const express = require('express');
const router = express.Router();
const pool = require('../db/connection');
const checkAuth = require('../middleware/authMiddleware')

// get all notes
router.get('/', checkAuth, async (req, res) => {
    const { id } = req.user;

    try{
        const result = await pool.query(
            `SELECT id, title, body, created_at, updated_at, notebook_id, is_favorite, color, tags
             FROM notes
             WHERE user_id = $1
             ORDER BY created_at DESC`, [id]
        );

        res.status(200).json(result.rows);

    }catch(error){
        console.error('Error fetching notes:', error);
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
        console.error(`Failed to fetch this note:`, error);
        res.status(500).json({error: `Something went wrong while fetching the note`})
    } 
});

// POST /notes
router.post('/', checkAuth, async (req, res) => {
    const { title, body} = req.body;
    const { id: userID } = req.user;
    
    if(!title || title.trim() === '') return res.status(400).json({error: "Needs a title"})

    try {

        const result = await pool.query(
            `INSERT INTO notes (title, body, user_id)
             VALUES ($1, $2, $3) RETURNING *`, [title.trim(), body || '', userID]
        );

        res.status(201).json(result.rows[0])
        
    } catch (error) {
        console.error(`Failed to add note:`, error);
        res.status(500).json({error: "Something went wrong while creating a note"})
    }
})

// PUT /notes/:id
router.put('/:id', checkAuth, async (req, res) => {
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
        console.error(`Failed to edit note:`, error);
        res.status(500).json({error: "Something went wrong while trying edit note"})
    }
})

// DELETE /notes/:id
router.delete('/:id', checkAuth, async (req, res) => {
    const {id: noteID} = req.params;
    const {id: userID} = req.user;

    try {
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
        console.error(`Failed to delete note:`, error);
        res.status(500).json({error: `Something went wrong while deleting the note`})
    }
})


module.exports = router;