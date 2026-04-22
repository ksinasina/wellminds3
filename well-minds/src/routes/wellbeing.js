const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireManager, requireAdmin, requireRole, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

// All routes require authentication
router.use(authenticate);

// ============================================================
// PULSE CHECKS
// ============================================================

// GET /api/wellbeing/checks - User's wellbeing check history
router.get('/checks',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
    validate
  ],
  async (req, res) => {
    try {
      const userId = req.user.id;
      const page = req.query.page || 1;
      const limit = req.query.limit || 20;
      const offset = (page - 1) * limit;

      const conditions = ['user_id = $1'];
      const params = [userId];
      let paramIndex = 2;

      if (req.query.start_date) {
        conditions.push(`created_at >= $${paramIndex++}`);
        params.push(req.query.start_date);
      }
      if (req.query.end_date) {
        conditions.push(`created_at <= $${paramIndex++}`);
        params.push(req.query.end_date);
      }

      const whereClause = conditions.join(' AND ');

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM wellbeing_checks WHERE ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const { rows } = await pool.query(`
        SELECT id, overall, energy, stress, connection, purpose, notes, created_at
        FROM wellbeing_checks
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `, [...params, limit, offset]);

      res.json({
        data: rows,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }
      });
    } catch (err) {
      console.error('GET /api/wellbeing/checks error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/wellbeing/checks - Submit pulse check
router.post('/checks',
  [
    body('overall').notEmpty().isInt({ min: 1, max: 10 }).withMessage('Overall score 1-10 is required'),
    body('energy').notEmpty().isInt({ min: 1, max: 10 }).withMessage('Energy score 1-10 is required'),
    body('stress').notEmpty().isInt({ min: 1, max: 10 }).withMessage('Stress score 1-10 is required'),
    body('connection').notEmpty().isInt({ min: 1, max: 10 }).withMessage('Connection score 1-10 is required'),
    body('purpose').notEmpty().isInt({ min: 1, max: 10 }).withMessage('Purpose score 1-10 is required'),
    body('notes').optional({ nullable: true }).trim(),
    validate
  ],
  async (req, res) => {
    try {
      const userId = req.user.id;
      const companyId = req.user.company_id;
      const { overall, energy, stress, connection, purpose, notes } = req.body;

      const id = uuidv4();

      const { rows } = await pool.query(`
        INSERT INTO wellbeing_checks (id, user_id, company_id, overall, energy, stress, connection, purpose, notes, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        RETURNING *
      `, [id, userId, companyId, overall, energy, stress, connection, purpose, notes || null]);

      res.status(201).json({ data: rows[0] });
    } catch (err) {
      console.error('POST /api/wellbeing/checks error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/wellbeing/stats - Aggregated anonymous wellbeing stats (manager+)
router.get('/stats',
  [
    requireRole('manager', 'admin'),
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
    validate
  ],
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const { start_date, end_date } = req.query;

      const conditions = ['wc.company_id = $1'];
      const params = [companyId];
      let paramIndex = 2;

      if (start_date) { conditions.push(`wc.created_at >= $${paramIndex++}`); params.push(start_date); }
      if (end_date) { conditions.push(`wc.created_at <= $${paramIndex++}`); params.push(end_date); }

      const whereClause = conditions.join(' AND ');

      // Aggregated averages
      const avgResult = await pool.query(`
        SELECT
          ROUND(AVG(overall), 2) AS avg_overall,
          ROUND(AVG(energy), 2) AS avg_energy,
          ROUND(AVG(stress), 2) AS avg_stress,
          ROUND(AVG(connection), 2) AS avg_connection,
          ROUND(AVG(purpose), 2) AS avg_purpose,
          COUNT(*)::int AS total_checks,
          COUNT(DISTINCT user_id)::int AS unique_users
        FROM wellbeing_checks wc
        WHERE ${whereClause}
      `, params);

      // Weekly trend (last 12 weeks)
      const trendResult = await pool.query(`
        SELECT
          DATE_TRUNC('week', wc.created_at) AS week,
          ROUND(AVG(overall), 2) AS avg_overall,
          ROUND(AVG(energy), 2) AS avg_energy,
          ROUND(AVG(stress), 2) AS avg_stress,
          ROUND(AVG(connection), 2) AS avg_connection,
          ROUND(AVG(purpose), 2) AS avg_purpose,
          COUNT(*)::int AS check_count,
          COUNT(DISTINCT user_id)::int AS unique_users
        FROM wellbeing_checks wc
        WHERE ${whereClause} AND wc.created_at >= NOW() - INTERVAL '12 weeks'
        GROUP BY DATE_TRUNC('week', wc.created_at)
        ORDER BY week DESC
      `, params);

      // Total active employees for participation rate
      const empResult = await pool.query(
        "SELECT COUNT(*)::int AS total FROM users WHERE company_id = $1 AND status = 'active'",
        [companyId]
      );

      const stats = avgResult.rows[0];

      res.json({
        data: {
          averages: {
            overall: parseFloat(stats.avg_overall) || 0,
            energy: parseFloat(stats.avg_energy) || 0,
            stress: parseFloat(stats.avg_stress) || 0,
            connection: parseFloat(stats.avg_connection) || 0,
            purpose: parseFloat(stats.avg_purpose) || 0
          },
          total_checks: stats.total_checks,
          unique_users: stats.unique_users,
          total_employees: empResult.rows[0].total,
          participation_rate: empResult.rows[0].total > 0
            ? Math.round((stats.unique_users / empResult.rows[0].total) * 100 * 10) / 10
            : 0,
          weekly_trend: trendResult.rows
        }
      });
    } catch (err) {
      console.error('GET /api/wellbeing/stats error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================
// RESOURCES (Udemy-style Topic -> Milestone -> Lesson -> Resource)
// ============================================================

// GET /api/wellbeing/resources/topics - List topics with user progress
router.get('/resources/topics',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('category').optional().trim(),
    validate
  ],
  async (req, res) => {
    try {
      const userId = req.user.id;
      const companyId = req.user.company_id;
      const page = req.query.page || 1;
      const limit = req.query.limit || 20;
      const offset = (page - 1) * limit;

      const conditions = ['t.company_id = $1', 't.is_active = true'];
      const params = [companyId];
      let paramIndex = 2;

      if (req.query.category) {
        conditions.push(`t.category = $${paramIndex++}`);
        params.push(req.query.category);
      }

      const whereClause = conditions.join(' AND ');

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM resource_topics t WHERE ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const { rows } = await pool.query(`
        SELECT
          t.id, t.title, t.description, t.category, t.thumbnail_url, t.created_at,
          COALESCE(mc.milestone_count, 0)::int AS milestone_count,
          COALESCE(rc.resource_count, 0)::int AS total_resources,
          COALESCE(uc.completed_count, 0)::int AS completed_resources,
          CASE
            WHEN COALESCE(rc.resource_count, 0) = 0 THEN 0
            ELSE ROUND((COALESCE(uc.completed_count, 0)::decimal / rc.resource_count) * 100, 1)
          END AS progress_percent
        FROM resource_topics t
        LEFT JOIN (
          SELECT topic_id, COUNT(*) AS milestone_count
          FROM resource_milestones
          GROUP BY topic_id
        ) mc ON mc.topic_id = t.id
        LEFT JOIN (
          SELECT rm.topic_id, COUNT(r.id) AS resource_count
          FROM resources r
          JOIN resource_lessons rl ON rl.id = r.lesson_id
          JOIN resource_milestones rm ON rm.id = rl.milestone_id
          GROUP BY rm.topic_id
        ) rc ON rc.topic_id = t.id
        LEFT JOIN (
          SELECT rm.topic_id, COUNT(up.id) AS completed_count
          FROM user_resource_progress up
          JOIN resources r ON r.id = up.resource_id
          JOIN resource_lessons rl ON rl.id = r.lesson_id
          JOIN resource_milestones rm ON rm.id = rl.milestone_id
          WHERE up.user_id = $${paramIndex++} AND up.status = 'completed'
          GROUP BY rm.topic_id
        ) uc ON uc.topic_id = t.id
        WHERE ${whereClause}
        ORDER BY t.sort_order ASC, t.title ASC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `, [...params, userId, limit, offset]);

      res.json({
        data: rows,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }
      });
    } catch (err) {
      console.error('GET /api/wellbeing/resources/topics error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/wellbeing/resources/my-progress - User's overall progress
router.get('/resources/my-progress', async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = req.user.company_id;

    // Total resources available
    const totalResult = await pool.query(`
      SELECT COUNT(r.id)::int AS total
      FROM resources r
      JOIN resource_lessons rl ON rl.id = r.lesson_id
      JOIN resource_milestones rm ON rm.id = rl.milestone_id
      JOIN resource_topics t ON t.id = rm.topic_id
      WHERE t.company_id = $1 AND t.is_active = true
    `, [companyId]);

    // User's progress
    const progressResult = await pool.query(`
      SELECT
        up.status,
        COUNT(*)::int AS count
      FROM user_resource_progress up
      JOIN resources r ON r.id = up.resource_id
      JOIN resource_lessons rl ON rl.id = r.lesson_id
      JOIN resource_milestones rm ON rm.id = rl.milestone_id
      JOIN resource_topics t ON t.id = rm.topic_id
      WHERE up.user_id = $1 AND t.company_id = $2 AND t.is_active = true
      GROUP BY up.status
    `, [userId, companyId]);

    const statusMap = {};
    for (const row of progressResult.rows) {
      statusMap[row.status] = row.count;
    }

    const totalResources = totalResult.rows[0].total;
    const completed = statusMap['completed'] || 0;
    const inProgress = statusMap['in_progress'] || 0;
    const notStarted = totalResources - completed - inProgress;

    // Per-topic progress
    const topicProgressResult = await pool.query(`
      SELECT
        t.id AS topic_id, t.title, t.category,
        COUNT(r.id)::int AS total_resources,
        COALESCE(SUM(CASE WHEN up.status = 'completed' THEN 1 ELSE 0 END), 0)::int AS completed,
        COALESCE(SUM(CASE WHEN up.status = 'in_progress' THEN 1 ELSE 0 END), 0)::int AS in_progress
      FROM resource_topics t
      JOIN resource_milestones rm ON rm.topic_id = t.id
      JOIN resource_lessons rl ON rl.milestone_id = rm.id
      JOIN resources r ON r.lesson_id = rl.id
      LEFT JOIN user_resource_progress up ON up.resource_id = r.id AND up.user_id = $1
      WHERE t.company_id = $2 AND t.is_active = true
      GROUP BY t.id, t.title, t.category
      ORDER BY t.sort_order ASC
    `, [userId, companyId]);

    res.json({
      data: {
        total_resources: totalResources,
        completed,
        in_progress: inProgress,
        not_started: notStarted,
        overall_progress_percent: totalResources > 0
          ? Math.round((completed / totalResources) * 100 * 10) / 10
          : 0,
        topics: topicProgressResult.rows.map(t => ({
          ...t,
          progress_percent: t.total_resources > 0
            ? Math.round((t.completed / t.total_resources) * 100 * 10) / 10
            : 0
        }))
      }
    });
  } catch (err) {
    console.error('GET /api/wellbeing/resources/my-progress error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/wellbeing/resources/stats - Anonymous engagement stats (manager+)
router.get('/resources/stats',
  [
    requireRole('manager', 'admin'),
    validate
  ],
  async (req, res) => {
    try {
      const companyId = req.user.company_id;

      // Overall engagement
      const engagementResult = await pool.query(`
        SELECT
          COUNT(DISTINCT up.user_id)::int AS engaged_users,
          COUNT(CASE WHEN up.status = 'completed' THEN 1 END)::int AS total_completions,
          COUNT(CASE WHEN up.status = 'in_progress' THEN 1 END)::int AS total_in_progress
        FROM user_resource_progress up
        JOIN resources r ON r.id = up.resource_id
        JOIN resource_lessons rl ON rl.id = r.lesson_id
        JOIN resource_milestones rm ON rm.id = rl.milestone_id
        JOIN resource_topics t ON t.id = rm.topic_id
        WHERE t.company_id = $1 AND t.is_active = true
      `, [companyId]);

      const totalEmpResult = await pool.query(
        "SELECT COUNT(*)::int AS total FROM users WHERE company_id = $1 AND status = 'active'",
        [companyId]
      );

      // Top topics by engagement
      const topTopicsResult = await pool.query(`
        SELECT
          t.id, t.title, t.category,
          COUNT(DISTINCT up.user_id)::int AS engaged_users,
          COUNT(CASE WHEN up.status = 'completed' THEN 1 END)::int AS completions
        FROM resource_topics t
        JOIN resource_milestones rm ON rm.topic_id = t.id
        JOIN resource_lessons rl ON rl.milestone_id = rm.id
        JOIN resources r ON r.lesson_id = rl.id
        LEFT JOIN user_resource_progress up ON up.resource_id = r.id
        WHERE t.company_id = $1 AND t.is_active = true
        GROUP BY t.id, t.title, t.category
        ORDER BY engaged_users DESC
      `, [companyId]);

      // Engagement by category
      const byCategoryResult = await pool.query(`
        SELECT
          t.category,
          COUNT(DISTINCT up.user_id)::int AS engaged_users,
          COUNT(CASE WHEN up.status = 'completed' THEN 1 END)::int AS completions
        FROM resource_topics t
        JOIN resource_milestones rm ON rm.topic_id = t.id
        JOIN resource_lessons rl ON rl.milestone_id = rm.id
        JOIN resources r ON r.lesson_id = rl.id
        LEFT JOIN user_resource_progress up ON up.resource_id = r.id
        WHERE t.company_id = $1 AND t.is_active = true
        GROUP BY t.category
        ORDER BY engaged_users DESC
      `, [companyId]);

      const engagement = engagementResult.rows[0];
      const totalEmployees = totalEmpResult.rows[0].total;

      res.json({
        data: {
          engaged_users: engagement.engaged_users,
          total_employees: totalEmployees,
          engagement_rate: totalEmployees > 0
            ? Math.round((engagement.engaged_users / totalEmployees) * 100 * 10) / 10
            : 0,
          total_completions: engagement.total_completions,
          total_in_progress: engagement.total_in_progress,
          top_topics: topTopicsResult.rows,
          by_category: byCategoryResult.rows
        }
      });
    } catch (err) {
      console.error('GET /api/wellbeing/resources/stats error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/wellbeing/resources/topics/:topicId - Topic detail with milestones, lessons, resources, progress
router.get('/resources/topics/:topicId',
  [
    param('topicId').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const topicId = req.params.topicId;
      const userId = req.user.id;
      const companyId = req.user.company_id;

      const topicResult = await pool.query(
        'SELECT * FROM resource_topics WHERE id = $1 AND company_id = $2 AND is_active = true',
        [topicId, companyId]
      );
      if (topicResult.rows.length === 0) {
        return res.status(404).json({ error: 'Topic not found' });
      }

      // Get milestones
      const milestonesResult = await pool.query(`
        SELECT id, title, description, sort_order
        FROM resource_milestones
        WHERE topic_id = $1
        ORDER BY sort_order ASC
      `, [topicId]);

      // Get lessons with resources and user progress
      const lessonsResult = await pool.query(`
        SELECT
          rl.id AS lesson_id, rl.title AS lesson_title, rl.description AS lesson_description,
          rl.milestone_id, rl.sort_order AS lesson_sort_order,
          r.id AS resource_id, r.title AS resource_title, r.description AS resource_description,
          r.resource_type, r.url, r.duration_minutes, r.sort_order AS resource_sort_order,
          up.status AS user_status, up.started_at, up.completed_at
        FROM resource_lessons rl
        JOIN resource_milestones rm ON rm.id = rl.milestone_id
        LEFT JOIN resources r ON r.lesson_id = rl.id
        LEFT JOIN user_resource_progress up ON up.resource_id = r.id AND up.user_id = $1
        WHERE rm.topic_id = $2
        ORDER BY rl.sort_order ASC, r.sort_order ASC
      `, [userId, topicId]);

      // Build nested structure
      const milestones = milestonesResult.rows.map(milestone => {
        const mileLessons = {};
        for (const row of lessonsResult.rows) {
          if (row.milestone_id !== milestone.id) continue;
          if (!mileLessons[row.lesson_id]) {
            mileLessons[row.lesson_id] = {
              id: row.lesson_id,
              title: row.lesson_title,
              description: row.lesson_description,
              sort_order: row.lesson_sort_order,
              resources: []
            };
          }
          if (row.resource_id) {
            mileLessons[row.lesson_id].resources.push({
              id: row.resource_id,
              title: row.resource_title,
              description: row.resource_description,
              resource_type: row.resource_type,
              url: row.url,
              duration_minutes: row.duration_minutes,
              sort_order: row.resource_sort_order,
              status: row.user_status || 'not_started',
              started_at: row.started_at,
              completed_at: row.completed_at
            });
          }
        }

        const lessons = Object.values(mileLessons).sort((a, b) => a.sort_order - b.sort_order);
        const totalResources = lessons.reduce((sum, l) => sum + l.resources.length, 0);
        const completedResources = lessons.reduce(
          (sum, l) => sum + l.resources.filter(r => r.status === 'completed').length, 0
        );

        return {
          ...milestone,
          lessons,
          total_resources: totalResources,
          completed_resources: completedResources,
          progress_percent: totalResources > 0
            ? Math.round((completedResources / totalResources) * 100 * 10) / 10
            : 0
        };
      });

      res.json({
        data: {
          ...topicResult.rows[0],
          milestones
        }
      });
    } catch (err) {
      console.error('GET /api/wellbeing/resources/topics/:topicId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/wellbeing/resources/topics/:topicId/milestones/:milestoneId - Milestone detail
router.get('/resources/topics/:topicId/milestones/:milestoneId',
  [
    param('topicId').isUUID(),
    param('milestoneId').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const { topicId, milestoneId } = req.params;
      const userId = req.user.id;
      const companyId = req.user.company_id;

      // Verify topic belongs to company
      const topicResult = await pool.query(
        'SELECT id FROM resource_topics WHERE id = $1 AND company_id = $2 AND is_active = true',
        [topicId, companyId]
      );
      if (topicResult.rows.length === 0) {
        return res.status(404).json({ error: 'Topic not found' });
      }

      const milestoneResult = await pool.query(
        'SELECT * FROM resource_milestones WHERE id = $1 AND topic_id = $2',
        [milestoneId, topicId]
      );
      if (milestoneResult.rows.length === 0) {
        return res.status(404).json({ error: 'Milestone not found' });
      }

      const lessonsResult = await pool.query(`
        SELECT
          rl.id AS lesson_id, rl.title AS lesson_title, rl.description AS lesson_description,
          rl.sort_order AS lesson_sort_order,
          r.id AS resource_id, r.title AS resource_title, r.description AS resource_description,
          r.resource_type, r.url, r.duration_minutes, r.sort_order AS resource_sort_order,
          up.status AS user_status, up.started_at, up.completed_at
        FROM resource_lessons rl
        LEFT JOIN resources r ON r.lesson_id = rl.id
        LEFT JOIN user_resource_progress up ON up.resource_id = r.id AND up.user_id = $1
        WHERE rl.milestone_id = $2
        ORDER BY rl.sort_order ASC, r.sort_order ASC
      `, [userId, milestoneId]);

      const lessonsMap = {};
      for (const row of lessonsResult.rows) {
        if (!lessonsMap[row.lesson_id]) {
          lessonsMap[row.lesson_id] = {
            id: row.lesson_id,
            title: row.lesson_title,
            description: row.lesson_description,
            sort_order: row.lesson_sort_order,
            resources: []
          };
        }
        if (row.resource_id) {
          lessonsMap[row.lesson_id].resources.push({
            id: row.resource_id,
            title: row.resource_title,
            description: row.resource_description,
            resource_type: row.resource_type,
            url: row.url,
            duration_minutes: row.duration_minutes,
            sort_order: row.resource_sort_order,
            status: row.user_status || 'not_started',
            started_at: row.started_at,
            completed_at: row.completed_at
          });
        }
      }

      const lessons = Object.values(lessonsMap).sort((a, b) => a.sort_order - b.sort_order);

      res.json({
        data: {
          ...milestoneResult.rows[0],
          lessons
        }
      });
    } catch (err) {
      console.error('GET /api/wellbeing/resources/topics/:topicId/milestones/:milestoneId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/wellbeing/resources/:resourceId/start - Mark resource as in_progress
router.post('/resources/:resourceId/start',
  [
    param('resourceId').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const resourceId = req.params.resourceId;
      const userId = req.user.id;
      const companyId = req.user.company_id;

      // Verify resource belongs to company
      const resourceResult = await pool.query(`
        SELECT r.id
        FROM resources r
        JOIN resource_lessons rl ON rl.id = r.lesson_id
        JOIN resource_milestones rm ON rm.id = rl.milestone_id
        JOIN resource_topics t ON t.id = rm.topic_id
        WHERE r.id = $1 AND t.company_id = $2 AND t.is_active = true
      `, [resourceId, companyId]);

      if (resourceResult.rows.length === 0) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      // Check existing progress
      const existing = await pool.query(
        'SELECT id, status FROM user_resource_progress WHERE resource_id = $1 AND user_id = $2',
        [resourceId, userId]
      );

      if (existing.rows.length > 0) {
        if (existing.rows[0].status === 'completed') {
          return res.status(400).json({ error: 'Resource already completed' });
        }
        return res.json({ data: { resource_id: resourceId, status: 'in_progress' } });
      }

      const id = uuidv4();
      await pool.query(`
        INSERT INTO user_resource_progress (id, user_id, resource_id, status, started_at)
        VALUES ($1, $2, $3, 'in_progress', NOW())
      `, [id, userId, resourceId]);

      res.status(201).json({ data: { resource_id: resourceId, status: 'in_progress' } });
    } catch (err) {
      console.error('POST /api/wellbeing/resources/:resourceId/start error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/wellbeing/resources/:resourceId/complete - Mark as completed
router.post('/resources/:resourceId/complete',
  [
    param('resourceId').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const resourceId = req.params.resourceId;
      const userId = req.user.id;
      const companyId = req.user.company_id;

      // Verify resource and get topic/milestone info
      const resourceResult = await pool.query(`
        SELECT r.id, rm.id AS milestone_id, rm.topic_id
        FROM resources r
        JOIN resource_lessons rl ON rl.id = r.lesson_id
        JOIN resource_milestones rm ON rm.id = rl.milestone_id
        JOIN resource_topics t ON t.id = rm.topic_id
        WHERE r.id = $1 AND t.company_id = $2 AND t.is_active = true
      `, [resourceId, companyId]);

      if (resourceResult.rows.length === 0) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const { milestone_id, topic_id } = resourceResult.rows[0];

      // Check existing progress
      const existing = await pool.query(
        'SELECT id, status FROM user_resource_progress WHERE resource_id = $1 AND user_id = $2',
        [resourceId, userId]
      );

      if (existing.rows.length > 0) {
        if (existing.rows[0].status === 'completed') {
          return res.status(400).json({ error: 'Resource already completed' });
        }
        await pool.query(`
          UPDATE user_resource_progress SET status = 'completed', completed_at = NOW()
          WHERE resource_id = $1 AND user_id = $2
        `, [resourceId, userId]);
      } else {
        const id = uuidv4();
        await pool.query(`
          INSERT INTO user_resource_progress (id, user_id, resource_id, status, started_at, completed_at)
          VALUES ($1, $2, $3, 'completed', NOW(), NOW())
        `, [id, userId, resourceId]);
      }

      // Calculate milestone progress
      const milestoneProgressResult = await pool.query(`
        SELECT
          COUNT(r.id)::int AS total,
          COUNT(CASE WHEN up.status = 'completed' THEN 1 END)::int AS completed
        FROM resources r
        JOIN resource_lessons rl ON rl.id = r.lesson_id
        WHERE rl.milestone_id = $1
        LEFT JOIN user_resource_progress up ON up.resource_id = r.id AND up.user_id = $2
      `, [milestone_id, userId]);

      // Calculate topic progress
      const topicProgressResult = await pool.query(`
        SELECT
          COUNT(r.id)::int AS total,
          COUNT(CASE WHEN up.status = 'completed' THEN 1 END)::int AS completed
        FROM resources r
        JOIN resource_lessons rl ON rl.id = r.lesson_id
        JOIN resource_milestones rm ON rm.id = rl.milestone_id
        WHERE rm.topic_id = $1
        LEFT JOIN user_resource_progress up ON up.resource_id = r.id AND up.user_id = $2
      `, [topic_id, userId]);

      const milestoneProgress = milestoneProgressResult.rows[0];
      const topicProgress = topicProgressResult.rows[0];

      res.json({
        data: {
          resource_id: resourceId,
          status: 'completed',
          milestone_progress: {
            milestone_id,
            total: milestoneProgress.total,
            completed: milestoneProgress.completed,
            progress_percent: milestoneProgress.total > 0
              ? Math.round((milestoneProgress.completed / milestoneProgress.total) * 100 * 10) / 10
              : 0
          },
          topic_progress: {
            topic_id,
            total: topicProgress.total,
            completed: topicProgress.completed,
            progress_percent: topicProgress.total > 0
              ? Math.round((topicProgress.completed / topicProgress.total) * 100 * 10) / 10
              : 0
          }
        }
      });
    } catch (err) {
      console.error('POST /api/wellbeing/resources/:resourceId/complete error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
