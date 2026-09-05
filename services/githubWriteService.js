// services/githubWriteService.js
//
// Writes review comments back to a GitHub PR using the user's own PAT.
//
// Everything here is built around one rule: THE SERVER DECIDES WHAT GETS
// POSTED, NOT THE CLIENT. The route re-derives findings from its own analysis
// (usually a cache hit) rather than accepting a findings payload over the
// wire — otherwise anyone could make this endpoint post arbitrary text into
// any PR the token can reach.
//
// Idempotency works by embedding an invisible marker carrying the finding's
// fingerprint in every comment body. On a later run we read back the existing
// comments, parse the markers, and skip anything already posted. That is what
// makes "re-review and comment again" safe to click repeatedly.

const { Octokit } = require('@octokit/rest');

// Invisible in rendered Markdown, greppable in the raw body.
const MARKER_PREFIX = 'pr-analyzer:fp=';
const MARKER_RE = /<!--\s*pr-analyzer:fp=([0-9a-f]{6,64})\s*-->/;

// Hard caps. A PR with 200 findings should not produce 200 notifications.
const MAX_INLINE_COMMENTS = 25;
const MAX_BODY_CHARS      = 60000;

const SEVERITY_LABEL = {
  critical: 'CRITICAL',
  high:     'HIGH',
  medium:   'MEDIUM',
  low:      'LOW',
};

const SEVERITY_EMOJI = {
  critical: '🔴',
  high:     '🟠',
  medium:   '🟡',
  low:      '⚪',
};

function createOctokit(token) {
  return new Octokit({
    auth: token,
    request: { timeout: 15000 },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}

// ── Body construction ─────────────────────────────────────────────────────

function marker(fingerprint) {
  return `<!-- ${MARKER_PREFIX}${fingerprint} -->`;
}

// GitHub renders Markdown, so anything interpolated from analyzed source
// could otherwise inject formatting or an image beacon into someone's PR.
// Code goes in a fence; prose gets its control characters stripped.
function safeProse(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/</g, '&lt;')
    .trim();
}

function fence(code) {
  // A snippet containing ``` would break out of the fence.
  const safe = String(code || '').replace(/`{3,}/g, '``');
  return `\`\`\`\n${safe}\n\`\`\``;
}

/** Longest reviewer-supplied rewrite accepted for one comment. */
const MAX_EDIT_CHARS = 1000;

/**
 * Build the inline comment body.
 *
 * `editedDetail` lets a reviewer rephrase or simplify the explanation before
 * it is posted — people write review comments in their team's voice, and a
 * take-it-or-leave-it wall of generated prose gets posted less often than a
 * sentence someone actually wrote.
 *
 * What an edit CANNOT change is deliberate. The severity header, the code
 * snippet, the provenance line and the fingerprint marker are all still built
 * here, from the server's own analysis. So an edit rewords a real finding on a
 * real line; it can never detach a comment from the finding it belongs to,
 * and §4's property that the request body cannot carry arbitrary text into a
 * PR still holds — the text lands in one bounded, escaped, length-capped slot
 * attached to a fingerprint the server itself reported.
 */
function buildInlineBody(finding, editedDetail) {
  const sev = SEVERITY_LABEL[finding.severity] || 'INFO';
  const emoji = SEVERITY_EMOJI[finding.severity] || '⚪';

  const detail = typeof editedDetail === 'string' && editedDetail.trim()
    ? safeProse(editedDetail).slice(0, MAX_EDIT_CHARS)
    : safeProse(finding.detail);

  const lines = [
    `${emoji} **${sev} — ${safeProse(finding.title)}**`,
    '',
    detail,
  ];

  if (finding.suggestion) {
    lines.push('', `**Suggested fix:** ${safeProse(finding.suggestion)}`);
  }

  // Say plainly where the finding came from. A reviewer deciding whether to
  // trust it needs to know if a deterministic rule matched or a model
  // inferred it, and how sure the model was.
  const provenance = finding.source === 'ai'
    ? `AI review · \`${finding.kind}\` · confidence ${Math.round((finding.confidence ?? 0) * 100)}%`
    : `static rule · \`${finding.kind}\``;

  lines.push('', `<sub>🤖 pr-analyzer · ${provenance}</sub>`, marker(finding.fingerprint));

  return lines.join('\n');
}

function buildSummaryBody({ anchored, unanchored, resolvedNow, prHeadSha }) {
  const total = anchored.length + unanchored.length;
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of [...anchored, ...unanchored]) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }

  const lines = ['## 🤖 PR Analyzer review', ''];

  if (total === 0 && resolvedNow.length === 0) {
    lines.push('No risks found in the changed code.');
    return lines.join('\n');
  }

  if (total > 0) {
    const chips = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([sev, n]) => `${SEVERITY_EMOJI[sev]} ${n} ${sev}`)
      .join(' · ');
    lines.push(`**${total} risk${total === 1 ? '' : 's'} found** — ${chips}`, '');

    lines.push('| Severity | Issue | Location |', '|---|---|---|');
    for (const f of [...anchored, ...unanchored].slice(0, 50)) {
      const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      lines.push(`| ${SEVERITY_EMOJI[f.severity]} ${SEVERITY_LABEL[f.severity]} | ${safeProse(f.title)} | ${loc} |`);
    }
    lines.push('');
  }

  // Findings we could not tie to a specific added line are reported here
  // rather than guessed onto one. Posting a comment on the wrong line is
  // worse than posting it in the summary.
  if (unanchored.length > 0) {
    lines.push(
      `<details><summary>${unanchored.length} finding(s) not anchored to a diff line</summary>`,
      '',
      'These could not be tied to a specific added line, so they are listed here instead of inline:',
      '',
    );
    for (const f of unanchored) {
      lines.push(`- **${safeProse(f.title)}** — \`${f.file}\` — ${safeProse(f.detail)}`);
    }
    lines.push('', '</details>', '');
  }

  if (resolvedNow.length > 0) {
    lines.push(
      `### ✅ Fixed since the last review (${resolvedNow.length})`,
      '',
      ...resolvedNow.map(f => `- ~~${safeProse(f.title)}~~ — \`${f.file}\``),
      '',
    );
  }

  if (prHeadSha) {
    lines.push('', `<sub>Reviewed at \`${String(prHeadSha).slice(0, 7)}\`. Re-run to refresh — already-posted findings are never duplicated.</sub>`);
  }

  return lines.join('\n').slice(0, MAX_BODY_CHARS);
}

// ── Reading back what we already posted ───────────────────────────────────

// Returns Map<fingerprint, { id, body, path, line, isResolvedNote }>.
async function fetchPostedFingerprints(octokit, repoInfo) {
  const posted = new Map();

  const [reviewComments, issueComments] = await Promise.all([
    octokit.paginate(octokit.pulls.listReviewComments, {
      owner: repoInfo.owner, repo: repoInfo.repo,
      pull_number: repoInfo.pull_number, per_page: 100,
    }).catch(() => []),
    octokit.paginate(octokit.issues.listComments, {
      owner: repoInfo.owner, repo: repoInfo.repo,
      issue_number: repoInfo.pull_number, per_page: 100,
    }).catch(() => []),
  ]);

  for (const c of [...reviewComments, ...issueComments]) {
    const m = MARKER_RE.exec(c.body || '');
    if (!m) continue;
    posted.set(m[1], {
      id: c.id,
      body: c.body,
      path: c.path || null,
      line: c.line ?? c.original_line ?? null,
      isReviewComment: Boolean(c.path),
      isResolvedNote: /^✅ \*\*Resolved/.test(c.body || ''),
    });
  }

  return posted;
}

// ── Planning (the dry run) ────────────────────────────────────────────────

/**
 * Work out exactly what would be written, without writing anything.
 *
 * Returned verbatim to the client as the dry-run preview, and consumed
 * unchanged by executeCommentPlan — so what the user approves is precisely
 * what gets posted.
 */
/**
 * @param selected  Set of fingerprints the reviewer chose to post inline, or
 *   null for "all of them". Per-comment choice matters because one rewritten
 *   comment often already covers findings below it — posting those anyway is
 *   noise on someone's PR. Deselected findings are NOT lost: they still appear
 *   in the summary table, which stays a complete picture of the analysis.
 */
function buildCommentPlan({
  findings, postedFingerprints, prHeadSha, edits = {}, selected = null,
}) {
  // Only a finding anchored to a real added line may be posted inline.
  // reviewService sets anchored:false and diffPosition:null when it could not
  // verify the position, specifically so it cannot land on the wrong line.
  const anchored = [];
  const unanchored = [];

  for (const f of findings) {
    if (f.anchored && Number.isInteger(f.diffPosition) && f.diffPosition > 0) anchored.push(f);
    else unanchored.push(f);
  }

  const currentFingerprints = new Set(findings.map(f => f.fingerprint));

  const newInline = [];
  const alreadyPosted = [];
  const deselected = [];

  for (const f of anchored) {
    if (postedFingerprints.has(f.fingerprint)) alreadyPosted.push(f);
    else if (selected && !selected.has(f.fingerprint)) deselected.push(f);
    else newInline.push(f);
  }

  // A fingerprint we previously commented on that is no longer reported has
  // been fixed. Mark the existing comment rather than leaving stale advice.
  const toMarkResolved = [];
  for (const [fp, comment] of postedFingerprints) {
    if (currentFingerprints.has(fp)) continue;
    if (comment.isResolvedNote) continue;      // already marked
    if (!comment.isReviewComment) continue;    // summary comment, not a finding
    toMarkResolved.push({ fingerprint: fp, commentId: comment.id, body: comment.body });
  }

  const truncated = Math.max(0, newInline.length - MAX_INLINE_COMMENTS);
  const inlineToPost = newInline.slice(0, MAX_INLINE_COMMENTS);

  const summaryBody = buildSummaryBody({
    anchored,
    unanchored,
    resolvedNow: toMarkResolved.map(r => ({
      title: extractTitleFromBody(r.body),
      file: extractPathFromBody(r.body),
    })),
    prHeadSha,
  });

  // A review posted for a CHOSEN SUBSET must not carry the full summary table.
  // Posting 16 findings one at a time attached the whole 16-row summary to
  // every one of them, so the PR ended up with the same table repeated 16
  // times. A partial review gets a one-line body naming what it contains.
  const isPartial = selected !== null;
  const reviewBody = isPartial
    ? `🤖 **PR Analyzer** — ${inlineToPost.length} finding${inlineToPost.length === 1 ? '' : 's'} posted individually. `
      + 'Run the full review for the complete summary.'
    : summaryBody;

  return {
    isPartial,
    reviewBody,
    inlineComments: inlineToPost.map(f => ({
      path: f.file,
      position: f.diffPosition,
      body: buildInlineBody(f, edits[f.fingerprint]),
      fingerprint: f.fingerprint,
      severity: f.severity,
      title: f.title,
      line: f.line,
      // The original wording, so the UI can offer "reset" and show what was
      // changed. Never used for the posted body — that is `body` above.
      defaultDetail: f.detail,
      edited: typeof edits[f.fingerprint] === 'string' && !!edits[f.fingerprint].trim(),
    })),
    summaryBody,
    resolutions: toMarkResolved,
    skipped: {
      alreadyPosted: alreadyPosted.map(f => ({ fingerprint: f.fingerprint, title: f.title })),
      unanchored: unanchored.map(f => ({ fingerprint: f.fingerprint, title: f.title, file: f.file })),
      deselected: deselected.map(f => ({ fingerprint: f.fingerprint, title: f.title })),
      truncated,
    },
    counts: {
      willPostInline: inlineToPost.length,
      willMarkResolved: toMarkResolved.length,
      alreadyPosted: alreadyPosted.length,
      unanchored: unanchored.length,
      deselected: deselected.length,
      truncated,
    },
  };
}

function extractTitleFromBody(body) {
  const m = /\*\*(?:CRITICAL|HIGH|MEDIUM|LOW|INFO) — (.+?)\*\*/.exec(body || '');
  return m ? m[1] : 'previous finding';
}

function extractPathFromBody() {
  return '';
}

// ── Execution ─────────────────────────────────────────────────────────────

/**
 * Apply a plan produced by buildCommentPlan.
 *
 * Inline comments go out as ONE review rather than N individual comments:
 * a single notification for the author instead of a mailbox full, and it
 * either lands or it doesn't.
 */
/**
 * True when the plan has nothing the PR does not already carry: no new inline
 * comment, nothing to mark resolved, and at least one finding skipped because
 * it was already posted.
 *
 * Without this, retrying a comment that is already on the PR posted ANOTHER
 * summary comment each time — the one action guaranteed to add noise while
 * changing nothing. An unanchored-only plan is different: there the summary IS
 * how the finding gets delivered, so it must still post.
 */
function nothingNewToSay(plan) {
  return plan.inlineComments.length === 0
    && plan.resolutions.length === 0
    && (plan.counts.alreadyPosted || 0) > 0
    && (plan.counts.unanchored || 0) === 0;
}

async function executeCommentPlan(octokit, repoInfo, plan, { prHeadSha } = {}) {
  const result = { postedInline: 0, postedSummary: false, markedResolved: 0, errors: [] };

  if (plan.inlineComments.length > 0) {
    try {
      await octokit.pulls.createReview({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        pull_number: repoInfo.pull_number,
        commit_id: prHeadSha || undefined,
        event: 'COMMENT',       // never REQUEST_CHANGES — a bot must not block a merge
        body: plan.reviewBody ?? plan.summaryBody,
        comments: plan.inlineComments.map(c => ({
          path: c.path,
          position: c.position,
          body: c.body,
        })),
      });
      result.postedInline = plan.inlineComments.length;
      result.postedSummary = true;
    } catch (error) {
      // Positions can go stale if the PR was pushed to between analysis and
      // posting. Fall back to the summary alone rather than losing the review.
      result.errors.push(`inline review failed: ${error.message}`);
      try {
        await octokit.issues.createComment({
          owner: repoInfo.owner, repo: repoInfo.repo,
          issue_number: repoInfo.pull_number,
          body: `${plan.summaryBody}\n\n<sub>⚠️ Inline comments could not be placed (the diff moved since analysis). Findings are listed above instead.</sub>`,
        });
        result.postedSummary = true;
      } catch (fallbackError) {
        result.errors.push(`summary fallback failed: ${fallbackError.message}`);
      }
    }
  } else if (plan.summaryBody && !nothingNewToSay(plan)) {
    try {
      await octokit.issues.createComment({
        owner: repoInfo.owner, repo: repoInfo.repo,
        issue_number: repoInfo.pull_number,
        body: plan.summaryBody,
      });
      result.postedSummary = true;
    } catch (error) {
      result.errors.push(`summary failed: ${error.message}`);
    }
  } else if (plan.summaryBody) {
    // Everything selected is already on the PR. Posting the summary anyway
    // added a duplicate summary comment on every retry.
    result.skippedAsAlreadyPosted = true;
  }

  for (const res of plan.resolutions) {
    try {
      await octokit.pulls.updateReviewComment({
        owner: repoInfo.owner, repo: repoInfo.repo,
        comment_id: res.commentId,
        body: `✅ **Resolved** — this no longer appears as of \`${String(prHeadSha || '').slice(0, 7)}\`.\n\n<details><summary>Original finding</summary>\n\n${res.body}\n\n</details>`,
      });
      result.markedResolved += 1;
    } catch (error) {
      result.errors.push(`resolve ${res.fingerprint}: ${error.message}`);
    }
  }

  return result;
}

/** Confirm the token can actually write here before promising the user it can. */
/**
 * Is this token authenticated and able to see this repository?
 *
 * Commenting on a PUBLIC pull request needs authentication but NOT push
 * access — that is how open-source review works: anyone can review a public
 * PR. Requiring push here (as this route used to, via checkWriteAccess) locked
 * out exactly the person the feature is for: a reviewer on someone else's repo.
 *
 * DELIBERATELY NOT `GET /user` (octokit.users.getAuthenticated). A classic PAT
 * (`ghp_…`) can call it freely, but a fine-grained PAT (`github_pat_…`)
 * scoped only to a repository's Contents/Pull-requests permissions CANNOT —
 * that endpoint needs a separate ACCOUNT-level permission
 * ("Read access to account profile") that has nothing to do with commenting
 * on a PR and that most people scoping a token to "just this repo" never
 * grant. Calling it here would reject a perfectly good, correctly-scoped
 * fine-grained token with a confusing 401 — which is exactly what happened.
 *
 * `repos.get` on the PR's own repo checks the one thing that actually matters
 * — can this token authenticate and read this repo — using only "Metadata:
 * read-only", the ONE permission every fine-grained PAT carries unconditionally
 * for any repository it is scoped to. It cannot be unchecked, so this call
 * works for both token types and never demands a permission commenting does
 * not need.
 */
async function checkIdentity(octokit, repoInfo) {
  try {
    await octokit.repos.get({ owner: repoInfo.owner, repo: repoInfo.repo });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Push access. Required for COMMITTING a fix (§6), which writes to the PR's
 * head branch. NOT required for commenting — see checkIdentity.
 */
async function checkWriteAccess(octokit, repoInfo) {
  try {
    const { data } = await octokit.repos.get({ owner: repoInfo.owner, repo: repoInfo.repo });
    const perms = data.permissions || {};
    return {
      canWrite: Boolean(perms.push || perms.maintain || perms.admin),
      permissions: perms,
    };
  } catch (error) {
    return { canWrite: false, error: error.message };
  }
}

module.exports = {
  MAX_EDIT_CHARS,
  createOctokit,
  checkIdentity,
  fetchPostedFingerprints,
  buildCommentPlan,
  executeCommentPlan,
  checkWriteAccess,
  buildInlineBody,
  buildSummaryBody,
  MARKER_RE,
  MAX_INLINE_COMMENTS,
};
