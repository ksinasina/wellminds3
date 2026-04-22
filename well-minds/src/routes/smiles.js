const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireManager, requireAdmin, requireRole, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { sendEmail } = require('../utils/email');
const { v4: uuidv4 } = require('uuid');

// All routes require authentication
router.use(authenticate);

// GET /api/smiles/categories - List active smile categories for company
router.get('/categories', async (req, res) => {
  try {
    const companyId = req.user.company_id;

    const { rows } = await pool.query(`
      SELECT id, name, description, icon, color, sort_order
      FROM smile_categories
      WHERE company_id = $1 AND is_active = true
      ORDER BY sort_order ASC, name ASC
    `, [companyId]);

    res.json({ data: rows });
  } catch (err) {
    console.error('GET /api/smiles/categories error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/smiles/feed - Public smiles feed
router.get('/feed',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('category_id').optional().isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const page = req.query.page || 1;
      const limit = req.query.limit || 20;
      const offset = (page - 1) * limit;
      const categoryId = req.query.category_id;

      const conditions = ['s.company_id = $1', "s.visibility = 'public'"];
      const params = [companyId];
      let paramIndex = 2;

      if (categoryId) {
        conditions.push(`s.category_id = $${paramIndex++}`);
        params.push(categoryId);
      }

      const whereClause = conditions.join(' AND ');

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM smiles s WHERE ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const { rows } = await pool.query(`
        SELECT
          s.id, s.message, s.visibility, s.created_at,
          s.sender_id, su.first_name AS sender_first_name, su.last_name AS sender_last_name,
          su.avatar_url AS sender_avatar_url, su.job_title AS sender_job_title, su.department AS sender_department,
          s.recipient_id, ru.first_name AS recipient_first_name, ru.last_name AS recipient_last_name,
          ru.avatar_url AS recipient_avatar_url, ru.job_title AS recipient_job_title, ru.department AS recipient_department,
          sc.id AS category_id, sc.name AS category_name, sc.icon AS category_icon, sc.color AS category_color
        FROM smiles s
        JOIN users su ON su.id = s.sender_id
        JOIN users ru ON ru.id = s.recipient_id
        JOIN smile_categories sc ON sc.id = s.category_id
        WHERE ${whereClause}
        ORDER BY s.created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `, [...params, limit, offset]);

      res.json({
        data: rows,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }
      });
    } catch (err) {
      console.error('GET /api/smiles/feed error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/smiles/leaderboard - Top recipients by period
router.get('/leaderboard',
  [
    query('period').optional().isIn(['week', 'month', 'quarter', 'year', 'all']),
    query('category_id').optional().isUUID(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    validate
  ],
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const period = req.query.period || 'month';
      const categoryId = req.query.category_id;
      const limit = req.query.limit || 10;

      const conditions = ['s.company_id = $1'];
      const params = [companyId];
      let paramIndex = 2;

      if (period !== 'all') {
        const intervalMap = { week: '1 week', month: '1 month', quarter: '3 months', year: '1 year' };
        conditions.push(`s.created_at >= NOW() - INTERVAL '${intervalMap[period]}'`);
      }

      if (categoryId) {
        conditions.push(`s.category_id = $${paramIndex++}`);
        params.push(categoryId);
      }

      const whereClause = conditions.join(' AND ');

      const { rows } = await pool.query(`
        SELECT
          s.recipient_id,
          u.first_name, u.last_name, u.avatar_url, u.job_title, u.department,
          COUNT(*)::int AS smile_count
        FROM smiles s
        JOIN users u ON u.id = s.recipient_id
        WHERE ${whereClause}
        GROUP BY s.recipient_id, u.first_name, u.last_name, u.avatar_url, u.job_title, u.department
        ORDER BY smile_count DESC
        LIMIT $${paramIndex}
      `, [...params, limit]);

      res.json({ data: rows });
    } catch (err) {
      console.error('GET /api/smiles/leaderboard error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/smiles/stats - Culture analytics (manager+ with reporting access)
router.get('/stats',
  [
    requireRole('manager', 'admin'),
    query('bu').optional().trim(),
    query('department').optional().trim(),
    query('location').optional().trim(),
    query('role').optional().trim(),
    query('gender').optional().trim(),
    query('job_level').optional().trim(),
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
    validate
  ],
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const { bu, department, location, role, gender, job_level, start_date, end_date } = req.query;

      const conditions = ['s.company_id = $1'];
      const params = [companyId];
      let paramIndex = 2;

      // User filters (applied to recipient)
      let recipientJoin = 'JOIN users ru ON ru.id = s.recipient_id';
      if (bu) { conditions.push(`ru.business_unit = $${paramIndex++}`); params.push(bu); }
      if (department) { conditions.push(`ru.department = $${paramIndex++}`); params.push(department); }
      if (location) { conditions.push(`ru.location = $${paramIndex++}`); params.push(location); }
      if (role) { conditions.push(`ru.role = $${paramIndex++}`); params.push(role); }
      if (gender) { conditions.push(`ru.gender = $${paramIndex++}`); params.push(gender); }
      if (job_level) { conditions.push(`ru.job_level = $${paramIndex++}`); params.push(job_level); }
      if (start_date) { conditions.push(`s.created_at >= $${paramIndex++}`); params.push(start_date); }
      if (end_date) { conditions.push(`s.created_at <= $${paramIndex++}`); params.push(end_date); }

      const whereClause = conditions.join(' AND ');

      // Category counts
      const categoryResult = await pool.query(`
        SELECT sc.id, sc.name, sc.icon, sc.color, COUNT(*)::int AS count
        FROM smiles s
        ${recipientJoin}
        JOIN smile_categories sc ON sc.id = s.category_id
        WHERE ${whereClause}
        GROUP BY sc.id, sc.name, sc.icon, sc.color
        ORDER BY count DESC
      `, params);

      // Top recipients
      const topRecipientsResult = await pool.query(`
        SELECT
          s.recipient_id, ru.first_name, ru.last_name, ru.department,
          COUNT(*)::int AS smile_count
        FROM smiles s
        ${recipientJoin}
        WHERE ${whereClause}
        GROUP BY s.recipient_id, ru.first_name, ru.last_name, ru.department
        ORDER BY smile_count DESC
        LIMIT 10
      `, params);

      // Least recognized (employees with 0 or fewest smiles)
      const leastRecognizedResult = await pool.query(`
        SELECT
          u.id, u.first_name, u.last_name, u.department,
          COALESCE(sc.smile_count, 0)::int AS smile_count
        FROM users u
        LEFT JOIN (
          SELECT s.recipient_id, COUNT(*) AS smile_count
          FROM smiles s
          ${recipientJoin}
          WHERE ${whereClause}
          GROUP BY s.recipient_id
        ) sc ON sc.recipient_id = u.id
        WHERE u.company_id = $1 AND u.status = 'active'
        ORDER BY smile_count ASC
        LIMIT 10
      `, params);

      // Top senders
      const topSendersResult = await pool.query(`
        SELECT
          s.sender_id, su.first_name, su.last_name, su.department,
          COUNT(*)::int AS smile_count
        FROM smiles s
        ${recipientJoin}
        JOIN users su ON su.id = s.sender_id
        WHERE ${whereClause}
        GROUP BY s.sender_id, su.first_name, su.last_name, su.department
        ORDER BY smile_count DESC
        LIMIT 10
      `, params);

      // Monthly trend (last 12 months)
      const trendResult = await pool.query(`
        SELECT
          DATE_TRUNC('month', s.created_at) AS month,
          COUNT(*)::int AS smile_count,
          COUNT(DISTINCT s.sender_id)::int AS unique_senders,
          COUNT(DISTINCT s.recipient_id)::int AS unique_recipients
        FROM smiles s
        ${recipientJoin}
        WHERE ${whereClause} AND s.created_at >= NOW() - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', s.created_at)
        ORDER BY month DESC
      `, params);

      // Total count
      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM smiles s ${recipientJoin} WHERE ${whereClause}`,
        params
      );

      res.json({
        data: {
          total_smiles: totalResult.rows[0].total,
          category_breakdown: categoryResult.rows,
          top_recipients: topRecipientsResult.rows,
          least_recognized: leastRecognizedResult.rows,
          top_senders: topSendersResult.rows,
          monthly_trend: trendResult.rows
        }
      });
    } catch (err) {
      console.error('GET /api/smiles/stats error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/smiles/my-stats - Individual stats
router.get('/my-stats', async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = req.user.company_id;

    // Received count
    const receivedResult = await pool.query(
      'SELECT COUNT(*)::int AS count FROM smiles WHERE recipient_id = $1 AND company_id = $2',
      [userId, companyId]
    );

    // Sent count
    const sentResult = await pool.query(
      'SELECT COUNT(*)::int AS count FROM smiles WHERE sender_id = $1 AND company_id = $2',
      [userId, companyId]
    );

    // Received by category
    const receivedByCategoryResult = await pool.query(`
      SELECT sc.id, sc.name, sc.icon, sc.color, COUNT(*)::int AS count
      FROM smiles s
      JOIN smile_categories sc ON sc.id = s.category_id
      WHERE s.recipient_id = $1 AND s.company_id = $2
      GROUP BY sc.id, sc.name, sc.icon, sc.color
      ORDER BY count DESC
    `, [userId, companyId]);

    // Sent by category
    const sentByCategoryResult = await pool.query(`
      SELECT sc.id, sc.name, sc.icon, sc.color, COUNT(*)::int AS count
      FROM smiles s
      JOIN smile_categories sc ON sc.id = s.category_id
      WHERE s.sender_id = $1 AND s.company_id = $2
      GROUP BY sc.id, sc.name, sc.icon, sc.color
      ORDER BY count DESC
    `, [userId, companyId]);

    res.json({
      data: {
        received_count: receivedResult.rows[0].count,
        sent_count: sentResult.rows[0].count,
        received_by_category: receivedByCategoryResult.rows,
        sent_by_category: sentByCategoryResult.rows
      }
    });
  } catch (err) {
    console.error('GET /api/smiles/my-stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/smiles/sent - User's sent smiles
router.get('/sent',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    validate
  ],
  async (req, res) => {
    try {
      const userId = req.user.id;
      const companyId = req.user.company_id;
      const page = req.query.page || 1;
      const limit = req.query.limit || 20;
      const offset = (page - 1) * limit;

      const countResult = await pool.query(
        'SELECT COUNT(*) FROM smiles WHERE sender_id = $1 AND company_id = $2',
        [userId, companyId]
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const { rows } = await pool.query(`
        SELECT
          s.id, s.message, s.visibility, s.created_at,
          s.recipient_id, ru.first_name AS recipient_first_name, ru.last_name AS recipient_last_name,
          ru.avatar_url AS recipient_avatar_url, ru.job_title AS recipient_job_title, ru.department AS recipient_department,
          sc.id AS category_id, sc.name AS category_name, sc.icon AS category_icon, sc.color AS category_color
        FROM smiles s
        JOIN users ru ON ru.id = s.recipient_id
        JOIN smile_categories sc ON sc.id = s.category_id
        WHERE s.sender_id = $1 AND s.company_id = $2
        ORDER BY s.created_at DESC
        LIMIT $3 OFFSET $4
      `, [userId, companyId, limit, offset]);

      res.json({
        data: rows,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }
      });
    } catch (err) {
      console.error('GET /api/smiles/sent error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/smiles - User's received smiles
router.get('/',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    validate
  ],
  async (req, res) => {
    try {
      const userId = req.user.id;
      const companyId = req.user.company_id;
      const page = req.query.page || 1;
      const limit = req.query.limit || 20;
      const offset = (page - 1) * limit;

      const countResult = await pool.query(
        'SELECT COUNT(*) FROM smiles WHERE recipient_id = $1 AND company_id = $2',
        [userId, companyId]
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const { rows } = await pool.query(`
        SELECT
          s.id, s.message, s.visibility, s.created_at,
          s.sender_id, su.first_name AS sender_first_name, su.last_name AS sender_last_name,
          su.avatar_url AS sender_avatar_url, su.job_title AS sender_job_title, su.department AS sender_department,
          sc.id AS category_id, sc.name AS category_name, sc.icon AS category_icon, sc.color AS category_color
        FROM smiles s
        JOIN users su ON su.id = s.sender_id
        JOIN smile_categories sc ON sc.id = s.category_id
        WHERE s.recipient_id = $1 AND s.company_id = $2
        ORDER BY s.created_at DESC
        LIMIT $3 OFFSET $4
      `, [userId, companyId, limit, offset]);

      res.json({
        data: rows,
        total,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }
      });
    } catch (err) {
      console.error('GET /api/smiles error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/smiles - Send a smile
router.post('/',
  [
    body('recipient_id').notEmpty().isUUID().withMessage('Recipient is required'),
    body('category_id').notEmpty().isUUID().withMessage('Category is required'),
    body('message').optional({ nullable: true }).trim(),
    body('visibility').optional().isIn(['public', 'private']),
    validate
  ],
  async (req, res) => {
    try {
      const senderId = req.user.id;
      const companyId = req.user.company_id;
      const { recipient_id, category_id, message, visibility } = req.body;

      // Cannot smile yourself
      if (recipient_id === senderId) {
        return res.status(400).json({ error: 'You cannot send a smile to yourself' });
      }

      // Verify recipient belongs to same company
      const recipientResult = await pool.query(
        'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND company_id = $2 AND status = $3',
        [recipient_id, companyId, 'active']
      );
      if (recipientResult.rows.length === 0) {
        return res.status(404).json({ error: 'Recipient not found' });
      }

      // Verify category
      const categoryResult = await pool.query(
        'SELECT id, name FROM smile_categories WHERE id = $1 AND company_id = $2 AND is_active = true',
        [category_id, companyId]
      );
      if (categoryResult.rows.length === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }

      const id = uuidv4();
      const vis = visibility || 'public';

      const { rows } = await pool.query(`
        INSERT INTO smiles (id, sender_id, recipient_id, company_id, category_id, message, visibility, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING *
      `, [id, senderId, recipient_id, companyId, category_id, message || null, vis]);

      // Create notification
      const notifId = uuidv4();
      const categoryName = categoryResult.rows[0].name;
      await pool.query(`
        INSERT INTO notifications (id, user_id, type, title, message, reference_id, reference_type, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `, [
        notifId, recipient_id, 'smile_received',
        'You received a smile!',
        `${req.user.first_name} ${req.user.last_name} sent you a ${categoryName} smile`,
        id, 'smile'
      ]);

      // Send email notification
      const recipient = recipientResult.rows[0];
      try {
        await sendEmail({
          to: recipient.email,
          subject: 'You received a smile!',
          html: `<p>Hi ${recipient.first_name},</p>
                 <p>${req.user.first_name} ${req.user.last_name} sent you a <strong>${categoryName}</strong> smile!</p>
                 ${message ? `<p>"${message}"</p>` : ''}
                 <p>Log in to see your recognition.</p>`
        });
      } catch (emailErr) {
        console.error('Failed to send smile email:', emailErr);
        // Non-blocking - smile is still created
      }

      res.status(201).json({ data: rows[0] });
    } catch (err) {
      console.error('POST /api/smiles error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
