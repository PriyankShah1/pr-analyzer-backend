// routes/analyze.js
const express  = require('express');
const router   = express.Router();
const { rateLimit }        = require('../middleware/rateLimit');
const { parsePR }          = require('../utils/validation');
const { getCached, setCached } = require('../services/cacheService');
const { fetchPRDetails }   = require('../services/githubService');
const { filterPHPFiles, buildEmptyResult, analyzeFiles } = require('../services/analysisService');
const { handleGitHubError } = require('./errorHandler');

router.post('/', rateLimit, async (req, res) => {
  const { url, token } = req.body;

  let repoInfo;
  try {
    repoInfo = parsePR(url);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  // Cache check — public PRs only, never cache private token requests
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

    if (phpFiles.length === 0) {
      return res.json(buildEmptyResult(prMeta));
    }

    let result;
    try {
      result = analyzeFiles(phpFiles, prMeta);
    } catch (error) {
      // guardLargePR throws here
      return res.status(422).json({ error: error.message });
    }

    // Cache public PR results only
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