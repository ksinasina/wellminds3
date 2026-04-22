const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireManager, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { sendEmail, sendCompanyEmail } = require('../utils/email');
const { v4: uuidv4 } = require('uuid');

// All routes require authentication
router.use(authenticate);

// ============================================================================
// 1. GET /api/indicators - List published indicators available to user's org
// ============================================================================
router.get('/',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('category_id').optional().isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const userId = req.user.id;
      const page = req.query.page || 1;
      const limit = req.query.limit || 20;
      const offset = (page - 1) * limit;

      const conditions = [
        `i.status = 'published'`,
        `ioa.company_id = $1`,
        `i.admin_distribution_only = false`
      ];
      const params = [companyId];
      let paramIndex = 2;

      if (req.query.category_id) {
        conditions.push(`i.category_id = $${paramIndex++}`);
        params.push(req.query.category_id);
      }

      // Timed availability: respect available_from / available_until on assignments
      conditions.push(`(ioa.available_from IS NULL OR ioa.available_from <= NOW())`);
      conditions.push(`(ioa.available_until IS NULL OR ioa.available_until >= NOW())`);

      // Respect indicator_schedules: if schedules exist for this company, at least one must be active
      conditions.push(`(
        NOT EXISTS (
          SELECT 1 FROM indicator_schedules isch
          WHERE isch.indicator_id = i.id
            AND isch.is_active = true
            AND (isch.target_company_ids IS NULL OR isch.target_company_ids::jsonb @> to_jsonb($1::text))
        )
        OR EXISTS (
          SELECT 1 FROM indicator_schedules isch
          WHERE isch.indicator_id = i.id
            AND isch.is_active = true
            AND isch.start_date <= NOW()
            AND isch.end_date >= NOW()
            AND (isch.target_company_ids IS NULL OR isch.target_company_ids::jsonb @> to_jsonb($1::text))
        )
      )`);

      const whereClause = conditions.join(' AND ');

      const countResult = await pool.query(
        `SELECT COUNT(DISTINCT i.id)
         FROM indicators i
         JOIN indicator_org_assignments ioa ON ioa.indicator_id = i.id
         WHERE ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const { rows } = await pool.query(`
        SELECT
          i.id, i.title, i.description, i.banner_url, i.background_url,
          i.include_scoring, i.disclaimer,
          ic.id AS category_id, ic.name AS category_name,
          (SELECT COUNT(*) FROM indicator_sections s WHERE s.indicator_id = i.id)::int AS section_count,
          (SELECT COUNT(*)
           FROM indicator_questions q
           JOIN indicator_sections s2 ON s2.id = q.section_id
           WHERE s2.indicator_id = i.id)::int AS question_count,
          COALESCE(comp.completion_count, 0)::int AS user_completion_count,
          comp.last_completed_at
        FROM indicators i
        JOIN indicator_org_assignments ioa ON ioa.indicator_id = i.id
        LEFT JOIN indicator_categories ic ON ic.id = i.category_id
        LEFT JOIN (
          SELECT indicator_id, COUNT(*) AS completion_count, MAX(completed_at) AS last_completed_at
          FROM indicator_completions
          WHERE user_id = $${paramIndex++}
          GROUP BY indicator_id
        ) comp ON comp.indicator_id = i.id
        WHERE ${whereClause}
        GROUP BY i.id, ic.id, ic.name, comp.completion_count, comp.last_completed_at
        ORDER BY i.created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `, [...params, userId, limit, offset]);

      res.json({
        data: rows,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }
      });
    } catch (err) {
      console.error('GET /api/indicators error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// 4. GET /api/indicators/completions - User's completion history
// ============================================================================
router.get('/completions',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('indicator_id').optional().isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const userId = req.user.id;
      const page = req.query.page || 1;
      const limit = req.query.limit || 20;
      const offset = (page - 1) * limit;

      const conditions = ['ic.user_id = $1'];
      const params = [userId];
      let paramIndex = 2;

      if (req.query.indicator_id) {
        conditions.push(`ic.indicator_id = $${paramIndex++}`);
        params.push(req.query.indicator_id);
      }

      const whereClause = conditions.join(' AND ');

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM indicator_completions ic WHERE ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const { rows } = await pool.query(`
        SELECT
          ic.id AS completion_id, ic.indicator_id, ic.total_score, ic.max_score,
          ic.percentage, ic.completed_at,
          i.title AS indicator_title, i.include_scoring,
          cat.id AS category_id, cat.name AS category_name
        FROM indicator_completions ic
        JOIN indicators i ON i.id = ic.indicator_id
        LEFT JOIN indicator_categories cat ON cat.id = i.category_id
        WHERE ${whereClause}
        ORDER BY ic.completed_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `, [...params, limit, offset]);

      res.json({
        data: rows,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }
      });
    } catch (err) {
      console.error('GET /api/indicators/completions error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// 5. GET /api/indicators/completions/:completionId - Specific completion detail
// ============================================================================
router.get('/completions/:completionId',
  [
    param('completionId').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const completionId = req.params.completionId;
      const userId = req.user.id;

      const result = await pool.query(`
        SELECT
          ic.id AS completion_id, ic.indicator_id, ic.total_score, ic.max_score,
          ic.percentage, ic.section_scores, ic.report_html, ic.completed_at,
          i.title AS indicator_title, i.description AS indicator_description,
          i.include_scoring, i.footer_html,
          cat.id AS category_id, cat.name AS category_name
        FROM indicator_completions ic
        JOIN indicators i ON i.id = ic.indicator_id
        LEFT JOIN indicator_categories cat ON cat.id = i.category_id
        WHERE ic.id = $1 AND ic.user_id = $2
      `, [completionId, userId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Completion not found' });
      }

      const completion = result.rows[0];

      // Parse section_scores JSONB for structured response
      let sectionBreakdown = [];
      if (completion.section_scores) {
        const scores = typeof completion.section_scores === 'string'
          ? JSON.parse(completion.section_scores)
          : completion.section_scores;
        sectionBreakdown = Object.values(scores);
      }

      res.json({
        data: {
          ...completion,
          section_breakdown: sectionBreakdown
        }
      });
    } catch (err) {
      console.error('GET /api/indicators/completions/:completionId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// 6. GET /api/indicators/completions/:completionId/download - Download report
// ============================================================================
router.get('/completions/:completionId/download',
  [
    param('completionId').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const completionId = req.params.completionId;
      const userId = req.user.id;

      const result = await pool.query(`
        SELECT ic.report_html, ic.completed_at, i.title AS indicator_title
        FROM indicator_completions ic
        JOIN indicators i ON i.id = ic.indicator_id
        WHERE ic.id = $1 AND ic.user_id = $2
      `, [completionId, userId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Completion not found' });
      }

      const { report_html, indicator_title, completed_at } = result.rows[0];
      const dateStr = new Date(completed_at).toISOString().split('T')[0];
      const filename = `${indicator_title.replace(/[^a-zA-Z0-9]/g, '_')}_${dateStr}.html`;

      const styledHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${indicator_title} - Report</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 20px;
      color: #333;
      line-height: 1.6;
      background: #f9fafb;
    }
    .report-container {
      background: #fff;
      border-radius: 12px;
      padding: 40px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    h1 { color: #1a1a2e; margin-bottom: 4px; }
    h2 { color: #16213e; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
    h3 { color: #0f3460; }
    .score-badge {
      display: inline-block;
      background: #3b82f6;
      color: #fff;
      padding: 8px 16px;
      border-radius: 20px;
      font-weight: bold;
      font-size: 1.1em;
    }
    .section-score {
      background: #f1f5f9;
      border-radius: 8px;
      padding: 16px;
      margin: 12px 0;
    }
    .meta { color: #64748b; font-size: 0.9em; }
    @media print {
      body { background: #fff; padding: 0; }
      .report-container { box-shadow: none; padding: 20px; }
    }
  </style>
</head>
<body>
  <div class="report-container">
    ${report_html}
  </div>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(styledHtml);
    } catch (err) {
      console.error('GET /api/indicators/completions/:completionId/download error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// 7. GET /api/indicators/stats - Manager+ anonymised aggregated stats
// ============================================================================
router.get('/stats',
  [
    requireManager,
    query('department').optional().trim(),
    query('business_unit').optional().trim(),
    query('date_from').optional().isISO8601(),
    query('date_to').optional().isISO8601(),
    validate
  ],
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const ANONYMISATION_THRESHOLD = 5;

      // Build filter conditions for completions
      const conditions = ['ic.company_id = $1'];
      const params = [companyId];
      let paramIndex = 2;

      if (req.query.department) {
        conditions.push(`u.department = $${paramIndex++}`);
        params.push(req.query.department);
      }
      if (req.query.business_unit) {
        conditions.push(`u.business_unit = $${paramIndex++}`);
        params.push(req.query.business_unit);
      }
      if (req.query.date_from) {
        conditions.push(`ic.completed_at >= $${paramIndex++}`);
        params.push(req.query.date_from);
      }
      if (req.query.date_to) {
        conditions.push(`ic.completed_at <= $${paramIndex++}`);
        params.push(req.query.date_to);
      }

      const whereClause = conditions.join(' AND ');
      const joinUser = (req.query.department || req.query.business_unit)
        ? 'JOIN users u ON u.id = ic.user_id'
        : 'LEFT JOIN users u ON u.id = ic.user_id';

      // --- Completion rates per indicator ---
      const crConditions = ['ic.company_id = $1'];
      const crParams = [companyId];
      let crIdx = 2;
      if (req.query.department) {
        crConditions.push(`u.department = $${crIdx++}`);
        crParams.push(req.query.department);
      }
      if (req.query.business_unit) {
        crConditions.push(`u.business_unit = $${crIdx++}`);
        crParams.push(req.query.business_unit);
      }
      if (req.query.date_from) {
        crConditions.push(`ic.completed_at >= $${crIdx++}`);
        crParams.push(req.query.date_from);
      }
      if (req.query.date_to) {
        crConditions.push(`ic.completed_at <= $${crIdx++}`);
        crParams.push(req.query.date_to);
      }
      const crJoinUser = (req.query.department || req.query.business_unit)
        ? 'LEFT JOIN users u ON u.id = ic.user_id'
        : '';
      const crExtraWhere = crConditions.length > 1
        ? 'AND ' + crConditions.slice(1).join(' AND ')
        : '';

      const completionRates = await pool.query(`
        SELECT
          i.id AS indicator_id, i.title,
          COUNT(DISTINCT ic.user_id)::int AS unique_completions,
          COUNT(ic.id)::int AS total_completions
        FROM indicators i
        JOIN indicator_org_assignments ioa ON ioa.indicator_id = i.id AND ioa.company_id = $1
        LEFT JOIN indicator_completions ic ON ic.indicator_id = i.id AND ic.company_id = $1
        ${crJoinUser}
        WHERE i.status = 'published' ${crExtraWhere}
        GROUP BY i.id, i.title
        HAVING COUNT(DISTINCT ic.user_id) >= ${ANONYMISATION_THRESHOLD} OR COUNT(DISTINCT ic.user_id) = 0
        ORDER BY total_completions DESC
      `, crParams);

      // --- Average scores by category ---
      const avgByCategory = await pool.query(`
        SELECT
          cat.id AS category_id, cat.name AS category_name,
          ROUND(AVG(ic.percentage)::numeric, 2) AS avg_percentage,
          COUNT(DISTINCT ic.user_id)::int AS unique_respondents,
          COUNT(ic.id)::int AS total_completions
        FROM indicator_completions ic
        JOIN indicators i ON i.id = ic.indicator_id
        LEFT JOIN indicator_categories cat ON cat.id = i.category_id
        ${joinUser}
        WHERE ${whereClause} AND ic.percentage IS NOT NULL
        GROUP BY cat.id, cat.name
        HAVING COUNT(DISTINCT ic.user_id) >= ${ANONYMISATION_THRESHOLD}
        ORDER BY avg_percentage DESC
      `, params);

      // --- Monthly completion trend ---
      const monthlyTrend = await pool.query(`
        SELECT
          TO_CHAR(ic.completed_at, 'YYYY-MM') AS month,
          COUNT(ic.id)::int AS completions,
          COUNT(DISTINCT ic.user_id)::int AS unique_users,
          ROUND(AVG(ic.percentage)::numeric, 2) AS avg_percentage
        FROM indicator_completions ic
        ${joinUser}
        WHERE ${whereClause}
        GROUP BY TO_CHAR(ic.completed_at, 'YYYY-MM')
        HAVING COUNT(DISTINCT ic.user_id) >= ${ANONYMISATION_THRESHOLD}
        ORDER BY month DESC
        LIMIT 12
      `, params);

      // --- Most / least completed indicators ---
      const mostCompleted = await pool.query(`
        SELECT
          i.id AS indicator_id, i.title,
          COUNT(ic.id)::int AS total_completions,
          COUNT(DISTINCT ic.user_id)::int AS unique_users
        FROM indicator_completions ic
        JOIN indicators i ON i.id = ic.indicator_id
        ${joinUser}
        WHERE ${whereClause}
        GROUP BY i.id, i.title
        HAVING COUNT(DISTINCT ic.user_id) >= ${ANONYMISATION_THRESHOLD}
        ORDER BY total_completions DESC
        LIMIT 5
      `, params);

      const leastCompleted = await pool.query(`
        SELECT
          i.id AS indicator_id, i.title,
          COUNT(ic.id)::int AS total_completions,
          COUNT(DISTINCT ic.user_id)::int AS unique_users
        FROM indicators i
        JOIN indicator_org_assignments ioa ON ioa.indicator_id = i.id AND ioa.company_id = $1
        LEFT JOIN indicator_completions ic ON ic.indicator_id = i.id AND ic.company_id = $1
        WHERE i.status = 'published'
        GROUP BY i.id, i.title
        HAVING COUNT(DISTINCT ic.user_id) >= ${ANONYMISATION_THRESHOLD}
        ORDER BY total_completions ASC
        LIMIT 5
      `, [companyId]);

      // --- Score distribution (band-based) ---
      const scoreDistribution = await pool.query(`
        SELECT
          CASE
            WHEN ic.percentage >= 80 THEN 'excellent'
            WHEN ic.percentage >= 60 THEN 'good'
            WHEN ic.percentage >= 40 THEN 'moderate'
            WHEN ic.percentage >= 20 THEN 'low'
            ELSE 'very_low'
          END AS band,
          COUNT(ic.id)::int AS count
        FROM indicator_completions ic
        ${joinUser}
        WHERE ${whereClause} AND ic.percentage IS NOT NULL
        GROUP BY band
        HAVING COUNT(ic.id) >= ${ANONYMISATION_THRESHOLD}
        ORDER BY
          CASE
            WHEN band = 'excellent' THEN 1
            WHEN band = 'good' THEN 2
            WHEN band = 'moderate' THEN 3
            WHEN band = 'low' THEN 4
            ELSE 5
          END
      `, params);

      // Total completions for context
      const totalResult = await pool.query(`
        SELECT COUNT(ic.id)::int AS total, COUNT(DISTINCT ic.user_id)::int AS unique_users
        FROM indicator_completions ic
        ${joinUser}
        WHERE ${whereClause}
      `, params);

      res.json({
        data: {
          overview: {
            total_completions: totalResult.rows[0].total,
            unique_users: totalResult.rows[0].unique_users,
            anonymisation_threshold: ANONYMISATION_THRESHOLD
          },
          completion_rates: completionRates.rows,
          avg_scores_by_category: avgByCategory.rows,
          monthly_trend: monthlyTrend.rows,
          most_completed: mostCompleted.rows,
          least_completed: leastCompleted.rows,
          score_distribution: scoreDistribution.rows
        }
      });
    } catch (err) {
      console.error('GET /api/indicators/stats error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// 2. GET /api/indicators/:id - Indicator detail with sections & questions
// ============================================================================
router.get('/:id',
  [
    param('id').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const indicatorId = req.params.id;
      const companyId = req.user.company_id;

      // Verify indicator is published and assigned to user's org
      const indicatorResult = await pool.query(`
        SELECT i.id, i.title, i.description, i.disclaimer, i.footer_html,
               i.banner_url, i.background_url, i.include_scoring,
               ic.id AS category_id, ic.name AS category_name
        FROM indicators i
        JOIN indicator_org_assignments ioa ON ioa.indicator_id = i.id AND ioa.company_id = $2
        LEFT JOIN indicator_categories ic ON ic.id = i.category_id
        WHERE i.id = $1 AND i.status = 'published'
      `, [indicatorId, companyId]);

      if (indicatorResult.rows.length === 0) {
        return res.status(404).json({ error: 'Indicator not found' });
      }

      // Fetch sections with questions (exclude scoring data from employee view)
      const sectionsResult = await pool.query(`
        SELECT s.id, s.title, s.description, s.sort_order,
          json_agg(
            json_build_object(
              'id', q.id,
              'question_text', q.question_text,
              'question_type', q.question_type,
              'options', q.options,
              'sort_order', q.sort_order
            ) ORDER BY q.sort_order
          ) FILTER (WHERE q.id IS NOT NULL) AS questions
        FROM indicator_sections s
        LEFT JOIN indicator_questions q ON q.section_id = s.id
        WHERE s.indicator_id = $1
        GROUP BY s.id
        ORDER BY s.sort_order
      `, [indicatorId]);

      const data = {
        ...indicatorResult.rows[0],
        sections: sectionsResult.rows
      };

      res.json({ data });
    } catch (err) {
      console.error('GET /api/indicators/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// 3. POST /api/indicators/:id/complete - Submit completed assessment
// ============================================================================
router.post('/:id/complete',
  [
    param('id').isUUID(),
    body('answers').isArray({ min: 1 }).withMessage('Answers are required'),
    body('answers.*.question_id').notEmpty().isUUID(),
    body('answers.*.answer_value').exists().withMessage('Answer value is required'),
    validate
  ],
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const indicatorId = req.params.id;
      const userId = req.user.id;
      const companyId = req.user.company_id;
      const { answers } = req.body;

      // Verify indicator is published and assigned to user's org
      const indicatorResult = await client.query(`
        SELECT i.*
        FROM indicators i
        JOIN indicator_org_assignments ioa ON ioa.indicator_id = i.id AND ioa.company_id = $2
        WHERE i.id = $1 AND i.status = 'published'
      `, [indicatorId, companyId]);

      if (indicatorResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Indicator not found or not available' });
      }

      const indicator = indicatorResult.rows[0];

      // Fetch all sections with their scoring config
      const sectionsResult = await client.query(`
        SELECT id, title, scoring_enabled, multiplier, base_max_score, effective_max_score
        FROM indicator_sections
        WHERE indicator_id = $1
        ORDER BY sort_order
      `, [indicatorId]);
      const sections = sectionsResult.rows;

      // Fetch all questions with scoring info
      const questionsResult = await client.query(`
        SELECT q.id, q.section_id, q.question_type, q.options, q.scoring_enabled
        FROM indicator_questions q
        JOIN indicator_sections s ON s.id = q.section_id
        WHERE s.indicator_id = $1
      `, [indicatorId]);
      const questions = questionsResult.rows;

      // Build lookup maps
      const questionMap = {};
      for (const q of questions) {
        questionMap[q.id] = q;
      }

      const answerMap = {};
      for (const a of answers) {
        answerMap[a.question_id] = a.answer_value;
      }

      // Calculate scores
      let totalScore = 0;
      let maxPossible = 0;
      const sectionScores = {};
      const includeScoring = indicator.include_scoring;

      for (const section of sections) {
        let sectionRawScore = 0;
        let sectionMaxRaw = 0;

        if (!section.scoring_enabled || !includeScoring) {
          sectionScores[section.id] = {
            section_id: section.id,
            title: section.title,
            scoring_enabled: false,
            raw_score: null,
            multiplier: section.multiplier,
            weighted_score: null,
            max_score: null
          };
          continue;
        }

        // Get questions for this section
        const sectionQuestions = questions.filter(q => q.section_id === section.id);

        for (const question of sectionQuestions) {
          if (!question.scoring_enabled) continue;

          const answerValue = answerMap[question.id];
          if (answerValue === undefined || answerValue === null) continue;

          // Calculate numeric value from answer
          const numericValue = extractNumericScore(question, answerValue);
          sectionRawScore += numericValue;

          // Calculate max possible for this question
          const questionMax = getQuestionMaxScore(question);
          sectionMaxRaw += questionMax;
        }

        const multiplier = parseFloat(section.multiplier) || 1;
        const weightedScore = sectionRawScore * multiplier;
        const sectionMax = section.effective_max_score
          ? parseFloat(section.effective_max_score)
          : sectionMaxRaw * multiplier;

        sectionScores[section.id] = {
          section_id: section.id,
          title: section.title,
          scoring_enabled: true,
          raw_score: sectionRawScore,
          multiplier: multiplier,
          weighted_score: weightedScore,
          max_score: sectionMax
        };

        totalScore += weightedScore;
        maxPossible += sectionMax;
      }

      const percentage = maxPossible > 0
        ? Math.round((totalScore / maxPossible) * 100 * 100) / 100
        : 0;

      // Look up curated responses for each section based on score range
      const sectionCuratedResponses = {};
      if (includeScoring) {
        for (const sectionId of Object.keys(sectionScores)) {
          const sData = sectionScores[sectionId];
          if (!sData.scoring_enabled) continue;

          const rangeResult = await client.query(`
            SELECT title, description
            FROM indicator_responses
            WHERE indicator_id = $1
              AND section_id = $2
              AND score_range_min <= $3
              AND score_range_max >= $3
            ORDER BY score_range_min
            LIMIT 1
          `, [indicatorId, sectionId, sData.weighted_score]);

          if (rangeResult.rows.length > 0) {
            sectionCuratedResponses[sectionId] = rangeResult.rows[0];
          }
        }
      }

      // Look up overall curated response
      let overallCuratedResponse = null;
      if (includeScoring) {
        const overallResult = await client.query(`
          SELECT title, intro_text, conclusion_text
          FROM indicator_responses
          WHERE indicator_id = $1
            AND section_id IS NULL
            AND start_score <= $2
            AND end_score >= $2
          ORDER BY start_score
          LIMIT 1
        `, [indicatorId, totalScore]);

        if (overallResult.rows.length > 0) {
          overallCuratedResponse = overallResult.rows[0];
        }
      }

      // Fetch user and company info for placeholders
      const userResult = await client.query(
        'SELECT first_name, last_name, email FROM users WHERE id = $1',
        [userId]
      );
      const user = userResult.rows[0];

      const companyResult = await client.query(
        'SELECT name FROM companies WHERE id = $1',
        [companyId]
      );
      const companyName = companyResult.rows[0]?.name || '';

      // Generate report HTML
      const reportHtml = generateReportHtml({
        indicator,
        sections,
        sectionScores,
        sectionCuratedResponses,
        overallCuratedResponse,
        totalScore,
        maxPossible,
        percentage,
        user,
        companyName,
        includeScoring
      });

      // Save completion record
      const completionId = uuidv4();
      await client.query(`
        INSERT INTO indicator_completions (
          id, indicator_id, user_id, company_id,
          total_score, max_score, percentage,
          section_scores, report_html, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      `, [
        completionId, indicatorId, userId, companyId,
        includeScoring ? totalScore : null,
        includeScoring ? maxPossible : null,
        includeScoring ? percentage : null,
        JSON.stringify(sectionScores),
        reportHtml
      ]);

      // Save individual answers
      for (const answer of answers) {
        const question = questionMap[answer.question_id];
        const numericScore = (question && question.scoring_enabled && includeScoring)
          ? extractNumericScore(question, answer.answer_value)
          : null;

        await client.query(`
          INSERT INTO indicator_answers (id, completion_id, question_id, answer_value, numeric_score, created_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
        `, [
          uuidv4(), completionId, answer.question_id,
          JSON.stringify(answer.answer_value), numericScore
        ]);
      }

      await client.query('COMMIT');

      // Send results email if configured
      if (indicator.send_results && user.email) {
        const emailHtml = indicator.mail_content_html
          ? applyPlaceholders(indicator.mail_content_html, {
              first_name: user.first_name,
              last_name: user.last_name,
              company_name: companyName,
              survey_score: totalScore,
              survey_max_score: maxPossible,
              survey_percentage: percentage
            })
          : reportHtml;

        try {
          await sendCompanyEmail({
            companyId,
            to: user.email,
            subject: `Your ${indicator.title} Results`,
            html: emailHtml
          });
        } catch (emailErr) {
          console.error('Failed to send indicator results email:', emailErr);
          // Non-blocking: completion still succeeds
        }
      }

      res.status(201).json({
        data: {
          completion_id: completionId,
          indicator_title: indicator.title,
          total_score: includeScoring ? totalScore : null,
          max_score: includeScoring ? maxPossible : null,
          percentage: includeScoring ? percentage : null,
          overall_response: overallCuratedResponse
            ? { title: overallCuratedResponse.title }
            : null,
          section_summaries: includeScoring
            ? Object.values(sectionScores)
                .filter(s => s.scoring_enabled)
                .map(s => ({
                  section_id: s.section_id,
                  title: s.title,
                  weighted_score: s.weighted_score,
                  max_score: s.max_score,
                  curated_response: sectionCuratedResponses[s.section_id]?.title || null
                }))
            : null
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /api/indicators/:id/complete error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Extract a numeric score from a question answer based on question type and options.
 * Options are expected as an array of { label, value, score } objects.
 */
function extractNumericScore(question, answerValue) {
  if (!question || !question.scoring_enabled) return 0;

  // If answerValue is already numeric (e.g., scale type)
  if (typeof answerValue === 'number') return answerValue;

  // Parse options
  let options = question.options;
  if (typeof options === 'string') {
    try { options = JSON.parse(options); } catch { return 0; }
  }

  if (!Array.isArray(options)) {
    // Attempt numeric parse as fallback
    const num = parseFloat(answerValue);
    return isNaN(num) ? 0 : num;
  }

  // For single_choice / yes_no: find the matching option and return its score
  if (question.question_type === 'single_choice' || question.question_type === 'yes_no') {
    const match = options.find(
      o => String(o.value) === String(answerValue) || String(o.label) === String(answerValue)
    );
    return match && match.score !== undefined ? parseFloat(match.score) : 0;
  }

  // For scale: answer is the numeric value directly
  if (question.question_type === 'scale') {
    const num = parseFloat(answerValue);
    return isNaN(num) ? 0 : num;
  }

  // For multiple_choice: sum scores of selected options
  if (question.question_type === 'multiple_choice') {
    const selected = Array.isArray(answerValue) ? answerValue : [answerValue];
    let total = 0;
    for (const sel of selected) {
      const match = options.find(
        o => String(o.value) === String(sel) || String(o.label) === String(sel)
      );
      if (match && match.score !== undefined) {
        total += parseFloat(match.score);
      }
    }
    return total;
  }

  // text questions: no score
  return 0;
}

/**
 * Get the maximum possible score for a question.
 */
function getQuestionMaxScore(question) {
  if (!question || !question.scoring_enabled) return 0;

  let options = question.options;
  if (typeof options === 'string') {
    try { options = JSON.parse(options); } catch { return 0; }
  }

  if (!Array.isArray(options) || options.length === 0) return 0;

  const scores = options
    .map(o => (o.score !== undefined ? parseFloat(o.score) : 0))
    .filter(s => !isNaN(s));

  if (scores.length === 0) return 0;

  if (question.question_type === 'multiple_choice') {
    // Max = sum of all positive scores
    return scores.filter(s => s > 0).reduce((sum, s) => sum + s, 0);
  }

  // single_choice, yes_no, scale: max is the highest option score
  return Math.max(...scores);
}

/**
 * Apply dynamic placeholders to HTML content.
 */
function applyPlaceholders(html, data) {
  return html
    .replace(/%first_name%/g, data.first_name || '')
    .replace(/%last_name%/g, data.last_name || '')
    .replace(/%company_name%/g, data.company_name || '')
    .replace(/%survey_score%/g, String(data.survey_score ?? ''))
    .replace(/%survey_max_score%/g, String(data.survey_max_score ?? ''))
    .replace(/%survey_percentage%/g, String(data.survey_percentage ?? ''));
}

/**
 * Generate the full report HTML for a completion.
 */
function generateReportHtml({
  indicator, sections, sectionScores, sectionCuratedResponses,
  overallCuratedResponse, totalScore, maxPossible, percentage,
  user, companyName, includeScoring
}) {
  const placeholderData = {
    first_name: user.first_name,
    last_name: user.last_name,
    company_name: companyName,
    survey_score: totalScore,
    survey_max_score: maxPossible,
    survey_percentage: percentage
  };

  let html = `<h1>${indicator.title}</h1>`;
  html += `<p class="meta">Completed by ${user.first_name} ${user.last_name} on ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p>`;

  if (indicator.description) {
    html += `<p>${indicator.description}</p>`;
  }

  // Overall score
  if (includeScoring && maxPossible > 0) {
    html += `<h2>Overall Score</h2>`;
    html += `<p><span class="score-badge">${totalScore} / ${maxPossible} (${percentage}%)</span></p>`;

    if (overallCuratedResponse) {
      html += `<h3>${overallCuratedResponse.title}</h3>`;
      if (overallCuratedResponse.intro_text) {
        html += `<p>${applyPlaceholders(overallCuratedResponse.intro_text, placeholderData)}</p>`;
      }
      if (overallCuratedResponse.conclusion_text) {
        html += `<p>${applyPlaceholders(overallCuratedResponse.conclusion_text, placeholderData)}</p>`;
      }
    }
  }

  // Section breakdowns
  html += `<h2>Section Results</h2>`;
  for (const section of sections) {
    const sData = sectionScores[section.id];
    if (!sData) continue;

    html += `<div class="section-score">`;
    html += `<h3>${section.title}</h3>`;

    if (sData.scoring_enabled && includeScoring) {
      html += `<p>Score: <strong>${sData.weighted_score}</strong> / ${sData.max_score}</p>`;

      const curatedResp = sectionCuratedResponses[section.id];
      if (curatedResp) {
        html += `<p><strong>${curatedResp.title}</strong></p>`;
        if (curatedResp.description) {
          html += `<p>${applyPlaceholders(curatedResp.description, placeholderData)}</p>`;
        }
      }
    } else {
      html += `<p><em>This section is not scored.</em></p>`;
    }

    html += `</div>`;
  }

  // Disclaimer
  if (indicator.disclaimer) {
    html += `<hr><p class="meta"><em>${indicator.disclaimer}</em></p>`;
  }

  // Footer
  if (indicator.footer_html) {
    html += applyPlaceholders(indicator.footer_html, placeholderData);
  }

  return html;
}

module.exports = router;
