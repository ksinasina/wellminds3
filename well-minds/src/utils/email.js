'use strict';

const nodemailer = require('nodemailer');
const pool = require('../db');

// ---------------------------------------------------------------------------
// Global transporter (lazy-initialised)
// ---------------------------------------------------------------------------
let _globalTransporter = null;

function getGlobalTransporter() {
  if (_globalTransporter) return _globalTransporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn(
      '[email] SMTP not configured (missing SMTP_HOST / SMTP_USER / SMTP_PASS). Emails will not be sent.',
    );
    return null;
  }

  _globalTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10) || 587,
    secure: parseInt(SMTP_PORT, 10) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  return _globalTransporter;
}

// ---------------------------------------------------------------------------
// sendEmail  -  Send using global SMTP config
// ---------------------------------------------------------------------------
async function sendEmail({ to, subject, html, text }) {
  try {
    const transporter = getGlobalTransporter();
    if (!transporter) {
      console.warn('[email] Skipping email (no SMTP config):', subject);
      return false;
    }

    const fromName = process.env.SMTP_FROM_NAME || 'InterBeing Care Connect';
    const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;

    await transporter.sendMail({
      from: `"${fromName}" <${fromAddr}>`,
      to,
      subject,
      html,
      text: text || undefined,
    });

    return true;
  } catch (err) {
    console.error('[email] Failed to send email:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// sendCompanyEmail  -  Send using company-specific SMTP, fallback to global
// ---------------------------------------------------------------------------
async function sendCompanyEmail({ companyId, to, subject, html, text }) {
  try {
    // Look up company SMTP settings
    const result = await pool.query(
      `SELECT smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_from_name
       FROM companies
       WHERE id = $1`,
      [companyId],
    );

    const company = result.rows[0];

    // If company has its own SMTP config, use it
    if (company && company.smtp_host && company.smtp_user && company.smtp_pass) {
      const companyTransporter = nodemailer.createTransport({
        host: company.smtp_host,
        port: parseInt(company.smtp_port, 10) || 587,
        secure: parseInt(company.smtp_port, 10) === 465,
        auth: {
          user: company.smtp_user,
          pass: company.smtp_pass,
        },
      });

      const fromName = company.smtp_from_name || 'InterBeing Care Connect';
      const fromAddr = company.smtp_from || company.smtp_user;

      await companyTransporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to,
        subject,
        html,
        text: text || undefined,
      });

      return true;
    }

    // Fall back to global
    return sendEmail({ to, subject, html, text });
  } catch (err) {
    console.error('[email] Failed to send company email:', err.message);
    // Attempt global fallback on transporter creation / query errors
    try {
      return await sendEmail({ to, subject, html, text });
    } catch {
      return false;
    }
  }
}

module.exports = {
  sendEmail,
  sendCompanyEmail,
};
