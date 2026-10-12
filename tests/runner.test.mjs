// Cloud-PC runner queue tests: durability, atomic claim, allow-list, caps.
import { DatabaseSync } from 'node:sqlite';
import { Store, ensureSchema } from '../src/db.js';
import { createRunner } from '../src/runner/queue.js';

function d1() {
  const db = new DatabaseSync(':memory:');
  const wrap = (sql) => ({
    all: async (...p) => ({ results: db.prepare(sql).all(...p) }),
    first: async (...p) => db.prepare(sql).get(...p) ?? null,
    run: async (...p) => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...p)?.changes ?? 0) } }),
    bind: (...p) => ({
      all: async () => ({ results: db.prepare(sql).all(...p) }),
      first: async () => db.prepare(sql).get(...p) ?? null,
      run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...p)?.changes ?? 0) } }),
    }),
  });
  return { exec: (sql) => db.exec(sql), prepare: wrap };
}

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   - ${n}`); } else { fail++; console.log(`  FAIL - ${n} ${x}`); } };

const store = new Store(d1());
await ensureSchema(store);
const cols = await store.all(`SELECT name FROM pragma_table_info('runner_jobs')`);
ok('runner_jobs table exists', cols.some((c) => c.name === 'command'));

const off = createRunner({ store, env: {} });
ok('disabled by default', (await off.status()).enabled === false);
ok('disabled runner refuses jobs', (await off.enqueue({ command: 'echo hi' })).error === 'runner_disabled');

const r = createRunner({ store, env: { RUNNER_ENABLED: 'true', RUNNER_TOKEN: 'secret', RUNNER_MAX_MS: 5000 } });
ok('enabled with token reports ready', (await r.status()).ready === true);
ok('empty command rejected', (await r.enqueue({ command: '   ' })).error === 'command_required');
const bad = await r.enqueue({ command: 'rm -rf /' });
ok('non-allow-listed command rejected at submit', bad.error === 'command_not_allowed' && Array.isArray(bad.allowed));
ok('allow-list re-checks the binary, not a substring', (await r.enqueue({ command: 'echo rm -rf /' })).ok === true);
ok('oversized command rejected', (await r.enqueue({ command: `echo ${'x'.repeat(2100)}` })).error === 'command_too_long');

const j1 = (await r.enqueue({ command: 'echo hello' })).job;
const j2 = (await r.enqueue({ command: 'node -v' })).job;
ok('timeout is capped by RUNNER_MAX_MS', j1.timeout_ms === 5000, `got ${j1.timeout_ms}`);

const pendingBefore = (await r.jobs({ limit: 50 })).filter((j) => j.state === 'queued').length;
const cA = await r.claim({ runnerId: 'pc-a', limit: 50 });
const cB = await r.claim({ runnerId: 'pc-b', limit: 50 });
ok('first runner takes every queued job', cA.jobs.length === pendingBefore && pendingBefore >= 2, `took=${cA.jobs.length} queued=${pendingBefore}`);
ok('second runner gets nothing (no double execution)', cB.jobs.length === 0);
ok('claim stamps the runner and start time', (await store.get('runner_jobs', j1.id)).runner_id === 'pc-a' && !!cA.jobs[0].started_at);

const done = await r.complete({ jobId: j1.id, exitCode: 0, stdout: 'hello\n', stderr: '', durationMs: 12, runnerId: 'pc-a' });
ok('successful job is marked done with output', done.job.state === 'done' && done.job.stdout.includes('hello') && done.job.exit_code === 0);
const failed = await r.complete({ jobId: j2.id, exitCode: 127, stdout: '', stderr: 'not found', durationMs: 3 });
ok('non-zero exit is marked failed', failed.job.state === 'failed' && failed.job.exit_code === 127);
ok('unknown job reported, not thrown', (await r.complete({ jobId: 'nope' })).error === 'job_not_found');

const big = await r.enqueue({ command: 'echo big' });
const capped = await r.complete({ jobId: big.job.id, exitCode: 0, stdout: 'y'.repeat(50000) });
ok('output is capped', capped.job.stdout.length <= 20001, `len=${capped.job.stdout.length}`);

const j3 = (await r.enqueue({ command: 'pwd' })).job;
const cancelled = await r.cancel(j3.id);
ok('queued job can be cancelled', cancelled.job.state === 'cancelled');
ok('finished job is not cancellable', (await r.cancel(j1.id)).error === 'not_cancellable');

const st = await r.status();
ok('status counts by state', st.counts.done === 2 && st.counts.failed === 1 && st.counts.cancelled === 1, JSON.stringify(st.counts));
ok('status reports the paired machine + online flag', st.runners.length >= 1 && typeof st.runners[0].online === 'boolean');
ok('status carries the copy-paste setup', !!st.setup.one_liner && !!st.setup.step2);
ok('jobs list is newest-first', (await r.jobs({ limit: 3 }))[0].id !== j1.id);

console.log(`\n════════ runner tests: ${pass} passed, ${fail} failed ════════`);
process.exit(fail ? 1 : 0);
