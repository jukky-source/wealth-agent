#!/usr/bin/env node
// Cloud-PC runner — the agent's hands.
//
// Run this on any machine with a real filesystem (GitHub Codespaces, Google
// Cloud Shell, a VPS, Docker, an old laptop). It polls the deployment for
// queued jobs, executes them in a working directory, and posts the output back.
// The brain keeps running 24/7; this only has to be alive when there is work.
//
//   RUNNER_URL=https://<your-worker>.workers.dev \
//   RUNNER_TOKEN=<same RUNNER_TOKEN as the Worker> \
//   node runner/agent-runner.mjs
//
// Safety (see "safety" section below): it refuses to start without a token,
// turns each job into an argv ARRAY and NEVER invokes a shell, so shell
// metacharacters cannot chain a second command; it re-checks the allow-list
// locally, pins the working directory inside RUNNER_WORKDIR, hands the child a
// minimal environment (not the runner's own secrets), kills on timeout
// (SIGKILL on the process group), and caps the output it uploads.

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const URL_BASE = (process.env.RUNNER_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.RUNNER_TOKEN || '';
const RUNNER_ID = process.env.RUNNER_ID || `pc-${hostname()}`;
const WORKDIR = resolve(process.env.RUNNER_WORKDIR || `${process.env.HOME || '/tmp'}/agent-workspace`);
const POLL_MS = Math.max(1000, Number(process.env.RUNNER_POLL_MS || 5000));
const MAX_OUTPUT = Math.max(1000, Number(process.env.RUNNER_MAX_OUTPUT || 20000));
const ALLOW = (process.env.RUNNER_ALLOW
  || 'node,npm,npx,python3,pip3,ls,cat,echo,pwd,git,date,df,uname,head,tail,wc,find,grep,curl')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!URL_BASE || !TOKEN) {
  console.error('[runner] RUNNER_URL と RUNNER_TOKEN は必須です。');
  console.error('[runner] 例: RUNNER_URL=https://xxx.workers.dev RUNNER_TOKEN=... node runner/agent-runner.mjs');
  process.exit(2);
}
mkdirSync(WORKDIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- safety
//
// "Check the first word" is not a command validator. A job string like
//   echo hi; rm -rf /
// has an allow-listed first word (echo) and passes a first-token check, yet a
// shell would still run `rm -rf /`. So we do two things instead:
//
//   1. Reject a shell metacharacter found OUTSIDE quotes. Unquoted `;` / `|` /
//      `$(` / backticks only mean something when a shell parses them, so a
//      legitimate argv job never needs one. This is the belt.
//   2. Turn the string into an argv ARRAY and call spawn() with shell:false.
//      The child gets the binary and its arguments directly — there is no shell
//      in the pipeline to inject into, so a metacharacter INSIDE quotes (e.g.
//      `python3 -c "print(1)"`) is passed through literally and stays inert.
//      This is the braces, and it is what makes the fix real, not cosmetic.
//
// We also hand the child a minimal environment, so a job cannot read the
// runner's own RUNNER_TOKEN or any other secret from process.env.
const SHELL_META = /[;&|`$><(){}[\]\n\r\0*?!~\\]/;

function tokenize(raw) {
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

/** command string -> { bin, args } or { error }. Never returns a shell line. */
function parseCommand(command) {
  const raw = String(command ?? '').trim();
  if (!raw) return { error: 'command_required' };
  if (raw.length > 2000) return { error: 'command_too_long' };
  const t = tokenize(raw);
  if (t.error) return { error: t.error };
  const bin = t.tokens[0];
  const name = bin.split('/').pop();
  if (!ALLOW.includes(name)) return { error: `command_not_allowed:${name}` };
  return { bin, name, args: t.tokens.slice(1) };
}

/** Keep every job inside RUNNER_WORKDIR — a job cannot point cwd at / or $HOME. */
function safeCwd(cwd) {
  const p = resolve(cwd || WORKDIR);
  return (p === WORKDIR || p.startsWith(WORKDIR + sep)) ? p : WORKDIR;
}

const SAFE_ENV = {
  PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: process.env.LANG || 'C.UTF-8',
  HOME: WORKDIR,
  TMPDIR: process.env.TMPDIR || '/tmp',
  AGENT_WORKDIR: WORKDIR,
};

async function call(path, body) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: 'bad_response', text: text.slice(0, 300) }; }
}

function runJob(job) {
  return new Promise((resolve_) => {
    const parsed = parseCommand(job.command);
    if (parsed.error) {
      resolve_({ exit_code: 126, stdout: '', stderr: `実行を拒否しました（${parsed.error}）: ${job.command}`, duration_ms: 0 });
      return;
    }
    const started = Date.now();
    const timeout = Math.min(Number(job.timeout_ms) || 60000, 15 * 60e3);
    // shell:false — the binary is executed directly with argv. No shell.
    const child = spawn(parsed.bin, parsed.args, {
      cwd: safeCwd(job.cwd), detached: true, shell: false, env: SAFE_ENV,
    });
    let out = '', err = '', killed = false;
    const cap = (s) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（以降は省略）` : s);
    child.stdout.on('data', (d) => { out = cap(out + d.toString()); });
    child.stderr.on('data', (d) => { err = cap(err + d.toString()); });
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeout);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve_({ exit_code: 127, stdout: out, stderr: `${err}\n[起動できませんでした: ${e.message}]`, duration_ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve_({
        exit_code: killed ? 124 : (code ?? 1),
        stdout: out, stderr: killed ? `${err}\n[タイムアウト ${timeout}ms で強制終了しました]` : err,
        duration_ms: Date.now() - started,
      });
    });
  });
}

let stopping = false;
process.on('SIGINT', () => { stopping = true; log('[runner] 停止します…'); setTimeout(() => process.exit(0), 200); });

log(`[runner] 起動 — id=${RUNNER_ID} url=${URL_BASE} workdir=${WORKDIR}`);
log(`[runner] 許可コマンド: ${ALLOW.join(', ')}`);
log('[runner] 実行方式: argv 直実行（シェル不使用）・環境変数は最小限・cwd は workdir 内に固定');

let idle = 0;
while (!stopping) {
  try {
    const c = await call('/api/runner/claim', { runner_id: RUNNER_ID, limit: 3 });
    if (c.ok && c.jobs && c.jobs.length) {
      idle = 0;
      for (const job of c.jobs) {
        log(`[runner] 実行: ${job.id} — ${job.command}`);
        const r = await runJob(job);
        const done = await call('/api/runner/complete', {
          job_id: job.id, runner_id: RUNNER_ID, exit_code: r.exit_code,
          stdout: r.stdout, stderr: r.stderr, duration_ms: r.duration_ms,
        });
        log(`[runner] 完了: ${job.id} exit=${r.exit_code} ${r.duration_ms}ms 報告=${done.ok ? 'ok' : '失敗'}`);
      }
    } else if (!c.ok) {
      log(`[runner] claim 失敗: ${c.error || ''} ${c.hint || ''}`);
      await new Promise((r) => setTimeout(r, 15000));
    } else {
      idle++;
      if (idle % 12 === 1) log('[runner] 待機中（仕事なし）');
    }
  } catch (e) {
    log(`[runner] 通信エラー: ${e.message}`);
    await new Promise((r) => setTimeout(r, 10000));
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
