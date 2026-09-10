// routes/analyze.js
const express  = require('express');
const router   = express.Router();
const { rateLimit }        = require('../middleware/rateLimit');
const { parsePR }          = require('../utils/validation');
const { getCached, setCached } = require('../services/cacheService');
const { fetchPRDetails }   = require('../services/githubService');
const { filterPHPFiles, buildEmptyResult, analyzeFiles } = require('../services/analysisService');
const { generateExplanation } = require('../services/aiService');
const { generateReview }      = require('../services/reviewService');
const { buildGraphFindings }  = require('../services/graphFindings');
const { getDefaultLanguage }  = require('../services/languageConfig');
const { handleGitHubError } = require('./errorHandler');
const { isDemoPR, getDemoPRDetails } = require('../fixtures/demoPR');

router.post('/', rateLimit, async (req, res) => {
  const { url, token, refresh, aiReview } = req.body;

  let repoInfo;
  try {
    repoInfo = parsePR(url);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  // Cache check — public PRs only, never cache private token requests.
  // The cached object already includes aiExplanations (if generated),
  // so a cache hit returns the explanation with zero extra Gemini calls.
  //
  // `refresh: true` skips the READ only. The board's Refresh button exists to
  // answer "is this still true at the latest commit?", and a cached answer
  // from up to CACHE_TTL_MS ago cannot answer that — it would report an old
  // SHA as current. The write still happens below, so a refresh warms the
  // cache for everyone else rather than poisoning it.
  // The in-depth review (UI name; wire field stays `aiReview`) is a SEPARATE,
  // larger Gemini call (see §2). It is opt-in, so
  // a plain Analyze costs exactly one model call — the explanation — as it did
  // before v6. Reviewed and unreviewed results cache separately: serving a
  // cached unreviewed result to someone who asked for a review would silently
  // drop the findings they requested.
  const wantsReview = aiReview === true;
  const cacheKey = wantsReview ? `pr:${url}:review` : `pr:${url}`;
  if (!token && !refresh) {
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[cache hit] ${url}`);
      return res.json({ ...cached, fromCache: true });
    }
  }

  try {
    // The built-in demo PR (github.com/test/test/pull/1) short-circuits the
    // GitHub round trip and nothing else — every parser, rule and model call
    // below runs on it exactly as on a real PR. It is also never cached: its
    // whole purpose is to advance a revision on refresh.
    const demo = isDemoPR(repoInfo);
    const { prTitle, prNumber, prAuthor, prState, prMerged,
            prHeadSha, prBaseSha, prRepo, prCommits, files, demo: demoMeta } =
      demo
        ? getDemoPRDetails({ advance: !!refresh })
        : await fetchPRDetails(repoInfo, token);

    console.log(`[analyze] PR #${prNumber} (${prState}) @ ${String(prHeadSha).slice(0, 7)}`);

    const prMeta = { prTitle, prNumber, prAuthor, prState, prMerged,
                     prHeadSha, prBaseSha, prRepo, prCommits, prUrl: url };
    const phpFiles = filterPHPFiles(files);

    if (phpFiles.length === 0 && files.length === 0) {
      return res.json(buildEmptyResult(prMeta));
    }

    let result;
    try {
      result = analyzeFiles(files, prMeta);
    } catch (error) {
      // guardLargePR / guardLargeJsPR throws here
      return res.status(422).json({ error: error.message });
    }

    // ── AI explanation — auto-generate ONLY the default language ─────────
    // Determined dynamically from languageConfig (currently 'en'). Other
    // languages are generated on-demand via POST /explain when the user
    // clicks that tab. Skipped entirely if nodes.length === 0 — handled
    // inside generateExplanation, so no wasted API calls on empty PRs.
    // The structured logic review is a second, independent Gemini call. Run
    // it alongside the explanation rather than after — they share no state,
    // and serialising them would double the wait on every analyze.
    const defaultLang = getDefaultLanguage();

    // Ticking "in-depth review" re-runs the analysis, which used to regenerate
    // the PR explanation as well — two model calls where one was already paid
    // for, partly undoing B4a's saving. The explanation depends only on the
    // diff, so if a plain run of this same URL already produced one, reuse it.
    const priorExplanation = wantsReview
      ? getCached(`pr:${url}`)?.aiExplanations?.[defaultLang]
      : null;

    const [explanation, aiFindings] = await Promise.all([
      priorExplanation ? Promise.resolve(priorExplanation) : generateExplanation(defaultLang, {
        prTitle:      result.prTitle,
        codeLanguage: result.language,
        flows:        result.flows,
        stats:        result.visualization?.stats,
        codeContext:  result.codeContext,
      }),
      // Skipped unless explicitly requested. Static SQL rules and every graph
      // check are unaffected — they cost no quota and always run.
      wantsReview
        ? generateReview({
            prTitle:      result.prTitle,
            codeLanguage: result.language,
            files,
            flows:        result.flows,
            sqlFindings:  result.sqlFindings,
          })
        : Promise.resolve([]),
    ]);

    if (explanation) {
      result.aiExplanations = { [defaultLang]: explanation };
    }

    // One ranked risk list from every source — static SQL rules and the AI
    // review share a shape, so the frontend never branches on origin.
    result.aiFindings = aiFindings;
    // Graph checks (broken dependency, prop name/type mismatch, missing hook
    // dep) are findings too — they were previously visible in triage but absent
    // from `risks`, so they could never be posted or committed.
    result.graphFindings = buildGraphFindings(result.flows, files);

    result.risks = [...(result.sqlFindings || []), ...result.graphFindings, ...aiFindings]
      .sort((a, b) => a.severityRank - b.severityRank
                   || b.confidence - a.confidence
                   || a.file.localeCompare(b.file));

    if (result.visualization?.stats) {
      result.visualization.stats.aiFindings = aiFindings.length;
      result.visualization.stats.graphFindings = result.graphFindings.length;
      result.visualization.stats.totalRisks = result.risks.length;
    }

    // The UI must be able to tell "no AI findings" from "the AI never ran".
    result.aiReviewRan = wantsReview;

    // A reviewer must never mistake fixture output for a review of real code,
    // and the demo's revision cursor means two calls legitimately differ.
    if (demoMeta) {
      result.demo = demoMeta;
      result.warnings = [
        ...(result.warnings || []),
        `Demo PR — ${demoMeta.label} (revision ${demoMeta.revision} of ${demoMeta.revisionCount}). `
        + 'This is built-in fixture code, not a real pull request. '
        + (demoMeta.isLastRevision
            ? 'This is the last revision; Refresh will re-analyze it.'
            : 'Refresh to advance to the next revision and see the re-review diff.'),
      ];
    }

    // Cache public PR results only — explanation is cached as part of result
    // The demo is excluded: caching it would freeze the revision cursor.
    if (!token && !demoMeta) {
      setCached(cacheKey, result);
      console.log(`[cache set] ${url}`);
    }

    return res.json(result);

  } catch (error) {
    return handleGitHubError(error, res);
  }
});

module.exports = router;
