#!/usr/bin/env node
/**
 * Render deploy bootstrap:
 *   1. Runs v1 schema (well-minds/schema.sql)
 *   2. Runs v2 schema (well-minds-v2/schema/schema-v2.sql)
 *   3. Runs v2 seed — only if SEED_ON_BOOT=true
 *   4. Boots the v2 server (well-minds-v2/src/index-v2.js)
 *
 * Idempotent. Safe to re-run on every deploy.
 */
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const V1_SCHEMA = path.join(REPO_ROOT, 'well-minds', 'schema.sql');
const V2_SCHEMA = path.join(REPO_ROOT, 'well-minds-v2', 'schema', 'schema-v2.sql');
const SEED_SCRIPT = path.join(REPO_ROOT, 'well-minds-v2', 'scripts', 'seed-v2.js');

function log(tag, msg) { console.log(`[bootstrap] ${tag} ${msg}`); }

async function runSql(label, filepath) {
  if (!fs.existsSync(filepath)) { log(label, `skipped (not found)`); return; }
  if (!process.env.DATABASE_URL) { log(label, 'skipped (no DATABASE_URL)'); return; }
  const sql = fs.readFileSync(filepath, 'utf8');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  try {
    await client.connect();
    await client.query(sql);
    log(label, 'applied OK');
  } catch (err) {
    log(label, `error (non-fatal): ${err.message.split('\n')[0]}`);
  } finally {
    try { await client.end(); } catch (_) {}
  }
}

async function runSeed() {
  if (process.env.SEED_ON_BOOT !== 'true') { log('seed', 'skipped'); return; }
  if (!fs.existsSync(SEED_SCRIPT)) { log('seed', 'skipped (no seed script)'); return; }
  try {
    require(SEED_SCRIPT);
    await new Promise(r => setTimeout(r, 3000));
    log('seed', 'completed');
  } catch (err) {
    log('seed', `error (non-fatal): ${err.message.split('\n')[0]}`);
  }
}

async function main() {
  log('env', `NODE_ENV=${process.env.NODE_ENV} PORT=${process.env.PORT}`);
  log('env', `DATABASE_URL=${process.env.DATABASE_URL ? 'set' : 'MISSING'}`);
  await runSql('v1-schema', V1_SCHEMA);
  await runSql('v2-schema', V2_SCHEMA);
  await runSeed();
  log('server', 'starting index-v2.js');
  const app = require(path.join(REPO_ROOT, 'well-minds-v2', 'src', 'index-v2.js'));
  const PORT = parseInt(process.env.PORT, 10) || 3001;
  app.listen(PORT, '0.0.0.0', () => log('server', 'listening on 0.0.0.0:' + PORT));
}

main().catch(err => {
  console.error('[bootstrap] FATAL', err);
  try {
    const app = require(path.join(REPO_ROOT, 'well-minds-v2', 'src', 'index-v2.js'));
    const PORT = parseInt(process.env.PORT, 10) || 3001;
    app.listen(PORT, '0.0.0.0', () => console.log('[bootstrap] fallback server listening on 0.0.0.0:' + PORT));
  } catch (e) {
    console.error('[bootstrap] could not fall back:', e.message);
    process.exit(1);
  }
});
