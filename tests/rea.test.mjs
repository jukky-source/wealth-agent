// REA（rea.js）— 認証回避をしないこと・対象を実行しないこと・根拠と不明点を必ず残すことを固定する。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  classifyTarget, reaPlan, scanJsBundle, inspectRea, reaBrief, reaScore, capabilityMap,
  recordRun, listRuns, ACTION_RULES, GUARDRAILS, LIMITS, REA_PRICE_USDC, REA_VERSION, KINDS,
} from '../src/agent/rea.js';

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.log('FAIL', name, e.message); } };

const html = `<!doctype html><html><head><title>Acme Notes</title><meta name="description" content="Notes for teams"><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>
<form action="/api/login" method="post"><input name="email"></form>
<script>window.__flags={"betaSearch":true,"newEditor":false};var k="sk-abcdefghijklmnopqrstuvwx";fetch("/api/notes?page=1");process.env.NEXT_PUBLIC_API_BASE;</script>
<script src="/_next/static/app.js"></script></body></html>`;
const appJs = `fetch("/v1/graphql");const s="https://api.stripe.com";var f={featureX:true};import.meta.env.VITE_TOKEN;`;

await t('classifyTarget: URL は remote', () => { const c = classifyTarget('https://example.com'); assert.equal(c.mode, 'remote'); });
await t('classifyTarget: ローカルの拡張子を種別に落とす', () => {
  assert.equal(classifyTarget('./resources/app.asar').kind, 'asar');
  assert.equal(classifyTarget('C:/x/tool.exe').kind, 'pe');
  assert.equal(classifyTarget('./libfoo.so').kind, 'elf');
  assert.equal(classifyTarget('/tmp/a.apk').kind, 'apk');
  assert.equal(classifyTarget('./x.unknown-ext').mode, 'local');
});
await t('reaPlan: 種別ごとの手順を返し、すべて allow', () => {
  const p = reaPlan('elf');
  assert.ok(p.some((s) => s.tool === 'readelf'));
  assert.ok(p.every((s) => s.level === 'allow'));
  assert.ok(p.every((s) => s.handoff === 'local'));
  assert.ok(reaPlan('pe').some((s) => s.tool === 'objdump'));
  assert.ok(reaPlan('asar').some((s) => s.cmd.includes('rea-cli')));
});
await t('scanJsBundle: フラグ・環境変数名・入口・外部ホストを取る', () => {
  const s = scanJsBundle(appJs, 'https://a.test');
  assert.ok(s.flags.some((f) => f.name === 'featureX' && f.value === true));
  assert.ok(s.envNames.includes('VITE_TOKEN'));
  assert.ok(s.endpoints.some((e) => e.path === '/v1/graphql'));
  assert.ok(s.hosts.includes('api.stripe.com'));
});
await t('scanJsBundle: 秘密は「形」だけで、値は返さない', () => {
  const s = scanJsBundle(html, 'https://a.test');
  assert.ok(s.secretShapes.length >= 1);
  const blob = JSON.stringify(s);
  assert.ok(!blob.includes('abcdefghijklmnopqrstuvwx'), '鍵の値が出力に漏れている');
  assert.ok(blob.includes('…（値は出さない）'));
});
await t('ACTION_RULES: 4段階そろい、危険な操作は never', () => {
  const lv = new Set(ACTION_RULES.map((r) => r.level));
  for (const x of ['allow', 'approve', 'handoff', 'never']) assert.ok(lv.has(x), x);
  const never = ACTION_RULES.filter((r) => r.level === 'never').map((r) => r.action);
  for (const x of ['auth_bypass', 'paywall_bypass', 'drm_circumvention', 'run_target_binary', 'scrape_and_resell']) assert.ok(never.includes(x), x);
});
await t('価格と版', () => { assert.equal(REA_PRICE_USDC, 0.5); assert.equal(REA_VERSION, '2.0'); assert.ok(KINDS.includes('mcp')); });

const fake = (routes) => async (u) => {
  const key = String(u).replace('https://a.test', '');
  const r = routes[key] || { status: 404, body: '', ct: 'text/plain' };
  return { status: r.status, headers: new Headers({ 'content-type': r.ct, ...(r.h || {}) }), text: async () => r.body, url: String(u) };
};

await t('inspectRea: 公開サイトを解析し、根拠と状態遷移を残す', async () => {
  const s = await inspectRea('https://a.test', { fetchImpl: fake({
    '/': { status: 200, ct: 'text/html', body: html },
    '/robots.txt': { status: 200, ct: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/_next/static/app.js': { status: 200, ct: 'application/javascript', body: appJs },
  }) });
  assert.equal(s.ok, true);
  assert.equal(s.state, 'done');
  assert.equal(s.kind, 'web');
  assert.ok(s.evidence.length >= 3);
  assert.ok(s.unknown.length >= 1);
  assert.ok(s.capabilities.length >= 2);
  assert.ok(s.steps.some((x) => x.state === 'queued') && s.steps.some((x) => x.state === 'done'));
  assert.ok(s.js.bundles.length >= 1 && s.js.totalBytes > 0);
  assert.ok(s.js.flags.some((f) => f.name === 'betaSearch'));
});
await t('inspectRea: 403 は突破せず blocked / auth_required', async () => {
  const s = await inspectRea('https://a.test', { fetchImpl: fake({ '/': { status: 403, ct: 'text/html', body: 'denied' } }) });
  assert.equal(s.auth, 'auth_required');
  assert.equal(s.state, 'blocked');
  assert.equal(s.kind, 'protected');
  assert.ok(s.evidence[0].includes('403'));
});
await t('inspectRea: ローカル対象は実行せず handoff で手順を返す', async () => {
  let called = 0;
  const s = await inspectRea('./resources/app.asar', { fetchImpl: async () => { called++; throw new Error('呼んではいけない'); } });
  assert.equal(s.mode, 'local');
  assert.equal(s.state, 'handoff');
  assert.equal(called, 0);
  assert.ok(s.plan.length >= 2);
  assert.ok(s.unknown.some((u) => u.includes('読んでいない')));
});
await t('inspectRea: URL 不正は ok:false', async () => {
  const s = await inspectRea('nothost');
  assert.equal(s.ok, false);
  assert.equal(s.state, 'failed');
});
await t('inspectRea: MCP があれば種別 mcp に上がる', async () => {
  const mcpFake = async (u, o) => {
    if (String(u).endsWith('/mcp')) {
      const body = JSON.parse(o.body);
      const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'x', version: '1' } } : { tools: [{ name: 'a' }, { name: 'b' }] };
      return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), url: String(u) };
    }
    return fake({ '/': { status: 200, ct: 'text/html', body: '<title>t</title>' } })(u, o);
  };
  const s = await inspectRea('https://a.test', { fetchImpl: mcpFake });
  assert.equal(s.kind, 'mcp');
  assert.equal(s.mcp.tools.length, 2);
  assert.ok(s.capabilities.some((c) => c.name.includes('MCP')));
});
await t('reaBrief: 根拠・不明・権限・限界を必ず含む', () => {
  const s = { ok: true, target: 'https://a.test', kind: 'web', mode: 'remote', state: 'done', score: 4, auth: 'public', capabilities: [{ name: 'x', evidence: 'y', confidence: 'med' }], evidence: ['GET / → 200'], unknown: ['動的'], action_rules: ACTION_RULES };
  const b = reaBrief(s, { full: false });
  for (const k of ['できること', '根拠', '分からなかったこと', 'この道具が守ること', '権限（4段階）', '限界']) assert.ok(b.includes(k), k);
  assert.ok(reaBrief({ ok: true, mode: 'local', target: './a.asar', plan: reaPlan('asar'), capabilities: [], evidence: [], unknown: [] }).includes('rea-cli'));
});
await t('reaScore: 0..10', () => {
  assert.ok(reaScore({ ok: true, capabilities: [], evidence: [] }) <= 10);
  assert.equal(reaScore({ ok: true, capabilities: [1, 2, 3], api: { openapi: {} }, mcp: { ok: true }, js: { totalBytes: 10 }, endpoints: [1], evidence: [1, 2, 3, 4] }), 10);
});
await t('capabilityMap: 根拠の無い項目は作らない', () => {
  const c = capabilityMap({ signals: [] });
  assert.equal(c.length, 0);
  const c2 = capabilityMap({ mcp: { ok: true, tools: [1] } });
  assert.ok(c2[0].evidence.includes('initialize'));
});
await t('recordRun/listRuns: 実行の記録が残る', async () => {
  const rows = [];
  const store = {
    run: async (sql, ...a) => { if (/INSERT/.test(sql)) rows.push(a); return { ok: true }; },
    all: async () => rows.map((a) => ({ id: a[0], target: a[1], kind: a[2], mode: a[3], state: a[4], score: a[5], caps: a[6], unknowns: a[7], at: a[9] })),
  };
  const id = await recordRun(store, { target: 'https://a.test', kind: 'web', mode: 'remote', state: 'done', score: 5, capabilities: [1, 2], unknown: [1], steps: [{ state: 'done' }] });
  assert.ok(id && id.startsWith('r_'));
  const list = await listRuns(store, 5);
  assert.equal(list.length, 1);
  assert.equal(list[0].state, 'done');
  assert.equal(list[0].caps, 2);
});
await t('守ることは空でない（禁止事項が仕様に入っている）', () => {
  assert.ok(GUARDRAILS.some((g) => g.includes('401/403')));
  assert.ok(GUARDRAILS.some((g) => g.includes('値は出さない')));
  assert.ok(LIMITS.some((l) => l.includes('実行')));
});
await t('CLI: --self-test が通り、ELF を解析できる', () => {
  const out = execFileSync('node', ['tools/rea-cli.mjs', '--self-test'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.ok(out.includes('"self_test": "ok"'));
  const elf = execFileSync('node', ['tools/rea-cli.mjs', '/usr/bin/ls', '--json'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(elf);
  assert.equal(j.kind, 'elf');
  assert.ok(j.capabilities.length >= 1);
  assert.ok(j.unknown.some((u) => u.includes('実行しない')));
});

console.log(`rea: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
