// Regression tests for the N+1 detector, written from the three findings the
// real-world sweep produced (B5). Two were false positives; one was real.
// Each case below is the shape of an actual merged PR.
// Run: npm test
const A = require("../parsers/sqlAnalyzer.js");
const NL = String.fromCharCode(10);

let pass = 0, fail = 0;
const check = (n, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (extra ? '  → ' + extra : '')); }
};
const run = (filename, patch) => {
  const f = A.analyzeSqlInFiles([{ filename, patch }]);
  return f.filter(x => x.title === 'Query inside a loop (N+1)');
};
const P = (...lines) => lines.join(NL);

console.log(NL + '1. koel/koel#2633 — loop closes before the query (was a false positive)');
// The foreach ends at the 5th line. The `->get($url)` is in a DIFFERENT
// method 50 lines down. Both the closing braces and the HTTP receiver were
// invisible to the old detector.
const koel = run('app/Services/Image/ImageWriter.php', P(
  '@@ -60,14 +60,20 @@',
  '         foreach (self::FORMATS as $format) {',
  '             if ($imageDriver->supports($format)) {',
  '                 return $format;',
  '             }',
  '         }',
  '     }',
  '+    private static function fetch(string $url): string',
  '+    {',
  '+        return Http::withUserAgent(http_user_agent())',
  '+            ->get($url)',
  '+            ->body();',
  '+    }',
));
check('an HTTP call after the loop closed is not an N+1', koel.length === 0,
  koel.map(f => f.file + ':' + f.line).join(', '));

console.log(NL + '2. documenso/documenso#3301 — .filter(Boolean) is not a loop (was a false positive)');
const doc = run('apps/remix/app/routes/_layout.tsx', P(
  '@@ -40,6 +40,12 @@',
  "     const [resource, mode] = url.pathname.split('/').filter(Boolean).slice(3);",
  '     if (isAuthoringSession) {',
  '+      fireAndForget(async () => {',
  '+        const team = await prisma.team.findFirst({',
  '+          where: { id: result.teamId },',
  '+        });',
  '+      });',
  '     }',
));
check('a chained .filter() on a string opens no loop', doc.length === 0,
  doc.map(f => f.line).join(', '));

console.log(NL + '3. twentyhq/twenty#25468 — a real query in a real loop (must STILL fire)');
const twenty = run('packages/twenty-server/src/database/commands/backfill.command.ts', P(
  '@@ -130,3 +132,7 @@',
  '         const backfills = await resolve();',
  '+        for (const { label, junctionRelationFieldMetadataId } of backfills) {',
  '+          const fieldMetadata = await fieldMetadataRepository.findOne({',
  '+            where: { id: junctionRelationFieldMetadataId },',
  '+          });',
  '+        }',
));
check('await findOne inside for…of is reported', twenty.length === 1,
  'got ' + twenty.length);

console.log(NL + '4. Eloquent in a foreach (must fire — the ambiguous ->first() WITH a builder)');
const eloquent = run('app/Http/Controllers/UserController.php', P(
  '@@ -10,2 +10,5 @@',
  '     public function index() {',
  '+        foreach ($ids as $id) {',
  "+            $user = User::query()->where('id', $id)->first();",
  '+        }',
  '     }',
));
check('->first() after ->where() still counts as a query', eloquent.length === 1,
  'got ' + eloquent.length);

console.log(NL + '5. .map(async …) IS a loop (callback present — must fire)');
const mapped = run('src/sync.ts', P(
  '@@ -5,2 +5,5 @@',
  '   async function sync(items) {',
  '+    await Promise.all(items.map(async (item) => {',
  '+      const row = await prisma.user.findUnique({ where: { id: item.id } });',
  '+      return row;',
  '+    }));',
));
check('.map with an arrow callback opens a loop', mapped.length === 1,
  'got ' + mapped.length);

console.log(NL + '6. Context lines must not be reported on');
const ctxOnly = run('app/Repo.php', P(
  '@@ -1,4 +1,5 @@',
  '     foreach ($ids as $id) {',
  "         $u = DB::table('users')->where('id', $id)->first();",
  '+        $log[] = $u;',
  '     }',
));
check('an unchanged query inside a loop is not a new finding', ctxOnly.length === 0,
  ctxOnly.map(f => f.line).join(', '));

console.log(NL + '7. diffPosition/line bookkeeping unchanged (inline comments depend on it)');
const lines = A.extractAddedLinesWithPositions(P(
  '@@ -1,3 +1,5 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
));
check('two added lines', lines.length === 2, JSON.stringify(lines));
check('new-file line numbers are 2 and 3',
  lines[0].line === 2 && lines[1].line === 3, JSON.stringify(lines.map(l => l.line)));
check('diff positions are 3 and 4',
  lines[0].diffPosition === 3 && lines[1].diffPosition === 4,
  JSON.stringify(lines.map(l => l.diffPosition)));
check('no `added` key leaks to callers', !('added' in lines[0]), Object.keys(lines[0]).join(','));

console.log(NL + '8. The other rules are untouched');
const inj = A.analyzeSqlInFiles([{ filename: 'routes/user.js', patch: P(
  '@@ -0,0 +1,3 @@',
  '+router.get("/u/:id", async (req, res) => {',
  '+  const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);',
  '+});',
) }]);
check('string-interpolated SQL still critical',
  inj.some(f => f.title === 'SQL built by string interpolation' && f.severity === 'critical'),
  inj.map(f => f.title).join(' | '));
check('SELECT * still reported', inj.some(f => f.title === 'SELECT * over-fetches'),
  inj.map(f => f.title).join(' | '));

console.log(NL + '9. documenso/documenso#3301 (2nd) — a concise-body arrow has no body to be "inside"');
const concise = run('apps/remix/app/routes/direct.$token.tsx', P(
  '@@ -94,4 +94,12 @@',
  '   const fields = template.fields.filter((field) => field.recipientId === id);',
  ' ',
  '+  fireAndForget(async () => {',
  '+    const team = await prisma.team.findFirst({',
  '+      where: { id: template.teamId },',
  '+    });',
  '+  });',
));
check('a one-line .filter(x => …) opens no block', concise.length === 0,
  concise.map(f => f.line).join(', '));

console.log(NL + '10. Allman braces still open a loop (must fire)');
const allman = run('app/Repo.php', P(
  '@@ -1,2 +1,6 @@',
  '     public function run($ids) {',
  '+        foreach ($ids as $id)',
  '+        {',
  "+            $u = DB::table('users')->where('id', $id)->first();",
  '+        }',
));
check('brace on the next line still counts', allman.length === 1, 'got ' + allman.length);

console.log(NL + '11. strapi#27427 — batched pagination is NOT an N+1');
// A CAPPED query inside a `while` is the recommended way to walk a large
// table. Reporting it as an N+1 tells the author to undo the correct fix.
const paging = run('src/audit.ts', P(
  '@@ -1,2 +1,10 @@',
  '   async function* chunks() {',
  '+    let remaining = partSize;',
  '+    while (remaining > 0) {',
  '+      const batchLimit = Math.min(BATCH, remaining);',
  '+      const rows = await strapi.db.query("audit").findMany({',
  '+        where: buildWhere(lastId),',
  '+        orderBy: { id: "asc" },',
  '+        limit: batchLimit,',
  '+      });',
  '+    }',
));
check('a capped query in a while loop is pagination, not N+1', paging.length === 0,
  paging.map(f => f.line).join(', '));

console.log(NL + '12. …but an UNCAPPED query in a while loop still fires');
const uncapped = run('src/drain.ts', P(
  '@@ -1,2 +1,6 @@',
  '   async function drain(queue) {',
  '+    while (queue.length > 0) {',
  '+      const next = await prisma.job.findFirst({ where: { done: false } });',
  '+      process(next);',
  '+    }',
));
check('uncapped query in a while loop still reported', uncapped.length === 1,
  'got ' + uncapped.length);

console.log(NL + '13. …and a capped query in a for-of over a collection is still N+1');
const forOf = run('src/sync.ts', P(
  '@@ -1,2 +1,6 @@',
  '   async function sync(ids) {',
  '+    for (const id of ids) {',
  '+      const row = await prisma.user.findMany({ where: { id }, take: 1 });',
  '+      use(row);',
  '+    }',
));
check('for-of with a cap is still an N+1', forOf.length === 1, 'got ' + forOf.length);

console.log(NL + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
