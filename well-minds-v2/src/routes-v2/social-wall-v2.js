'use strict';

/**
 * Social Wall v2
 * --------------------------------------------------------------------------
 * Spec A5. Adds audience targeting (all / team / department / custom), media
 * type + URL, compliance acknowledgement, nested comments.
 *
 * Write routes go through v2; read route honours audience filters.
 */

const express = require('express');
const router = express.Router();
const pool = require('../../../well-minds/src/db');
const { authenticate } = require('../../../well-minds/src/middleware');
const requirePermission = require('../middleware/requirePermission');

const AUDIENCE_TYPES = ['all', 'team', 'department', 'custom'];

// --------------------------------------------------------------------------
// GET /api/v2/social-wall/feed — posts visible to the current user
// --------------------------------------------------------------------------
router.get('/feed', authenticate, async (req, res, next) => {
  try {
    // Determine the user's team + department for filtering
    const meRes = await pool.query(
      `SELECT manager_id, department_id FROM users WHERE id = $1`,
      [req.user.id],
    );
    const me = meRes.rows[0] || {};

    const sql = `
      SELECT p.*,
             u.first_name, u.last_name, u.profile_image_url,
             (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comment_count,
             (SELECT COUNT(*) FROM post_likes    l WHERE l.post_id = p.id) AS like_count
        FROM posts p
        JOIN users u ON u.id = p.user_id
       WHERE p.company_id = $1
         AND (
              p.audience_type = 'all'
           OR (p.audience_type = 'team'
               AND (p.user_id = $2 OR u.manager_id = $3 OR u.id = $3))
           OR (p.audience_type = 'department'
               AND u.department_id = $4)
           OR (p.audience_type = 'custom'
               AND (p.audience_value ->> 'user_ids') IS NOT NULL
               AND (p.audience_value -> 'user_ids') ? $2)
         )
         AND p.is_deleted = FALSE
       ORDER BY p.created_at DESC
       LIMIT 100
    `;
    const { rows } = await pool.query(sql, [
      req.user.company_id,
      req.user.id,
      me.manager_id,
      me.department_id,
    ]);
    res.json(rows);
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// POST /api/v2/social-wall/posts — create
// Body: { title?, content, audience_type, audience_value?, media_type?, media_url?,
//         compliance_required? }
// --------------------------------------------------------------------------
router.post('/posts',
  authenticate,
  requirePermission('social_wall', 'add'),
  async (req, res, next) => {
    const { title, content, audience_type, audience_value, media_type,
      media_url, compliance_required, parent_post_id } = req.body;

    if (audience_type && !AUDIENCE_TYPES.includes(audience_type)) {
      return res.status(400).json({ error: 'Invalid audience_type' });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO posts
           (user_id, company_id, title, content, audience_type, audience_value,
            media_type, media_url, compliance_required, parent_post_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         RETURNING *`,
        [
          req.user.id, req.user.company_id, title || null, content,
          audience_type || 'all', audience_value || null,
          media_type || null, media_url || null,
          !!compliance_required, parent_post_id || null,
        ],
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  },
);

// --------------------------------------------------------------------------
// POST /api/v2/social-wall/posts/:id/acknowledge — for compliance posts
// --------------------------------------------------------------------------
router.post('/posts/:id/acknowledge', authenticate, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE posts
          SET compliance_acknowledged = COALESCE(compliance_acknowledged, '[]'::jsonb)
              || to_jsonb(json_build_object(
                   'user_id', $1::text,
                   'at', NOW()
                 ))
        WHERE id = $2`,
      [req.user.id, req.params.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// POST /api/v2/social-wall/posts/:id/comments — nested supported
// Body: { content, parent_comment_id? }
// --------------------------------------------------------------------------
router.post('/posts/:id/comments', authenticate, async (req, res, next) => {
  try {
    const { content, parent_comment_id } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO post_comments (post_id, user_id, content, parent_comment_id, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [req.params.id, req.user.id, content, parent_comment_id || null],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// GET /api/v2/social-wall/posts/:id/comments
// --------------------------------------------------------------------------
router.get('/posts/:id/comments', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, u.first_name, u.last_name, u.profile_image_url
         FROM post_comments c
         JOIN users u ON u.id = c.user_id
        WHERE c.post_id = $1
        ORDER BY c.created_at`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
