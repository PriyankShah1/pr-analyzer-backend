// Caps on what a single review posts (B-ii).
//
// GitHub will not take an unlimited number of inline comments, and a 200-row
// table buries the PR description. Both caps existed; neither SAID anything
// when it cut, so a reviewer on a large PR saw a list that looked complete.
const W = require('../services/githubWriteService.js');

let pass = 0, fail = 0;
const check = (n, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (extra ? '  → ' + extra : '')); }
};

const findings = n => Array.from({ length: n }, (_, i) => ({
  fingerprint: 'fp' + i,
  file: 'src/f' + Math.floor(i / 6) + '.js',
  line: 10 + i,
  diffPosition: 3 + i,
  anchored: true,
  severity: i < 5 ? 'critical' : i < 20 ? 'high' : 'medium',
  title: 'Finding ' + i,
  detail: 'Detail ' + i,
  snippet: 'x' + i,
  kind: 'sql_injection',
}));

const plan = (n, { partial = false } = {}) => {
  const f = findings(n);
  return W.buildCommentPlan({
    findings: f,
    postedFingerprints: new Set(),
    prHeadSha: 'abc1234def',
    edits: {},
    selected: partial ? new Set(f.map(x => x.fingerprint)) : null,
    hasSummary: true,
    resolvedThreadFps: new Set(),
  });
};

console.log('\n1. The inline cap holds');
const big = plan(60);
check('never posts more than MAX_INLINE_COMMENTS',
  big.inlineComments.length === W.MAX_INLINE_COMMENTS, 'got ' + big.inlineComments.length);
check('reports how many it held back', big.counts.truncated === 35, 'got ' + big.counts.truncated);

console.log('\n2. The reader is TOLD what was cut');
check('summary says how many rows are missing',
  /\*\*10 more\*\*/.test(big.reviewBody), 'no row notice');
check('summary says how many inline comments were held back',
  /\*\*35\*\* further findings were not posted inline/.test(big.reviewBody), 'no inline notice');
check('the notice names the real total (60)', /all 60/.test(big.reviewBody));

console.log('\n3. The table itself is capped');
const rows = (big.reviewBody.match(/^\| /gm) || []).length;
check('50 findings + 1 header row', rows === 51, 'got ' + rows);

console.log('\n4. A partial review says it too');
const part = plan(60, { partial: true });
check('partial body names the unposted count',
  /35 more could not be posted inline/.test(part.reviewBody), part.reviewBody.slice(0, 90));

console.log('\n5. A normal PR carries no truncation noise');
const small = plan(3);
check('no row notice', !/more\*\* are not listed/.test(small.reviewBody));
check('no inline notice', !/not posted inline/.test(small.reviewBody));
check('all 3 posted inline', small.inlineComments.length === 3, 'got ' + small.inlineComments.length);

console.log('\n6. Exactly at the cap, nothing is claimed to be missing');
const exact = plan(25);
check('25 posted', exact.inlineComments.length === 25, 'got ' + exact.inlineComments.length);
check('truncated is 0', exact.counts.truncated === 0, 'got ' + exact.counts.truncated);
check('no inline notice at exactly the cap', !/not posted inline/.test(exact.reviewBody));

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
