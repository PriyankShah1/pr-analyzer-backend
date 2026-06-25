// services/analysisService.js
// Orchestrates the full analysis pipeline for PHP and JS/TS files

const { parseLaravelFlow, extractAddedLines } = require('../parsers/phpParser');
const { parseJsFlow, isJsFile, extractAddedLines: extractJsAddedLines } = require('../parsers/jsParser');
const { enrichWithTypes, detectMismatches, detectBrokenDependencies } = require('../parsers/analyzerService');
const { buildVisualizationResponse }          = require('../visualizer');
const { guardLargePR, guardLargeJsPR, truncateLargeFiles, truncateLargeJsFiles, MAX_FILE_LINES } = require('../utils/validation');

// How many files go into the AI prompt — ranked by relevance, not array order.
// No per-file line cap here. The character ceiling in aiService.js (6000 chars)
// is the real guard — it measures actual prompt size, not an arbitrary line count.
// A 120-line controller is fully included; aiService trims if total exceeds the budget.
const MAX_CODE_CONTEXT_FILES = 5;

// ── File filters ──────────────────────────────────────────────────────────
function filterPHPFiles(files) {
  return files.filter(file => file.filename.endsWith('.php'));
}

function filterJsFiles(files) {
  return files.filter(file => isJsFile(file.filename));
}

// ── Low-signal files to deprioritize when picking AI context ──────────────
// Tests, configs, lockfiles rarely explain "what the PR does" — the
// controller/service files driving the actual flow matter more.
const LOW_SIGNAL_PATTERNS = [
  /\.test\./i, /\.spec\./i, /[\\/]tests?[\\/]/i, /[\\/]__tests__[\\/]/i,
  /package(-lock)?\.json$/i, /composer\.(json|lock)$/i,
  /\.env(\.|$)/i, /readme/i, /\.md$/i, /\.lock$/i,
  /jest\.config/i, /\.eslintrc/i, /tsconfig/i,
];

function isLowSignalFile(filename) {
  return LOW_SIGNAL_PATTERNS.some(pattern => pattern.test(filename));
}

// ── Build code context for AI explanation ─────────────────────────────────
// Ranks files by how many flows reference them (most relevant first),
// filters out low-signal files (tests, configs, lockfiles),
// and sends ALL added lines from each file — no per-file line cap.
// aiService.js's 6000-char ceiling is the only guard on total prompt size.
function buildCodeContext(files, flows, lineExtractor) {
  // Count how often each file appears in the detected flows
  const fileRelevance = new Map();
  flows.forEach(flow => {
    if (flow.file) {
      fileRelevance.set(flow.file, (fileRelevance.get(flow.file) || 0) + 1);
    }
  });

  // Sort by relevance score — files driving the most flows come first
  const rankedFiles = [...files]
    .filter(f => !isLowSignalFile(f.filename))
    .sort((a, b) => {
      const relevanceA = fileRelevance.get(a.filename) || 0;
      const relevanceB = fileRelevance.get(b.filename) || 0;
      return relevanceB - relevanceA;
    });

  // Fallback: if all files got filtered (e.g. PR is only test changes),
  // use original list so we still produce some context
  const candidateFiles = rankedFiles.length > 0 ? rankedFiles : files;

  const snippets = candidateFiles
    .slice(0, MAX_CODE_CONTEXT_FILES)
    .map(file => {
      const lines = lineExtractor(file.patch); // full file — no line slice
      if (lines.length === 0) return null;
      return `// ${file.filename}\n${lines.join('\n')}`;
    })
    .filter(Boolean);

  return snippets.join('\n\n');
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

// ── Analyse PHP files ─────────────────────────────────────────────────────
function analyzePhpFiles(phpFiles, prMeta) {
  guardLargePR(phpFiles);

  const truncated      = truncateLargeFiles(phpFiles);
  const truncatedNames = truncated.filter(f => f.truncated).map(f => f.filename);

  const { flows: rawFlows, deletedClasses, deletedFunctions } = parseLaravelFlow(truncated);
  let flows = enrichWithTypes(truncated, rawFlows);
  flows     = detectMismatches(flows);
  flows     = detectBrokenDependencies(flows, deletedClasses);

  const visualization = buildVisualizationResponse(flows, deletedClasses);
  const codeContext    = buildCodeContext(truncated, flows, extractAddedLines);

  if (deletedClasses.length > 0) {
    console.log(`[deleted php classes] ${deletedClasses.join(', ')}`);
  }

  return {
    ...prMeta,
    language:         'php',
    files:            truncated.map(f => ({ filename: f.filename, truncated: f.truncated || false })),
    flows,
    deletedClasses,
    deletedFunctions,
    visualization,
    codeContext,
    warnings: buildWarnings(truncatedNames, deletedClasses),
  };
}

// ── Analyse JS/TS files ───────────────────────────────────────────────────
function analyzeJsFiles(jsFiles, prMeta) {
  guardLargeJsPR(jsFiles);

  const truncated      = truncateLargeJsFiles(jsFiles);
  const truncatedNames = truncated.filter(f => f.truncated).map(f => f.filename);

  const { flows: rawFlows, deletedClasses, deletedFunctions } = parseJsFlow(truncated);
  let flows = detectMismatches(rawFlows);
  flows     = detectBrokenDependencies(flows, deletedClasses);

  const visualization = buildVisualizationResponse(flows, deletedClasses);
  const codeContext    = buildCodeContext(truncated, flows, extractJsAddedLines);

  if (deletedClasses.length > 0) {
    console.log(`[deleted js classes] ${deletedClasses.join(', ')}`);
  }

  return {
    ...prMeta,
    language:         'javascript',
    files:            truncated.map(f => ({ filename: f.filename, truncated: f.truncated || false })),
    flows,
    deletedClasses,
    deletedFunctions,
    visualization,
    codeContext,
    warnings: buildWarnings(truncatedNames, deletedClasses),
  };
}

// ── Auto-detect language and run correct parser ───────────────────────────
function analyzeFiles(allFiles, prMeta) {
  const phpFiles = filterPHPFiles(allFiles);
  const jsFiles  = filterJsFiles(allFiles);

  if (phpFiles.length > 0) {
    return analyzePhpFiles(phpFiles, prMeta);
  }

  if (jsFiles.length > 0) {
    return analyzeJsFiles(jsFiles, prMeta);
  }

  return buildEmptyResult(prMeta, 'No PHP or JS/TS files found in this PR');
}

// ── Warning builder ───────────────────────────────────────────────────────
function buildWarnings(truncatedNames, deletedClasses) {
  return [
    ...(truncatedNames.length > 0
      ? [`${truncatedNames.length} file(s) truncated (>${MAX_FILE_LINES} lines): ${truncatedNames.join(', ')}`]
      : []),
    ...(deletedClasses.length > 0
      ? [`${deletedClasses.length} class(es) deleted in this PR: ${deletedClasses.join(', ')}`]
      : []),
  ];
}

module.exports = { filterPHPFiles, filterJsFiles, buildEmptyResult, analyzeFiles };