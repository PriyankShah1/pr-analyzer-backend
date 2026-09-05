// fixtures/demoPR.js
//
// A built-in, synthetic pull request so the whole pipeline can be exercised
// without GitHub — no PAT, no 60-requests/hour rate limit, no repo to create.
//
//     https://github.com/test/test/pull/1
//
// Everything downstream of the fetch is REAL. The parsers, the SQL rules, the
// Gemini review, the risk registry, the triage list, the comment and commit
// planners all run exactly as they do on a live PR. Only the GitHub round trip
// is replaced. That is the point: a demo that stubbed the analysis would prove
// nothing about the analysis.
//
// ── Why three revisions ──────────────────────────────────────────────────
// The most novel thing in v6 is the recursive-review loop: analyze a PR, let
// someone push a fix, analyze again, and have the tool say which risks were
// actually resolved and which came back. A frozen fixture cannot demonstrate
// that, because the head SHA never moves and every review compares a revision
// to itself. So this PR has three revisions and `refresh: true` advances to
// the next one:
//
//   rev 1  the initial push — every detector fires
//   rev 2  a developer fixes the injection and the unguarded DELETE
//   rev 3  the injection is reintroduced, and a new SELECT * appears
//
// Reviewing 1 → 2 shows RESOLVED. Reviewing 2 → 3 shows REGRESSED plus NEW.
// That cursor is per-process demo state and the only stateful thing here; it
// is documented as such rather than pretended away (decision B3 keeps the
// backend stateless for real PRs, and this fixture is not a real PR).

const DEMO_OWNER = 'test';
const DEMO_REPO = 'test';
const DEMO_PR_NUMBER = 1;

/** Is this URL the built-in demo PR? */
function isDemoPR(repoInfo) {
  return !!repoInfo
    && repoInfo.owner.toLowerCase() === DEMO_OWNER
    && repoInfo.repo.toLowerCase() === DEMO_REPO
    && repoInfo.pull_number === DEMO_PR_NUMBER;
}

/**
 * Build a unified-diff patch in which every line is an addition.
 *
 * This is the exact shape GitHub returns for a newly added file, so the diff
 * positions the SQL analyzer computes from it are the real ones — a finding
 * anchored here would anchor identically on a live PR.
 */
function addedPatch(lines) {
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}`;
}

// ── src/api/orders.js — the static SQL rules ─────────────────────────────
// One rule per function, each in its own string literal, so what fires is
// unambiguous. `listAll` deliberately trips two rules at once (SELECT * and
// ORDER BY without LIMIT) because that is a real pattern and the analyzer is
// designed to report both.
function ordersFile(variant) {
  const lines = [
    "const db = require('../db');",
    "const prisma = require('../prisma');",
    '',
  ];

  // ── Rule: sql_injection_risk (critical) ────────────────────────────────
  // Present at rev 1, fixed at rev 2, and back at rev 3 — byte-identical to
  // rev 1, so its fingerprint matches and the diff reads REGRESSED, not NEW.
  if (variant === 'vulnerable' || variant === 'regressed') {
    lines.push(
      'async function findOrdersByCustomer(customerId) {',
      '  const sql = `SELECT id, total, status FROM orders WHERE customer_id = ${customerId}`;',
      '  return db.query(sql);',
      '}',
      '',
    );
  } else {
    // The fix a reviewer would actually make: parameterize.
    lines.push(
      'async function findOrdersByCustomer(customerId) {',
      "  return db.query('SELECT id, total, status FROM orders WHERE customer_id = $1', [customerId]);",
      '}',
      '',
    );
  }

  // ── Rule: destructive_without_where (critical) ─────────────────────────
  if (variant === 'vulnerable') {
    lines.push(
      'async function purgeCancelled() {',
      "  return db.query('DELETE FROM orders');",
      '}',
      '',
    );
  } else {
    lines.push(
      'async function purgeCancelled() {',
      "  return db.query('DELETE FROM orders WHERE status = $1', ['cancelled']);",
      '}',
      '',
    );
  }

  // ── Rules that persist across every revision ───────────────────────────
  lines.push(
    // select_star (high) + order_by_without_limit (low)
    'async function listAll() {',
    "  return db.query('SELECT * FROM orders ORDER BY created_at DESC');",
    '}',
    '',
    // leading_wildcard_like (high)
    'async function searchByEmail(term) {',
    '  return db.query("SELECT id, email FROM customers WHERE email LIKE \'%" + term + "%\'");',
    '}',
    '',
    // function_on_filtered_column (medium)
    'async function findByLoweredName(name) {',
    "  return db.query('SELECT id FROM customers WHERE LOWER(name) = $1', [name]);",
    '}',
    '',
    // not_in_subquery (medium)
    'async function customersWithoutOrders() {',
    "  return db.query('SELECT id FROM customers WHERE id NOT IN (SELECT customer_id FROM orders)');",
    '}',
    '',
    // implicit_join (medium)
    'async function joinLegacy() {',
    "  return db.query('SELECT o.id, c.name FROM orders o, customers c WHERE o.customer_id = c.id');",
    '}',
    '',
    // large_offset_pagination (medium)
    'async function pageDeep() {',
    "  return db.query('SELECT id FROM orders ORDER BY id LIMIT 20 OFFSET 5000');",
    '}',
    '',
    // n_plus_one_query (high) — one round trip per iteration
    'async function enrichOrders(orders) {',
    '  const out = [];',
    '  for (const order of orders) {',
    "    const customer = await db.query('SELECT id, name FROM customers WHERE id = $1', [order.customerId]);",
    '    out.push({ ...order, customer });',
    '  }',
    '  return out;',
    '}',
    '',
    // unbounded_orm_read (high)
    'async function allProducts() {',
    '  return prisma.product.findMany();',
    '}',
    '',
  );

  // ── rev 3 only: a brand-new finding, so the diff shows INTRODUCED ──────
  if (variant === 'regressed') {
    lines.push(
      'async function auditTrail() {',
      "  return db.query('SELECT * FROM audit_log');",
      '}',
      '',
    );
  }

  lines.push('module.exports = {');
  lines.push('  findOrdersByCustomer, purgeCancelled, listAll, searchByEmail,');
  lines.push('  findByLoweredName, customersWithoutOrders, joinLegacy, pageDeep,');
  lines.push('  enrichOrders, allProducts,');
  lines.push('};');

  return { filename: 'src/api/orders.js', status: 'added', patch: addedPatch(lines), lines };
}

// ── src/api/auth.js — targets for the AI logic review ────────────────────
// These are the classes of bug reviewService.js is prompted to look for and
// that static rules cannot see: a secret in source, a promise never awaited,
// an unguarded dereference, a swallowed error, a route with no auth check.
//
// AI findings are model output, so the harness reports them rather than
// asserting an exact set — claiming a fixed count here would be a test that
// lies the first time the model words something differently.
function authFile() {
  const lines = [
    "const jwt = require('jsonwebtoken');",
    "const db = require('../db');",
    '',
    '// Hardcoded credential committed to source control.',
    // Shaped like a real credential so the review flags it, but deliberately
    // NOT in any vendor's live-key format — `sk_live_…` would trip GitHub's
    // push protection and Stripe's scanner the moment this fixture is pushed.
    "const JWT_SECRET = 'EXAMPLE-FAKE-CREDENTIAL-DO-NOT-USE-0000000000';",
    '',
    'async function login(req, res) {',
    '  const { email, password } = req.body;',
    '',
    "  const user = await db.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);",
    '',
    '  // Dereferenced without checking whether the lookup returned anything.',
    '  const valid = comparePassword(password, user.rows[0].password_hash);',
    '  if (!valid) return res.status(401).json({ error: "bad credentials" });',
    '',
    '  const token = jwt.sign({ sub: user.rows[0].id }, JWT_SECRET);',
    '  return res.json({ token });',
    '}',
    '',
    'async function refreshSession(userId) {',
    '  // Promise is never awaited — the write may not have landed when this returns.',
    "  db.query('UPDATE sessions SET refreshed_at = NOW() WHERE user_id = $1', [userId]);",
    '  return { ok: true };',
    '}',
    '',
    'async function deleteAccount(req, res) {',
    '  // No authentication or ownership check before a destructive operation.',
    '  const targetId = req.params.id;',
    "  await db.query('DELETE FROM users WHERE id = $1', [targetId]);",
    '  return res.status(204).send();',
    '}',
    '',
    'async function syncBilling(customerId) {',
    '  try {',
    '    await billing.sync(customerId);',
    '  } catch (err) {',
    '    // Error swallowed — a failed sync looks identical to a successful one.',
    '  }',
    '  return true;',
    '}',
    '',
    'module.exports = { login, refreshSession, deleteAccount, syncBilling };',
  ];

  return { filename: 'src/api/auth.js', status: 'added', patch: addedPatch(lines), lines };
}

// ── React — prop name mismatch, prop TYPE mismatch, missing hook dep ─────
//
// The two prop problems sit on DIFFERENT elements on purpose. The parser
// checks names first and only checks literal types when every name matched
// (reactParser.js), so a component receiving an unaccepted prop never reaches
// the type check — putting both on one element would silently exercise only
// the name rule and make this fixture claim coverage it does not have.
function checkoutPanelFile() {
  const lines = [
    "import { useEffect, useState } from 'react';",
    "import { OrderSummary } from './OrderSummary';",
    "import { PromoBanner } from './PromoBanner';",
    '',
    'export function CheckoutPanel({ cartId }: { cartId: string }) {',
    '  const [total, setTotal] = useState(0);',
    '',
    '  useEffect(() => {',
    '    fetchTotal(cartId).then(setTotal);',
    '  }, []);',
    '',
    '  return (',
    '    <div className="checkout-panel">',
    '      <OrderSummary total={total} itemCount="3" />',
    '      <PromoBanner code={cartId} discountPercent={10} />',
    '    </div>',
    '  );',
    '}',
  ];
  return { filename: 'src/components/CheckoutPanel.tsx', status: 'added', patch: addedPatch(lines), lines };
}

// Accepts only `code`; CheckoutPanel also passes `discountPercent`.
function promoBannerFile() {
  const lines = [
    'interface PromoBannerProps {',
    '  code: string;',
    '}',
    '',
    'export function PromoBanner({ code }: PromoBannerProps) {',
    '  return <div className="promo-banner">{code}</div>;',
    '}',
  ];
  return { filename: 'src/components/PromoBanner.tsx', status: 'added', patch: addedPatch(lines), lines };
}

function orderSummaryFile() {
  const lines = [
    'interface OrderSummaryProps {',
    '  total: number;',
    '  itemCount: number;',
    '}',
    '',
    'export function OrderSummary({ total, itemCount }: OrderSummaryProps) {',
    '  return (',
    '    <div className="order-summary">',
    '      <span>{itemCount} items</span>',
    '      <strong>{total}</strong>',
    '    </div>',
    '  );',
    '}',
  ];
  return { filename: 'src/components/OrderSummary.tsx', status: 'added', patch: addedPatch(lines), lines };
}

// ── PHP / Laravel — exercises the third parser ───────────────────────────
function phpFile() {
  const lines = [
    '<?php',
    '',
    'namespace App\\Http\\Controllers;',
    '',
    'use App\\Services\\ReportBuilder;',
    'use Illuminate\\Http\\Request;',
    '',
    'class LegacyReportController extends Controller',
    '{',
    '    public function monthly(Request $request)',
    '    {',
    '        $builder = new ReportBuilder();',
    '        $rows = $builder->collect($request->input(\'month\'));',
    '',
    '        return response()->json($rows);',
    '    }',
    '',
    '    public function export(Request $request)',
    '    {',
    '        $rows = DB::select("SELECT * FROM invoices ORDER BY issued_at DESC");',
    '',
    '        return response()->json($rows);',
    '    }',
    '}',
  ];
  return { filename: 'app/Http/Controllers/LegacyReportController.php', status: 'added', patch: addedPatch(lines), lines };
}

// ── The three revisions ──────────────────────────────────────────────────
const REVISIONS = [
  {
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    label: 'rev 1 — initial push, every detector fires',
    files: () => [
      ordersFile('vulnerable'),
      authFile(),
      checkoutPanelFile(),
      orderSummaryFile(),
      promoBannerFile(),
      phpFile(),
    ],
  },
  {
    sha: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890',
    label: 'rev 2 — injection and unguarded DELETE fixed',
    files: () => [
      ordersFile('fixed'),
      authFile(),
      checkoutPanelFile(),
      orderSummaryFile(),
      promoBannerFile(),
      phpFile(),
    ],
  },
  {
    sha: 'c3d4e5f60718293a4b5c6d7e8f90123456789012',
    label: 'rev 3 — injection reintroduced, new SELECT * added',
    files: () => [
      ordersFile('regressed'),
      authFile(),
      checkoutPanelFile(),
      orderSummaryFile(),
      promoBannerFile(),
      phpFile(),
    ],
  },
];

// Demo-only cursor. See the header note: a static fixture cannot demonstrate
// the re-review loop, which is the feature most worth demonstrating.
let revisionCursor = 0;

/** Which revision the next plain analyze will return (1-based). */
function currentRevision() {
  return revisionCursor + 1;
}

function revisionCount() {
  return REVISIONS.length;
}

/** Put the demo back to revision 1. */
function resetDemo() {
  revisionCursor = 0;
}

/**
 * Details for the demo PR, in exactly the shape `fetchPRDetails` returns.
 *
 * `advance: true` (the board's Refresh) moves to the next revision, stopping
 * at the last one rather than wrapping — wrapping would make a re-review
 * report the final revision's fixes as regressions, which is backwards.
 */
function getDemoPRDetails({ advance = false } = {}) {
  if (advance && revisionCursor < REVISIONS.length - 1) revisionCursor += 1;

  const revision = REVISIONS[revisionCursor];

  return {
    prTitle: 'Rework checkout: order lookup, auth, and summary panel',
    prNumber: DEMO_PR_NUMBER,
    prAuthor: 'demo-author',
    prState: 'open',
    prMerged: false,
    prHeadSha: revision.sha,
    prBaseSha: '0000000000000000000000000000000000000000',
    prRepo: `${DEMO_OWNER}/${DEMO_REPO}`,
    prCommits: revisionCursor + 1,
    files: revision.files(),

    // Demo-only metadata. Routes surface this as a warning so nobody mistakes
    // a fixture for a real review of a real pull request.
    demo: {
      revision: revisionCursor + 1,
      revisionCount: REVISIONS.length,
      label: revision.label,
      isLastRevision: revisionCursor === REVISIONS.length - 1,
    },
  };
}

/**
 * Full text of a demo file at the CURRENT revision.
 *
 * The commit path (§6) fetches a file's real content to anchor a patch in it.
 * Fixture files are wholly added, so their content is exactly their added
 * lines — which means a patch verified here is verified against the same text
 * the analyzer read, just as on a live PR.
 */
function getDemoFileContent(filename) {
  const file = REVISIONS[revisionCursor].files().find(f => f.filename === filename);
  return file ? file.lines.join('\n') : null;
}

module.exports = {
  isDemoPR,
  getDemoPRDetails,
  getDemoFileContent,
  resetDemo,
  currentRevision,
  revisionCount,
  DEMO_URL: `https://github.com/${DEMO_OWNER}/${DEMO_REPO}/pull/${DEMO_PR_NUMBER}`,
};
