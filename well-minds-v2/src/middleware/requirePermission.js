'use strict';

/**
 * requirePermission(module, action)
 * --------------------------------------------------------------------------
 * Spec 01, P0-1. Single middleware factory backing the new RBAC matrix.
 * Resolves both company-user and ICC-admin contexts by scope, checks the
 * appropriate permissions table, and returns 403 if the row is missing.
 *
 * Uses a tiny 60-second in-memory cache keyed by user_id:scope:module:action
 * so the DB isn't hammered on every protected request.
 *
 * action is one of 'view' | 'add' | 'edit' | 'delete'.
 */

const pool = require('../../../well-minds/src/db');

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

function cacheKey(userId, scope, module, action) {
  return `${userId}:${scope}:${module}:${action}`;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

function invalidateUser(userId) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${userId}:`)) cache.delete(key);
  }
}

function requirePermission(module, action) {
  if (!['view', 'add', 'edit', 'delete'].includes(action)) {
    throw new Error(`requirePermission: invalid action '${action}'`);
  }
  const column = `can_${action}`;

  return async function permissionGate(req, res, next) {
    const iccAdmin = req.iccAdmin;
    const user = req.user;

    if (!iccAdmin && !user) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    const scope = iccAdmin ? 'icc' : 'company';
    const principalId = iccAdmin ? iccAdmin.id : user.id;

    const ck = cacheKey(principalId, scope, module, action);
    const cached = cacheGet(ck);
    if (cached === true) return next();
    if (cached === false) {
      return res.status(403).json({ error: 'Forbidden', module, action });
    }

    try {
      const sql =
        scope === 'icc'
          ? `SELECT 1
               FROM icc_admin_roles iar
               JOIN icc_role_permissions irp ON irp.role_id = iar.role_id
              WHERE iar.admin_id = $1 AND irp.module = $2 AND irp.${column} = TRUE
              LIMIT 1`
          : `SELECT 1
               FROM user_roles ur
               JOIN role_permissions rp ON rp.role_id = ur.role_id
              WHERE ur.user_id = $1 AND rp.module = $2 AND rp.${column} = TRUE
              LIMIT 1`;

      const { rowCount } = await pool.query(sql, [principalId, module]);
      const allowed = rowCount > 0;
      cacheSet(ck, allowed);

      if (!allowed) {
        // Fallback: company-side legacy roles (admin bypass) for v1 users who
        // haven't been migrated yet. Lets the v2 routes co-exist with old data.
        if (scope === 'company' && user && user.role === 'admin') {
          cacheSet(ck, true);
          return next();
        }
        return res.status(403).json({ error: 'Forbidden', module, action });
      }
      return next();
    } catch (err) {
      console.error('[requirePermission]', err.message);
      return res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

module.exports = requirePermission;
module.exports.invalidateUser = invalidateUser;
module.exports._cacheForTest = cache;
