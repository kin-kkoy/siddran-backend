const express = require("express");
const router = express.Router();
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware');
const { strictLimiter, contentUpdateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger')


router.use(checkAuth);


function getPrio(projectTasks){
    const levelValue = { low: 1, normal: 2, high: 3 };

    const total = projectTasks.reduce((sum, task) => sum + levelValue[task.priority], 0);
    const avg = total / projectTasks.length

    if (avg >= 2.72) return "very_high";
    if (avg >= 2.44) return "quite_high";
    if (avg >= 2.15) return "high";
    if (avg >= 1.87) return "normal";
    if (avg >= 1.58) return "low";
    if (avg >= 1.29) return "quite_low";
    return "very_low";
}


// ----- PROJECT ROUTES -----

// GET all projects
router.get('/', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const cursor = req.query.cursor;

    try {
        let query, values;

        if(cursor){
            query = `SELECT id, title, priority, is_completed, color, created_at, updated_at
                     FROM projects
                     WHERE user_id = $1
                     AND created_at < $2
                     ORDER BY is_completed ASC, created_at DESC
                     LIMIT $3`;
            values = [req.user.id, cursor, limit + 1];
        }else{
            query = `SELECT id, title, priority, is_completed, color, created_at, updated_at 
                     FROM projects
                     WHERE user_id = $1
                     ORDER BY is_completed ASC, created_at DESC
                     LIMIT $2`;
            values = [req.user.id, limit + 1];
        }

        const { rows: projects } = await pool.query(query, values);

        const hasNextPage = projects.length > limit;
        const paginatedProjects = hasNextPage ? projects.slice(0, -1) : projects;

        const projectIds = paginatedProjects.map(p => p.id);

        let projectTasks = [];
        if(projectIds.length > 0){
            const { rows } = await pool.query(
                `SELECT id, project_id, title, priority, is_completed, created_at, updated_at
                 FROM project_tasks
                 WHERE project_id = ANY($1)
                 ORDER BY created_at ASC`,
                [projectIds]
            );
            projectTasks = rows;
        }

        const projectsWithTasks = paginatedProjects.map(project => ({
            ...project,
            tasks: projectTasks.filter(task => task.project_id === project.id)
        }));

        const nextCursor = hasNextPage ? paginatedProjects[paginatedProjects.length - 1].created_at : null;
    

        res.json({ projects: projectsWithTasks, pagination: {
                hasNextPage, 
                nextCursor,
                limit 
            } 
        })

    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to fetch projects' })
    }
});

// GET one project (with its tasks) by id — used by the Calendar deep-link → TasksHub bundle
// detail opener. Mirrors the per-project shape from GET '/'. User-scoped.
router.get('/:id', async (req, res) => {
    const { id } = req.params
    try {
        const { rows } = await pool.query(
            `SELECT id, title, priority, is_completed, color, created_at, updated_at
             FROM projects WHERE id = $1 AND user_id = $2`,
            [id, req.user.id]
        )
        if (rows.length === 0) return res.status(404).json({ error: 'Project not found' })

        const { rows: tasks } = await pool.query(
            `SELECT id, project_id, title, priority, is_completed, created_at, updated_at
             FROM project_tasks WHERE project_id = $1 ORDER BY created_at ASC`,
            [id]
        )
        res.json({ ...rows[0], tasks })
    } catch (error) {
        logger.error(error)
        res.status(500).json({ error: 'Failed to fetch project' })
    }
})

// POST create a project
router.post('/', strictLimiter, async (req, res) => {
    const { title, tasks, color } = req.body;  // priorities is an array that contains 3 elements: x amount of low/normal/high

    // Validation
    if(!title || title.trim().length === 0) return res.status(400).json({ error: 'Title is required' });

    if(title.length > 100) return res.status(400).json({ error: 'Title must be 100 characters or less' });

    if(!tasks || !Array.isArray(tasks) ||tasks.length <= 0) return res.status(400).json({error: 'Must provide list of tasks for this project'})

    if(tasks.length > 30) return res.status(400).json({error: "Too many items in the checklist per req (30 only)"})


    let client;
    try {  // title, priority, is_completed, color, created_at, updated_at

        // FOR NOW: Limit standard user's task count to 100 except for owner mwehhe. Like the other limiters, limit/max will be increased/removed if premium user
        const projectCount = await pool.query(
            `SELECT COUNT(*) FROM projects
            WHERE user_id = $1`, [req.user.id]
        );
        if(parseInt(projectCount.rows[0].count) >= 100) return res.status(400).json({error: "You have reached the maximum number of projects"}); // "Upgrade to premium to add more or unlimited!"


        // Dedicated client so the whole transaction runs on one connection.
        client = await pool.connect();
        await client.query('BEGIN'); // Start Batch Transaction

        // calculate priority
        const priority = getPrio(tasks);

        // Insert main project
        const { rows: projectRows } = await client.query(
            `INSERT INTO projects (user_id, title, priority, color)
             VALUES ($1, $2, $3, $4)
             RETURNING id, title, priority, is_completed, color, created_at, updated_at`,
            [req.user.id, title.trim(), priority, color || null]
        );

        const newProject = projectRows[0];


        // insert checklist items or tasks of that project
        const createdTasks = [];

        for (const task of tasks){
            if(!task.title || task.title.trim().length === 0) continue; // don't add basically

            const {rows} = await client.query(
                `INSERT INTO project_tasks (project_id, title, priority)
                 VALUES ($1, $2, $3)
                 RETURNING id, project_id, title, priority, is_completed, created_at, updated_at`,
                [newProject.id, task.title.trim(), task.priority || 'normal']);
            createdTasks.push(rows[0]);
        }

        await client.query(`COMMIT`); // End ---
        res.status(201).json({ ...newProject, tasks: createdTasks });

    } catch (error) {
        if (client) { try { await client.query(`ROLLBACK`) } catch { /* connection already broken */ } }
        logger.error(error);
        res.status(500).json({ error: 'Failed to create project' })
    } finally {
        if (client) client.release();
    }
});

// PUT update a project
router.put('/:id', contentUpdateLimiter, async (req, res) => {
    const { id } = req.params
    const {title, color, is_completed} = req.body;

    // Validation
    if(title && title.length > 100) return res.status(400).json({ error: 'Title must be 100 characters or less' });

    try {

        const { rows } = await pool.query(
            `UPDATE projects
             SET title = COALESCE ($1, title),
                 color = COALESCE ($2, color),
                 is_completed = COALESCE ($3, is_completed),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $4 AND user_id = $5
             RETURNING id, title, priority, color, is_completed, created_at, updated_at`,
            [title?.trim(), color, is_completed, id, req.user.id]
        );
        if(rows.length === 0) return res.status(404).json({ error: 'No project found' })

        res.status(200).json(rows[0]);

    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to update project' })
    }
});

// DELETE a project
router.delete('/:id', strictLimiter, async (req, res) => {
    const { id } = req.params;

    try {

        const {rowCount} = await pool.query(
            `DELETE FROM projects
             WHERE id = $1
             AND user_id = $2`, [id, req.user.id]
        );
        if (rowCount=== 0) return res.status(404).json({ error: `Project not found`})

        res.status(200).json({ message: `Successfully deleted project` })

    } catch (error) {
        logger.error(`Error deleting tasks:`,error);
            res.status(500).json({error: `Something went wrong while deleting the project`})
    }
});


// ----- PROJECT TASKS ROUTES -----

// POST add a task/s to a project
router.post('/:projectId/tasks', strictLimiter, async (req, res) => {
    const { projectId } = req.params;
    const { tasks } = req.body;

    // Validation
    if(!tasks || !Array.isArray(tasks) ||tasks.length <= 0) return res.status(400).json({error: 'Must provide list of tasks for this project'})
    if(tasks.length > 30) return res.status(400).json({error: "Too many tasks in the project (30 only)"})

    let client;
    try {

        // Verify that the project exists and that it's the user's
        const project = await pool.query(
            `SELECT COUNT(*) FROM projects
             WHERE user_id=$1 AND id =$2`, [req.user.id, projectId]
        );
        if(parseInt(project.rows[0].count) === 0) return res.status(400).json({error: "You do not own this project"});

        // get all current tasks and the count
        const taskCount = await pool.query(
            `SELECT COUNT(*) FROM project_tasks
             WHERE project_id = $1`, [projectId]
        );
        if(parseInt(taskCount.rows[0].count) >= 30) return res.status(400).json({error: "You have reached the maximum number of tasks for this project"}); // "Upgrade to premium to add more or unlimited!"

        
        client = await pool.connect();
        await client.query(`BEGIN`);


        // store all tasks with the created ones appended incrementally
        const allTasks = await client.query(
            `SELECT priority FROM project_tasks
             WHERE project_id = $1`, [projectId]
        );


        for(const task of tasks){
            if(!task.title || task.title.trim().length === 0) continue; // don't add basically

            const {rows} = await client.query(
                `INSERT INTO project_tasks (project_id, title, priority)
                 VALUES ($1, $2, $3)
                 RETURNING id, project_id, title, priority, is_completed, created_at, updated_at`,
                [projectId, task.title.trim(), task.priority || 'normal']
            );
            allTasks.rows.push(rows[0]);
        }

        // get the new priority level of the project considering the new tasks added
        const projPrio = getPrio(allTasks.rows);

        // then update the project's priority
        const { rows: updatedProject } = await client.query(
            `UPDATE projects
             SET priority = COALESCE ($1, priority), updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING id, title, priority, is_completed, updated_at`,
            [projPrio, projectId]
        );
        if(updatedProject.length === 0){
            await client.query('ROLLBACK')
            return res.status(400).json({ error: "Failed to update project's priority level" })
        }


        await client.query(`COMMIT`); // End ---
        res.status(201).json({ ...updatedProject[0], tasks: allTasks.rows });

    } catch (error) {
        if (client) { try { await client.query(`ROLLBACK`) } catch { /* connection already broken */ } }
        logger.error(error);
        res.status(500).json({ error: 'Failed to add task/s' })
    } finally {
        if (client) client.release();
    }
});

// PUT update project tasks (can handle edge cases such as only one task to edit)
router.put('/:projectId/tasks', contentUpdateLimiter, async (req, res) => {
    const { projectId } = req.params
    const { tasks } = req.body

    // Validation
    if(!tasks || !Array.isArray(tasks) ||tasks.length <= 0) return res.status(400).json({error: 'Must provide list of tasks'})

    let client;
    try {

        // Verify that the project exists and that it's the user's
        const project = await pool.query(
            `SELECT COUNT(*) FROM projects
             WHERE user_id=$1 AND id =$2`, [req.user.id, projectId]
        );
        if(parseInt(project.rows[0].count) === 0) return res.status(400).json({error: "You do not own this project"});

        
        client = await pool.connect();
        await client.query(`BEGIN`)


        for(const task of tasks){
            const {rows} = await client.query(
                `UPDATE project_tasks
                 SET
                    title = COALESCE ($1, title),
                    priority = COALESCE ($2, priority),
                    is_completed = COALESCE ($3, is_completed),
                    updated_at = CURRENT_TIMESTAMP
                 WHERE id = $4 AND project_id = $5
                 RETURNING id, title, priority, is_completed, created_at, updated_at`,
                [task.title?.trim(), task.priority, task.is_completed, task.id, projectId]
            );
        };

        // used to store all tasks; For if ever a task's priority would be changed or would change
        const { rows: allTasks } = await client.query(
            `SELECT id, project_id, title, priority, is_completed, created_at, updated_at
             FROM project_tasks
             WHERE project_id = $1
             ORDER BY created_at ASC`,
            [projectId]
        );

        // Would've added a comparison here where if a task's prio has changed than only then will we recompute the project's priority but for now since I'm the only user we will just always update the priority instead.

        const prioUpdate = await client.query(
            `UPDATE projects
             SET priority = COALESCE ($1, priority)
             WHERE id = $2 AND user_id = $3
             RETURNING id, title, priority, color, is_completed, created_at, updated_at`,
            [getPrio(allTasks), projectId, req.user.id]
        )
        if(prioUpdate.rows.length === 0){
            await client.query('ROLLBACK')
            return res.status(404).json({ error: 'No project found' })
        }

        await client.query(`COMMIT`)
        res.status(200).json({ allTasks })

    } catch (error) {
        if (client) { try { await client.query(`ROLLBACK`) } catch { /* connection already broken */ } }
        logger.error(error);
        res.status(500).json({ error: 'Failed to update tasks' })
    } finally {
        if (client) client.release();
    }
});

// DELETE a batch of project tasks
router.delete('/:projectId/tasks', strictLimiter, async (req, res) => {
    const { projectId } = req.params;
    const { tasks } = req.body;

    // Validation
    if(!tasks || !Array.isArray(tasks) ||tasks.length <= 0) return res.status(400).json({error: 'Must provide list of tasks'})

    let client;
    try {

        // Verify that the project exists and that it's the user's
        const project = await pool.query(
            `SELECT COUNT(*) FROM projects
             WHERE user_id=$1 AND id =$2`, [req.user.id, projectId]
        );
        if(parseInt(project.rows[0].count) === 0) return res.status(400).json({error: "You do not own this project"});

        
        client = await pool.connect();
        await client.query(`BEGIN`)


        for(const task of tasks){
            const {rowCount} = await client.query(
                `DELETE FROM project_tasks
                 WHERE id = $1 AND project_id = $2`,
                [task.id, projectId]
            )
            if (rowCount === 0){
                await client.query('ROLLBACK')
                return res.status(404).json({ error: `Task not found`})
            }
        }


        // recalculate project priority since it's a DELETE and not a complete.
        const {rows: allTasks} = await client.query(
            `SELECT id, project_id, title, priority, is_completed, created_at, updated_at
             FROM project_tasks
             WHERE project_id = $1
             ORDER BY created_at ASC`,
            [projectId]
        )
        const newPrio = allTasks.length > 0 ? getPrio(allTasks) : 'very_low'; // it's actually going to be deleted but just to be sure i'll make it `very_low` because it'd turn into NaN if no safeguard like this.

        const {rows} = await client.query(
            `UPDATE projects
             SET priority = COALESCE($1, priority)
             WHERE id = $2`,
            [newPrio, projectId]
        );
        if(rows.length === 0){
            await client.query('ROLLBACK')
            return res.status(404).json({ error: `Project not found`})
        }


        await client.query(`COMMIT`)
        res.status(200).json({ message: `Successfully deleted tasks` })

    } catch (error) {
        if (client) { try { await client.query(`ROLLBACK`) } catch { /* connection already broken */ } }
        logger.error(error);
        res.status(500).json({ error: 'Failed to update tasks' })
    } finally {
        if (client) client.release();
    }
});


// COMPLETE a task in a project (singular). The batch updating one is already included as an implementation in the put route above
router.put('/:projectId/tasks/:taskId', contentUpdateLimiter, async (req, res) => {
    const { projectId, taskId } = req.params;
    const { is_completed } = req.body;

    try {
        
        // Verify that the project exists and that it's the user's
        const project = await pool.query(
            `SELECT COUNT(*) FROM projects
             WHERE user_id=$1 AND id =$2`, [req.user.id, projectId]
        );
        if(parseInt(project.rows[0].count) === 0) return res.status(400).json({error: "You do not own this project"});

        const { rows } = await pool.query(
            `UPDATE project_tasks
             SET
                is_completed = COALESCE ($1, is_completed),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND project_id = $3
             RETURNING id, title, priority, is_completed, updated_at`,
            [is_completed, taskId, projectId]
        ); // yes no created at because I don't see the need tho i might be wrong
        if(rows.length === 0) return res.status(404).json({error: 'Task not found'})

        res.status(200).json(rows[0])

    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to complete/update task' })
    }
})


module.exports = router;
