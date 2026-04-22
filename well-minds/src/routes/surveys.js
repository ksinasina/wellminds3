const router = require('express').Router();
const pool = require('../db');
const { authenticate, requireManager, requireAdmin, requireRole, validate } = require('../middleware');
const { body, param, query } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

// All routes require authentication
router.use(authenticate);

// GET /api/surveys - List surveys
router.get('/',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('status').optional().isIn(['draft', 'active', 'closed']),
    query('category').optional().isIn(['engagement', 'wellbeing', 'culture', 'leadership']),
    validate
  ],
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const userId = req.user.id;
      const userRole = req.user.role;
      const page = req.query.page || 1;
      const limit = req.query.limit || 20;
      const offset = (page - 1) * limit;

      const conditions = ['s.company_id = $1', 's.deleted_at IS NULL'];
      const params = [companyId];
      let paramIndex = 2;

      if (req.query.status) {
        conditions.push(`s.status = $${paramIndex++}`);
        params.push(req.query.status);
      }

      if (req.query.category) {
        conditions.push(`s.category = $${paramIndex++}`);
        params.push(req.query.category);
      }

      // Staff only see active surveys assigned to them
      if (userRole !== 'admin' && userRole !== 'manager') {
        conditions.push(`s.status = 'active'`);
        conditions.push(`(
          EXISTS (
            SELECT 1 FROM survey_assignments sa
            WHERE sa.survey_id = s.id AND (
              sa.target_type = 'all'
              OR (sa.target_type = 'individual' AND sa.target_value = $${paramIndex++})
              OR (sa.target_type = 'department' AND sa.target_value = (SELECT department FROM users WHERE id = $${paramIndex++}))
              OR (sa.target_type = 'business_unit' AND sa.target_value = (SELECT business_unit FROM users WHERE id = $${paramIndex++}))
            )
          )
        )`);
        params.push(userId, userId, userId);
      }

      const whereClause = conditions.join(' AND ');

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM surveys s WHERE ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const { rows } = await pool.query(`
        SELECT
          s.id, s.name, s.description, s.category, s.status, s.anonymous,
          s.start_date, s.end_date, s.created_at,
          COALESCE(qc.question_count, 0)::int AS question_count,
          COALESCE(rc.response_count, 0)::int AS response_count,
          CASE WHEN sr.id IS NOT NULL THEN true ELSE false END AS has_responded
        FROM surveys s
        LEFT JOIN (
          SELECT survey_id, COUNT(*) AS question_count
          FROM survey_questions
          GROUP BY survey_id
        ) qc ON qc.survey_id = s.id
        LEFT JOIN (
          SELECT survey_id, COUNT(DISTINCT respondent_id) AS response_count
          FROM survey_responses
          GROUP BY survey_id
        ) rc ON rc.survey_id = s.id
        LEFT JOIN survey_responses sr ON sr.survey_id = s.id AND sr.respondent_id = $${paramIndex++}
        WHERE ${whereClause}
        ORDER BY s.created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `, [...params, userId, limit, offset]);

      res.json({
        data: rows,
        pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }
      });
    } catch (err) {
      console.error('GET /api/surveys error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/surveys/:id - Survey with sections and questions
router.get('/:id',
  [
    param('id').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const surveyId = req.params.id;
      const companyId = req.user.company_id;

      const surveyResult = await pool.query(
        'SELECT * FROM surveys WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [surveyId, companyId]
      );
      if (surveyResult.rows.length === 0) {
        return res.status(404).json({ error: 'Survey not found' });
      }

      const sectionsResult = await pool.query(`
        SELECT id, title, description, sort_order
        FROM survey_sections
        WHERE survey_id = $1
        ORDER BY sort_order ASC
      `, [surveyId]);

      const questionsResult = await pool.query(`
        SELECT
          q.id, q.section_id, q.text, q.question_type, q.is_mandatory,
          q.options, q.sort_order
        FROM survey_questions q
        WHERE q.survey_id = $1
        ORDER BY q.sort_order ASC
      `, [surveyId]);

      // Group questions by section
      const sections = sectionsResult.rows.map(section => ({
        ...section,
        questions: questionsResult.rows.filter(q => q.section_id === section.id)
      }));

      // Questions without sections
      const unsectioned = questionsResult.rows.filter(q => !q.section_id);

      res.json({
        data: {
          ...surveyResult.rows[0],
          sections,
          unsectioned_questions: unsectioned
        }
      });
    } catch (err) {
      console.error('GET /api/surveys/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/surveys - Create survey (admin)
router.post('/',
  [
    requireAdmin,
    body('name').notEmpty().withMessage('Survey name is required').trim(),
    body('description').optional({ nullable: true }).trim(),
    body('anonymous').optional().isBoolean(),
    body('category').notEmpty().isIn(['engagement', 'wellbeing', 'culture', 'leadership']),
    body('start_date').optional({ nullable: true }).isISO8601(),
    body('end_date').optional({ nullable: true }).isISO8601(),
    body('target_type').optional({ nullable: true }).isIn(['all', 'department', 'business_unit', 'individual']),
    body('target_value').optional({ nullable: true }).trim(),
    body('sections').optional().isArray(),
    body('sections.*.title').optional().notEmpty().trim(),
    body('sections.*.description').optional({ nullable: true }).trim(),
    body('sections.*.questions').optional().isArray(),
    body('sections.*.questions.*.text').optional().notEmpty().trim(),
    body('sections.*.questions.*.question_type').optional().isIn(['likert', 'multiple_choice', 'open_text']),
    body('sections.*.questions.*.is_mandatory').optional().isBoolean(),
    body('sections.*.questions.*.options').optional({ nullable: true }),
    body('questions').optional().isArray(),
    body('questions.*.text').optional().notEmpty().trim(),
    body('questions.*.question_type').optional().isIn(['likert', 'multiple_choice', 'open_text']),
    body('questions.*.is_mandatory').optional().isBoolean(),
    body('questions.*.options').optional({ nullable: true }),
    validate
  ],
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const companyId = req.user.company_id;
      const surveyId = uuidv4();
      const {
        name, description, anonymous, category,
        start_date, end_date, target_type, target_value,
        sections, questions
      } = req.body;

      await client.query(`
        INSERT INTO surveys (
          id, company_id, name, description, anonymous, category,
          start_date, end_date, status, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, NOW(), NOW())
      `, [
        surveyId, companyId, name, description || null,
        anonymous !== false, category,
        start_date || null, end_date || null, req.user.id
      ]);

      let questionSortOrder = 0;

      // Create sections with their questions
      if (sections && sections.length > 0) {
        for (let sIdx = 0; sIdx < sections.length; sIdx++) {
          const section = sections[sIdx];
          const sectionId = uuidv4();

          await client.query(`
            INSERT INTO survey_sections (id, survey_id, title, description, sort_order)
            VALUES ($1, $2, $3, $4, $5)
          `, [sectionId, surveyId, section.title, section.description || null, sIdx + 1]);

          if (section.questions && section.questions.length > 0) {
            for (const q of section.questions) {
              questionSortOrder++;
              const qId = uuidv4();
              await client.query(`
                INSERT INTO survey_questions (
                  id, survey_id, section_id, text, question_type, is_mandatory, options, sort_order
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              `, [
                qId, surveyId, sectionId, q.text, q.question_type || 'likert',
                q.is_mandatory !== false, q.options ? JSON.stringify(q.options) : null,
                questionSortOrder
              ]);
            }
          }
        }
      }

      // Create standalone questions (not in sections)
      if (questions && questions.length > 0) {
        for (const q of questions) {
          questionSortOrder++;
          const qId = uuidv4();
          await client.query(`
            INSERT INTO survey_questions (
              id, survey_id, section_id, text, question_type, is_mandatory, options, sort_order
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [
            qId, surveyId, null, q.text, q.question_type || 'likert',
            q.is_mandatory !== false, q.options ? JSON.stringify(q.options) : null,
            questionSortOrder
          ]);
        }
      }

      // Auto-assign if target specified
      if (target_type) {
        const assignmentId = uuidv4();
        await client.query(`
          INSERT INTO survey_assignments (id, survey_id, target_type, target_value, created_at)
          VALUES ($1, $2, $3, $4, NOW())
        `, [assignmentId, surveyId, target_type, target_value || null]);
      }

      await client.query('COMMIT');

      // Fetch complete survey
      const surveyResult = await pool.query('SELECT * FROM surveys WHERE id = $1', [surveyId]);

      res.status(201).json({ data: surveyResult.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /api/surveys error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// PATCH /api/surveys/:id - Update survey (admin)
router.patch('/:id',
  [
    requireAdmin,
    param('id').isUUID(),
    body('name').optional().notEmpty().trim(),
    body('description').optional({ nullable: true }).trim(),
    body('anonymous').optional().isBoolean(),
    body('category').optional().isIn(['engagement', 'wellbeing', 'culture', 'leadership']),
    body('start_date').optional({ nullable: true }).isISO8601(),
    body('end_date').optional({ nullable: true }).isISO8601(),
    validate
  ],
  async (req, res) => {
    try {
      const surveyId = req.params.id;
      const companyId = req.user.company_id;

      const existing = await pool.query(
        'SELECT id, status FROM surveys WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [surveyId, companyId]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Survey not found' });
      }

      if (existing.rows[0].status !== 'draft') {
        return res.status(400).json({ error: 'Can only update draft surveys' });
      }

      const allowedFields = ['name', 'description', 'anonymous', 'category', 'start_date', 'end_date'];
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

      updates.push('updated_at = NOW()');
      values.push(surveyId, companyId);

      const { rows } = await pool.query(`
        UPDATE surveys SET ${updates.join(', ')}
        WHERE id = $${paramIndex++} AND company_id = $${paramIndex++} AND deleted_at IS NULL
        RETURNING *
      `, values);

      res.json({ data: rows[0] });
    } catch (err) {
      console.error('PATCH /api/surveys/:id error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// PATCH /api/surveys/:id/publish - Set status to active (admin)
router.patch('/:id/publish',
  [
    requireAdmin,
    param('id').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const surveyId = req.params.id;
      const companyId = req.user.company_id;

      const existing = await pool.query(
        'SELECT id, status FROM surveys WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [surveyId, companyId]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Survey not found' });
      }

      if (existing.rows[0].status !== 'draft') {
        return res.status(400).json({ error: 'Survey is already published or closed' });
      }

      // Verify at least one question exists
      const questionCount = await pool.query(
        'SELECT COUNT(*) FROM survey_questions WHERE survey_id = $1',
        [surveyId]
      );
      if (parseInt(questionCount.rows[0].count, 10) === 0) {
        return res.status(400).json({ error: 'Survey must have at least one question before publishing' });
      }

      const { rows } = await pool.query(`
        UPDATE surveys SET status = 'active', start_date = COALESCE(start_date, NOW()), updated_at = NOW()
        WHERE id = $1 AND company_id = $2
        RETURNING *
      `, [surveyId, companyId]);

      res.json({ data: rows[0] });
    } catch (err) {
      console.error('PATCH /api/surveys/:id/publish error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/surveys/:id/respond - Submit response
router.post('/:id/respond',
  [
    param('id').isUUID(),
    body('answers').isArray({ min: 1 }).withMessage('Answers are required'),
    body('answers.*.question_id').notEmpty().isUUID(),
    body('answers.*.value').exists().withMessage('Answer value is required'),
    validate
  ],
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const surveyId = req.params.id;
      const userId = req.user.id;
      const companyId = req.user.company_id;
      const { answers } = req.body;

      // Verify survey exists, is active
      const surveyResult = await client.query(
        'SELECT * FROM surveys WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [surveyId, companyId]
      );
      if (surveyResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Survey not found' });
      }

      const survey = surveyResult.rows[0];
      if (survey.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Survey is not active' });
      }

      // Check end date
      if (survey.end_date && new Date(survey.end_date) < new Date()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Survey has ended' });
      }

      // Check duplicate submission
      const existingResponse = await client.query(
        'SELECT id FROM survey_responses WHERE survey_id = $1 AND respondent_id = $2',
        [surveyId, userId]
      );
      if (existingResponse.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You have already responded to this survey' });
      }

      // Check assignment
      const assignmentCheck = await client.query(`
        SELECT id FROM survey_assignments
        WHERE survey_id = $1 AND (
          target_type = 'all'
          OR (target_type = 'individual' AND target_value = $2)
          OR (target_type = 'department' AND target_value = (SELECT department FROM users WHERE id = $2))
          OR (target_type = 'business_unit' AND target_value = (SELECT business_unit FROM users WHERE id = $2))
        )
      `, [surveyId, userId]);

      if (assignmentCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'You are not assigned to this survey' });
      }

      // Get all mandatory questions
      const mandatoryQuestions = await client.query(
        'SELECT id FROM survey_questions WHERE survey_id = $1 AND is_mandatory = true',
        [surveyId]
      );

      const answeredQuestionIds = answers.map(a => a.question_id);
      const missingMandatory = mandatoryQuestions.rows.filter(
        q => !answeredQuestionIds.includes(q.id)
      );

      if (missingMandatory.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Missing mandatory questions',
          missing_question_ids: missingMandatory.map(q => q.id)
        });
      }

      // Determine respondent_id (anonymous or not)
      const respondentId = survey.anonymous ? null : userId;
      const responseId = uuidv4();

      await client.query(`
        INSERT INTO survey_responses (id, survey_id, respondent_id, submitted_at)
        VALUES ($1, $2, $3, NOW())
      `, [responseId, surveyId, userId]); // Always store userId for duplicate check; anonymity enforced at read time

      // Insert individual answers
      for (const answer of answers) {
        const answerId = uuidv4();
        await client.query(`
          INSERT INTO survey_answers (id, response_id, question_id, value, created_at)
          VALUES ($1, $2, $3, $4, NOW())
        `, [answerId, responseId, answer.question_id, JSON.stringify(answer.value)]);
      }

      await client.query('COMMIT');

      res.status(201).json({ message: 'Response submitted successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /api/surveys/:id/respond error:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// GET /api/surveys/:id/results - Aggregated results (manager+)
router.get('/:id/results',
  [
    requireRole('manager', 'admin'),
    param('id').isUUID(),
    query('format').optional().isIn(['json', 'csv']),
    validate
  ],
  async (req, res) => {
    try {
      const surveyId = req.params.id;
      const companyId = req.user.company_id;
      const exportFormat = req.query.format;

      // Verify survey
      const surveyResult = await pool.query(
        'SELECT * FROM surveys WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [surveyId, companyId]
      );
      if (surveyResult.rows.length === 0) {
        return res.status(404).json({ error: 'Survey not found' });
      }

      const survey = surveyResult.rows[0];

      // Total assigned count
      const assignedResult = await pool.query(`
        SELECT COUNT(DISTINCT u.id)::int AS count
        FROM users u
        JOIN survey_assignments sa ON sa.survey_id = $1 AND (
          sa.target_type = 'all'
          OR (sa.target_type = 'individual' AND sa.target_value = u.id::text)
          OR (sa.target_type = 'department' AND sa.target_value = u.department)
          OR (sa.target_type = 'business_unit' AND sa.target_value = u.business_unit)
        )
        WHERE u.company_id = $2 AND u.status = 'active'
      `, [surveyId, companyId]);
      const totalAssigned = assignedResult.rows[0].count;

      // Response count
      const responseCountResult = await pool.query(
        'SELECT COUNT(DISTINCT respondent_id)::int AS count FROM survey_responses WHERE survey_id = $1',
        [surveyId]
      );
      const totalResponses = responseCountResult.rows[0].count;

      // Questions with aggregated answers
      const questionsResult = await pool.query(`
        SELECT q.id, q.text, q.question_type, q.section_id, q.options,
          ss.title AS section_title
        FROM survey_questions q
        LEFT JOIN survey_sections ss ON ss.id = q.section_id
        WHERE q.survey_id = $1
        ORDER BY q.sort_order ASC
      `, [surveyId]);

      const questionResults = [];
      for (const question of questionsResult.rows) {
        const answersResult = await pool.query(`
          SELECT a.value
          FROM survey_answers a
          JOIN survey_responses r ON r.id = a.response_id
          WHERE a.question_id = $1 AND r.survey_id = $2
        `, [question.id, surveyId]);

        const answers = answersResult.rows.map(r => {
          try { return JSON.parse(r.value); } catch { return r.value; }
        });

        let aggregation = {};

        if (question.question_type === 'likert') {
          const numericAnswers = answers.filter(a => typeof a === 'number' || !isNaN(Number(a))).map(Number);
          const sum = numericAnswers.reduce((acc, val) => acc + val, 0);
          aggregation = {
            avg_score: numericAnswers.length > 0 ? Math.round((sum / numericAnswers.length) * 100) / 100 : null,
            response_count: numericAnswers.length,
            distribution: {}
          };
          for (let i = 1; i <= 5; i++) {
            aggregation.distribution[i] = numericAnswers.filter(a => a === i).length;
          }
        } else if (question.question_type === 'multiple_choice') {
          const distribution = {};
          for (const answer of answers) {
            const key = String(answer);
            distribution[key] = (distribution[key] || 0) + 1;
          }
          aggregation = { response_count: answers.length, distribution };
        } else {
          // open_text - NO individual responses to protect anonymity, just count
          aggregation = { response_count: answers.length };
        }

        questionResults.push({
          question_id: question.id,
          text: question.text,
          question_type: question.question_type,
          section_title: question.section_title,
          ...aggregation
        });
      }

      // Section-level insights
      const sectionInsights = [];
      const sectionsResult = await pool.query(
        'SELECT id, title FROM survey_sections WHERE survey_id = $1 ORDER BY sort_order',
        [surveyId]
      );
      for (const section of sectionsResult.rows) {
        const sectionQuestions = questionResults.filter(q => q.section_title === section.title);
        const likertQuestions = sectionQuestions.filter(q => q.question_type === 'likert' && q.avg_score !== null);
        const avgScore = likertQuestions.length > 0
          ? Math.round((likertQuestions.reduce((sum, q) => sum + q.avg_score, 0) / likertQuestions.length) * 100) / 100
          : null;
        sectionInsights.push({
          section_id: section.id,
          title: section.title,
          avg_score: avgScore,
          question_count: sectionQuestions.length
        });
      }

      const resultData = {
        survey: {
          id: survey.id,
          name: survey.name,
          category: survey.category,
          anonymous: survey.anonymous,
          status: survey.status
        },
        participation: {
          total_assigned: totalAssigned,
          total_responses: totalResponses,
          participation_rate: totalAssigned > 0 ? Math.round((totalResponses / totalAssigned) * 100 * 10) / 10 : 0
        },
        questions: questionResults,
        section_insights: sectionInsights
      };

      // CSV export
      if (exportFormat === 'csv') {
        const csvRows = ['Question,Type,Section,Avg Score,Response Count'];
        for (const q of questionResults) {
          csvRows.push(
            `"${q.text.replace(/"/g, '""')}","${q.question_type}","${q.section_title || ''}",${q.avg_score || ''},${q.response_count}`
          );
        }
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="survey-${surveyId}-results.csv"`);
        return res.send(csvRows.join('\n'));
      }

      res.json({ data: resultData });
    } catch (err) {
      console.error('GET /api/surveys/:id/results error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// POST /api/surveys/:id/assign - Assign survey to targets (admin)
router.post('/:id/assign',
  [
    requireAdmin,
    param('id').isUUID(),
    body('assignments').isArray({ min: 1 }).withMessage('Assignments are required'),
    body('assignments.*.target_type').notEmpty().isIn(['all', 'department', 'business_unit', 'individual']),
    body('assignments.*.target_value').optional({ nullable: true }).trim(),
    validate
  ],
  async (req, res) => {
    try {
      const surveyId = req.params.id;
      const companyId = req.user.company_id;
      const { assignments } = req.body;

      const existing = await pool.query(
        'SELECT id FROM surveys WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [surveyId, companyId]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Survey not found' });
      }

      const created = [];
      for (const assignment of assignments) {
        const id = uuidv4();
        const { rows } = await pool.query(`
          INSERT INTO survey_assignments (id, survey_id, target_type, target_value, created_at)
          VALUES ($1, $2, $3, $4, NOW())
          RETURNING *
        `, [id, surveyId, assignment.target_type, assignment.target_value || null]);
        created.push(rows[0]);
      }

      res.status(201).json({ data: created });
    } catch (err) {
      console.error('POST /api/surveys/:id/assign error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/surveys/:id/participation - Participation tracking (admin)
router.get('/:id/participation',
  [
    requireAdmin,
    param('id').isUUID(),
    validate
  ],
  async (req, res) => {
    try {
      const surveyId = req.params.id;
      const companyId = req.user.company_id;

      const surveyResult = await pool.query(
        'SELECT id, name, anonymous FROM surveys WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL',
        [surveyId, companyId]
      );
      if (surveyResult.rows.length === 0) {
        return res.status(404).json({ error: 'Survey not found' });
      }

      // Get all assigned users
      const assignedResult = await pool.query(`
        SELECT DISTINCT u.id, u.first_name, u.last_name, u.department, u.business_unit
        FROM users u
        JOIN survey_assignments sa ON sa.survey_id = $1 AND (
          sa.target_type = 'all'
          OR (sa.target_type = 'individual' AND sa.target_value = u.id::text)
          OR (sa.target_type = 'department' AND sa.target_value = u.department)
          OR (sa.target_type = 'business_unit' AND sa.target_value = u.business_unit)
        )
        WHERE u.company_id = $2 AND u.status = 'active'
      `, [surveyId, companyId]);

      // Get respondent IDs
      const respondedResult = await pool.query(
        'SELECT respondent_id FROM survey_responses WHERE survey_id = $1',
        [surveyId]
      );
      const respondedIds = new Set(respondedResult.rows.map(r => r.respondent_id));

      // Mark completion status (but don't reveal WHICH answers if anonymous)
      const participation = assignedResult.rows.map(user => ({
        user_id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        department: user.department,
        business_unit: user.business_unit,
        has_responded: respondedIds.has(user.id)
      }));

      // Department breakdown
      const deptBreakdown = {};
      for (const p of participation) {
        const dept = p.department || 'Unassigned';
        if (!deptBreakdown[dept]) {
          deptBreakdown[dept] = { total: 0, responded: 0 };
        }
        deptBreakdown[dept].total++;
        if (p.has_responded) deptBreakdown[dept].responded++;
      }

      res.json({
        data: {
          total_assigned: assignedResult.rows.length,
          total_responded: respondedIds.size,
          participation_rate: assignedResult.rows.length > 0
            ? Math.round((respondedIds.size / assignedResult.rows.length) * 100 * 10) / 10
            : 0,
          participants: participation,
          department_breakdown: Object.entries(deptBreakdown).map(([dept, data]) => ({
            department: dept,
            ...data,
            rate: data.total > 0 ? Math.round((data.responded / data.total) * 100 * 10) / 10 : 0
          }))
        }
      });
    } catch (err) {
      console.error('GET /api/surveys/:id/participation error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
