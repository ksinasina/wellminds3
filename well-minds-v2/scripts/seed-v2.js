'use strict';

/**
 * seed-v2.js
 * --------------------------------------------------------------------------
 * Demo data for stakeholder pitches. Runs AFTER the original seed.js and
 * schema-v2.sql have both been applied. Idempotent — safe to re-run.
 *
 * Creates:
 *   - A richer hierarchy: 1 CEO → 2 managers → 6 employees
 *   - 1 indicator ("Wellbeing Snapshot") with 3 sections, 3 section ranges
 *     each, 3 overall ranges, narrative verbiage
 *   - 1 active connect cycle with 3 reflection periods
 *   - Performance/development/wellbeing objectives at various approval states
 *   - EAP page + 4 services
 *   - 5 social wall posts (some with media, some compliance-required)
 *   - 6 smiles across 3 culture categories
 *   - 10 communication templates (covering the 4 channels)
 *   - 3 learning sessions, 3 professionals, 2 wellbeing resources
 *   - Pulse check submissions (30+) so the results endpoint isn't redacted
 *
 * Usage:
 *   DATABASE_URL=postgres://... node well-minds-v2/scripts/seed-v2.js
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const pool = require(path.join(__dirname, '..', '..', 'well-minds', 'src', 'db'));

const DEMO_COMPANY_SLUG = 'demo-organisation';
const DEMO_COMPANY_NAME = 'Demo Organisation';

async function upsertCompany(client) {
  const existing = await client.query(
    `SELECT id FROM companies WHERE slug = $1`,
    [DEMO_COMPANY_SLUG],
  );
  if (existing.rowCount > 0) {
    await client.query(
      `UPDATE companies SET subdomain = $1, eap_enabled = TRUE WHERE slug = $2`,
      ['demo', DEMO_COMPANY_SLUG],
    );
    return existing.rows[0].id;
  }
  const id = uuidv4();
  await client.query(
    `INSERT INTO companies (id, name, slug, subdomain, company_code, plan, eap_enabled)
     VALUES ($1, $2, $3, 'demo', 'DEMO001', 'enterprise', TRUE)`,
    [id, DEMO_COMPANY_NAME, DEMO_COMPANY_SLUG],
  );
  return id;
}

async function ensureUser(client, { companyId, email, firstName, lastName,
  role, managerId, department }) {
  const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (existing.rowCount > 0) {
    await client.query(
      `UPDATE users
          SET manager_id = $1,
              department = COALESCE($2, department)
        WHERE id = $3`,
      [managerId, department, existing.rows[0].id],
    );
    return existing.rows[0].id;
  }
  const hash = await bcrypt.hash('Demo@123456', 10);
  const id = uuidv4();
  await client.query(
    `INSERT INTO users
       (id, company_id, email, password_hash, first_name, last_name, role,
        manager_id, department, status, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', TRUE)`,
    [id, companyId, email, hash, firstName, lastName, role, managerId, department],
  );
  return id;
}

async function seedHierarchy(client, companyId) {
  const ceo = await ensureUser(client, {
    companyId, email: 'ceo@demo.com',
    firstName: 'Amara', lastName: 'Okafor', role: 'admin',
    managerId: null, department: 'Executive',
  });
  const managerA = await ensureUser(client, {
    companyId, email: 'mgr.a@demo.com',
    firstName: 'Ben', lastName: 'Chen', role: 'manager',
    managerId: ceo, department: 'Engineering',
  });
  const managerB = await ensureUser(client, {
    companyId, email: 'mgr.b@demo.com',
    firstName: 'Priya', lastName: 'Rao', role: 'manager',
    managerId: ceo, department: 'People Ops',
  });
  const employees = [];
  for (const [email, first, last, mgr, dept] of [
    ['liz@demo.com',   'Liz',   'Martinez', managerA, 'Engineering'],
    ['dan@demo.com',   'Dan',   'Kelly',    managerA, 'Engineering'],
    ['mo@demo.com',    'Mo',    'Ali',      managerA, 'Engineering'],
    ['sana@demo.com',  'Sana',  'Patel',    managerB, 'People Ops'],
    ['leo@demo.com',   'Leo',   'Burns',    managerB, 'People Ops'],
    ['kai@demo.com',   'Kai',   'Jensen',   managerB, 'People Ops'],
  ]) {
    employees.push(await ensureUser(client, {
      companyId, email, firstName: first, lastName: last, role: 'staff',
      managerId: mgr, department: dept,
    }));
  }
  return { ceo, managerA, managerB, employees };
}

async function seedIndicator(client, companyId) {
  // Only insert if we don't already have a demo indicator
  const existing = await client.query(
    `SELECT id FROM indicators WHERE title = 'Wellbeing Snapshot (Demo)' LIMIT 1`,
  );
  let indicatorId;
  if (existing.rowCount > 0) {
    indicatorId = existing.rows[0].id;
  } else {
    indicatorId = uuidv4();
    await client.query(
      `INSERT INTO indicators (id, title, description, icc_global, is_published)
       VALUES ($1, 'Wellbeing Snapshot (Demo)', 'A 3-dimension snapshot of day-to-day wellbeing.', TRUE, TRUE)`,
      [indicatorId],
    );
  }

  // Ensure 3 sections exist
  const sections = [
    { title: 'Energy & Sleep', order: 10 },
    { title: 'Connection & Belonging', order: 20 },
    { title: 'Purpose & Meaning', order: 30 },
  ];
  const sectionIds = [];
  for (const s of sections) {
    const r = await client.query(
      `SELECT id FROM indicator_sections WHERE indicator_id = $1 AND title = $2`,
      [indicatorId, s.title],
    );
    if (r.rowCount > 0) { sectionIds.push(r.rows[0].id); continue; }
    const id = uuidv4();
    await client.query(
      `INSERT INTO indicator_sections (id, indicator_id, title, sort_order)
       VALUES ($1, $2, $3, $4)`,
      [id, indicatorId, s.title, s.order],
    );
    sectionIds.push(id);
  }

  // 3 questions per section
  for (const sectionId of sectionIds) {
    const existingQ = await client.query(
      `SELECT COUNT(*)::int AS n FROM indicator_questions WHERE section_id = $1`,
      [sectionId],
    );
    if (existingQ.rows[0].n >= 3) continue;
    for (let i = 1; i <= 3; i++) {
      await client.query(
        `INSERT INTO indicator_questions
           (section_id, prompt, question_type, min_score, max_score, sort_order)
         VALUES ($1, $2, 'likert_5', 1, 5, $3)`,
        [sectionId, `Sample question ${i}`, i * 10],
      );
    }
  }

  // Section ranges
  for (const sectionId of sectionIds) {
    const ranges = [
      { band: 'Low',      min:  3, max:  6,  color: '#e8735e',
        verbiage: '<p>Scores in this range suggest significant strain. Consider exploring the supporting resources below and, if it helps, reaching out to a professional.</p>' },
      { band: 'Moderate', min:  7, max: 11,  color: '#f6b042',
        verbiage: '<p>You are coping, but there are clear levers to pull. Pick one resource from the recommendations and try it for two weeks.</p>' },
      { band: 'Strong',   min: 12, max: 15,  color: '#1e9e97',
        verbiage: '<p>You are in a strong place here. Keep the practices that are working for you — and consider sharing them with the team.</p>' },
    ];
    for (const r of ranges) {
      await client.query(
        `INSERT INTO indicator_section_ranges
           (section_id, band_label, score_min, score_max, report_verbiage_html, color)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (section_id, band_label) DO UPDATE SET
           score_min = EXCLUDED.score_min,
           score_max = EXCLUDED.score_max,
           report_verbiage_html = EXCLUDED.report_verbiage_html,
           color = EXCLUDED.color`,
        [sectionId, r.band, r.min, r.max, r.verbiage, r.color],
      );
    }
  }

  // Overall ranges
  const overall = [
    { band: 'Red',   min:  9, max: 20, color: '#e8735e',
      verbiage: '<p>Your overall snapshot suggests it would be useful to talk through what is going on with someone you trust — a manager, a peer, or one of the professionals listed in the directory.</p>' },
    { band: 'Amber', min: 21, max: 34, color: '#f6b042',
      verbiage: '<p>You are managing, but a couple of dimensions are flagging. The two recommended resources below are a light touch starting point.</p>' },
    { band: 'Green', min: 35, max: 45, color: '#1e9e97',
      verbiage: '<p>Looking strong across the board. A great time to note what is working — revisit this indicator in 8 weeks to check it has held.</p>' },
  ];
  for (const o of overall) {
    await client.query(
      `INSERT INTO indicator_overall_ranges
         (indicator_id, band_label, score_min, score_max, report_verbiage_html, color)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (indicator_id, band_label) DO UPDATE SET
         score_min = EXCLUDED.score_min,
         score_max = EXCLUDED.score_max,
         report_verbiage_html = EXCLUDED.report_verbiage_html,
         color = EXCLUDED.color`,
      [indicatorId, o.band, o.min, o.max, o.verbiage, o.color],
    );
  }
  return indicatorId;
}

async function seedConnectCycle(client, companyId, users) {
  const existing = await client.query(
    `SELECT id FROM connect_cycles WHERE company_id = $1 AND name = 'FY26 H1 Demo'`,
    [companyId],
  );
  let cycleId;
  if (existing.rowCount > 0) {
    cycleId = existing.rows[0].id;
  } else {
    cycleId = uuidv4();
    await client.query(
      `INSERT INTO connect_cycles
         (id, company_id, name, starts_on, ends_on, is_active, objective_window_days)
       VALUES ($1, $2, 'FY26 H1 Demo', CURRENT_DATE - INTERVAL '60 days',
               CURRENT_DATE + INTERVAL '120 days', TRUE, 14)`,
      [cycleId, companyId],
    );
  }

  // Reflection periods
  const periods = [
    ['Q1', 'CURRENT_DATE - INTERVAL \'60 days\'', 'CURRENT_DATE - INTERVAL \'30 days\''],
    ['Q2', 'CURRENT_DATE - INTERVAL \'29 days\'', 'CURRENT_DATE'],
    ['Q3', 'CURRENT_DATE + INTERVAL \'1 day\'',   'CURRENT_DATE + INTERVAL \'60 days\''],
  ];
  for (let i = 0; i < periods.length; i++) {
    const [label, startsOn, endsOn] = periods[i];
    await client.query(
      `INSERT INTO cycle_reflection_periods (cycle_id, label, starts_on, ends_on, sort_order)
       VALUES ($1, $2, ${startsOn}, ${endsOn}, $3)
       ON CONFLICT (cycle_id, label) DO NOTHING`,
      [cycleId, label, i],
    );
  }

  // Add a performance objective per employee at various approval states
  const states = ['approved', 'approved', 'pending', 'alternative_suggested', 'approved', 'rejected'];
  for (let i = 0; i < users.employees.length; i++) {
    const uid = users.employees[i];
    const approval = states[i % states.length];
    await client.query(
      `INSERT INTO performance_objectives
         (user_id, company_id, cycle_id, title, description, category, approval_status, weight)
       SELECT $1, $2, $3, 'Ship Q3 launch', 'Deliver the launch on time', 'delivery', $4, 25
        WHERE NOT EXISTS (
          SELECT 1 FROM performance_objectives
           WHERE user_id = $1 AND cycle_id = $3 AND title = 'Ship Q3 launch'
        )`,
      [uid, companyId, cycleId, approval],
    );
    await client.query(
      `INSERT INTO development_objectives
         (user_id, company_id, cycle_id, title, category, approval_status)
       SELECT $1, $2, $3, 'Learn system design', 'skill', 'approved'
        WHERE NOT EXISTS (
          SELECT 1 FROM development_objectives
           WHERE user_id = $1 AND cycle_id = $3 AND title = 'Learn system design'
        )`,
      [uid, companyId, cycleId],
    );
    await client.query(
      `INSERT INTO wellbeing_objectives
         (user_id, company_id, cycle_id, title, category, approval_status, share_with_manager)
       SELECT $1, $2, $3, 'Protect sleep routine', 'sleep', 'approved', $4
        WHERE NOT EXISTS (
          SELECT 1 FROM wellbeing_objectives
           WHERE user_id = $1 AND cycle_id = $3 AND title = 'Protect sleep routine'
        )`,
      [uid, companyId, cycleId, i % 2 === 0],
    );
  }
  return cycleId;
}

async function seedSocialWall(client, companyId, users) {
  const posts = [
    { title: 'Welcome back',   content: 'Big welcome to the new joiners this week.',      audience: 'all',      author: users.ceo },
    { title: 'Q2 all-hands recap', content: 'Slides and recording are in Resources.',      audience: 'all',      author: users.ceo },
    { title: 'Engineering demo day', content: 'Friday 3pm — come watch the team ship!',  audience: 'department', audience_value: { department: 'Engineering' }, author: users.managerA },
    { title: 'Code of conduct update', content: 'Please read and acknowledge.',           audience: 'all',      compliance: true, author: users.managerB },
    { title: 'Smile of the week',  content: 'Huge thanks to Mo for mentoring the new joiners.', audience: 'all', author: users.managerA },
  ];
  for (const p of posts) {
    const existing = await client.query(
      `SELECT id FROM posts WHERE company_id = $1 AND title = $2 LIMIT 1`,
      [companyId, p.title],
    );
    if (existing.rowCount > 0) continue;
    await client.query(
      `INSERT INTO posts
         (user_id, company_id, title, content, audience_type, audience_value, compliance_required, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - (RANDOM() * INTERVAL '14 days'))`,
      [p.author, companyId, p.title, p.content, p.audience, p.audience_value || null, !!p.compliance],
    );
  }
}

async function seedEap(client, companyId) {
  const existing = await client.query(
    `SELECT id FROM eap_pages WHERE company_id = $1`,
    [companyId],
  );
  let pageId;
  if (existing.rowCount > 0) {
    pageId = existing.rows[0].id;
    await client.query(
      `UPDATE eap_pages
          SET provider_name = 'InterBeing Care',
              contact_phone = '+44 20 7946 0000',
              contact_email = 'eap@demo.com',
              hours_text    = '24/7',
              intro_html    = '<p>Confidential, free support for you and your household. Pick any service below.</p>',
              updated_at    = NOW()
        WHERE id = $1`,
      [pageId],
    );
  } else {
    pageId = uuidv4();
    await client.query(
      `INSERT INTO eap_pages
         (id, company_id, provider_name, contact_phone, contact_email, hours_text, intro_html)
       VALUES ($1, $2, 'InterBeing Care', '+44 20 7946 0000', 'eap@demo.com', '24/7',
               '<p>Confidential, free support for you and your household. Pick any service below.</p>')`,
      [pageId, companyId],
    );
  }
  const services = [
    { title: 'Counselling (24/7)',  desc: 'Up to 6 sessions per issue per year.', icon: 'user' },
    { title: 'Legal advice',        desc: 'Initial consultation with a qualified solicitor.', icon: 'scale' },
    { title: 'Financial coaching',  desc: 'Pension, debt, mortgage support.',      icon: 'piggy' },
    { title: 'Bereavement support', desc: 'Dedicated specialist counselling.',    icon: 'heart' },
  ];
  for (let i = 0; i < services.length; i++) {
    const s = services[i];
    await client.query(
      `INSERT INTO eap_services (eap_page_id, title, description, icon, sort_order)
       SELECT $1,$2,$3,$4,$5
        WHERE NOT EXISTS (
          SELECT 1 FROM eap_services WHERE eap_page_id = $1 AND title = $2
        )`,
      [pageId, s.title, s.desc, s.icon, i],
    );
  }
}

async function seedPulseSubmissions(client, companyId, users) {
  const pulseRes = await client.query(
    `SELECT id FROM pulse_checks WHERE id = '11111111-1111-1111-1111-111111111111'`,
  );
  if (pulseRes.rowCount === 0) {
    console.log('[seed-v2] ICC global pulse not found — did schema-v2.sql run?');
    return;
  }
  const pulseId = pulseRes.rows[0].id;

  // 30 submissions spread across the 9 users × recent days
  const userIds = [users.ceo, users.managerA, users.managerB, ...users.employees];
  for (const uid of userIds) {
    for (let d = 0; d < 4; d++) {
      await client.query(
        `INSERT INTO wellbeing_checks
           (user_id, company_id, pulse_check_id, mood_score, energy_score,
            stress_score, connection_score, purpose_score, submitted_at)
         SELECT $1, $2, $3,
                2 + FLOOR(RANDOM() * 4)::int,
                2 + FLOOR(RANDOM() * 4)::int,
                1 + FLOOR(RANDOM() * 4)::int,
                2 + FLOOR(RANDOM() * 4)::int,
                2 + FLOOR(RANDOM() * 4)::int,
                NOW() - ($4::int || ' days')::interval
          WHERE NOT EXISTS (
            SELECT 1 FROM wellbeing_checks
             WHERE user_id = $1
               AND pulse_check_id = $3
               AND submitted_at::date = (NOW() - ($4::int || ' days')::interval)::date
          )`,
        [uid, companyId, pulseId, d * 2],
      );
    }
  }
}

async function seedCommunicationTemplates(client) {
  const templates = [
    { channel: 'email',    trigger: 'welcome_employee',     name: 'Employee welcome',      subject: 'Welcome to {{company_name}}', body: 'Hi {{first_name}}, welcome aboard!' },
    { channel: 'email',    trigger: 'cycle_opens',          name: 'Connect cycle opens',   subject: 'Your FY cycle is open',        body: 'Log in to add your objectives by {{due_date}}.' },
    { channel: 'in_app',   trigger: 'cycle_objective_due',  name: 'Objective reminder',    subject: 'Add objectives',               body: 'You have {{days}} days to submit.' },
    { channel: 'whatsapp', trigger: 'pulse_check_push',     name: 'Pulse nudge',           subject: null,                           body: 'Quick pulse check available — takes 60 seconds.' },
    { channel: 'nudge',    trigger: 'indicator_due',        name: 'Indicator reminder',    subject: null,                           body: 'Your quarterly wellbeing snapshot is waiting.' },
    { channel: 'email',    trigger: 'manager_approve_objective', name: 'Objective approved', subject: 'Your objective was approved', body: 'Nice work.' },
    { channel: 'email',    trigger: 'manager_reject_objective',  name: 'Objective revisited', subject: 'Your manager left a note',   body: 'See the note and re-submit.' },
    { channel: 'in_app',   trigger: 'consolidation_due',    name: 'Consolidation due',     subject: null,                           body: 'Book time with your manager to align.' },
    { channel: 'email',    trigger: 'signoff_reminder',     name: 'Sign-off reminder',     subject: 'Please sign off',              body: 'You have a cycle waiting on your signature.' },
    { channel: 'whatsapp', trigger: 'session_reminder',     name: 'Learning session',      subject: null,                           body: 'Session starts in 1 hour. Link: {{url}}' },
  ];
  for (const t of templates) {
    await client.query(
      `INSERT INTO communication_templates (scope, channel, trigger_key, name, subject, body, variables, is_active)
       VALUES ('icc_global', $1, $2, $3, $4, $5, '{}'::jsonb, TRUE)
       ON CONFLICT (scope, channel, trigger_key) DO NOTHING`,
      [t.channel, t.trigger, t.name, t.subject, t.body],
    );
  }
}

async function seedSmiles(client, companyId, users) {
  const categories = [
    { name: 'Kindness',   behaviour: 'Going out of your way for a teammate.' },
    { name: 'Ownership',  behaviour: 'Taking responsibility when it would be easier not to.' },
    { name: 'Curiosity',  behaviour: 'Asking the question that unlocks the room.' },
  ];
  const catIds = [];
  for (const c of categories) {
    const r = await client.query(
      `SELECT id FROM smile_categories WHERE company_id = $1 AND name = $2`,
      [companyId, c.name],
    );
    if (r.rowCount > 0) {
      catIds.push(r.rows[0].id);
      await client.query(
        `UPDATE smile_categories SET behaviour_statement = $1 WHERE id = $2`,
        [c.behaviour, r.rows[0].id],
      );
      continue;
    }
    const id = uuidv4();
    await client.query(
      `INSERT INTO smile_categories (id, company_id, name, behaviour_statement, is_active)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [id, companyId, c.name, c.behaviour],
    );
    catIds.push(id);
  }

  // 6 smiles between employees
  const pairs = [
    [users.employees[0], users.employees[1], catIds[0], 'Stayed late to help me debug.'],
    [users.employees[2], users.employees[0], catIds[1], 'Owned the release even when it got messy.'],
    [users.employees[3], users.employees[4], catIds[2], 'Great question on the all-hands Q&A.'],
    [users.employees[5], users.employees[3], catIds[0], 'Brought biscuits. Unnecessary but lovely.'],
    [users.employees[1], users.employees[2], catIds[1], 'Stepped up when the lead was away.'],
    [users.managerA,     users.employees[0], catIds[2], 'Your demo made the team think differently.'],
  ];
  for (const [from, to, cat, msg] of pairs) {
    await client.query(
      `INSERT INTO smiles (sender_user_id, recipient_user_id, company_id, category_id, message, created_at)
       SELECT $1,$2,$3,$4,$5,NOW() - (RANDOM() * INTERVAL '21 days')
        WHERE NOT EXISTS (
          SELECT 1 FROM smiles
           WHERE sender_user_id = $1 AND recipient_user_id = $2 AND message = $5
        )`,
      [from, to, companyId, cat, msg],
    );
  }
}

// ---------------------------------------------------------------------------

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('[seed-v2] Starting v2 demo seed…');

    const companyId = await upsertCompany(client);
    console.log('[seed-v2] Company ready');

    const users = await seedHierarchy(client, companyId);
    console.log(`[seed-v2] Users ready (9 total)`);

    await seedIndicator(client, companyId);
    console.log('[seed-v2] Indicator + ranges ready');

    await seedConnectCycle(client, companyId, users);
    console.log('[seed-v2] Connect cycle ready');

    await seedSocialWall(client, companyId, users);
    console.log('[seed-v2] Social wall posts ready');

    await seedEap(client, companyId);
    console.log('[seed-v2] EAP page ready');

    await seedPulseSubmissions(client, companyId, users);
    console.log('[seed-v2] Pulse check submissions ready');

    await seedCommunicationTemplates(client);
    console.log('[seed-v2] Communication templates ready');

    await seedSmiles(client, companyId, users);
    console.log('[seed-v2] Smiles ready');

    await client.query('COMMIT');
    console.log('[seed-v2] Done.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed-v2] ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) seed();
module.exports = { seed };
