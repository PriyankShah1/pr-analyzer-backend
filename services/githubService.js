// services/githubService.js
// All GitHub API interactions via Octokit

const { Octokit } = require('@octokit/rest');

function createOctokit(token) {
  return new Octokit({
    auth: token || process.env.GITHUB_TOKEN || undefined,
    request: { timeout: 10000 },
    log: {
      debug: () => {},
      info:  () => {},
      warn:  () => {},
      error: () => {},
    },
  });
}

// GitHub's listFiles returns 30 files per page by DEFAULT. Calling it without
// per_page or pagination silently truncated every PR to its first 30 changed
// files: findings in file 31 onward were never reported, and the analyzer's
// own size guards (80 JS/TS, 50 PHP) could never fire, because 30 files cannot
// exceed 80. Caught by B-ii — a 96-file PR analyzed as 29.
//
// Capped rather than unbounded: the size guards refuse long before this, so
// this ceiling only exists to bound the request count on a huge PR.
const MAX_PR_FILES = 300;
const FILES_PER_PAGE = 100;

async function listAllPRFiles(octokit, repoInfo) {
  const out = [];

  for (let page = 1; page <= Math.ceil(MAX_PR_FILES / FILES_PER_PAGE); page += 1) {
    const res = await octokit.pulls.listFiles({ ...repoInfo, per_page: FILES_PER_PAGE, page });
    out.push(...res.data);
    if (res.data.length < FILES_PER_PAGE) break;   // last page
    if (out.length >= MAX_PR_FILES) break;
  }

  return out.slice(0, MAX_PR_FILES);
}

async function fetchPRDetails(repoInfo, token) {
  const octokit = createOctokit(token);
  const [prDetailsRes, files] = await Promise.all([
    octokit.pulls.get(repoInfo),
    listAllPRFiles(octokit, repoInfo),
  ]);

  return {
    prTitle:  prDetailsRes.data.title,
    prNumber: prDetailsRes.data.number,
    prAuthor: prDetailsRes.data.user?.login || null,
    prState:  prDetailsRes.data.state,
    prMerged: prDetailsRes.data.merged || false,
    // Head SHA identifies WHICH revision of the PR was reviewed. The risk
    // registry keys on it to answer "was this finding fixed since last time?"
    // — without it, two reviews of the same PR are indistinguishable.
    prHeadSha:  prDetailsRes.data.head?.sha || null,
    prBaseSha:  prDetailsRes.data.base?.sha || null,
    prRepo:     prDetailsRes.data.base?.repo?.full_name || `${repoInfo.owner}/${repoInfo.repo}`,
    prCommits:  prDetailsRes.data.commits ?? null,
    files,
  };
}

async function fetchPRFiles(repoInfo, token) {
  const octokit = createOctokit(token);
  return listAllPRFiles(octokit, repoInfo);
}

module.exports = { fetchPRDetails, fetchPRFiles };