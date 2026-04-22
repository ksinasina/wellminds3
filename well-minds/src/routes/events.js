const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireManager, requireAdmin, requireRole, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { sendEmail } = require('../utils/email');
const { v4: uuidv4 } = require('uuid');

// All routes require authentication
router.use(authenticate);

// GET /api/events/calendar - Calendar view data for a given month
router.get('/calendar',
  [
    query('month').optional().isInt({ min: 1, max: 12 }).toInt(),
    query('year').optional().isInt({ min: 2020, max: 2100 }).toInt(),
    validate
  ],
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const userId = req.user.id;
      const now = new Date();
      const month = req.query.month || (now.getMonth() + 1);
      const year = req.query.year || now.getFullYear();

      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const endDate = month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, '0')}-01`;

      const { rows } = await pool.query(`
        SELECT
          e.id, e.title, e.start_time, e.end_time, e.event_type, e.event_color,
          e.venue, e.is_public,
          COALESCE(ac.attendee_count, 0)::int AS attendee_count,
          ea.status AS my_rsvp
        FROM events e
        LEFT JOIN (
          SELECT event_id, COUNT(*) AS attendee_count
          FROM event_attendees
          WHERE status = 'accepted'
          GROUP BY event_id
        ) ac ON ac.event_id = e.id
        LEFT JOIN event_attendees ea ON ea.event_id = e.id AND ea.user_id = $1
        WHERE e.company_id = $2
          AND e.deleted_at IS NULL
          AND e.start_time >= $3
          AND e.start_time < $4
        ORDER BY e.start_time ASC
      `, [userId, companyId, startDate, endDate]);

      res.json({ data: rows, month, year });
    } catch (err) {
      console.error('GET /api/events/calendar error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/events/stats - Event analytics (manager+)
router.get('/stats',
  [
    requireRole('manager', 'admin'),
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
    validate
  ],
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const { start_date, end_date } = req.query;

      const conditions = ['e.company_id = $1', 'e.deleted_at IS NULL'];
      const params = [companyId];
      let paramIndex = 2;

      if (start_date) { conditions.push(`e.start_time >= $${paramIndex++}`); params.push(start_date); }
      if (end_date) { conditions.push(`e.start_time <= $${paramIndex++}`); params.push(end_date); }

      const whereClause = conditions.join(' AND ');

      // Total events
      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM events e WHERE ${whereClause}`,
        params
      );

      // By event type
      const byTypeResult = await pool.query(`
        SELECT e.event_type, COUNT(*)::int AS count
        FROM events e
        WHERE ${whereClause}
        GROUP BY e.event_type
      `, params);

      // Average attendance
      const avgAttendanceResult = await pool.query(`
        SELECT
          ROUND(AVG(ac.cnt), 1) AS avg_attendance
        FROM events e
        LEFT JOIN (
          SELECT event_id, COUNT(*) AS cnt
          FROM event_attendees WHERE status = 'accepted'
          GROUP BY event_id
        ) ac ON ac.event_id = e.id
        WHERE ${whereClause}
      `, params);

      // RSVP breakdown
      const rsvpResult = await pool.query(`
        SELECT ea.status, COUNT(*)::int AS count
        FROM event_attendees ea
        JOIN events e ON e.id = ea.event_id
        WHERE ${whereClause}
        GROUP BY ea.status
      `, params);

      // Monthly trend
      const trendResult = await pool.query(`
        SELECT
          DATE_TRUNC('month', e.start_time) AS month,
          COUNT(*)::int AS event_count
        FROM events e
        WHERE ${whereClause} AND e.start_time >= NOW() - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', e.start_time)
        ORDER BY month DESC
      `, params);

      res.json({
        data: {
          total_events: totalResult.rows[0].total,
          by_type: byTypeResult.rows,
          avg_attendance: parseFloat(avgAttendanceResult.rows[0].avg_attendance) || 0,
          rsvp_breakdown: rsvpResult.rows,
          monthly_trend: trendResult.rows
        }
      });
    } catch (err) {
      console.error('GET /api/events/stats error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/events - List events with filters
router.get('/',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('month').optional().isInt({ min: 1, max: 12 }).toInt(),
    query('year').optional().isInt({ min: 2020, max: 2100 }).toInt(),
    query('upcoming').optional().isBoolean().toBoolean(),
    query('event_type').optional().isIn(['online', 'in_person']),
    validate
  ],
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const userId = req.user.id;
      const page = req.query.page || 1;
      const limit = req.query.limit || 20;
      const offset = (page - 1) * limit;

      const conditions = ['e.company_id = $1', 'e.deleted_at IS NULL'];
      const params = [companyId];
      let paramIndex = 2;

      if (req.query.upcoming) {
        conditions.push(`e.start_time >= NOW()`);
      }

      if (req.query.event_type) {
        conditions.push(`e.event_type = $${paramIndex++}`);
        params.push(req.query.event_type);
      }

      if (req.query.month && req.query.year) {
        const m = req.query.month;
        const y = req.query.year;
        const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
        const endDate = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
        conditions.push(`e.start_time >= $${paramIndex++}`);
        params.push(startDate);
        conditions.push(`e.start_time < $${paramIndex++}`);
        params.push(endDate);
      }

      const whereClause = conditions.join(' AND ');

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM events e WHERE ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const { rows } = await pool.query(`
        SELECT
          e.id, e.title, e.description, e.venue, e.start_time, e.end_time,
          e.event_type, e.event_color, e.format, e.is_public,
          e.target_type, e.target_value,
          e.organizer_id, u.first_name AS organizer_first_name, u.last_name AS organizer_last_name,
          e.created_at,
          COALESCE(ac.attendee_count, 0)::int AS attendee_count,
          ea.status AS my_rsvp
        FROM events e
        JOIN users u ON u.id = e.organizer_id
        LEFT JOIN (
          SELECT event_id, COUNT(*) AS attendee_count
          FROM event_attendees
          WHERE status = 'accepted'
          GROUP BY event_id
        ) ac ON ac.event_id = e.id
        LEFT JOIN event_attendees ea ON ea.event_id = e.id AND ea.user_id = $${paramIndex++}
        WHERE ${whereClause}
        ORDER BY e.start_time ASC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `, [...params, userId, limit, offset]);

      res.json({
        data: rows,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }
      });
    } catch (err) {
      console.error('GET /api/events error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/events/:id - Event detail with attendee list
router.get('/:id',
  [
    param('id').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const eventId = req.params.id;
      const companyId = req.user.company_id;
      const userId = req.user.id;

      const eventResult = await pool.query(`
        SELECT
          e.*,
          u.first_name AS organizer_first_name, u.last_name AS organizer_last_name,
          u.avatar_url AS organizer_avatar_url,
          ea.status AS my_rsvp
        FROM events e
        JOIN users u ON u.id = e.organizer_id
        LEFT JOIN event_attendees ea ON ea.event_id = e.id AND ea.user_id = $1
        WHERE e.id = $2 AND e.company_id = $3 AND e.deleted_at IS NULL
      `, [userId, eventId, companyId]);

      if (eventResult.rows.length === 0) {
        return res.status(404).json({ error: 'Event not found' });
      }

      const attendeesResult = await pool.query(`
        SELECT
          ea.user_id, ea.status, ea.responded_at,
          u.first_name, u.last_name, u.avatar_url, u.job_title, u.department
        FROM event_attendees ea
        JOIN users u ON u.id = ea.user_id
        WHERE ea.event_id = $1
        ORDER BY ea.responded_at ASC
      `, [eventId]);

      res.json({
        data: {
          ...eventResult.rows[0],
          attendees: attendeesResult.rows
        }
      });
    } catch (err) {
      console.error('GET /api/events/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/events - Create event (manager+)
router.post('/',
  [
    requireRole('manager', 'admin'),
    body('title').notEmpty().withMessage('Title is required').trim(),
    body('venue').notEmpty().withMessage('Venue is required').trim(),
    body('start_time').notEmpty().isISO8601().withMessage('Valid start time is required'),
    body('end_time').notEmpty().isISO8601().withMessage('Valid end time is required'),
    body('event_type').optional().isIn(['online', 'in_person']),
    body('event_color').notEmpty().withMessage('Event color is required').trim(),
    body('description').notEmpty().withMessage('Description is required').trim(),
    body('format').optional({ nullable: true }).trim(),
    body('target_type').optional({ nullable: true }).isIn(['all', 'department', 'business_unit', 'location', 'individual']),
    body('target_value').optional({ nullable: true }).trim(),
    body('is_public').optional().isBoolean(),
    body('notify_participants').optional().isBoolean(),
    validate
  ],
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const organizerId = req.user.id;
      const {
        title, venue, start_time, end_time, event_type, event_color,
        description, format, target_type, target_value, is_public, notify_participants
      } = req.body;

      if (new Date(end_time) <= new Date(start_time)) {
        return res.status(400).json({ error: 'End time must be after start time' });
      }

      const id = uuidv4();

      const { rows } = await pool.query(`
        INSERT INTO events (
          id, company_id, organizer_id, title, venue, start_time, end_time,
          event_type, event_color, description, format, target_type, target_value,
          is_public, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
        RETURNING *
      `, [
        id, companyId, organizerId, title, venue, start_time, end_time,
        event_type || 'in_person', event_color, description, format || null,
        target_type || null, target_value || null, is_public !== false
      ]);

      // Auto-RSVP the organizer
      const rsvpId = uuidv4();
      await pool.query(`
        INSERT INTO event_attendees (id, event_id, user_id, status, responded_at)
        VALUES ($1, $2, $3, 'accepted', NOW())
      `, [rsvpId, id, organizerId]);

      // Optional email notification to target participants
      if (notify_participants && target_type) {
        try {
          let recipientConditions = ['company_id = $1', "status = 'active'"];
          const recipientParams = [companyId];
          let rIdx = 2;

          if (target_type === 'department' && target_value) {
            recipientConditions.push(`department = $${rIdx++}`);
            recipientParams.push(target_value);
          } else if (target_type === 'business_unit' && target_value) {
            recipientConditions.push(`business_unit = $${rIdx++}`);
            recipientParams.push(target_value);
          } else if (target_type === 'location' && target_value) {
            recipientConditions.push(`location = $${rIdx++}`);
            recipientParams.push(target_value);
          }

          const recipientsResult = await pool.query(
            `SELECT id, email, first_name FROM users WHERE ${recipientConditions.join(' AND ')}`,
            recipientParams
          );

          for (const recipient of recipientsResult.rows) {
            if (recipient.id === organizerId) continue;
            await sendEmail({
              to: recipient.email,
              subject: `New Event: ${title}`,
              html: `<p>Hi ${recipient.first_name},</p>
                     <p>You're invited to <strong>${title}</strong>.</p>
                     <p>When: ${new Date(start_time).toLocaleString()} - ${new Date(end_time).toLocaleString()}</p>
                     <p>Where: ${venue}</p>
                     <p>${description}</p>
                     <p>Log in to RSVP.</p>`
            });
          }
        } catch (emailErr) {
          console.error('Failed to send event notification emails:', emailErr);
        }
      }

      res.status(201).json({ data: rows[0] });
    } catch (err) {
      console.error('POST /api/events error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/events/:id - Update event (manager+)
router.patch('/:id',
  [
    requireRole('manager', 'admin'),
    param('id').isUUID(),
    body('title').optional().notEmpty().trim(),
    body('venue').optional().notEmpty().trim(),
    body('start_time').optional().isISO8601(),
    body('end_time').optional().isISO8601(),
    body('event_type').optional().isIn(['online', 'in_person']),
    body('event_color').optional().notEmpty().trim(),
    body('description').optional().notEmpty().trim(),
    body('format').optional({ nullable: true }).trim(),
    body('target_type').optional({ nullable: true }).isIn(['all', 'department', 'business_unit', 'location', 'individual']),
    body('target_value').optional({ nullable: true }).trim(),
    body('is_public').optional().isBoolean(),
    validate
  ],
  async (req, res) => {
    try {
      const eventId = req.params.id;
      const companyId = req.user.company_id;

      // Verify event exists
      const existing = await pool.query(
        'SELECT id FROM events WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [eventId, companyId]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Event not found' });
      }

      const allowedFields = [
        'title', 'venue', 'start_time', 'end_time', 'event_type', 'event_color',
        'description', 'format', 'target_type', 'target_value', 'is_public'
      ];

      const updates = [];
      const values = [];
      let paramIndex = 1;

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = $${paramIndex++}`);
          values.push(req.body[field]);
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      updates.push(`updated_at = NOW()`);
      values.push(eventId, companyId);

      const { rows } = await pool.query(`
        UPDATE events
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex++} AND company_id = $${paramIndex++} AND deleted_at IS NULL
        RETURNING *
      `, values);

      // Notify attendees of update
      try {
        const attendeesResult = await pool.query(
          `SELECT ea.user_id FROM event_attendees ea WHERE ea.event_id = $1`,
          [eventId]
        );
        for (const attendee of attendeesResult.rows) {
          if (attendee.user_id === req.user.id) continue;
          const notifId = uuidv4();
          await pool.query(`
            INSERT INTO notifications (id, user_id, type, title, message, reference_id, reference_type, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          `, [
            notifId, attendee.user_id, 'event_updated',
            'Event updated',
            `The event "${rows[0].title}" has been updated`,
            eventId, 'event'
          ]);
        }
      } catch (notifErr) {
        console.error('Failed to send event update notifications:', notifErr);
      }

      res.json({ data: rows[0] });
    } catch (err) {
      console.error('PATCH /api/events/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/events/:id/rsvp - RSVP with upsert
router.post('/:id/rsvp',
  [
    param('id').isUUID(),
    body('status').notEmpty().isIn(['accepted', 'declined', 'maybe']).withMessage('Valid RSVP status is required'),
    validate
  ],
  async (req, res) => {
    try {
      const eventId = req.params.id;
      const userId = req.user.id;
      const companyId = req.user.company_id;
      const { status } = req.body;

      // Verify event exists
      const eventResult = await pool.query(
        'SELECT id, title FROM events WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [eventId, companyId]
      );
      if (eventResult.rows.length === 0) {
        return res.status(404).json({ error: 'Event not found' });
      }

      // Upsert RSVP
      const existing = await pool.query(
        'SELECT id FROM event_attendees WHERE event_id = $1 AND user_id = $2',
        [eventId, userId]
      );

      if (existing.rows.length > 0) {
        await pool.query(
          'UPDATE event_attendees SET status = $1, responded_at = NOW() WHERE event_id = $2 AND user_id = $3',
          [status, eventId, userId]
        );
      } else {
        const id = uuidv4();
        await pool.query(
          'INSERT INTO event_attendees (id, event_id, user_id, status, responded_at) VALUES ($1, $2, $3, $4, NOW())',
          [id, eventId, userId, status]
        );
      }

      res.json({ data: { event_id: eventId, status } });
    } catch (err) {
      console.error('POST /api/events/:id/rsvp error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/events/:id - Delete event (manager+)
router.delete('/:id',
  [
    requireRole('manager', 'admin'),
    param('id').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const eventId = req.params.id;
      const companyId = req.user.company_id;

      const result = await pool.query(
        'UPDATE events SET deleted_at = NOW() WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL RETURNING id',
        [eventId, companyId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Event not found' });
      }

      res.json({ message: 'Event deleted successfully' });
    } catch (err) {
      console.error('DELETE /api/events/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
