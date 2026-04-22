const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireManager, requireAdmin, requireRole, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// HELPERS
// ============================================================

const MIN_GROUP_SIZE_DEFAULT = 5;

/**
 * Build standard filter WHERE clause and params from request query.
 * Returns { whereClause, params, paramIdx } to append to existing queries.
 */
function buildReportFilters(reqQuery, startParamIdx, startParams = []) {
  const params = [...startParams];
  let paramIdx = startParamIdx;
  let clauses = [];

  const { date_from, date_to, business_unit, department, role, job_level,
          location, manager_id, employment_status, tenure_min, tenure_max,
          participation_level, performance_rating_min, performance_rating_max,
          wellbeing_category, survey_type } = reqQuery;

  if (date_from) {
    clauses.push(`created_at >= $${paramIdx++}`);
    params.push(date_from);
  }
  if (date_to) {
    clauses.push(`created_at <= $${paramIdx++}`);
    params.push(date_to);
  }
  if (business_unit) {
    clauses.push(`u.business_unit = $${paramIdx++}`);
    params.push(business_unit);
  }
  if (department) {
    clauses.push(`u.department = $${paramIdx++}`);
    params.push(department);
  }
  if (role) {
    clauses.push(`u.role = $${paramIdx++}`);
    params.push(role);
  }
  if (job_level) {
    clauses.push(`u.job_level = $${paramIdx++}`);
    params.push(job_level);
  }
  if (location) {
    clauses.push(`u.location = $${paramIdx++}`);
    params.push(location);
  }
  if (manager_id) {
    clauses.push(`u.manager_id = $${paramIdx++}`);
    params.push(manager_id);
  }
  if (employment_status) {
    clauses.push(`u.employment_status = $${paramIdx++}`);
    params.push(employment_status);
  }

  return { filterClause: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params, paramIdx };
}

/**
 * Check minimum group threshold for anonymised data
 */
function enforceMinGroupSize(count, minSize) {
  return count >= minSize;
}

/**
 * Build drill-down GROUP BY based on level param
 */
function getDrillDownGroupBy(level) {
  switch (level) {
    case 'bu': return 'u.business_unit';
    case 'department': return 'u.department';
    case 'individual': return 'u.id, u.first_name, u.last_name';
    default: return null; // org level - no group by user dimension
  }
}

// Standard validation for all report endpoints
const reportFilters = [
  query('date_from').optional().isISO8601(),
  query('date_to').optional().isISO8601(),
  query('business_unit').optional().isString(),
  query('department').optional().isString(),
  query('role').optional().isString(),
  query('job_level').optional().isString(),
  query('location').optional().isString(),
  query('manager_id').optional().isUUID(),
  query('employment_status').optional().isString(),
  query('level').optional().isIn(['org', 'bu', 'department', 'individual'])
];

// All report endpoints require admin
const reportAuth = [authenticate, requireAdmin];

// ============================================================
// OVERVIEW DASHBOARD
// ============================================================

router.get('/overview',
  ...reportAuth,
  reportFilters,
  validate,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const { filterClause, params } = buildReportFilters(req.query, 2, [companyId]);

      const baseUserFilter = `u.company_id = $1${filterClause}`;

      const [smiles, socialWall, perfObjectives, devObjectives, wellbeing, surveys, challenges, learningSessions] = await Promise.all([
        // Smiles activity
        pool.query(`
          SELECT COUNT(*) AS total_smiles,
                 COUNT(DISTINCT s.sender_id) AS unique_senders,
                 COUNT(DISTINCT s.receiver_id) AS unique_receivers
          FROM smiles s
          JOIN users u ON u.id = s.sender_id
          WHERE s.company_id = $1 ${filterClause}
        `, params),

        // Social wall engagement
        pool.query(`
          SELECT COUNT(DISTINCT p.id) AS total_posts,
                 COUNT(DISTINCT c.id) AS total_comments,
                 COUNT(DISTINCT r.id) AS total_reactions
          FROM social_wall_posts p
          JOIN users u ON u.id = p.user_id
          LEFT JOIN social_wall_comments c ON c.post_id = p.id
          LEFT JOIN social_wall_reactions r ON r.post_id = p.id
          WHERE p.company_id = $1 ${filterClause}
        `, params),

        // Performance objectives
        pool.query(`
          SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE po.status = 'completed') AS completed,
                 COUNT(*) FILTER (WHERE po.status = 'in_progress') AS in_progress
          FROM performance_objectives po
          JOIN users u ON u.id = po.user_id
          WHERE po.company_id = $1 ${filterClause}
        `, params),

        // Development objectives
        pool.query(`
          SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE do2.status = 'completed') AS completed,
                 COUNT(*) FILTER (WHERE do2.status = 'in_progress') AS in_progress
          FROM development_objectives do2
          JOIN users u ON u.id = do2.user_id
          WHERE do2.company_id = $1 ${filterClause}
        `, params),

        // Wellbeing activity
        pool.query(`
          SELECT COUNT(DISTINCT wo.id) AS wellbeing_objectives,
                 COUNT(DISTINCT pc.id) AS pulse_checks
          FROM users u
          LEFT JOIN wellbeing_objectives wo ON wo.user_id = u.id
          LEFT JOIN pulse_checks pc ON pc.user_id = u.id
          WHERE ${baseUserFilter}
        `, params),

        // Survey participation
        pool.query(`
          SELECT COUNT(DISTINCT s.id) AS total_surveys,
                 COUNT(DISTINCT sr.id) AS total_responses,
                 COUNT(DISTINCT sr.user_id) AS unique_respondents
          FROM surveys s
          LEFT JOIN survey_responses sr ON sr.survey_id = s.id
          WHERE s.company_id = $1
        `, [companyId]),

        // Challenge stats
        pool.query(`
          SELECT COUNT(DISTINCT c.id) AS total_challenges,
                 COUNT(DISTINCT cp.user_id) AS total_participants
          FROM challenges c
          LEFT JOIN challenge_participants cp ON cp.challenge_id = c.id
          WHERE c.company_id = $1 AND c.status = 'active'
        `, [companyId]),

        // Learning session attendance
        pool.query(`
          SELECT COUNT(DISTINCT ls.id) AS total_sessions,
                 COUNT(DISTINCT rsvp.user_id) FILTER (WHERE rsvp.response = 'yes') AS total_rsvps,
                 COUNT(DISTINCT att.user_id) FILTER (WHERE att.status = 'attended') AS total_attended
          FROM learning_sessions ls
          LEFT JOIN learning_session_rsvps rsvp ON rsvp.session_id = ls.id
          LEFT JOIN learning_session_attendance att ON att.session_id = ls.id
          WHERE ls.company_id = $1 AND ls.status = 'published'
        `, [companyId])
      ]);

      res.json({
        overview: {
          smiles: smiles.rows[0],
          social_wall: socialWall.rows[0],
          performance_objectives: perfObjectives.rows[0],
          development_objectives: devObjectives.rows[0],
          wellbeing: wellbeing.rows[0],
          surveys: surveys.rows[0],
          challenges: challenges.rows[0],
          learning_sessions: learningSessions.rows[0]
        }
      });
    } catch (err) {
      console.error('Overview report error:', err);
      res.status(500).json({ error: 'Failed to generate overview report' });
    }
  }
);

// ============================================================
// MODULE-SPECIFIC REPORTS
// ============================================================

// GET /api/reports/smiles
router.get('/smiles',
  ...reportAuth,
  reportFilters,
  validate,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const { filterClause, params } = buildReportFilters(req.query, 2, [companyId]);
      const level = req.query.level || 'org';
      const groupBy = getDrillDownGroupBy(level);

      const [byCategory, trend, distribution] = await Promise.all([
        pool.query(`
          SELECT s.category, COUNT(*) AS count
          FROM smiles s
          JOIN users u ON u.id = s.sender_id
          WHERE s.company_id = $1 ${filterClause}
          GROUP BY s.category
          ORDER BY count DESC
        `, params),

        pool.query(`
          SELECT DATE_TRUNC('week', s.created_at) AS week, COUNT(*) AS count
          FROM smiles s
          JOIN users u ON u.id = s.sender_id
          WHERE s.company_id = $1 ${filterClause}
          GROUP BY week
          ORDER BY week
        `, params),

        pool.query(`
          SELECT u.id AS user_id, u.first_name, u.last_name, u.department,
                 COUNT(*) FILTER (WHERE s.sender_id = u.id) AS sent,
                 COUNT(*) FILTER (WHERE s.receiver_id = u.id) AS received
          FROM users u
          LEFT JOIN smiles s ON (s.sender_id = u.id OR s.receiver_id = u.id) AND s.company_id = $1
          WHERE u.company_id = $1 ${filterClause}
          GROUP BY u.id
          HAVING COUNT(s.id) > 0
          ORDER BY (COUNT(*) FILTER (WHERE s.sender_id = u.id) + COUNT(*) FILTER (WHERE s.receiver_id = u.id)) DESC
          LIMIT 50
        `, params)
      ]);

      res.json({
        by_category: byCategory.rows,
        trend: trend.rows,
        distribution: distribution.rows
      });
    } catch (err) {
      console.error('Smiles report error:', err);
      res.status(500).json({ error: 'Failed to generate smiles report' });
    }
  }
);

// GET /api/reports/social-wall
router.get('/social-wall',
  ...reportAuth,
  reportFilters,
  validate,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const { filterClause, params } = buildReportFilters(req.query, 2, [companyId]);

      const [engagement, trend] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(DISTINCT p.id) AS post_count,
            COUNT(DISTINCT c.id) AS comment_count,
            COUNT(DISTINCT r.id) AS reaction_count,
            COUNT(DISTINCT p.user_id) AS unique_posters,
            CASE WHEN COUNT(DISTINCT u2.id) > 0
              THEN ROUND(COUNT(DISTINCT p.user_id)::numeric / COUNT(DISTINCT u2.id) * 100, 1)
              ELSE 0
            END AS participation_rate_pct
          FROM social_wall_posts p
          JOIN users u ON u.id = p.user_id
          LEFT JOIN social_wall_comments c ON c.post_id = p.id
          LEFT JOIN social_wall_reactions r ON r.post_id = p.id
          LEFT JOIN users u2 ON u2.company_id = $1 AND u2.status = 'active'
          WHERE p.company_id = $1 ${filterClause}
        `, params),

        pool.query(`
          SELECT DATE_TRUNC('week', p.created_at) AS week,
                 COUNT(DISTINCT p.id) AS posts,
                 COUNT(DISTINCT c.id) AS comments,
                 COUNT(DISTINCT r.id) AS reactions
          FROM social_wall_posts p
          JOIN users u ON u.id = p.user_id
          LEFT JOIN social_wall_comments c ON c.post_id = p.id
          LEFT JOIN social_wall_reactions r ON r.post_id = p.id
          WHERE p.company_id = $1 ${filterClause}
          GROUP BY week
          ORDER BY week
        `, params)
      ]);

      res.json({
        engagement: engagement.rows[0],
        trend: trend.rows
      });
    } catch (err) {
      console.error('Social wall report error:', err);
      res.status(500).json({ error: 'Failed to generate social wall report' });
    }
  }
);

// GET /api/reports/performance
router.get('/performance',
  ...reportAuth,
  reportFilters,
  validate,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const { filterClause, params } = buildReportFilters(req.query, 2, [companyId]);

      const [completionRate, reflectionRate, ratingDistribution, approvalStats] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE po.status = 'completed') AS completed,
            CASE WHEN COUNT(*) > 0
              THEN ROUND(COUNT(*) FILTER (WHERE po.status = 'completed')::numeric / COUNT(*) * 100, 1)
              ELSE 0
            END AS completion_rate_pct
          FROM performance_objectives po
          JOIN users u ON u.id = po.user_id
          WHERE po.company_id = $1 ${filterClause}
        `, params),

        pool.query(`
          SELECT
            COUNT(*) AS total_objectives,
            COUNT(*) FILTER (WHERE pr.id IS NOT NULL) AS with_reflections,
            CASE WHEN COUNT(*) > 0
              THEN ROUND(COUNT(*) FILTER (WHERE pr.id IS NOT NULL)::numeric / COUNT(*) * 100, 1)
              ELSE 0
            END AS reflection_rate_pct
          FROM performance_objectives po
          JOIN users u ON u.id = po.user_id
          LEFT JOIN performance_reflections pr ON pr.objective_id = po.id
          WHERE po.company_id = $1 ${filterClause}
        `, params),

        pool.query(`
          SELECT po.rating, COUNT(*) AS count
          FROM performance_objectives po
          JOIN users u ON u.id = po.user_id
          WHERE po.company_id = $1 AND po.rating IS NOT NULL ${filterClause}
          GROUP BY po.rating
          ORDER BY po.rating
        `, params),

        pool.query(`
          SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE po.approval_status = 'approved') AS approved,
            COUNT(*) FILTER (WHERE po.approval_status = 'pending') AS pending,
            COUNT(*) FILTER (WHERE po.approval_status = 'rejected') AS rejected
          FROM performance_objectives po
          JOIN users u ON u.id = po.user_id
          WHERE po.company_id = $1 ${filterClause}
        `, params)
      ]);

      res.json({
        completion: completionRate.rows[0],
        reflection: reflectionRate.rows[0],
        rating_distribution: ratingDistribution.rows,
        approval: approvalStats.rows[0]
      });
    } catch (err) {
      console.error('Performance report error:', err);
      res.status(500).json({ error: 'Failed to generate performance report' });
    }
  }
);

// GET /api/reports/development
router.get('/development',
  ...reportAuth,
  reportFilters,
  validate,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const { filterClause, params } = buildReportFilters(req.query, 2, [companyId]);

      const [completionRate, reflectionRate, ratingDistribution, approvalStats] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE do2.status = 'completed') AS completed,
            CASE WHEN COUNT(*) > 0
              THEN ROUND(COUNT(*) FILTER (WHERE do2.status = 'completed')::numeric / COUNT(*) * 100, 1)
              ELSE 0
            END AS completion_rate_pct
          FROM development_objectives do2
          JOIN users u ON u.id = do2.user_id
          WHERE do2.company_id = $1 ${filterClause}
        `, params),

        pool.query(`
          SELECT
            COUNT(*) AS total_objectives,
            COUNT(*) FILTER (WHERE dr.id IS NOT NULL) AS with_reflections,
            CASE WHEN COUNT(*) > 0
              THEN ROUND(COUNT(*) FILTER (WHERE dr.id IS NOT NULL)::numeric / COUNT(*) * 100, 1)
              ELSE 0
            END AS reflection_rate_pct
          FROM development_objectives do2
          JOIN users u ON u.id = do2.user_id
          LEFT JOIN development_reflections dr ON dr.objective_id = do2.id
          WHERE do2.company_id = $1 ${filterClause}
        `, params),

        pool.query(`
          SELECT do2.rating, COUNT(*) AS count
          FROM development_objectives do2
          JOIN users u ON u.id = do2.user_id
          WHERE do2.company_id = $1 AND do2.rating IS NOT NULL ${filterClause}
          GROUP BY do2.rating
          ORDER BY do2.rating
        `, params),

        pool.query(`
          SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE do2.approval_status = 'approved') AS approved,
            COUNT(*) FILTER (WHERE do2.approval_status = 'pending') AS pending,
            COUNT(*) FILTER (WHERE do2.approval_status = 'rejected') AS rejected
          FROM development_objectives do2
          JOIN users u ON u.id = do2.user_id
          WHERE do2.company_id = $1 ${filterClause}
        `, params)
      ]);

      res.json({
        completion: completionRate.rows[0],
        reflection: reflectionRate.rows[0],
        rating_distribution: ratingDistribution.rows,
        approval: approvalStats.rows[0]
      });
    } catch (err) {
      console.error('Development report error:', err);
      res.status(500).json({ error: 'Failed to generate development report' });
    }
  }
);

// GET /api/reports/wellbeing (anonymised)
router.get('/wellbeing',
  ...reportAuth,
  reportFilters,
  validate,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const { filterClause, params } = buildReportFilters(req.query, 2, [companyId]);
      const minGroupSize = req.query.min_group_size ? +req.query.min_group_size : MIN_GROUP_SIZE_DEFAULT;

      const [pulseTrend, indicatorCompletions, resourceEngagement, objectiveProgress] = await Promise.all([
        // Pulse check trends (anonymised)
        pool.query(`
          SELECT DATE_TRUNC('week', pc.created_at) AS week,
                 ROUND(AVG(pc.score), 2) AS avg_score,
                 COUNT(DISTINCT pc.user_id) AS respondents
          FROM pulse_checks pc
          JOIN users u ON u.id = pc.user_id
          WHERE pc.company_id = $1 ${filterClause}
          GROUP BY week
          HAVING COUNT(DISTINCT pc.user_id) >= ${minGroupSize}
          ORDER BY week
        `, params),

        // Indicator completions (anonymised)
        pool.query(`
          SELECT wi.name AS indicator, wi.category,
                 COUNT(DISTINCT wic.user_id) AS completions,
                 ROUND(AVG(wic.score), 2) AS avg_score
          FROM wellbeing_indicator_completions wic
          JOIN wellbeing_indicators wi ON wi.id = wic.indicator_id
          JOIN users u ON u.id = wic.user_id
          WHERE wic.company_id = $1 ${filterClause}
          GROUP BY wi.id
          HAVING COUNT(DISTINCT wic.user_id) >= ${minGroupSize}
          ORDER BY completions DESC
        `, params),

        // Resource engagement
        pool.query(`
          SELECT wr.title, wr.category, wr.theme,
                 COUNT(DISTINCT wre.user_id) AS unique_views,
                 COUNT(wre.id) AS total_views
          FROM wellbeing_resource_engagements wre
          JOIN wellbeing_resources wr ON wr.id = wre.resource_id
          JOIN users u ON u.id = wre.user_id
          WHERE wr.company_id = $1 ${filterClause}
          GROUP BY wr.id
          ORDER BY unique_views DESC
          LIMIT 30
        `, params),

        // Objective progress (anonymised)
        pool.query(`
          SELECT wo.category,
                 COUNT(DISTINCT wo.user_id) AS users_with_objectives,
                 COUNT(*) AS total_objectives,
                 COUNT(*) FILTER (WHERE wo.status = 'completed') AS completed,
                 ROUND(AVG(wo.progress_pct), 1) AS avg_progress_pct
          FROM wellbeing_objectives wo
          JOIN users u ON u.id = wo.user_id
          WHERE wo.company_id = $1 ${filterClause}
          GROUP BY wo.category
          HAVING COUNT(DISTINCT wo.user_id) >= ${minGroupSize}
          ORDER BY users_with_objectives DESC
        `, params)
      ]);

      res.json({
        pulse_trend: pulseTrend.rows,
        indicator_completions: indicatorCompletions.rows,
        resource_engagement: resourceEngagement.rows,
        objective_progress: objectiveProgress.rows
      });
    } catch (err) {
      console.error('Wellbeing report error:', err);
      res.status(500).json({ error: 'Failed to generate wellbeing report' });
    }
  }
);

// GET /api/reports/surveys
router.get('/surveys',
  ...reportAuth,
  reportFilters,
  validate,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const minGroupSize = req.query.min_group_size ? +req.query.min_group_size : MIN_GROUP_SIZE_DEFAULT;

      const { rows: surveyList } = await pool.query(`
        SELECT s.id, s.title, s.survey_type, s.status, s.created_at,
               COUNT(DISTINCT sr.user_id) AS respondents,
               (SELECT COUNT(*) FROM users WHERE company_id = $1 AND status = 'active') AS total_employees,
               CASE WHEN (SELECT COUNT(*) FROM users WHERE company_id = $1 AND status = 'active') > 0
                 THEN ROUND(COUNT(DISTINCT sr.user_id)::numeric /
                      (SELECT COUNT(*) FROM users WHERE company_id = $1 AND status = 'active') * 100, 1)
                 ELSE 0
               END AS response_rate_pct
        FROM surveys s
        LEFT JOIN survey_responses sr ON sr.survey_id = s.id
        WHERE s.company_id = $1
        GROUP BY s.id
        ORDER BY s.created_at DESC
      `, [companyId]);

      // Aggregated answers for latest survey
      let aggregatedAnswers = [];
      if (surveyList.length) {
        const latestSurveyId = surveyList[0].id;
        const { rows } = await pool.query(`
          SELECT sq.id AS question_id, sq.question_text, sq.question_type,
                 CASE
                   WHEN sq.question_type IN ('rating', 'scale')
                   THEN json_build_object('avg', ROUND(AVG(sa.numeric_value), 2), 'count', COUNT(*))
                   WHEN sq.question_type IN ('multiple_choice', 'single_choice')
                   THEN json_agg(json_build_object('value', sa.text_value, 'count',
                        (SELECT COUNT(*) FROM survey_answers sa2
                         WHERE sa2.question_id = sq.id AND sa2.text_value = sa.text_value)))
                   ELSE json_build_object('count', COUNT(*))
                 END AS aggregated
          FROM survey_questions sq
          LEFT JOIN survey_answers sa ON sa.question_id = sq.id
          WHERE sq.survey_id = $1
          GROUP BY sq.id
          HAVING COUNT(DISTINCT sa.response_id) >= $2
          ORDER BY sq.sort_order
        `, [latestSurveyId, minGroupSize]);

        aggregatedAnswers = rows;
      }

      res.json({
        surveys: surveyList,
        aggregated_answers: aggregatedAnswers
      });
    } catch (err) {
      console.error('Surveys report error:', err);
      res.status(500).json({ error: 'Failed to generate surveys report' });
    }
  }
);

// GET /api/reports/hris
router.get('/hris',
  ...reportAuth,
  reportFilters,
  validate,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;

      const [demographics, docCompleteness, certExpiry, trainingStats] = await Promise.all([
        // Workforce demographics
        pool.query(`
          SELECT
            COUNT(*) AS total_employees,
            COUNT(*) FILTER (WHERE status = 'active') AS active,
            COUNT(*) FILTER (WHERE status = 'inactive') AS inactive,
            json_agg(DISTINCT department) FILTER (WHERE department IS NOT NULL) AS departments,
            json_object_agg(COALESCE(department, 'Unassigned'), dept_count) AS by_department
          FROM (
            SELECT department, status, COUNT(*) AS dept_count
            FROM users WHERE company_id = $1
            GROUP BY department, status
          ) sub
        `, [companyId]),

        // Document completeness
        pool.query(`
          SELECT
            COUNT(DISTINCT u.id) AS total_users,
            COUNT(DISTINCT CASE WHEN ud.id IS NOT NULL THEN u.id END) AS users_with_docs,
            ROUND(COUNT(DISTINCT CASE WHEN ud.id IS NOT NULL THEN u.id END)::numeric
                  / NULLIF(COUNT(DISTINCT u.id), 0) * 100, 1) AS completeness_pct
          FROM users u
          LEFT JOIN user_documents ud ON ud.user_id = u.id
          WHERE u.company_id = $1 AND u.status = 'active'
        `, [companyId]),

        // Certificate expiry
        pool.query(`
          SELECT uc.certificate_name, uc.expiry_date, u.first_name, u.last_name, u.department
          FROM user_certificates uc
          JOIN users u ON u.id = uc.user_id
          WHERE u.company_id = $1 AND uc.expiry_date <= NOW() + INTERVAL '90 days'
          ORDER BY uc.expiry_date ASC
          LIMIT 50
        `, [companyId]),

        // Training stats
        pool.query(`
          SELECT
            COUNT(DISTINCT t.id) AS total_trainings,
            COUNT(DISTINCT tc.user_id) AS users_trained,
            COUNT(DISTINCT CASE WHEN tc.status = 'completed' THEN tc.id END) AS completions,
            ROUND(COUNT(DISTINCT CASE WHEN tc.status = 'completed' THEN tc.id END)::numeric
                  / NULLIF(COUNT(tc.id), 0) * 100, 1) AS completion_rate_pct
          FROM trainings t
          LEFT JOIN training_completions tc ON tc.training_id = t.id
          WHERE t.company_id = $1
        `, [companyId])
      ]);

      res.json({
        demographics: demographics.rows[0],
        document_completeness: docCompleteness.rows[0],
        expiring_certificates: certExpiry.rows,
        training: trainingStats.rows[0]
      });
    } catch (err) {
      console.error('HRIS report error:', err);
      res.status(500).json({ error: 'Failed to generate HRIS report' });
    }
  }
);

// GET /api/reports/challenges
router.get('/challenges',
  ...reportAuth,
  reportFilters,
  validate,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;

      const [participation, completion, moduleProgress] = await Promise.all([
        pool.query(`
          SELECT c.id, c.name, c.challenge_type, c.status,
                 COUNT(DISTINCT cp.user_id) AS participants,
                 COUNT(DISTINCT ce.user_id) AS active_participants,
                 COUNT(ce.id) AS total_entries,
                 COALESCE(AVG(cp.points), 0) AS avg_points
          FROM challenges c
          LEFT JOIN challenge_participants cp ON cp.challenge_id = c.id
          LEFT JOIN challenge_entries ce ON ce.challenge_id = c.id
          WHERE c.company_id = $1
          GROUP BY c.id
          ORDER BY c.created_at DESC
        `, [companyId]),

        pool.query(`
          SELECT c.id, c.name,
                 COUNT(DISTINCT cp.user_id) AS total_participants,
                 COUNT(DISTINCT completed_users.user_id) AS fully_completed,
                 CASE WHEN COUNT(DISTINCT cp.user_id) > 0
                   THEN ROUND(COUNT(DISTINCT completed_users.user_id)::numeric
                        / COUNT(DISTINCT cp.user_id) * 100, 1)
                   ELSE 0
                 END AS completion_rate_pct
          FROM challenges c
          LEFT JOIN challenge_participants cp ON cp.challenge_id = c.id
          LEFT JOIN (
            SELECT cmc.user_id, cm.challenge_id
            FROM challenge_module_completions cmc
            JOIN challenge_modules cm ON cm.id = cmc.module_id
            WHERE cmc.completed = true
            GROUP BY cmc.user_id, cm.challenge_id
            HAVING COUNT(DISTINCT cmc.module_id) = (
              SELECT COUNT(*) FROM challenge_modules cm2 WHERE cm2.challenge_id = cm.challenge_id
            )
          ) completed_users ON completed_users.challenge_id = c.id AND completed_users.user_id = cp.user_id
          WHERE c.company_id = $1
          GROUP BY c.id
          ORDER BY c.created_at DESC
        `, [companyId]),

        pool.query(`
          SELECT cm.id, cm.activity_name, cm.module_type, c.name AS challenge_name,
                 COUNT(DISTINCT ce.user_id) AS users_engaged,
                 COALESCE(SUM(ce.value), 0) AS total_value,
                 COUNT(DISTINCT CASE WHEN cmc.completed = true THEN cmc.user_id END) AS users_completed
          FROM challenge_modules cm
          JOIN challenges c ON c.id = cm.challenge_id
          LEFT JOIN challenge_entries ce ON ce.module_id = cm.id
          LEFT JOIN challenge_module_completions cmc ON cmc.module_id = cm.id
          WHERE c.company_id = $1
          GROUP BY cm.id, c.name
          ORDER BY c.name, cm.sort_order
        `, [companyId])
      ]);

      res.json({
        participation: participation.rows,
        completion: completion.rows,
        module_progress: moduleProgress.rows
      });
    } catch (err) {
      console.error('Challenges report error:', err);
      res.status(500).json({ error: 'Failed to generate challenges report' });
    }
  }
);

// GET /api/reports/learning-sessions
router.get('/learning-sessions',
  ...reportAuth,
  reportFilters,
  validate,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;

      const [sessionStats, recordingViews] = await Promise.all([
        pool.query(`
          SELECT ls.id, ls.title, ls.category, ls.session_date, ls.facilitator_name,
                 COUNT(DISTINCT rsvp.id) FILTER (WHERE rsvp.response = 'yes') AS rsvp_yes,
                 COUNT(DISTINCT rsvp.id) FILTER (WHERE rsvp.response = 'no') AS rsvp_no,
                 COUNT(DISTINCT rsvp.id) FILTER (WHERE rsvp.response = 'maybe') AS rsvp_maybe,
                 COUNT(DISTINCT att.user_id) FILTER (WHERE att.status = 'attended') AS attended,
                 CASE WHEN COUNT(DISTINCT rsvp.id) FILTER (WHERE rsvp.response = 'yes') > 0
                   THEN ROUND(COUNT(DISTINCT att.user_id) FILTER (WHERE att.status = 'attended')::numeric
                        / COUNT(DISTINCT rsvp.id) FILTER (WHERE rsvp.response = 'yes') * 100, 1)
                   ELSE 0
                 END AS attendance_rate_pct
          FROM learning_sessions ls
          LEFT JOIN learning_session_rsvps rsvp ON rsvp.session_id = ls.id
          LEFT JOIN learning_session_attendance att ON att.session_id = ls.id
          WHERE ls.company_id = $1
          GROUP BY ls.id
          ORDER BY ls.session_date DESC
        `, [companyId]),

        pool.query(`
          SELECT r.id, r.title, r.recording_type,
                 COUNT(DISTINCT rv.user_id) AS unique_views,
                 COUNT(rv.id) AS total_views
          FROM learning_session_recordings r
          LEFT JOIN learning_recording_views rv ON rv.recording_id = r.id
          WHERE r.company_id = $1
          GROUP BY r.id
          ORDER BY unique_views DESC
        `, [companyId])
      ]);

      res.json({
        sessions: sessionStats.rows,
        recording_views: recordingViews.rows
      });
    } catch (err) {
      console.error('Learning sessions report error:', err);
      res.status(500).json({ error: 'Failed to generate learning sessions report' });
    }
  }
);

// GET /api/reports/engagement - Composite engagement score
router.get('/engagement',
  ...reportAuth,
  reportFilters,
  validate,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const { filterClause, params } = buildReportFilters(req.query, 2, [companyId]);

      // Weighted engagement formula across modules
      // Weights: smiles(15%), social_wall(10%), performance(20%), development(15%),
      //          wellbeing(15%), surveys(10%), challenges(10%), learning(5%)
      const { rows } = await pool.query(`
        WITH user_engagement AS (
          SELECT u.id,
            -- Smiles score (sent + received, capped at 100)
            LEAST(
              (SELECT COUNT(*) FROM smiles WHERE (sender_id = u.id OR receiver_id = u.id) AND company_id = $1) * 5,
              100
            ) AS smiles_score,
            -- Social wall score
            LEAST(
              (SELECT COUNT(*) FROM social_wall_posts WHERE user_id = u.id AND company_id = $1) * 10 +
              (SELECT COUNT(*) FROM social_wall_comments WHERE user_id = u.id) * 5,
              100
            ) AS social_score,
            -- Performance objectives score
            LEAST(
              (SELECT COUNT(*) FILTER (WHERE status IN ('completed', 'in_progress'))
               FROM performance_objectives WHERE user_id = u.id AND company_id = $1) * 25,
              100
            ) AS perf_score,
            -- Development objectives score
            LEAST(
              (SELECT COUNT(*) FILTER (WHERE status IN ('completed', 'in_progress'))
               FROM development_objectives WHERE user_id = u.id AND company_id = $1) * 25,
              100
            ) AS dev_score,
            -- Wellbeing score
            LEAST(
              (SELECT COUNT(*) FROM pulse_checks WHERE user_id = u.id AND company_id = $1) * 10 +
              (SELECT COUNT(*) FROM wellbeing_objectives WHERE user_id = u.id AND company_id = $1) * 20,
              100
            ) AS wellbeing_score,
            -- Survey score
            LEAST(
              (SELECT COUNT(DISTINCT survey_id) FROM survey_responses WHERE user_id = u.id) * 50,
              100
            ) AS survey_score,
            -- Challenge score
            LEAST(
              (SELECT COALESCE(SUM(points), 0) FROM challenge_participants WHERE user_id = u.id) * 2,
              100
            ) AS challenge_score,
            -- Learning score
            LEAST(
              (SELECT COUNT(*) FROM learning_session_rsvps WHERE user_id = u.id AND response = 'yes') * 20 +
              (SELECT COUNT(*) FROM learning_session_attendance WHERE user_id = u.id AND status = 'attended') * 30,
              100
            ) AS learning_score
          FROM users u
          WHERE u.company_id = $1 AND u.status = 'active' ${filterClause}
        )
        SELECT
          ROUND(AVG(
            smiles_score * 0.15 + social_score * 0.10 + perf_score * 0.20 +
            dev_score * 0.15 + wellbeing_score * 0.15 + survey_score * 0.10 +
            challenge_score * 0.10 + learning_score * 0.05
          ), 1) AS composite_score,
          ROUND(AVG(smiles_score), 1) AS avg_smiles_score,
          ROUND(AVG(social_score), 1) AS avg_social_score,
          ROUND(AVG(perf_score), 1) AS avg_perf_score,
          ROUND(AVG(dev_score), 1) AS avg_dev_score,
          ROUND(AVG(wellbeing_score), 1) AS avg_wellbeing_score,
          ROUND(AVG(survey_score), 1) AS avg_survey_score,
          ROUND(AVG(challenge_score), 1) AS avg_challenge_score,
          ROUND(AVG(learning_score), 1) AS avg_learning_score,
          COUNT(*) AS total_users
        FROM user_engagement
      `, params);

      res.json({
        engagement: rows[0],
        weights: {
          smiles: 0.15,
          social_wall: 0.10,
          performance: 0.20,
          development: 0.15,
          wellbeing: 0.15,
          surveys: 0.10,
          challenges: 0.10,
          learning: 0.05
        }
      });
    } catch (err) {
      console.error('Engagement report error:', err);
      res.status(500).json({ error: 'Failed to generate engagement report' });
    }
  }
);

// ============================================================
// CROSS-MODULE INSIGHTS
// ============================================================

router.get('/cross-module',
  ...reportAuth,
  reportFilters,
  validate,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const minGroupSize = req.query.min_group_size ? +req.query.min_group_size : MIN_GROUP_SIZE_DEFAULT;

      const [recognitionVsPerformance, wellbeingVsProductivity, engagementVsRetention] = await Promise.all([
        // Recognition vs Performance
        pool.query(`
          SELECT u.department,
                 COUNT(DISTINCT s.id) AS smiles_received,
                 ROUND(AVG(po.rating), 2) AS avg_performance_rating,
                 COUNT(DISTINCT u.id) AS group_size
          FROM users u
          LEFT JOIN smiles s ON s.receiver_id = u.id AND s.company_id = $1
          LEFT JOIN performance_objectives po ON po.user_id = u.id AND po.company_id = $1 AND po.rating IS NOT NULL
          WHERE u.company_id = $1 AND u.status = 'active' AND u.department IS NOT NULL
          GROUP BY u.department
          HAVING COUNT(DISTINCT u.id) >= $2
          ORDER BY avg_performance_rating DESC NULLS LAST
        `, [companyId, minGroupSize]),

        // Wellbeing vs Productivity (department level, anonymised)
        pool.query(`
          SELECT u.department,
                 ROUND(AVG(pc.score), 2) AS avg_pulse_score,
                 ROUND(AVG(CASE WHEN po.status = 'completed' THEN 100
                                WHEN po.status = 'in_progress' THEN 50
                                ELSE 0 END), 1) AS avg_objective_progress,
                 COUNT(DISTINCT u.id) AS group_size
          FROM users u
          LEFT JOIN pulse_checks pc ON pc.user_id = u.id AND pc.company_id = $1
          LEFT JOIN performance_objectives po ON po.user_id = u.id AND po.company_id = $1
          WHERE u.company_id = $1 AND u.status = 'active' AND u.department IS NOT NULL
          GROUP BY u.department
          HAVING COUNT(DISTINCT u.id) >= $2
          ORDER BY avg_pulse_score DESC NULLS LAST
        `, [companyId, minGroupSize]),

        // Engagement vs Retention (department level)
        pool.query(`
          SELECT u.department,
                 COUNT(DISTINCT u.id) AS total_employees,
                 COUNT(DISTINCT u.id) FILTER (WHERE u.status = 'inactive' AND u.deactivated_at >= NOW() - INTERVAL '12 months') AS departed_12m,
                 ROUND(
                   COUNT(DISTINCT u.id) FILTER (WHERE u.status = 'inactive' AND u.deactivated_at >= NOW() - INTERVAL '12 months')::numeric
                   / NULLIF(COUNT(DISTINCT u.id), 0) * 100, 1
                 ) AS turnover_rate_pct,
                 ROUND(AVG(
                   (SELECT COUNT(*) FROM smiles WHERE sender_id = u.id AND company_id = $1) +
                   (SELECT COUNT(*) FROM social_wall_posts WHERE user_id = u.id AND company_id = $1) +
                   (SELECT COUNT(*) FROM pulse_checks WHERE user_id = u.id AND company_id = $1)
                 ), 1) AS avg_activity_count
          FROM users u
          WHERE u.company_id = $1 AND u.department IS NOT NULL
          GROUP BY u.department
          HAVING COUNT(DISTINCT u.id) >= $2
          ORDER BY turnover_rate_pct ASC
        `, [companyId, minGroupSize])
      ]);

      res.json({
        recognition_vs_performance: recognitionVsPerformance.rows,
        wellbeing_vs_productivity: wellbeingVsProductivity.rows,
        engagement_vs_retention: engagementVsRetention.rows
      });
    } catch (err) {
      console.error('Cross-module report error:', err);
      res.status(500).json({ error: 'Failed to generate cross-module insights' });
    }
  }
);

// ============================================================
// SAVED REPORTS
// ============================================================

// POST /api/reports/save - Save report config
router.post('/save',
  ...reportAuth,
  [
    body('name').notEmpty().isString().trim().isLength({ max: 200 }),
    body('report_type').notEmpty().isString(),
    body('filters').isObject(),
    body('description').optional().isString().trim()
  ],
  validate,
  async (req, res) => {
    try {
      const { name, report_type, filters, description } = req.body;
      const id = uuidv4();

      const { rows } = await pool.query(`
        INSERT INTO saved_reports (id, company_id, user_id, name, description, report_type, filters, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        RETURNING *
      `, [id, req.user.company_id, req.user.id, name, description, report_type, JSON.stringify(filters)]);

      res.status(201).json({ report: rows[0] });
    } catch (err) {
      console.error('Save report error:', err);
      res.status(500).json({ error: 'Failed to save report' });
    }
  }
);

// GET /api/reports/saved - List saved reports
router.get('/saved',
  ...reportAuth,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, name, description, report_type, filters, created_at, updated_at
        FROM saved_reports
        WHERE company_id = $1 AND user_id = $2
        ORDER BY updated_at DESC
      `, [req.user.company_id, req.user.id]);

      res.json({ reports: rows });
    } catch (err) {
      console.error('List saved reports error:', err);
      res.status(500).json({ error: 'Failed to list saved reports' });
    }
  }
);

// GET /api/reports/export/:type - Export as JSON/CSV
router.get('/export/:type',
  ...reportAuth,
  [
    param('type').isIn(['json', 'csv']),
    query('report_type').notEmpty().isString(),
    query('saved_report_id').optional().isUUID()
  ],
  validate,
  async (req, res) => {
    try {
      const { type } = req.params;
      const { report_type, saved_report_id } = req.query;

      // If a saved report, load its filters
      let filters = req.query;
      if (saved_report_id) {
        const { rows } = await pool.query(
          `SELECT filters FROM saved_reports WHERE id = $1 AND company_id = $2 AND user_id = $3`,
          [saved_report_id, req.user.company_id, req.user.id]
        );
        if (rows.length) {
          filters = { ...JSON.parse(rows[0].filters), ...req.query };
        }
      }

      // Build the report data based on report_type
      // We re-use the same query logic. For brevity, fetch via internal call pattern.
      const companyId = req.user.company_id;
      let reportData;

      switch (report_type) {
        case 'smiles': {
          const { rows } = await pool.query(`
            SELECT s.id, s.category, s.message, s.created_at,
                   su.first_name AS sender_first, su.last_name AS sender_last,
                   ru.first_name AS receiver_first, ru.last_name AS receiver_last
            FROM smiles s
            JOIN users su ON su.id = s.sender_id
            JOIN users ru ON ru.id = s.receiver_id
            WHERE s.company_id = $1
            ORDER BY s.created_at DESC
            LIMIT 10000
          `, [companyId]);
          reportData = rows;
          break;
        }
        case 'performance': {
          const { rows } = await pool.query(`
            SELECT po.id, po.title, po.status, po.rating, po.approval_status,
                   po.created_at, u.first_name, u.last_name, u.department
            FROM performance_objectives po
            JOIN users u ON u.id = po.user_id
            WHERE po.company_id = $1
            ORDER BY po.created_at DESC
            LIMIT 10000
          `, [companyId]);
          reportData = rows;
          break;
        }
        case 'challenges': {
          const { rows } = await pool.query(`
            SELECT c.name AS challenge_name, cp.user_id, u.first_name, u.last_name,
                   u.department, cp.points, cp.joined_at
            FROM challenge_participants cp
            JOIN challenges c ON c.id = cp.challenge_id
            JOIN users u ON u.id = cp.user_id
            WHERE c.company_id = $1
            ORDER BY c.name, cp.points DESC
            LIMIT 10000
          `, [companyId]);
          reportData = rows;
          break;
        }
        case 'learning-sessions': {
          const { rows } = await pool.query(`
            SELECT ls.title, ls.session_date, ls.category,
                   u.first_name, u.last_name, u.department,
                   rsvp.response, att.status AS attendance
            FROM learning_session_rsvps rsvp
            JOIN learning_sessions ls ON ls.id = rsvp.session_id
            JOIN users u ON u.id = rsvp.user_id
            LEFT JOIN learning_session_attendance att ON att.session_id = ls.id AND att.user_id = u.id
            WHERE ls.company_id = $1
            ORDER BY ls.session_date DESC
            LIMIT 10000
          `, [companyId]);
          reportData = rows;
          break;
        }
        default: {
          return res.status(400).json({ error: `Unsupported report type: ${report_type}` });
        }
      }

      if (type === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${report_type}-report.json"`);
        return res.json({ data: reportData });
      }

      // CSV export
      if (!reportData.length) {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${report_type}-report.csv"`);
        return res.send('No data');
      }

      const headers = Object.keys(reportData[0]);
      const csvRows = [headers.join(',')];

      for (const row of reportData) {
        const values = headers.map(h => {
          const val = row[h];
          if (val === null || val === undefined) return '';
          const str = String(val);
          // Escape CSV values containing commas, quotes, or newlines
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        });
        csvRows.push(values.join(','));
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${report_type}-report.csv"`);
      res.send(csvRows.join('\n'));
    } catch (err) {
      console.error('Export error:', err);
      res.status(500).json({ error: 'Failed to export report' });
    }
  }
);

module.exports = router;
