// routes/health.js
const express = require('express');
const router  = express.Router();
const { getCacheSize } = require('../services/cacheService');

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    github_token_configured: !!process.env.GITHUB_TOKEN,
    cache_entries: getCacheSize(),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;