'use strict';

const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const pool = require('./db');

const JWT_SECRET = () => process.env.JWT_SECRET;

// ---------------------------------------------------------------------------
// 1. authenticate  -  Verify org-user JWT (Authorization: Bearer <token>)
// ---------------------------------------------------------------------------
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET());
    req.user = {
      id: decoded.id,
      company_id: decoded.company_id,
      role: decoded.role,
      email: decoded.email,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------------------------------------------------------------------------
// 2. authenticateICC  -  Verify ICC admin JWT
// ---------------------------------------------------------------------------
function authenticateICC(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'ICC authentication required' });
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET());
    if (!decoded.icc_admin_id) {
      return res.status(401).json({ error: 'Invalid ICC token' });
    }
    req.iccAdmin = {
      id: decoded.icc_admin_id,
      role: decoded.role,
      email: decoded.email,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------------------------------------------------------------------------
// 3. authenticateProfessional  -  Verify professional portal JWT
// ---------------------------------------------------------------------------
function authenticateProfessional(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Professional authentication required' });
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET());
    if (!decoded.professional_id || decoded.type !== 'professional') {
      return res.status(401).json({ error: 'Invalid professional token' });
    }
    req.professional = {
      id: decoded.professional_id,
      type: decoded.type,
      email: decoded.email,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------------------------------------------------------------------------
// 4. requireAdmin
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ---------------------------------------------------------------------------
// 5. requireManager  -  admin OR manager
// ---------------------------------------------------------------------------
function requireManager(req, res, next) {
  if (!req.user || !['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager or admin access required' });
  }
  next();
}

// ---------------------------------------------------------------------------
// 6. requireRole(...roles)
// ---------------------------------------------------------------------------
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `One of the following roles is required: ${roles.join(', ')}`,
      });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// 7. requireICCRole(...roles)
// ---------------------------------------------------------------------------
function requireICCRole(...roles) {
  return (req, res, next) => {
    if (!req.iccAdmin || !roles.includes(req.iccAdmin.role)) {
      return res.status(403).json({
        error: `One of the following ICC roles is required: ${roles.join(', ')}`,
      });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// 8. validate  -  express-validator result checker
// ---------------------------------------------------------------------------
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      errors: errors.array().map((e) => e.msg),
    });
  }
  next();
}

// ---------------------------------------------------------------------------
// 9. checkPermission(module, action)
//    Looks up user_roles + role_permissions for custom RBAC.
//    Falls back to basic role-based check when no custom roles are assigned.
// ---------------------------------------------------------------------------
function checkPermission(module, action) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      // Look up custom role assignments for this user
      const roleResult = await pool.query(
        `SELECT ur.role_id, rp.module, rp.can_view, rp.can_add, rp.can_edit, rp.can_delete
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = $1
           AND rp.module = $2`,
        [req.user.id, module],
      );

      // If custom roles exist, enforce them
      if (roleResult.rows.length > 0) {
        const columnMap = {
          view: 'can_view',
          add: 'can_add',
          edit: 'can_edit',
          delete: 'can_delete',
        };
        const column = columnMap[action];
        if (!column) {
          return res.status(400).json({ error: `Unknown action: ${action}` });
        }

        const allowed = roleResult.rows.some((row) => row[column] === true);
        if (!allowed) {
          return res.status(403).json({
            error: `You do not have ${action} permission for ${module}`,
          });
        }
        return next();
      }

      // Fallback: role-based access (admin gets everything, manager gets view/add/edit)
      if (req.user.role === 'admin') {
        return next();
      }
      if (req.user.role === 'manager' && ['view', 'add', 'edit'].includes(action)) {
        return next();
      }
      if (req.user.role === 'staff' && action === 'view') {
        return next();
      }

      return res.status(403).json({
        error: `You do not have ${action} permission for ${module}`,
      });
    } catch (err) {
      console.error('[checkPermission] Error:', err.message);
      return res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  authenticate,
  authenticateICC,
  authenticateProfessional,
  requireAdmin,
  requireManager,
  requireRole,
  requireICCRole,
  validate,
  checkPermission,
};
