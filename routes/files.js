// routes/files.js
const express  = require('express');
const router   = express.Router();
const { rateLimit }      = require('../middleware/rateLimit');
const { parsePR }        = require('../utils/validation');
const { fetchPRFiles }   = require('../services/githubService');
const { extractAddedLines } = require('../parsers/phpParser');
const { handleGitHubError } = require('./errorHandler');

router.get('/', rateLimit, async (req, res) => {
  const { url } = req.query;

  let repoInfo;
  try {
    repoInfo = parsePR(url);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  try {
    const files = await fetchPRFiles(repoInfo);
    const phpFiles = files
      .filter(file => file.filename.endsWith('.php'))
      .map(file => ({
        filename:   file.filename,
        addedLines: extractAddedLines(file.patch),
      }));
    return res.json(phpFiles);
  } catch (error) {
    return handleGitHubError(error, res);
  }
});

module.exports = router;