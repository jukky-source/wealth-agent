// Acceptance tests A–L against the REAL Worker code + a real SQLite database.
// Network is stubbed so the suite is deterministic and offline.
//
//   node tests/run.mjs
//
// Each test names the acceptance criterion from the brief it verifies.

import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Shim } from '../server/sqlite-d1.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT, '.local-data', `test-${Date.now()}.sqlite`);

// ---------------------------------------------------------------------------
// Network stub — deterministic, offline
// ---------------------------------------------------------------------------
function html(body, status = 200) { return new Response(body, { status, headers: { 'content-type': 'text/html' } }); }
function jr(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }); }

function ddgHtml(n = 6) {
  return Array.from({ length: n }, (_, i) => `
    <div class="result">
      <a class="result__a" href="https://source${i}.example.jp/article/${i}">出典${i}: 収益サービスの条件まとめ</a>
      <a class="result__snippet">最低換金額は1000ポイント、換金手数料は無料。日本国内から利用可能。2026年時点の情報。</a>
    </div>`).join('');
}

const DDG = ddgHtml();
const SOURCE_PAGE = `<html><head><title>出典ページ: 換金条件のまとめ</title></head><body><h1>換金条件</h1>${
  '<p>最低換金額は1000ポイント、換金手数料は無料で、日本国内から利用可能です。2026年時点で実際に換金できたという第三者報告があります。条件は公式規約に明記されています。</p>'.repeat(8)
}</body></html>`;

function yahooPayload(n = 1600) {
  let x = 12345; const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const ts = []; const open = []; const high = []; const low = []; const close = [];
  let price = 145;
  const start = Math.floor(new Date('2019-06-01T00:00:00Z').getTime() / 1000);
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 75) * 0.05;
    const o = price;
    price = price + (rnd() - 0.5) * 1.1 + drift;
    ts.push(start + i * 86400);
    open.push(+o.toFixed(3));
    close.push(+price.toFixed(3));
    high.push(+(Math.max(o, price) + rnd() * 0.25).toFixed(3));
    low.push(+(Math.min(o, price) - rnd() * 0.25).toFixed(3));
  }
  return { chart: { result: [{ meta: { symbol: 'JPY=X' }, timestamp: ts, indicators: { quote: [{ open, high, low, close }] } }] } };
}
const YAHOO = yahooPayload();

let fetchCount = 0;
globalThis.fetch = async (url, init) => {
  fetchCount++;
  const u = String(url);
  if (u.includes('duckduckgo.com')) return html(DDG);
  if (u.includes('.example.jp')) return html(SOURCE_PAGE);
  if (u.includes('wikipedia.org')) return jr({ query: { search: [{ title: 'Reward program', snippet: 'A reward program pays points.' }] } });
  if (u.includes('frankfurter')) return jr({ base: 'USD', rates: { '2024-01-02': { JPY: 142.1 }, '2024-01-03': { JPY: 143.0 } } });
  if (u.includes('finance.yahoo.com')) return jr(YAHOO);
  if (u.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
  if (u.includes('generativelanguage.googleapis.com') || u.includes('api.groq.com') || u.includes('openrouter.ai')) {
    return jr({ error: 'should not be called — no key configured' }, 400);
  }
  return new Response('not found', { status: 404 });
};

// ---------------------------------------------------------------------------
// Boot the worker with a fresh DB
// ---------------------------------------------------------------------------
mkdirSync(path.dirname(DB_FILE), { recursive: true });
if (existsSync(DB_FILE)) rmSync(DB_FILE, { force: true });
const env = {
  DB: new D1Shim(DB_FILE),
  ASSETS: null,
  RUNTIME: 'node-test',
  AGENT_NAME: 'Wealth Agent',
  ENGINE_STEPS_PER_TICK: '3',
  AI_DAILY_CALL_BUDGET: '300',
  ALLOW_PAID_AI: 'false',
  OWNER_TOKEN: '',
  GEMINI_API_KEY: '',
  GROQ_API_KEY: '',
  OPENROUTER_API_KEY: '',
  SEARCH_ENDPOINT: '',
};

const worker = (await import('../src/index.js')).default;

async function call(pathname, method = 'GET', body = null, overrideEnv = null) {
  const e = overrideEnv || env;
  const req = new Request(`https://agent.test${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, e, { waitUntil: () => {}, passThroughOnException: () => {} });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let pass = 0; const failures = [];
const results = [];
async function test(id, title, fn) {
  try {
    await fn();
    pass++;
    results.push({ id, title, ok: true });
    console.log(`  ✓ [${id}] ${title}`);
  } catch (e) {
    failures.push({ id, title, error: e.message });
    results.push({ id, title, ok: false, error: e.message });
    console.log(`  ✗ [${id}] ${title}\n      ${e.message}`);
  }
}

console.log('\n════════ ACCEPTANCE TESTS (A–L) ════════\n');

// ---------------------------------------------------------------------------
// Seed first
// ---------------------------------------------------------------------------
const seeded = await call('/api/admin/seed', 'POST', {});
console.log(`seed: ok=${seeded.json?.ok} character=${seeded.json?.character_created} workflows=${seeded.json?.workflows?.length} tasks=${seeded.json?.plan?.created?.length || 0}\n`);

// ===========================================================================
await test('A', 'キャラクター設定を保存し、再読み込み後も保持される', async () => {
  const save = await call('/api/character', 'POST', {
    character: {
      preset: 'cold_researcher', name: 'リリス', avatar: '🔬',
      description: 'データと証拠を重視する研究者', personality: '実証主義', tone: '淡々と事実を述べる',
      values: ['証拠', '再現性'], strengths: '検証設計', weaknesses: '意思決定の遅さ',
      creativity: 40, caution: 90, risk_tolerance: 15, report_frequency: 'hourly',
      autonomy_level: 4, long_term_goals: '月3万円の実測収益', prohibitions: '推定を実績として報告しない',
    },
  });
  assert.equal(save.json.ok, true, 'save must succeed');
  // Re-read through a separate request (fresh read path)
  const reload = await call('/api/character');
  const c = reload.json.character;
  assert.equal(c.name, 'リリス');
  assert.equal(c.preset, 'cold_researcher');
  assert.equal(c.caution, 90);
  assert.equal(c.report_frequency, 'hourly');
  assert.deepEqual(c.values, ['証拠', '再現性']);
  // Persistence of the priority weights derived from the persona
  const dash = await call('/api/dashboard');
  assert.ok(dash.json.character.weights.evidence > dash.json.character.weights.speed,
    'a cautious researcher must weight evidence above speed');
});

// ===========================================================================
await test('B', 'ミッションを登録すると自動で複数タスクに分割される', async () => {
  const r = await call('/api/missions', 'POST', {
    goal: '毎月3万円の追加収益を目指して、利用可能な方法を探索し実行し改善し続けて',
    constraints: '元手ゼロ、多重アカウント禁止', target_value: 30000, metric_unit: 'JPY',
  });
  assert.equal(r.json.ok, true);
  const tasks = r.json.tasks;
  assert.ok(tasks.length >= 4, `expected >=4 tasks, got ${tasks.length}`);
  const domains = new Set(r.json.categories || []);
  assert.ok(domains.has('fx'), 'FX domain should be recognised');
  assert.ok(domains.has('rewards'), 'rewards domain should be recognised');
  assert.ok(domains.has('side_hustle'), 'side hustle domain should be recognised');
  // All tasks persisted with the documented initial state
  const list = await call('/api/tasks?limit=200');
  const mine = list.json.tasks.filter((t) => t.mission_id === r.json.mission.id);
  assert.equal(mine.length, tasks.length);
  assert.ok(mine.every((t) => t.state === 'queued'), 'new tasks start queued');
  globalThis.__MISSION_ID = r.json.mission.id;
});

// ===========================================================================
await test('C', 'タスク完了後、次のタスクが自動選択される', async () => {
  // Engine must be running for ticks to act
  await call('/api/engine/start', 'POST', {});
  const before = await call('/api/dashboard');
  assert.ok(before.json.next_task, 'a next task must be selected with a reason');
  assert.ok(before.json.next_task.reasons && before.json.next_task.reasons.length > 0, 'selection reason required');

  const tick = await call('/api/engine/tick', 'POST', { steps: 3 });
  assert.equal(tick.json.ran, true, 'the engine must run a tick');

  const after = await call('/api/dashboard');
  const progressed = after.json.completed_tasks.length + after.json.running_tasks.length
    + after.json.queued_tasks.length;
  assert.ok(progressed > 0);
  // The engine logged the selection + outcome
  const logs = await call('/api/logs?limit=50');
  assert.ok((logs.json.runs || []).length > 0, 'runs must be logged');
  const states = new Set((logs.json.runs || []).map((r) => r.state));
  assert.ok([...states].some((s) => ['running', 'completed', 'verifying', 'planning', 'improving', 'failed'].includes(s)),
    `expected a workflow state in logs, got ${[...states].join(',')}`);
  // The dashboard always exposes the NEXT task (or an explicit reason it cannot)
  assert.ok(after.json.next_task || after.json.queued_tasks.length === 0);
});

// ===========================================================================
await test('D', 'テスト失敗時、ログを保存し修正または別の計画を試みる', async () => {
  const { Store } = await import('../src/db.js');
  const { runTaskAttempt, mutateForRetry } = await import('../src/engine/executor.js');
  const { verifyResult } = await import('../src/engine/verifier.js');
  const { diagnose } = await import('../src/engine/executor.js');
  const { replanAfterFailure } = await import('../src/engine/planner.js');
  const { Memory } = await import('../src/memory/memory.js');
  const { buildTools } = await import('../src/engine/tools.js');
  const { AIRouter } = await import('../src/ai/router.js');
  const { createResearch } = await import('../src/research/web.js');
  const { createRewards } = await import('../src/income/rewards.js');
  const { createSideHustle } = await import('../src/income/sidehustle.js');
  const { createRanking } = await import('../src/income/ranking.js');

  const store = new Store(env.DB);
  const memory = new Memory(store);
  const router = new AIRouter(store, env);
  const research = createResearch(env);
  const rewards = createRewards({ store, router, research, memory });
  const sidehustle = createSideHustle({ store, router, research, memory });
  const ranking = createRanking({ store, memory });
  // A deterministic failing dependency: the FX module always reports no data.
  const fxStub = {
    runBacktestForStrategy: async () => ({ ok: false, error: 'no_market_data', summary: 'stub: no data available' }),
    fetchMarketData: async () => ({ bars: [], source: null }),
    generateStrategy: async () => null,
    lintPine: () => ({ nonRepaint: true, violations: [], checksRun: 0 }),
    improveStrategy: async () => ({ ok: false, error: 'stub' }),
  };
  const tools = buildTools({ store, env, router, memory, research, fx: fxStub, rewards, sidehustle, ranking, knowledge: null, dataAnalysis: null, codeAgent: null, browser: null });

  // A task that is guaranteed to fail: fx_backtest with no strategy present.
  const now = new Date().toISOString();
  const task = {
    id: 'tsk_failtest', mission_id: globalThis.__MISSION_ID, parent_id: null,
    title: 'FX戦略のバックテスト', description: '失敗経路の検証', category: 'income_fx',
    state: 'queued', priority: 80, score: 0, depends_on: '[]', attempt: 0, max_attempts: 2,
    tool_name: 'fx_backtest', tool_args: '{}', error_history: '[]', strategy_switches: 0,
    artifacts: '[]', created_at: now, updated_at: now,
  };
  await store.insert('tasks', task);
  const mission = await store.get('missions', globalThis.__MISSION_ID);
  const character = await store.first('SELECT * FROM characters WHERE is_active=1');

  const out1 = await runTaskAttempt(
    { store, memory, tools, env },
    {
      task: await store.get('tasks', task.id), mission, character,
      verify: verifyResult,
      remember: (t, o) => memory.write({ kind: o.success ? 'success' : 'failure', scope: `mission:${mission.id}`, key: `outcome:${t.id}:${t.attempt}`, text: `「${t.title}」${o.success ? '成功' : '失敗'}: ${o.detail || ''}`, evidence: o.success ? 'measured' : 'unverified', importance: 70 }),
    },
  );
  assert.equal(out1.outcome, 'retry', `first failure should schedule a retry, got ${out1.outcome}`);
  assert.ok(out1.diagnosis?.summary, 'a diagnosis must be produced');
  const t1 = await store.get('tasks', task.id);
  assert.equal(t1.state, 'improving');
  const hist = JSON.parse(t1.error_history);
  assert.equal(hist.length, 1, 'error history must be recorded');
  assert.ok(hist[0].diagnosis && hist[0].error, 'history entries need error + diagnosis');

  // Retry mutates the task so it is genuinely different
  await mutateForRetry(store, t1, out1.diagnosis);
  const mutated = await store.get('tasks', task.id);
  assert.notEqual(mutated.tool_args, '{}', 'retry must change the parameters');

  // Exhaust the attempts → failed → alternative strategy is planned
  await store.update('tasks', task.id, { attempt: 2 });
  const out2 = await runTaskAttempt(
    { store, memory, tools, env },
    {
      task: await store.get('tasks', task.id), mission, character, verify: verifyResult,
      remember: async () => {},
    },
  );
  assert.equal(out2.outcome, 'failed', 'exhausted attempts must fail');
  const failLog = await call(`/api/tasks/${task.id}`);
  assert.ok(failLog.json.runs.some((r) => ['failed', 'improving'].includes(r.state)), 'failure must be logged');

  const alt = await replanAfterFailure({ store, router, memory, character, mission, failedTask: await store.get('tasks', task.id), diagnosis: out2.diagnosis.summary });
  assert.ok(alt.length >= 1, 'a replacement task must be created');
  const altTool = alt[0].tool_name;
  assert.notEqual(altTool, 'fx_backtest', `alternative strategy must differ from the failed tool (got ${altTool})`);
  // The failure must be durably recorded so the next plan can avoid it
  const memRows = await store.all(`SELECT * FROM memories WHERE kind IN ('strategy','failure') ORDER BY created_at DESC LIMIT 50`);
  assert.ok(memRows.some((m) => m.text.includes('FX戦略のバックテスト')),
    `the failed strategy must enter long-term memory (found ${memRows.length} strategy/failure entries)`);
  const byKinds = await memory.byKinds(['strategy', 'failure'], `mission:${mission.id}`, 20);
  assert.ok(byKinds.length > 0, 'byKinds must return failure guardrails for the planner');
});

// ===========================================================================
await test('E', '実行を途中で停止し、再開すると最後のチェックポイントから続行できる', async () => {
  await call('/api/engine/tick', 'POST', { steps: 2 });
  const ckptsBefore = await call('/api/checkpoints');
  assert.ok((ckptsBefore.json.checkpoints || []).length > 0, 'checkpoints must be written during a tick');

  const stop = await call('/api/engine/stop', 'POST', {});
  assert.equal(stop.json.status, 'stopped');
  const stateStopped = await call('/api/engine');
  assert.equal(stateStopped.json.status, 'stopped');

  // A stopped engine must not run
  const blocked = await call('/api/engine/tick', 'POST', { steps: 2 });
  assert.equal(blocked.json.ran, false);
  assert.equal(blocked.json.reason, 'engine_stopped');

  // Task state survives the pause (nothing is lost)
  const tasksBefore = await call('/api/tasks?limit=200');
  const inFlight = tasksBefore.json.tasks.filter((t) => t.state === 'improving');

  const start = await call('/api/engine/start', 'POST', {});
  assert.equal(start.json.status, 'running');
  const resumed = await call('/api/engine/tick', 'POST', { steps: 2 });
  assert.equal(resumed.json.ran, true, 'the engine must resume after start');

  // The previously in-flight tasks are still present with their history
  const tasksAfter = await call('/api/tasks?limit=200');
  for (const t of inFlight) {
    const still = tasksAfter.json.tasks.find((x) => x.id === t.id);
    assert.ok(still, `task ${t.id} must survive pause/resume`);
    assert.ok(still.attempt >= t.attempt, 'attempt counters must be preserved, never reset');
  }
  // Resume point is the latest checkpoint
  const ckpts = await call('/api/checkpoints');
  const scopes = new Set((ckpts.json.checkpoints || []).map((c) => c.scope));
  assert.ok([...scopes].some((s) => s.startsWith('mission:')), 'mission checkpoints must exist for resume');
});

// ===========================================================================
await test('F', 'APIエラー発生時、無限ループにならずリトライ・切替・待機のいずれかが実行される', async () => {
  const { Store } = await import('../src/db.js');
  const { AIRouter } = await import('../src/ai/router.js');
  const { Memory } = await import('../src/memory/memory.js');
  const store = new Store(env.DB);
  const memory = new Memory(store);
  const router = new AIRouter(store, { ...env, GEMINI_API_KEY: 'test-key-123' });

  const realFetch = globalThis.fetch;
  let calls = 0;
  let mode = '429';
  globalThis.fetch = async (url) => {
    calls++;
    if (mode === '429') return new Response('rate limited', { status: 429 });
    if (mode === '503') return new Response('unavailable', { status: 503 });
    if (mode === '401') return new Response('bad key', { status: 401 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
  // 429 then success → retries with backoff, then succeeds; bounded call count
  mode = '429';
  const calls429 = calls;
  const r1 = await router.complete({ role: 'chat', system: 's', user: 'u', json: true, schema: ['ok'] });
  assert.equal(r1.ok, true, 'must resolve, never throw or loop');
  assert.ok(r1.fallback === true, 'after exhausting retries it must fall back');
  assert.equal(r1.ok && r1.provider, 'deterministic');
  assert.ok(calls - calls429 <= 4, `call count must stay bounded (was ${calls - calls429})`);
  assert.ok(r1.wait_until, 'a wait_until must be provided so the task can be parked');
  assert.ok(r1.note);

  // Provider state records the rate limit
  const st = await store.first(`SELECT * FROM ai_provider_state WHERE provider='gemini'`);
  assert.equal(st.status, 'rate_limited');
  assert.ok(st.cooldown_until, 'a cooldown must be set (no hammering)');

  // 401 (permanent) → immediate failover, no repeated attempts
  mode = '401';
  calls = 0;
  const r2 = await router.complete({ role: 'chat', system: 's', user: 'u' });
  assert.equal(r2.ok, true);
  assert.ok(calls <= 2, `permanent errors must not be retried (calls=${calls})`);

  // Recovery: a working provider succeeds again
  mode = 'ok';
  const r3 = await router.complete({ role: 'chat', system: 's', user: 'u' });
  assert.equal(r3.ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }

  // Usage is logged for every call so the free tier can be managed
  const usage = await call('/api/logs?limit=50');
  assert.ok(usage.json.ai_usage.length > 0, 'AI usage must be logged');
  assert.ok(usage.json.ai_usage.every((u) => u.provider), 'every usage row names a provider');
});

// ===========================================================================
await test('G', 'APIキーがブラウザーや公開リポジトリに露出しない', async () => {
  const SECRET = 'sk-super-secret-do-not-leak-9f3a';
  const envWithKey = { ...env, GEMINI_API_KEY: SECRET, GROQ_API_KEY: SECRET, OWNER_TOKEN: 'owner-token-xyz' };

  const p = await call('/api/providers?token=owner-token-xyz', 'GET', null, envWithKey);
  assert.equal(p.status, 200, 'a valid token must be accepted');
  assert.equal(p.text.includes(SECRET), false, '/api/providers must never return the key');
  assert.equal(p.json.env.secrets_present.GEMINI_API_KEY, true, 'presence flag must be true');

  const s = await call('/api/settings?token=owner-token-xyz', 'GET', null, envWithKey);
  assert.equal(s.text.includes(SECRET), false, '/api/settings must never return the key');

  const d = await call('/api/dashboard?token=owner-token-xyz', 'GET', null, envWithKey);
  assert.equal(d.text.includes(SECRET), false, '/api/dashboard must never return the key');

  // Authentication is enforced when a token is configured
  const unauth = await call('/api/dashboard', 'GET', null, envWithKey);
  assert.equal(unauth.status, 401, 'requests without a token must be rejected');
  const authed = await call('/api/dashboard?token=owner-token-xyz', 'GET', null, envWithKey);
  assert.equal(authed.status, 200, 'a valid token must be accepted');

  // The front end must not contain server-side key material
  for (const f of ['public/app.js', 'public/index.html', 'public/sw.js']) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    assert.equal(/GEMINI_API_KEY\s*=/.test(src), false, `${f} must not define a key`);
    assert.equal(/AIza[0-9A-Za-z_-]{20,}/.test(src), false, `${f} must not contain a Google API key literal`);
  }
  // .gitignore protects the local env file and wrangler state
  const gi = readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.ok(/\.dev\.vars/.test(gi) && /\.wrangler/.test(gi), '.gitignore must exclude secret-bearing files');
});

// ===========================================================================
await test('H', '実績収益と推定収益が別々に表示される', async () => {
  const measured = await call('/api/ledger', 'POST', { kind: 'revenue', amount: 5000, basis: 'measured', source: 'https://payout.example.jp/receipt/123', note: '換金完了' });
  assert.equal(measured.json.ok, true);
  const estimated = await call('/api/ledger', 'POST', { kind: 'revenue', amount: 99000, basis: 'estimated', note: '推定月収' });
  assert.equal(estimated.json.ok, true);

  // A measured entry without evidence must be REJECTED
  const bad = await call('/api/ledger', 'POST', { kind: 'revenue', amount: 7777, basis: 'measured' });
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.error, 'measured_requires_source');

  const led = await call('/api/ledger');
  assert.equal(led.json.summary.revenue.measured, 5000);
  assert.equal(led.json.summary.revenue.total_estimated, 99000);
  assert.equal(led.json.summary.net_profit_measured, 5000);
  assert.ok(led.json.summary.disclaimer.includes('推定'));

  // The dashboard surfaces both numbers separately
  const dash = await call('/api/dashboard');
  assert.equal(dash.json.ledger.revenue.measured, 5000);
  assert.ok(dash.json.ledger.revenue.total_estimated >= 99000);
  assert.ok(dash.json.honesty.basis_labels.measured === '実測');
});

// ===========================================================================
await test('I', 'iPhoneの画面幅で主要操作が使用できる（モバイルファースト）', async () => {
  const html = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.ok(html.includes('width=device-width'), 'responsive viewport');
  assert.ok(html.includes('viewport-fit=cover'), 'iPhone safe-area support');
  assert.ok(html.includes('apple-mobile-web-app-capable'), 'iOS home-screen support');
  assert.ok(html.includes('manifest.webmanifest'), 'PWA manifest linked');

  const css = readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
  assert.ok(/--tap:\s*44px/.test(css), 'minimum 44px touch targets');
  assert.ok(/position:\s*fixed; bottom: 0/.test(css), 'fixed bottom tab bar for one-handed use');
  assert.ok(/safe-area-inset-bottom/.test(css), 'safe area insets handled');
  assert.ok(/@media \(max-width: 380px\)/.test(css), 'very narrow screens handled');
  assert.ok(/prefers-color-scheme: light/.test(css), 'light mode supported');

  const app = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  for (const route of ['home', 'missions', 'tasks', 'opportunities', 'fx', 'rewards', 'sidehustle', 'workflows', 'knowledge', 'logs', 'character', 'settings']) {
    assert.ok(app.includes(`screens.${route}`), `screen ${route} must exist`);
  }
  // Home screen must show the required elements
  for (const kw of ['現在のミッション', '次に実行するタスク', '選定理由', '最後に成功したステップ', '停止', 'API使用状況']) {
    assert.ok(app.includes(kw), `home screen must display "${kw}"`);
  }
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.length >= 3, 'PWA icons declared');
});

// ===========================================================================
await test('J', 'ブラウザーを閉じてもバックエンドが処理を継続する（制約は明示）', async () => {
  // Simulate the Cron Trigger path with NO client involved at all.
  const before = await call('/api/logs?limit=200');
  const beforeCount = before.json.runs.length;

  const t1 = await call('/api/scheduler/tick', 'POST', {});
  assert.equal(t1.json.source, 'api');
  const steps = (t1.json.steps || []).map((s) => s.step);
  assert.ok(steps.includes('engine_tick'), 'the scheduler must drive the engine');
  assert.ok(steps.includes('resume_waiting'), 'quota waiters must be woken');

  // Work happens with no dashboard/UI request in between
  const after = await call('/api/logs?limit=200');
  assert.ok(after.json.runs.length >= beforeCount, 'work must be recorded server-side');

  const settings = await call('/api/settings');
  const lastRun = settings.json.settings.find((s) => s.key === 'scheduler:last_run');
  assert.ok(lastRun && lastRun.value.at, 'the scheduler must persist its last run');

  // The constraint is documented rather than hidden
  const wrangler = readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
  assert.ok(/crons\s*=/.test(wrangler), 'a Cron Trigger must be configured for server-side continuation');
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(/cron|Cron/.test(readme), 'the deployment docs must explain the scheduler');
  // A cron run performs a bounded number of steps (10ms CPU on the free plan)
  assert.ok(Number(env.ENGINE_STEPS_PER_TICK) <= 10, 'per-tick work must stay small');
});

// ===========================================================================
await test('K', '危険な外部操作が承認なしに実行されない', async () => {
  const { Store } = await import('../src/db.js');
  const { buildTools, executeTool } = await import('../src/engine/tools.js');
  const { gate } = await import('../src/safety.js');
  const store = new Store(env.DB);
  const tools = buildTools({ store, env, rewards: null, sidehustle: null, ranking: null, memory: null, research: null, router: null, fx: null, knowledge: null, dataAnalysis: null, codeAgent: null, browser: null });

  // The dangerous task must exist in the queue so the gate can park it.
  const now = new Date().toISOString();
  await store.insert('tasks', {
    id: 'tsk_danger', mission_id: 'msn_starter', parent_id: null, title: '実口座発注の検討',
    description: '承認ゲートの検証', category: 'income_fx', state: 'queued', priority: 10, score: 0,
    score_reasons: null, depends_on: '[]', attempt: 0, max_attempts: 3, last_success_step: null,
    next_action: null, tool_name: 'live_order', tool_args: '{}', result_ref: null,
    error_history: '[]', strategy: null, strategy_switches: 0, progress_marker: null, artifacts: '[]',
    created_at: now, updated_at: now, started_at: null, finished_at: null,
  });

  const ctx = { store, env, task: { id: 'tsk_danger', mission_id: 'msn_starter', title: '実口座発注' }, memory: null };

  for (const tool of ['live_order', 'fund_transfer', 'external_publish', 'account_signup']) {
    const res = await executeTool(tools, ctx, tool, { amount: 100000 });
    assert.equal(res.ok, false, `${tool} must never succeed without approval`);
    assert.equal(res.needsApproval, true, `${tool} must request approval`);
  }
  // Approvals were created and are pending
  const appr = await call('/api/approvals');
  assert.ok(appr.json.approvals.filter((a) => a.status === 'pending').length >= 4, 'approval records must exist');

  // The task was parked in waiting_for_approval
  const tasks = await call('/api/tasks?limit=200');
  const t = tasks.json.tasks.find((x) => x.id === 'tsk_danger');
  assert.equal(t?.state, 'waiting_for_approval');

  // Paid AI is disabled and a spend guard exists
  const { spendGuard } = await import('../src/safety.js');
  const sg = await spendGuard(store, env, { paid: true, estCostUsd: 1 });
  assert.equal(sg.allowed, false);
  assert.equal(sg.reason, 'paid_disabled');

  // Approving does not magically enable order execution (research mode)
  const pending = appr.json.approvals.find((a) => a.action === 'live_order');
  const decided = await call(`/api/approvals/${pending.id}/decide`, 'POST', { decision: 'approved' });
  assert.equal(decided.json.status, 'approved');
  const after = await executeTool(tools, ctx, 'live_order', { amount: 1 });
  assert.equal(after.ok, false, 'even after approval, real order submission is not implemented in research mode');

  // The policy is explicit in the API
  const policy = (await call('/api/approvals')).json.policy;
  assert.ok(policy.approval_required.includes('実口座での売買'));
  assert.ok(policy.autonomous.includes('公開情報の調査'));
});

// ===========================================================================
await test('L', '過去に失敗した方法と却下された候補が次の計画に反映される', async () => {
  const { Store } = await import('../src/db.js');
  const { Memory } = await import('../src/memory/memory.js');
  const { AIRouter } = await import('../src/ai/router.js');
  const { createResearch } = await import('../src/research/web.js');
  const { createRewards } = await import('../src/income/rewards.js');
  const { replanAfterFailure, planMission } = await import('../src/engine/planner.js');

  const store = new Store(env.DB);
  const memory = new Memory(store);
  const router = new AIRouter(store, env);
  const research = createResearch(env);
  const rewards = createRewards({ store, router, research, memory });

  // 1) Reject a candidate → it enters long-term memory
  const first = await rewards.research({ store, router, memory, research, mission: null, character: null, topic: 'ポイ活 高還元', limit: 5 });
  assert.ok(first.candidates.length > 0, 'candidates expected from the stub sources');
  const victim = first.candidates[0];
  await rewards.reject(store, { opportunityId: victim.id, reason: '換金条件が未確認で確実性が低い', name: victim.name });

  const rejectedMem = await memory.search(victim.name, { kinds: ['rejected'], limit: 5 });
  assert.ok(rejectedMem.length >= 1, 'the rejection must be stored as memory');

  // 2) Re-running the research must NOT re-propose the rejected candidate
  const second = await rewards.research({ store, router, memory, research, mission: null, character: null, topic: 'ポイ活 高還元', limit: 5 });
  const reProposed = second.candidates.find((c) => c.name.toLowerCase() === victim.name.toLowerCase());
  assert.ok(!reProposed, `rejected candidate "${victim.name}" must not be re-proposed`);
  assert.ok(second.rejected.length >= 1, 'the rejected list must be reported back');

  // 3) Guardrails feed the planning context
  const guards = await call('/api/memory/guardrails');
  assert.ok(guards.json.memories.some((m) => m.kind === 'rejected' || m.kind === 'failure' || m.kind === 'strategy'),
    'guardrails must expose failures/rejections for planning');

  // 4) A failed strategy is avoided by the re-planner
  const mission = await store.get('missions', globalThis.__MISSION_ID);
  const failedTask = {
    id: 'tsk_l_fail', mission_id: mission.id, category: 'income_rewards',
    tool_name: 'rewards_research', title: 'ポイ活候補の調査', priority: 60, attempt: 3, strategy_switches: 0,
  };
  await memory.write({ kind: 'strategy', scope: `mission:${mission.id}`, key: 'failed-strategy:income_rewards:rewards_research', text: '手法 rewards_research は income_rewards で失敗した（原因: データなし）。再計画時は別手段を優先する。', evidence: 'measured', importance: 70 });
  const alt = await replanAfterFailure({ store, router, memory, character: null, mission, failedTask, diagnosis: 'データが取得できなかった' });
  assert.ok(alt.length >= 1);
  assert.notEqual(alt[0].tool_name, 'rewards_research', 'the failed method must not be reused');

  // 5) planMission skips titles that are already open (no duplicate work)
  const existing = await store.all('SELECT * FROM tasks WHERE mission_id=?', mission.id);
  const replanned = await planMission({ store, router, memory, character: null, mission, existingTasks: existing });
  const existingTitles = new Set(existing.filter((t) => !['completed', 'failed', 'cancelled'].includes(t.state)).map((t) => t.title.replace(/\s+/g, '').toLowerCase()));
  for (const created of replanned.created) {
    assert.ok(!existingTitles.has(created.title.replace(/\s+/g, '').toLowerCase()), `duplicate task created: ${created.title}`);
  }
});

// ===========================================================================
// Extra end-to-end checks beyond A–L
// ===========================================================================
await test('X1', 'FXパイプライン: データ取得→仮説→非リペイント検査→バックテスト→改善', async () => {
  const md = await call('/api/fx/market-data', 'POST', { symbol: 'USDJPY', days: 1500 });
  assert.equal(md.json.ok, true, `market data: ${md.json.error || ''}`);
  assert.ok(md.json.bars > 1000, `expected >1000 bars, got ${md.json.bars}`);
  assert.ok(md.json.source, 'the data source must be named');

  const gen = await call('/api/fx/generate', 'POST', { symbol: 'USDJPY' });
  assert.equal(gen.json.ok, true);
  assert.ok(gen.json.strategy.pine_code.includes('@version='), 'Pine script generated');
  assert.equal(gen.json.strategy.lint.nonRepaint, true, `generated Pine must be non-repainting: ${JSON.stringify(gen.json.strategy.lint.violations)}`);

  const bt = await call('/api/fx/backtest', 'POST', { symbol: 'USDJPY', days: 1500 });
  assert.equal(bt.json.ok, true, `backtest: ${bt.json.summary || ''}`);
  const m = bt.json.metrics;
  assert.ok(m.trades >= 0);
  assert.ok(m.profitFactor !== undefined);
  assert.ok(m.maxDrawdownPct !== undefined);
  assert.ok(bt.json.walkforward && bt.json.walkforward.folds.length >= 3, 'walk-forward folds required');
  assert.ok(bt.json.overfit && bt.json.overfit.verdict, 'overfit verdict required');
  assert.ok(bt.json.losers.hypotheses.length > 0, 'loser analysis must propose next hypotheses');
  assert.ok(bt.json.disclaimer.includes('保証'), 'the disclaimer must not over-promise');

  const improve = await call('/api/fx/improve', 'POST', {});
  assert.equal(improve.json.ok, true, `improve: ${improve.json.error || ''}`);
  assert.ok(improve.json.trials > 0, 'alternative parameters must be trialled');
  assert.ok(typeof improve.json.improved === 'boolean');
});

await test('X2', '実行ログとチェックポイントが状態遷移を記録する', async () => {
  const logs = await call('/api/logs?limit=200');
  const states = new Set(logs.json.runs.map((r) => r.state));
  assert.ok(states.size >= 3, `expected several distinct states, got ${[...states].join(',')}`);
  const ck = await call('/api/checkpoints');
  assert.ok(ck.json.checkpoints.length > 0);
  assert.ok(ck.json.checkpoints.every((c) => c.scope && c.state));
});

await test('X3', 'データ分析とナレッジベースが動作する', async () => {
  const csv = 'date,visits,signups,sales\n2026-09-01,120,4,0\n2026-09-02,180,9,1\n2026-09-03,90,2,0\n2026-09-04,,3,0\n';
  const prev = await call('/api/data/preview', 'POST', { text: csv });
  assert.equal(prev.json.ok, true);
  assert.deepEqual(prev.json.columns, ['date', 'visits', 'signups', 'sales']);
  assert.equal(prev.json.quality.missingCells, 1);
  const an = await call('/api/data/analyze', 'POST', { text: csv, spec: { kind: 'group', groupBy: 'date', metric: 'visits', agg: 'sum' } });
  assert.equal(an.json.ok, true);
  assert.ok(an.json.grouped.length === 4);

  const ing = await call('/api/knowledge/ingest', 'POST', { name: '収益メモ.md', text: '# メモ\n換金条件は1000ポイント以上。手数料は無料。日本国内のみ対応。\n'.repeat(10) });
  assert.equal(ing.json.ok, true);
  assert.ok(ing.json.chunks >= 1);
  const q = await call('/api/knowledge/query', 'POST', { question: '換金条件は？' });
  assert.ok(q.json.hits.length > 0, 'citation-bearing hits expected');
  assert.ok(q.json.answer.text.length > 0);
});

await test('X4', 'コード生成→テスト実行→失敗時は修正（制約は正直に報告）', async () => {
  const gen = await call('/api/code/generate', 'POST', { spec: '文字列を逆順にする関数', language: 'javascript' });
  assert.equal(gen.json.ok, true);
  assert.ok(gen.json.code.length > 10);
  assert.equal(gen.json.base, 'measured');

  const testRes = await call('/api/code/test', 'POST', { code: gen.json.code, tests: gen.json.tests, language: 'javascript' });
  assert.equal(testRes.json.ran, true, `runner must attempt execution: ${testRes.json.reason || ''}`);
  assert.ok(typeof testRes.json.passed === 'boolean');
  assert.ok(testRes.json.note.includes('デプロイ') || testRes.json.note.includes('実運用'), 'the runner must state its limits');

  // A genuinely broken snippet must report failure, not success
  const bad = await call('/api/code/test', 'POST', { code: 'function solve(x){ throw new Error("boom"); }', tests: [{ name: 'boom', fn: 'solve', args: [1], expected: 1 }], language: 'javascript' });
  assert.equal(bad.json.passed, false);
});

await test('X5', 'ワークフローが条件分岐・リトライ・ログ付きで実行される', async () => {
  const wf = await call('/api/workflows', 'POST', {
    name: 'テスト用フロー',
    definition: {
      steps: [
        { id: 'rank', tool: 'rank_opportunities', args: {}, output: 'r' },
        { id: 'cond', type: 'condition', expr: 'r.total > 0', then: 'ok', else: 'fallback' },
        { id: 'ok', tool: 'memory_write', args: { kind: 'fact', text: 'ranking ok' } },
        { id: 'fallback', tool: 'memory_write', args: { kind: 'fact', text: 'ranking empty' } },
      ],
    },
  });
  assert.equal(wf.json.ok, true);
  const run = await call(`/api/workflows/${wf.json.workflow.id}/run`, 'POST', { context: {} });
  assert.equal(run.json.status, 'completed');
  assert.ok(run.json.steps >= 3);
  const log = run.json.log;
  assert.ok(log.some((l) => l.branch !== undefined), 'the branch decision must be logged');
  assert.ok(log.every((l) => l.at), 'every step must be timestamped');

  // Retry + onError:continue behaviour (a deterministically failing read)
  const wf2 = await call('/api/workflows', 'POST', {
    name: 'エラー処理テスト',
    definition: {
      steps: [
        { id: 'fail', tool: 'browser_extract', args: { url: 'https://example.com/login' }, retries: 1, onError: 'continue' },
        { id: 'after', tool: 'memory_write', args: { kind: 'fact', text: 'continued after failure' } },
      ],
    },
  });
  const run2 = await call(`/api/workflows/${wf2.json.workflow.id}/run`, 'POST', {});
  assert.equal(run2.json.status, 'completed', 'onError=continue must let the flow finish');
  assert.equal(run2.json.log[0].attempts, 2, 'retries must be honoured');
  assert.equal(run2.json.log[0].ok, false);
});

await test('X6', '深層リサーチが出典つき所見と不足点を返す', async () => {
  const r = await call('/api/research/deep', 'POST', { question: '日本のポイ活で実際に換金できるサービスと条件', passes: 1 });
  assert.equal(r.json.ok, true);
  const rep = r.json.report;
  assert.ok(rep.findings.length > 0, 'findings expected');
  assert.ok(rep.sources.length >= 3, 'multiple sources expected');
  assert.ok(rep.findings.every((f) => f.basis), 'each finding must declare its evidence basis');
  assert.ok(rep.provenance.includes('出典'), 'provenance statement required');
  const reports = await call('/api/research/reports');
  assert.ok(reports.json.reports.length >= 1, 'the report must be persisted');
});

await test('X7', 'ブラウザーエージェントは読み取り専用で安全制約を守る', async () => {
  const ok = await call('/api/browser/extract', 'POST', { url: 'https://source0.example.jp/article/0' });
  assert.equal(ok.json.ok, true);
  assert.ok(ok.json.note.includes('読み取り'), 'the read-only limitation must be stated');

  const login = await call('/api/browser/extract', 'POST', { url: 'https://example.com/login' });
  assert.equal(login.json.ok, false);
  assert.equal(login.json.error, 'disallowed_path');

  const priv = await call('/api/browser/extract', 'POST', { url: 'http://127.0.0.1:8080/secret' });
  assert.equal(priv.json.ok, false);
  assert.equal(priv.json.error, 'blocked_private_host');
});

await test('X8', 'キャラクターの重みがタスク選択スコアに実際に反映される', async () => {
  const { scoreTask } = await import('../src/engine/executor.js');
  const task = { title: 'x', category: 'income_fx', tool_name: 'fx_backtest', priority: 70, attempt: 0, depends_on: '[]' };
  const bold = scoreTask(task, { character: { priority_weights: { upside: 0.40, speed: 0.25, evidence: 0.15, risk: 0.10, cost: 0.10 } } });
  const careful = scoreTask(task, { character: { priority_weights: { upside: 0.20, speed: 0.10, evidence: 0.45, risk: 0.20, cost: 0.05 } } });
  assert.notEqual(bold.score, careful.score, 'persona weights must change the ranking');
  assert.ok(bold.reasons.length > 0, 'the score must be explainable');
  // A blocked task (unmet dependency) ranks lower
  const blocked = scoreTask({ ...task, depends_on: JSON.stringify(['dep1']) }, { character: { priority_weights: bold.weights || { upside: .3, speed: .2, evidence: .25, risk: .15, cost: .1 } } });
  assert.ok(blocked.score < bold.score, 'dependency-blocked tasks must score lower');
});

await test('X9', 'AIキー未設定でも全モジュールが決定的モードで動作する', async () => {
  // The whole suite above ran with zero API keys — assert the fallback is real
  const p = await call('/api/providers');
  assert.equal(p.json.configured.every((c) => !c.key_present), true, 'no keys in the test env');
  assert.equal(p.json.fallback_available, true);
  assert.ok(p.json.fallback_note.length > 0);
  const chat = await call('/api/chat', 'POST', { message: '現状を教えて' });
  assert.equal(chat.json.ok, true);
  assert.equal(chat.json.fallback, true);
  assert.ok(chat.json.reply.length > 0, 'the deterministic chat path must answer');
});

// ---------------------------------------------------------------------------
console.log(`\n════════ RESULT: ${pass} passed, ${failures.length} failed ════════`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  [${f.id}] ${f.title}\n    → ${f.error}`);
}
try { env.DB.close(); } catch { /* ignore */ }
try { rmSync(DB_FILE, { force: true }); } catch { /* ignore */ }
process.exit(failures.length ? 1 : 0);
