// Scheduler — the heartbeat. Called from a Cloudflare Cron Trigger and from
// the local dev server's interval loop.
//
// Free-tier reality check (documented, not hidden):
//  * Workers Free: 5 cron triggers per account, 15 min wall time per run,
//    10 ms CPU per run → each run must do a BOUNDED amount of work and return.
//  * Therefore the scheduler does: engine steps (network-bound), workflow
//    schedules, quota wake-ups, daily recalibration — and nothing CPU-heavy.

import { nowIso, safeJson, utcDay, truncate } from './util.js';
import { setting, setSetting } from './db.js';
import { checkWatches } from './agent/watch.js';

export function createScheduler(deps) {
  const { store, env, engine, memory, ranking, workflows, router, research, fleet = null } = deps;

  async function scheduledTick({ source = 'cron', maxSteps = null } = {}) {
    const started = Date.now();
    const report = { source, at: nowIso(), steps: [] };

    // 1) wake tasks waiting on quota
    try {
      const w = await engine.resumeWaiting();
      report.steps.push({ step: 'resume_waiting', ...w });
    } catch (e) { report.steps.push({ step: 'resume_waiting', error: e.message }); }

    // 2) engine steps
    try {
      const t = await engine.tick({ maxSteps: maxSteps || Number(env.ENGINE_STEPS_PER_TICK || 3), source });
      report.steps.push({ step: 'engine_tick', ...t });
    } catch (e) { report.steps.push({ step: 'engine_tick', error: e.message }); }

    // 2b) run every agent that is switched on (bounded slice each)
    if (fleet) {
      try {
        const f = await fleet.tickAll({ source: 'cron', concurrency: 3, steps: 1 });
        report.steps.push({ step: 'fleet_tick', ran: !!f.ran, agents: (f.agents || []).length, reason: f.reason || null });
      } catch (e) { report.steps.push({ step: 'fleet_tick', error: e.message }); }
    }

    // 3) scheduled workflows (at most one per run to protect the CPU budget)
    try {
      const due = await dueWorkflows();
      if (due.length) {
        const r = await workflows.run(due[0].id, { context: { scheduled: true, at: nowIso() } });
        report.steps.push({ step: 'workflow', workflow: due[0].name, runId: r.runId, status: r.status });
      } else {
        report.steps.push({ step: 'workflow', due: 0 });
      }
    } catch (e) { report.steps.push({ step: 'workflow', error: e.message }); }

    // 4) daily housekeeping
    try {
      const last = await setting(store, 'scheduler:last_daily', null);
      if (last !== utcDay()) {
        const r = await ranking.recalibrate(store, { character: await engine.getCharacter() });
        await setSetting(store, 'scheduler:last_daily', utcDay());
        report.steps.push({ step: 'daily_recalibration', ...r });
      }
    } catch (e) { report.steps.push({ step: 'daily_recalibration', error: e.message }); }

    // 5) watch rules — speak up on its own only when the condition is really met
    let holds = [];
    try {
      const w = await checkWatches({ store, memory });
      holds = w.holds || [];
      if (w.fired.length) report.steps.push({ step: 'watch', fired: w.fired.length, ids: w.fired.map((f) => f.id) });
      else report.steps.push({ step: 'watch', checked: w.checked, fired: 0 });
    } catch (e) { report.steps.push({ step: 'watch', error: e.message }); }

    // 6) goal（完了条件としての見張り）— 未達なら止めない。あと何が必要かを数え直し、
    //    エンジンが止まっていれば起こす。ここも重い処理はしない。
    try {
      if (holds.length) {
        const st = await engine.engineState();
        if (st.status !== 'running') await engine.control('resume').catch(() => {});
        const top = holds[0];
        const { WATCH_METRICS } = await import('./agent/watch.js');
        const label = WATCH_METRICS[top.metric]?.label || top.metric;
        await memory.write({
          kind: 'next_action', key: `goal:${top.id}`, evidence: 'measured', importance: 65,
          text: `完了条件まであと ${top.remain}${top.unit || ''}（${label} ${top.current}/${top.target}）`,
          data: { watch_id: top.id, metric: top.metric, remain: top.remain, pct: top.pct },
        }).catch(() => {});
        report.steps.push({ step: 'goal', holds: holds.length, remain: top.remain, pct: top.pct, resumed: st.status !== 'running' });
      } else {
        report.steps.push({ step: 'goal', holds: 0 });
      }
    } catch (e) { report.steps.push({ step: 'goal', error: e.message }); }

    await store.run(`INSERT INTO settings (key,value,updated_at) VALUES ('scheduler:last_run',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      JSON.stringify({ at: report.at, durationMs: Date.now() - started, source, steps: report.steps.map((s) => s.step) }), nowIso());

    report.durationMs = Date.now() - started;
    return report;
  }

  /** Simple cron matcher for the subset of syntax used by starter workflows. */
  async function dueWorkflows() {
    const rows = await store.all('SELECT * FROM workflows WHERE enabled=1');
    const now = new Date();
    const out = [];
    for (const wf of rows) {
      const def = safeJson(wf.definition, {});
      if (!def.schedule) continue;
      if (!cronMatches(def.schedule, now)) continue;
      const lastKey = `workflow:last:${wf.id}`;
      const last = await setting(store, lastKey, null);
      const minuteKey = `${now.toISOString().slice(0, 16)}`;
      if (last === minuteKey) continue;
      await setSetting(store, lastKey, minuteKey);
      out.push(wf);
    }
    return out;
  }

  return { scheduledTick, dueWorkflows, cronMatches };
}

// Supports: m h dom mon dow with wildcard, step (slash), lists (comma), ranges and exact numbers.
export function cronMatches(expr, date) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  const checks = [
    [m, date.getUTCMinutes()], [h, date.getUTCHours()], [dom, date.getUTCDate()],
    [mon, date.getUTCMonth() + 1], [dow, date.getUTCDay()],
  ];
  return checks.every(([field, value]) => fieldMatch(field, value));
}

function fieldMatch(field, value) {
  if (field === '*') return true;
  return field.split(',').some((part) => {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = Number(stepStr) || 1;
      if (range === '*') return value % step === 0;
      const [lo, hi] = range.split('-').map(Number);
      return value >= lo && value <= hi && (value - lo) % step === 0;
    }
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      return value >= lo && value <= hi;
    }
    return Number(part) === value;
  });
}
