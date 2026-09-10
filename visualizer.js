/**
 * visualizer.js
 * Converts flows into React Flow nodes + edges.
 */

const KNOWN_FACADES = new Set([
  'Cache','DB','Mail','Log','Event','Queue','Storage',
  'Redis','Http','Bus','Auth','Hash','Session','Config','Artisan'
]);

function getNodeType(name, flowTypesForNode) {
  if (flowTypesForNode && flowTypesForNode.size > 0) {
    if (flowTypesForNode.has('renders'))      return 'hook_owner_component';
    if (flowTypesForNode.has('hook'))         return 'hook_owner_component';
    if (flowTypesForNode.has('api_call'))     return 'hook_owner_component';
    if (flowTypesForNode.has('global_state')) return 'hook_owner_component';
  }

  if (/^use[A-Z]\w*\(/.test(name)) return 'hook';
  if (/^(GET|POST|PUT|PATCH|DELETE)\s/.test(name)) return 'api_call';
  if (/\.Provider$/.test(name)) return 'context_provider';
  if (/^createContext\(\)/.test(name)) return 'context_create';

  if (name.startsWith('Route:'))       return 'route';
  if (name.startsWith('Middleware:'))  return 'middleware';
  if (name.startsWith('Model:'))       return 'model';
  if (name.startsWith('prisma.'))      return 'model';

  if (/^[A-Z]\w+::/.test(name)) {
    const className = name.split('::')[0];
    return KNOWN_FACADES.has(className) ? 'facade' : 'model';
  }

  if (/^[A-Z]\w+\.(find|create|update|delete|save|count|aggregate)/.test(name)) return 'model';
  if (/\w*(Repository|Repo)\.\w+/.test(name)) return 'repository';

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

function buildNodeFlowTypeMap(flows) {
  const map = new Map();
  flows.forEach(flow => {
    if (!flow.from || !flow.type) return;
    if (!map.has(flow.from)) map.set(flow.from, new Set());
    map.get(flow.from).add(flow.type);
  });
  return map;
}

// What a node IS, judged by the edges pointing AT it.
//
// buildNodeFlowTypeMap only sees outgoing edges, so a node that is only ever
// a target — a leaf child component, a hook that calls nothing — had no type
// evidence at all and fell through to name-pattern guessing, which labelled
// every one of them "service". The target side of an edge is just as strong a
// signal: whatever `renders` points to is a component, whatever a `hook` edge
// points to is a hook.
const TARGET_TYPE_BY_FLOW = {
  renders:      'component',
  hook:         'hook',
  api_call:     'api_call',
  global_state: 'context_create',
};

function buildNodeTargetTypeMap(flows) {
  const map = new Map();
  flows.forEach(flow => {
    if (!flow.to || !flow.type) return;
    const inferred = TARGET_TYPE_BY_FLOW[flow.type];
    if (!inferred) return;
    if (!map.has(flow.to)) map.set(flow.to, inferred);
  });
  return map;
}

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

// ── Layered left-to-right layout ──────────────────────────────────────────
//
// Replaces a grid that placed nodes by array index and knew nothing about the
// edges, so a parent could land to the RIGHT of its children and every arrow
// ran backwards across the canvas.
//
// This is the standard layered approach: a node's COLUMN is its depth in the
// dependency graph, so every edge points rightward by construction. Within a
// column, children are ordered near their parents to cut crossings.
//
// Deliberately simple. A full Sugiyama pass (barycentre iteration, dummy
// nodes for long edges) would straighten a few more lines, but these graphs
// are tens of nodes, not thousands, and the win here is direction, not
// perfection.

const NODE_WIDTH  = 222;   // matches the card width the UI renders (§7.5)
const COLUMN_GAP  = 130;
const ROW_HEIGHT  = 132;

function layoutLeftToRight(nodes, edges) {
  if (nodes.length === 0) return;

  const byId = new Map(nodes.map(n => [n.id, n]));
  const outgoing = new Map(nodes.map(n => [n.id, []]));
  const incoming = new Map(nodes.map(n => [n.id, []]));

  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue;
    outgoing.get(e.source).push(e.target);
    incoming.get(e.target).push(e.source);
  }

  // ── Depth = longest path from a root ────────────────────────────────────
  // Longest path, not shortest: a node must sit to the right of EVERY parent,
  // otherwise one of its incoming edges still points backwards.
  const depth = new Map(nodes.map(n => [n.id, 0]));
  const roots = nodes.filter(n => incoming.get(n.id).length === 0).map(n => n.id);

  // Cycles are real in this data (mutual imports, recursive components), so
  // relaxation is capped instead of recursing — a cycle simply settles at the
  // depth its longest acyclic path gives it rather than hanging.
  const queue = roots.length > 0 ? [...roots] : [nodes[0].id];
  let guard = nodes.length * 4;
  while (queue.length > 0 && guard-- > 0) {
    const id = queue.shift();
    for (const next of outgoing.get(id)) {
      if (depth.get(next) < depth.get(id) + 1) {
        depth.set(next, depth.get(id) + 1);
        queue.push(next);
      }
    }
  }

  // ── Group into columns ──────────────────────────────────────────────────
  const columns = new Map();
  for (const n of nodes) {
    const d = depth.get(n.id);
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(n);
  }

  const orderedDepths = [...columns.keys()].sort((a, b) => a - b);

  // Order each column by the average row of its parents, so an edge travels
  // as horizontally as it can instead of cutting across the whole canvas.
  const rowOf = new Map();

  for (const d of orderedDepths) {
    const column = columns.get(d);

    if (d === orderedDepths[0]) {
      column.forEach((n, i) => rowOf.set(n.id, i));
    } else {
      const withKey = column.map((n, i) => {
        const parents = incoming.get(n.id).filter(p => rowOf.has(p));
        const key = parents.length === 0
          ? i
          : parents.reduce((sum, p) => sum + rowOf.get(p), 0) / parents.length;
        return { node: n, key, tiebreak: i };
      });
      withKey.sort((a, b) => a.key - b.key || a.tiebreak - b.tiebreak);
      withKey.forEach((entry, i) => rowOf.set(entry.node.id, i));
      columns.set(d, withKey.map(e => e.node));
    }
  }

  // ── Assign coordinates, each column vertically centred ──────────────────
  const tallest = Math.max(...orderedDepths.map(d => columns.get(d).length));

  orderedDepths.forEach((d, columnIndex) => {
    const column = columns.get(d);
    const offset = ((tallest - column.length) * ROW_HEIGHT) / 2;
    column.forEach((n, rowIndex) => {
      n.position = {
        x: columnIndex * (NODE_WIDTH + COLUMN_GAP),
        y: offset + rowIndex * ROW_HEIGHT,
      };
    });
  });
}

function buildVisualizationResponse(flows, deletedClasses = []) {
  const deduplicatedFlows = deduplicateFlows(flows);
  const deletedSet        = new Set(deletedClasses);
  const nodeFlowTypeMap   = buildNodeFlowTypeMap(deduplicatedFlows);
  const nodeTargetTypeMap = buildNodeTargetTypeMap(deduplicatedFlows);

  // Which file each node came from. The triage list uses this to offer
  // "Locate" on a SQL/AI finding (which knows a file, not a node), and the
  // detail panel shows it under the node name. A node's own outgoing flow is
  // the better source than an incoming one, since that is where it is defined.
  const nodeFileMap = new Map();
  deduplicatedFlows.forEach(flow => {
    if (!flow.file) return;
    if (!nodeFileMap.has(flow.from)) nodeFileMap.set(flow.from, flow.file);
  });
  deduplicatedFlows.forEach(flow => {
    if (!flow.file) return;
    if (!nodeFileMap.has(flow.to)) nodeFileMap.set(flow.to, flow.file);
  });

  const uniqueNodeNames = [];
  const seenNames       = new Set();

  deduplicatedFlows.forEach(flow => {
    [flow.from, flow.to].forEach(name => {
      if (!seenNames.has(name)) { seenNames.add(name); uniqueNodeNames.push(name); }
    });
  });

  deletedClasses.forEach(className => {
    if (!seenNames.has(className)) { seenNames.add(className); uniqueNodeNames.push(className); }
  });

  const nodeMap = new Map();
  uniqueNodeNames.forEach((name, index) => nodeMap.set(name, String(index + 1)));

  const nodesWithMismatches  = new Set();
  const nodesWithBrokenDeps  = new Set();
  const nodesWithBrokenProps = new Set();
  const nodesWithTypeMismatch = new Set();
  const nodesWithMissingDeps = new Map();

  deduplicatedFlows.forEach(flow => {
    if (flow.mismatch)         { nodesWithMismatches.add(flow.from); nodesWithMismatches.add(flow.to); }
    if (flow.brokenDependency) { nodesWithBrokenDeps.add(flow.to); }
    // A React prop type mismatch also carries checked_broken, so record it
    // separately — otherwise the node badge reads "PROP MISMATCH" when the
    // real problem is a wrong literal type, not an unaccepted prop name.
    if (flow.typeMismatches && flow.typeMismatches.length > 0) { nodesWithTypeMismatch.add(flow.to); }
    else if (flow.propCheckStatus === 'checked_broken') { nodesWithBrokenProps.add(flow.to); }
    if (flow.missingDeps && flow.missingDeps.length > 0) { nodesWithMissingDeps.set(flow.to, flow.missingDeps); }
  });

  const nodes = uniqueNodeNames.map((name) => {
    const id             = nodeMap.get(name);
    const hasMismatch    = nodesWithMismatches.has(name);
    const hasBrokenProps = nodesWithBrokenProps.has(name);
    const hasTypeMismatch = nodesWithTypeMismatch.has(name);
    const missingDeps    = nodesWithMissingDeps.get(name) || [];
    const hasMissingDeps = missingDeps.length > 0;

    const rawClass = name.includes('@')
      ? name.split('@')[0]
      : name.includes('.') ? name.split('.')[0] : name.split('::')[0];

    let nodeType = getNodeType(name, nodeFlowTypeMap.get(name));
    if (nodeType === 'hook_owner_component') nodeType = 'component';

    // Outgoing edges said nothing useful, so trust what points at this node
    // rather than guessing from its name.
    if (nodeType === 'service' && nodeTargetTypeMap.has(name)) {
      nodeType = nodeTargetTypeMap.get(name);
    }

    if (deletedSet.has(rawClass) || deletedSet.has(name)) {
      nodeType = 'deleted';
    } else if (nodesWithBrokenDeps.has(name)) {
      nodeType = 'broken';
    }

    return {
      id,
      type: 'custom',
      data: {
        label: name,
        type: nodeType,
        file: nodeFileMap.get(name) || null,
        hasMismatch,
        hasBrokenProps,
        hasTypeMismatch,
        hasMissingDeps,
        missingDeps,
        isDeleted: nodeType === 'deleted',
        isBroken: nodeType === 'broken',
      },
      // position is assigned by layoutLeftToRight() once the edges exist —
      // placing nodes before knowing what points at what is what produced the
      // criss-crossing grid this replaced.
      position: { x: 0, y: 0 },
    };
  });

  const edges = deduplicatedFlows.map((flow, index) => {
    const sourceId = nodeMap.get(flow.from);
    const targetId = nodeMap.get(flow.to);

    const isMismatch = flow.mismatch || false;
    const isBroken = flow.brokenDependency || false;
    const isDeletedSource = flow.deletedSource || false;
    const returnType = flow.returnType || 'unknown';
    const hasMissingDeps = flow.missingDeps && flow.missingDeps.length > 0;

    // The design keeps edges quiet: three stroke treatments carrying the
    // whole vocabulary (broken / fetch / props-render), no per-edge text.
    // Labels used to restate what the node badges and the right panel already
    // say, and at any real graph size they collided into noise.
    let strokeColor = 'var(--edge)';
    let strokeWidth = 1.2;
    let dash;

    if (flow.type === 'api_call') {
      strokeColor = '#00c48c';
      dash = '3 4';
    }

    if (isBroken || isDeletedSource) {
      strokeColor = '#ff5a3d';
      strokeWidth = 1.6;
      dash = '5 4';
    } else if (isMismatch || flow.propCheckStatus === 'checked_broken') {
      strokeColor = '#ff8a3d';
      strokeWidth = 1.6;
    } else if (hasMissingDeps) {
      strokeColor = '#ffc93d';
      strokeWidth = 1.6;
    }

    const isOrmCall = flow.type === 'orm_call';

    return {
      id: `e${sourceId}-${targetId}-${index}`,
      source: sourceId,
      target: targetId,
      type: 'default',
      animated: false,
      style: {
        stroke: strokeColor,
        strokeWidth,
        strokeDasharray: isOrmCall ? '5 5' : dash,
      },
      markerEnd: { type: 'arrowclosed', color: strokeColor, width: 14, height: 14 },
      data: {
        returnType,
        mismatch: isMismatch,
        brokenDependency: isBroken,
        deletedSource: isDeletedSource,
        ormCall: isOrmCall,
        message: flow.message,
        flowType: flow.type,
        file: flow.file,
        propCheckStatus: flow.propCheckStatus,
        // What the parent actually passes. The detail panel's PROPS section
        // renders this; without it the panel could only report prop PROBLEMS,
        // never the ordinary prop list the design asks for.
        passedProps: flow.passedProps || [],
        brokenProps: flow.brokenProps,
        typeMismatches: flow.typeMismatches || [],
        hookDeps: flow.hookDeps,
        missingDeps: flow.missingDeps || [],
        apiEndpoint: flow.apiEndpoint,
        globalStateKind: flow.globalStateKind,
        outputBinding: flow.outputBinding,
        usagesByVar: flow.usagesByVar,
        crossComponentTrace: flow.crossComponentTrace,
      },
    };
  });

  layoutLeftToRight(nodes, edges);

  return {
    nodes,
    edges,
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      mismatches: edges.filter(e => e.data.mismatch).length,
      staticCalls: edges.filter(e => e.data.flowType === 'static_call').length,
      ormCalls: edges.filter(e => e.data.ormCall).length,
      brokenDependencies: edges.filter(e => e.data.brokenDependency).length,
      deletedClasses: deletedClasses.length,
      // brokenProps stays the umbrella "prop issue" count (name + type);
      // propTypeMismatches is the Fix-4 subset, broken out for the triage list.
      brokenProps: edges.filter(e => e.data.propCheckStatus === 'checked_broken').length,
      propTypeMismatches: edges.filter(e => e.data.typeMismatches.length > 0).length,
      missingDeps: edges.filter(e => e.data.missingDeps && e.data.missingDeps.length > 0).length,
    },
  };
}

module.exports = { buildVisualizationResponse };