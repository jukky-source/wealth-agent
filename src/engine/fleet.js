// Fleet — several autonomous agents making progress at the same time.
//
// Honest engineering notes:
//  * One Worker isolate does not give us real threads; "concurrent" here means
//    each agent owns its own mission queue, budget, log and status, and one
//    tick advances a bounded slice of SEVERAL agents instead of one serial
//    queue. Progress is checkpointed after every step, so a 15-minute cron gap
//    or a closed browser tab never loses work.
//  * CPU stays bounded on purpose: FLEET_MAX_CONCURRENT agents per tick and
//    FLEET_STEPS_PER_AGENT steps each. Raise them only after watching the
//    CPU-time metric in the Cloudflare dashboard.

import { id as newId, nowIso, j, safeJson, truncate } from '../util.js';
import { setSetting, setting } from '../db.js';

export const AGENT_PRESETS = {
  strategist: { label: '戦略家', specialty: '機会の比較と資源配分', focus: ['opportunity', 'ranking'], instructions: '複数の収益機会を横断比較し、期待値と機会費用で優先順位を決める。' },
  researcher: { label: '調査役', specialty: '一次情報の収集と検証', focus: ['research', 'knowledge'], instructions: '主張は必ず出典つきで収集し、未確認は未確認と明示する。' },
  engineer: { label: '実装役', specialty: '自動化とコードの検証', focus: ['code', 'workflow'], instructions: '小さく動くものを作り、テストで確かめてから広げる。' },
  marketer: { label: '集客役', specialty: '需要の特定と発信', focus: ['research', 'content'], instructions: '誰のどの困りごとにいくら払われるかを具体的に特定する。' },
  trader: { label: '検証役', specialty: '値動き戦略の検証', focus: ['fx', 'backtest'], instructions: '過剰適合とリペイントを検査し、未検証の優位性を主張しない。' },
  operator: { label: '運用役', specialty: '収支の記録と日次運用', focus: ['ledger', 'workflow'], instructions: '実測と推定を分離して記録し、日次で振り返る。' },
};

export const AGENT_STATUS = ['idle', 'running', 'paused', 'stopped'];

export function createFleet(deps) {
  const { store, env = {}, engine, memory } = deps;

  const cfg = {
    maxConcurrent: Math.max(1, Math.min(8, Number(env.FLEET_MAX_CONCURRENT || 3))),
    stepsPerAgent: Math.max(1, Math.min(3, Number(env.FLEET_STEPS_PER_AGENT || 1))),
  };

  async function list() {
    const rows = await store.all('SELECT * FROM agents ORDER BY created_at ASC');
    const out = [];
    for (const a of rows) {
      const [missions, tasks, lastRun] = await Promise.all([
        store.all('SELECT id,title,status,progress FROM missions WHERE agent_id=? ORDER BY updated_at DESC LIMIT 5', a.id),
        store.first(`SELECT COUNT(*) AS total,
            SUM(CASE WHEN state='running' THEN 1 ELSE 0 END) AS running,
            SUM(CASE WHEN state='queued' THEN 1 ELSE 0 END) AS queued,
            SUM(CASE WHEN state='completed' THEN 1 ELSE 0 END) AS completed
          FROM tasks WHERE agent_id=?`, a.id),
        store.first('SELECT state,summary,created_at FROM runs WHERE agent_id=? ORDER BY created_at DESC LIMIT 1', a.id),
      ]);
      out.push({
        id: a.id, name: a.name, preset: a.preset, specialty: a.specialty, instructions: a.instructions,
        avatar: a.avatar, avatar_url: a.avatar_url, status: a.status, autonomy_level: a.autonomy_level,
        max_steps_per_tick: a.max_steps_per_tick, focus: safeJson(a.focus_json, []), stats: safeJson(a.stats_json, {}),
        last_run_at: a.last_run_at, last_result: a.last_result, created_at: a.created_at,
        missions: missions || [],
        tasks: { total: tasks?.total || 0, running: tasks?.running || 0, queued: tasks?.queued || 0, completed: tasks?.completed || 0 },
        last_run: lastRun || null,
      });
    }
    return out;
  }

  async function create({ name = '', preset = 'strategist', specialty = null, instructions = '', avatar = null, avatar_url = null, autonomy_level = 4, max_steps_per_tick = 2, goal = null, status = 'idle' } = {}) {
    const p = AGENT_PRESETS[preset] || AGENT_PRESETS.strategist;
    const row = {
      id: newId('agt'),
      name: String(name || '').trim().slice(0, 40) || `${p.label}${Math.floor(Math.random() * 90 + 10)}`,
      preset, specialty: specialty || p.specialty, instructions: String(instructions || p.instructions).slice(0, 400),
      avatar: String(avatar || '').replace(/\p{Extended_Pictographic}+/gu, '').trim().slice(0, 4) || null,
      avatar_url: /^data:image\//i.test(String(avatar_url || '')) ? avatar_url : null,
      status: AGENT_STATUS.includes(status) ? status : 'idle',
      autonomy_level: Number(autonomy_level) || 4,
      max_steps_per_tick: Math.max(1, Math.min(3, Number(max_steps_per_tick) || 2)),
      focus_json: j(p.focus || []), stats_json: j({ steps: 0, ticks: 0 }),
      last_run_at: null, last_result: null, created_at: nowIso(), updated_at: nowIso(),
    };
    await store.insert('agents', row);
    let mission = null;
    if (goal && String(goal).trim()) mission = await spawnMission(row, String(goal).trim());
    await memory.write({ kind: 'checkpoint', scope: `agent:${row.id}`, text: `エージェント「${row.name}」（${p.label}）を編成しました`, evidence: 'measured', importance: 40 });
    return { agent: row, mission };
  }

  async function update(id, patch = {}) {
    const a = await store.get('agents', id);
    if (!a) return { ok: false, error: 'agent_not_found' };
    const p = patch.preset ? AGENT_PRESETS[patch.preset] : null;
    const clean = {};
    if (patch.name !== undefined) clean.name = String(patch.name).slice(0, 40);
    if (patch.preset !== undefined && AGENT_PRESETS[patch.preset]) clean.preset = patch.preset;
    if (patch.specialty !== undefined) clean.specialty = String(patch.specialty).slice(0, 120);
    if (patch.instructions !== undefined) clean.instructions = String(patch.instructions).slice(0, 400);
    if (patch.avatar !== undefined) clean.avatar = String(patch.avatar).replace(/\p{Extended_Pictographic}+/gu, '').trim().slice(0, 4) || null;
    if (patch.avatar_url !== undefined) clean.avatar_url = /^data:image\//i.test(String(patch.avatar_url)) ? patch.avatar_url : null;
    if (patch.status !== undefined && AGENT_STATUS.includes(patch.status)) clean.status = patch.status;
    if (patch.autonomy_level !== undefined) clean.autonomy_level = Math.max(1, Math.min(5, Number(patch.autonomy_level) || 4));
    if (patch.max_steps_per_tick !== undefined) clean.max_steps_per_tick = Math.max(1, Math.min(3, Number(patch.max_steps_per_tick) || 2));
    if (p) clean.focus_json = j(p.focus || []);
    if (patch.goal && String(patch.goal).trim()) {
      const full = { ...a, ...clean };
      await store.update('agents', id, { ...clean, updated_at: nowIso() });
      const mission = await spawnMission(full, String(patch.goal).trim());
      return { ok: true, agent: await store.get('agents', id), mission };
    }
    await store.update('agents', id, { ...clean, updated_at: nowIso() });
    return { ok: true, agent: await store.get('agents', id) };
  }

  async function remove(id) {
    const a = await store.get('agents', id);
    if (!a) return { ok: false, error: 'agent_not_found' };
    await store.run('UPDATE missions SET agent_id=NULL, updated_at=? WHERE agent_id=?', nowIso(), id);
    await store.run('UPDATE tasks SET agent_id=NULL WHERE agent_id=?', id);
    await store.run('DELETE FROM agents WHERE id=?', id);
    await memory.write({ kind: 'checkpoint', scope: `agent:${id}`, text: `エージェント「${a.name}」を解任しました（担当ミッションは未割当に戻しました）`, evidence: 'measured', importance: 40 });
    return { ok: true, removed: a.name, released_missions: true };
  }

  /** Give the agent an unassigned mission (so nobody is idle while work waits). */
  async function claimMission(agent) {
    const mine = await store.first(`SELECT COUNT(*) AS c FROM missions WHERE agent_id=? AND status='active'`, agent.id);
    if ((mine?.c || 0) > 0) return null;
    const free = await store.first(`SELECT * FROM missions WHERE agent_id IS NULL AND status='active' ORDER BY priority DESC, created_at ASC LIMIT 1`);
    if (!free) return null;
    // Conditional update: two agents ticking at once must never end up owning
    // the same mission. The loser of the race simply tries again next cycle.
    const res = await store.run('UPDATE missions SET agent_id=?, updated_at=? WHERE id=? AND agent_id IS NULL', agent.id, nowIso(), free.id);
    const changed = res?.changes ?? res?.meta?.changes ?? 1;
    if (!changed) return null;
    await store.run('UPDATE tasks SET agent_id=? WHERE mission_id=? AND agent_id IS NULL', agent.id, free.id);
    await memory.write({ kind: 'checkpoint', scope: `agent:${agent.id}`, text: `エージェント「${agent.name}」がミッション「${free.title}」を担当します`, evidence: 'measured', importance: 45 });
    return free.id;
  }

  async function spawnMission(agent, goal) {
    const r = await engine.createMission({
      title: truncate(goal, 60), goal,
      constraints: `担当エージェント: ${agent.name}（${agent.specialty || ''}）`,
      priority: 55, planNow: true,
    });
    await store.update('missions', r.mission.id, { agent_id: agent.id, updated_at: nowIso() });
    await store.run('UPDATE tasks SET agent_id=? WHERE mission_id=?', agent.id, r.mission.id);
    return { ...r.mission, agent_id: agent.id };
  }

  async function tickAgent(agent, { source = 'fleet', steps = null } = {}) {
    const t0 = Date.now();
    let claimed = null;
    try { claimed = await claimMission(agent); } catch { /* best effort */ }
    let result;
    try {
      result = await engine.tick({ agentId: agent.id, maxSteps: steps || agent.max_steps_per_tick || cfg.stepsPerAgent, source });
    } catch (e) {
      result = { ran: false, reason: 'error', note: String(e.message || e).slice(0, 200) };
    }
    const stats = safeJson(agent.stats_json, {});
    stats.ticks = (stats.ticks || 0) + 1;
    if (result.ran) stats.steps = (stats.steps || 0) + ((result.missions || []).reduce((n, m) => n + (m.steps || 0), 0) || 0);
    stats.last = { at: nowIso(), ms: Date.now() - t0, claimed };
    const summary = result.ran
      ? ((result.missions || []).map((m) => `${m.mission_id}:${m.status}`).join(', ') || 'no_mission')
      : (result.reason || 'skipped');
    await store.update('agents', agent.id, {
      last_run_at: nowIso(), last_result: truncate(summary, 200), stats_json: j(stats), updated_at: nowIso(),
    });
    return { agent_id: agent.id, name: agent.name, ms: Date.now() - t0, claimed_mission: claimed, ...result };
  }

  /** Advance every switched-on agent, bounded by concurrency and steps. */
  async function tickAll({ source = 'fleet', concurrency = null, steps = null } = {}) {
    const master = await engine.engineState();
    const limit = Math.max(1, Math.min(8, Number(concurrency) || cfg.maxConcurrent));
    // Every switched-on agent gets a slice; `limit` only bounds how many run at
    // the same time, never how many are served in one cycle.
    const agents = await store.all(`SELECT * FROM agents WHERE status='running' ORDER BY created_at ASC`);
    if (master.status !== 'running') {
      return { ran: false, reason: `engine_${master.status}`, note: 'エンジン本体が停止中のため、エージェントも進みません（「エンジン開始」で再開します）。', agents: [] };
    }
    if (!agents.length) return { ran: false, reason: 'no_running_agent', note: '稼働中のエージェントがいません。', agents: [] };

    const queue = [...agents];
    const results = [];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const a = queue.shift();
        results.push(await tickAgent(a, { source, steps }));
      }
    });
    await Promise.all(workers);
    await setSetting(store, 'fleet:last_run', { at: nowIso(), source, agents: results.map((r) => ({ id: r.agent_id, ran: !!r.ran, reason: r.reason || null })) });
    return { ran: true, source, concurrency: workers.length, agents: results };
  }

  /** Supervisor: keep idle agents busy without inventing infinite work. */
  async function supervise({ spawn = 1 } = {}) {
    const agents = await store.all(`SELECT * FROM agents WHERE status='running' ORDER BY created_at ASC`);
    const assigned = [];
    for (const a of agents) {
      const claimed = await claimMission(a);
      if (claimed) assigned.push({ agent_id: a.id, claimed_mission: claimed });
    }
    let spawned = 0;
    if (spawn > 0) {
      for (const a of agents) {
        if (spawned >= spawn) break;
        const mine = await store.first(`SELECT COUNT(*) AS c FROM missions WHERE agent_id=? AND status='active'`, a.id);
        if ((mine?.c || 0) > 0) continue;
        const p = AGENT_PRESETS[a.preset] || AGENT_PRESETS.strategist;
        const goal = `${a.instructions || p.instructions}（担当: ${a.specialty || p.specialty}）`;
        const m = await spawnMission(a, goal);
        spawned++;
        assigned.push({ agent_id: a.id, spawned_mission: m.id });
      }
    }
    return { ok: true, assigned, spawned };
  }

  async function control(action, { id = null } = {}) {
    const now = nowIso();
    if (action === 'start-all') { await store.run(`UPDATE agents SET status='running', updated_at=? WHERE status IN ('idle','paused','stopped')`, now); return { ok: true, status: 'running' }; }
    if (action === 'pause-all') { await store.run(`UPDATE agents SET status='paused', updated_at=? WHERE status='running'`, now); return { ok: true, status: 'paused' }; }
    if (!id) return { ok: false, error: 'agent_id_required' };
    const a = await store.get('agents', id);
    if (!a) return { ok: false, error: 'agent_not_found' };
    const map = { start: 'running', resume: 'running', pause: 'paused', stop: 'stopped', idle: 'idle' };
    if (!map[action]) return { ok: false, error: 'unknown_action', allowed: Object.keys(map) };
    await store.update('agents', id, { status: map[action], updated_at: now });
    if (action === 'start' || action === 'resume') return { ok: true, status: 'running', tick: await tickAgent(await store.get('agents', id), { source: 'control' }) };
    return { ok: true, status: map[action] };
  }

  /** Three-agent starter crew — the fastest way to see the fleet move. */
  async function bootstrap() {
    const existing = await store.first('SELECT COUNT(*) AS c FROM agents');
    if ((existing?.c || 0) > 0) return { ok: true, created: [], note: '既にエージェントが存在します' };
    const created = [];
    for (const preset of ['strategist', 'researcher', 'operator']) {
      const r = await create({ preset, status: 'idle' });
      created.push(r.agent);
    }
    await setSetting(store, 'fleet:bootstrapped', nowIso());
    return { ok: true, created };
  }

  async function status() {
    const master = await engine.engineState();
    const rows = await store.all('SELECT status FROM agents');
    const counts = { total: rows.length };
    for (const s of AGENT_STATUS) counts[s] = rows.filter((r) => r.status === s).length;
    const hour = await store.first(`SELECT COUNT(*) AS c FROM runs WHERE created_at >= ?`, new Date(Date.now() - 3600e3).toISOString());
    const last = await setting(store, 'fleet:last_run', null);
    return {
      master: master.status, counts, runs_last_hour: hour?.c || 0,
      concurrency: cfg.maxConcurrent, steps_per_agent: cfg.stepsPerAgent, last_run: last,
    };
  }

  return { list, create, update, remove, tickAgent, tickAll, supervise, control, bootstrap, status, claimMission, spawnMission, AGENT_PRESETS, cfg };
}
