const express = require('express')
const router = express.Router()
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware')
const { strictLimiter, contentUpdateLimiter } = require('../middleware/rateLimiter')

router.use(checkAuth)


// remove all expired tasks (beyond 24 hrs already)
const removeExpiredTasks = async (userId) => {
    try {
        await pool.query(
            `DELETE FROM daily_tasks
             WHERE user_id = $1 
             AND expires_at < NOW()`, [userId]
        );
    } catch (error) {
        console.error(`Removing expired tasks error:`, error)
    }
}

// Get all tasks
router.get('/', async (req, res) => {
    const userId = req.user.id

    try {
        await removeExpiredTasks(userId)

        const { rows } = await pool.query(
            `SELECT * FROM daily_tasks
             WHERE user_id = $1
             AND expires_at > NOW()
             ORDER BY is_completed ASC, created_at DESC`, [userId]
        );

        res.json(rows)

    } catch (error) {
        console.error(`Error fetching tasks:`,error);
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

    try {

        // FOR NOW: Limit standard user's task count to 100 except for owner mwehhe. Like the other limiters, limit/max will be increased/removed if premium user
        const dailyTaskCount = await pool.query(
            `SELECT COUNT(*) FROM daily_tasks
             WHERE user_id = $1
             AND expires_at > NOW()`, [req.user.id]
        );

        const currentDTCount = parseInt(dailyTaskCount.rows[0].count);
        if(currentDTCount + tasks.length > 50) return res.status(400).json({ error: `You can only have 50 active daily tasks at once. Currently have: ${currentDTCount}`})


        await pool.query('BEGIN'); // Start Batch Transaction

        const createdTasks = [];
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours

        for (const task of tasks){
            if(!task.title || task.title.trim().length === 0) continue; // don't add basically

            const {rows} = await pool.query(
                `INSERT INTO daily_tasks (user_id, title, priority, expires_at)
                 VALUES ($1, $2, $3, $4)
                 RETURNING *`, [req.user.id, task.title.trim(), task.priority || 'normal', expiresAt]);
            createdTasks.push(rows[0]);
        }

        await pool.query(`COMMIT`); // End ---
        res.status(201).json(createdTasks);

    } catch (error) {
        await pool.query('ROLLBACK')
        console.error(`Error in adding daily tasks:`, error)
        res.status(500).json({error: `Something went wrong while adding list of daily tasks`})
    }
})

// Update tasks (completion of task)
router.put('/:id', contentUpdateLimiter, async (req, res) => {
    const { id } = req.params;
    const { is_completed } = req.body;
    
    try {
        const {rows} = await pool.query(
            `UPDATE daily_tasks
             SET is_completed = COALESCE($1, is_completed), updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             AND user_id = $3
             AND expires_at > NOW()
             RETURNING *`, [is_completed, id, req.user.id]
        )

        if(rows.length === 0) return res.status(404).json({error: 'List of daily tasks not found or expired already'})

        res.status(200).json(rows[0])

    } catch (error) {
        console.error(`Error updating tasks:`,error);
        res.status(500).json({error: `Something went wrong while updating list of daily tasks`})
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

        if(rowCount === 0) res.status(404).json({ error: `Daily task not found`})

        res.status(200).json({message: `Successfully deleted daily task`})

    } catch (error) {
        console.error(`Error deleting tasks:`,error);
        res.status(500).json({error: `Something went wrong while deleting the list of daily tasks`})
    }
})

module.exports = router;