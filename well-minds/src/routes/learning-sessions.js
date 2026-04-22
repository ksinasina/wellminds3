const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireManager, requireAdmin, requireRole, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { sendEmail } = require('../utils/email');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// EMPLOYEE ENDPOINTS
// ============================================================

// GET /api/learning-sessions - List published sessions
router.get('/',
  authenticate,
  [
    query('category').optional().isIn(['wellbeing', 'leadership', 'culture']),
    query('time_filter').optional().isIn(['upcoming', 'past']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 })
  ],
  validate,
  async (req, res) => {
    try {
      const { category, time_filter, page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;
      const companyId = req.user.company_id;
      const params = [companyId];
      let paramIdx = 2;

      let whereClause = `WHERE ls.company_id = $1 AND ls.status = 'published'`;

      if (category) {
        whereClause += ` AND ls.category = $${paramIdx++}`;
        params.push(category);
      }
      if (time_filter === 'upcoming') {
        whereClause += ` AND ls.session_date >= NOW()`;
      } else if (time_filter === 'past') {
        whereClause += ` AND ls.session_date < NOW()`;
      }

      params.push(+limit, +offset);

      const { rows } = await pool.query(`
        SELECT ls.id, ls.title, ls.description, ls.category, ls.facilitator_name,
               ls.session_type, ls.session_date, ls.duration_minutes, ls.timezone,
               ls.rsvp_required, ls.capacity_limit,
               COUNT(DISTINCT rsvp.id) FILTER (WHERE rsvp.response = 'yes') AS attendee_count,
               EXISTS(
                 SELECT 1 FROM learning_session_rsvps r2
                 WHERE r2.session_id = ls.id AND r2.user_id = $${paramIdx + 1}
               ) AS has_rsvpd
        FROM learning_sessions ls
        LEFT JOIN learning_session_rsvps rsvp ON rsvp.session_id = ls.id
        ${whereClause}
        GROUP BY ls.id
        ORDER BY ls.session_date ASC
        LIMIT $${paramIdx++} OFFSET $${paramIdx}
      `, [...params, req.user.id]);

      const countResult = await pool.query(`
        SELECT COUNT(*) AS total FROM learning_sessions ls ${whereClause}
      `, params.slice(0, paramIdx - 3));

      res.json({
        sessions: rows,
        pagination: { page: +page, limit: +limit, total: +countResult.rows[0].total }
      });
    } catch (err) {
      console.error('List sessions error:', err);
      res.status(500).json({ error: 'Failed to list learning sessions' });
    }
  }
);

// GET /api/learning-sessions/recordings - List available recordings
router.get('/recordings',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 })
  ],
  validate,
  async (req, res) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      const { rows } = await pool.query(`
        SELECT r.id, r.title, r.description, r.recording_type, r.recording_url,
               r.thumbnail_url, r.duration_minutes, r.created_at,
               ls.title AS session_title, ls.category
        FROM learning_session_recordings r
        LEFT JOIN learning_sessions ls ON ls.id = r.session_id
        WHERE (ls.company_id = $1 OR r.company_id = $1) AND r.status = 'published'
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3
      `, [req.user.company_id, +limit, +offset]);

      res.json({ recordings: rows });
    } catch (err) {
      console.error('List recordings error:', err);
      res.status(500).json({ error: 'Failed to list recordings' });
    }
  }
);

// GET /api/learning-sessions/recordings/:id - Recording detail
router.get('/recordings/:id',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT r.*, ls.title AS session_title, ls.category, ls.facilitator_name
        FROM learning_session_recordings r
        LEFT JOIN learning_sessions ls ON ls.id = r.session_id
        WHERE r.id = $1 AND (ls.company_id = $2 OR r.company_id = $2)
      `, [req.params.id, req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Recording not found' });
      }

      // Track view
      await pool.query(`
        INSERT INTO learning_recording_views (id, recording_id, user_id, viewed_at)
        VALUES ($1, $2, $3, NOW())
      `, [uuidv4(), req.params.id, req.user.id]);

      res.json({ recording: rows[0] });
    } catch (err) {
      console.error('Recording detail error:', err);
      res.status(500).json({ error: 'Failed to retrieve recording' });
    }
  }
);

// GET /api/learning-sessions/my-sessions - User's RSVPd sessions
router.get('/my-sessions',
  authenticate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT ls.id, ls.title, ls.description, ls.category, ls.facilitator_name,
               ls.session_type, ls.session_date, ls.duration_minutes, ls.timezone,
               ls.live_session_url, ls.access_instructions,
               rsvp.response, rsvp.created_at AS rsvp_date
        FROM learning_session_rsvps rsvp
        JOIN learning_sessions ls ON ls.id = rsvp.session_id
        WHERE rsvp.user_id = $1 AND ls.company_id = $2
        ORDER BY ls.session_date DESC
      `, [req.user.id, req.user.company_id]);

      res.json({ sessions: rows });
    } catch (err) {
      console.error('My sessions error:', err);
      res.status(500).json({ error: 'Failed to retrieve your sessions' });
    }
  }
);

// GET /api/learning-sessions/:id - Session detail
router.get('/:id',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT ls.*,
               COUNT(DISTINCT rsvp.id) FILTER (WHERE rsvp.response = 'yes') AS yes_count,
               COUNT(DISTINCT rsvp.id) FILTER (WHERE rsvp.response = 'no') AS no_count,
               COUNT(DISTINCT rsvp.id) FILTER (WHERE rsvp.response = 'maybe') AS maybe_count
        FROM learning_sessions ls
        LEFT JOIN learning_session_rsvps rsvp ON rsvp.session_id = ls.id
        WHERE ls.id = $1 AND ls.company_id = $2
        GROUP BY ls.id
      `, [req.params.id, req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // User's RSVP
      const { rows: rsvpRows } = await pool.query(
        `SELECT response FROM learning_session_rsvps WHERE session_id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );

      res.json({
        session: rows[0],
        my_rsvp: rsvpRows[0]?.response || null,
        attendee_count: +rows[0].yes_count
      });
    } catch (err) {
      console.error('Session detail error:', err);
      res.status(500).json({ error: 'Failed to retrieve session' });
    }
  }
);

// POST /api/learning-sessions/:id/rsvp - RSVP
router.post('/:id/rsvp',
  authenticate,
  [
    param('id').isUUID(),
    body('response').isIn(['yes', 'no', 'maybe'])
  ],
  validate,
  async (req, res) => {
    try {
      const { response } = req.body;

      const { rows: sessionRows } = await pool.query(
        `SELECT id, capacity_limit, rsvp_required FROM learning_sessions
         WHERE id = $1 AND company_id = $2 AND status = 'published'`,
        [req.params.id, req.user.company_id]
      );

      if (!sessionRows.length) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check capacity for 'yes' responses
      if (response === 'yes' && sessionRows[0].capacity_limit) {
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*) AS count FROM learning_session_rsvps
           WHERE session_id = $1 AND response = 'yes'`,
          [req.params.id]
        );

        // Check if already RSVPd yes (don't count against capacity)
        const { rows: existingRsvp } = await pool.query(
          `SELECT response FROM learning_session_rsvps WHERE session_id = $1 AND user_id = $2`,
          [req.params.id, req.user.id]
        );

        const currentCount = +countRows[0].count;
        const alreadyYes = existingRsvp.length && existingRsvp[0].response === 'yes';

        if (!alreadyYes && currentCount >= sessionRows[0].capacity_limit) {
          return res.status(409).json({ error: 'Session is at full capacity' });
        }
      }

      const rsvpId = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO learning_session_rsvps (id, session_id, user_id, response, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (session_id, user_id) DO UPDATE SET response = $4, updated_at = NOW()
        RETURNING *
      `, [rsvpId, req.params.id, req.user.id, response]);

      res.json({ rsvp: rows[0] });
    } catch (err) {
      console.error('RSVP error:', err);
      res.status(500).json({ error: 'Failed to RSVP' });
    }
  }
);

// ============================================================
// ADMIN ENDPOINTS
// ============================================================

// POST /api/learning-sessions - Create session
router.post('/',
  authenticate,
  requireAdmin,
  [
    body('title').notEmpty().isString().trim().isLength({ max: 300 }),
    body('description').optional().isString().trim(),
    body('category').isIn(['wellbeing', 'leadership', 'culture']),
    body('facilitator_name').optional().isString().trim(),
    body('session_type').isIn(['live', 'recorded', 'live_plus_recording']),
    body('session_date').optional().isISO8601(),
    body('duration_minutes').optional().isInt({ min: 1 }),
    body('timezone').optional().isString(),
    body('audience_type').optional().isIn(['all', 'department', 'business_unit', 'custom']),
    body('audience_value').optional(),
    body('rsvp_required').optional().isBoolean(),
    body('capacity_limit').optional().isInt({ min: 1 }),
    body('live_session_url').optional().isURL(),
    body('backup_url').optional().isURL(),
    body('access_instructions').optional().isString().trim()
  ],
  validate,
  async (req, res) => {
    try {
      const {
        title, description, category, facilitator_name, session_type,
        session_date, duration_minutes, timezone, audience_type = 'all',
        audience_value, rsvp_required = true, capacity_limit,
        live_session_url, backup_url, access_instructions
      } = req.body;

      const id = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO learning_sessions
          (id, company_id, title, description, category, facilitator_name,
           session_type, session_date, duration_minutes, timezone,
           audience_type, audience_value, rsvp_required, capacity_limit,
           live_session_url, backup_url, access_instructions,
           status, created_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                'draft', $18, NOW(), NOW())
        RETURNING *
      `, [id, req.user.company_id, title, description, category, facilitator_name,
          session_type, session_date, duration_minutes, timezone,
          audience_type, JSON.stringify(audience_value), rsvp_required, capacity_limit,
          live_session_url, backup_url, access_instructions, req.user.id]);

      res.status(201).json({ session: rows[0] });
    } catch (err) {
      console.error('Create session error:', err);
      res.status(500).json({ error: 'Failed to create session' });
    }
  }
);

// PATCH /api/learning-sessions/:id - Update session
router.patch('/:id',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    body('title').optional().isString().trim(),
    body('description').optional().isString().trim(),
    body('category').optional().isIn(['wellbeing', 'leadership', 'culture']),
    body('facilitator_name').optional().isString().trim(),
    body('session_type').optional().isIn(['live', 'recorded', 'live_plus_recording']),
    body('session_date').optional().isISO8601(),
    body('duration_minutes').optional().isInt({ min: 1 }),
    body('timezone').optional().isString(),
    body('audience_type').optional().isIn(['all', 'department', 'business_unit', 'custom']),
    body('rsvp_required').optional().isBoolean(),
    body('capacity_limit').optional().isInt({ min: 1 }),
    body('live_session_url').optional().isURL(),
    body('backup_url').optional().isURL(),
    body('access_instructions').optional().isString().trim()
  ],
  validate,
  async (req, res) => {
    try {
      const allowedFields = [
        'title', 'description', 'category', 'facilitator_name', 'session_type',
        'session_date', 'duration_minutes', 'timezone', 'audience_type',
        'audience_value', 'rsvp_required', 'capacity_limit', 'live_session_url',
        'backup_url', 'access_instructions'
      ];

      const updates = [];
      const values = [];
      let paramIdx = 1;

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = $${paramIdx++}`);
          values.push(field === 'audience_value' ? JSON.stringify(req.body[field]) : req.body[field]);
        }
      }

      if (!updates.length) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      updates.push(`updated_at = NOW()`);
      values.push(req.params.id, req.user.company_id);

      const { rows } = await pool.query(`
        UPDATE learning_sessions SET ${updates.join(', ')}
        WHERE id = $${paramIdx++} AND company_id = $${paramIdx}
        RETURNING *
      `, values);

      if (!rows.length) {
        return res.status(404).json({ error: 'Session not found' });
      }

      res.json({ session: rows[0] });
    } catch (err) {
      console.error('Update session error:', err);
      res.status(500).json({ error: 'Failed to update session' });
    }
  }
);

// PATCH /api/learning-sessions/:id/publish - Publish session
router.patch('/:id/publish',
  authenticate,
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        UPDATE learning_sessions SET status = 'published', published_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND company_id = $2 AND status = 'draft'
        RETURNING *
      `, [req.params.id, req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Session not found or already published' });
      }

      // Send announcement notification to eligible users
      const session = rows[0];
      let userQuery = `SELECT id, email, first_name FROM users WHERE company_id = $1 AND status = 'active'`;
      const userParams = [req.user.company_id];

      if (session.audience_type === 'department' && session.audience_value) {
        userQuery += ` AND department = $2`;
        userParams.push(session.audience_value);
      } else if (session.audience_type === 'business_unit' && session.audience_value) {
        userQuery += ` AND business_unit = $2`;
        userParams.push(session.audience_value);
      }

      const { rows: users } = await pool.query(userQuery, userParams);

      // Send emails in background (non-blocking)
      Promise.allSettled(
        users.map(user =>
          sendEmail({
            to: user.email,
            subject: `New Learning Session: ${session.title}`,
            template: 'learning_session_announcement',
            data: {
              userName: user.first_name,
              sessionTitle: session.title,
              sessionDate: session.session_date,
              facilitator: session.facilitator_name,
              description: session.description
            }
          })
        )
      ).catch(err => console.error('Email send errors:', err));

      res.json({ session: rows[0], notifications_sent: users.length });
    } catch (err) {
      console.error('Publish session error:', err);
      res.status(500).json({ error: 'Failed to publish session' });
    }
  }
);

// DELETE /api/learning-sessions/:id - Delete/cancel session
router.delete('/:id',
  authenticate,
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        UPDATE learning_sessions SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND company_id = $2
        RETURNING id, title, status
      `, [req.params.id, req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Notify RSVPd users about cancellation
      const { rows: rsvpUsers } = await pool.query(`
        SELECT u.email, u.first_name
        FROM learning_session_rsvps rsvp
        JOIN users u ON u.id = rsvp.user_id
        WHERE rsvp.session_id = $1 AND rsvp.response = 'yes'
      `, [req.params.id]);

      Promise.allSettled(
        rsvpUsers.map(user =>
          sendEmail({
            to: user.email,
            subject: `Session Cancelled: ${rows[0].title}`,
            template: 'learning_session_cancelled',
            data: { userName: user.first_name, sessionTitle: rows[0].title }
          })
        )
      ).catch(err => console.error('Cancellation email errors:', err));

      res.json({ message: 'Session cancelled', session: rows[0] });
    } catch (err) {
      console.error('Delete session error:', err);
      res.status(500).json({ error: 'Failed to delete session' });
    }
  }
);

// POST /api/learning-sessions/:id/recordings - Add recording
router.post('/:id/recordings',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    body('title').notEmpty().isString().trim(),
    body('description').optional().isString().trim(),
    body('recording_type').isIn(['video', 'audio', 'slides', 'document']),
    body('recording_url').isURL(),
    body('thumbnail_url').optional().isURL(),
    body('duration_minutes').optional().isInt({ min: 1 })
  ],
  validate,
  async (req, res) => {
    try {
      // Verify session exists
      const { rows: sessionRows } = await pool.query(
        `SELECT id FROM learning_sessions WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user.company_id]
      );
      if (!sessionRows.length) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const { title, description, recording_type, recording_url, thumbnail_url, duration_minutes } = req.body;
      const recordingId = uuidv4();

      const { rows } = await pool.query(`
        INSERT INTO learning_session_recordings
          (id, session_id, company_id, title, description, recording_type,
           recording_url, thumbnail_url, duration_minutes, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published', NOW())
        RETURNING *
      `, [recordingId, req.params.id, req.user.company_id, title, description,
          recording_type, recording_url, thumbnail_url, duration_minutes]);

      res.status(201).json({ recording: rows[0] });
    } catch (err) {
      console.error('Add recording error:', err);
      res.status(500).json({ error: 'Failed to add recording' });
    }
  }
);

// PATCH /api/learning-sessions/recordings/:id - Update recording
router.patch('/recordings/:id',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    body('title').optional().isString().trim(),
    body('description').optional().isString().trim(),
    body('recording_url').optional().isURL(),
    body('thumbnail_url').optional().isURL(),
    body('duration_minutes').optional().isInt({ min: 1 })
  ],
  validate,
  async (req, res) => {
    try {
      const allowedFields = ['title', 'description', 'recording_url', 'thumbnail_url', 'duration_minutes'];
      const updates = [];
      const values = [];
      let paramIdx = 1;

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = $${paramIdx++}`);
          values.push(req.body[field]);
        }
      }

      if (!updates.length) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      values.push(req.params.id, req.user.company_id);

      const { rows } = await pool.query(`
        UPDATE learning_session_recordings SET ${updates.join(', ')}
        WHERE id = $${paramIdx++} AND company_id = $${paramIdx}
        RETURNING *
      `, values);

      if (!rows.length) {
        return res.status(404).json({ error: 'Recording not found' });
      }

      res.json({ recording: rows[0] });
    } catch (err) {
      console.error('Update recording error:', err);
      res.status(500).json({ error: 'Failed to update recording' });
    }
  }
);

// DELETE /api/learning-sessions/recordings/:id - Delete recording
router.delete('/recordings/:id',
  authenticate,
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rowCount } = await pool.query(`
        DELETE FROM learning_session_recordings
        WHERE id = $1 AND company_id = $2
      `, [req.params.id, req.user.company_id]);

      if (!rowCount) {
        return res.status(404).json({ error: 'Recording not found' });
      }

      res.json({ message: 'Recording deleted' });
    } catch (err) {
      console.error('Delete recording error:', err);
      res.status(500).json({ error: 'Failed to delete recording' });
    }
  }
);

// GET /api/learning-sessions/:id/attendees - List RSVPs and attendance
router.get('/:id/attendees',
  authenticate,
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT rsvp.id, rsvp.response, rsvp.created_at AS rsvp_date,
               u.id AS user_id, u.first_name, u.last_name, u.email, u.department,
               att.status AS attendance_status, att.marked_at AS attendance_marked_at
        FROM learning_session_rsvps rsvp
        JOIN users u ON u.id = rsvp.user_id
        LEFT JOIN learning_session_attendance att ON att.session_id = rsvp.session_id AND att.user_id = rsvp.user_id
        WHERE rsvp.session_id = $1
          AND rsvp.session_id IN (SELECT id FROM learning_sessions WHERE company_id = $2)
        ORDER BY u.last_name, u.first_name
      `, [req.params.id, req.user.company_id]);

      res.json({ attendees: rows });
    } catch (err) {
      console.error('List attendees error:', err);
      res.status(500).json({ error: 'Failed to list attendees' });
    }
  }
);

// POST /api/learning-sessions/:id/attendance - Mark attendance (batch)
router.post('/:id/attendance',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    body('attendees').isArray({ min: 1 }),
    body('attendees.*.user_id').isUUID(),
    body('attendees.*.status').isIn(['attended', 'absent', 'partial'])
  ],
  validate,
  async (req, res) => {
    try {
      // Verify session
      const { rows: sessionRows } = await pool.query(
        `SELECT id FROM learning_sessions WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user.company_id]
      );
      if (!sessionRows.length) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const { attendees } = req.body;
      const insertValues = [];
      const insertParams = [];
      let paramIdx = 1;

      for (const att of attendees) {
        const attId = uuidv4();
        insertValues.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NOW())`);
        insertParams.push(attId, req.params.id, att.user_id, att.status, req.user.id);
      }

      await pool.query(`
        INSERT INTO learning_session_attendance (id, session_id, user_id, status, marked_by, marked_at)
        VALUES ${insertValues.join(', ')}
        ON CONFLICT (session_id, user_id)
        DO UPDATE SET status = EXCLUDED.status, marked_by = EXCLUDED.marked_by, marked_at = NOW()
      `, insertParams);

      res.json({ message: `Attendance marked for ${attendees.length} user(s)` });
    } catch (err) {
      console.error('Mark attendance error:', err);
      res.status(500).json({ error: 'Failed to mark attendance' });
    }
  }
);

// GET /api/learning-sessions/:id/stats - Session stats
router.get('/:id/stats',
  authenticate,
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT id, title, session_date, capacity_limit FROM learning_sessions WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user.company_id]
      );
      if (!sessionRows.length) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const [rsvpStats, attendanceStats] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE response = 'yes') AS yes_count,
            COUNT(*) FILTER (WHERE response = 'no') AS no_count,
            COUNT(*) FILTER (WHERE response = 'maybe') AS maybe_count,
            COUNT(*) AS total_rsvps
          FROM learning_session_rsvps WHERE session_id = $1
        `, [req.params.id]),
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'attended') AS attended,
            COUNT(*) FILTER (WHERE status = 'absent') AS absent,
            COUNT(*) FILTER (WHERE status = 'partial') AS partial,
            COUNT(*) AS total_marked
          FROM learning_session_attendance WHERE session_id = $1
        `, [req.params.id])
      ]);

      const rsvp = rsvpStats.rows[0];
      const attendance = attendanceStats.rows[0];
      const attendanceRate = +rsvp.yes_count > 0
        ? Math.round((+attendance.attended / +rsvp.yes_count) * 100)
        : 0;

      res.json({
        session: sessionRows[0],
        rsvp: {
          yes: +rsvp.yes_count,
          no: +rsvp.no_count,
          maybe: +rsvp.maybe_count,
          total: +rsvp.total_rsvps
        },
        attendance: {
          attended: +attendance.attended,
          absent: +attendance.absent,
          partial: +attendance.partial,
          total_marked: +attendance.total_marked,
          attendance_rate_pct: attendanceRate
        }
      });
    } catch (err) {
      console.error('Session stats error:', err);
      res.status(500).json({ error: 'Failed to retrieve session stats' });
    }
  }
);

// POST /api/learning-sessions/:id/remind - Send reminder to RSVPd users
router.post('/:id/remind',
  authenticate,
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT id, title, session_date, live_session_url, access_instructions
         FROM learning_sessions WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user.company_id]
      );
      if (!sessionRows.length) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const session = sessionRows[0];

      const { rows: rsvpUsers } = await pool.query(`
        SELECT u.email, u.first_name
        FROM learning_session_rsvps rsvp
        JOIN users u ON u.id = rsvp.user_id
        WHERE rsvp.session_id = $1 AND rsvp.response IN ('yes', 'maybe')
      `, [req.params.id]);

      const results = await Promise.allSettled(
        rsvpUsers.map(user =>
          sendEmail({
            to: user.email,
            subject: `Reminder: ${session.title}`,
            template: 'learning_session_reminder',
            data: {
              userName: user.first_name,
              sessionTitle: session.title,
              sessionDate: session.session_date,
              joinUrl: session.live_session_url,
              instructions: session.access_instructions
            }
          })
        )
      );

      const sent = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      res.json({ message: `Reminders sent`, sent, failed, total: rsvpUsers.length });
    } catch (err) {
      console.error('Send reminder error:', err);
      res.status(500).json({ error: 'Failed to send reminders' });
    }
  }
);

module.exports = router;
