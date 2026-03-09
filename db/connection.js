require('dotenv').config()
const logger = require('../utils/logger')

let Pool;
if (process.env.NODE_ENV === 'production') {
    ({ Pool } = require('@neondatabase/serverless'));
} else {
    ({ Pool } = require('pg'));
}

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