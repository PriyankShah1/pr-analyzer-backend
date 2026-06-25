// routes/analyze.js
const express  = require('express');
const router   = express.Router();
const { rateLimit }        = require('../middleware/rateLimit');
const { parsePR }          = require('../utils/validation');
const { getCached, setCached } = require('../services/cacheService');
const { fetchPRDetails }   = require('../services/githubService');
const { filterPHPFiles, buildEmptyResult, analyzeFiles } = require('../services/analysisService');
const { generateExplanation } = require('../services/aiService');
const { getDefaultLanguage }  = require('../services/languageConfig');
const { handleGitHubError } = require('./errorHandler');

router.post('/', rateLimit, async (req, res) => {
  const { url, token } = req.body;

  let repoInfo;
  try {
    repoInfo = parsePR(url);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  // Cache check — public PRs only, never cache private token requests.
  // The cached object already includes aiExplanations (if generated),
  // so a cache hit returns the explanation with zero extra Gemini calls.
  const cacheKey = `pr:${url}`;
  if (!token) {
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[cache hit] ${url}`);
      return res.json({ ...cached, fromCache: true });
    }
  }

  try {
    const { prTitle, prNumber, prAuthor, prState, prMerged, files } =
      await fetchPRDetails(repoInfo, token);

    console.log(`[analyze] PR #${prNumber} (${prState})`);

    const prMeta = { prTitle, prNumber, prAuthor, prState, prMerged };
    const phpFiles = filterPHPFiles(files);

    if (phpFiles.length === 0 && files.length === 0) {
      return res.json(buildEmptyResult(prMeta));
    }

    let result;
    try {
      result = analyzeFiles(files, prMeta);
    } catch (error) {
      // guardLargePR / guardLargeJsPR throws here
      return res.status(422).json({ error: error.message });
    }

    // ── AI explanation — auto-generate ONLY the default language ─────────
    // Determined dynamically from languageConfig (currently 'en'). Other
    // languages are generated on-demand via POST /explain when the user
    // clicks that tab. Skipped entirely if nodes.length === 0 — handled
    // inside generateExplanation, so no wasted API calls on empty PRs.
    const defaultLang = getDefaultLanguage();
    const explanation = await generateExplanation(defaultLang, {
      prTitle:      result.prTitle,
      codeLanguage: result.language,
      flows:        result.flows,
      stats:        result.visualization?.stats,
      codeContext:  result.codeContext,
    });

    if (explanation) {
      result.aiExplanations = { [defaultLang]: explanation };
    }

    // Cache public PR results only — explanation is cached as part of result
    if (!token) {
      setCached(cacheKey, result);
      console.log(`[cache set] ${url}`);
    }

    return res.json(result);

  } catch (error) {
    return handleGitHubError(error, res);
  }
});

module.exports = router;