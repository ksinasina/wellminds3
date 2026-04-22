const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireManager, requireAdmin, requireRole, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { sendEmail } = require('../utils/email');
const { v4: uuidv4 } = require('uuid');

// ============================================================================
// HELPERS
// ============================================================================

function paginate(req) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// ============================================================================
// PROFILE
// ============================================================================

router.get('/profile', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.*,
              d.name AS department_name,
              jl.name AS job_level_name,
              bu.name AS business_unit_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN job_levels jl ON jl.id = u.job_level_id
       LEFT JOIN business_units bu ON bu.id = u.business_unit_id
       WHERE u.id = $1 AND u.company_id = $2`,
      [req.user.id, req.user.company_id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Profile not found' });

    const profile = rows[0];

    // Custom field values
    const { rows: customFields } = await pool.query(
      `SELECT cfv.*, cf.field_name, cf.field_type, cf.field_label, cf.required
       FROM custom_field_values cfv
       JOIN custom_fields cf ON cf.id = cfv.field_id
       WHERE cfv.user_id = $1 AND cfv.company_id = $2`,
      [req.user.id, req.user.company_id]
    );

    // Completeness score
    const requiredFields = ['first_name', 'last_name', 'email', 'phone', 'address', 'bio', 'emergency_contact_name', 'emergency_contact_phone'];
    const filledRequired = requiredFields.filter(f => profile[f] && String(profile[f]).trim() !== '');
    const completeness = Math.round((filledRequired.length / requiredFields.length) * 100);

    // Remove sensitive fields
    delete profile.password_hash;

    res.json({
      data: {
        ...profile,
        custom_fields: customFields,
        completeness_score: completeness
      }
    });
  } catch (err) {
    console.error('Error fetching own profile:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/profile/:userId', authenticate, [
  param('userId').isUUID()
], validate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.bio, u.avatar_url,
              u.department_id, u.job_level_id, u.business_unit_id, u.job_title, u.start_date,
              u.hobbies, u.status,
              d.name AS department_name,
              jl.name AS job_level_name,
              bu.name AS business_unit_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN job_levels jl ON jl.id = u.job_level_id
       LEFT JOIN business_units bu ON bu.id = u.business_unit_id
       WHERE u.id = $1 AND u.company_id = $2`,
      [req.params.userId, req.user.company_id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'User not found' });

    // Visibility rules: managers and admins see more fields
    const isManagerOrAdmin = req.user.role === 'manager' || req.user.role === 'admin';
    const profile = rows[0];

    if (isManagerOrAdmin) {
      const { rows: extraFields } = await pool.query(
        `SELECT address, emergency_contact_name, emergency_contact_phone, emergency_contact_relationship
         FROM users WHERE id = $1 AND company_id = $2`,
        [req.params.userId, req.user.company_id]
      );
      if (extraFields[0]) Object.assign(profile, extraFields[0]);
    }

    res.json({ data: profile });
  } catch (err) {
    console.error('Error fetching user profile:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/profile', authenticate, [
  body('bio').optional().trim(),
  body('phone').optional().trim(),
  body('address').optional().trim(),
  body('emergency_contact_name').optional().trim(),
  body('emergency_contact_phone').optional().trim(),
  body('emergency_contact_relationship').optional().trim(),
  body('hobbies').optional().trim(),
  body('avatar_url').optional().trim()
], validate, async (req, res) => {
  try {
    const fields = ['bio', 'phone', 'address', 'emergency_contact_name', 'emergency_contact_phone',
                     'emergency_contact_relationship', 'hobbies', 'avatar_url'];
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
    params.push(req.user.id, req.user.company_id);

    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING id, first_name, last_name, email, phone, bio, address, emergency_contact_name,
                 emergency_contact_phone, emergency_contact_relationship, hobbies, avatar_url, updated_at`,
      params
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error updating profile:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/profiles', authenticate, requireManager, [
  query('department_id').optional().isUUID(),
  query('business_unit_id').optional().isUUID(),
  query('status').optional().isIn(['active', 'inactive', 'on_leave']),
  query('job_level_id').optional().isUUID(),
  query('search').optional().trim()
], validate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);
    const { department_id, business_unit_id, status, job_level_id, search } = req.query;

    let where = 'u.company_id = $1';
    const params = [req.user.company_id];
    let idx = 2;

    if (department_id) { where += ` AND u.department_id = $${idx++}`; params.push(department_id); }
    if (business_unit_id) { where += ` AND u.business_unit_id = $${idx++}`; params.push(business_unit_id); }
    if (status) { where += ` AND u.status = $${idx++}`; params.push(status); }
    if (job_level_id) { where += ` AND u.job_level_id = $${idx++}`; params.push(job_level_id); }
    if (search) {
      where += ` AND (u.first_name ILIKE $${idx} OR u.last_name ILIKE $${idx} OR u.email ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM users u WHERE ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.job_title, u.status,
              u.department_id, u.job_level_id, u.business_unit_id, u.start_date, u.avatar_url,
              d.name AS department_name, jl.name AS job_level_name, bu.name AS business_unit_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN job_levels jl ON jl.id = u.job_level_id
       LEFT JOIN business_units bu ON bu.id = u.business_unit_id
       WHERE ${where}
       ORDER BY u.last_name ASC, u.first_name ASC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing profiles:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// DOCUMENTS
// ============================================================================

router.get('/documents', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, dt.name AS type_name, dt.category AS type_category
       FROM employee_documents d
       LEFT JOIN document_types dt ON dt.id = d.document_type_id
       WHERE d.user_id = $1 AND d.company_id = $2
       ORDER BY d.created_at DESC`,
      [req.user.id, req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing documents:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/documents/types', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM document_types
       WHERE company_id = $1 AND active = true
       ORDER BY required DESC, name ASC`,
      [req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing document types:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/documents', authenticate, [
  body('document_type_id').isUUID(),
  body('file_name').trim().notEmpty(),
  body('file_url').trim().isURL(),
  body('file_type').optional().trim(),
  body('file_size').optional().isInt({ min: 0 }),
  body('description').optional().trim(),
  body('expiry_date').optional().isISO8601(),
  body('issue_date').optional().isISO8601()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { document_type_id, file_name, file_url, file_type, file_size, description, expiry_date, issue_date } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO employee_documents
        (id, user_id, company_id, document_type_id, file_name, file_url, file_type, file_size,
         description, expiry_date, issue_date, verification_status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, document_type_id, file_name, file_url,
       file_type || null, file_size || null, description || null,
       expiry_date || null, issue_date || null]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating document:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/documents/:id', authenticate, [
  param('id').isUUID(),
  body('file_name').optional().trim().notEmpty(),
  body('file_url').optional().trim().isURL(),
  body('description').optional().trim(),
  body('expiry_date').optional().isISO8601(),
  body('issue_date').optional().isISO8601()
], validate, async (req, res) => {
  try {
    const doc = await pool.query(
      'SELECT * FROM employee_documents WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!doc.rows[0]) return res.status(404).json({ error: 'Document not found' });
    if (doc.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const fields = ['file_name', 'file_url', 'description', 'expiry_date', 'issue_date'];
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

    // Reset verification on edit
    updates.push(`verification_status = 'pending'`);
    updates.push('updated_at = NOW()');
    params.push(req.params.id, req.user.company_id);

    const { rows } = await pool.query(
      `UPDATE employee_documents SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING *`,
      params
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error updating document:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/documents/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const doc = await pool.query(
      'SELECT * FROM employee_documents WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!doc.rows[0]) return res.status(404).json({ error: 'Document not found' });
    if (doc.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      'DELETE FROM employee_documents WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Document deleted' });
  } catch (err) {
    console.error('Error deleting document:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/documents/all', authenticate, requireManager, [
  query('user_id').optional().isUUID(),
  query('document_type_id').optional().isUUID(),
  query('verification_status').optional().isIn(['pending', 'verified', 'rejected'])
], validate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);
    const { user_id, document_type_id, verification_status } = req.query;

    let where = 'd.company_id = $1';
    const params = [req.user.company_id];
    let idx = 2;

    if (user_id) { where += ` AND d.user_id = $${idx++}`; params.push(user_id); }
    if (document_type_id) { where += ` AND d.document_type_id = $${idx++}`; params.push(document_type_id); }
    if (verification_status) { where += ` AND d.verification_status = $${idx++}`; params.push(verification_status); }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM employee_documents d WHERE ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT d.*, u.first_name, u.last_name, u.email,
              dt.name AS type_name, dt.category AS type_category
       FROM employee_documents d
       LEFT JOIN users u ON u.id = d.user_id
       LEFT JOIN document_types dt ON dt.id = d.document_type_id
       WHERE ${where}
       ORDER BY d.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing all documents:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/documents/:id/verify', authenticate, requireManager, [
  param('id').isUUID(),
  body('verification_status').isIn(['verified', 'rejected']),
  body('verification_notes').optional().trim()
], validate, async (req, res) => {
  try {
    const doc = await pool.query(
      'SELECT * FROM employee_documents WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!doc.rows[0]) return res.status(404).json({ error: 'Document not found' });

    const { verification_status, verification_notes } = req.body;

    const { rows } = await pool.query(
      `UPDATE employee_documents
       SET verification_status = $1, verification_notes = $2, verified_by = $3, verified_at = NOW(), updated_at = NOW()
       WHERE id = $4 AND company_id = $5
       RETURNING *`,
      [verification_status, verification_notes || null, req.user.id, req.params.id, req.user.company_id]
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error verifying document:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// EMPLOYMENT HISTORY
// ============================================================================

router.get('/employment-history', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM employment_history
       WHERE user_id = $1 AND company_id = $2
       ORDER BY start_date DESC`,
      [req.user.id, req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing employment history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/employment-history', authenticate, [
  body('company_name').trim().notEmpty(),
  body('job_title').trim().notEmpty(),
  body('start_date').isISO8601(),
  body('end_date').optional().isISO8601(),
  body('description').optional().trim(),
  body('reason_for_leaving').optional().trim()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { company_name, job_title, start_date, end_date, description, reason_for_leaving } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO employment_history
        (id, user_id, company_id, company_name, job_title, start_date, end_date, description, reason_for_leaving, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, company_name, job_title, start_date,
       end_date || null, description || null, reason_for_leaving || null]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating employment history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/employment-history/:id', authenticate, [
  param('id').isUUID(),
  body('company_name').optional().trim().notEmpty(),
  body('job_title').optional().trim().notEmpty(),
  body('start_date').optional().isISO8601(),
  body('end_date').optional().isISO8601(),
  body('description').optional().trim(),
  body('reason_for_leaving').optional().trim()
], validate, async (req, res) => {
  try {
    const record = await pool.query(
      'SELECT * FROM employment_history WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!record.rows[0]) return res.status(404).json({ error: 'Record not found' });
    if (record.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const fields = ['company_name', 'job_title', 'start_date', 'end_date', 'description', 'reason_for_leaving'];
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
      `UPDATE employment_history SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING *`,
      params
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error updating employment history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/employment-history/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const record = await pool.query(
      'SELECT * FROM employment_history WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!record.rows[0]) return res.status(404).json({ error: 'Record not found' });
    if (record.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      'DELETE FROM employment_history WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Employment history deleted' });
  } catch (err) {
    console.error('Error deleting employment history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// TRAINING RECORDS
// ============================================================================

router.get('/training', authenticate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM training_records WHERE user_id = $1 AND company_id = $2',
      [req.user.id, req.user.company_id]
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT tr.*, tt.name AS type_name
       FROM training_records tr
       LEFT JOIN training_types tt ON tt.id = tr.training_type_id
       WHERE tr.user_id = $1 AND tr.company_id = $2
       ORDER BY tr.completion_date DESC NULLS LAST, tr.created_at DESC
       LIMIT $3 OFFSET $4`,
      [req.user.id, req.user.company_id, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing training records:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/training/types', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM training_types
       WHERE company_id = $1 AND active = true
       ORDER BY name ASC`,
      [req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing training types:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/training', authenticate, [
  body('training_type_id').isUUID(),
  body('title').trim().notEmpty().isLength({ max: 255 }),
  body('provider').optional().trim(),
  body('description').optional().trim(),
  body('start_date').optional().isISO8601(),
  body('completion_date').optional().isISO8601(),
  body('hours').optional().isFloat({ min: 0 }),
  body('cost').optional().isFloat({ min: 0 }),
  body('currency').optional().trim().isLength({ max: 3 }),
  body('certificate_url').optional().trim(),
  body('status').optional().isIn(['planned', 'in_progress', 'completed', 'cancelled'])
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { training_type_id, title, provider, description, start_date, completion_date,
            hours, cost, currency, certificate_url, status } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO training_records
        (id, user_id, company_id, training_type_id, title, provider, description,
         start_date, completion_date, hours, cost, currency, certificate_url, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, training_type_id, title, provider || null,
       description || null, start_date || null, completion_date || null, hours || null,
       cost || null, currency || 'USD', certificate_url || null, status || 'planned']
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating training record:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/training/:id', authenticate, [
  param('id').isUUID(),
  body('title').optional().trim().notEmpty(),
  body('provider').optional().trim(),
  body('description').optional().trim(),
  body('start_date').optional().isISO8601(),
  body('completion_date').optional().isISO8601(),
  body('hours').optional().isFloat({ min: 0 }),
  body('cost').optional().isFloat({ min: 0 }),
  body('currency').optional().trim().isLength({ max: 3 }),
  body('certificate_url').optional().trim(),
  body('status').optional().isIn(['planned', 'in_progress', 'completed', 'cancelled'])
], validate, async (req, res) => {
  try {
    const record = await pool.query(
      'SELECT * FROM training_records WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!record.rows[0]) return res.status(404).json({ error: 'Training record not found' });
    if (record.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const fields = ['title', 'provider', 'description', 'start_date', 'completion_date',
                     'hours', 'cost', 'currency', 'certificate_url', 'status'];
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
      `UPDATE training_records SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING *`,
      params
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error updating training record:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/training/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const record = await pool.query(
      'SELECT * FROM training_records WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!record.rows[0]) return res.status(404).json({ error: 'Training record not found' });
    if (record.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      'DELETE FROM training_records WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Training record deleted' });
  } catch (err) {
    console.error('Error deleting training record:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/training/all', authenticate, requireManager, [
  query('user_id').optional().isUUID(),
  query('training_type_id').optional().isUUID(),
  query('status').optional().isIn(['planned', 'in_progress', 'completed', 'cancelled'])
], validate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);
    const { user_id, training_type_id, status } = req.query;

    let where = 'tr.company_id = $1';
    const params = [req.user.company_id];
    let idx = 2;

    if (user_id) { where += ` AND tr.user_id = $${idx++}`; params.push(user_id); }
    if (training_type_id) { where += ` AND tr.training_type_id = $${idx++}`; params.push(training_type_id); }
    if (status) { where += ` AND tr.status = $${idx++}`; params.push(status); }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM training_records tr WHERE ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT tr.*, u.first_name, u.last_name, u.email, tt.name AS type_name
       FROM training_records tr
       LEFT JOIN users u ON u.id = tr.user_id
       LEFT JOIN training_types tt ON tt.id = tr.training_type_id
       WHERE ${where}
       ORDER BY tr.completion_date DESC NULLS LAST
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing all training records:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// PROFESSIONAL LICENCES & CERTIFICATIONS
// ============================================================================

router.get('/certifications', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, ct.name AS type_name
       FROM certifications c
       LEFT JOIN certification_types ct ON ct.id = c.certification_type_id
       WHERE c.user_id = $1 AND c.company_id = $2
       ORDER BY c.expiry_date ASC NULLS LAST`,
      [req.user.id, req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing certifications:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/certifications/types', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM certification_types
       WHERE company_id = $1 AND active = true
       ORDER BY name ASC`,
      [req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing certification types:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/certifications', authenticate, [
  body('certification_type_id').isUUID(),
  body('name').trim().notEmpty().isLength({ max: 255 }),
  body('issuing_body').trim().notEmpty(),
  body('issue_date').isISO8601(),
  body('expiry_date').optional().isISO8601(),
  body('credential_id').optional().trim(),
  body('credential_url').optional().trim(),
  body('description').optional().trim()
], validate, async (req, res) => {
  try {
    const id = uuidv4();
    const { certification_type_id, name, issuing_body, issue_date, expiry_date, credential_id, credential_url, description } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO certifications
        (id, user_id, company_id, certification_type_id, name, issuing_body, issue_date, expiry_date,
         credential_id, credential_url, description, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',NOW(),NOW())
       RETURNING *`,
      [id, req.user.id, req.user.company_id, certification_type_id, name, issuing_body,
       issue_date, expiry_date || null, credential_id || null, credential_url || null, description || null]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('Error creating certification:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/certifications/:id', authenticate, [
  param('id').isUUID(),
  body('name').optional().trim().notEmpty(),
  body('issuing_body').optional().trim().notEmpty(),
  body('issue_date').optional().isISO8601(),
  body('expiry_date').optional().isISO8601(),
  body('credential_id').optional().trim(),
  body('credential_url').optional().trim(),
  body('description').optional().trim(),
  body('status').optional().isIn(['active', 'expired', 'revoked'])
], validate, async (req, res) => {
  try {
    const record = await pool.query(
      'SELECT * FROM certifications WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!record.rows[0]) return res.status(404).json({ error: 'Certification not found' });
    if (record.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const fields = ['name', 'issuing_body', 'issue_date', 'expiry_date', 'credential_id',
                     'credential_url', 'description', 'status'];
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
      `UPDATE certifications SET ${updates.join(', ')}
       WHERE id = $${idx++} AND company_id = $${idx}
       RETURNING *`,
      params
    );

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('Error updating certification:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/certifications/:id', authenticate, [
  param('id').isUUID()
], validate, async (req, res) => {
  try {
    const record = await pool.query(
      'SELECT * FROM certifications WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (!record.rows[0]) return res.status(404).json({ error: 'Certification not found' });
    if (record.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      'DELETE FROM certifications WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );

    res.json({ message: 'Certification deleted' });
  } catch (err) {
    console.error('Error deleting certification:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/certifications/all', authenticate, requireManager, [
  query('user_id').optional().isUUID(),
  query('certification_type_id').optional().isUUID(),
  query('status').optional().isIn(['active', 'expired', 'revoked'])
], validate, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);
    const { user_id, certification_type_id, status } = req.query;

    let where = 'c.company_id = $1';
    const params = [req.user.company_id];
    let idx = 2;

    if (user_id) { where += ` AND c.user_id = $${idx++}`; params.push(user_id); }
    if (certification_type_id) { where += ` AND c.certification_type_id = $${idx++}`; params.push(certification_type_id); }
    if (status) { where += ` AND c.status = $${idx++}`; params.push(status); }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM certifications c WHERE ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT c.*, u.first_name, u.last_name, u.email, ct.name AS type_name
       FROM certifications c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN certification_types ct ON ct.id = c.certification_type_id
       WHERE ${where}
       ORDER BY c.expiry_date ASC NULLS LAST
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing all certifications:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/certifications/expiring', authenticate, requireManager, [
  query('days').optional().isInt({ min: 1, max: 365 })
], validate, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 90;
    const { page, limit, offset } = paginate(req);

    const countResult = await pool.query(
      `SELECT COUNT(*)
       FROM certifications c
       WHERE c.company_id = $1
         AND c.expiry_date IS NOT NULL
         AND c.expiry_date <= NOW() + ($2 || ' days')::INTERVAL
         AND c.expiry_date >= NOW()
         AND c.status = 'active'`,
      [req.user.company_id, days.toString()]
    );
    const total = parseInt(countResult.rows[0].count);

    const { rows } = await pool.query(
      `SELECT c.*, u.first_name, u.last_name, u.email, ct.name AS type_name,
              c.expiry_date - NOW() AS days_until_expiry
       FROM certifications c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN certification_types ct ON ct.id = c.certification_type_id
       WHERE c.company_id = $1
         AND c.expiry_date IS NOT NULL
         AND c.expiry_date <= NOW() + ($2 || ' days')::INTERVAL
         AND c.expiry_date >= NOW()
         AND c.status = 'active'
       ORDER BY c.expiry_date ASC
       LIMIT $3 OFFSET $4`,
      [req.user.company_id, days.toString(), limit, offset]
    );

    res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Error listing expiring certifications:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// CUSTOM FIELDS
// ============================================================================

router.get('/custom-fields', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM custom_fields
       WHERE company_id = $1 AND active = true
       ORDER BY sort_order ASC, field_label ASC`,
      [req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing custom fields:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/custom-field-values', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cfv.*, cf.field_name, cf.field_type, cf.field_label, cf.required, cf.options
       FROM custom_field_values cfv
       JOIN custom_fields cf ON cf.id = cfv.field_id
       WHERE cfv.user_id = $1 AND cfv.company_id = $2
       ORDER BY cf.sort_order ASC`,
      [req.user.id, req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing custom field values:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/custom-field-values', authenticate, [
  body('values').isArray({ min: 1 }),
  body('values.*.field_id').isUUID(),
  body('values.*.value').exists()
], validate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const results = [];
    for (const item of req.body.values) {
      // Verify field exists and belongs to company
      const field = await client.query(
        'SELECT id FROM custom_fields WHERE id = $1 AND company_id = $2',
        [item.field_id, req.user.company_id]
      );
      if (!field.rows[0]) continue;

      const { rows } = await client.query(
        `INSERT INTO custom_field_values (id, user_id, company_id, field_id, value, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_id, field_id)
         DO UPDATE SET value = $5, updated_at = NOW()
         RETURNING *`,
        [uuidv4(), req.user.id, req.user.company_id, item.field_id, JSON.stringify(item.value)]
      );
      results.push(rows[0]);
    }

    await client.query('COMMIT');
    res.json({ data: results });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating custom field values:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.get('/custom-field-values/:userId', authenticate, requireManager, [
  param('userId').isUUID()
], validate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cfv.*, cf.field_name, cf.field_type, cf.field_label, cf.required, cf.options
       FROM custom_field_values cfv
       JOIN custom_fields cf ON cf.id = cfv.field_id
       WHERE cfv.user_id = $1 AND cfv.company_id = $2
       ORDER BY cf.sort_order ASC`,
      [req.params.userId, req.user.company_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error listing user custom field values:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// ANALYTICS
// ============================================================================

router.get('/analytics/completeness', authenticate, requireManager, async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req);

    const { rows } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email,
              d.name AS department_name,
              CASE WHEN u.first_name IS NOT NULL AND u.first_name != '' THEN 1 ELSE 0 END +
              CASE WHEN u.last_name IS NOT NULL AND u.last_name != '' THEN 1 ELSE 0 END +
              CASE WHEN u.email IS NOT NULL AND u.email != '' THEN 1 ELSE 0 END +
              CASE WHEN u.phone IS NOT NULL AND u.phone != '' THEN 1 ELSE 0 END +
              CASE WHEN u.address IS NOT NULL AND u.address != '' THEN 1 ELSE 0 END +
              CASE WHEN u.bio IS NOT NULL AND u.bio != '' THEN 1 ELSE 0 END +
              CASE WHEN u.emergency_contact_name IS NOT NULL AND u.emergency_contact_name != '' THEN 1 ELSE 0 END +
              CASE WHEN u.emergency_contact_phone IS NOT NULL AND u.emergency_contact_phone != '' THEN 1 ELSE 0 END
              AS filled_fields,
              8 AS total_required_fields,
              ROUND(
                (CASE WHEN u.first_name IS NOT NULL AND u.first_name != '' THEN 1 ELSE 0 END +
                 CASE WHEN u.last_name IS NOT NULL AND u.last_name != '' THEN 1 ELSE 0 END +
                 CASE WHEN u.email IS NOT NULL AND u.email != '' THEN 1 ELSE 0 END +
                 CASE WHEN u.phone IS NOT NULL AND u.phone != '' THEN 1 ELSE 0 END +
                 CASE WHEN u.address IS NOT NULL AND u.address != '' THEN 1 ELSE 0 END +
                 CASE WHEN u.bio IS NOT NULL AND u.bio != '' THEN 1 ELSE 0 END +
                 CASE WHEN u.emergency_contact_name IS NOT NULL AND u.emergency_contact_name != '' THEN 1 ELSE 0 END +
                 CASE WHEN u.emergency_contact_phone IS NOT NULL AND u.emergency_contact_phone != '' THEN 1 ELSE 0 END
                )::numeric / 8 * 100, 0
              ) AS completeness_pct
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.company_id = $1 AND u.status = 'active'
       ORDER BY completeness_pct ASC
       LIMIT $2 OFFSET $3`,
      [req.user.company_id, limit, offset]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('Error fetching completeness analytics:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/analytics/missing', authenticate, requireManager, async (req, res) => {
  try {
    // Missing required documents
    const { rows: missingDocs } = await pool.query(
      `SELECT u.id AS user_id, u.first_name, u.last_name, u.email,
              dt.id AS document_type_id, dt.name AS document_type_name
       FROM users u
       CROSS JOIN document_types dt
       LEFT JOIN employee_documents ed ON ed.user_id = u.id AND ed.document_type_id = dt.id
       WHERE u.company_id = $1 AND u.status = 'active'
         AND dt.company_id = $1 AND dt.required = true AND dt.active = true
         AND ed.id IS NULL
       ORDER BY u.last_name, dt.name`,
      [req.user.company_id]
    );

    // Missing required custom fields
    const { rows: missingFields } = await pool.query(
      `SELECT u.id AS user_id, u.first_name, u.last_name, u.email,
              cf.id AS field_id, cf.field_label, cf.field_name
       FROM users u
       CROSS JOIN custom_fields cf
       LEFT JOIN custom_field_values cfv ON cfv.user_id = u.id AND cfv.field_id = cf.id
       WHERE u.company_id = $1 AND u.status = 'active'
         AND cf.company_id = $1 AND cf.required = true AND cf.active = true
         AND (cfv.id IS NULL OR cfv.value IS NULL OR cfv.value = 'null' OR cfv.value = '""')
       ORDER BY u.last_name, cf.field_label`,
      [req.user.company_id]
    );

    res.json({
      data: {
        missing_documents: missingDocs,
        missing_custom_fields: missingFields
      }
    });
  } catch (err) {
    console.error('Error fetching missing analytics:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/analytics/demographics', authenticate, requireManager, async (req, res) => {
  try {
    const { rows: byDepartment } = await pool.query(
      `SELECT d.name AS department, COUNT(u.id) AS headcount
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.company_id = $1 AND u.status = 'active'
       GROUP BY d.name
       ORDER BY headcount DESC`,
      [req.user.company_id]
    );

    const { rows: byBusinessUnit } = await pool.query(
      `SELECT bu.name AS business_unit, COUNT(u.id) AS headcount
       FROM users u
       LEFT JOIN business_units bu ON bu.id = u.business_unit_id
       WHERE u.company_id = $1 AND u.status = 'active'
       GROUP BY bu.name
       ORDER BY headcount DESC`,
      [req.user.company_id]
    );

    const { rows: byRole } = await pool.query(
      `SELECT u.role, COUNT(u.id) AS headcount
       FROM users u
       WHERE u.company_id = $1 AND u.status = 'active'
       GROUP BY u.role
       ORDER BY headcount DESC`,
      [req.user.company_id]
    );

    const { rows: byGender } = await pool.query(
      `SELECT u.gender, COUNT(u.id) AS headcount
       FROM users u
       WHERE u.company_id = $1 AND u.status = 'active'
       GROUP BY u.gender
       ORDER BY headcount DESC`,
      [req.user.company_id]
    );

    const { rows: totalCount } = await pool.query(
      `SELECT COUNT(*) AS total FROM users WHERE company_id = $1 AND status = 'active'`,
      [req.user.company_id]
    );

    res.json({
      data: {
        total_headcount: parseInt(totalCount[0].total),
        by_department: byDepartment,
        by_business_unit: byBusinessUnit,
        by_role: byRole,
        by_gender: byGender
      }
    });
  } catch (err) {
    console.error('Error fetching demographics:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/analytics/training-stats', authenticate, requireManager, async (req, res) => {
  try {
    const { rows: participation } = await pool.query(
      `SELECT
         COUNT(DISTINCT tr.user_id) AS employees_with_training,
         COUNT(tr.id) AS total_records,
         COUNT(tr.id) FILTER (WHERE tr.status = 'completed') AS completed,
         COUNT(tr.id) FILTER (WHERE tr.status = 'in_progress') AS in_progress,
         COUNT(tr.id) FILTER (WHERE tr.status = 'planned') AS planned,
         COALESCE(SUM(tr.hours) FILTER (WHERE tr.status = 'completed'), 0) AS total_hours_completed,
         COALESCE(SUM(tr.cost) FILTER (WHERE tr.status = 'completed'), 0) AS total_cost
       FROM training_records tr
       WHERE tr.company_id = $1`,
      [req.user.company_id]
    );

    const { rows: byType } = await pool.query(
      `SELECT tt.name AS training_type,
              COUNT(tr.id) AS record_count,
              COUNT(tr.id) FILTER (WHERE tr.status = 'completed') AS completed_count,
              COALESCE(SUM(tr.hours) FILTER (WHERE tr.status = 'completed'), 0) AS total_hours,
              COALESCE(SUM(tr.cost), 0) AS total_cost
       FROM training_records tr
       LEFT JOIN training_types tt ON tt.id = tr.training_type_id
       WHERE tr.company_id = $1
       GROUP BY tt.name
       ORDER BY record_count DESC`,
      [req.user.company_id]
    );

    const { rows: totalEmployees } = await pool.query(
      `SELECT COUNT(*) AS total FROM users WHERE company_id = $1 AND status = 'active'`,
      [req.user.company_id]
    );

    res.json({
      data: {
        summary: {
          ...participation[0],
          total_employees: parseInt(totalEmployees[0].total),
          participation_rate: parseInt(totalEmployees[0].total) > 0
            ? Math.round((parseInt(participation[0].employees_with_training) / parseInt(totalEmployees[0].total)) * 100)
            : 0
        },
        by_type: byType
      }
    });
  } catch (err) {
    console.error('Error fetching training stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/analytics/certification-stats', authenticate, requireManager, async (req, res) => {
  try {
    const { rows: summary } = await pool.query(
      `SELECT
         COUNT(c.id) AS total_certifications,
         COUNT(c.id) FILTER (WHERE c.status = 'active') AS active_count,
         COUNT(c.id) FILTER (WHERE c.status = 'expired') AS expired_count,
         COUNT(c.id) FILTER (WHERE c.status = 'revoked') AS revoked_count,
         COUNT(c.id) FILTER (WHERE c.status = 'active' AND c.expiry_date IS NOT NULL
                             AND c.expiry_date <= NOW() + INTERVAL '30 days'
                             AND c.expiry_date >= NOW()) AS expiring_30_days,
         COUNT(c.id) FILTER (WHERE c.status = 'active' AND c.expiry_date IS NOT NULL
                             AND c.expiry_date <= NOW() + INTERVAL '90 days'
                             AND c.expiry_date >= NOW()) AS expiring_90_days,
         COUNT(DISTINCT c.user_id) AS employees_with_certs
       FROM certifications c
       WHERE c.company_id = $1`,
      [req.user.company_id]
    );

    const { rows: byType } = await pool.query(
      `SELECT ct.name AS certification_type,
              COUNT(c.id) AS total,
              COUNT(c.id) FILTER (WHERE c.status = 'active') AS active,
              COUNT(c.id) FILTER (WHERE c.status = 'expired') AS expired
       FROM certifications c
       LEFT JOIN certification_types ct ON ct.id = c.certification_type_id
       WHERE c.company_id = $1
       GROUP BY ct.name
       ORDER BY total DESC`,
      [req.user.company_id]
    );

    const { rows: upcomingExpiries } = await pool.query(
      `SELECT c.id, c.name, c.expiry_date, u.first_name, u.last_name, u.email,
              ct.name AS type_name,
              c.expiry_date - CURRENT_DATE AS days_until_expiry
       FROM certifications c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN certification_types ct ON ct.id = c.certification_type_id
       WHERE c.company_id = $1
         AND c.status = 'active'
         AND c.expiry_date IS NOT NULL
         AND c.expiry_date >= NOW()
         AND c.expiry_date <= NOW() + INTERVAL '90 days'
       ORDER BY c.expiry_date ASC
       LIMIT 20`,
      [req.user.company_id]
    );

    res.json({
      data: {
        summary: summary[0],
        by_type: byType,
        upcoming_expiries: upcomingExpiries
      }
    });
  } catch (err) {
    console.error('Error fetching certification stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// EXPORT
// ============================================================================

router.get('/export', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows: users } = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.bio, u.address,
              u.job_title, u.start_date, u.status, u.gender, u.role,
              u.emergency_contact_name, u.emergency_contact_phone, u.emergency_contact_relationship,
              u.hobbies,
              d.name AS department_name,
              jl.name AS job_level_name,
              bu.name AS business_unit_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN job_levels jl ON jl.id = u.job_level_id
       LEFT JOIN business_units bu ON bu.id = u.business_unit_id
       WHERE u.company_id = $1
       ORDER BY u.last_name ASC`,
      [req.user.company_id]
    );

    const { rows: documents } = await pool.query(
      `SELECT ed.*, u.first_name, u.last_name, dt.name AS type_name
       FROM employee_documents ed
       LEFT JOIN users u ON u.id = ed.user_id
       LEFT JOIN document_types dt ON dt.id = ed.document_type_id
       WHERE ed.company_id = $1
       ORDER BY u.last_name, ed.created_at`,
      [req.user.company_id]
    );

    const { rows: training } = await pool.query(
      `SELECT tr.*, u.first_name, u.last_name, tt.name AS type_name
       FROM training_records tr
       LEFT JOIN users u ON u.id = tr.user_id
       LEFT JOIN training_types tt ON tt.id = tr.training_type_id
       WHERE tr.company_id = $1
       ORDER BY u.last_name, tr.created_at`,
      [req.user.company_id]
    );

    const { rows: certifications } = await pool.query(
      `SELECT c.*, u.first_name, u.last_name, ct.name AS type_name
       FROM certifications c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN certification_types ct ON ct.id = c.certification_type_id
       WHERE c.company_id = $1
       ORDER BY u.last_name, c.created_at`,
      [req.user.company_id]
    );

    const { rows: employmentHistory } = await pool.query(
      `SELECT eh.*, u.first_name, u.last_name
       FROM employment_history eh
       LEFT JOIN users u ON u.id = eh.user_id
       WHERE eh.company_id = $1
       ORDER BY u.last_name, eh.start_date DESC`,
      [req.user.company_id]
    );

    const { rows: customFieldValues } = await pool.query(
      `SELECT cfv.*, u.first_name, u.last_name, cf.field_name, cf.field_label
       FROM custom_field_values cfv
       LEFT JOIN users u ON u.id = cfv.user_id
       LEFT JOIN custom_fields cf ON cf.id = cfv.field_id
       WHERE cfv.company_id = $1
       ORDER BY u.last_name, cf.sort_order`,
      [req.user.company_id]
    );

    const exportData = {
      exported_at: new Date().toISOString(),
      company_id: req.user.company_id,
      users,
      documents,
      training,
      certifications,
      employment_history: employmentHistory,
      custom_field_values: customFieldValues
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="hris-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(exportData);
  } catch (err) {
    console.error('Error exporting HRIS data:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
