const express = require('express')
const router = express.Router()
const pool = require('../db/connection')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const logger = require('../utils/logger')
const { authLimiter } = require('../middleware/rateLimiter')

// Per-account rate limiting for login attempts
const loginAttempts = new Map() // { username: { count: number, lastAttempt: timestamp } }
const MAX_LOGIN_ATTEMPTS = 5
const LOCKOUT_DURATION = 15 * 60 * 1000 // 15 minutes

const checkAccountLockout = (username) => {
    const attempts = loginAttempts.get(username.toLowerCase())
    if (!attempts) return { locked: false }

    const timeSinceLastAttempt = Date.now() - attempts.lastAttempt

    // Reset if lockout period has passed
    if (timeSinceLastAttempt > LOCKOUT_DURATION) {
        loginAttempts.delete(username.toLowerCase())
        return { locked: false }
    }

    if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
        const remainingTime = Math.ceil((LOCKOUT_DURATION - timeSinceLastAttempt) / 60000)
        return { locked: true, remainingMinutes: remainingTime }
    }

    return { locked: false }
}

const recordFailedAttempt = (username) => {
    const key = username.toLowerCase()
    const current = loginAttempts.get(key) || { count: 0 }
    loginAttempts.set(key, { count: current.count + 1, lastAttempt: Date.now() })
}

const clearLoginAttempts = (username) => {
    loginAttempts.delete(username.toLowerCase())
}


// Helper function: cleaup for the old tokens, used by the function after this
const cleanExpiredTokens = async (userId) => {
    try {
        // 2 parts to delete: expired tokens, revoked tokens that are older than 30 days

        // delete expired tokens
        await pool.query(
            `DELETE FROM refresh_tokens
             WHERE user_id = $1
             AND expires_at < NOW()`, [userId]
        )

        // delete revoked tokens
        await pool.query(
            `DELETE FROM refresh_tokens
             WHERE user_id = $1
             AND revoked = TRUE
             AND created_at < NOW() - INTERVAL '30 days'`, [userId]
        )

    } catch (error) {
        logger.error(`Cleaning up tokens error:`, error)
    }
}

//  Helper function for creating tokens and cleaning up refresh tokens W/ EXPLANATION
const generateTokens = async (userId, username) => {
    // QUICK EXPLANATION: You might notice on refreshtokens table in the DB that there's more than 1 row for a single user, that's because i want to support multiple device usage. But each device will only have 1 row now and ofc auto cleanup whenever refresh token is now invalid which is after this function

    // Revamping tokens: 2 tokens now; access & refresh tokens. Access to be sent to frontend while Refresh will be stored in DB
    
    //  cleanup old tokens first then proceed
    await cleanExpiredTokens(userId)

    //  Creating access token
    const accessToken = jwt.sign(
        {id: userId, username},
        process.env.JWT_SECRET,
        {expiresIn: '15m'}
    )


    //  limits the amount of tokens a user can have (for multiple devices) to 5 only
    const tokenCount = await pool.query(
        `SELECT COUNT(*)
         FROM refresh_tokens
         WHERE user_id = $1
         AND revoked = FALSE`, [userId]
    )

    if(parseInt(tokenCount.rows[0].count) >= 5){
        // delete oldest token
        await pool.query(
            `DELETE FROM refresh_tokens
             WHERE id = (
                SELECT id FROM refresh_tokens
                WHERE user_id = $1 AND revoked = FALSE
                ORDER BY created_at ASC
                LIMIT 1
             )`, [userId]
        )
    }


    //  Creating refresh token
    const refreshToken = crypto.randomBytes(40).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

    //  Storing refresh token to DB on it's own table
    await pool.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at)
         VALUES ($1, $2, $3)`, [userId, refreshToken, expiresAt]
    )

    return {accessToken, refreshToken}
}


// register
router.post('/register', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    const salt = 10; // makes hash stronger

    // Quick validation for username/password length ---------------
    if(!username || !password) return res.status(400).json({error: "Username and password must not be empty"})

    // Username validation
    const usernameRegex = /^[a-zA-Z0-9_]{3,30}$/;   // characters that aren't allowed basically
    if(!usernameRegex.test(username)) return res.status(400).json({ error: `Username must be 3-30 characters and can only contain letters, numbers, and underscores`});

    // Password Validation
    if(password.length < 6) return res.status(400).json({error: `Password must be at least 6 characters long`})
    const hasSpecialOrNumber = /[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);
    if(!hasSpecialOrNumber) return res.status(400).json({error: `Password must contain at least one number or special character`})


    try {
        const hashPass = await bcrypt.hash(password, salt);

        const newUser = await pool.query(
            `INSERT INTO users (username, password_hash)
             VALUES ($1, $2)
             RETURNING id, username`, [username, hashPass]
        );

        // create tokens & cookie asap to auto login
        try {
            const tokens = await generateTokens( newUser.rows[0].id, newUser.rows[0].username )

            // explanation of this is in the login section below
            res.cookie('refreshToken', tokens.refreshToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000
            })

            res.status(201).json({
                message: "Registered Successfully",
                accessToken: tokens.accessToken,
            });

        } catch (tokenError) {
            logger.error('Error signing token:', tokenError);
            res.status(500).json({error: "Couldn't sign token"})
        }

    } catch (error) {
        logger.error(`Something went wrong while registering:`, error)
        res.status(500).json({error: `Failed to register the user`})
    }
})


// login
router.post('/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' })
    }

    // Check if account is locked due to too many failed attempts
    const lockoutStatus = checkAccountLockout(username)
    if (lockoutStatus.locked) {
        return res.status(429).json({
            error: `Too many failed login attempts. Please try again in ${lockoutStatus.remainingMinutes} minute(s).`
        })
    }

    try {
        const getUser = await pool.query(
            `SELECT *
            FROM users
            WHERE username = $1`, [username]
        )

        if (getUser.rows.length === 0) {
            recordFailedAttempt(username)
            return res.status(401).json({error: "Incorrect credentials"})
        }

        const user = getUser.rows[0]
        const isUser = await bcrypt.compare(password, user.password_hash)
        if(!isUser) {
            recordFailedAttempt(username)
            return res.status(401).json({error: "Incorrect credentials"})
        }

        // Clear failed attempts on successful login
        clearLoginAttempts(username)

        // tokens part
        try {
            // create both tokens --> send refreshToken as HttpOnly cookie which is much more secure since it can avoid XSS (cross-site scripting) --> just send back the access token

            // create both tokens
            const tokens = await generateTokens(user.id, user.username)
            
            // send refreshToken as HttpOnly cookie
            res.cookie(`refreshToken`, tokens.refreshToken, {
                httpOnly: true, // simple means it can't be accessd by JS
                secure: process.env.NODE_ENV === 'production', // S in HTTPS
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000// 1 week
            })

            // just send back access token
            res.status(200).json({
                message: "Signed in",
                accessToken: tokens.accessToken,
            })

        } catch (tokenError) {
            logger.error('Error signing token:', tokenError);
            res.status(500).json({error: "Couldn't sign token"})
        }

    } catch (error) {
        logger.error(`Something went wrong while logging in:`, error)
        res.status(500).json({error: "Couldn't login user"})
    }
})


// this endpoint is for the refreshing the access token
router.post('/refresh', async (req, res) => {
    const refreshToken = req.cookies.refreshToken // get the token from the cookie and not the body

    if(!refreshToken) return res.status(401).json({error: "Refresh token required"})

    try {
        const result = await pool.query(
            `SELECT user_id, expires_at, revoked
             FROM refresh_tokens
             WHERE token = $1`, [refreshToken]
        )

        if (result.rows.length === 0) return res.status(401).json({error: `Invalid refresh token`})

        const tokenData = result.rows[0]

        if(tokenData.revoked) return res.status(401).json({error: 'Refresh token revoked'})

        // expiry check right here, after the revoked check
        if(new Date() > new Date(tokenData.expires_at)) return res.status(401).json({error: 'Refresh token expired'})
        
        const userResult = await pool.query(
            `SELECT id, username
             FROM users
             WHERE id = $1`, [tokenData.user_id]
        )

        if(userResult.rows.length === 0) return res.status(404).json({error: "user not found"})

        const user = userResult.rows[0]

        // TOKEN ROTATION: Revoke the old refresh token and create new tokens
        // This prevents token reuse attacks - if stolen token is used, legitimate user will notice
        await pool.query(
            `UPDATE refresh_tokens SET revoked = TRUE WHERE token = $1`,
            [refreshToken]
        )

        // Generate new access AND refresh tokens
        const tokens = await generateTokens(user.id, user.username)

        // Set new refresh token in cookie
        res.cookie('refreshToken', tokens.refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 1 week
        })

        res.json({ accessToken: tokens.accessToken })


    } catch (error) {
        logger.error(`Refresh token error:`, error)
        res.status(500).json({error: 'Failed to refresh the token'})
    }
})

// Logout
router.post('/logout', async (req, res) => {
    const refreshToken = req.cookies.refreshToken

    if(!refreshToken) return res.status(400).json({ error: 'Refresh token required' })

    try {
        // revoke the refresh token in the DB
        await pool.query(
            `UPDATE refresh_tokens
             SET revoked = TRUE
             WHERE token = $1`, [refreshToken]
        )
    } catch (error) {
        logger.error(`Logout error:`, error)
    }

    // clearCookie only deletes the cookie if these attributes match the ones it
    // was set with — a cross-site (SameSite=None; Secure) cookie won't be cleared
    // by an attribute-less clearCookie in some browsers.
    res.clearCookie(`refreshToken`, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    })
    res.json({message: "Logged out"})
})



module.exports = router;