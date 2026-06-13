const rateLimit = require('express-rate-limit')

// General limiter - for most GET routes. A single authed page load makes ~9 GETs (settings,
// notes, notebooks, tasks, daily-tasks, projects, events, tasks?dated, tasks?undated), so 100/15min
// trips after ~11 reloads. 400 gives comfortable headroom for normal navigation/refreshing while
// still bounding abuse per IP.
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 400,
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

// Upload limiter - for image presign requests. Higher per-minute cap than strictLimiter to support pasting multiple images at once
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30,
    message: { error: 'Too many uploads, slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
})

module.exports = { generalLimiter, contentUpdateLimiter, strictLimiter, authLimiter, uploadLimiter }