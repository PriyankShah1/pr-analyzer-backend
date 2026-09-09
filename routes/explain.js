// routes/explain.js
const express = require('express');
const { lastGeminiFailure, isFatalGeminiFailure } = require('../services/geminiClient');
const router  = express.Router();
const crypto                   = require('crypto');
const { rateLimit }            = require('../middleware/rateLimit');
const { getCached, setCached } = require('../services/cacheService');
const { generateExplanation }  = require('../services/aiService');
const { isSupportedLanguage, listSupportedLanguages } = require('../services/languageConfig');

// ── GET /explain/languages ─────────────────────────────────────────────────
// Frontend calls this to dynamically build language tabs. Adding a new
// language to languageConfig.js makes it appear here automatically —
// zero frontend code changes needed when a 5th, 6th language is added.
router.get('/languages', (req, res) => {
  res.json({ languages: listSupportedLanguages() });
});

// ── POST /explain ───────────────────────────────────────────────────────
// Generates an explanation in the requested language. Stateless — the
// frontend supplies all context (flows, stats, codeContext) since it
// already has this data from the /analyze response. No server-side PR
// lookup needed — works identically for public and private repos.
router.post('/', rateLimit, async (req, res) => {
  const { language, prTitle, codeLanguage, flows, stats, codeContext } = req.body;

  if (!language || typeof language !== 'string') {
    return res.status(400).json({ error: 'language is required' });
  }

  if (!isSupportedLanguage(language)) {
    return res.status(400).json({
      error: `Unsupported language: ${language}`,
      supportedLanguages: listSupportedLanguages().map(l => l.code),
    });
  }

  if (!Array.isArray(flows) || flows.length === 0) {
    return res.status(400).json({ error: 'flows array is required and must not be empty' });
  }

  if (!stats || typeof stats !== 'object') {
    return res.status(400).json({ error: 'stats object is required' });
  }

    // Keyed on the INPUTS, not the PR. This route is deliberately stateless —
    // the client supplies all context — so there is no url to key on, and the
    // same inputs must give the same answer anyway. Without this, flipping to
    // a language, leaving the panel and coming back spent another model call
    // for a translation we had already paid for.
    const cacheKey = 'explain:' + crypto.createHash('sha1')
      .update([
        language, prTitle || '', codeLanguage || '',
        String(stats.totalNodes ?? ''), String(stats.totalEdges ?? ''),
        (codeContext || '').slice(0, 4000),
      ].join('|'))
      .digest('hex');

    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ language, explanation: cached, fromCache: true });
    }

  try {
    const explanation = await generateExplanation(language, {
      prTitle, codeLanguage, flows, stats, codeContext,
    });

    if (!explanation) {
      // geminiClient already worked out WHY the call failed — a quota error, a
      // missing key, a blocked response. Passing the generic sentence instead
      // meant a user who had exhausted their Gemini quota saw only "Failed"
      // and had no way to know a retry could not help.
      const failure = lastGeminiFailure();
      return res.status(503).json({
        error: failure?.message
          || 'AI explanation unavailable right now. Please try again later.',
        retryable: failure ? !isFatalGeminiFailure(failure) : true,
      });
    }

    setCached(cacheKey, explanation);
    return res.json({ language, explanation });

  } catch (error) {
    console.error('[explain route] error:', error.message);
    return res.status(500).json({ error: 'Failed to generate explanation' });
  }
});

module.exports = router;