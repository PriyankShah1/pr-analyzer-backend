// services/patchService.js
//
// Turns a finding into a concrete code change: fetch the real file, ask the
// model for an exact replacement, then verify that replacement can be applied
// safely before anyone is offered the chance to commit it.
//
// The verification is the important half. A model asked to "fix this" will
// happily return code that does not match the file, matches in several
// places, or quietly rewrites twenty unrelated lines. Every one of those
// produces a broken commit in someone's repository, so each is checked for
// explicitly and rejected rather than patched around.

const { callGeminiJson } = require('./geminiClient');

// Lines of surrounding code given to the model. Enough to understand the
// context; small enough to keep the prompt cheap.
const CONTEXT_LINES = 25;

// A fix that rewrites more than this many lines is not a targeted fix any
// more — it is a refactor, and it should not be applied unattended.
const MAX_REPLACEMENT_LINES = 40;

// Files above this size are skipped: the anchor snippet gets less reliable
// the more the file repeats itself, and huge files blow the prompt budget.
const MAX_FILE_BYTES = 200000;

async function fetchFileContent(octokit, repoInfo, path, ref) {
  const { data } = await octokit.repos.getContent({
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    path,
    ref,
  });

  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`${path} is not a file`);
  }
  if (data.size > MAX_FILE_BYTES) {
    throw new Error(`${path} is too large to patch safely (${data.size} bytes)`);
  }

  return {
    content: Buffer.from(data.content, 'base64').toString('utf8'),
    sha: data.sha,
  };
}

function sliceContext(content, line) {
  const lines = content.split('\n');
  const idx = Math.max(0, (line || 1) - 1);
  const start = Math.max(0, idx - CONTEXT_LINES);
  const end = Math.min(lines.length, idx + CONTEXT_LINES);

  return {
    numbered: lines
      .slice(start, end)
      .map((text, i) => `${start + i + 1}| ${text}`)
      .join('\n'),
    startLine: start + 1,
  };
}

function buildFixPrompt(finding, context) {
  return `You are fixing one specific defect in a source file. Below is the relevant region, each line prefixed with its real line number.

File: ${finding.file}
Defect (${finding.severity}): ${finding.title}
Why it is a problem: ${finding.detail}
Suggested approach: ${finding.suggestion || '(none given)'}
Reported at line: ${finding.line}

Code:
${context.numbered}

Produce a MINIMAL fix for exactly this defect.

Rules:
1. "original" must be copied VERBATIM from the code above — exact characters, exact indentation, WITHOUT the "N| " line-number prefixes. It must be unique enough to appear only once in the file.
2. "original" must be as short as possible while still being unique — ideally 1-5 lines.
3. "replacement" is what those exact lines become. Keep the same indentation style.
4. Change ONLY what this defect requires. Do not reformat, rename, or improve anything else.
5. Do not introduce new imports unless the fix cannot work without them — if you do, list them in "requiresImports".
6. If you cannot fix it safely with a local edit, set "canFix" to false and explain in "reason". That is a valid, useful answer.

Return ONLY JSON:
{"canFix":true|false,"original":"<exact code>","replacement":"<fixed code>","explanation":"<one sentence on what changed>","requiresImports":[],"reason":"<only when canFix is false>"}`;
}

// ── Verification ──────────────────────────────────────────────────────────

/**
 * Decide whether a proposed edit can be applied to this file safely.
 *
 * Rejects, in order:
 *   - the model declining to fix (a legitimate answer, passed through)
 *   - an anchor that does not appear in the file  → the model invented it
 *   - an anchor that appears more than once       → we'd patch the wrong copy
 *   - a no-op replacement                         → nothing to commit
 *   - an oversized replacement                    → refactor, not a fix
 */
function verifyPatch(fileContent, proposal) {
  if (!proposal || proposal.canFix === false) {
    return { ok: false, reason: proposal?.reason || 'Model could not produce a safe local fix' };
  }

  const original = String(proposal.original ?? '');
  const replacement = String(proposal.replacement ?? '');

  if (!original.trim()) {
    return { ok: false, reason: 'Empty anchor snippet' };
  }

  const occurrences = fileContent.split(original).length - 1;
  if (occurrences === 0) {
    return { ok: false, reason: 'Anchor snippet does not appear in the file — the model did not quote it verbatim' };
  }
  if (occurrences > 1) {
    return { ok: false, reason: `Anchor snippet appears ${occurrences} times — cannot tell which one to patch` };
  }

  if (original === replacement) {
    return { ok: false, reason: 'Replacement is identical to the original' };
  }

  const replacementLines = replacement.split('\n').length;
  if (replacementLines > MAX_REPLACEMENT_LINES) {
    return { ok: false, reason: `Replacement rewrites ${replacementLines} lines — too broad to apply unattended` };
  }

  return { ok: true, original, replacement };
}

function applyPatch(fileContent, original, replacement) {
  return fileContent.replace(original, replacement);
}

// ── Diff rendering (preview only) ─────────────────────────────────────────

/**
 * A small unified-diff renderer for the approval preview.
 *
 * Deliberately not a real diff algorithm: we already know the exact block
 * being replaced, so showing that block removed and the new one added is
 * both accurate and easier to read than a computed LCS diff.
 */
function buildUnifiedDiff(path, original, replacement, startLine) {
  const oldLines = original.split('\n');
  const newLines = replacement.split('\n');

  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`,
    ...oldLines.map(l => `-${l}`),
    ...newLines.map(l => `+${l}`),
  ].join('\n');
}

function lineNumberOf(fileContent, snippet) {
  const idx = fileContent.indexOf(snippet);
  if (idx === -1) return 1;
  return fileContent.slice(0, idx).split('\n').length;
}

// ── Public entry point ────────────────────────────────────────────────────

/**
 * Build a verified, applyable patch for one finding.
 * Returns { applicable: false, reason } rather than throwing — one
 * unfixable finding must never abort the whole batch.
 */
async function generatePatch(octokit, repoInfo, finding, ref) {
  let file;
  try {
    file = await fetchFileContent(octokit, repoInfo, finding.file, ref);
  } catch (error) {
    return { fingerprint: finding.fingerprint, applicable: false, reason: `Could not read file: ${error.message}` };
  }

  const context = sliceContext(file.content, finding.line);
  const proposal = await callGeminiJson(buildFixPrompt(finding, context), {
    temperature: 0.1,          // a fix should be the obvious one, not a creative one
    maxOutputTokens: 1536,
    timeoutMs: 30000,
  });

  if (!proposal) {
    return { fingerprint: finding.fingerprint, applicable: false, reason: 'No response from the model' };
  }

  const verified = verifyPatch(file.content, proposal);
  if (!verified.ok) {
    return { fingerprint: finding.fingerprint, applicable: false, reason: verified.reason };
  }

  const patchedContent = applyPatch(file.content, verified.original, verified.replacement);
  const startLine = lineNumberOf(file.content, verified.original);

  return {
    fingerprint: finding.fingerprint,
    applicable: true,
    file: finding.file,
    fileSha: file.sha,
    title: finding.title,
    severity: finding.severity,
    explanation: String(proposal.explanation || '').trim(),
    requiresImports: Array.isArray(proposal.requiresImports) ? proposal.requiresImports : [],
    original: verified.original,
    replacement: verified.replacement,
    diff: buildUnifiedDiff(finding.file, verified.original, verified.replacement, startLine),
    patchedContent,
  };
}

module.exports = {
  generatePatch,
  verifyPatch,
  applyPatch,
  buildUnifiedDiff,
  fetchFileContent,
  MAX_REPLACEMENT_LINES,
};
