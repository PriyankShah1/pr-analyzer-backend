// parsers/sqlAnalyzer.js
//
// Finds SQL (raw strings and ORM calls) in a PR's added lines and reports
// correctness / performance / safety problems.
//
// Two things make this file different from the other parsers:
//
//   1. It KEEPS LINE POSITIONS. Every other parser throws them away because
//      it only needs code text for the graph. SQL findings are destined to
//      become inline PR review comments, and GitHub needs a diff position or
//      a new-file line number to anchor a comment to. So we track both.
//
//   2. Every finding carries a STABLE FINGERPRINT derived from the
//      normalized code, never the line number. That is what lets a re-review
//      at a later commit answer "was this specific risk fixed?" — line
//      numbers shift on every push, normalized SQL does not.
//
// Design principle, same as the rest of the project: accuracy over coverage.
// A rule only fires when the problem is definite from static reading. Cases
// we cannot decide are dropped silently rather than guessed at, because one
// wrong confident flag erodes trust in every correct flag.

const crypto = require('crypto');

const SEVERITY = {
  CRITICAL: 'critical',
  HIGH:     'high',
  MEDIUM:   'medium',
  LOW:      'low',
};

// Severity → sort rank, so a caller can order a triage list without knowing
// the string values.
const SEVERITY_RANK = {
  [SEVERITY.CRITICAL]: 1,
  [SEVERITY.HIGH]:     2,
  [SEVERITY.MEDIUM]:   3,
  [SEVERITY.LOW]:      4,
};

const SQL_FILE_RE = /\.(js|jsx|ts|tsx|mjs|cjs|php)$/i;

// Files where SQL-looking strings are usually fixtures, not production
// queries. Flagging a seeded test row as an unparameterized query is exactly
// the kind of false positive that makes a reviewer stop reading.
const NON_PRODUCTION_RE = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|seeds?|seeders?|migrations?|factories)(\/|$)|\.(test|spec)\.[jt]sx?$/i;

function isSqlRelevantFile(filename) {
  return SQL_FILE_RE.test(filename) && !NON_PRODUCTION_RE.test(filename);
}

// ── Diff extraction that preserves real positions ─────────────────────────
//
// GitHub's inline-comment API anchors on `position`: the number of lines
// below the FIRST @@ hunk header, where the line directly after that header
// is position 1. Subsequent @@ headers themselves also consume a position.
// Getting this off by one puts a reviewer's comment on the wrong line, so it
// is computed explicitly here rather than inferred later.
function extractAddedLinesWithPositions(patch) {
  if (!patch) return [];

  const out = [];
  let newLineNo = 0;
  let diffPosition = 0;
  let hunkIndex = -1;
  let seenHunk = false;

  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      // First header sits at position 0; later headers occupy a position.
      if (seenHunk) diffPosition += 1;
      else seenHunk = true;
      newLineNo = parseInt(hunk[1], 10);
      hunkIndex += 1;
      continue;
    }
    if (!seenHunk) continue;   // ignore ---/+++ file headers before hunk 1

    diffPosition += 1;

    if (raw.startsWith('+')) {
      out.push({ line: newLineNo, diffPosition, hunkIndex, text: raw.slice(1) });
      newLineNo += 1;
    } else if (raw.startsWith('-')) {
      // Removed line: consumes a diff position but no new-file line.
    } else {
      newLineNo += 1;          // context line
    }
  }

  return out;
}

// ── String literal scanner ────────────────────────────────────────────────
// Pulls '…', "…" and `…` literals out of a code blob, tracking whether each
// template literal contained an ${…} interpolation — that flag is what the
// injection rule keys on. Escapes are honoured so a `\'` inside a string
// doesn't terminate it early.
function extractStringLiterals(blob) {
  const literals = [];
  let i = 0;

  while (i < blob.length) {
    const ch = blob[i];

    // Skip line comments so commented-out SQL is never reported.
    if (ch === '/' && blob[i + 1] === '/') {
      const nl = blob.indexOf('\n', i);
      i = nl === -1 ? blob.length : nl;
      continue;
    }
    if (ch === '/' && blob[i + 1] === '*') {
      const end = blob.indexOf('*/', i + 2);
      i = end === -1 ? blob.length : end + 2;
      continue;
    }

    if (ch !== '"' && ch !== "'" && ch !== '`') { i += 1; continue; }

    const quote = ch;
    const start = i;
    let value = '';
    let interpolated = false;
    let j = i + 1;

    while (j < blob.length) {
      const c = blob[j];
      if (c === '\\') { value += blob[j + 1] ?? ''; j += 2; continue; }
      if (c === quote) break;
      // Single/double-quoted strings do not span lines in JS or PHP.
      if (quote !== '`' && c === '\n') break;
      if (quote === '`' && c === '$' && blob[j + 1] === '{') {
        interpolated = true;
        // Record the hole as a placeholder so SQL structure stays readable.
        const close = blob.indexOf('}', j + 2);
        value += '${…}';
        j = close === -1 ? blob.length : close + 1;
        continue;
      }
      value += c;
      j += 1;
    }

    literals.push({ value, start, end: j, quote, interpolated });
    i = j + 1;
  }

  return literals;
}

// A literal is SQL only if it has a leading verb AND the structural keyword
// that verb requires. "SELECT a plan" in a user-facing message has the verb
// but no FROM, so it never reaches the rules.
const SQL_SHAPE_RE =
  /\bSELECT\b[\s\S]*\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\b[\s\S]*\bSET\b|\bDELETE\b[\s\S]*\bFROM\b/i;

function looksLikeSql(value) {
  return value.length >= 12 && SQL_SHAPE_RE.test(value);
}

// ── Individual SQL rules ──────────────────────────────────────────────────
//
// Each returns null (clean) or a partial finding. `sql` is the literal text
// with ${…} holes already normalized in.

function ruleInjection(sql, literal) {
  if (!literal.interpolated) return null;

  // A hole is safe when it lands in a spot that cannot carry a predicate —
  // in practice only LIMIT/OFFSET numerics read that way, and even those we
  // only clear when the whole query has no WHERE to poison.
  const holeInPredicate = /\b(WHERE|AND|OR|HAVING|VALUES|SET|IN)\b[^;]*\$\{…\}/i.test(sql);
  const holeInIdentifier = /\b(FROM|JOIN|INTO|UPDATE)\s+\$\{…\}/i.test(sql);
  if (!holeInPredicate && !holeInIdentifier) return null;

  return {
    kind: 'sql_injection_risk',
    severity: SEVERITY.CRITICAL,
    title: 'SQL built by string interpolation',
    detail: holeInIdentifier
      ? 'A ${…} hole lands on a table or column identifier. Identifiers cannot be parameterized, so this needs an allowlist check against known table names before it reaches the driver.'
      : 'A ${…} hole lands inside a WHERE/VALUES/SET clause. If any part of that expression comes from a request, this is injectable.',
    suggestion: holeInIdentifier
      ? 'Validate the interpolated identifier against a hardcoded allowlist, e.g. `const table = ALLOWED[key]; if (!table) throw ...`'
      : 'Use a parameterized query — `db.query("… WHERE id = $1", [id])` — instead of interpolating the value into the string.',
  };
}

function ruleDestructiveNoWhere(sql) {
  const isUpdate = /^\s*UPDATE\b/i.test(sql);
  const isDelete = /^\s*DELETE\b/i.test(sql);
  if (!isUpdate && !isDelete) return null;
  if (/\bWHERE\b/i.test(sql)) return null;

  return {
    kind: 'destructive_without_where',
    severity: SEVERITY.CRITICAL,
    title: `${isUpdate ? 'UPDATE' : 'DELETE'} with no WHERE clause`,
    detail: `This ${isUpdate ? 'rewrites' : 'removes'} every row in the table. If that is genuinely intended it should be obvious to the next reader; if not, it is a data-loss bug.`,
    suggestion: 'Add a WHERE clause, or if a full-table operation is intended, say so in a comment and consider TRUNCATE.',
  };
}

function ruleSelectStar(sql) {
  if (!/\bSELECT\s+\*/i.test(sql)) return null;
  return {
    kind: 'select_star',
    severity: SEVERITY.HIGH,
    title: 'SELECT * over-fetches',
    detail: 'Every column crosses the wire, including ones this code never reads. It also silently changes shape when a migration adds a column, and it prevents the query from being served by a covering index.',
    suggestion: 'Name the columns you actually use: `SELECT id, email, created_at FROM …`',
  };
}

function ruleLeadingWildcard(sql) {
  if (!/\bLIKE\s+['"`]?%/i.test(sql)) return null;
  return {
    kind: 'leading_wildcard_like',
    severity: SEVERITY.HIGH,
    title: "LIKE '%…' cannot use an index",
    detail: 'A leading wildcard forces a full table scan — the B-tree index on that column is unusable, so cost grows linearly with table size.',
    suggestion: "Use a trailing-only wildcard ('prefix%') if the semantics allow, or move to a full-text index / trigram (pg_trgm) index for genuine substring search.",
  };
}

function ruleFunctionOnColumn(sql) {
  const m = /\bWHERE\b[\s\S]*?\b(LOWER|UPPER|DATE|YEAR|MONTH|CAST|CONVERT)\s*\(\s*([A-Za-z_][\w.]*)\s*\)\s*(=|>|<|>=|<=|LIKE|IN)/i.exec(sql);
  if (!m) return null;
  return {
    kind: 'function_on_filtered_column',
    severity: SEVERITY.MEDIUM,
    title: `${m[1].toUpperCase()}() wrapped around a filtered column`,
    detail: `Applying ${m[1].toUpperCase()}() to \`${m[2]}\` in the WHERE clause makes the predicate non-sargable — the planner cannot use an ordinary index on that column and falls back to scanning.`,
    suggestion: `Rewrite the predicate to leave the column bare (compare against a pre-transformed parameter), or add a functional index on ${m[1].toUpperCase()}(${m[2]}).`,
  };
}

function ruleNotInSubquery(sql) {
  if (!/\bNOT\s+IN\s*\(\s*SELECT\b/i.test(sql)) return null;
  return {
    kind: 'not_in_subquery',
    severity: SEVERITY.MEDIUM,
    title: 'NOT IN (SELECT …) has a NULL trap',
    detail: 'If the subquery returns even one NULL, NOT IN evaluates to UNKNOWN for every row and the query returns nothing at all — silently, with no error. It is also generally slower than the alternatives.',
    suggestion: 'Use NOT EXISTS (correlated), or a LEFT JOIN … WHERE right.id IS NULL. Both are NULL-safe and usually plan better.',
  };
}

function ruleImplicitJoin(sql) {
  // FROM a, b — the pre-ANSI-92 comma join. Requires two bare identifiers,
  // so `FROM t WHERE x IN (1, 2)` cannot trip it.
  if (!/\bFROM\s+[A-Za-z_]\w*(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s*,\s*[A-Za-z_]\w*/i.test(sql)) return null;
  return {
    kind: 'implicit_join',
    severity: SEVERITY.MEDIUM,
    title: 'Implicit comma join',
    detail: 'Comma joins put the join condition in the WHERE clause, where it is easy to omit — and omitting it produces a cross join that silently multiplies the row count instead of erroring.',
    suggestion: 'Use explicit `INNER JOIN … ON …` so the join condition cannot be dropped by accident.',
  };
}

function ruleOrderByNoLimit(sql) {
  if (!/\bORDER\s+BY\b/i.test(sql)) return null;
  if (/\b(LIMIT|TOP|FETCH\s+FIRST|ROWNUM)\b/i.test(sql)) return null;
  if (!/^\s*SELECT\b/i.test(sql)) return null;
  return {
    kind: 'order_by_without_limit',
    severity: SEVERITY.LOW,
    title: 'ORDER BY with no LIMIT',
    detail: 'The database sorts the entire result set and ships all of it. If this table grows, the sort becomes the dominant cost and memory spikes.',
    suggestion: 'Add a LIMIT (with keyset pagination if this is a listing endpoint).',
  };
}

function ruleOffsetPagination(sql) {
  const m = /\bOFFSET\s+(\d+)/i.exec(sql);
  if (!m || parseInt(m[1], 10) < 1000) return null;
  return {
    kind: 'large_offset_pagination',
    severity: SEVERITY.MEDIUM,
    title: `OFFSET ${m[1]} scans and discards rows`,
    detail: 'The database must walk every row up to the offset before returning any. Cost climbs with page number, so the last page is the slowest.',
    suggestion: 'Switch to keyset pagination: `WHERE id < :lastSeenId ORDER BY id DESC LIMIT n`.',
  };
}

const SQL_RULES = [
  ruleInjection,
  ruleDestructiveNoWhere,
  ruleSelectStar,
  ruleLeadingWildcard,
  ruleFunctionOnColumn,
  ruleNotInSubquery,
  ruleImplicitJoin,
  ruleOffsetPagination,
  ruleOrderByNoLimit,
];

// ── ORM rules (operate on code, not on SQL text) ──────────────────────────

// Query-ish call sites, used by both the ORM rules and the N+1 detector.
const QUERY_CALL_RE =
  /\.(query|execute|raw|findMany|findAll|findOne|findUnique|findFirst|aggregate|count)\s*\(|\$queryRaw|\$executeRaw|DB::(select|statement|insert|update|delete|table|raw)|->(get|first|find|paginate)\s*\(/;

const LOOP_OPENER_RE =
  /\b(for|while)\s*\(|\.\s*(forEach|map|flatMap|filter|reduce)\s*\(|\bforeach\s*\(/;

// `await` inside a loop over a query is the classic N+1: one round trip per
// element. Async iteration primitives that fan out concurrently (Promise.all,
// allSettled) are excluded — those are already a single logical batch.
function detectNPlusOne(addedLines, filename) {
  const findings = [];
  let depth = 0;
  let loopDepth = null;
  let loopLine = null;

  for (const entry of addedLines) {
    const text = entry.text;

    if (loopDepth === null && LOOP_OPENER_RE.test(text)) {
      loopDepth = depth;
      loopLine = entry;
    }

    if (loopDepth !== null && QUERY_CALL_RE.test(text) && /\bawait\b|->|DB::/.test(text)) {
      // Same statement as the loop opener (e.g. `for (const r of await q())`)
      // is one query, not N.
      if (entry.line !== loopLine.line) {
        findings.push(buildFinding({
          filename,
          entry,
          kind: 'n_plus_one_query',
          severity: SEVERITY.HIGH,
          title: 'Query inside a loop (N+1)',
          detail: `This issues one database round trip per iteration of the loop opened at line ${loopLine.line}. At 100 items that is 100 sequential queries; latency is N × RTT and grows with the data.`,
          suggestion: 'Fetch the whole set in one query before the loop (`WHERE id IN (…)` / an ORM `include`/`join`), then look up from an in-memory Map inside the loop.',
          snippet: text.trim(),
        }));
      }
    }

    // Crude brace tracking — enough to know when the loop body ended within
    // a diff hunk, which is all this needs.
    depth += (text.match(/\{/g) || []).length;
    depth -= (text.match(/\}/g) || []).length;
    if (loopDepth !== null && depth <= loopDepth && /\}/.test(text)) {
      loopDepth = null;
      loopLine = null;
    }
  }

  return findings;
}

// findMany/findAll with neither a row cap nor a projection: unbounded read.
function detectUnboundedOrmReads(addedLines, filename) {
  const findings = [];

  for (const entry of addedLines) {
    const text = entry.text;
    if (!/\.(findMany|findAll)\s*\(/.test(text)) continue;
    // An empty or near-empty call — `findMany()` / `findMany({})` — is the
    // unambiguous case. Anything with options may cap rows on a later line,
    // and we will not guess.
    if (!/\.(findMany|findAll)\s*\(\s*\)?\s*\{?\s*\}?\s*\)/.test(text)) continue;

    findings.push(buildFinding({
      filename,
      entry,
      kind: 'unbounded_orm_read',
      severity: SEVERITY.HIGH,
      title: 'Unbounded findMany/findAll',
      detail: 'With no `take`/`limit` and no `select`, this loads every row and every column of the table into process memory. It is fine on a seeded dev database and an outage on a production one.',
      suggestion: 'Add a row cap (`take: 100` / `limit: 100`) and a `select` listing only the fields used downstream.',
      snippet: text.trim(),
    }));
  }

  return findings;
}

// ── Finding construction ──────────────────────────────────────────────────

// Line numbers move on every push, so they cannot identify a finding across
// commits. Normalized code can: lowercase, collapse whitespace, drop quote
// characters. Two pushes that leave the same problem in place produce the
// same fingerprint, which is what "was this risk fixed?" is built on.
function fingerprintOf(kind, filename, snippet) {
  const normalized = String(snippet)
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return crypto
    .createHash('sha1')
    .update(`${kind}|${filename}|${normalized}`)
    .digest('hex')
    .slice(0, 12);
}

function buildFinding({ filename, entry, kind, severity, title, detail, suggestion, snippet }) {
  return {
    kind,
    severity,
    severityRank: SEVERITY_RANK[severity],
    title,
    detail,
    suggestion,
    file: filename,
    line: entry.line,
    diffPosition: entry.diffPosition,
    snippet: snippet.length > 240 ? `${snippet.slice(0, 240)}…` : snippet,
    fingerprint: fingerprintOf(kind, filename, snippet),
    // Shape parity with reviewService findings, so the triage list, the
    // risk registry and the PR commenter can treat both sources uniformly.
    source: 'sql',
    confidence: 1,      // static rules either matched or did not
    anchored: true,     // position came from the diff itself, not a model
  };
}

// ── Public entry point ────────────────────────────────────────────────────

function analyzeSqlInFiles(files) {
  const findings = [];

  for (const file of files || []) {
    const filename = file.filename || '';
    if (!isSqlRelevantFile(filename) || !file.patch) continue;

    const addedLines = extractAddedLinesWithPositions(file.patch);
    if (addedLines.length === 0) continue;

    // Rules that need multi-line context run per hunk, so a loop in one hunk
    // can never be paired with a query in an unrelated hunk.
    const hunks = new Map();
    for (const entry of addedLines) {
      if (!hunks.has(entry.hunkIndex)) hunks.set(entry.hunkIndex, []);
      hunks.get(entry.hunkIndex).push(entry);
    }

    for (const hunkLines of hunks.values()) {
      findings.push(...detectNPlusOne(hunkLines, filename));

      // Join the hunk so a template literal spanning several added lines is
      // seen as one string, then map any match back to its starting line.
      const offsets = [];
      let cursor = 0;
      for (const entry of hunkLines) {
        offsets.push(cursor);
        cursor += entry.text.length + 1;
      }
      const blob = hunkLines.map(l => l.text).join('\n');

      const lineFor = charIndex => {
        let idx = 0;
        for (let k = 0; k < offsets.length; k += 1) {
          if (offsets[k] <= charIndex) idx = k;
          else break;
        }
        return hunkLines[idx];
      };

      for (const literal of extractStringLiterals(blob)) {
        if (!looksLikeSql(literal.value)) continue;

        const sql = literal.value.replace(/\s+/g, ' ').trim();
        const entry = lineFor(literal.start);

        for (const rule of SQL_RULES) {
          const hit = rule(sql, literal);
          if (!hit) continue;
          findings.push(buildFinding({ ...hit, filename, entry, snippet: sql }));
        }
      }
    }

    findings.push(...detectUnboundedOrmReads(addedLines, filename));
  }

  // Two rules can legitimately fire on the same statement (SELECT * plus an
  // ORDER BY with no LIMIT, say) — those are distinct findings. Identical
  // fingerprints are not, and happen when the same query is added twice.
  const seen = new Set();
  const deduped = findings.filter(f => {
    if (seen.has(f.fingerprint)) return false;
    seen.add(f.fingerprint);
    return true;
  });

  return deduped.sort((a, b) => a.severityRank - b.severityRank || a.file.localeCompare(b.file) || a.line - b.line);
}

module.exports = {
  analyzeSqlInFiles,
  isSqlRelevantFile,
  extractAddedLinesWithPositions,
  fingerprintOf,
  SEVERITY,
  SEVERITY_RANK,
};
