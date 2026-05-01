
// analyzer.js

function detectReturnType(line) {
  if (/return\s+\[/.test(line))        return 'array';
  if (/return\s+new\s+/.test(line))    return 'object';
  if (/->toArray\(\)/.test(line))      return 'array';
  if (/json\(/.test(line))             return 'object';
  return 'unknown';
}

function enrichWithTypes(files, flows) {
  files.forEach(file => {
    if (!file.filename.endsWith('.php')) return;
    const lines = file.patch
      ? file.patch.split('\n').map(l => l.replace(/^\+/, '').trim())
      : [];

    lines.forEach(line => {
      const returnType = detectReturnType(line);
      if (returnType !== 'unknown') {
        const lastFlow = flows[flows.length - 1];
        if (lastFlow) lastFlow.returnType = returnType;
      }
    });
  });
  return flows;
}

function detectMismatches(flows) {
  return flows.map((flow, index) => {
    const nextFlow = flows[index + 1];
    if (!nextFlow) return flow;

    const output   = flow.returnType || 'unknown';
    const expected = nextFlow.expectedInput || 'object';

    if (output !== 'unknown' && expected !== 'unknown' && output !== expected) {
      return { ...flow, mismatch: true, message: `Type mismatch: ${output} → ${expected}` };
    }
    return flow;
  });
}

// ── NEW: Detect broken dependencies ──────────────────────────────────────
// A broken dependency is when:
// - Flow A calls ClassB@method
// - ClassB was deleted in this PR (present in deletedClasses)
// This means the code still references something that no longer exists.
function detectBrokenDependencies(flows, deletedClasses = []) {
  const deletedSet = new Set(deletedClasses);

  return flows.map(flow => {
    // Extract the class name from the "to" field
    // e.g. "userService@createUser" → "userService"
    // e.g. "User::find" → "User"
    const toNode  = flow.to || '';
    const toClass = toNode.includes('@')
      ? toNode.split('@')[0]
      : toNode.split('::')[0];

    if (deletedSet.has(toClass)) {
      return {
        ...flow,
        brokenDependency: true,
        mismatch: true, // treat as a critical issue
        message: `⚠️ ${toClass} was deleted in this PR but is still referenced here`,
      };
    }

    // Also check if the "from" class was deleted — meaning it calls something
    // but the caller itself is gone (less critical but worth flagging)
    const fromNode  = flow.from || '';
    const fromClass = fromNode.includes('@')
      ? fromNode.split('@')[0]
      : fromNode.split('::')[0];

    if (deletedSet.has(fromClass)) {
      return {
        ...flow,
        deletedSource: true,
        message: `🗑️ ${fromClass} was deleted in this PR`,
      };
    }

    return flow;
  });
}

module.exports = { enrichWithTypes, detectMismatches, detectBrokenDependencies };