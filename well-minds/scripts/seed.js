'use strict';

/**
 * seed.js - Creates the initial ICC super-admin and a demo organization
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/seed.js
 *
 * Or if you have a .env file:
 *   node scripts/seed.js
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const pool = require('../src/db');

const ICC_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@interbeingcare.com';
const ICC_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@123456';
const DEMO_COMPANY_NAME = 'Demo Organisation';

async function seed() {
    const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Ensure uuid-ossp extension exists
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    console.log('[seed] uuid-ossp extension ready');

    // Create ICC super-admin
    const existing = await client.query(
      'SELECT id FROM icc_admins WHERE email = $1',
      [ICC_ADMIN_EMAIL]
    );

    let iccAdminId;
    if (existing.rows.length > 0) {
      iccAdminId = existing.rows[0].id;
      console.log(`[seed] ICC admin already exists: ${ICC_ADMIN_EMAIL}`);
    } else {
      const hash = await bcrypt.hash(ICC_ADMIN_PASSWORD, 10);
      iccAdminId = uuidv4();
      await client.query(
        `INSERT INTO icc_admins (id, email, password_hash, first_name, last_name, role, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
        [iccAdminId, ICC_ADMIN_EMAIL, hash, 'ICC', 'Admin', 'super_admin']
      );
      console.log(`[seed] Created ICC super-admin: ${ICC_ADMIN_EMAIL} / ${ICC_ADMIN_PASSWORD}`);
    }

    // Create demo company
    const existingCo = await client.query(
      'SELECT id FROM companies WHERE name = $1',
      [DEMO_COMPANY_NAME]
    );

    let companyId;
    if (existingCo.rows.length > 0) {
      companyId = existingCo.rows[0].id;
      console.log(`[seed] Demo company already exists`);
    } else {
      companyId = uuidv4();
      await client.query(
        `INSERT INTO companies (id, name, slug, company_code, plan)
         VALUES ($1, $2, $3, $4, $5)`,
        [companyId, DEMO_COMPANY_NAME, 'demo-organisation', 'DEMO001', 'enterprise']
      );
      console.log(`[seed] Created demo company: ${DEMO_COMPANY_NAME}`);
    }

    // Create demo org-admin user
    const demoAdminEmail = 'orgadmin@demo.com';
    const demoAdminPw = 'OrgAdmin@123456';

    const existingUser = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [demoAdminEmail]
    );

    if (existingUser.rows.length > 0) {
      console.log(`[seed] Demo org-admin already exists: ${demoAdminEmail}`);
    } else {
      const userHash = await bcrypt.hash(demoAdminPw, 10);
      const userId = uuidv4();
      await client.query(
        `INSERT INTO users (id, company_id, email, password_hash, first_name, last_name, role, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
        [userId, companyId, demoAdminEmail, userHash, 'Org', 'Admin', 'admin']
      );
      console.log(`[seed] Created demo org-admin: ${demoAdminEmail} / ${demoAdminPw}`);
    }

    await client.query('COMMIT');
    console.log('\n[seed] Done! You can now sign in with:');
    console.log(`  ICC Admin Panel (/admin):  ${ICC_ADMIN_EMAIL} / ${ICC_ADMIN_PASSWORD}`);
    console.log(`  Org App (/app):            ${demoAdminEmail} / ${demoAdminPw}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] Error:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));
