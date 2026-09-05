// services/reviewService.js
//
// Structured code review. Where sqlAnalyzer answers "does this query match a
// known bad pattern", this asks a model to read the actual changed code and
// reason about logic — the class of bug no regex finds.
//
// Two rules govern everything here, both inherited from the project's
// accuracy-over-coverage principle:
//
//   1. THE MODEL'S LINE NUMBERS ARE NOT TRUSTED. Language models hallucinate
//      positions confidently. Every finding is re-anchored against the real
//      added lines of the diff; anything that cannot be anchored is kept but
//      flagged `anchored: false` so it never becomes an inline PR comment on
//      the wrong line. It goes in the summary instead.
//
//   2. LOW CONFIDENCE IS DROPPED, NOT SHOWN. One wrong confident flag erodes
//      trust in every correct flag, and an AI reviewer that cries wolf gets
//      switched off.

const { callGeminiJson } = require('./geminiClient');
const {
  extractAddedLinesWithPositions,
  fingerprintOf,
  SEVERITY,
  SEVERITY_RANK,
} = require('../parsers/sqlAnalyzer');

// Free tier is limited by requests/minute, not output size, so the budget
// here is about keeping the prompt cheap and the reply parseable — not cost.
const MAX_CODE_CHARS      = 12000;
const MAX_FILES_IN_PROMPT = 12;
const MAX_FINDINGS        = 12;
const REVIEW_MAX_TOKENS   = 2048;

// Below this the model is guessing. Tuned to be strict: a reviewer who sees
// two solid findings trusts the tool; one who sees ten speculative ones stops
// reading it entirely.
const MIN_CONFIDENCE = 0.7;

const REVIEWABLE_RE = /\.(js|jsx|ts|tsx|mjs|cjs|php|py|go|rb|java)$/i;
const SKIP_RE = /(^|\/)(node_modules|dist|build|vendor|\.next)(\/|$)|\.(lock|snap|min\.js)$|package-lock\.json$/i;

// Kinds the model may return. Anything else is discarded — an open-ended
// taxonomy makes the UI ungroupable and lets the model invent categories to
// justify weak findings.
const ALLOWED_KINDS = new Set([
  'missing_await',
  'unhandled_error_path',
  'swallowed_error',
  'missing_auth_check',
  'unvalidated_input',
  'race_condition',
  'resource_leak',
  'null_dereference',
  'off_by_one',
  'hardcoded_secret',
  'incorrect_logic',
  'breaking_api_change',
]);

const ALLOWED_SEVERITIES = new Set(Object.values(SEVERITY));

// ── Prompt construction ───────────────────────────────────────────────────

// The model needs real line numbers to cite, so added lines are presented as
// `<line>| <code>` — the same shape it will be asked to reference back.
function buildNumberedCode(files) {
  const blocks = [];
  let budget = MAX_CODE_CHARS;

  for (const file of files.slice(0, MAX_FILES_IN_PROMPT)) {
    if (budget <= 0) break;
    const added = extractAddedLinesWithPositions(file.patch);
    if (added.length === 0) continue;

    const body = added
      .map(l => `${l.line}| ${l.text}`)
      .join('\n')
      .slice(0, budget);

    budget -= body.length;
    blocks.push(`--- ${file.filename} ---\n${body}`);
  }

  return blocks.join('\n\n');
}

function buildReviewPrompt({ prTitle, codeLanguage, numberedCode, flowSummary, sqlSummary }) {
  return `You are a senior engineer reviewing a pull request. Below are ONLY the lines this PR adds, each prefixed with its real line number.

PR title: ${prTitle || 'Untitled'}
Language: ${codeLanguage || 'unknown'}
${flowSummary ? `\nCode flow detected by static analysis:\n${flowSummary}\n` : ''}${sqlSummary ? `\nSQL problems ALREADY found by static analysis (do NOT repeat these):\n${sqlSummary}\n` : ''}
Changed code:
${numberedCode}

Find genuine LOGIC defects a static analyzer cannot catch. Look for:
- missing_await — a promise not awaited, so errors vanish and ordering breaks
- unhandled_error_path — I/O or parsing with no error handling around it
- swallowed_error — catch block that discards the error silently
- missing_auth_check — a new route or handler with no authorization guard
- unvalidated_input — request data reaching a query, path, or command unchecked
- race_condition — check-then-act on shared or persisted state
- resource_leak — opened handle/connection/stream never released
- null_dereference — property access on a value that can be null/undefined here
- off_by_one — boundary error in indexing, slicing, or pagination
- hardcoded_secret — credential or key literal committed in the diff
- incorrect_logic — the code demonstrably does not do what its name/context says
- breaking_api_change — a signature or response shape change that breaks callers

NEVER report any of the following — you are seeing ONLY this PR's added lines, not the whole repository, so these cannot be judged from here:
- dead code, unused functions, unused variables or unreachable code (callers elsewhere are invisible to you)
- missing tests, missing documentation, missing type annotations
- naming, formatting, style or code organisation
- a function being "not called" or an import being "unused"
- anything whose correctness depends on code that is not printed above

Rules you MUST follow:
1. Only report a defect you can see in the lines above. Never speculate about code you were not shown.
2. "file" must be exactly one of the file paths shown. "line" must be a line number that appears in that file's listing.
3. "confidence" is 0.0-1.0. Use below 0.7 if you are inferring rather than seeing the defect. Be honest — low-confidence entries are discarded, not penalised.
4. "evidence" must quote the exact code text from the line you cite, so the finding can be verified.
5. If the code is fine, return an empty findings array. A clean review is a valid result.
6. At most ${MAX_FINDINGS} findings, highest severity first.

Return ONLY JSON in this exact shape:
{"findings":[{"kind":"<one of the kinds above>","severity":"critical|high|medium|low","file":"<path>","line":<number>,"evidence":"<exact code from that line>","title":"<short defect name, under 60 chars>","why":"<what breaks, concretely, 1-2 sentences>","suggestion":"<the specific fix>","confidence":<0.0-1.0>}]}`;
}

// ── Validation & re-anchoring ─────────────────────────────────────────────

// Index every added line of the PR so a claimed (file, line) can be checked
// against reality, and so a finding whose line is wrong but whose quoted
// evidence is real can be moved to the correct line instead of discarded.
function buildAddedLineIndex(files) {
  const byFile = new Map();

  for (const file of files) {
    const added = extractAddedLinesWithPositions(file.patch);
    if (added.length === 0) continue;

    const byLine = new Map();
    for (const entry of added) byLine.set(entry.line, entry);
    byFile.set(file.filename, { byLine, all: added });
  }

  return byFile;
}

function normalizeForMatch(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

// Returns { line, diffPosition, text, anchored } — anchored:false means we
// could not place this finding on a real added line.
function anchorFinding(finding, index) {
  const fileEntry = index.get(finding.file);
  if (!fileEntry) return { anchored: false };

  // Case 1: the cited line is a real added line and its text matches the
  // quoted evidence. This is the model getting it right.
  const direct = fileEntry.byLine.get(finding.line);
  const evidence = normalizeForMatch(finding.evidence || '');

  if (direct) {
    const lineText = normalizeForMatch(direct.text);
    if (!evidence || lineText.includes(evidence) || evidence.includes(lineText)) {
      return { ...direct, anchored: true };
    }
  }

  // Case 2: the line number is wrong but the quoted evidence exists elsewhere
  // in the same file's added lines. Re-anchor to where it actually is.
  if (evidence.length >= 8) {
    const match = fileEntry.all.find(l => {
      const t = normalizeForMatch(l.text);
      return t.includes(evidence) || evidence.includes(t);
    });
    if (match) return { ...match, anchored: true, reanchored: true };
  }

  // Case 3: cited line exists but evidence does not match anything. Keep the
  // position, but do not claim it is verified.
  if (direct) return { ...direct, anchored: false };

  return { anchored: false };
}

function validateFinding(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  if (!ALLOWED_KINDS.has(raw.kind)) return null;
  if (!ALLOWED_SEVERITIES.has(raw.severity)) return null;
  if (typeof raw.file !== 'string' || !raw.file) return null;

  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) return null;

  const title = String(raw.title || '').trim();
  const why   = String(raw.why || '').trim();
  if (!title || !why) return null;

  const anchor = anchorFinding({ ...raw, line: Number(raw.line) }, index);

  // A finding we cannot even attribute to a file in this PR is a
  // hallucination about code the model was never shown. Drop it.
  if (!index.has(raw.file)) return null;

  const snippet = anchor.text ? anchor.text.trim() : String(raw.evidence || title);

  return {
    kind: raw.kind,
    severity: raw.severity,
    severityRank: SEVERITY_RANK[raw.severity],
    title: title.slice(0, 80),
    detail: why,
    suggestion: String(raw.suggestion || '').trim(),
    file: raw.file,
    line: anchor.line ?? Number(raw.line) ?? null,
    diffPosition: anchor.diffPosition ?? null,
    snippet: snippet.length > 240 ? `${snippet.slice(0, 240)}…` : snippet,
    fingerprint: fingerprintOf(raw.kind, raw.file, snippet),
    source: 'ai',
    confidence,
    anchored: Boolean(anchor.anchored),
    reanchored: Boolean(anchor.reanchored),
  };
}

// ── Public entry point ────────────────────────────────────────────────────

function isReviewableFile(filename) {
  return REVIEWABLE_RE.test(filename) && !SKIP_RE.test(filename);
}

async function generateReview({ prTitle, codeLanguage, files, flows, sqlFindings }) {
  const reviewable = (files || []).filter(f => f.patch && isReviewableFile(f.filename || ''));
  if (reviewable.length === 0) return [];

  const numberedCode = buildNumberedCode(reviewable);
  if (!numberedCode.trim()) return [];

  const flowSummary = (flows || [])
    .slice(0, 20)
    .map(f => `${f.from} → ${f.to}${f.type ? ` (${f.type})` : ''}`)
    .join('\n');

  // Telling the model what static analysis already found stops it spending
  // its output budget restating the same SQL problems.
  const sqlSummary = (sqlFindings || [])
    .slice(0, 10)
    .map(f => `${f.file}:${f.line} ${f.kind}`)
    .join('\n');

  const prompt = buildReviewPrompt({ prTitle, codeLanguage, numberedCode, flowSummary, sqlSummary });

  const reply = await callGeminiJson(prompt, {
    temperature: 0.2,             // review wants determinism, not creativity
    maxOutputTokens: REVIEW_MAX_TOKENS,
    timeoutMs: 30000,
  });

  if (!reply || !Array.isArray(reply.findings)) return [];

  const index = buildAddedLineIndex(reviewable);
  const seen = new Set();
  const validated = [];

  for (const raw of reply.findings.slice(0, MAX_FINDINGS)) {
    const finding = validateFinding(raw, index);
    if (!finding) continue;
    if (seen.has(finding.fingerprint)) continue;
    seen.add(finding.fingerprint);
    validated.push(finding);
  }

  const dropped = reply.findings.length - validated.length;
  if (dropped > 0) {
    console.log(`[reviewService] ${validated.length} kept, ${dropped} dropped (low confidence / unverifiable)`);
  }

  return validated.sort((a, b) => a.severityRank - b.severityRank || b.confidence - a.confidence);
}

module.exports = {
  generateReview,
  isReviewableFile,
  MIN_CONFIDENCE,
  // Exported for tests: posting a review comment on a wrong line in someone
  // else's PR is embarrassing and awkward to undo, so the guard that prevents
  // it needs direct coverage rather than being exercised only through a
  // live model call.
  _internal: { validateFinding, buildAddedLineIndex, anchorFinding },
};
