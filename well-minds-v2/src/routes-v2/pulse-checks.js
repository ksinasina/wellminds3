'use strict';

/**
 * Pulse Checks (v2)
 * --------------------------------------------------------------------------
 * Spec 02. Unified engine for both ICC-global push and company-authored pulse
 * checks. The home page prompts the current active pulse; employees submit a
 * wellbeing_checks row tagged with pulse_check_id.
 */

const express = require('express');
const router = express.Router();
const pool = require('../../../well-minds/src/db');
const { authenticate, authenticateICC } = require('../../../well-minds/src/middleware');
const requirePermission = require('../middleware/requirePermission');
const { applyOverallGate } = require('../services/anonymize');

// --------------------------------------------------------------------------
// GET /api/v2/pulse/active — the one pulse the current user should see today
// --------------------------------------------------------------------------
router.get('/active', authenticate, async (req, res, next) => {
  try {
    const sql = `
      SELECT pc.*, COALESCE(
          (SELECT json_agg(q.* ORDER BY q.sort_order)
             FROM pulse_check_questions q
            WHERE q.pulse_check_id = pc.id), '[]'::json
        ) AS questions
        FROM pulse_checks pc
       WHERE pc.is_active = TRUE
         AND (
             (pc.scope = 'icc_global')
          OR (pc.scope = 'company' AND pc.company_id = $1)
         )
         AND (pc.starts_on IS NULL OR pc.starts_on <= CURRENT_DATE)
         AND (pc.ends_on   IS NULL OR pc.ends_on   >= CURRENT_DATE)
       ORDER BY pc.scope = 'company' DESC, pc.created_at DESC
       LIMIT 1
    `;
    const { rows } = await pool.query(sql, [req.user.company_id]);
    res.json(rows[0] || null);
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// POST /api/v2/pulse/:id/submit — employee submits answers
// --------------------------------------------------------------------------
router.post('/:id/submit', authenticate, async (req, res, next) => {
  const { answers } = req.body; // { question_key: score }
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'answers object required' });
  }
  try {
    await pool.query(
      `INSERT INTO wellbeing_checks
         (user_id, company_id, pulse_check_id, mood_score, energy_score,
          stress_score, connection_score, purpose_score, notes, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
      [
        req.user.id,
        req.user.company_id,
        req.params.id,
        answers.mood ?? null,
        answers.energy ?? null,
        answers.stress ?? null,
        answers.connection ?? null,
        answers.purpose ?? null,
        answers.notes || null,
      ],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// GET /api/v2/pulse/:id/results — aggregated, anonymized
//   company admin → own company only; ICC admin → cross-company
// --------------------------------------------------------------------------
router.get('/:id/results',
  authenticate,
  requirePermission('wellbeing_indicators', 'view'),
  async (req, res, next) => {
    try {
      const sql = `
        SELECT COUNT(*)::int AS n,
               ROUND(AVG(mood_score)::numeric, 2)       AS mood,
               ROUND(AVG(energy_score)::numeric, 2)     AS energy,
               ROUND(AVG(stress_score)::numeric, 2)     AS stress,
               ROUND(AVG(connection_score)::numeric, 2) AS connection,
               ROUND(AVG(purpose_score)::numeric, 2)    AS purpose
          FROM wellbeing_checks
         WHERE pulse_check_id = $1
           AND company_id = $2
           AND submitted_at > NOW() - INTERVAL '30 days'
      `;
      const { rows } = await pool.query(sql, [req.params.id, req.user.company_id]);
      const gated = applyOverallGate(rows, { countField: 'n' });
      res.json({ pulse_check_id: req.params.id, ...gated });
    } catch (err) { next(err); }
  },
);

// --------------------------------------------------------------------------
// ICC: POST /api/v2/pulse (author a new pulse)  — company or ICC global
// --------------------------------------------------------------------------
router.post('/', authenticate, requirePermission('settings_comms', 'add'), async (req, res, next) => {
  const { title, description, scope, starts_on, ends_on, questions } = req.body;
  if (!title || !scope) return res.status(400).json({ error: 'title and scope required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pulseRes = await client.query(
      `INSERT INTO pulse_checks (company_id, scope, title, description, starts_on, ends_on, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING *`,
      [scope === 'icc_global' ? null : req.user.company_id, scope, title, description, starts_on, ends_on],
    );
    const pulse = pulseRes.rows[0];
    if (Array.isArray(questions)) {
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        await client.query(
          `INSERT INTO pulse_check_questions (pulse_check_id, question_key, prompt, sort_order)
           VALUES ($1,$2,$3,$4)`,
          [pulse.id, q.question_key, q.prompt, i],
        );
      }
    }
    await client.query('COMMIT');
    res.status(201).json(pulse);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
