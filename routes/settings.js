const express = require('express')
const router = express.Router()
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware')
const logger = require('../utils/logger')

router.use(checkAuth)

// Get user settings
router.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT settings FROM users WHERE id = $1`, [req.user.id]
        )

        if (rows.length === 0) return res.status(404).json({ error: 'User not found' })

        res.json({ settings: rows[0].settings || {} })

    } catch (error) {
        logger.error('Error fetching settings:', error)
        res.status(500).json({ error: 'Something went wrong while fetching settings' })
    }
})

// Update user settings
router.put('/', async (req, res) => {
    const { settings } = req.body

    if (!settings || typeof settings !== 'object') {
        return res.status(400).json({ error: 'Settings object required' })
    }

    try {
        const { rows } = await pool.query(
            `UPDATE users SET settings = $1 WHERE id = $2 RETURNING settings`,
            [JSON.stringify(settings), req.user.id]
        )

        if (rows.length === 0) return res.status(404).json({ error: 'User not found' })

        res.json({ settings: rows[0].settings })

    } catch (error) {
        logger.error('Error updating settings:', error)
        res.status(500).json({ error: 'Something went wrong while updating settings' })
    }
})

module.exports = router
