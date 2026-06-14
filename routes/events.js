const express = require('express');
const router = express.Router()
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware');
const { strictLimiter, contentUpdateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger')

// A calendar "block" is a first-class item: standalone (ref_type NULL) or linked to an
// existing entity. Mirrors routes/tasks.js, but reads are a range query (the calendar always
// asks for a visible window) rather than cursor pagination.

router.use(checkAuth);

// Allowed polymorphic link targets. ref_id has no FK (note/task/project/daily ids are INTEGER,
// sandbox ids are UUID), so we validate ref_type here and let a deleted target degrade to a
// standalone block on the client.
const REF_TYPES = ['note', 'task', 'daily', 'project', 'sandbox'];

// GET blocks overlapping a [from, to) window: GET /events?from=ISO&to=ISO
// Overlap test uses COALESCE(end_at, start_at) so point events (no end) are matched by their start.
router.get('/', async (req, res) => {
    const { from, to } = req.query;

    try {
        let query, values;

        if (from && to) {
            query = `SELECT id, title, description, start_at, end_at, all_day, color, ref_type, ref_id, created_at, updated_at
                FROM calendar_events
                WHERE user_id = $1
                AND start_at < $3
                AND COALESCE(end_at, start_at) >= $2
                ORDER BY start_at ASC`;
            values = [req.user.id, from, to];
        } else {
            // No window → return everything for the user (bounded by their own data).
            query = `SELECT id, title, description, start_at, end_at, all_day, color, ref_type, ref_id, created_at, updated_at
                FROM calendar_events
                WHERE user_id = $1
                ORDER BY start_at ASC`;
            values = [req.user.id];
        }

        const { rows: events } = await pool.query(query, values);

        res.json({ events });

    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to fetch events' })
    }
});

// POST a block
router.post('/', strictLimiter, async (req, res) => {
    const { title, description, start_at, end_at, all_day, color, ref_type, ref_id } = req.body;

    // Validation
    if (!title || title.trim().length === 0) {
        return res.status(400).json({ error: 'Title is required' });
    }

    if (title.length > 200) {
        return res.status(400).json({ error: 'Title must be 200 characters or less' });
    }

    if (!start_at) {
        return res.status(400).json({ error: 'start_at is required' });
    }

    if (ref_type != null && !REF_TYPES.includes(ref_type)) {
        return res.status(400).json({ error: 'Invalid ref_type' });
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO calendar_events (user_id, title, description, start_at, end_at, all_day, color, ref_type, ref_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id, title, description, start_at, end_at, all_day, color, ref_type, ref_id, created_at, updated_at`,
            [
                req.user.id,
                title.trim(),
                description?.trim() || null,
                start_at,
                end_at || null,
                all_day ?? false,
                color || null,
                ref_type || null,
                ref_type ? (ref_id ?? null) : null,
            ]
        );

        res.status(201).json({ ...rows[0] });

    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to create event' })
    }
})

// PUT update a block. The SET clause is built from only the keys PRESENT in the body, so an
// explicit null CLEARS a field (e.g. unlinking → ref_type/ref_id = null, or end_at = null when a
// timed block becomes all-day) while an absent key is left untouched (so drag-retime, which only
// sends start_at/end_at/all_day, never clobbers a link). Replaces the old COALESCE form, which
// couldn't tell "absent" from "null" and thus couldn't clear a link.
router.put('/:id', contentUpdateLimiter, async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};

    if (body.title != null && String(body.title).length > 200) {
        return res.status(400).json({ error: 'Title must be 200 characters or less' });
    }

    if (body.ref_type != null && !REF_TYPES.includes(body.ref_type)) {
        return res.status(400).json({ error: 'Invalid ref_type' });
    }

    const allowed = ['title', 'description', 'start_at', 'end_at', 'all_day', 'color', 'ref_type', 'ref_id'];
    const sets = [];
    const values = [];
    for (const key of allowed) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
        let val = body[key];
        if ((key === 'title' || key === 'description') && typeof val === 'string') val = val.trim();
        // A link is a pair: if the type is cleared, clear the id too.
        if (key === 'ref_id' && body.ref_type === null) val = null;
        values.push(val);
        sets.push(`${key} = $${values.length}`);
    }

    if (sets.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const idParam = `$${values.length}`;
    values.push(req.user.id);
    const userParam = `$${values.length}`;

    try {
        const { rows } = await pool.query(
            `UPDATE calendar_events
             SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = ${idParam} AND user_id = ${userParam}
             RETURNING id, title, description, start_at, end_at, all_day, color, ref_type, ref_id, created_at, updated_at`,
            values
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        res.json({ ...rows[0] });

    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to update event' })
    }
})

// DELETE a block
router.delete('/:id', strictLimiter, async (req, res) => {
    const { id } = req.params

    try {
        const { rowCount } = await pool.query(
            `DELETE FROM calendar_events
             WHERE id = $1
             AND user_id = $2`,
             [id, req.user.id]
        );

        if (rowCount === 0) return res.status(404).json({ error: 'Event not found' })

        res.json({ message: 'Event deleted successfully' })

    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to delete event' })
    }
})

module.exports = router;
