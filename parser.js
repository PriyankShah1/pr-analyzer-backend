// parser.js

function extractAddedLines(patch) {
  if (!patch) return [];
  return patch
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1).trim());
}

// ── Regex patterns ─────────────────────────────────────────────────────────
const classRegex         = /class\s+(\w+)/;
const functionRegex      = /public function (\w+)/;
const serviceCallRegex   = /\$this->(\w+)->(\w+)\(/;
const routeRegex         = /Route::(get|post|put|patch|delete|any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(?:\[(\w+)::class\s*,\s*['"](\w+)['"]\]|['"](\w+)@(\w+)['"])/;
const middlewareRegex    = /->middleware\(\s*['"\[]([^\)'"]+)['"]/;
const modelStaticRegex   = /\b([A-Z]\w+)::(find|where|create|update|delete|first|all|findOrFail|firstOrCreate|updateOrCreate|with|select|orderBy|paginate)\s*\(/;
const facadeRegex        = /\b(Cache|DB|Mail|Log|Event|Queue|Storage|Redis|Http|Bus|Auth|Hash|Session|Config|Artisan)::([\w]+)\s*\(/;
const namespaceRegex     = /^namespace\s+([\w\\]+)/;

const KNOWN_FACADES = new Set([
  'Cache','DB','Mail','Log','Event','Queue','Storage',
  'Redis','Http','Bus','Auth','Hash','Session','Config','Artisan'
]);

// ── Classify any PHP class by name + namespace ─────────────────────────────
// Works for app code (App\Http\Controllers) AND framework code (Illuminate\*)
function classifyClass(className, namespace) {
  const ns = namespace || '';

  if (className.endsWith('Controller'))              return 'controller';
  if (className.endsWith('Middleware')
    || ns.includes('Middleware'))                    return 'middleware';
  if (className.endsWith('Repository')
    || className.endsWith('Repo'))                   return 'repository';
  if (className.endsWith('Service'))                 return 'service';
  if (className.endsWith('Job')
    || ns.includes('\\Jobs\\'))                      return 'job';
  if (className.endsWith('Event')
    || ns.includes('\\Events\\'))                    return 'event';
  if (className.endsWith('Listener')
    || ns.includes('\\Listeners\\'))                 return 'listener';
  if (className.endsWith('Policy')
    || ns.includes('\\Policies\\'))                  return 'policy';
  if (className.endsWith('Request')
    || ns.includes('\\Requests\\'))                  return 'request';
  if (className.endsWith('Resource')
    || ns.includes('\\Resources\\'))                 return 'resource';
  if (className.endsWith('Observer')
    || ns.includes('\\Observers\\'))                 return 'observer';
  if (ns.includes('\\Client\\')
    || ns.includes('\\Http\\Client'))                return 'client';
  if (ns.includes('\\Console\\'))                    return 'command';

  // Default: treat as generic service
  return 'service';
}

function parseLaravelFlow(files) {
  const flows = [];

  files.forEach(file => {
    if (!file.filename.endsWith('.php')) return;

    const lines = extractAddedLines(file.patch);
    let currentClass    = null;
    let currentType     = null;   // classified type of current class
    let currentFunction = null;
    let currentNS       = null;

    lines.forEach(line => {

      // ── Namespace detection ──────────────────────────────────────────────
      const nsMatch = line.match(namespaceRegex);
      if (nsMatch) {
        currentNS = nsMatch[1];
      }

      // ── Class detection (any PHP class) ──────────────────────────────────
      const classMatch = line.match(classRegex);
      if (classMatch) {
        currentClass    = classMatch[1];
        currentType     = classifyClass(currentClass, currentNS);
        currentFunction = null;
      }

      // ── Function detection ───────────────────────────────────────────────
      const functionMatch = line.match(functionRegex);
      if (functionMatch) {
        currentFunction = functionMatch[1];
      }

      // ── Route detection ──────────────────────────────────────────────────
      const routeMatch = line.match(routeRegex);
      if (routeMatch) {
        const method     = routeMatch[1].toUpperCase();
        const path       = routeMatch[2];
        const controller = routeMatch[3] || routeMatch[5];
        const action     = routeMatch[4] || routeMatch[6];
        if (controller && action) {
          flows.push({
            from: `Route:${method} ${path}`,
            to:   `${controller}@${action}`,
            type: 'route',
            returnType: 'request',
          });
        }
      }

      // ── Only track flows inside a known class+function context ────────────
      if (!currentClass || !currentFunction) return;

      const fromLabel = `${currentClass}@${currentFunction}`;

      // ── Middleware on route ──────────────────────────────────────────────
      const mwMatch = line.match(middlewareRegex);
      if (mwMatch) {
        const mwNames = mwMatch[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
        mwNames.forEach(mw => {
          flows.push({
            from: `Middleware:${mw}`,
            to:   fromLabel,
            type: 'middleware',
            returnType: 'request',
          });
        });
      }

      // ── Service call ($this->dep->method()) ──────────────────────────────
      const serviceMatch = line.match(serviceCallRegex);
      if (serviceMatch) {
        const [, dep, method] = serviceMatch;
        flows.push({
          from: fromLabel,
          to:   `${dep}@${method}`,
          type: 'call',
          file: file.filename,
        });
      }

      // ── Model static call (User::find, Order::where, etc.) ───────────────
      const modelMatch = line.match(modelStaticRegex);
      if (modelMatch) {
        const [, model, method] = modelMatch;
        if (!KNOWN_FACADES.has(model)) {
          flows.push({
            from: fromLabel,
            to:   `${model}::${method}`,
            type: 'model_call',
            returnType: 'object',
            file: file.filename,
          });
        }
      }

      // ── Facade / static calls ─────────────────────────────────────────────
      const facadeMatch = line.match(facadeRegex);
      if (facadeMatch) {
        const [, facade, method] = facadeMatch;
        flows.push({
          from: fromLabel,
          to:   `${facade}::${method}`,
          type: 'static_call',
          returnType: 'unknown',
          file: file.filename,
        });
      }
    });
  });

  return flows;
}

module.exports = {
  parseLaravelFlow,
  extractAddedLines,
};