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

module.exports = pool;