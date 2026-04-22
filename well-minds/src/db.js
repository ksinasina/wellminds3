'use strict';

const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Build connection configuration
// ---------------------------------------------------------------------------
function buildConfig() {
  // Prefer DATABASE_URL when available (e.g. Heroku, Railway, Render)
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
    };
  }

  // Fall back to individual PG_* variables
  return {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT, 10) || 5432,
    database: process.env.PG_DATABASE || 'wellminds',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '',
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
  };
}

const pool = new Pool({
  ...buildConfig(),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Log pool-level errors so they don't crash the process silently
pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle client:', err.message);
});

module.exports = pool;
