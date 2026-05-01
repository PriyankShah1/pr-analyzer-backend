require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Octokit } = require('@octokit/rest');
const { parseLaravelFlow, extractAddedLines } = require('./parser');
const { enrichWithTypes, detectMismatches, detectBrokenDependencies } = require('./analyzer');
const { buildVisualizationResponse } = require('./visualizer');

const app = express();

// ── 1. CORS ───────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

// ── 2. Security headers ───────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.github.com"
  );
  next();
});

// ── 3. Rate limiting ──────────────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX       = 10;

function rateLimit(req, res, next) {
  const ip  = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };

  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);

  if (rateLimitMap.size > 1000) {
    for (const [key, val] of rateLimitMap) {
      if (now - val.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(key);
    }
  }

  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: `Rate limit exceeded. Max ${RATE_LIMIT_MAX} requests per minute.`,
      retryAfter: Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000),
    });
  }
  next();
}

// ── 4. In-memory cache ────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX    = 100;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}

function setCached(key, data) {
  if (cache.size >= CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, { data, timestamp: Date.now() });
}

// ── 5. Input validation ───────────────────────────────────────────────────
function parsePR(url) {
  if (!url || typeof url !== 'string') throw new Error('PR URL is required');
  const trimmed = url.trim().replace(/\/$/, '');
  const match = trimmed.match(
    /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pull\/(\d+)$/
  );
  if (!match) throw new Error('Invalid PR URL. Expected format: https://github.com/owner/repo/pull/123');
  return { owner: match[1], repo: match[2], pull_number: Number(match[3]) };
}

// ── 6. Large PR guards ────────────────────────────────────────────────────
const MAX_PHP_FILES  = 50;
const MAX_FILE_LINES = 500;

function guardLargePR(phpFiles) {
  if (phpFiles.length > MAX_PHP_FILES) {
    throw new Error(`PR is too large: ${phpFiles.length} PHP files found. Max supported is ${MAX_PHP_FILES}.`);
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

// ── 7. GitHub error handler ───────────────────────────────────────────────
function handleGitHubError(error, res) {
  const safeMessage = (msg) =>
    typeof msg === 'string'
      ? msg.replace(/ghp_[a-zA-Z0-9]+/g, '[REDACTED]')
           .replace(/github_pat_[a-zA-Z0-9_]+/g, '[REDACTED]')
      : 'Unknown error';

  if (error.status === 404) return res.status(404).json({ error: 'PR not found. Check the URL and repository access.' });
  if (error.status === 401) return res.status(401).json({ error: 'GitHub authentication failed. Check your token.' });
  if (error.status === 403) return res.status(403).json({ error: 'Access forbidden. Check repository permissions or rate limits.' });
  if (error.status === 422) return res.status(422).json({ error: safeMessage(error.message) });

  console.error('[analyze error]', safeMessage(error.message));
  return res.status(500).json({ error: 'Failed to analyze PR. Please try again.' });
}

process.on('unhandledRejection', (reason) => {
  const msg = String(reason)
    .replace(/ghp_[a-zA-Z0-9]+/g, '[REDACTED]')
    .replace(/github_pat_[a-zA-Z0-9_]+/g, '[REDACTED]');
  console.error('[unhandledRejection]', msg);
});

// ── Health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    github_token_configured: !!process.env.GITHUB_TOKEN,
    cache_entries: cache.size,
    timestamp: new Date().toISOString(),
  });
});

// ── GET /files ────────────────────────────────────────────────────────────
app.get('/files', rateLimit, async (req, res) => {
  const { url } = req.query;
  let repoInfo;
  try { repoInfo = parsePR(url); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  try {
    const requestOctokit = new Octokit({
      auth: process.env.GITHUB_TOKEN || undefined,
      request: { timeout: 10000 },
      log: { debug:()=>{}, info:()=>{}, warn:()=>{}, error:()=>{} },
    });
    const response = await requestOctokit.pulls.listFiles(repoInfo);
    const phpFiles = response.data
      .filter(file => file.filename.endsWith('.php'))
      .map(file => ({ filename: file.filename, addedLines: extractAddedLines(file.patch) }));
    return res.json(phpFiles);
  } catch (error) { return handleGitHubError(error, res); }
});

// ── POST /analyze ─────────────────────────────────────────────────────────
app.post('/analyze', rateLimit, async (req, res) => {
  const { url, token } = req.body;

  let repoInfo;
  try { repoInfo = parsePR(url); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  // Cache check — public PRs only
  const cacheKey = `pr:${url}`;
  if (!token) {
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[cache hit] ${url}`);
      return res.json({ ...cached, fromCache: true });
    }
  }

  const requestOctokit = new Octokit({
    auth: token || process.env.GITHUB_TOKEN || undefined,
    request: { timeout: 10000 },
    log: { debug:()=>{}, info:()=>{}, warn:()=>{}, error:()=>{} },
  });

  try {
    // ✅ Fetch PR details + files IN PARALLEL — no extra delay
    const [prDetailsRes, filesRes] = await Promise.all([
      requestOctokit.pulls.get(repoInfo),
      requestOctokit.pulls.listFiles(repoInfo),
    ]);

    // ── PR metadata ──────────────────────────────────────────────────────
    const prTitle  = prDetailsRes.data.title;
    const prNumber = prDetailsRes.data.number;
    const prAuthor = prDetailsRes.data.user?.login || null;
    const prState  = prDetailsRes.data.state;       // 'open' | 'closed' | 'merged'
    const prMerged = prDetailsRes.data.merged || false;

    console.log(`[analyze] PR #${prNumber} (${prState})`);

    let phpFiles = filesRes.data.filter(file => file.filename.endsWith('.php'));

    if (phpFiles.length === 0) {
      return res.json({
        prTitle,
        prNumber,
        prAuthor,
        prState,
        prMerged,
        files: [], flows: [], deletedClasses: [], deletedFunctions: {},
        visualization: {
          nodes: [], edges: [],
          stats: { totalNodes: 0, totalEdges: 0, mismatches: 0, staticCalls: 0, brokenDependencies: 0, deletedClasses: 0 },
        },
        message: 'No PHP files found in this PR',
      });
    }

    try { guardLargePR(phpFiles); }
    catch (error) { return res.status(422).json({ error: error.message }); }

    phpFiles = truncateLargeFiles(phpFiles);
    const truncatedFiles = phpFiles.filter(f => f.truncated).map(f => f.filename);

    // ── Full analysis pipeline ───────────────────────────────────────────
    const { flows: rawFlows, deletedClasses, deletedFunctions } = parseLaravelFlow(phpFiles);

    let flows = enrichWithTypes(phpFiles, rawFlows);
    flows = detectMismatches(flows);
    flows = detectBrokenDependencies(flows, deletedClasses);

    const visualization = buildVisualizationResponse(flows, deletedClasses);

    if (deletedClasses.length > 0) {
      console.log(`[deleted classes] ${deletedClasses.join(', ')}`);
    }

    const result = {
      // ✅ PR metadata included in response
      prTitle,
      prNumber,
      prAuthor,
      prState,
      prMerged,
      files: phpFiles.map(f => ({ filename: f.filename, truncated: f.truncated || false })),
      flows,
      deletedClasses,
      deletedFunctions,
      visualization,
      warnings: [
        ...(truncatedFiles.length > 0
          ? [`${truncatedFiles.length} file(s) were truncated (>${MAX_FILE_LINES} lines): ${truncatedFiles.join(', ')}`]
          : []),
        ...(deletedClasses.length > 0
          ? [`${deletedClasses.length} class(es) deleted in this PR: ${deletedClasses.join(', ')}`]
          : []),
      ],
    };

    if (!token) {
      setCached(cacheKey, result);
      console.log(`[cache set] ${url}`);
    }

    return res.json(result);

  } catch (error) { return handleGitHubError(error, res); }
});

// ── 404 handler ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

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