// app.js
// Express app setup — routes and middleware only, no business logic

require('dotenv').config();
const express = require('express');
const { corsMiddleware }  = require('./middleware/cors');
const { securityHeaders } = require('./middleware/security');
const { scrub }           = require('./utils/tokenScrubber');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────
app.use(corsMiddleware);
app.use(express.json());
app.use(securityHeaders);

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/health',  require('./routes/health'));
app.use('/files',   require('./routes/files'));
app.use('/analyze', require('./routes/analyze'));
app.use('/explain', require('./routes/explain')); // ← NEW: AI explanation

// ── 404 handler ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ── Global unhandled rejection ────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', scrub(String(reason)));
});

module.exports = app;