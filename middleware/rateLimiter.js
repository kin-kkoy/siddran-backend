const rateLimit = require('express-rate-limit')

// General limiter - for most GET routes
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: `Man chill. You're requesting allat` },
    standardHeaders: true,
    legacyHeaders: false,
})

// Content update limiter - for editing notes (title, body, tags). More lenient because users edit frequently
const contentUpdateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 mins
    max: 150, // Higher limit for content updates in the editor (body)
    message: { error: 'Too many updates, please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
})

// Strict limiter - for create/delete operations
const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { error: `Chill you're requesting too much, slow down` },
    standardHeaders: true,
    legacyHeaders: false,
})

// Auth limiter - for login/register
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many login attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
})

module.exports = { generalLimiter, contentUpdateLimiter, strictLimiter, authLimiter }