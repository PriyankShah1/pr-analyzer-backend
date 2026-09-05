// routes/commit.js
// POST /commit — generate fixes for findings and, on explicit approval,
// commit them to the PR's branch.
//
// This is the most destructive thing the tool can do, so the guards are
// deliberately heavy:
//
//   1. DRY RUN IS THE DEFAULT. Without `confirm: true` it returns patches and
//      diffs and writes nothing.
//   2. THE CLIENT NAMES FINDINGS, NOT CONTENT. It sends fingerprints; the
//      server re-derives the findings and generates the code itself. The
//      request body can never carry code that ends up committed.
//   3. EVERY PATCH IS VERIFIED before it is offered — anchor must exist
//      exactly once, replacement must differ, size must stay small.
//   4. ONE ATOMIC COMMIT via the Git Data API. Either every fix lands or
//      none does; no half-applied state.
//   5. FORK PRs ARE REFUSED rather than silently committing somewhere else.

const express = require('express');
const router  = express.Router();

const { rateLimit }        = require('../middleware/rateLimit');
const { parsePR }          = require('../utils/validation');
const { getCached, setCached, invalidateCached } = require('../services/cacheService');
const { fetchPRDetails }   = require('../services/githubService');
const { analyzeFiles }     = require('../services/analysisService');
const { generateReview }   = require('../services/reviewService');
const { buildGraphFindings } = require('../services/graphFindings');
const { generatePatch }    = require('../services/patchService');
const { createOctokit, checkWriteAccess } = require('../services/githubWriteService');
const { isDemoPR, getDemoPRDetails } = require('../fixtures/demoPR');
const { createDemoOctokit, DEMO_CONFIRM_REFUSAL } = require('../fixtures/demoGithub');
const { handleGitHubError } = require('./errorHandler');

// Committing several files at once is bounded so one click cannot rewrite
// half a repository.
const MAX_FIXES_PER_COMMIT = 10;

// `wantsReview` must match the flag the ANALYSIS ran with. The server decides
// what gets posted (that is the §4 safety property), but it must decide the
// same content the reviewer approved in the dry run — re-deriving with the AI
// review on would post findings the user never saw. It also keeps reviewed
// output out of the unreviewed cache key.
async function deriveRisks(url, repoInfo, token, wantsReview = false) {
  const cacheKey = wantsReview ? `pr:${url}:review` : `pr:${url}`;
  const cached = getCached(cacheKey);
  if (cached?.risks && cached.prHeadSha) return cached.risks;

  const { prTitle, prNumber, prAuthor, prState, prMerged,
          prHeadSha, prBaseSha, prRepo, prCommits, files } =
    isDemoPR(repoInfo) ? getDemoPRDetails() : await fetchPRDetails(repoInfo, token);

  const result = analyzeFiles(files, {
    prTitle, prNumber, prAuthor, prState, prMerged,
    prHeadSha, prBaseSha, prRepo, prCommits, prUrl: url,
  });

  const aiFindings = wantsReview
    ? await generateReview({
        prTitle: result.prTitle, codeLanguage: result.language,
        files, flows: result.flows, sqlFindings: result.sqlFindings,
      })
    : [];

  result.aiFindings = aiFindings;
  // Must match routes/analyze.js exactly, or the dry run would preview a
  // different set than the confirm posts.
  result.graphFindings = buildGraphFindings(result.flows, files);

  result.risks = [...(result.sqlFindings || []), ...result.graphFindings, ...aiFindings]
    .sort((a, b) => a.severityRank - b.severityRank || b.confidence - a.confidence);

  setCached(cacheKey, result);
  return result.risks;
}

/**
 * Create ONE commit containing every patched file.
 *
 * Uses the Git Data API rather than repeated contents-API writes: that would
 * make a commit per file and could leave the branch half-fixed if a later
 * write failed. Here the tree is built first and the ref moves once.
 */
async function commitFixes(octokit, headRepo, branch, patches, message) {
  const [owner, repo] = headRepo.split('/');

  const { data: ref } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const baseCommitSha = ref.object.sha;

  const { data: baseCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: baseCommitSha });

  const blobs = await Promise.all(patches.map(async p => {
    const { data: blob } = await octokit.git.createBlob({
      owner, repo,
      content: Buffer.from(p.patchedContent, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    return { path: p.file, mode: '100644', type: 'blob', sha: blob.sha };
  }));

  const { data: tree } = await octokit.git.createTree({
    owner, repo, base_tree: baseCommit.tree.sha, tree: blobs,
  });

  const { data: commit } = await octokit.git.createCommit({
    owner, repo, message, tree: tree.sha, parents: [baseCommitSha],
  });

  await octokit.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha });

  return { sha: commit.sha, url: commit.html_url, branch };
}

function buildCommitMessage(patches) {
  const titles = patches.map(p => `- ${p.title} (${p.file})`);
  const subject = patches.length === 1
    ? `fix: ${patches[0].title}`
    : `fix: address ${patches.length} issues found by PR Analyzer`;

  return [
    subject,
    '',
    ...titles,
    '',
    'Generated by PR Analyzer and applied with reviewer approval.',
  ].join('\n');
}

router.post('/', rateLimit, async (req, res) => {
  const { url, token, fingerprints, confirm , aiReview } = req.body || {};

  // repoInfo is needed before the token check so the demo can skip it.
  let demo = false;
  try { demo = isDemoPR(parsePR(url)); } catch { /* reported properly below */ }

  if (demo && confirm === true) {
    return res.status(400).json(DEMO_CONFIRM_REFUSAL);
  }

  if (!demo && (!token || typeof token !== 'string' || !token.trim())) {
    return res.status(401).json({ error: 'A GitHub token with write access is required.' });
  }
  if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
    return res.status(400).json({ error: 'Specify which findings to fix, by fingerprint.' });
  }
  if (fingerprints.length > MAX_FIXES_PER_COMMIT) {
    return res.status(400).json({
      error: `At most ${MAX_FIXES_PER_COMMIT} fixes per commit (got ${fingerprints.length}).`,
    });
  }

  let repoInfo;
  try {
    repoInfo = parsePR(url);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  try {
    const octokit = demo ? createDemoOctokit() : createOctokit(token.trim());

    const { data: pr } = await octokit.pulls.get({
      owner: repoInfo.owner, repo: repoInfo.repo, pull_number: repoInfo.pull_number,
    });

    if (pr.state !== 'open') {
      return res.status(409).json({ error: `This PR is ${pr.state}. Fixes can only be committed to an open PR.` });
    }

    const headRepo = pr.head?.repo?.full_name;
    const baseRepo = pr.base?.repo?.full_name;
    const headBranch = pr.head?.ref;

    if (!headRepo || !headBranch) {
      return res.status(422).json({ error: 'Could not determine this PR\'s head branch.' });
    }

    // A fork PR's branch lives in someone else's repository. Committing there
    // needs maintainer-edit permission we cannot verify reliably, so refuse
    // rather than fail confusingly halfway through.
    if (headRepo !== baseRepo) {
      return res.status(422).json({
        error: 'This PR comes from a fork. Committing fixes to a fork branch is not supported — apply the suggested diffs manually.',
        headRepo, baseRepo,
      });
    }

    // Write access is a real-PR concern; the demo has no repository behind it.
    const access = demo ? { canWrite: true } : await checkWriteAccess(octokit, repoInfo);
    if (!access.canWrite) {
      return res.status(403).json({
        error: 'This token cannot write to that repository.',
        // Same trap as routes/comment.js: "Public repositories" access on a
        // fine-grained token is read-only, so no Repository permissions
        // section is offered and there is nothing on screen explaining the
        // refusal. Committing needs Contents write on top of that.
        detail: 'Fine-grained token: Repository access must be "Only select repositories" '
          + '(or "All repositories") and include this repo — "Public repositories" is '
          + 'read-only. Then set Contents: Read and write (a commit writes to the head '
          + 'branch) and Pull requests: Read. '
          + 'Classic token: needs the repo scope and push access.',
      });
    }

    const risks = await deriveRisks(url, repoInfo, demo ? undefined : token.trim(), aiReview === true);
    const wanted = new Set(fingerprints);
    const selected = risks.filter(r => wanted.has(r.fingerprint));

    if (selected.length === 0) {
      return res.status(404).json({
        error: 'None of those findings are present in the current analysis. Re-run the review — they may already be fixed.',
      });
    }

    // Generate every patch first, so a dry run and a real commit see exactly
    // the same set and the user approves what actually gets written.
    const patches = [];
    for (const finding of selected) {
      patches.push(await generatePatch(octokit, repoInfo, finding, pr.head.sha));
    }

    const applicable = patches.filter(p => p.applicable);
    const rejected = patches
      .filter(p => !p.applicable)
      .map(p => ({ fingerprint: p.fingerprint, reason: p.reason }));

    // Two findings in one file would each patch a stale copy of it, so the
    // second fix would silently overwrite the first.
    const files = applicable.map(p => p.file);
    const duplicateFiles = files.filter((f, i) => files.indexOf(f) !== i);
    if (duplicateFiles.length > 0) {
      return res.status(409).json({
        error: 'Two selected fixes touch the same file. Apply them one at a time so the second is generated against the first\'s result.',
        files: [...new Set(duplicateFiles)],
      });
    }

    const preview = applicable.map(p => ({
      fingerprint: p.fingerprint, file: p.file, title: p.title, severity: p.severity,
      explanation: p.explanation, requiresImports: p.requiresImports, diff: p.diff,
    }));

    if (confirm !== true) {
      return res.json({
        dryRun: true,
        headBranch,
        commitMessage: applicable.length ? buildCommitMessage(applicable) : null,
        patches: preview,
        rejected,
        message: applicable.length === 0
          ? 'No safely applyable fix could be generated for the selected findings.'
          : `Would commit ${applicable.length} fix(es) to ${headBranch}.`,
      });
    }

    if (applicable.length === 0) {
      return res.status(422).json({ error: 'No applyable patches — nothing to commit.', rejected });
    }

    const commit = await commitFixes(
      octokit, headRepo, headBranch, applicable, buildCommitMessage(applicable),
    );

    // The branch has moved, so the cached analysis is now stale — drop it so
    // the next review reads the fixed code and can report these as resolved.
    invalidateCached(`pr:${url}`);

    return res.json({
      dryRun: false,
      committed: true,
      commit,
      applied: preview,
      rejected,
      message: `Committed ${applicable.length} fix(es) to ${headBranch}. Re-run the review to confirm they're resolved.`,
    });

  } catch (error) {
    return handleGitHubError(error, res);
  }
});

module.exports = router;
