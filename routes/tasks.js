const express = require('express');
const router = express.Router()
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware');
const { strictLimiter, contentUpdateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger')


// Just found out that I could've just done it this way lol, but I still find the structure of notes.js to be more intuitive
router.use(checkAuth);


// GET ALL tasks
router.get('/', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const cursor = req.query.cursor;
    const { dueFrom, dueTo } = req.query;

    // Range mode (used by the Calendar overlay): return ALL dated tasks whose due_date falls
    // in [dueFrom, dueTo) — no pagination, bounded by the window. The client re-buckets by
    // local day, so a slightly generous UTC window is fine.
    if (dueFrom && dueTo) {
        try {
            const { rows: tasks } = await pool.query(
                `SELECT id, title, description, priority, due_date, is_completed, created_at, updated_at FROM tasks
                 WHERE user_id = $1
                 AND due_date IS NOT NULL
                 AND due_date >= $2
                 AND due_date < $3
                 ORDER BY due_date ASC`,
                [req.user.id, dueFrom, dueTo]
            );
            return res.json({ tasks });
        } catch (error) {
            logger.error(error);
            return res.status(500).json({ error: 'Failed to fetch tasks' });
        }
    }

    // Dated mode (Calendar overlay): ALL tasks that have a due_date, no pagination. The calendar
    // fetches these once and derives every month/view client-side (no per-view refetch).
    if (req.query.dated) {
        try {
            const { rows: tasks } = await pool.query(
                `SELECT id, title, description, priority, due_date, is_completed, created_at, updated_at FROM tasks
                 WHERE user_id = $1
                 AND due_date IS NOT NULL
                 ORDER BY due_date ASC`,
                [req.user.id]
            );
            return res.json({ tasks });
        } catch (error) {
            logger.error(error);
            return res.status(500).json({ error: 'Failed to fetch tasks' });
        }
    }

    // Undated mode (Calendar's "unscheduled" drawer): incomplete tasks with no due_date.
    if (req.query.undated) {
        try {
            const { rows: tasks } = await pool.query(
                `SELECT id, title, description, priority, due_date, is_completed, created_at, updated_at FROM tasks
                 WHERE user_id = $1
                 AND due_date IS NULL
                 AND is_completed = FALSE
                 ORDER BY created_at DESC
                 LIMIT 100`,
                [req.user.id]
            );
            return res.json({ tasks });
        } catch (error) {
            logger.error(error);
            return res.status(500).json({ error: 'Failed to fetch tasks' });
        }
    }

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
        const nextCursor = hasNextPage ? paginatedTasks[paginatedTasks.length - 1].created_at : null;

        res.json({ tasks: paginatedTasks, pagination: {
                hasNextPage, 
                nextCursor,
                limit 
            } 
        })

    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to fetch tasks' })
    }
});

// POST a task
// GET one task by id (used by the Calendar deep-link → TasksHub detail opener). User-scoped.
router.get('/:id', async (req, res) => {
    const { id } = req.params
    try {
        const { rows } = await pool.query(
            `SELECT id, title, description, priority, due_date, is_completed, created_at, updated_at
             FROM tasks WHERE id = $1 AND user_id = $2`,
            [id, req.user.id]
        )
        if (rows.length === 0) return res.status(404).json({ error: 'Task not found' })
        res.json(rows[0])
    } catch (error) {
        logger.error(error)
        res.status(500).json({ error: 'Failed to fetch task' })
    }
})

router.post('/', strictLimiter, async (req, res) => {
    const { title, description, priority, due_date } = req.body;

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

        // FOR NOW: Limit standard user's task count to 100 except for owner mwehhe. Like the other limiters, limit/max will be increased/removed if premium user
        const taskCount = await pool.query(
            `SELECT COUNT(*) FROM tasks
            WHERE user_id = $1`, [req.user.id]
        );

        if(parseInt(taskCount.rows[0].count) >= 100) return res.status(400).json({error: "You have reached the maximum number of tasks"}); // "Upgrade to premium to add more or unlimited!"


        // Insert main task
        const { rows: taskRows } = await pool.query(
            `INSERT INTO tasks (user_id, title, description, priority, due_date)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, title, description, priority, due_date, is_completed, created_at, updated_at`,
            [req.user.id, title.trim(), description?.trim() || null, priority || 'normal', due_date || null]
        );

        const newTask = taskRows[0];

        res.status(201).json({ ...newTask });
        
    } catch (error) {
        logger.error(error);
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

        res.json({ ...rows[0] });

    } catch (error) {
        logger.error(error);
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
        logger.error(error);
        res.status(500).json({ error: 'Failed to delete task' })
    }
})

module.exports = router;