// index.js
// Entry point — just starts the server

const app = require('./app');
const { ALLOWED_ORIGINS } = require('./middleware/cors');
const { CACHE_TTL_MS, CACHE_MAX } = require('./services/cacheService');

const port = process.env.PORT || 3001;

app.listen(port, () => {
  console.log(`\n✅ PR Analyzer API running on http://localhost:${port}`);
  console.log(`📋 GitHub Token configured: ${!!process.env.GITHUB_TOKEN}`);
  console.log(`🔒 Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`💾 Cache: TTL=${CACHE_TTL_MS / 60000}min, Max=${CACHE_MAX} entries`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /files?url=<PR_URL>`);
  console.log(`  POST /analyze (body: { url, token? })\n`);
});