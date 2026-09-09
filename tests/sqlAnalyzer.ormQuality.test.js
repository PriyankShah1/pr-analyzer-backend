// ORM query-quality rules.
//
// Why these exist: a sweep of 573 real merged PRs found raw SQL in a small
// minority and Eloquent in 60% of the PRs that touch a database. The nine
// raw-SQL rules were aimed at a code path modern applications barely use, and
// produced nothing across the whole sweep. These rules read the ORM call SHAPE
// instead.
//
// The negative half of this file is the important half. These rules fire on
// ordinary application code rather than on rare mistakes, so a false positive
// here is not a curiosity — it is noise on every review, which is how a
// reviewer learns to ignore the tool.

const { analyzeSqlInFiles } = require('../parsers/sqlAnalyzer');

const NL = String.fromCharCode(10);
const D = String.fromCharCode(36);   // $
const Q = String.fromCharCode(39);   // '

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + extra : '')); }
};

function findingsFor(filename, lines) {
  const patch = '@@ -0,0 +1,' + lines.length + ' @@' + NL + lines.map(l => '+' + l).join(NL);
  return analyzeSqlInFiles([{ filename, patch }]);
}
const titles = (filename, lines) => findingsFor(filename, lines).map(f => f.title);

const fires = (name, filename, lines, want) => {
  const t = titles(filename, lines);
  check(name, t.some(x => want.test(x)), t.join(' | ') || 'nothing fired');
};
const silent = (name, filename, lines) => {
  const t = titles(filename, lines);
  check(name, t.length === 0, 'fired: ' + t.join(' | '));
};

// Wrap PHP lines in a class so they look like real application code.
const php = body => ['class Svc {', '    public function handle(' + D + 'id) {', ...body.map(l => '        ' + l), '    }', '}'];
const js = body => ['export async function handle(id) {', ...body.map(l => '  ' + l), '}'];

// The rule reports reads with NO filter at all.
//
// It once reported any read without a row cap. A 626-PR sweep fired that
// version five times and it was wrong five times — every case was "fetch the
// rows belonging to one owner" (a user's folders, a dashboard's widgets, one
// accessory's acceptances, a type's categories). That is ordinary correct
// code. A filter bounds a query in practice even though it is not a LIMIT, so
// only the unfiltered case is reported now.
console.log(NL + '1. Unfiltered reads — Eloquent');
fires('Model::all()', 'app/Svc.php', php(['return Order::all();']), /every matching row/);

console.log(NL + '2. Unfiltered reads — JS ORMs');
fires('prisma findMany()', 'src/a.ts', js(['return prisma.order.findMany();']), /every matching row/);
fires('sequelize findAll()', 'src/c2.js', js(['return Order.findAll();']), /every matching row/);
fires('typeorm find({ relations }) with no where', 'src/d.ts',
  js(['return repo.find({ relations: [' + Q + 'items' + Q + '] });']), /every matching row/);

console.log(NL + '3. Work done in PHP that belongs in the query');
fires('->get()->filter()', 'app/Svc.php',
  php(['return Order::query()->get()->filter(fn(' + D + 'o) => ' + D + 'o->paid);']), /filtered in PHP/);
fires('->get()->count()', 'app/Svc.php',
  php(['return Order::query()->where("x", 1)->get()->count();']), /Aggregate computed in PHP/);
fires('->get()->sum()', 'app/Svc.php',
  php(['return Order::query()->where("x", 1)->get()->sum("total");']), /Aggregate computed in PHP/);
fires('->get()->sortBy()', 'app/Svc.php',
  php(['return Order::query()->where("x", 1)->get()->sortBy("total");']), /sorted in PHP/);

console.log(NL + '4. One defect reports ONCE, on the line holding the fetch');
const chain = findingsFor('app/Svc.php', php([
  'return Order::query()',
  '    ->get()',
  '    ->filter(fn(' + D + 'o) => ' + D + 'o->paid);']));
check('exactly one finding for a multi-line chain', chain.length === 1, chain.length);
check('anchored to the ->get() line',
  chain[0] && /->get\(\)/.test(chain[0].snippet), chain[0] && chain[0].snippet);

console.log(NL + '5. PRECISION GUARD — bounded queries must stay silent');
silent('->paginate(20)', 'app/Svc.php', php(['return Order::query()->paginate(20);']));
silent('->limit(10)->get()', 'app/Svc.php', php(['return Order::query()->limit(10)->get();']));
silent('->take(5)->get()', 'app/Svc.php', php(['return Order::query()->take(5)->get();']));
silent('->first()', 'app/Svc.php', php(['return Order::query()->where("id", ' + D + 'id)->first();']));
silent('->count() in SQL', 'app/Svc.php', php(['return Order::query()->where("id", ' + D + 'id)->count();']));
silent('->chunk()', 'app/Svc.php', php(['Order::query()->chunk(100, fn(' + D + 'rows) => null);']));
silent('->cursor()', 'app/Svc.php', php(['foreach (Order::query()->cursor() as ' + D + 'o) { noop(); }']));
silent('->exists()', 'app/Svc.php', php(['return Order::query()->where("id", ' + D + 'id)->exists();']));
silent('bounded, multi-line', 'app/Svc.php', php([
  'return Order::query()',
  '    ->where("user_id", ' + D + 'id)',
  '    ->limit(50)',
  '    ->get();']));
silent('prisma take:', 'src/e.ts', js(['return prisma.order.findMany({ where: { id }, take: 50 });']));
silent('prisma take: multi-line', 'src/f.ts', js([
  'return prisma.order.findMany({',
  '  where: { id },',
  '  take: 50,',
  '});']));
silent('sequelize limit:', 'src/g.js', js(['return Order.findAll({ where: { id }, limit: 20 });']));

console.log(NL + '6. PRECISION GUARD — things that are not queries at all');
silent('$request->get("key")', 'app/Svc.php', php(['return ' + D + 'request->get("page");']));
silent('Http client ->get($url)', 'app/Svc.php', php([
  'return Http::withUserAgent("x")->get(' + D + 'url)->body();']));
silent('Cache::get()', 'app/Svc.php', php(['return Cache::get("key");']));
silent('config()->get()', 'app/Svc.php', php(['return config()->get("app.name");']));
silent('a collection filter with no query', 'app/Svc.php', php([
  'return ' + D + 'this->items->filter(fn(' + D + 'i) => ' + D + 'i->ok);']));
silent('Array.prototype.find with a callback', 'src/h.ts',
  js(['return items.find((x) => x.id === id);']));
silent('a plain object literal named find', 'src/i.ts',
  js(['const opts = { find: true };', 'return opts;']));
silent('no database code whatsoever', 'src/j.ts',
  js(['return id.toUpperCase();']));

console.log(NL + '7. Non-production files are still skipped');
silent('a seeder may legitimately read everything', 'database/seeders/OrderSeeder.php',
  php(['return Order::all();']));
silent('a test may too', 'tests/OrderTest.php', php(['return Order::all();']));

console.log(NL + '8. The finding is actionable');
const f = findingsFor('app/Svc.php', php(['return Order::all();']))[0];
check('severity is high', f && f.severity === 'high', f && f.severity);
check('suggests a concrete fix', f && /limit|paginate|chunk/i.test(f.suggestion), f && f.suggestion);
check('has a stable fingerprint', f && typeof f.fingerprint === 'string' && f.fingerprint.length > 0);

console.log(NL + '9. REAL false positives caught by the sweep — each must stay silent');

// firefly-iii#12698: bounded by an array the caller already holds.
silent('eloquent whereIn(...)->get()', 'app/Support/Steam.php', php([
  'return AccountMeta::query()->whereIn("account_id", ' + D + 'ids)->where("name", "x")->get();']));
silent('eloquent whereIn multi-line', 'app/Support/Steam.php', php([
  'return TransactionCurrency::query()',
  '    ->whereIn("id", ' + D + 'prefs)',
  '    ->where("id", "!=", ' + D + 'primary->id)',
  '    ->get();']));

// outline#13617: sequelize keyed by a variable holding an id array.
silent('findAll where id is a variable array', 'src/task.ts', js([
  'return Attachment.findAll({',
  '  where: { teamId: doc.teamId, id: attachmentIds },',
  '  transaction,',
  '});']));

// n8n#37857: TypeORM's In() operator.
silent('typeorm where In(ids)', 'src/repo.ts', js([
  'return await this.find({',
  '  select: [' + Q + 'agentId' + Q + '],',
  '  where: { workflowId: In(workflowIds) },',
  '});']));

console.log(NL + "10. A filtered read is NOT reported - the sweep verdict");
// Each of these is a real shape the wide rule got wrong, named by the PR.
silent("koel#2612: one user folders", 'app/Repo.php', php([
  'return PlaylistFolder::query()->where("user_id", ' + D + 'user->id)->orderBy("id")->get();']));
silent("formbricks#9141: one dashboard widgets", 'src/dash.ts', js([
  'return tx.dashboardWidget.findMany({',
  '  where: { dashboardId: data.dashboardId },',
  '  select: { layout: true },',
  '});']));
silent('akaunting#3347: categories of a type', 'app/Cat.php', php([
  'return Category::type(' + D + 'types)->enabled()->orderBy("name")->get();']));
silent('snipe-it#19599: acceptances for one record', 'app/Bulk.php', php([
  'return CheckoutAcceptance::where("checkoutable_id", ' + D + 'id)->get();']));

console.log(NL + '11. akaunting#3347 — never report on a brace or a blank line');
// The rule tested the STATEMENT window without anchoring to the line holding
// the fetch, so every line inside the window reported — including a closing
// brace and an empty line.
const braces = findingsFor('app/Utilities/Overrider.php', [
  'class Overrider {',
  '    public static function load() {',
  '        $settings = Setting::all();',
  '        foreach ($settings as $s) {',
  '            config([$s->key => $s->value]);',
  '        }',
  '',
  '    }',
  '}',
]);
check('exactly one finding, not one per line', braces.length === 1, braces.length);
check('anchored to the ::all() line',
  braces[0] && /::all\(\)/.test(braces[0].snippet), braces[0] && JSON.stringify(braces[0].snippet));
check('never reports on a blank line',
  braces.every(f => f.snippet.trim().length > 0),
  JSON.stringify(braces.map(f => f.snippet)));
check('never reports on a bare brace',
  braces.every(f => f.snippet.trim() !== '}'),
  JSON.stringify(braces.map(f => f.snippet)));

console.log(NL + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
