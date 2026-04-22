'use strict';

/**
 * Communication Templates (v2)
 * --------------------------------------------------------------------------
 * Spec A11. Rename of "Email Templates" to include email + in_app + whatsapp
 * + nudges. ICC authors the global templates; companies override per trigger.
 */

const express = require('express');
const router = express.Router();
const pool = require('../../../well-minds/src/db');
const { authenticate, authenticateICC } = require('../../../well-minds/src/middleware');
const requirePermission = require('../middleware/requirePermission');

// List templates effective for the current company (global + overrides merged)
router.get('/', authenticate, async (req, res, next) => {
  try {
    const sql = `
      SELECT
        t.id,
        t.scope,
        t.channel,
        t.trigger_key,
        t.name,
        COALESCE(o.subject_override, t.subject) AS subject,
        COALESCE(o.body_override, t.body)       AS body,
        t.variables,
        (o.id IS NOT NULL) AS overridden,
        t.is_active,
        (CASE WHEN o.id IS NOT NULL THEN o.updated_at ELSE t.updated_at END) AS effective_updated_at
      FROM communication_templates t
      LEFT JOIN communication_template_company_overrides o
             ON o.template_id = t.id AND o.company_id = $1
      WHERE t.is_active = TRUE
      ORDER BY t.channel, t.trigger_key
    `;
    const { rows } = await pool.query(sql, [req.user.company_id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ICC: create a new global template
router.post('/',
  authenticateICC,
  async (req, res, next) => {
    const { channel, trigger_key, name, subject, body, variables } = req.body;
    if (!['email', 'in_app', 'whatsapp', 'nudge'].includes(channel)) {
      return res.status(400).json({ error: 'Invalid channel' });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO communication_templates
           (scope, channel, trigger_key, name, subject, body, variables, is_active)
         VALUES ('icc_global', $1, $2, $3, $4, $5, $6, TRUE)
         RETURNING *`,
        [channel, trigger_key, name, subject, body, variables || {}],
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  },
);

// Company: override a global template
router.put('/:templateId/override',
  authenticate,
  requirePermission('settings_comms', 'edit'),
  async (req, res, next) => {
    const { subject_override, body_override } = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO communication_template_company_overrides
           (template_id, company_id, subject_override, body_override, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (template_id, company_id) DO UPDATE SET
           subject_override = EXCLUDED.subject_override,
           body_override    = EXCLUDED.body_override,
           updated_at       = NOW()
         RETURNING *`,
        [req.params.templateId, req.user.company_id, subject_override, body_override],
      );
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

// Company: reset override back to global default
router.delete('/:templateId/override',
  authenticate,
  requirePermission('settings_comms', 'delete'),
  async (req, res, next) => {
    try {
      await pool.query(
        `DELETE FROM communication_template_company_overrides
          WHERE template_id = $1 AND company_id = $2`,
        [req.params.templateId, req.user.company_id],
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

module.exports = router;
