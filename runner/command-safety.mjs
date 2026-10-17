// Command safety for the Cloud-PC runner — shared by the live runner and its tests.
//
// The runner executes commands that an autonomous agent wrote. "Check the first
// word against an allow-list, then hand the whole line to /bin/sh -lc" is not a
// validator: `echo hi; rm -rf /` has an allow-listed first word and still runs
// the second half. The defence here is structural, in two layers:
//
//   1. parseCommand() turns the job string into an argv ARRAY. A shell
//      metacharacter found OUTSIDE quotes is rejected outright — metacharacters
//      only mean something when a shell parses them, so a legitimate argv job
//      never needs one. Metacharacters INSIDE quotes are kept, because the
//      runner never invokes a shell: spawn(bin, args, { shell: false }) passes
//      them literally, so `python3 -c "print(1)"` works and `$(id)` stays inert.
//   2. safeCwd() keeps a job's working directory inside the runner workdir, so
//      a job cannot point cwd at / or $HOME and climb out.

/** Commands the runner will execute if RUNNER_ALLOW is unset. */
export const DEFAULT_ALLOW = [
  'node', 'npm', 'npx', 'python3', 'pip3', 'ls', 'cat', 'echo', 'pwd', 'git',
  'date', 'df', 'uname', 'head', 'tail', 'wc', 'find', 'grep', 'curl',
];

/** Characters that only do something when a shell parses them. */
export const SHELL_META = /[;&|`$><(){}[\]\n\r\0*?!~\\]/;

/** Split a command line on whitespace, honouring '…' and "…" quoting. */
export function tokenize(raw) {
  const out = [];
  let cur = '', quote = null, has = false;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (SHELL_META.test(ch)) return { error: 'shell_metacharacter_rejected' };
    if (/\s/.test(ch)) { if (has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += ch; has = true;
  }
  if (quote) return { error: 'unterminated_quote' };
  if (has) out.push(cur);
  return { tokens: out };
}

/**
 * command string -> { bin, name, args } (argv, never a shell line) or { error }.
 * @param {unknown} command
 * @param {string[]} [allow]
 */
export function parseCommand(command, allow = DEFAULT_ALLOW) {
  const raw = String(command ?? '').trim();
  if (!raw) return { error: 'command_required' };
  if (raw.length > 2000) return { error: 'command_too_long' };
  const t = tokenize(raw);
  if (t.error) return { error: t.error };
  const bin = t.tokens[0];
  const name = bin.split('/').pop();
  if (!allow.includes(name)) return { error: `command_not_allowed:${name}` };
  return { bin, name, args: t.tokens.slice(1) };
}

/** Resolve a job's cwd, clamped to the runner workdir. */
export function safeCwd(cwd, root) {
  const base = String(root || '').replace(/\/+$/, '');
  const p = String(cwd || base);
  return (p === base || p.startsWith(`${base}/`)) ? p : base;
}
