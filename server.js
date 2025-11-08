// Imports -> App itself -> middlewares -> routes -> port running (backend)

const express = require('express')
const cors = require('cors')
require('dotenv').config()
const notesRouter = require('./routes/notes')
const authRouter = require ('./routes/auth')

const app = express();
const PORT = process.env.PORT || 3000;


// middlewares
app.use(cors());
app.use(express.json());

// routes
app.use('/auth', authRouter);
app.use('/notes', notesRouter);


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