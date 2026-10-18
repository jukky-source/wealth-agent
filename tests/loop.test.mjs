// 自己修復ループ（loop.js）と REA 自動投入キュー（reaQueue.js）のテスト。
// 外部通信はしない（fetch を差し替える）。確かめること:
//  ・収益0のとき、ファネルの「どの段で詰まっているか」を名指しできること
//  ・同じ失敗を繰り返さず、手を変えて再試行し、上限で見切ること
//  ・拾った情報が、人が並べなくても自動で解析対象になること（重複しない）
//  ・解析結果がネタ帳（試すループ）に変換されること
import assert from 'node:assert/strict';
import { funnel, mutateAttempt, urlVariants, retryPlaybook, selfHeal, verifyListings, MAX_TRIES, loopText } from '../src/agent/loop.js';
import { enqueueFromFindings, autoAnalyze, queueSummary, targetKey } from '../src/agent/reaQueue.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

// --- 記憶だけの store（必要なテーブルだけ・再帰しない） ----------------------
function memStore(seed = {}) {
  const tables = {
    playbooks: [], rea_targets: [], loop_runs: [], settings: [], receipts: [], ledger: [],
    twitter_posts: [], scout_findings: [], perks: [],
  };
  for (const k of Object.keys(seed)) tables[k] = seed[k].slice();
  const T = (sql) => { const m = sql.match(/(?:INTO|FROM|UPDATE)\s+([a-z_]+)/i); return m ? m[1] : null; };
  const cols = (sql) => { const m = sql.match(/INSERT INTO [a-z_]+ \(([^)]+)\)/i); return m ? m[1].split(',').map((s) => s.trim()) : null; };
  return {
    _t: tables,
    async run(sql, ...a) {
      if (/^\s*CREATE (TABLE|UNIQUE INDEX|INDEX)/i.test(sql)) return {};
      const tb = T(sql); if (!tb || !tables[tb]) return {};
      if (/^\s*INSERT INTO/i.test(sql)) {
        const c = cols(sql); const o = {};
        c.forEach((k, i) => { o[k] = a[i]; });
        if (c.includes('key') && tables[tb].some((r) => r.key === o.key)) throw new Error('UNIQUE constraint failed');
        tables[tb].push(o); return {};
      }
      if (/^\s*UPDATE/i.test(sql)) {
        const m = sql.match(/UPDATE\s+([a-z_]+)\s+SET\s+([\s\S]+?)\s+WHERE\s+id\s*=\s*\?/i);
        if (!m) return {};
        const body = m[2].replace(/COALESCE\(tries,0\)\s*\+\s*1/gi, '__tries_inc__');
        const row = tables[m[1]].find((r) => r.id === a[a.length - 1]);
        if (!row) return {};
        let i = 0;
        for (const s of body.split(',').map((x) => x.trim())) {
          const eq = s.indexOf('=');
          const col = s.slice(0, eq).trim(); const expr = s.slice(eq + 1).trim();
          if (expr === '__tries_inc__') { row[col] = (row[col] || 0) + 1; continue; }
          if (expr === '?') { row[col] = a[i++]; continue; }
          row[col] = expr.replace(/^'|'$/g, '');
        }
        return {};
      }
      return {};
    },
    async first(sql, ...a) { return (await this.all(sql, ...a))[0] || null; },
    async all(sql, ...a) {
      const tb = T(sql);
      if (!tb || !tables[tb]) return [];
      let out = tables[tb].slice();
      const q = (re, fn) => { if (re.test(sql)) out = out.filter(fn); };
      q(/WHERE key = \?/, (r) => r.key === a[0]);
      q(/WHERE status = 'trying'/, (r) => r.status === 'trying');
      q(/WHERE status = 'dead'/, (r) => r.status === 'dead');
      q(/WHERE status = 'queued'/, (r) => r.status === 'queued');
      q(/WHERE status = \?/, (r) => r.status === a[0]);
      q(/COALESCE\(tries,0\) > 0/, (r) => Number(r.tries || 0) > 0);
      q(/COALESCE\(tries,0\) < \?/, (r) => Number(r.tries || 0) < a[0]);
      q(/key LIKE 'f_%'/, (r) => String(r.key || '').startsWith('f_'));
      q(/url IS NOT NULL/, (r) => r.url);
      q(/kind = 'revenue'/, (r) => r.kind === 'revenue');
      q(/basis <> 'self_test'/, (r) => r.basis !== 'self_test');
      q(/status IN \('analyzed','handoff'\)/, (r) => r.status === 'analyzed' || r.status === 'handoff');
      q(/kind = 'distribute' AND state = 'done'/, (r) => r.kind === 'distribute' && r.state === 'done');
      if (/SUM\(amount\)/i.test(sql)) {
        const self = /basis = 'self_test'/.test(sql);
        return [{ s: out.reduce((x, r) => x + (self ? (r.basis === 'self_test' ? Number(r.amount || 0) : 0) : Number(r.amount || 0)), 0) }];
      }
      if (/GROUP BY status/.test(sql)) { const m = {}; for (const r of out) m[r.status || 'other'] = (m[r.status || 'other'] || 0) + 1; return Object.entries(m).map(([status, n]) => ({ status, n })); }
      if (/GROUP BY kind/.test(sql) && tb === 'loop_runs') { const m = {}; for (const r of out) m[r.kind || 'other'] = (m[r.kind || 'other'] || 0) + 1; return Object.entries(m).map(([kind, n]) => ({ kind, n })); }
      if (/COUNT\(\*\)/i.test(sql)) return [{ n: out.length }];
      if (/ORDER BY score DESC/.test(sql)) out.sort((x, y) => Number(y.score || 0) - Number(x.score || 0));
      if (/LIMIT \?/.test(sql)) out = out.slice(0, Number(a[a.length - 1]) || 20);
      return out;
    },
  };
}

const fakeFetch = (map = {}) => async (u) => {
  const hit = map[String(u)];
  if (!hit) return { status: 404, ok: false, text: async () => '', json: async () => ({}), headers: new Headers({ 'content-type': 'text/plain' }) };
  return { status: hit.status || 200, ok: (hit.status || 200) < 400, text: async () => hit.body || '', json: async () => JSON.parse(hit.body || '{}'), headers: new Headers({ 'content-type': hit.ct || 'text/html' }) };
};

console.log('自己修復ループ');
await t('urlVariants: www の有無とトップを、元と違う形で返す', () => {
  const v = urlVariants('https://www.example.com/a');
  assert.ok(v.includes('https://example.com/a'), JSON.stringify(v));
  assert.ok(v.includes('https://www.example.com/'));
  assert.equal(urlVariants('not a url').length, 0);
});
await t('mutateAttempt: 初回 → 入口を変える → 読み方を変える → 3回で見切る', () => {
  assert.equal(mutateAttempt({ tries: 0, url: 'https://a.test/x' }).mutation, 'first');
  const e = mutateAttempt({ tries: 1, url: 'https://a.test/x', probe: 'http' });
  assert.equal(e.mutation, 'entry'); assert.notEqual(e.url, 'https://a.test/x');
  const p = mutateAttempt({ tries: 2, url: 'https://a.test/x', probe: 'http' });
  assert.equal(p.mutation, 'probe'); assert.equal(p.probe, 'free_tier');
  assert.equal(mutateAttempt({ tries: MAX_TRIES, url: 'https://a.test/x' }).give_up, true);
});
await t('funnel: 売り物はあるのに掲載0なら「置き場に出る」で詰まっていると言える', async () => {
  const store = memStore({ playbooks: [{ id: 'a', tries: 2, status: 'trying', result_json: '{"verdict":"alive"}' }], ledger: [{ kind: 'revenue', amount: 0, basis: 'self_test' }] });
  const f = await funnel(store);
  assert.equal(f.bottleneck.key, 'distributed', JSON.stringify(f.bottleneck));
  assert.match(f.verdict, /実売上はまだ 0/);
  assert.equal(f.stages.find((s) => s.key === 'tried').n, 1);
});
await t('funnel: 実売上があれば verdict が「次の詰まり」を言う', async () => {
  const store = memStore({ playbooks: [{ id: 'a', tries: 1, status: 'works', result_json: '{"verdict":"alive"}' }], ledger: [{ kind: 'revenue', amount: 12, basis: 'x402' }] });
  const f = await funnel(store);
  assert.match(f.verdict, /実売上 \$12/);
});
await t('retryPlaybook: 到達できなければ手を変えて再試行し、3回で dead にする', async () => {
  const store = memStore({ playbooks: [{ id: 'p1', title: 'x', url: 'https://a.test/x', probe: 'http', tries: 0, status: 'new' }] });
  const f1 = await retryPlaybook(store, store._t.playbooks[0], { fetchImpl: fakeFetch({}) });
  assert.equal(f1.status, 'trying'); assert.equal(f1.mutation, 'first');
  const f2 = await retryPlaybook(store, store._t.playbooks[0], { fetchImpl: fakeFetch({}) });
  assert.equal(f2.mutation, 'entry');
  assert.match(store._t.playbooks[0].result_json, /"mutation":"entry"/);
  const f3 = await retryPlaybook(store, store._t.playbooks[0], { fetchImpl: fakeFetch({}) });
  assert.equal(f3.status, 'dead');
  assert.equal((await retryPlaybook(store, store._t.playbooks[0], { fetchImpl: fakeFetch({}) })).action, 'give_up');
});
await t('retryPlaybook: 生きていれば trying、募集中なら works', async () => {
  const store = memStore({ playbooks: [{ id: 'p1', title: 'x', url: 'https://a.test/x', probe: 'http', tries: 0, status: 'new' }] });
  const ok = await retryPlaybook(store, store._t.playbooks[0], { fetchImpl: fakeFetch({ 'https://a.test/x': { body: 'hello' } }) });
  assert.equal(ok.status, 'trying'); assert.equal(ok.verdict, 'alive');
  const store2 = memStore({ playbooks: [{ id: 'p2', title: 'y', url: 'https://b.test/y', probe: 'free_tier', tries: 0, status: 'new' }] });
  const w = await retryPlaybook(store2, store2._t.playbooks[0], { fetchImpl: fakeFetch({ 'https://b.test/y': { body: 'free tier available' } }) });
  assert.equal(w.status, 'works'); assert.equal(w.verdict, 'mentions_free_or_money');
});
await t('selfHeal: 詰まりを記録し、置き場の掲載エントリを「押すだけ」の形で用意する', async () => {
  const store = memStore({
    playbooks: [{ id: 'p1', title: 'stuck', url: 'https://a.test/x', probe: 'http', tries: 1, status: 'trying', last_try_at: new Date(Date.now() - 7 * 3600e3).toISOString() }],
    ledger: [{ kind: 'revenue', amount: 0, basis: 'self_test' }],
  });
  const r = await selfHeal(store, { fetchImpl: fakeFetch({}), now: new Date().toISOString() });
  const kinds = r.actions.map((a) => a.kind);
  assert.ok(kinds.includes('retry'), JSON.stringify(kinds));
  assert.ok(kinds.includes('distribute'), JSON.stringify(kinds));
  assert.ok(kinds.includes('diagnose'), JSON.stringify(kinds));
  const dist = store._t.loop_runs.find((x) => x.kind === 'distribute');
  assert.equal(dist.level, 'approve');
  assert.match(dist.evidence_json, /awesome-remote-mcp-servers/);
  assert.ok(store._t.loop_runs.length >= 3);
  assert.match(loopText(r.funnel), /詰まり/);
});

await t('verifyListings: 掲載面を実際に取りに行き、載っていれば live と数える', async () => {
  const ff = fakeFetch({ 'https://raw.githubusercontent.com/punkpeye/awesome-remote-mcp-servers/main/README.md': { body: '- [wealth-agent](https://wealth-agent.wealthagent-app.workers.dev) `https://wealth-agent.wealthagent-app.workers.dev/mcp`' } });
  const r = await verifyListings({ fetchImpl: ff });
  assert.equal(r.checked, 2);
  assert.ok(r.live_keys.includes('awesome-remote-mcp-servers'), JSON.stringify(r));
  assert.equal(r.live, 1);
});
await t('verifyListings: 載っていなければ live にしない（提出済みと載ったを混同しない）', async () => {
  const r = await verifyListings({ fetchImpl: fakeFetch({}) });
  assert.equal(r.live, 0);
  assert.equal(r.listings[0].status, 404);
});
await t('selfHeal: 掲載が生きていれば「置き場に出る」を done として数える', async () => {
  const store = memStore({ playbooks: [{ id: 'p1', title: 'stuck', url: 'https://a.test/x', probe: 'http', tries: 1, status: 'trying', last_try_at: new Date(Date.now() - 7 * 3600e3).toISOString() }] });
  const ff = fakeFetch({ 'https://raw.githubusercontent.com/punkpeye/awesome-remote-mcp-servers/main/README.md': { body: 'https://wealth-agent.wealthagent-app.workers.dev/mcp' } });
  const r = await selfHeal(store, { fetchImpl: ff, now: new Date().toISOString() });
  const d = store._t.loop_runs.filter((x) => x.kind === 'distribute');
  assert.ok(d.some((x) => x.state === 'done'), JSON.stringify(d));
  assert.equal(r.funnel.stages.find((s) => s.key === 'distributed').n, 1);
});

console.log('REA 自動投入キュー');
await t('enqueueFromFindings: X / scout / perks から積み、同じ URL は二度積まない', async () => {
  const store = memStore({
    twitter_posts: [{ url: 'https://x.test/a', text: 'AIの無料枠', score: 9, handle: 'a' }, { url: 'https://x.test/a', text: 'AIの無料枠', score: 9, handle: 'a' }],
    scout_findings: [{ url: 'https://s.test/b', title: 'B', score: 40, source_id: 'hn' }],
    perks: [{ url: 'https://p.test/c', title: 'C' }],
  });
  const r = await enqueueFromFindings(store, { limit: 10 });
  assert.equal(r.inserted, 3, JSON.stringify(r));
  assert.equal(r.skipped, 1);
  assert.equal((await enqueueFromFindings(store, { limit: 10 })).inserted, 0);
  assert.equal(store._t.rea_targets[0].key, targetKey('https://x.test/a'));
});
await t('autoAnalyze: 解析して状態を残し、使えるものはネタ帳に変換する', async () => {
  const store = memStore({ rea_targets: [{ id: 'q1', key: 'rt_1', target: 'https://a.test', source: 'x:a', title: 'A', score: 9, status: 'queued', tries: 0, created_at: new Date().toISOString() }] });
  const ff = fakeFetch({ 'https://a.test': { body: '<html><title>A</title><form action="/api/x"></form><script src="/app.js"></script></html>' } });
  const r = await autoAnalyze(store, { limit: 2, fetchImpl: ff });
  assert.equal(r.analyzed, 1);
  assert.equal(store._t.rea_targets[0].status, 'analyzed', store._t.rea_targets[0].status + ' / ' + store._t.rea_targets[0].result_json);
  assert.match(store._t.rea_targets[0].result_json, /"kind":"web"/);
  assert.ok(store._t.playbooks.length >= 1, 'ネタ帳に変換される');
  assert.ok(String(store._t.playbooks[0].key).startsWith('ra_'));
  assert.equal(store._t.playbooks[0].cost_jpy, 0);
  const s = await queueSummary(store);
  assert.equal(s.analyzed, 1); assert.equal(s.queued, 0); assert.equal(s.derived_playbooks, 1);
});
await t('autoAnalyze: 失敗しても記録して次へ進む（キューが詰まらない）', async () => {
  const store = memStore({ rea_targets: [{ id: 'q1', key: 'rt_1', target: 'nothost', source: 'x:a', title: 'A', score: 1, status: 'queued', tries: 0, created_at: new Date().toISOString() }] });
  const r = await autoAnalyze(store, { limit: 1, fetchImpl: fakeFetch({}) });
  assert.equal(r.analyzed, 1);
  assert.equal(store._t.rea_targets[0].status, 'failed', store._t.rea_targets[0].result_json);
  assert.equal(store._t.playbooks.length, 0);
});

console.log(`\n════════ LOOP: ${pass} passed, ${fail} failed ════════`);
process.exit(fail ? 1 : 0);
