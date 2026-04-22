const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireManager, requireAdmin, requireRole, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { sendEmail } = require('../utils/email');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// EMPLOYEE ENDPOINTS
// ============================================================

// GET /api/challenges - List active challenges for user's org
router.get('/',
  authenticate,
  [
    query('type').optional().isIn(['icc_linked', 'organisation_specific', 'hybrid']),
    query('status').optional().isIn(['draft', 'active', 'completed']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 })
  ],
  validate,
  async (req, res) => {
    try {
      const { type, status = 'active', page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;
      const companyId = req.user.company_id;
      const params = [companyId];
      let paramIdx = 2;

      let whereClause = `WHERE c.company_id = $1`;

      if (status) {
        whereClause += ` AND c.status = $${paramIdx++}`;
        params.push(status);
      }
      if (type) {
        whereClause += ` AND c.challenge_type = $${paramIdx++}`;
        params.push(type);
      }

      params.push(+limit, +offset);

      const { rows } = await pool.query(`
        SELECT c.id, c.name, c.theme, c.description, c.challenge_type, c.status,
               c.start_date, c.end_date, c.participation_mode, c.scoring_mode,
               c.audience_type, c.created_at,
               COUNT(DISTINCT cm.id) AS module_count,
               COUNT(DISTINCT cp.id) AS participant_count,
               EXISTS(
                 SELECT 1 FROM challenge_participants cp2
                 WHERE cp2.challenge_id = c.id AND cp2.user_id = $${paramIdx + 1}
               ) AS is_joined
        FROM challenges c
        LEFT JOIN challenge_modules cm ON cm.challenge_id = c.id
        LEFT JOIN challenge_participants cp ON cp.challenge_id = c.id
        ${whereClause}
        GROUP BY c.id
        ORDER BY c.start_date DESC
        LIMIT $${paramIdx++} OFFSET $${paramIdx}
      `, [...params, req.user.id]);

      const countResult = await pool.query(`
        SELECT COUNT(*) AS total FROM challenges c ${whereClause}
      `, params.slice(0, paramIdx - 3));

      res.json({
        challenges: rows,
        pagination: { page: +page, limit: +limit, total: +countResult.rows[0].total }
      });
    } catch (err) {
      console.error('List challenges error:', err);
      res.status(500).json({ error: 'Failed to list challenges' });
    }
  }
);

// GET /api/challenges/my - User's joined challenges with progress
router.get('/my',
  authenticate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT c.id, c.name, c.theme, c.challenge_type, c.status,
               c.start_date, c.end_date, c.scoring_mode,
               cp.points, cp.joined_at,
               COUNT(DISTINCT cm.id) AS total_modules,
               COUNT(DISTINCT CASE WHEN cmc.completed = true THEN cmc.module_id END) AS completed_modules,
               CASE
                 WHEN COUNT(DISTINCT cm.id) > 0
                 THEN ROUND(COUNT(DISTINCT CASE WHEN cmc.completed = true THEN cmc.module_id END)::numeric
                      / COUNT(DISTINCT cm.id) * 100, 1)
                 ELSE 0
               END AS completion_pct
        FROM challenge_participants cp
        JOIN challenges c ON c.id = cp.challenge_id
        LEFT JOIN challenge_modules cm ON cm.challenge_id = c.id
        LEFT JOIN challenge_module_completions cmc ON cmc.module_id = cm.id AND cmc.user_id = $1
        WHERE cp.user_id = $1 AND c.company_id = $2
        GROUP BY c.id, cp.points, cp.joined_at
        ORDER BY c.start_date DESC
      `, [req.user.id, req.user.company_id]);

      res.json({ challenges: rows });
    } catch (err) {
      console.error('My challenges error:', err);
      res.status(500).json({ error: 'Failed to retrieve your challenges' });
    }
  }
);

// GET /api/challenges/:id - Challenge detail
router.get('/:id',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows: challengeRows } = await pool.query(`
        SELECT c.* FROM challenges c
        WHERE c.id = $1 AND c.company_id = $2
      `, [req.params.id, req.user.company_id]);

      if (!challengeRows.length) {
        return res.status(404).json({ error: 'Challenge not found' });
      }

      const [modules, leaderboard, teams] = await Promise.all([
        pool.query(`
          SELECT id, module_type, activity_name, instructions, metric_type,
                 goal_type, goal_value, linked_theme_id, linked_milestone_id,
                 completion_method, sort_order
          FROM challenge_modules WHERE challenge_id = $1 ORDER BY sort_order
        `, [req.params.id]),
        pool.query(`
          SELECT cp.user_id, u.first_name, u.last_name, cp.points,
                 ct.name AS team_name
          FROM challenge_participants cp
          JOIN users u ON u.id = cp.user_id
          LEFT JOIN challenge_team_members ctm ON ctm.user_id = cp.user_id AND ctm.challenge_id = cp.challenge_id
          LEFT JOIN challenge_teams ct ON ct.id = ctm.team_id
          WHERE cp.challenge_id = $1
          ORDER BY cp.points DESC
          LIMIT 20
        `, [req.params.id]),
        pool.query(`
          SELECT ct.id, ct.name, COUNT(ctm.user_id) AS member_count,
                 COALESCE(SUM(cp.points), 0) AS total_points
          FROM challenge_teams ct
          LEFT JOIN challenge_team_members ctm ON ctm.team_id = ct.id
          LEFT JOIN challenge_participants cp ON cp.user_id = ctm.user_id AND cp.challenge_id = ct.challenge_id
          WHERE ct.challenge_id = $1
          GROUP BY ct.id
          ORDER BY total_points DESC
        `, [req.params.id])
      ]);

      const challenge = challengeRows[0];

      // Respect visibility settings
      let leaderboardData = [];
      if (challenge.leaderboard_visibility !== 'off') {
        leaderboardData = leaderboard.rows;
      }

      res.json({
        challenge,
        modules: modules.rows,
        leaderboard: leaderboardData,
        teams: teams.rows
      });
    } catch (err) {
      console.error('Challenge detail error:', err);
      res.status(500).json({ error: 'Failed to retrieve challenge' });
    }
  }
);

// POST /api/challenges/:id/join - Join challenge
router.post('/:id/join',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows: challengeRows } = await pool.query(`
        SELECT id, status, start_date, end_date FROM challenges
        WHERE id = $1 AND company_id = $2 AND status = 'active'
      `, [req.params.id, req.user.company_id]);

      if (!challengeRows.length) {
        return res.status(404).json({ error: 'Active challenge not found' });
      }

      // Check if already joined
      const { rows: existing } = await pool.query(
        `SELECT id FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );
      if (existing.length) {
        return res.status(409).json({ error: 'You have already joined this challenge' });
      }

      const participantId = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO challenge_participants (id, challenge_id, user_id, points, joined_at)
        VALUES ($1, $2, $3, 0, NOW())
        RETURNING *
      `, [participantId, req.params.id, req.user.id]);

      res.status(201).json({ participant: rows[0] });
    } catch (err) {
      console.error('Join challenge error:', err);
      res.status(500).json({ error: 'Failed to join challenge' });
    }
  }
);

// POST /api/challenges/:id/log - Log entry
router.post('/:id/log',
  authenticate,
  [
    param('id').isUUID(),
    body('module_id').isUUID(),
    body('value').isNumeric(),
    body('notes').optional().isString().trim(),
    body('entry_date').isISO8601()
  ],
  validate,
  async (req, res) => {
    try {
      const { module_id, value, notes, entry_date } = req.body;
      const challengeId = req.params.id;

      // Verify participation
      const { rows: participantRows } = await pool.query(
        `SELECT id FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2`,
        [challengeId, req.user.id]
      );
      if (!participantRows.length) {
        return res.status(403).json({ error: 'You have not joined this challenge' });
      }

      // Verify challenge is active and entry_date is within challenge period
      const { rows: challengeRows } = await pool.query(
        `SELECT id, start_date, end_date, status FROM challenges WHERE id = $1 AND company_id = $2`,
        [challengeId, req.user.company_id]
      );
      if (!challengeRows.length || challengeRows[0].status !== 'active') {
        return res.status(400).json({ error: 'Challenge is not active' });
      }

      const challenge = challengeRows[0];
      const entryDateObj = new Date(entry_date);
      if (entryDateObj > new Date()) {
        return res.status(400).json({ error: 'Cannot log entries for future dates' });
      }
      if (entryDateObj < new Date(challenge.start_date) || entryDateObj > new Date(challenge.end_date)) {
        return res.status(400).json({ error: 'Entry date must be within the challenge period' });
      }

      // Verify module exists and belongs to this challenge
      const { rows: moduleRows } = await pool.query(
        `SELECT id, module_type, goal_value, metric_type, completion_method
         FROM challenge_modules WHERE id = $1 AND challenge_id = $2`,
        [module_id, challengeId]
      );
      if (!moduleRows.length) {
        return res.status(404).json({ error: 'Module not found in this challenge' });
      }

      const module = moduleRows[0];

      // Check for duplicate entry on same date (for activity modules)
      if (module.module_type === 'activity') {
        const { rows: dupeRows } = await pool.query(
          `SELECT id FROM challenge_entries
           WHERE challenge_id = $1 AND module_id = $2 AND user_id = $3 AND entry_date = $4`,
          [challengeId, module_id, req.user.id, entry_date]
        );
        if (dupeRows.length) {
          return res.status(409).json({ error: 'Entry already logged for this module on this date' });
        }
      }

      // For resource modules, check completion counted only once
      if (module.module_type === 'resource') {
        const { rows: completionRows } = await pool.query(
          `SELECT id FROM challenge_module_completions
           WHERE module_id = $1 AND user_id = $2 AND completed = true`,
          [module_id, req.user.id]
        );
        if (completionRows.length) {
          return res.status(409).json({ error: 'Resource already completed' });
        }
      }

      // Validate value within limits
      if (module.goal_value && value > module.goal_value * 2) {
        return res.status(400).json({ error: 'Value exceeds allowed limit' });
      }

      const entryId = uuidv4();
      const { rows: entryRows } = await pool.query(`
        INSERT INTO challenge_entries (id, challenge_id, module_id, user_id, value, notes, entry_date, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING *
      `, [entryId, challengeId, module_id, req.user.id, value, notes, entry_date]);

      // Update points
      const pointsToAdd = Math.round(value);
      await pool.query(`
        UPDATE challenge_participants SET points = points + $1
        WHERE challenge_id = $2 AND user_id = $3
      `, [pointsToAdd, challengeId, req.user.id]);

      // Check if module is now completed
      if (module.module_type === 'activity' && module.goal_value) {
        const { rows: totalRows } = await pool.query(`
          SELECT COALESCE(SUM(value), 0) AS total
          FROM challenge_entries
          WHERE challenge_id = $1 AND module_id = $2 AND user_id = $3
        `, [challengeId, module_id, req.user.id]);

        if (+totalRows[0].total >= module.goal_value) {
          await pool.query(`
            INSERT INTO challenge_module_completions (id, module_id, user_id, completed, completed_at)
            VALUES ($1, $2, $3, true, NOW())
            ON CONFLICT (module_id, user_id) DO UPDATE SET completed = true, completed_at = NOW()
          `, [uuidv4(), module_id, req.user.id]);
        }
      } else if (module.module_type === 'resource') {
        await pool.query(`
          INSERT INTO challenge_module_completions (id, module_id, user_id, completed, completed_at)
          VALUES ($1, $2, $3, true, NOW())
          ON CONFLICT (module_id, user_id) DO NOTHING
        `, [uuidv4(), module_id, req.user.id]);
      }

      res.status(201).json({ entry: entryRows[0] });
    } catch (err) {
      console.error('Log entry error:', err);
      res.status(500).json({ error: 'Failed to log entry' });
    }
  }
);

// GET /api/challenges/:id/entries - Own entries
router.get('/:id/entries',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT ce.id, ce.module_id, cm.activity_name, ce.value, ce.notes,
               ce.entry_date, ce.created_at,
               ev.id AS evidence_id, ev.status AS evidence_status
        FROM challenge_entries ce
        JOIN challenge_modules cm ON cm.id = ce.module_id
        LEFT JOIN challenge_evidence ev ON ev.entry_id = ce.id
        WHERE ce.challenge_id = $1 AND ce.user_id = $2
        ORDER BY ce.entry_date DESC
      `, [req.params.id, req.user.id]);

      res.json({ entries: rows });
    } catch (err) {
      console.error('Get entries error:', err);
      res.status(500).json({ error: 'Failed to retrieve entries' });
    }
  }
);

// POST /api/challenges/:id/evidence - Upload evidence
router.post('/:id/evidence',
  authenticate,
  [
    param('id').isUUID(),
    body('entry_id').isUUID(),
    body('file_url').isURL(),
    body('file_name').notEmpty().isString().trim()
  ],
  validate,
  async (req, res) => {
    try {
      const { entry_id, file_url, file_name } = req.body;

      // Verify entry belongs to user and challenge
      const { rows: entryRows } = await pool.query(
        `SELECT id FROM challenge_entries WHERE id = $1 AND challenge_id = $2 AND user_id = $3`,
        [entry_id, req.params.id, req.user.id]
      );
      if (!entryRows.length) {
        return res.status(404).json({ error: 'Entry not found' });
      }

      const evidenceId = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO challenge_evidence (id, entry_id, challenge_id, user_id, file_url, file_name, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
        RETURNING *
      `, [evidenceId, entry_id, req.params.id, req.user.id, file_url, file_name]);

      res.status(201).json({ evidence: rows[0] });
    } catch (err) {
      console.error('Upload evidence error:', err);
      res.status(500).json({ error: 'Failed to upload evidence' });
    }
  }
);

// GET /api/challenges/:id/leaderboard - Full leaderboard
router.get('/:id/leaderboard',
  authenticate,
  [
    param('id').isUUID(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 })
  ],
  validate,
  async (req, res) => {
    try {
      const { page = 1, limit = 50 } = req.query;
      const offset = (page - 1) * limit;

      // Check visibility settings
      const { rows: challengeRows } = await pool.query(
        `SELECT leaderboard_visibility FROM challenges WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user.company_id]
      );
      if (!challengeRows.length) {
        return res.status(404).json({ error: 'Challenge not found' });
      }

      const visibility = challengeRows[0].leaderboard_visibility;
      if (visibility === 'off') {
        return res.status(403).json({ error: 'Leaderboard is disabled for this challenge' });
      }

      if (visibility === 'individual_opt_in') {
        // Only show users who opted in, plus the requesting user
        const { rows } = await pool.query(`
          SELECT cp.user_id, u.first_name, u.last_name, cp.points,
                 ct.name AS team_name,
                 COUNT(DISTINCT ce.id) AS total_entries,
                 ROW_NUMBER() OVER (ORDER BY cp.points DESC) AS rank
          FROM challenge_participants cp
          JOIN users u ON u.id = cp.user_id
          LEFT JOIN challenge_team_members ctm ON ctm.user_id = cp.user_id AND ctm.challenge_id = cp.challenge_id
          LEFT JOIN challenge_teams ct ON ct.id = ctm.team_id
          LEFT JOIN challenge_entries ce ON ce.challenge_id = cp.challenge_id AND ce.user_id = cp.user_id
          WHERE cp.challenge_id = $1
            AND (cp.leaderboard_opt_in = true OR cp.user_id = $2)
          GROUP BY cp.user_id, u.first_name, u.last_name, cp.points, ct.name
          ORDER BY cp.points DESC
          LIMIT $3 OFFSET $4
        `, [req.params.id, req.user.id, +limit, +offset]);

        return res.json({ leaderboard: rows });
      }

      // team or full visibility
      const { rows } = await pool.query(`
        SELECT cp.user_id, u.first_name, u.last_name, cp.points,
               ct.name AS team_name,
               COUNT(DISTINCT ce.id) AS total_entries,
               ROW_NUMBER() OVER (ORDER BY cp.points DESC) AS rank
        FROM challenge_participants cp
        JOIN users u ON u.id = cp.user_id
        LEFT JOIN challenge_team_members ctm ON ctm.user_id = cp.user_id AND ctm.challenge_id = cp.challenge_id
        LEFT JOIN challenge_teams ct ON ct.id = ctm.team_id
        LEFT JOIN challenge_entries ce ON ce.challenge_id = cp.challenge_id AND ce.user_id = cp.user_id
        WHERE cp.challenge_id = $1
        GROUP BY cp.user_id, u.first_name, u.last_name, cp.points, ct.name
        ORDER BY cp.points DESC
        LIMIT $2 OFFSET $3
      `, [req.params.id, +limit, +offset]);

      res.json({ leaderboard: rows });
    } catch (err) {
      console.error('Leaderboard error:', err);
      res.status(500).json({ error: 'Failed to retrieve leaderboard' });
    }
  }
);

// GET /api/challenges/:id/my-progress - Detailed personal progress
router.get('/:id/my-progress',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows: participantRows } = await pool.query(
        `SELECT points, joined_at FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );
      if (!participantRows.length) {
        return res.status(404).json({ error: 'You have not joined this challenge' });
      }

      const { rows: moduleProgress } = await pool.query(`
        SELECT cm.id AS module_id, cm.activity_name, cm.module_type,
               cm.goal_type, cm.goal_value,
               COALESCE(SUM(ce.value), 0) AS current_value,
               COUNT(ce.id) AS entry_count,
               COALESCE(cmc.completed, false) AS completed,
               cmc.completed_at,
               CASE
                 WHEN cm.goal_value > 0
                 THEN LEAST(ROUND(COALESCE(SUM(ce.value), 0)::numeric / cm.goal_value * 100, 1), 100)
                 ELSE 0
               END AS progress_pct
        FROM challenge_modules cm
        LEFT JOIN challenge_entries ce ON ce.module_id = cm.id AND ce.user_id = $2
        LEFT JOIN challenge_module_completions cmc ON cmc.module_id = cm.id AND cmc.user_id = $2
        WHERE cm.challenge_id = $1
        GROUP BY cm.id, cmc.completed, cmc.completed_at
        ORDER BY cm.sort_order
      `, [req.params.id, req.user.id]);

      // Daily trend
      const { rows: dailyTrend } = await pool.query(`
        SELECT entry_date, SUM(value) AS total_value, COUNT(*) AS entries
        FROM challenge_entries
        WHERE challenge_id = $1 AND user_id = $2
        GROUP BY entry_date
        ORDER BY entry_date
      `, [req.params.id, req.user.id]);

      res.json({
        points: participantRows[0].points,
        joined_at: participantRows[0].joined_at,
        modules: moduleProgress,
        daily_trend: dailyTrend
      });
    } catch (err) {
      console.error('My progress error:', err);
      res.status(500).json({ error: 'Failed to retrieve progress' });
    }
  }
);

// GET /api/challenges/:id/certificate - Get certificate if earned
router.get('/:id/certificate',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      // Check if already issued
      const { rows: existingCert } = await pool.query(
        `SELECT * FROM challenge_certificates WHERE challenge_id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );
      if (existingCert.length) {
        return res.json({ certificate: existingCert[0] });
      }

      // Check eligibility: all modules completed
      const { rows: completionCheck } = await pool.query(`
        SELECT
          COUNT(DISTINCT cm.id) AS total_modules,
          COUNT(DISTINCT CASE WHEN cmc.completed = true THEN cm.id END) AS completed_modules
        FROM challenge_modules cm
        LEFT JOIN challenge_module_completions cmc ON cmc.module_id = cm.id AND cmc.user_id = $2
        WHERE cm.challenge_id = $1
      `, [req.params.id, req.user.id]);

      const check = completionCheck[0];
      if (+check.total_modules === 0 || +check.completed_modules < +check.total_modules) {
        return res.status(400).json({
          error: 'Certificate not yet earned',
          progress: { total: +check.total_modules, completed: +check.completed_modules }
        });
      }

      // Get certificate config
      const { rows: configRows } = await pool.query(
        `SELECT certificate_text, certificate_logo_url FROM challenges WHERE id = $1`,
        [req.params.id]
      );

      const certId = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO challenge_certificates (id, challenge_id, user_id, certificate_text, logo_url, issued_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING *
      `, [certId, req.params.id, req.user.id,
          configRows[0]?.certificate_text, configRows[0]?.certificate_logo_url]);

      res.json({ certificate: rows[0] });
    } catch (err) {
      console.error('Certificate error:', err);
      res.status(500).json({ error: 'Failed to retrieve certificate' });
    }
  }
);

// GET /api/challenges/:id/badges - List earned badges
router.get('/:id/badges',
  authenticate,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT cb.id, cb.name, cb.description, cb.icon_url, cb.threshold,
               ub.earned_at
        FROM challenge_badges cb
        JOIN user_badges ub ON ub.badge_id = cb.id
        WHERE cb.challenge_id = $1 AND ub.user_id = $2
        ORDER BY ub.earned_at
      `, [req.params.id, req.user.id]);

      res.json({ badges: rows });
    } catch (err) {
      console.error('Badges error:', err);
      res.status(500).json({ error: 'Failed to retrieve badges' });
    }
  }
);

// ============================================================
// ADMIN ENDPOINTS
// ============================================================

// POST /api/challenges - Create challenge
router.post('/',
  authenticate,
  requireAdmin,
  [
    body('name').notEmpty().isString().trim().isLength({ max: 200 }),
    body('theme').optional().isString().trim(),
    body('description').optional().isString().trim(),
    body('start_date').isISO8601(),
    body('end_date').isISO8601(),
    body('audience_type').isIn(['all', 'department', 'business_unit', 'custom']),
    body('audience_value').optional(),
    body('participation_mode').isIn(['individual', 'team', 'both']),
    body('leaderboard_visibility').optional().isIn(['off', 'team', 'individual_opt_in', 'full']),
    body('challenge_type').isIn(['icc_linked', 'organisation_specific', 'hybrid']),
    body('scoring_mode').optional().isIn(['points', 'completion', 'hybrid'])
  ],
  validate,
  async (req, res) => {
    try {
      const {
        name, theme, description, start_date, end_date, audience_type,
        audience_value, participation_mode, leaderboard_visibility = 'full',
        challenge_type, scoring_mode = 'points'
      } = req.body;

      if (new Date(end_date) <= new Date(start_date)) {
        return res.status(400).json({ error: 'End date must be after start date' });
      }

      const id = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO challenges
          (id, company_id, name, theme, description, start_date, end_date,
           audience_type, audience_value, participation_mode, leaderboard_visibility,
           challenge_type, scoring_mode, status, created_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft', $14, NOW(), NOW())
        RETURNING *
      `, [id, req.user.company_id, name, theme, description, start_date, end_date,
          audience_type, JSON.stringify(audience_value), participation_mode,
          leaderboard_visibility, challenge_type, scoring_mode, req.user.id]);

      res.status(201).json({ challenge: rows[0] });
    } catch (err) {
      console.error('Create challenge error:', err);
      res.status(500).json({ error: 'Failed to create challenge' });
    }
  }
);

// PATCH /api/challenges/:id - Update challenge
router.patch('/:id',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    body('name').optional().isString().trim(),
    body('theme').optional().isString().trim(),
    body('description').optional().isString().trim(),
    body('start_date').optional().isISO8601(),
    body('end_date').optional().isISO8601(),
    body('audience_type').optional().isIn(['all', 'department', 'business_unit', 'custom']),
    body('participation_mode').optional().isIn(['individual', 'team', 'both']),
    body('leaderboard_visibility').optional().isIn(['off', 'team', 'individual_opt_in', 'full']),
    body('scoring_mode').optional().isIn(['points', 'completion', 'hybrid'])
  ],
  validate,
  async (req, res) => {
    try {
      const allowedFields = [
        'name', 'theme', 'description', 'start_date', 'end_date',
        'audience_type', 'audience_value', 'participation_mode',
        'leaderboard_visibility', 'scoring_mode'
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
        UPDATE challenges SET ${updates.join(', ')}
        WHERE id = $${paramIdx++} AND company_id = $${paramIdx}
        RETURNING *
      `, values);

      if (!rows.length) {
        return res.status(404).json({ error: 'Challenge not found' });
      }

      res.json({ challenge: rows[0] });
    } catch (err) {
      console.error('Update challenge error:', err);
      res.status(500).json({ error: 'Failed to update challenge' });
    }
  }
);

// PATCH /api/challenges/:id/status - Change status
router.patch('/:id/status',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    body('status').isIn(['draft', 'active', 'completed'])
  ],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        UPDATE challenges SET status = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3
        RETURNING *
      `, [req.body.status, req.params.id, req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Challenge not found' });
      }

      res.json({ challenge: rows[0] });
    } catch (err) {
      console.error('Update status error:', err);
      res.status(500).json({ error: 'Failed to update challenge status' });
    }
  }
);

// POST /api/challenges/:id/modules - Add module
router.post('/:id/modules',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    body('module_type').isIn(['resource', 'activity']),
    body('activity_name').optional().isString().trim(),
    body('instructions').optional().isString().trim(),
    body('metric_type').optional().isString(),
    body('goal_type').optional().isIn(['cumulative', 'daily', 'per_entry']),
    body('goal_value').optional().isNumeric(),
    body('linked_theme_id').optional().isUUID(),
    body('linked_milestone_id').optional().isUUID(),
    body('completion_method').optional().isIn(['view', 'complete', 'quiz']),
    body('sort_order').optional().isInt({ min: 0 })
  ],
  validate,
  async (req, res) => {
    try {
      // Verify challenge exists and belongs to company
      const { rows: challengeRows } = await pool.query(
        `SELECT id FROM challenges WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user.company_id]
      );
      if (!challengeRows.length) {
        return res.status(404).json({ error: 'Challenge not found' });
      }

      const {
        module_type, activity_name, instructions, metric_type,
        goal_type, goal_value, linked_theme_id, linked_milestone_id,
        completion_method, sort_order = 0
      } = req.body;

      const moduleId = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO challenge_modules
          (id, challenge_id, module_type, activity_name, instructions, metric_type,
           goal_type, goal_value, linked_theme_id, linked_milestone_id,
           completion_method, sort_order, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        RETURNING *
      `, [moduleId, req.params.id, module_type, activity_name, instructions,
          metric_type, goal_type, goal_value, linked_theme_id,
          linked_milestone_id, completion_method, sort_order]);

      res.status(201).json({ module: rows[0] });
    } catch (err) {
      console.error('Add module error:', err);
      res.status(500).json({ error: 'Failed to add module' });
    }
  }
);

// PATCH /api/challenges/:id/modules/:moduleId - Update module
router.patch('/:id/modules/:moduleId',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    param('moduleId').isUUID(),
    body('activity_name').optional().isString().trim(),
    body('instructions').optional().isString().trim(),
    body('metric_type').optional().isString(),
    body('goal_type').optional().isIn(['cumulative', 'daily', 'per_entry']),
    body('goal_value').optional().isNumeric(),
    body('completion_method').optional().isIn(['view', 'complete', 'quiz']),
    body('sort_order').optional().isInt({ min: 0 })
  ],
  validate,
  async (req, res) => {
    try {
      const allowedFields = [
        'activity_name', 'instructions', 'metric_type', 'goal_type',
        'goal_value', 'completion_method', 'sort_order'
      ];

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

      values.push(req.params.moduleId, req.params.id, req.user.company_id);

      const { rows } = await pool.query(`
        UPDATE challenge_modules SET ${updates.join(', ')}
        WHERE id = $${paramIdx++} AND challenge_id = $${paramIdx++}
          AND challenge_id IN (SELECT id FROM challenges WHERE company_id = $${paramIdx})
        RETURNING *
      `, values);

      if (!rows.length) {
        return res.status(404).json({ error: 'Module not found' });
      }

      res.json({ module: rows[0] });
    } catch (err) {
      console.error('Update module error:', err);
      res.status(500).json({ error: 'Failed to update module' });
    }
  }
);

// DELETE /api/challenges/:id/modules/:moduleId - Delete module
router.delete('/:id/modules/:moduleId',
  authenticate,
  requireAdmin,
  [param('id').isUUID(), param('moduleId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rowCount } = await pool.query(`
        DELETE FROM challenge_modules
        WHERE id = $1 AND challenge_id = $2
          AND challenge_id IN (SELECT id FROM challenges WHERE company_id = $3)
      `, [req.params.moduleId, req.params.id, req.user.company_id]);

      if (!rowCount) {
        return res.status(404).json({ error: 'Module not found' });
      }

      res.json({ message: 'Module deleted' });
    } catch (err) {
      console.error('Delete module error:', err);
      res.status(500).json({ error: 'Failed to delete module' });
    }
  }
);

// PATCH /api/challenges/:id/evidence-settings - Evidence settings
router.patch('/:id/evidence-settings',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    body('evidence_required').isBoolean(),
    body('evidence_type').optional().isIn(['photo', 'file', 'link', 'any']),
    body('approval_mode').optional().isIn(['auto', 'manual'])
  ],
  validate,
  async (req, res) => {
    try {
      const { evidence_required, evidence_type, approval_mode } = req.body;

      const { rows } = await pool.query(`
        UPDATE challenges
        SET evidence_required = $1, evidence_type = $2, evidence_approval_mode = $3, updated_at = NOW()
        WHERE id = $4 AND company_id = $5
        RETURNING *
      `, [evidence_required, evidence_type, approval_mode, req.params.id, req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Challenge not found' });
      }

      res.json({ challenge: rows[0] });
    } catch (err) {
      console.error('Evidence settings error:', err);
      res.status(500).json({ error: 'Failed to update evidence settings' });
    }
  }
);

// POST /api/challenges/:id/badges - Create badge
router.post('/:id/badges',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    body('name').notEmpty().isString().trim(),
    body('description').optional().isString().trim(),
    body('icon_url').optional().isURL(),
    body('threshold').isNumeric()
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: challengeRows } = await pool.query(
        `SELECT id FROM challenges WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user.company_id]
      );
      if (!challengeRows.length) {
        return res.status(404).json({ error: 'Challenge not found' });
      }

      const badgeId = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO challenge_badges (id, challenge_id, name, description, icon_url, threshold, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *
      `, [badgeId, req.params.id, req.body.name, req.body.description,
          req.body.icon_url, req.body.threshold]);

      res.status(201).json({ badge: rows[0] });
    } catch (err) {
      console.error('Create badge error:', err);
      res.status(500).json({ error: 'Failed to create badge' });
    }
  }
);

// PATCH /api/challenges/:id/certificate - Configure certificate
router.patch('/:id/certificate',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    body('certificate_text').optional().isString().trim(),
    body('certificate_logo_url').optional().isURL()
  ],
  validate,
  async (req, res) => {
    try {
      const { certificate_text, certificate_logo_url } = req.body;

      const { rows } = await pool.query(`
        UPDATE challenges
        SET certificate_text = COALESCE($1, certificate_text),
            certificate_logo_url = COALESCE($2, certificate_logo_url),
            updated_at = NOW()
        WHERE id = $3 AND company_id = $4
        RETURNING *
      `, [certificate_text, certificate_logo_url, req.params.id, req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Challenge not found' });
      }

      res.json({ challenge: rows[0] });
    } catch (err) {
      console.error('Certificate config error:', err);
      res.status(500).json({ error: 'Failed to configure certificate' });
    }
  }
);

// POST /api/challenges/:id/teams - Create team
router.post('/:id/teams',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    body('name').notEmpty().isString().trim()
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: challengeRows } = await pool.query(
        `SELECT id FROM challenges WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user.company_id]
      );
      if (!challengeRows.length) {
        return res.status(404).json({ error: 'Challenge not found' });
      }

      const teamId = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO challenge_teams (id, challenge_id, name, created_at)
        VALUES ($1, $2, $3, NOW())
        RETURNING *
      `, [teamId, req.params.id, req.body.name]);

      res.status(201).json({ team: rows[0] });
    } catch (err) {
      console.error('Create team error:', err);
      res.status(500).json({ error: 'Failed to create team' });
    }
  }
);

// POST /api/challenges/:id/teams/:teamId/members - Assign members
router.post('/:id/teams/:teamId/members',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    param('teamId').isUUID(),
    body('user_ids').isArray({ min: 1 }),
    body('user_ids.*').isUUID()
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: teamRows } = await pool.query(
        `SELECT id FROM challenge_teams WHERE id = $1 AND challenge_id = $2`,
        [req.params.teamId, req.params.id]
      );
      if (!teamRows.length) {
        return res.status(404).json({ error: 'Team not found' });
      }

      const insertValues = [];
      const insertParams = [];
      let paramIdx = 1;

      for (const userId of req.body.user_ids) {
        const memberId = uuidv4();
        insertValues.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NOW())`);
        insertParams.push(memberId, req.params.teamId, req.params.id, userId);
      }

      await pool.query(`
        INSERT INTO challenge_team_members (id, team_id, challenge_id, user_id, assigned_at)
        VALUES ${insertValues.join(', ')}
        ON CONFLICT (team_id, user_id) DO NOTHING
      `, insertParams);

      res.status(201).json({ message: `${req.body.user_ids.length} member(s) assigned to team` });
    } catch (err) {
      console.error('Assign members error:', err);
      res.status(500).json({ error: 'Failed to assign members' });
    }
  }
);

// POST /api/challenges/:id/nudges - Create nudge
router.post('/:id/nudges',
  authenticate,
  requireAdmin,
  [
    param('id').isUUID(),
    body('nudge_type').isIn(['reminder', 'encouragement', 'milestone', 'custom']),
    body('message').notEmpty().isString().trim(),
    body('schedule').isObject()
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: challengeRows } = await pool.query(
        `SELECT id FROM challenges WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user.company_id]
      );
      if (!challengeRows.length) {
        return res.status(404).json({ error: 'Challenge not found' });
      }

      const nudgeId = uuidv4();
      const { rows } = await pool.query(`
        INSERT INTO challenge_nudges (id, challenge_id, nudge_type, message, schedule, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING *
      `, [nudgeId, req.params.id, req.body.nudge_type, req.body.message, JSON.stringify(req.body.schedule)]);

      res.status(201).json({ nudge: rows[0] });
    } catch (err) {
      console.error('Create nudge error:', err);
      res.status(500).json({ error: 'Failed to create nudge' });
    }
  }
);

// GET /api/challenges/:id/evidence/pending - List pending evidence
router.get('/:id/evidence/pending',
  authenticate,
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT ev.id, ev.entry_id, ev.file_url, ev.file_name, ev.status, ev.created_at,
               u.first_name, u.last_name,
               ce.module_id, cm.activity_name, ce.value, ce.entry_date
        FROM challenge_evidence ev
        JOIN challenge_entries ce ON ce.id = ev.entry_id
        JOIN challenge_modules cm ON cm.id = ce.module_id
        JOIN users u ON u.id = ev.user_id
        WHERE ev.challenge_id = $1 AND ev.status = 'pending'
          AND ev.challenge_id IN (SELECT id FROM challenges WHERE company_id = $2)
        ORDER BY ev.created_at ASC
      `, [req.params.id, req.user.company_id]);

      res.json({ evidence: rows });
    } catch (err) {
      console.error('Pending evidence error:', err);
      res.status(500).json({ error: 'Failed to list pending evidence' });
    }
  }
);

// POST /api/challenges/evidence/:evidenceId/approve - Approve evidence
router.post('/evidence/:evidenceId/approve',
  authenticate,
  requireAdmin,
  [param('evidenceId').isUUID()],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        UPDATE challenge_evidence
        SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
        WHERE id = $2 AND status = 'pending'
          AND challenge_id IN (SELECT id FROM challenges WHERE company_id = $3)
        RETURNING *
      `, [req.user.id, req.params.evidenceId, req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Evidence not found or already reviewed' });
      }

      res.json({ evidence: rows[0] });
    } catch (err) {
      console.error('Approve evidence error:', err);
      res.status(500).json({ error: 'Failed to approve evidence' });
    }
  }
);

// POST /api/challenges/evidence/:evidenceId/reject - Reject evidence
router.post('/evidence/:evidenceId/reject',
  authenticate,
  requireAdmin,
  [
    param('evidenceId').isUUID(),
    body('reason').notEmpty().isString().trim()
  ],
  validate,
  async (req, res) => {
    try {
      const { rows } = await pool.query(`
        UPDATE challenge_evidence
        SET status = 'rejected', rejection_reason = $1, reviewed_by = $2, reviewed_at = NOW()
        WHERE id = $3 AND status = 'pending'
          AND challenge_id IN (SELECT id FROM challenges WHERE company_id = $4)
        RETURNING *
      `, [req.body.reason, req.user.id, req.params.evidenceId, req.user.company_id]);

      if (!rows.length) {
        return res.status(404).json({ error: 'Evidence not found or already reviewed' });
      }

      res.json({ evidence: rows[0] });
    } catch (err) {
      console.error('Reject evidence error:', err);
      res.status(500).json({ error: 'Failed to reject evidence' });
    }
  }
);

// GET /api/challenges/:id/stats - Full stats (admin)
router.get('/:id/stats',
  authenticate,
  requireAdmin,
  [param('id').isUUID()],
  validate,
  async (req, res) => {
    try {
      const challengeId = req.params.id;
      const companyId = req.user.company_id;

      // Verify challenge
      const { rows: challengeRows } = await pool.query(
        `SELECT id, name, start_date, end_date FROM challenges WHERE id = $1 AND company_id = $2`,
        [challengeId, companyId]
      );
      if (!challengeRows.length) {
        return res.status(404).json({ error: 'Challenge not found' });
      }

      const [participation, moduleProgress, dailyTrend, teamRankings] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(DISTINCT cp.user_id) AS total_participants,
            COUNT(DISTINCT CASE WHEN ce.id IS NOT NULL THEN cp.user_id END) AS active_participants,
            COUNT(DISTINCT ce.id) AS total_entries,
            COALESCE(AVG(cp.points), 0) AS avg_points
          FROM challenge_participants cp
          LEFT JOIN challenge_entries ce ON ce.challenge_id = cp.challenge_id AND ce.user_id = cp.user_id
          WHERE cp.challenge_id = $1
        `, [challengeId]),

        pool.query(`
          SELECT cm.id, cm.activity_name, cm.module_type,
                 COUNT(DISTINCT ce.user_id) AS users_with_entries,
                 COUNT(DISTINCT CASE WHEN cmc.completed = true THEN cmc.user_id END) AS users_completed,
                 COALESCE(SUM(ce.value), 0) AS total_value
          FROM challenge_modules cm
          LEFT JOIN challenge_entries ce ON ce.module_id = cm.id
          LEFT JOIN challenge_module_completions cmc ON cmc.module_id = cm.id
          WHERE cm.challenge_id = $1
          GROUP BY cm.id
          ORDER BY cm.sort_order
        `, [challengeId]),

        pool.query(`
          SELECT ce.entry_date, COUNT(*) AS entries, COUNT(DISTINCT ce.user_id) AS active_users,
                 SUM(ce.value) AS total_value
          FROM challenge_entries ce
          WHERE ce.challenge_id = $1
          GROUP BY ce.entry_date
          ORDER BY ce.entry_date
        `, [challengeId]),

        pool.query(`
          SELECT ct.id, ct.name,
                 COUNT(DISTINCT ctm.user_id) AS member_count,
                 COALESCE(SUM(cp.points), 0) AS total_points,
                 COALESCE(AVG(cp.points), 0) AS avg_points
          FROM challenge_teams ct
          LEFT JOIN challenge_team_members ctm ON ctm.team_id = ct.id
          LEFT JOIN challenge_participants cp ON cp.user_id = ctm.user_id AND cp.challenge_id = ct.challenge_id
          WHERE ct.challenge_id = $1
          GROUP BY ct.id
          ORDER BY total_points DESC
        `, [challengeId])
      ]);

      // Completion rates
      const { rows: completionRows } = await pool.query(`
        SELECT
          COUNT(DISTINCT cp.user_id) AS total_participants,
          COUNT(DISTINCT CASE
            WHEN completed_all.user_id IS NOT NULL THEN cp.user_id
          END) AS fully_completed
        FROM challenge_participants cp
        LEFT JOIN (
          SELECT cmc.user_id
          FROM challenge_module_completions cmc
          JOIN challenge_modules cm ON cm.id = cmc.module_id
          WHERE cm.challenge_id = $1 AND cmc.completed = true
          GROUP BY cmc.user_id
          HAVING COUNT(DISTINCT cmc.module_id) = (
            SELECT COUNT(*) FROM challenge_modules WHERE challenge_id = $1
          )
        ) completed_all ON completed_all.user_id = cp.user_id
        WHERE cp.challenge_id = $1
      `, [challengeId]);

      const stats = participation.rows[0];
      const completionRate = +completionRows[0].total_participants > 0
        ? Math.round((+completionRows[0].fully_completed / +completionRows[0].total_participants) * 100)
        : 0;

      res.json({
        challenge: challengeRows[0],
        participation: {
          total_participants: +stats.total_participants,
          active_participants: +stats.active_participants,
          total_entries: +stats.total_entries,
          avg_points: Math.round(+stats.avg_points),
          completion_rate_pct: completionRate
        },
        module_progress: moduleProgress.rows,
        daily_trend: dailyTrend.rows,
        team_rankings: teamRankings.rows
      });
    } catch (err) {
      console.error('Challenge stats error:', err);
      res.status(500).json({ error: 'Failed to retrieve challenge stats' });
    }
  }
);

module.exports = router;
