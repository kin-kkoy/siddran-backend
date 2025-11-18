const express = require('express')
const router = express.Router()
const pool = require('../db/connection')
const checkAuth = require('../middleware/authMiddleware')

// get
router.get('/', checkAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT *
             FROM notebooks
             WHERE user_id = $1
             ORDER BY created_at DESC`, [req.user.id]
        );

        res.json(result.rows);

    } catch (error) {
        console.error('Error fetching notebooks:', error)
        res.status(500).json({error: 'Failed to fetch notebooks'})
    }
});

// get notes in a specific notebook
router.get('/:id/notes', checkAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT *
             FROM notes
             WHERE notebook_id = $1
             AND user_id = $2
             ORDER BY created_at DESC`, [req.params.id, req.user.id]
        );

        res.json(result.rows);
        
    } catch (error) {
        console.error(`Failed to fetch notebook notes: `, error);
        res.status(500).json({error: 'Something went wrong while getting the notes of the notebook'})
    }
})

// post notebook
router.post('/', checkAuth, async (req, res) => {
    const {name, noteIds} = req.body;   // REMEMBER: noteIds is an ARRAY of note IDs to be added to the notebook

    try {
        const ntbkResult = await pool.query(
            `INSERT INTO notebooks (name, user_id) 
            VALUES ($1, $2) RETURNING *`, [name || 'Untitled Notebook', req.user.id]
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
        console.error(`Failed to create notebook: `, error);
        res.status(500).json({error: 'Something went wrong while creating notebook'})
    }
})

// put more notes into the notebook (go back later)

// delete notes from notebook (by setting notebook_id to null in said note) BUT THE NOTE IS STILL ALIVE OK JUST REMOVED FROM THE GROUP (NOTEBOOK)
router.delete('/:notebookId/notes/:noteId', checkAuth, async (req, res) => {
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
        console.error(`Failed to delete note: `, error);
        res.status(500).json({error: 'Something went wrong while deleting that certain note'})
    }
})

// delete notebook (notes are still alive just not grouped anymroe)
router.delete('/:id', checkAuth, async (req, res) => {
    try {
        // FIRST: UNLINK ALL NOTES before deleting
        await pool.query(
            `UPDATE notes 
             SET notebook_id = NULL
             WHERE notebook_id = $1`, [req.params.id]
        );

        // ONLY THEN we delete the notebook itself
        await pool.query(
            `DELETE FROM notebooks
             WHERE id = $1
             AND user_id = $2`, [req.params.id, req.user.id]
        );
        
        res.json({message: 'Notebook has been deleted'})

    } catch (error) {
        console.error(`Failed to delete notebook: `, error);
        res.status(500).json({error: 'Something went wrong while deleting notebook'})
    }
});

module.exports = router