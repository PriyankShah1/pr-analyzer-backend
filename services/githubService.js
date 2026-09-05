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

async function fetchPRDetails(repoInfo, token) {
  const octokit = createOctokit(token);
  const [prDetailsRes, filesRes] = await Promise.all([
    octokit.pulls.get(repoInfo),
    octokit.pulls.listFiles(repoInfo),
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
    files:      filesRes.data,
  };
}

async function fetchPRFiles(repoInfo, token) {
  const octokit = createOctokit(token);
  const response = await octokit.pulls.listFiles(repoInfo);
  return response.data;
}

module.exports = { fetchPRDetails, fetchPRFiles };