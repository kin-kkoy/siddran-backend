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

    try {
        const {rows} = await pool.query(
            `UPDATE daily_tasks
             SET title = COALESCE($1, title),
                 priority = COALESCE($2, priority),
                 is_completed = COALESCE($3, is_completed),
                 recurrence = COALESCE($4, recurrence),
                 time = COALESCE($5, time),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $6
             AND user_id = $7
             AND (expires_at > NOW() OR recurrence IS NOT NULL)
             RETURNING id, title, priority, is_completed, created_at, updated_at, expires_at, recurrence, time`,
             [title?.trim(), priority, is_completed, recurrenceParam, time, id, req.user.id]
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