// SQL injection detection across the forms it actually takes.
//
// From the recall pass. The rule fired only on JS TEMPLATE LITERALS, which
// meant the tool's single critical-severity rule missed:
//
//   - every PHP injection, in a tool that advertises Laravel support
//   - `'SELECT … WHERE id = ' + id`, the pre-template-literal JS idiom
//
// The demo fixture itself contained one of these (a concatenated LIKE) and had
// been reporting it only as a slow query, never as an injection.
//
// The negative cases matter as much as the positive ones: widening the most
// severe rule in the tool is exactly how a wave of false positives gets in.

const { analyzeSqlInFiles } = require('../parsers/sqlAnalyzer');

const NL = String.fromCharCode(10);
const Q = String.fromCharCode(39);   // '
const DQ = String.fromCharCode(34);  // "
const BT = String.fromCharCode(96);  // `
const D = String.fromCharCode(36);   // $

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + extra : '')); }
};

function injections(filename, lines) {
  const patch = '@@ -0,0 +1,' + lines.length + ' @@' + NL + lines.map(l => '+' + l).join(NL);
  return analyzeSqlInFiles([{ filename, patch }])
    .filter(f => f.title === 'SQL built by string interpolation');
}

const fires = (name, filename, lines) =>
  check(name, injections(filename, lines).length === 1,
    'got ' + injections(filename, lines).length);
const silent = (name, filename, lines) =>
  check(name, injections(filename, lines).length === 0,
    'fired: ' + injections(filename, lines).map(f => f.snippet).join(' | '));

console.log(NL + '1. JavaScript');
fires('template literal', 'src/a.js', [
  'async function f(id) {',
  '  return db.query(' + BT + 'SELECT id FROM users WHERE id = ' + D + '{id}' + BT + ');',
  '}']);
fires('string concatenation', 'src/b.js', [
  'async function f(id) {',
  '  return db.query(' + Q + 'SELECT id FROM users WHERE id = ' + Q + ' + id);',
  '}']);
fires('concatenation inside a LIKE (the demo fixture case)', 'src/c.js', [
  'async function f(term) {',
  '  return db.query(' + DQ + 'SELECT id FROM customers WHERE email LIKE ' + Q + '%'
    + DQ + ' + term + ' + DQ + '%' + Q + DQ + ');',
  '}']);
fires('interpolated table name', 'src/d.js', [
  'async function f(table) {',
  '  return db.query(' + BT + 'SELECT id FROM ' + D + '{table}' + BT + ');',
  '}']);

console.log(NL + '2. PHP — none of these were detected before');
fires('double-quoted "$var"', 'app/A.php', [
  'class A {',
  '    public function f(' + D + 'email) {',
  '        return DB::select(' + DQ + 'SELECT id FROM users WHERE email = ' + D + 'email' + DQ + ');',
  '    }',
  '}']);
fires('braced "{$var}"', 'app/B.php', [
  'class B {',
  '    public function f(' + D + 'email) {',
  '        return DB::select(' + DQ + 'SELECT id FROM users WHERE email = {' + D + 'email}' + DQ + ');',
  '    }',
  '}']);
fires('property access "{$user->id}"', 'app/C.php', [
  'class C {',
  '    public function f(' + D + 'user) {',
  '        return DB::select(' + DQ + 'SELECT id FROM logs WHERE uid = {' + D + 'user->id}' + DQ + ');',
  '    }',
  '}']);
fires('concatenation with .', 'app/D.php', [
  'class D {',
  '    public function f(' + D + 'email) {',
  '        return DB::select(' + DQ + 'SELECT id FROM users WHERE email = ' + DQ + ' . ' + D + 'email);',
  '    }',
  '}']);

console.log(NL + '3. Safe code must stay silent (precision guard)');
silent('parameterised query', 'src/e.js', [
  'async function f(id) {',
  '  return db.query(' + Q + 'SELECT id FROM users WHERE id = ' + D + '1' + Q + ', [id]);',
  '}']);
silent('PHP SINGLE-quoted $var does not interpolate in PHP', 'app/E.php', [
  'class E {',
  '    public function f(' + D + 'email) {',
  '        return DB::select(' + Q + 'SELECT id FROM users WHERE email = ' + D + 'email' + Q + ');',
  '    }',
  '}']);
silent('PHP bound parameters', 'app/F.php', [
  'class F {',
  '    public function f(' + D + 'email) {',
  '        return DB::select(' + Q + 'SELECT id FROM users WHERE email = ?' + Q + ', [' + D + 'email]);',
  '    }',
  '}']);
silent('two literal strings joined — no variable involved', 'src/f.js', [
  'async function f() {',
  '  return db.query(' + Q + 'SELECT id FROM users ' + Q + ' + ' + Q + 'WHERE active = true' + Q + ');',
  '}']);
silent('a plain string that merely mentions SQL words', 'src/g.js', [
  'function label(name) {',
  '  return ' + Q + 'Deleted from users: ' + Q + ' + name;',
  '}']);
silent('no SQL at all', 'src/h.js', [
  'function greet(name) {',
  '  return ' + BT + 'Hello ' + D + '{name}' + BT + ';',
  '}']);

console.log(NL + '4. The finding is usable');
const f = injections('app/G.php', [
  'class G {',
  '    public function f(' + D + 'email) {',
  '        return DB::select(' + DQ + 'SELECT id FROM users WHERE email = ' + D + 'email' + DQ + ');',
  '    }',
  '}'])[0];
check('severity is critical', f && f.severity === 'critical', f && f.severity);
check('the hole is shown as a placeholder', f && /\$\{…\}/.test(f.snippet), f && f.snippet);
check('it suggests parameterising', f && /parameteriz|parameter/i.test(f.suggestion), f && f.suggestion);

console.log(NL + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
