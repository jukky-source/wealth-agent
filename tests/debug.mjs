// Diagnostic probe — prints full responses for the paths that were failing.
// Usage: node tests/debug.mjs
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Shim } from '../server/sqlite-d1.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT, '.local-data', 'debug.sqlite');
mkdirSync(path.dirname(DB_FILE), { recursive: true });
if (existsSync(DB_FILE)) rmSync(DB_FILE, { force: true });

const PAGE = `<html><head><title>出典ページ</title></head><body><h1>換金条件のまとめ</h1>${'<p>最低換金額は1000ポイント、換金手数料は無料で、日本国内から利用可能です。2026年時点で実際に換金できたという第三者報告があります。条件は公式規約に記載されています。</p>'.repeat(6)}</body></html>`;

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('.example.jp')) return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
  if (u.includes('duckduckgo.com')) return new Response(
    Array.from({ length: 6 }, (_, i) => `<a class="result__a" href="https://source${i}.example.jp/a/${i}">出典${i}</a><a class="result__snippet">日本のポイ活は最低換金額1000ポイント、手数料無料。</a>`).join(''),
    { status: 200, headers: { 'content-type': 'text/html' } });
  if (u.includes('wikipedia.org')) return new Response(JSON.stringify({ query: { search: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
  if (u.includes('finance.yahoo.com')) {
    const ts = []; const o = []; const h = []; const l = []; const c = [];
    let p = 145; let x = 7;
    const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
    for (let i = 0; i < 1600; i++) {
      const op = p; p = p + (rnd() - 0.5) * 1.1 + Math.sin(i / 75) * 0.05;
      ts.push(Math.floor(Date.parse('2019-06-01T00:00:00Z') / 1000) + i * 86400);
      o.push(op); c.push(p); h.push(Math.max(op, p) + 0.2); l.push(Math.min(op, p) - 0.2);
    }
    return new Response(JSON.stringify({ chart: { result: [{ meta: {}, timestamp: ts, indicators: { quote: [{ open: o, high: h, low: l, close: c }] } }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('nope', { status: 404 });
};

const env = {
  DB: new D1Shim(DB_FILE), ASSETS: null, RUNTIME: 'debug', OWNER_TOKEN: '',
  GEMINI_API_KEY: '', GROQ_API_KEY: '', OPENROUTER_API_KEY: '', SEARCH_ENDPOINT: '',
  ENGINE_STEPS_PER_TICK: '3', AI_DAILY_CALL_BUDGET: '300', ALLOW_PAID_AI: 'false',
};
const worker = (await import('../src/index.js')).default;

async function call(p, method = 'GET', body = null) {
  const req = new Request(`https://t.test${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, { waitUntil: () => {} });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* noop */ }
  return { status: res.status, json, text };
}
const show = (label, r, pick) => {
  console.log(`\n── ${label} (HTTP ${r.status})`);
  const v = pick ? pick(r.json) : r.json;
  console.log(JSON.stringify(v, null, 1)?.slice(0, 1200));
};

show('seed', await call('/api/admin/seed', 'POST', {}));
show('POST /api/character', await call('/api/character', 'POST', { character: { preset: 'cold_researcher', name: 'リリス', caution: 90, creativity: 40, risk_tolerance: 15, autonomy_level: 4, report_frequency: 'hourly', values: ['証拠'] } }));
show('GET /api/character', await call('/api/character'), (j) => ({ ok: j.ok, name: j.character?.name, caution: j.character?.caution, weights: j.character?.weights }));
show('POST /api/missions', await call('/api/missions', 'POST', { goal: '毎月3万円の追加収益を目指して、利用可能な方法を探索し実行し改善し続けて', target_value: 30000 }), (j) => ({ ok: j.ok, categories: j.categories, tasks: (j.tasks || []).map((t) => `${t.category}/${t.tool_name}`) }));
show('engine start', await call('/api/engine/start', 'POST', {}));
show('engine tick', await call('/api/engine/tick', 'POST', { steps: 3 }));
show('fx market-data', await call('/api/fx/market-data', 'POST', { symbol: 'USDJPY', days: 1500 }), (j) => ({ ok: j.ok, bars: j.bars, source: j.source, error: j.error }));
show('data analyze group', await call('/api/data/analyze', 'POST', { text: 'date,visits,signups,sales\n2026-09-01,120,4,0\n2026-09-02,180,9,1\n2026-09-03,90,2,0\n2026-09-04,,3,0\n', spec: { kind: 'group', groupBy: 'date', metric: 'visits', agg: 'sum' } }), (j) => ({ ok: j.ok, grouped: j.grouped, error: j.error }));
show('deep research', await call('/api/research/deep', 'POST', { question: '日本のポイ活で実際に換金できる条件', passes: 1 }), (j) => ({ ok: j.ok, findings: j.report?.findings?.length, sources: j.report?.sources?.length, error: j.error }));
const wf = await call('/api/workflows', 'POST', { name: 'dbg', definition: { steps: [{ id: 'rank', tool: 'rank_opportunities', args: {}, output: 'r' }, { id: 'cond', type: 'condition', expr: 'r.total > 0', then: 'ok', else: 'fb' }, { id: 'ok', tool: 'memory_write', args: { kind: 'fact', text: 'rank ok' } }, { id: 'fb', tool: 'memory_write', args: { kind: 'fact', text: 'rank empty' } }] } });
show('workflow run', await call(`/api/workflows/${wf.json.workflow.id}/run`, 'POST', {}));
try { env.DB.close(); } catch { /* noop */ }
