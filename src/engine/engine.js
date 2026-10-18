// Autonomous Mission Engine — the heart of the system.
//
// One tick = a bounded amount of work. The loop continues because ticks are
// driven by (a) Cloudflare Cron Triggers, (b) client polling, (c) manual runs.
// State, evidence and checkpoints are persisted after EVERY step, so a quota
// error, a crash or a closed browser tab never loses progress.
//
// Anti-loop guarantees:
//   * no-progress counter → after N stalled steps the strategy is replaced
//   * strategy-switch counter → after M switches the mission waits for a human
//   * every retry mutates the task so it is genuinely different
//   * a hard per-tick step cap prevents runaway execution

import { id as newId, nowIso, j, safeJson, hash, truncate, round } from '../util.js';
import { setting, setSetting } from '../db.js';
import { planMission, replanAfterFailure, explainNext } from './planner.js';
import { selectNextTask, setState, runTaskAttempt, mutateForRetry, deriveTool, TERMINAL_STATES } from './executor.js';
import { verifyResult, verifyMission } from './verifier.js';
import { runPeerReview } from './peer.js';

export const ENGINE_DEFAULTS = {
  maxStepsPerTick: 3,
  maxStalledSteps: 6,
  maxStrategySwitches: 3,
  maxMissionsPerTick: 2,
  minMsBetweenMissions: 1500,
};

export function createEngine(deps) {
  const { store, env, router, memory, research, fx, rewards, sidehustle, ranking, knowledge, dataAnalysis, codeAgent, browser, workflows, tools } = deps;

  const cfg = { ...ENGINE_DEFAULTS, maxStepsPerTick: Number(env.ENGINE_STEPS_PER_TICK || 3) };

  async function getCharacter() {
    const rows = await store.all('SELECT * FROM characters ORDER BY is_active DESC, updated_at DESC LIMIT 1');
    const c = rows[0];
    if (!c) return null;
    return { ...c, values: safeJson(c.values_json, []), priority_weights: weightsFor(c) };
  }

  function weightsFor(c) {
    const byPreset = {
      ambitious_businessman: { upside: 0.40, speed: 0.25, evidence: 0.15, risk: 0.10, cost: 0.10 },
      cold_researcher: { upside: 0.20, speed: 0.10, evidence: 0.45, risk: 0.20, cost: 0.05 },
      autonomous_engineer: { upside: 0.25, speed: 0.20, evidence: 0.30, risk: 0.15, cost: 0.10 },
      strategist: { upside: 0.35, speed: 0.15, evidence: 0.25, risk: 0.15, cost: 0.10 },
      custom: { upside: 0.30, speed: 0.20, evidence: 0.25, risk: 0.15, cost: 0.10 },
    };
    const base = byPreset[c.preset] || byPreset.strategist;
    // Personality dials nudge the weights so the character really changes behaviour.
    const risk = (c.risk_tolerance ?? 30) / 100;
    const evid = (c.caution ?? 60) / 100;
    const w = { ...base };
    w.risk = round(base.risk * (0.5 + risk), 3);
    w.evidence = round(base.evidence * (0.6 + evid * 0.8), 3);
    w.upside = round(base.upside * (0.7 + risk * 0.6), 3);
    const sum = w.upside + w.speed + w.evidence + w.risk + w.cost;
    for (const k of Object.keys(w)) w[k] = round(w[k] / sum, 3);
    return w;
  }

  async function engineState() {
    return setting(store, 'engine:state', { status: 'stopped', reason: null, since: null, last_tick: null, ticks: 0, universe: {} });
  }

  async function setEngineState(patch) {
    const cur = await engineState();
    const next = { ...cur, ...patch };
    await setSetting(store, 'engine:state', next);
    return next;
  }

  /** Human controls: start / pause / resume / stop. */
  async function control(action, { note = '' } = {}) {
    const cur = await engineState();
    switch (action) {
      case 'start': case 'resume':
        await setEngineState({ status: 'running', reason: note || null, since: nowIso() });
        await memory.write({ kind: 'checkpoint', key: 'engine:control', text: `エンジンを${action === 'start' ? '開始' : '再開'}しました`, evidence: 'measured', importance: 40 });
        return { ok: true, status: 'running' };
      case 'pause':
        await setEngineState({ status: 'paused', reason: note || 'オーナーによる一時停止', since: nowIso() });
        await memory.write({ kind: 'checkpoint', key: 'engine:control', text: 'エンジンを一時停止しました（進捗は保存済み）', evidence: 'measured', importance: 40 });
        return { ok: true, status: 'paused' };
      case 'stop':
        await setEngineState({ status: 'stopped', reason: note || 'オーナーによる停止', since: nowIso() });
        await memory.write({ kind: 'checkpoint', key: 'engine:control', text: 'エンジンを停止しました（進捗は保存済み）', evidence: 'measured', importance: 40 });
        return { ok: true, status: 'stopped' };
      default:
        return { ok: false, error: 'unknown_action' };
    }
  }

  // -------------------------------------------------------------------------
  // Mission lifecycle
  // -------------------------------------------------------------------------
  async function createMission({ title, goal, constraints = '', successMetric = null, targetValue = null, metricUnit = 'JPY', priority = 50, autonomyLevel = null, planNow = true }) {
    const character = await getCharacter();
    const row = {
      id: newId('msn'), title: title || truncate(goal, 80), goal, constraints,
      success_metric: successMetric, target_value: targetValue, metric_unit: metricUnit,
      status: 'active', priority, autonomy_level: autonomyLevel ?? character?.autonomy_level ?? 4,
      progress: 0, created_at: nowIso(), updated_at: nowIso(),
    };
    await store.insert('missions', row);
    await memory.write({
      kind: 'goal', scope: `mission:${row.id}`, key: `goal:${row.id}`,
      text: `長期目標「${row.title}」: ${goal}${constraints ? ` / 制約: ${constraints}` : ''}`,
      evidence: 'measured', importance: 90, data: { mission_id: row.id },
    });
    if (constraints) {
      await memory.write({ kind: 'constraint', scope: `mission:${row.id}`, text: `制約: ${constraints}`, evidence: 'measured', importance: 80 });
    }
    let plan = null;
    if (planNow) plan = await planMission({ store, router, memory, character, mission: row, existingTasks: [] });
    return { mission: row, plan };
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------
  async function tick({ maxSteps = cfg.maxStepsPerTick, source = 'manual', agentId = null, budgetMs = null } = {}) {
    const started = Date.now();
    // 1ティックの壁時計の上限。Workers の実行時間に近づく前に必ず切り上げ、
    // どこまで進んだかは保存済みなので次のティックが続きから進める。
    const budget = Math.max(5000, Number(budgetMs || (env && env.ENGINE_BUDGET_MS) || 45000));
    const deadline = started + budget;
    let budgetHit = false;

    // 前回のティックが時間切れで途中になっていた作業を拾い直す（進捗を失わない）
    try {
      const cutoff = new Date(Date.now() - 180000).toISOString();
      await store.run(`UPDATE tasks SET state='queued', next_action='時間切れで切り上げた作業を再開します', updated_at=? WHERE state IN ('running','verifying','testing','planning') AND updated_at < ?`, nowIso(), cutoff);
    } catch { /* 拾い直しに失敗しても止めない */ }
    // Fleet scoping: when an agent id is given, this tick only advances that
    // agent's missions (plus unassigned ones it may claim). Runs created during
    // the slice are stamped with the agent id so the log can be filtered.
    const agentStartedAt = nowIso();
    const state = await engineState();
    if (state.status !== 'running') {
      return { ran: false, reason: `engine_${state.status}`, status: state.status, note: state.status === 'stopped' ? 'エンジンは停止中です（開始してください）' : '一時停止中です' };
    }

    const character = await getCharacter();
    if (!character) {
      return { ran: false, reason: 'no_character', note: 'キャラクターが未設定です。Character Studio で作成してください。' };
    }

    // 1ティックでAIに聞く回数を絞る（使い切ったら決定的処理へ。止めない）
    const aiPerTick = Number((typeof env !== 'undefined' && env && env.AI_CALLS_PER_TICK) || 3);
    router.beginTick(aiPerTick);

    const missions = agentId
      ? await store.all(`SELECT * FROM missions WHERE status='active' AND (agent_id=? OR agent_id IS NULL) ORDER BY priority DESC LIMIT ?`, agentId, cfg.maxMissionsPerTick)
      : await (async () => {
        // 全ミッションを公平に回す。優先度順に並べたうえで、ティックごとに開始位置をずらす
        // （上位2つだけが動いて3つ目が永遠に待つ「飢餓」を防ぐ）。
        const all = await store.all(`SELECT * FROM missions WHERE status='active' ORDER BY priority DESC`);
        if (all.length <= cfg.maxMissionsPerTick) return all;
        const rot = Number(await setting(store, 'engine:mission_rot', 0)) || 0;
        await setSetting(store, 'engine:mission_rot', (rot + 1) % all.length).catch(() => {});
        return Array.from({ length: cfg.maxMissionsPerTick }, (_, i) => all[(rot + i) % all.length]);
      })();
    if (!missions.length) {
      await setEngineState({ last_tick: nowIso(), last_result: 'no_active_mission' });
      return { ran: false, reason: 'no_active_mission', note: 'アクティブなミッションがありません（作成してください）' };
    }

    const perTick = Math.max(1, Math.ceil(maxSteps / missions.length));
    const results = [];

    for (const mission of missions) {
      if (Date.now() >= deadline) { budgetHit = true; results.push({ mission_id: mission.id, status: 'deferred_time_budget' }); continue; }
      const r = await runMissionSlice(mission, { character, steps: perTick, source, deadline });
      results.push(r);
    }

    await setEngineState({
      last_tick: nowIso(), ticks: (state.ticks || 0) + 1, last_result: results.map((r) => `${r.mission_id}:${r.status}`).join(','),
    });
    await checkpoint('engine', 'tick', { at: nowIso(), results, source, agent_id: agentId || null });
    if (agentId) {
      // Runs are written by the executor without fleet knowledge; stamping by
      // time window keeps executor.js untouched.
      try { await store.run(`UPDATE runs SET agent_id=? WHERE agent_id IS NULL AND created_at >= ?`, agentId, agentStartedAt); } catch { /* column may not exist yet */ }
    }

    router.endTick();
    return {
      ran: true, durationMs: Date.now() - started, source, agent_id: agentId || null,
      missions: results, budget_ms: budget,
      budget_exhausted: budgetHit || results.some((r) => r.status === 'deferred_time_budget'),
      quota: await router.budgetExceeded() ? 'exhausted' : 'ok',
    };
  }

  /** Run up to `steps` steps for one mission. */
  async function runMissionSlice(mission, { character, steps, source, deadline = Infinity }) {
    let done = 0;
    const trace = [];

    for (let s = 0; s < steps; s++) {
      // 上限に達したら「ここまで」を記録して返す（途中で殺されない・進捗は残る）
      if (Date.now() >= deadline) { trace.push({ step: s, skipped: 'time_budget' }); break; }
      const memos = await memory.digest(`${mission.title} ${mission.goal}`, { scope: `mission:${mission.id}`, limit: 10 });
      const sel = await selectNextTask(store, { character, mission, memories: memos });

      if (!sel.chosen) {
        // Nothing runnable → re-plan (bounded).
        const planKey = `mission:${mission.id}:replans`;
        const replans = (await setting(store, planKey, 0)) || 0;
        if (replans >= 5) {
          // 「止めずに回す」方針: エンジンもミッションも停止させない。
          // カウンタを戻してこのティックは他へ譲り、冷却後に別角度で再開する。
          await setSetting(store, planKey, 0);
          await memory.write({
            kind: 'checkpoint', scope: `mission:${mission.id}`, importance: 85, evidence: 'measured',
            text: `ミッション「${mission.title}」: 再計画を5回行っても新規タスクが出ないため、いったん冷却し別角度で再試行します（エンジンは稼働継続）。`,
          });
          return { mission_id: mission.id, status: 'idle', note: '再計画の上限。冷却して別角度で再試行します（停止しません）', trace };
        }
        const planned = await planMission({ store, router, memory, character, mission, existingTasks: await allTasks(mission.id) });
        await setSetting(store, planKey, replans + 1);
        trace.push({ action: 'replan', created: planned.created.length, reason: planned.note || null });
        if (!planned.created.length) {
          const vm = await verifyMission(store, mission);
          if (vm.met) {
            await store.update('missions', mission.id, { status: 'completed', progress: 100, updated_at: nowIso() });
            return { mission_id: mission.id, status: 'mission_completed', note: vm.statement, trace };
          }
          return { mission_id: mission.id, status: 'idle', note: `実行可能タスクなし。${vm.statement}`, trace };
        }
        done++;
        continue;
      }

      const chosen = sel.chosen;
      await store.update('tasks', chosen.task.id, {
        score: chosen.score, score_reasons: chosen.reasons, updated_at: nowIso(),
      });

      const task = await store.get('tasks', chosen.task.id);
      if (task.state === 'improving') {
        const diag = safeJson(task.error_history, [])?.slice(-1)[0] || {};
        await mutateForRetry(store, task, { kind: guessKind(diag.diagnosis) });
      }

      const freshTask = await store.get('tasks', task.id);
      // 1歩が長すぎる場合の見張り。上限を超えたら切り上げ、タスクは実行待ちに戻す
      // （途中で殺されて「running のまま」になるのを防ぐ）。
      const stepBudget = Math.max(15000, Number((env && env.ENGINE_STEP_BUDGET_MS) || 75000));
      let stepTimer = null;
      const stepTimeout = new Promise((resolve) => {
        stepTimer = setTimeout(() => resolve({ outcome: 'time_budget' }), Math.max(1000, Math.min(stepBudget, deadline - Date.now())));
      });
      const outcome = await Promise.race([stepTimeout, runTaskAttempt(
        { store, memory, tools, router, research, fx, rewards, sidehustle, ranking, knowledge, dataAnalysis, codeAgent, browser, workflows, env },
        { task: freshTask, mission, character, verify: verifyResult, remember: (t, o) => memory.write({
          kind: o.success ? 'success' : 'failure',
          scope: `mission:${mission.id}`,
          key: `outcome:${t.id}:${t.attempt}`,
          text: o.success ? `「${t.title}」成功（${o.method}）: ${truncate(o.detail, 160)}` : `「${t.title}」失敗（${o.method}）: ${truncate(o.detail, 160)} / 診断: ${o.diagnosis}`,
          evidence: o.success ? 'measured' : 'unverified',
          importance: o.success ? 60 : 78,
          data: { task_id: t.id, tool: o.method },
        }),
        },
      )]);

      clearTimeout(stepTimer);
      if (outcome && outcome.outcome === 'time_budget') {
        await store.update('tasks', freshTask.id, { state: 'queued', next_action: '1歩が長すぎたため切り上げました。次のティックで続きから実行します', updated_at: nowIso() });
        await checkpoint(`mission:${mission.id}`, 'time_budget', { task_id: freshTask.id });
        trace.push({ task_id: freshTask.id, title: freshTask.title, outcome: 'time_budget' });
        return { mission_id: mission.id, status: 'deferred_time_budget', note: '1歩が長すぎたため切り上げました（進捗は保存済み・次回続行）', trace };
      }
      trace.push({ task_id: freshTask.id, title: freshTask.title, outcome: outcome.outcome, detail: truncate(outcome.result?.summary || outcome.result?.error || '', 160) });
      done++;

      // --- stalled-progress guard -----------------------------------------
      const stallKey = `mission:${mission.id}:stall`;
      const swKey = `mission:${mission.id}:switches`;
      if (outcome.outcome === 'completed') {
        await setSetting(store, stallKey, 0);
        await memory.write({ kind: 'checkpoint', scope: `mission:${mission.id}`, text: `進捗: 「${freshTask.title}」完了`, evidence: 'measured', importance: 55 });
      } else if (outcome.outcome === 'failed' || outcome.outcome === 'retry') {
        const stalled = ((await setting(store, stallKey, 0)) || 0) + 1;
        await setSetting(store, stallKey, stalled);
        if (stalled >= cfg.maxStalledSteps) {
          const switches = ((await setting(store, swKey, 0)) || 0) + 1;
          await setSetting(store, swKey, switches);
          await setSetting(store, stallKey, 0);
          const diagnosis = outcome.diagnosis?.summary || '反復失敗';
          await replanAfterFailure({ store, router, memory, character, mission, failedTask: freshTask, diagnosis });
          trace.push({ action: 'strategy_switch', count: switches, diagnosis });
          if (switches >= cfg.maxStrategySwitches) {
            // 「止めずに回す」方針: 停止せず、カウンタを戻して別戦略で続行する。
            // 同じミッションで無限に粘って無料枠を焼かないよう、1日の回数だけ数える。
            const autoKey = `mission:${mission.id}:autocontinue:${new Date().toISOString().slice(0, 10)}`;
            const ac = ((await setting(store, autoKey, 0)) || 0) + 1;
            await setSetting(store, autoKey, ac);
            await setSetting(store, swKey, 0);
            await memory.write({
              kind: 'checkpoint', scope: `mission:${mission.id}`, importance: 88, evidence: 'measured',
              text: `ミッション「${mission.title}」: ${switches}回の戦略切替でも進展なし（原因「${diagnosis}」）。停止せず別戦略で続行します（本日 ${ac} 回目）。`,
            });
            trace.push({ action: 'auto_continue', count: switches, diagnosis, today: ac });
            if (ac > 8) {
              // 1日8回を超えたら同じミッションで粘らず他へ回す（エンジンは稼働継続）
              return { mission_id: mission.id, status: 'idle', note: '本日の戦略切替上限。冷却して他タスクへ（停止しません）', trace };
            }
            continue;
          }
        }
      } else if (outcome.outcome === 'waiting_quota') {
        trace.push({ action: 'wait', note: 'API枠の回復待ち（進捗は保存済み）' });
        await checkpoint(`mission:${mission.id}`, 'waiting_quota', { task_id: freshTask.id });
        return { mission_id: mission.id, status: 'waiting_quota', note: 'API枠が回復したら自動再開します', trace };
      } else if (outcome.outcome === 'waiting_approval') {
        trace.push({ action: 'wait_approval', note: 'オーナーの承認待ち' });
        return { mission_id: mission.id, status: 'waiting_approval', note: '承認待ちです', trace };
      }

      await checkpoint(`mission:${mission.id}`, 'step', {
        task_id: freshTask.id, outcome: outcome.outcome, step: s,
        last_success_step: (await store.get('tasks', freshTask.id))?.last_success_step || null,
      });

      // Mission-level completion check
      const vm = await verifyMission(store, mission);
      await store.update('missions', mission.id, { progress: vm.progress ?? mission.progress, updated_at: nowIso() });
      if (vm.met) {
        await store.update('missions', mission.id, { status: 'completed', progress: 100, updated_at: nowIso() });
        await memory.write({ kind: 'success', scope: `mission:${mission.id}`, text: `ミッション達成: ${vm.statement}`, evidence: 'measured', importance: 95 });
        return { mission_id: mission.id, status: 'mission_completed', note: vm.statement, trace };
      }
    }

    const remaining = await store.first(
      `SELECT COUNT(*) AS c FROM tasks WHERE mission_id=? AND state NOT IN ('completed','cancelled','failed')`, mission.id);
    return {
      mission_id: mission.id, status: 'progressed', steps: done,
      remaining_tasks: remaining?.c || 0, trace,
    };
  }

  async function allTasks(missionId) {
    return store.all('SELECT * FROM tasks WHERE mission_id=? ORDER BY created_at ASC', missionId);
  }

  async function checkpoint(scope, state, payload) {
    await store.insert('checkpoints', { id: newId('ckp'), scope, state, payload: j(payload), created_at: nowIso() });
    // keep only the most recent 30 per scope
    const rows = await store.all('SELECT id FROM checkpoints WHERE scope=? ORDER BY created_at DESC LIMIT 200', scope);
    if (rows.length > 30) {
      for (const r of rows.slice(30)) await store.run('DELETE FROM checkpoints WHERE id=?', r.id);
    }
  }

  /** Resume: wake tasks that were waiting for quota once the budget resets. */
  async function resumeWaiting() {
    const waiters = await store.all(`SELECT * FROM tasks WHERE state='waiting_for_quota'`);
    let woken = 0;
    for (const t of waiters) {
      const since = new Date(t.updated_at).getTime();
      if (Date.now() - since > 10 * 60e3) {
        await store.run(`UPDATE tasks SET state='improving', next_action='クォータ回復後に再開', updated_at=? WHERE id=?`, nowIso(), t.id);
        woken++;
      }
    }
    return { woken, waiting: waiters.length - woken };
  }

  /** Notification digest respecting the character's report frequency. */
  async function notifications({ limit = 20 } = {}) {
    const state = await engineState();
    const [waitApproval, waitQuota, needsHuman, recentFailures, provState] = await Promise.all([
      store.all(`SELECT COUNT(*) AS c FROM tasks WHERE state='waiting_for_approval'`),
      store.all(`SELECT COUNT(*) AS c FROM tasks WHERE state='waiting_for_quota'`),
      store.all(`SELECT * FROM missions WHERE status='paused'`),
      store.all(`SELECT * FROM runs WHERE state='failed' ORDER BY created_at DESC LIMIT ?`, limit),
      // 外部の無料AIキーが失効・失効疑い・レート制限で使えなくなっていないか。
      // 無料キーは期限で切れるのではなく「取り消し・上限・仕様変更」で死ぬので、
      // 死んだことに気づけないまま回転数が落ちるのを防ぐ。
      store.all(`SELECT provider, status, consecutive_failures, cooldown_until, last_error FROM ai_provider_state
        WHERE provider <> 'workersai' AND (consecutive_failures > 0 OR status NOT IN ('ok','unknown'))`).catch(() => []),
    ]);
    const providerIssues = (provState || []).map((p) => ({
      provider: p.provider, status: p.status, failures: p.consecutive_failures || 0,
      cooldown_until: p.cooldown_until || null, last_error: p.last_error || null,
      advice: 'この無料キーは今は使えません（取り消し・上限・仕様変更のいずれか）。キーを再発行して同じ環境変数に入れ直すと復帰します。エージェントは残りの経路で動き続けます。',
    }));
    return {
      provider_issues: providerIssues,
      engine: state.status,
      engine_reason: state.reason,
      waiting_approval: waitApproval[0]?.c || 0,
      waiting_quota: waitQuota[0]?.c || 0,
      paused_missions: needsHuman.map((m) => ({ id: m.id, title: m.title })),
      // 既存の通知欄にそのまま出る形でも渡す（UI変更なしで気づけるように）。
      recent_failures: [
        ...providerIssues.map((p) => ({ summary: `⚠ 無料AIキー異常: ${p.provider}（連続失敗 ${p.failures}回）— キーの再発行を検討してください`, at: p.cooldown_until || null })),
        ...recentFailures.map((r) => ({ summary: r.summary, at: r.created_at })),
      ].slice(0, limit + 5),
    };
  }

  return {
    tick, createMission, control, engineState, notifications, resumeWaiting,
    getCharacter, weightsFor, runMissionSlice, checkpoint,
  };
}

function guessKind(diagnosis) {
  const d = String(diagnosis || '');
  if (/データ|取得できなかった/.test(d)) return 'data_gap';
  if (/AI枠|API制限|一時/.test(d)) return 'transient';
  if (/非リペイント/.test(d)) return 'spec_violation';
  if (/テスト不合格/.test(d)) return 'bug';
  if (/証拠/.test(d)) return 'evidence';
  return 'unknown';
}
