const { Pool, types } = require('pg');
require('dotenv').config();

// Make PostgreSQL NUMERIC → JS float
types.setTypeParser(1700, parseFloat);
// Make PostgreSQL INT8 → JS number
types.setTypeParser(20, parseInt);

const connectionString = process.env.DATABASE_URL;

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'tarim_pazar',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'password',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err);
});

// Helper: run a query and return rows
const query = (text, params) => pool.query(text, params);

// Helper: get a single client for transactions
const getClient = () => pool.connect();

module.exports = { query, getClient, pool };