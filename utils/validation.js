// utils/validation.js
// Input validation and PR size guards for PHP and JS/TS files

const { extractAddedLines } = require('../parsers/phpParser');
const { extractAddedLines: extractJsAddedLines } = require('../parsers/jsParser');

const MAX_PHP_FILES  = 50;
const MAX_JS_FILES   = 80;   // JS/TS repos tend to have more files
const MAX_FILE_LINES = 500;

// ── PR URL validation ─────────────────────────────────────────────────────
function parsePR(url) {
  if (!url || typeof url !== 'string') throw new Error('PR URL is required');
  const trimmed = url.trim().replace(/\/$/, '');
  const match = trimmed.match(
    /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pull\/(\d+)$/
  );
  if (!match) throw new Error(
    'Invalid PR URL. Expected format: https://github.com/owner/repo/pull/123'
  );
  return { owner: match[1], repo: match[2], pull_number: Number(match[3]) };
}

// ── PHP guards ────────────────────────────────────────────────────────────
function guardLargePR(phpFiles) {
  if (phpFiles.length > MAX_PHP_FILES) {
    throw new Error(
      `PR is too large: ${phpFiles.length} PHP files found. Max supported is ${MAX_PHP_FILES}.`
    );
  }
}

function truncateLargeFiles(phpFiles) {
  return phpFiles.map(file => {
    const lines = extractAddedLines(file.patch);
    if (lines.length > MAX_FILE_LINES) {
      console.warn(`[truncate] ${file.filename}: ${lines.length} lines → truncated to ${MAX_FILE_LINES}`);
      return {
        ...file,
        patch: lines.slice(0, MAX_FILE_LINES).map(l => `+${l}`).join('\n'),
        truncated: true,
      };
    }
    return file;
  });
}

// ── JS/TS guards ──────────────────────────────────────────────────────────
function guardLargeJsPR(jsFiles) {
  if (jsFiles.length > MAX_JS_FILES) {
    throw new Error(
      `PR is too large: ${jsFiles.length} JS/TS files found. Max supported is ${MAX_JS_FILES}.`
    );
  }
}

function truncateLargeJsFiles(jsFiles) {
  return jsFiles.map(file => {
    const lines = extractJsAddedLines(file.patch);
    if (lines.length > MAX_FILE_LINES) {
      console.warn(`[truncate] ${file.filename}: ${lines.length} lines → truncated to ${MAX_FILE_LINES}`);
      return {
        ...file,
        patch: lines.slice(0, MAX_FILE_LINES).map(l => `+${l}`).join('\n'),
        truncated: true,
      };
    }
    return file;
  });
}

module.exports = {
  parsePR,
  guardLargePR,
  truncateLargeFiles,
  guardLargeJsPR,
  truncateLargeJsFiles,
  MAX_PHP_FILES,
  MAX_JS_FILES,
  MAX_FILE_LINES,
};