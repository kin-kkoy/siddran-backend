const express = require('express');
const router = express.Router()
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware')


// Just found out that I could've just done it this way lol, but I still find the structure of notes.js to be more intuitive
router.use(checkAuth);


// GET ALL tasks
router.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT *
             FROM tasks
             WHERE user_id = $1
             ORDER BY is_completed ASC, created_at DESC`, [req.user.id]
        );

        res.json(rows)

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: `Something went wrong while fetching tasks` })
    }
});

// POST a task
router.post('/', async (req, res) => {
    const { content, priority, due_date } = req.body

    try {
        const { rows } = await pool.query(
            `INSERT INTO tasks (user_id, content, priority, due_date)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
             [req.user.id, content, priority || 'normal', due_date || null]
        );

        res.status(201).json(rows[0])
        
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: `Something went while creating task` })
    }
})

// PUT a task (like completing, editing, etc.)
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { content, is_completed, priority, due_date } = req.body

    try {
        const { rows } = await pool.query(
            `UPDATE tasks
             SET content = COALESCE($1, content), 
                 is_completed = COALESCE($2, is_completed), 
                 priority = COALESCE($3, priority), 
                 due_date = COALESCE($4, due_date),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $5 AND user_id = $6 
             RETURNING *`, 
             [content, is_completed, priority, due_date, id, req.user.id]
        )

        if(rows.length === 0) return res.status(404).json({ error: 'Task not found' })
        
        res.json(rows[0]);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: `Something went wrong while updating task` })
    }

})

// DELETE a task
router.delete('/:id', async (req, res) => {
    const { id } = req.params

    try {
        const { rowCount } = await pool.query(
            `DELETE FROM tasks
             WHERE id = $1 
             AND user_id = $2`,
             [id, req.user.id]
        );

        if(rowCount === 0) return res.status(404).json({ error: `Task not found`})

        res.json({ message: `Task deleted successfully` })

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: `Something went wrong while deleting the task` })
    }
})

module.exports = router;