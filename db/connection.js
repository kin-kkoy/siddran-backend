const { Pool } = require('@neondatabase/serverless');
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
})

module.exports = pool;