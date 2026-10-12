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
// Safety: it refuses to start without a token, re-checks the allow-list locally
// before spawning, kills on timeout (SIGKILL on the process group), and caps the
// output it uploads.

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const URL_BASE = (process.env.RUNNER_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.RUNNER_TOKEN || '';
const RUNNER_ID = process.env.RUNNER_ID || `pc-${hostname()}`;
const WORKDIR = process.env.RUNNER_WORKDIR || `${process.env.HOME || '/tmp'}/agent-workspace`;
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

async function call(path, body) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: 'bad_response', text: text.slice(0, 300) }; }
}

function allowedCommand(command) {
  const first = String(command || '').trim().split(/\s+/)[0] || '';
  return ALLOW.includes(first.split('/').pop());
}

function runJob(job) {
  return new Promise((resolve) => {
    if (!allowedCommand(job.command)) {
      resolve({ exit_code: 126, stdout: '', stderr: `許可リストにないコマンドです: ${job.command}`, duration_ms: 0 });
      return;
    }
    const started = Date.now();
    const timeout = Math.min(Number(job.timeout_ms) || 60000, 15 * 60e3);
    const child = spawn('/bin/sh', ['-lc', job.command], {
      cwd: job.cwd || WORKDIR, detached: true, env: { ...process.env, AGENT_WORKDIR: WORKDIR },
    });
    let out = '', err = '', killed = false;
    const cap = (s) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（以降は省略）` : s);
    child.stdout.on('data', (d) => { out = cap(out + d.toString()); });
    child.stderr.on('data', (d) => { err = cap(err + d.toString()); });
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
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
