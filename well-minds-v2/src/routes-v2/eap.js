'use strict';

/**
 * EAP pages (v2)
 * --------------------------------------------------------------------------
 * Spec A6. Simple CRUD over the EAP hero + service list. Public to
 * company members (company_id match), editable with settings_company:edit.
 */

const express = require('express');
const router = express.Router();
const pool = require('../../../well-minds/src/db');
const { authenticate } = require('../../../well-minds/src/middleware');
const requirePermission = require('../middleware/requirePermission');

// Get the EAP page for my company
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const pageRes = await pool.query(
      `SELECT * FROM eap_pages WHERE company_id = $1`,
      [req.user.company_id],
    );
    if (pageRes.rowCount === 0) return res.json(null);
    const page = pageRes.rows[0];
    const servicesRes = await pool.query(
      `SELECT * FROM eap_services WHERE eap_page_id = $1 ORDER BY sort_order, title`,
      [page.id],
    );
    res.json({ ...page, services: servicesRes.rows });
  } catch (err) { next(err); }
});

// Upsert the EAP page (admin)
router.put('/me',
  authenticate,
  requirePermission('eap', 'edit'),
  async (req, res, next) => {
    const { banner_image_url, intro_html, provider_name, contact_phone,
      contact_email, hours_text, emergency_text } = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO eap_pages
           (company_id, banner_image_url, intro_html, provider_name,
            contact_phone, contact_email, hours_text, emergency_text,
            updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (company_id) DO UPDATE SET
           banner_image_url = EXCLUDED.banner_image_url,
           intro_html       = EXCLUDED.intro_html,
           provider_name    = EXCLUDED.provider_name,
           contact_phone    = EXCLUDED.contact_phone,
           contact_email    = EXCLUDED.contact_email,
           hours_text       = EXCLUDED.hours_text,
           emergency_text   = EXCLUDED.emergency_text,
           updated_at       = NOW()
         RETURNING *`,
        [
          req.user.company_id, banner_image_url, intro_html, provider_name,
          contact_phone, contact_email, hours_text, emergency_text,
        ],
      );
      res.json(rows[0]);
    } catch (err) { next(err); }
  },
);

// Add an EAP service
router.post('/:eapPageId/services',
  authenticate,
  requirePermission('eap', 'add'),
  async (req, res, next) => {
    const { title, description, url, icon, sort_order } = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO eap_services (eap_page_id, title, description, url, icon, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.eapPageId, title, description, url, icon, sort_order || 0],
      );
      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  },
);

// Delete an EAP service
router.delete('/services/:id',
  authenticate,
  requirePermission('eap', 'delete'),
  async (req, res, next) => {
    try {
      await pool.query(`DELETE FROM eap_services WHERE id = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

module.exports = router;
