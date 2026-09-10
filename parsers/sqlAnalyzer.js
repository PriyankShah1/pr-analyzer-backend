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
function extractPatchLines(patch) {
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
      out.push({ line: newLineNo, diffPosition, hunkIndex, text: raw.slice(1), added: true });
      newLineNo += 1;
    } else if (raw.startsWith('-')) {
      // Removed line: consumes a diff position but no new-file line. Left out
      // of the output entirely — deleted code must not affect brace depth.
    } else {
      // Context. Unchanged, so nothing is ever REPORTED on it, but its braces
      // are the only way to know where a loop body ENDS. Tracking depth over
      // added lines alone let a loop stay open across the rest of the file.
      out.push({ line: newLineNo, diffPosition, hunkIndex, text: raw.slice(1), added: false });
      newLineNo += 1;
    }
  }

  return out;
}

function extractAddedLinesWithPositions(patch) {
  // Same shape as before this was split out — callers outside this file
  // (inline comment positioning) depend on it exactly.
  return extractPatchLines(patch)
    .filter(l => l.added)
    .map(({ added, ...rest }) => rest);
}

// ── String literal scanner ────────────────────────────────────────────────
// Pulls '…', "…" and `…` literals out of a code blob, tracking whether each
// template literal contained an ${…} interpolation — that flag is what the
// injection rule keys on. Escapes are honoured so a `\'` inside a string
// doesn't terminate it early.
/**
 * Pull string literals out of a code blob.
 *
 * `isPhp` matters: in PHP a DOUBLE-quoted string interpolates `$var` and
 * `{$var}` exactly the way a JS backtick interpolates `${var}`, while a
 * single-quoted PHP string does not. Without it, the injection rule saw only
 * JS template literals and missed every PHP injection — in a tool that claims
 * to support Laravel, and on its only critical-severity rule.
 */
function extractStringLiterals(blob, isPhp = false) {
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
    // The expression inside each ${…}. The placeholder alone cannot tell a
    // request parameter from an escaped identifier or a module constant.
    const holes = [];
    let j = i + 1;

    while (j < blob.length) {
      const c = blob[j];
      if (c === '\\') { value += blob[j + 1] ?? ''; j += 2; continue; }
      if (c === quote) break;
      // Single/double-quoted strings do not span lines in JS or PHP.
      if (quote !== '`' && c === '\n') break;
      if (quote === '`' && c === '$' && blob[j + 1] === '{') {
        interpolated = true;
        // Record the hole as a placeholder so SQL structure stays readable,
        // and keep the expression itself for the safety check.
        const close = blob.indexOf('}', j + 2);
        holes.push(close === -1 ? '' : blob.slice(j + 2, close));
        value += '${…}';
        j = close === -1 ? blob.length : close + 1;
        continue;
      }
      // PHP: "… {$user->id} …" — braced, may contain property/array access.
      if (isPhp && quote === '"' && c === '$' && blob[j + 1] === '{') {
        interpolated = true;
        const close = blob.indexOf('}', j + 2);
        value += '${…}';
        j = close === -1 ? blob.length : close + 1;
        continue;
      }
      if (isPhp && quote === '"' && c === '{' && blob[j + 1] === '$') {
        interpolated = true;
        const close = blob.indexOf('}', j + 2);
        value += '${…}';
        j = close === -1 ? blob.length : close + 1;
        continue;
      }
      // PHP: "… $email …" — bare, runs to the end of the identifier.
      if (isPhp && quote === '"' && c === '$' && /[A-Za-z_]/.test(blob[j + 1] || '')) {
        interpolated = true;
        let k = j + 1;
        while (k < blob.length && /[A-Za-z0-9_]/.test(blob[k])) k += 1;
        // A trailing -> or [ ] access is part of the same hole.
        if (blob.slice(k, k + 2) === '->') {
          k += 2;
          while (k < blob.length && /[A-Za-z0-9_]/.test(blob[k])) k += 1;
        }
        value += '${…}';
        j = k;
        continue;
      }
      value += c;
      j += 1;
    }

    // Concatenation is the other half of the same defect:
    //   db.query('SELECT … WHERE id = ' + id)          (JS)
    //   DB::select("SELECT … WHERE id = " . $id)       (PHP)
    // Neither is a template literal, and both are injectable. Looking at what
    // sits immediately after the closing quote is enough to tell.
    const after = blob.slice(j + 1, j + 40);
    const concatenated = isPhp
      ? /^\s*\.\s*[$A-Za-z_]/.test(after)
      : /^\s*\+\s*[A-Za-z_$]/.test(after);

    literals.push({ value, start, end: j, quote, interpolated, concatenated, holes });
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

/**
 * Is every hole in this string demonstrably NOT attacker-controlled?
 *
 * Two shapes are safe and both are common in real code:
 *
 *   `${CORE_WORKFLOW_AGGREGATE_COLUMNS}` — a module constant, fixed at build
 *   time and impossible to influence at runtime.
 *
 *   `${schemaName}` where `const schemaName = escapeIdentifier(...)` — an
 *   identifier that cannot be parameterized, passed through the escaping the
 *   rule would otherwise ask for. twentyhq/twenty#25669 was reported as a
 *   critical injection for exactly this, which is telling an author to fix
 *   what they already did correctly — on the most severe rule we have.
 *
 * A hole is only cleared on positive evidence. Anything unrecognised still
 * counts as unsafe.
 */
const ESCAPER_RE = /escapeIdentifier|escapeLiteral|quoteIdent|escapeId|sqlEscape|escapeString/i;

function holeIsSafe(expr, blob) {
  const e = String(expr).trim();
  if (!e) return false;

  // A module constant: SCREAMING_SNAKE_CASE, no call, no member access.
  if (/^[A-Z][A-Z0-9_]*$/.test(e)) return true;

  // The escaping happens inside the hole itself.
  if (ESCAPER_RE.test(e)) return true;

  // Or on an earlier line: `const schemaName = escapeIdentifier(...)`.
  //
  // Scanned line by line rather than with a regex built from a string. Two
  // separate attempts at the string-built version silently produced a literal
  // backspace character from '\b' and dropped '\s' entirely, so the check
  // never matched anything and the false positive stayed.
  if (/^[A-Za-z_$][\w$]*$/.test(e) && blob) {
    for (const line of String(blob).split('\n')) {
      if (!ESCAPER_RE.test(line)) continue;
      const at = line.indexOf(e);
      if (at === -1) continue;
      // It must be assigned TO, not merely mentioned: `<name> =`.
      const before = at === 0 ? '' : line[at - 1];
      const isWholeWord = !/[\w$]/.test(before);
      if (isWholeWord && /^\s*=[^=]/.test(line.slice(at + e.length))) return true;
    }
  }

  return false;
}

function ruleInjection(sql, literal) {
  // Every hole accounted for as safe means there is nothing to inject through.
  const holes = literal.holes || [];
  if (holes.length > 0 && holes.every(h => holeIsSafe(h, literal.blob))) return null;

  // Both forms build SQL out of a variable at runtime; only the syntax
  // differs. Treating just the template-literal form as injection meant PHP
  // interpolation and `'…' + id` concatenation went unreported entirely.
  if (!literal.interpolated && !literal.concatenated) return null;

  // A hole is safe when it lands in a spot that cannot carry a predicate —
  // in practice only LIMIT/OFFSET numerics read that way, and even those we
  // only clear when the whole query has no WHERE to poison.
  // Placement is decided by where the ${…} marker sits. A CONCATENATED string
  // has no marker — it simply ends where the variable is glued on — so the
  // hole IS the end of the string:
  //   'SELECT … WHERE id = ' + id   →   SELECT … WHERE id = ${…}
  // Without this the concat form passed the interpolation check above and then
  // failed here, which is why it stayed invisible even after the scanner
  // learned to flag it.
  const probe = literal.concatenated && !literal.interpolated ? `${sql} \${…}` : sql;

  const holeInPredicate = /\b(WHERE|AND|OR|HAVING|VALUES|SET|IN)\b[^;]*\$\{…\}/i.test(probe);
  const holeInIdentifier = /\b(FROM|JOIN|INTO|UPDATE)\s+\$\{…\}/i.test(probe);
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

// Unambiguous query call sites.
const QUERY_CALL_RE =
  /\.(query|execute|raw|findMany|findAll|findOne|findUnique|findFirst|aggregate|count)\s*\(|\$queryRaw|\$executeRaw|DB::(select|statement|insert|update|delete|table|raw)/;

// `->get()`, `->first()`, `->find()` and `->paginate()` are Eloquent — and are
// also Laravel's HTTP client, the cache, collections, and half the standard
// library. Matching them on sight reported `Http::withUserAgent(...)->get($url)`
// as a database round trip (koel/koel#2633), so they now need a query builder
// somewhere in the same statement before they count.
const AMBIGUOUS_PHP_QUERY_RE = /->(get|first|find|paginate)\s*\(/;
const PHP_BUILDER_HINT_RE =
  /DB::|->where[A-Za-z]*\s*\(|->orderBy\s*\(|->with\s*\(|->select\s*\(|->table\s*\(|->join\s*\(|->query\s*\(|::query\s*\(|::where[A-Za-z]*\s*\(|->newQuery\s*\(|Repository\b/;
const PHP_NON_DB_RECEIVER_RE =
  /\b(Http|Storage|Cache|Config|Session|Cookie|Redis|Log|Arr|Str|Route|View|Response|Request|File|Mail|Queue)::|\$request->|\bcollect\s*\(/;

// `for`/`while`/`foreach` open a loop; nothing else reliably does. The
// array-method family is ambiguous — `url.pathname.split('/').filter(Boolean)`
// is a chained call on a string, not iteration over rows, and counting it
// opened a "loop" that swallowed every query in the enclosing block
// (documenso/documenso#3301). Require the callback syntax a real body has.
const KEYWORD_LOOP_RE = /\b(for|while)\s*\(|\bforeach\s*\(/;
const METHOD_LOOP_RE = /\.\s*(forEach|map|flatMap|filter|reduce)\s*\(/;
const CALLBACK_RE = /=>|\bfunction\s*\(/;

function isLoopOpener(text) {
  if (KEYWORD_LOOP_RE.test(text)) return true;
  return METHOD_LOOP_RE.test(text) && CALLBACK_RE.test(text);
}

/**
 * Does the loop on this line open a block that later lines sit inside?
 *
 * A concise-body arrow — `fields.filter((f) => f.recipientId === id)` — is a
 * loop whose body begins and ends on its own line. It has no braces, so brace
 * tracking could never close it, and every query in the rest of the hunk
 * looked like it was inside (documenso/documenso#3301, second finding).
 */
function opensBlock(hunkLines, i) {
  const text = hunkLines[i].text;
  const delta = (text.match(/\{/g) || []).length - (text.match(/\}/g) || []).length;
  if (delta !== 0) return delta > 0;

  // Allman style puts the brace on the next line.
  for (let k = i + 1; k < hunkLines.length; k += 1) {
    const t = hunkLines[k].text.trim();
    if (t === '') continue;
    return t.startsWith('{');
  }
  return false;
}

/** Is this line a database call? `stmt` is the statement it sits in. */
function looksLikeQuery(text, stmt) {
  if (QUERY_CALL_RE.test(text)) return true;
  if (!AMBIGUOUS_PHP_QUERY_RE.test(text)) return false;
  if (PHP_NON_DB_RECEIVER_RE.test(stmt)) return false;
  return PHP_BUILDER_HINT_RE.test(stmt);
}

// `await` inside a loop over a query is the classic N+1: one round trip per
// element. Async iteration primitives that fan out concurrently (Promise.all,
// allSettled) are excluded — those are already a single logical batch.
function detectNPlusOne(hunkLines, filename) {
  const findings = [];
  let depth = 0;
  let loopDepth = null;
  let loopLine = null;

  for (let i = 0; i < hunkLines.length; i += 1) {
    const entry = hunkLines[i];
    const text = entry.text;

    if (loopDepth === null && isLoopOpener(text) && opensBlock(hunkLines, i)) {
      loopDepth = depth;
      loopLine = entry;
    }

    // Reported only on ADDED lines: context is here to close braces, not to
    // be commented on. A pre-existing loop with a newly added query inside it
    // is still a new N+1, so the OPENER may be context.
    if (loopDepth !== null && entry.added) {
      // The statement, not just the line — a fluent chain puts the receiver
      // that says whether this is a database call several lines above the
      // `->get(` that matches.
      const stmt = hunkLines.slice(Math.max(0, i - 3), i + 1).map(l => l.text).join('\n');

      // A CAPPED query inside a `while` is batched pagination — the deliberate,
      // recommended way to walk a large table — not an N+1. The options object
      // sits BELOW the call, so this looks forward; the window above is
      // backwards-only because a fluent chain puts its receiver above.
      // strapi#27427 was reported on exactly this shape:
      //   while (remaining > 0) { ...findMany({ ..., limit: batchLimit }) }
      const forward = hunkLines
        .slice(i, Math.min(hunkLines.length, i + 9)).map(l => l.text).join('\n');
      const capped = /\b(limit|take)\s*:\s*[\w.]|->(limit|take|forPage)\s*\(/.test(forward);
      const pagingLoop = /\bwhile\s*\(|\bfor\s*\(\s*;/.test(loopLine.text) && capped;

      // Same statement as the loop opener (e.g. `for (const r of await q())`)
      // is one query, not N.
      if (!pagingLoop
          && looksLikeQuery(text, stmt) && /\bawait\b|->|DB::/.test(text) && entry.line !== loopLine.line) {
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

    // Brace tracking. Correct now that context lines are included: before,
    // the closing braces of the loop were usually unchanged and therefore
    // invisible, so the loop never ended.
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
// -- ORM query quality ----------------------------------------------------
//
// The nine rules above read raw SQL TEXT. A sweep of 573 real merged PRs found
// raw SQL in a small minority of them and Eloquent in 60%, so those rules were
// aimed at a code path modern applications barely use. These rules read the
// ORM call SHAPE instead, which is where the queries actually are.
//
// Everything here is statement-aware, not line-aware: a builder chain is
// routinely split across lines, so `->limit(10)` and `->get()` usually sit on
// different ones, and a line-level check would call every bounded query
// unbounded.

/**
 * The whole statement containing line `i`, as one string.
 *
 * Walks out from the line until a statement boundary, bounded so that a
 * missing semicolon cannot swallow an entire file.
 */
function statementAround(hunkLines, i, maxSpan = 8) {
  let start = i;
  while (start > 0 && i - start < maxSpan) {
    const prev = hunkLines[start - 1].text.trim();
    if (prev === '' || /[;{}]$/.test(prev) || prev.startsWith('//') || prev.startsWith('*')) break;
    start -= 1;
  }
  let end = i;
  while (end < hunkLines.length - 1 && end - i < maxSpan) {
    if (/;\s*$/.test(hunkLines[end].text)) break;
    end += 1;
  }
  return hunkLines.slice(start, end + 1).map(l => l.text).join('\n');
}

// --- PHP / Eloquent ------------------------------------------------------

// A terminal fetch: the point rows actually leave the database. `->get()` and
// `::all()` with EMPTY parens only — `$request->get('key')` and
// `Http::...->get($url)` take arguments and are not queries.
const PHP_FETCH_RE = /->get\s*\(\s*\)|::all\s*\(\s*\)/;

// Anything that caps or aggregates in SQL. Any of these means it is bounded.
const PHP_BOUNDED_RE =
  /->(limit|take|paginate|simplePaginate|cursorPaginate|forPage|first|firstOrFail|firstWhere|find|findOrFail|chunk|chunkById|cursor|lazy|lazyById|exists|doesntExist|count|sum|avg|max|min|value|pluck)\s*\(/;

// `whereIn('id', $ids)` is bounded by an array the caller already holds in
// memory, so the result cannot be larger than something already sized. Real
// PRs are full of this shape — firefly-iii#12698 fired on it twice — and
// flagging it is exactly the noise-on-every-review failure these rules have to
// avoid. Counted as bounded even though it is not a LIMIT.
const PHP_KEYED_RE = /->(whereIn|whereKey|whereIntegerInRaw|whereBetween)\s*\(/;

// Reads with no filter of any kind: `Model::all()`, or a table read that
// never narrows. These cannot be defended as "bounded by the owner" because
// there is no owner in the query.
const PHP_UNFILTERED_RE = /\b[A-Z]\w*::all\s*\(\s*\)|DB::table\s*\([^)]*\)\s*->get\s*\(\s*\)/;

// Any narrowing at all. Custom Eloquent scopes (`->type(...)`, `->enabled()`)
// are indistinguishable from ordinary chained calls, so anything that looks
// like a scope call between the model and the fetch counts as a filter.
const PHP_FILTER_RE = /->(where[A-Za-z]*|having[A-Za-z]*|scope[A-Za-z]*|forUser|enabled|active|type|visible|published)\s*\(|::where[A-Za-z]*\s*\(/;

// Proof this is a query builder rather than some other fluent object.
const PHP_QUERY_HINT_RE =
  /\b[A-Z]\w*::(query|where[A-Za-z]*|with|all|select|orderBy|find)\s*\(|DB::table\s*\(|->where[A-Za-z]*\s*\(|->newQuery\s*\(|->join\s*\(|->orderBy\s*\(/;

// Work done in PHP that the database could have done.
const PHP_INMEMORY_FILTER_RE =
  /->get\s*\(\s*\)\s*(?:\r?\n\s*)?->\s*(filter|reject|where[A-Za-z]*|firstWhere|search|contains)\s*\(/;
const PHP_INMEMORY_AGGREGATE_RE =
  /->get\s*\(\s*\)\s*(?:\r?\n\s*)?->\s*(count|sum|avg|average|max|min)\s*\(/;
const PHP_INMEMORY_SORT_RE =
  /->get\s*\(\s*\)\s*(?:\r?\n\s*)?->\s*(sortBy|sortByDesc|sort|shuffle)\s*\(/;

// --- JS / TS ORMs --------------------------------------------------------

const JS_FETCH_RE = /\.(findMany|findAll)\s*\(/;
// TypeORM / Mongoose `.find({ ... })` — an OBJECT argument, never an array
// callback, so this cannot match Array.prototype.find.
const JS_OBJECT_FIND_RE = /\.find\s*\(\s*\{/;
const JS_BOUNDED_RE = /\b(take|limit|first|skip)\s*:\s*[\w.[]/;
// `where: { id: { in: ids } }` is bounded by an array the caller already holds
// — the JS equivalent of Eloquent's whereIn. Not a LIMIT, but the result
// cannot be larger than something already sized and in memory.
// `id:` is matched whether the value is a literal array or a variable holding
// one — `where: { id: attachmentIds }` is just as bounded as `id: [1, 2]`.
// The \b matters: it must NOT match `userId:` or `teamId:`, which are ordinary
// filters and bound nothing.
// `In(ids)` is TypeORM's operator form of the same thing (n8n#37857 fired on
// `where: { workflowId: In(workflowIds) }`, which is bounded by the argument).
const JS_KEYED_RE = /\bin\s*:\s*[\w.[]|\bid\s*:\s*[\w.[]|\[Op\.in\]|\bIn\s*\(/;
const JS_ORM_OPTION_RE = /\b(where|relations|include|select|orderBy|order)\s*:/;

/**
 * Reads that fetch an unbounded number of rows, and work done in application
 * memory that belongs in the query.
 */
function detectOrmQueryQuality(hunkLines, filename) {
  const findings = [];
  const isPhp = /\.php$/i.test(filename);
  const seen = new Set();

  for (let i = 0; i < hunkLines.length; i += 1) {
    const entry = hunkLines[i];
    if (!entry.added) continue;             // report only on new code
    const text = entry.text;
    const stmt = statementAround(hunkLines, i);

    const push = (kind, severity, title, detail, suggestion) => {
      const key = kind + ':' + entry.line;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push(buildFinding({
        filename, entry, kind, severity, title, detail, suggestion,
        snippet: text.trim(),
      }));
    };

    if (isPhp) {
      // Fetch-then-work-in-PHP is checked BEFORE the unbounded rule: it is the
      // more specific diagnosis of the same statement.
      // Anchored to the line holding the fetch, not merely to a line inside
      // the statement — otherwise every line of a multi-line chain reports the
      // same defect separately.
      const fetchOnThisLine = /->get\s*\(\s*\)/.test(text);

      if (fetchOnThisLine && PHP_INMEMORY_FILTER_RE.test(stmt)) {
        push('in_memory_filter', SEVERITY.HIGH,
          'Rows filtered in PHP instead of in the query',
          'Every row of the result set is loaded into PHP and then thrown away by the filter. The database can apply this condition against an index and return only the rows that match.',
          'Move the condition into the query - `->where(...)` before `->get()` - so the database does the filtering.');
        continue;
      }
      if (fetchOnThisLine && PHP_INMEMORY_AGGREGATE_RE.test(stmt)) {
        push('in_memory_aggregate', SEVERITY.HIGH,
          'Aggregate computed in PHP over a full result set',
          'This loads every row only to reduce it to a single number. The database computes the same value without transferring the rows.',
          'Use the query aggregate instead - `->count()`, `->sum(...)`, `->avg(...)` - which runs in SQL and returns one value.');
        continue;
      }
      if (fetchOnThisLine && PHP_INMEMORY_SORT_RE.test(stmt)) {
        push('in_memory_sort', SEVERITY.MEDIUM,
          'Result set sorted in PHP',
          'Sorting after the fetch means the whole set is loaded before it can be ordered, and any limit applied afterwards has already paid for every row.',
          'Order in the query - `->orderBy(...)` - so the database can use an index and a later limit is meaningful.');
        continue;
      }

      // NARROWED after a 626-PR sweep. The wider version - "a fetch with no
      // row cap" - fired five times and was wrong all five: every case was
      // "fetch the rows belonging to ONE owner" (a user's folders, a
      // dashboard's widgets, one accessory's acceptances, a type's
      // categories). That is ordinary correct code, and flagging it is noise
      // on every review, which is how a reviewer learns to ignore the tool.
      //
      // A filter bounds a query in practice even though it is not a LIMIT.
      // What remains is the case with NO filter at all: `Model::all()` and a
      // bare table read, where the row count is the whole table by
      // construction and cannot be argued about.
      // Anchored to the line that HOLDS the fetch, the same way the
      // in-memory rules are. Testing only the statement window meant every
      // line inside it reported — akaunting#3347 produced findings on a
      // closing brace and on a blank line.
      const unfilteredHere = /::all\s*\(\s*\)/.test(text) || fetchOnThisLine;

      if (unfilteredHere
          && PHP_UNFILTERED_RE.test(stmt)
          && !PHP_BOUNDED_RE.test(stmt)
          && !PHP_KEYED_RE.test(stmt)
          && !PHP_FILTER_RE.test(stmt)) {
        push('unbounded_orm_read', SEVERITY.HIGH,
          'Query fetches every matching row',
          'There is no row cap on this query, so the number of rows it returns is whatever the table holds. That is bounded on a development database and unbounded in production.',
          'Add a cap - `->limit(100)` - or page the results with `->paginate()`; use `->chunk()` when the intent really is to walk the whole table.');
        continue;
      }
      continue;
    }

    // --- JS / TS ---
    const isFetch = JS_FETCH_RE.test(text)
      || (JS_OBJECT_FIND_RE.test(text) && JS_ORM_OPTION_RE.test(stmt));
    if (!isFetch) continue;
    if (JS_BOUNDED_RE.test(stmt) || JS_KEYED_RE.test(stmt)) continue;
    // Same narrowing as PHP: a `where` means the caller has scoped the read to
    // something, and "all the widgets on this dashboard" is not a defect.
    // Only a read with no filter at all is reported.
    if (/\bwhere\s*:/.test(stmt)) continue;

    push('unbounded_orm_read', SEVERITY.HIGH,
      'Query fetches every matching row',
      'With no `take`/`limit`, this returns every row that matches. A `where` clause bounds WHICH rows come back, not HOW MANY - the count still grows with the table.',
      'Add a row cap (`take: 100` / `limit: 100`), and a `select` listing only the fields used downstream.');
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

    const isPhpFile = /\.php$/i.test(filename);
    const patchLines = extractPatchLines(file.patch);
    const addedLines = patchLines.filter(l => l.added).map(({ added, ...rest }) => rest);
    if (addedLines.length === 0) continue;

    // Rules that need multi-line context run per hunk, so a loop in one hunk
    // can never be paired with a query in an unrelated hunk.
    const hunks = new Map();
    const fullHunks = new Map();
    for (const entry of addedLines) {
      if (!hunks.has(entry.hunkIndex)) hunks.set(entry.hunkIndex, []);
      hunks.get(entry.hunkIndex).push(entry);
    }
    // Added AND context, for the rules that need to know where a block ends.
    for (const entry of patchLines) {
      if (!fullHunks.has(entry.hunkIndex)) fullHunks.set(entry.hunkIndex, []);
      fullHunks.get(entry.hunkIndex).push(entry);
    }

    for (const [hunkIndex, hunkLines] of hunks.entries()) {
      findings.push(...detectNPlusOne(fullHunks.get(hunkIndex), filename));
      findings.push(...detectOrmQueryQuality(fullHunks.get(hunkIndex), filename));

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

      for (const literal of extractStringLiterals(blob, isPhpFile)) {
        // Needed to see where a hole's variable came from.
        literal.blob = blob;
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

  }

  // Two rules can legitimately fire on the same statement (SELECT * plus an
  // ORDER BY with no LIMIT, say) — those are distinct findings. Identical
  // fingerprints are not, and happen when the same query is added twice.
  const seen = new Set();
  let deduped = findings.filter(f => {
    if (seen.has(f.fingerprint)) return false;
    seen.add(f.fingerprint);
    return true;
  });

  // A query inside a loop is ALSO an unbounded read, so both rules fire on the
  // same line — two review comments on one query, saying overlapping things
  // (seen on outline#13617). N+1 is the more specific and more actionable
  // diagnosis, so it wins and the generic one is dropped for that line.
  const nPlusOneLines = new Set(
    deduped.filter(f => f.kind === 'n_plus_one_query').map(f => `${f.file}:${f.line}`),
  );
  deduped = deduped.filter(
    f => !(f.kind === 'unbounded_orm_read' && nPlusOneLines.has(`${f.file}:${f.line}`)),
  );

  return deduped.sort((a, b) => a.severityRank - b.severityRank || a.file.localeCompare(b.file) || a.line - b.line);
}

module.exports = {
  analyzeSqlInFiles,
  isSqlRelevantFile,
  extractAddedLinesWithPositions,
  extractPatchLines,
  fingerprintOf,
  SEVERITY,
  SEVERITY_RANK,
};
