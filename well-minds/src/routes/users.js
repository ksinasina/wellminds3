'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { body, query: queryValidator, param } = require('express-validator');
const pool = require('../db');
const { authenticate, requireAdmin, requireManager, validate } = require('../middleware');
const { sendCompanyEmail } = require('../utils/email');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// ---------------------------------------------------------------------------
// GET /  -  Paginated user list with filters (manager+)
// ---------------------------------------------------------------------------
router.get(
  '/',
  requireManager,
  [
    queryValidator('page').optional().isInt({ min: 1 }).toInt(),
    queryValidator('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    queryValidator('search').optional().trim(),
    queryValidator('department').optional().trim(),
    queryValidator('business_unit').optional().trim(),
    queryValidator('role').optional().isIn(['admin', 'manager', 'staff']),
    queryValidator('status').optional().isIn(['active', 'invited', 'suspended']),
    queryValidator('job_level').optional().trim(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const page = req.query.page || 1;
      const limit = req.query.limit || 20;
      const offset = (page - 1) * limit;

      const conditions = ['u.company_id = $1'];
      const params = [req.user.company_id];
      let paramIdx = 2;

      if (req.query.search) {
        conditions.push(
          `(u.first_name ILIKE $${paramIdx} OR u.last_name ILIKE $${paramIdx} OR u.email ILIKE $${paramIdx})`,
        );
        params.push(`%${req.query.search}%`);
        paramIdx++;
      }

      if (req.query.department) {
        conditions.push(`u.department = $${paramIdx}`);
        params.push(req.query.department);
        paramIdx++;
      }

      if (req.query.business_unit) {
        conditions.push(`u.business_unit = $${paramIdx}`);
        params.push(req.query.business_unit);
        paramIdx++;
      }

      if (req.query.role) {
        conditions.push(`u.role = $${paramIdx}`);
        params.push(req.query.role);
        paramIdx++;
      }

      if (req.query.status) {
        conditions.push(`u.status = $${paramIdx}`);
        params.push(req.query.status);
        paramIdx++;
      }

      if (req.query.job_level) {
        conditions.push(`u.job_level = $${paramIdx}`);
        params.push(req.query.job_level);
        paramIdx++;
      }

      const whereClause = conditions.join(' AND ');

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM users u WHERE ${whereClause}`,
        params,
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const dataResult = await pool.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.department,
                u.business_unit, u.job_title, u.job_level, u.status,
                u.avatar_url, u.last_login_at, u.created_at
         FROM users u
         WHERE ${whereClause}
         ORDER BY u.created_at DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset],
      );

      res.json({
        users: dataResult.rows,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /new-joiners  -  List new joiners (last 30 days)
// ---------------------------------------------------------------------------
router.get('/new-joiners', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, department, job_title, avatar_url, created_at
       FROM users
       WHERE company_id = $1
         AND status = 'active'
         AND created_at >= NOW() - INTERVAL '30 days'
       ORDER BY created_at DESC`,
      [req.user.company_id],
    );

    res.json({ new_joiners: result.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /directory  -  Company directory (basic info for all active users)
// ---------------------------------------------------------------------------
router.get('/directory', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, department, business_unit,
              job_title, avatar_url, email
       FROM users
       WHERE company_id = $1 AND status = 'active'
       ORDER BY first_name, last_name`,
      [req.user.company_id],
    );

    res.json({ directory: result.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:id  -  View profile
// ---------------------------------------------------------------------------
router.get(
  '/:id',
  [param('id').isUUID().withMessage('Valid user ID is required'), validate],
  async (req, res, next) => {
    try {
      // Staff can only view their own profile
      if (req.user.role === 'staff' && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'You can only view your own profile' });
      }

      const result = await pool.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.department,
                u.business_unit, u.job_title, u.job_level, u.phone,
                u.avatar_url, u.status, u.last_login_at, u.created_at,
                u.date_of_birth, u.gender, u.hire_date
         FROM users u
         WHERE u.id = $1 AND u.company_id = $2`,
        [req.params.id, req.user.company_id],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ user: result.rows[0] });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /:id  -  Update profile
// ---------------------------------------------------------------------------
router.patch(
  '/:id',
  [
    param('id').isUUID().withMessage('Valid user ID is required'),
    body('first_name').optional().trim().notEmpty(),
    body('last_name').optional().trim().notEmpty(),
    body('phone').optional().trim(),
    body('department').optional().trim(),
    body('business_unit').optional().trim(),
    body('job_title').optional().trim(),
    body('job_level').optional().trim(),
    body('avatar_url').optional().trim(),
    body('date_of_birth').optional().isISO8601(),
    body('gender').optional().trim(),
    body('hire_date').optional().isISO8601(),
    validate,
  ],
  async (req, res, next) => {
    try {
      // Staff can only edit own profile; admin can edit anyone in company
      if (req.user.role === 'staff' && req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'You can only edit your own profile' });
      }

      // Verify user belongs to same company
      const existing = await pool.query(
        'SELECT id FROM users WHERE id = $1 AND company_id = $2',
        [req.params.id, req.user.company_id],
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const allowedFields = [
        'first_name', 'last_name', 'phone', 'department', 'business_unit',
        'job_title', 'job_level', 'avatar_url', 'date_of_birth', 'gender', 'hire_date',
      ];

      const updates = [];
      const values = [];
      let idx = 1;

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = $${idx}`);
          values.push(req.body[field]);
          idx++;
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      updates.push(`updated_at = NOW()`);
      values.push(req.params.id);

      const result = await pool.query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}
         RETURNING id, email, first_name, last_name, role, department,
                   business_unit, job_title, job_level, phone, avatar_url, status`,
        values,
      );

      res.json({ user: result.rows[0] });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /invite  -  Send invitation (manager+)
// ---------------------------------------------------------------------------
router.post(
  '/invite',
  requireManager,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('role').optional().isIn(['admin', 'manager', 'staff']).withMessage('Invalid role'),
    body('department').optional().trim(),
    body('job_title').optional().trim(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const { email, role, department, job_title } = req.body;

      // Check existing
      const existing = await pool.query('SELECT id, status FROM users WHERE email = $1', [
        email.toLowerCase(),
      ]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'A user with this email already exists' });
      }

      const userId = uuidv4();
      const invitationToken = uuidv4();

      await pool.query(
        `INSERT INTO users (id, company_id, email, role, status, department, job_title,
                            invitation_token, invited_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'invited', $5, $6, $7, $8, NOW(), NOW())`,
        [
          userId,
          req.user.company_id,
          email.toLowerCase(),
          role || 'staff',
          department || null,
          job_title || null,
          invitationToken,
          req.user.id,
        ],
      );

      const inviteUrl = `${process.env.CORS_ORIGINS?.split(',')[0] || 'http://localhost:3000'}/accept-invite?token=${invitationToken}`;

      await sendCompanyEmail({
        companyId: req.user.company_id,
        to: email.toLowerCase(),
        subject: 'You are invited to InterBeing Care Connect',
        html: `
          <h2>Welcome!</h2>
          <p>You have been invited to join your organisation's wellbeing platform.</p>
          <p><a href="${inviteUrl}">Accept Invitation</a></p>
          <p>If you did not expect this invitation, please ignore this email.</p>
        `,
        text: `You have been invited to InterBeing Care Connect. Accept here: ${inviteUrl}`,
      });

      res.status(201).json({
        message: 'Invitation sent',
        user: { id: userId, email: email.toLowerCase(), status: 'invited' },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /:id/role  -  Change role (admin only)
// ---------------------------------------------------------------------------
router.patch(
  '/:id/role',
  requireAdmin,
  [
    param('id').isUUID().withMessage('Valid user ID is required'),
    body('role').isIn(['admin', 'manager', 'staff']).withMessage('Role must be admin, manager, or staff'),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `UPDATE users SET role = $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3
         RETURNING id, email, role`,
        [req.body.role, req.params.id, req.user.company_id],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ user: result.rows[0] });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /:id/status  -  Activate / suspend (admin only)
// ---------------------------------------------------------------------------
router.patch(
  '/:id/status',
  requireAdmin,
  [
    param('id').isUUID().withMessage('Valid user ID is required'),
    body('status').isIn(['active', 'suspended']).withMessage('Status must be active or suspended'),
    validate,
  ],
  async (req, res, next) => {
    try {
      // Prevent self-suspension
      if (req.params.id === req.user.id && req.body.status === 'suspended') {
        return res.status(400).json({ error: 'You cannot suspend your own account' });
      }

      const result = await pool.query(
        `UPDATE users SET status = $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3
         RETURNING id, email, status`,
        [req.body.status, req.params.id, req.user.company_id],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // If suspended, invalidate all refresh tokens
      if (req.body.status === 'suspended') {
        await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.params.id]);
      }

      res.json({ user: result.rows[0] });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/change-password  -  Change own password
// ---------------------------------------------------------------------------
router.post(
  '/:id/change-password',
  [
    param('id').isUUID().withMessage('Valid user ID is required'),
    body('current_password').notEmpty().withMessage('Current password is required'),
    body('new_password').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
    validate,
  ],
  async (req, res, next) => {
    try {
      // Users can only change their own password
      if (req.user.id !== req.params.id) {
        return res.status(403).json({ error: 'You can only change your own password' });
      }

      const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [
        req.user.id,
      ]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const valid = await bcrypt.compare(req.body.current_password, result.rows[0].password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const newHash = await bcrypt.hash(req.body.new_password, 12);
      await pool.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [newHash, req.user.id],
      );

      // Invalidate all refresh tokens except current session would be ideal,
      // but for simplicity clear all
      await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user.id]);

      res.json({ message: 'Password changed successfully' });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
