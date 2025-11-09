const express = require('express')
const router = express.Router()
const pool = require('../db/connection')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')


// register
router.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const salt = 10; // makes hash stronger

    try {
        const hashPass = await bcrypt.hash(password, salt);

        const newUser = await pool.query(
            `INSERT INTO users (username, password_hash)
             VALUES ($1, $2)
             RETURNING id, username`, [username, hashPass]
        );

        // create token asap to auto login
        try {
            const payload = {
                id: newUser.rows[0].id,
                username: newUser.rows[0].username
            }

            const token = jwt.sign(payload, process.env.JWT_SECRET, {expiresIn: '1h'})

            res.status(201).json({
                message: "Registered Successfully",
                token: token
            });

        } catch (tokenError) {
            console.error('Error signing token:', tokenError);
            res.status(500).json({error: "Couldn't sign token"})
        }

    } catch (error) {
        console.error(`Something went wrong while registering:`, error)
        res.status(500).json({error: `Failed to register the user`})
    }
})


// login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const getUser = await pool.query(
            `SELECT * 
            FROM users
            WHERE username = $1`, [username]
        )
        
        if (getUser.rows.length === 0) return res.status(404).json({error: "Incorrect credentials"})

        const user = getUser.rows[0]
        const isUser = await bcrypt.compare(password, user.password_hash)
        if(!isUser) return res.status(404).json({error: "Incorrect credentials"})

        // jwt part -- create payload token -> sign it using JWT_SECRET -> send token back to user
        try {
            const payload = {
                id: user.id,
                username: user.username
            }

            const token = jwt.sign(
                payload,
                process.env.JWT_SECRET,
                { expiresIn: '1h' }
            )

            res.status(200).json({
                message: "Signed in",
                token: token
            })
        } catch (tokenError) {
            console.error('Error signing token:', tokenError);
            res.status(500).json({error: "Couldn't sign token"})
        }
        
    } catch (error) {
        console.error(`Something went wrong while logging in:`, error)
        res.status(500).json({error: "Couldn't login user"})
    }
})


module.exports = router;