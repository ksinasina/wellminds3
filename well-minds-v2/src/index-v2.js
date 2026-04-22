'use strict';

/**
 * index-v2.js
 * --------------------------------------------------------------------------
 * Boots the server with BOTH v1 routes (original /api) AND v2 routes (/api/v2).
 * Existing v1 handlers are untouched; v2 handlers live under well-minds-v2/.
 *
 * New static HTML demos are served at /demo (company app) and /demo/icc
 * (ICC admin) while the original pages stay at /app and /admin.
 */

require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');

const app = express();

// ---------------------------------------------------------------------------
// Locate the v1 source tree (sibling folder)
// ---------------------------------------------------------------------------
const V1_ROOT = path.resolve(__dirname, '..', '..', 'well-minds');
const V1_SRC = path.join(V1_ROOT, 'src');

// ---------------------------------------------------------------------------
// Shared middleware (mirrors the v1 index so everything boots the same)
// ---------------------------------------------------------------------------
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
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
      },
    },
  }),
);
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'];

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: 'v2', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// V1 routes (mounted exactly as they were in the original index.js)
// ---------------------------------------------------------------------------
app.use('/api/auth',              require(path.join(V1_SRC, 'routes/auth')));
app.use('/api/users',             require(path.join(V1_SRC, 'routes/users')));
app.use('/api/objectives',        require(path.join(V1_SRC, 'routes/objectives')));
app.use('/api/wellbeing',         require(path.join(V1_SRC, 'routes/wellbeing')));
app.use('/api/smiles',            require(path.join(V1_SRC, 'routes/smiles')));
app.use('/api/events',            require(path.join(V1_SRC, 'routes/events')));
app.use('/api/surveys',           require(path.join(V1_SRC, 'routes/surveys')));
app.use('/api/posts',             require(path.join(V1_SRC, 'routes/posts')));
app.use('/api/company',           require(path.join(V1_SRC, 'routes/company')));
app.use('/api/indicators',        require(path.join(V1_SRC, 'routes/indicators')));
app.use('/api/hris',              require(path.join(V1_SRC, 'routes/hris')));
app.use('/api/challenges',        require(path.join(V1_SRC, 'routes/challenges')));
app.use('/api/professionals',     require(path.join(V1_SRC, 'routes/professionals')));
app.use('/api/reports',           require(path.join(V1_SRC, 'routes/reports')));
app.use('/api/learning-sessions', require(path.join(V1_SRC, 'routes/learning-sessions')));
app.use('/api/icc',               require(path.join(V1_SRC, 'routes/icc-admin')));

// ---------------------------------------------------------------------------
// V2 routes
// ---------------------------------------------------------------------------
app.use('/api/v2/rbac',                  require('./routes-v2/rbac'));
app.use('/api/v2/pulse',                 require('./routes-v2/pulse-checks'));
app.use('/api/v2/indicator-ranges',      require('./routes-v2/indicator-ranges'));
app.use('/api/v2/growth',                require('./routes-v2/growth-leaderboards'));
app.use('/api/v2/eap',                   require('./routes-v2/eap'));
app.use('/api/v2/connect',               require('./routes-v2/connect-signoff'));
app.use('/api/v2/communication-templates', require('./routes-v2/communication-templates'));
app.use('/api/v2/social-wall',           require('./routes-v2/social-wall-v2'));

// ---------------------------------------------------------------------------
// Static frontend (both v1 and v2 under /public)
// ---------------------------------------------------------------------------
function sendHtmlWithNonce(filePath, res) {
  const html = fs.readFileSync(filePath, 'utf8');
  const nonce = res.locals.cspNonce;
  res.type('html').send(html.replace(/<script>/g, `<script nonce="${nonce}">`));
}

// v1 originals (read-only — never modified)
app.use('/v1-assets', express.static(path.join(V1_ROOT, 'public')));

// v2 public (new demos)
app.use(express.static(path.join(__dirname, '..', 'public')));

// v1 URLs (unchanged)
app.get('/app', (_req, res) =>
  sendHtmlWithNonce(path.join(V1_ROOT, 'public', 'wellminds-app.html'), res),
);
app.get('/admin', (_req, res) =>
  sendHtmlWithNonce(path.join(V1_ROOT, 'public', 'icc-admin.html'), res),
);

// v2 demos
app.get('/', (_req, res) => res.redirect('/demo'));
app.get('/demo', (_req, res) =>
  sendHtmlWithNonce(path.join(__dirname, '..', 'public', 'wellminds-v2-demo.html'), res),
);
app.get('/demo/icc', (_req, res) =>
  sendHtmlWithNonce(path.join(__dirname, '..', 'public', 'icc-admin-v2-demo.html'), res),
);

// ---------------------------------------------------------------------------
// 404 + error handlers
// ---------------------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

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
// Start
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[server] WellMinds v2 API listening on port ${PORT}`);
    console.log(`[server] Demo app:   http://localhost:${PORT}/demo`);
    console.log(`[server] ICC demo:   http://localhost:${PORT}/demo/icc`);
    console.log(`[server] V1 app:     http://localhost:${PORT}/app`);
    console.log(`[server] V1 admin:   http://localhost:${PORT}/admin`);
  });
}

module.exports = app;
