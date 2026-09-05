// routes/comment.js
// POST /comment — post analyzer findings to a GitHub PR as review comments.
//
// Safety model, in order of importance:
//
//   1. DRY RUN IS THE DEFAULT. A request without `confirm: true` returns the
//      exact plan and writes nothing. The client must show that plan and get
//      a deliberate confirmation before sending the real one.
//
//   2. THE SERVER PICKS THE CONTENT. Findings are re-derived from this
//      server's own analysis, never accepted from the request body. Otherwise
//      the endpoint would post arbitrary attacker-supplied text into any PR
//      the supplied token can reach.
//
//   3. THE TOKEN IS AUTHENTICATED FIRST, so a bad token gives a clear message
//      instead of a confusing 401 from deep in the API. Note this checks
//      IDENTITY, not push access: GitHub lets any authenticated user comment
//      on a public PR, and demanding push rights would lock out the reviewer
//      this feature exists for. Committing a fix does require push — that
//      check lives in routes/commit.js.

const express = require('express');
const router  = express.Router();

const { rateLimit }        = require('../middleware/rateLimit');
const { parsePR }          = require('../utils/validation');
const { getCached, setCached } = require('../services/cacheService');
const { fetchPRDetails }   = require('../services/githubService');
const { analyzeFiles }     = require('../services/analysisService');
const { generateReview }   = require('../services/reviewService');
const { buildGraphFindings } = require('../services/graphFindings');
const { handleGitHubError } = require('./errorHandler');
const {
  createOctokit, fetchPostedState, buildCommentPlan,
  executeCommentPlan, checkIdentity,
} = require('../services/githubWriteService');
const { isDemoPR, getDemoPRDetails } = require('../fixtures/demoPR');
const { createDemoOctokit, DEMO_CONFIRM_REFUSAL } = require('../fixtures/demoGithub');

// Re-derive the risk list for a PR, reusing the analyze cache when possible
// so confirming a dry run doesn't pay for a second full analysis.
// `wantsReview` must match the flag the ANALYSIS ran with. The server decides
// what gets posted (that is the §4 safety property), but it must decide the
// same content the reviewer approved in the dry run — re-deriving with the AI
// review on would post findings the user never saw. It also keeps reviewed
// output out of the unreviewed cache key.
async function deriveRisks(url, repoInfo, token, wantsReview = false) {
  const cacheKey = wantsReview ? `pr:${url}:review` : `pr:${url}`;
  const cached = getCached(cacheKey);
  if (cached?.risks && cached.prHeadSha) {
    return { risks: cached.risks, prHeadSha: cached.prHeadSha, fromCache: true };
  }

  const { prTitle, prNumber, prAuthor, prState, prMerged,
          prHeadSha, prBaseSha, prRepo, prCommits, files } =
    isDemoPR(repoInfo) ? getDemoPRDetails() : await fetchPRDetails(repoInfo, token);

  const prMeta = { prTitle, prNumber, prAuthor, prState, prMerged,
                   prHeadSha, prBaseSha, prRepo, prCommits, prUrl: url };

  const result = analyzeFiles(files, prMeta);

  const aiFindings = wantsReview
    ? await generateReview({
        prTitle:      result.prTitle,
        codeLanguage: result.language,
        files,
        flows:        result.flows,
        sqlFindings:  result.sqlFindings,
      })
    : [];

  // Must match routes/analyze.js exactly, or the dry run would preview a
  // different set than the confirm posts.
  const graphFindings = buildGraphFindings(result.flows, files);

  const risks = [...(result.sqlFindings || []), ...graphFindings, ...aiFindings]
    .sort((a, b) => a.severityRank - b.severityRank || b.confidence - a.confidence);

  result.aiFindings = aiFindings;
  result.risks = risks;
  setCached(cacheKey, result);

  return { risks, prHeadSha, fromCache: false };
}

router.post('/', rateLimit, async (req, res) => {
  const { url, token, confirm, aiReview, edits, fingerprints } = req.body || {};

  let repoInfo;
  try {
    repoInfo = parsePR(url);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  // The demo needs no token — having to paste a PAT to see a dry run would
  // defeat the point of a fixture. It can never be confirmed, though: there
  // is no real PR behind it.
  const demo = isDemoPR(repoInfo);

  if (demo && confirm === true) {
    return res.status(400).json(DEMO_CONFIRM_REFUSAL);
  }

  if (!demo && (!token || typeof token !== 'string' || !token.trim())) {
    return res.status(401).json({
      error: 'A GitHub token with write access is required to post comments.',
    });
  }

  try {
    const octokit = demo ? createDemoOctokit() : createOctokit(token.trim());

    // Identity, not push access. Commenting on a public PR needs a valid
    // token so GitHub knows who is speaking; it does NOT need push rights.
    // Requiring those blocked the ordinary case: reviewing someone else's
    // open-source PR. Committing a fix still requires push (routes/commit.js).
    const identity = demo ? { ok: true } : await checkIdentity(octokit, repoInfo);
    if (!identity.ok) {
      return res.status(401).json({
        error: 'That token could not read this repository on GitHub. Check it has not '
          + 'expired, is spelled correctly, and — for a fine-grained token — is scoped '
          + 'to this repository (a classic token needs `public_repo`).',
        detail: identity.error || null,
      });
    }

    const { risks, prHeadSha } = await deriveRisks(url, repoInfo, demo ? undefined : token.trim(), aiReview === true);
    const { posted: postedFingerprints, hasSummary } = await fetchPostedState(octokit, repoInfo);
    // Reviewer rewrites, keyed by fingerprint. Only edits for findings THIS
    // server just derived are honoured — an unknown key is dropped, so the
    // request body cannot introduce a comment that has no finding behind it.
    const knownFingerprints = new Set(risks.map(r => r.fingerprint));
    const safeEdits = {};
    if (edits && typeof edits === 'object' && !Array.isArray(edits)) {
      for (const [fp, text] of Object.entries(edits)) {
        if (knownFingerprints.has(fp) && typeof text === 'string') safeEdits[fp] = text;
      }
    }

    // Which findings the reviewer chose to post inline. Absent means all — so
    // an older client that does not send a selection behaves exactly as before.
    // Unknown ids are ignored rather than erroring: the analysis may have moved
    // on since the dry run, and a stale id is not worth failing the whole post.
    const selected = Array.isArray(fingerprints)
      ? new Set(fingerprints.filter(fp => typeof fp === 'string' && knownFingerprints.has(fp)))
      : null;

    const plan = buildCommentPlan({
      findings: risks, postedFingerprints, prHeadSha, edits: safeEdits, selected,
      hasSummary,
    });

    // An explicit EMPTY selection means "post nothing inline". Treating it as
    // "post everything" would post comments the reviewer just unticked.
    //
    // Resolutions are the exception: marking a previously-posted finding as
    // fixed is a write with nothing to select, so refusing an empty selection
    // made that path unreachable whenever every current finding was already
    // commented on — which is exactly the state a PR reaches after the fixes
    // land.
    if (selected && selected.size === 0 && confirm === true
        && plan.resolutions.length === 0) {
      return res.status(400).json({
        error: 'No comments selected. Tick at least one finding to post, or cancel.',
      });
    }

    // Dry run — return the plan verbatim and write nothing.
    if (confirm !== true) {
      return res.json({
        dryRun: true,
        prHeadSha,
        plan: {
          // The exact bodies that would be posted, so the preview is editable
          // and what the reviewer approves is literally what gets written.
          inlineComments: plan.inlineComments,
          summaryBody: plan.summaryBody,
          // Titles too: "3 will be marked resolved" is not checkable, and the
          // reviewer is about to authorise an edit to comments already on the PR.
          resolutions: plan.resolutions.map(r => ({
            fingerprint: r.fingerprint,
            title: r.title,
            path: r.path,
          })),
          skipped: plan.skipped,
          counts: plan.counts,
        },
        // Say exactly what will happen, including whether a summary posts.
        // "Would post 0 inline comment(s), 1 summary, and mark 3 as resolved"
        // promised a summary that is now correctly skipped, and buried the one
        // thing actually happening.
        message: (() => {
          const posts = plan.counts.willPostInline;
          const marks = plan.counts.willMarkResolved;
          if (posts === 0 && marks === 0) {
            // Terse is not the same as helpful. Report what IS on the PR, so
            // "nothing to do" reads as a finished state rather than a refusal.
            const already = plan.counts.alreadyPosted || 0;
            const resolvedAlready = [...postedFingerprints.values()]
              .filter(c => c.isResolvedNote).length;
            const parts = [];
            if (already) parts.push(`${already} finding${already === 1 ? '' : 's'} already commented on`);
            if (resolvedAlready) parts.push(`${resolvedAlready} already marked resolved`);
            return parts.length
              ? `Everything is already on the PR — ${parts.join(', ')}. Nothing left to write.`
              : 'Nothing to post — no finding in this analysis can be anchored to a diff line.';
          }
          if (posts === 0) {
            return `Nothing new to post. ${marks} finding${marks === 1 ? '' : 's'} `
              + `${marks === 1 ? 'has' : 'have'} been fixed — their existing comments will be `
              + 'marked resolved in place.';
          }
          const parts = [`${posts} inline comment${posts === 1 ? '' : 's'}`, 'a summary'];
          const tail = marks > 0 ? `, and ${marks} marked resolved` : '';
          return `Would post ${parts.join(' and ')}${tail}.`;
        })(),
      });
    }

    const outcome = await executeCommentPlan(octokit, repoInfo, plan, { prHeadSha });

    // "Already on the PR" is a SUCCESS, not a failure. fetchPostedFingerprints
    // only returns a fingerprint it read back out of a real comment body on
    // GitHub, so its presence proves the comment is there. Reporting that as
    // "nothing was posted" told the user their comment had failed when it had
    // in fact worked.
    const alreadyPosted = plan.skipped.alreadyPosted || [];

    const wroteSomething = outcome.postedInline > 0
      || outcome.postedSummary
      || outcome.markedResolved > 0
      || alreadyPosted.length > 0;

    // executeCommentPlan collects GitHub's errors instead of throwing, so that
    // one failed inline comment cannot lose the whole review. That is right,
    // but the route used to return 200 with "Posted 0 inline comment(s)" and
    // DROP outcome.errors — so a rejected write looked identical to a
    // successful one and the actual reason never left the server.
    if (!wroteSomething) {
      return res.status(502).json({
        error: outcome.errors[0]
          ? `GitHub rejected the write: ${outcome.errors[0]}`
          : 'Nothing was written and GitHub reported no reason.',
        // The overwhelmingly common cause, and the least obvious one: a
        // fine-grained token created with Repository access = "Public
        // repositories" is READ-ONLY by definition. GitHub does not even show
        // a Repository permissions section for it, so there is no setting to
        // change and nothing on screen says why writes fail.
        detail: 'Fine-grained token: Repository access must be "Only select repositories" '
          + '(or "All repositories") and include this repo — "Public repositories" is '
          + 'read-only and can never post, which is why no Repository permissions section '
          + 'appears for it. Then set Pull requests: Read and write. '
          + 'Classic token: needs the repo scope (or public_repo for public repositories).',
        errors: outcome.errors,
        posted: outcome,
      });
    }

    return res.json({
      dryRun: false,
      prHeadSha,
      posted: outcome,
      counts: plan.counts,
      // Which findings were skipped because the PR already carries them, so
      // the client can mark those rows done rather than failed.
      alreadyPosted,
      // Partial failures are reported, not hidden: some comments can land while
      // others are rejected for a stale position.
      errors: outcome.errors.length > 0 ? outcome.errors : undefined,
      message: outcome.postedInline === 0 && alreadyPosted.length > 0
        ? `Already on this PR — ${alreadyPosted.length} finding(s) were commented on previously, so nothing was duplicated.`
        : `Posted ${outcome.postedInline} inline comment(s)`
        + `${outcome.postedSummary ? ' and a summary' : ''}`
        + `${outcome.markedResolved ? `, marked ${outcome.markedResolved} resolved` : ''}.`
        + `${outcome.errors.length > 0 ? ` ${outcome.errors.length} failed — see errors.` : ''}`,
    });

  } catch (error) {
    return handleGitHubError(error, res);
  }
});

module.exports = router;
