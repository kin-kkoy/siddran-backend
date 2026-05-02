// Flow: Imports -> App itself -> middlewares -> routes -> port running (backend)

const express = require('express')
const cors = require('cors')
require('dotenv').config()
const authRouter = require ('./routes/auth')
const notesRouter = require('./routes/notes')
const notebooksRouter = require('./routes/notebook')
const tasksRouter = require('./routes/tasks')
const projectsRouter = require('./routes/projects')
const dailyTasksRouter = require('./routes/dailyTasks')
const settingsRouter = require('./routes/settings')
const uploadsRouter = require('./routes/uploads')
const cookieParser = require('cookie-parser')
const helmet = require('helmet')
const morgan = require('morgan')
const { generalLimiter } = require('./middleware/rateLimiter')
const pool = require('./db/connection')
const logger = require('./utils/logger')

// Cleanup expired tokens on server startup
const cleanupExpiredTokens = async () => {
    try {
        const expiredResult = await pool.query(
            `DELETE FROM refresh_tokens WHERE expires_at < NOW()`
        )
        const revokedResult = await pool.query(
            `DELETE FROM refresh_tokens
             WHERE revoked = TRUE
             AND created_at < NOW() - INTERVAL '30 days'`
        )
        logger.info(`Token cleanup: Removed ${expiredResult.rowCount} expired and ${revokedResult.rowCount} old revoked tokens`)
    } catch (error) {
        logger.error('Token cleanup failed:', error)
    }
}

// Run cleanup on startup (skip on Vercel where this would run on every cold start)
if (!process.env.VERCEL) {
    cleanupExpiredTokens()
}

const app = express();
const PORT = process.env.PORT || 3000;

// Trust first proxy - apparently is REQUIRED for rate limiting to work on deployed platforms
app.set('trust proxy', 1);

// middlewares
app.use(helmet({
  contentSecurityPolicy: false,   // API-only server, no HTML served
  hsts: {
    maxAge: 31536000,             // 1 year
    includeSubDomains: true,
  },
}))
app.use(cors({
  origin: process.env.FRONTEND_URL,  // FRONTEND URL
  credentials: true  // Allow cookies to be sent!
}));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser()); // duh parses the cookie

// Request logging - 'dev' format in development, 'combined' in production for more detail
// Custom format includes timestamp for better debugging
app.use(morgan(':date[iso] :method :url :status :response-time ms - :res[content-length]'))

// Health check endpoint (pings the server to checks if it's alive or not)
// IMPORTANT: This must be BEFORE rate limiter so deployment platforms (e.g., Render) can ping it without getting rate-limited
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Ember API is running' });
});

app.use(generalLimiter);

// routes
app.use('/auth', authRouter);
app.use('/notes', notesRouter);
app.use('/notebooks', notebooksRouter)
app.use('/tasks', tasksRouter)
app.use('/projects', projectsRouter)
app.use('/daily-tasks', dailyTasksRouter)
app.use('/settings', settingsRouter)
app.use('/uploads', uploadsRouter)

// route not found handler (if route (page) doesn't exist)
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' })
})

// another safety net for the whole server. If an error happens and is not caught by the try-catches, this guy will catch it and show it in console, without it the whole server would crash.
app.use((err, req, res, next) => {
  logger.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});


// Only start the HTTP server when not on Vercel (Vercel sets VERCEL=1 automatically)
if (!process.env.VERCEL) {
    const server = app.listen(PORT, () => logger.info(`Backend listening on port ${PORT}`))

    // Graceful shutdown
    function SD(signal) {
        logger.info(`Signal received, shutting down gracefully`)

        server.close(async () => {
            logger.info('HTTP server closed');

            // database pool close
            await pool.end();
            logger.info(`DB pool closed`);

            process.exit(0)
        })

        // force exit after 10 secs
        setTimeout(() => {
            logger.error(`Forced shutdown after timeout`)
            process.exit(1)
        }, 10000)
    }

    process.on('SIGINT', SD)
    process.on('SIGTERM', SD)
}

// Export for Vercel serverless handler
module.exports = app;