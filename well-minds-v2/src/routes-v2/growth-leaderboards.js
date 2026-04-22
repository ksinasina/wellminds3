'use strict';

/**
 * Growth & Leaderboards (v2)
 * --------------------------------------------------------------------------
 * Spec: Home page widgets — growth snapshot + cycle leaderboards.
 *
 * Endpoints:
 *   GET /api/v2/growth/me
 *   GET /api/v2/growth/team/:managerUserId     (hierarchy-gated)
 *   GET /api/v2/growth/leaderboard             (opt-in, anonymized)
 *   GET /api/v2/growth/progress/:userId        (timeline widget)
 */

const express = require('express');
const router = express.Router();
const pool = require('../../../well-minds/src/db');
const { authenticate } = require('../../../well-minds/src/middleware');
const { canView, subjectsForViewer } = require('../services/hierarchyVisibility');
const { redactSmallBuckets } = require('../services/anonymize');

// My own growth snapshot (union across all 3 modules)
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM v_user_growth_snapshot WHERE user_id = $1`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// My team's growth
router.get('/team/:managerUserId', authenticate, async (req, res, next) => {
  const managerId = req.params.managerUserId;
  if (managerId !== req.user.id) {
    return res.status(403).json({ error: 'Own team only (for now)' });
  }
  try {
    const subjects = await subjectsForViewer(managerId);
    if (subjects.length === 0) return res.json([]);
    const { rows } = await pool.query(
      `SELECT v.*, u.first_name, u.last_name, u.email
         FROM v_user_growth_snapshot v
         JOIN users u ON u.id = v.user_id
        WHERE v.user_id = ANY($1::uuid[])
        ORDER BY u.last_name, u.first_name`,
      [subjects],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Company leaderboard — opt-in for each employee, anonymized.
// Opt-in is represented by users.leaderboard_opt_in (default TRUE).
router.get('/leaderboard', authenticate, async (req, res, next) => {
  try {
    const sql = `
      SELECT u.id,
             CASE WHEN u.leaderboard_opt_in THEN
               COALESCE(u.first_name, 'Anon') || ' ' || LEFT(COALESCE(u.last_name, ''), 1)
             ELSE 'Team member'
             END AS display_name,
             COUNT(DISTINCT po.id) FILTER (WHERE po.approval_status = 'approved') AS perf_goals,
             COUNT(DISTINCT d.id)  FILTER (WHERE d.approval_status  = 'approved') AS dev_goals,
             COUNT(DISTINCT w.id)  FILTER (WHERE w.approval_status  = 'approved') AS well_goals
        FROM users u
        LEFT JOIN performance_objectives po ON po.user_id = u.id
        LEFT JOIN development_objectives d  ON d.user_id  = u.id
        LEFT JOIN wellbeing_objectives w    ON w.user_id  = u.id
       WHERE u.company_id = $1
         AND u.is_active = TRUE
       GROUP BY u.id
       ORDER BY (
         COUNT(DISTINCT po.id) FILTER (WHERE po.approval_status = 'approved') +
         COUNT(DISTINCT d.id)  FILTER (WHERE d.approval_status  = 'approved') +
         COUNT(DISTINCT w.id)  FILTER (WHERE w.approval_status  = 'approved')
       ) DESC
       LIMIT 50
    `;
    const { rows } = await pool.query(sql, [req.user.company_id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// Per-user cycle progress widget (6-step timeline)
router.get('/progress/:userId', authenticate, async (req, res, next) => {
  try {
    if (!(await canView(req.user.id, req.params.userId))) {
      return res.status(403).json({ error: 'Not authorized to view this user' });
    }
    const { rows } = await pool.query(
      `SELECT * FROM v_user_growth_snapshot WHERE user_id = $1`,
      [req.params.userId],
    );
    // Group by module for the frontend
    const byModule = { performance: null, development: null, wellbeing: null };
    for (const r of rows) {
      byModule[r.module] = {
        cycle_id: r.cycle_id,
        cycle_name: r.cycle_name,
        current_phase: r.current_phase,
        pct_complete: Number(r.pct_complete),
        next_action_for_user: r.next_action_for_user,
      };
    }
    res.json(byModule);
  } catch (err) { next(err); }
});

module.exports = router;
