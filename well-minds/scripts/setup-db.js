'use strict';

/**
 * Database setup script.
 *
 * Reads schema.sql from the project root (or a path supplied as the first CLI
 * argument) and executes it against the configured PostgreSQL database.
 *
 * Usage:
 *   node scripts/setup-db.js                  # reads ./schema.sql
 *   node scripts/setup-db.js path/to/file.sql # reads custom path
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  // Determine schema file path
  const schemaArg = process.argv[2];
  const schemaPath = schemaArg
    ? path.resolve(schemaArg)
    : path.resolve(__dirname, '..', 'schema.sql');

  console.log(`[setup-db] Reading schema from: ${schemaPath}`);

  if (!fs.existsSync(schemaPath)) {
    console.error(`[setup-db] Schema file not found: ${schemaPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(schemaPath, 'utf-8');

  // Build connection config (mirrors src/db.js logic)
  const poolConfig = process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      }
    : {
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT, 10) || 5432,
        database: process.env.PG_DATABASE || 'wellminds',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || '',
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      };

  const pool = new Pool(poolConfig);

  try {
    console.log('[setup-db] Connecting to database...');
    const client = await pool.connect();

    try {
      console.log('[setup-db] Executing schema...');
      await client.query(sql);
      console.log('[setup-db] Schema applied successfully.');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[setup-db] Failed to apply schema:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
