// parsers/jsParser.js
// Parses JS/TS files (Express.js + NestJS) to detect code flow
// Handles: .js, .ts, .jsx, .tsx files
// Detects: Express routes, NestJS decorators, class services, TypeScript types,
//          Prisma + Mongoose + TypeORM ORM calls, middleware chains,
//          functional controllers (no class), router.route() chained style

// ── Supported file extensions ─────────────────────────────────────────────
const JS_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx'];

function isJsFile(filename) {
  return JS_EXTENSIONS.some(ext => filename.endsWith(ext));
}

// ── Words to skip for funcServiceCallRegex ────────────────────────────────
const SKIP_AWAIT_WORDS = new Set([
  'res', 'next', 'req', 'Promise', 'setTimeout', 'setInterval',
  'fs', 'path', 'console', 'JSON', 'Math', 'Object', 'Array',
  'Buffer', 'process', 'stream', 'pipe', 'done', 'cb', 'callback',
]);

// ── Line extractors ───────────────────────────────────────────────────────
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

// ── Regex patterns ────────────────────────────────────────────────────────

// Class detection
const classRegex = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;

// ── NestJS: @Controller('path') ────────────────────────────────────────────
const nestControllerRegex = /@Controller\s*\(\s*['"`]?([^'")\s]*)['"`]?\s*\)?/;

// ── NestJS: @Get()/@Post()/@Put()/@Patch()/@Delete() on a method ───────────
const nestRouteDecoratorRegex = /@(Get|Post|Put|Patch|Delete|All)\s*\(\s*['"`]?([^'")\s]*)['"`]?\s*\)?/;

// ── NestJS: @Injectable() ───────────────────────────────────────────────────
const nestInjectableRegex = /@Injectable\s*\(\s*\)?/;

// ── NestJS: @UseGuards(AuthGuard) / @UseInterceptors(...) ──────────────────
const nestGuardRegex = /@Use(?:Guards|Interceptors|Pipes)\s*\(\s*([^)]+)\)/;

// ── NestJS: method name following a route decorator ────────────────────────
const nestMethodNameRegex = /(?:async\s+)?(\w+)\s*\(/;

// router.route() chained style
const routerRouteRegex = /(?:router|app)\.route\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\.(get|post|put|patch|delete)/;

// Functional controller — const/arrow function
const funcControllerRegex = /(?:const|let)\s+(\w+)\s*=\s*(?:catchAsync\s*\()?\s*async\s*\(/;

// TypeScript method with return type
const tsMethodRegex = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*:\s*(Promise<[^>]+>|[\w<>[\]|]+)/;

// this.service.method() calls (class style)
const serviceCallRegex = /this\.(\w+)\.(\w+)\s*\(/;

// Express route with method + path + handlers
const expressRouteFullRegex = /(?:router|app|this\.router|Router\(\))\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(.+)/;

// router.use() middleware
const routerUseRegex = /(?:router|app)\.use\s*\(\s*(?:['"`][^'"`]+['"`]\s*,\s*)?(\w+)/;

// Constructor DI injection (TypeScript)
const constructorParamRegex = /(?:private|protected|public|readonly)\s+(\w+)\s*:\s*(\w+)/g;

// Functional service call (no "this.")
const funcServiceCallRegex = /\bawait\s+(\w+Service|\w+Repository|\w+Repo|\w+Manager|\w+Client|\w+Provider)\.(\w+)\s*\(/;

// ── ORM: Prisma ───────────────────────────────────────────────────────────
const prismaRegex = /prisma\.(\w+)\.(create|findUnique|findFirst|findMany|update|updateMany|upsert|delete|deleteMany|count|aggregate)\s*\(/;

// ── ORM: Mongoose ─────────────────────────────────────────────────────────
const mongooseStaticRegex = /\b([A-Z]\w+)\.(findById|findOne|find|create|updateOne|updateMany|deleteOne|deleteMany|findByIdAndUpdate|findByIdAndDelete|countDocuments|aggregate)\s*\(/;

// ── ORM: TypeORM ──────────────────────────────────────────────────────────
const typeormRegex = /(?:this\.)?(\w*[Rr]epository|\w*[Rr]epo)\.(?:save|find|findOne|findOneBy|findBy|update|delete|remove|insert|count|exists|createQueryBuilder)\s*\(/;

// Import tracking
const importRegex = /import\s+(?:type\s+)?(?:\{[^}]+\}|\w+)\s+from\s+['"`]([^'"`]+)['"`]/;
const requireRegex = /(?:const|let|var)\s+(?:\{[^}]+\}|\w+)\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/;

// ── Extract middleware from Express route handler string ──────────────────
function extractMiddlewareFromRoute(handlerStr) {
  const middlewares = [];

  const arrayMatch = handlerStr.match(/\[([^\]]+)\]/);
  if (arrayMatch) {
    arrayMatch[1].split(',').forEach(m => {
      const name = m.trim().replace(/\(.*\)/, '').trim();
      if (name && !name.includes('.')) middlewares.push(name);
    });
  }

  const args = handlerStr.split(',').map(s => s.trim());
  if (args.length > 1) {
    args.slice(0, -1).forEach(arg => {
      const name = arg.replace(/^\[|\]$/g, '').trim();
      if (name && /^\w+$/.test(name)) middlewares.push(name);
    });
  }

  return [...new Set(middlewares)];
}

// ── Build a clean NestJS path: combine controller base + method path ──────
function buildNestPath(basePath, methodPath) {
  const base   = (basePath || '').replace(/^\/|\/$/g, '');
  const method = (methodPath || '').replace(/^\/|\/$/g, '');
  const full   = [base, method].filter(Boolean).join('/');
  return '/' + full;
}

// ── Track deleted JS/TS entities ──────────────────────────────────────────
function parseDeletedJsEntities(files) {
  const deletedClasses   = new Set();
  const deletedFunctions = new Map();

  files.forEach(file => {
    if (!isJsFile(file.filename)) return;
    const lines = extractDeletedLines(file.patch);
    let currentClass = null;

    lines.forEach(line => {
      const classMatch = line.match(classRegex);
      if (classMatch) {
        currentClass = classMatch[1];
        deletedClasses.add(currentClass);
      }
      const methodMatch = line.match(tsMethodRegex);
      if (methodMatch && currentClass) {
        if (!deletedFunctions.has(currentClass)) deletedFunctions.set(currentClass, new Set());
        deletedFunctions.get(currentClass).add(methodMatch[1]);
      }
    });
  });

  return { deletedClasses, deletedFunctions };
}

// ── Main parser ───────────────────────────────────────────────────────────
function parseJsFlow(files) {
  const flows = [];

  files.forEach(file => {
    if (!isJsFile(file.filename)) return;

    const lines             = extractAddedLines(file.patch);
    let currentClass        = null;
    let currentMethod       = null;
    let currentReturnType   = null;
    let nestControllerBase  = null;
    let pendingNestMethod   = null;
    const imports           = new Map();

    lines.forEach(line => {

      // ── Import tracking ────────────────────────────────────────────────
      const importMatch = line.match(importRegex);
      if (importMatch) {
        const namedMatch = line.match(/import\s+\{([^}]+)\}/);
        if (namedMatch) {
          namedMatch[1].split(',').forEach(name => {
            imports.set(name.trim(), importMatch[1]);
          });
        }
        const defaultMatch = line.match(/import\s+(\w+)\s+from/);
        if (defaultMatch) imports.set(defaultMatch[1], importMatch[1]);
      }

      const requireMatch = line.match(requireRegex);
      if (requireMatch) {
        const nameMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=/);
        if (nameMatch) imports.set(nameMatch[1], requireMatch[1]);
      }

      // ── NestJS: @Controller('path') — appears before class line ────────
      const nestControllerMatch = line.match(nestControllerRegex);
      if (nestControllerMatch) {
        nestControllerBase = nestControllerMatch[1] || '';
        return;
      }

      // ── NestJS: @Injectable() — no-op marker, class style already covers it
      if (nestInjectableRegex.test(line)) {
        return;
      }

      // ── NestJS: @UseGuards(AuthGuard) / @UseInterceptors(...) ──────────
      const nestGuardMatch = line.match(nestGuardRegex);
      if (nestGuardMatch) {
        const guardNames = nestGuardMatch[1].split(',').map(g => g.trim().replace(/\(.*\)/, ''));
        guardNames.forEach(guard => {
          if (guard) {
            flows.push({
              from: `Middleware:${guard}`,
              to:   currentClass ? `${currentClass}@guard` : `Guard:${guard}`,
              type: 'middleware',
              returnType: 'request',
              file: file.filename,
            });
          }
        });
        return;
      }

      // ── NestJS: @Get()/@Post()/etc. — remember until method name appears ─
      const nestRouteMatch = line.match(nestRouteDecoratorRegex);
      if (nestRouteMatch) {
        pendingNestMethod = {
          httpMethod: nestRouteMatch[1].toUpperCase(),
          path:       nestRouteMatch[2] || '',
        };
        return;
      }

      // ── Class detection ────────────────────────────────────────────────
      const classMatch = line.match(classRegex);
      if (classMatch) {
        currentClass      = classMatch[1];
        currentMethod     = null;
        currentReturnType = null;
        return;
      }

      // ── Constructor DI injection ───────────────────────────────────────
      if (line.includes('constructor(') && currentClass) {
        constructorParamRegex.lastIndex = 0;
        let match;
        while ((match = constructorParamRegex.exec(line)) !== null) {
          imports.set(match[1], match[2]);
        }
      }

      // ── Resolve pending NestJS route decorator to a method name ────────
      if (pendingNestMethod && currentClass) {
        const methodNameMatch = line.match(nestMethodNameRegex);
        if (methodNameMatch && !['constructor', 'if', 'for', 'while'].includes(methodNameMatch[1])) {
          const fullPath = buildNestPath(nestControllerBase, pendingNestMethod.path);
          flows.push({
            from: `Route:${pendingNestMethod.httpMethod} ${fullPath}`,
            to:   `${currentClass}@${methodNameMatch[1]}`,
            type: 'route',
            returnType: 'request',
            file: file.filename,
          });
          currentMethod     = methodNameMatch[1];
          currentReturnType = null;
          pendingNestMethod = null;
        }
      }

      // ── router.route() chained style (Express) ──────────────────────────
      const routerRouteMatch = line.match(routerRouteRegex);
      if (routerRouteMatch) {
        const path   = routerRouteMatch[1];
        const method = routerRouteMatch[2].toUpperCase();
        const controllerMatches = [...line.matchAll(/(\w+)\.(\w+)\s*[,)]/g)];
        const lastHandler = controllerMatches.length > 0
          ? controllerMatches[controllerMatches.length - 1]
          : null;
        const toNode = lastHandler
          ? `${lastHandler[1]}@${lastHandler[2]}`
          : `handler@${method.toLowerCase()}`;

        flows.push({
          from: `Route:${method} ${path}`,
          to:   toNode,
          type: 'route',
          returnType: 'request',
          file: file.filename,
        });
      }

      // ── Functional controller (Express) ─────────────────────────────────
      const funcMatch = line.match(funcControllerRegex);
      if (funcMatch) {
        currentMethod     = funcMatch[1];
        currentReturnType = null;
      }

      // ── Method detection (class-based, non-Nest) ────────────────────────
      const tsMethodMatch = line.match(tsMethodRegex);
      if (tsMethodMatch && currentClass && !pendingNestMethod) {
        currentMethod     = tsMethodMatch[1];
        currentReturnType = tsMethodMatch[2] || null;
      } else if (currentClass && !pendingNestMethod) {
        const plainMethodMatch = line.match(/(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
        if (
          plainMethodMatch &&
          !['if','for','while','switch','catch','function','constructor'].includes(plainMethodMatch[1])
        ) {
          currentMethod     = plainMethodMatch[1];
          currentReturnType = null;
        }
      }

      // ── Express route detection (router.get/post/etc.) ─────────────────
      const routeFullMatch = line.match(expressRouteFullRegex);
      if (routeFullMatch) {
        const method     = routeFullMatch[1].toUpperCase();
        const path       = routeFullMatch[2];
        const handlerStr = routeFullMatch[3] || '';

        const handlerArgs  = handlerStr.split(',').map(s => s.trim());
        const lastArg       = handlerArgs[handlerArgs.length - 1];
        const handlerMatch  = lastArg.match(/(\w+)\.(\w+)/);

        const toNode = handlerMatch
          ? `${handlerMatch[1]}@${handlerMatch[2]}`
          : currentClass
            ? `${currentClass}@handler`
            : `handler@${method.toLowerCase()}`;

        flows.push({
          from: `Route:${method} ${path}`,
          to:   toNode,
          type: 'route',
          returnType: 'request',
          file: file.filename,
        });

        extractMiddlewareFromRoute(handlerStr).forEach(mw => {
          flows.push({
            from: `Middleware:${mw}`,
            to:   `Route:${method} ${path}`,
            type: 'middleware',
            returnType: 'request',
            file: file.filename,
          });
        });
        return;
      }

      // ── router.use() middleware (Express) ───────────────────────────────
      const routerUseMatch = line.match(routerUseRegex);
      if (routerUseMatch && currentClass) {
        flows.push({
          from: `Middleware:${routerUseMatch[1]}`,
          to:   `${currentClass}@router`,
          type: 'middleware',
          returnType: 'request',
          file: file.filename,
        });
      }

      // ── Skip if no current method context ─────────────────────────────
      if (!currentMethod) return;

      const fromLabel = currentClass
        ? `${currentClass}@${currentMethod}`
        : currentMethod;

      // ── this.service.method() calls ────────────────────────────────────
      const serviceMatch = line.match(serviceCallRegex);
      if (serviceMatch) {
        const [, propName, method] = serviceMatch;
        const resolvedClass = imports.get(propName) || propName;
        flows.push({
          from: fromLabel,
          to:   `${resolvedClass}@${method}`,
          type: 'call',
          returnType: currentReturnType || 'unknown',
          file: file.filename,
        });
      }

      // ── Functional service call (await service.method()) ───────────────
      const funcServiceMatch = line.match(funcServiceCallRegex);
      if (funcServiceMatch) {
        const [, serviceName, method] = funcServiceMatch;
        if (!SKIP_AWAIT_WORDS.has(serviceName)) {
          flows.push({
            from: fromLabel,
            to:   `${serviceName}@${method}`,
            type: 'call',
            returnType: 'unknown',
            file: file.filename,
          });
        }
      }

      // ── Prisma ORM calls ───────────────────────────────────────────────
      const prismaMatch = line.match(prismaRegex);
      if (prismaMatch) {
        const [, model, operation] = prismaMatch;
        flows.push({
          from: fromLabel,
          to:   `prisma.${model}.${operation}`,
          type: 'orm_call',
          returnType: 'object',
          file: file.filename,
        });
      }

      // ── Mongoose ORM calls ─────────────────────────────────────────────
      const mongooseMatch = line.match(mongooseStaticRegex);
      if (mongooseMatch) {
        const [, model, operation] = mongooseMatch;
        if (model[0] === model[0].toUpperCase()) {
          flows.push({
            from: fromLabel,
            to:   `${model}.${operation}`,
            type: 'orm_call',
            returnType: 'object',
            file: file.filename,
          });
        }
      }

      // ── TypeORM repository calls ───────────────────────────────────────
      const typeormMatch = line.match(typeormRegex);
      if (typeormMatch) {
        const [, repoName] = typeormMatch;
        const operation = line.match(
          /\.(save|find|findOne|findOneBy|findBy|update|delete|remove|insert|count)\s*\(/
        )?.[1] || 'query';
        flows.push({
          from: fromLabel,
          to:   `${repoName}.${operation}`,
          type: 'orm_call',
          returnType: 'object',
          file: file.filename,
        });
      }
    });
  });

  const { deletedClasses, deletedFunctions } = parseDeletedJsEntities(files);

  return {
    flows,
    deletedClasses: Array.from(deletedClasses),
    deletedFunctions: Object.fromEntries(
      Array.from(deletedFunctions.entries()).map(([k, v]) => [k, Array.from(v)])
    ),
  };
}

module.exports = { parseJsFlow, extractAddedLines, extractDeletedLines, isJsFile };