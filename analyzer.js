function detectReturnType(line) {
  if (/return\s+\[/.test(line)) return 'array';
  if (/return\s+new\s+/.test(line)) return 'object';
  if (/->toArray\(\)/.test(line)) return 'array';
  if (/json\(/.test(line)) return 'object';
  return 'unknown';
}

function detectParamType(line) {
  // Very basic heuristics
  if (/\(.*array.*\)/i.test(line)) return 'array';
  if (/\(.*object.*\)/i.test(line)) return 'object';
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
        // Attach return type to last matching flow
        const lastFlow = flows[flows.length - 1];
        if (lastFlow) {
          lastFlow.returnType = returnType;
        }
      }
    });
  });

  return flows;
}

function detectMismatches(flows) {
  return flows.map((flow, index) => {
    const nextFlow = flows[index + 1];

    if (!nextFlow) return flow;

    const output = flow.returnType || 'unknown';
    const expected = nextFlow.expectedInput || 'object'; // default assumption

    if (output !== 'unknown' && expected !== 'unknown' && output !== expected) {
      return {
        ...flow,
        mismatch: true,
        message: `Type mismatch: ${output} → ${expected}`
      };
    }

    return flow;
  });
}

module.exports = {
  enrichWithTypes,
  detectMismatches
};
