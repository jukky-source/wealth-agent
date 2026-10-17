// Cloud-PC runner command-safety tests.
// Proves the injection fix: allow-listed jobs still run, shell chaining is refused.
import { parseCommand, safeCwd, DEFAULT_ALLOW, SHELL_META } from '../runner/command-safety.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   - ${n}`); } else { fail++; console.log(`  FAIL - ${n} ${x}`); } };

// --- legitimate jobs still work (argv, no regression) ---
ok('plain command becomes argv', JSON.stringify(parseCommand('echo hello')) === JSON.stringify({ bin: 'echo', name: 'echo', args: ['hello'] }));
ok('flags are preserved', JSON.stringify(parseCommand('node -v').args) === '["-v"]');
ok('bare command has empty argv', JSON.stringify(parseCommand('pwd').args) === '[]');
ok('quoted argument survives as ONE argv element', JSON.stringify(parseCommand('python3 -c "print(1)"').args) === '["-c","print(1)"]');
ok('single quotes work too', JSON.stringify(parseCommand("node -e 'console.log(1)'").args) === '["-e","console.log(1)"]');

// --- the actual vulnerability: chained commands ---
for (const bad of [
  'echo hi; rm -rf /',
  'echo x | tee /etc/passwd',
  'ls `whoami`',
  'echo $(id)',
  'curl http://x && rm -rf /',
  'cat f > /etc/hosts',
  'echo a\nrm -rf /',
  'echo *',
]) {
  ok(`rejects chaining via shell meta: ${JSON.stringify(bad)}`, parseCommand(bad).error === 'shell_metacharacter_rejected', JSON.stringify(parseCommand(bad)));
}

// --- allow-list is on the binary, and not fooled by a substring ---
ok('non-allow-listed binary refused', parseCommand('rm -rf /').error === 'command_not_allowed:rm');
ok('binary name is checked after the last slash', parseCommand('/usr/bin/rm x').error === 'command_not_allowed:rm');
ok('substring is not a match', parseCommand('echo rm -rf /').error === undefined);

// --- limits ---
ok('empty command refused', parseCommand('   ').error === 'command_required');
ok('over-long command refused', parseCommand(`echo ${'x'.repeat(2100)}`).error === 'command_too_long');
ok('unterminated quote refused', parseCommand('echo "abc').error === 'unterminated_quote');
ok('custom allow-list is honoured', parseCommand('ffmpeg -i a out.mp4', ['ffmpeg']).name === 'ffmpeg');
ok('default allow-list excludes shell-only tools', !DEFAULT_ALLOW.includes('sh') && !DEFAULT_ALLOW.includes('bash'));

// --- working directory cannot escape ---
ok('cwd inside workdir is kept', safeCwd('/work/sub', '/work') === '/work/sub');
ok('cwd at workdir is kept', safeCwd('/work', '/work') === '/work');
ok('cwd outside workdir is clamped', safeCwd('/etc', '/work') === '/work');
ok('prefix-sibling is not mistaken for inside', safeCwd('/workshop/x', '/work') === '/work');
ok('missing cwd falls back to workdir', safeCwd(undefined, '/work') === '/work');

ok('SHELL_META detects a semicolon', SHELL_META.test('a;b'));

console.log(`\n════════ runner security: ${pass} passed, ${fail} failed ════════`);
process.exit(fail ? 1 : 0);
