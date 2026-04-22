'use strict';

/**
 * indicatorReportGenerator.js
 * --------------------------------------------------------------------------
 * Spec 02. Assembles the narrative report for an indicator completion:
 *   1. Intro (indicator-level description)
 *   2. Per-section band verbiage (indicator_section_ranges)
 *   3. Overall conclusion (indicator_overall_ranges)
 *   4. Recommended resources (recommendation_resource_ids UUID[])
 *
 * Inputs: a completion_id — everything else is joined in SQL.
 * Output:  { sections: [{ section_id, label, score, band, html }],
 *            overall: { label, score, band, html, resources: [...] } }
 */

const pool = require('../../../well-minds/src/db');

async function assemble(completionId) {
  // 1. Per-section scores with the matching band verbiage
  const sectionsSql = `
    SELECT s.id   AS section_id,
           s.title,
           s.sort_order,
           per_sec.score,
           per_sec.max_score,
           r.band_label,
           r.report_verbiage_html
      FROM indicator_sections s
      JOIN indicator_completions c   ON c.id = $1
      JOIN (
        SELECT ia.section_id,
               SUM(ia.score)::NUMERIC AS score,
               SUM(iq.max_score)::NUMERIC AS max_score
          FROM indicator_answers ia
          JOIN indicator_questions iq ON iq.id = ia.question_id
         WHERE ia.completion_id = $1
         GROUP BY ia.section_id
      ) per_sec ON per_sec.section_id = s.id
      LEFT JOIN indicator_section_ranges r
             ON r.section_id = s.id
            AND per_sec.score >= r.score_min
            AND per_sec.score <= r.score_max
     WHERE s.indicator_id = c.indicator_id
     ORDER BY s.sort_order
  `;

  // 2. Overall score + band
  const overallSql = `
    SELECT c.id,
           c.total_score,
           c.max_score,
           o.band_label,
           o.report_verbiage_html,
           o.recommendation_resource_ids
      FROM indicator_completions c
      LEFT JOIN indicator_overall_ranges o
             ON o.indicator_id = c.indicator_id
            AND c.total_score >= o.score_min
            AND c.total_score <= o.score_max
     WHERE c.id = $1
  `;

  const [sectionsRes, overallRes] = await Promise.all([
    pool.query(sectionsSql, [completionId]),
    pool.query(overallSql, [completionId]),
  ]);

  if (overallRes.rowCount === 0) {
    return { sections: [], overall: null, error: 'Completion not found' };
  }

  // 3. Fetch recommended resources (if any)
  const ids = overallRes.rows[0].recommendation_resource_ids || [];
  let resources = [];
  if (ids.length > 0) {
    const resSql = `
      SELECT id, title, description, resource_url, category, format
        FROM wellbeing_resources
       WHERE id = ANY($1::uuid[])
    `;
    const resRes = await pool.query(resSql, [ids]);
    resources = resRes.rows;
  }

  return {
    sections: sectionsRes.rows.map((r) => ({
      section_id: r.section_id,
      title: r.title,
      sort_order: r.sort_order,
      score: Number(r.score),
      max_score: Number(r.max_score),
      band: r.band_label,
      html: r.report_verbiage_html,
    })),
    overall: {
      score: Number(overallRes.rows[0].total_score),
      max_score: Number(overallRes.rows[0].max_score),
      band: overallRes.rows[0].band_label,
      html: overallRes.rows[0].report_verbiage_html,
      resources,
    },
  };
}

module.exports = { assemble };
