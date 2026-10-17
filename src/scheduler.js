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
import { ensureStreams } from './agent/streams.js';
import { convene, saveDecision, pickTopic, DEFAULT_SEATS } from './agent/council.js';

export function createScheduler(deps) {
  const { store, env, engine, memory, ranking, workflows, router, research, fleet = null } = deps;

  async function scheduledTick({ source = 'cron', maxSteps = null } = {}) {
    const started = Date.now();
    const report = { source, at: nowIso(), steps: [] };

    // 0) 稼ぎ方ストリームを保証（無ければ自動作成。目標入力は不要）
    try {
      const s0 = await ensureStreams({ store, router, memory, engine });
      report.steps.push({ step: 'streams', created: s0.created.length });
    } catch (e) { report.steps.push({ step: 'streams', error: e.message }); }

    // 0b) 停止は「オーナーの明示操作」だけにする。理由が自動判定の停止なら起こす。
    try {
      const st0 = await engine.engineState();
      if (st0.status === 'stopped' || (st0.status === 'paused' && /戦略切替|再計画|人手/.test(String(st0.reason || '')))) {
        await engine.control('resume', { note: '自律運転のため自動再開' }).catch(() => {});
        report.steps.push({ step: 'auto_resume', from: st0.status });
      }
    } catch (e) { report.steps.push({ step: 'auto_resume', error: e.message }); }

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

    // 5b) スカウト（自律リサーチ）— 無料の巡回先だけを数箇所ずつ回し、稼げそうな
    //     話を点数化して残す。原価0。投稿・購入・アカウント作成はしない。
    //     毎tickやると外部に迷惑なので、既定3時間おきに間引く。
    try {
      const everyMin = Math.max(30, Number(env.SCOUT_EVERY_MINUTES || 180));
      const last = await setting(store, 'scout:last_run_at', null);
      const due = !last || (Date.now() - new Date(last).getTime() >= everyMin * 60e3);
      // SCOUT_ENABLED を明示したときだけ動かす（テストや想定外の環境で外部通信しない）
      if (due && env && env.SCOUT_ENABLED === 'true') {
        const { scoutTick } = await import('./agent/scout.js');
        const s = await scoutTick({ store, env, maxSources: Number(env.SCOUT_SOURCES_PER_TICK || 3), perSource: Number(env.SCOUT_PER_SOURCE || 12), minScore: Number(env.SCOUT_MIN_SCORE || 30) });
        await setSetting(store, 'scout:last_run_at', nowIso());
        report.steps.push({ step: 'scout', inserted: s.inserted, sources: s.sources.map((x) => `${x.source}:${x.kept}`), top: s.top[0]?.title || null });
      } else {
        report.steps.push({ step: 'scout', skipped: 'not_due' });
      }
    } catch (e) { report.steps.push({ step: 'scout', error: e.message }); }

    // 5c) FX Lab（試行錯誤ループ）— 少数の実験を回し続け、王者が更新されたら昇格させる。
    //     「ここで完成させる」のではなく、エージェントが試し続ける状態を作るのが目的。
    //     原価0（無料の市場データ＋自作バックテスト）。既定60分おきに2実験だけ。
    try {
      const everyMin = Math.max(15, Number(env.FX_LAB_EVERY_MINUTES || 60));
      const last = await setting(store, 'fxlab:last_run_at', null);
      const due = !last || (Date.now() - new Date(last).getTime() >= everyMin * 60e3);
      if (due && env && env.FX_LAB_ENABLED === 'true') {
        const { fxLabTick } = await import('./income/fxLab.js');
        const r = await fxLabTick({ store, env, n: Number(env.FX_LAB_EXPERIMENTS_PER_TICK || 2) });
        await setSetting(store, 'fxlab:last_run_at', nowIso());
        const top = (r.experiments || []).find((e) => e.fitness != null);
        report.steps.push({ step: 'fx_lab', ran: r.ran, improved: r.improved, best: top ? `${top.symbol}/${top.strategyKey} fitness=${top.fitness}` : null, promoted: r.promoted?.name || null });
      } else {
        report.steps.push({ step: 'fx_lab', skipped: due ? 'disabled' : 'not_due' });
      }
    } catch (e) { report.steps.push({ step: 'fx_lab', error: e.message }); }

    // 5c-2) Logic space（論理空間）— 文法の中で作れる論理を番号順に踏破する。
    //       FX Lab とは別の時計で回す（既定5分＝cronと同じ間隔）。原価0。
    try {
      const everyMin = Math.max(5, Number(env.FX_LAB_LOGIC_EVERY_MINUTES || 5));
      const last = await setting(store, 'fxlab:logic_last_at', null);
      const due = !last || (Date.now() - new Date(last).getTime() >= everyMin * 60e3);
      if (due && env && env.FX_LAB_LOGIC_ENABLED === 'true') {
        const { logicTick } = await import('./income/logic.js');
        const r = await logicTick({ store, env, n: Number(env.FX_LAB_LOGIC_PER_TICK || 3) });
        await setSetting(store, 'fxlab:logic_last_at', nowIso());
        const top = (r.experiments || []).find((e) => e.fitness != null);
        report.steps.push({ step: 'fx_logic', ran: r.ran, tier: r.tier, coverage: r.coverage_pct, deep: r.deep_validations || 0, best: top ? `${top.symbol}/${top.tier} fitness=${top.fitness}` : null, promoted: r.promoted && r.promoted.name ? r.promoted.name : null });
      } else {
        report.steps.push({ step: 'fx_logic', skipped: due ? 'disabled' : 'not_due' });
      }
    } catch (e) { report.steps.push({ step: 'fx_logic', error: e.message }); }

    // 5d) SNS下書きの自動補充 — scout が拾った実データから X / note / ココナラ の下書きを作る。
    //     投稿はしない（public_post=approval）。人は「押すだけ・貼るだけ」の材料だけ受け取る。
    try {
      const everyMin = Math.max(30, Number(env.SOCIAL_EVERY_MINUTES || 720));
      const prev = await setting(store, 'social:last_refill', null);
      const lastAt = prev && typeof prev === 'object' ? prev.at : null;
      const due = !lastAt || (Date.now() - new Date(lastAt).getTime() >= everyMin * 60e3);
      if (due && env && env.SOCIAL_ENABLED === 'true') {
        const { refillQueue } = await import('./agent/social.js');
        const r = await refillQueue({ store, limit: Number(env.SOCIAL_DRAFTS_PER_TICK || 2) });
        report.steps.push({ step: 'social_refill', created: r.created.length, blocked: r.blocked.length, skipped: r.skipped });
      } else {
        report.steps.push({ step: 'social_refill', skipped: due ? 'disabled' : 'not_due' });
      }
    } catch (e) { report.steps.push({ step: 'social_refill', error: e.message }); }

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
    // 議会（チーム制）: 数時間おきに開き、異なる立場の合意点を決めて残す。
    //   キャッシュが効くので同一議題の再審議はAIを呼ばない。予算切れなら決定的に議論。
    try {
      const everyMin = Math.max(30, Number(env.COUNCIL_EVERY_MINUTES || 180));
      const last = await setting(store, 'council:last_at', null);
      const due = !last || (Date.now() - new Date(last).getTime() >= everyMin * 60e3);
      if (due) {
        const t = await pickTopic(store);
        if (t) {
          const character = await engine.getCharacter().catch(() => null);
          const ev = await store.all("SELECT title,severity,source_url FROM memories WHERE kind='evidence' ORDER BY created_at DESC LIMIT 10").catch(() => []);
          const r = await convene({ router, character, topic: t.topic, evidenceBlock: `# 証拠メモ\n${JSON.stringify(ev)}`, seats: DEFAULT_SEATS });
          await saveDecision(store, r.decision, { missionId: t.mission_id, source: 'cron' });
          if (memory) await memory.write({ kind: 'checkpoint', scope: 'council', evidence: 'measured', importance: 70,
            text: `議会: 「${t.topic}」→ ${r.decision.verdict}（${r.decision.direction || ''}）` }).catch(() => {});
          await setSetting(store, 'council:last_at', nowIso());
          report.steps.push({ step: 'council', verdict: r.decision.verdict, seats: r.cost.seats, cached: r.cost.cached });
        }
      } else {
        report.steps.push({ step: 'council', skipped: 'not_due' });
      }
    } catch (e) { report.steps.push({ step: 'council', error: e.message }); }

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
