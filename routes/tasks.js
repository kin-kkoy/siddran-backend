const express = require('express');
const router = express.Router()
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware')


// Just found out that I could've just done it this way lol, but I still find the structure of notes.js to be more intuitive
router.use(checkAuth);


// GET ALL tasks (with checklist items)
router.get('/', async (req, res) => {
    try {
        // Get all tasks
        const { rows: tasks } = await pool.query(
            `SELECT * FROM tasks
             WHERE user_id = $1
             ORDER BY is_completed ASC, created_at DESC`,
            [req.user.id]
        );

        // Get all checklist items for these tasks
        const taskIds = tasks.map(t => t.id);
        
        let checklistItems = [];
        if (taskIds.length > 0) {
            const { rows } = await pool.query(
                `SELECT * FROM task_checklist
                 WHERE task_id = ANY($1)
                 ORDER BY created_at ASC`,
                [taskIds]
            );
            checklistItems = rows;
        }

        // Attach checklist items to their parent tasks
        const tasksWithChecklist = tasks.map(task => ({
            ...task,
            checklist: checklistItems.filter(item => item.task_id === task.id)
        }));

        res.json(tasksWithChecklist);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch tasks' })
    }
});

// POST a task
router.post('/', async (req, res) => {
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

    try {
        // Start transaction
        await pool.query('BEGIN');

        // Insert main task
        const { rows: taskRows } = await pool.query(
            `INSERT INTO tasks (user_id, title, description, priority, due_date)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
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
                     RETURNING *`,
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
        res.status(500).json({ error: error.message || 'Failed to create task' })
    }
})

// PUT update a task
router.put('/:id', async (req, res) => {
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
             RETURNING *`,
            [title?.trim(), description?.trim(), is_completed, priority, due_date, id, req.user.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // Get checklist items
        const { rows: checklist } = await pool.query(
            `SELECT * FROM task_checklist WHERE task_id = $1`,
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
router.delete('/:id', async (req, res) => {
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
router.post('/:taskId/checklist', async (req, res) => {
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
             RETURNING *`,
            [taskId, title.trim()]
        );

        res.status(201).json(rows[0]);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create checklist item' });
    }
});

// PUT update/toggle a checklist item
router.put('/:taskId/checklist/:checklistId', async (req, res) => {
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
             RETURNING *`,
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
router.delete('/:taskId/checklist/:checklistId', async (req, res) => {
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