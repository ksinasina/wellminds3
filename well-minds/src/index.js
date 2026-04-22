'use strict';

require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Generate a per-request nonce so inline <script> blocks work without 'unsafe-inline'
app.use((_req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
      },
    },
  }),
);
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// CORS - configurable origins from env
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:3000', 'http://localhost:5173'];

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Route mounting
// ---------------------------------------------------------------------------
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/objectives', require('./routes/objectives'));
app.use('/api/wellbeing', require('./routes/wellbeing'));
app.use('/api/smiles', require('./routes/smiles'));
app.use('/api/events', require('./routes/events'));
app.use('/api/surveys', require('./routes/surveys'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/company', require('./routes/company'));
app.use('/api/indicators', require('./routes/indicators'));
app.use('/api/hris', require('./routes/hris'));
app.use('/api/challenges', require('./routes/challenges'));
app.use('/api/professionals', require('./routes/professionals'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/learning-sessions', require('./routes/learning-sessions'));
app.use('/api/icc', require('./routes/icc-admin'));

// ---------------------------------------------------------------------------
// Serve frontend HTML files from /public
// ---------------------------------------------------------------------------
const fs = require('fs');

function sendHtmlWithNonce(filePath, res) {
  const html = fs.readFileSync(filePath, 'utf8');
  const nonce = res.locals.cspNonce;
  res.type('html').send(html.replace(/<script>/g, `<script nonce="${nonce}">`));
}

app.use(express.static(path.join(__dirname, '..', 'public')));

// Org-level app
app.get('/app', (_req, res) => {
  sendHtmlWithNonce(path.join(__dirname, '..', 'public', 'wellminds-app.html'), res);
});

// ICC super-admin panel
app.get('/admin', (_req, res) => {
  sendHtmlWithNonce(path.join(__dirname, '..', 'public', 'icc-admin.html'), res);
});

// Root redirects to org app
app.get('/', (_req, res) => {
  res.redirect('/app');
});

// ---------------------------------------------------------------------------
// 404 handler (API only - let frontend routes through above)
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[error]', err.stack || err.message || err);

  const status = err.status || err.statusCode || 500;
  const message =
    process.env.NODE_ENV === 'production' && status === 500
      ? 'Internal server error'
      : err.message || 'Internal server error';

  res.status(status).json({ error: message });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 3001;

app.listen(PORT, () => {
  console.log(`[server] InterBeing Care Connect API listening on port ${PORT}`);
  console.log(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
