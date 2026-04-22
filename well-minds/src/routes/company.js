const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireAdmin, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { sendEmail } = require('../utils/email');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// All routes require authentication
router.use(authenticate);

// ============================================================================
// COMPANY SETUP
// ============================================================================

// GET /api/company - Get company info with user counts, module subscriptions
router.get('/', async (req, res) => {
  try {
    const { company_id } = req.user;
    const companyResult = await pool.query(
      `SELECT c.*,
        (SELECT COUNT(*) FROM users WHERE company_id = c.id AND is_active = true) AS active_user_count,
        (SELECT COUNT(*) FROM users WHERE company_id = c.id) AS total_user_count
       FROM companies c WHERE c.id = $1`,
      [company_id]
    );
    if (companyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    const modulesResult = await pool.query(
      `SELECT module_name, is_enabled, subscribed_at, expires_at
       FROM company_modules WHERE company_id = $1 ORDER BY module_name`,
      [company_id]
    );
    const company = companyResult.rows[0];
    company.modules = modulesResult.rows;
    // Strip sensitive SMTP fields for non-admins
    if (req.user.role !== 'admin') {
      delete company.smtp_password;
    }
    res.json({ data: company });
  } catch (err) {
    console.error('GET /api/company error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/company - Update company details (admin)
router.patch('/',
  requireAdmin,
  [
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
    body('code').optional().trim().notEmpty(),
    body('phone').optional().trim(),
    body('website').optional().trim(),
    body('description').optional().trim(),
    body('address').optional().trim(),
    body('logo_url').optional().trim(),
    body('banner_url').optional().trim(),
    body('timezone').optional().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const allowed = ['name', 'code', 'phone', 'website', 'description', 'address', 'logo_url', 'banner_url', 'timezone'];
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
      values.push(company_id);
      const result = await pool.query(
        `UPDATE companies SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`,
        values
      );
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /api/company error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/company/stats - Dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const { company_id } = req.user;
    const stats = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM users WHERE company_id = $1 AND is_active = true) AS active_users,
        (SELECT COUNT(*) FROM users WHERE company_id = $1) AS total_users,
        (SELECT COUNT(*) FROM departments WHERE company_id = $1 AND is_active = true) AS department_count,
        (SELECT COUNT(*) FROM business_units WHERE company_id = $1 AND is_active = true) AS business_unit_count,
        (SELECT COUNT(*) FROM users WHERE company_id = $1 AND created_at >= NOW() - INTERVAL '30 days') AS new_users_30d,
        (SELECT COUNT(*) FROM connect_cycles WHERE company_id = $1 AND status = 'active') AS active_cycles`,
      [company_id]
    );
    res.json({ data: stats.rows[0] });
  } catch (err) {
    console.error('GET /api/company/stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/company/smtp - Update SMTP config (admin)
router.patch('/smtp',
  requireAdmin,
  [
    body('smtp_host').optional().trim(),
    body('smtp_port').optional().isInt({ min: 1, max: 65535 }),
    body('smtp_user').optional().trim(),
    body('smtp_password').optional().trim(),
    body('smtp_from_email').optional().isEmail(),
    body('smtp_from_name').optional().trim(),
    body('smtp_provider').optional().trim(),
    body('business_email').optional().isEmail(),
    body('smtp_ssl').optional().isBoolean(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const allowed = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_password', 'smtp_from_email', 'smtp_from_name', 'smtp_provider', 'business_email', 'smtp_ssl'];
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
      values.push(company_id);
      const result = await pool.query(
        `UPDATE companies SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING
          smtp_host, smtp_port, smtp_user, smtp_from_email, smtp_from_name, smtp_provider, business_email, smtp_ssl`,
        values
      );
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /api/company/smtp error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/company/theme - Get theme configuration
router.get('/theme', async (req, res) => {
  try {
    const { company_id } = req.user;
    const result = await pool.query(
      `SELECT primary_color, secondary_color, bg_color, fg_color, font_colors, button_styles, status_colors, table_styling
       FROM company_themes WHERE company_id = $1`,
      [company_id]
    );
    res.json({ data: result.rows[0] || {} });
  } catch (err) {
    console.error('GET /api/company/theme error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/company/theme - Update theme (admin)
router.patch('/theme',
  requireAdmin,
  [
    body('primary_color').optional().trim(),
    body('secondary_color').optional().trim(),
    body('bg_color').optional().trim(),
    body('fg_color').optional().trim(),
    body('font_colors').optional().isObject(),
    body('button_styles').optional().isObject(),
    body('status_colors').optional().isObject(),
    body('table_styling').optional().isObject(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const allowed = ['primary_color', 'secondary_color', 'bg_color', 'fg_color', 'font_colors', 'button_styles', 'status_colors', 'table_styling'];
      const fields = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          fields[key] = req.body[key];
        }
      }
      if (Object.keys(fields).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }
      const columns = Object.keys(fields);
      const values = Object.values(fields);
      const placeholders = columns.map((_, i) => `$${i + 2}`);
      const updateSets = columns.map((col, i) => `${col} = $${i + 2}`);

      const result = await pool.query(
        `INSERT INTO company_themes (company_id, ${columns.join(', ')})
         VALUES ($1, ${placeholders.join(', ')})
         ON CONFLICT (company_id) DO UPDATE SET ${updateSets.join(', ')}, updated_at = NOW()
         RETURNING *`,
        [company_id, ...values]
      );
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /api/company/theme error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/company/connect-config - Get connect configurations
router.get('/connect-config', async (req, res) => {
  try {
    const { company_id } = req.user;
    const result = await pool.query(
      `SELECT * FROM connect_configurations WHERE company_id = $1 ORDER BY module_type`,
      [company_id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/company/connect-config error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/company/connect-config/:moduleType - Update connect config (admin)
router.patch('/connect-config/:moduleType',
  requireAdmin,
  [
    param('moduleType').isIn(['performance', 'development', 'wellbeing']),
    body('consolidation').optional().trim(),
    body('reflection_type').optional().trim(),
    body('weights').optional().isObject(),
    body('deadlines').optional().isObject(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { moduleType } = req.params;
      const { consolidation, reflection_type, weights, deadlines } = req.body;

      // Validate weights sum to 100 if provided
      if (weights) {
        const total = Object.values(weights).reduce((sum, val) => sum + Number(val), 0);
        if (Math.abs(total - 100) > 0.01) {
          return res.status(400).json({ error: 'Weights must total 100%', current_total: total });
        }
      }

      const result = await pool.query(
        `INSERT INTO connect_configurations (id, company_id, module_type, consolidation, reflection_type, weights, deadlines)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (company_id, module_type) DO UPDATE SET
           consolidation = COALESCE($4, connect_configurations.consolidation),
           reflection_type = COALESCE($5, connect_configurations.reflection_type),
           weights = COALESCE($6, connect_configurations.weights),
           deadlines = COALESCE($7, connect_configurations.deadlines),
           updated_at = NOW()
         RETURNING *`,
        [uuidv4(), company_id, moduleType, consolidation || null, reflection_type || null, weights ? JSON.stringify(weights) : null, deadlines ? JSON.stringify(deadlines) : null]
      );
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /api/company/connect-config error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/company/modules - List module subscriptions
router.get('/modules', async (req, res) => {
  try {
    const { company_id } = req.user;
    const result = await pool.query(
      `SELECT id, module_name, is_enabled, subscribed_at, expires_at, config
       FROM company_modules WHERE company_id = $1 ORDER BY module_name`,
      [company_id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/company/modules error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/company/modules/:moduleName - Enable/disable module (admin)
router.patch('/modules/:moduleName',
  requireAdmin,
  [
    param('moduleName').trim().notEmpty(),
    body('is_enabled').isBoolean(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { moduleName } = req.params;
      const { is_enabled } = req.body;

      const result = await pool.query(
        `UPDATE company_modules SET is_enabled = $1, updated_at = NOW()
         WHERE company_id = $2 AND module_name = $3 RETURNING *`,
        [is_enabled, company_id, moduleName]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Module subscription not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /api/company/modules error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// STAFF MANAGEMENT - ROLES & PERMISSIONS
// ============================================================================

// GET /api/company/roles - List custom roles
router.get('/roles', async (req, res) => {
  try {
    const { company_id } = req.user;
    const result = await pool.query(
      `SELECT r.*,
        (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count
       FROM roles r WHERE r.company_id = $1 ORDER BY r.is_system DESC, r.name`,
      [company_id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/company/roles error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/company/roles - Create role with permissions matrix (admin)
router.post('/roles',
  requireAdmin,
  [
    body('name').trim().notEmpty().withMessage('Role name is required'),
    body('description').optional().trim(),
    body('permissions').isArray().withMessage('Permissions array is required'),
    body('permissions.*.module').notEmpty(),
    body('permissions.*.enabled').isBoolean(),
    body('permissions.*.can_view').optional().isBoolean(),
    body('permissions.*.can_add').optional().isBoolean(),
    body('permissions.*.can_edit').optional().isBoolean(),
    body('permissions.*.can_delete').optional().isBoolean(),
  ],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { company_id } = req.user;
      const { name, description, permissions } = req.body;
      await client.query('BEGIN');

      const roleId = uuidv4();
      const roleResult = await client.query(
        `INSERT INTO roles (id, company_id, name, description, is_system)
         VALUES ($1, $2, $3, $4, false) RETURNING *`,
        [roleId, company_id, name, description || null]
      );

      for (const perm of permissions) {
        await client.query(
          `INSERT INTO role_permissions (id, role_id, module, enabled, can_view, can_add, can_edit, can_delete)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            uuidv4(), roleId, perm.module, perm.enabled,
            perm.can_view !== undefined ? perm.can_view : false,
            perm.can_add !== undefined ? perm.can_add : false,
            perm.can_edit !== undefined ? perm.can_edit : false,
            perm.can_delete !== undefined ? perm.can_delete : false,
          ]
        );
      }

      await client.query('COMMIT');
      const role = roleResult.rows[0];
      role.permissions = permissions;
      res.status(201).json({ data: role });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /api/company/roles error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// PATCH /api/company/roles/:id - Update role + permissions (admin)
router.patch('/roles/:id',
  requireAdmin,
  [
    param('id').isUUID(),
    body('name').optional().trim().notEmpty(),
    body('description').optional().trim(),
    body('permissions').optional().isArray(),
  ],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const { name, description, permissions } = req.body;

      await client.query('BEGIN');

      // Verify role belongs to company and is not system
      const existing = await client.query(
        'SELECT * FROM roles WHERE id = $1 AND company_id = $2',
        [id, company_id]
      );
      if (existing.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Role not found' });
      }
      if (existing.rows[0].is_system) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Cannot modify system roles' });
      }

      const sets = [];
      const values = [];
      let idx = 1;
      if (name !== undefined) { sets.push(`name = $${idx++}`); values.push(name); }
      if (description !== undefined) { sets.push(`description = $${idx++}`); values.push(description); }

      if (sets.length > 0) {
        values.push(id);
        await client.query(
          `UPDATE roles SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
          values
        );
      }

      if (permissions && permissions.length > 0) {
        await client.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
        for (const perm of permissions) {
          await client.query(
            `INSERT INTO role_permissions (id, role_id, module, enabled, can_view, can_add, can_edit, can_delete)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              uuidv4(), id, perm.module, perm.enabled,
              perm.can_view || false, perm.can_add || false,
              perm.can_edit || false, perm.can_delete || false,
            ]
          );
        }
      }

      await client.query('COMMIT');
      const updated = await pool.query('SELECT * FROM roles WHERE id = $1', [id]);
      const perms = await pool.query('SELECT * FROM role_permissions WHERE role_id = $1', [id]);
      const role = updated.rows[0];
      role.permissions = perms.rows;
      res.json({ data: role });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('PATCH /api/company/roles/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// DELETE /api/company/roles/:id - Delete non-system role (admin)
router.delete('/roles/:id',
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const existing = await pool.query(
        'SELECT * FROM roles WHERE id = $1 AND company_id = $2',
        [id, company_id]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Role not found' });
      }
      if (existing.rows[0].is_system) {
        return res.status(403).json({ error: 'Cannot delete system roles' });
      }
      // Check if role is assigned to users
      const assigned = await pool.query(
        'SELECT COUNT(*) FROM user_roles WHERE role_id = $1',
        [id]
      );
      if (parseInt(assigned.rows[0].count) > 0) {
        return res.status(409).json({ error: 'Role is assigned to users. Remove assignments first.' });
      }
      await pool.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      await pool.query('DELETE FROM roles WHERE id = $1', [id]);
      res.json({ message: 'Role deleted successfully' });
    } catch (err) {
      console.error('DELETE /api/company/roles/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/company/roles/:id/permissions - Get role's permission matrix
router.get('/roles/:id/permissions',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const role = await pool.query(
        'SELECT * FROM roles WHERE id = $1 AND company_id = $2',
        [id, company_id]
      );
      if (role.rows.length === 0) {
        return res.status(404).json({ error: 'Role not found' });
      }
      const perms = await pool.query(
        'SELECT * FROM role_permissions WHERE role_id = $1 ORDER BY module',
        [id]
      );
      res.json({ data: { role: role.rows[0], permissions: perms.rows } });
    } catch (err) {
      console.error('GET /api/company/roles/:id/permissions error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/company/user-roles - Assign role to user (admin)
router.post('/user-roles',
  requireAdmin,
  [
    body('user_id').isUUID(),
    body('role_id').isUUID(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { user_id, role_id } = req.body;

      // Verify user belongs to company
      const user = await pool.query(
        'SELECT id FROM users WHERE id = $1 AND company_id = $2',
        [user_id, company_id]
      );
      if (user.rows.length === 0) {
        return res.status(404).json({ error: 'User not found in company' });
      }
      // Verify role belongs to company
      const role = await pool.query(
        'SELECT id FROM roles WHERE id = $1 AND company_id = $2',
        [role_id, company_id]
      );
      if (role.rows.length === 0) {
        return res.status(404).json({ error: 'Role not found in company' });
      }
      // Check for duplicate
      const existing = await pool.query(
        'SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2',
        [user_id, role_id]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Role already assigned to user' });
      }

      const result = await pool.query(
        `INSERT INTO user_roles (id, user_id, role_id, assigned_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [uuidv4(), user_id, role_id, req.user.id]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /api/company/user-roles error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/company/user-roles/:userId/:roleId - Remove role from user (admin)
router.delete('/user-roles/:userId/:roleId',
  requireAdmin,
  [
    param('userId').isUUID(),
    param('roleId').isUUID(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { userId, roleId } = req.params;

      // Verify user belongs to company
      const user = await pool.query(
        'SELECT id FROM users WHERE id = $1 AND company_id = $2',
        [userId, company_id]
      );
      if (user.rows.length === 0) {
        return res.status(404).json({ error: 'User not found in company' });
      }

      const result = await pool.query(
        'DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2 RETURNING id',
        [userId, roleId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Role assignment not found' });
      }
      res.json({ message: 'Role removed from user' });
    } catch (err) {
      console.error('DELETE /api/company/user-roles error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// STAFF MANAGEMENT - BUSINESS UNITS
// ============================================================================

// GET /api/company/business-units
router.get('/business-units', async (req, res) => {
  try {
    const { company_id } = req.user;
    const result = await pool.query(
      `SELECT bu.*,
        (SELECT COUNT(*) FROM users u WHERE u.business_unit_id = bu.id AND u.is_active = true) AS employee_count
       FROM business_units bu WHERE bu.company_id = $1 AND bu.is_active = true ORDER BY bu.name`,
      [company_id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/company/business-units error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/company/business-units (admin)
router.post('/business-units',
  requireAdmin,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('code').optional().trim(),
    body('description').optional().trim(),
    body('head_user_id').optional().isUUID(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { name, code, description, head_user_id } = req.body;
      const result = await pool.query(
        `INSERT INTO business_units (id, company_id, name, code, description, head_user_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [uuidv4(), company_id, name, code || null, description || null, head_user_id || null]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Business unit with this name or code already exists' });
      }
      console.error('POST /api/company/business-units error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/company/business-units/:id (admin)
router.patch('/business-units/:id',
  requireAdmin,
  [
    param('id').isUUID(),
    body('name').optional().trim().notEmpty(),
    body('code').optional().trim(),
    body('description').optional().trim(),
    body('head_user_id').optional().isUUID(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const allowed = ['name', 'code', 'description', 'head_user_id'];
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
      values.push(id, company_id);
      const result = await pool.query(
        `UPDATE business_units SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
        values
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Business unit not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /api/company/business-units/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/company/business-units/:id (admin)
router.delete('/business-units/:id',
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const result = await pool.query(
        `UPDATE business_units SET is_active = false, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 RETURNING id`,
        [id, company_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Business unit not found' });
      }
      res.json({ message: 'Business unit deactivated' });
    } catch (err) {
      console.error('DELETE /api/company/business-units/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// STAFF MANAGEMENT - DEPARTMENTS
// ============================================================================

// GET /api/company/departments
router.get('/departments', async (req, res) => {
  try {
    const { company_id } = req.user;
    const { business_unit_id } = req.query;
    let sql = `
      SELECT d.*, bu.name AS business_unit_name,
        (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.is_active = true) AS user_count
      FROM departments d
      LEFT JOIN business_units bu ON bu.id = d.business_unit_id
      WHERE d.company_id = $1 AND d.is_active = true`;
    const values = [company_id];

    if (business_unit_id) {
      sql += ' AND d.business_unit_id = $2';
      values.push(business_unit_id);
    }
    sql += ' ORDER BY d.name';

    const result = await pool.query(sql, values);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/company/departments error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/company/departments (admin)
router.post('/departments',
  requireAdmin,
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('code').optional().trim(),
    body('business_unit_id').optional().isUUID(),
    body('head_user_id').optional().isUUID(),
    body('description').optional().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { name, code, business_unit_id, head_user_id, description } = req.body;
      const result = await pool.query(
        `INSERT INTO departments (id, company_id, name, code, business_unit_id, head_user_id, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [uuidv4(), company_id, name, code || null, business_unit_id || null, head_user_id || null, description || null]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Department with this name or code already exists' });
      }
      console.error('POST /api/company/departments error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/company/departments/:id (admin)
router.patch('/departments/:id',
  requireAdmin,
  [
    param('id').isUUID(),
    body('name').optional().trim().notEmpty(),
    body('code').optional().trim(),
    body('business_unit_id').optional().isUUID(),
    body('head_user_id').optional().isUUID(),
    body('description').optional().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const allowed = ['name', 'code', 'business_unit_id', 'head_user_id', 'description'];
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
      values.push(id, company_id);
      const result = await pool.query(
        `UPDATE departments SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
        values
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Department not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /api/company/departments/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/company/departments/:id (admin)
router.delete('/departments/:id',
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const result = await pool.query(
        `UPDATE departments SET is_active = false, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 RETURNING id`,
        [id, company_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Department not found' });
      }
      res.json({ message: 'Department deactivated' });
    } catch (err) {
      console.error('DELETE /api/company/departments/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// STAFF MANAGEMENT - JOB LEVELS
// ============================================================================

// GET /api/company/job-levels
router.get('/job-levels', async (req, res) => {
  try {
    const { company_id } = req.user;
    const result = await pool.query(
      `SELECT jl.*,
        (SELECT COUNT(*) FROM users u WHERE u.job_level_id = jl.id AND u.is_active = true) AS user_count
       FROM job_levels jl WHERE jl.company_id = $1 AND jl.is_active = true ORDER BY jl.sort_order, jl.name`,
      [company_id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/company/job-levels error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/company/job-levels (admin)
router.post('/job-levels',
  requireAdmin,
  [
    body('code').trim().notEmpty().withMessage('Code is required'),
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('description').optional().trim(),
    body('framework').optional().trim(),
    body('sort_order').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { code, name, description, framework, sort_order } = req.body;
      const result = await pool.query(
        `INSERT INTO job_levels (id, company_id, code, name, description, framework, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [uuidv4(), company_id, code, name, description || null, framework || null, sort_order || 0]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Job level with this code already exists' });
      }
      console.error('POST /api/company/job-levels error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/company/job-levels/:id (admin)
router.patch('/job-levels/:id',
  requireAdmin,
  [
    param('id').isUUID(),
    body('code').optional().trim().notEmpty(),
    body('name').optional().trim().notEmpty(),
    body('description').optional().trim(),
    body('framework').optional().trim(),
    body('sort_order').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const allowed = ['code', 'name', 'description', 'framework', 'sort_order'];
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
      values.push(id, company_id);
      const result = await pool.query(
        `UPDATE job_levels SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} AND company_id = $${idx + 1} AND is_active = true RETURNING *`,
        values
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Job level not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /api/company/job-levels/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/company/job-levels/:id - Deactivate (admin)
router.delete('/job-levels/:id',
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const result = await pool.query(
        `UPDATE job_levels SET is_active = false, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 RETURNING id`,
        [id, company_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Job level not found' });
      }
      res.json({ message: 'Job level deactivated' });
    } catch (err) {
      console.error('DELETE /api/company/job-levels/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// STAFF MANAGEMENT - EMPLOYEE SETUP
// ============================================================================

// POST /api/company/employees - Create single employee (admin)
router.post('/employees',
  requireAdmin,
  [
    body('employee_code').trim().notEmpty().withMessage('Employee code is required'),
    body('first_name').trim().notEmpty().withMessage('First name is required'),
    body('last_name').trim().notEmpty().withMessage('Last name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('business_unit_id').optional().isUUID(),
    body('department_id').optional().isUUID(),
    body('job_level_id').optional().isUUID(),
    body('role_id').optional().isUUID(),
    body('manager_id').optional().isUUID(),
    body('phone').optional().trim(),
    body('hire_date').optional().isISO8601(),
  ],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { company_id } = req.user;
      const {
        employee_code, first_name, last_name, email,
        business_unit_id, department_id, job_level_id, role_id,
        manager_id, phone, hire_date
      } = req.body;

      await client.query('BEGIN');

      // Check duplicate email
      const existingEmail = await client.query(
        'SELECT id FROM users WHERE email = $1 AND company_id = $2',
        [email, company_id]
      );
      if (existingEmail.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Email already exists in company' });
      }

      // Check duplicate code
      const existingCode = await client.query(
        'SELECT id FROM users WHERE employee_code = $1 AND company_id = $2',
        [employee_code, company_id]
      );
      if (existingCode.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Employee code already exists' });
      }

      // Generate temp password
      const tempPassword = uuidv4().slice(0, 12);
      const hashedPassword = await bcrypt.hash(tempPassword, 12);

      const userId = uuidv4();
      const userResult = await client.query(
        `INSERT INTO users (id, company_id, employee_code, first_name, last_name, email, password_hash,
          business_unit_id, department_id, job_level_id, manager_id, phone, hire_date, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true) RETURNING
          id, employee_code, first_name, last_name, email, business_unit_id, department_id,
          job_level_id, manager_id, phone, hire_date, is_active, created_at`,
        [
          userId, company_id, employee_code, first_name, last_name, email, hashedPassword,
          business_unit_id || null, department_id || null, job_level_id || null,
          manager_id || null, phone || null, hire_date || null
        ]
      );

      // Assign role if provided
      if (role_id) {
        await client.query(
          `INSERT INTO user_roles (id, user_id, role_id, assigned_by) VALUES ($1, $2, $3, $4)`,
          [uuidv4(), userId, role_id, req.user.id]
        );
      }

      await client.query('COMMIT');

      // Send welcome email (non-blocking)
      sendEmail({
        to: email,
        subject: 'Welcome to InterBeing Care Connect',
        html: `<p>Hello ${first_name},</p>
               <p>Your account has been created. Your temporary password is: <strong>${tempPassword}</strong></p>
               <p>Please login and change your password immediately.</p>`
      }).catch(err => console.error('Welcome email error:', err));

      res.status(201).json({ data: userResult.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /api/company/employees error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// POST /api/company/employees/bulk - Bulk upload (admin)
router.post('/employees/bulk',
  requireAdmin,
  [
    body('employees').isArray({ min: 1 }).withMessage('Employees array is required'),
    body('employees.*.employee_code').trim().notEmpty(),
    body('employees.*.first_name').trim().notEmpty(),
    body('employees.*.last_name').trim().notEmpty(),
    body('employees.*.email').isEmail(),
  ],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { company_id } = req.user;
      const { employees } = req.body;
      const errors = [];
      const created = [];

      // Pre-validate: check duplicates within batch
      const emailSet = new Set();
      const codeSet = new Set();
      for (let i = 0; i < employees.length; i++) {
        const emp = employees[i];
        if (emailSet.has(emp.email.toLowerCase())) {
          errors.push({ row: i + 1, field: 'email', message: `Duplicate email in batch: ${emp.email}` });
        }
        emailSet.add(emp.email.toLowerCase());
        if (codeSet.has(emp.employee_code)) {
          errors.push({ row: i + 1, field: 'employee_code', message: `Duplicate code in batch: ${emp.employee_code}` });
        }
        codeSet.add(emp.employee_code);
      }

      // Check against existing records
      const existingEmails = await client.query(
        'SELECT email FROM users WHERE company_id = $1 AND email = ANY($2)',
        [company_id, Array.from(emailSet)]
      );
      for (const row of existingEmails.rows) {
        errors.push({ field: 'email', message: `Email already exists: ${row.email}` });
      }

      const existingCodes = await client.query(
        'SELECT employee_code FROM users WHERE company_id = $1 AND employee_code = ANY($2)',
        [company_id, Array.from(codeSet)]
      );
      for (const row of existingCodes.rows) {
        errors.push({ field: 'employee_code', message: `Code already exists: ${row.employee_code}` });
      }

      if (errors.length > 0) {
        return res.status(400).json({ error: 'Validation errors', details: errors });
      }

      await client.query('BEGIN');

      for (const emp of employees) {
        const tempPassword = uuidv4().slice(0, 12);
        const hashedPassword = await bcrypt.hash(tempPassword, 12);
        const userId = uuidv4();

        const result = await client.query(
          `INSERT INTO users (id, company_id, employee_code, first_name, last_name, email, password_hash,
            business_unit_id, department_id, job_level_id, manager_id, phone, hire_date, must_change_password)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
           RETURNING id, employee_code, first_name, last_name, email`,
          [
            userId, company_id, emp.employee_code, emp.first_name, emp.last_name, emp.email, hashedPassword,
            emp.business_unit_id || null, emp.department_id || null, emp.job_level_id || null,
            emp.manager_id || null, emp.phone || null, emp.hire_date || null
          ]
        );

        if (emp.role_id) {
          await client.query(
            `INSERT INTO user_roles (id, user_id, role_id, assigned_by) VALUES ($1, $2, $3, $4)`,
            [uuidv4(), userId, emp.role_id, req.user.id]
          );
        }

        created.push(result.rows[0]);

        // Queue welcome email
        sendEmail({
          to: emp.email,
          subject: 'Welcome to InterBeing Care Connect',
          html: `<p>Hello ${emp.first_name},</p>
                 <p>Your account has been created. Your temporary password is: <strong>${tempPassword}</strong></p>
                 <p>Please login and change your password immediately.</p>`
        }).catch(err => console.error('Bulk welcome email error:', err));
      }

      await client.query('COMMIT');
      res.status(201).json({ data: { created_count: created.length, employees: created } });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /api/company/employees/bulk error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// GET /api/company/employees/export - Export all employees (admin)
router.get('/employees/export',
  requireAdmin,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const result = await pool.query(
        `SELECT u.employee_code, u.first_name, u.last_name, u.email, u.phone, u.hire_date,
          u.is_active, u.created_at,
          bu.name AS business_unit, d.name AS department, jl.name AS job_level,
          m.first_name || ' ' || m.last_name AS manager_name
         FROM users u
         LEFT JOIN business_units bu ON bu.id = u.business_unit_id
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN job_levels jl ON jl.id = u.job_level_id
         LEFT JOIN users m ON m.id = u.manager_id
         WHERE u.company_id = $1
         ORDER BY u.last_name, u.first_name`,
        [company_id]
      );
      res.json({ data: result.rows });
    } catch (err) {
      console.error('GET /api/company/employees/export error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/company/employees/:id/status - Activate/deactivate (admin)
router.patch('/employees/:id/status',
  requireAdmin,
  [
    param('id').isUUID(),
    body('is_active').isBoolean(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const { is_active } = req.body;

      if (id === req.user.id) {
        return res.status(403).json({ error: 'Cannot change your own status' });
      }

      const result = await pool.query(
        `UPDATE users SET is_active = $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3
         RETURNING id, employee_code, first_name, last_name, email, is_active`,
        [is_active, id, company_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Employee not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /api/company/employees/:id/status error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// STAFF MANAGEMENT - ORG CHART
// ============================================================================

// GET /api/company/org-chart - Hierarchical org chart data
router.get('/org-chart', async (req, res) => {
  try {
    const { company_id } = req.user;
    const { view } = req.query; // bu, department, functional, reporting

    let result;

    if (view === 'bu') {
      result = await pool.query(
        `SELECT bu.id, bu.name, bu.code,
          json_agg(json_build_object(
            'id', u.id, 'first_name', u.first_name, 'last_name', u.last_name,
            'email', u.email, 'job_level', jl.name, 'avatar_url', u.avatar_url
          ) ORDER BY u.last_name) FILTER (WHERE u.id IS NOT NULL) AS members
         FROM business_units bu
         LEFT JOIN users u ON u.business_unit_id = bu.id AND u.is_active = true
         LEFT JOIN job_levels jl ON jl.id = u.job_level_id
         WHERE bu.company_id = $1 AND bu.is_active = true
         GROUP BY bu.id ORDER BY bu.name`,
        [company_id]
      );
    } else if (view === 'department') {
      result = await pool.query(
        `SELECT d.id, d.name, d.code, bu.name AS business_unit_name,
          json_agg(json_build_object(
            'id', u.id, 'first_name', u.first_name, 'last_name', u.last_name,
            'email', u.email, 'job_level', jl.name, 'avatar_url', u.avatar_url
          ) ORDER BY u.last_name) FILTER (WHERE u.id IS NOT NULL) AS members
         FROM departments d
         LEFT JOIN business_units bu ON bu.id = d.business_unit_id
         LEFT JOIN users u ON u.department_id = d.id AND u.is_active = true
         LEFT JOIN job_levels jl ON jl.id = u.job_level_id
         WHERE d.company_id = $1 AND d.is_active = true
         GROUP BY d.id, bu.name ORDER BY d.name`,
        [company_id]
      );
    } else {
      // Default: reporting hierarchy (manager-based tree)
      result = await pool.query(
        `SELECT u.id, u.first_name, u.last_name, u.email, u.avatar_url, u.employee_code,
          u.manager_id, jl.name AS job_level, d.name AS department, bu.name AS business_unit
         FROM users u
         LEFT JOIN job_levels jl ON jl.id = u.job_level_id
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN business_units bu ON bu.id = u.business_unit_id
         WHERE u.company_id = $1 AND u.is_active = true
         ORDER BY u.last_name`,
        [company_id]
      );

      // Build tree structure
      const users = result.rows;
      const userMap = new Map();
      for (const u of users) {
        u.children = [];
        userMap.set(u.id, u);
      }
      const roots = [];
      for (const u of users) {
        if (u.manager_id && userMap.has(u.manager_id)) {
          userMap.get(u.manager_id).children.push(u);
        } else {
          roots.push(u);
        }
      }
      return res.json({ data: roots });
    }

    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/company/org-chart error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/company/org-chart/search - Search in org chart
router.get('/org-chart/search',
  [query('q').trim().notEmpty().withMessage('Search query is required')],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { q } = req.query;
      const searchTerm = `%${q}%`;
      const result = await pool.query(
        `SELECT u.id, u.first_name, u.last_name, u.email, u.employee_code, u.avatar_url,
          u.manager_id, jl.name AS job_level, d.name AS department, bu.name AS business_unit,
          m.first_name || ' ' || m.last_name AS manager_name
         FROM users u
         LEFT JOIN job_levels jl ON jl.id = u.job_level_id
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN business_units bu ON bu.id = u.business_unit_id
         LEFT JOIN users m ON m.id = u.manager_id
         WHERE u.company_id = $1 AND u.is_active = true
           AND (u.first_name ILIKE $2 OR u.last_name ILIKE $2 OR u.email ILIKE $2
                OR (u.first_name || ' ' || u.last_name) ILIKE $2)
         ORDER BY u.last_name LIMIT 50`,
        [company_id, searchTerm]
      );
      res.json({ data: result.rows });
    } catch (err) {
      console.error('GET /api/company/org-chart/search error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// VISIBILITY SETTINGS
// ============================================================================

// GET /api/company/visibility
router.get('/visibility', async (req, res) => {
  try {
    const { company_id } = req.user;
    const result = await pool.query(
      `SELECT show_new_joiners, visibility_scope, visibility_groups, duration_days
       FROM company_visibility_settings WHERE company_id = $1`,
      [company_id]
    );
    res.json({ data: result.rows[0] || { show_new_joiners: true, visibility_scope: 'all', visibility_groups: [], duration_days: 30 } });
  } catch (err) {
    console.error('GET /api/company/visibility error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/company/visibility (admin)
router.patch('/visibility',
  requireAdmin,
  [
    body('show_new_joiners').optional().isBoolean(),
    body('visibility_scope').optional().isIn(['all', 'department', 'business_unit', 'custom']),
    body('visibility_groups').optional().isArray(),
    body('duration_days').optional().isInt({ min: 1, max: 365 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { show_new_joiners, visibility_scope, visibility_groups, duration_days } = req.body;

      const result = await pool.query(
        `INSERT INTO company_visibility_settings (id, company_id, show_new_joiners, visibility_scope, visibility_groups, duration_days)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (company_id) DO UPDATE SET
           show_new_joiners = COALESCE($3, company_visibility_settings.show_new_joiners),
           visibility_scope = COALESCE($4, company_visibility_settings.visibility_scope),
           visibility_groups = COALESCE($5, company_visibility_settings.visibility_groups),
           duration_days = COALESCE($6, company_visibility_settings.duration_days),
           updated_at = NOW()
         RETURNING *`,
        [
          uuidv4(), company_id,
          show_new_joiners !== undefined ? show_new_joiners : true,
          visibility_scope || 'all',
          visibility_groups ? JSON.stringify(visibility_groups) : '[]',
          duration_days || 30
        ]
      );
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /api/company/visibility error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// MASTER RECORDS - GENERIC CRUD HELPER
// ============================================================================

function masterRecordRoutes(basePath, tableName, requiredFields, optionalFields = []) {
  // GET - List all
  router.get(basePath, async (req, res) => {
    try {
      const { company_id } = req.user;
      const { module_type } = req.query;
      let sql = `SELECT * FROM ${tableName} WHERE company_id = $1 AND is_active = true`;
      const values = [company_id];
      if (module_type) {
        sql += ` AND module_type = $2`;
        values.push(module_type);
      }
      sql += ' ORDER BY sort_order, name';
      const result = await pool.query(sql, values);
      res.json({ data: result.rows });
    } catch (err) {
      console.error(`GET ${basePath} error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST - Create
  const createValidation = requiredFields.map(f =>
    body(f).trim().notEmpty().withMessage(`${f} is required`)
  );
  for (const f of optionalFields) {
    createValidation.push(body(f).optional().trim());
  }

  router.post(basePath,
    requireAdmin,
    createValidation,
    validate,
    async (req, res) => {
      try {
        const { company_id } = req.user;
        const allFields = [...requiredFields, ...optionalFields];
        const columns = ['id', 'company_id'];
        const placeholders = ['$1', '$2'];
        const values = [uuidv4(), company_id];
        let idx = 3;
        for (const f of allFields) {
          if (req.body[f] !== undefined) {
            columns.push(f);
            placeholders.push(`$${idx++}`);
            values.push(req.body[f]);
          }
        }
        const result = await pool.query(
          `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
          values
        );
        res.status(201).json({ data: result.rows[0] });
      } catch (err) {
        if (err.code === '23505') {
          return res.status(409).json({ error: 'Record already exists with this name or code' });
        }
        console.error(`POST ${basePath} error:`, err);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // PATCH - Update
  router.patch(`${basePath}/:id`,
    requireAdmin,
    [param('id').isUUID()],
    validate,
    async (req, res) => {
      try {
        const { company_id } = req.user;
        const { id } = req.params;
        const allFields = [...requiredFields, ...optionalFields];
        const sets = [];
        const values = [];
        let idx = 1;
        for (const key of allFields) {
          if (req.body[key] !== undefined) {
            sets.push(`${key} = $${idx++}`);
            values.push(req.body[key]);
          }
        }
        if (sets.length === 0) {
          return res.status(400).json({ error: 'No valid fields to update' });
        }
        values.push(id, company_id);
        const result = await pool.query(
          `UPDATE ${tableName} SET ${sets.join(', ')}, updated_at = NOW()
           WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
          values
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Record not found' });
        }
        res.json({ data: result.rows[0] });
      } catch (err) {
        console.error(`PATCH ${basePath}/:id error:`, err);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // DELETE - Deactivate
  router.delete(`${basePath}/:id`,
    requireAdmin,
    [param('id').isUUID()],
    validate,
    async (req, res) => {
      try {
        const { company_id } = req.user;
        const { id } = req.params;
        const result = await pool.query(
          `UPDATE ${tableName} SET is_active = false, updated_at = NOW()
           WHERE id = $1 AND company_id = $2 RETURNING id`,
          [id, company_id]
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Record not found' });
        }
        res.json({ message: 'Record deactivated' });
      } catch (err) {
        console.error(`DELETE ${basePath}/:id error:`, err);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  );
}

// Register master record routes
masterRecordRoutes('/smile-categories', 'smile_categories', ['name'], ['description', 'icon', 'sort_order']);
masterRecordRoutes('/objective-categories', 'objective_categories', ['name'], ['description', 'module_type', 'sort_order']);
masterRecordRoutes('/objective-statuses', 'objective_statuses', ['name'], ['description', 'module_type', 'color', 'sort_order']);
masterRecordRoutes('/rating-scales', 'rating_scales', ['name'], ['description', 'module_type', 'min_value', 'max_value', 'sort_order']);
masterRecordRoutes('/document-types', 'document_types', ['name'], ['description', 'allowed_extensions', 'max_size_mb', 'sort_order']);
masterRecordRoutes('/training-types', 'training_types', ['name'], ['description', 'sort_order']);
masterRecordRoutes('/certification-types', 'certification_types', ['name'], ['description', 'validity_months', 'sort_order']);

// ============================================================================
// MASTER RECORDS - OBJECTIVE TEMPLATES (with bulk)
// ============================================================================

// GET /api/company/objective-templates
router.get('/objective-templates', async (req, res) => {
  try {
    const { company_id } = req.user;
    const { module_type } = req.query;
    let sql = `SELECT ot.*, oc.name AS category_name
               FROM objective_templates ot
               LEFT JOIN objective_categories oc ON oc.id = ot.category_id
               WHERE ot.company_id = $1 AND ot.is_active = true`;
    const values = [company_id];
    if (module_type) {
      sql += ' AND ot.module_type = $2';
      values.push(module_type);
    }
    sql += ' ORDER BY ot.sort_order, ot.name';
    const result = await pool.query(sql, values);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /objective-templates error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/company/objective-templates
router.post('/objective-templates',
  requireAdmin,
  [
    body('name').trim().notEmpty(),
    body('description').optional().trim(),
    body('module_type').optional().trim(),
    body('category_id').optional().isUUID(),
    body('default_weight').optional().isFloat({ min: 0, max: 100 }),
    body('sort_order').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { name, description, module_type, category_id, default_weight, sort_order } = req.body;
      const result = await pool.query(
        `INSERT INTO objective_templates (id, company_id, name, description, module_type, category_id, default_weight, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [uuidv4(), company_id, name, description || null, module_type || null, category_id || null, default_weight || null, sort_order || 0]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /objective-templates error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/company/objective-templates/bulk - Bulk upload
router.post('/objective-templates/bulk',
  requireAdmin,
  [body('templates').isArray({ min: 1 })],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { company_id } = req.user;
      const { templates } = req.body;
      await client.query('BEGIN');
      const created = [];
      for (const t of templates) {
        const result = await client.query(
          `INSERT INTO objective_templates (id, company_id, name, description, module_type, category_id, default_weight, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [uuidv4(), company_id, t.name, t.description || null, t.module_type || null, t.category_id || null, t.default_weight || null, t.sort_order || 0]
        );
        created.push(result.rows[0]);
      }
      await client.query('COMMIT');
      res.status(201).json({ data: { created_count: created.length, templates: created } });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /objective-templates/bulk error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// GET /api/company/objective-templates/export
router.get('/objective-templates/export',
  requireAdmin,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const result = await pool.query(
        `SELECT ot.name, ot.description, ot.module_type, oc.name AS category_name, ot.default_weight, ot.sort_order
         FROM objective_templates ot
         LEFT JOIN objective_categories oc ON oc.id = ot.category_id
         WHERE ot.company_id = $1 AND ot.is_active = true
         ORDER BY ot.sort_order, ot.name`,
        [company_id]
      );
      res.json({ data: result.rows });
    } catch (err) {
      console.error('GET /objective-templates/export error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/company/objective-templates/:id
router.patch('/objective-templates/:id',
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const allowed = ['name', 'description', 'module_type', 'category_id', 'default_weight', 'sort_order'];
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
      values.push(id, company_id);
      const result = await pool.query(
        `UPDATE objective_templates SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
        values
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Template not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /objective-templates/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/company/objective-templates/:id
router.delete('/objective-templates/:id',
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const result = await pool.query(
        `UPDATE objective_templates SET is_active = false, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 RETURNING id`,
        [id, company_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Template not found' });
      }
      res.json({ message: 'Template deactivated' });
    } catch (err) {
      console.error('DELETE /objective-templates/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// CONNECT CYCLES
// ============================================================================

// GET /api/company/connect-cycles
router.get('/connect-cycles', async (req, res) => {
  try {
    const { company_id } = req.user;
    const { status, module_type } = req.query;
    let sql = `
      SELECT cc.*,
        (SELECT COUNT(*) FROM connect_cycle_assignments cca WHERE cca.cycle_id = cc.id) AS assignment_count,
        (SELECT COUNT(*) FROM connect_cycle_assignments cca WHERE cca.cycle_id = cc.id AND cca.status = 'completed') AS completed_count
      FROM connect_cycles cc
      WHERE cc.company_id = $1`;
    const values = [company_id];
    let idx = 2;
    if (status) {
      sql += ` AND cc.status = $${idx++}`;
      values.push(status);
    }
    if (module_type) {
      sql += ` AND cc.module_type = $${idx++}`;
      values.push(module_type);
    }
    sql += ' ORDER BY cc.created_at DESC';
    const result = await pool.query(sql, values);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /connect-cycles error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/company/connect-cycles - Create cycle + assignments
router.post('/connect-cycles',
  requireAdmin,
  [
    body('name').trim().notEmpty(),
    body('module_type').isIn(['performance', 'development', 'wellbeing']),
    body('start_date').isISO8601(),
    body('end_date').isISO8601(),
    body('description').optional().trim(),
    body('assignments').optional().isArray(),
    body('assignments.*.user_id').optional().isUUID(),
    body('assignments.*.reviewer_id').optional().isUUID(),
  ],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { company_id } = req.user;
      const { name, module_type, start_date, end_date, description, assignments } = req.body;

      if (new Date(end_date) <= new Date(start_date)) {
        return res.status(400).json({ error: 'End date must be after start date' });
      }

      await client.query('BEGIN');

      const cycleId = uuidv4();
      const cycleResult = await client.query(
        `INSERT INTO connect_cycles (id, company_id, name, module_type, start_date, end_date, description, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8) RETURNING *`,
        [cycleId, company_id, name, module_type, start_date, end_date, description || null, req.user.id]
      );

      let assignmentCount = 0;
      if (assignments && assignments.length > 0) {
        for (const a of assignments) {
          await client.query(
            `INSERT INTO connect_cycle_assignments (id, cycle_id, user_id, reviewer_id, status)
             VALUES ($1, $2, $3, $4, 'pending')`,
            [uuidv4(), cycleId, a.user_id, a.reviewer_id || null]
          );
          assignmentCount++;
        }
      }

      await client.query('COMMIT');
      const cycle = cycleResult.rows[0];
      cycle.assignment_count = assignmentCount;
      res.status(201).json({ data: cycle });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /connect-cycles error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// PATCH /api/company/connect-cycles/:id - Update cycle
router.patch('/connect-cycles/:id',
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const allowed = ['name', 'description', 'start_date', 'end_date'];
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
      values.push(id, company_id);
      const result = await pool.query(
        `UPDATE connect_cycles SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
        values
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Cycle not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /connect-cycles/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/company/connect-cycles/:id/status - Change cycle status
router.patch('/connect-cycles/:id/status',
  requireAdmin,
  [
    param('id').isUUID(),
    body('status').isIn(['draft', 'active', 'closed', 'archived']),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const { status } = req.body;
      const result = await pool.query(
        `UPDATE connect_cycles SET status = $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3 RETURNING *`,
        [status, id, company_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Cycle not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /connect-cycles/:id/status error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/company/connect-cycles/:id/assignments
router.get('/connect-cycles/:id/assignments',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;

      // Verify cycle belongs to company
      const cycle = await pool.query(
        'SELECT id FROM connect_cycles WHERE id = $1 AND company_id = $2',
        [id, company_id]
      );
      if (cycle.rows.length === 0) {
        return res.status(404).json({ error: 'Cycle not found' });
      }

      const result = await pool.query(
        `SELECT cca.*,
          u.first_name || ' ' || u.last_name AS user_name, u.email AS user_email,
          r.first_name || ' ' || r.last_name AS reviewer_name
         FROM connect_cycle_assignments cca
         JOIN users u ON u.id = cca.user_id
         LEFT JOIN users r ON r.id = cca.reviewer_id
         WHERE cca.cycle_id = $1
         ORDER BY u.last_name`,
        [id]
      );
      res.json({ data: result.rows });
    } catch (err) {
      console.error('GET /connect-cycles/:id/assignments error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/company/connect-cycles/:id/assignments - Add assignments
router.post('/connect-cycles/:id/assignments',
  requireAdmin,
  [
    param('id').isUUID(),
    body('assignments').isArray({ min: 1 }),
    body('assignments.*.user_id').isUUID(),
    body('assignments.*.reviewer_id').optional().isUUID(),
  ],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { company_id } = req.user;
      const { id } = req.params;
      const { assignments } = req.body;

      const cycle = await client.query(
        'SELECT id FROM connect_cycles WHERE id = $1 AND company_id = $2',
        [id, company_id]
      );
      if (cycle.rows.length === 0) {
        return res.status(404).json({ error: 'Cycle not found' });
      }

      await client.query('BEGIN');
      const created = [];
      for (const a of assignments) {
        // Skip duplicates
        const existing = await client.query(
          'SELECT id FROM connect_cycle_assignments WHERE cycle_id = $1 AND user_id = $2',
          [id, a.user_id]
        );
        if (existing.rows.length > 0) continue;

        const result = await client.query(
          `INSERT INTO connect_cycle_assignments (id, cycle_id, user_id, reviewer_id, status)
           VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
          [uuidv4(), id, a.user_id, a.reviewer_id || null]
        );
        created.push(result.rows[0]);
      }
      await client.query('COMMIT');
      res.status(201).json({ data: { added_count: created.length, assignments: created } });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /connect-cycles/:id/assignments error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// DELETE /api/company/connect-cycles/:id/assignments/:assignmentId
router.delete('/connect-cycles/:id/assignments/:assignmentId',
  requireAdmin,
  [param('id').isUUID(), param('assignmentId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id, assignmentId } = req.params;

      const cycle = await pool.query(
        'SELECT id FROM connect_cycles WHERE id = $1 AND company_id = $2',
        [id, company_id]
      );
      if (cycle.rows.length === 0) {
        return res.status(404).json({ error: 'Cycle not found' });
      }

      const result = await pool.query(
        'DELETE FROM connect_cycle_assignments WHERE id = $1 AND cycle_id = $2 RETURNING id',
        [assignmentId, id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Assignment not found' });
      }
      res.json({ message: 'Assignment removed' });
    } catch (err) {
      console.error('DELETE /connect-cycles/:id/assignments error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================================
// EMAIL TEMPLATES
// ============================================================================

// GET /api/company/email-templates
router.get('/email-templates', async (req, res) => {
  try {
    const { company_id } = req.user;
    const result = await pool.query(
      `SELECT id, name, subject, event_trigger, is_active, created_at, updated_at
       FROM email_templates WHERE company_id = $1 ORDER BY name`,
      [company_id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /email-templates error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/company/email-templates - Create custom template
router.post('/email-templates',
  requireAdmin,
  [
    body('name').trim().notEmpty(),
    body('subject').trim().notEmpty(),
    body('body_html').trim().notEmpty(),
    body('event_trigger').optional().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { name, subject, body_html, event_trigger } = req.body;
      const templateId = uuidv4();

      const result = await pool.query(
        `INSERT INTO email_templates (id, company_id, name, subject, body_html, event_trigger, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [templateId, company_id, name, subject, body_html, event_trigger || null, req.user.id]
      );

      // Create initial version
      await pool.query(
        `INSERT INTO email_template_versions (id, template_id, version, subject, body_html, created_by)
         VALUES ($1, $2, 1, $3, $4, $5)`,
        [uuidv4(), templateId, subject, body_html, req.user.id]
      );

      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      console.error('POST /email-templates error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/company/email-templates/:id - Update (creates version record)
router.patch('/email-templates/:id',
  requireAdmin,
  [
    param('id').isUUID(),
    body('name').optional().trim().notEmpty(),
    body('subject').optional().trim().notEmpty(),
    body('body_html').optional().trim().notEmpty(),
    body('event_trigger').optional().trim(),
    body('is_active').optional().isBoolean(),
  ],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { company_id } = req.user;
      const { id } = req.params;

      const existing = await client.query(
        'SELECT * FROM email_templates WHERE id = $1 AND company_id = $2',
        [id, company_id]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Template not found' });
      }

      await client.query('BEGIN');

      const allowed = ['name', 'subject', 'body_html', 'event_trigger', 'is_active'];
      const sets = [];
      const values = [];
      let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          sets.push(`${key} = $${idx++}`);
          values.push(req.body[key]);
        }
      }

      if (sets.length > 0) {
        values.push(id);
        await client.query(
          `UPDATE email_templates SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
          values
        );
      }

      // Create version record if content changed
      if (req.body.subject || req.body.body_html) {
        const maxVersion = await client.query(
          'SELECT COALESCE(MAX(version), 0) AS max_v FROM email_template_versions WHERE template_id = $1',
          [id]
        );
        const newVersion = parseInt(maxVersion.rows[0].max_v) + 1;
        await client.query(
          `INSERT INTO email_template_versions (id, template_id, version, subject, body_html, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            uuidv4(), id, newVersion,
            req.body.subject || existing.rows[0].subject,
            req.body.body_html || existing.rows[0].body_html,
            req.user.id
          ]
        );
      }

      await client.query('COMMIT');
      const updated = await pool.query('SELECT * FROM email_templates WHERE id = $1', [id]);
      res.json({ data: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('PATCH /email-templates/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// GET /api/company/email-templates/:id/versions - Version history
router.get('/email-templates/:id/versions',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { company_id } = req.user;
      const { id } = req.params;

      const template = await pool.query(
        'SELECT id FROM email_templates WHERE id = $1 AND company_id = $2',
        [id, company_id]
      );
      if (template.rows.length === 0) {
        return res.status(404).json({ error: 'Template not found' });
      }

      const result = await pool.query(
        `SELECT v.*, u.first_name || ' ' || u.last_name AS created_by_name
         FROM email_template_versions v
         LEFT JOIN users u ON u.id = v.created_by
         WHERE v.template_id = $1
         ORDER BY v.version DESC`,
        [id]
      );
      res.json({ data: result.rows });
    } catch (err) {
      console.error('GET /email-templates/:id/versions error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/company/email-templates/:id/revert/:versionId - Revert to previous version
router.post('/email-templates/:id/revert/:versionId',
  requireAdmin,
  [param('id').isUUID(), param('versionId').isUUID()],
  validate,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const { company_id } = req.user;
      const { id, versionId } = req.params;

      const template = await client.query(
        'SELECT id FROM email_templates WHERE id = $1 AND company_id = $2',
        [id, company_id]
      );
      if (template.rows.length === 0) {
        return res.status(404).json({ error: 'Template not found' });
      }

      const version = await client.query(
        'SELECT * FROM email_template_versions WHERE id = $1 AND template_id = $2',
        [versionId, id]
      );
      if (version.rows.length === 0) {
        return res.status(404).json({ error: 'Version not found' });
      }

      await client.query('BEGIN');

      // Update template with version content
      await client.query(
        `UPDATE email_templates SET subject = $1, body_html = $2, updated_at = NOW() WHERE id = $3`,
        [version.rows[0].subject, version.rows[0].body_html, id]
      );

      // Create new version record for the revert
      const maxVersion = await client.query(
        'SELECT COALESCE(MAX(version), 0) AS max_v FROM email_template_versions WHERE template_id = $1',
        [id]
      );
      await client.query(
        `INSERT INTO email_template_versions (id, template_id, version, subject, body_html, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv4(), id, parseInt(maxVersion.rows[0].max_v) + 1, version.rows[0].subject, version.rows[0].body_html, req.user.id]
      );

      await client.query('COMMIT');
      const updated = await pool.query('SELECT * FROM email_templates WHERE id = $1', [id]);
      res.json({ data: updated.rows[0], message: `Reverted to version ${version.rows[0].version}` });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /email-templates/:id/revert error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// ============================================================================
// NOTIFICATIONS
// ============================================================================

// GET /api/company/notifications - User's notifications with unread count
router.get('/notifications', async (req, res) => {
  try {
    const userId = req.user.id;
    const { company_id } = req.user;
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countResult = await pool.query(
      `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE is_read = false) AS unread_count
       FROM notifications WHERE user_id = $1 AND company_id = $2`,
      [userId, company_id]
    );

    const result = await pool.query(
      `SELECT * FROM notifications
       WHERE user_id = $1 AND company_id = $2
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [userId, company_id, parseInt(limit), offset]
    );

    res.json({
      data: result.rows,
      meta: {
        total: parseInt(countResult.rows[0].total),
        unread_count: parseInt(countResult.rows[0].unread_count),
        page: parseInt(page),
        limit: parseInt(limit),
      }
    });
  } catch (err) {
    console.error('GET /notifications error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/company/notifications/read-all - Mark all read
router.patch('/notifications/read-all', async (req, res) => {
  try {
    const userId = req.user.id;
    const { company_id } = req.user;
    await pool.query(
      `UPDATE notifications SET is_read = true, read_at = NOW()
       WHERE user_id = $1 AND company_id = $2 AND is_read = false`,
      [userId, company_id]
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('PATCH /notifications/read-all error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/company/notifications/:id/read - Mark single read
router.patch('/notifications/:id/read',
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const { id } = req.params;
      const result = await pool.query(
        `UPDATE notifications SET is_read = true, read_at = NOW()
         WHERE id = $1 AND user_id = $2 RETURNING *`,
        [id, userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Notification not found' });
      }
      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('PATCH /notifications/:id/read error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
