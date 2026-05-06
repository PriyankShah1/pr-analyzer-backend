// services/analysisService.js
// Orchestrates the full analysis pipeline

const { parseLaravelFlow, extractAddedLines } = require('../parsers/phpParser');
const { enrichWithTypes, detectMismatches, detectBrokenDependencies } = require('../parsers/analyzerService');
const { buildVisualizationResponse } = require('../visualizer');
const { guardLargePR, truncateLargeFiles, MAX_FILE_LINES } = require('../utils/validation');

function filterPHPFiles(files) {
  return files.filter(file => file.filename.endsWith('.php'));
}

function buildEmptyResult(prMeta) {
  return {
    ...prMeta,
    files: [],
    flows: [],
    deletedClasses: [],
    deletedFunctions: {},
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
    message: 'No PHP files found in this PR',
  };
}

function analyzeFiles(phpFiles, prMeta) {
  // Guard size
  guardLargePR(phpFiles);

  // Truncate large files
  const truncated = truncateLargeFiles(phpFiles);
  const truncatedNames = truncated.filter(f => f.truncated).map(f => f.filename);

  // Full pipeline
  const { flows: rawFlows, deletedClasses, deletedFunctions } = parseLaravelFlow(truncated);
  let flows = enrichWithTypes(truncated, rawFlows);
  flows = detectMismatches(flows);
  flows = detectBrokenDependencies(flows, deletedClasses);

  const visualization = buildVisualizationResponse(flows, deletedClasses);

  if (deletedClasses.length > 0) {
    console.log(`[deleted classes] ${deletedClasses.join(', ')}`);
  }

  const warnings = [
    ...(truncatedNames.length > 0
      ? [`${truncatedNames.length} file(s) truncated (>${MAX_FILE_LINES} lines): ${truncatedNames.join(', ')}`]
      : []),
    ...(deletedClasses.length > 0
      ? [`${deletedClasses.length} class(es) deleted in this PR: ${deletedClasses.join(', ')}`]
      : []),
  ];

  return {
    ...prMeta,
    files: truncated.map(f => ({ filename: f.filename, truncated: f.truncated || false })),
    flows,
    deletedClasses,
    deletedFunctions,
    visualization,
    warnings,
  };
}

module.exports = { filterPHPFiles, buildEmptyResult, analyzeFiles };