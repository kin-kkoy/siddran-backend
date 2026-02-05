const express = require('express');
const router = express.Router()
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware');
const { strictLimiter, contentUpdateLimiter } = require('../middleware/rateLimiter');


// Just found out that I could've just done it this way lol, but I still find the structure of notes.js to be more intuitive
router.use(checkAuth);


// GET ALL tasks (with checklist items)
router.get('/', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const cursor = req.query.cursor;

    try {
        let query, values;

        if(cursor) {
            // Get tasks older than cursor, but keep sort order (incomplete first, then by date)
            query = `SELECT id, title, description, priority, due_date, is_completed, created_at, updated_at FROM tasks
                WHERE user_id = $1 AND created_at < $2
                ORDER BY is_completed ASC, created_at DESC
                LIMIT $3`;
            values = [req.user.id, cursor, limit + 1];
        } else {
            query = `SELECT id, title, description, priority, due_date, is_completed, created_at, updated_at FROM tasks
                WHERE user_id = $1
                ORDER BY is_completed ASC, created_at DESC
                LIMIT $2`;
            values = [req.user.id, limit + 1];
        }

        const { rows: tasks } = await pool.query(query, values);

        const hasNextPage = tasks.length > limit;
        const paginatedTasks = hasNextPage ? tasks.slice(0, -1) : tasks;


        // Get checklist items for these specific tasks only (use paginatedTasks, not tasks)
        const taskIds = paginatedTasks.map(t => t.id);
        
        let checklistItems = [];
        if (taskIds.length > 0) {
            const { rows } = await pool.query(
                `SELECT id, task_id, title, is_completed, created_at FROM task_checklist
                 WHERE task_id = ANY($1)
                 ORDER BY created_at ASC`,
                [taskIds]
            );
            checklistItems = rows;
        }

        // Attach checklist items to their parent tasks
        const tasksWithChecklist = paginatedTasks.map(task => ({
            ...task,
            checklist: checklistItems.filter(item => item.task_id === task.id)
        }));

        const nextCursor = hasNextPage ? paginatedTasks[paginatedTasks.length - 1].created_at : null;

        res.json({tasks: tasksWithChecklist, pagination: {
            hasNextPage, nextCursor, limit
        }});

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch tasks' })
    }
});

// POST a task
router.post('/', strictLimiter, async (req, res) => {
    const { title, description, priority, due_date, checklist } = req.body;

    // Validation
    if (!title || title.trim().length === 0) {
        return res.status(400).json({ error: 'Title is required' });
    }

    if (title.length > 200) {
        return res.status(400).json({ error: 'Title must be 200 characters or less' });
    }

    if (description && description.length > 500) {
        return res.status(400).json({ error: 'Description must be 500 characters or less' });
    }

    // For now cap the checklist, maybe remove in the future
    if(checklist && checklist.length > 20) return res.status(400).json({ error: '20 checklist items per task only' })

    try {

        // FOR NOW: Limit standard user's task count to 100 except for owner mwehhe. Like the other limiters, limit/max will be increased/removed if premium user
        const taskCount = await pool.query(
            `SELECT COUNT(*) FROM tasks
            WHERE user_id = $1`, [req.user.id]
        );

        if(parseInt(taskCount.rows[0].count) >= 100) return res.status(400).json({error: "You have reached the maximum number of tasks"}); // "Upgrade to premium to add more or unlimited!"


        // Start transaction
        await pool.query('BEGIN');

        // Insert main task
        const { rows: taskRows } = await pool.query(
            `INSERT INTO tasks (user_id, title, description, priority, due_date)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, title, description, priority, due_date, is_completed, created_at, updated_at`,
            [req.user.id, title.trim(), description?.trim() || null, priority || 'normal', due_date || null]
        );

        const newTask = taskRows[0];

        // Insert checklist items if provided
        const createdChecklist = [];
        if (checklist && Array.isArray(checklist) && checklist.length > 0) {
            for (const item of checklist) {
                if (!item.title || item.title.trim().length === 0) continue;

                if (item.title.length > 100) {
                    throw new Error('Checklist item title must be 100 characters or less');
                }

                const { rows } = await pool.query(
                    `INSERT INTO task_checklist (task_id, title)
                     VALUES ($1, $2)
                     RETURNING id, task_id, title, is_completed, created_at`,
                    [newTask.id, item.title.trim()]
                );
                createdChecklist.push(rows[0]);
            }
        }

        await pool.query('COMMIT');

        res.status(201).json({
            ...newTask,
            checklist: createdChecklist
        });
        
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error(error);
        res.status(500).json({ error: 'Failed to create task' })
    }
})

// PUT update a task
router.put('/:id', contentUpdateLimiter, async (req, res) => {
    const { id } = req.params;
    const { title, description, is_completed, priority, due_date } = req.body;

    // Validation
    if (title && title.length > 200) {
        return res.status(400).json({ error: 'Title must be 200 characters or less' });
    }

    if (description && description.length > 500) {
        return res.status(400).json({ error: 'Description must be 500 characters or less' });
    }

    try {
        const { rows } = await pool.query(
            `UPDATE tasks
             SET title = COALESCE($1, title),
                 description = COALESCE($2, description),
                 is_completed = COALESCE($3, is_completed),
                 priority = COALESCE($4, priority),
                 due_date = COALESCE($5, due_date),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $6 AND user_id = $7
             RETURNING id, title, description, priority, due_date, is_completed, created_at, updated_at`,
            [title?.trim(), description?.trim(), is_completed, priority, due_date, id, req.user.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // Get checklist items
        const { rows: checklist } = await pool.query(
            `SELECT id, task_id, title, is_completed, created_at FROM task_checklist WHERE task_id = $1`,
            [id]
        );

        res.json({
            ...rows[0],
            checklist
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to update task' })
    }
})

// DELETE a task (cascades to checklist items automatically)
router.delete('/:id', strictLimiter, async (req, res) => {
    const { id } = req.params

    try {
        const { rowCount } = await pool.query(
            `DELETE FROM tasks
             WHERE id = $1 
             AND user_id = $2`,
             [id, req.user.id]
        );

        if(rowCount === 0) return res.status(404).json({ error: 'Task not found'})

        res.json({ message: 'Task deleted successfully' })

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to delete task' })
    }
})

// ----- CHECKLIST ROUTES -----

// POST add a checklist item to an existing task
router.post('/:taskId/checklist', strictLimiter, async (req, res) => {
    const { taskId } = req.params;
    const { title } = req.body;

    if (!title || title.trim().length === 0) {
        return res.status(400).json({ error: 'Checklist item title is required' });
    }

    if (title.length > 100) {
        return res.status(400).json({ error: 'Checklist item title must be 100 characters or less' });
    }

    try {
        // Verify task exists and belongs to user
        const { rows: taskRows } = await pool.query(
            `SELECT id FROM tasks WHERE id = $1 AND user_id = $2`,
            [taskId, req.user.id]
        );

        if (taskRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const { rows } = await pool.query(
            `INSERT INTO task_checklist (task_id, title)
             VALUES ($1, $2)
             RETURNING id, task_id, title, is_completed, created_at`,
            [taskId, title.trim()]
        );

        res.status(201).json(rows[0]);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create checklist item' });
    }
});

// PUT update/toggle a checklist item
router.put('/:taskId/checklist/:checklistId', contentUpdateLimiter, async (req, res) => {
    const { taskId, checklistId } = req.params;
    const { title, is_completed } = req.body;

    if (title && title.length > 100) {
        return res.status(400).json({ error: 'Checklist item title must be 100 characters or less' });
    }

    try {
        // Verify task belongs to user
        const { rows: taskRows } = await pool.query(
            `SELECT id FROM tasks WHERE id = $1 AND user_id = $2`,
            [taskId, req.user.id]
        );

        if (taskRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const { rows } = await pool.query(
            `UPDATE task_checklist
             SET title = COALESCE($1, title),
                 is_completed = COALESCE($2, is_completed)
             WHERE id = $3 AND task_id = $4
             RETURNING id, task_id, title, is_completed, created_at`,
            [title?.trim(), is_completed, checklistId, taskId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Checklist item not found' });
        }

        res.json(rows[0]);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to update checklist item' });
    }
});

// DELETE a checklist item
router.delete('/:taskId/checklist/:checklistId', strictLimiter, async (req, res) => {
    const { taskId, checklistId } = req.params;

    try {
        // Verify task belongs to user
        const { rows: taskRows } = await pool.query(
            `SELECT id FROM tasks WHERE id = $1 AND user_id = $2`,
            [taskId, req.user.id]
        );

        if (taskRows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const { rowCount } = await pool.query(
            `DELETE FROM task_checklist WHERE id = $1 AND task_id = $2`,
            [checklistId, taskId]
        );

        if (rowCount === 0) {
            return res.status(404).json({ error: 'Checklist item not found' });
        }

        res.json({ message: 'Checklist item deleted successfully' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to delete checklist item' });
    }
});

module.exports = router;