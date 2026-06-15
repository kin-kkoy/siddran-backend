const express = require('express')
const router = express.Router()
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware')
const { strictLimiter, contentUpdateLimiter } = require('../middleware/rateLimiter')
const logger = require('../utils/logger')

router.use(checkAuth)

// Normalize a recurrence value for storage (TEXT column): preset strings pass through,
// a { mask: [7 bools] } object is JSON-stringified, null/undefined means a one-off (ephemeral)
// daily. The calendar expands recurring rows into virtual per-day instances.
const normalizeRecurrence = (rec) => {
    if (rec == null) return null
    return typeof rec === 'object' ? JSON.stringify(rec) : String(rec)
}

// remove all expired tasks (beyond 24 hrs already) — but NEVER recurring ones (they persist
// and repeat; recurrence IS NOT NULL rows are skipped by the cleanup)
const removeExpiredTasks = async (userId) => {
    try {
        await pool.query(
            `DELETE FROM daily_tasks
             WHERE user_id = $1
             AND expires_at < NOW()
             AND recurrence IS NULL`, [userId]
        );
    } catch (error) {
        logger.error(`Removing expired tasks error:`, error)
    }
}

// Get all tasks
router.get('/', async (req, res) => {
    const userId = req.user.id

    // Calendar mode: every RECURRING daily (recurrence IS NOT NULL = non-expiring, repeats),
    // non-paginated, so the calendar plots ALL recurring rows — not just the paginated first page.
    if (req.query.recurring === '1') {
        try {
            const { rows } = await pool.query(
                `SELECT id, title, priority, is_completed, created_at, updated_at, expires_at, recurrence, time
                 FROM daily_tasks
                 WHERE user_id = $1 AND recurrence IS NOT NULL
                 ORDER BY created_at DESC`, [userId]
            );
            return res.json({ dailyTasks: rows });
        } catch (error) {
            logger.error(`Error fetching recurring daily tasks:`, error);
            return res.status(500).json({ error: `Something went wrong while getting recurring daily tasks` });
        }
    }

    // Lightweight picker list (calendar block linking): active/recurring dailies, id + title. ?picker=1
    if (req.query.picker) {
        try {
            const { rows: items } = await pool.query(
                `SELECT id, title FROM daily_tasks
                 WHERE user_id = $1 AND (expires_at > NOW() OR recurrence IS NOT NULL)
                 ORDER BY created_at DESC LIMIT 200`,
                [userId]
            );
            return res.json({ items });
        } catch (error) {
            logger.error(`Error fetching daily task picker list:`, error);
            return res.status(500).json({ error: `Something went wrong while getting daily tasks` });
        }
    }

    //pagination (explanation in notes.js)
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const cursor = req.query.cursor;

    try {
        // Clean up expired tasks first
        await removeExpiredTasks(userId)

        let query, values;

        if(cursor) {
            query = `SELECT id, title, priority, is_completed, created_at, updated_at, expires_at, recurrence, time FROM daily_tasks
                WHERE user_id = $1
                AND (expires_at > NOW() OR recurrence IS NOT NULL)
                AND created_at < $2
                ORDER BY is_completed ASC, created_at DESC
                LIMIT $3`;
            values = [userId, cursor, limit + 1];
        } else {
            query = `SELECT id, title, priority, is_completed, created_at, updated_at, expires_at, recurrence, time FROM daily_tasks
                WHERE user_id = $1
                AND (expires_at > NOW() OR recurrence IS NOT NULL)
                ORDER BY is_completed ASC, created_at DESC
                LIMIT $2`;
            values = [userId, limit + 1];
        }

        const { rows } = await pool.query(query, values);

        const hasNextPage = rows.length > limit;
        const dailyTasks = hasNextPage ? rows.slice(0, -1) : rows;
        const nextCursor = hasNextPage ? dailyTasks[dailyTasks.length - 1].created_at : null;

        res.json({ dailyTasks, pagination: {
            hasNextPage, nextCursor, limit
        }});

    } catch (error) {
        logger.error(`Error fetching tasks:`,error);
        res.status(500).json({error: `Something went wrong while getting list of daily tasks`})
    }
})

// ---- Per-day completions for RECURRING dailies (calendar check-off) ----
// A completion row's presence = that recurring daily is "done" on that date. Ephemeral (one-off)
// dailies keep their own is_completed and are untouched here.

// Range fetch (optional ?from=&to= 'YYYY-MM-DD'); omitted = all completions for the user.
router.get('/completions', async (req, res) => {
    const userId = req.user.id
    const { from, to } = req.query

    try {
        const values = [userId]
        let query = `SELECT daily_task_id, to_char(date, 'YYYY-MM-DD') AS date
                     FROM daily_completions WHERE user_id = $1`
        if (from) { values.push(from); query += ` AND date >= $${values.length}` }
        if (to)   { values.push(to);   query += ` AND date <= $${values.length}` }

        const { rows } = await pool.query(query, values)
        res.json({ completions: rows })
    } catch (error) {
        logger.error(`Error fetching daily completions:`, error)
        res.status(500).json({ error: `Something went wrong while getting daily completions` })
    }
})

// Toggle one recurring daily's completion on one date. { date:'YYYY-MM-DD', done:bool }:
// done → upsert the row, !done → delete it. Single-row, no transaction needed.
router.post('/:id/completions', contentUpdateLimiter, async (req, res) => {
    const userId = req.user.id
    const { id } = req.params
    const { date, done } = req.body

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required' })
    }

    try {
        // Only a recurring daily the user owns can be checked off per-day.
        const owns = await pool.query(
            `SELECT 1 FROM daily_tasks WHERE id = $1 AND user_id = $2 AND recurrence IS NOT NULL`,
            [id, userId]
        )
        if (owns.rowCount === 0) return res.status(404).json({ error: 'Recurring daily task not found' })

        if (done) {
            await pool.query(
                `INSERT INTO daily_completions (user_id, daily_task_id, date)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (daily_task_id, date) DO NOTHING`,
                [userId, id, date]
            )
        } else {
            await pool.query(
                `DELETE FROM daily_completions WHERE user_id = $1 AND daily_task_id = $2 AND date = $3`,
                [userId, id, date]
            )
        }

        res.json({ daily_task_id: Number(id), date, done: !!done })
    } catch (error) {
        logger.error(`Error toggling daily completion:`, error)
        res.status(500).json({ error: `Something went wrong while updating the completion` })
    }
})

// GET one daily task by id (Calendar deep-link → TasksHub daily detail opener). User-scoped.
// Registered after GET '/completions' so the literal route still matches first.
router.get('/:id', async (req, res) => {
    const { id } = req.params
    try {
        const { rows } = await pool.query(
            `SELECT id, title, priority, is_completed, created_at, updated_at, expires_at, recurrence, time
             FROM daily_tasks WHERE id = $1 AND user_id = $2`,
            [id, req.user.id]
        )
        if (rows.length === 0) return res.status(404).json({ error: 'Daily task not found' })
        res.json(rows[0])
    } catch (error) {
        logger.error(`Error fetching daily task:`, error)
        res.status(500).json({ error: `Something went wrong while getting the daily task` })
    }
})

// Create tasks (by batch)
router.post('/', strictLimiter, async (req, res) => {
    const { tasks } = req.body // get the array of tasks

    if(!tasks || !Array.isArray(tasks) || tasks.length === 0){
        return res.status(400).json({ error: 'Array of tasks required!'})
    }

    if(tasks.length > 20) return res.status(400).json({error: "Too many daily tasks per req (20 only)"})

    let client;
    try {

        // FOR NOW: Limit standard user's task count to 100 except for owner mwehhe. Like the other limiters, limit/max will be increased/removed if premium user
        const dailyTaskCount = await pool.query(
            `SELECT COUNT(*) FROM daily_tasks
             WHERE user_id = $1
             AND (expires_at > NOW() OR recurrence IS NOT NULL)`, [req.user.id]
        );

        const currentDTCount = parseInt(dailyTaskCount.rows[0].count);
        if(currentDTCount + tasks.length > 50) return res.status(400).json({ error: `You can only have 50 active daily tasks at once. Currently have: ${currentDTCount}`})


        // Dedicated client so the whole transaction runs on one connection.
        client = await pool.connect();
        await client.query('BEGIN'); // Start Batch Transaction

        const createdTasks = [];
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours

        for (const task of tasks){
            if(!task.title || task.title.trim().length === 0) continue; // don't add basically

            // expires_at is always set (NOT NULL), but recurring rows are skipped by the
            // cleanup, so their expiry never fires — they persist and repeat.
            const {rows} = await client.query(
                `INSERT INTO daily_tasks (user_id, title, priority, expires_at, recurrence, time)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, title, priority, is_completed, created_at, updated_at, expires_at, recurrence, time`,
                 [req.user.id, task.title.trim(), task.priority || 'normal', expiresAt, normalizeRecurrence(task.recurrence), task.time || null]);
            createdTasks.push(rows[0]);
        }

        await client.query(`COMMIT`); // End ---
        res.status(201).json(createdTasks);

    } catch (error) {
        if (client) { try { await client.query('ROLLBACK') } catch { /* connection already broken */ } }
        logger.error(`Error in adding daily tasks:`, error)
        res.status(500).json({error: `Something went wrong while adding list of daily tasks`})
    } finally {
        if (client) client.release();
    }
})

// Update tasks (batch completion of tasks)
router.patch('/batch-complete', contentUpdateLimiter, async (req, res) => {
    const { tasks } = req.body;

    if(!tasks || !Array.isArray(tasks) || tasks.length === 0){
        return res.status(400).json({ error: 'Array of tasks required!'})
    }

    let client;
    try {

        client = await pool.connect();
        await client.query('BEGIN'); // Start Batch Transaction

        const updatedTasks = [];

        for(const task of tasks){
            if(!task.id) continue;

            const {rows} = await client.query(
                `UPDATE daily_tasks
                 SET is_completed = COALESCE($1, is_completed), updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2
                 AND user_id = $3
                 AND (expires_at > NOW() OR recurrence IS NOT NULL)
                 RETURNING id, title, priority, is_completed, created_at, updated_at, expires_at, recurrence, time`,
                 [task.is_completed, task.id, req.user.id]
            )

            updatedTasks.push(rows[0]);
        }

        await client.query(`COMMIT`); // End ---
        res.status(200).json(updatedTasks);

    } catch (error) {
        if (client) { try { await client.query('ROLLBACK') } catch { /* connection already broken */ } }
        logger.error(`Error updating tasks:`,error);
        res.status(500).json({error: `Something went wrong while updating list of daily tasks`})
    } finally {
        if (client) client.release();
    }
})

// Update tasks (completion of task)
router.put('/:id', contentUpdateLimiter, async (req, res) => {
    const { id } = req.params;
    const { title, priority, is_completed, recurrence, time } = req.body;

    // recurrence is normalized only when explicitly provided, so an undefined recurrence
    // leaves the stored value untouched (COALESCE), while passing one updates it.
    const recurrenceParam = recurrence === undefined ? undefined : normalizeRecurrence(recurrence);
    // `time` must support being explicitly CLEARED to null (untimed daily) — COALESCE can't tell
    // absent from null, so set it directly only when the key is present in the body.
    const timeProvided = Object.prototype.hasOwnProperty.call(req.body, 'time');

    try {
        const {rows} = await pool.query(
            `UPDATE daily_tasks
             SET title = COALESCE($1, title),
                 priority = COALESCE($2, priority),
                 is_completed = COALESCE($3, is_completed),
                 recurrence = COALESCE($4, recurrence),
                 time = CASE WHEN $5 THEN $6 ELSE time END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $7
             AND user_id = $8
             AND (expires_at > NOW() OR recurrence IS NOT NULL)
             RETURNING id, title, priority, is_completed, created_at, updated_at, expires_at, recurrence, time`,
             [title?.trim(), priority, is_completed, recurrenceParam, timeProvided, timeProvided ? (time ?? null) : null, id, req.user.id]
        )

        if(rows.length === 0) return res.status(404).json({error: 'List of daily tasks not found or expired already'})

        res.status(200).json(rows[0])

    } catch (error) {
        logger.error(`Error updating tasks:`,error);
        res.status(500).json({error: `Something went wrong while updating list of daily tasks`})
    }
})

// Delete tasks in batch
router.delete('/batch-delete', strictLimiter, async (req, res) => {
    const { tasks } = req.body;

    if(!tasks || !Array.isArray(tasks) || tasks.length === 0){
        return res.status(400).json({ error: 'Array of tasks required!'})
    }

    let client;
    try {

        client = await pool.connect();
        await client.query('BEGIN')

        for(const task of tasks){
            if(!task.id) continue;

            const { rowCount } = await client.query(
                `DELETE FROM daily_tasks
                WHERE id = $1
                AND user_id = $2`, [task.id, req.user.id]
            );

            if(rowCount === 0){
                await client.query('ROLLBACK')
                return res.status(404).json({ error: `Daily task not found`})
            }
        }

        await client.query(`COMMIT`); // End ---
        res.status(200).json({message: `Successfully deleted list of daily tasks`});

    } catch (error) {
        if (client) { try { await client.query('ROLLBACK') } catch { /* connection already broken */ } }
        logger.error(`Error deleting tasks:`,error);
        res.status(500).json({error: `Something went wrong while deleting list of daily tasks`})
    } finally {
        if (client) client.release();
    }
})

// Delete task
router.delete('/:id', strictLimiter, async (req, res) => {
    const { id } = req.params
    
    try {
        const { rowCount } = await pool.query(
            `DELETE FROM daily_tasks
             WHERE id = $1
             AND user_id = $2`, [id, req.user.id]
        );

        if(rowCount === 0) return res.status(404).json({ error: `Daily task not found`})

        res.status(200).json({message: `Successfully deleted daily task`})

    } catch (error) {
        logger.error(`Error deleting tasks:`,error);
        res.status(500).json({error: `Something went wrong while deleting the list of daily tasks`})
    }
})

module.exports = router;