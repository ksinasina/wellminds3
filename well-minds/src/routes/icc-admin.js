const router = require('express').Router();
const pool = require('../db');
const { authenticateICC, requireICCRole } = require('../middleware');
const { body, param, query } = require('express-validator');
const { sendEmail } = require('../utils/email');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Validation middleware runner
const validate = (req, res, next) => {
  const { validationResult } = require('express-validator');
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// ============================================================================
// AUTH
// ============================================================================

// POST /api/icc/login
router.post('/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const { email, password } = req.body;
      const result = await pool.query(
        "SELECT * FROM icc_admins WHERE email = $1 AND status = 'active'",
        [email]
      );
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const admin = result.rows[0];
      const isMatch = await bcrypt.compare(password, admin.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const accessToken = jwt.sign(
        { icc_admin_id: admin.id, email: admin.email, role: admin.role },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );
      const refreshToken = jwt.sign(
        { icc_admin_id: admin.id, type: 'refresh' },
        (process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET),
        { expiresIn: '7d' }
      );

      // Store refresh token
      await pool.query(
        `INSERT INTO icc_refresh_tokens (id, admin_id, token, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
        [uuidv4(), admin.id, refreshToken]
      );

      // Update last login
      await pool.query(
        'UPDATE icc_admins SET last_login_at = NOW() WHERE id = $1',
        [admin.id]
      );

      res.json({
        data: {
          access_token: accessToken,
          refresh_token: refreshToken,
          admin: {
            id: admin.id,
            email: admin.email,
            first_name: admin.first_name,
            last_name: admin.last_name,
            role: admin.role,
          }
        }
      });
    } catch (err) {
      console.error('POST /api/icc/login error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/icc/me - Current admin profile
router.get('/me', authenticateICC, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, role, avatar_url, last_login_at, created_at
       FROM icc_admins WHERE id = $1`,
      [req.iccAdmin.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('GET /api/icc/me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/icc/refresh - Token refresh
router.post('/refresh',
  [body('refresh_token').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const { refresh_token } = req.body;

      let decoded;
      try {
        decoded = jwt.verify(refresh_token, (process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET));
      } catch (e) {
        return res.status(401).json({ error: 'Invalid or expired refresh token' });
      }

      // Verify token exists in DB
      const stored = await pool.query(
        'SELECT * FROM icc_refresh_tokens WHERE token = $1 AND admin_id = $2 AND expires_at > NOW()',
        [refresh_token, decoded.icc_admin_id]
      );
      if (stored.rows.length === 0) {
        return res.status(401).json({ error: 'Refresh token revoked or expired' });
      }

      const admin = await pool.query(
        "SELECT id, email, role FROM icc_admins WHERE id = $1 AND status = 'active'",
        [decoded.icc_admin_id]
      );
      if (admin.rows.length === 0) {
        return res.status(401).json({ error: 'Admin account disabled' });
      }

      // Rotate refresh token
      await pool.query('DELETE FROM icc_refresh_tokens WHERE token = $1', [refresh_token]);

      const newAccessToken = jwt.sign(
        { icc_admin_id: admin.rows[0].id, email: admin.rows[0].email, role: admin.rows[0].role },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );
      const newRefreshToken = jwt.sign(
        { icc_admin_id: admin.rows[0].id, type: 'refresh' },
        (process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET),
        { expiresIn: '7d' }
      );

      await pool.query(
        `INSERT INTO icc_refresh_tokens (id, admin_id, token, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
        [uuidv4(), admin.rows[0].id, newRefreshToken]
      );

      res.json({
        data: {
          access_token: newAccessToken,
          refresh_token: newRefreshToken,
        }
      });
    } catch (err) {
      console.error('POST /api/icc/refresh error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/icc/logout
router.post('/logout', authenticateICC, async (req, res) => {
  try {
    // Revoke all refresh tokens for this admin
    await pool.query(
      'DELETE FROM icc_refresh_tokens WHERE admin_id = $1',
      [req.iccAdmin.id]
    );
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('POST /api/icc/logout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// All subsequent routes require ICC authentication
router.use(authenticateICC);

// ============================================================================
// CLIENT REGISTRATIONS
// ============================================================================

// GET /api/icc/registrations - List all registrations with status filter
router.get('/registrations', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = 'SELECT * FROM client_registrations WHERE 1=1';
    const values = [];
    let idx = 1;
    if (status) {
      sql += ` AND status = $${idx++}`;
      values.push(status);
    }
    sql += ' ORDER BY created_at DESC';
    sql += ` LIMIT $${idx++} OFFSET $${idx++}`;
    values.push(parseInt(limit), offset);

    const result = await pool.query(sql, values);

    const countSql = status
      ? 'SELECT COUNT(*) FROM client_registrations WHERE status = $1'
      : 'SELECT COUNT(*) FROM client_registrations';
    const countResult = await pool.query(countSql, status ? [status] : []);

    res.json({
      data: result.rows,
      meta: { total: parseInt(countResult.rows[0].count), page: parseInt(page), limit: parseInt(limit) }
    });
  } catch (err) {
    console.error('GET /api/icc/registrations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/icc/registrations/:id - Registration detail
router.get('/registrations/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM client_registrations WHERE id = $1',
        [req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Registration not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('GET /api/icc/registrations/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/icc/registrations/:id/approve - Approve registration
router.post('/registrations/:id/approve',
  [
    param('id').isUUID(),
    body('modules').optional().isArray(),
    body('plan').optional().trim(),
    body('max_users').optional().isInt({ min: 1 }),
  ],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const { modules, plan, max_users } = req.body;

      const reg = await client.query(
        'SELECT * FROM client_registrations WHERE id = $1',
        [id]
      );
      if (reg.rows.length === 0) {
        return res.status(404).json({ error: 'Registration not found' });
      }
      if (reg.rows[0].status !== 'pending') {
        return res.status(409).json({ error: `Registration already ${reg.rows[0].status}` });
      }

      const registration = reg.rows[0];
      await client.query('BEGIN');

      // 1. Create company instance
      const companyId = uuidv4();
      await client.query(
        `INSERT INTO companies (id, name, code, email, phone, website, plan, max_users, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')`,
        [
          companyId,
          registration.company_name,
          registration.company_code || registration.company_name.toLowerCase().replace(/\s+/g, '-'),
          registration.email,
          registration.phone || null,
          registration.website || null,
          plan || 'standard',
          max_users || 50
        ]
      );

      // 2. Create primary admin user
      const adminId = uuidv4();
      const tempPassword = uuidv4().slice(0, 12);
      const hashedPassword = await bcrypt.hash(tempPassword, 12);
      await client.query(
        `INSERT INTO users (id, company_id, first_name, last_name, email, password_hash, role, must_change_password, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, 'admin', true, true)`,
        [adminId, companyId, registration.contact_first_name, registration.contact_last_name, registration.email, hashedPassword]
      );

      // 3. Assign selected modules
      const moduleList = modules || ['performance', 'development', 'wellbeing'];
      for (const mod of moduleList) {
        await client.query(
          `INSERT INTO company_modules (id, company_id, module_name, is_enabled, subscribed_at)
           VALUES ($1, $2, $3, true, NOW())`,
          [uuidv4(), companyId, mod]
        );
      }

      // 4. Update registration status
      await client.query(
        `UPDATE client_registrations SET status = 'approved', approved_by = $1, approved_at = NOW(), company_id = $2
         WHERE id = $3`,
        [req.iccAdmin.id, companyId, id]
      );

      await client.query('COMMIT');

      // 5. Send activation email (non-blocking)
      sendEmail({
        to: registration.email,
        subject: 'Your InterBeing Care Connect Account is Ready',
        html: `<p>Hello ${registration.contact_first_name},</p>
               <p>Your organization <strong>${registration.company_name}</strong> has been approved.</p>
               <p>Login with your email and temporary password: <strong>${tempPassword}</strong></p>
               <p>Please change your password upon first login.</p>`
      }).catch(err => console.error('Activation email error:', err));

      res.json({
        data: {
          registration_id: id,
          company_id: companyId,
          admin_user_id: adminId,
          status: 'approved',
          modules: moduleList,
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /api/icc/registrations/:id/approve error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// POST /api/icc/registrations/:id/reject - Reject with reason
router.post('/registrations/:id/reject',
  [
    param('id').isUUID(),
    body('reason').trim().notEmpty().withMessage('Rejection reason is required'),
  ],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const reg = await pool.query(
        'SELECT * FROM client_registrations WHERE id = $1',
        [id]
      );
      if (reg.rows.length === 0) {
        return res.status(404).json({ error: 'Registration not found' });
      }
      if (reg.rows[0].status !== 'pending') {
        return res.status(409).json({ error: `Registration already ${reg.rows[0].status}` });
      }

      await pool.query(
        `UPDATE client_registrations SET status = 'rejected', rejection_reason = $1, rejected_by = $2, rejected_at = NOW()
         WHERE id = $3`,
        [reason, req.iccAdmin.id, id]
      );

      // Notify applicant
      sendEmail({
        to: reg.rows[0].email,
        subject: 'InterBeing Care Connect - Registration Update',
        html: `<p>Hello ${reg.rows[0].contact_first_name},</p>
               <p>Unfortunately, your registration for <strong>${reg.rows[0].company_name}</strong> was not approved.</p>
               <p>Reason: ${reason}</p>
               <p>Please contact us for further information.</p>`
      }).catch(err => console.error('Rejection email error:', err));

      res.json({ data: { registration_id: id, status: 'rejected', reason } });
    } catch (err) {
      console.error('POST /api/icc/registrations/:id/reject error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// DASHBOARD
// ============================================================================

// GET /api/icc/dashboard - KPI tiles
router.get('/dashboard', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM client_registrations) AS total_registered_clients,
        (SELECT COUNT(*) FROM companies WHERE status = 'active') AS total_active_clients,
        (SELECT COUNT(*) FROM users WHERE is_active = true) AS total_users,
        (SELECT COUNT(*) FROM client_registrations WHERE status = 'pending') AS total_pending_registrations,
        (SELECT COUNT(*) FROM companies WHERE created_at >= NOW() - INTERVAL '30 days') AS new_clients_30d,
        (SELECT COUNT(*) FROM companies WHERE created_at >= NOW() - INTERVAL '60 days' AND created_at < NOW() - INTERVAL '30 days') AS new_clients_prev_30d,
        (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '30 days') AS new_users_30d,
        (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '60 days' AND created_at < NOW() - INTERVAL '30 days') AS new_users_prev_30d
    `);

    const s = stats.rows[0];
    const clientTrend = s.new_clients_prev_30d > 0
      ? ((s.new_clients_30d - s.new_clients_prev_30d) / s.new_clients_prev_30d * 100).toFixed(1)
      : s.new_clients_30d > 0 ? 100 : 0;
    const userTrend = s.new_users_prev_30d > 0
      ? ((s.new_users_30d - s.new_users_prev_30d) / s.new_users_prev_30d * 100).toFixed(1)
      : s.new_users_30d > 0 ? 100 : 0;

    res.json({
      data: {
        total_registered_clients: parseInt(s.total_registered_clients),
        total_active_clients: parseInt(s.total_active_clients),
        total_users: parseInt(s.total_users),
        total_pending_registrations: parseInt(s.total_pending_registrations),
        client_trend_pct: parseFloat(clientTrend),
        user_trend_pct: parseFloat(userTrend),
      }
    });
  } catch (err) {
    console.error('GET /api/icc/dashboard error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/icc/dashboard/charts - Chart data
router.get('/dashboard/charts', async (req, res) => {
  try {
    const [regStatus, geoDist, moduleAdoption, usersPerOrg] = await Promise.all([
      pool.query(
        `SELECT status, COUNT(*) AS count FROM client_registrations GROUP BY status`
      ),
      pool.query(
        `SELECT COALESCE(country, 'Unknown') AS country, COUNT(*) AS count
         FROM companies WHERE status = 'active' GROUP BY country ORDER BY count DESC LIMIT 20`
      ),
      pool.query(
        `SELECT module_name, COUNT(*) AS org_count,
          COUNT(*) FILTER (WHERE is_enabled = true) AS enabled_count
         FROM company_modules GROUP BY module_name ORDER BY org_count DESC`
      ),
      pool.query(
        `SELECT c.name AS company_name, COUNT(u.id) AS user_count
         FROM companies c
         LEFT JOIN users u ON u.company_id = c.id AND u.is_active = true
         WHERE c.status = 'active'
         GROUP BY c.id, c.name ORDER BY user_count DESC LIMIT 20`
      ),
    ]);

    res.json({
      data: {
        registration_status: regStatus.rows,
        geographic_distribution: geoDist.rows,
        module_adoption: moduleAdoption.rows,
        users_per_org: usersPerOrg.rows,
      }
    });
  } catch (err) {
    console.error('GET /api/icc/dashboard/charts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// ORGANIZATIONS
// ============================================================================

// GET /api/icc/organizations - List all with user counts
router.get('/organizations', async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = `
      SELECT c.*,
        (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.is_active = true) AS active_user_count,
        (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS total_user_count
      FROM companies c WHERE 1=1`;
    const values = [];
    let idx = 1;
    if (status) {
      sql += ` AND c.status = $${idx++}`;
      values.push(status);
    }
    if (search) {
      sql += ` AND (c.name ILIKE $${idx} OR c.code ILIKE $${idx} OR c.email ILIKE $${idx})`;
      values.push(`%${search}%`);
      idx++;
    }
    sql += ` ORDER BY c.name LIMIT $${idx++} OFFSET $${idx++}`;
    values.push(parseInt(limit), offset);

    const result = await pool.query(sql, values);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/icc/organizations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/icc/organizations/:id - Org details with stats, module subscriptions
router.get('/organizations/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const companyResult = await pool.query(
        `SELECT c.*,
          (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.is_active = true) AS active_user_count,
          (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS total_user_count,
          (SELECT COUNT(*) FROM departments d WHERE d.company_id = c.id AND d.is_active = true) AS department_count,
          (SELECT COUNT(*) FROM business_units bu WHERE bu.company_id = c.id AND bu.is_active = true) AS bu_count
         FROM companies c WHERE c.id = $1`,
        [id]
      );
      if (companyResult.rows.length === 0) {
        return res.status(404).json({ error: 'Organization not found' });
      }
      const modules = await pool.query(
        'SELECT * FROM company_modules WHERE company_id = $1 ORDER BY module_name',
        [id]
      );
      const company = companyResult.rows[0];
      company.modules = modules.rows;
      res.json({ data: company });
    } catch (err) {
      console.error('GET /api/icc/organizations/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/icc/organizations/:id - Update plan, max_users, status
router.patch('/organizations/:id',
  [
    param('id').isUUID(),
    body('plan').optional().trim(),
    body('max_users').optional().isInt({ min: 1 }),
    body('status').optional().isIn(['active', 'suspended', 'cancelled']),
    body('name').optional().trim().notEmpty(),
  ],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const allowed = ['plan', 'max_users', 'status', 'name'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(`${key} = $${idx++}`);
          values.push(req.body[key]);
        }
      }
      if (sets.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }
      values.push(id);
      const result = await pool.query(
        `UPDATE companies SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Organization not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /api/icc/organizations/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/icc/organizations - Provision new company
router.post('/organizations',
  [
    body('name').trim().notEmpty().withMessage('Company name is required'),
    body('code').trim().notEmpty().withMessage('Company code is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('plan').optional().trim(),
    body('max_users').optional().isInt({ min: 1 }),
    body('admin_first_name').trim().notEmpty(),
    body('admin_last_name').trim().notEmpty(),
    body('admin_email').isEmail(),
    body('modules').optional().isArray(),
  ],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { name, code, email, plan, max_users, admin_first_name, admin_last_name, admin_email, modules } = req.body;

      await client.query('BEGIN');

      const companyId = uuidv4();
      await client.query(
        `INSERT INTO companies (id, name, code, email, plan, max_users, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
        [companyId, name, code, email, plan || 'standard', max_users || 50]
      );

      const adminId = uuidv4();
      const tempPassword = uuidv4().slice(0, 12);
      const hashedPassword = await bcrypt.hash(tempPassword, 12);
      await client.query(
        `INSERT INTO users (id, company_id, first_name, last_name, email, password_hash, role, must_change_password, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, 'admin', true, true)`,
        [adminId, companyId, admin_first_name, admin_last_name, admin_email, hashedPassword]
      );

      const moduleList = modules || ['performance', 'development', 'wellbeing'];
      for (const mod of moduleList) {
        await client.query(
          `INSERT INTO company_modules (id, company_id, module_name, is_enabled, subscribed_at)
           VALUES ($1, $2, $3, true, NOW())`,
          [uuidv4(), companyId, mod]
        );
      }

      await client.query('COMMIT');

      sendEmail({
        to: admin_email,
        subject: 'Your InterBeing Care Connect Account',
        html: `<p>Hello ${admin_first_name},</p>
               <p>Your organization <strong>${name}</strong> has been set up on InterBeing Care Connect.</p>
               <p>Your temporary password is: <strong>${tempPassword}</strong></p>
               <p>Please change your password upon first login.</p>`
      }).catch(err => console.error('Provision email error:', err));

      res.status(201).json({
        data: { company_id: companyId, admin_user_id: adminId, modules: moduleList }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Company with this code already exists' });
      }
      console.error('POST /api/icc/organizations error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// ============================================================================
// INDICATORS
// ============================================================================

// GET /api/icc/indicators
router.get('/indicators', async (req, res) => {
  try {
    const { status, category_id, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = `
      SELECT i.*, ic.name AS category_name,
        (SELECT COUNT(*) FROM indicator_sections s WHERE s.indicator_id = i.id) AS section_count,
        (SELECT COUNT(*) FROM indicator_org_assignments ioa WHERE ioa.indicator_id = i.id) AS org_count
      FROM indicators i
      LEFT JOIN indicator_categories ic ON ic.id = i.category_id
      WHERE 1=1`;
    const values = [];
    let idx = 1;
    if (status) {
      sql += ` AND i.status = $${idx++}`;
      values.push(status);
    }
    if (category_id) {
      sql += ` AND i.category_id = $${idx++}`;
      values.push(category_id);
    }
    sql += ` ORDER BY i.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    values.push(parseInt(limit), offset);

    const result = await pool.query(sql, values);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/icc/indicators error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/icc/indicators/:id
router.get('/indicators/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const indicator = await pool.query('SELECT * FROM indicators WHERE id = $1', [id]);
      if (indicator.rows.length === 0) {
        return res.status(404).json({ error: 'Indicator not found' });
      }
      const sections = await pool.query(
        `SELECT s.*, json_agg(
           json_build_object('id', q.id, 'question_text', q.question_text, 'question_type', q.question_type,
             'options', q.options, 'scoring_enabled', q.scoring_enabled, 'sort_order', q.sort_order)
           ORDER BY q.sort_order
         ) FILTER (WHERE q.id IS NOT NULL) AS questions
         FROM indicator_sections s
         LEFT JOIN indicator_questions q ON q.section_id = s.id
         WHERE s.indicator_id = $1
         GROUP BY s.id ORDER BY s.sort_order`,
        [id]
      );
      const sectionRanges = await pool.query(
        'SELECT * FROM indicator_responses WHERE indicator_id = $1 AND section_id IS NOT NULL ORDER BY score_range_min',
        [id]
      );
      const overallRanges = await pool.query(
        'SELECT * FROM indicator_responses WHERE indicator_id = $1 AND section_id IS NULL ORDER BY start_score',
        [id]
      );
      const orgs = await pool.query(
        `SELECT ioa.*, c.name AS company_name
         FROM indicator_org_assignments ioa
         JOIN companies c ON c.id = ioa.company_id
         WHERE ioa.indicator_id = $1`,
        [id]
      );

      const data = indicator.rows[0];
      data.sections = sections.rows;
      data.section_ranges = sectionRanges.rows;
      data.overall_ranges = overallRanges.rows;
      data.assigned_orgs = orgs.rows;
      res.json({ data });
    } catch (err) {
      console.error('GET /api/icc/indicators/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/icc/indicators
router.post('/indicators',
  [
    body('title').trim().notEmpty(),
    body('category_id').optional().isUUID(),
    body('description').optional().trim(),
    body('disclaimer').optional().trim(),
    body('footer_html').optional().trim(),
    body('mail_content_html').optional().trim(),
    body('banner_url').optional().trim(),
    body('background_url').optional().trim(),
    body('include_scoring').optional().isBoolean(),
    body('admin_distribution_only').optional().isBoolean(),
    body('send_results').optional().isBoolean(),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        title, category_id, description, disclaimer, footer_html,
        mail_content_html, banner_url, background_url,
        include_scoring, admin_distribution_only, send_results
      } = req.body;

      const result = await pool.query(
        `INSERT INTO indicators (id, title, category_id, description, disclaimer, footer_html,
          mail_content_html, banner_url, background_url, include_scoring, admin_distribution_only,
          send_results, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft', $13) RETURNING *`,
        [
          uuidv4(), title, category_id || null, description || null, disclaimer || null,
          footer_html || null, mail_content_html || null, banner_url || null, background_url || null,
          include_scoring !== undefined ? include_scoring : true,
          admin_distribution_only !== undefined ? admin_distribution_only : false,
          send_results !== undefined ? send_results : true,
          req.iccAdmin.id
        ]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /api/icc/indicators error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/icc/indicators/:id
router.patch('/indicators/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const allowed = [
        'title', 'category_id', 'description', 'disclaimer', 'footer_html',
        'mail_content_html', 'banner_url', 'background_url',
        'include_scoring', 'admin_distribution_only', 'send_results'
      ];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(`${key} = $${idx++}`);
          values.push(req.body[key]);
        }
      }
      if (sets.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }
      values.push(id);
      const result = await pool.query(
        `UPDATE indicators SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Indicator not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /api/icc/indicators/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/icc/indicators/:id
router.delete('/indicators/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'UPDATE indicators SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
        ['archived', req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Indicator not found' });
      }
      res.json({ message: 'Indicator archived' });
    } catch (err) {
      console.error('DELETE /api/icc/indicators/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Indicator Sections ---

// POST /api/icc/indicators/:id/sections
router.post('/indicators/:id/sections',
  [
    param('id').isUUID(),
    body('title').trim().notEmpty(),
    body('description').optional().trim(),
    body('scoring_enabled').optional().isBoolean(),
    body('multiplier').optional().isFloat({ min: 0 }),
    body('base_max_score').optional().isFloat({ min: 0 }),
    body('sort_order').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const indicator = await pool.query('SELECT id FROM indicators WHERE id = $1', [id]);
      if (indicator.rows.length === 0) {
        return res.status(404).json({ error: 'Indicator not found' });
      }
      const { title, description, scoring_enabled, multiplier, base_max_score, sort_order } = req.body;
      const effectiveMax = (base_max_score || 0) * (multiplier || 1);
      const result = await pool.query(
        `INSERT INTO indicator_sections (id, indicator_id, title, description, scoring_enabled, multiplier, base_max_score, effective_max_score, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [uuidv4(), id, title, description || null, scoring_enabled !== undefined ? scoring_enabled : true, multiplier || 1, base_max_score || 0, effectiveMax, sort_order || 0]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /indicators/:id/sections error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/icc/indicators/:id/sections/:sectionId
router.patch('/indicators/:id/sections/:sectionId',
  [param('id').isUUID(), param('sectionId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { sectionId } = req.params;
      const allowed = ['title', 'description', 'scoring_enabled', 'multiplier', 'base_max_score', 'sort_order'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(`${key} = $${idx++}`);
          values.push(req.body[key]);
        }
      }
      if (sets.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }
      // Recalculate effective_max_score if relevant fields change
      if (req.body.base_max_score !== undefined || req.body.multiplier !== undefined) {
        sets.push(`effective_max_score = COALESCE($${idx}, base_max_score) * COALESCE($${idx + 1}, multiplier)`);
        values.push(req.body.base_max_score || null, req.body.multiplier || null);
        idx += 2;
      }
      values.push(sectionId);
      const result = await pool.query(
        `UPDATE indicator_sections SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Section not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /indicators/:id/sections/:sectionId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/icc/indicators/:id/sections/:sectionId
router.delete('/indicators/:id/sections/:sectionId',
  [param('id').isUUID(), param('sectionId').isUUID()],
  validate,
  async (req, res) => {
    try {
      await pool.query('DELETE FROM indicator_questions WHERE section_id = $1', [req.params.sectionId]);
      await pool.query('DELETE FROM indicator_responses WHERE section_id = $1', [req.params.sectionId]);
      const result = await pool.query(
        'DELETE FROM indicator_sections WHERE id = $1 AND indicator_id = $2 RETURNING id',
        [req.params.sectionId, req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Section not found' });
      }
      res.json({ message: 'Section deleted' });
    } catch (err) {
      console.error('DELETE /indicators/:id/sections/:sectionId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Indicator Questions ---

// POST /api/icc/indicators/:id/sections/:sectionId/questions
router.post('/indicators/:id/sections/:sectionId/questions',
  [
    param('id').isUUID(),
    param('sectionId').isUUID(),
    body('question_text').trim().notEmpty(),
    body('question_type').isIn(['single_choice', 'multiple_choice', 'scale', 'text', 'yes_no']),
    body('options').optional().isArray(),
    body('scoring_enabled').optional().isBoolean(),
    body('sort_order').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { sectionId } = req.params;
      const { question_text, question_type, options, scoring_enabled, sort_order } = req.body;
      const result = await pool.query(
        `INSERT INTO indicator_questions (id, section_id, question_text, question_type, options, scoring_enabled, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [uuidv4(), sectionId, question_text, question_type, options ? JSON.stringify(options) : null, scoring_enabled !== undefined ? scoring_enabled : true, sort_order || 0]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /questions error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/icc/indicators/:id/sections/:sectionId/questions/:questionId
router.patch('/indicators/:id/sections/:sectionId/questions/:questionId',
  [param('id').isUUID(), param('sectionId').isUUID(), param('questionId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { questionId } = req.params;
      const allowed = ['question_text', 'question_type', 'options', 'scoring_enabled', 'sort_order'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(`${key} = $${idx++}`);
          values.push(key === 'options' ? JSON.stringify(req.body[key]) : req.body[key]);
        }
      }
      if (sets.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }
      values.push(questionId);
      const result = await pool.query(
        `UPDATE indicator_questions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Question not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /questions/:questionId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/icc/indicators/:id/sections/:sectionId/questions/:questionId
router.delete('/indicators/:id/sections/:sectionId/questions/:questionId',
  [param('id').isUUID(), param('sectionId').isUUID(), param('questionId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM indicator_questions WHERE id = $1 AND section_id = $2 RETURNING id',
        [req.params.questionId, req.params.sectionId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Question not found' });
      }
      res.json({ message: 'Question deleted' });
    } catch (err) {
      console.error('DELETE /questions/:questionId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Indicator Responses / Ranges ---

// POST /api/icc/indicators/:id/section-ranges (section-level ranges)
router.post('/indicators/:id/section-ranges',
  [
    param('id').isUUID(),
    body('section_id').isUUID(),
    body('title').trim().notEmpty(),
    body('score_range_min').isFloat(),
    body('score_range_max').isFloat(),
    body('description').optional().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { section_id, title, score_range_min, score_range_max, description } = req.body;

      // Validate no overlap
      const existing = await pool.query(
        `SELECT * FROM indicator_responses
         WHERE indicator_id = $1 AND section_id = $2
         AND ((score_range_min <= $3 AND score_range_max >= $3) OR (score_range_min <= $4 AND score_range_max >= $4)
              OR (score_range_min >= $3 AND score_range_max <= $4))`,
        [id, section_id, score_range_min, score_range_max]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Score range overlaps with existing range' });
      }

      const result = await pool.query(
        `INSERT INTO indicator_responses (id, indicator_id, section_id, title, score_range_min, score_range_max, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [uuidv4(), id, section_id, title, score_range_min, score_range_max, description || null]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /indicators/:id/section-ranges error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/icc/indicators/:id/overall-ranges (overall indicator ranges)
router.post('/indicators/:id/overall-ranges',
  [
    param('id').isUUID(),
    body('title').trim().notEmpty(),
    body('start_score').isFloat(),
    body('end_score').isFloat(),
    body('intro_text').optional().trim(),
    body('conclusion_text').optional().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { title, start_score, end_score, intro_text, conclusion_text } = req.body;

      // Validate no overlap
      const existing = await pool.query(
        `SELECT * FROM indicator_responses
         WHERE indicator_id = $1 AND section_id IS NULL
         AND ((start_score <= $2 AND end_score >= $2) OR (start_score <= $3 AND end_score >= $3)
              OR (start_score >= $2 AND end_score <= $3))`,
        [id, start_score, end_score]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Score range overlaps with existing range' });
      }

      const result = await pool.query(
        `INSERT INTO indicator_responses (id, indicator_id, section_id, title, start_score, end_score, intro_text, conclusion_text)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7) RETURNING *`,
        [uuidv4(), id, title, start_score, end_score, intro_text || null, conclusion_text || null]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /indicators/:id/overall-ranges error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/icc/indicators/:id/ranges/:rangeId
router.patch('/indicators/:id/ranges/:rangeId',
  [param('id').isUUID(), param('rangeId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rangeId } = req.params;
      const allowed = ['title', 'score_range_min', 'score_range_max', 'start_score', 'end_score', 'description', 'intro_text', 'conclusion_text'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(`${key} = $${idx++}`);
          values.push(req.body[key]);
        }
      }
      if (sets.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }
      values.push(rangeId);
      const result = await pool.query(
        `UPDATE indicator_responses SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Range not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /indicators/:id/ranges/:rangeId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/icc/indicators/:id/ranges/:rangeId
router.delete('/indicators/:id/ranges/:rangeId',
  [param('id').isUUID(), param('rangeId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM indicator_responses WHERE id = $1 AND indicator_id = $2 RETURNING id',
        [req.params.rangeId, req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Range not found' });
      }
      res.json({ message: 'Range deleted' });
    } catch (err) {
      console.error('DELETE /indicators/:id/ranges/:rangeId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Publish/Unpublish ---

// PATCH /api/icc/indicators/:id/publish
router.patch('/indicators/:id/publish',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;

      // Validate: at least one section with questions
      const sections = await pool.query(
        'SELECT id FROM indicator_sections WHERE indicator_id = $1',
        [id]
      );
      if (sections.rows.length === 0) {
        return res.status(400).json({ error: 'Indicator must have at least one section to publish' });
      }
      const questions = await pool.query(
        'SELECT id FROM indicator_questions WHERE section_id = ANY($1)',
        [sections.rows.map(s => s.id)]
      );
      if (questions.rows.length === 0) {
        return res.status(400).json({ error: 'Indicator must have at least one question to publish' });
      }

      const result = await pool.query(
        `UPDATE indicators SET status = 'published', published_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Indicator not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /indicators/:id/publish error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/icc/indicators/:id/unpublish
router.patch('/indicators/:id/unpublish',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE indicators SET status = 'draft', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Indicator not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /indicators/:id/unpublish error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Assign to orgs ---

// POST /api/icc/indicators/:id/assign
router.post('/indicators/:id/assign',
  [
    param('id').isUUID(),
    body('company_ids').isArray({ min: 1 }),
    body('company_ids.*').isUUID(),
  ],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { company_ids } = req.body;
      const created = [];
      for (const companyId of company_ids) {
        const existing = await pool.query(
          'SELECT id FROM indicator_org_assignments WHERE indicator_id = $1 AND company_id = $2',
          [id, companyId]
        );
        if (existing.rows.length > 0) continue;
        const result = await pool.query(
          `INSERT INTO indicator_org_assignments (id, indicator_id, company_id, assigned_by)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [uuidv4(), id, companyId, req.iccAdmin.id]
        );
        created.push(result.rows[0]);
      }
      res.status(201).json({ data: { assigned_count: created.length, assignments: created } });
    } catch (err) {
      console.error('POST /indicators/:id/assign error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/icc/indicators/:id/assign/:companyId
router.delete('/indicators/:id/assign/:companyId',
  [param('id').isUUID(), param('companyId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM indicator_org_assignments WHERE indicator_id = $1 AND company_id = $2 RETURNING id',
        [req.params.id, req.params.companyId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Assignment not found' });
      }
      res.json({ message: 'Assignment removed' });
    } catch (err) {
      console.error('DELETE /indicators/:id/assign/:companyId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Indicator Schedules ---

// GET /api/icc/indicators/:id/schedules
router.get('/indicators/:id/schedules',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM indicator_schedules WHERE indicator_id = $1 ORDER BY start_date DESC',
        [req.params.id]
      );
      res.json({ data: result.rows });
    } catch (err) {
      console.error('GET /indicators/:id/schedules error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/icc/indicators/:id/schedules
router.post('/indicators/:id/schedules',
  [
    param('id').isUUID(),
    body('start_date').isISO8601(),
    body('end_date').isISO8601(),
    body('recurrence').optional().isIn(['once', 'weekly', 'monthly', 'quarterly', 'yearly']),
    body('target_company_ids').optional().isArray(),
  ],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { start_date, end_date, recurrence, target_company_ids } = req.body;
      const result = await pool.query(
        `INSERT INTO indicator_schedules (id, indicator_id, start_date, end_date, recurrence, target_company_ids, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [uuidv4(), id, start_date, end_date, recurrence || 'once', target_company_ids ? JSON.stringify(target_company_ids) : null, req.iccAdmin.id]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /indicators/:id/schedules error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/icc/indicators/:id/schedules/:scheduleId
router.patch('/indicators/:id/schedules/:scheduleId',
  [param('id').isUUID(), param('scheduleId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { scheduleId } = req.params;
      const allowed = ['start_date', 'end_date', 'recurrence', 'target_company_ids', 'is_active'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(`${key} = $${idx++}`);
          values.push(key === 'target_company_ids' ? JSON.stringify(req.body[key]) : req.body[key]);
        }
      }
      if (sets.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }
      values.push(scheduleId);
      const result = await pool.query(
        `UPDATE indicator_schedules SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Schedule not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /indicators/:id/schedules/:scheduleId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/icc/indicators/:id/schedules/:scheduleId
router.delete('/indicators/:id/schedules/:scheduleId',
  [param('id').isUUID(), param('scheduleId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM indicator_schedules WHERE id = $1 AND indicator_id = $2 RETURNING id',
        [req.params.scheduleId, req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Schedule not found' });
      }
      res.json({ message: 'Schedule deleted' });
    } catch (err) {
      console.error('DELETE /indicators/:id/schedules/:scheduleId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/icc/indicators/:id/analytics - Completion analytics across orgs
router.get('/indicators/:id/analytics',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `SELECT c.name AS company_name, c.id AS company_id,
          COUNT(ic.id) AS total_completions,
          COUNT(ic.id) FILTER (WHERE ic.completed_at IS NOT NULL) AS completed,
          ROUND(AVG(ic.total_score)::numeric, 2) AS avg_score
         FROM indicator_org_assignments ioa
         JOIN companies c ON c.id = ioa.company_id
         LEFT JOIN indicator_completions ic ON ic.indicator_id = $1 AND ic.company_id = c.id
         WHERE ioa.indicator_id = $1
         GROUP BY c.id, c.name
         ORDER BY c.name`,
        [id]
      );
      res.json({ data: result.rows });
    } catch (err) {
      console.error('GET /indicators/:id/analytics error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// RESOURCES
// ============================================================================

// --- Topic Categories ---
router.get('/resources/categories', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM resource_topic_categories ORDER BY sort_order, name'
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /resources/categories error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/resources/categories',
  [body('name').trim().notEmpty(), body('description').optional().trim(), body('sort_order').optional().isInt({ min: 0 })],
  validate,
  async (req, res) => {
    try {
      const { name, description, sort_order } = req.body;
      const result = await pool.query(
        `INSERT INTO resource_topic_categories (id, name, description, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [uuidv4(), name, description || null, sort_order || 0]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /resources/categories error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.patch('/resources/categories/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const allowed = ['name', 'description', 'sort_order'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(`${key} = $${idx++}`);
          values.push(req.body[key]);
        }
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No valid fields' });
      values.push(req.params.id);
      const result = await pool.query(
        `UPDATE resource_topic_categories SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Category not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /resources/categories/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/resources/categories/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM resource_topic_categories WHERE id = $1 RETURNING id',
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Category not found' });
      res.json({ message: 'Category deleted' });
    } catch (err) {
      console.error('DELETE /resources/categories/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Topics ---
router.get('/resources/topics', async (req, res) => {
  try {
    const { category_id } = req.query;
    let sql = `
      SELECT t.*, c.name AS category_name,
        (SELECT COUNT(*) FROM resource_milestones m WHERE m.topic_id = t.id) AS milestone_count,
        (SELECT COUNT(*) FROM resource_topic_org_assignments rta WHERE rta.topic_id = t.id) AS org_count
      FROM resource_topics t
      LEFT JOIN resource_topic_categories c ON c.id = t.category_id
      WHERE 1=1`;
    const values = [];
    if (category_id) {
      sql += ' AND t.category_id = $1';
      values.push(category_id);
    }
    sql += ' ORDER BY t.created_at DESC';
    const result = await pool.query(sql, values);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /resources/topics error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/resources/topics/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const topic = await pool.query('SELECT * FROM resource_topics WHERE id = $1', [req.params.id]);
      if (topic.rows.length === 0) return res.status(404).json({ error: 'Topic not found' });

      const milestones = await pool.query(
        `SELECT m.*,
          json_agg(json_build_object('id', l.id, 'title', l.title, 'sort_order', l.sort_order) ORDER BY l.sort_order)
          FILTER (WHERE l.id IS NOT NULL) AS lessons
         FROM resource_milestones m
         LEFT JOIN resource_lessons l ON l.milestone_id = m.id
         WHERE m.topic_id = $1
         GROUP BY m.id ORDER BY m.sort_order`,
        [req.params.id]
      );
      const data = topic.rows[0];
      data.milestones = milestones.rows;
      res.json({ data });
    } catch (err) {
      console.error('GET /resources/topics/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post('/resources/topics',
  [
    body('title').trim().notEmpty(),
    body('category_id').optional().isUUID(),
    body('description').optional().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const { title, category_id, description } = req.body;
      const result = await pool.query(
        `INSERT INTO resource_topics (id, title, category_id, description, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [uuidv4(), title, category_id || null, description || null, req.iccAdmin.id]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /resources/topics error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.patch('/resources/topics/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const allowed = ['title', 'category_id', 'description'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) { sets.push(`${key} = $${idx++}`); values.push(req.body[key]); }
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No valid fields' });
      values.push(req.params.id);
      const result = await pool.query(
        `UPDATE resource_topics SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Topic not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /resources/topics/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/resources/topics/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'UPDATE resource_topics SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id',
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Topic not found' });
      res.json({ message: 'Topic archived' });
    } catch (err) {
      console.error('DELETE /resources/topics/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Milestones ---
router.post('/resources/topics/:topicId/milestones',
  [param('topicId').isUUID(), body('title').trim().notEmpty(), body('description').optional().trim(), body('sort_order').optional().isInt({ min: 0 })],
  validate,
  async (req, res) => {
    try {
      const { title, description, sort_order } = req.body;
      const result = await pool.query(
        `INSERT INTO resource_milestones (id, topic_id, title, description, sort_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [uuidv4(), req.params.topicId, title, description || null, sort_order || 0]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /milestones error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.patch('/resources/milestones/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const allowed = ['title', 'description', 'sort_order'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) { sets.push(`${key} = $${idx++}`); values.push(req.body[key]); }
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No valid fields' });
      values.push(req.params.id);
      const result = await pool.query(
        `UPDATE resource_milestones SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Milestone not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /milestones/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/resources/milestones/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM resource_milestones WHERE id = $1 RETURNING id',
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Milestone not found' });
      res.json({ message: 'Milestone deleted' });
    } catch (err) {
      console.error('DELETE /milestones/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Lessons ---
router.post('/resources/milestones/:milestoneId/lessons',
  [param('milestoneId').isUUID(), body('title').trim().notEmpty(), body('description').optional().trim(), body('sort_order').optional().isInt({ min: 0 })],
  validate,
  async (req, res) => {
    try {
      const { title, description, sort_order } = req.body;
      const result = await pool.query(
        `INSERT INTO resource_lessons (id, milestone_id, title, description, sort_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [uuidv4(), req.params.milestoneId, title, description || null, sort_order || 0]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /lessons error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.patch('/resources/lessons/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const allowed = ['title', 'description', 'sort_order'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) { sets.push(`${key} = $${idx++}`); values.push(req.body[key]); }
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No valid fields' });
      values.push(req.params.id);
      const result = await pool.query(
        `UPDATE resource_lessons SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Lesson not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /lessons/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/resources/lessons/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM resource_lessons WHERE id = $1 RETURNING id', [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Lesson not found' });
      res.json({ message: 'Lesson deleted' });
    } catch (err) {
      console.error('DELETE /lessons/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Lesson Resources ---
router.get('/resources/lessons/:lessonId/resources',
  [param('lessonId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM resource_items WHERE lesson_id = $1 ORDER BY sort_order',
        [req.params.lessonId]
      );
      res.json({ data: result.rows });
    } catch (err) {
      console.error('GET /lessons/:lessonId/resources error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post('/resources/lessons/:lessonId/resources',
  [
    param('lessonId').isUUID(),
    body('title').trim().notEmpty(),
    body('resource_type').isIn(['video', 'audio', 'pdf', 'article']),
    body('file_url').optional().trim(),
    body('content_html').optional().trim(),
    body('duration_minutes').optional().isInt({ min: 0 }),
    body('sort_order').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { title, resource_type, file_url, content_html, duration_minutes, sort_order } = req.body;
      const result = await pool.query(
        `INSERT INTO resource_items (id, lesson_id, title, resource_type, file_url, content_html, duration_minutes, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [uuidv4(), req.params.lessonId, title, resource_type, file_url || null, content_html || null, duration_minutes || null, sort_order || 0]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /lessons/:lessonId/resources error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.patch('/resources/items/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const allowed = ['title', 'resource_type', 'file_url', 'content_html', 'duration_minutes', 'sort_order'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) { sets.push(`${key} = $${idx++}`); values.push(req.body[key]); }
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No valid fields' });
      values.push(req.params.id);
      const result = await pool.query(
        `UPDATE resource_items SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Resource not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /resources/items/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/resources/items/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query('DELETE FROM resource_items WHERE id = $1 RETURNING id', [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Resource not found' });
      res.json({ message: 'Resource deleted' });
    } catch (err) {
      console.error('DELETE /resources/items/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Assign topics to organizations ---
router.post('/resources/topics/:topicId/assign',
  [param('topicId').isUUID(), body('company_ids').isArray({ min: 1 }), body('company_ids.*').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { topicId } = req.params;
      const { company_ids } = req.body;
      const created = [];
      for (const companyId of company_ids) {
        const existing = await pool.query(
          'SELECT id FROM resource_topic_org_assignments WHERE topic_id = $1 AND company_id = $2',
          [topicId, companyId]
        );
        if (existing.rows.length > 0) continue;
        const result = await pool.query(
          `INSERT INTO resource_topic_org_assignments (id, topic_id, company_id, assigned_by)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [uuidv4(), topicId, companyId, req.iccAdmin.id]
        );
        created.push(result.rows[0]);
      }
      res.status(201).json({ data: { assigned_count: created.length, assignments: created } });
    } catch (err) {
      console.error('POST /resources/topics/:topicId/assign error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/resources/topics/:topicId/assign/:companyId',
  [param('topicId').isUUID(), param('companyId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM resource_topic_org_assignments WHERE topic_id = $1 AND company_id = $2 RETURNING id',
        [req.params.topicId, req.params.companyId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
      res.json({ message: 'Assignment removed' });
    } catch (err) {
      console.error('DELETE /resources/topics assign error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/icc/resources/engagement - Engagement stats
router.get('/resources/engagement', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.id, t.title, c.name AS category_name,
        (SELECT COUNT(DISTINCT re.user_id) FROM resource_engagements re
         JOIN resource_items ri ON ri.id = re.resource_item_id
         JOIN resource_lessons rl ON rl.id = ri.lesson_id
         JOIN resource_milestones rm ON rm.id = rl.milestone_id
         WHERE rm.topic_id = t.id) AS unique_users,
        (SELECT COUNT(*) FROM resource_engagements re
         JOIN resource_items ri ON ri.id = re.resource_item_id
         JOIN resource_lessons rl ON rl.id = ri.lesson_id
         JOIN resource_milestones rm ON rm.id = rl.milestone_id
         WHERE rm.topic_id = t.id AND re.completed = true) AS completions
      FROM resource_topics t
      LEFT JOIN resource_topic_categories c ON c.id = t.category_id
      WHERE t.is_active = true
      ORDER BY unique_users DESC
    `);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /resources/engagement error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// PROFESSIONALS
// ============================================================================

// GET /api/icc/professionals
router.get('/professionals', async (req, res) => {
  try {
    const { status, specialty, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = 'SELECT * FROM professionals WHERE 1=1';
    const values = [];
    let idx = 1;
    if (status) { sql += ` AND status = $${idx++}`; values.push(status); }
    if (specialty) { sql += ` AND specialty ILIKE $${idx++}`; values.push(`%${specialty}%`); }
    sql += ` ORDER BY last_name, first_name LIMIT $${idx++} OFFSET $${idx++}`;
    values.push(parseInt(limit), offset);
    const result = await pool.query(sql, values);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /professionals error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/icc/professionals/:id
router.get('/professionals/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const prof = await pool.query('SELECT * FROM professionals WHERE id = $1', [req.params.id]);
      if (prof.rows.length === 0) return res.status(404).json({ error: 'Professional not found' });
      const credentials = await pool.query(
        'SELECT * FROM professional_credentials WHERE professional_id = $1 ORDER BY issued_date DESC',
        [req.params.id]
      );
      const orgs = await pool.query(
        `SELECT poa.*, c.name AS company_name
         FROM professional_org_assignments poa
         JOIN companies c ON c.id = poa.company_id
         WHERE poa.professional_id = $1`,
        [req.params.id]
      );
      const data = prof.rows[0];
      data.credentials = credentials.rows;
      data.assigned_orgs = orgs.rows;
      res.json({ data });
    } catch (err) {
      console.error('GET /professionals/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/icc/professionals
router.post('/professionals',
  [
    body('first_name').trim().notEmpty(),
    body('last_name').trim().notEmpty(),
    body('email').isEmail(),
    body('phone').optional().trim(),
    body('specialty').optional().trim(),
    body('bio').optional().trim(),
    body('title').optional().trim(),
    body('license_number').optional().trim(),
    body('years_experience').optional().isInt({ min: 0 }),
    body('avatar_url').optional().trim(),
    body('languages').optional().isArray(),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        first_name, last_name, email, phone, specialty, bio,
        title, license_number, years_experience, avatar_url, languages
      } = req.body;
      const result = await pool.query(
        `INSERT INTO professionals (id, first_name, last_name, email, phone, specialty, bio,
          title, license_number, years_experience, avatar_url, languages, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', $13) RETURNING *`,
        [
          uuidv4(), first_name, last_name, email, phone || null, specialty || null, bio || null,
          title || null, license_number || null, years_experience || null, avatar_url || null,
          languages ? JSON.stringify(languages) : null, req.iccAdmin.id
        ]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Professional with this email already exists' });
      console.error('POST /professionals error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/icc/professionals/:id
router.patch('/professionals/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const allowed = ['first_name', 'last_name', 'email', 'phone', 'specialty', 'bio', 'title', 'license_number', 'years_experience', 'avatar_url', 'languages', 'status'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(`${key} = $${idx++}`);
          values.push(key === 'languages' ? JSON.stringify(req.body[key]) : req.body[key]);
        }
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No valid fields' });
      values.push(req.params.id);
      const result = await pool.query(
        `UPDATE professionals SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Professional not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /professionals/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/icc/professionals/:id
router.delete('/professionals/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE professionals SET status = 'inactive', updated_at = NOW() WHERE id = $1 RETURNING id`,
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Professional not found' });
      res.json({ message: 'Professional deactivated' });
    } catch (err) {
      console.error('DELETE /professionals/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/icc/professionals/:id/invite - Invite professional
router.post('/professionals/:id/invite',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const prof = await pool.query('SELECT * FROM professionals WHERE id = $1', [req.params.id]);
      if (prof.rows.length === 0) return res.status(404).json({ error: 'Professional not found' });

      const inviteToken = uuidv4();
      await pool.query(
        `UPDATE professionals SET invite_token = $1, invite_sent_at = NOW() WHERE id = $2`,
        [inviteToken, req.params.id]
      );

      const inviteUrl = `${process.env.APP_URL}/professional/onboard?token=${inviteToken}`;
      await sendEmail({
        to: prof.rows[0].email,
        subject: 'Welcome to InterBeing Care Connect - Professional Invitation',
        html: `<p>Hello ${prof.rows[0].first_name},</p>
               <p>You have been invited to join InterBeing Care Connect as a professional.</p>
               <p>Please complete your profile: <a href="${inviteUrl}">${inviteUrl}</a></p>`
      });

      res.json({ message: 'Invitation sent', data: { invite_url: inviteUrl } });
    } catch (err) {
      console.error('POST /professionals/:id/invite error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Professional Credentials ---
router.post('/professionals/:id/credentials',
  [
    param('id').isUUID(),
    body('name').trim().notEmpty(),
    body('issuing_body').optional().trim(),
    body('credential_number').optional().trim(),
    body('issued_date').optional().isISO8601(),
    body('expiry_date').optional().isISO8601(),
    body('document_url').optional().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const { name, issuing_body, credential_number, issued_date, expiry_date, document_url } = req.body;
      const result = await pool.query(
        `INSERT INTO professional_credentials (id, professional_id, name, issuing_body, credential_number, issued_date, expiry_date, document_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [uuidv4(), req.params.id, name, issuing_body || null, credential_number || null, issued_date || null, expiry_date || null, document_url || null]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /professionals/:id/credentials error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.patch('/professionals/credentials/:credId',
  [param('credId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const allowed = ['name', 'issuing_body', 'credential_number', 'issued_date', 'expiry_date', 'document_url', 'status'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) { sets.push(`${key} = $${idx++}`); values.push(req.body[key]); }
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No valid fields' });
      values.push(req.params.credId);
      const result = await pool.query(
        `UPDATE professional_credentials SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Credential not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /professionals/credentials/:credId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/professionals/credentials/:credId',
  [param('credId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM professional_credentials WHERE id = $1 RETURNING id',
        [req.params.credId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Credential not found' });
      res.json({ message: 'Credential deleted' });
    } catch (err) {
      console.error('DELETE /professionals/credentials/:credId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Assign professionals to organizations ---
router.post('/professionals/:id/assign',
  [param('id').isUUID(), body('company_ids').isArray({ min: 1 }), body('company_ids.*').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_ids } = req.body;
      const created = [];
      for (const companyId of company_ids) {
        const existing = await pool.query(
          'SELECT id FROM professional_org_assignments WHERE professional_id = $1 AND company_id = $2',
          [req.params.id, companyId]
        );
        if (existing.rows.length > 0) continue;
        const result = await pool.query(
          `INSERT INTO professional_org_assignments (id, professional_id, company_id, assigned_by)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [uuidv4(), req.params.id, companyId, req.iccAdmin.id]
        );
        created.push(result.rows[0]);
      }
      res.status(201).json({ data: { assigned_count: created.length, assignments: created } });
    } catch (err) {
      console.error('POST /professionals/:id/assign error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/professionals/:id/assign/:companyId',
  [param('id').isUUID(), param('companyId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM professional_org_assignments WHERE professional_id = $1 AND company_id = $2 RETURNING id',
        [req.params.id, req.params.companyId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
      res.json({ message: 'Assignment removed' });
    } catch (err) {
      console.error('DELETE /professionals/:id/assign error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/icc/professionals/:id/cases - View cases across orgs
router.get('/professionals/:id/cases',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT pc.*, c.name AS company_name,
          u.first_name || ' ' || u.last_name AS client_name
         FROM professional_cases pc
         JOIN companies c ON c.id = pc.company_id
         JOIN users u ON u.id = pc.user_id
         WHERE pc.professional_id = $1
         ORDER BY pc.created_at DESC`,
        [req.params.id]
      );
      res.json({ data: result.rows });
    } catch (err) {
      console.error('GET /professionals/:id/cases error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// CHALLENGES
// ============================================================================

// GET /api/icc/challenges
router.get('/challenges', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = `
      SELECT ch.*,
        (SELECT COUNT(*) FROM challenge_modules cm WHERE cm.challenge_id = ch.id) AS module_count,
        (SELECT COUNT(*) FROM challenge_org_assignments coa WHERE coa.challenge_id = ch.id) AS org_count
      FROM challenges ch WHERE 1=1`;
    const values = [];
    let idx = 1;
    if (status) { sql += ` AND ch.status = $${idx++}`; values.push(status); }
    sql += ` ORDER BY ch.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    values.push(parseInt(limit), offset);
    const result = await pool.query(sql, values);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /challenges error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/icc/challenges/:id
router.get('/challenges/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const challenge = await pool.query('SELECT * FROM challenges WHERE id = $1', [req.params.id]);
      if (challenge.rows.length === 0) return res.status(404).json({ error: 'Challenge not found' });
      const modules = await pool.query(
        'SELECT * FROM challenge_modules WHERE challenge_id = $1 ORDER BY sort_order',
        [req.params.id]
      );
      const orgs = await pool.query(
        `SELECT coa.*, c.name AS company_name
         FROM challenge_org_assignments coa JOIN companies c ON c.id = coa.company_id
         WHERE coa.challenge_id = $1`,
        [req.params.id]
      );
      const data = challenge.rows[0];
      data.modules = modules.rows;
      data.assigned_orgs = orgs.rows;
      res.json({ data });
    } catch (err) {
      console.error('GET /challenges/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/icc/challenges
router.post('/challenges',
  [
    body('title').trim().notEmpty(),
    body('description').optional().trim(),
    body('start_date').optional().isISO8601(),
    body('end_date').optional().isISO8601(),
    body('badge_name').optional().trim(),
    body('badge_image_url').optional().trim(),
    body('certificate_template_id').optional().isUUID(),
    body('max_participants').optional().isInt({ min: 1 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { title, description, start_date, end_date, badge_name, badge_image_url, certificate_template_id, max_participants } = req.body;
      const result = await pool.query(
        `INSERT INTO challenges (id, title, description, start_date, end_date, badge_name, badge_image_url,
          certificate_template_id, max_participants, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10) RETURNING *`,
        [uuidv4(), title, description || null, start_date || null, end_date || null, badge_name || null,
         badge_image_url || null, certificate_template_id || null, max_participants || null, req.iccAdmin.id]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /challenges error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/icc/challenges/:id
router.patch('/challenges/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const allowed = ['title', 'description', 'start_date', 'end_date', 'badge_name', 'badge_image_url', 'certificate_template_id', 'max_participants', 'status'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) { sets.push(`${key} = $${idx++}`); values.push(req.body[key]); }
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No valid fields' });
      values.push(req.params.id);
      const result = await pool.query(
        `UPDATE challenges SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Challenge not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /challenges/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/icc/challenges/:id
router.delete('/challenges/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE challenges SET status = 'archived', updated_at = NOW() WHERE id = $1 RETURNING id`,
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Challenge not found' });
      res.json({ message: 'Challenge archived' });
    } catch (err) {
      console.error('DELETE /challenges/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Challenge Modules ---
router.post('/challenges/:id/modules',
  [
    param('id').isUUID(),
    body('title').trim().notEmpty(),
    body('module_type').isIn(['resource', 'activity']),
    body('description').optional().trim(),
    body('resource_id').optional().isUUID(),
    body('activity_instructions').optional().trim(),
    body('evidence_required').optional().isBoolean(),
    body('sort_order').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { title, module_type, description, resource_id, activity_instructions, evidence_required, sort_order } = req.body;
      const result = await pool.query(
        `INSERT INTO challenge_modules (id, challenge_id, title, module_type, description, resource_id,
          activity_instructions, evidence_required, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [uuidv4(), req.params.id, title, module_type, description || null, resource_id || null,
         activity_instructions || null, evidence_required !== undefined ? evidence_required : false, sort_order || 0]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /challenges/:id/modules error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.patch('/challenges/:id/modules/:moduleId',
  [param('id').isUUID(), param('moduleId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const allowed = ['title', 'module_type', 'description', 'resource_id', 'activity_instructions', 'evidence_required', 'sort_order'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) { sets.push(`${key} = $${idx++}`); values.push(req.body[key]); }
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No valid fields' });
      values.push(req.params.moduleId);
      const result = await pool.query(
        `UPDATE challenge_modules SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Module not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /challenges/:id/modules/:moduleId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/challenges/:id/modules/:moduleId',
  [param('id').isUUID(), param('moduleId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM challenge_modules WHERE id = $1 AND challenge_id = $2 RETURNING id',
        [req.params.moduleId, req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Module not found' });
      res.json({ message: 'Module deleted' });
    } catch (err) {
      console.error('DELETE /challenges/:id/modules/:moduleId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Evidence Approval ---
router.get('/challenges/evidence/pending', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ce.*, u.first_name || ' ' || u.last_name AS user_name, u.email,
        c.name AS company_name, ch.title AS challenge_title, cm.title AS module_title
       FROM challenge_evidence ce
       JOIN users u ON u.id = ce.user_id
       JOIN companies c ON c.id = u.company_id
       JOIN challenge_modules cm ON cm.id = ce.module_id
       JOIN challenges ch ON ch.id = cm.challenge_id
       WHERE ce.status = 'pending'
       ORDER BY ce.submitted_at ASC`
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /challenges/evidence/pending error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/challenges/evidence/:evidenceId',
  [
    param('evidenceId').isUUID(),
    body('status').isIn(['approved', 'rejected']),
    body('feedback').optional().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const { status, feedback } = req.body;
      const result = await pool.query(
        `UPDATE challenge_evidence SET status = $1, feedback = $2, reviewed_by = $3, reviewed_at = NOW()
         WHERE id = $4 RETURNING *`,
        [status, feedback || null, req.iccAdmin.id, req.params.evidenceId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Evidence not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /challenges/evidence/:evidenceId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Badges/Certificates ---
router.get('/challenges/:id/badges', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cb.*, u.first_name || ' ' || u.last_name AS user_name, c.name AS company_name
       FROM challenge_badges cb
       JOIN users u ON u.id = cb.user_id
       JOIN companies c ON c.id = u.company_id
       WHERE cb.challenge_id = $1
       ORDER BY cb.awarded_at DESC`,
      [req.params.id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /challenges/:id/badges error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Assign challenges to organizations ---
router.post('/challenges/:id/assign',
  [param('id').isUUID(), body('company_ids').isArray({ min: 1 }), body('company_ids.*').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_ids } = req.body;
      const created = [];
      for (const companyId of company_ids) {
        const existing = await pool.query(
          'SELECT id FROM challenge_org_assignments WHERE challenge_id = $1 AND company_id = $2',
          [req.params.id, companyId]
        );
        if (existing.rows.length > 0) continue;
        const result = await pool.query(
          `INSERT INTO challenge_org_assignments (id, challenge_id, company_id, assigned_by)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [uuidv4(), req.params.id, companyId, req.iccAdmin.id]
        );
        created.push(result.rows[0]);
      }
      res.status(201).json({ data: { assigned_count: created.length, assignments: created } });
    } catch (err) {
      console.error('POST /challenges/:id/assign error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/challenges/:id/assign/:companyId',
  [param('id').isUUID(), param('companyId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM challenge_org_assignments WHERE challenge_id = $1 AND company_id = $2 RETURNING id',
        [req.params.id, req.params.companyId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
      res.json({ message: 'Assignment removed' });
    } catch (err) {
      console.error('DELETE /challenges/:id/assign error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// LEARNING SESSIONS
// ============================================================================

// GET /api/icc/sessions
router.get('/sessions', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = `
      SELECT ls.*,
        (SELECT COUNT(*) FROM session_rsvps sr WHERE sr.session_id = ls.id) AS rsvp_count,
        (SELECT COUNT(*) FROM session_attendances sa WHERE sa.session_id = ls.id) AS attendance_count,
        (SELECT COUNT(*) FROM session_recordings sr WHERE sr.session_id = ls.id) AS recording_count
      FROM learning_sessions ls WHERE 1=1`;
    const values = [];
    let idx = 1;
    if (status) { sql += ` AND ls.status = $${idx++}`; values.push(status); }
    sql += ` ORDER BY ls.scheduled_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    values.push(parseInt(limit), offset);
    const result = await pool.query(sql, values);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/icc/sessions/:id
router.get('/sessions/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const session = await pool.query('SELECT * FROM learning_sessions WHERE id = $1', [req.params.id]);
      if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
      const recordings = await pool.query(
        'SELECT * FROM session_recordings WHERE session_id = $1 ORDER BY created_at',
        [req.params.id]
      );
      const rsvps = await pool.query(
        `SELECT sr.*, u.first_name || ' ' || u.last_name AS user_name, c.name AS company_name
         FROM session_rsvps sr
         JOIN users u ON u.id = sr.user_id
         JOIN companies c ON c.id = u.company_id
         WHERE sr.session_id = $1`,
        [req.params.id]
      );
      const orgs = await pool.query(
        `SELECT soa.*, c.name AS company_name
         FROM session_org_assignments soa JOIN companies c ON c.id = soa.company_id
         WHERE soa.session_id = $1`,
        [req.params.id]
      );
      const data = session.rows[0];
      data.recordings = recordings.rows;
      data.rsvps = rsvps.rows;
      data.assigned_orgs = orgs.rows;
      res.json({ data });
    } catch (err) {
      console.error('GET /sessions/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/icc/sessions
router.post('/sessions',
  [
    body('title').trim().notEmpty(),
    body('description').optional().trim(),
    body('scheduled_at').isISO8601(),
    body('duration_minutes').isInt({ min: 1 }),
    body('host_name').optional().trim(),
    body('meeting_url').optional().trim(),
    body('max_attendees').optional().isInt({ min: 1 }),
    body('session_type').optional().isIn(['webinar', 'workshop', 'seminar', 'group_session']),
  ],
  validate,
  async (req, res) => {
    try {
      const { title, description, scheduled_at, duration_minutes, host_name, meeting_url, max_attendees, session_type } = req.body;
      const result = await pool.query(
        `INSERT INTO learning_sessions (id, title, description, scheduled_at, duration_minutes, host_name,
          meeting_url, max_attendees, session_type, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'scheduled', $10) RETURNING *`,
        [uuidv4(), title, description || null, scheduled_at, duration_minutes, host_name || null,
         meeting_url || null, max_attendees || null, session_type || 'webinar', req.iccAdmin.id]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /sessions error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/icc/sessions/:id
router.patch('/sessions/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const allowed = ['title', 'description', 'scheduled_at', 'duration_minutes', 'host_name', 'meeting_url', 'max_attendees', 'session_type', 'status'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) { sets.push(`${key} = $${idx++}`); values.push(req.body[key]); }
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No valid fields' });
      values.push(req.params.id);
      const result = await pool.query(
        `UPDATE learning_sessions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /sessions/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/icc/sessions/:id
router.delete('/sessions/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE learning_sessions SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING id`,
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
      res.json({ message: 'Session cancelled' });
    } catch (err) {
      console.error('DELETE /sessions/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Session Recordings ---
router.post('/sessions/:id/recordings',
  [
    param('id').isUUID(),
    body('title').trim().notEmpty(),
    body('recording_url').trim().notEmpty(),
    body('duration_minutes').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { title, recording_url, duration_minutes } = req.body;
      const result = await pool.query(
        `INSERT INTO session_recordings (id, session_id, title, recording_url, duration_minutes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [uuidv4(), req.params.id, title, recording_url, duration_minutes || null]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /sessions/:id/recordings error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.patch('/sessions/recordings/:recordingId',
  [param('recordingId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const allowed = ['title', 'recording_url', 'duration_minutes'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) { sets.push(`${key} = $${idx++}`); values.push(req.body[key]); }
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No valid fields' });
      values.push(req.params.recordingId);
      const result = await pool.query(
        `UPDATE session_recordings SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Recording not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /sessions/recordings/:recordingId error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/sessions/recordings/:recordingId',
  [param('recordingId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM session_recordings WHERE id = $1 RETURNING id',
        [req.params.recordingId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Recording not found' });
      res.json({ message: 'Recording deleted' });
    } catch (err) {
      console.error('DELETE /sessions/recordings error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// --- Assign sessions to organizations ---
router.post('/sessions/:id/assign',
  [param('id').isUUID(), body('company_ids').isArray({ min: 1 }), body('company_ids.*').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_ids } = req.body;
      const created = [];
      for (const companyId of company_ids) {
        const existing = await pool.query(
          'SELECT id FROM session_org_assignments WHERE session_id = $1 AND company_id = $2',
          [req.params.id, companyId]
        );
        if (existing.rows.length > 0) continue;
        const result = await pool.query(
          `INSERT INTO session_org_assignments (id, session_id, company_id, assigned_by)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [uuidv4(), req.params.id, companyId, req.iccAdmin.id]
        );
        created.push(result.rows[0]);
      }
      res.status(201).json({ data: { assigned_count: created.length, assignments: created } });
    } catch (err) {
      console.error('POST /sessions/:id/assign error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.delete('/sessions/:id/assign/:companyId',
  [param('id').isUUID(), param('companyId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM session_org_assignments WHERE session_id = $1 AND company_id = $2 RETURNING id',
        [req.params.id, req.params.companyId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Assignment not found' });
      res.json({ message: 'Assignment removed' });
    } catch (err) {
      console.error('DELETE /sessions/:id/assign error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/icc/sessions/:id/attendance - RSVP/attendance stats
router.get('/sessions/:id/attendance',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const rsvps = await pool.query(
        `SELECT sr.*, u.first_name || ' ' || u.last_name AS user_name, c.name AS company_name
         FROM session_rsvps sr JOIN users u ON u.id = sr.user_id JOIN companies c ON c.id = u.company_id
         WHERE sr.session_id = $1 ORDER BY sr.created_at`,
        [req.params.id]
      );
      const attendance = await pool.query(
        `SELECT sa.*, u.first_name || ' ' || u.last_name AS user_name, c.name AS company_name
         FROM session_attendances sa JOIN users u ON u.id = sa.user_id JOIN companies c ON c.id = u.company_id
         WHERE sa.session_id = $1 ORDER BY sa.joined_at`,
        [req.params.id]
      );
      res.json({
        data: {
          rsvp_count: rsvps.rows.length,
          attendance_count: attendance.rows.length,
          rsvps: rsvps.rows,
          attendances: attendance.rows,
        }
      });
    } catch (err) {
      console.error('GET /sessions/:id/attendance error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// EMAIL TEMPLATES (IBL level)
// ============================================================================

// GET /api/icc/email-templates
router.get('/email-templates', async (req, res) => {
  try {
    const { event_trigger } = req.query;
    let sql = 'SELECT id, name, subject, event_trigger, is_active, created_at, updated_at FROM icc_email_templates WHERE 1=1';
    const values = [];
    if (event_trigger) {
      sql += ' AND event_trigger = $1';
      values.push(event_trigger);
    }
    sql += ' ORDER BY name';
    const result = await pool.query(sql, values);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /icc/email-templates error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/icc/email-templates/:id
router.get('/email-templates/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM icc_email_templates WHERE id = $1', [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('GET /icc/email-templates/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/icc/email-templates
router.post('/email-templates',
  [
    body('name').trim().notEmpty(),
    body('subject').trim().notEmpty(),
    body('body_html').trim().notEmpty(),
    body('event_trigger').optional().trim(),
    body('available_tokens').optional().isArray(),
  ],
  validate,
  async (req, res) => {
    try {
      const { name, subject, body_html, event_trigger, available_tokens } = req.body;
      const templateId = uuidv4();
      const result = await pool.query(
        `INSERT INTO icc_email_templates (id, name, subject, body_html, event_trigger, available_tokens, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [templateId, name, subject, body_html, event_trigger || null, available_tokens ? JSON.stringify(available_tokens) : null, req.iccAdmin.id]
      );

      // Create initial version
      await pool.query(
        `INSERT INTO icc_email_template_versions (id, template_id, version, subject, body_html, created_by)
         VALUES ($1, $2, 1, $3, $4, $5)`,
        [uuidv4(), templateId, subject, body_html, req.iccAdmin.id]
      );

      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /icc/email-templates error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/icc/email-templates/:id
router.patch('/email-templates/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const existing = await client.query('SELECT * FROM icc_email_templates WHERE id = $1', [id]);
      if (existing.rows.length === 0) return res.status(404).json({ error: 'Template not found' });

      await client.query('BEGIN');

      const allowed = ['name', 'subject', 'body_html', 'event_trigger', 'available_tokens', 'is_active'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(`${key} = $${idx++}`);
          values.push(key === 'available_tokens' ? JSON.stringify(req.body[key]) : req.body[key]);
        }
      }
      if (sets.length > 0) {
        values.push(id);
        await client.query(
          `UPDATE icc_email_templates SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
          values
        );
      }

      if (req.body.subject || req.body.body_html) {
        const maxVersion = await client.query(
          'SELECT COALESCE(MAX(version), 0) AS max_v FROM icc_email_template_versions WHERE template_id = $1',
          [id]
        );
        await client.query(
          `INSERT INTO icc_email_template_versions (id, template_id, version, subject, body_html, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [uuidv4(), id, parseInt(maxVersion.rows[0].max_v) + 1,
           req.body.subject || existing.rows[0].subject,
           req.body.body_html || existing.rows[0].body_html,
           req.iccAdmin.id]
        );
      }

      await client.query('COMMIT');
      const updated = await pool.query('SELECT * FROM icc_email_templates WHERE id = $1', [id]);
      res.json({ data: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('PATCH /icc/email-templates/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// DELETE /api/icc/email-templates/:id
router.delete('/email-templates/:id',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        'UPDATE icc_email_templates SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id',
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
      res.json({ message: 'Template deactivated' });
    } catch (err) {
      console.error('DELETE /icc/email-templates/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/icc/email-templates/:id/versions
router.get('/email-templates/:id/versions',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT v.*, a.first_name || ' ' || a.last_name AS created_by_name
         FROM icc_email_template_versions v
         LEFT JOIN icc_admins a ON a.id = v.created_by
         WHERE v.template_id = $1 ORDER BY v.version DESC`,
        [req.params.id]
      );
      res.json({ data: result.rows });
    } catch (err) {
      console.error('GET /icc/email-templates/:id/versions error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/icc/email-templates/:id/revert/:versionId
router.post('/email-templates/:id/revert/:versionId',
  [param('id').isUUID(), param('versionId').isUUID()],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { id, versionId } = req.params;
      const version = await client.query(
        'SELECT * FROM icc_email_template_versions WHERE id = $1 AND template_id = $2',
        [versionId, id]
      );
      if (version.rows.length === 0) return res.status(404).json({ error: 'Version not found' });

      await client.query('BEGIN');
      await client.query(
        'UPDATE icc_email_templates SET subject = $1, body_html = $2, updated_at = NOW() WHERE id = $3',
        [version.rows[0].subject, version.rows[0].body_html, id]
      );
      const maxVersion = await client.query(
        'SELECT COALESCE(MAX(version), 0) AS max_v FROM icc_email_template_versions WHERE template_id = $1',
        [id]
      );
      await client.query(
        `INSERT INTO icc_email_template_versions (id, template_id, version, subject, body_html, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv4(), id, parseInt(maxVersion.rows[0].max_v) + 1, version.rows[0].subject, version.rows[0].body_html, req.iccAdmin.id]
      );
      await client.query('COMMIT');

      const updated = await pool.query('SELECT * FROM icc_email_templates WHERE id = $1', [id]);
      res.json({ data: updated.rows[0], message: `Reverted to version ${version.rows[0].version}` });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /icc/email-templates/:id/revert error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// --- Event trigger mapping ---
router.get('/email-templates/triggers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT event_trigger, COUNT(*) AS template_count
       FROM icc_email_templates WHERE event_trigger IS NOT NULL AND is_active = true
       GROUP BY event_trigger ORDER BY event_trigger`
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /email-templates/triggers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Token library ---
router.get('/email-templates/tokens', async (req, res) => {
  try {
    // Return predefined token library
    res.json({
      data: [
        { token: '{{user.first_name}}', description: 'User first name' },
        { token: '{{user.last_name}}', description: 'User last name' },
        { token: '{{user.email}}', description: 'User email address' },
        { token: '{{company.name}}', description: 'Company name' },
        { token: '{{company.code}}', description: 'Company code' },
        { token: '{{indicator.title}}', description: 'Indicator title' },
        { token: '{{challenge.title}}', description: 'Challenge title' },
        { token: '{{session.title}}', description: 'Session title' },
        { token: '{{session.date}}', description: 'Session scheduled date' },
        { token: '{{professional.name}}', description: 'Professional full name' },
        { token: '{{app.url}}', description: 'Application URL' },
        { token: '{{current.date}}', description: 'Current date' },
      ]
    });
  } catch (err) {
    console.error('GET /email-templates/tokens error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Send test email ---
router.post('/email-templates/:id/test',
  [param('id').isUUID(), body('to_email').isEmail()],
  validate,
  async (req, res) => {
    try {
      const template = await pool.query('SELECT * FROM icc_email_templates WHERE id = $1', [req.params.id]);
      if (template.rows.length === 0) return res.status(404).json({ error: 'Template not found' });

      const { to_email } = req.body;
      const t = template.rows[0];

      // Replace tokens with sample data
      let subject = t.subject.replace(/\{\{[^}]+\}\}/g, '[Sample Data]');
      let html = t.body_html.replace(/\{\{[^}]+\}\}/g, '[Sample Data]');

      await sendEmail({ to: to_email, subject: `[TEST] ${subject}`, html });
      res.json({ message: `Test email sent to ${to_email}` });
    } catch (err) {
      console.error('POST /email-templates/:id/test error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// ANALYTICS
// ============================================================================

// GET /api/icc/analytics/overview - Platform-wide stats
router.get('/analytics/overview', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM companies WHERE status = 'active') AS active_organizations,
        (SELECT COUNT(*) FROM users WHERE is_active = true) AS active_users,
        (SELECT COUNT(*) FROM indicators WHERE status = 'published') AS published_indicators,
        (SELECT COUNT(*) FROM resource_topics WHERE is_active = true) AS active_topics,
        (SELECT COUNT(*) FROM challenges WHERE status IN ('active', 'published')) AS active_challenges,
        (SELECT COUNT(*) FROM professionals WHERE status = 'active') AS active_professionals,
        (SELECT COUNT(*) FROM learning_sessions WHERE status = 'scheduled' AND scheduled_at > NOW()) AS upcoming_sessions,
        (SELECT COUNT(*) FROM indicator_completions WHERE completed_at >= NOW() - INTERVAL '30 days') AS indicator_completions_30d
    `);
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('GET /analytics/overview error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/icc/analytics/indicators - Indicator completion rates
router.get('/analytics/indicators', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.id, i.title, i.status,
        COUNT(ic.id) AS total_completions,
        COUNT(DISTINCT ic.user_id) AS unique_users,
        ROUND(AVG(ic.total_score)::numeric, 2) AS avg_score,
        COUNT(ic.id) FILTER (WHERE ic.completed_at >= NOW() - INTERVAL '30 days') AS completions_30d
      FROM indicators i
      LEFT JOIN indicator_completions ic ON ic.indicator_id = i.id
      WHERE i.status = 'published'
      GROUP BY i.id, i.title, i.status
      ORDER BY total_completions DESC
    `);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /analytics/indicators error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/icc/analytics/resources - Resource engagement
router.get('/analytics/resources', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.id, t.title, c.name AS category_name,
        COUNT(DISTINCT re.user_id) AS unique_users,
        COUNT(re.id) AS total_interactions,
        COUNT(re.id) FILTER (WHERE re.completed = true) AS completions,
        ROUND(AVG(re.time_spent_seconds)::numeric, 0) AS avg_time_seconds
      FROM resource_topics t
      LEFT JOIN resource_topic_categories c ON c.id = t.category_id
      LEFT JOIN resource_milestones rm ON rm.topic_id = t.id
      LEFT JOIN resource_lessons rl ON rl.milestone_id = rm.id
      LEFT JOIN resource_items ri ON ri.lesson_id = rl.id
      LEFT JOIN resource_engagements re ON re.resource_item_id = ri.id
      WHERE t.is_active = true
      GROUP BY t.id, t.title, c.name
      ORDER BY unique_users DESC
    `);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /analytics/resources error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/icc/analytics/challenges - Challenge participation
router.get('/analytics/challenges', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ch.id, ch.title, ch.status,
        (SELECT COUNT(DISTINCT cp.user_id) FROM challenge_participations cp WHERE cp.challenge_id = ch.id) AS participants,
        (SELECT COUNT(*) FROM challenge_evidence ce
         JOIN challenge_modules cm ON cm.id = ce.module_id
         WHERE cm.challenge_id = ch.id AND ce.status = 'approved') AS approved_evidence,
        (SELECT COUNT(*) FROM challenge_badges cb WHERE cb.challenge_id = ch.id) AS badges_awarded
      FROM challenges ch
      WHERE ch.status != 'archived'
      ORDER BY participants DESC
    `);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /analytics/challenges error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/icc/analytics/professionals - Professional case stats
router.get('/analytics/professionals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.first_name, p.last_name, p.specialty, p.status,
        COUNT(pc.id) AS total_cases,
        COUNT(pc.id) FILTER (WHERE pc.status = 'active') AS active_cases,
        COUNT(pc.id) FILTER (WHERE pc.status = 'completed') AS completed_cases,
        COUNT(DISTINCT pc.company_id) AS org_count,
        ROUND(AVG(pc.rating)::numeric, 2) AS avg_rating
      FROM professionals p
      LEFT JOIN professional_cases pc ON pc.professional_id = p.id
      WHERE p.status = 'active'
      GROUP BY p.id, p.first_name, p.last_name, p.specialty, p.status
      ORDER BY total_cases DESC
    `);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /analytics/professionals error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
