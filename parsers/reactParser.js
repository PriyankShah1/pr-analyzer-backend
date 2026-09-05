// parsers/reactParser.js — Phases 1-5, 6A, 6B, 6C, Fix 3 (missing deps, corrected)
const REACT_EXTENSIONS = ['.jsx', '.tsx'];
function isReactFile(filename) { return REACT_EXTENSIONS.some(ext => filename.endsWith(ext)); }

function extractAddedLines(patch) {
  if (!patch) return [];
  return patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1).trim());
}
function extractDeletedLines(patch) {
  if (!patch) return [];
  return patch.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1).trim());
}

const functionComponentRegex = /(?:export\s+default\s+)?(?:export\s+)?function\s+([A-Z]\w*)\s*\(/;
const arrowComponentRegex    = /(?:export\s+)?const\s+([A-Z]\w*)\s*(?::\s*[\w.<>[\]]+\s*)?=\s*(?:\([^)]*\)|[a-zA-Z_]\w*)\s*(?::\s*[\w.<>[\]]+\s*)?=>/;
const classComponentRegex    = /class\s+([A-Z]\w*)\s+extends\s+(?:React\.)?Component/;
const jsxUsageRegex = /<([A-Z]\w*)(?:\.(\w+))?[\s/>]/g;

const spreadPropsRegex = /\{\s*\.\.\.\w+\s*\}/;
// Captures the expression inside {...EXPR} — a bare variable name, or an
// inline object literal like {...{ a, b }}.
const spreadCaptureRegex = /\{\s*\.\.\.\s*(\{[^}]*\}|\w+)\s*\}/;
// Rest-destructure pattern: const { id, ...rest } = someSource — deliberately
// NOT resolved (see Fix 1 design decision): computing "everything except id"
// requires knowing the full shape of someSource, which we often don't have.
// We detect it only so we can report an honest, specific reason rather than
// a generic "can't verify".
const restDestructureRegex = /const\s*\{[^}]*\.\.\.(\w+)[^}]*\}\s*=\s*(\w+)/;
// A plain object literal assigned to a variable: const config = { a, b, c }
// Used to resolve Pattern 3 — spreading a variable that's itself a
// traceable object literal declared earlier in the same component.
const objectLiteralAssignRegex = /const\s+(\w+)\s*=\s*\{([^}]*)\}/;

const jsxPropNameRegex = /(\w+)(?:=(?:\{[^}]*\}|"[^"]*"|'[^']*'))?/g;
// BUG FIX: previously required the closing `)` to come IMMEDIATELY after
// the destructured `{...}` — this broke on the extremely common pattern of
// a named type annotation, e.g. `({ count, active }: SidebarProps)`. The
// `(?::\s*[^)]+)?` addition allows an optional `: TypeName` (or inline
// `: { ... }`) between the destructure and the closing paren, without
// which extractAcceptedProps AND extractPropTypes (Fix 4) would silently
// report "no signature found" for any component using a named props type —
// which is the majority of real-world TypeScript React components.
const destructuredPropsRegex = /(?:function\s+[A-Z]\w*|const\s+[A-Z]\w*\s*=)\s*\(\s*\{\s*([^}]+)\}\s*(?::\s*[^)]+)?\)/;

const hookWithDepsFullRegex = /\b(useEffect|useCallback|useMemo)\s*\(\s*(?:async\s*)?\(?\s*\)?\s*=>\s*\{([\s\S]*?)\}\s*,\s*\[([^\]]*)\]\s*\)/;
const hookWithDepsRegex = /\b(useEffect|useCallback|useMemo)\s*\([\s\S]*?,\s*\[([^\]]*)\]\s*\)/;
const hookCallRegex = /\b(use[A-Z]\w*)\s*\(([^)]*)\)/g;

const BUILT_IN_HOOKS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
  'useMemo', 'useRef', 'useImperativeHandle', 'useLayoutEffect',
  'useDebugValue', 'useDeferredValue', 'useTransition', 'useId',
  'useSyncExternalStore', 'useInsertionEffect',
]);

const GLOBAL_IDENTIFIERS = new Set([
  'console', 'window', 'document', 'Math', 'JSON', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Promise', 'Error', 'Map', 'Set',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'axios', 'undefined', 'null', 'true', 'false', 'this',
]);

const axiosCallRegex = /\baxios\.(get|post|put|patch|delete)\s*\(\s*([^,)]+)/;
const fetchCallRegex = /\bfetch\s*\(\s*([^,)]+)/;

function extractEndpointPath(rawUrlArg) {
  const trimmed = rawUrlArg.trim();
  const templateMatch = trimmed.match(/^`\$\{[^}]+\}(.*)`$/);
  if (templateMatch) { const p = templateMatch[1]; return p.length > 0 ? p : '(base URL only)'; }
  const plainTemplateMatch = trimmed.match(/^`([^`]*)`$/);
  if (plainTemplateMatch) return plainTemplateMatch[1];
  const stringMatch = trimmed.match(/^['"]([^'"]*)['"]$/);
  if (stringMatch) return stringMatch[1];
  return null;
}

const createContextRegex = /const\s+(\w+)\s*=\s*createContext\s*\(/;
const contextProviderRegex = /<(\w+)\.Provider\b/;
const useContextRegex = /useContext\s*\(\s*(\w+)\s*\)/;
const useSelectorRegex = /useSelector\s*\(/;
const useDispatchRegex = /useDispatch\s*\(/;
const zustandCreateRegex = /const\s+(\w+)\s*=\s*create\s*(?:<[^>]+>)?\s*\(/;

const arrayDestructureRegex = /const\s*\[\s*([^\]]+)\]\s*=\s*/;
const objectDestructureRegex = /const\s*\{\s*([^}]+)\}\s*=\s*(?:await\s+)?/;
const singleBindingRegex = /const\s+(\w+)\s*=\s*(?:await\s+)?/;

const PROP_CHECK = {
  CHECKED_OK: 'checked_ok', CHECKED_BROKEN: 'checked_broken',
  SKIPPED_SPREAD: 'skipped_spread', SKIPPED_NO_SIGNATURE: 'skipped_no_signature',
  SKIPPED_UNKNOWN_CHILD: 'skipped_unknown_child',
};

const USAGE_KIND = {
  JSX_PROP: 'jsx_prop', JSX_EXPRESSION: 'jsx_expression', FUNCTION_CALL: 'function_call',
  CONDITION: 'condition', ASSIGNMENT: 'assignment', PROPERTY_ACCESS: 'property_access',
};

function classifyReactComponent(name) {
  if (/Provider$/.test(name))  return 'provider';
  if (/Page$/.test(name))      return 'page';
  if (/Layout$/.test(name))    return 'layout';
  if (/Panel$/.test(name))     return 'panel';
  if (/Modal$|Dialog$/.test(name)) return 'modal';
  if (/Icon$/.test(name))      return 'icon';
  if (/Button$/.test(name))    return 'button';
  return 'component';
}

function extractOutputBinding(line) {
  const arrayMatch = line.match(arrayDestructureRegex);
  if (arrayMatch) {
    const names = arrayMatch[1].split(',').map(n => n.trim()).map(n => n.split('=')[0].trim()).filter(Boolean);
    return { pattern: 'array_destructure', names };
  }
  const objectMatch = line.match(objectDestructureRegex);
  if (objectMatch) {
    const names = objectMatch[1].split(',').map(n => n.trim()).map(n => n.split(':')[0].trim()).map(n => n.split('=')[0].trim()).filter(Boolean);
    return { pattern: 'object_destructure', names };
  }
  const singleMatch = line.match(singleBindingRegex);
  if (singleMatch) return { pattern: 'single', names: [singleMatch[1]] };
  return { pattern: 'none', names: [] };
}

function formatBindingLabel(binding) {
  if (!binding || binding.pattern === 'none' || binding.names.length === 0) return null;
  if (binding.pattern === 'array_destructure')  return `→ [${binding.names.join(', ')}]`;
  if (binding.pattern === 'object_destructure') return `→ {${binding.names.join(', ')}}`;
  return `→ ${binding.names[0]}`;
}

function classifyUsage(line, varName) {
  const jsxPropPattern = new RegExp(`\\w+=\\{\\s*${varName}(?:\\.[\\w.]+)?\\s*\\}`);
  if (jsxPropPattern.test(line) && line.includes('<')) return USAGE_KIND.JSX_PROP;

  const jsxExpressionPattern = new RegExp(`\\{\\s*${varName}(?:\\.[\\w.]+)?\\s*[}&|?]`);
  if (jsxExpressionPattern.test(line) && !jsxPropPattern.test(line)) return USAGE_KIND.JSX_EXPRESSION;

  const conditionPattern = new RegExp(`(?:if\\s*\\([^)]*\\b${varName}\\b|\\b${varName}\\b\\s*(?:&&|\\?|===|!==|==|!=))`);
  if (conditionPattern.test(line)) return USAGE_KIND.CONDITION;

  const assignmentPattern = new RegExp(`\\w+\\s*(?:=|:)\\s*${varName}\\b(?!\\s*=)`);
  if (assignmentPattern.test(line) && !line.trim().startsWith('const') && !line.trim().startsWith('let')) return USAGE_KIND.ASSIGNMENT;

  const varNameIsTheCallPattern = new RegExp(`\\b${varName}\\s*\\(`);
  const varNameAsArgumentPattern = new RegExp(`\\w+\\s*\\([^)]*\\b${varName}\\b[^)]*\\)`);
  const varNameMethodCallPattern = new RegExp(`\\b${varName}\\.\\w+\\s*\\(`);
  if (varNameIsTheCallPattern.test(line) || varNameAsArgumentPattern.test(line) || varNameMethodCallPattern.test(line)) {
    return USAGE_KIND.FUNCTION_CALL;
  }

  const bracketAccessPattern = new RegExp(`\\b${varName}\\s*\\[|\\[\\s*${varName}\\s*\\]`);
  if (bracketAccessPattern.test(line)) return USAGE_KIND.PROPERTY_ACCESS;

  const propertyAccessPattern = new RegExp(`\\b${varName}\\.[\\w.]+`);
  if (propertyAccessPattern.test(line)) return USAGE_KIND.PROPERTY_ACCESS;

  return USAGE_KIND.PROPERTY_ACCESS;
}

function extractAccessedProperty(line, varName) {
  const dotMatch = line.match(new RegExp(`\\b${varName}\\.([\\w.]+)`));
  if (dotMatch) return dotMatch[1];
  const varIndexedMatch = line.match(new RegExp(`\\b${varName}\\s*\\[\\s*([\\w.'"]+)\\s*\\]`));
  if (varIndexedMatch) return `[${varIndexedMatch[1]}]`;
  const varAsKeyMatch = new RegExp(`\\[\\s*${varName}\\s*\\]`).test(line);
  if (varAsKeyMatch) return '(used as index key)';
  return null;
}

function extractJsxPropTarget(line, varName) {
  const match = line.match(new RegExp(`<([A-Z]\\w*)(?:\\.\\w+)?[^>]*\\b(\\w+)=\\{\\s*${varName}(?:\\.[\\w.]+)?\\s*\\}`));
  if (!match) return null;
  return { childComponent: match[1], propNameOnChild: match[2] };
}

function traceAcrossComponents(componentName, varName, allComponentData, visitedPath = []) {
  if (visitedPath.includes(componentName)) {
    return [{ hopBlocked: true, componentName, reason: 'Already visited this component on this path — stopped to avoid infinite loop.' }];
  }
  const componentData = allComponentData.get(componentName);
  if (!componentData) {
    return [{ hopBlocked: true, componentName, reason: `${componentName} is not declared in this PR's changed files — cannot trace further.` }];
  }

  const newPath = [...visitedPath, componentName];
  const localUsages = traceVariableUsages(componentData.lines, varName, null);
  const hops = [];

  localUsages.forEach(usage => {
    if (usage.kind !== USAGE_KIND.JSX_PROP) return;
    const target = extractJsxPropTarget(usage.line, varName);
    if (!target) return;

    const childData = allComponentData.get(target.childComponent);
    if (!childData) {
      hops.push({ fromComponent: componentName, toComponent: target.childComponent, propName: target.propNameOnChild, resolved: false, reason: `${target.childComponent} is not declared in this PR's changed files — its parameter name for this prop is unknown.` });
      return;
    }
    const childAcceptsThisProp = childData.acceptedProps?.props?.includes(target.propNameOnChild);
    if (!childAcceptsThisProp) {
      hops.push({ fromComponent: componentName, toComponent: target.childComponent, propName: target.propNameOnChild, resolved: false, reason: `${target.childComponent} does not destructure "${target.propNameOnChild}" in its props — likely dead prop or already caught by broken-prop detection.` });
      return;
    }
    const deeperHops = traceAcrossComponents(target.childComponent, target.propNameOnChild, allComponentData, newPath);
    hops.push({ fromComponent: componentName, toComponent: target.childComponent, propName: target.propNameOnChild, resolved: true, childLocalUsages: traceVariableUsages(childData.lines, target.propNameOnChild, null), furtherHops: deeperHops });
  });

  return hops;
}

function traceVariableUsages(componentLines, varName, bindingLine) {
  const usages = [];
  const varBoundaryPattern = new RegExp(`\\b${varName}\\b`);
  componentLines.forEach(line => {
    if (line === bindingLine) return;
    if (!varBoundaryPattern.test(line)) return;
    usages.push({ line: line.trim(), kind: classifyUsage(line, varName), accessedProperty: extractAccessedProperty(line, varName) });
  });
  return usages;
}

// ── Fix 3 (corrected): Missing dependency detection ───────────────────────
function findMissingDependencies(bodyText, depsArray, componentScopeNames) {
  if (!bodyText) return [];

  const locallyDeclaredNames = new Set();
  const declRegex = /(?:const|let)\s+(?:\[([^\]]+)\]|\{([^}]+)\}|(\w+))\s*=/g;
  let declMatch;
  while ((declMatch = declRegex.exec(bodyText)) !== null) {
    const [, arr, obj, single] = declMatch;
    if (arr) arr.split(',').forEach(n => locallyDeclaredNames.add(n.trim().split('=')[0].trim()));
    if (obj) obj.split(',').forEach(n => locallyDeclaredNames.add(n.trim().split(':')[0].trim().split('=')[0].trim()));
    if (single) locallyDeclaredNames.add(single);
  }

  // Names used as PARAMETERS of any inner arrow function/callback within
  // the body (e.g. ".then(res => ...)") are locally scoped, not outer refs.
  const paramRegex = /\(?\s*(\w+)\s*\)?\s*=>/g;
  let paramMatch;
  while ((paramMatch = paramRegex.exec(bodyText)) !== null) {
    locallyDeclaredNames.add(paramMatch[1]);
  }
  const multiParamRegex = /\(\s*(\w+(?:\s*,\s*\w+)*)\s*\)\s*=>/g;
  let multiParamMatch;
  while ((multiParamMatch = multiParamRegex.exec(bodyText)) !== null) {
    multiParamMatch[1].split(',').forEach(p => locallyDeclaredNames.add(p.trim()));
  }

  const depsSet = new Set(depsArray.map(d => d.trim()));
  const missing = [];

  // Strip the CONTENTS of string/template literals before scanning for
  // real identifier usage — otherwise a word that only appears inside a
  // URL or plain string (e.g. `${API}/explain/languages`) gets mistaken
  // for a reference to an outer variable of the same name (e.g. a
  // "languages" state variable). Backtick, single-quote, and double-quote
  // strings are all replaced with a same-length run of "x" so positions/
  // length stay roughly stable for other regexes, but no real word inside
  // them can match a \b-bounded identifier check.
  const bodyTextForUsageCheck = bodyText
    .replace(/`(?:[^`\\]|\\.)*`/g, m => 'x'.repeat(m.length))
    .replace(/"(?:[^"\\]|\\.)*"/g, m => 'x'.repeat(m.length))
    .replace(/'(?:[^'\\]|\\.)*'/g, m => 'x'.repeat(m.length));

  componentScopeNames.forEach(name => {
    if (/^set[A-Z]/.test(name)) return; // useState setters are always stable
    if (locallyDeclaredNames.has(name)) return;
    if (depsSet.has(name)) return;
    if (GLOBAL_IDENTIFIERS.has(name)) return;

    // Only count as "used" if not immediately preceded by a dot — avoids
    // matching a PROPERTY name like "res.data.languages" against an outer
    // variable called "languages". Checked against the STRIPPED body text
    // so words inside strings/template literals can never match either.
    const realUsagePattern = new RegExp(`(?<!\\.)\\b${name}\\b`);
    if (realUsagePattern.test(bodyTextForUsageCheck)) missing.push(name);
  });

  return missing;
}

function extractComponentDeclarations(lines) {
  const declarations = new Map();
  lines.forEach(line => {
    const funcMatch = line.match(functionComponentRegex);
    if (funcMatch) { declarations.set(funcMatch[1], { type: 'function', role: classifyReactComponent(funcMatch[1]) }); return; }
    const arrowMatch = line.match(arrowComponentRegex);
    if (arrowMatch) { declarations.set(arrowMatch[1], { type: 'arrow', role: classifyReactComponent(arrowMatch[1]) }); return; }
    const classMatch = line.match(classComponentRegex);
    if (classMatch) declarations.set(classMatch[1], { type: 'class', role: classifyReactComponent(classMatch[1]) });
  });
  return declarations;
}

function extractAcceptedProps(lines, componentName) {
  for (const line of lines) {
    const isThisComponent = (line.includes(`function ${componentName}`) || line.includes(`const ${componentName}`));
    if (!isThisComponent) continue;
    const match = line.match(destructuredPropsRegex);
    if (!match) return { props: null, hasSignature: false };
    const propNames = match[1].split(',').map(p => p.trim()).map(p => p.split('=')[0].trim()).map(p => p.split(':')[0].trim()).filter(Boolean);
    return { props: propNames, hasSignature: true };
  }
  return { props: null, hasSignature: false };
}

// ── Fix 4: Extract each prop's declared TypeScript type ───────────────────
// Deliberately LITERAL-ONLY scope (see design decision): we only compare
// primitive types (string/number/boolean/array) against LITERAL values
// passed in JSX — never inferring types of variables or expressions. This
// keeps every flagged mismatch 100% certain, no guessing, matching the
// same accuracy bar as spread-resolution and missing-deps.
const PRIMITIVE_TYPES = new Set(['string', 'number', 'boolean']);

// Named interface/type: interface SidebarProps { prUrl: string; count: number }
function extractNamedTypeDeclaration(lines, typeName) {
  const startIdx = lines.findIndex(l =>
    new RegExp(`(?:interface|type)\\s+${typeName}\\b`).test(l)
  );
  if (startIdx === -1) return null;

  // Collect lines until the closing brace — types are usually short enough
  // that a simple brace-count over a handful of lines is reliable.
  let depth = 0;
  let bodyLines = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;
    bodyLines.push(line);
    if (depth <= 0 && i > startIdx) break;
  }

  return parsePropTypeBody(bodyLines.join('\n'));
}

// Parses "prUrl: string; count: number; active?: boolean" style bodies
// into a Map of propName -> declared type string.
function parsePropTypeBody(bodyText) {
  const types = new Map();
  const propTypeRegex = /(\w+)\??\s*:\s*([^;,\n}]+)/g;
  let match;
  while ((match = propTypeRegex.exec(bodyText)) !== null) {
    const [, propName, rawType] = match;
    types.set(propName, rawType.trim());
  }
  return types;
}

// Given a component's lines and its signature line, resolve prop types
// from EITHER an inline type annotation OR a named interface/type.
function extractPropTypes(lines, componentName) {
  for (const line of lines) {
    const isThisComponent = (line.includes(`function ${componentName}`) || line.includes(`const ${componentName}`));
    if (!isThisComponent) continue;

    // Inline object types are written as `}: { prUrl: string; count: number }`.
    // The closing `)` comes after the type object, not before it.
    const inlineMatch = line.match(/\}\s*:\s*\{([^}]+)\}\s*\)/) || line.match(/\)\s*:\s*\{([^}]+)\}/);
    if (inlineMatch) return parsePropTypeBody(inlineMatch[1]);

    // Named types are written as `}: SidebarProps)` rather than `): SidebarProps`.
    // Handle both declaration formats so `interface FooProps` and `type FooProps`
    // aliases are resolved reliably.
    const namedMatch = line.match(/\}\s*:\s*(\w+)\s*\)/) || line.match(/\)\s*:\s*(\w+)\s*(?:\{|=>|$)/);
    if (namedMatch) {
      const resolved = extractNamedTypeDeclaration(lines, namedMatch[1]);
      if (resolved) return resolved;
    }

    return new Map(); // component found, but no resolvable type info
  }
  return new Map();
}

// ── Fix 4: Infer the type of a LITERAL value passed in JSX ────────────────
// Returns null for anything that isn't a clear literal (variables,
// expressions, function calls) — those are deliberately left unverified
// rather than guessed at.
function inferLiteralType(rawValue) {
  const trimmed = rawValue.trim();

  // String literal: "..." or '...' — note this checks the RAW prop value
  // text including quotes, e.g. prUrl="hello" has rawValue = "hello"
  if (/^["'].*["']$/.test(trimmed)) return 'string';

  // Braced literal: {42}, {"hello"}, {true}, {[1,2,3]}
  const bracedMatch = trimmed.match(/^\{\s*(.+?)\s*\}$/);
  if (bracedMatch) {
    const inner = bracedMatch[1];
    if (/^-?\d+(\.\d+)?$/.test(inner)) return 'number';
    if (inner === 'true' || inner === 'false') return 'boolean';
    if (/^["'].*["']$/.test(inner)) return 'string';
    if (/^\[.*\]$/.test(inner)) return 'array';
    return null; // variable, expression, or function call — stay silent
  }

  return null;
}

// Compares an inferred literal type against a declared TypeScript type
// string. Only handles the primitive cases + simple array types — returns
// true if there's a CERTAIN mismatch, false if they match or if the
// declared type isn't one we can confidently compare (union types,
// custom interfaces, generics beyond simple arrays all return false —
// i.e. "not flagged", not "confirmed OK").
function isDefiniteTypeMismatch(declaredType, inferredType) {
  if (!inferredType) return false; // couldn't infer — never flag

  const cleanDeclared = declaredType.replace(/\s/g, '');

  if (PRIMITIVE_TYPES.has(cleanDeclared)) {
    return cleanDeclared !== inferredType;
  }

  if (cleanDeclared.endsWith('[]') && inferredType === 'array') {
    return false; // array-to-array, good enough at this literal-only granularity
  }
  if (cleanDeclared.endsWith('[]') && inferredType !== 'array') {
    return true; // e.g. declared string[] but passed a plain number literal
  }

  return false; // union types, custom types, generics — not confidently comparable
}

// ── Fix 1: Resolve what's inside a spread {...expr} when possible ────────
// Returns { resolved: true, props: string[] } if we could determine the
// actual prop names, or { resolved: false, reason: string } if not —
// callers must report the reason explicitly, never silently give up.
function resolveSpreadExpression(expr, componentLines) {
  const trimmed = expr.trim();

  // Pattern 1: inline object literal — {...{ name, age, onClick }}
  if (trimmed.startsWith('{')) {
    const inner = trimmed.slice(1, -1);
    const names = inner.split(',')
      .map(part => part.trim().split(':')[0].trim()) // handles shorthand + renamed keys
      .filter(Boolean);
    return { resolved: true, props: names, resolutionKind: 'object_literal' };
  }

  // Pattern 3: a bare variable — trace its OWN declaration in this component.
  const varName = trimmed;

  // 3a: it's a plain object literal assigned earlier — const config = { a, b }
  const literalDecl = componentLines.find(l => new RegExp(`const\\s+${varName}\\s*=\\s*\\{`).test(l));
  if (literalDecl) {
    const match = literalDecl.match(objectLiteralAssignRegex);
    if (match && match[1] === varName) {
      const names = match[2].split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean);
      return { resolved: true, props: names, resolutionKind: 'traced_object_literal', tracedFrom: varName };
    }
  }

  // 3b: it's a rest-destructure — const { id, ...rest } = someSource.
  // Deliberately NOT resolved (see design decision) — report a specific,
  // honest reason rather than a generic "can't verify".
  const restDecl = componentLines.find(l => restDestructureRegex.test(l) && new RegExp(`\\.\\.\\.${varName}\\b`).test(l));
  if (restDecl) {
    const restMatch = restDecl.match(restDestructureRegex);
    return {
      resolved: false,
      reason: `"${varName}" is a rest-destructure ({ ...${varName} }) from "${restMatch?.[2] || 'another object'}" — resolving its exact contents would require knowing that object's full shape, which isn't reliably determinable from static analysis.`,
    };
  }

  // Nothing matched — likely a function call result, an imported value,
  // or a variable declared outside this PR's diff entirely.
  return {
    resolved: false,
    reason: `"${varName}" could not be traced to an object literal in this component — it may come from a function call, an import, or a file outside this PR's changes.`,
  };
}

// Fix 4: captures NAME and VALUE together (unlike jsxPropNameRegex which
// only captures the name) — needed to check literal value types against
// declared prop types.
const jsxPropNameValueRegex = /(\w+)=(\{[^}]*\}|"[^"]*"|'[^']*')/g;

function extractPassedPropValues(attrsSource) {
  const values = new Map(); // propName -> raw value text (e.g. '{42}', '"hello"')
  jsxPropNameValueRegex.lastIndex = 0;
  let match;
  while ((match = jsxPropNameValueRegex.exec(attrsSource)) !== null) {
    const [, name, value] = match;
    if (name && !['className', 'key', 'ref'].includes(name)) values.set(name, value);
  }
  return values;
}

function extractPassedProps(line, tagName, componentLines) {
  const tagPattern = new RegExp(`<${tagName}(?:\\.\\w+)?\\s`);
  const tagMatch = line.match(tagPattern);
  if (!tagMatch) return { props: [], hasSpread: false };

  const attrsStart = tagMatch.index + tagMatch[0].length;
  const selfCloseIdx = line.indexOf('/>', attrsStart);
  const closeIdx = line.indexOf('>', attrsStart);
  const attrsEnd = selfCloseIdx !== -1 && (selfCloseIdx < closeIdx || closeIdx === -1) ? selfCloseIdx : closeIdx;
  const attrsSource = attrsEnd > attrsStart ? line.slice(attrsStart, attrsEnd) : '';
  const propValues = extractPassedPropValues(attrsSource); // Fix 4

  const spreadMatch = attrsSource.match(spreadCaptureRegex);
  if (spreadMatch) {
    const resolution = resolveSpreadExpression(spreadMatch[1], componentLines || []);

    // Even when a spread is present, other NON-spread props may also be
    // passed alongside it (e.g. <Child {...config} extra={x} />) — collect
    // those too rather than dropping them.
    const nonSpreadSource = attrsSource.replace(spreadCaptureRegex, '');
    const explicitProps = [];
    jsxPropNameRegex.lastIndex = 0;
    let m;
    while ((m = jsxPropNameRegex.exec(nonSpreadSource)) !== null) {
      const name = m[1];
      if (name && !['className', 'key', 'ref'].includes(name)) explicitProps.push(name);
    }

    if (resolution.resolved) {
      return {
        props: [...resolution.props, ...explicitProps],
        hasSpread: false, // resolved — no longer treated as an unverifiable spread
        spreadResolution: resolution,
        propValues, // Fix 4 — only meaningful for the explicit (non-spread) props
      };
    }
    return {
      props: null,
      hasSpread: true,
      spreadResolution: resolution, // carries the SPECIFIC reason, not generic
      propValues,
    };
  }

  const props = [];
  jsxPropNameRegex.lastIndex = 0;
  let match;
  while ((match = jsxPropNameRegex.exec(attrsSource)) !== null) {
    const name = match[1];
    if (name && !['className', 'key', 'ref'].includes(name)) props.push(name);
  }
  return { props, hasSpread: false, propValues };
}

function splitIntoComponentBlocks(lines) {
  const blocks = [];
  let currentBlock = null;
  lines.forEach(line => {
    const funcMatch = line.match(functionComponentRegex);
    const arrowMatch = line.match(arrowComponentRegex);
    const classMatch = line.match(classComponentRegex);
    const newComponentName = funcMatch?.[1] || arrowMatch?.[1] || classMatch?.[1];
    if (newComponentName) { currentBlock = { componentName: newComponentName, lines: [] }; blocks.push(currentBlock); return; }
    if (currentBlock) currentBlock.lines.push(line);
  });
  return blocks;
}

function buildComponentScope(block, acceptedPropsForComponent) {
  const scope = new Set();
  if (acceptedPropsForComponent?.props) acceptedPropsForComponent.props.forEach(p => scope.add(p));
  block.lines.forEach(l => {
    const binding = extractOutputBinding(l);
    binding.names.forEach(n => scope.add(n));
  });
  return scope;
}

function extractHookUsages(lines, zustandStoreNames, scopeByComponent) {
  const hooksByComponent = new Map();
  const blocks = splitIntoComponentBlocks(lines);

  blocks.forEach(block => {
    const hookList = [];
    const blockText = block.lines.join('\n');
    const componentScope = scopeByComponent.get(block.componentName) || new Set();
    const handledHookLines = new Set();

    const fullDepsMatches = blockText.matchAll(new RegExp(hookWithDepsFullRegex.source, 'g'));
    for (const fullMatch of fullDepsMatches) {
      const [, hookName, bodyText, depsRaw] = fullMatch;
      const deps = depsRaw.trim().length > 0 ? depsRaw.split(',').map(d => d.trim()).filter(Boolean) : [];
      const sourceLine = block.lines.find(l => l.includes(hookName + '('));
      const binding = sourceLine ? extractOutputBinding(sourceLine) : { pattern: 'none', names: [] };
      const usagesByVar = {};
      binding.names.forEach(name => { usagesByVar[name] = traceVariableUsages(block.lines, name, sourceLine); });

      const missingDeps = findMissingDependencies(bodyText, deps, componentScope);

      hookList.push({ hookName, isBuiltIn: true, deps, hasDepsArray: true, binding, usagesByVar, missingDeps });
      if (sourceLine) handledHookLines.add(sourceLine);
    }

    const simpleDepsMatches = blockText.matchAll(new RegExp(hookWithDepsRegex.source, 'g'));
    for (const depsMatch of simpleDepsMatches) {
      const [, hookName, depsRaw] = depsMatch;
      const sourceLine = block.lines.find(l => l.includes(hookName + '('));
      if (sourceLine && handledHookLines.has(sourceLine)) continue;

      const deps = depsRaw.trim().length > 0 ? depsRaw.split(',').map(d => d.trim()).filter(Boolean) : [];
      const binding = sourceLine ? extractOutputBinding(sourceLine) : { pattern: 'none', names: [] };
      const usagesByVar = {};
      binding.names.forEach(name => { usagesByVar[name] = traceVariableUsages(block.lines, name, sourceLine); });
      hookList.push({ hookName, isBuiltIn: true, deps, hasDepsArray: true, binding, usagesByVar, missingDeps: [] });
    }

    block.lines.forEach(line => {
      hookCallRegex.lastIndex = 0;
      let match;
      while ((match = hookCallRegex.exec(line)) !== null) {
        const [, hookName] = match;
        if (hookName === 'useEffect' || hookName === 'useCallback' || hookName === 'useMemo') continue;
        if (hookName === 'useContext' || hookName === 'useSelector' || hookName === 'useDispatch') continue;
        if (zustandStoreNames.has(hookName)) continue;

        const binding = extractOutputBinding(line);
        const usagesByVar = {};
        binding.names.forEach(name => { usagesByVar[name] = traceVariableUsages(block.lines, name, line); });
        hookList.push({ hookName, isBuiltIn: BUILT_IN_HOOKS.has(hookName), deps: null, hasDepsArray: false, binding, usagesByVar, missingDeps: [] });
      }
    });

    hooksByComponent.set(block.componentName, hookList);
  });

  return hooksByComponent;
}

function extractApiCalls(lines) {
  const callsByComponent = new Map();
  const blocks = splitIntoComponentBlocks(lines);
  blocks.forEach(block => {
    const calls = [];
    block.lines.forEach(line => {
      const axiosMatch = line.match(axiosCallRegex);
      if (axiosMatch) {
        const [, method, rawUrl] = axiosMatch;
        const binding = extractOutputBinding(line);
        const usagesByVar = {};
        binding.names.forEach(name => { usagesByVar[name] = traceVariableUsages(block.lines, name, line); });
        calls.push({ library: 'axios', method: method.toUpperCase(), endpoint: extractEndpointPath(rawUrl), binding, usagesByVar });
        return;
      }
      const fetchMatch = line.match(fetchCallRegex);
      if (fetchMatch) {
        const [, rawUrl] = fetchMatch;
        const binding = extractOutputBinding(line);
        const usagesByVar = {};
        binding.names.forEach(name => { usagesByVar[name] = traceVariableUsages(block.lines, name, line); });
        calls.push({ library: 'fetch', method: 'GET', endpoint: extractEndpointPath(rawUrl), binding, usagesByVar });
      }
    });
    callsByComponent.set(block.componentName, calls);
  });
  return callsByComponent;
}

function detectZustandStoreNames(files) {
  const storeNames = new Set();
  files.forEach(file => {
    const isJsLike = file.filename.endsWith('.ts') || file.filename.endsWith('.js') || file.filename.endsWith('.tsx') || file.filename.endsWith('.jsx');
    if (!isJsLike) return;
    const lines = extractAddedLines(file.patch);
    lines.forEach(line => { const match = line.match(zustandCreateRegex); if (match) storeNames.add(match[1]); });
  });
  return storeNames;
}

function extractGlobalStateUsages(lines, zustandStoreNames) {
  const usagesByComponent = new Map();
  const blocks = splitIntoComponentBlocks(lines);
  blocks.forEach(block => {
    const usages = [];
    block.lines.forEach(line => {
      const createCtxMatch = line.match(createContextRegex);
      if (createCtxMatch) usages.push({ kind: 'context_create', label: `createContext() → ${createCtxMatch[1]}`, binding: { pattern: 'none', names: [] }, usagesByVar: {} });
      const providerMatch = line.match(contextProviderRegex);
      if (providerMatch) usages.push({ kind: 'context_provider', label: `${providerMatch[1]}.Provider`, binding: { pattern: 'none', names: [] }, usagesByVar: {} });
      const useCtxMatch = line.match(useContextRegex);
      if (useCtxMatch) {
        const binding = extractOutputBinding(line);
        const usagesByVar = {};
        binding.names.forEach(name => { usagesByVar[name] = traceVariableUsages(block.lines, name, line); });
        usages.push({ kind: 'context_consume', label: `useContext(${useCtxMatch[1]})`, binding, usagesByVar });
      }
      if (useSelectorRegex.test(line)) {
        const binding = extractOutputBinding(line);
        const usagesByVar = {};
        binding.names.forEach(name => { usagesByVar[name] = traceVariableUsages(block.lines, name, line); });
        usages.push({ kind: 'redux_selector', label: 'useSelector()', binding, usagesByVar });
      }
      if (useDispatchRegex.test(line)) {
        const binding = extractOutputBinding(line);
        const usagesByVar = {};
        binding.names.forEach(name => { usagesByVar[name] = traceVariableUsages(block.lines, name, line); });
        usages.push({ kind: 'redux_dispatch', label: 'useDispatch()', binding, usagesByVar });
      }
      zustandStoreNames.forEach(storeName => {
        const storeUsageRegex = new RegExp(`\\b${storeName}\\s*\\(`);
        if (storeUsageRegex.test(line)) {
          const binding = extractOutputBinding(line);
          const usagesByVar = {};
          binding.names.forEach(name => { usagesByVar[name] = traceVariableUsages(block.lines, name, line); });
          usages.push({ kind: 'zustand_store', label: `${storeName}()`, binding, usagesByVar });
        }
      });
    });
    usagesByComponent.set(block.componentName, usages);
  });
  return usagesByComponent;
}

function extractComponentTree(lines) {
  const edges = [];
  let currentComponent = null;
  lines.forEach(line => {
    const funcMatch = line.match(functionComponentRegex);
    const arrowMatch = line.match(arrowComponentRegex);
    const classMatch = line.match(classComponentRegex);
    if (funcMatch) { currentComponent = funcMatch[1]; return; }
    if (arrowMatch) { currentComponent = arrowMatch[1]; return; }
    if (classMatch) { currentComponent = classMatch[1]; return; }
    if (!currentComponent) return;
    jsxUsageRegex.lastIndex = 0;
    let match;
    while ((match = jsxUsageRegex.exec(line)) !== null) {
      const [, tagName, namespaceMethod] = match;
      const childName = namespaceMethod ? `${tagName}.${namespaceMethod}` : tagName;
      const passed = extractPassedProps(line, tagName, lines);
      edges.push({ from: currentComponent, to: childName, type: 'renders', passedProps: passed.props, hasSpread: passed.hasSpread, spreadResolution: passed.spreadResolution, propValues: passed.propValues });
    }
  });
  return edges;
}

function parseDeletedReactComponents(files) {
  const deletedComponents = new Set();
  files.forEach(file => {
    if (!isReactFile(file.filename)) return;
    const lines = extractDeletedLines(file.patch);
    const declarations = extractComponentDeclarations(lines);
    declarations.forEach((_, name) => deletedComponents.add(name));
  });
  return deletedComponents;
}

function parseReactFlow(files) {
  const flows = [];
  const allDeclarations = new Map();
  const allAcceptedProps = new Map();
  const allPropTypes = new Map(); // Fix 4 — componentName -> Map(propName -> declaredType)
  const declaredInThisPR = new Set();
  const allComponentLines = new Map();

  files.forEach(file => {
    if (!isReactFile(file.filename)) return;
    const lines = extractAddedLines(file.patch);
    const declarations = extractComponentDeclarations(lines);
    declarations.forEach((info, name) => {
      allDeclarations.set(name, { ...info, file: file.filename });
      allAcceptedProps.set(name, extractAcceptedProps(lines, name));
      allPropTypes.set(name, extractPropTypes(lines, name)); // Fix 4
      declaredInThisPR.add(name);
      allComponentLines.set(name, lines);
    });
  });

  const allComponentData = new Map();
  declaredInThisPR.forEach(name => {
    allComponentData.set(name, { lines: allComponentLines.get(name), acceptedProps: allAcceptedProps.get(name) });
  });

  const zustandStoreNames = detectZustandStoreNames(files);

  files.forEach(file => {
    if (!isReactFile(file.filename)) return;
    const lines = extractAddedLines(file.patch);

    const treeEdges = extractComponentTree(lines);
    treeEdges.forEach(edge => {
      const flow = {
        from: edge.from, to: edge.to, type: edge.type, file: file.filename,
        // The props the parent passes, carried through so the detail panel can
        // list them. Previously this stayed on the parser's internal edge and
        // never reached the visualizer, so the panel could report prop
        // PROBLEMS but never the ordinary prop list.
        passedProps: edge.passedProps || [],
      };
      if (edge.hasSpread) {
        flow.propCheckStatus = PROP_CHECK.SKIPPED_SPREAD;
        // Use the SPECIFIC reason from resolveSpreadExpression when available
        // (e.g. "res is a rest-destructure..." or "config could not be
        // traced...") rather than the old one-size-fits-all message —
        // this tells the reviewer WHY it couldn't be verified, not just that
        // it couldn't.
        flow.message = edge.spreadResolution?.reason
          ? `Prop check skipped: ${edge.spreadResolution.reason}`
          : `Prop check skipped: ${edge.from} passes props via spread syntax ({...props}) — cannot verify individual prop names from static analysis.`;
      } else if (!declaredInThisPR.has(edge.to)) {
        flow.propCheckStatus = PROP_CHECK.SKIPPED_UNKNOWN_CHILD;
        flow.message = `Prop check skipped: ${edge.to} is not declared in this PR's changed files — its accepted props are unknown.`;
      } else {
        const accepted = allAcceptedProps.get(edge.to);
        if (!accepted || !accepted.hasSignature) {
          flow.propCheckStatus = PROP_CHECK.SKIPPED_NO_SIGNATURE;
          flow.message = `Prop check skipped: ${edge.to} does not destructure props in its function signature — individual prop usage can't be verified.`;
        } else {
          const unknownProps = (edge.passedProps || []).filter(p => !accepted.props.includes(p));
          const wasResolvedFromSpread = !!edge.spreadResolution?.resolved;
          if (unknownProps.length > 0) {
            flow.propCheckStatus = PROP_CHECK.CHECKED_BROKEN;
            flow.brokenProps = unknownProps;
            flow.message = wasResolvedFromSpread
              ? `Prop(s) resolved from spread but not accepted by ${edge.to}: ${unknownProps.join(', ')} (resolved via ${edge.spreadResolution.resolutionKind})`
              : `Prop(s) passed but not accepted by ${edge.to}: ${unknownProps.join(', ')}`;
          } else {
            // Fix 4: names all matched — now check LITERAL value types
            // against the child's declared types. Only ever flags a
            // CERTAIN mismatch (see isDefiniteTypeMismatch) — variables
            // and expressions are silently skipped, never guessed at.
            const childTypes = allPropTypes.get(edge.to);
            const typeMismatches = [];
            if (childTypes && childTypes.size > 0 && edge.propValues) {
              edge.propValues.forEach((rawValue, propName) => {
                const declaredType = childTypes.get(propName);
                if (!declaredType) return; // no type info for this prop — skip
                const inferredType = inferLiteralType(rawValue);
                if (isDefiniteTypeMismatch(declaredType, inferredType)) {
                  typeMismatches.push({ propName, declaredType, inferredType, rawValue });
                }
              });
            }

            if (typeMismatches.length > 0) {
              flow.propCheckStatus = PROP_CHECK.CHECKED_BROKEN;
              flow.typeMismatches = typeMismatches;
              flow.message = `Type mismatch — ${edge.to} expects ${typeMismatches.map(t => `${t.propName}: ${t.declaredType}`).join(', ')} but received ${typeMismatches.map(t => `${t.propName}=${t.rawValue} (${t.inferredType})`).join(', ')}`;
            } else {
              flow.propCheckStatus = PROP_CHECK.CHECKED_OK;
              flow.message = wasResolvedFromSpread
                ? `All props verified — ${edge.to} accepts everything resolved from ${edge.from}'s spread (via ${edge.spreadResolution.resolutionKind}).`
                : `All props verified — ${edge.to} accepts everything ${edge.from} passes.`;
            }
          }
        }
      }
      flows.push(flow);
    });

    const blocks = splitIntoComponentBlocks(lines);
    const scopeByComponent = new Map();
    blocks.forEach(block => {
      scopeByComponent.set(block.componentName, buildComponentScope(block, allAcceptedProps.get(block.componentName)));
    });

    const hooksByComponent = extractHookUsages(lines, zustandStoreNames, scopeByComponent);
    hooksByComponent.forEach((hooks, componentName) => {
      hooks.forEach(hook => {
        const bindingLabel = formatBindingLabel(hook.binding);
        const hookLabel = hook.hasDepsArray ? `${hook.hookName}(deps: [${hook.deps.join(', ')}])` : `${hook.hookName}()`;

        const crossComponentTrace = {};
        hook.binding.names.forEach(varName => {
          crossComponentTrace[varName] = traceAcrossComponents(componentName, varName, allComponentData);
        });

        flows.push({
          from: componentName,
          to: bindingLabel ? `${hookLabel} ${bindingLabel}` : hookLabel,
          type: 'hook', file: file.filename,
          hookName: hook.hookName, isBuiltInHook: hook.isBuiltIn, hookDeps: hook.deps,
          outputBinding: hook.binding, usagesByVar: hook.usagesByVar,
          crossComponentTrace,
          missingDeps: hook.missingDeps || [],
        });
      });
    });

    const callsByComponent = extractApiCalls(lines);
    callsByComponent.forEach((calls, componentName) => {
      calls.forEach(call => {
        const endpointLabel = call.endpoint ?? '(endpoint unknown — dynamic URL)';
        const bindingLabel = formatBindingLabel(call.binding);
        const baseLabel = `${call.method} ${endpointLabel}`;
        const crossComponentTrace = {};
        call.binding.names.forEach(varName => {
          crossComponentTrace[varName] = traceAcrossComponents(componentName, varName, allComponentData);
        });
        flows.push({
          from: componentName,
          to: bindingLabel ? `${baseLabel} ${bindingLabel}` : baseLabel,
          type: 'api_call', file: file.filename,
          apiLibrary: call.library, apiMethod: call.method, apiEndpoint: call.endpoint,
          outputBinding: call.binding, usagesByVar: call.usagesByVar,
          crossComponentTrace,
        });
      });
    });

    const globalStateByComponent = extractGlobalStateUsages(lines, zustandStoreNames);
    globalStateByComponent.forEach((usages, componentName) => {
      usages.forEach(usage => {
        const bindingLabel = formatBindingLabel(usage.binding);
        const crossComponentTrace = {};
        usage.binding.names.forEach(varName => {
          crossComponentTrace[varName] = traceAcrossComponents(componentName, varName, allComponentData);
        });
        flows.push({
          from: componentName,
          to: bindingLabel ? `${usage.label} ${bindingLabel}` : usage.label,
          type: 'global_state', file: file.filename,
          globalStateKind: usage.kind, outputBinding: usage.binding, usagesByVar: usage.usagesByVar,
          crossComponentTrace,
        });
      });
    });
  });

  const deletedComponents = parseDeletedReactComponents(files);

  return {
    flows,
    componentDeclarations: Object.fromEntries(allDeclarations.entries()),
    deletedComponents: Array.from(deletedComponents),
    zustandStoresDetected: Array.from(zustandStoreNames),
  };
}

module.exports = {
  parseReactFlow, isReactFile, extractAddedLines, extractDeletedLines,
  extractComponentDeclarations, extractAcceptedProps, extractHookUsages,
  extractApiCalls, extractEndpointPath, extractOutputBinding, formatBindingLabel,
  traceVariableUsages, classifyUsage, extractAccessedProperty,
  extractJsxPropTarget, traceAcrossComponents, findMissingDependencies,
  buildComponentScope,
  detectZustandStoreNames, extractGlobalStateUsages, classifyReactComponent,
  extractPropTypes, inferLiteralType, isDefiniteTypeMismatch, // Fix 4
  PROP_CHECK, USAGE_KIND, BUILT_IN_HOOKS, GLOBAL_IDENTIFIERS,
};