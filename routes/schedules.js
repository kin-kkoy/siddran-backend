const express = require('express')
const router = express.Router()
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware')
const { strictLimiter, contentUpdateLimiter } = require('../middleware/rateLimiter')
const logger = require('../utils/logger')
const { bulkValues } = require('../utils/sqlBulk')

// Map a Designer block to a calendar_events row tuple (column order below). ref_id is TEXT
// (polymorphic), and is only kept when ref_type is set.
const eventRow = (e, userId, scheduleId) => [
    userId, e.title.trim(), e.description?.trim() || null,
    e.start_at, e.end_at || null, e.all_day ?? false, e.color || null,
    e.ref_type || null, e.ref_type ? (e.ref_id ?? null) : null, scheduleId,
]
const EVENT_CASTS = ['int', 'text', 'text', 'timestamptz', 'timestamptz', 'boolean', 'text', 'text', 'text', 'int']
const EVENT_COLS = '(user_id, title, description, start_at, end_at, all_day, color, ref_type, ref_id, schedule_id)'
const EVENT_RETURNING = 'id, title, description, start_at, end_at, all_day, color, ref_type, ref_id, schedule_id, created_at, updated_at'

// A "schedule" groups the blocks stamped from the Schedule Designer (a designed weekly timetable
// applied across a date range), so a whole term can be renamed / recoloured / bulk-deleted as a unit.

router.use(checkAuth)

const REF_TYPES = ['note', 'task', 'daily', 'project', 'sandbox']
const MAX_EVENTS = 500

// List the user's schedules with their block counts.
router.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT s.id, s.name, s.color, s.template, s.created_at, COUNT(e.id)::int AS block_count
             FROM schedules s
             LEFT JOIN calendar_events e ON e.schedule_id = s.id
             WHERE s.user_id = $1
             GROUP BY s.id
             ORDER BY s.created_at DESC`,
            [req.user.id]
        )
        res.json({ schedules: rows })
    } catch (error) {
        logger.error(error)
        res.status(500).json({ error: 'Failed to fetch schedules' })
    }
})

// Create a named schedule + bulk-insert its stamped blocks in ONE transaction.
router.post('/', strictLimiter, async (req, res) => {
    const { name, color, events, template } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: 'A schedule name is required' })
    if (!Array.isArray(events) || events.length === 0) return res.status(400).json({ error: 'An events array is required' })
    if (events.length > MAX_EVENTS) return res.status(400).json({ error: `Too many blocks (max ${MAX_EVENTS})` })
    for (const e of events) {
        if (!e.title || !e.start_at) return res.status(400).json({ error: 'Each block needs a title and start_at' })
        if (e.ref_type != null && !REF_TYPES.includes(e.ref_type)) return res.status(400).json({ error: 'Invalid ref_type' })
    }

    let client
    try {
        client = await pool.connect()
        await client.query('BEGIN')

        const { rows: sRows } = await client.query(
            `INSERT INTO schedules (user_id, name, color, template) VALUES ($1, $2, $3, $4)
             RETURNING id, name, color, template, created_at`,
            [req.user.id, name.trim(), color || null, template ? JSON.stringify(template) : null]
        )
        const schedule = sRows[0]

        // All blocks in one multi-row INSERT (was one INSERT per block, up to 500).
        const ev = bulkValues(events.map(e => eventRow(e, req.user.id, schedule.id)), 1, EVENT_CASTS)
        const { rows: created } = await client.query(
            `INSERT INTO calendar_events ${EVENT_COLS} VALUES ${ev.text} RETURNING ${EVENT_RETURNING}`,
            ev.values
        )

        await client.query('COMMIT')
        res.status(201).json({ schedule: { ...schedule, block_count: created.length }, events: created })
    } catch (error) {
        if (client) { try { await client.query('ROLLBACK') } catch { /* connection already broken */ } }
        logger.error(error)
        res.status(500).json({ error: 'Failed to create schedule' })
    } finally {
        if (client) client.release()
    }
})

// Rename / recolour a schedule. A recolour repaints all of its blocks too.
router.put('/:id', contentUpdateLimiter, async (req, res) => {
    const { id } = req.params
    const { name, color } = req.body
    const recolor = Object.prototype.hasOwnProperty.call(req.body, 'color')

    let client
    try {
        client = await pool.connect()
        await client.query('BEGIN')

        const { rows } = await client.query(
            `UPDATE schedules SET name = COALESCE($1, name), color = CASE WHEN $2 THEN $3 ELSE color END
             WHERE id = $4 AND user_id = $5
             RETURNING id, name, color, created_at`,
            [name?.trim(), recolor, recolor ? (color || null) : null, id, req.user.id]
        )
        if (rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Schedule not found' }) }

        if (recolor) {
            await client.query(
                `UPDATE calendar_events SET color = $1, updated_at = CURRENT_TIMESTAMP WHERE schedule_id = $2 AND user_id = $3`,
                [color || null, id, req.user.id]
            )
        }

        await client.query('COMMIT')
        res.json({ schedule: rows[0] })
    } catch (error) {
        if (client) { try { await client.query('ROLLBACK') } catch { /* connection already broken */ } }
        logger.error(error)
        res.status(500).json({ error: 'Failed to update schedule' })
    } finally {
        if (client) client.release()
    }
})

// Edit (in-place): replace ALL of a schedule's blocks with a freshly-stamped set, and update its
// name / colour / template — in ONE transaction. Used by the Designer's "Edit" flow.
router.put('/:id/restamp', strictLimiter, async (req, res) => {
    const { id } = req.params
    const { name, color, events, template } = req.body
    if (!Array.isArray(events) || events.length === 0) return res.status(400).json({ error: 'An events array is required' })
    if (events.length > MAX_EVENTS) return res.status(400).json({ error: `Too many blocks (max ${MAX_EVENTS})` })
    for (const e of events) {
        if (!e.title || !e.start_at) return res.status(400).json({ error: 'Each block needs a title and start_at' })
        if (e.ref_type != null && !REF_TYPES.includes(e.ref_type)) return res.status(400).json({ error: 'Invalid ref_type' })
    }
    const recolor = Object.prototype.hasOwnProperty.call(req.body, 'color')

    let client
    try {
        client = await pool.connect()
        await client.query('BEGIN')

        const { rows: sRows } = await client.query(
            `UPDATE schedules
             SET name = COALESCE($1, name), color = CASE WHEN $2 THEN $3 ELSE color END, template = COALESCE($4, template)
             WHERE id = $5 AND user_id = $6
             RETURNING id, name, color, template, created_at`,
            [name?.trim(), recolor, recolor ? (color || null) : null, template ? JSON.stringify(template) : null, id, req.user.id]
        )
        if (sRows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Schedule not found' }) }

        await client.query(`DELETE FROM calendar_events WHERE schedule_id = $1 AND user_id = $2`, [id, req.user.id])

        // Re-stamp the whole set in one multi-row INSERT (was one INSERT per block, up to 500).
        const ev = bulkValues(events.map(e => eventRow(e, req.user.id, id)), 1, EVENT_CASTS)
        const { rows: created } = await client.query(
            `INSERT INTO calendar_events ${EVENT_COLS} VALUES ${ev.text} RETURNING ${EVENT_RETURNING}`,
            ev.values
        )

        await client.query('COMMIT')
        res.json({ schedule: { ...sRows[0], block_count: created.length }, events: created })
    } catch (error) {
        if (client) { try { await client.query('ROLLBACK') } catch { /* connection already broken */ } }
        logger.error(error)
        res.status(500).json({ error: 'Failed to update schedule' })
    } finally {
        if (client) client.release()
    }
})

// Delete a schedule — cascades away its stamped blocks (ON DELETE CASCADE).
router.delete('/:id', strictLimiter, async (req, res) => {
    const { id } = req.params
    try {
        const { rowCount } = await pool.query(`DELETE FROM schedules WHERE id = $1 AND user_id = $2`, [id, req.user.id])
        if (rowCount === 0) return res.status(404).json({ error: 'Schedule not found' })
        res.json({ message: 'Schedule deleted', id: Number(id) })
    } catch (error) {
        logger.error(error)
        res.status(500).json({ error: 'Failed to delete schedule' })
    }
})

module.exports = router
