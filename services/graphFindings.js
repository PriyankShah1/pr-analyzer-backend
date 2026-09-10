// services/graphFindings.js
//
// Turns the GRAPH parser's verdicts into the same `Finding` shape the SQL
// rules and the AI review produce, so they can be ranked, fingerprinted,
// posted as PR comments and tracked across revisions like everything else.
//
// Before this, the graph checks existed only as flags on an edge. They were
// drawn on the canvas and listed in the triage panel, but `result.risks` held
// only SQL + AI findings — so "Post comments" reported nothing to post on a PR
// whose only problem was a broken prop. The triage count and the postable
// count disagreed, with nothing on screen explaining why.
//
// ── What is NOT included, and why ────────────────────────────────────────
// `flow.mismatch` from analyzerService.detectMismatches() is deliberately
// left out. That check compares `flows[i].returnType` against
// `flows[i + 1].expectedInput` — ADJACENT ARRAY ELEMENTS, with nothing
// requiring the two flows to be connected at all. It fires on unrelated pairs,
// which is why the UI marks it "heuristic". Static rules here post at
// confidence 1; promoting a positional accident to a comment on someone's PR
// is exactly the confident-but-wrong output this project is built to avoid.
// It stays visible in the triage list as advisory only.

const {
  extractAddedLinesWithPositions,
  fingerprintOf,
  SEVERITY,
  SEVERITY_RANK,
} = require('../parsers/sqlAnalyzer');

/**
 * Anchor a graph finding to a real added line.
 *
 * Flows record which FILE a relationship lives in but no line number, so the
 * line is recovered by finding the added line containing a distinctive marker
 * (the JSX tag, the hook call, the deleted identifier).
 *
 * Requires EXACTLY ONE match. Two matches means we cannot tell which one the
 * finding refers to, and an inline comment on the wrong line is worse than no
 * inline comment — the finding simply stays unanchored and is reported in the
 * summary instead. Same uniqueness rule patchService applies before rewriting
 * code.
 */
function anchorTo(addedLines, marker) {
  if (!marker) return null;
  const hits = addedLines.filter(l => l.text.includes(marker));
  return hits.length === 1 ? hits[0] : null;
}

function build({ kind, severity, title, detail, suggestion, file, entry, snippet }) {
  return {
    kind,
    severity,
    severityRank: SEVERITY_RANK[severity],
    title,
    detail,
    suggestion,
    file,
    line: entry ? entry.line : null,
    diffPosition: entry ? entry.diffPosition : null,
    snippet: snippet.length > 240 ? snippet.slice(0, 240) + '…' : snippet,
    fingerprint: fingerprintOf(kind, file, snippet),
    source: 'static',
    confidence: 1,          // each rule below either matched or did not
    anchored: Boolean(entry),
  };
}

/**
 * @param flows  analysis flows, carrying the graph parser's verdicts
 * @param files  the PR's files, for their patches (used only to recover lines)
 */
function buildGraphFindings(flows = [], files = []) {
  const patchByFile = new Map();
  for (const f of files || []) {
    if (f && f.filename && f.patch) patchByFile.set(f.filename, f.patch);
  }

  const addedLinesFor = (file) => {
    const patch = patchByFile.get(file);
    return patch ? extractAddedLinesWithPositions(patch) : [];
  };

  const findings = [];

  for (const flow of flows) {
    const file = flow.file;
    if (!file) continue;
    const added = addedLinesFor(file);

    // ── Broken dependency: still referencing something deleted in this PR ──
    if (flow.brokenDependency) {
      const target = String(flow.to || '');
      const cls = target.includes('@') ? target.split('@')[0] : target.split('::')[0];
      const entry = anchorTo(added, cls);
      findings.push(build({
        kind: 'broken_dependency',
        severity: SEVERITY.CRITICAL,
        title: flow.from + ' references ' + flow.to + ', deleted in this PR',
        detail: flow.message
          || (cls + ' was removed in this PR but is still referenced here. This fails at build or run time.'),
        suggestion: 'Remove the reference to ' + cls + ', or restore it if the deletion was unintended.',
        file,
        entry,
        snippet: entry ? entry.text.trim() : (flow.from + ' -> ' + flow.to),
      }));
      continue;   // a broken dependency subsumes any prop verdict on the same edge
    }

    // ── Prop TYPE mismatch: a literal whose type contradicts the declaration ──
    if (Array.isArray(flow.typeMismatches) && flow.typeMismatches.length > 0) {
      const entry = anchorTo(added, '<' + flow.to);
      for (const t of flow.typeMismatches) {
        findings.push(build({
          kind: 'prop_type_mismatch',
          severity: SEVERITY.HIGH,
          title: flow.to + ' expects ' + t.propName + ': ' + t.declaredType
            + ', received ' + t.inferredType,
          detail: flow.from + ' passes ' + t.propName + '=' + t.rawValue + ', which is a '
            + t.inferredType + ', but ' + flow.to + ' declares ' + t.propName + ': '
            + t.declaredType + '. Literal values only — variables and expressions are '
            + 'never inferred, so this comparison is exact.',
          suggestion: t.declaredType === 'number'
            ? 'Pass a number: ' + t.propName + '={' + String(t.rawValue).replace(/["']/g, '') + '}'
            : 'Pass a ' + t.declaredType + ', or widen ' + flow.to + "'s declared type for " + t.propName + '.',
          file,
          entry,
          snippet: entry ? entry.text.trim() : ('<' + flow.to + ' ' + t.propName + '=' + t.rawValue + ' />'),
        }));
      }
      continue;   // reported as a type problem, not also as a name problem
    }

    // ── Prop NAME mismatch: passing a prop the child does not accept ──
    if (flow.propCheckStatus === 'checked_broken'
        && Array.isArray(flow.brokenProps) && flow.brokenProps.length > 0) {
      const entry = anchorTo(added, '<' + flow.to);
      findings.push(build({
        kind: 'prop_name_mismatch',
        severity: SEVERITY.HIGH,
        title: flow.to + ' does not accept ' + flow.brokenProps.join(', '),
        detail: flow.message
          || (flow.from + ' passes ' + flow.brokenProps.join(', ') + ', which ' + flow.to
              + ' does not destructure. The value arrives as undefined.'),
        suggestion: 'Either accept ' + flow.brokenProps.join(', ') + ' in ' + flow.to
          + "'s signature, or stop passing it if it was renamed.",
        file,
        entry,
        snippet: entry ? entry.text.trim() : ('<' + flow.to + ' ' + flow.brokenProps.join(' ') + ' />'),
      }));
    }

    // ── Missing hook dependency ──
    if (Array.isArray(flow.missingDeps) && flow.missingDeps.length > 0) {
      // flow.to reads like "useEffect(deps: [])" — anchor on the hook call.
      const hookName = String(flow.to || '').split('(')[0];
      const entry = anchorTo(added, hookName + '(');
      findings.push(build({
        kind: 'missing_hook_dependency',
        severity: SEVERITY.MEDIUM,
        title: hookName + ' is missing ' + flow.missingDeps.join(', ') + ' from its dependency array',
        detail: 'The hook body reads ' + flow.missingDeps.join(', ') + ' but they are absent from its '
          + 'dependency array, so the effect runs against stale values and will not re-run when they '
          + 'change. Setters and inner callback parameters are excluded from this check.',
        suggestion: 'Add ' + flow.missingDeps.join(', ') + ' to the dependency array.',
        file,
        entry,
        snippet: entry ? entry.text.trim() : (hookName + ' missing ' + flow.missingDeps.join(', ')),
      }));
    }
  }

  // The same edge can be reported by two parsers; identical fingerprints are
  // duplicates, distinct ones are genuinely different problems.
  const seen = new Set();
  return findings
    .filter((f) => {
      if (seen.has(f.fingerprint)) return false;
      seen.add(f.fingerprint);
      return true;
    })
    .sort((a, b) => a.severityRank - b.severityRank || a.file.localeCompare(b.file));
}

module.exports = { buildGraphFindings };
