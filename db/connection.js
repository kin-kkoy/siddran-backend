const { Pool } = require('pg');
require('dotenv').config()
const logger = require('../utils/logger')

// connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

pool.on('connect', () => {
    logger.info('Connected to postgresql db');
})

pool.on('error', err => {
    logger.error(`DB Connection error:  `, err);
    process.exit(-1);
})

pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        logger.error('Database connection error:', err)
    } else {
        logger.info('Database connected successfully at:', res.rows[0].now)
    }
})

module.exports = pool;