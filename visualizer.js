/**
 * Converts parsed flows into React Flow compatible nodes and edges.
 * Single nodeMap used for both node generation and edge linking — no ID mismatch.
 */

const KNOWN_FACADES = new Set([
  'Cache', 'DB', 'Mail', 'Log', 'Event', 'Queue',
  'Storage', 'Redis', 'Http', 'Bus', 'Auth', 'Hash',
  'Session', 'Config', 'Artisan'
]);

function getNodeType(name) {
  if (name.startsWith('Route:'))      return 'route';
  if (name.startsWith('Middleware:')) return 'middleware';
  if (/^[A-Z]\w+::/.test(name)) {
    const className = name.split('::')[0];
    return KNOWN_FACADES.has(className) ? 'facade' : 'model';
  }
  if (name.includes('Controller'))    return 'controller';
  if (name.includes('Repository') || name.includes('Repo')) return 'repository';
  if (name.includes('Service'))       return 'service';
  if (name.includes('Job'))           return 'job';
  if (name.includes('Event'))         return 'event';
  if (name.includes('Client') || name.includes('Breaker')) return 'client';
  return 'service';
}

function deduplicateFlows(flows) {
  const uniqueFlows = new Map();

  flows.forEach(flow => {
    const key = `${flow.from}→${flow.to}`;
    if (!uniqueFlows.has(key)) {
      uniqueFlows.set(key, flow);
    } else if (flow.mismatch && !uniqueFlows.get(key).mismatch) {
      // Prefer the mismatch version if duplicate
      uniqueFlows.set(key, flow);
    }
  });

  return Array.from(uniqueFlows.values());
}

function buildVisualizationResponse(flows) {
  const deduplicatedFlows = deduplicateFlows(flows);

  // ── Step 1: Collect all unique node names ──────────────────────────────────
  const uniqueNodeNames = [];
  const seenNames = new Set();

  deduplicatedFlows.forEach(flow => {
    if (!seenNames.has(flow.from)) {
      seenNames.add(flow.from);
      uniqueNodeNames.push(flow.from);
    }
    if (!seenNames.has(flow.to)) {
      seenNames.add(flow.to);
      uniqueNodeNames.push(flow.to);
    }
  });

  // ── Step 2: Build nodeMap (label → id) — single source of truth ───────────
  const nodeMap = new Map();
  uniqueNodeNames.forEach((name, index) => {
    nodeMap.set(name, String(index + 1));
  });

  // ── Step 3: Build nodes using nodeMap ─────────────────────────────────────
  const nodesWithMismatches = new Set();
  deduplicatedFlows.forEach(flow => {
    if (flow.mismatch) {
      nodesWithMismatches.add(flow.from);
      nodesWithMismatches.add(flow.to);
    }
  });

  const nodesPerRow = Math.max(1, Math.ceil(Math.sqrt(uniqueNodeNames.length)));

  const nodes = uniqueNodeNames.map((name, index) => {
    const id = nodeMap.get(name);
    const hasMismatch = nodesWithMismatches.has(name);

    return {
      id,
      type: 'custom',
      data: {
        label: name,
        type: getNodeType(name), // ✅ proper type detection
        hasMismatch,
      },
      position: {
        x: (index % nodesPerRow) * 350,
        y: Math.floor(index / nodesPerRow) * 160,
      },
    };
  });

  // ── Step 4: Build edges using same nodeMap ─────────────────────────────────
  const edges = deduplicatedFlows.map((flow, index) => {
    const sourceId = nodeMap.get(flow.from);
    const targetId = nodeMap.get(flow.to);

    const isMismatch = flow.mismatch || false;
    const returnType = flow.returnType || 'unknown';

    return {
      id: `e${sourceId}-${targetId}-${index}`,
      source: sourceId,
      target: targetId,
      label: isMismatch ? `${returnType} ❌` : returnType,
      animated: isMismatch,
      style: {
        stroke: isMismatch ? '#ef4444' : '#94a3b8',
        strokeWidth: isMismatch ? 3 : 2,
      },
      markerEnd: {
        type: 'arrowclosed',
        color: isMismatch ? '#ef4444' : '#94a3b8',
      },
      data: {
        returnType,
        mismatch: isMismatch,
        message: flow.message,
        flowType: flow.type,
        file: flow.file,
      },
    };
  });

  return {
    nodes,
    edges,
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      mismatches: edges.filter(e => e.data.mismatch).length,
      staticCalls: edges.filter(e => e.data.flowType === 'static_call').length,
    },
  };
}

module.exports = { buildVisualizationResponse };