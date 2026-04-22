'use strict';

/**
 * Connect Cycle Sign-off & Approval (v2)
 * --------------------------------------------------------------------------
 * Spec 03. The routes missing from v1 to make the cycle a coherent workflow:
 *   - Objective approval (approve / reject / suggest alternative / cascade)
 *   - Consolidation of final status + rating
 *   - Audit-trailed sign-offs (employee → manager → functional manager)
 *   - Visibility grants
 *   - Progress widget per module
 */

const express = require('express');
const router = express.Router();
const pool = require('../../../well-minds/src/db');
const { authenticate } = require('../../../well-minds/src/middleware');
const requirePermission = require('../middleware/requirePermission');
const { canView } = require('../services/hierarchyVisibility');

const MODULES = ['performance', 'development', 'wellbeing'];

function assertModule(m) {
  if (!MODULES.includes(m)) throw Object.assign(new Error('Unknown module'), { status: 400 });
}

function objectiveTable(m) { return `${m}_objectives`; }
function reflectionTable(m) { return `${m}_reflections`; }

// --------------------------------------------------------------------------
// PATCH /api/v2/connect/:module/objectives/:oid/approval
// Body: { action: 'approve'|'reject'|'suggest_alternative', note?, alternative? }
// --------------------------------------------------------------------------
router.patch('/:module/objectives/:oid/approval', authenticate, async (req, res, next) => {
  try {
    assertModule(req.params.module);
    const { action, note, alternative } = req.body;
    const approvalStatus = {
      approve: 'approved',
      reject: 'rejected',
      suggest_alternative: 'alternative_suggested',
    }[action];
    if (!approvalStatus) return res.status(400).json({ error: 'Unknown action' });

    const table = objectiveTable(req.params.module);
    const result = await pool.query(
      `UPDATE ${table}
          SET approval_status = $1,
              manager_note    = $2,
              approved_by     = $3,
              approved_at     = NOW()
        WHERE id = $4
        RETURNING *`,
      [approvalStatus, note || alternative || null, req.user.id, req.params.oid],
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Objective not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// POST /api/v2/connect/:module/objectives/:oid/cascade
// Manager cascades their own objective down to a list of employees.
// Body: { user_ids: [uuid,...] }
// --------------------------------------------------------------------------
router.post('/:module/objectives/:oid/cascade', authenticate, async (req, res, next) => {
  try {
    assertModule(req.params.module);
    const { user_ids } = req.body;
    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ error: 'user_ids array required' });
    }
    const table = objectiveTable(req.params.module);

    // Fetch the source objective
    const src = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.oid]);
    if (src.rowCount === 0) return res.status(404).json({ error: 'Source objective not found' });
    const parent = src.rows[0];

    const inserted = [];
    for (const uid of user_ids) {
      const { rows } = await pool.query(
        `INSERT INTO ${table}
           (user_id, company_id, cycle_id, title, description, category,
            measure_of_success, weight, status_id, approval_status,
            cascaded_from_objective_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,NOW())
         RETURNING id, user_id`,
        [
          uid, parent.company_id, parent.cycle_id, parent.title, parent.description,
          parent.category, parent.measure_of_success, parent.weight, parent.status_id,
          parent.id,
        ],
      );
      inserted.push(rows[0]);
    }
    res.status(201).json({ cascaded: inserted.length, objectives: inserted });
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// PATCH /api/v2/connect/:module/reflections/:id/consolidate
// Body: { final_agreed_status_id, final_agreed_rating_id, consolidated_notes }
// --------------------------------------------------------------------------
router.patch('/:module/reflections/:id/consolidate', authenticate, async (req, res, next) => {
  try {
    assertModule(req.params.module);
    const { final_agreed_status_id, final_agreed_rating_id, consolidated_notes } = req.body;
    const table = reflectionTable(req.params.module);
    const { rows } = await pool.query(
      `UPDATE ${table}
          SET is_consolidated      = TRUE,
              consolidated_notes   = $1,
              final_agreed_status_id = $2,
              final_agreed_rating_id = $3,
              consolidated_at      = NOW()
        WHERE id = $4
        RETURNING *`,
      [consolidated_notes, final_agreed_status_id, final_agreed_rating_id, req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Reflection not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// POST /api/v2/connect/:module/reflections/:id/signoff
// Body: { role: 'employee'|'manager'|'functional_manager', note? }
// --------------------------------------------------------------------------
router.post('/:module/reflections/:id/signoff', authenticate, async (req, res, next) => {
  try {
    assertModule(req.params.module);
    const { role, note } = req.body;
    if (!['employee', 'manager', 'functional_manager'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const table = reflectionTable(req.params.module);

    await pool.query(
      `INSERT INTO reflection_signoffs
         (module_type, reflection_id, role, user_id, ip_address, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.module, req.params.id, role, req.user.id, req.ip, note || null],
    );

    const columnMap = {
      employee:            'employee_signed_off',
      manager:             'manager_signed_off',
      functional_manager:  'functional_manager_signed_off',
    };
    await pool.query(
      `UPDATE ${table} SET ${columnMap[role]} = TRUE WHERE id = $1`,
      [req.params.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// POST /api/v2/connect/:module/reflections/:id/signoff/revoke
// Only allowed if the user signed AND nobody else has signed after.
// --------------------------------------------------------------------------
router.post('/:module/reflections/:id/signoff/revoke', authenticate, async (req, res, next) => {
  try {
    assertModule(req.params.module);
    const table = reflectionTable(req.params.module);
    // Revoke my most recent active signoff on this reflection.
    const so = await pool.query(
      `UPDATE reflection_signoffs
          SET revoked_at = NOW()
        WHERE id = (
          SELECT id FROM reflection_signoffs
           WHERE reflection_id = $1
             AND module_type = $2
             AND user_id = $3
             AND revoked_at IS NULL
           ORDER BY signed_at DESC
           LIMIT 1
        )
        RETURNING role`,
      [req.params.id, req.params.module, req.user.id],
    );
    if (so.rowCount === 0) return res.status(404).json({ error: 'No active signoff to revoke' });
    const columnMap = {
      employee:            'employee_signed_off',
      manager:             'manager_signed_off',
      functional_manager:  'functional_manager_signed_off',
    };
    await pool.query(
      `UPDATE ${table} SET ${columnMap[so.rows[0].role]} = FALSE WHERE id = $1`,
      [req.params.id],
    );
    res.json({ ok: true, revoked_role: so.rows[0].role });
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// POST /api/v2/connect/:module/reports/:userId/:cycleId/grant-view
// Body: { granted_to_user_id, expires_at? }
// --------------------------------------------------------------------------
router.post('/:module/reports/:userId/:cycleId/grant-view', authenticate, async (req, res, next) => {
  try {
    assertModule(req.params.module);
    if (req.user.id !== req.params.userId) {
      return res.status(403).json({ error: 'Only the report owner can grant visibility' });
    }
    const { granted_to_user_id, expires_at } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO objective_visibility_grants
         (module_type, user_id, granted_to_user_id, granted_by, expires_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.module, req.params.userId, granted_to_user_id, req.user.id, expires_at || null],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// --------------------------------------------------------------------------
// GET /api/v2/connect/:module/reports/:userId/:cycleId
// On-screen report (JSON shape that the PDF generator / frontend uses)
// --------------------------------------------------------------------------
router.get('/:module/reports/:userId/:cycleId', authenticate, async (req, res, next) => {
  try {
    assertModule(req.params.module);
    if (!(await canView(req.user.id, req.params.userId))) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const objTable = objectiveTable(req.params.module);
    const reflTable = reflectionTable(req.params.module);

    const [obj, refl, signoffs] = await Promise.all([
      pool.query(`SELECT * FROM ${objTable}
                   WHERE user_id = $1 AND cycle_id = $2
                   ORDER BY created_at`,
                 [req.params.userId, req.params.cycleId]),
      pool.query(`SELECT * FROM ${reflTable}
                   WHERE user_id = $1 AND cycle_id = $2
                   ORDER BY created_at`,
                 [req.params.userId, req.params.cycleId]),
      pool.query(
        `SELECT s.*, u.first_name, u.last_name
           FROM reflection_signoffs s
           JOIN users u ON u.id = s.user_id
          WHERE s.module_type = $1
            AND s.reflection_id IN (
              SELECT id FROM ${reflTable}
               WHERE user_id = $2 AND cycle_id = $3
            )
            AND s.revoked_at IS NULL
          ORDER BY s.signed_at`,
        [req.params.module, req.params.userId, req.params.cycleId],
      ),
    ]);
    res.json({
      objectives: obj.rows,
      reflections: refl.rows,
      signoffs: signoffs.rows,
    });
  } catch (err) { next(err); }
});

module.exports = router;
