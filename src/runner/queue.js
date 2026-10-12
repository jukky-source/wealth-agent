// Cloud-PC runner queue.
//
// The brain (this Worker) stays tiny and always-on; heavy work is handed to a
// machine with a real filesystem — GitHub Codespaces, Google Cloud Shell, a VPS,
// Cloudflare Containers, or any box you can SSH into. The hand-off is a durable
// job row, so a sleeping laptop or a 15-minute cron gap never loses work.
//
// Safety, stated plainly:
//  * Off by default. Nothing is accepted until RUNNER_ENABLED=true and a
//    RUNNER_TOKEN secret exist, and the pairing token can only reach
//    /api/runner/*.
//  * The command must match the RUNNER_ALLOW prefix list server-side AND the
//    runner re-checks it locally before spawning. Two locks, not one.
//  * stdout/stderr are capped (RUNNER_MAX_OUTPUT, default 20k chars) and the
//    job carries a hard timeout (RUNNER_MAX_MS, default 60s) that the runner
//    enforces with SIGKILL.

import { nowIso, truncate } from '../util.js';

export function createRunner({ store, env = {} } = {}) {
  const cfg = {
    enabled: String(env.RUNNER_ENABLED || 'false') === 'true',
    token_configured: !!env.RUNNER_TOKEN,
    maxMs: Math.max(1000, Number(env.RUNNER_MAX_MS || 60000)),
    maxOutput: Math.max(1000, Number(env.RUNNER_MAX_OUTPUT || 20000)),
    allow: String(env.RUNNER_ALLOW || 'node,npm,npx,python3,pip3,ls,cat,echo,pwd,git,date,df,uname,head,tail,wc,find,grep,curl')
      .split(',').map((s) => s.trim()).filter(Boolean),
  };

  const newId = () => `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  /** Is the command inside the server-side allow-list? */
  function allowed(command) {
    const first = String(command || '').trim().split(/\s+/)[0] || '';
    const bin = first.split('/').pop();
    return cfg.allow.includes(bin);
  }

  async function enqueue({ command, cwd = null, timeoutMs = null, requestedBy = 'owner' } = {}) {
    if (!cfg.enabled) {
      return { ok: false, error: 'runner_disabled', hint: 'クラウドPC連携は無効です。デプロイ先で RUNNER_ENABLED=true と RUNNER_TOKEN を設定し、runner/agent-runner.mjs を起動してください。' };
    }
    const cmd = String(command || '').trim();
    if (!cmd) return { ok: false, error: 'command_required' };
    if (cmd.length > 2000) return { ok: false, error: 'command_too_long', hint: '2000文字までです' };
    if (!allowed(cmd)) {
      return { ok: false, error: 'command_not_allowed', allowed: cfg.allow, hint: `先頭コマンド「${cmd.split(/\s+/)[0]}」は許可リストにありません（RUNNER_ALLOW で追加できます）` };
    }
    const row = {
      id: newId(), command: cmd, cwd: cwd ? String(cwd).slice(0, 300) : null,
      timeout_ms: Math.min(cfg.maxMs, Math.max(1000, Number(timeoutMs) || cfg.maxMs)),
      state: 'queued', runner_id: null, exit_code: null, stdout: null, stderr: null,
      duration_ms: null, requested_by: requestedBy, created_at: nowIso(), started_at: null, finished_at: null,
    };
    await store.insert('runner_jobs', row);
    return { ok: true, job: row, allowed: cfg.allow };
  }

  /**
   * Claim up to `limit` queued jobs for one machine. The claim is a conditional
   * UPDATE, so two runners polling at the same instant can never both take the
   * same job — the loser just sees an empty queue this round.
   */
  async function claim({ runnerId = 'cloud-pc', limit = 3 } = {}) {
    if (!cfg.enabled) return { ok: false, error: 'runner_disabled' };
    const n = Math.max(1, Math.min(10, Number(limit) || 3));
    const queued = await store.all(`SELECT id FROM runner_jobs WHERE state='queued' ORDER BY created_at ASC LIMIT ?`, n);
    const taken = [];
    for (const q of queued) {
      const res = await store.run(
        `UPDATE runner_jobs SET state='running', runner_id=?, started_at=? WHERE id=? AND state='queued'`,
        runnerId, nowIso(), q.id,
      );
      const changed = res?.changes ?? res?.meta?.changes ?? 1;
      if (changed) {
        const job = await store.get('runner_jobs', q.id);
        if (job) taken.push(job);
      }
    }
    return { ok: true, jobs: taken, count: taken.length };
  }

  /** Report a finished job. Output is capped; the runner already killed on timeout. */
  async function complete({ jobId, exitCode = null, stdout = '', stderr = '', durationMs = null, runnerId = null } = {}) {
    if (!jobId) return { ok: false, error: 'job_id_required' };
    const job = await store.get('runner_jobs', jobId);
    if (!job) return { ok: false, error: 'job_not_found' };
    await store.update('runner_jobs', jobId, {
      state: exitCode === 0 ? 'done' : 'failed',
      exit_code: exitCode === null ? null : Number(exitCode),
      stdout: truncate(String(stdout || ''), cfg.maxOutput),
      stderr: truncate(String(stderr || ''), cfg.maxOutput),
      duration_ms: durationMs === null ? null : Number(durationMs),
      runner_id: runnerId || job.runner_id,
      finished_at: nowIso(),
    });
    return { ok: true, job: await store.get('runner_jobs', jobId) };
  }

  async function cancel(jobId) {
    const job = await store.get('runner_jobs', jobId);
    if (!job) return { ok: false, error: 'job_not_found' };
    if (!['queued', 'running'].includes(job.state)) return { ok: false, error: 'not_cancellable', state: job.state };
    await store.update('runner_jobs', jobId, { state: 'cancelled', finished_at: nowIso() });
    return { ok: true, job: await store.get('runner_jobs', jobId) };
  }

  async function jobs({ limit = 20 } = {}) {
    return store.all('SELECT * FROM runner_jobs ORDER BY created_at DESC LIMIT ?', Math.max(1, Math.min(50, Number(limit) || 20)));
  }

  /** A cloud PC that has polled recently counts as online. */
  async function status({ limit = 20 } = {}) {
    const rows = await jobs({ limit });
    const seen = new Map();
    for (const j of rows) {
      if (!j.runner_id) continue;
      const cur = seen.get(j.runner_id);
      const at = j.finished_at || j.started_at || j.created_at;
      if (!cur || at > cur) seen.set(j.runner_id, at);
    }
    const runners = [...seen.entries()].map(([id, at]) => ({
      id, last_seen: at, online: Date.now() - new Date(at).getTime() < 3 * 60e3,
    }));
    const counts = {};
    for (const s of ['queued', 'running', 'done', 'failed', 'cancelled']) counts[s] = rows.filter((j) => j.state === s).length;
    return {
      enabled: cfg.enabled,
      token_configured: cfg.token_configured,
      ready: cfg.enabled && cfg.token_configured,
      allow: cfg.allow,
      max_ms: cfg.maxMs,
      max_output: cfg.maxOutput,
      counts,
      runners,
      online: runners.some((r) => r.online),
      jobs: rows,
      setup: {
        step1: 'Cloudflare（または .dev.vars）に RUNNER_ENABLED=true と RUNNER_TOKEN を設定',
        step2: 'クラウドPC側で: RUNNER_URL=<あなたのURL> RUNNER_TOKEN=<同じ値> node runner/agent-runner.mjs',
        step3: '「接続確認」ボタンか、この画面のジョブ一覧で疎通を確認',
        one_liner: 'bash runner/cloud-pc.sh',
      },
    };
  }

  return { enqueue, claim, complete, cancel, jobs, status, allowed, cfg };
}
