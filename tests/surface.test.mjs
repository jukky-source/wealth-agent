// 公開表面の解析（surface.js）— 認証回避をしないこと、根拠と不明点を残すことを固定する。
import assert from 'node:assert/strict';
import { normTarget, parseHead, findEndpoints, findForms, findFeeds, surfaceScore, surfaceBrief, inspectSurface, GUARDRAILS, SURFACE_PRICE_USDC } from '../src/agent/surface.js';

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.log('FAIL', name, e.message); } };

const html = `<!doctype html><html><head><title>Acme Notes</title><meta name="description" content="Notes for teams"><meta name="generator" content="Next.js"><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body><form action="/api/login" method="post"><input name="email"><input name="password"></form><script src="/_next/static/app.js"></script><script>fetch("/api/notes?page=1")</script></body></html>`;

await t('normTarget: ホスト名だけでもURLにする', () => { assert.equal(normTarget('example.com').href, 'https://example.com/'); });
await t('normTarget: 不正はnull', () => { assert.equal(normTarget('nothost'), null); assert.equal(normTarget(''), null); });
await t('parseHead: 見出しと痕跡', () => { const h = parseHead(html); assert.equal(h.title, 'Acme Notes'); assert.ok(h.signals.includes('Next.js')); assert.ok(h.signals.includes('フィード')); });
await t('findEndpoints: パスを拾う', () => { const e = findEndpoints(html, 'https://acme.test'); assert.ok(e.some((x) => x.path === '/api/login')); assert.ok(e.some((x) => x.path === '/api/notes')); });
await t('findForms/findFeeds', () => { assert.equal(findForms(html)[0].method, 'post'); assert.deepEqual(findFeeds(html), ['/feed.xml']); });
await t('surfaceScore: 0..10', () => { assert.ok(surfaceScore({ ok: true, kind: 'mcp', endpoints: [1, 2], openapi: {}, feeds: [1], forms: [1], robots: {}, signals: [1] }) === 10); });
await t('surfaceBrief: 根拠と不明点と禁止事項を必ず含む', () => {
  const s = { ok: true, target: 'https://a.test', kind: 'web', score: 3, auth: 'public', endpoints: [{ path: '/api/x', evidence: '本文' }], forms: [], feeds: [], evidence: ['GET / → 200'], unknown: ['動的レンダリング'], signals: [] };
  const b = surfaceBrief(s, { full: false });
  for (const k of ['根拠', '分からなかったこと', 'この道具が守ること', '限界']) assert.ok(b.includes(k), k);
});

const fake = (routes) => async (u) => {
  const key = String(u).replace('https://a.test', '');
  const r = routes[key] || { status: 404, body: '', ct: 'text/plain' };
  return { status: r.status, headers: new Headers({ 'content-type': r.ct, ...(r.h || {}) }), text: async () => r.body, url: String(u) };
};

await t('inspectSurface: 公開ページを解析して根拠を残す', async () => {
  const s = await inspectSurface('https://a.test', { fetchImpl: fake({ '/': { status: 200, ct: 'text/html', body: html }, '/robots.txt': { status: 200, ct: 'text/plain', body: 'User-agent: *\nAllow: /' } }) });
  assert.equal(s.ok, true);
  assert.equal(s.title, 'Acme Notes');
  assert.ok(s.endpoints.length >= 1);
  assert.ok(s.evidence.length >= 1);
  assert.ok(s.unknown.length >= 1);
  assert.equal(s.auth, 'public');
});

await t('inspectSurface: 403 は突破せず auth_required で止める', async () => {
  const s = await inspectSurface('https://a.test', { fetchImpl: fake({ '/': { status: 403, ct: 'text/html', body: 'denied' } }) });
  assert.equal(s.auth, 'auth_required');
  assert.equal(s.kind, 'protected');
  assert.ok(s.evidence.join(' ').includes('403'));
  assert.equal(s.endpoints.length, 0);
});

await t('inspectSurface: 接続不可は ok:false', async () => {
  const s = await inspectSurface('https://a.test', { fetchImpl: async () => { throw new Error('boom'); } });
  assert.equal(s.ok, false);
  assert.ok(s.reason);
});

await t('inspectSurface: MCP サーバーはツール一覧を読む', async () => {
  const mcp = async (u, init) => {
    if (String(u).endsWith('/mcp')) {
      const m = JSON.parse(init.body);
      const j = (o) => ({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(o), json: async () => o, url: String(u) });
      if (m.method === 'initialize') return j({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'wealth-agent', version: '1.0.0' } } });
      return j({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'buy_research_brief' }] } });
    }
    return fake({ '/': { status: 200, ct: 'text/html', body: html } })(u);
  };
  const s = await inspectSurface('https://a.test', { fetchImpl: mcp });
  assert.equal(s.mcp.ok, true);
  assert.equal(s.mcp.tools[0].name, 'buy_research_brief');
  assert.equal(s.kind, 'mcp');
});

await t('禁止事項と価格が公開されている', () => { assert.ok(GUARDRAILS.join(' ').includes('突破はしない')); assert.equal(SURFACE_PRICE_USDC, 0.25); });

console.log(`surface: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
