const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireManager, requireAdmin, requireRole, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

// All routes require authentication
router.use(authenticate);

// GET /api/posts - Company feed, pinned first, with like/comment counts
router.get('/',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    validate
  ],
  async (req, res) => {
    try {
      const page = req.query.page || 1;
      const limit = req.query.limit || 20;
      const offset = (page - 1) * limit;
      const userId = req.user.id;
      const companyId = req.user.company_id;

      const countResult = await pool.query(
        'SELECT COUNT(*) FROM posts WHERE company_id = $1 AND deleted_at IS NULL',
        [companyId]
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const { rows } = await pool.query(`
        SELECT
          p.id, p.user_id, p.text, p.image_url, p.video_url, p.media_type,
          p.is_pinned, p.created_at, p.updated_at,
          u.first_name, u.last_name, u.avatar_url, u.job_title, u.department,
          COALESCE(lc.like_count, 0)::int AS like_count,
          COALESCE(cc.comment_count, 0)::int AS comment_count,
          CASE WHEN ul.user_id IS NOT NULL THEN true ELSE false END AS liked_by_me
        FROM posts p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN (
          SELECT post_id, COUNT(*) AS like_count
          FROM post_reactions
          WHERE deleted_at IS NULL
          GROUP BY post_id
        ) lc ON lc.post_id = p.id
        LEFT JOIN (
          SELECT post_id, COUNT(*) AS comment_count
          FROM post_comments
          WHERE deleted_at IS NULL
          GROUP BY post_id
        ) cc ON cc.post_id = p.id
        LEFT JOIN post_reactions ul ON ul.post_id = p.id AND ul.user_id = $1 AND ul.deleted_at IS NULL
        WHERE p.company_id = $2 AND p.deleted_at IS NULL
        ORDER BY p.is_pinned DESC, p.created_at DESC
        LIMIT $3 OFFSET $4
      `, [userId, companyId, limit, offset]);

      res.json({
        data: rows,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit)
        }
      });
    } catch (err) {
      console.error('GET /api/posts error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/posts - Create post
router.post('/',
  [
    body('text').notEmpty().withMessage('Post text is required').trim(),
    body('image_url').optional({ nullable: true }).isURL(),
    body('video_url').optional({ nullable: true }).isURL(),
    body('media_type').optional({ nullable: true }).isIn(['image', 'video', null]),
    validate
  ],
  async (req, res) => {
    try {
      const id = uuidv4();
      const { text, image_url, video_url, media_type } = req.body;
      const userId = req.user.id;
      const companyId = req.user.company_id;

      const { rows } = await pool.query(`
        INSERT INTO posts (id, user_id, company_id, text, image_url, video_url, media_type, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        RETURNING *
      `, [id, userId, companyId, text, image_url || null, video_url || null, media_type || null]);

      res.status(201).json({ data: rows[0] });
    } catch (err) {
      console.error('POST /api/posts error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/posts/stats - Org-level engagement stats (manager+ with reporting access)
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

      let filterJoin = '';
      const conditions = ['p.company_id = $1', 'p.deleted_at IS NULL'];
      const params = [companyId];
      let paramIndex = 2;

      // Build dynamic user filters
      const userFilters = [];
      if (bu) { userFilters.push(`u.business_unit = $${paramIndex++}`); params.push(bu); }
      if (department) { userFilters.push(`u.department = $${paramIndex++}`); params.push(department); }
      if (location) { userFilters.push(`u.location = $${paramIndex++}`); params.push(location); }
      if (role) { userFilters.push(`u.role = $${paramIndex++}`); params.push(role); }
      if (gender) { userFilters.push(`u.gender = $${paramIndex++}`); params.push(gender); }
      if (job_level) { userFilters.push(`u.job_level = $${paramIndex++}`); params.push(job_level); }

      if (userFilters.length > 0) {
        filterJoin = 'JOIN users u ON u.id = p.user_id';
        conditions.push(...userFilters);
      }

      if (start_date) { conditions.push(`p.created_at >= $${paramIndex++}`); params.push(start_date); }
      if (end_date) { conditions.push(`p.created_at <= $${paramIndex++}`); params.push(end_date); }

      const whereClause = conditions.join(' AND ');

      // Total employees in company (with filters)
      let empParams = [companyId];
      let empConditions = ['company_id = $1', 'status = \'active\''];
      let empIdx = 2;
      if (bu) { empConditions.push(`business_unit = $${empIdx++}`); empParams.push(bu); }
      if (department) { empConditions.push(`department = $${empIdx++}`); empParams.push(department); }
      if (location) { empConditions.push(`location = $${empIdx++}`); empParams.push(location); }
      if (role) { empConditions.push(`role = $${empIdx++}`); empParams.push(role); }
      if (gender) { empConditions.push(`gender = $${empIdx++}`); empParams.push(gender); }
      if (job_level) { empConditions.push(`job_level = $${empIdx++}`); empParams.push(job_level); }

      const totalEmpResult = await pool.query(
        `SELECT COUNT(*) FROM users WHERE ${empConditions.join(' AND ')}`,
        empParams
      );
      const totalEmployees = parseInt(totalEmpResult.rows[0].count, 10);

      // Post count
      const postCountResult = await pool.query(
        `SELECT COUNT(*) FROM posts p ${filterJoin} WHERE ${whereClause}`,
        params
      );
      const totalPosts = parseInt(postCountResult.rows[0].count, 10);

      // Unique posters (participation rate)
      const uniquePostersResult = await pool.query(
        `SELECT COUNT(DISTINCT p.user_id) FROM posts p ${filterJoin} WHERE ${whereClause}`,
        params
      );
      const uniquePosters = parseInt(uniquePostersResult.rows[0].count, 10);

      // Reactions count
      const reactionsResult = await pool.query(
        `SELECT COUNT(*) FROM post_reactions pr
         JOIN posts p ON p.id = pr.post_id
         ${filterJoin ? filterJoin.replace('p.user_id', 'pr.user_id') : ''}
         WHERE ${whereClause} AND pr.deleted_at IS NULL`,
        params
      );
      const totalReactions = parseInt(reactionsResult.rows[0].count, 10);

      // Comments count
      const commentsResult = await pool.query(
        `SELECT COUNT(*) FROM post_comments pc
         JOIN posts p ON p.id = pc.post_id
         ${filterJoin ? filterJoin.replace('p.user_id', 'pc.user_id') : ''}
         WHERE ${whereClause} AND pc.deleted_at IS NULL`,
        params
      );
      const totalComments = parseInt(commentsResult.rows[0].count, 10);

      // Weekly activity trend (last 12 weeks)
      const trendResult = await pool.query(`
        SELECT
          DATE_TRUNC('week', p.created_at) AS week,
          COUNT(*) AS post_count,
          COUNT(DISTINCT p.user_id) AS unique_posters
        FROM posts p
        ${filterJoin}
        WHERE ${whereClause} AND p.created_at >= NOW() - INTERVAL '12 weeks'
        GROUP BY DATE_TRUNC('week', p.created_at)
        ORDER BY week DESC
      `, params);

      res.json({
        data: {
          total_posts: totalPosts,
          total_reactions: totalReactions,
          total_comments: totalComments,
          unique_posters: uniquePosters,
          total_employees: totalEmployees,
          participation_rate: totalEmployees > 0 ? Math.round((uniquePosters / totalEmployees) * 100 * 10) / 10 : 0,
          weekly_trend: trendResult.rows
        }
      });
    } catch (err) {
      console.error('GET /api/posts/stats error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/posts/:id/react - Toggle reaction (like)
router.post('/:id/react',
  [
    param('id').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const postId = req.params.id;
      const userId = req.user.id;
      const companyId = req.user.company_id;

      // Verify post exists and belongs to company
      const postResult = await pool.query(
        'SELECT id, user_id FROM posts WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [postId, companyId]
      );
      if (postResult.rows.length === 0) {
        return res.status(404).json({ error: 'Post not found' });
      }

      // Check if already liked
      const existing = await pool.query(
        'SELECT id FROM post_reactions WHERE post_id = $1 AND user_id = $2 AND deleted_at IS NULL',
        [postId, userId]
      );

      if (existing.rows.length > 0) {
        // Remove reaction
        await pool.query(
          'UPDATE post_reactions SET deleted_at = NOW() WHERE post_id = $1 AND user_id = $2 AND deleted_at IS NULL',
          [postId, userId]
        );
        return res.json({ data: { liked: false } });
      }

      // Add reaction
      const id = uuidv4();
      await pool.query(
        'INSERT INTO post_reactions (id, post_id, user_id, reaction_type, created_at) VALUES ($1, $2, $3, $4, NOW())',
        [id, postId, userId, 'like']
      );

      res.json({ data: { liked: true } });
    } catch (err) {
      console.error('POST /api/posts/:id/react error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/posts/:id/comments - List comments for a post
router.get('/:id/comments',
  [
    param('id').isUUID(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    validate
  ],
  async (req, res) => {
    try {
      const postId = req.params.id;
      const companyId = req.user.company_id;
      const page = req.query.page || 1;
      const limit = req.query.limit || 20;
      const offset = (page - 1) * limit;

      // Verify post belongs to company
      const postResult = await pool.query(
        'SELECT id FROM posts WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [postId, companyId]
      );
      if (postResult.rows.length === 0) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const countResult = await pool.query(
        'SELECT COUNT(*) FROM post_comments WHERE post_id = $1 AND deleted_at IS NULL',
        [postId]
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const { rows } = await pool.query(`
        SELECT
          c.id, c.post_id, c.user_id, c.text, c.created_at,
          u.first_name, u.last_name, u.avatar_url, u.job_title
        FROM post_comments c
        JOIN users u ON u.id = c.user_id
        WHERE c.post_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.created_at ASC
        LIMIT $2 OFFSET $3
      `, [postId, limit, offset]);

      res.json({
        data: rows,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }
      });
    } catch (err) {
      console.error('GET /api/posts/:id/comments error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/posts/:id/comments - Add comment
router.post('/:id/comments',
  [
    param('id').isUUID(),
    body('text').notEmpty().withMessage('Comment text is required').trim(),
    validate
  ],
  async (req, res) => {
    try {
      const postId = req.params.id;
      const userId = req.user.id;
      const companyId = req.user.company_id;
      const { text } = req.body;

      // Verify post
      const postResult = await pool.query(
        'SELECT id, user_id FROM posts WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [postId, companyId]
      );
      if (postResult.rows.length === 0) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const commentId = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO post_comments (id, post_id, user_id, text, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        RETURNING *
      `, [commentId, postId, userId, text]);

      // Create notification for post owner (if not commenting on own post)
      const postOwnerId = postResult.rows[0].user_id;
      if (postOwnerId !== userId) {
        const notifId = uuidv4();
        await pool.query(`
          INSERT INTO notifications (id, user_id, type, title, message, reference_id, reference_type, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        `, [notifId, postOwnerId, 'post_comment', 'New comment on your post',
            `${req.user.first_name} ${req.user.last_name} commented on your post`, postId, 'post']);
      }

      res.status(201).json({ data: rows[0] });
    } catch (err) {
      console.error('POST /api/posts/:id/comments error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/posts/:id - Delete own post or admin/manager moderation
router.delete('/:id',
  [
    param('id').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const postId = req.params.id;
      const userId = req.user.id;
      const companyId = req.user.company_id;
      const userRole = req.user.role;

      const postResult = await pool.query(
        'SELECT id, user_id FROM posts WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [postId, companyId]
      );
      if (postResult.rows.length === 0) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const post = postResult.rows[0];
      if (post.user_id !== userId && userRole !== 'admin' && userRole !== 'manager') {
        return res.status(403).json({ error: 'Not authorized to delete this post' });
      }

      await pool.query(
        'UPDATE posts SET deleted_at = NOW() WHERE id = $1',
        [postId]
      );

      res.json({ message: 'Post deleted successfully' });
    } catch (err) {
      console.error('DELETE /api/posts/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/posts/comments/:commentId - Delete own comment or admin moderation
router.delete('/comments/:commentId',
  [
    param('commentId').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const commentId = req.params.commentId;
      const userId = req.user.id;
      const companyId = req.user.company_id;
      const userRole = req.user.role;

      const commentResult = await pool.query(`
        SELECT c.id, c.user_id
        FROM post_comments c
        JOIN posts p ON p.id = c.post_id
        WHERE c.id = $1 AND p.company_id = $2 AND c.deleted_at IS NULL
      `, [commentId, companyId]);

      if (commentResult.rows.length === 0) {
        return res.status(404).json({ error: 'Comment not found' });
      }

      const comment = commentResult.rows[0];
      if (comment.user_id !== userId && userRole !== 'admin') {
        return res.status(403).json({ error: 'Not authorized to delete this comment' });
      }

      await pool.query(
        'UPDATE post_comments SET deleted_at = NOW() WHERE id = $1',
        [commentId]
      );

      res.json({ message: 'Comment deleted successfully' });
    } catch (err) {
      console.error('DELETE /api/posts/comments/:commentId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
