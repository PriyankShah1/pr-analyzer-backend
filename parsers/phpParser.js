
// parser.js

function extractAddedLines(patch) {
  if (!patch) return [];
  return patch
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1).trim());
}

function extractDeletedLines(patch) {
  if (!patch) return [];
  return patch
    .split('\n')
    .filter(line => line.startsWith('-') && !line.startsWith('---'))
    .map(line => line.slice(1).trim());
}

// ── Regex patterns ─────────────────────────────────────────────────────────
const classRegex       = /class\s+(\w+)/;
const functionRegex    = /public function (\w+)/;
const serviceCallRegex = /\$this->(\w+)->(\w+)\(/;
const routeRegex       = /Route::(get|post|put|patch|delete|any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(?:\[(\w+)::class\s*,\s*['"](\w+)['"]\]|['"](\w+)@(\w+)['"])/;
const middlewareRegex  = /->middleware\(\s*['"\[]([^\)'"]+)['"]/;
const modelStaticRegex = /\b([A-Z]\w+)::(find|where|create|update|delete|first|all|findOrFail|firstOrCreate|updateOrCreate|with|select|orderBy|paginate)\s*\(/;
const facadeRegex      = /\b(Cache|DB|Mail|Log|Event|Queue|Storage|Redis|Http|Bus|Auth|Hash|Session|Config|Artisan)::([\w]+)\s*\(/;
const namespaceRegex   = /^namespace\s+([\w\\]+)/;

const KNOWN_FACADES = new Set([
  'Cache','DB','Mail','Log','Event','Queue','Storage',
  'Redis','Http','Bus','Auth','Hash','Session','Config','Artisan'
]);

// ── Track deleted classes and functions ───────────────────────────────────
function parseDeletedEntities(files) {
  const deletedClasses   = new Set();
  const deletedFunctions = new Map(); // className → Set of function names

  files.forEach(file => {
    if (!file.filename.endsWith('.php')) return;
    const lines = extractDeletedLines(file.patch);
    let currentClass = null;

    lines.forEach(line => {
      const classMatch = line.match(classRegex);
      if (classMatch) {
        currentClass = classMatch[1];
        deletedClasses.add(currentClass);
      }

      const fnMatch = line.match(functionRegex);
      if (fnMatch && currentClass) {
        if (!deletedFunctions.has(currentClass)) {
          deletedFunctions.set(currentClass, new Set());
        }
        deletedFunctions.get(currentClass).add(fnMatch[1]);
      }
    });
  });

  return { deletedClasses, deletedFunctions };
}

// ── Parse added flows ─────────────────────────────────────────────────────
function parseLaravelFlow(files) {
  const flows = [];

  files.forEach(file => {
    if (!file.filename.endsWith('.php')) return;

    const lines = extractAddedLines(file.patch);
    let currentClass    = null;
    let currentFunction = null;
    let currentNS       = null;

    lines.forEach(line => {

      // Namespace
      const nsMatch = line.match(namespaceRegex);
      if (nsMatch) currentNS = nsMatch[1];

      // Class
      const classMatch = line.match(classRegex);
      if (classMatch) {
        currentClass    = classMatch[1];
        currentFunction = null;
      }

      // Function
      const functionMatch = line.match(functionRegex);
      if (functionMatch) currentFunction = functionMatch[1];

      // Route
      const routeMatch = line.match(routeRegex);
      if (routeMatch) {
        const method     = routeMatch[1].toUpperCase();
        const path       = routeMatch[2];
        const controller = routeMatch[3] || routeMatch[5];
        const action     = routeMatch[4] || routeMatch[6];
        if (controller && action) {
          flows.push({ from: `Route:${method} ${path}`, to: `${controller}@${action}`, type: 'route', returnType: 'request' });
        }
      }

      if (!currentClass || !currentFunction) return;
      const fromLabel = `${currentClass}@${currentFunction}`;

      // Middleware
      const mwMatch = line.match(middlewareRegex);
      if (mwMatch) {
        mwMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '')).forEach(mw => {
          flows.push({ from: `Middleware:${mw}`, to: fromLabel, type: 'middleware', returnType: 'request' });
        });
      }

      // Service call
      const serviceMatch = line.match(serviceCallRegex);
      if (serviceMatch) {
        const [, dep, method] = serviceMatch;
        flows.push({ from: fromLabel, to: `${dep}@${method}`, type: 'call', file: file.filename });
      }

      // Model static call
      const modelMatch = line.match(modelStaticRegex);
      if (modelMatch) {
        const [, model, method] = modelMatch;
        if (!KNOWN_FACADES.has(model)) {
          flows.push({ from: fromLabel, to: `${model}::${method}`, type: 'model_call', returnType: 'object', file: file.filename });
        }
      }

      // Facade
      const facadeMatch = line.match(facadeRegex);
      if (facadeMatch) {
        const [, facade, method] = facadeMatch;
        flows.push({ from: fromLabel, to: `${facade}::${method}`, type: 'static_call', returnType: 'unknown', file: file.filename });
      }
    });
  });

  // Parse deleted entities separately
  const { deletedClasses, deletedFunctions } = parseDeletedEntities(files);

  return {
    flows,
    deletedClasses:   Array.from(deletedClasses),
    deletedFunctions: Object.fromEntries(
      Array.from(deletedFunctions.entries()).map(([k, v]) => [k, Array.from(v)])
    ),
  };
}

module.exports = { parseLaravelFlow, extractAddedLines, extractDeletedLines };