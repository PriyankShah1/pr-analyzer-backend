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
    files:    filesRes.data,
  };
}

async function fetchPRFiles(repoInfo, token) {
  const octokit = createOctokit(token);
  const response = await octokit.pulls.listFiles(repoInfo);
  return response.data;
}

module.exports = { fetchPRDetails, fetchPRFiles };