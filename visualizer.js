/**
 * visualizer.js
 * Converts flows into React Flow nodes + edges.
 * Supports PHP, JS/TS, ORM calls, deleted and broken dependency node types.
 */

const KNOWN_FACADES = new Set([
  'Cache','DB','Mail','Log','Event','Queue','Storage',
  'Redis','Http','Bus','Auth','Hash','Session','Config','Artisan'
]);

// ── Node type detector ────────────────────────────────────────────────────
function getNodeType(name) {
  // Route nodes
  if (name.startsWith('Route:'))       return 'route';
  if (name.startsWith('Middleware:'))  return 'middleware';
  if (name.startsWith('Model:'))       return 'model';

  // ORM calls — Prisma
  if (name.startsWith('prisma.'))      return 'model';

  // Facade / static calls (PHP)
  if (/^[A-Z]\w+::/.test(name)) {
    const className = name.split('::')[0];
    return KNOWN_FACADES.has(className) ? 'facade' : 'model';
  }

  // ORM — Mongoose/TypeORM static calls (UpperCase.method)
  if (/^[A-Z]\w+\.(find|create|update|delete|save|count|aggregate)/.test(name)) {
    return 'model';
  }

  // Repository calls (TypeORM)
  if (/\w*(Repository|Repo)\.\w+/.test(name)) return 'repository';

  // Class-based
  if (name.includes('Controller') || name.includes('Resolver')) return 'controller';
  if (name.includes('Repository') || name.includes('Repo'))     return 'repository';
  if (name.includes('Service'))                                  return 'service';
  if (name.includes('Guard'))                                    return 'middleware';
  if (name.includes('Job'))                                      return 'job';
  if (name.includes('Event'))                                    return 'event';
  if (name.includes('Client') || name.includes('Breaker'))       return 'client';
  if (name.includes('Handler'))                                  return 'service';

  return 'service';
}

// ── Deduplication ─────────────────────────────────────────────────────────
function deduplicateFlows(flows) {
  const uniqueFlows = new Map();
  flows.forEach(flow => {
    const key = `${flow.from}→${flow.to}`;
    if (!uniqueFlows.has(key)) {
      uniqueFlows.set(key, flow);
    } else if ((flow.mismatch || flow.brokenDependency) && !uniqueFlows.get(key).mismatch) {
      uniqueFlows.set(key, flow);
    }
  });
  return Array.from(uniqueFlows.values());
}

// ── Main builder ──────────────────────────────────────────────────────────
function buildVisualizationResponse(flows, deletedClasses = []) {
  const deduplicatedFlows = deduplicateFlows(flows);
  const deletedSet        = new Set(deletedClasses);

  // ── Step 1: Collect unique node names ─────────────────────────────────
  const uniqueNodeNames = [];
  const seenNames       = new Set();

  deduplicatedFlows.forEach(flow => {
    [flow.from, flow.to].forEach(name => {
      if (!seenNames.has(name)) {
        seenNames.add(name);
        uniqueNodeNames.push(name);
      }
    });
  });

  // Add deleted classes as standalone nodes
  deletedClasses.forEach(className => {
    if (!seenNames.has(className)) {
      seenNames.add(className);
      uniqueNodeNames.push(className);
    }
  });

  // ── Step 2: Build nodeMap ──────────────────────────────────────────────
  const nodeMap = new Map();
  uniqueNodeNames.forEach((name, index) => {
    nodeMap.set(name, String(index + 1));
  });

  // ── Step 3: Determine node states ─────────────────────────────────────
  const nodesWithMismatches    = new Set();
  const nodesWithBrokenDeps    = new Set();
  const nodesWithDeletedSource = new Set();

  deduplicatedFlows.forEach(flow => {
    if (flow.mismatch)         { nodesWithMismatches.add(flow.from); nodesWithMismatches.add(flow.to); }
    if (flow.brokenDependency) { nodesWithBrokenDeps.add(flow.to); }
    if (flow.deletedSource)    { nodesWithDeletedSource.add(flow.from); }
  });

  // ── Step 4: Build nodes ────────────────────────────────────────────────
  const nodesPerRow = Math.max(1, Math.ceil(Math.sqrt(uniqueNodeNames.length)));

  const nodes = uniqueNodeNames.map((name, index) => {
    const id          = nodeMap.get(name);
    const hasMismatch = nodesWithMismatches.has(name);

    const rawClass = name.includes('@')
      ? name.split('@')[0]
      : name.includes('.')
        ? name.split('.')[0]
        : name.split('::')[0];

    let nodeType = getNodeType(name);
    if (deletedSet.has(rawClass) || deletedSet.has(name)) {
      nodeType = 'deleted';
    } else if (nodesWithBrokenDeps.has(name)) {
      nodeType = 'broken';
    }

    return {
      id,
      type: 'custom',
      data: {
        label:      name,
        type:       nodeType,
        hasMismatch,
        isDeleted:  nodeType === 'deleted',
        isBroken:   nodeType === 'broken',
      },
      position: {
        x: (index % nodesPerRow) * 350,
        y: Math.floor(index / nodesPerRow) * 160,
      },
    };
  });

  // ── Step 5: Build edges ────────────────────────────────────────────────
  const edges = deduplicatedFlows.map((flow, index) => {
    const sourceId = nodeMap.get(flow.from);
    const targetId = nodeMap.get(flow.to);

    const isMismatch      = flow.mismatch         || false;
    const isBroken        = flow.brokenDependency || false;
    const isDeletedSource = flow.deletedSource    || false;
    const returnType      = flow.returnType        || 'unknown';

    let strokeColor = '#94a3b8';
    let edgeLabel   = returnType;

    if (isBroken) {
      strokeColor = '#f97316';
      edgeLabel   = `${returnType} 💥`;
    } else if (isMismatch) {
      strokeColor = '#ef4444';
      edgeLabel   = `${returnType} ❌`;
    } else if (isDeletedSource) {
      strokeColor = '#6b7280';
      edgeLabel   = `${returnType} 🗑️`;
    }

    // ORM calls get a distinct style — dashed border, model color
    const isOrmCall = flow.type === 'orm_call';

    return {
      id:       `e${sourceId}-${targetId}-${index}`,
      source:   sourceId,
      target:   targetId,
      label:    edgeLabel,
      animated: isMismatch || isBroken,
      style: {
        stroke:          strokeColor,
        strokeWidth:     (isMismatch || isBroken) ? 3 : 2,
        strokeDasharray: (isDeletedSource || isOrmCall) ? '5 5' : undefined,
      },
      markerEnd: {
        type:  'arrowclosed',
        color: strokeColor,
      },
      data: {
        returnType,
        mismatch:         isMismatch,
        brokenDependency: isBroken,
        deletedSource:    isDeletedSource,
        ormCall:          isOrmCall,
        message:          flow.message,
        flowType:         flow.type,
        file:             flow.file,
      },
    };
  });

  return {
    nodes,
    edges,
    stats: {
      totalNodes:         nodes.length,
      totalEdges:         edges.length,
      mismatches:         edges.filter(e => e.data.mismatch).length,
      staticCalls:        edges.filter(e => e.data.flowType === 'static_call').length,
      ormCalls:           edges.filter(e => e.data.ormCall).length,
      brokenDependencies: edges.filter(e => e.data.brokenDependency).length,
      deletedClasses:     deletedClasses.length,
    },
  };
}

module.exports = { buildVisualizationResponse };