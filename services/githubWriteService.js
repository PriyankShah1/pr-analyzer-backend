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

// The summary carries no fingerprint marker, so its presence is detected by
// its heading. That matters: whether the PR CURRENTLY has a summary is a
// different question from whether we ever posted one, and only the first can
// tell a deleted summary apart from a duplicate about to be created.
const SUMMARY_HEADING = '## 🤖 PR Analyzer review';
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

  const lines = [SUMMARY_HEADING, ''];

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
/**
 * What our previous reviews left on this PR: which findings are commented on,
 * and whether the summary is still there.
 *
 * One pass, because both answers come from the same two comment lists and the
 * plan needs them together.
 */
async function fetchPostedState(octokit, repoInfo) {
  const posted = await fetchPostedFingerprints(octokit, repoInfo);
  const hasSummary = await hasSummaryComment(octokit, repoInfo);
  return { posted, hasSummary };
}

/**
 * Every summary we have already put on this PR.
 *
 * A summary can live in TWO places and they are different API surfaces:
 *
 *   - the BODY of a review, when it was posted alongside inline comments
 *     (pulls.createReview) — visible via pulls.listReviews
 *   - a standalone issue comment, when there was nothing to post inline
 *     (issues.createComment) — visible via issues.listComments
 *
 * Checking only the second is why the tool could not see its own summaries and
 * kept adding more: the ones it had posted with inline comments were invisible
 * to it.
 */
async function findSummaryComments(octokit, repoInfo) {
  const found = [];

  const [reviews, issueComments] = await Promise.all([
    octokit.paginate(octokit.pulls.listReviews, {
      owner: repoInfo.owner, repo: repoInfo.repo,
      pull_number: repoInfo.pull_number, per_page: 100,
    }).catch(() => []),
    octokit.paginate(octokit.issues.listComments, {
      owner: repoInfo.owner, repo: repoInfo.repo,
      issue_number: repoInfo.pull_number, per_page: 100,
    }).catch(() => []),
  ]);

  for (const r of reviews) {
    if (String(r.body || '').includes(SUMMARY_HEADING)) {
      found.push({ kind: 'review', id: r.id, url: r.html_url || null });
    }
  }
  for (const c of issueComments) {
    if (String(c.body || '').includes(SUMMARY_HEADING)) {
      found.push({ kind: 'issue', id: c.id, url: c.html_url || null });
    }
  }
  return found;
}

/** Is our summary comment currently on the PR? */
async function hasSummaryComment(octokit, repoInfo) {
  try {
    return (await findSummaryComments(octokit, repoInfo)).length > 0;
  } catch {
    // Cannot tell. Assume it is there rather than risk posting a duplicate:
    // a missing summary is a smaller problem than two of them.
    return true;
  }
}

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
      // A direct link to the comment on GitHub. An inline review comment lives
      // on the Files-changed tab, so "3 marked resolved" was unverifiable
      // without hunting through the whole diff for it.
      url: c.html_url || null,
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
  hasSummary = true,
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
  const alreadyResolved = [];
  for (const [fp, comment] of postedFingerprints) {
    if (currentFingerprints.has(fp)) continue;
    if (comment.isResolvedNote) {
      // Marked on an earlier run. Reported so the UI can point at it, rather
      // than only counting it.
      alreadyResolved.push({
        fingerprint: fp,
        title: extractTitleFromBody(comment.body),
        path: comment.path || null,
        url: comment.url || null,
      });
      continue;
    }
    if (!comment.isReviewComment) continue;    // summary comment, not a finding
    toMarkResolved.push({
      fingerprint: fp,
      commentId: comment.id,
      body: comment.body,
      // Carried so the dry run can NAME what it will edit. "3 will be marked
      // resolved" is not something a reviewer can check before authorising an
      // edit to comments already on their PR.
      title: extractTitleFromBody(comment.body),
      path: comment.path || null,
      url: comment.url || null,
    });
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
  const planHasSummary = hasSummary;
  const isPartial = selected !== null;
  const reviewBody = isPartial
    ? `🤖 **PR Analyzer** — ${inlineToPost.length} finding${inlineToPost.length === 1 ? '' : 's'} posted individually. `
      + 'Run the full review for the complete summary.'
    : summaryBody;

  return {
    isPartial,
    hasSummary: planHasSummary,
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
      alreadyResolved,
      truncated,
    },
    counts: {
      willPostInline: inlineToPost.length,
      willMarkResolved: toMarkResolved.length,
      alreadyPosted: alreadyPosted.length,
      unanchored: unanchored.length,
      deselected: deselected.length,
      alreadyResolved: alreadyResolved.length,
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
 * True when a summary comment would add nothing the PR does not already carry.
 *
 * The summary exists to introduce findings. It is posted as the BODY of the
 * review that carries new inline comments, and separately only when a finding
 * has no other way to reach the PR. Two cases must not post one:
 *
 *   - Retrying a comment already on the PR. Nothing changed, so another
 *     summary is pure noise.
 *   - Marking findings resolved. The resolution is already visible on the
 *     comments themselves, which get edited in place; a second full table
 *     repeating the previous review's contents just buries them.
 *
 * An unanchored-only plan is different: there the summary IS how the finding
 * gets delivered, so it must still post. So must a genuine first review, where
 * the PR carries nothing of ours yet.
 */
function nothingNewToSay(plan) {
  const nothingNewInline = plan.inlineComments.length === 0;
  const nothingOnlyDeliverableBySummary = (plan.counts.unanchored || 0) === 0;
  const prAlreadyHasOurComments =
    (plan.counts.alreadyPosted || 0) > 0 || plan.resolutions.length > 0;

  // If the summary is GONE from the PR — deleted by hand, say — posting one
  // is not a duplicate, it is a restore. Keying this off "did we ever post?"
  // instead of "is one there now?" made a deleted summary unrecoverable.
  const prStillHasOurSummary = plan.hasSummary !== false;

  return nothingNewInline
    && nothingOnlyDeliverableBySummary
    && prAlreadyHasOurComments
    && prStillHasOurSummary;
}

// ── Native "Resolve conversation" ────────────────────────────────────────
//
// GitHub's own resolve marks the thread resolved and COLLAPSES it, which is
// what a reviewer means by "this is handled". Editing the comment body to say
// "Resolved" only approximated that: the thread stayed open and expanded, the
// conversation count never moved, and the original finding had to be pushed
// into a <details> to make room for the notice.
//
// There is no REST endpoint for it — resolving a review thread exists only in
// GraphQL — which is why the first implementation reached for a body edit.

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 20) { nodes { body } }
          }
        }
      }
    }
  }
`;

const RESOLVE_THREAD_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

/**
 * Map fingerprint -> review thread, so a finding can be tied to the thread
 * that carries it. Returns an empty Map when GraphQL is unavailable, letting
 * callers fall back rather than fail.
 */
async function fetchReviewThreads(octokit, repoInfo) {
  const byFingerprint = new Map();
  if (typeof octokit.graphql !== 'function') return byFingerprint;

  try {
    const data = await octokit.graphql(REVIEW_THREADS_QUERY, {
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      number: repoInfo.pull_number,
    });

    const threads = data?.repository?.pullRequest?.reviewThreads?.nodes || [];
    for (const thread of threads) {
      for (const c of thread?.comments?.nodes || []) {
        const m = MARKER_RE.exec(c?.body || '');
        if (m && !byFingerprint.has(m[1])) {
          byFingerprint.set(m[1], { id: thread.id, isResolved: !!thread.isResolved });
        }
      }
    }
  } catch {
    // No GraphQL access, or the schema moved. The caller falls back to editing
    // the comment body, which is worse but still communicates the outcome.
  }

  return byFingerprint;
}

async function resolveReviewThread(octokit, threadId) {
  await octokit.graphql(RESOLVE_THREAD_MUTATION, { threadId });
}

/**
 * Put the summary on the PR: refresh the one already there, or add one if
 * there is none.
 *
 * Both callers need this — the normal no-inline path AND the fallback after an
 * inline review is rejected — and having two copies of the logic is how the
 * fallback ended up able to create a duplicate the other path avoided.
 */
async function publishSummary(octokit, repoInfo, body, existingSummaries, result) {
  const existing = existingSummaries || [];

  if (existing.length > 0) {
    for (const sum of existing) {
      try {
        if (sum.kind === 'review') {
          await octokit.pulls.updateReview({
            owner: repoInfo.owner, repo: repoInfo.repo,
            pull_number: repoInfo.pull_number,
            review_id: sum.id,
            body,
          });
        } else {
          await octokit.issues.updateComment({
            owner: repoInfo.owner, repo: repoInfo.repo,
            comment_id: sum.id,
            body,
          });
        }
        result.updatedSummaries += 1;
      } catch (error) {
        result.errors.push(`summary update failed: ${error.message}`);
      }
    }
    if (result.updatedSummaries > 0) result.postedSummary = true;
    return;
  }

  try {
    await octokit.issues.createComment({
      owner: repoInfo.owner, repo: repoInfo.repo,
      issue_number: repoInfo.pull_number,
      body,
    });
    result.postedSummary = true;
  } catch (error) {
    result.errors.push(`summary failed: ${error.message}`);
  }
}

async function executeCommentPlan(octokit, repoInfo, plan, { prHeadSha, existingSummaries } = {}) {
  const result = {
    postedInline: 0, postedSummary: false, updatedSummaries: 0,
    // markedResolved is the total handled; the two below say HOW, since
    // resolving the thread and editing the body look very different on the PR.
    markedResolved: 0, resolvedThreads: 0, editedComments: 0,
    errors: [],
  };

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
  } else if (plan.summaryBody) {
    // A summary already on the PR is UPDATED, never duplicated.
    //
    // It was previously written once and never touched again, so it kept
    // saying "16 risks found, reviewed at <old sha>" long after three of them
    // were fixed — the most prominent thing on the PR, permanently wrong.
    // Refreshing it in place is both the fix for that and the reason a second
    // one is never needed.
    const existing = existingSummaries || [];

    // Refresh what is there. Only skip entirely when there is nothing on the
    // PR to refresh AND nothing new worth adding.
    if (existing.length > 0 || !nothingNewToSay(plan)) {
      await publishSummary(octokit, repoInfo, plan.summaryBody, existing, result);
    } else {
      result.skippedAsAlreadyPosted = true;
    }
  }

  // Prefer GitHub's own "Resolve conversation": it marks the thread resolved
  // and COLLAPSES it, which is what "handled" looks like to a reviewer, and it
  // leaves the original finding intact. Editing the body only approximated
  // that — the thread stayed open, the conversation count never moved, and the
  // finding had to be pushed into a <details> to make room for the notice.
  //
  // Resolving a thread exists only in GraphQL, so a body edit remains the
  // fallback for when that is unavailable.
  const threads = plan.resolutions.length > 0
    ? await fetchReviewThreads(octokit, repoInfo)
    : new Map();

  for (const res of plan.resolutions) {
    const thread = threads.get(res.fingerprint);

    if (thread && thread.isResolved) {
      result.markedResolved += 1;   // resolved on an earlier run; nothing to do
      continue;
    }

    if (thread) {
      try {
        await resolveReviewThread(octokit, thread.id);
        result.resolvedThreads += 1;
        result.markedResolved += 1;
        continue;
      } catch (error) {
        // Fall through to the body edit rather than losing the outcome.
        result.errors.push(`resolve thread ${res.fingerprint}: ${error.message}`);
      }
    }

    try {
      await octokit.pulls.updateReviewComment({
        owner: repoInfo.owner, repo: repoInfo.repo,
        comment_id: res.commentId,
        body: `✅ **Resolved** — this no longer appears as of \`${String(prHeadSha || '').slice(0, 7)}\`.\n\n<details><summary>Original finding</summary>\n\n${res.body}\n\n</details>`,
      });
      result.editedComments += 1;
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
  fetchPostedState,
  hasSummaryComment,
  findSummaryComments,
  fetchReviewThreads,
  resolveReviewThread,
  extractTitleFromBody,
  SUMMARY_HEADING,
  fetchPostedFingerprints,
  buildCommentPlan,
  executeCommentPlan,
  checkWriteAccess,
  buildInlineBody,
  buildSummaryBody,
  MARKER_RE,
  MAX_INLINE_COMMENTS,
};
