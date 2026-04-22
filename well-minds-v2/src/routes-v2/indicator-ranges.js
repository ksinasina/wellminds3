'use strict';

/**
 * Indicator Ranges (v2)
 * --------------------------------------------------------------------------
 * Spec 02. The ICC-side missing piece — section ranges + report verbiage so
 * that when an employee completes an indicator, the narrative they see is
 * driven by the ranges ICC configured (not hard-coded).
 *
 * Routes:
 *   - GET    /api/v2/indicator-ranges/:indicatorId
 *   - PUT    /api/v2/indicator-ranges/:indicatorId/section/:sectionId
 *   - PUT    /api/v2/indicator-ranges/:indicatorId/overall
 *   - GET    /api/v2/indicator-ranges/completion/:completionId/report
 */

const express = require('express');
const router = express.Router();
const pool = require('../../../well-minds/src/db');
const { authenticate, authenticateICC } = require('../../../well-minds/src/middleware');
const requirePermission = require('../middleware/requirePermission');
const reportGen = require('../services/indicatorReportGenerator');

// Fetch all ranges for an indicator (both section and overall)
router.get('/:indicatorId', async (req, res, next) => {
  try {
    const sections = await pool.query(
      `SELECT r.*, s.title AS section_title
         FROM indicator_section_ranges r
         JOIN indicator_sections s ON s.id = r.section_id
        WHERE s.indicator_id = $1
        ORDER BY s.sort_order, r.score_min`,
      [req.params.indicatorId],
    );
    const overall = await pool.query(
      `SELECT * FROM indicator_overall_ranges
        WHERE indicator_id = $1
        ORDER BY score_min`,
      [req.params.indicatorId],
    );
    res.json({ sections: sections.rows, overall: overall.rows });
  } catch (err) { next(err); }
});

// Upsert a section range (by band_label)
router.put('/:indicatorId/section/:sectionId',
  authenticateICC,
  async (req, res, next) => {
    const { band_label, score_min, score_max, report_verbiage_html, color } = req.body;
    try {
      await pool.query(
        `INSERT INTO indicator_section_ranges
           (section_id, band_label, score_min, score_max, report_verbiage_html, color)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (section_id, band_label) DO UPDATE SET
           score_min = EXCLUDED.score_min,
           score_max = EXCLUDED.score_max,
           report_verbiage_html = EXCLUDED.report_verbiage_html,
           color = EXCLUDED.color`,
        [req.params.sectionId, band_label, score_min, score_max, report_verbiage_html, color || null],
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

// Upsert an overall range
router.put('/:indicatorId/overall',
  authenticateICC,
  async (req, res, next) => {
    const { band_label, score_min, score_max, report_verbiage_html,
      recommendation_resource_ids, color } = req.body;
    try {
      await pool.query(
        `INSERT INTO indicator_overall_ranges
           (indicator_id, band_label, score_min, score_max,
            report_verbiage_html, recommendation_resource_ids, color)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (indicator_id, band_label) DO UPDATE SET
           score_min = EXCLUDED.score_min,
           score_max = EXCLUDED.score_max,
           report_verbiage_html = EXCLUDED.report_verbiage_html,
           recommendation_resource_ids = EXCLUDED.recommendation_resource_ids,
           color = EXCLUDED.color`,
        [
          req.params.indicatorId, band_label, score_min, score_max,
          report_verbiage_html, recommendation_resource_ids || null, color || null,
        ],
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

// Generate the narrative report for a given completion
router.get('/completion/:completionId/report', authenticate, async (req, res, next) => {
  try {
    const report = await reportGen.assemble(req.params.completionId);
    res.json(report);
  } catch (err) { next(err); }
});

module.exports = router;
