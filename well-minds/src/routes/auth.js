'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body } = require('express-validator');
const pool = require('../db');
const { authenticate, validate } = require('../middleware');
const { sendEmail } = require('../utils/email');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Rate limiters for sensitive auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 attempts per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

const JWT_SECRET = () => process.env.JWT_SECRET;
const JWT_EXPIRES_IN = () => process.env.JWT_EXPIRES_IN || '1h';
const JWT_REFRESH_EXPIRES_IN = () => process.env.JWT_REFRESH_EXPIRES_IN || '7d';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET(), { expiresIn: JWT_EXPIRES_IN() });
}

function generateRefreshToken(payload) {
  return jwt.sign({ ...payload, type: 'refresh' }, JWT_SECRET(), {
    expiresIn: JWT_REFRESH_EXPIRES_IN(),
  });
}

async function storeRefreshToken(userId, token) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [uuidv4(), userId, token, expiresAt],
  );
}

// ---------------------------------------------------------------------------
// POST /register  -  Company + admin user signup
// ---------------------------------------------------------------------------
router.post(
  '/register',
  authLimiter,
  [
    body('company_name').trim().notEmpty().withMessage('Company name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('first_name').trim().notEmpty().withMessage('First name is required'),
    body('last_name').trim().notEmpty().withMessage('Last name is required'),
    validate,
  ],
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { company_name, email, password, first_name, last_name } = req.body;

      // Check for duplicate email
      const existing = await client.query('SELECT id FROM users WHERE email = $1', [
        email.toLowerCase(),
      ]);
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Email already registered' });
      }

      // Create company
      const companyId = uuidv4();
      await client.query(
        `INSERT INTO companies (id, name, status, created_at, updated_at)
         VALUES ($1, $2, 'active', NOW(), NOW())`,
        [companyId, company_name],
      );

      // Create admin user
      const userId = uuidv4();
      const passwordHash = await bcrypt.hash(password, 12);
      await client.query(
        `INSERT INTO users (id, company_id, email, password_hash, first_name, last_name, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'admin', 'active', NOW(), NOW())`,
        [userId, companyId, email.toLowerCase(), passwordHash, first_name, last_name],
      );

      await client.query('COMMIT');

      // Generate tokens
      const tokenPayload = { id: userId, company_id: companyId, role: 'admin', email: email.toLowerCase() };
      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);
      await storeRefreshToken(userId, refreshToken);

      res.status(201).json({
        access_token: accessToken,
        refresh_token: refreshToken,
        user: {
          id: userId,
          email: email.toLowerCase(),
          first_name,
          last_name,
          role: 'admin',
          company_id: companyId,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------
router.post(
  '/login',
  authLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
    validate,
  ],
  async (req, res, next) => {
    try {
      const { email, password } = req.body;

      const result = await pool.query(
        `SELECT id, company_id, email, password_hash, first_name, last_name, role, status, avatar_url
         FROM users WHERE email = $1`,
        [email.toLowerCase()],
      );

      const user = result.rows[0];
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      if (user.status !== 'active') {
        return res.status(403).json({ error: 'Account is not active. Please contact your administrator.' });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Update last login
      await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

      const tokenPayload = {
        id: user.id,
        company_id: user.company_id,
        role: user.role,
        email: user.email,
      };
      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);
      await storeRefreshToken(user.id, refreshToken);

      res.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        user: {
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: user.role,
          company_id: user.company_id,
          avatar_url: user.avatar_url,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /refresh  -  Refresh token rotation
// ---------------------------------------------------------------------------
router.post(
  '/refresh',
  [body('refresh_token').notEmpty().withMessage('Refresh token is required'), validate],
  async (req, res, next) => {
    try {
      const { refresh_token } = req.body;

      // Verify token
      let decoded;
      try {
        decoded = jwt.verify(refresh_token, JWT_SECRET());
      } catch {
        return res.status(401).json({ error: 'Invalid or expired refresh token' });
      }

      if (decoded.type !== 'refresh') {
        return res.status(401).json({ error: 'Invalid token type' });
      }

      // Check if token exists in DB
      const tokenResult = await pool.query(
        'SELECT id FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
        [refresh_token],
      );
      if (tokenResult.rows.length === 0) {
        return res.status(401).json({ error: 'Refresh token not found or expired' });
      }

      // Delete old token (rotation)
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refresh_token]);

      // Issue new pair
      const tokenPayload = {
        id: decoded.id,
        company_id: decoded.company_id,
        role: decoded.role,
        email: decoded.email,
      };
      const newAccessToken = generateAccessToken(tokenPayload);
      const newRefreshToken = generateRefreshToken(tokenPayload);
      await storeRefreshToken(decoded.id, newRefreshToken);

      res.json({
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /logout
// ---------------------------------------------------------------------------
router.post(
  '/logout',
  [body('refresh_token').notEmpty().withMessage('Refresh token is required'), validate],
  async (req, res, next) => {
    try {
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [req.body.refresh_token]);
      res.json({ message: 'Logged out successfully' });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /forgot-password
// ---------------------------------------------------------------------------
router.post(
  '/forgot-password',
  strictLimiter,
  [body('email').isEmail().withMessage('Valid email is required'), validate],
  async (req, res, next) => {
    try {
      const { email } = req.body;

      const result = await pool.query(
        'SELECT id, first_name FROM users WHERE email = $1 AND status = $2',
        [email.toLowerCase(), 'active'],
      );

      // Always return success to avoid email enumeration
      if (result.rows.length === 0) {
        return res.json({ message: 'If the email exists, a reset link has been sent.' });
      }

      const user = result.rows[0];
      const resetToken = uuidv4();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await pool.query(
        `UPDATE users SET reset_token = $1, reset_token_expires_at = $2 WHERE id = $3`,
        [resetToken, expiresAt, user.id],
      );

      const resetUrl = `${process.env.CORS_ORIGINS?.split(',')[0] || 'http://localhost:3000'}/reset-password?token=${resetToken}`;

      await sendEmail({
        to: email.toLowerCase(),
        subject: 'Reset Your Password - InterBeing Care Connect',
        html: `
          <h2>Password Reset Request</h2>
          <p>Hi ${user.first_name},</p>
          <p>You requested a password reset. Click the link below to set a new password:</p>
          <p><a href="${resetUrl}">Reset Password</a></p>
          <p>This link expires in 1 hour. If you did not request this, please ignore this email.</p>
        `,
        text: `Hi ${user.first_name},\n\nReset your password here: ${resetUrl}\n\nThis link expires in 1 hour.`,
      });

      res.json({ message: 'If the email exists, a reset link has been sent.' });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /reset-password
// ---------------------------------------------------------------------------
router.post(
  '/reset-password',
  strictLimiter,
  [
    body('token').notEmpty().withMessage('Reset token is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    validate,
  ],
  async (req, res, next) => {
    try {
      const { token, password } = req.body;

      const result = await pool.query(
        `SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires_at > NOW()`,
        [token],
      );

      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid or expired reset token' });
      }

      const userId = result.rows[0].id;
      const passwordHash = await bcrypt.hash(password, 12);

      await pool.query(
        `UPDATE users
         SET password_hash = $1, reset_token = NULL, reset_token_expires_at = NULL, updated_at = NOW()
         WHERE id = $2`,
        [passwordHash, userId],
      );

      // Invalidate all refresh tokens for this user
      await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);

      res.json({ message: 'Password has been reset successfully' });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /accept-invite  -  Accept invitation, set password, activate
// ---------------------------------------------------------------------------
router.post(
  '/accept-invite',
  [
    body('token').notEmpty().withMessage('Invitation token is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('first_name').trim().notEmpty().withMessage('First name is required'),
    body('last_name').trim().notEmpty().withMessage('Last name is required'),
    validate,
  ],
  async (req, res, next) => {
    try {
      const { token, password, first_name, last_name } = req.body;

      const result = await pool.query(
        `SELECT id, company_id, email, role FROM users
         WHERE invitation_token = $1 AND status = 'invited'`,
        [token],
      );

      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid or expired invitation token' });
      }

      const user = result.rows[0];
      const passwordHash = await bcrypt.hash(password, 12);

      await pool.query(
        `UPDATE users
         SET password_hash = $1, first_name = $2, last_name = $3,
             status = 'active', invitation_token = NULL, updated_at = NOW()
         WHERE id = $4`,
        [passwordHash, first_name, last_name, user.id],
      );

      const tokenPayload = {
        id: user.id,
        company_id: user.company_id,
        role: user.role,
        email: user.email,
      };
      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);
      await storeRefreshToken(user.id, refreshToken);

      res.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        user: {
          id: user.id,
          email: user.email,
          first_name,
          last_name,
          role: user.role,
          company_id: user.company_id,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /me  -  Current user profile
// ---------------------------------------------------------------------------
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.company_id, u.email, u.first_name, u.last_name, u.role,
              u.department, u.business_unit, u.job_title, u.job_level,
              u.avatar_url, u.phone, u.status, u.last_login_at, u.created_at,
              c.name AS company_name
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1`,
      [req.user.id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /register-client  -  Public client registration (creates pending entry)
// ---------------------------------------------------------------------------
router.post(
  '/register-client',
  authLimiter,
  [
    body('company_name').trim().notEmpty().withMessage('Company name is required'),
    body('contact_name').trim().notEmpty().withMessage('Contact name is required'),
    body('contact_email').isEmail().withMessage('Valid contact email is required'),
    body('contact_phone').optional().trim(),
    body('employee_count').optional().isInt({ min: 1 }).withMessage('Employee count must be a positive integer'),
    body('industry').optional().trim(),
    body('message').optional().trim(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const {
        company_name,
        contact_name,
        contact_email,
        contact_phone,
        employee_count,
        industry,
        message,
      } = req.body;

      const id = uuidv4();

      await pool.query(
        `INSERT INTO client_registrations
           (id, company_name, contact_name, contact_email, contact_phone,
            employee_count, industry, message, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())`,
        [id, company_name, contact_name, contact_email.toLowerCase(), contact_phone || null,
         employee_count || null, industry || null, message || null],
      );

      // Notify IBL admin
      await sendEmail({
        to: process.env.SMTP_FROM || 'admin@interbeing.co',
        subject: `New Client Registration: ${company_name}`,
        html: `
          <h2>New Client Registration</h2>
          <p><strong>Company:</strong> ${company_name}</p>
          <p><strong>Contact:</strong> ${contact_name} (${contact_email})</p>
          <p><strong>Phone:</strong> ${contact_phone || 'N/A'}</p>
          <p><strong>Employees:</strong> ${employee_count || 'N/A'}</p>
          <p><strong>Industry:</strong> ${industry || 'N/A'}</p>
          <p><strong>Message:</strong> ${message || 'N/A'}</p>
        `,
      });

      res.status(201).json({
        message: 'Registration submitted successfully. Our team will contact you shortly.',
        registration_id: id,
      });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
