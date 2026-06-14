const express = require('express');
const router = express.Router();
const pool = require('../db/connection');
const checkAuth = require('../middleware/authMiddleware')
const { contentUpdateLimiter, strictLimiter } = require('../middleware/rateLimiter')
const logger = require('../utils/logger')
const storage = require('../lib/storage')

// get all notes
router.get('/', checkAuth, async (req, res) => {
    const { id } = req.user;

    // Lightweight picker list (calendar block linking): id + title only, capped. ?picker=1
    if (req.query.picker) {
        try {
            const { rows: items } = await pool.query(
                `SELECT id, title FROM notes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200`,
                [id]
            );
            return res.json({ items });
        } catch (error) {
            logger.error(error);
            return res.status(500).json({ error: 'Failed to fetch notes' });
        }
    }

    // pagination: basically give the data to user by chunks instead of everything to prevent data overload or self DOS. Used cursor for this instead of offset
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const cursor = req.query.cursor; // ISO date string or null for the first page

    try{
        let query, values;

        if(cursor){
            // Get the notes older than the cursor if cursor exists
            query = `SELECT id, title, body, created_at, updated_at, notebook_id, is_favorite, color, tags
                FROM notes
                WHERE user_id = $1 AND
                created_at < $2
                ORDER BY created_at DESC
                LIMIT  $3`;
            values = [id, cursor, limit+1]; // +1 to check if there's a next page
        }else{
            // no cursor existing yet (the first loading (GET) of data) so get the newest notes
            query = ` SELECT id, title, body, created_at, updated_at, notebook_id, is_favorite, color, tags
            FROM notes
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2`;
            values = [id, limit+1];
        }

        // const result = await pool.query(
        //     `SELECT id, title, body, created_at, updated_at, notebook_id, is_favorite, color, tags
        //      FROM notes
        //      WHERE user_id = $1
        //      ORDER BY created_at DESC`, [id]
        // );

        const result = await pool.query(query, values);

        // check if there's next page (the data after the ones we loaded)
        const hasNextPage = result .rows.length > limit;

        // removing the extra item fetched for checking
        const notes = hasNextPage ? result.rows.slice(0, -1) : result.rows;

        // this is the cursor for the next request which is the `created_at` of the last note 
        const nextCursor = hasNextPage ? notes[notes.length - 1].created_at : null;

        res.status(200).json({notes, pagination: { hasNextPage, nextCursor, limit }}); // `nextCursor is for frontend to use for next request`

    }catch(error){
        logger.error('Error fetching notes:', error);
        res.status(500).json({err: 'Something went wrong while fetching notes'})
    }
});

// get the clicked note
router.get('/:id', checkAuth, async (req, res) => {
    const { id: noteID } = req.params;
    const { id: userID } = req.user;

    try {
        const result = await pool.query(
            `SELECT id, title, body, created_at, updated_at, notebook_id, is_favorite, color, tags
             FROM notes
             WHERE id = $1
             AND user_id = $2`, [noteID, userID]
        );

        if(result.rows.length === 0) return res.status(404).json({error: `Note not found`})

        res.status(200).json(result.rows[0]);

    } catch (error) {
        logger.error(`Failed to fetch this note:`, error);
        res.status(500).json({error: `Something went wrong while fetching the note`})
    } 
});

// POST /notes
router.post('/', checkAuth, strictLimiter, async (req, res) => {
    const { title, body} = req.body;
    const { id: userID } = req.user;
    
    if(!title || title.trim() === '') return res.status(400).json({error: "Needs a title"})

    // Body length / Notes contents length/size checker (IF PREMIUM IS GOING TO BE APPLIED, DOUBLE/TRIPLE THE SIZE)
    if(body && body.length > 50000) return res.status(400).json({error: "Too many note contents (max 50,000 characters/letters)"})

    try {

        // User's note count (max 50 notes only, aside from owner mwehehe)
        const noteCount = await pool.query(
            `SELECT COUNT(*)
            FROM notes
            WHERE user_id = $1`, [userID]
        );

        if(parseInt(noteCount.rows[0].count) >= 50) return res.status(400).json({ error: 'You have reached the maximum number of notes'}) // maybe add a message in the future to make users upgrade if they've reached max # of notes.

        const result = await pool.query(
            `INSERT INTO notes (title, body, user_id)
             VALUES ($1, $2, $3) RETURNING id, title, body, created_at, updated_at, notebook_id, is_favorite, color, tags`, [title.trim(), body || '', userID]
        );

        res.status(201).json(result.rows[0])
        
    } catch (error) {
        logger.error(`Failed to add note:`, error);
        res.status(500).json({error: "Something went wrong while creating a note"})
    }
})

// PUT /notes/:id
router.put('/:id', checkAuth, contentUpdateLimiter, async (req, res) => {
    const {title, body, is_favorite, color, tags} = req.body;
    const {id: noteID} = req.params;
    const {id: userID} = req.user;

    const updates = [];
    const values = [];
    let parameterCount = 1;

    if(title !== undefined) {
        updates.push(`title = $${parameterCount++}`);
        values.push(title.trim());
    }

    if(body !== undefined){
        updates.push(`body = $${parameterCount++}`);
        values.push(body);
    }

    if(is_favorite !== undefined){
        updates.push(`is_favorite = $${parameterCount++}`);
        values.push(is_favorite);
    }

    if(color !== undefined){
        updates.push(`color = $${parameterCount++}`);
        values.push(color);
    }

    if(tags !== undefined){
        updates.push(`tags = $${parameterCount++}`);
        values.push(tags);
    }

    if(updates.length === 0) return res.status(400).json({ error: "Nothing to update" })

    updates.push(`updated_at = CURRENT_TIMESTAMP`)
    values.push(noteID);
    values.push(userID);

    try {

        // Orphan cleanup: if body is being updated, find images removed in the new body and delete them from R2
        if (body !== undefined) {
            const { rows: currentRows } = await pool.query(
                `SELECT body FROM notes WHERE id = $1 AND user_id = $2`,
                [noteID, userID]
            )
            if (currentRows.length > 0 && currentRows[0].body) {
                const imageRegex = /!\[[^\]]*\]\(\/uploads\/(\d+)\/([a-f0-9-]+\.\w+)\)/g
                const oldPaths = new Set()
                for (const m of currentRows[0].body.matchAll(imageRegex)) {
                    oldPaths.add(`${m[1]}|${m[2]}`)
                }
                const newPaths = new Set()
                for (const m of (body || '').matchAll(imageRegex)) {
                    newPaths.add(`${m[1]}|${m[2]}`)
                }
                for (const orphan of oldPaths) {
                    if (newPaths.has(orphan)) continue
                    const [ownerId, filename] = orphan.split('|')
                    if (ownerId !== String(userID)) continue // safety: don't delete other users' files
                    await storage.deleteObject({ key: `uploads/${ownerId}/${filename}` }).catch(err => {
                        logger.error('Failed to delete orphaned image during note update:', err)
                    })
                }
            }
        }

        const query = `
            UPDATE notes
            SET ${updates.join(', ')}
            WHERE id = $${parameterCount}
            AND user_id = $${parameterCount + 1}
            RETURNING id, title, body, created_at, updated_at, is_favorite, color, tags
        `;

        const result = await pool.query(query, values)

        if(result.rows.length === 0) return res.status(404).json({error: "Note not found"})

        res.status(200).json(result.rows[0]);

    } catch (error) {
        logger.error(`Failed to edit note:`, error);
        res.status(500).json({error: "Something went wrong while trying edit note"})
    }
})

// DELETE /notes/:id
router.delete('/:id', checkAuth, strictLimiter, async (req, res) => {
    const {id: noteID} = req.params;
    const {id: userID} = req.user;

    try {
        // Fetch the note body first so we can clean up referenced uploads from R2
        const { rows: noteRows } = await pool.query(
            `SELECT body FROM notes WHERE id = $1 AND user_id = $2`,
            [noteID, userID]
        )

        if (noteRows.length > 0 && noteRows[0].body) {
            const matches = noteRows[0].body.matchAll(/!\[[^\]]*\]\(\/uploads\/(\d+)\/([a-f0-9-]+\.\w+)\)/g)
            for (const m of matches) {
                const [, ownerId, filename] = m
                if (ownerId !== String(userID)) continue // safety: don't delete another user's files
                await storage.deleteObject({ key: `uploads/${ownerId}/${filename}` }).catch(err => {
                    logger.error('Failed to delete uploaded image during note deletion:', err)
                })
            }
        }

        const result = await pool.query(
            `DELETE FROM notes
             WHERE id = $1
             AND user_id = $2
             RETURNING id`, [noteID, userID]
        )

        // double check, to ensure that something was deletd
        if(result.rows.length === 0) return res.status(404).json({error: `Note wasn't found`})

        res.status(200).json({ message: "Note was deleted successfully:", id: result.rows[0].id });

    } catch (error) {
        logger.error(`Failed to delete note:`, error);
        res.status(500).json({error: `Something went wrong while deleting the note`})
    }
})


module.exports = router;