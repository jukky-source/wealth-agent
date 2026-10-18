// 公開「表面」解析 — 参考: morluto/rea（ローカルのアプリやバイナリを解析して機能を理解し、
// 自分の実装で作り直すための証拠を返すMCPツール）。ここでは対象を「公開されているWeb/APIの表面」
// だけに限定して移植する。認証回避・課金回避・コピープロテクト解除は実装しない（要件ではなく禁止）。
//
// 返すもの: そのサービスが公開している入口（エンドポイント・フォーム・フィード・MCPツール）と、
// それぞれの根拠（どの応答のどこに書いてあったか）、そして「分からなかったこと」。
// 分からないことを分からないと書くのが、この手のツールで一番価値がある部分。

export const SURFACE_VERSION = '1.0';
export const SURFACE_PRICE_USDC = 0.25;

export const GUARDRAILS = [
  '読むのは公開されている応答だけ（認証情報は使わない）',
  '401/403 は「要認証」と記録して止める。突破はしない',
  'robots.txt を尊重し、対象へのアクセスは1回ずつ',
  '再配布・再販はしない（出典URLを必ず残す）',
];

const UA = 'wealth-agent-surface/1.0 (+https://wealth-agent.wealthagent-app.workers.dev)';
const LIMITS = [
  'SPA の動的レンダリング後のDOMは取れない（初期HTMLとインラインJSのみ）',
  '認証後の内部APIは原理的に見えない',
  'エンドポイントは文字列としての出現であり、動作確認はしていない',
  'レート制限やbot判定で 403 になるサイトは解析できない',
];

export function normTarget(t = '') {
  let s = String(t || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); if (!u.hostname.includes('.')) return null; return u; } catch { return null; }
}

export function hostOf(u) { return typeof u === 'string' ? new URL(u).hostname : u.hostname; }

export function parseHead(html = '') {
  const title = (html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || '';
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,300})/i) || [])[1] || '';
  const gen = (html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{0,80})/i) || [])[1] || '';
  const signals = [];
  const add = (re, label) => { if (re.test(html)) signals.push(label); };
  add(/__NEXT_DATA__|_next\/static/, 'Next.js');
  add(/__NUXT__|_nuxt\//, 'Nuxt');
  add(/data-reactroot|react(-dom)?[@.\/]/, 'React');
  add(/vue(\.runtime)?[@.\/]|data-v-/, 'Vue');
  add(/svelte-/, 'Svelte');
  add(/wp-content|wp-json/, 'WordPress');
  add(/cdn\.shopify\.com|Shopify\.theme/, 'Shopify');
  add(/stripe\.com|js\.stripe\.com/, 'Stripe');
  add(/cloudflare|__cf_bm/, 'Cloudflare');
  add(/swagger-ui|redoc|openapi\.json|swagger\.json/, 'OpenAPI/Swagger の痕跡');
  add(/graphql|__typename/, 'GraphQL の痕跡');
  add(/rss\+xml|application\/atom\+xml/, 'フィード');
  add(/mcp|modelcontextprotocol/i, 'MCP の痕跡');
  add(/x402|PAYMENT-REQUIRED/i, 'x402 の痕跡');
  return { title: title.trim(), description: desc.trim(), generator: gen.trim(), signals: [...new Set(signals)] };
}

export function findEndpoints(text = '', origin = '') {
  const out = new Map();
  const re = /["'`](\/(?:api|v\d|graphql|rest|mcp|rpc|oauth|auth|admin|internal|_next\/data)[A-Za-z0-9_\-./{}$:?=&%]{0,120})["'`]/g;
  let m;
  while ((m = re.exec(text))) {
    const p = m[1].split('?')[0].replace(/\/$/, '');
    if (!p || p.length < 3) continue;
    if (/\.(png|jpg|jpeg|svg|webp|css|woff2?|ico|map)$/i.test(p)) continue;
    const k = p.toLowerCase();
    if (!out.has(k)) out.set(k, { path: p, evidence: 'ページ本文/JS内の文字列' });
  }
  const abs = /https?:\/\/[A-Za-z0-9._\-]+\/(?:api|v\d|graphql|rest|mcp)[A-Za-z0-9_\-./{}$:?=&%]{0,100}/g;
  while ((m = abs.exec(text))) {
    const p = m[0];
    if (origin && p.startsWith(origin)) continue;
    const k = p.toLowerCase().split('?')[0];
    if (!out.has(k)) out.set(k, { path: p.split('?')[0], evidence: '外部ホストへの参照', external: true });
  }
  return [...out.values()].slice(0, 40);
}

export function findForms(html = '') {
  const out = [];
  const re = /<form\b[^>]*>([\s\S]{0,3000}?)<\/form>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 10) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const action = (tag.match(/action=["']([^"']{0,200})["']/i) || [])[1] || '(同じURL)';
    const method = ((tag.match(/method=["']([^"']{0,10})["']/i) || [])[1] || 'get').toLowerCase();
    const fields = [...m[1].matchAll(/<input\b[^>]*name=["']([^"']{1,60})["']/gi)].map((x) => x[1]).slice(0, 12);
    out.push({ action, method, fields });
  }
  return out;
}

export function findFeeds(html = '') {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]+type=["']application\/(rss|atom)\+xml["'][^>]*>/gi)) {
    const href = (m[0].match(/href=["']([^"']{1,300})["']/i) || [])[1];
    if (href) out.push(href);
  }
  return [...new Set(out)].slice(0, 6);
}

// 対象が MCP サーバーなら、公開されている tools/list を読む（認証は使わない）。
export async function detectMcp(origin, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const out = { probed: true, ok: false, tools: [], server: null, protocolVersion: null };
  const post = async (body) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      const r = await fetchImpl(origin + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA }, body: JSON.stringify(body), signal: c.signal });
      if (!(r.status >= 200 && r.status < 300)) { out.status = r.status; return null; }
      return await r.json();
    } catch (e) { out.error = String(e && e.message || e).slice(0, 120); return null; } finally { clearTimeout(t); }
  };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'surface', version: SURFACE_VERSION } } });
  if (!init || !init.result) return out;
  out.ok = true;
  out.protocolVersion = init.result.protocolVersion || null;
  out.server = init.result.serverInfo || null;
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  out.tools = (list?.result?.tools || []).map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 160) }));
  return out;
}

async function get(url, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { redirect: 'follow', headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'user-agent': UA }, signal: c.signal });
    const ct = r.headers.get('content-type') || '';
    const body = ct.includes('json') || ct.includes('text') || ct.includes('html') || ct.includes('xml') ? (await r.text()).slice(0, 400000) : '';
    return { status: r.status, ct, body, server: r.headers.get('server') || '', finalUrl: r.url || url, x402: r.headers.get('PAYMENT-REQUIRED') || r.headers.get('payment-required') || '' };
  } catch (e) {
    return { status: 0, ct: '', body: '', server: '', finalUrl: url, error: String(e && e.message || e).slice(0, 140) };
  } finally { clearTimeout(t); }
}

export async function inspectSurface(target, { fetchImpl = fetch, now = null, checkMcp = true } = {}) {
  const at = now || new Date().toISOString();
  const u = normTarget(target);
  if (!u) return { ok: false, reason: 'URL が不正です', target: String(target || ''), at };
  const origin = u.origin;
  const root = await get(origin + '/', { fetchImpl });
  const s = {
    ok: true, at, target: origin, requested: u.href, version: SURFACE_VERSION,
    status: root.status, server: root.server, contentType: root.ct, finalUrl: root.finalUrl,
    auth: 'public', x402: !!root.x402, kind: 'web', signals: [], title: '', endpoints: [], forms: [], feeds: [], mcp: null, evidence: [], unknown: [], guardrails: GUARDRAILS, limits: LIMITS,
  };
  if (root.status === 401 || root.status === 403) { s.auth = 'auth_required'; s.kind = 'protected'; s.evidence.push(`GET ${origin}/ → ${root.status}（要認証。ここで止める）`); s.unknown.push('認証後の表面は取得していない'); return s; }
  if (root.status === 0) { s.ok = false; s.reason = root.error || '接続できません'; return s; }
  s.evidence.push(`GET ${origin}/ → ${root.status} ${root.ct || ''}`.trim());

  if ((root.ct || '').includes('json')) {
    s.kind = 'api';
    try { const j = JSON.parse(root.body); s.jsonKeys = Object.keys(j).slice(0, 20); s.evidence.push(`JSON のキー: ${s.jsonKeys.join(', ')}`); } catch {}
    s.endpoints = findEndpoints(root.body, origin);
  } else {
    const h = parseHead(root.body);
    s.title = h.title; s.description = h.description; s.generator = h.generator; s.signals = h.signals;
    s.endpoints = findEndpoints(root.body, origin);
    s.forms = findForms(root.body);
    s.feeds = findFeeds(root.body);
    if (s.signals.includes('OpenAPI/Swagger の痕跡')) s.kind = 'documented-api';
    else if (s.signals.includes('Shopify')) s.kind = 'commerce';
    else if (s.signals.includes('WordPress')) s.kind = 'cms';
  }

  // 定番の公開メタ（あるものだけ・無ければ unknown に残す）
  const probes = [['/robots.txt', 'robots'], ['/sitemap.xml', 'sitemap'], ['/openapi.json', 'openapi'], ['/swagger.json', 'swagger']];
  for (const [p, label] of probes) {
    const r = await get(origin + p, { fetchImpl, timeoutMs: 7000 });
    if (r.status === 200 && r.body.trim()) { s[label] = { url: origin + p, bytes: r.body.length, head: r.body.slice(0, 200).replace(/\s+/g, ' ').trim() }; s.evidence.push(`GET ${p} → 200（${r.body.length} bytes）`); }
    else s.unknown.push(`${p} は取得できず（${r.status || 'err'}）`);
  }
  if (s.robots && /disallow:\s*\/\s*$/im.test(s.robots.head)) { s.robotsBlocks = true; s.unknown.push('robots.txt が全体を Disallow している'); }

  if (checkMcp) {
    const m = await detectMcp(origin, { fetchImpl });
    s.mcp = m;
    if (m.ok) { s.kind = 'mcp'; s.signals = [...new Set([...s.signals, 'MCP'])]; s.evidence.push(`POST /mcp initialize → 200（${m.server?.name || '?'} / tools ${m.tools.length}件）`); }
    else s.unknown.push(`/mcp は応答せず（${m.status || m.error || 'no result'}）`);
  }
  if (!s.endpoints.length) s.unknown.push('エンドポイントの文字列は見つからなかった（動的レンダリングの可能性）');
  if (!s.forms.length) s.unknown.push('フォームは見つからなかった');
  s.score = surfaceScore(s);
  return s;
}

export function surfaceScore(s = {}) {
  let n = 0;
  if (s.ok) n += 1;
  if (s.kind === 'mcp' || s.kind === 'documented-api') n += 3;
  else if (s.kind === 'api') n += 2;
  if (s.endpoints?.length) n += Math.min(3, s.endpoints.length);
  if (s.openapi || s.swagger) n += 3;
  if (s.feeds?.length) n += 1;
  if (s.forms?.length) n += 1;
  if (s.robots) n += 1;
  if (s.signals?.length) n += 1;
  return Math.min(10, n);
}

export function surfaceBrief(s = {}, { full = false } = {}) {
  if (!s.ok) return `解析できませんでした: ${s.reason || '不明'}（対象 ${s.target || ''}）`;
  const L = [];
  L.push(`# ${s.title || s.target}`);
  L.push(`対象: ${s.target} ／ 判定: ${s.kind} ／ 完成度: ${s.score}/10 ／ 認証: ${s.auth}`);
  if (s.description) L.push(`説明: ${s.description}`);
  if (s.server) L.push(`サーバー: ${s.server}`);
  if (s.signals?.length) L.push(`痕跡: ${s.signals.join(' / ')}`);
  if (s.mcp?.ok) L.push(`MCP: ${s.mcp.server?.name || '?'} v${s.mcp.server?.version || '?'} / ツール ${s.mcp.tools.length}件${s.mcp.tools.length ? ' → ' + s.mcp.tools.slice(0, full ? 40 : 6).map((t) => t.name).join(', ') : ''}`);
  if (s.endpoints?.length) L.push(`入口の候補 ${s.endpoints.length}件:\n` + s.endpoints.slice(0, full ? 40 : 8).map((e) => `  - ${e.path}${e.external ? '（外部）' : ''} 〔${e.evidence}〕`).join('\n'));
  if (s.forms?.length) L.push(`フォーム ${s.forms.length}件:\n` + s.forms.slice(0, full ? 10 : 3).map((f) => `  - ${f.method.toUpperCase()} ${f.action} ${f.fields.length ? '(' + f.fields.join(', ') + ')' : ''}`).join('\n'));
  if (s.feeds?.length) L.push(`フィード: ${s.feeds.join(', ')}`);
  if (s.openapi) L.push(`OpenAPI: ${s.openapi.url}`);
  if (s.robots) L.push(`robots.txt: ${s.robots.url}`);
  L.push(`\n## 根拠\n` + s.evidence.map((e) => `- ${e}`).join('\n'));
  L.push(`\n## 分からなかったこと\n` + (s.unknown?.length ? s.unknown.map((e) => `- ${e}`).join('\n') : '- 特になし'));
  L.push(`\n## この道具が守ること\n` + GUARDRAILS.map((g) => `- ${g}`).join('\n'));
  L.push(`\n## 限界\n` + LIMITS.map((g) => `- ${g}`).join('\n'));
  if (!full) L.push(`\n（無料版は要約。全エンドポイント・全フォーム・MCPツール全件・根拠の全文は有料版 ${SURFACE_PRICE_USDC} USDC）`);
  return L.join('\n');
}

export function surfaceHelp() {
  return [
    '公開表面の解析（無料・要約）',
    '  使い方: GET /api/surface?url=https://example.com',
    '  返るもの: そのサイトが公開している入口（エンドポイント候補・フォーム・フィード・MCPツール）と根拠、そして分からなかったこと。',
    '  有料版: 0.25 USDC（x402）。全件＋根拠の全文＋実装メモ。',
    '禁止: 認証回避・課金回避・コピープロテクト解除。401/403 は記録して止める。',
  ].join('\n');
}

export function surfaceText(s = {}, { full = false } = {}) { return surfaceBrief(s, { full }); }
