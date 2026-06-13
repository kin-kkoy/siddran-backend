const express = require("express");
const router = express.Router();
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware');
const { strictLimiter, contentUpdateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger')


router.use(checkAuth);


// ----- constants & helpers -----

const MAX_TITLE = 100;
const MAX_BATCH = 500; // upserts per batch request — keeps a single transaction bounded
const ITEM_TYPES = new Set(['stroke', 'shape', 'image', 'note', 'task', 'text', 'connector']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// REAL columns are nullable for w/h; x/y are NOT NULL. Coerce to a finite number
// or fall back so a malformed client value can't blow up the INSERT.
const num = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
};
const numOrNull = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};


// ----- SANDBOX ROUTES -----

// GET all sandboxes (lightweight list for the hub — counts come from the denormalized
// item_count column, so the hub never has to read every board's items)
router.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, title, item_count, created_at, updated_at
             FROM sandboxes
             WHERE user_id = $1
             ORDER BY updated_at DESC`,
            [req.user.id]
        );
        res.status(200).json({ sandboxes: rows });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to fetch sandboxes' })
    }
});

// GET a single sandbox plus all of its items
router.get('/:id', async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) return res.status(404).json({ error: 'Sandbox not found' });

    try {
        const { rows: boardRows } = await pool.query(
            `SELECT id, title, item_count, created_at, updated_at
             FROM sandboxes
             WHERE id = $1 AND user_id = $2`,
            [id, req.user.id]
        );
        if (boardRows.length === 0) return res.status(404).json({ error: 'Sandbox not found' });

        const { rows: items } = await pool.query(
            `SELECT id, type, x, y, w, h, rotation, z_index, payload, created_at, updated_at
             FROM sandbox_items
             WHERE sandbox_id = $1
             ORDER BY z_index ASC, created_at ASC`,
            [id]
        );

        res.status(200).json({ sandbox: boardRows[0], items });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to fetch sandbox' })
    }
});

// POST create a sandbox. The client may supply a crypto.randomUUID id so the optimistic
// record and the server row share an id (no swap needed); otherwise the DB generates one.
router.post('/', strictLimiter, async (req, res) => {
    const { id, title } = req.body;

    if (!title || title.trim().length === 0) return res.status(400).json({ error: 'Title is required' });
    if (title.length > MAX_TITLE) return res.status(400).json({ error: `Title must be ${MAX_TITLE} characters or less` });
    if (id !== undefined && !isUuid(id)) return res.status(400).json({ error: 'Invalid sandbox id' });

    try {
        // Client-supplied id is the common path; if it already exists for this user treat
        // it as a no-op success so a retried/migrated create is idempotent.
        if (id) {
            const existing = await pool.query(
                `SELECT id, title, item_count, created_at, updated_at
                 FROM sandboxes
                 WHERE id = $1 AND user_id = $2`,
                [id, req.user.id]
            );
            if (existing.rows.length > 0) return res.status(200).json(existing.rows[0]);
        }

        const { rows } = await pool.query(
            `INSERT INTO sandboxes (id, user_id, title)
             VALUES (COALESCE($1, gen_random_uuid()), $2, $3)
             RETURNING id, title, item_count, created_at, updated_at`,
            [id || null, req.user.id, title.trim()]
        );

        res.status(201).json(rows[0]);
    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to create sandbox' })
    }
});

// PUT rename / touch a sandbox
router.put('/:id', contentUpdateLimiter, async (req, res) => {
    const { id } = req.params;
    const { title } = req.body;

    if (!isUuid(id)) return res.status(404).json({ error: 'Sandbox not found' });
    if (title !== undefined && title.length > MAX_TITLE) return res.status(400).json({ error: `Title must be ${MAX_TITLE} characters or less` });

    try {
        const { rows } = await pool.query(
            `UPDATE sandboxes
             SET title = COALESCE($1, title),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND user_id = $3
             RETURNING id, title, item_count, created_at, updated_at`,
            [title?.trim(), id, req.user.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Sandbox not found' });

        res.status(200).json(rows[0]);
    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to update sandbox' })
    }
});

// DELETE a sandbox (items cascade)
router.delete('/:id', strictLimiter, async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) return res.status(404).json({ error: 'Sandbox not found' });

    try {
        const { rowCount } = await pool.query(
            `DELETE FROM sandboxes
             WHERE id = $1 AND user_id = $2`,
            [id, req.user.id]
        );
        if (rowCount === 0) return res.status(404).json({ error: 'Sandbox not found' });

        res.status(200).json({ message: 'Successfully deleted sandbox' });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Failed to delete sandbox' })
    }
});


// ----- SANDBOX ITEMS (batch delta-sync) -----

// POST batch upsert + delete of items for one board, in a single transaction. The client
// sends only the items dirtied/deleted since its last flush — never one request per stroke.
router.post('/:id/items/batch', contentUpdateLimiter, async (req, res) => {
    const { id } = req.params;
    const { upserts, deletes } = req.body;

    if (!isUuid(id)) return res.status(404).json({ error: 'Sandbox not found' });

    const upsertList = Array.isArray(upserts) ? upserts : [];
    const deleteList = Array.isArray(deletes) ? deletes : [];

    if (upsertList.length === 0 && deleteList.length === 0) {
        return res.status(400).json({ error: 'Nothing to sync' });
    }
    if (upsertList.length > MAX_BATCH) {
        return res.status(400).json({ error: `Too many items in one batch (${MAX_BATCH} max)` });
    }

    // Validate up front so we never open a transaction on bad input.
    for (const item of upsertList) {
        if (!item || !isUuid(item.id)) return res.status(400).json({ error: 'Each item needs a valid id' });
        if (!ITEM_TYPES.has(item.type)) return res.status(400).json({ error: `Invalid item type: ${item.type}` });
        if (item.payload === undefined || item.payload === null || typeof item.payload !== 'object') {
            return res.status(400).json({ error: 'Each item needs a payload object' });
        }
    }
    const deleteIds = deleteList.filter(isUuid);

    // Ownership check before any write (single autocommit query, no transaction).
    let owns;
    try {
        owns = await pool.query(
            `SELECT 1 FROM sandboxes WHERE id = $1 AND user_id = $2`,
            [id, req.user.id]
        );
    } catch (error) {
        logger.error(error);
        return res.status(500).json({ error: 'Failed to sync sandbox items' })
    }
    if (owns.rows.length === 0) return res.status(404).json({ error: 'Sandbox not found' });

    // A dedicated client so BEGIN/INSERT/COMMIT all run on the SAME connection.
    // pool.query() can pick a different pooled connection per statement, which breaks
    // transactions (and can leave an aborted connection in the pool) under concurrency.
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const item of upsertList) {
            // The ON CONFLICT WHERE guard means an id that somehow belongs to another board
            // is left untouched rather than hijacked into this one.
            await client.query(
                `INSERT INTO sandbox_items
                    (id, sandbox_id, type, x, y, w, h, rotation, z_index, payload, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, CURRENT_TIMESTAMP)
                 ON CONFLICT (id) DO UPDATE SET
                    type = EXCLUDED.type,
                    x = EXCLUDED.x,
                    y = EXCLUDED.y,
                    w = EXCLUDED.w,
                    h = EXCLUDED.h,
                    rotation = EXCLUDED.rotation,
                    z_index = EXCLUDED.z_index,
                    payload = EXCLUDED.payload,
                    updated_at = CURRENT_TIMESTAMP
                 WHERE sandbox_items.sandbox_id = $2`,
                [
                    item.id,
                    id,
                    item.type,
                    num(item.x),
                    num(item.y),
                    numOrNull(item.w),
                    numOrNull(item.h),
                    num(item.rotation),
                    Math.trunc(num(item.z_index)),
                    JSON.stringify(item.payload),
                ]
            );
        }

        if (deleteIds.length > 0) {
            await client.query(
                `DELETE FROM sandbox_items
                 WHERE sandbox_id = $1 AND id = ANY($2::uuid[])`,
                [id, deleteIds]
            );
        }

        // Recompute the denormalized count + bump updated_at in the same transaction.
        const { rows } = await client.query(
            `UPDATE sandboxes
             SET item_count = (SELECT COUNT(*) FROM sandbox_items WHERE sandbox_id = $1),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND user_id = $2
             RETURNING item_count, updated_at`,
            [id, req.user.id]
        );

        await client.query('COMMIT');

        res.status(200).json(rows[0]);
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
        logger.error(error);
        res.status(500).json({ error: 'Failed to sync sandbox items' })
    } finally {
        client.release();
    }
});


module.exports = router;
