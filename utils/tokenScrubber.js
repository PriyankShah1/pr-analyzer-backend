// utils/tokenScrubber.js
// Removes GitHub tokens from any string before logging or returning to client

function scrub(msg) {
  if (typeof msg !== 'string') return 'Unknown error';
  return msg
    .replace(/ghp_[a-zA-Z0-9]+/g, '[REDACTED]')
    .replace(/github_pat_[a-zA-Z0-9_]+/g, '[REDACTED]');
}

module.exports = { scrub };