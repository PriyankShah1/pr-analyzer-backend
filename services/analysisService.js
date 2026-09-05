// services/analysisService.js
// Orchestrates the full analysis pipeline for PHP, JS/TS, and React files.
//
// Detection strategy: file EXTENSION decides the parser, not content
// guessing — .php → phpParser, .jsx/.tsx → reactParser, .js/.ts → jsParser.
// This is a 100% reliable signal with zero ambiguity, unlike trying to
// detect "does this file contain JSX" from file content.
//
// A single PR can touch multiple categories at once (e.g. a full-stack PR
// changing both a backend route file and a React component) — in that
// case ALL applicable parsers run and their flows are MERGED into one
// result, rather than picking just one language and discarding the rest.

const { parseLaravelFlow, extractAddedLines } = require('../parsers/phpParser');
const { parseJsFlow, isJsFile, extractAddedLines: extractJsAddedLines } = require('../parsers/jsParser');
const { parseReactFlow, isReactFile, extractAddedLines: extractReactAddedLines } = require('../parsers/reactParser');
const { enrichWithTypes, detectMismatches, detectBrokenDependencies } = require('../parsers/analyzerService');
const { analyzeSqlInFiles } = require('../parsers/sqlAnalyzer');
const { buildVisualizationResponse }          = require('../visualizer');
const { guardLargePR, guardLargeJsPR, truncateLargeFiles, truncateLargeJsFiles, MAX_FILE_LINES } = require('../utils/validation');

const MAX_CODE_CONTEXT_FILES = 5;

// ── File filters ──────────────────────────────────────────────────────────
function filterPHPFiles(files) {
  return files.filter(file => file.filename.endsWith('.php'));
}

// JS/TS files that are NOT React files — .jsx/.tsx are claimed by
// filterReactFiles() instead, so a file is never double-counted.
function filterJsFiles(files) {
  return files.filter(file => isJsFile(file.filename) && !isReactFile(file.filename));
}

function filterReactFiles(files) {
  return files.filter(file => isReactFile(file.filename));
}

// ── Low-signal files to deprioritize when picking AI context ──────────────
const LOW_SIGNAL_PATTERNS = [
  /\.test\./i, /\.spec\./i, /[\\/]tests?[\\/]/i, /[\\/]__tests__[\\/]/i,
  /package(-lock)?\.json$/i, /composer\.(json|lock)$/i,
  /\.env(\.|$)/i, /readme/i, /\.md$/i, /\.lock$/i,
  /jest\.config/i, /\.eslintrc/i, /tsconfig/i,
];

function isLowSignalFile(filename) {
  return LOW_SIGNAL_PATTERNS.some(pattern => pattern.test(filename));
}

// ── Empty result when no supported files found ────────────────────────────
function buildEmptyResult(prMeta, reason) {
  return {
    ...prMeta,
    files:            [],
    flows:            [],
    deletedClasses:   [],
    deletedFunctions: {},
    language:         'none',
    codeContext:      '',
    visualization: {
      nodes: [],
      edges: [],
      stats: {
        totalNodes: 0, totalEdges: 0,
        mismatches: 0, staticCalls: 0,
        brokenDependencies: 0, deletedClasses: 0,
      },
    },
    warnings: [],
    message: reason || 'No supported files found in this PR',
  };
}

// ── Analyse PHP files — returns raw pieces for merging, not a final result ──
function analyzePhpFiles(phpFiles) {
  guardLargePR(phpFiles);

  const truncated      = truncateLargeFiles(phpFiles);
  const truncatedNames = truncated.filter(f => f.truncated).map(f => f.filename);

  const { flows: rawFlows, deletedClasses, deletedFunctions } = parseLaravelFlow(truncated);
  let flows = enrichWithTypes(truncated, rawFlows);
  flows     = detectMismatches(flows);
  flows     = detectBrokenDependencies(flows, deletedClasses);

  if (deletedClasses.length > 0) {
    console.log(`[deleted php classes] ${deletedClasses.join(', ')}`);
  }

  return {
    language: 'php',
    files: truncated.map(f => ({ filename: f.filename, truncated: f.truncated || false })),
    flows,
    deletedClasses,
    deletedFunctions,
    truncatedNames,
    codeContextFiles: truncated,
    codeContextExtractor: extractAddedLines,
  };
}

// ── Analyse JS/TS files (non-React) ────────────────────────────────────────
function analyzeJsFiles(jsFiles) {
  guardLargeJsPR(jsFiles);

  const truncated      = truncateLargeJsFiles(jsFiles);
  const truncatedNames = truncated.filter(f => f.truncated).map(f => f.filename);

  const { flows: rawFlows, deletedClasses, deletedFunctions } = parseJsFlow(truncated);
  let flows = detectMismatches(rawFlows);
  flows     = detectBrokenDependencies(flows, deletedClasses);

  if (deletedClasses.length > 0) {
    console.log(`[deleted js classes] ${deletedClasses.join(', ')}`);
  }

  return {
    language: 'javascript',
    files: truncated.map(f => ({ filename: f.filename, truncated: f.truncated || false })),
    flows,
    deletedClasses,
    deletedFunctions,
    truncatedNames,
    codeContextFiles: truncated,
    codeContextExtractor: extractJsAddedLines,
  };
}

// ── Analyse React files (.jsx/.tsx) ────────────────────────────────────────
function analyzeReactFiles(reactFiles) {
  guardLargeJsPR(reactFiles); // reuse JS threshold — similar file-count patterns

  const truncated      = truncateLargeJsFiles(reactFiles);
  const truncatedNames = truncated.filter(f => f.truncated).map(f => f.filename);

  const { flows, deletedComponents, zustandStoresDetected } = parseReactFlow(truncated);

  if (deletedComponents.length > 0) {
    console.log(`[deleted react components] ${deletedComponents.join(', ')}`);
  }
  if (zustandStoresDetected.length > 0) {
    console.log(`[zustand stores detected] ${zustandStoresDetected.join(', ')}`);
  }

  return {
    language: 'react',
    files: truncated.map(f => ({ filename: f.filename, truncated: f.truncated || false })),
    flows,
    deletedClasses: deletedComponents, // reuse the same field name for the frontend
    deletedFunctions: {},
    truncatedNames,
    codeContextFiles: truncated,
    codeContextExtractor: extractReactAddedLines,
  };
}

// ── Build code context across files from potentially different parsers ───
function buildMergedCodeContext(fileEntries, flows) {
  const fileRelevance = new Map();
  flows.forEach(flow => {
    if (flow.file) {
      fileRelevance.set(flow.file, (fileRelevance.get(flow.file) || 0) + 1);
    }
  });

  const ranked = [...fileEntries]
    .filter(entry => !isLowSignalFile(entry.file.filename))
    .sort((a, b) => {
      const relA = fileRelevance.get(a.file.filename) || 0;
      const relB = fileRelevance.get(b.file.filename) || 0;
      return relB - relA;
    });

  const candidates = ranked.length > 0 ? ranked : fileEntries;

  const snippets = candidates
    .slice(0, MAX_CODE_CONTEXT_FILES)
    .map(({ file, extractor }) => {
      const lines = extractor(file.patch);
      if (lines.length === 0) return null;
      return `// ${file.filename}\n${lines.join('\n')}`;
    })
    .filter(Boolean);

  return snippets.join('\n\n');
}

// ── Auto-detect language(s) and run applicable parsers, merging results ──
// A PR can span multiple categories (e.g. backend route file + React
// component in the same PR) — every applicable parser runs, and their
// flows/files/deleted-entities are merged into one combined result rather
// than picking a single "winner" language and discarding the rest.
function analyzeFiles(allFiles, prMeta) {
  const phpFiles   = filterPHPFiles(allFiles);
  const jsFiles    = filterJsFiles(allFiles);
  const reactFiles = filterReactFiles(allFiles);

  // SQL analysis is independent of the flow parsers — it reads raw added
  // lines, so it still has something to say about a PR whose files produced
  // no graph at all (a lone query change in an untracked file shape).
  const sqlFindings = analyzeSqlInFiles(allFiles);

  const results = [];
  if (phpFiles.length   > 0) results.push(analyzePhpFiles(phpFiles));
  if (jsFiles.length    > 0) results.push(analyzeJsFiles(jsFiles));
  if (reactFiles.length > 0) results.push(analyzeReactFiles(reactFiles));

  if (results.length === 0) {
    return { ...buildEmptyResult(prMeta, 'No PHP, JS/TS, or React files found in this PR'), sqlFindings };
  }

  const mergedFlows           = results.flatMap(r => r.flows);
  const mergedFiles           = results.flatMap(r => r.files);
  const mergedDeletedClasses  = results.flatMap(r => r.deletedClasses);
  const mergedDeletedFunctions = Object.assign({}, ...results.map(r => r.deletedFunctions));
  const mergedTruncatedNames  = results.flatMap(r => r.truncatedNames);

  // Language label reflects everything detected — e.g. "php" alone stays
  // "php", a mixed PR becomes "javascript+react" so the AI prompt and
  // frontend know multiple ecosystems are involved.
  const combinedLanguage = results.map(r => r.language).join('+');

  const visualization = buildVisualizationResponse(mergedFlows, mergedDeletedClasses);

  // Fold SQL counts into the same stats object the pills and triage read, so
  // consumers have one place to look for "how bad is this PR".
  visualization.stats.sqlFindings = sqlFindings.length;
  visualization.stats.sqlCritical = sqlFindings.filter(f => f.severity === 'critical').length;
  visualization.stats.sqlHigh     = sqlFindings.filter(f => f.severity === 'high').length;

  const allCodeContextFiles = results.flatMap(r =>
    r.codeContextFiles.map(f => ({ file: f, extractor: r.codeContextExtractor }))
  );
  const codeContext = buildMergedCodeContext(allCodeContextFiles, mergedFlows);

  return {
    ...prMeta,
    language: combinedLanguage,
    files: mergedFiles,
    flows: mergedFlows,
    deletedClasses: mergedDeletedClasses,
    deletedFunctions: mergedDeletedFunctions,
    visualization,
    codeContext,
    sqlFindings,
    warnings: buildWarnings(mergedTruncatedNames, mergedDeletedClasses),
  };
}

// ── Warning builder ───────────────────────────────────────────────────────
function buildWarnings(truncatedNames, deletedClasses) {
  return [
    ...(truncatedNames.length > 0
      ? [`${truncatedNames.length} file(s) truncated (>${MAX_FILE_LINES} lines): ${truncatedNames.join(', ')}`]
      : []),
    ...(deletedClasses.length > 0
      ? [`${deletedClasses.length} class(es)/component(s) deleted in this PR: ${deletedClasses.join(', ')}`]
      : []),
  ];
}


module.exports = { filterPHPFiles, filterJsFiles, filterReactFiles, buildEmptyResult, analyzeFiles };