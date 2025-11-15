const { Pool } = require('pg');
require('dotenv').config()

// connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

pool.on('connect', () => {
    console.log('Connected to postgresql db');
})

pool.on('error', err => {
    console.error(`DB Connection error:  `, err);
    process.exit(-1);
})

pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Database connection error:', err)
    } else {
        console.log('Database connected successfully at:', res.rows[0].now)
    }
})

module.exports = pool;