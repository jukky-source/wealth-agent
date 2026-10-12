// Fleet (multi-agent) + image-generation settings tests.
// Self-contained: a D1-shaped adapter straight over node:sqlite, so the test
// exercises the real Store/ensureSchema code path with no mocks in between.
import { DatabaseSync } from 'node:sqlite';
import { Store, ensureSchema } from '../src/db.js';
import { createFleet, AGENT_PRESETS } from '../src/engine/fleet.js';
import { createImageGen } from '../src/ai/imagegen.js';

function d1(file = ':memory:') {
  const db = new DatabaseSync(file);
  const wrap = (sql) => ({
    all: async (...p) => ({ results: db.prepare(sql).all(...p) }),
    first: async (...p) => db.prepare(sql).get(...p) ?? null,
    run: async (...p) => db.prepare(sql).run(...p),
    bind: (...p) => ({
      all: async () => ({ results: db.prepare(sql).all(...p) }),
      first: async () => db.prepare(sql).get(...p) ?? null,
      run: async () => db.prepare(sql).run(...p),
    }),
  });
  return { exec: (sql) => db.exec(sql), prepare: wrap };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name} ${extra}`); }
};

function stubEngine({ status = 'running' } = {}) {
  let active = 0, maxActive = 0;
  const calls = [];
  return {
    calls,
    maxActive: () => maxActive,
    engineState: async () => ({ status, ticks: 0 }),
    tick: async ({ agentId, maxSteps }) => {
      active++; maxActive = Math.max(maxActive, active);
      calls.push({ agentId, maxSteps });
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { ran: true, agent_id: agentId, missions: [{ mission_id: 'msn_1', status: 'progressed', steps: 1 }] };
    },
    createMission: async ({ title, goal }) => ({ mission: { id: `msn_${Math.random().toString(36).slice(2, 8)}`, title, goal, status: 'active' }, tasks: [] }),
  };
}

const store = new Store(d1());
await ensureSchema(store);
const memory = { write: async () => {} };

// --- schema -----------------------------------------------------------------
const cols = await store.all(`SELECT name FROM pragma_table_info('runs')`);
ok('runs has agent_id column', cols.some((c) => c.name === 'agent_id'));
const mcols = await store.all(`SELECT name FROM pragma_table_info('missions')`);
ok('missions has agent_id column', mcols.some((c) => c.name === 'agent_id'));
ok('agent presets documented', Object.keys(AGENT_PRESETS).length >= 5);

// --- creation / listing ------------------------------------------------------
const engine = stubEngine();
const fleet = createFleet({ store, env: {}, engine, memory });

const a1 = (await fleet.create({ name: 'アレス', preset: 'researcher', status: 'running' })).agent;
const a2 = (await fleet.create({ preset: 'operator', status: 'running' })).agent;
const a3 = (await fleet.create({ preset: 'trader', status: 'paused' })).agent;
ok('three agents created with distinct ids', new Set([a1.id, a2.id, a3.id]).size === 3);
const listed = await fleet.list();
ok('list returns every agent', listed.length === 3);
ok('list carries task counters and specialty', listed[0].tasks && typeof listed[0].tasks.queued === 'number' && !!listed[0].specialty);
ok('preset specialty defaults from the preset', a1.specialty === AGENT_PRESETS.researcher.specialty);

// --- mission claiming --------------------------------------------------------
await store.insert('missions', {
  id: 'msn_free', title: '未割当ミッション', goal: '検証する', constraints: '', success_metric: null,
  target_value: null, metric_unit: 'JPY', status: 'active', priority: 50, autonomy_level: 4, progress: 0,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});
await store.insert('tasks', {
  id: 'tsk_free', mission_id: 'msn_free', parent_id: null, title: '未割当タスク', description: '',
  category: 'research', state: 'queued', priority: 50, score: 0, score_reasons: null, depends_on: null,
  attempt: 0, max_attempts: 3, last_success_step: null, next_action: null, tool_name: null, tool_args: null,
  result_ref: null, error_history: '[]', strategy: null, strategy_switches: 0, progress_marker: null,
  artifacts: '[]', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});
const claimed = await fleet.claimMission(a1);
ok('idle agent claims the unassigned mission', claimed === 'msn_free');
const missionRow = await store.get('missions', 'msn_free');
ok('mission is stamped with the claiming agent', missionRow.agent_id === a1.id);
const taskRow = await store.get('tasks', 'tsk_free');
ok('its tasks inherit the agent id', taskRow.agent_id === a1.id);

// --- tickAll respects status, master switch and concurrency -----------------
const r1 = await fleet.tickAll({ source: 'test', concurrency: 2, steps: 1 });
ok('tickAll ran the running agents', r1.ran === true);
ok('paused agent was skipped', !engine.calls.some((c) => c.agentId === a3.id));
ok('engine received the agent id', engine.calls.every((c) => c.agentId === a1.id || c.agentId === a2.id));
const stopped = createFleet({ store, env: {}, engine: stubEngine({ status: 'stopped' }), memory });
const r2 = await stopped.tickAll({});
ok('master engine stopped blocks the whole fleet', r2.ran === false && /engine_stopped/.test(r2.reason));

for (let i = 0; i < 4; i++) await fleet.create({ preset: 'engineer', status: 'running' });
const engine2 = stubEngine();
const fleet2 = createFleet({ store, env: {}, engine: engine2, memory });
const r3 = await fleet2.tickAll({ concurrency: 2, steps: 1 });
ok('concurrency cap is honoured', engine2.maxActive() <= 2, `max=${engine2.maxActive()}`);
ok('every running agent still got a slice', r3.agents.length === 6, `n=${r3.agents.length}`);

// --- supervisor --------------------------------------------------------------
const sup = await fleet.supervise({ spawn: 1 });
ok('supervisor assigns or spawns bounded work', sup.spawned <= 1);
ok('supervisor reports what it did', Array.isArray(sup.assigned));

// --- control / removal -------------------------------------------------------
const c = await fleet.control('start', { id: a3.id });
ok('control start resumes an agent', c.ok && c.status === 'running');
const cAll = await fleet.control('pause-all', {});
ok('pause-all parks every running agent', cAll.ok && (await fleet.list()).every((x) => x.status !== 'running'));
await fleet.remove(a2.id);
const after = await fleet.list();
ok('removed agent disappears from the list', !after.some((x) => x.id === a2.id));
ok('its missions are released, not deleted', (await store.get('missions', 'msn_free')).agent_id !== undefined);

// --- image settings ----------------------------------------------------------
const imagegen = createImageGen({ env: {}, store });
const avail = imagegen.availability();
ok('local engine is always available', avail.local === true);
ok('workersai/gemini unavailable without env', avail.workersai === false && avail.gemini === false);

const saved = await imagegen.setConfig({ engines: { workersai: false, gemini: false, local: true }, style: 'line', size: 384, quality: 0.7, prompt_suffix: '円形構図' });
ok('config saves', saved.ok === true && saved.config.size === 384);
const reloaded = await imagegen.config();
ok('config survives a reload from the database', reloaded.style === 'line' && reloaded.engines.gemini === false);
const gen = await imagegen.generate({ instruction: '落ち着いた女性アドバイザー' });
ok('generate still works with only the local engine enabled', gen.ok === true && gen.engine === 'local');
ok('saved default style is applied', gen.style === 'line');
ok('prompt suffix reaches the model prompt', /円形構図/.test(gen.prompt_used || ''));

await imagegen.setConfig({ size: 9999 });
ok('invalid size is clamped, not accepted', (await imagegen.config()).size === 384);
await imagegen.setConfig({ workers_model: 'my/custom-model' });
const opts = imagegen.options();
ok('model override is reflected in options()', opts.engines[0].model === 'my/custom-model');
ok('options exposes engine enabled flags', opts.engines.every((e) => typeof e.enabled === 'boolean'));

await imagegen.setConfig({ engines: { workersai: false, gemini: false, local: false } });
const off = await imagegen.generate({ instruction: 'だれか' });
ok('all engines off returns an actionable error', off.ok === false && off.error === 'all_engines_disabled' && !!off.hint);
const back = await imagegen.setConfig({ reset: true });
ok('reset restores the documented defaults', back.ok && back.config.engines.local === true && back.config.order[0] === 'workersai');
const usage = await store.all("SELECT * FROM ai_usage WHERE role='image'");
ok('every generation is logged as an image call', usage.length >= 1);
ok('the image log row is a role=image local call', usage.some((u) => u.role === 'image' && u.provider === 'local'));

console.log(`\n════════ fleet/image tests: ${pass} passed, ${fail} failed ════════`);
process.exit(fail ? 1 : 0);
