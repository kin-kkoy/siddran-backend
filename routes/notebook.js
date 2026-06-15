const express = require('express')
const router = express.Router()
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware');
const { strictLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger')

// get
router.get('/', checkAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const cursor = req.query.cursor;

    try {
        let query, values;

        if(cursor) {
            query = `SELECT n.id, n.name, n.created_at, n.updated_at, n.is_favorite, n.color, n.tags,
                  (SELECT COUNT(*) FROM notes WHERE notebook_id = n.id)::int AS note_count
                FROM notebooks n
                WHERE n.user_id = $1 AND n.created_at < $2
                ORDER BY n.created_at DESC
                LIMIT $3`;
            values = [req.user.id, cursor, limit + 1];
        } else {
            query = `SELECT n.id, n.name, n.created_at, n.updated_at, n.is_favorite, n.color, n.tags,
                  (SELECT COUNT(*) FROM notes WHERE notebook_id = n.id)::int AS note_count
                FROM notebooks n
                WHERE n.user_id = $1
                ORDER BY n.created_at DESC
                LIMIT $2`;
            values = [req.user.id, limit + 1];
        }

        const result = await pool.query(query, values);

        const hasNextPage = result.rows.length > limit;
        const notebooks = hasNextPage ? result.rows.slice(0,-1) : result.rows;
        const nextCursor = hasNextPage ? notebooks[notebooks.length-1].created_at : null;

        res.json({notebooks, pagination: {
            hasNextPage,
            nextCursor,
            limit
        }});

    } catch (error) {
        logger.error('Error fetching notebooks:', error)
        res.status(500).json({error: 'Failed to fetch notebooks'})
    }
});

// Notes for several notebooks in ONE query (replaces the client's N+1 of GET /:id/notes per
// notebook on load). Returns { notesByNotebook: { [id]: notes[] } }. Declared before /:id/notes
// so "notes-batch" can't be captured as an :id.
router.get('/notes-batch', checkAuth, async (req, res) => {
    const ids = String(req.query.ids || '')
        .split(',')
        .map(s => parseInt(s, 10))
        .filter(Number.isInteger)
    if (ids.length === 0) return res.json({ notesByNotebook: {} })

    try {
        const { rows } = await pool.query(
            `SELECT id, title, body, created_at, updated_at, notebook_id, is_favorite, color, tags
             FROM notes
             WHERE user_id = $1 AND notebook_id = ANY($2::int[])
             ORDER BY created_at DESC`,
            [req.user.id, ids]
        )
        const notesByNotebook = {}
        for (const id of ids) notesByNotebook[id] = [] // seed so empty notebooks come back as []
        for (const n of rows) notesByNotebook[n.notebook_id].push(n)
        res.json({ notesByNotebook })
    } catch (error) {
        logger.error('Failed to batch-fetch notebook notes: ', error)
        res.status(500).json({ error: 'Something went wrong while getting notebook notes' })
    }
})

// get notes in a specific notebook (with pagination)
router.get('/:id/notes', checkAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const cursor = req.query.cursor;

    try {
        let query, values;

        if (cursor) {
            query = `SELECT id, title, body, created_at, updated_at, notebook_id, is_favorite, color, tags
                FROM notes
                WHERE notebook_id = $1 AND user_id = $2 AND created_at < $3
                ORDER BY created_at DESC
                LIMIT $4`;
            values = [req.params.id, req.user.id, cursor, limit + 1];
        } else {
            query = `SELECT id, title, body, created_at, updated_at, notebook_id, is_favorite, color, tags
                FROM notes
                WHERE notebook_id = $1 AND user_id = $2
                ORDER BY created_at DESC
                LIMIT $3`;
            values = [req.params.id, req.user.id, limit + 1];
        }

        const result = await pool.query(query, values);

        const hasNextPage = result.rows.length > limit;
        const notes = hasNextPage ? result.rows.slice(0, -1) : result.rows;
        const nextCursor = hasNextPage ? notes[notes.length - 1].created_at : null;

        res.json({
            notes,
            pagination: { hasNextPage, nextCursor, limit }
        });

    } catch (error) {
        logger.error(`Failed to fetch notebook notes: `, error);
        res.status(500).json({error: 'Something went wrong while getting the notes of the notebook'})
    }
})

// post notebook
router.post('/', checkAuth, strictLimiter, async (req, res) => {
    const {name, noteIds, tags} = req.body;   // REMEMBER: noteIds is an ARRAY of note IDs to be added to the notebook

    // FOR NOW: Add limit to # of notes in a notebook, but maybe remove this in the future since notebooks may contain as much notes as possible
    if(noteIds && noteIds.length > 50) return res.status(400).json({ error: 'Max 50 notes per notebook only' })

    // Validate tag length (max 20 characters per tag)
    if(tags && Array.isArray(tags)) {
        const invalidTag = tags.find(tag => tag.length > 20);
        if(invalidTag) return res.status(400).json({ error: 'Each tag must be 20 characters or less' })
    }

    try {

        // FOR NOW: Add limit to # of notebooks and in the future maybe set this to smth like premium users can have more notebooks (max for now: 20)
        const ntbkCount = await pool.query(
            `SELECT COUNT(*)
            FROM notebooks
            WHERE user_id = $1`, [req.user.id]
        );

        if(parseInt(ntbkCount.rows[0].count) >= 20) return res.status(400).json({error: "You have reached the maximum number of notebooks"})


        const ntbkResult = await pool.query(
            `INSERT INTO notebooks (name, user_id, tags)
            VALUES ($1, $2, $3) RETURNING id, name, created_at, updated_at, is_favorite, color, tags`, [name || 'Untitled Notebook', req.user.id, tags || null]
        );

        const notebook = ntbkResult.rows[0]

        let updatedNotes = []

        // if noteIds ARRAY exists and actually has contents, move the contents (which are notes) into the notebook
        if(noteIds && noteIds.length > 0){
            const result = await pool.query(
                `UPDATE notes 
                 SET notebook_id = $1 
                 WHERE id = ANY($2)
                 AND user_id=$3
                 RETURNING *`, [notebook.id, noteIds, req.user.id]
            );

            updatedNotes = result.rows // store the updated notes to be sent back to frontend
        }

        res.status(201).json({notebook, updatedNotes});

    } catch (error) {
        logger.error(`Failed to create notebook: `, error);
        res.status(500).json({error: 'Something went wrong while creating notebook'})
    }
})

// put/update notebook (for name, favorite, color, and tags)
router.put('/:id', checkAuth, strictLimiter, async (req, res) => {
    const { name, is_favorite, color, tags } = req.body;

    // Validate tag length (max 20 characters per tag)
    if(tags && Array.isArray(tags)) {
        const invalidTag = tags.find(tag => tag.length > 20);
        if(invalidTag) return res.status(400).json({ error: 'Each tag must be 20 characters or less' })
    }

    try {
        const updates = [];
        const values = [req.params.id, req.user.id];
        let parameterCount = 3;

        if (name !== undefined) {
            updates.push(`name = $${parameterCount++}`);
            values.push(name.trim().slice(0, 100));
        }

        if (is_favorite !== undefined) {
            updates.push(`is_favorite = $${parameterCount++}`);
            values.push(is_favorite);
        }

        if (color !== undefined) {
            updates.push(`color = $${parameterCount++}`);
            values.push(color);
        }

        if (tags !== undefined) {
            updates.push(`tags = $${parameterCount++}`);
            values.push(tags);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        const query = `
            UPDATE notebooks
            SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND user_id = $2
            RETURNING id, name, created_at, updated_at, is_favorite, color, tags
        `;

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Notebook not found' });
        }

        res.json(result.rows[0]);

    } catch (error) {
        logger.error('Failed to update notebook:', error);
        res.status(500).json({ error: 'Something went wrong while updating notebook' });
    }
});

// add notes to an existing notebook
router.post('/:id/notes', checkAuth, strictLimiter, async (req, res) => {
    const { noteIds } = req.body;

    if (!noteIds || !Array.isArray(noteIds) || noteIds.length === 0) {
        return res.status(400).json({ error: 'noteIds array is required' });
    }

    try {
        const notebookCheck = await pool.query(
            'SELECT id FROM notebooks WHERE id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );
        if (notebookCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Notebook not found' });
        }

        const result = await pool.query(
            `UPDATE notes
             SET notebook_id = $1
             WHERE id = ANY($2)
             AND user_id = $3
             AND notebook_id IS NULL
             RETURNING *`,
            [req.params.id, noteIds, req.user.id]
        );

        res.json({ updatedNotes: result.rows });
    } catch (error) {
        logger.error('Failed to add notes to notebook:', error);
        res.status(500).json({ error: 'Failed to add notes to notebook' });
    }
});

// delete notes from notebook (by setting notebook_id to null in said note) BUT THE NOTE IS STILL ALIVE OK JUST REMOVED FROM THE GROUP (NOTEBOOK)
router.delete('/:notebookId/notes/:noteId', checkAuth, strictLimiter, async (req, res) => {
    try {
        await pool.query(
            `UPDATE notes 
             SET notebook_id = NULL
             WHERE id = $1
             AND notebook_id = $2
             AND user_id = $3`, [req.params.noteId, req.params.notebookId, req.user.id]
        )

        res.json({message: 'Note has been removed from notebook'})
    } catch (error) {
        logger.error(`Failed to delete note: `, error);
        res.status(500).json({error: 'Something went wrong while deleting that certain note'})
    }
})

// delete notebook (notes are still alive just not grouped anymore)
router.delete('/:id', checkAuth, strictLimiter, async (req, res) => {
    let client;
    try {
        // FIRST: Check if user owns this notebook
        const ownershipCheck = await pool.query(
            `SELECT id FROM notebooks WHERE id = $1 AND user_id = $2`,
            [req.params.id, req.user.id]
        );

        if (ownershipCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Notebook not found or you do not have permission to delete it' });
        }

        // Dedicated client so BEGIN/UPDATE/DELETE/COMMIT all run on the SAME connection
        // (pool.query can pick a different connection per statement, breaking the transaction).
        client = await pool.connect();
        await client.query('BEGIN');

        // THEN: UNLINK ALL NOTES before deleting
        await client.query(
            `UPDATE notes
             SET notebook_id = NULL
             WHERE notebook_id = $1 AND user_id = $2`, [req.params.id, req.user.id]
        );

        // ONLY THEN we delete the notebook itself
        await client.query(
            `DELETE FROM notebooks
             WHERE id = $1
             AND user_id = $2`, [req.params.id, req.user.id]
        );

        await client.query('COMMIT');

        res.json({message: 'Notebook has been deleted'})

    } catch (error) {
        if (client) { try { await client.query('ROLLBACK'); } catch { /* connection already broken */ } }
        logger.error(`Failed to delete notebook: `, error);
        res.status(500).json({error: 'Something went wrong while deleting notebook'})
    } finally {
        if (client) client.release();
    }
});

module.exports = router