'use strict';

/**
 * hierarchyVisibility.js
 * --------------------------------------------------------------------------
 * Spec 03. Returns the set of user IDs allowed to view a given employee's
 * connect report. That set is the union of:
 *   (1) the employee themself
 *   (2) the full upward manager_id chain
 *   (3) the functional_manager_id recorded on that employee's reflections
 *   (4) explicit grants in objective_visibility_grants (non-expired)
 */

const pool = require('../../../well-minds/src/db');

async function viewersForUser(userId) {
  const sql = `
    WITH RECURSIVE upward AS (
      SELECT u.id, u.manager_id
        FROM users u
       WHERE u.id = $1
      UNION
      SELECT u.id, u.manager_id
        FROM users u
        JOIN upward ON u.id = upward.manager_id
    )
    SELECT id AS viewer_id FROM upward
    UNION
    SELECT DISTINCT functional_manager_id
      FROM performance_reflections
     WHERE user_id = $1 AND functional_manager_id IS NOT NULL
    UNION
    SELECT granted_to_user_id
      FROM objective_visibility_grants
     WHERE user_id = $1
       AND (expires_at IS NULL OR expires_at > NOW())
  `;
  const { rows } = await pool.query(sql, [userId]);
  return rows.map((r) => r.viewer_id).filter(Boolean);
}

async function canView(viewerId, subjectUserId) {
  if (viewerId === subjectUserId) return true;
  const viewers = await viewersForUser(subjectUserId);
  return viewers.includes(viewerId);
}

/**
 * Reverse lookup: which subjects can a given user see?
 * Returns the IDs of every user whose report `viewerId` is allowed to open.
 * Useful for the manager's landing page.
 */
async function subjectsForViewer(viewerId) {
  const sql = `
    WITH RECURSIVE downward AS (
      SELECT u.id
        FROM users u
       WHERE u.manager_id = $1
      UNION
      SELECT u.id
        FROM users u
        JOIN downward ON u.manager_id = downward.id
    )
    SELECT id FROM downward
    UNION
    SELECT user_id
      FROM objective_visibility_grants
     WHERE granted_to_user_id = $1
       AND (expires_at IS NULL OR expires_at > NOW())
  `;
  const { rows } = await pool.query(sql, [viewerId]);
  return rows.map((r) => r.id);
}

module.exports = { viewersForUser, canView, subjectsForViewer };
