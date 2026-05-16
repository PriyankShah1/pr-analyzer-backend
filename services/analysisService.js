// services/analysisService.js
// Orchestrates the full analysis pipeline for PHP and JS/TS files

const { parseLaravelFlow, extractAddedLines } = require('../parsers/phpParser');
const { parseJsFlow, isJsFile }               = require('../parsers/jsParser');
const { enrichWithTypes, detectMismatches, detectBrokenDependencies } = require('../parsers/analyzerService');
const { buildVisualizationResponse }          = require('../visualizer');
const { guardLargePR, guardLargeJsPR, truncateLargeFiles, truncateLargeJsFiles, MAX_FILE_LINES } = require('../utils/validation');

// ── File filters ──────────────────────────────────────────────────────────
function filterPHPFiles(files) {
  return files.filter(file => file.filename.endsWith('.php'));
}

function filterJsFiles(files) {
  return files.filter(file => isJsFile(file.filename));
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
    warnings: buildWarnings(truncatedNames, deletedClasses),
  };
}

// ── Auto-detect language and run correct parser ───────────────────────────
function analyzeFiles(allFiles, prMeta) {
  const phpFiles = filterPHPFiles(allFiles);
  const jsFiles  = filterJsFiles(allFiles);

  // PHP takes priority if both exist (mixed repo — PHP is primary)
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