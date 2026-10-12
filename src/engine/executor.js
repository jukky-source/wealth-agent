// Task selection, execution and state machine.
// States: queued planning running testing verifying improving
//         waiting_for_quota waiting_for_approval waiting_for_user
//         completed failed cancelled

import { id as newId, nowIso, j, safeJson, hash, clamp, round } from '../util.js';
import { executeTool, TOOL_META } from './tools.js';
import { recordExperience } from '../memory/memory.js';

export const TASK_STATES = [
  'queued', 'planning', 'running', 'testing', 'verifying', 'improving',
  'waiting_for_quota', 'waiting_for_approval', 'waiting_for_user',
  'completed', 'failed', 'cancelled',
];

export const TERMINAL_STATES = ['completed', 'failed', 'cancelled'];
export const ACTIVE_STATES = ['planning', 'running', 'testing', 'verifying', 'improving'];

/**
 * Opportunity score for task selection.
 * Persona weights drive the formula so character actually changes behaviour.
 */
export function scoreTask(task, { character, mission, memories = [] } = {}) {
  const w = character?.priority_weights || { upside: 0.30, speed: 0.20, evidence: 0.25, risk: 0.15, cost: 0.10 };
  const reasons = [];

  const upside = clamp((task.priority ?? 50) / 100, 0, 1);
  reasons.push(`優先度 ${Math.round(task.priority ?? 50)}`);
  const speed = task.tool_name && TOOL_META[task.tool_name] ? 0.8 : 0.4;
  reasons.push(`実行容易性 ${speed}`);

  // Evidence value: research/verification tasks build certainty.
  const evidenceBoost = { research: 0.9, verification: 1.0, analysis: 0.8, income_fx: 0.7, income_rewards: 0.7, income_sidehustle: 0.6, coding: 0.6, testing: 0.8, writing: 0.5, meta: 0.3 }[task.category] ?? 0.5;
  // Risk proxy: approval-gated tools are risky; repeated failures raise risk.
  const meta = task.tool_name ? TOOL_META[task.tool_name] : null;
  let risk = meta?.approval ? 0.9 : 0.2;
  risk = clamp(risk + (task.attempt || 0) * 0.15, 0, 1);
  reasons.push(`リスク ${round(risk, 2)}`);

  // Cost proxy: cheaper when cached/no external calls.
  const cost = ['memory_write', 'checkpoint', 'report_write', 'rank_opportunities'].includes(task.tool_name) ? 0.05 : 0.3;

  // Learning bonus: un-attempted categories with failures elsewhere get a nudge.
  const failedSameCat = memories.filter((m) => m.kind === 'strategy' && m.text.includes(task.category)).length;
  const learning = failedSameCat > 0 ? 0.05 : 0;

  const raw = upside * w.upside + speed * w.speed + evidenceBoost * w.evidence + (1 - risk) * w.risk + (1 - cost) * w.cost + learning;
  let score = raw * 100;

  // Blocked tasks must never be selected.
  const deps = safeJson(task.depends_on, []);
  if (deps.length) { score -= 25; reasons.push(`依存 ${deps.length} 件`); }
  if (task.attempt > 0) { score -= task.attempt * 4; reasons.push(`再試行${task.attempt}回`); }

  return { score: round(score, 2), reasons: reasons.join(' / ') };
}

/** Choose the next task: highest score whose dependencies are satisfied. */
export async function selectNextTask(store, { character, mission, memories = [] }) {
  const tasks = await store.all(
    `SELECT * FROM tasks WHERE mission_id=? AND state IN ('queued','improving','planning') ORDER BY priority DESC LIMIT 100`,
    mission.id);
  const done = new Set((await store.all(
    `SELECT id FROM tasks WHERE mission_id=? AND state='completed'`, mission.id)).map((r) => r.id));

  const runnable = tasks.filter((t) => {
    const deps = safeJson(t.depends_on, []);
    return deps.every((d) => done.has(d));
  });
  const blocked = tasks.filter((t) => !runnable.includes(t));

  const scored = runnable.map((t) => ({ task: t, ...scoreTask(t, { character, mission, memories }) }))
    .sort((a, b) => b.score - a.score);

  // "improving" tasks (retries) get a mild preference over brand-new ones so
  // partial work is finished before new work starts.
  const improving = scored.filter((s) => s.task.state === 'improving');
  const chosen = improving[0]?.score >= (scored[0]?.score - 5) ? improving[0] : scored[0];

  return {
    chosen: chosen || null,
    candidateCount: runnable.length,
    blockedCount: blocked.length,
    waiting: await store.all(`SELECT * FROM tasks WHERE mission_id=? AND state IN ('waiting_for_quota','waiting_for_approval','waiting_for_user')`, mission.id),
  };
}

/** Transition a task's state and log the transition. */
export async function setState(store, task, state, { summary = null, detail = null, nextAction = null, lastSuccessStep = null } = {}) {
  if (!TASK_STATES.includes(state)) throw new Error(`invalid task state: ${state}`);
  const patch = { state, updated_at: nowIso() };
  if (nextAction !== null) patch.next_action = nextAction;
  if (lastSuccessStep !== null) patch.last_success_step = lastSuccessStep;
  if (state === 'running' && !task.started_at) patch.started_at = nowIso();
  if (TERMINAL_STATES.includes(state)) patch.finished_at = nowIso();
  await store.update('tasks', task.id, patch);
  await store.insert('runs', {
    id: newId('run'), task_id: task.id, mission_id: task.mission_id, state,
    step: task.attempt || 0, summary: summary ? String(summary).slice(0, 800) : null,
    detail: detail ? j(detail) : null, created_at: nowIso(),
  });
  return { ...task, ...patch };
}

/**
 * Execute one task end-to-end (one attempt), including test/verify phases.
 * Returns a structured outcome used by the engine to decide the next move.
 */
export async function runTaskAttempt(deps, ctx) {
  const { store, memory, tools } = deps;
  let task = ctx.task;
  const character = ctx.character;

  task = await setState(store, task, 'planning', { summary: 'タスクを実行計画に展開', nextAction: `ツール ${task.tool_name || '未定'} を実行` });

  // Derive tool + args if the planner did not set them.
  let toolName = task.tool_name;
  let toolArgs = safeJson(task.tool_args, {}) || {};
  if (!toolName) {
    const derived = deriveTool(task);
    toolName = derived.tool; toolArgs = { ...derived.args, ...toolArgs };
    await store.update('tasks', task.id, { tool_name: toolName, tool_args: j(toolArgs), updated_at: nowIso() });
  }

  await store.update('tasks', task.id, { attempt: (task.attempt || 0) + 1, updated_at: nowIso() });
  task = await store.get('tasks', task.id);

  task = await setState(store, task, 'running', { summary: `実行: ${toolName}`, nextAction: '結果を検証' });

  const execCtx = { ...ctx, store, env: deps.env || ctx.env || {}, memory, task: { ...task, title: task.title } };
  const res = await executeTool(tools, execCtx, toolName, toolArgs);

  // --- approval / quota wait states ----------------------------------------
  if (res.needsApproval) {
    await setState(store, task, 'waiting_for_approval', {
      summary: res.summary || '承認待ち', detail: { approvalId: res.approvalId, action: TOOL_META[toolName]?.approval },
      nextAction: 'オーナーの承認後に再実行',
    });
    return { outcome: 'waiting_approval', task: await store.get('tasks', task.id), result: res, toolName };
  }
  if (res.error === 'daily_budget_exhausted' || /(rate[_ -]?limit|ratelimit|quota|too many requests|\b429\b|\b503\b)/i.test(res.error || '')) {
    await setState(store, task, 'waiting_for_quota', {
      summary: 'API枠の回復待ち（進捗は保存済み）', nextAction: 'クォータ回復後に続行',
    });
    return { outcome: 'waiting_quota', task: await store.get('tasks', task.id), result: res, toolName };
  }

  const hasTestPhase = ['testing'].includes(task.category) || toolName === 'code_generate';

  // --- test phase ----------------------------------------------------------
  if (hasTestPhase) {
    await setState(store, task, 'testing', { summary: 'テスト実行', nextAction: 'テスト結果を検証' });
  }

  // --- verify phase --------------------------------------------------------
  task = await setState(store, task, 'verifying', { summary: '証拠を検証中', nextAction: '検証結果に応じて完了または改善' });
  const verification = ctx.verify(task, res, { toolName });

  const evidence = {
    ok: res.ok,
    tool: toolName,
    summary: res.summary || res.error,
    basis: res.basis || 'unverified',
    evidenceUrl: res.evidence_url || (res.data?.sources?.[0]?.url) || null,
    data: res.data || null,
    verification,
  };

  if (res.ok && verification.passed) {
    task = await setState(store, task, 'completed', {
      summary: `完了: ${res.summary || task.title}`, detail: evidence,
      nextAction: '次のタスクを自動選択', lastSuccessStep: res.summary ? String(res.summary).slice(0, 200) : null,
    });
    await store.update('tasks', task.id, { result_ref: res.data ? idRef(res) : null, artifacts: j(res.artifacts || []), progress_marker: hash(JSON.stringify(evidence.data || evidence.summary)) });
    await memory.write({
      kind: 'next_action', scope: `mission:${task.mission_id}`, key: `next:${task.id}`,
      text: `「${task.title}」完了 → 次タスクは依存関係とスコアで自動選択されます。`,
      evidence: 'measured', importance: 40,
    });
    await ctx.remember(task, { success: true, method: toolName, detail: res.summary });
    return { outcome: 'completed', task: await store.get('tasks', task.id), result: res, verification, toolName };
  }

  // --- failure path --------------------------------------------------------
  const failureReason = res.ok ? (verification.reason || 'verification_failed') : (res.error || 'tool_failed');
  const diagnosis = diagnose(task, res, verification, toolName);
  const errHistory = safeJson(task.error_history, []) || [];
  errHistory.push({ at: nowIso(), error: String(failureReason).slice(0, 300), diagnosis, tool: toolName, attempt: task.attempt });

  const canRetry = (task.attempt || 1) < (task.max_attempts || 3) && diagnosis.retryable;
  await store.update('tasks', task.id, { error_history: j(errHistory), updated_at: nowIso() });

  await setState(store, task, canRetry ? 'improving' : 'failed', {
    summary: canRetry ? `改善して再試行: ${diagnosis.summary}` : `失敗: ${diagnosis.summary}`,
    detail: { ...evidence, diagnosis },
    nextAction: canRetry ? `パラメータ/条件を変更して再実行 (${task.attempt}/${task.max_attempts})` : '代替戦略に切替',
  });
  await ctx.remember(task, { success: false, method: toolName, detail: res.summary || res.error, diagnosis: diagnosis.summary });

  return {
    outcome: canRetry ? 'retry' : 'failed',
    task: await store.get('tasks', task.id), result: res, verification, diagnosis, toolName,
  };
}

function idRef(res) {
  return res.data?.backtest_id || res.data?.strategy_id || res.data?.snippet_id || res.data?.report_id || null;
}

/** Pick a sensible tool when the planner left it blank. */
export function deriveTool(task) {
  const cat = task.category || 'research';
  const map = {
    income_fx: { tool: 'fx_backtest', args: { symbol: 'USDJPY' } },
    income_rewards: { tool: 'rewards_research', args: {} },
    income_sidehustle: { tool: 'sidehustle_research', args: {} },
    research: { tool: 'deep_research', args: { question: task.title } },
    analysis: { tool: 'rank_opportunities', args: {} },
    coding: { tool: 'code_generate', args: { spec: task.description || task.title } },
    testing: { tool: 'code_test', args: {} },
    verification: { tool: 'deep_research', args: { question: `検証: ${task.title}` } },
    writing: { tool: 'report_write', args: { title: task.title, body: task.description || '' } },
    meta: { tool: 'checkpoint', args: { scope: `task:${task.id}`, state: 'saved' } },
  };
  return map[cat] || map.research;
}

/** Turn a failure into an actionable diagnosis (retryable? root cause?). */
export function diagnose(task, res, verification, toolName) {
  const err = String(res.error || verification?.reason || 'unknown');
  if (/rate|quota|429|503|budget/i.test(err)) return { summary: 'API制限/一時的障害', retryable: true, kind: 'transient' };
  if (/timeout|network|fetch|ECONN|ENOTFOUND/i.test(err)) return { summary: 'ネットワーク一時障害', retryable: true, kind: 'transient' };
  if (/no_results|no_findings|no_hits|no_candidates|no_market_data/i.test(err)) {
    return { summary: 'データが取得できなかった（検索軸/対象の見直しが必要）', retryable: true, kind: 'data_gap' };
  }
  if (/non_repaint_violation/i.test(err)) return { summary: '非リペイント違反 → 条件を修正して再生成', retryable: true, kind: 'spec_violation' };
  if (/tests_failed/i.test(err)) return { summary: 'テスト不合格 → コードを修正', retryable: true, kind: 'bug' };
  if (/approval_required/i.test(err)) return { summary: '承認が必要', retryable: false, kind: 'approval' };
  if (/validation|verification_failed/i.test(err)) return { summary: '証拠が基準を満たさない', retryable: true, kind: 'evidence' };
  return { summary: `原因未特定: ${err.slice(0, 120)}`, retryable: true, kind: 'unknown' };
}

/** Adjust a retrying task so the retry is genuinely different. */
export async function mutateForRetry(store, task, diagnosis) {
  const args = safeJson(task.tool_args, {}) || {};
  if (diagnosis.kind === 'data_gap') {
    if (task.category === 'income_rewards') args.topic = 'ポイント 高還元 換金 即日 2026';
    if (task.category === 'income_sidehustle') args.topic = '個人開発 SaaS 収益 事例';
    if (!args.query) args.query = `${task.title} 事例 実績`;
    args.limit = Math.min(10, (args.limit || 6) + 2);
  }
  if (diagnosis.kind === 'spec_violation') {
    args.overrides = { ...(args.overrides || {}), entry_on_close_only: true, lookahead: 'off' };
  }
  if (diagnosis.kind === 'evidence') {
    args.days = Math.min(2500, (args.days || 1500) + 500);
  }
  if (diagnosis.kind === 'bug' && task.category === 'coding') {
    args.spec = `${safeJson(task.tool_args, {})?.spec || task.description} / 前回のテスト失敗を踏まえ、境界条件と型を厳密に処理する`;
  }
  await store.update('tasks', task.id, {
    tool_args: j(args), updated_at: nowIso(),
    next_action: `条件を変更して再試行 (${diagnosis.kind})`,
  });
  return { ...task, tool_args: j(args) };
}
