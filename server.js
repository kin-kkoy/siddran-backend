// Flow: Imports -> App itself -> middlewares -> routes -> port running (backend)

const express = require('express')
const cors = require('cors')
require('dotenv').config()
const authRouter = require ('./routes/auth')
const notesRouter = require('./routes/notes')
const notebooksRouter = require('./routes/notebook')
const tasksRouter = require('./routes/tasks')
const dailyTasksRouter = require('./routes/dailyTasks')
const cookieParser = require('cookie-parser')
const { generalLimiter, authLimiter } = require('./middleware/rateLimiter')


const app = express();
const PORT = process.env.PORT || 3000;

// Trust first proxy - apparently is REQUIRED for rate limiting to work on deployed platforms
app.set('trust proxy', 1);

// middlewares
app.use(cors({
  origin: process.env.FRONTEND_URL,  // FRONTEND URL
  credentials: true  // Allow cookies to be sent!
}));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser()); // duh parses the cookie

app.use(generalLimiter);

// routes
app.use('/auth', authLimiter, authRouter);
app.use('/notes', notesRouter);
app.use('/notebooks', notebooksRouter)
app.use('/tasks', tasksRouter)
app.use('/daily-tasks', dailyTasksRouter)


// extension of routes
// Health check endpoint (pings the server to checks if it's alive or not)
//  when app is deployed this'll be pinged occasionally to check if server is still running)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Ember API is running' });
});

// route not found hadnler (if route (page) doesn't exist)
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' })
})

// another safety net for the whole server. If an error happens and is not caught by the try-catches, this guy will catch it and show it in console, without it the whole server would crash.
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});


app.listen(PORT, () => console.log(`Backend listening on port ${PORT}`))