const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireManager, requireAdmin, requireRole, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { sendEmail } = require('../utils/email');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ============================================================
// EMPLOYEE-FACING ENDPOINTS
// ============================================================

// GET /api/professionals - List professionals for user's org
router.get('/',
  authenticate,
  [
    query('type').optional().isString(),
    query('modality').optional().isString(),
    query('language').optional().isString(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 })
  ],
  validate,
  async (req, res) => {
    try {
      const { type, modality, language, page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;
      const companyId = req.user.company_id;

      let whereClause = `WHERE (poa.company_id = $1 OR p.is_preferred = true)`;
      const params = [companyId];
      let paramIdx = 2;

      if (type) {
        whereClause += ` AND p.professional_type = $${paramIdx++}`;
        params.push(type);
      }
      if (modality) {
        whereClause += ` AND $${paramIdx++} = ANY(p.modalities)`;
        params.push(modality);
      }
      if (language) {
        whereClause += ` AND $${paramIdx++} = ANY(p.languages)`;
        params.push(language);
      }

      params.push(limit, offset);

      const { rows } = await pool.query(`
        SELECT p.id, p.first_name, p.last_name, p.professional_type, p.title,
               p.bio, p.modalities, p.languages, p.specialisations,
               p.profile_photo_url, p.is_preferred,
               COALESCE(p.average_rating, 0) AS average_rating
        FROM professionals p
        LEFT JOIN professional_org_assignments poa ON poa.professional_id = p.id
        ${whereClause}
        GROUP BY p.id
        ORDER BY p.is_preferred DESC, p.average_rating DESC
        LIMIT $${paramIdx++} OFFSET $${paramIdx}
      `, params);

      const countResult = await pool.query(`
        SELECT COUNT(DISTINCT p.id) AS total
        FROM professionals p
        LEFT JOIN professional_org_assignments poa ON poa.professional_id = p.id
        ${whereClause}
      `, params.slice(0, paramIdx - 3));

      res.json({
        professionals: rows,
        pagination: {
          page: +page,
          limit: +limit,
          total: +countResult.rows[0].total
        }
      });
    } catch (err) {
      console.error('List professionals error:', err);
      res.status(500).json({ error: 'Failed to list professionals' });
    }
  }
);

// GET /api/professionals/eap - Get company's EAP page
router.get('/eap',
  authenticate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT e.id, e.overview, e.access_methods, e.operating_hours,
               e.languages, e.media, e.created_at, e.updated_at
        FROM eap_pages e
        WHERE e.company_id = $1
        LIMIT 1
      `, [req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'EAP page not configured for your organisation' });
      }

      res.json({ eap: rows[0] });
    } catch (err) {
      console.error('Get EAP error:', err);
      res.status(500).json({ error: 'Failed to retrieve EAP information' });
    }
  }
);

// GET /api/professionals/my-cases - Employee's cases
router.get('/my-cases',
  authenticate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT c.id, c.case_number, c.support_topic, c.preferred_modality,
               c.urgency, c.status, c.created_at, c.updated_at,
               p.first_name AS professional_first_name,
               p.last_name AS professional_last_name,
               p.professional_type,
               c.proposed_times, c.confirmed_time
        FROM professional_cases c
        LEFT JOIN professionals p ON p.id = c.professional_id
        WHERE c.employee_id = $1 AND c.company_id = $2
        ORDER BY c.created_at DESC
      `, [req.user.id, req.user.company_id]);

      res.json({ cases: rows });
    } catch (err) {
      console.error('My cases error:', err);
      res.status(500).json({ error: 'Failed to retrieve cases' });
    }
  }
);

// GET /api/professionals/cases/:caseId - Case detail (employee sees own only)
router.get('/cases/:caseId',
  authenticate,
  [param('caseId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT c.*, p.first_name AS professional_first_name,
               p.last_name AS professional_last_name,
               p.professional_type, p.profile_photo_url,
               p.modalities AS professional_modalities
        FROM professional_cases c
        LEFT JOIN professionals p ON p.id = c.professional_id
        WHERE c.id = $1 AND c.employee_id = $2 AND c.company_id = $3
      `, [req.params.caseId, req.user.id, req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Case not found' });
      }

      res.json({ case: rows[0] });
    } catch (err) {
      console.error('Case detail error:', err);
      res.status(500).json({ error: 'Failed to retrieve case' });
    }
  }
);

// POST /api/professionals/request - Employee direct request
router.post('/request',
  authenticate,
  [
    body('support_topic').notEmpty().isString().trim(),
    body('preferred_modality').optional().isString(),
    body('availability').optional().isObject(),
    body('urgency').isIn(['standard', 'urgent', 'crisis']),
    body('notes').optional().isString().trim(),
    body('consent_acknowledged').isBoolean().equals('true')
  ],
  validate,
  async (req, res) => {
    try {
      const { support_topic, preferred_modality, availability, urgency, notes, consent_acknowledged } = req.body;

      if (!consent_acknowledged) {
        return res.status(400).json({ error: 'Consent must be acknowledged' });
      }

      // Crisis handling
      if (urgency === 'crisis') {
        const { rows: crisisContacts } = await pool.query(`
          SELECT name, phone, description, available_hours
          FROM crisis_contacts
          WHERE company_id = $1 OR is_global = true
          ORDER BY is_global ASC
        `, [req.user.company_id]);

        return res.status(200).json({
          crisis: true,
          message: 'If you are in immediate danger, please contact emergency services. Below are crisis support contacts available to you.',
          crisis_contacts: crisisContacts,
          acknowledgement_required: true
        });
      }

      const caseId = uuidv4();
      const caseNumber = `PC-${Date.now().toString(36).toUpperCase()}`;

      const { rows } = await pool.query(`
        INSERT INTO professional_cases
          (id, case_number, company_id, employee_id, support_topic, preferred_modality,
           availability, urgency, notes, consent_acknowledged, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'assigned', NOW(), NOW())
        RETURNING *
      `, [caseId, caseNumber, req.user.company_id, req.user.id, support_topic,
          preferred_modality, JSON.stringify(availability), urgency, notes, consent_acknowledged]);

      res.status(201).json({ case: rows[0] });
    } catch (err) {
      console.error('Create request error:', err);
      res.status(500).json({ error: 'Failed to create request' });
    }
  }
);

// POST /api/professionals/cases/:caseId/confirm-time - Employee confirms proposed time
router.post('/cases/:caseId/confirm-time',
  authenticate,
  [
    param('caseId').isUUID(),
    body('selected_time').isISO8601()
  ],
  validate,
  async (req, res) => {
    try {
      const { selected_time } = req.body;

      const { rows: caseRows } = await pool.query(`
        SELECT id, proposed_times, status FROM professional_cases
        WHERE id = $1 AND employee_id = $2 AND company_id = $3
      `, [req.params.caseId, req.user.id, req.user.company_id]);

      if (!caseRows.length) {
        return res.status(404).json({ error: 'Case not found' });
      }

      const caseRecord = caseRows[0];
      if (caseRecord.status !== 'times_proposed') {
        return res.status(400).json({ error: 'Case is not awaiting time confirmation' });
      }

      const proposedTimes = caseRecord.proposed_times || [];
      const isValidTime = proposedTimes.some(t => new Date(t).getTime() === new Date(selected_time).getTime());
      if (!isValidTime) {
        return res.status(400).json({ error: 'Selected time is not among proposed options' });
      }

      const { rows } = await pool.query(`
        UPDATE professional_cases
        SET confirmed_time = $1, status = 'confirmed', updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [selected_time, req.params.caseId]);

      res.json({ case: rows[0] });
    } catch (err) {
      console.error('Confirm time error:', err);
      res.status(500).json({ error: 'Failed to confirm time' });
    }
  }
);

// POST /api/professionals/cases/:caseId/confirm-attendance - Employee confirms attendance
router.post('/cases/:caseId/confirm-attendance',
  authenticate,
  [param('caseId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows: caseRows } = await pool.query(`
        SELECT id, status FROM professional_cases
        WHERE id = $1 AND employee_id = $2 AND company_id = $3
      `, [req.params.caseId, req.user.id, req.user.company_id]);

      if (!caseRows.length) {
        return res.status(404).json({ error: 'Case not found' });
      }

      if (caseRows[0].status !== 'completed') {
        return res.status(400).json({ error: 'Session must be marked completed by professional first' });
      }

      const { rows } = await pool.query(`
        UPDATE professional_cases
        SET employee_attendance_confirmed = true, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [req.params.caseId]);

      res.json({ case: rows[0] });
    } catch (err) {
      console.error('Confirm attendance error:', err);
      res.status(500).json({ error: 'Failed to confirm attendance' });
    }
  }
);

// POST /api/professionals/cases/:caseId/cancel - Employee cancels
router.post('/cases/:caseId/cancel',
  authenticate,
  [
    param('caseId').isUUID(),
    body('reason').optional().isString().trim()
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: caseRows } = await pool.query(`
        SELECT id, status FROM professional_cases
        WHERE id = $1 AND employee_id = $2 AND company_id = $3
      `, [req.params.caseId, req.user.id, req.user.company_id]);

      if (!caseRows.length) {
        return res.status(404).json({ error: 'Case not found' });
      }

      if (['completed', 'cancelled'].includes(caseRows[0].status)) {
        return res.status(400).json({ error: 'Cannot cancel a case that is already completed or cancelled' });
      }

      const { rows } = await pool.query(`
        UPDATE professional_cases
        SET status = 'cancelled', cancellation_reason = $1, cancelled_by = 'employee', updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [req.body.reason || null, req.params.caseId]);

      res.json({ case: rows[0] });
    } catch (err) {
      console.error('Cancel case error:', err);
      res.status(500).json({ error: 'Failed to cancel case' });
    }
  }
);

// GET /api/professionals/cases/:caseId/messages - Get messages for a case (employee)
router.get('/cases/:caseId/messages',
  authenticate,
  [param('caseId').isUUID()],
  validate,
  async (req, res) => {
    try {
      // Verify employee owns the case
      const { rows: caseRows } = await pool.query(`
        SELECT id FROM professional_cases
        WHERE id = $1 AND employee_id = $2 AND company_id = $3
      `, [req.params.caseId, req.user.id, req.user.company_id]);

      if (!caseRows.length) {
        return res.status(404).json({ error: 'Case not found' });
      }

      const { rows } = await pool.query(`
        SELECT m.id, m.sender_type, m.sender_id, m.message, m.created_at,
               CASE
                 WHEN m.sender_type = 'employee' THEN u.first_name || ' ' || u.last_name
                 WHEN m.sender_type = 'professional' THEN p.first_name || ' ' || p.last_name
                 ELSE 'System'
               END AS sender_name
        FROM professional_case_messages m
        LEFT JOIN users u ON u.id = m.sender_id AND m.sender_type = 'employee'
        LEFT JOIN professionals p ON p.id = m.sender_id AND m.sender_type = 'professional'
        WHERE m.case_id = $1
        ORDER BY m.created_at ASC
      `, [req.params.caseId]);

      res.json({ messages: rows });
    } catch (err) {
      console.error('Get messages error:', err);
      res.status(500).json({ error: 'Failed to retrieve messages' });
    }
  }
);

// POST /api/professionals/cases/:caseId/messages - Send message (employee)
router.post('/cases/:caseId/messages',
  authenticate,
  [
    param('caseId').isUUID(),
    body('message').notEmpty().isString().trim().isLength({ max: 5000 })
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: caseRows } = await pool.query(`
        SELECT id FROM professional_cases
        WHERE id = $1 AND employee_id = $2 AND company_id = $3
      `, [req.params.caseId, req.user.id, req.user.company_id]);

      if (!caseRows.length) {
        return res.status(404).json({ error: 'Case not found' });
      }

      const msgId = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO professional_case_messages (id, case_id, sender_type, sender_id, message, created_at)
        VALUES ($1, $2, 'employee', $3, $4, NOW())
        RETURNING *
      `, [msgId, req.params.caseId, req.user.id, req.body.message]);

      res.status(201).json({ message: rows[0] });
    } catch (err) {
      console.error('Send message error:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

// GET /api/professionals/:id - Professional profile
router.get('/:id',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT p.id, p.first_name, p.last_name, p.professional_type, p.title,
               p.bio, p.modalities, p.languages, p.specialisations,
               p.profile_photo_url, p.is_preferred, p.average_rating,
               p.credentials, p.years_experience, p.qualifications
        FROM professionals p
        LEFT JOIN professional_org_assignments poa ON poa.professional_id = p.id
        WHERE p.id = $1 AND (poa.company_id = $2 OR p.is_preferred = true)
      `, [req.params.id, req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Professional not found' });
      }

      res.json({ professional: rows[0] });
    } catch (err) {
      console.error('Professional detail error:', err);
      res.status(500).json({ error: 'Failed to retrieve professional' });
    }
  }
);

// ============================================================
// MANAGER / HR REFERRAL ENDPOINTS
// ============================================================

// POST /api/professionals/referrals - Create referral
router.post('/referrals',
  authenticate,
  requireManager,
  [
    body('employee_id').isUUID(),
    body('reason_category').notEmpty().isString().trim(),
    body('context_note').optional().isString().trim().isLength({ max: 2000 }),
    body('urgency').isIn(['standard', 'urgent']),
    body('confidentiality_acknowledged').isBoolean().equals('true'),
    body('suggested_professional_id').optional().isUUID(),
    body('suggested_modality').optional().isString()
  ],
  validate,
  async (req, res) => {
    try {
      const {
        employee_id, reason_category, context_note, urgency,
        confidentiality_acknowledged, suggested_professional_id, suggested_modality
      } = req.body;

      if (!confidentiality_acknowledged) {
        return res.status(400).json({ error: 'Confidentiality must be acknowledged' });
      }

      // Verify employee belongs to same company
      const { rows: empRows } = await pool.query(
        `SELECT id, first_name, last_name FROM users WHERE id = $1 AND company_id = $2`,
        [employee_id, req.user.company_id]
      );
      if (!empRows.length) {
        return res.status(404).json({ error: 'Employee not found in your organisation' });
      }

      const referralId = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO professional_referrals
          (id, company_id, referring_manager_id, employee_id, reason_category,
           context_note, urgency, confidentiality_acknowledged,
           suggested_professional_id, suggested_modality, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NOW(), NOW())
        RETURNING id, status, created_at
      `, [referralId, req.user.company_id, req.user.id, employee_id, reason_category,
          context_note, urgency, confidentiality_acknowledged,
          suggested_professional_id, suggested_modality]);

      res.status(201).json({
        referral: {
          ...rows[0],
          employee_name: `${empRows[0].first_name} ${empRows[0].last_name}`
        }
      });
    } catch (err) {
      console.error('Create referral error:', err);
      res.status(500).json({ error: 'Failed to create referral' });
    }
  }
);

// GET /api/professionals/referrals - List referrals (manager sees limited fields)
router.get('/referrals',
  authenticate,
  requireManager,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT r.id AS referral_id,
               u.first_name || ' ' || u.last_name AS employee_name,
               r.status, r.created_at
        FROM professional_referrals r
        JOIN users u ON u.id = r.employee_id
        WHERE r.referring_manager_id = $1 AND r.company_id = $2
        ORDER BY r.created_at DESC
      `, [req.user.id, req.user.company_id]);

      res.json({ referrals: rows });
    } catch (err) {
      console.error('List referrals error:', err);
      res.status(500).json({ error: 'Failed to list referrals' });
    }
  }
);

// GET /api/professionals/referrals/:id - Referral detail (limited)
router.get('/referrals/:id',
  authenticate,
  requireManager,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT r.id AS referral_id,
               u.first_name || ' ' || u.last_name AS employee_name,
               r.reason_category, r.urgency, r.status, r.created_at, r.updated_at
        FROM professional_referrals r
        JOIN users u ON u.id = r.employee_id
        WHERE r.id = $1 AND r.referring_manager_id = $2 AND r.company_id = $3
      `, [req.params.id, req.user.id, req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Referral not found' });
      }

      res.json({ referral: rows[0] });
    } catch (err) {
      console.error('Referral detail error:', err);
      res.status(500).json({ error: 'Failed to retrieve referral' });
    }
  }
);

// ============================================================
// PROFESSIONAL PORTAL ENDPOINTS
// ============================================================

// Middleware to authenticate professional from JWT
const authenticateProfessional = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.type !== 'professional') {
      return res.status(403).json({ error: 'Professional access required' });
    }

    const { rows } = await pool.query(
      `SELECT id, email, first_name, last_name, professional_type, status FROM professionals WHERE id = $1`,
      [decoded.id]
    );

    if (!rows.length || rows[0].status !== 'active') {
      return res.status(401).json({ error: 'Invalid or inactive professional account' });
    }

    req.professional = rows[0];
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error('Professional auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// POST /api/professionals/portal/login - Professional login
router.post('/portal/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
  ],
  validate,
  async (req, res) => {
    try {
      const { email, password } = req.body;

      const { rows } = await pool.query(
        `SELECT id, email, password_hash, first_name, last_name, professional_type, status
         FROM professionals WHERE email = $1`,
        [email]
      );

      if (!rows.length) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const professional = rows[0];
      if (professional.status !== 'active') {
        return res.status(403).json({ error: 'Account is not active' });
      }

      const passwordValid = await bcrypt.compare(password, professional.password_hash);
      if (!passwordValid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = jwt.sign(
        { id: professional.id, type: 'professional' },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.json({
        token,
        professional: {
          id: professional.id,
          email: professional.email,
          first_name: professional.first_name,
          last_name: professional.last_name,
          professional_type: professional.professional_type
        }
      });
    } catch (err) {
      console.error('Professional login error:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

// POST /api/professionals/portal/accept-invite - Accept invitation
router.post('/portal/accept-invite',
  [
    body('invite_token').notEmpty().isString(),
    body('password').isLength({ min: 8 }),
    body('terms_accepted').isBoolean().equals('true')
  ],
  validate,
  async (req, res) => {
    try {
      const { invite_token, password, terms_accepted } = req.body;

      if (!terms_accepted) {
        return res.status(400).json({ error: 'Terms must be accepted' });
      }

      const { rows } = await pool.query(
        `SELECT id, email, first_name, last_name FROM professionals
         WHERE invite_token = $1 AND status = 'invited' AND invite_expires_at > NOW()`,
        [invite_token]
      );

      if (!rows.length) {
        return res.status(400).json({ error: 'Invalid or expired invitation' });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      await pool.query(`
        UPDATE professionals
        SET password_hash = $1, status = 'active', terms_accepted = true,
            terms_accepted_at = NOW(), invite_token = NULL, updated_at = NOW()
        WHERE id = $2
      `, [passwordHash, rows[0].id]);

      const token = jwt.sign(
        { id: rows[0].id, type: 'professional' },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.json({
        token,
        professional: {
          id: rows[0].id,
          email: rows[0].email,
          first_name: rows[0].first_name,
          last_name: rows[0].last_name
        }
      });
    } catch (err) {
      console.error('Accept invite error:', err);
      res.status(500).json({ error: 'Failed to accept invitation' });
    }
  }
);

// GET /api/professionals/portal/dashboard - Professional dashboard
router.get('/portal/dashboard',
  authenticateProfessional,
  async (req, res) => {
    try {
      const profId = req.professional.id;

      const [newRequests, awaitingConfirmation, confirmedUpcoming, completed, declined] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) AS count FROM professional_cases WHERE professional_id = $1 AND status = 'assigned'`,
          [profId]
        ),
        pool.query(
          `SELECT COUNT(*) AS count FROM professional_cases WHERE professional_id = $1 AND status = 'times_proposed'`,
          [profId]
        ),
        pool.query(
          `SELECT COUNT(*) AS count FROM professional_cases
           WHERE professional_id = $1 AND status = 'confirmed' AND confirmed_time > NOW()`,
          [profId]
        ),
        pool.query(
          `SELECT COUNT(*) AS count FROM professional_cases WHERE professional_id = $1 AND status = 'completed'`,
          [profId]
        ),
        pool.query(
          `SELECT COUNT(*) AS count FROM professional_cases WHERE professional_id = $1 AND status IN ('declined', 'reassigned')`,
          [profId]
        )
      ]);

      // SLA performance: % of cases where first response was within 24h
      const slaResult = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE first_response_at IS NOT NULL AND first_response_at - created_at <= INTERVAL '24 hours') AS within_sla,
          COUNT(*) FILTER (WHERE first_response_at IS NOT NULL) AS total_responded
        FROM professional_cases
        WHERE professional_id = $1 AND created_at >= NOW() - INTERVAL '90 days'
      `, [profId]);

      const sla = slaResult.rows[0];
      const slaPerformance = sla.total_responded > 0
        ? Math.round((sla.within_sla / sla.total_responded) * 100)
        : 100;

      res.json({
        dashboard: {
          new_requests: +newRequests.rows[0].count,
          awaiting_confirmation: +awaitingConfirmation.rows[0].count,
          confirmed_upcoming: +confirmedUpcoming.rows[0].count,
          completed: +completed.rows[0].count,
          declined_reassigned: +declined.rows[0].count,
          sla_performance_pct: slaPerformance
        }
      });
    } catch (err) {
      console.error('Dashboard error:', err);
      res.status(500).json({ error: 'Failed to load dashboard' });
    }
  }
);

// GET /api/professionals/portal/cases - List assigned cases
router.get('/portal/cases',
  authenticateProfessional,
  [
    query('status').optional().isString(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 })
  ],
  validate,
  async (req, res) => {
    try {
      const { status, page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;
      const params = [req.professional.id];
      let whereClause = `WHERE c.professional_id = $1`;
      let paramIdx = 2;

      if (status) {
        whereClause += ` AND c.status = $${paramIdx++}`;
        params.push(status);
      }

      params.push(+limit, +offset);

      const { rows } = await pool.query(`
        SELECT c.id, c.case_number, c.support_topic, c.preferred_modality,
               c.urgency, c.status, c.created_at, c.confirmed_time,
               u.first_name AS employee_first_name, u.last_name AS employee_last_name
        FROM professional_cases c
        JOIN users u ON u.id = c.employee_id
        ${whereClause}
        ORDER BY
          CASE c.status
            WHEN 'assigned' THEN 1
            WHEN 'times_proposed' THEN 2
            WHEN 'confirmed' THEN 3
            ELSE 4
          END,
          c.created_at DESC
        LIMIT $${paramIdx++} OFFSET $${paramIdx}
      `, params);

      res.json({ cases: rows });
    } catch (err) {
      console.error('Portal cases error:', err);
      res.status(500).json({ error: 'Failed to list cases' });
    }
  }
);

// GET /api/professionals/portal/cases/:caseId - Case detail (professional)
router.get('/portal/cases/:caseId',
  authenticateProfessional,
  [param('caseId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT c.*, u.first_name AS employee_first_name, u.last_name AS employee_last_name,
               u.email AS employee_email
        FROM professional_cases c
        JOIN users u ON u.id = c.employee_id
        WHERE c.id = $1 AND c.professional_id = $2
      `, [req.params.caseId, req.professional.id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Case not found' });
      }

      res.json({ case: rows[0] });
    } catch (err) {
      console.error('Portal case detail error:', err);
      res.status(500).json({ error: 'Failed to retrieve case' });
    }
  }
);

// POST /api/professionals/portal/cases/:caseId/propose-times - Propose available times
router.post('/portal/cases/:caseId/propose-times',
  authenticateProfessional,
  [
    param('caseId').isUUID(),
    body('proposed_times').isArray({ min: 1, max: 10 }),
    body('proposed_times.*').isISO8601()
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: caseRows } = await pool.query(
        `SELECT id, status FROM professional_cases WHERE id = $1 AND professional_id = $2`,
        [req.params.caseId, req.professional.id]
      );

      if (!caseRows.length) {
        return res.status(404).json({ error: 'Case not found' });
      }

      if (caseRows[0].status !== 'assigned') {
        return res.status(400).json({ error: 'Times can only be proposed for newly assigned cases' });
      }

      const { rows } = await pool.query(`
        UPDATE professional_cases
        SET proposed_times = $1, status = 'times_proposed',
            first_response_at = COALESCE(first_response_at, NOW()), updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [JSON.stringify(req.body.proposed_times), req.params.caseId]);

      res.json({ case: rows[0] });
    } catch (err) {
      console.error('Propose times error:', err);
      res.status(500).json({ error: 'Failed to propose times' });
    }
  }
);

// POST /api/professionals/portal/cases/:caseId/complete - Mark session completed
router.post('/portal/cases/:caseId/complete',
  authenticateProfessional,
  [
    param('caseId').isUUID(),
    body('session_notes').optional().isString().trim()
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: caseRows } = await pool.query(
        `SELECT id, status FROM professional_cases WHERE id = $1 AND professional_id = $2`,
        [req.params.caseId, req.professional.id]
      );

      if (!caseRows.length) {
        return res.status(404).json({ error: 'Case not found' });
      }

      if (caseRows[0].status !== 'confirmed') {
        return res.status(400).json({ error: 'Only confirmed cases can be marked as completed' });
      }

      const { rows } = await pool.query(`
        UPDATE professional_cases
        SET status = 'completed', session_notes = $1, completed_at = NOW(), updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [req.body.session_notes || null, req.params.caseId]);

      res.json({ case: rows[0] });
    } catch (err) {
      console.error('Complete case error:', err);
      res.status(500).json({ error: 'Failed to complete case' });
    }
  }
);

// POST /api/professionals/portal/cases/:caseId/decline - Decline case
router.post('/portal/cases/:caseId/decline',
  authenticateProfessional,
  [
    param('caseId').isUUID(),
    body('decline_reason').notEmpty().isString().trim()
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: caseRows } = await pool.query(
        `SELECT id, status FROM professional_cases WHERE id = $1 AND professional_id = $2`,
        [req.params.caseId, req.professional.id]
      );

      if (!caseRows.length) {
        return res.status(404).json({ error: 'Case not found' });
      }

      if (!['assigned', 'times_proposed'].includes(caseRows[0].status)) {
        return res.status(400).json({ error: 'This case cannot be declined in its current status' });
      }

      const { rows } = await pool.query(`
        UPDATE professional_cases
        SET status = 'declined', decline_reason = $1, professional_id = NULL, updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [req.body.decline_reason, req.params.caseId]);

      res.json({ case: rows[0], message: 'Case declined and returned to admin queue' });
    } catch (err) {
      console.error('Decline case error:', err);
      res.status(500).json({ error: 'Failed to decline case' });
    }
  }
);

// GET /api/professionals/portal/cases/:caseId/messages - Get messages (professional)
router.get('/portal/cases/:caseId/messages',
  authenticateProfessional,
  [param('caseId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows: caseRows } = await pool.query(
        `SELECT id FROM professional_cases WHERE id = $1 AND professional_id = $2`,
        [req.params.caseId, req.professional.id]
      );

      if (!caseRows.length) {
        return res.status(404).json({ error: 'Case not found' });
      }

      const { rows } = await pool.query(`
        SELECT m.id, m.sender_type, m.sender_id, m.message, m.created_at,
               CASE
                 WHEN m.sender_type = 'employee' THEN u.first_name || ' ' || u.last_name
                 WHEN m.sender_type = 'professional' THEN p.first_name || ' ' || p.last_name
                 ELSE 'System'
               END AS sender_name
        FROM professional_case_messages m
        LEFT JOIN users u ON u.id = m.sender_id AND m.sender_type = 'employee'
        LEFT JOIN professionals p ON p.id = m.sender_id AND m.sender_type = 'professional'
        WHERE m.case_id = $1
        ORDER BY m.created_at ASC
      `, [req.params.caseId]);

      res.json({ messages: rows });
    } catch (err) {
      console.error('Portal get messages error:', err);
      res.status(500).json({ error: 'Failed to retrieve messages' });
    }
  }
);

// POST /api/professionals/portal/cases/:caseId/messages - Send message (professional)
router.post('/portal/cases/:caseId/messages',
  authenticateProfessional,
  [
    param('caseId').isUUID(),
    body('message').notEmpty().isString().trim().isLength({ max: 5000 })
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: caseRows } = await pool.query(
        `SELECT id FROM professional_cases WHERE id = $1 AND professional_id = $2`,
        [req.params.caseId, req.professional.id]
      );

      if (!caseRows.length) {
        return res.status(404).json({ error: 'Case not found' });
      }

      const msgId = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO professional_case_messages (id, case_id, sender_type, sender_id, message, created_at)
        VALUES ($1, $2, 'professional', $3, $4, NOW())
        RETURNING *
      `, [msgId, req.params.caseId, req.professional.id, req.body.message]);

      res.status(201).json({ message: rows[0] });
    } catch (err) {
      console.error('Portal send message error:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

// PATCH /api/professionals/portal/profile - Update own profile
router.patch('/portal/profile',
  authenticateProfessional,
  [
    body('bio').optional().isString().trim(),
    body('title').optional().isString().trim(),
    body('modalities').optional().isArray(),
    body('languages').optional().isArray(),
    body('specialisations').optional().isArray(),
    body('profile_photo_url').optional().isURL(),
    body('qualifications').optional().isArray(),
    body('years_experience').optional().isInt({ min: 0 })
  ],
  validate,
  async (req, res) => {
    try {
      const allowedFields = [
        'bio', 'title', 'modalities', 'languages', 'specialisations',
        'profile_photo_url', 'qualifications', 'years_experience'
      ];

      const updates = [];
      const values = [];
      let paramIdx = 1;

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          const value = Array.isArray(req.body[field])
            ? JSON.stringify(req.body[field])
            : req.body[field];
          updates.push(`${field} = $${paramIdx++}`);
          values.push(value);
        }
      }

      if (!updates.length) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      updates.push(`updated_at = NOW()`);
      values.push(req.professional.id);

      const { rows } = await pool.query(`
        UPDATE professionals
        SET ${updates.join(', ')}
        WHERE id = $${paramIdx}
        RETURNING id, first_name, last_name, email, professional_type, title, bio,
                  modalities, languages, specialisations, profile_photo_url,
                  qualifications, years_experience
      `, values);

      res.json({ professional: rows[0] });
    } catch (err) {
      console.error('Update profile error:', err);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  }
);

module.exports = router;
