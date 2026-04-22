'use strict';

/**
 * RBAC Management (v2)
 * --------------------------------------------------------------------------
 * Spec 01. CRUD for roles + permission matrix on both company and ICC sides.
 *   - GET  /api/v2/rbac/modules
 *   - GET  /api/v2/rbac/roles                 (company scope)
 *   - POST /api/v2/rbac/roles
 *   - PUT  /api/v2/rbac/roles/:id/permissions (array of {module, view, add, edit, delete})
 *   - POST /api/v2/rbac/assign                (user_id, role_id)
 *   - GET  /api/v2/rbac/me                    (effective permission set)
 *
 * ICC equivalents under /icc/rbac.
 */

const express = require('express');
const router = express.Router();
const pool = require('../../../well-minds/src/db');
const { authenticate, authenticateICC } = require('../../../well-minds/src/middleware');
const requirePermission = require('../middleware/requirePermission');

// --------------------------------------------------------------------------
// GET /api/v2/rbac/modules — list all modules grouped by scope
// --------------------------------------------------------------------------
router.get('/modules', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, scope, label, description, sort_order
         FROM permission_modules
        ORDER BY scope, sort_order, label`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// GET /api/v2/rbac/me — current user's effective permission set
// --------------------------------------------------------------------------
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT rp.module, bool_or(rp.can_view) AS can_view,
                         bool_or(rp.can_add)  AS can_add,
                         bool_or(rp.can_edit) AS can_edit,
                         bool_or(rp.can_delete) AS can_delete
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1
        GROUP BY rp.module`,
      [req.user.id],
    );
    res.json({
      user_id: req.user.id,
      permissions: rows,
      role: req.user.role,
    });
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// GET /api/v2/rbac/roles — list company roles
// --------------------------------------------------------------------------
router.get('/roles', authenticate, requirePermission('settings_rbac', 'view'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*,
              COALESCE((
                SELECT json_agg(rp.*)
                  FROM role_permissions rp
                 WHERE rp.role_id = r.id
              ), '[]'::json) AS permissions
         FROM roles r
        WHERE r.company_id = $1 OR r.company_id IS NULL
        ORDER BY r.is_system DESC, r.name`,
      [req.user.company_id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// POST /api/v2/rbac/roles — create a new role
// --------------------------------------------------------------------------
router.post('/roles',
  authenticate,
  requirePermission('settings_rbac', 'add'),
  async (req, res, next) => {
    const { name, description } = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO roles (company_id, name, description, is_system)
         VALUES ($1, $2, $3, FALSE) RETURNING *`,
        [req.user.company_id, name, description || null],
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  },
);

// --------------------------------------------------------------------------
// PUT /api/v2/rbac/roles/:id/permissions
// Body: { permissions: [{module, can_view, can_add, can_edit, can_delete}, ...] }
// --------------------------------------------------------------------------
router.put('/roles/:id/permissions',
  authenticate,
  requirePermission('settings_rbac', 'edit'),
  async (req, res, next) => {
    const { permissions } = req.body;
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'permissions array required' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [req.params.id]);
      for (const p of permissions) {
        await client.query(
          `INSERT INTO role_permissions (role_id, module, can_view, can_add, can_edit, can_delete)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [req.params.id, p.module, !!p.can_view, !!p.can_add, !!p.can_edit, !!p.can_delete],
        );
      }
      await client.query('COMMIT');
      const invalidate = require('../middleware/requirePermission').invalidateUser;
      // Invalidate cache for every user currently assigned to this role
      const usersRes = await pool.query(`SELECT user_id FROM user_roles WHERE role_id = $1`, [req.params.id]);
      for (const u of usersRes.rows) invalidate(u.user_id);
      res.json({ ok: true, updated: permissions.length });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  },
);

// --------------------------------------------------------------------------
// POST /api/v2/rbac/assign — assign a role to a user
// --------------------------------------------------------------------------
router.post('/assign',
  authenticate,
  requirePermission('settings_rbac', 'edit'),
  async (req, res, next) => {
    const { user_id, role_id } = req.body;
    try {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [user_id, role_id],
      );
      require('../middleware/requirePermission').invalidateUser(user_id);
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

// --------------------------------------------------------------------------
// ICC-side: list ICC roles + their permissions
// --------------------------------------------------------------------------
router.get('/icc/roles', authenticateICC, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*,
              COALESCE((
                SELECT json_agg(irp.*)
                  FROM icc_role_permissions irp
                 WHERE irp.role_id = r.id
              ), '[]'::json) AS permissions
         FROM icc_roles r
        ORDER BY r.is_system DESC, r.name`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// ICC-side: update ICC role permissions
// --------------------------------------------------------------------------
router.put('/icc/roles/:id/permissions', authenticateICC, async (req, res, next) => {
  const { permissions } = req.body;
  if (!Array.isArray(permissions)) {
    return res.status(400).json({ error: 'permissions array required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM icc_role_permissions WHERE role_id = $1`, [req.params.id]);
    for (const p of permissions) {
      await client.query(
        `INSERT INTO icc_role_permissions (role_id, module, can_view, can_add, can_edit, can_delete)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.id, p.module, !!p.can_view, !!p.can_add, !!p.can_edit, !!p.can_delete],
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, updated: permissions.length });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// --------------------------------------------------------------------------
// ICC-side: assign an ICC role to an admin
// --------------------------------------------------------------------------
router.post('/icc/assign', authenticateICC, async (req, res, next) => {
  const { admin_id, role_id } = req.body;
  try {
    await pool.query(
      `INSERT INTO icc_admin_roles (admin_id, role_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [admin_id, role_id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
