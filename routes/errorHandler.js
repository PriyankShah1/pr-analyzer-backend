// routes/errorHandler.js
const { scrub } = require('../utils/tokenScrubber');

function handleGitHubError(error, res) {
  if (error.status === 404) return res.status(404).json({ error: 'PR not found. Check the URL and repository access.' });
  if (error.status === 401) return res.status(401).json({ error: 'GitHub authentication failed. Check your token.' });
  if (error.status === 403) return res.status(403).json({ error: 'Access forbidden. Check repository permissions or rate limits.' });
  if (error.status === 422) return res.status(422).json({ error: scrub(error.message) });

  console.error('[error]', scrub(error.message));
  return res.status(500).json({ error: 'Failed to analyze PR. Please try again.' });
}

module.exports = { handleGitHubError };