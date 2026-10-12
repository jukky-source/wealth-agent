// Workflow Automation — declarative multi-step workflows with conditions,
// retries, error handling, schedules and full execution logs.
//
// definition = {
//   steps: [
//     { id, tool, args, if?: "<expr>", retries?: n, onError?: "continue|fail|retry" },
//     { id, type: "condition", expr, then: "stepId", else: "stepId" },
//     { id, type: "delay", ms }
//   ],
//   schedule?: "*/30 * * * *"   // recorded for the scheduler; honoured by cron ticks
// }

import { id as newId, nowIso, j, safeJson, truncate, hash } from '../util.js';
import { executeTool } from '../engine/tools.js';

export function createWorkflows({ store, tools, memory }) {
  async function save({ id: wid = null, name, definition, enabled = true }) {
    const def = typeof definition === 'string' ? definition : j(definition);
    const parsed = safeJson(def, null);
    if (!parsed?.steps?.length) throw new Error('definition.steps が必要です');
    const row = {
      id: wid || newId('wfl'), name, definition: def, enabled: enabled ? 1 : 0,
      created_at: nowIso(), updated_at: nowIso(),
    };
    if (wid && await store.get('workflows', wid)) await store.update('workflows', wid, { ...row, created_at: undefined });
    else await store.insert('workflows', row);
    return row;
  }

  async function list() {
    const rows = await store.all('SELECT * FROM workflows ORDER BY created_at DESC');
    return rows.map((r) => ({ ...r, definition: safeJson(r.definition, {}) }));
  }

  async function run(workflowId, { context = {}, maxSteps = 25 } = {}) {
    const wf = await store.get('workflows', workflowId);
    if (!wf) return { ok: false, error: 'workflow_not_found' };
    const def = safeJson(wf.definition, {});
    const runId = newId('wfr');
    const log = [];
    const ctx = { vars: { ...context }, store };
    let cursor = 0;
    let status = 'completed';

    await store.insert('workflow_runs', {
      id: runId, workflow_id: workflowId, status: 'running', cursor: 0,
      context: j(context), log_json: j([]), created_at: nowIso(), updated_at: nowIso(),
    });

    const stepMap = {};
    def.steps.forEach((s, i) => { if (s.id) stepMap[s.id] = i; });

    let steps = 0;
    while (cursor < def.steps.length && steps < maxSteps) {
      const step = def.steps[cursor];
      steps++;
      const entry = { at: nowIso(), index: cursor, id: step.id || `step${cursor}`, type: step.type || 'tool', tool: step.tool || null };

      // condition gate
      if (step.if && !evalExpr(step.if, ctx)) {
        entry.skipped = `if(${step.if}) == false`;
        log.push(entry);
        cursor++;
        continue;
      }

      if (step.type === 'condition') {
        const branch = evalExpr(step.expr, ctx) ? step.then : step.else;
        entry.branch = branch;
        log.push(entry);
        cursor = (branch && stepMap[branch] !== undefined) ? stepMap[branch] : cursor + 1;
        continue;
      }
      if (step.type === 'delay') {
        const ms = Math.min(20000, Number(step.ms) || 1000);
        await new Promise((r) => setTimeout(r, ms));
        entry.waitedMs = ms;
        log.push(entry);
        cursor++;
        continue;
      }

      // tool step with retry / onError policy
      const retries = Math.min(5, Number(step.retries) || 0);
      let attempt = 0; let res = null;
      const args = resolveArgs(step.args || {}, ctx);
      while (attempt <= retries) {
        attempt++;
        res = await executeTool(tools, {
          store, env: ctx.env || {}, task: { id: `wfl:${runId}`, title: entry.id, mission_id: null }, memory,
        }, step.tool, args);
        if (res.ok) break;
        if (attempt <= retries) await new Promise((r) => setTimeout(r, 400 * attempt));
      }
      entry.attempts = attempt;
      entry.ok = !!res?.ok;
      entry.summary = truncate(res?.summary || res?.error || '', 300);
      if (step.output) ctx.vars[step.output] = res?.data ?? res?.summary ?? null;
      log.push(entry);

      if (!res?.ok) {
        const policy = step.onError || 'fail';
        if (policy === 'continue') { cursor++; continue; }
        if (policy === 'goto' && step.goto && stepMap[step.goto] !== undefined) { cursor = stepMap[step.goto]; continue; }
        status = 'failed';
        break;
      }
      cursor++;
    }

    if (steps >= maxSteps) status = 'step_limit_reached';
    await store.run('UPDATE workflow_runs SET status=?, cursor=?, context=?, log_json=?, updated_at=? WHERE id=?',
      status, cursor, j(ctx.vars), j(log), nowIso(), runId);
    await memory.write({
      kind: 'experience', key: `workflow:${workflowId}:${hash(j(log))}`,
      text: `ワークフロー「${wf.name}」実行: ${status}（${log.length}ステップ）`, evidence: 'measured', importance: 45,
    });
    return { ok: status === 'completed', runId, status, steps: log.length, log, vars: ctx.vars };
  }

  async function runs(workflowId = null, limit = 20) {
    const rows = workflowId
      ? await store.all('SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY created_at DESC LIMIT ?', workflowId, limit)
      : await store.all('SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map((r) => ({ ...r, log: safeJson(r.log_json, []), context: safeJson(r.context, {}) }));
  }

  return { save, list, run, runs };
}

/** Safe expression evaluation: a tiny whitelist, never eval(). */
export function evalExpr(expr, ctx) {
  const src = String(expr || '').trim();
  if (!src) return false;
  const m = src.match(/^([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (m) {
    const left = getPath(ctx.vars, m[1]);
    let right = m[3].trim().replace(/^['"]|['"]$/g, '');
    if (/^-?\d+(\.\d+)?$/.test(right)) right = Number(right);
    else if (right === 'true') right = true;
    else if (right === 'false') right = false;
    switch (m[2]) {
      case '==': return String(left) === String(right);
      case '!=': return String(left) !== String(right);
      case '>': return Number(left) > Number(right);
      case '<': return Number(left) < Number(right);
      case '>=': return Number(left) >= Number(right);
      case '<=': return Number(left) <= Number(right);
    }
  }
  const t = src.match(/^(!)?([\w.]+)$/);
  if (t) {
    const v = getPath(ctx.vars, t[2]);
    return t[1] ? !truthy(v) : truthy(v);
  }
  return false;
}

function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '' || v === 'false') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

/** Resolve {{var}} placeholders in step args. */
export function resolveArgs(args, ctx) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && /^\{\{[\w.]+\}\}$/.test(v)) out[k] = getPath(ctx.vars, v.slice(2, -2));
    else if (typeof v === 'string') out[k] = v.replace(/\{\{([\w.]+)\}\}/g, (_, p) => {
      const val = getPath(ctx.vars, p);
      return val === undefined || val === null ? '' : (typeof val === 'object' ? JSON.stringify(val) : String(val));
    });
    else out[k] = v;
  }
  return out;
}

/** Built-in starter workflows offered in the UI. */
export const STARTER_WORKFLOWS = [
  {
    name: '毎日の収益ポートフォリオ点検',
    definition: {
      schedule: '0 22 * * *',
      steps: [
        { id: 'rank', tool: 'rank_opportunities', args: {}, output: 'ranking' },
        { id: 'research', tool: 'deep_research', args: { question: '今週の収益機会の変化と新しい選択肢' }, output: 'research', onError: 'continue' },
        { id: 'report', tool: 'report_write', args: { title: '日次ポートフォリオ点検', body: 'ランキングと調査結果を統合' }, onError: 'continue' },
      ],
    },
  },
  {
    name: 'FX戦略の検証パイプライン',
    definition: {
      steps: [
        { id: 'data', tool: 'fx_market_data', args: { symbol: 'USDJPY', days: 1500 }, output: 'md' },
        { id: 'gen', tool: 'fx_generate_strategy', args: { symbol: 'USDJPY' }, output: 'strategy' },
        { id: 'lint', tool: 'fx_lint_pine', args: {}, output: 'lint', onError: 'continue' },
        { id: 'decide', type: 'condition', expr: 'lint.nonRepaint == true', then: 'bt', else: 'replan' },
        { id: 'bt', tool: 'fx_backtest', args: { symbol: 'USDJPY' }, output: 'bt', onError: 'continue' },
        { id: 'replan', tool: 'memory_write', args: { kind: 'failure', text: '非リペイント検査に失敗したため再生成が必要' }, onError: 'continue' },
      ],
    },
  },
];
