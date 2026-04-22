const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireManager, requireAdmin, requireRole, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { sendEmail } = require('../utils/email');
const { v4: uuidv4 } = require('uuid');

// ============================================================================
// SHARED HELPERS
// ============================================================================

function paginate(req) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

async function isObjectiveOwner(objectiveId, userId, companyId, table) {
  const { rows } = await pool.query(
    `SELECT id FROM ${table} WHERE id = $1 AND user_id = $2 AND company_id = $3`,
    [objectiveId, userId, companyId]
  );
  return rows.length > 0;
}

async function getObjective(id, companyId, table) {
  const { rows } = await pool.query(
    `SELECT * FROM ${table} WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  return rows[0] || null;
}

// ============================================================================
// PERFORMANCE CONNECT
// ============================================================================

// --- Templates ---
router.get('/performance/templates', authenticate, [
  query('department_id').optional().isUUID(),
  query('category_id').optional().isUUID()
], validate, async (req, res) => {
  try {
    const { department_id, category_id } = req.query;
    let sql = `
      SELECT t.*, c.name AS category_name
      FROM performance_objective_templates t
      LEFT JOIN objective_categories c ON c.id = t.category_id
      WHERE t.company_id = $1 AND t.active = true
    `;
    const params = [req.user.company_id];
    let idx = 2;

    if (department_id) {
      sql += ` AND t.department_id = $${idx++}`;
      params.push(department_id);
    }
    if (category_id) {
      sql += ` AND t.category_id = $${idx++}`;
      params.push(category_id);
    }
    sql += ' ORDER BY t.name ASC';

    const { rows } = await pool.query(sql, params);
    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing performance templates:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Cycles ---
router.get('/performance/cycles', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM objective_cycles
       WHERE company_id = $1 AND (status = 'active' OR status = 'upcoming')
       ORDER BY start_date ASC`,
      [req.user.company_id]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing cycles:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Performance Objectives CRUD ---
router.get('/performance', authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM performance_objectives WHERE user_id = $1 AND company_id = $2`,
      [req.user.id, req.user.company_id]
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT po.*,
              t.name AS template_name,
              cy.name AS cycle_name, cy.start_date AS cycle_start, cy.end_date AS cycle_end,
              cat.name AS category_name
       FROM performance_objectives po
       LEFT JOIN performance_objective_templates t ON t.id = po.template_id
       LEFT JOIN objective_cycles cy ON cy.id = po.cycle_id
       LEFT JOIN objective_categories cat ON cat.id = po.category_id
       WHERE po.user_id = $1 AND po.company_id = $2
       ORDER BY po.created_at DESC
       LIMIT $3 OFFSET $4`,
      [req.user.id, req.user.company_id, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing performance objectives:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/performance', authenticate, [
  body('title').trim().notEmpty().isLength({ max: 255 }),
  body('description').optional().trim(),
  body('category_id').optional().isUUID(),
  body('template_id').optional().isUUID(),
  body('measure').optional().trim(),
  body('target_date').optional().isISO8601(),
  body('cycle_id').isUUID()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { title, description, category_id, template_id, measure, target_date, cycle_id } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO performance_objectives
        (id, user_id, company_id, title, description, category_id, template_id, measure, target_date, cycle_id, approval_status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, title, description || null, category_id || null,
       template_id || null, measure || null, target_date || null, cycle_id]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating performance objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/performance/:id', authenticate, [
  param('id').isUUID(),
  body('title').optional().trim().notEmpty().isLength({ max: 255 }),
  body('description').optional().trim(),
  body('category_id').optional().isUUID(),
  body('measure').optional().trim(),
  body('target_date').optional().isISO8601()
], validate, async (req, res) => {
  try {
    const obj = await getObjective(req.params.id, req.user.company_id, 'performance_objectives');
    if (!obj) return res.status(404).json({ error: 'Objective not found' });

    const isOwner = obj.user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (isOwner && !isAdmin && obj.approval_status === 'approved') {
      return res.status(403).json({ error: 'Cannot edit an approved objective' });
    }

    const fields = ['title', 'description', 'category_id', 'measure', 'target_date'];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        params.push(req.body[f]);
      }
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push(`updated_at = NOW()`);
    params.push(req.params.id, req.user.company_id);

    const { rows } = await pool.query(
      `UPDATE performance_objectives SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING *`,
      params
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error updating performance objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/performance/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const obj = await getObjective(req.params.id, req.user.company_id, 'performance_objectives');
    if (!obj) return res.status(404).json({ error: 'Objective not found' });

    const isOwner = obj.user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (isOwner && !isAdmin && obj.approval_status === 'approved') {
      return res.status(403).json({ error: 'Cannot delete an approved objective' });
    }

    await pool.query(
      'DELETE FROM performance_objectives WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Objective deleted' });
  } catch (err) {
    console.error('Error deleting performance objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Approval ---
router.post('/performance/:id/approve', authenticate, requireManager, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const obj = await getObjective(req.params.id, req.user.company_id, 'performance_objectives');
    if (!obj) return res.status(404).json({ error: 'Objective not found' });
    if (obj.approval_status === 'approved') return res.status(400).json({ error: 'Already approved' });

    const { rows } = await pool.query(
      `UPDATE performance_objectives
       SET approval_status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [req.user.id, req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error approving performance objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/performance/:id/reject', authenticate, requireManager, [
  param('id').isUUID(),
  body('reason').trim().notEmpty()
], validate, async (req, res) => {
  try {
    const obj = await getObjective(req.params.id, req.user.company_id, 'performance_objectives');
    if (!obj) return res.status(404).json({ error: 'Objective not found' });

    const { rows } = await pool.query(
      `UPDATE performance_objectives
       SET approval_status = 'rejected', rejection_reason = $1, approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING *`,
      [req.body.reason, req.user.id, req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error rejecting performance objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// PERFORMANCE REFLECTIONS
// ============================================================================

router.get('/performance/reflections', authenticate, [
  query('cycle_id').optional().isUUID(),
  query('objective_id').optional().isUUID(),
  query('period').optional().trim()
], validate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);
    const { cycle_id, objective_id, period } = req.query;

    let where = 'r.user_id = $1 AND r.company_id = $2';
    const params = [req.user.id, req.user.company_id];
    let idx = 3;

    if (cycle_id) { where += ` AND r.cycle_id = $${idx++}`; params.push(cycle_id); }
    if (objective_id) { where += ` AND r.objective_id = $${idx++}`; params.push(objective_id); }
    if (period) { where += ` AND r.period = $${idx++}`; params.push(period); }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM performance_reflections r WHERE ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT r.*, po.title AS objective_title
       FROM performance_reflections r
       LEFT JOIN performance_objectives po ON po.id = r.objective_id
       WHERE ${where}
       ORDER BY r.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing performance reflections:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/performance/reflections', authenticate, [
  body('objective_id').isUUID(),
  body('period').trim().notEmpty(),
  body('content').trim().notEmpty(),
  body('actions_required').optional().trim(),
  body('status_id').optional().isUUID(),
  body('self_rating_id').optional().isUUID()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { objective_id, period, content, actions_required, status_id, self_rating_id } = req.body;

    // Verify objective ownership
    const owned = await isObjectiveOwner(objective_id, req.user.id, req.user.company_id, 'performance_objectives');
    if (!owned) return res.status(403).json({ error: 'You do not own this objective' });

    const { rows } = await pool.query(
      `INSERT INTO performance_reflections
        (id, user_id, company_id, objective_id, period, content, actions_required, status_id, self_rating_id, submitted, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, objective_id, period, content,
       actions_required || null, status_id || null, self_rating_id || null]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating performance reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/performance/reflections/:id', authenticate, [
  param('id').isUUID(),
  body('content').optional().trim().notEmpty(),
  body('actions_required').optional().trim(),
  body('status_id').optional().isUUID(),
  body('self_rating_id').optional().isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'performance_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });
    if (reflection.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (reflection.submitted) return res.status(400).json({ error: 'Cannot edit a submitted reflection' });

    const fields = ['content', 'actions_required', 'status_id', 'self_rating_id'];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        params.push(req.body[f]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push('updated_at = NOW()');
    params.push(req.params.id, req.user.company_id);

    const { rows } = await pool.query(
      `UPDATE performance_reflections SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING *`,
      params
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error updating performance reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/performance/reflections/:id/submit', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'performance_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });
    if (reflection.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (reflection.submitted) return res.status(400).json({ error: 'Already submitted' });

    const { rows } = await pool.query(
      `UPDATE performance_reflections
       SET submitted = true, submitted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error submitting performance reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/performance/reflections/:id/manager-review', authenticate, requireManager, [
  param('id').isUUID(),
  body('content').trim().notEmpty(),
  body('status_id').optional().isUUID(),
  body('manager_rating_id').optional().isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'performance_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });
    if (!reflection.submitted) return res.status(400).json({ error: 'Employee has not submitted yet' });

    const { content, status_id, manager_rating_id } = req.body;

    const { rows } = await pool.query(
      `UPDATE performance_reflections
       SET manager_content = $1, manager_status_id = $2, manager_rating_id = $3,
           manager_reviewed_by = $4, manager_reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [content, status_id || null, manager_rating_id || null, req.user.id, req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error adding manager review:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/performance/reflections/:id/functional-review', authenticate, requireRole('functional_manager'), [
  param('id').isUUID(),
  body('content').trim().notEmpty(),
  body('status_id').optional().isUUID(),
  body('functional_rating_id').optional().isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'performance_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });
    if (!reflection.submitted) return res.status(400).json({ error: 'Employee has not submitted yet' });

    const { content, status_id, functional_rating_id } = req.body;

    const { rows } = await pool.query(
      `UPDATE performance_reflections
       SET functional_content = $1, functional_status_id = $2, functional_rating_id = $3,
           functional_reviewed_by = $4, functional_reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [content, status_id || null, functional_rating_id || null, req.user.id, req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error adding functional review:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/performance/reflections/:id/consolidate', authenticate, requireManager, [
  param('id').isUUID(),
  body('final_agreed_status_id').isUUID(),
  body('final_agreed_rating_id').isUUID(),
  body('consolidated_notes').optional().trim()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'performance_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });

    const { final_agreed_status_id, final_agreed_rating_id, consolidated_notes } = req.body;

    const { rows } = await pool.query(
      `UPDATE performance_reflections
       SET final_agreed_status_id = $1, final_agreed_rating_id = $2, consolidated_notes = $3,
           consolidated_by = $4, consolidated_at = NOW(), updated_at = NOW()
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [final_agreed_status_id, final_agreed_rating_id, consolidated_notes || null,
       req.user.id, req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error consolidating reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/performance/reflections/:id/sign-off', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'performance_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });

    const role = req.user.role;
    let column;
    if (reflection.user_id === req.user.id) {
      column = 'employee_signed_off_at';
    } else if (role === 'manager') {
      column = 'manager_signed_off_at';
    } else if (role === 'functional_manager') {
      column = 'functional_signed_off_at';
    } else {
      return res.status(403).json({ error: 'You cannot sign off on this reflection' });
    }

    const { rows } = await pool.query(
      `UPDATE performance_reflections
       SET ${column} = NOW(), updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error signing off reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// PERFORMANCE STAKEHOLDER FEEDBACK
// ============================================================================

router.post('/performance/reflections/:id/request-feedback', authenticate, [
  param('id').isUUID(),
  body('stakeholder_ids').isArray({ min: 1 }),
  body('stakeholder_ids.*').isUUID(),
  body('objective_ids').optional().isArray(),
  body('objective_ids.*').optional().isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'performance_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });

    const { stakeholder_ids, objective_ids } = req.body;
    const created = [];

    for (const stakeholderId of stakeholder_ids) {
      const id = uuidv4();
      const { rows } = await pool.query(
        `INSERT INTO performance_stakeholder_feedback
          (id, reflection_id, company_id, stakeholder_id, requested_by, objective_ids, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW(),NOW())
         RETURNING *`,
        [id, req.params.id, req.user.company_id, stakeholderId, req.user.id,
         JSON.stringify(objective_ids || [])]
      );
      created.push(rows[0]);

      // Send notification email
      const stakeholder = await pool.query('SELECT email, first_name FROM users WHERE id = $1', [stakeholderId]);
      if (stakeholder.rows[0]) {
        sendEmail({
          to: stakeholder.rows[0].email,
          subject: 'Feedback Requested',
          text: `Hi ${stakeholder.rows[0].first_name}, you have been asked to provide stakeholder feedback.`
        }).catch(e => console.error('Email send failed:', e));
      }
    }

    res.status(201).json({ data: created });
  } catch (err) {
    console.error('Error requesting feedback:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/performance/reflections/:id/feedback', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, u.first_name AS stakeholder_first_name, u.last_name AS stakeholder_last_name
       FROM performance_stakeholder_feedback f
       LEFT JOIN users u ON u.id = f.stakeholder_id
       WHERE f.reflection_id = $1 AND f.company_id = $2
       ORDER BY f.created_at ASC`,
      [req.params.id, req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing feedback:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/performance/feedback/:feedbackId/submit', authenticate, [
  param('feedbackId').isUUID(),
  body('text').trim().notEmpty(),
  body('rating').optional().isInt({ min: 1, max: 5 })
], validate, async (req, res) => {
  try {
    const fb = await pool.query(
      'SELECT * FROM performance_stakeholder_feedback WHERE id = $1 AND company_id = $2',
      [req.params.feedbackId, req.user.company_id]
    );
    if (!fb.rows[0]) return res.status(404).json({ error: 'Feedback request not found' });
    if (fb.rows[0].stakeholder_id !== req.user.id) return res.status(403).json({ error: 'Not your feedback request' });
    if (fb.rows[0].status === 'completed') return res.status(400).json({ error: 'Already submitted' });

    const { text, rating } = req.body;

    const { rows } = await pool.query(
      `UPDATE performance_stakeholder_feedback
       SET feedback_text = $1, rating = $2, status = 'completed', submitted_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING *`,
      [text, rating || null, req.params.feedbackId, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error submitting feedback:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// PERFORMANCE ADHOC NOTES (V2)
// ============================================================================

router.get('/performance/notes', authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM performance_adhoc_notes WHERE user_id = $1 AND company_id = $2',
      [req.user.id, req.user.company_id]
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT n.*, array_agg(nol.objective_id) FILTER (WHERE nol.objective_id IS NOT NULL) AS linked_objective_ids
       FROM performance_adhoc_notes n
       LEFT JOIN performance_note_objective_links nol ON nol.note_id = n.id
       WHERE n.user_id = $1 AND n.company_id = $2
       GROUP BY n.id
       ORDER BY n.note_date DESC
       LIMIT $3 OFFSET $4`,
      [req.user.id, req.user.company_id, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing performance notes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/performance/notes', authenticate, [
  body('note_date').isISO8601(),
  body('interaction_type').trim().notEmpty(),
  body('summary').trim().notEmpty(),
  body('key_observations').optional().trim(),
  body('agreed_actions').optional().trim(),
  body('linked_objective_ids').optional().isArray(),
  body('linked_objective_ids.*').optional().isUUID()
], validate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const id = uuidv4();
    const { note_date, interaction_type, summary, key_observations, agreed_actions, linked_objective_ids } = req.body;

    const { rows } = await client.query(
      `INSERT INTO performance_adhoc_notes
        (id, user_id, company_id, note_date, interaction_type, summary, key_observations, agreed_actions, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, note_date, interaction_type, summary,
       key_observations || null, agreed_actions || null]
    );

    if (linked_objective_ids && linked_objective_ids.length > 0) {
      for (const objId of linked_objective_ids) {
        await client.query(
          'INSERT INTO performance_note_objective_links (id, note_id, objective_id) VALUES ($1,$2,$3)',
          [uuidv4(), id, objId]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ data: { ...rows[0], linked_objective_ids: linked_objective_ids || [] } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating performance note:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.patch('/performance/notes/:id', authenticate, [
  param('id').isUUID(),
  body('note_date').optional().isISO8601(),
  body('interaction_type').optional().trim().notEmpty(),
  body('summary').optional().trim().notEmpty(),
  body('key_observations').optional().trim(),
  body('agreed_actions').optional().trim(),
  body('linked_objective_ids').optional().isArray(),
  body('linked_objective_ids.*').optional().isUUID()
], validate, async (req, res) => {
  const client = await pool.connect();
  try {
    const note = await getObjective(req.params.id, req.user.company_id, 'performance_adhoc_notes');
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await client.query('BEGIN');

    const fields = ['note_date', 'interaction_type', 'summary', 'key_observations', 'agreed_actions'];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        params.push(req.body[f]);
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = NOW()');
      params.push(req.params.id, req.user.company_id);
      await client.query(
        `UPDATE performance_adhoc_notes SET ${updates.join(', ')}
         WHERE id = $${idx++} AND company_id = $${idx}`,
        params
      );
    }

    if (req.body.linked_objective_ids !== undefined) {
      await client.query('DELETE FROM performance_note_objective_links WHERE note_id = $1', [req.params.id]);
      for (const objId of req.body.linked_objective_ids) {
        await client.query(
          'INSERT INTO performance_note_objective_links (id, note_id, objective_id) VALUES ($1,$2,$3)',
          [uuidv4(), req.params.id, objId]
        );
      }
    }

    await client.query('COMMIT');

    const { rows } = await pool.query(
      'SELECT * FROM performance_adhoc_notes WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating performance note:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.delete('/performance/notes/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const note = await getObjective(req.params.id, req.user.company_id, 'performance_adhoc_notes');
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      'DELETE FROM performance_adhoc_notes WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Note deleted' });
  } catch (err) {
    console.error('Error deleting performance note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// PERFORMANCE ATTACHMENTS (V2)
// ============================================================================

router.post('/performance/attachments', authenticate, [
  body('entity_type').trim().notEmpty(),
  body('entity_id').isUUID(),
  body('file_name').trim().notEmpty(),
  body('file_url').trim().isURL(),
  body('file_type').optional().trim(),
  body('file_size').optional().isInt({ min: 0 }),
  body('description').optional().trim()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { entity_type, entity_id, file_name, file_url, file_type, file_size, description } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO performance_attachments
        (id, user_id, company_id, entity_type, entity_id, file_name, file_url, file_type, file_size, description, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, entity_type, entity_id, file_name, file_url,
       file_type || null, file_size || null, description || null]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating attachment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/performance/attachments', authenticate, [
  query('entity_type').trim().notEmpty(),
  query('entity_id').isUUID()
], validate, async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;

    const { rows } = await pool.query(
      `SELECT a.*, u.first_name AS uploaded_by_first_name, u.last_name AS uploaded_by_last_name
       FROM performance_attachments a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity_type = $1 AND a.entity_id = $2 AND a.company_id = $3
       ORDER BY a.created_at DESC`,
      [entity_type, entity_id, req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing attachments:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/performance/attachments/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM performance_attachments WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Attachment not found' });
    if (rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      'DELETE FROM performance_attachments WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Attachment deleted' });
  } catch (err) {
    console.error('Error deleting attachment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// DEVELOPMENT CONNECT
// ============================================================================

// --- Development Objectives CRUD ---
router.get('/development', authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM development_objectives WHERE user_id = $1 AND company_id = $2',
      [req.user.id, req.user.company_id]
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT do_obj.*,
              t.name AS template_name,
              cy.name AS cycle_name,
              cat.name AS category_name
       FROM development_objectives do_obj
       LEFT JOIN development_objective_templates t ON t.id = do_obj.template_id
       LEFT JOIN objective_cycles cy ON cy.id = do_obj.cycle_id
       LEFT JOIN objective_categories cat ON cat.id = do_obj.category_id
       WHERE do_obj.user_id = $1 AND do_obj.company_id = $2
       ORDER BY do_obj.created_at DESC
       LIMIT $3 OFFSET $4`,
      [req.user.id, req.user.company_id, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing development objectives:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/development', authenticate, [
  body('title').trim().notEmpty().isLength({ max: 255 }),
  body('description').optional().trim(),
  body('category_id').optional().isUUID(),
  body('template_id').optional().isUUID(),
  body('measure').optional().trim(),
  body('target_date').optional().isISO8601(),
  body('cycle_id').isUUID(),
  body('skill_area').optional().trim(),
  body('resources').optional().trim()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { title, description, category_id, template_id, measure, target_date, cycle_id, skill_area, resources } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO development_objectives
        (id, user_id, company_id, title, description, category_id, template_id, measure, target_date, cycle_id,
         skill_area, resources, approval_status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, title, description || null, category_id || null,
       template_id || null, measure || null, target_date || null, cycle_id,
       skill_area || null, resources || null]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating development objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/development/:id', authenticate, [
  param('id').isUUID(),
  body('title').optional().trim().notEmpty().isLength({ max: 255 }),
  body('description').optional().trim(),
  body('category_id').optional().isUUID(),
  body('measure').optional().trim(),
  body('target_date').optional().isISO8601(),
  body('skill_area').optional().trim(),
  body('resources').optional().trim()
], validate, async (req, res) => {
  try {
    const obj = await getObjective(req.params.id, req.user.company_id, 'development_objectives');
    if (!obj) return res.status(404).json({ error: 'Objective not found' });

    const isOwner = obj.user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Access denied' });
    if (isOwner && !isAdmin && obj.approval_status === 'approved') {
      return res.status(403).json({ error: 'Cannot edit an approved objective' });
    }

    const fields = ['title', 'description', 'category_id', 'measure', 'target_date', 'skill_area', 'resources'];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        params.push(req.body[f]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push('updated_at = NOW()');
    params.push(req.params.id, req.user.company_id);

    const { rows } = await pool.query(
      `UPDATE development_objectives SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING *`,
      params
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error updating development objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/development/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const obj = await getObjective(req.params.id, req.user.company_id, 'development_objectives');
    if (!obj) return res.status(404).json({ error: 'Objective not found' });

    const isOwner = obj.user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Access denied' });
    if (isOwner && !isAdmin && obj.approval_status === 'approved') {
      return res.status(403).json({ error: 'Cannot delete an approved objective' });
    }

    await pool.query(
      'DELETE FROM development_objectives WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Objective deleted' });
  } catch (err) {
    console.error('Error deleting development objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Development Approval ---
router.post('/development/:id/approve', authenticate, requireManager, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const obj = await getObjective(req.params.id, req.user.company_id, 'development_objectives');
    if (!obj) return res.status(404).json({ error: 'Objective not found' });
    if (obj.approval_status === 'approved') return res.status(400).json({ error: 'Already approved' });

    const { rows } = await pool.query(
      `UPDATE development_objectives
       SET approval_status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [req.user.id, req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error approving development objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/development/:id/reject', authenticate, requireManager, [
  param('id').isUUID(),
  body('reason').trim().notEmpty()
], validate, async (req, res) => {
  try {
    const obj = await getObjective(req.params.id, req.user.company_id, 'development_objectives');
    if (!obj) return res.status(404).json({ error: 'Objective not found' });

    const { rows } = await pool.query(
      `UPDATE development_objectives
       SET approval_status = 'rejected', rejection_reason = $1, approved_by = $2, approved_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING *`,
      [req.body.reason, req.user.id, req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error rejecting development objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Development Reflections ---
router.get('/development/reflections', authenticate, [
  query('cycle_id').optional().isUUID(),
  query('objective_id').optional().isUUID(),
  query('period').optional().trim()
], validate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);
    const { cycle_id, objective_id, period } = req.query;

    let where = 'r.user_id = $1 AND r.company_id = $2';
    const params = [req.user.id, req.user.company_id];
    let idx = 3;

    if (cycle_id) { where += ` AND r.cycle_id = $${idx++}`; params.push(cycle_id); }
    if (objective_id) { where += ` AND r.objective_id = $${idx++}`; params.push(objective_id); }
    if (period) { where += ` AND r.period = $${idx++}`; params.push(period); }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM development_reflections r WHERE ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT r.*, d.title AS objective_title
       FROM development_reflections r
       LEFT JOIN development_objectives d ON d.id = r.objective_id
       WHERE ${where}
       ORDER BY r.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing development reflections:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/development/reflections', authenticate, [
  body('objective_id').isUUID(),
  body('period').trim().notEmpty(),
  body('content').trim().notEmpty(),
  body('learning_achieved').optional().trim(),
  body('skills_developed').optional().trim(),
  body('application_of_learning').optional().trim(),
  body('actions_required').optional().trim(),
  body('status_id').optional().isUUID(),
  body('self_rating_id').optional().isUUID()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { objective_id, period, content, learning_achieved, skills_developed,
            application_of_learning, actions_required, status_id, self_rating_id } = req.body;

    const owned = await isObjectiveOwner(objective_id, req.user.id, req.user.company_id, 'development_objectives');
    if (!owned) return res.status(403).json({ error: 'You do not own this objective' });

    const { rows } = await pool.query(
      `INSERT INTO development_reflections
        (id, user_id, company_id, objective_id, period, content, learning_achieved, skills_developed,
         application_of_learning, actions_required, status_id, self_rating_id, submitted, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, objective_id, period, content,
       learning_achieved || null, skills_developed || null, application_of_learning || null,
       actions_required || null, status_id || null, self_rating_id || null]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating development reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/development/reflections/:id', authenticate, [
  param('id').isUUID(),
  body('content').optional().trim().notEmpty(),
  body('learning_achieved').optional().trim(),
  body('skills_developed').optional().trim(),
  body('application_of_learning').optional().trim(),
  body('actions_required').optional().trim(),
  body('status_id').optional().isUUID(),
  body('self_rating_id').optional().isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'development_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });
    if (reflection.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (reflection.submitted) return res.status(400).json({ error: 'Cannot edit a submitted reflection' });

    const fields = ['content', 'learning_achieved', 'skills_developed', 'application_of_learning',
                     'actions_required', 'status_id', 'self_rating_id'];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        params.push(req.body[f]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push('updated_at = NOW()');
    params.push(req.params.id, req.user.company_id);

    const { rows } = await pool.query(
      `UPDATE development_reflections SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING *`,
      params
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error updating development reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/development/reflections/:id/submit', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'development_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });
    if (reflection.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (reflection.submitted) return res.status(400).json({ error: 'Already submitted' });

    const { rows } = await pool.query(
      `UPDATE development_reflections
       SET submitted = true, submitted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error submitting development reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/development/reflections/:id/manager-review', authenticate, requireManager, [
  param('id').isUUID(),
  body('content').trim().notEmpty(),
  body('status_id').optional().isUUID(),
  body('manager_rating_id').optional().isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'development_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });
    if (!reflection.submitted) return res.status(400).json({ error: 'Employee has not submitted yet' });

    const { content, status_id, manager_rating_id } = req.body;

    const { rows } = await pool.query(
      `UPDATE development_reflections
       SET manager_content = $1, manager_status_id = $2, manager_rating_id = $3,
           manager_reviewed_by = $4, manager_reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [content, status_id || null, manager_rating_id || null, req.user.id, req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error adding manager review:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/development/reflections/:id/functional-review', authenticate, requireRole('functional_manager'), [
  param('id').isUUID(),
  body('content').trim().notEmpty(),
  body('status_id').optional().isUUID(),
  body('functional_rating_id').optional().isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'development_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });
    if (!reflection.submitted) return res.status(400).json({ error: 'Employee has not submitted yet' });

    const { content, status_id, functional_rating_id } = req.body;

    const { rows } = await pool.query(
      `UPDATE development_reflections
       SET functional_content = $1, functional_status_id = $2, functional_rating_id = $3,
           functional_reviewed_by = $4, functional_reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [content, status_id || null, functional_rating_id || null, req.user.id, req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error adding functional review:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/development/reflections/:id/consolidate', authenticate, requireManager, [
  param('id').isUUID(),
  body('final_agreed_status_id').isUUID(),
  body('final_agreed_rating_id').isUUID(),
  body('consolidated_notes').optional().trim()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'development_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });

    const { final_agreed_status_id, final_agreed_rating_id, consolidated_notes } = req.body;

    const { rows } = await pool.query(
      `UPDATE development_reflections
       SET final_agreed_status_id = $1, final_agreed_rating_id = $2, consolidated_notes = $3,
           consolidated_by = $4, consolidated_at = NOW(), updated_at = NOW()
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [final_agreed_status_id, final_agreed_rating_id, consolidated_notes || null,
       req.user.id, req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error consolidating development reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/development/reflections/:id/sign-off', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'development_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });

    const role = req.user.role;
    let column;
    if (reflection.user_id === req.user.id) {
      column = 'employee_signed_off_at';
    } else if (role === 'manager') {
      column = 'manager_signed_off_at';
    } else if (role === 'functional_manager') {
      column = 'functional_signed_off_at';
    } else {
      return res.status(403).json({ error: 'You cannot sign off on this reflection' });
    }

    const { rows } = await pool.query(
      `UPDATE development_reflections
       SET ${column} = NOW(), updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error signing off development reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Development Stakeholder Feedback ---
router.post('/development/reflections/:id/request-feedback', authenticate, [
  param('id').isUUID(),
  body('stakeholder_ids').isArray({ min: 1 }),
  body('stakeholder_ids.*').isUUID(),
  body('objective_ids').optional().isArray(),
  body('objective_ids.*').optional().isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'development_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });

    const { stakeholder_ids, objective_ids } = req.body;
    const created = [];

    for (const stakeholderId of stakeholder_ids) {
      const id = uuidv4();
      const { rows } = await pool.query(
        `INSERT INTO development_stakeholder_feedback
          (id, reflection_id, company_id, stakeholder_id, requested_by, objective_ids, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW(),NOW())
         RETURNING *`,
        [id, req.params.id, req.user.company_id, stakeholderId, req.user.id,
         JSON.stringify(objective_ids || [])]
      );
      created.push(rows[0]);

      const stakeholder = await pool.query('SELECT email, first_name FROM users WHERE id = $1', [stakeholderId]);
      if (stakeholder.rows[0]) {
        sendEmail({
          to: stakeholder.rows[0].email,
          subject: 'Development Feedback Requested',
          text: `Hi ${stakeholder.rows[0].first_name}, you have been asked to provide development feedback.`
        }).catch(e => console.error('Email send failed:', e));
      }
    }

    res.status(201).json({ data: created });
  } catch (err) {
    console.error('Error requesting development feedback:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/development/reflections/:id/feedback', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, u.first_name AS stakeholder_first_name, u.last_name AS stakeholder_last_name
       FROM development_stakeholder_feedback f
       LEFT JOIN users u ON u.id = f.stakeholder_id
       WHERE f.reflection_id = $1 AND f.company_id = $2
       ORDER BY f.created_at ASC`,
      [req.params.id, req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing development feedback:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/development/feedback/:feedbackId/submit', authenticate, [
  param('feedbackId').isUUID(),
  body('text').trim().notEmpty(),
  body('rating').optional().isInt({ min: 1, max: 5 })
], validate, async (req, res) => {
  try {
    const fb = await pool.query(
      'SELECT * FROM development_stakeholder_feedback WHERE id = $1 AND company_id = $2',
      [req.params.feedbackId, req.user.company_id]
    );
    if (!fb.rows[0]) return res.status(404).json({ error: 'Feedback request not found' });
    if (fb.rows[0].stakeholder_id !== req.user.id) return res.status(403).json({ error: 'Not your feedback request' });
    if (fb.rows[0].status === 'completed') return res.status(400).json({ error: 'Already submitted' });

    const { text, rating } = req.body;

    const { rows } = await pool.query(
      `UPDATE development_stakeholder_feedback
       SET feedback_text = $1, rating = $2, status = 'completed', submitted_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING *`,
      [text, rating || null, req.params.feedbackId, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error submitting development feedback:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Development Adhoc Notes ---
router.get('/development/notes', authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM development_adhoc_notes WHERE user_id = $1 AND company_id = $2',
      [req.user.id, req.user.company_id]
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT n.*, array_agg(nol.objective_id) FILTER (WHERE nol.objective_id IS NOT NULL) AS linked_objective_ids
       FROM development_adhoc_notes n
       LEFT JOIN development_note_objective_links nol ON nol.note_id = n.id
       WHERE n.user_id = $1 AND n.company_id = $2
       GROUP BY n.id
       ORDER BY n.note_date DESC
       LIMIT $3 OFFSET $4`,
      [req.user.id, req.user.company_id, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing development notes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/development/notes', authenticate, [
  body('note_date').isISO8601(),
  body('interaction_type').trim().notEmpty(),
  body('summary').trim().notEmpty(),
  body('key_observations').optional().trim(),
  body('agreed_actions').optional().trim(),
  body('linked_objective_ids').optional().isArray(),
  body('linked_objective_ids.*').optional().isUUID()
], validate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const id = uuidv4();
    const { note_date, interaction_type, summary, key_observations, agreed_actions, linked_objective_ids } = req.body;

    const { rows } = await client.query(
      `INSERT INTO development_adhoc_notes
        (id, user_id, company_id, note_date, interaction_type, summary, key_observations, agreed_actions, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, note_date, interaction_type, summary,
       key_observations || null, agreed_actions || null]
    );

    if (linked_objective_ids && linked_objective_ids.length > 0) {
      for (const objId of linked_objective_ids) {
        await client.query(
          'INSERT INTO development_note_objective_links (id, note_id, objective_id) VALUES ($1,$2,$3)',
          [uuidv4(), id, objId]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ data: { ...rows[0], linked_objective_ids: linked_objective_ids || [] } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating development note:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.patch('/development/notes/:id', authenticate, [
  param('id').isUUID(),
  body('note_date').optional().isISO8601(),
  body('interaction_type').optional().trim().notEmpty(),
  body('summary').optional().trim().notEmpty(),
  body('key_observations').optional().trim(),
  body('agreed_actions').optional().trim(),
  body('linked_objective_ids').optional().isArray(),
  body('linked_objective_ids.*').optional().isUUID()
], validate, async (req, res) => {
  const client = await pool.connect();
  try {
    const note = await getObjective(req.params.id, req.user.company_id, 'development_adhoc_notes');
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await client.query('BEGIN');

    const fields = ['note_date', 'interaction_type', 'summary', 'key_observations', 'agreed_actions'];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        params.push(req.body[f]);
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = NOW()');
      params.push(req.params.id, req.user.company_id);
      await client.query(
        `UPDATE development_adhoc_notes SET ${updates.join(', ')}
         WHERE id = $${idx++} AND company_id = $${idx}`,
        params
      );
    }

    if (req.body.linked_objective_ids !== undefined) {
      await client.query('DELETE FROM development_note_objective_links WHERE note_id = $1', [req.params.id]);
      for (const objId of req.body.linked_objective_ids) {
        await client.query(
          'INSERT INTO development_note_objective_links (id, note_id, objective_id) VALUES ($1,$2,$3)',
          [uuidv4(), req.params.id, objId]
        );
      }
    }

    await client.query('COMMIT');

    const { rows } = await pool.query(
      'SELECT * FROM development_adhoc_notes WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating development note:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.delete('/development/notes/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const note = await getObjective(req.params.id, req.user.company_id, 'development_adhoc_notes');
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      'DELETE FROM development_adhoc_notes WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Note deleted' });
  } catch (err) {
    console.error('Error deleting development note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Development Attachments ---
router.post('/development/attachments', authenticate, [
  body('entity_type').trim().notEmpty(),
  body('entity_id').isUUID(),
  body('file_name').trim().notEmpty(),
  body('file_url').trim().isURL(),
  body('file_type').optional().trim(),
  body('file_size').optional().isInt({ min: 0 }),
  body('description').optional().trim()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { entity_type, entity_id, file_name, file_url, file_type, file_size, description } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO development_attachments
        (id, user_id, company_id, entity_type, entity_id, file_name, file_url, file_type, file_size, description, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, entity_type, entity_id, file_name, file_url,
       file_type || null, file_size || null, description || null]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating development attachment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/development/attachments', authenticate, [
  query('entity_type').trim().notEmpty(),
  query('entity_id').isUUID()
], validate, async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;

    const { rows } = await pool.query(
      `SELECT a.*, u.first_name AS uploaded_by_first_name, u.last_name AS uploaded_by_last_name
       FROM development_attachments a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity_type = $1 AND a.entity_id = $2 AND a.company_id = $3
       ORDER BY a.created_at DESC`,
      [entity_type, entity_id, req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing development attachments:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/development/attachments/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM development_attachments WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Attachment not found' });
    if (rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      'DELETE FROM development_attachments WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Attachment deleted' });
  } catch (err) {
    console.error('Error deleting development attachment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// WELLBEING CONNECT
// ============================================================================

// --- Wellbeing Objectives CRUD ---
router.get('/wellbeing', authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM wellbeing_objectives WHERE user_id = $1 AND company_id = $2',
      [req.user.id, req.user.company_id]
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT * FROM wellbeing_objectives
       WHERE user_id = $1 AND company_id = $2
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [req.user.id, req.user.company_id, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing wellbeing objectives:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/wellbeing', authenticate, [
  body('title').trim().notEmpty().isLength({ max: 255 }),
  body('description').optional().trim(),
  body('category').isIn(['Mental', 'Physical', 'Emotional', 'Social', 'Financial']),
  body('measure').optional().trim(),
  body('visible_to_manager').optional().isBoolean(),
  body('visible_to_functional_manager').optional().isBoolean()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { title, description, category, measure, visible_to_manager, visible_to_functional_manager } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO wellbeing_objectives
        (id, user_id, company_id, title, description, category, measure,
         visible_to_manager, visible_to_functional_manager, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, title, description || null, category, measure || null,
       visible_to_manager === true ? true : false,
       visible_to_functional_manager === true ? true : false]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating wellbeing objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/wellbeing/:id', authenticate, [
  param('id').isUUID(),
  body('title').optional().trim().notEmpty().isLength({ max: 255 }),
  body('description').optional().trim(),
  body('category').optional().isIn(['Mental', 'Physical', 'Emotional', 'Social', 'Financial']),
  body('measure').optional().trim(),
  body('visible_to_manager').optional().isBoolean(),
  body('visible_to_functional_manager').optional().isBoolean()
], validate, async (req, res) => {
  try {
    const obj = await getObjective(req.params.id, req.user.company_id, 'wellbeing_objectives');
    if (!obj) return res.status(404).json({ error: 'Objective not found' });
    if (obj.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const fields = ['title', 'description', 'category', 'measure', 'visible_to_manager', 'visible_to_functional_manager'];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        params.push(req.body[f]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push('updated_at = NOW()');
    params.push(req.params.id, req.user.company_id);

    const { rows } = await pool.query(
      `UPDATE wellbeing_objectives SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING *`,
      params
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error updating wellbeing objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/wellbeing/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const obj = await getObjective(req.params.id, req.user.company_id, 'wellbeing_objectives');
    if (!obj) return res.status(404).json({ error: 'Objective not found' });
    if (obj.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      'DELETE FROM wellbeing_objectives WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Objective deleted' });
  } catch (err) {
    console.error('Error deleting wellbeing objective:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Wellbeing Visibility (manager access) ---
router.get('/wellbeing/team', authenticate, requireManager, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM wellbeing_objectives wo
       JOIN users u ON u.id = wo.user_id
       WHERE wo.company_id = $1 AND u.manager_id = $2 AND wo.visible_to_manager = true`,
      [req.user.company_id, req.user.id]
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT wo.*, u.first_name, u.last_name, u.email
       FROM wellbeing_objectives wo
       JOIN users u ON u.id = wo.user_id
       WHERE wo.company_id = $1 AND u.manager_id = $2 AND wo.visible_to_manager = true
       ORDER BY wo.created_at DESC
       LIMIT $3 OFFSET $4`,
      [req.user.company_id, req.user.id, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing team wellbeing objectives:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Wellbeing Reflections (non-rated) ---
router.get('/wellbeing/reflections', authenticate, [
  query('objective_id').optional().isUUID(),
  query('period').optional().trim()
], validate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);
    const { objective_id, period } = req.query;

    let where = 'r.user_id = $1 AND r.company_id = $2';
    const params = [req.user.id, req.user.company_id];
    let idx = 3;

    if (objective_id) { where += ` AND r.objective_id = $${idx++}`; params.push(objective_id); }
    if (period) { where += ` AND r.period = $${idx++}`; params.push(period); }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM wellbeing_reflections r WHERE ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT r.*, wo.title AS objective_title, wo.category AS objective_category
       FROM wellbeing_reflections r
       LEFT JOIN wellbeing_objectives wo ON wo.id = r.objective_id
       WHERE ${where}
       ORDER BY r.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing wellbeing reflections:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/wellbeing/reflections', authenticate, [
  body('objective_id').isUUID(),
  body('period').trim().notEmpty(),
  body('summary').trim().notEmpty(),
  body('actions_required').optional().trim(),
  body('status').optional().trim()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { objective_id, period, summary, actions_required, status } = req.body;

    const owned = await isObjectiveOwner(objective_id, req.user.id, req.user.company_id, 'wellbeing_objectives');
    if (!owned) return res.status(403).json({ error: 'You do not own this objective' });

    const { rows } = await pool.query(
      `INSERT INTO wellbeing_reflections
        (id, user_id, company_id, objective_id, period, summary, actions_required, status, submitted, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, objective_id, period, summary,
       actions_required || null, status || null]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating wellbeing reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/wellbeing/reflections/:id', authenticate, [
  param('id').isUUID(),
  body('summary').optional().trim().notEmpty(),
  body('actions_required').optional().trim(),
  body('status').optional().trim()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'wellbeing_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });
    if (reflection.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (reflection.submitted) return res.status(400).json({ error: 'Cannot edit a submitted reflection' });

    const fields = ['summary', 'actions_required', 'status'];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        params.push(req.body[f]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push('updated_at = NOW()');
    params.push(req.params.id, req.user.company_id);

    const { rows } = await pool.query(
      `UPDATE wellbeing_reflections SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING *`,
      params
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error updating wellbeing reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/wellbeing/reflections/:id/submit', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'wellbeing_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });
    if (reflection.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (reflection.submitted) return res.status(400).json({ error: 'Already submitted' });

    const { rows } = await pool.query(
      `UPDATE wellbeing_reflections
       SET submitted = true, submitted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error submitting wellbeing reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/wellbeing/reflections/:id/consolidate', authenticate, requireManager, [
  param('id').isUUID(),
  body('final_agreed_status').trim().notEmpty(),
  body('consolidation_comments').optional().trim(),
  body('ownership_model').isIn(['employee_led', 'manager_led', 'joint'])
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'wellbeing_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });

    // Check visibility - manager can only consolidate if visible
    const objective = await getObjective(reflection.objective_id, req.user.company_id, 'wellbeing_objectives');
    if (!objective || !objective.visible_to_manager) {
      return res.status(403).json({ error: 'This wellbeing objective is not visible to you' });
    }

    const { final_agreed_status, consolidation_comments, ownership_model } = req.body;

    const { rows } = await pool.query(
      `UPDATE wellbeing_reflections
       SET final_agreed_status = $1, consolidation_comments = $2, ownership_model = $3,
           consolidated_by = $4, consolidated_at = NOW(), updated_at = NOW()
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [final_agreed_status, consolidation_comments || null, ownership_model,
       req.user.id, req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error consolidating wellbeing reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/wellbeing/reflections/:id/sign-off', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'wellbeing_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });

    const role = req.user.role;
    let column;
    if (reflection.user_id === req.user.id) {
      column = 'employee_signed_off_at';
    } else if (role === 'manager') {
      const objective = await getObjective(reflection.objective_id, req.user.company_id, 'wellbeing_objectives');
      if (!objective || !objective.visible_to_manager) {
        return res.status(403).json({ error: 'This wellbeing objective is not visible to you' });
      }
      column = 'manager_signed_off_at';
    } else if (role === 'functional_manager') {
      const objective = await getObjective(reflection.objective_id, req.user.company_id, 'wellbeing_objectives');
      if (!objective || !objective.visible_to_functional_manager) {
        return res.status(403).json({ error: 'This wellbeing objective is not visible to you' });
      }
      column = 'functional_signed_off_at';
    } else {
      return res.status(403).json({ error: 'You cannot sign off on this reflection' });
    }

    const { rows } = await pool.query(
      `UPDATE wellbeing_reflections
       SET ${column} = NOW(), updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error signing off wellbeing reflection:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Wellbeing Stakeholder Feedback (qualitative only, no rating) ---
router.post('/wellbeing/reflections/:id/request-feedback', authenticate, [
  param('id').isUUID(),
  body('stakeholder_ids').isArray({ min: 1 }),
  body('stakeholder_ids.*').isUUID(),
  body('objective_ids').optional().isArray(),
  body('objective_ids.*').optional().isUUID()
], validate, async (req, res) => {
  try {
    const reflection = await getObjective(req.params.id, req.user.company_id, 'wellbeing_reflections');
    if (!reflection) return res.status(404).json({ error: 'Reflection not found' });
    if (reflection.user_id !== req.user.id) return res.status(403).json({ error: 'Only the owner can request feedback' });

    const { stakeholder_ids, objective_ids } = req.body;
    const created = [];

    for (const stakeholderId of stakeholder_ids) {
      const id = uuidv4();
      const { rows } = await pool.query(
        `INSERT INTO wellbeing_stakeholder_feedback
          (id, reflection_id, company_id, stakeholder_id, requested_by, objective_ids, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW(),NOW())
         RETURNING *`,
        [id, req.params.id, req.user.company_id, stakeholderId, req.user.id,
         JSON.stringify(objective_ids || [])]
      );
      created.push(rows[0]);

      const stakeholder = await pool.query('SELECT email, first_name FROM users WHERE id = $1', [stakeholderId]);
      if (stakeholder.rows[0]) {
        sendEmail({
          to: stakeholder.rows[0].email,
          subject: 'Wellbeing Feedback Requested',
          text: `Hi ${stakeholder.rows[0].first_name}, you have been asked to provide wellbeing feedback.`
        }).catch(e => console.error('Email send failed:', e));
      }
    }

    res.status(201).json({ data: created });
  } catch (err) {
    console.error('Error requesting wellbeing feedback:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/wellbeing/reflections/:id/feedback', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, u.first_name AS stakeholder_first_name, u.last_name AS stakeholder_last_name
       FROM wellbeing_stakeholder_feedback f
       LEFT JOIN users u ON u.id = f.stakeholder_id
       WHERE f.reflection_id = $1 AND f.company_id = $2
       ORDER BY f.created_at ASC`,
      [req.params.id, req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing wellbeing feedback:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/wellbeing/feedback/:feedbackId/submit', authenticate, [
  param('feedbackId').isUUID(),
  body('text').trim().notEmpty()
  // No rating for wellbeing - qualitative only
], validate, async (req, res) => {
  try {
    const fb = await pool.query(
      'SELECT * FROM wellbeing_stakeholder_feedback WHERE id = $1 AND company_id = $2',
      [req.params.feedbackId, req.user.company_id]
    );
    if (!fb.rows[0]) return res.status(404).json({ error: 'Feedback request not found' });
    if (fb.rows[0].stakeholder_id !== req.user.id) return res.status(403).json({ error: 'Not your feedback request' });
    if (fb.rows[0].status === 'completed') return res.status(400).json({ error: 'Already submitted' });

    const { text } = req.body;

    const { rows } = await pool.query(
      `UPDATE wellbeing_stakeholder_feedback
       SET feedback_text = $1, status = 'completed', submitted_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND company_id = $3
       RETURNING *`,
      [text, req.params.feedbackId, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error submitting wellbeing feedback:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Wellbeing Adhoc Notes ---
router.get('/wellbeing/notes', authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM wellbeing_adhoc_notes WHERE user_id = $1 AND company_id = $2',
      [req.user.id, req.user.company_id]
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT n.*, array_agg(nol.objective_id) FILTER (WHERE nol.objective_id IS NOT NULL) AS linked_objective_ids
       FROM wellbeing_adhoc_notes n
       LEFT JOIN wellbeing_note_objective_links nol ON nol.note_id = n.id
       WHERE n.user_id = $1 AND n.company_id = $2
       GROUP BY n.id
       ORDER BY n.note_date DESC
       LIMIT $3 OFFSET $4`,
      [req.user.id, req.user.company_id, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing wellbeing notes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/wellbeing/notes', authenticate, [
  body('note_date').isISO8601(),
  body('interaction_type').trim().notEmpty(),
  body('summary').trim().notEmpty(),
  body('key_observations').optional().trim(),
  body('agreed_actions').optional().trim(),
  body('linked_objective_ids').optional().isArray(),
  body('linked_objective_ids.*').optional().isUUID()
], validate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const id = uuidv4();
    const { note_date, interaction_type, summary, key_observations, agreed_actions, linked_objective_ids } = req.body;

    const { rows } = await client.query(
      `INSERT INTO wellbeing_adhoc_notes
        (id, user_id, company_id, note_date, interaction_type, summary, key_observations, agreed_actions, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, note_date, interaction_type, summary,
       key_observations || null, agreed_actions || null]
    );

    if (linked_objective_ids && linked_objective_ids.length > 0) {
      for (const objId of linked_objective_ids) {
        await client.query(
          'INSERT INTO wellbeing_note_objective_links (id, note_id, objective_id) VALUES ($1,$2,$3)',
          [uuidv4(), id, objId]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ data: { ...rows[0], linked_objective_ids: linked_objective_ids || [] } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating wellbeing note:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.patch('/wellbeing/notes/:id', authenticate, [
  param('id').isUUID(),
  body('note_date').optional().isISO8601(),
  body('interaction_type').optional().trim().notEmpty(),
  body('summary').optional().trim().notEmpty(),
  body('key_observations').optional().trim(),
  body('agreed_actions').optional().trim(),
  body('linked_objective_ids').optional().isArray(),
  body('linked_objective_ids.*').optional().isUUID()
], validate, async (req, res) => {
  const client = await pool.connect();
  try {
    const note = await getObjective(req.params.id, req.user.company_id, 'wellbeing_adhoc_notes');
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await client.query('BEGIN');

    const fields = ['note_date', 'interaction_type', 'summary', 'key_observations', 'agreed_actions'];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = $${idx++}`);
        params.push(req.body[f]);
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = NOW()');
      params.push(req.params.id, req.user.company_id);
      await client.query(
        `UPDATE wellbeing_adhoc_notes SET ${updates.join(', ')}
         WHERE id = $${idx++} AND company_id = $${idx}`,
        params
      );
    }

    if (req.body.linked_objective_ids !== undefined) {
      await client.query('DELETE FROM wellbeing_note_objective_links WHERE note_id = $1', [req.params.id]);
      for (const objId of req.body.linked_objective_ids) {
        await client.query(
          'INSERT INTO wellbeing_note_objective_links (id, note_id, objective_id) VALUES ($1,$2,$3)',
          [uuidv4(), req.params.id, objId]
        );
      }
    }

    await client.query('COMMIT');

    const { rows } = await pool.query(
      'SELECT * FROM wellbeing_adhoc_notes WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating wellbeing note:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.delete('/wellbeing/notes/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const note = await getObjective(req.params.id, req.user.company_id, 'wellbeing_adhoc_notes');
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      'DELETE FROM wellbeing_adhoc_notes WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Note deleted' });
  } catch (err) {
    console.error('Error deleting wellbeing note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Wellbeing Attachments ---
router.post('/wellbeing/attachments', authenticate, [
  body('entity_type').trim().notEmpty(),
  body('entity_id').isUUID(),
  body('file_name').trim().notEmpty(),
  body('file_url').trim().isURL(),
  body('file_type').optional().trim(),
  body('file_size').optional().isInt({ min: 0 }),
  body('description').optional().trim()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { entity_type, entity_id, file_name, file_url, file_type, file_size, description } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO wellbeing_attachments
        (id, user_id, company_id, entity_type, entity_id, file_name, file_url, file_type, file_size, description, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, entity_type, entity_id, file_name, file_url,
       file_type || null, file_size || null, description || null]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating wellbeing attachment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/wellbeing/attachments', authenticate, [
  query('entity_type').trim().notEmpty(),
  query('entity_id').isUUID()
], validate, async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;

    const { rows } = await pool.query(
      `SELECT a.*, u.first_name AS uploaded_by_first_name, u.last_name AS uploaded_by_last_name
       FROM wellbeing_attachments a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity_type = $1 AND a.entity_id = $2 AND a.company_id = $3
       ORDER BY a.created_at DESC`,
      [entity_type, entity_id, req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing wellbeing attachments:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/wellbeing/attachments/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM wellbeing_attachments WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Attachment not found' });
    if (rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      'DELETE FROM wellbeing_attachments WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Attachment deleted' });
  } catch (err) {
    console.error('Error deleting wellbeing attachment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// 360-DEGREE FEEDBACK
// ============================================================================

router.get('/360/templates', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM feedback_360_templates
       WHERE company_id = $1 AND active = true
       ORDER BY name ASC`,
      [req.user.company_id]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing 360 templates:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/360/assessments', authenticate, requireAdmin, [
  body('template_id').isUUID(),
  body('employee_id').isUUID(),
  body('cycle_id').isUUID(),
  body('trigger_point').optional().trim(),
  body('module_type').optional().trim(),
  body('anonymous').optional().isBoolean()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { template_id, employee_id, cycle_id, trigger_point, module_type, anonymous } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO feedback_360_assessments
        (id, company_id, template_id, employee_id, cycle_id, trigger_point, module_type, anonymous, status, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,NOW(),NOW())
       RETURNING *`,
      [id, req.user.company_id, template_id, employee_id, cycle_id,
       trigger_point || null, module_type || null, anonymous !== false, req.user.id]
    );

    // Notify the employee
    const employee = await pool.query('SELECT email, first_name FROM users WHERE id = $1', [employee_id]);
    if (employee.rows[0]) {
      sendEmail({
        to: employee.rows[0].email,
        subject: '360-Degree Assessment Created',
        text: `Hi ${employee.rows[0].first_name}, a 360-degree feedback assessment has been created for you.`
      }).catch(e => console.error('Email send failed:', e));
    }

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating 360 assessment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/360/assessments', authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);
    const isAdmin = req.user.role === 'admin';

    let where = 'a.company_id = $1';
    const params = [req.user.company_id];
    let idx = 2;

    if (!isAdmin) {
      where += ` AND a.employee_id = $${idx++}`;
      params.push(req.user.id);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM feedback_360_assessments a WHERE ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT a.*, u.first_name AS employee_first_name, u.last_name AS employee_last_name,
              t.name AS template_name
       FROM feedback_360_assessments a
       LEFT JOIN users u ON u.id = a.employee_id
       LEFT JOIN feedback_360_templates t ON t.id = a.template_id
       WHERE ${where}
       ORDER BY a.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing 360 assessments:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/360/assessments/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const { rows: assessments } = await pool.query(
      `SELECT a.*, u.first_name AS employee_first_name, u.last_name AS employee_last_name,
              t.name AS template_name
       FROM feedback_360_assessments a
       LEFT JOIN users u ON u.id = a.employee_id
       LEFT JOIN feedback_360_templates t ON t.id = a.template_id
       WHERE a.id = $1 AND a.company_id = $2`,
      [req.params.id, req.user.company_id]
    );

    if (!assessments[0]) return res.status(404).json({ error: 'Assessment not found' });

    const assessment = assessments[0];
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && assessment.employee_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { rows: participants } = await pool.query(
      `SELECT p.*, u.first_name, u.last_name, u.email
       FROM feedback_360_participants p
       LEFT JOIN users u ON u.id = p.participant_id
       WHERE p.assessment_id = $1
       ORDER BY p.role ASC`,
      [req.params.id]
    );

    res.json({ data: { ...assessment, participants } });
  } catch (err) {
    console.error('Error getting 360 assessment detail:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/360/assessments/:id/participants', authenticate, requireAdmin, [
  param('id').isUUID(),
  body('participants').isArray({ min: 1 }),
  body('participants.*.participant_id').isUUID(),
  body('participants.*.role').trim().notEmpty()
], validate, async (req, res) => {
  try {
    const assessment = await pool.query(
      'SELECT * FROM feedback_360_assessments WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!assessment.rows[0]) return res.status(404).json({ error: 'Assessment not found' });

    const created = [];
    for (const p of req.body.participants) {
      const id = uuidv4();
      const { rows } = await pool.query(
        `INSERT INTO feedback_360_participants
          (id, assessment_id, participant_id, role, status, created_at)
         VALUES ($1,$2,$3,$4,'pending',NOW())
         ON CONFLICT (assessment_id, participant_id) DO NOTHING
         RETURNING *`,
        [id, req.params.id, p.participant_id, p.role]
      );
      if (rows[0]) {
        created.push(rows[0]);

        const user = await pool.query('SELECT email, first_name FROM users WHERE id = $1', [p.participant_id]);
        if (user.rows[0]) {
          sendEmail({
            to: user.rows[0].email,
            subject: '360-Degree Feedback Request',
            text: `Hi ${user.rows[0].first_name}, you have been selected as a participant in a 360-degree feedback assessment.`
          }).catch(e => console.error('Email send failed:', e));
        }
      }
    }

    res.status(201).json({ data: created });
  } catch (err) {
    console.error('Error adding 360 participants:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/360/my-pending', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, a.employee_id, a.template_id, a.cycle_id, a.anonymous,
              u.first_name AS employee_first_name, u.last_name AS employee_last_name,
              t.name AS template_name
       FROM feedback_360_participants p
       JOIN feedback_360_assessments a ON a.id = p.assessment_id
       LEFT JOIN users u ON u.id = a.employee_id
       LEFT JOIN feedback_360_templates t ON t.id = a.template_id
       WHERE p.participant_id = $1 AND a.company_id = $2 AND p.status = 'pending' AND a.status = 'active'
       ORDER BY p.created_at ASC`,
      [req.user.id, req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing my pending 360s:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/360/assessments/:id/respond', authenticate, [
  param('id').isUUID(),
  body('responses').isArray({ min: 1 }),
  body('responses.*.question_id').isUUID(),
  body('responses.*.rating_value').optional().isInt({ min: 1, max: 10 }),
  body('responses.*.comment_text').optional().trim()
], validate, async (req, res) => {
  const client = await pool.connect();
  try {
    // Check participant
    const participant = await pool.query(
      `SELECT p.* FROM feedback_360_participants p
       JOIN feedback_360_assessments a ON a.id = p.assessment_id
       WHERE p.assessment_id = $1 AND p.participant_id = $2 AND a.company_id = $3`,
      [req.params.id, req.user.id, req.user.company_id]
    );
    if (!participant.rows[0]) return res.status(403).json({ error: 'You are not a participant in this assessment' });
    if (participant.rows[0].status === 'completed') return res.status(400).json({ error: 'Already submitted' });

    await client.query('BEGIN');

    for (const resp of req.body.responses) {
      const id = uuidv4();
      await client.query(
        `INSERT INTO feedback_360_responses
          (id, assessment_id, participant_id, question_id, rating_value, comment_text, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [id, req.params.id, req.user.id, resp.question_id, resp.rating_value || null, resp.comment_text || null]
      );
    }

    await client.query(
      `UPDATE feedback_360_participants SET status = 'completed', completed_at = NOW()
       WHERE assessment_id = $1 AND participant_id = $2`,
      [req.params.id, req.user.id]
    );

    await client.query('COMMIT');
    res.json({ message: '360 feedback submitted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error submitting 360 responses:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.get('/360/assessments/:id/results', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const { rows: assessments } = await pool.query(
      'SELECT * FROM feedback_360_assessments WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!assessments[0]) return res.status(404).json({ error: 'Assessment not found' });

    const assessment = assessments[0];
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && assessment.employee_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check minimum respondent threshold
    const { rows: participantCount } = await pool.query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'completed') AS completed
       FROM feedback_360_participants WHERE assessment_id = $1`,
      [req.params.id]
    );

    const minThreshold = 3;
    const completed = parseInt(participantCount[0].completed);
    if (completed < minThreshold) {
      return res.status(400).json({
        error: `Minimum ${minThreshold} respondents required. Currently ${completed} completed.`
      });
    }

    // Aggregated results per question
    const { rows: results } = await pool.query(
      `SELECT r.question_id,
              q.question_text,
              q.category AS question_category,
              COUNT(r.rating_value) AS response_count,
              ROUND(AVG(r.rating_value)::numeric, 2) AS avg_rating,
              MIN(r.rating_value) AS min_rating,
              MAX(r.rating_value) AS max_rating
       FROM feedback_360_responses r
       JOIN feedback_360_questions q ON q.id = r.question_id
       WHERE r.assessment_id = $1
       GROUP BY r.question_id, q.question_text, q.category
       ORDER BY q.category, q.question_text`,
      [req.params.id]
    );

    // Comments (anonymous if configured)
    let comments;
    if (assessment.anonymous) {
      const { rows } = await pool.query(
        `SELECT r.question_id, r.comment_text
         FROM feedback_360_responses r
         WHERE r.assessment_id = $1 AND r.comment_text IS NOT NULL AND r.comment_text != ''
         ORDER BY r.question_id`,
        [req.params.id]
      );
      comments = rows;
    } else {
      const { rows } = await pool.query(
        `SELECT r.question_id, r.comment_text, u.first_name, u.last_name, p.role
         FROM feedback_360_responses r
         JOIN feedback_360_participants p ON p.participant_id = r.participant_id AND p.assessment_id = r.assessment_id
         LEFT JOIN users u ON u.id = r.participant_id
         WHERE r.assessment_id = $1 AND r.comment_text IS NOT NULL AND r.comment_text != ''
         ORDER BY r.question_id`,
        [req.params.id]
      );
      comments = rows;
    }

    // Results by role
    const { rows: roleResults } = await pool.query(
      `SELECT p.role, r.question_id,
              ROUND(AVG(r.rating_value)::numeric, 2) AS avg_rating,
              COUNT(r.rating_value) AS response_count
       FROM feedback_360_responses r
       JOIN feedback_360_participants p ON p.participant_id = r.participant_id AND p.assessment_id = r.assessment_id
       WHERE r.assessment_id = $1
       GROUP BY p.role, r.question_id
       ORDER BY p.role, r.question_id`,
      [req.params.id]
    );

    res.json({
      data: {
        assessment_id: req.params.id,
        anonymous: assessment.anonymous,
        respondents: completed,
        total_participants: parseInt(participantCount[0].total),
        summary: results,
        comments,
        by_role: roleResults
      }
    });
  } catch (err) {
    console.error('Error getting 360 results:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
