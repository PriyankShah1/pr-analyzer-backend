// parsers/jsParser.js
// Parses JS/TS files (Express.js) to detect code flow
// Handles: .js, .ts, .jsx, .tsx files
// Detects: Express routes, class services, TypeScript types,
//          Prisma + Mongoose + TypeORM ORM calls, middleware chains

// ── Supported file extensions ─────────────────────────────────────────────
const JS_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx'];

function isJsFile(filename) {
  return JS_EXTENSIONS.some(ext => filename.endsWith(ext));
}

// ── Line extractors (same pattern as phpParser) ───────────────────────────
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
// Matches: class UserController / class UserService extends BaseService
const classRegex = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;

// Function/method detection
// Matches: async store(req, res) / store = async (req, res) => / store(req, res, next)
const methodRegex = /(?:async\s+)?(\w+)\s*[=:]\s*(?:async\s+)?\(|(?:async\s+)?(\w+)\s*\(/;

// TypeScript method with explicit return type
// Matches: async createUser(dto: CreateUserDto): Promise<UserDto>
const tsMethodRegex = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*:\s*(Promise<[^>]+>|[\w<>[\]|]+)/;

// this.service.method() calls
// Matches: this.userService.createUser(data) / this.service.process()
const serviceCallRegex = /this\.(\w+)\.(\w+)\s*\(/;

// Express route detection
// Matches: router.get('/path', handler) / app.post('/path', [mid], handler)
// Also: Router().get / this.router.post
const expressRouteRegex = /(?:router|app|this\.router|Router\(\))\.(?:get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/;

// Express route with method extraction
const expressRouteFullRegex = /(?:router|app|this\.router|Router\(\))\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(.+)/;

// router.use() middleware
// Matches: router.use(authMiddleware) / router.use('/path', middleware)
const routerUseRegex = /(?:router|app)\.use\s*\(\s*(?:['"`][^'"`]+['"`]\s*,\s*)?(\w+)/;

// TypeScript return type
// Matches: ): Promise<UserDto> / ): UserResponseDto / ): ApiResponse<User>
const tsReturnTypeRegex = /\)\s*:\s*(Promise<([^>]+)>|([\w<>[\]|]+))\s*(?:\{|=>|$)/;

// Constructor injection (TypeScript DI)
// Matches: constructor(private userService: UserService, private mailService: MailService)
const constructorParamRegex = /(?:private|protected|public|readonly)\s+(\w+)\s*:\s*(\w+)/g;

// ── ORM: Prisma ───────────────────────────────────────────────────────────
// Matches: prisma.user.create() / prisma.order.findUnique() / prisma.post.update()
const prismaRegex = /prisma\.(\w+)\.(create|findUnique|findFirst|findMany|update|updateMany|upsert|delete|deleteMany|count|aggregate)\s*\(/;

// ── ORM: Mongoose ─────────────────────────────────────────────────────────
// Matches: User.findById(id) / Order.find({}) / Post.findOne({}) / User.save()
const mongooseStaticRegex = /\b([A-Z]\w+)\.(findById|findOne|find|create|updateOne|updateMany|deleteOne|deleteMany|findByIdAndUpdate|findByIdAndDelete|countDocuments|aggregate)\s*\(/;

// Matches: user.save() / doc.remove() (instance methods)
const mongooseInstanceRegex = /\b(\w+)\.(save|remove|populate|lean)\s*\(/;

// ── ORM: TypeORM ──────────────────────────────────────────────────────────
// Matches: userRepository.save(entity) / this.userRepo.findOne({where})
const typeormRegex = /(?:this\.)?(\w*[Rr]epository|\w*[Rr]epo)\.(?:save|find|findOne|findOneBy|findBy|update|delete|remove|insert|count|exists|createQueryBuilder)\s*\(/;

// Import tracking
// Matches: import { UserService } from './services/UserService'
const importRegex = /import\s+(?:type\s+)?(?:\{[^}]+\}|\w+)\s+from\s+['"`]([^'"`]+)['"`]/;

// require() tracking
// Matches: const userService = require('./services/userService')
const requireRegex = /(?:const|let|var)\s+(?:\{[^}]+\}|\w+)\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/;

// ── Classify JS/TS class by name ──────────────────────────────────────────
function classifyJsClass(className) {
  if (className.endsWith('Controller'))  return 'controller';
  if (className.endsWith('Service'))     return 'service';
  if (className.endsWith('Repository') || className.endsWith('Repo')) return 'repository';
  if (className.endsWith('Middleware'))  return 'middleware';
  if (className.endsWith('Guard'))       return 'middleware';   // NestJS guards
  if (className.endsWith('Resolver'))    return 'controller';   // GraphQL resolvers
  if (className.endsWith('Handler'))     return 'service';
  if (className.endsWith('Model'))       return 'model';
  if (className.endsWith('Schema'))      return 'model';
  return 'service';
}

// ── Extract middleware names from Express route handler list ──────────────
// e.g. "[authMiddleware, validateBody], controller.store"
// → ['authMiddleware', 'validateBody']
function extractMiddlewareFromRoute(handlerStr) {
  const middlewares = [];
  // Array-style: [auth, validate]
  const arrayMatch = handlerStr.match(/\[([^\]]+)\]/);
  if (arrayMatch) {
    arrayMatch[1].split(',').forEach(m => {
      const name = m.trim().replace(/\(.*\)/, '').trim();
      if (name && !name.includes('.')) middlewares.push(name);
    });
  }
  // Individual args before last handler (last is usually the controller method)
  const args = handlerStr.split(',').map(s => s.trim());
  if (args.length > 1) {
    // All but last are potential middleware
    args.slice(0, -1).forEach(arg => {
      const name = arg.replace(/^\[|\]$/g, '').trim();
      if (name && /^\w+$/.test(name)) middlewares.push(name);
    });
  }
  return [...new Set(middlewares)]; // deduplicate
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

  return {
    deletedClasses,
    deletedFunctions,
  };
}

// ── Main parser ───────────────────────────────────────────────────────────
function parseJsFlow(files) {
  const flows = [];

  files.forEach(file => {
    if (!isJsFile(file.filename)) return;

    const lines          = extractAddedLines(file.patch);
    let currentClass     = null;
    let currentMethod    = null;
    let currentReturnType = null;
    const imports        = new Map(); // localName → modulePath

    lines.forEach(line => {

      // ── Import tracking ────────────────────────────────────────────────
      const importMatch = line.match(importRegex);
      if (importMatch) {
        // Extract named imports: import { UserService, MailService } from '...'
        const namedMatch = line.match(/import\s+\{([^}]+)\}/);
        if (namedMatch) {
          namedMatch[1].split(',').forEach(name => {
            imports.set(name.trim(), importMatch[1]);
          });
        }
        // Default import: import UserService from '...'
        const defaultMatch = line.match(/import\s+(\w+)\s+from/);
        if (defaultMatch) imports.set(defaultMatch[1], importMatch[1]);
      }

      const requireMatch = line.match(requireRegex);
      if (requireMatch) {
        const nameMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=/);
        if (nameMatch) imports.set(nameMatch[1], requireMatch[1]);
      }

      // ── Class detection ────────────────────────────────────────────────
      const classMatch = line.match(classRegex);
      if (classMatch) {
        currentClass  = classMatch[1];
        currentMethod = null;
        currentReturnType = null;
        return;
      }

      // ── Constructor injection (TypeScript DI) ──────────────────────────
      if (line.includes('constructor(') && currentClass) {
        let match;
        constructorParamRegex.lastIndex = 0;
        while ((match = constructorParamRegex.exec(line)) !== null) {
          // Record injected dependency: e.g. userService: UserService
          // This helps us understand what this.userService refers to
          imports.set(match[1], match[2]); // localPropName → TypeName
        }
      }

      // ── Method/function detection ──────────────────────────────────────
      const tsMethodMatch = line.match(tsMethodRegex);
      if (tsMethodMatch && currentClass) {
        currentMethod     = tsMethodMatch[1];
        currentReturnType = tsMethodMatch[2] || null;
      } else {
        // Fallback for plain JS methods
        const plainMethodMatch = line.match(/(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
        if (plainMethodMatch && currentClass && !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(plainMethodMatch[1])) {
          currentMethod     = plainMethodMatch[1];
          currentReturnType = null;
        }
      }

      // ── Express route detection ────────────────────────────────────────
      const routeFullMatch = line.match(expressRouteFullRegex);
      if (routeFullMatch) {
        const method      = routeFullMatch[1].toUpperCase();
        const path        = routeFullMatch[2];
        const handlerStr  = routeFullMatch[3] || '';
// Extract the actual handler from the route string
// e.g. "authMiddleware, UserController.store" → "UserController@store"
const handlerArgs = handlerStr.split(',').map(s => s.trim());
const lastArg = handlerArgs[handlerArgs.length - 1];

// Detect "Controller.method" or "controller.method" pattern
const handlerMatch = lastArg.match(/(\w+)\.(\w+)/);
const toNode = handlerMatch
  ? `${handlerMatch[1]}@${handlerMatch[2]}`
  : currentClass
    ? `${currentClass}@handler`
    : `handler@${method.toLowerCase()}`;

flows.push({
  from:       `Route:${method} ${path}`,
  to:         toNode,
  type:       'route',
  returnType: 'request',
  file:       file.filename,
});

        // Extract middleware from route
        const middlewares = extractMiddlewareFromRoute(handlerStr);
        middlewares.forEach(mw => {
          flows.push({
            from:       `Middleware:${mw}`,
            to:         `Route:${method} ${path}`,
            type:       'middleware',
            returnType: 'request',
            file:       file.filename,
          });
        });
        return;
      }

      // ── router.use() middleware ────────────────────────────────────────
      const routerUseMatch = line.match(routerUseRegex);
      if (routerUseMatch && currentClass) {
        flows.push({
          from:       `Middleware:${routerUseMatch[1]}`,
          to:         `${currentClass}@router`,
          type:       'middleware',
          returnType: 'request',
          file:       file.filename,
        });
      }

      // ── Only track calls inside a class method ─────────────────────────
      if (!currentClass || !currentMethod) return;
      const fromLabel = `${currentClass}@${currentMethod}`;

      // ── this.service.method() calls ────────────────────────────────────
      const serviceMatch = line.match(serviceCallRegex);
      if (serviceMatch) {
        const [, propName, method] = serviceMatch;
        // Try to resolve the real class name from constructor injection
        const resolvedClass = imports.get(propName) || propName;
        flows.push({
          from:       fromLabel,
          to:         `${resolvedClass}@${method}`,
          type:       'call',
          returnType: currentReturnType || 'unknown',
          file:       file.filename,
        });
      }

      // ── Prisma ORM calls ───────────────────────────────────────────────
      const prismaMatch = line.match(prismaRegex);
      if (prismaMatch) {
        const [, model, operation] = prismaMatch;
        flows.push({
          from:       fromLabel,
          to:         `prisma.${model}.${operation}`,
          type:       'orm_call',
          returnType: 'object',
          file:       file.filename,
        });
      }

      // ── Mongoose ORM calls ─────────────────────────────────────────────
      const mongooseMatch = line.match(mongooseStaticRegex);
      if (mongooseMatch) {
        const [, model, operation] = mongooseMatch;
        // Skip if it looks like a Prisma model (lowercase first letter)
        if (model[0] === model[0].toUpperCase()) {
          flows.push({
            from:       fromLabel,
            to:         `${model}.${operation}`,
            type:       'orm_call',
            returnType: 'object',
            file:       file.filename,
          });
        }
      }

      // ── TypeORM repository calls ───────────────────────────────────────
      const typeormMatch = line.match(typeormRegex);
      if (typeormMatch) {
        const [, repoName] = typeormMatch;
        const operation    = line.match(/\.(save|find|findOne|findOneBy|findBy|update|delete|remove|insert|count)\s*\(/)?.[1] || 'query';
        flows.push({
          from:       fromLabel,
          to:         `${repoName}.${operation}`,
          type:       'orm_call',
          returnType: 'object',
          file:       file.filename,
        });
      }
    });
  });

  // Also track deleted JS entities
  const { deletedClasses, deletedFunctions } = parseDeletedJsEntities(files);

  return {
    flows,
    deletedClasses:   Array.from(deletedClasses),
    deletedFunctions: Object.fromEntries(
      Array.from(deletedFunctions.entries()).map(([k, v]) => [k, Array.from(v)])
    ),
  };
}

module.exports = { parseJsFlow, extractAddedLines, extractDeletedLines, isJsFile };