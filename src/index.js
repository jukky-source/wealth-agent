// Worker entry point — routing, auth, cron, and dependency wiring.
// Runs identically on Cloudflare Workers and on the local Node dev server
// (server/local.mjs) because everything here is web-standard.

import { Store, ensureSchema } from './db.js';
import { validateOrder as _preValidate } from './agent/fulfill.js';
import { AIRouter } from './ai/router.js';
import { Memory } from './memory/memory.js';
import { createResearch } from './research/web.js';
import { createDeepResearch } from './research/deep.js';
import { createKnowledge } from './research/knowledge.js';
import { createDataAnalysis } from './data/analyze.js';
import { createCodeAgent } from './code/agent.js';
import { createBrowser } from './browser/agent.js';
import { createWorkflows } from './workflow/workflow.js';
import { createRewards } from './income/rewards.js';
import { createSideHustle } from './income/sidehustle.js';
import { createRanking } from './income/ranking.js';
import { buildTools } from './engine/tools.js';
import { createEngine } from './engine/engine.js';
import { createScheduler } from './scheduler.js';
import { createApi } from './api.js';
import * as fxModule from './income/fx.js';
import { createImageGen } from './ai/imagegen.js';
import { createFleet } from './engine/fleet.js';
import { createRunner } from './runner/queue.js';
import { marketSnapshot } from './agent/markets.js';
import { venueBoard, venueCounts, venueAutoQueue, venueHumanQueue, venueBoardText, venueSnapshotLoad, probeVenues, venueRegistryPlan } from './agent/venues.js';
import { freeInference, laneStatus } from './agent/inference.js';
import { skillCatalog, agentsJson } from './agent/skillpacks.js';

const wiredByEnv = new WeakMap();
const schemaDone = new WeakSet();

function wire(env) {
  const cached = wiredByEnv.get(env);
  if (cached) return cached;
  const store = new Store(env.DB);
  const router = new AIRouter(store, env);
  const memory = new Memory(store);
  const research = createResearch(env);
  const deepResearch = createDeepResearch({ store, router, research, memory });
  const knowledge = createKnowledge({ store, router });
  const dataAnalysis = createDataAnalysis({ store });
  const codeAgent = createCodeAgent({ store, router });
  const browser = createBrowser({ store, research });
  const workflows = null; // wired below — workflows depend on the tool registry

  const rewards = createRewards({ store, router, research, memory });
  const sidehustle = createSideHustle({ store, router, research, memory });
  const ranking = createRanking({ store, memory });
  const imagegen = createImageGen({ env, store, router });
  const fx = fxModule;

  const tools = buildTools({
    store, env, router, memory, research, fx, rewards, sidehustle, ranking,
    knowledge, dataAnalysis, codeAgent, browser,
  });
  const workflowEngine = createWorkflows({ store, tools, memory });

  const engine = createEngine({
    store, env, router, memory, research, deepResearch, fx, rewards, sidehustle,
    ranking, knowledge, dataAnalysis, codeAgent, browser, workflows: workflowEngine, tools,
  });

  const fleet = createFleet({ store, env, engine, memory, router });
  const runner = createRunner({ store, env });

  const scheduler = createScheduler({ store, env, engine, memory, ranking, workflows: workflowEngine, router, research, fleet });

  const api = createApi({
    store, env, engine, router, memory, tools, research, deepResearch, knowledge,
    dataAnalysis, codeAgent, browser, workflows: workflowEngine, fx, rewards, sidehustle, ranking, scheduler, imagegen, fleet, runner,
  });

  const w = { store, env, router, memory, research, deepResearch, knowledge, dataAnalysis, codeAgent, browser, workflows: workflowEngine, rewards, sidehustle, ranking, engine, scheduler, api, tools, fx, imagegen, fleet, runner };
  wiredByEnv.set(env, w);
  return w;
}

// ブラウザで動く買い手エージェントが値札とレシートを読めるように、支払いヘッダを CORS で見せる。
const PAY_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,payment-signature,x-payment',
  'access-control-expose-headers': 'PAYMENT-REQUIRED,PAYMENT-RESPONSE,X-PAYMENT-RESPONSE,WWW-Authenticate',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type,payment-signature,x-payment',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-expose-headers': 'PAYMENT-REQUIRED,PAYMENT-RESPONSE,X-PAYMENT-RESPONSE,WWW-Authenticate',
      ...extraHeaders,
    },
  });
}

function authorized(req, env) {
  if (!env.OWNER_TOKEN && !env.RUNNER_TOKEN) return true; // local/dev mode — no token configured
  const h = req.headers.get('authorization') || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (token && env.OWNER_TOKEN && token === env.OWNER_TOKEN) return true;
  // A paired cloud machine authenticates with its own token, and only against
  // the runner endpoints — never against the rest of the owner API.
  if (token && env.RUNNER_TOKEN && token === env.RUNNER_TOKEN) {
    return new URL(req.url).pathname.startsWith('/api/runner');
  }
  const url = new URL(req.url);
  const q = url.searchParams.get('token');
  return !!q && q === env.OWNER_TOKEN;
}

function matchRoute(routes, method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const parts = r.pattern.split('/');
    const segs = pathname.split('/');
    if (parts.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(segs[i]);
      else if (parts[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    // 自律価格レバー（grow-1.0）: D1 に置いた値札の上書きを、値札を出す前に env へ注入する。
    // 上書きが読めなければカタログ価格のまま（下げる方向のみ・原価0）。D1 だけを見るので軽い。
    try {
      if (env && env.DB && request.url.indexOf('/api/x402') !== -1) {
        const _po = await env.DB.prepare("SELECT value FROM settings WHERE key='grow:price_json'").first();
        // 自律で作った品（market-1.0 が出品したもの）を env に載せる。カタログはコードのまま、
        // 生成物だけをデータで足す。読み取りに失敗しても固定品だけで動く（何も足さない）。
        if (!env.X402_EXTRA_CATALOG) {
          try {
            const _er = await env.DB.prepare("SELECT value FROM settings WHERE key='x402:extra_catalog'").first();
            let _val = _er && _er.value;
            for (let k = 0; k < 2 && typeof _val === 'string'; k++) { try { _val = JSON.parse(_val); } catch { break; } }
            if (Array.isArray(_val) && _val.length) env = { ...env, X402_EXTRA_CATALOG: JSON.stringify(_val) };
          } catch { /* 足せなくても固定品は売れる */ }
        }
        if (_po && _po.value) env = { ...env, X402_OVERRIDES: _po.value };
      }
    } catch { /* 読めなければカタログ価格で続行 */ }

    const url = new URL(request.url);
    // テスト専用: /api/x402-testnet/<品目> はテスト網(Base Sepolia)+金額0で決済経路だけを実測する。
    // X402_TESTNET_ENABLED=1 のときだけ開く（本番は 0 で 404）。本番の /api/x402/ は一切変わらない。
    if (url.pathname.startsWith('/api/x402-testnet/')) {
      if (env.X402_TESTNET_ENABLED !== '1') return json({ ok: false, error: 'testnet_disabled' }, 404);
      env = { ...env, X402_NETWORK: env.X402_TEST_NETWORK || 'base-sepolia', X402_MULTICHAIN: '0',
        X402_FACILITATOR_URL: env.X402_TESTNET_FACILITATOR || 'https://facilitator.payai.network',
        X402_TESTNET: '1', X402_TEST_AMOUNT: String(env.X402_TEST_AMOUNT ?? '0') };
    }

    // CORS preflight
    if (request.method === 'OPTIONS') return json({ ok: true }, 204);

    // 買い手（不特定のエージェント）向けの公開カタログ。秘密は含めない。
    if (url.pathname === '/.well-known/agent.json' || url.pathname === '/.well-known/agent-card.json' || url.pathname === '/.well-known/agents.json') {
      try {
        const { agentCard, agentsIndex } = await import('./agent/a2a.js');
        const card = agentCard(env, url.origin);
        const body = url.pathname === '/.well-known/agents.json' ? agentsIndex(card) : card;
        return new Response(JSON.stringify(body, null, 2), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: 'card_error', detail: String(e && e.message || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }
    // 発見面（機械が読む入口）。中身は discovery.js に集約し、値段は必ずカタログから読む。
    if (url.pathname === '/api/markets' && request.method === 'GET') {
      const _env = typeof env !== 'undefined' ? env : {};
      const snap = await marketSnapshot(_env);
      return new Response(JSON.stringify(snap, null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/.well-known/x402' || url.pathname === '/.well-known/x402.json' || url.pathname === '/api/x402/catalog.json') {
      // 外部クローラ（x402scan）は /.well-known/x402 を「発見の入口」として読む。
      // 仕様の形（version / resources / ownershipProofs）で返し、詳細は .json に残す。
      if (url.pathname === '/.well-known/x402') {
        const { discoveryFeed } = await import('./agent/x402.js');
        const feed = discoveryFeed(env, url.origin);
        const body = { ...feed, provider: env.AGENT_NAME || 'Wealth Agent', catalog: `${url.origin}/.well-known/x402.json`, openapi: `${url.origin}/openapi.json` };
        return new Response(JSON.stringify(body, null, 2), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });
      }
      const { discoveryManifest } = await import('./agent/discovery.js');
      return json(discoveryManifest(env, url.origin), 200, { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
    }
    // 有料ルートの機械可読な契約（x402scan / @agentcash/discovery はここを読む）。
    if (url.pathname === '/openapi.json') {
      const { openapi } = await import('./agent/discovery.js');
      return json(openapi(env, url.origin), 200, { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
    }

    // AI クローラ向けの説明。人手を介さずに「見つけてもらう」ための面。
    if (url.pathname === '/llms.txt') {
      const origin = url.origin;
      // 品目の一覧はカタログから作る。値札を変えても品目を足しても、ここが古くならない。
      const { X402_CATALOG, LISTING, INPUT_EXAMPLES, usdLabel } = await import('./agent/x402.js');
      const menu = X402_CATALOG.map((it) => {
        const usd = usdLabel(it.price_usdc);
        const body = JSON.stringify(INPUT_EXAMPLES[it.resource] || {});
        return `- POST ${origin}/api/x402/${it.resource} — ${usd} USDC. ${it.description} body: ${body}`;
      }).join('\n');
      // 無料枠（決定的4品目）。そのまま叩けるURLを例つきで出す＝読んだ側が即呼べる。
      const freeMenu = X402_CATALOG.filter((it) => it.free_tier).map((it) => {
        const ex = Object.entries(INPUT_EXAMPLES[it.resource] || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
        return `- GET ${origin}/api/free/${it.resource}?${ex} — free. ${it.description}`;
      }).join('\n');
      const txt = `# ${env.AGENT_NAME || 'Wealth Agent'}

> Pay-per-call HTTP APIs for AI agents, settled in USDC over x402 (HTTP 402). No account signup and no API key.

## Try for free (no payment, no account; per-IP and per-UTC-day limits)
- GET ${origin}/api/free — the free tier, with copy-paste ready examples
${freeMenu}

## Buy per call (POST, priced in USDC, ${X402_CATALOG.length} tools)
${menu}

The free tier only covers deterministic tools that use no model, which is why it can exist at zero marginal cost.
Once you hit the limit, call the same tool at /api/x402/ with a PAYMENT-SIGNATURE header (x402 v2 / USDC) for
unmetered use. url-meta fetches public pages only and never internal addresses.

Payment is the PAYMENT-SIGNATURE header (x402 v2, exact scheme). Supported chains: Base / Arbitrum / Polygon / Avalanche / Sei / X Layer (USDC) / Solana.

## Discovery
- ${origin}/.well-known/x402 — catalog with price, payTo and networks
- ${origin}/openapi.json — OpenAPI 3.1 with per-route x-payment-info (price, asset, payTo, network)
- ${origin}/agents.json — agent card (machine-readable). Read order: /robots.txt -> /.well-known/x402 -> /openapi.json -> /agents.json -> /llms.txt
- ${origin}/api/skills/catalog.json — mapping to free agent skills (zero cost)
- ${origin}/.well-known/agent-registration.json — ERC-8004 agent registration file
- ${origin}/.well-known/ai-tool/wealth-agent-<resource>.json — ERC-8257 tool manifests (price and payTo declared as CAIP-19/CAIP-10)
- ${origin}/.well-known/mcp/server-card.json — MCP server card
- ${origin}/api/x402/discovery/resources — resource list
- ${origin}/.well-known/agent-card.json — A2A agent card
- ${origin}/api/a2a , ${origin}/api/mcp — agent-to-agent protocols
`;
      return new Response(txt, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });
    }
    // MCP の登録所（公式レジストリ・集約サイト）が読むメタデータ。SPA の index.html を
    // 返してしまうと誤登録されるので、専用の JSON を返す。
    if (url.pathname === '/server.json') {
      // このブロックは origin を自分で束縛する。外側のスコープの origin は null のままなので、
      // 拾うと remotes[].url が "null/mcp" になり、集約サイトが壊れた入口を登録してしまう。
      const origin = url.origin;
      const body = {
        // 公式レジストリに公開済みの名前空間と一致させる（GitHub 認証で検証済みの名前）。
        // ここで別名を名乗ると、集約サイトが「どの登録が本物か」を判断できなくなる。
        name: 'io.github.jukky-source/wealth-agent',
        title: 'Wealth Agent — paid research, data cleaning and code review for agents',
        description: 'Remote MCP server selling agent-native services over x402 (USDC): a sourced research brief, CSV/TSV table cleaning, static code review, plus cheap deterministic tools (regex extract, text diff, CSV<->JSON, URL metadata). Payment is per call; no account or API key is required.',
        version: '1.0.0',
        websiteUrl: origin,
        remotes: [{ type: 'streamable-http', url: `${origin}/mcp` }],
        _meta: { publishedBy: 'the service operator', payment: 'x402 v2 (USDC, scheme exact)', freeTools: ['list_services'] },
      };
      return new Response(JSON.stringify(body, null, 2), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' } });
    }
    if (url.pathname === '/sitemap.xml') {
      const origin = url.origin;
      const { X402_CATALOG: CAT_S} = await import('./agent/x402.js');
      const urls = ['/', '/llms.txt', '/agents.json', '/x402-index', '/grow', '/api/xindex/summary', '/api/xindex/hosts', '/api/grow/public', '/api/skills/catalog.json', '/.well-known/x402', '/openapi.json', ...CAT_S.map((it) => `/api/x402/${it.resource}`)];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${origin}${u}</loc></url>`).join('\n')}\n</urlset>\n`;
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
    }
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /\n\n# Crawler read order: /robots.txt -> /.well-known/x402 -> /openapi.json -> /agents.json -> /llms.txt\n# AI agents / buyers: /llms.txt, /openapi.json, /.well-known/x402.json, /agents.json, /api/skills/catalog.json\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
    }

    // /mcp と /a2a は「プロトコルの入口」なので、SPA のフォールバックより先に通す。
    // ここを後ろに置くと、GET は index.html・POST は 405 が返り、自分で宣伝している
    // エンドポイントが永久に到達不能になる（実際にそうなっていた）。
    // ------------------------------------------------ /v1 — マーケット出品用の入口
    // ねらい: RapidAPI など「集客を任せられる売り場」からそのまま呼べる形にする。
    //   ① 売り場経由 : X-RapidAPI-Proxy-Secret を照合（課金は売り場側が完了している）
    //   ② 直販       : PAYMENT-SIGNATURE ヘッダ（既存の /api/x402/<品目> と同じ値札・同じ決済）
    //   ③ 自分の確認 : OWNER_TOKEN
    // 入金は売り場の報告（/api/webhooks/rapidapi）で記録する。ここでは台帳に二重計上しない。
    if (url.pathname === '/v1/openapi.json' || url.pathname === '/v1/openapi') {
      // 売り場（RapidAPI 等）に読み込ませる spec。
      // ここだけ paths を `/v1/<品目>` に張り替える（/openapi.json は x402 の発見用に
      // `/api/x402/<品目>` のまま残す。役割が違うので同じ形にはしない）。
      const { openapi } = await import('./agent/discovery.js');
      const spec = openapi(env, url.origin);
      const paths = {};
      for (const [k, v] of Object.entries(spec.paths || {})) paths[`/${k.replace(/^\/api\/x402\//, '')}`] = v;
      return json({
        ...spec,
        servers: [{ url: `${url.origin}/v1` }],
        paths,
        components: {
          ...(spec.components || {}),
          securitySchemes: { RapidApiProxySecret: { type: 'apiKey', in: 'header', name: 'X-RapidAPI-Proxy-Secret' } },
        },
      });
    }
    if (url.pathname.startsWith('/v1/')) {
      const x = await import('./agent/x402.js');
      const resource = url.pathname.slice(4).replace(/\/+$/, '');
      const item = x.X402_CATALOG.find((i) => i.resource === resource);
      if (!item) return json({ ok: false, error: 'unknown_resource', available: x.X402_CATALOG.map((i) => i.resource) }, 404);
      const secret = env.RAPIDAPI_PROXY_SECRET || null;
      const provided = request.headers.get('X-RapidAPI-Proxy-Secret') || '';
      const viaMarket = !!secret && provided === secret;
      const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const viaOwner = !!env.OWNER_TOKEN && bearer === env.OWNER_TOKEN;
      const body = (request.method === 'POST' || request.method === 'PUT') ? await request.json().catch(() => ({})) : {};
      const fm = await import('./agent/fulfill.js');
      const fulfill = fm.fulfillOrder;
      // code-review / brief は AI と保存領域を使う。{} を渡すと決定的な4品目しか動かず、
      // いちばん高い2品目（$0.75 / $0.25）が落ちる。本体と同じ配線を渡す。
      let vdeps = {};
      try { vdeps = wire(env); } catch { vdeps = {}; }
      if (!viaMarket && !viaOwner) {
        const pay = request.headers.get('PAYMENT-SIGNATURE') || request.headers.get('X-PAYMENT') || '';
        if (pay) {
          const pf = await x.preflight(env).catch(() => ({ ok: false }));
          const settled = await x.verifyAndSettle({ env, resource, paymentHeader: pay, feePayer: pf?.feePayer || null });
          if (!settled.ok) return json({ ok: false, error: settled.error, detail: settled.detail || null }, 402);
          let paidDone = { ok: false, error: 'fulfill_missing' };
          if (typeof fulfill === 'function') {
            try { paidDone = await fulfill(resource, body, vdeps); } catch (e) { paidDone = { ok: false, error: 'fulfill_failed', reason: String((e && e.message) || e) }; }
          }
          const paidInner = paidDone && paidDone.deliverable && typeof paidDone.deliverable === 'object' ? paidDone.deliverable : paidDone;
          return json({ ok: !!paidDone.ok, resource, paid: true, tx: settled.tx || null, result: paidInner, error: (paidDone && paidDone.error) || undefined });
        }
        const pf = await x.preflight(env).catch(() => ({ ok: false }));
        const ch = x.challenge(resource, env, { origin: url.origin, feePayer: pf?.feePayer || null, solanaFeePayer: pf?.solanaFeePayer || null });
        return json({ ok: false, error: 'payment_required', price_usdc: item.price_usdc, how: 'POST with X-RapidAPI-Proxy-Secret header (marketplace) or PAYMENT-SIGNATURE header (x402/USDC)', price: ch?.body || null }, 402);
      }
      if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed', use: 'POST' }, 405);
      if (typeof fulfill !== 'function') return json({ ok: false, error: 'fulfill_missing' }, 500);
      let done;
      try { done = await fulfill(resource, body, vdeps); }
      catch (e) { done = { ok: false, error: 'fulfill_failed', reason: String((e && e.message) || e) }; }
      // 売り場には1階層で返す（入れ子の ok は読み手が誤解する）。
      const inner = done && done.deliverable && typeof done.deliverable === 'object' ? done.deliverable : done;
      return json({
        ok: !!done.ok, resource, price_usdc: item.price_usdc,
        via: viaMarket ? 'rapidapi' : 'owner',
        buyer: request.headers.get('X-RapidAPI-User') || null,
        result: inner, error: (done && done.error) || undefined,
      });
    }
    // 無料枠（フリーミアム）— 決定的で原価ゼロの4品目だけを、支払いなしで試せる入口。
    // 有料の /api/x402/ はそのまま。上限に達したら 402 に切り替わり、有料の入口になる。
    if (url.pathname === '/api/free' || url.pathname.startsWith('/api/free/')) {
      const { handleFree } = await import('./agent/freemium.js');
      let fdeps = {};
      try { fdeps = wire(env); } catch { fdeps = {}; }
      return handleFree(request, env, url, fdeps);
    }

    if (!url.pathname.startsWith('/api/') && url.pathname !== '/mcp' && url.pathname !== '/a2a' && url.pathname !== '/agents.json') {
      // Static PWA assets (Cloudflare): fall back to the index for SPA routes.
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        if (url.pathname === '/today.json') {
          const { todayDigest } = await import('./agent/today.js');
          let store = null;
          try { store = wire(env).store; } catch {}
          return new Response(JSON.stringify(await todayDigest(store, { publicOnly: true })), { headers: { 'content-type': 'application/json; charset=utf-8' } });
        }
        const PRETTY = {
  '/bounty': '/bounty.html',
  '/digest': '/digest.html', '/today': '/today.html', '/surface': '/surface.html', '/rea': '/rea.html', '/loop': '/loop.html', '/lab': '/lab.html', '/improve': '/improve.html', '/sales': '/sales', '/hunt': '/hunt' };
        const pretty = PRETTY[url.pathname] || url.pathname;
        const res = await env.ASSETS.fetch(pretty === url.pathname ? request : new Request(new URL(pretty, url.origin).toString(), request));
        if (res.status === 404) {
          const indexUrl = new URL('/index.html', url.origin);
          return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
        }
        return res;
      }
      return new Response('Not found', { status: 404 });
    }

    const deps = wire(env);

    // --- エージェント間販売（AIがAIに売る）の公開エンドポイント。認証不要 ---
    if (url.pathname === '/a2a' || url.pathname === '/api/a2a') { const { handleA2a } = await import('./agent/a2a.js'); return handleA2a(request, env, url, deps); }
    if (url.pathname === '/mcp' || url.pathname === '/api/mcp') { const { handleMcp } = await import('./agent/mcp.js'); return handleMcp(request, env, url, deps); }
    if (url.pathname === '/api/x402/discovery/resources') {
      const { discoveryFeed } = await import('./agent/x402.js');
      return new Response(JSON.stringify(discoveryFeed(env, url.origin)), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } });
    }
    try {
      if (!schemaDone.has(env)) {
        // 冷えた isolate ごとに全 DDL（約35文）を流すと 13〜15 秒かかる。
        // 既存テーブルの有無だけを 1 往復で安く確かめ、無いときだけ DDL を流す。
        let ready = false;
        try {
          const probe = await deps.store.first('SELECT COUNT(*) AS n FROM missions');
          ready = !!probe;
        } catch { ready = false; }
        if (!ready) await ensureSchema(deps.store);
        schemaDone.add(env);
      }
    } catch (e) {
      return json({ ok: false, error: 'db_unavailable', detail: String(e.message || e) }, 500);
    }

    // 決済プロバイダの通知は、こちらのトークンではなく署名で本人性を確認する。
    // 認証の外に置く代わりに、検証できない通知は入金として記録しない。
    const isWebhook = url.pathname.startsWith('/api/webhooks/');
    // 売り物（/api/x402/<資源>）は、決済そのものが入場資格なのでトークンでは塞がない。
    // 買い手は不特定のエージェントなので、ここを塞ぐと誰も買えなくなる。カタログは塞ぐ。
    const isPaywall = url.pathname.startsWith('/api/x402-testnet/') || url.pathname.startsWith('/api/x402/') && !url.pathname.startsWith('/api/x402/catalog');
    // 端末の再ペアリング: 期限つき・1回だけのコードを持っている人にトークンを渡す口。
    // トークンを知らない端末が入る唯一の経路なので、コード側で失効・回数制限を持つ。
    const isPairing = url.pathname === '/api/pair';
    // 無料枠も「不特定の買い手」向け。トークンでは塞がない（塞ぐと誰も試せない）。
    const isFreeTier = url.pathname === '/api/free' || url.pathname.startsWith('/api/free/');
    if (!isWebhook && !isPaywall && !isPairing && !isFreeTier && !authorized(request, env)) {
      const OPEN = ['/api/surface', '/api/surface/help', '/api/today/public', '/api/rea', '/api/rea/help', '/api/rea/plan', '/api/rea/runs', '/api/loop/public', '/api/lab/loop/public', '/api/improve/public', '/api/sales/public', '/api/hunt/public', '/api/contact', '/api/grow/public', '/api/market', '/api/market/public', '/api/frontier/public', '/api/repos/public', '/api/direct/public', '/api/ideas', '/api/listings/public', '/api/venues/public', '/api/grow/help', '/api/hunt/help', '/api/sales/help', '/api/loop/help', '/api/improve/help', '/api/kpi', '/api/kpi/public', '/api/discwatch/public', '/api/xindex/summary', '/api/xindex/hosts', '/api/xindex/help', '/api/rea/queue', '/api/selfreport', '/api/skills/catalog', '/api/skills/catalog.json', '/api/digest/public', '/api/bounty/public', '/agents.json'];
      if (!OPEN.includes(url.pathname)) return json({ ok: false, error: 'unauthorized', hint: 'Authorization: Bearer <OWNER_TOKEN> が必要です' }, 401);
    }

    // 自己診断: この実行環境（Cloudflare の egress）から検索経路が実際に何を返すかを測る。
    // 出典0件＝中身のない brief を納品してしまう不具合を切り分けるための計器。オーナートークン必須。
    // 停滞回収をその場で走らせる（オーナー専用）。周期を待たずに結果を確認するための計器。
    if (url.pathname === '/api/diag/free-inference') {
      const _env = typeof env !== 'undefined' ? env : {};
      const _h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
      if (request.method === 'GET') {
        return new Response(JSON.stringify({ lanes: laneStatus(_env) }, null, 2), { status: 200, headers: _h });
      }
      let _p = {};
      try { _p = await request.json(); } catch {}
      const _out = await freeInference(String(_p.prompt || ''), _env, _p);
      return new Response(JSON.stringify(_out, null, 2), { status: _out.ok ? 200 : 503, headers: _h });
    }

    if (url.pathname === '/api/diag/reap' && (request.method === 'GET' || request.method === 'POST')) {
      try {
        const { reapStaleTasks } = await import('./engine/reaper.js');
        return json({ ok: true, ...(await reapStaleTasks(deps.store, env)) });
      } catch (e) {
        return json({ ok: false, error: 'reap_failed', detail: String((e && e.message) || e).slice(0, 300) }, 500);
      }
    }

    // 計画を立て直して、稼ぎ方の採点結果が実行タスクに繋がることをその場で確かめる計器（オーナー専用）。
    if (url.pathname === '/api/diag/plan' && (request.method === 'GET' || request.method === 'POST')) {
      try {
        const noAi = { availableProviders: () => [], complete: async () => ({ ok: false }) };
        const id = url.searchParams.get('id') || 'msn_stream_x402';
        const mission = await deps.store.get('missions', id);
        if (!mission) return json({ ok: false, error: 'mission_not_found', id }, 404);
        const existingTasks = await deps.store.all(`SELECT id,title,state FROM tasks WHERE mission_id=?`, mission.id);
        const { planMission } = await import('./engine/planner.js');
        const character = deps.engine && deps.engine.getCharacter ? await deps.engine.getCharacter().catch(() => null) : null;
        const out = await planMission({ store: deps.store, router: noAi, memory: deps.memory, character, mission, existingTasks });
        return json({ ok: true, mission: { id: mission.id, title: mission.title }, created: (out.created || []).map((t) => ({ id: t.id, title: t.title, tool: t.tool_name, category: t.category })), note: out.note || null });
      } catch (e) {
        return json({ ok: false, error: 'plan_diag_failed', detail: String((e && e.message) || e).slice(0, 300) }, 500);
      }
    }

    // 稼ぎ方が候補として採点されているかをその場で見る計器（オーナー専用）。
    if (url.pathname === '/api/diag/rank' && (request.method === 'GET' || request.method === 'POST')) {
      try {
        const { ensureLaneOpportunities } = await import('./income/lanes.js');
        const seeded = await ensureLaneOpportunities({ store: deps.store, origin: url.origin });
        // 素性を入れただけでなく、実際に採点まで通した結果を見せる。
        let ranked = null;
        let recalibrated = null;
        try {
          let rk = deps.ranking;
          if (!rk || typeof rk.rank !== 'function') {
            const { createRanking } = await import('./income/ranking.js');
            rk = createRanking({ store: deps.store, memory: deps.memory || { guardrails: async () => [] } });
          }
          // 実測の入金（実際に売れた事実）を先に反映してから採点する。
          if (typeof rk.recalibrate === 'function') { try { recalibrated = await rk.recalibrate(deps.store, {}); } catch { recalibrated = null; } }
          ranked = await rk.rank(deps.store, { persist: true });
        } catch { ranked = null; }
        const rows = await deps.store.all("SELECT id,domain,name,score,revenue_basis,est_monthly_revenue FROM opportunities ORDER BY score DESC LIMIT 20");
        const last = await deps.store.first("SELECT value FROM settings WHERE key='ranking:last'").catch(() => null);
        return json({ ok: true, seeded, ranked: rows.length, rows, ranking: ranked ? { total: ranked.total, allocation: ranked.allocation } : null, recalibrated, last: last && last.value ? JSON.parse(last.value) : null });
      } catch (e) {
        return json({ ok: false, error: 'rank_diag_failed', detail: String((e && e.message) || e).slice(0, 300) }, 500);
      }
    }

    // Logic space（論理空間）の計器。オーナー専用。
    //   GET  : 空間の広さ・どこまで見たか・上位の論理
    //   POST : その場で数件だけ回す（周期を待たない確認用）
    if (url.pathname === '/api/fxlab/logic' || url.pathname === '/api/diag/logic') {
      try {
        const _env = typeof env !== 'undefined' ? env : {};
        const { logicSpaceInfo, logicTick, spaceReport } = await import('./income/logic.js');
        if (request.method === 'POST') {
          let body = {};
          try { body = await request.json(); } catch {}
          const n = Math.max(1, Math.min(12, Number(body?.n || url.searchParams.get('n') || 3)));
          const r = await logicTick({ store: deps.store, env: _env, n });
          return json({ ok: true, ran: r.ran, tier: r.tier, coverage_pct: r.coverage_pct, cursor: r.cursor, experiments: r.experiments, robust: r.robust || null, promoted: r.promoted ? { name: r.promoted.name, id: r.promoted.id } : null, champion: r.champion ? { symbol: r.champion.symbol, fitness: r.champion.fitness, verified: !!r.champion.verified, logic: r.champion.logic_line || null } : null });
        }
        return json({ ok: true, plan: spaceReport(_env), space: await logicSpaceInfo(deps.store, _env) });
      } catch (e) {
        return json({ ok: false, error: 'logic_diag_failed', detail: String((e && e.message) || e).slice(0, 300) }, 500);
      }
    }

    // プロップファーム選考と自己資金運用の計器（オーナー専用）。
    // 各社のルール（利益目標・日次損失・最大損失・最低取引日数）に、実データの損益列を当てて
    // 合格率・合格までの日数・合格後の月次報酬を出す。重い処理なのでWorker上で回す。
    if (url.pathname === '/api/diag/prop' || url.pathname === '/api/prop') {
      try {
        const { buildPropReport, propHelp } = await import('./income/propReport.js');
        if (request.method === 'GET' && url.searchParams.get('help') === '1') return json({ ok: true, help: propHelp() });
        const p = Object.fromEntries(url.searchParams.entries());
        if (request.method === 'POST') { try { Object.assign(p, await request.json()); } catch { /* 本文なしでも動く */ } }
        const out = await buildPropReport({ store: deps.store, env, params: p });
        return json({ ok: true, ...out });
      } catch (e) {
        return json({ ok: false, error: 'prop_diag_failed', detail: String((e && e.message) || e).slice(0, 300) }, 500);
      }
    }

    // E8 One の実行部（オーナー専用）。エージェントの中で口座を1日ずつ前へ進める。
    //   GET  : いまの口座・進捗・通算（?format=text で人が読む形、?help=1 で説明）
    //   POST : その場で1tick回す（{reset:true} で口座を作り直す）
    if (url.pathname === '/api/diag/e8' || url.pathname === '/api/e8') {
      try {
        const { e8Step, e8Status, e8Text, e8Help } = await import('./income/e8Runner.js');
        if (request.method === 'GET' && url.searchParams.get('help') === '1') return json({ ok: true, help: e8Help() });
        if (request.method === 'POST') {
          let body = {};
          try { body = await request.json(); } catch { /* 本文なしでも動く */ }
          if (body && body.reset) await deps.store.run(`DELETE FROM settings WHERE key LIKE 'e8:%'`).catch(() => {});
          const r = await e8Step({ store: deps.store, env, days: body?.days, applyBackfill: body?.backfill });
          return json({ ok: true, ran: r, status: await e8Status(deps.store, env) });
        }
        const st = await e8Status(deps.store, env);
        if (url.searchParams.get('format') === 'text') {
          return new Response(e8Text(st), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
        }
        return json({ ok: true, ...st });
      } catch (e) {
        return json({ ok: false, error: 'e8_failed', detail: String((e && e.message) || e).slice(0, 300) }, 500);
      }
    }

    // 最適ロジック探索（有料バックテスターの進化探索を作り直したもの・オーナー専用）
    //   GET  : 世代・母集団・集計・相関の低い集合（?view=board / ?view=collection）
    //   POST : その場で数個体評価する（{n, reset}）
    if (url.pathname === '/api/diag/opt' || url.pathname === '/api/opt') {
      try {
        const { optTick, optStatus, optText, optHelp } = await import('./income/optimizer.js');
        if (request.method === 'GET' && url.searchParams.get('help') === '1') return json({ ok: true, help: optHelp() });
        if (request.method === 'POST') {
          let body = {};
          try { body = await request.json(); } catch { /* 本文なしでも動く */ }
          if (body && body.reset) await deps.store.run(`DELETE FROM settings WHERE key LIKE 'opt:%'`).catch(() => {});
          const n = Math.max(1, Math.min(12, Number(body?.n || url.searchParams.get('n') || 3)));
          const r = await optTick({ store: deps.store, env, n });
          return json({ ok: true, ran: r, status: await optStatus(deps.store, env) });
        }
        const st = await optStatus(deps.store, env);
        const view = url.searchParams.get('view');
        if (view === 'board') return json({ ok: true, board: st.board, champion: st.champion, stats: st.stats });
        if (view === 'collection') return json({ ok: true, collection: st.collection, stats: st.stats });
        if (url.searchParams.get('format') === 'text') {
          return new Response(optText(st), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
        }
        return json({ ok: true, ...st });
      } catch (e) {
        return json({ ok: false, error: 'opt_failed', detail: String((e && e.message) || e).slice(0, 300) }, 500);
      }
    }

    // バックテスト作業台（2つのタブ: E8モード / 自己資金モード）。オーナー専用。
    //   GET  /api/lab            : 状態（?format=text / ?help=1）
    //   GET  /api/lab/catalog    : 銘柄・論理・出口・費用・E8規格の一覧（UIのプルダウン用）
    //   GET  /api/lab/board      : D1 に積んだ候補の順位表（?mode=own|e8）
    //   GET  /api/lab/data       : チャート用の日足（?symbol=&days=&limit=）
    //   POST /api/lab/run        : 1回の実行（モードごとの結論まで出す）
    //   POST /api/lab/search     : 試行錯誤（候補づくり→採点→順位・ヒートマップ）
    //   POST /api/lab/exit       : 出口（損切り/利確/保有日数）の最適化
    //   POST /api/lab/project    : 保存・読込・一覧・削除
    //   POST /api/lab/tick       : 背景ループをその場で1回
    // ネタ帳 — 「有益な情報 → 実際に試す」。営業・売り込みの下書きは作らない。原価0。
    if (url.pathname === '/api/playbook' || url.pathname.startsWith('/api/playbook/')) {
      const pj = (o, code = 200) => new Response(JSON.stringify(o), { status: code, headers: { 'content-type': 'application/json; charset=utf-8' } });
      try {
        const pbm = await import('./agent/playbook.js');
        await pbm.ensurePlaybookTable(deps.store);
        const sub = url.pathname.replace('/api/playbook', '').replace(/^\//, '');
        if (sub === 'help') return pj({ ok: true, help: pbm.playbookHelp() });
        if (sub === 'seed') { const r = await pbm.seedPlaybooks(deps.store); return pj({ ok: true, ...r }); }
        if (sub === 'derive') {
          const rows = await deps.store.all('SELECT title, url, excerpt, score, source_id FROM scout_findings ORDER BY score DESC LIMIT 40');
          let ins = 0, cand = 0;
          for (const f of rows || []) {
            for (const c of pbm.derivePlaybooks(f, { max: 2 })) { cand++; const r = await pbm.savePlaybook(deps.store, c); if (r.inserted) ins++; }
          }
          return pj({ ok: true, scanned: (rows || []).length, candidates: cand, inserted: ins });
        }
        if (sub === 'try') {
          const r = await pbm.tryPlaybooks(deps.store, { limit: Number(url.searchParams.get('limit') || 2) });
          return pj({ ok: true, ...r });
        }
        const list = await pbm.listPlaybooks(deps.store, {
          limit: Number(url.searchParams.get('limit') || 50),
          kind: url.searchParams.get('kind'), status: url.searchParams.get('status'),
        });
        if (url.searchParams.get('format') === 'text') {
          return new Response(pbm.playbookText(list), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
        return pj({ ok: true, summary: await pbm.playbookSummary(deps.store), rows: list });
      } catch (e) { return pj({ ok: false, error: e.message }, 500); }
    }

    // 有益情報 — 「契約すると/買うと/応募すると、これが貰える」を出典つき・期限つきで貯める。
    // ポイ活の自動応募・自動クリックは規約違反になるので実装しない（受け取りは人の1タップ）。
    if (url.pathname === '/api/perks' || url.pathname.startsWith('/api/perks/')) {
      const pj = (o, code = 200) => new Response(JSON.stringify(o), { status: code, headers: { 'content-type': 'application/json; charset=utf-8' } });
      try {
        const pkm = await import('./agent/perks.js');
        await pkm.ensurePerkTable(deps.store);
        const sub = url.pathname.replace('/api/perks', '').replace(/^\//, '');
        if (sub === 'help') return pj({ ok: true, help: pkm.perkHelp() });
        if (sub === 'seed') { const r = await pkm.seedPerks(deps.store); return pj({ ok: true, ...r }); }
        if (sub === 'try') {
          const r = await pkm.tryPerks(deps.store, { limit: Number(url.searchParams.get('limit') || 3) });
          return pj({ ok: true, ...r });
        }
        if (sub === 'ingest') {
          let body = {};
          try { body = await request.json(); } catch { body = {}; }
          const r = await pkm.ingestPerks(deps.store, body.items || [], { max: Number(body.max || 60) });
          return pj({ ok: true, ...r });
        }
        const list = await pkm.listPerks(deps.store, {
          limit: Number(url.searchParams.get('limit') || 40),
          kind: url.searchParams.get('kind'), state: url.searchParams.get('state'),
        });
        if (url.searchParams.get('format') === 'text') {
          return new Response(pkm.perkText(list), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
        return pj({ ok: true, summary: await pkm.perkSummary(deps.store), rows: list });
      } catch (e) { return pj({ ok: false, error: e.message }); }
    }

    // X（Twitter）の無料巡回 — 鍵もアカウントも要らない経路だけで読む（読み取り専用）。
    // 経路: FxTwitter API v2（鍵なし）→ Nitter の RSS（生きている2台）→ Google News RSS。
    // 投稿・返信・引用・DM は行わない。X 公式 API は Free 枠廃止で読み取りが従量課金なので使わない。
    if (url.pathname === '/api/twitter' || url.pathname.startsWith('/api/twitter/')) {
      const tj = (o, code = 200) => new Response(JSON.stringify(o), { status: code, headers: { 'content-type': 'application/json; charset=utf-8' } });
      try {
        const tw = await import('./agent/twitter.js');
        await tw.ensureTwitterTable(deps.store);
        const sub = url.pathname.replace('/api/twitter', '').replace(/^\//, '');
        if (sub === 'help') return tj({ ok: true, help: tw.twitterHelp() });
        if (sub === 'providers') return tj({ ok: true, providers: tw.PROVIDERS });
        if (sub === 'sweep' || sub === 'try') {
          const r = await tw.tryTwitter(deps.store, { env });
          return tj({ ok: true, ...r });
        }
        const rows = await tw.listTweets(deps.store, { limit: Number(url.searchParams.get('limit') || 20) });
        if (url.searchParams.get('format') === 'text') {
          return new Response(tw.twitterText(rows), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
        return tj({ ok: true, summary: await tw.twitterSummary(deps.store), watch: tw.watchList(env), queries: tw.queryList(env), rows });
      } catch (e) { return tj({ ok: false, error: e.message }); }
    }

    // Reddit 横断巡回の計画。実際の巡回はサンドボックス側（Worker から Reddit 公式APIには到達できない）。
    if (url.pathname === '/api/reddit' || url.pathname.startsWith('/api/reddit/')) {
      try {
        const rd = await import('./agent/reddit.js');
        const sub = url.pathname.replace('/api/reddit', '').replace(/^\//, '');
        if (sub === 'help') return json({ ok: true, help: rd.redditHelp() });
        if (sub === 'subreddits') return json({ ok: true, subreddits: rd.SUBREDDITS });
        const plan = rd.sweepPlan({ limit: Number(url.searchParams.get('limit') || 8), mode: url.searchParams.get('mode') || 'top' });
        if (url.searchParams.get('format') === 'text') {
          return new Response(rd.redditPlanText(plan), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
        return json({ ok: true, plan });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }

    if (url.pathname === '/api/lab' || url.pathname.startsWith('/api/lab/')) {
      try {
        const lab = await import('./income/lab.js');
        const sub = url.pathname.replace('/api/lab', '').replace(/^\//, '');
        if (url.searchParams.get('help') === '1') return json({ ok: true, help: lab.labHelp() });
        if (request.method === 'GET' && url.searchParams.get('view') === 'auto') {
          return json({ ok: true, auto: await lab.labAutoStatus(deps.store) });
        }
        if (request.method === 'GET' && sub === 'catalog') return json({ ok: true, catalog: lab.labCatalog(env) });
        if (request.method === 'GET' && sub === 'board') {
          const mode = url.searchParams.get('mode') === 'e8' ? 'e8' : 'own';
          return json({ ok: true, mode, rows: await lab.labBoard(deps.store, { mode, limit: Number(url.searchParams.get('limit') || 30) }) });
        }
        if (request.method === 'GET' && sub === 'data') {
          const sym = url.searchParams.get('symbol') || 'USDJPY';
          const days = Math.max(300, Math.min(3000, Number(url.searchParams.get('days') || 1600)));
          const limit = Math.max(30, Math.min(900, Number(url.searchParams.get('limit') || 420)));
          const { fetchMarketData } = await import('./income/fx.js');
          const md = await fetchMarketData(deps.store, sym, { days });
          const bars = (md.bars || []).slice(-limit).map((b) => ({ date: b.date, o: b.open, h: b.high, l: b.low, c: b.close }));
          return json({ ok: true, symbol: sym, source: md.source || null, quality: md.quality || null, count: bars.length, bars });
        }
        let body = {};
        if (request.method === 'POST') { try { body = await request.json(); } catch { body = {}; } }
        if (sub === 'run') return json(await lab.labRun({ store: deps.store, env, body }));
        if (sub === 'search') {
          const mode = body.mode === 'e8' ? 'e8' : 'own';
          const n = Math.max(1, Math.min(24, Number(body.n || 8)));
          const r = await lab.labSearch({ store: deps.store, env, mode, n, opts: body.options || {}, settings: body.settings || {} });
          return json({ ok: true, ...r });
        }
        if (sub === 'exit') {
          const spec = body.spec || lab.specFromRow(body.row || {}, () => 0.5);
          const r = await lab.exitOptimize({ store: deps.store, env, spec, opts: body.options || {}, grid: body.grid || null, limit: body.limit || 24 });
          return json({ ok: true, ...r });
        }
        if (sub === 'project') {
          const action = String(body.action || 'list');
          if (action === 'save') return json({ ok: true, ...(await lab.labSaveProject(deps.store, body.name || 'untitled', body.payload || {})) });
          if (action === 'load') return json({ ok: true, ...(await lab.labLoadProject(deps.store, body.name || '')) });
          if (action === 'delete') return json({ ok: true, ...(await lab.labDeleteProject(deps.store, body.name || '')) });
          return json({ ok: true, projects: await lab.labProjects(deps.store) });
        }
        if (sub === 'tick') return json({ ok: true, ...(await lab.labTick({ store: deps.store, env })) });
        if (sub === 'auto') return json({ ok: true, ...(await lab.labAuto({ store: deps.store, env })) });
        //   GET  /api/lab/loop         : 試行錯誤の自浄ループの状態（?format=text）
        //   POST /api/lab/loop         : その場で1ラウンド（?mode=own|e8）
        //   GET  /api/lab/loop/public  : 認証なしの要約
        if (sub === 'loop' || sub === 'loop/public') {
          const loopMod = await import('./income/labLoop.js');
          if (sub === 'loop' && request.method === 'POST') {
            const mode = url.searchParams.get('mode') || 'own';
            return json({ ok: true, round: await loopMod.labLoopRound({ store: deps.store, env, mode }) });
          }
          const st = await loopMod.labLoopStatus(deps.store, env);
          if (url.searchParams.get('format') === 'text') return json({ ok: true, text: loopMod.labLoopText(st), ...st });
          return json({ ok: true, ...st });
        }
        const st = await lab.labStatus(deps.store, env);
        if (url.searchParams.get('format') === 'text') {
          return new Response(lab.labText(st), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
        }
        return json({ ok: true, ...st });
      } catch (e) {
        return json({ ok: false, error: 'lab_failed', detail: String((e && e.message) || e).slice(0, 300) }, 500);
      }
    }

    if (url.pathname === '/api/diag/research' && request.method === 'GET') {
      try {
        const { createResearch } = await import('./research/web.js');
        const q = url.searchParams.get('q') || 'x402 facilitator comparison';
        const p = await createResearch(env).probe(q);
        return json({ ok: true, ...p });
      } catch (e) {
        return json({ ok: false, error: 'diag_failed', detail: String(e && e.message || e).slice(0, 300) }, 500);
      }
    }

    // 活動報告: 「いま何をしているか」をタスク・台帳・売り物から実測して返す。
    // ?format=text で人が読む形、?live=1 で外部（自分の402・Bazaar 掲載）も実測する。オーナー専用。
    // 今日なにを拾い、何を試し、何が分かったか — 1画面ぶんのデータ（/today が読む）。
    // 全般の改善ループ — FX だけでなく、ファネル・ネタ帳・特典・REA・収集・売り物まで
    // 同じ形（測る → 壁を名指し → 手を変える → 記録する）でエージェント自身が回す。
    // --- 販路ポートフォリオ（sales loop）: 「なぜ売れないか」を販路ごとに測り、全販路を同時に打つ ---
    //   GET  /api/sales          : 状態（?format=text / ?help=1）
    //   GET  /api/sales/public   : 認証なしの要約（販路ボード）
    //   POST /api/sales          : その場で1ラウンド（?n=数）
    if (url.pathname === '/api/sales' || url.pathname === '/api/sales/help' || url.pathname === '/api/sales/public' || url.pathname === '/api/sales/run') {
      const sl = await import('./agent/sales.js');
      if (url.pathname === '/api/sales/help' || url.searchParams.get('help') === '1') return json({ ok: true, ...sl.salesHelp() });
      if (url.pathname === '/api/sales/run' || (url.pathname === '/api/sales' && request.method === 'POST')) {
        const rounds = await sl.salesTick({ store: deps.store, env, n: Number(url.searchParams.get('n') || 0) || undefined });
        return json({ ok: true, rounds });
      }
      const st = await sl.salesStatus(deps.store, env);
      if (url.pathname === '/api/sales/public') return json({ ok: true, ...sl.salesPublic(st) });
      if (url.searchParams.get('format') === 'text') return new Response(sl.salesText(st), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return json({ ok: true, ...st });
    }

    // --- 販路開拓（channel hunt）: まだ知らない売り場を自分で見つけ、載せられる所に載せる ---
    //   GET  /api/hunt           : 状態（?format=text / ?help=1）
    //   GET  /api/hunt/public    : 認証なしの要約
    //   POST /api/hunt           : その場で1ラウンド（?n=数 / ?discover=1 で探索を強制）
    if (url.pathname === '/api/hunt' || url.pathname === '/api/hunt/help' || url.pathname === '/api/hunt/public' || url.pathname === '/api/hunt/run') {
      const hn = await import('./agent/chanhunt.js');
      if (url.pathname === '/api/hunt/help' || url.searchParams.get('help') === '1') return json({ ok: true, ...hn.huntHelp() });
      if (url.pathname === '/api/hunt/run' || (url.pathname === '/api/hunt' && request.method === 'POST')) {
        const rec = await hn.huntRound({ store: deps.store, env, n: Number(url.searchParams.get('n') || 0) || 3, discoverNow: url.searchParams.get('discover') === '1' });
        return json({ ok: true, rounds: [rec] });
      }
      const st = await hn.huntStatus(deps.store, env);
      if (url.pathname === '/api/hunt/public') return json({ ok: true, ...hn.huntPublic(st) });
      if (url.searchParams.get('format') === 'text') return new Response(hn.huntText(st), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      return json({ ok: true, ...st });
    }

    //   GET  /api/improve          : 状態（?format=text / ?help=1）
    //   GET  /api/improve/public   : 認証なしの要約
    //   POST /api/improve          : その場で1〜nラウンド（?lane=key&n=数）
    //   POST /api/contact       : 外部エージェント／売り場からの連絡窓口（登録時に提出する webhook・認証不要）
    if (url.pathname === '/api/contact') {
      let b = {};
      try { b = await request.json(); } catch { b = {}; }
      const at = new Date().toISOString();
      const clip = (v, n) => (v == null ? '' : String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, n));
      const rec = {
        id: 'cm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        at,
        from_ref: clip(b.from || b.origin || b.url || b.source || '', 200),
        subject: clip(b.subject || b.topic || b.kind || 'contact', 200),
        message: clip(b.message || b.body || b.note || b.detail || '', 4000),
        raw: clip(b.raw === undefined ? b : b.raw, 2000),
        ua: clip(request.headers.get('user-agent') || '', 180),
      };
      const st = (deps && deps.store) || null;
      let saved = false;
      if (st) {
        const sql = 'INSERT INTO contact_msgs (id, at, from_ref, subject, message, raw, ua) VALUES (?, ?, ?, ?, ?, ?, ?)';
        const params = [rec.id, rec.at, rec.from_ref, rec.subject, rec.message, rec.raw, rec.ua];
        try { await st.run(sql, params); saved = true; } catch (e1) {
          try { await st.run(sql, ...params); saved = true; } catch { saved = false; }
        }
      }
      return json({ ok: true, received_at: rec.at, saved, id: rec.id, note: 'Wealth Agent contact endpoint. Automated agents welcome; we also publish x402/MCP details at /agents.json and /mcp.' });
    }
    // --- 自律成長エンジン（grow-1.0）: 全体を1つの目的関数で見て、いまの壁を名指しし、
    //     期待値の高い原価0の手を自分で選んで打ち、測って記憶する。人に指示されなくても回る。
    //   GET  /api/grow           : 状態（?format=text / ?help=1）
    //   GET  /api/grow/public    : 認証なしの要約（公開ボード /grow.html が読む）
    //   POST /api/grow           : その場で1ラウンド（?n=打つ手の数 / ?lever=手を指定）
    if (url.pathname === '/api/grow' || url.pathname === '/api/grow/help' || url.pathname === '/api/grow/public' || url.pathname === '/api/grow/run') {
      const gw = await import('./agent/grow.js');
      if (url.pathname === '/api/grow/help' || url.searchParams.get('help') === '1') return json({ ok: true, ...gw.growHelp() });
      if (url.pathname === '/api/grow/run' || (url.pathname === '/api/grow' && request.method === 'POST')) {
        const rec = await gw.growRound({ store: deps.store, env, n: Number(url.searchParams.get('n') || 0) || undefined, lever: url.searchParams.get('lever') || null });
        return json({ ok: true, rounds: [rec] });
      }
      const gst = await gw.growStatus(deps.store, env);
      if (url.pathname === '/api/grow/public') return json({ ok: true, ...gw.growPublic(gst) });
      if (url.searchParams.get('format') === 'text') return new Response(gw.growText(gst), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      return json({ ok: true, ...gst });
    }

    // --- x402 市場索引（xindex-1.0）: 公開ディスカバリを読んで作る自前のデータ商品の入口。
    //     索引そのものは**無料で公開**する（呼び水）。深い操作（取り込み・生存測定）は認証必須。
    if (url.pathname === '/api/xindex' || url.pathname === '/api/xindex/help' || url.pathname === '/api/xindex/summary'
        || url.pathname === '/api/xindex/hosts' || url.pathname === '/api/xindex/refresh' || url.pathname === '/api/xindex/probe') {
      const xi = await import('./agent/xindex.js');
      if (url.pathname === '/api/xindex/help' || url.searchParams.get('help') === '1') return json({ ok: true, ...xi.xindexHelp() });
      if (url.pathname === '/api/xindex/refresh') {
        const r = await xi.refreshIndex({ store: deps.store, env, pages: Number(url.searchParams.get('pages') || 0) || undefined });
        return json({ ok: true, refresh: r });
      }
      if (url.pathname === '/api/xindex/probe') {
        const p = await xi.probeSlice({ store: deps.store, env, n: Number(url.searchParams.get('n') || 0) || undefined });
        return json({ ok: true, probe: p });
      }
      const xs = await xi.xindexStatus(deps.store);
      if (url.pathname === '/api/xindex/summary') return json({ ok: true, ...xi.xindexPublic(xs) });
      if (url.pathname === '/api/xindex/hosts') {
        const hosts = await xi.topHosts(deps.store, {
          q: url.searchParams.get('q') || '', limit: Number(url.searchParams.get('limit') || 25),
          live: url.searchParams.get('live') === '1', sort: url.searchParams.get('sort') || 'n',
        });
        return json({ ok: true, hosts, summary: { services_indexed: xs.services_indexed, hosts_known: xs.hosts_known, last_at: xs.crawl && xs.crawl.last_at } });
      }
      if (url.searchParams.get('format') === 'text') return new Response(xi.xindexText(xs), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      return json({ ok: true, ...xs });
    }


    // market-1.0 — 市場の真実（公開は読み取りのみ。走査と出品はオーナーだけ）
    // --- frontier-1.0 / repo-1.0 / direct-1.0（分野の探索・GitHub取り込み・自然言語の指示）
    {
      const J = (o, st = 200) => new Response(JSON.stringify(o, null, 2), { status: st, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
      const T = (b, st = 200) => new Response(String(b), { status: st, headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' } });
      const body = async () => { try { return (await request.json()) || {}; } catch { return {}; } };
      const fmt = url.searchParams.get('format') === 'text';
      const wantHelp = url.searchParams.get('help') === '1';
      const base = new URL(request.url).origin;
      if (url.pathname.startsWith('/api/frontier')) {
        const fr = await import('./agent/frontier.js');
        if (url.pathname === '/api/frontier' && request.method === 'GET') {
          if (wantHelp) return T(fr.frontierHelp(base));
          const st = await fr.frontierStatus(deps.store);
          return fmt ? T(fr.frontierText(st)) : J(st);
        }
        if (url.pathname === '/api/frontier/public' && request.method === 'GET') return J(fr.frontierPublic(await fr.frontierStatus(deps.store)));
        if (url.pathname === '/api/frontier/think' && request.method === 'POST') {
          const b = await body();
          const { freeLlm } = await import('./agent/grow.js');
          let ai = null; try { ai = await freeLlm(env || {}, deps.store); } catch { ai = null; }
          const r = await fr.frontierThink({ store: deps.store, env: env || {}, deps, ai, force: b.force !== false });
          return J({ ok: r.ok, skipped: r.skipped || null, at: r.at, measured: r.measured, measured_at: r.measured_at || null,
            top: r.top, next: r.next, board: (r.board || []).slice(0, 6), ai_available: r.ai_available, ai_error: r.ai_error || null, new_domains_from_ai: r.new_domains_from_ai, ideas_saved: r.ideas_saved });
        }
        return J({ ok: false, error: 'not_found' }, 404);
      }
      if (url.pathname.startsWith('/api/repos')) {
        const rp = await import('./agent/repo.js');
        if (url.pathname === '/api/repos' && request.method === 'GET') {
          if (wantHelp) return T(rp.repoHelp(base));
          const st = await rp.repoStatus(deps.store);
          return fmt ? T(rp.repoText(st)) : J(st);
        }
        if (url.pathname === '/api/repos/public' && request.method === 'GET') {
          const st = await rp.repoStatus(deps.store, { limit: 24 });
          return J({ ok: true, version: st.version, last_run_at: st.last_run_at, by_adopt: st.by_adopt,
            candidates: st.candidates.map((c) => ({ full_name: c.full_name, stars: c.stars, adopt: c.adopt, kind: c.kind, why: c.why, html_url: c.html_url })),
            listing_candidates: st.listing_candidates });
        }
        if (url.pathname === '/api/repos/intake' && request.method === 'POST') {
          const b = await body();
          const r = await rp.repoIntake({ store: deps.store, env: env || {}, force: b.force !== false, limit: b.limit || null, readmes: b.readmes || null });
          return J({ ok: r.ok, skipped: r.skipped || null, at: r.at, scanned: r.scanned, readmes: r.readmes, adopt: r.adopt,
            listing_candidates: r.listing_candidates, payto_found: r.payto_found, errors: r.errors, top: r.top, items: (r.items || []).slice(0, 20) });
        }
        return J({ ok: false, error: 'not_found' }, 404);
      }
      if (url.pathname.startsWith('/api/direct')) {
        const dr = await import('./agent/director.js');
        if (url.pathname === '/api/direct' && request.method === 'GET') {
          if (wantHelp) return T(dr.directHelp(base));
          const st = await dr.directStatus(deps.store);
          return fmt ? T(dr.directText(st)) : J(st);
        }
        if (url.pathname === '/api/direct' && request.method === 'POST') {
          const b = await body();
          const text = b.text || b.instruction || b.q || '';
          if (!text) return J({ ok: false, error: 'text_required', hint: 'POST {"text":"...","run":true}' }, 400);
          if (b.run === false) { const q = await dr.queueDirective({ store: deps.store, text }); return J(q); }
          const { freeLlm } = await import('./agent/grow.js');
          let ai = null; try { ai = await freeLlm(env || {}, deps.store); } catch { ai = null; }
          const r = await dr.runDirective({ store: deps.store, env: env || {}, deps, text, ai, intent: b.intent || null });
          return J(r, r.ok ? 200 : 200);
        }
        if (url.pathname === '/api/direct/public' && request.method === 'GET') {
          const st = await dr.directStatus(deps.store, { limit: 8 });
          const counts = {}; for (const d of st.directives) counts[d.state] = (counts[d.state] || 0) + 1;
          return J({ ok: true, version: st.version, pending: st.pending, state_counts: counts,
            intents: st.intents.map((i) => ({ key: i.key, label: i.label, lever: i.lever })),
            recent: st.directives.map((d) => ({ at: d.at, intent: d.intent, state: d.state, tries: d.tries })) });
        }
        return J({ ok: false, error: 'not_found' }, 404);
      }
      if (url.pathname.startsWith('/api/listings')) {
        const rp = await import('./agent/repo.js');
        if (url.pathname === '/api/listings' && request.method === 'GET') {
          const st = await rp.repoProspects(deps.store, { limit: 40 });
          return fmt ? T(rp.prospectsText(st)) : J(st);
        }
        if (url.pathname === '/api/listings/public' && request.method === 'GET') {
          const st = await rp.repoProspects(deps.store, { limit: 40 });
          return J({ ok: true, version: st.version, at: st.at, hosts: st.hosts, auto_ready: st.auto_ready, human_required: st.human_required, by_state: st.by_state,
            items: st.items.map((x) => ({ host: x.host, state: x.state, signal: x.signal, kinds: x.kinds, repos: x.repos, urls: x.urls })) });
        }
        if (url.pathname === '/api/listings/intake' && request.method === 'POST') {
          const b = await body();
          const r = await rp.repoProspectIntake({ store: deps.store, env: env || {}, limit: b.limit || 8, dry: b.dry === true });
          return J(r);
        }
        return J({ ok: false, error: 'not_found' }, 404);
      }
      if (url.pathname === '/api/ideas' && request.method === 'GET') {
        const fr = await import('./agent/frontier.js');
        const f = await fr.frontierStatus(deps.store);
        const { dbAll } = await import('./agent/market.js');
        let hyps = []; try { hyps = await dbAll(deps.store, 'SELECT at,slug,category,op,price_atomic,why,score,source,state FROM market_hypotheses ORDER BY at DESC LIMIT 30'); } catch { hyps = []; }
        return J({ ok: true, next: f.next, frontier_ideas: f.ideas, market_hypotheses: hyps });
      }
    }
    // 大手の売り場ボード（venues-1.0）: Bazaar の外の到達規模を原価0・自動化可否で並べる。
    if (url.pathname === '/api/venues' || url.pathname === '/api/venues/public') {
      const _h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
      const _pub = url.pathname === '/api/venues/public';
      if (url.searchParams.get('format') === 'text' && !_pub) {
        return new Response(venueBoardText(), { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      }
      const _board = venueBoard();
      const _counts = venueCounts();
      const _snap = await venueSnapshotLoad(env);
      const _items = _board.map((v) => _pub
        ? { id: v.id, name: v.name, kind: v.kind, reach: v.reach, cost_usd: v.cost_usd, auto: v.auto, fit: v.fit, state: v.state, score: v.score, url: v.url, publish_api: v.publish_api || null, probe: v.probe || null }
        : { id: v.id, name: v.name, kind: v.kind, reach: v.reach, cost_usd: v.cost_usd, auto: v.auto, kyc: v.kyc, fit: v.fit, state: v.state, score: v.score, parts: v.parts, url: v.url, submit: v.submit, probe: v.probe || null, publish_api: v.publish_api || null, reach_note: v.reach_note, note: v.note, src: v.src });
      const _body = {
        ok: true, version: 'venues-1.0', registry_plan: venueRegistryPlan(), at: new Date().toISOString(),
        total: _counts.total, by_state: _counts.by_state,
        auto_queue: venueAutoQueue().map((v) => v.id),
        human_queue: venueHumanQueue().map((v) => v.id),
        items: _pub ? _items.slice(0, 8) : _items,
        last_probe: _snap ? { at: _snap.at, probed: _snap.probed, by_signal: _snap.by_signal } : null,
        packs: { diligence_pack: { price_usd: 1.0, resource: '/api/x402/diligence-pack', why: 'x402 で金額が出ているのは $1 以上の帯（Base の x402 では $1+ が総額の95%）。既定の買い手は1回 $1 までの上限なので、ちょうど $1.00 に置いた' } },
      };
      return new Response(JSON.stringify(_body, null, 2), { status: 200, headers: _h });
    }

    if (url.pathname === '/api/venues/probe') {
      const _h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
      if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed', hint: 'POST {only:[id],dry:true}' }), { status: 405, headers: _h });
      let _p = {};
      try { _p = await request.json(); } catch (e) { _p = {}; }
      const _r = await probeVenues({ env, only: _p.only, dry: !!_p.dry });
      return new Response(JSON.stringify(_r, null, 2), { status: _r.ok ? 200 : 500, headers: _h });
    }

    // 収益の計器。売上は receipts（外部の買い手が決済した事実）だけを出典にする。
    // 測れない指標は推定で埋めず「未測定」と、どう測るかを返す。
    if (url.pathname === '/api/kpi' || url.pathname === '/api/kpi/public') {
      try {
        const { kpiReport } = await import('./agent/kpi.js');
        const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 365);
        return json(await kpiReport(deps.store, { days }), 200);
      } catch (e) {
        return json({ ok: false, error: 'kpi_failed', detail: String((e && e.message) || e) }, 500);
      }
    }

    if (url.pathname === '/api/discwatch' || url.pathname === '/api/discwatch/public') {
      // 発見面の日次観測（discwatch）。CDP審査・索引入り・一般語検索での順位・説明文規律を
      // 原価0・鍵不要のAPIだけで記録する。公開面は保存済みスナップショットだけ（秘密は含まない）。
      const { runDiscWatch, discSnapshot } = await import('./agent/discwatch.js');
      if (url.pathname === '/api/discwatch') {
        if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
        if (url.searchParams.get('run') === '1' || url.searchParams.get('fresh') === '1') {
          return json(await runDiscWatch(env, deps.store, { origin: url.origin, force: url.searchParams.get('run') === '1' }), 200);
        }
      }
      return json(await discSnapshot(deps.store), 200);
    }
    if (url.pathname === '/api/market' || url.pathname === '/api/market/public') {
      const { marketStatus, marketPublic, marketText, marketHelp } = await import('./agent/market.js');
      if (url.searchParams.get('help') === '1') return json({ ok: true, help: marketHelp(url.origin) });
      const s = url.pathname === '/api/market' ? await marketStatus(deps.store) : await marketPublic(deps.store);
      if (url.searchParams.get('format') === 'text') return new Response(marketText(s), { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      return json({ ok: true, ...s });
    }
    if (url.pathname === '/api/market/rpc' && request.method === 'POST') {
      // 自作の品が「中身を返せるか」の根本原因（RPC への到達）を外から見えるようにする。
      const urls = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'];
      const out = [];
      for (const u of urls) {
        const t0 = Date.now();
        try {
          const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'WealthAgent/1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) });
          const txt = (await res.text()).slice(0, 160);
          out.push({ url: u, http: res.status, ms: Date.now() - t0, body: txt });
        } catch (e) { out.push({ url: u, http: 0, ms: Date.now() - t0, error: String(e && e.message).slice(0, 160) }); }
      }
      const { fulfillOnchainBalance } = await import('./agent/fulfill.js');
      const { SELFTEST_ADDRESS } = await import('./agent/market.js');
      const bal = await fulfillOnchainBalance({ chain: 'base', address: SELFTEST_ADDRESS, tokens: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'] }, { env });
      return json({ ok: true, rpc: out, deliverable: bal });
    }
    if (url.pathname === '/api/market/scan' && request.method === 'POST') {
      const { marketScan } = await import('./agent/market.js');
      const r = await marketScan({ store: deps.store, env, deps, force: url.searchParams.get('force') !== '0' });
      return json(r, r.ok ? 200 : 502);
    }
    if (url.pathname === '/api/market/launch' && request.method === 'POST') {
      const { launchTopProduct } = await import('./agent/market.js');
      const r = await launchTopProduct({ store: deps.store, env, deps, dryRun: url.searchParams.get('dry') === '1' });
      return json(r, r.ok ? 200 : 409);
    }
    if (url.pathname === '/api/market/delist' && request.method === 'POST') {
      const { delistProduct } = await import('./agent/market.js');
      const r = await delistProduct({ store: deps.store, slug: url.searchParams.get('slug') });
      return json(r, r.ok ? 200 : 404);
    }
    if (url.pathname === '/api/improve' || url.pathname === '/api/improve/help' || url.pathname === '/api/improve/public') {
      try {
        const im = await import('./agent/improve.js');
        if (url.pathname === '/api/improve/help' || url.searchParams.get('help') === '1') return json({ ok: true, ...im.improveHelp() });
        if (url.pathname === '/api/improve' && request.method === 'POST') {
          const lane = url.searchParams.get('lane');
          const n = Number(url.searchParams.get('n') || (lane ? 1 : env.IMPROVE_N || 2));
          const rounds = lane
            ? [await im.improveRound({ store: deps.store, env, lane })]
            : await im.improveTick({ store: deps.store, env, n });
          return json({ ok: true, rounds });
        }
        const st = await im.improveStatus(deps.store, env);
        if (url.searchParams.get('format') === 'text') {
          return new Response(im.improveText(st), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
        }
        if (url.pathname === '/api/improve/public') {
          return json({
            ok: true, version: st.version, rounds: st.rounds, by_verdict: st.by_verdict, by_wall: st.by_wall,
            lanes: st.lanes.map((l) => ({ key: l.key, label: l.label, what: l.what, rounds: l.rounds, stall: l.stall, wall: l.wall, action: l.action, level: l.level, verdict: l.verdict, at: l.at })),
            recent: st.recent.slice(0, 12), history: st.history, config: st.config, note: st.note,
          });
        }
        return json({ ok: true, ...st });
      } catch (e) {
        return json({ ok: false, error: 'improve_failed', detail: String((e && e.message) || e).slice(0, 300) }, 500);
      }
    }

        if (url.pathname === '/api/bounty/public' || url.pathname === '/api/bounty') {
      try {
        const { Store } = await import('./db.js');
        const bStore = new Store(env.DB);
        const { bountyBoard, bountyScan } = await import('./agent/bounty.js');
        const wantRun = request.method === 'POST' || url.searchParams.get('run') === '1';
        const d = wantRun ? await bountyScan({ store: bStore, env, live: true }) : await bountyBoard(bStore, {});
        return new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String((e && e.stack) || e).slice(0, 600) }), {
          status: 500, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
    }
    if (url.pathname === '/api/digest/public' || url.pathname === '/api/digest') {
      try {
        const { Store } = await import('./db.js');
        const dgStore = new Store(env.DB);
        const { latestDigest, snsDigest } = await import('./agent/snsdigest.js');
        const wantRun = request.method === 'POST' || url.searchParams.get('run') === '1';
        const d = wantRun ? await snsDigest(dgStore, { env, send: true }) : await latestDigest(dgStore);
        return new Response(JSON.stringify(d || { ok: false, note: 'no report yet' }), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String((e && e.stack) || e).slice(0, 600) }), {
          status: 500, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
    }
if (url.pathname === '/api/today' || url.pathname === '/api/today/public') {
      const { todayDigest, todayText } = await import('./agent/today.js');
      const body = await todayDigest(deps.store, { publicOnly: url.pathname.endsWith('/public') });
      if (url.searchParams.get('format') === 'text') return new Response(todayText(body), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return json(body);
    }

    // 公開表面の解析（無料・要約）。参考: morluto/rea の考え方を公開Web/APIに限定して移植。
    if (url.pathname === '/api/surface' || url.pathname === '/api/surface/help') {
      const { inspectSurface, surfaceBrief, surfaceHelp, SURFACE_PRICE_USDC, GUARDRAILS } = await import('./agent/surface.js');
      if (url.pathname.endsWith('/help')) return json({ ok: true, help: surfaceHelp(), price_usdc: SURFACE_PRICE_USDC, guardrails: GUARDRAILS });
      let target = url.searchParams.get('url') || '';
      if (!target && request.method === 'POST') { try { target = (await request.json()).url || ''; } catch {} }
      if (!target) return json({ ok: false, error: 'url が必要です', help: surfaceHelp() }, 400);
      const s = await inspectSurface(target, {});
      const brief = surfaceBrief(s, { full: false });
      if (url.searchParams.get('format') === 'text') return new Response(brief, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return json({ ok: s.ok, brief, report: s, paid: { resource: 'surface-report', price_usdc: SURFACE_PRICE_USDC, endpoint: `${url.origin}/api/x402/surface-report`, mcp_tool: 'buy_surface_report' }, guardrails: GUARDRAILS });
    }

    // REA（全種別の表面解析）。ローカルのファイルは実行せず、そのまま流せる手順を返す（handoff）。
    if (url.pathname === '/api/rea' || url.pathname === '/api/rea/help' || url.pathname === '/api/rea/plan' || url.pathname === '/api/rea/runs') {
      const { inspectRea, reaBrief, reaHelp, reaPlan, REA_PRICE_USDC, ACTION_RULES, recordRun, listRuns } = await import('./agent/rea.js');
      if (url.pathname.endsWith('/help')) return json({ ok: true, help: reaHelp(), price_usdc: REA_PRICE_USDC, action_rules: ACTION_RULES });
      if (url.pathname.endsWith('/plan')) { const kind = url.searchParams.get('kind') || 'unknown'; return json({ ok: true, kind, plan: reaPlan(kind), action_rules: ACTION_RULES }); }
      if (url.pathname.endsWith('/runs')) return json({ ok: true, runs: await listRuns(deps.store, Number(url.searchParams.get('limit')) || 20) });
      let target = url.searchParams.get('url') || url.searchParams.get('target') || '';
      if (!target && request.method === 'POST') { try { const b = await request.json(); target = b.url || b.target || ''; } catch {} }
      if (!target) return json({ ok: false, error: 'url（または target）が必要です', help: reaHelp() }, 400);
      const s = await inspectRea(target, {});
      try { if (deps.store) await recordRun(deps.store, s); } catch {}
      const brief = reaBrief(s, { full: false });
      if (url.searchParams.get('format') === 'text') return new Response(brief, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return json({ ok: s.ok, brief, report: s, plan: s.plan || null, paid: { resource: 'rea-report', price_usdc: REA_PRICE_USDC, endpoint: `${url.origin}/api/x402/rea-report`, mcp_tool: 'buy_rea_report' }, action_rules: ACTION_RULES });
    }

    // 自己修復ループ（なぜ収益0なのかを毎回測る）と REA 自動投入キューの状態。
    if (url.pathname === '/agents.json' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(JSON.stringify(agentsJson(env), null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
      });
    }
    if ((url.pathname === '/api/skills/catalog' || url.pathname === '/api/skills/catalog.json') && request.method === 'GET') {
      return new Response(JSON.stringify(skillCatalog(), null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
      });
    }
    if (url.pathname === '/api/selfreport' && request.method === 'POST') {
      const st = (deps && deps.store) || null;
      if (!st) return json({ ok: false, error: 'no_store' }, 500);
      let b = {};
      try { b = await request.json(); } catch { b = {}; }
      const cl = (v, max) => Math.max(-max, Math.min(max, Math.round(Number(v) || 0)));
      const rec = {
        at: new Date().toISOString(),
        ua: String(b.ua || '').slice(0, 180), platform: String(b.platform || '').slice(0, 40),
        standalone: b.standalone ? 1 : 0, path: String(b.path || '').slice(0, 120), note: String(b.note || '').slice(0, 60),
        inner_h: cl(b.innerH, 6000), inner_w: cl(b.innerW, 6000), vv_h: cl(b.vvH, 6000),
        screen_h: cl(b.screenH, 6000), screen_w: cl(b.screenW, 6000), avail_h: cl(b.availH, 6000),
        inset_top: cl(b.insetTop, 600), inset_bottom: cl(b.insetBottom, 600), shell_h: cl(b.shellH, 6000), dpr: Number(b.dpr) || 0,
      };
      const sql = 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';
      const params = ['device:report', JSON.stringify(rec), rec.at];
      try { await st.run(sql, params); } catch (e1) {
        try { await st.run(sql, ...params); } catch (e2) { return json({ ok: false, error: 'run_failed', e1: String(e1), e2: String(e2) }, 500); }
      }
      return json({ ok: true, saved: 'settings:device:report' });
    }
    if (url.pathname === '/api/loop' || url.pathname === '/api/loop/public' || url.pathname === '/api/loop/help' || url.pathname === '/api/rea/queue') {
      if (url.pathname.endsWith('/help')) {
        const { loopHelp, LOOP_VERSION } = await import('./agent/loop.js');
        const { reaQueueHelp, REA_QUEUE_VERSION } = await import('./agent/reaQueue.js');
        return json({ ok: true, version: LOOP_VERSION, help: loopHelp(), rea_queue: { version: REA_QUEUE_VERSION, help: reaQueueHelp() } });
      }
      if (url.pathname === '/api/rea/queue' && request.method === 'POST') {
        const { enqueueFromFindings, autoAnalyze } = await import('./agent/reaQueue.js');
        const enq = await enqueueFromFindings(deps.store, { limit: Number(url.searchParams.get('limit')) || 12 });
        const an = await autoAnalyze(deps.store, { limit: Number(url.searchParams.get('n')) || 3 });
        return json({ ok: true, enqueued: enq.inserted, scanned: enq.scanned, analyzed: an.analyzed, rows: an.rows });
      }
      if (url.pathname === '/api/rea/queue') {
        const { queueSummary, listTargets } = await import('./agent/reaQueue.js');
        const summary = await queueSummary(deps.store);
        const targets = (await listTargets(deps.store, { limit: Number(url.searchParams.get('limit')) || 15 }))
          .map((t) => ({ target: t.target, source: t.source, status: t.status, score: t.score, at: t.last_at || t.created_at, result: t.result_json || null }));
        return json({ ok: true, summary, targets });
      }
      if (url.pathname === '/api/loop' && request.method === 'POST') {
        const { selfHeal } = await import('./agent/loop.js');
        const { enqueueFromFindings, autoAnalyze } = await import('./agent/reaQueue.js');
        const mode = url.searchParams.get('mode') || 'both';
        const out = { ok: true, at: new Date().toISOString(), mode };
        if (mode !== 'heal') {
          out.enqueued = (await enqueueFromFindings(deps.store, { limit: 12 })).inserted;
          out.analyzed = (await autoAnalyze(deps.store, { limit: Number(url.searchParams.get('n')) || 3 })).rows;
        }
        if (mode !== 'queue') {
          const r = await selfHeal(deps.store, { env, maxRetry: 3 });
          out.heal = { bottleneck: r.bottleneck, actions: r.actions };
        }
        return json(out);
      }
      const { loopSummary, loopText } = await import('./agent/loop.js');
      const body = await loopSummary(deps.store, { env });
      if (url.pathname.endsWith('/public')) { body.recent = (body.recent || []).map((r) => ({ kind: r.kind, action: r.action, state: r.state, at: r.at })); body.public = true; }
      if (url.searchParams.get('format') === 'text') return new Response(loopText(body), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return json(body);
    }

    if (url.pathname === '/api/report' && request.method === 'GET') {
      try {
        const { activityReport } = await import('./agent/report.js');
        const rep = await activityReport(deps, { live: url.searchParams.get('live') === '1', origin: url.origin, env });
        if (url.searchParams.get('format') === 'text') {
          return new Response(rep.text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
        }
        return json({ ok: true, ...rep });
      } catch (e) {
        return json({ ok: false, error: 'report_failed', detail: String((e && e.message) || e).slice(0, 300) }, 500);
      }
    }

    // アバターは 70KB 超の base64 文字列として /api/dashboard に混ぜず、
    // ブラウザがキャッシュできる生画像として別エンドポイントで返す。
    if (url.pathname === '/api/character/avatar-image') {
      try {
        const ch = deps.engine && deps.engine.getCharacter ? await deps.engine.getCharacter() : null;
        const av = ch && ch.avatar_url ? String(ch.avatar_url) : '';
        const mm = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(av);
        if (!mm) return new Response('no avatar', { status: 404, headers: { 'cache-control': 'no-store' } });
        const bin = atob(mm[2]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        return new Response(bytes, { headers: { 'content-type': mm[1], 'cache-control': 'public, max-age=86400, immutable' } });
      } catch {
        return new Response('avatar error', { status: 500, headers: { 'cache-control': 'no-store' } });
      }
    }

    // x402 — 値札（402）を出し、facilitator が検証・決済した支払いだけを受け取って
    // 中身を返す。クライアントが付けたヘッダは一切信用しない。
    if ((url.pathname.startsWith('/api/x402-testnet/') || url.pathname.startsWith('/api/x402/')) && !url.pathname.startsWith('/api/x402/catalog')) {
      const { challenge, preflight, requiredHeader, responseHeader, verifyAndSettle, allItems, priceTagHtml } = await import('./agent/x402.js');
      const { createJob, recordReceipt } = await import('./agent/revenue.js');
      const resource = url.pathname.replace('/api/x402-testnet/', '').replace('/api/x402/', '');
      // 販路帰属: ?venue=<id> / X-WA-Venue を決済の source タグに載せる。
      // これが無いと「どの売り場が買い手を連れてきたか」を永久に測れない（KPI の未測定項目）。
      const { venueFromRequest, sourceTag } = await import('./agent/attribution.js');
      const venue = venueFromRequest(request, url);
      // 決済の前提を満たさない注文は、値札（402）より先に 400 で断る。
      // 「$1 を払ってから対象なしと言われる」事故を構造的に消す（納品側と同じ判定を使う）。
      //
      // ただし 400 で断るのは「決済ヘッダを持つ」呼び出しに限る。決済ヘッダの無い呼び出しは
      // 入力が空でも必ず 402（値札）を返す。買い手側ディレクトリは例示入力か空ボディで叩き、
      // 「402 が返るか」で掲載可否を決めるため、ここで 400 を返すと掲載されない（実測:
      // GET /api/x402/diff → 400 bad_input → CDP validate rejected）。
      const _payHeader = request.headers.get('PAYMENT-SIGNATURE') || request.headers.get('X-PAYMENT') || '';
      let _preBody = {};
      try { _preBody = await request.clone().json(); } catch (e) { _preBody = {}; }
      if (request.method === 'GET') for (const [k, v] of url.searchParams) if (!(k in _preBody)) _preBody[k] = v;
      const _pre = _preValidate(resource, _preBody);
      if (_payHeader && !_pre.ok) return json({ ok: false, ..._pre, charged: false, note: '入力が前提を満たさないため決済を要求していません（課金なし）' }, 400);
      const notFound = () => new Response(JSON.stringify({ ok: false, error: 'not_found', path: url.pathname }), { status: 404, headers: { 'content-type': 'application/json' } });
      if (!allItems(env).some((i) => i.resource === resource)) return notFound();
      // 自律で作った品は、値札・注文検査・納品をその「実行部品(op)＋固定引数(preset)」に写して扱う。
      const exItem = allItems(env).find((i) => i.resource === resource && i.op) || null;
      // 売りに出してよいかを先に確認する（受け取り先の形式・ネットワーク・facilitator の対応・
      // Solana なら feePayer）。確認できないものは値札を出さない。
      const pf = await preflight(env);
      if (!pf.ok) {
        return new Response(JSON.stringify({ ok: false, enabled: false, error: pf.error, reason: pf.reason }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      }
      const ch = challenge(resource, env, { origin: url.origin, feePayer: pf.feePayer, solanaFeePayer: pf.solanaFeePayer, method: request.method });
      if (!ch || !ch.configured) {
        return new Response(JSON.stringify({ ok: false, enabled: false, error: 'not_configured', reason: ch?.reason || pf.reason }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      const header = _payHeader;
      const { validateOrder, fulfillOrder, ORDER_SPECS } = await import('./agent/fulfill.js');
      const { logHit } = await import('./agent/hits.js');
      if (!header) {
        // 値札には注文書（入力仕様）も添える。買い手はこれを見て本文を組み立てる。
        // 無料枠がある品目は、値札の中でもその入口を案内する（試してから買える）。
        const { freeTierResources, freeQuotaFor: freeLimitFor } = await import('./agent/freemium.js');
        const priced = { ...ch.body, order_spec: ORDER_SPECS[exItem && exItem.op ? exItem.op : resource] || null,
          free_option: freeTierResources().includes(resource)
            ? { url: `${url.origin}/api/free/${resource}${venue && venue !== 'direct' ? `?venue=${venue}` : ''}`, daily_limit_per_ip: freeLimitFor(env, resource), note: 'No payment needed up to the daily limit (per IP, per UTC day). Pay here only if you need the limit removed.' }
            : null };
        if (resource !== 'diligence-pack') priced.upsell = { resource: 'diligence-pack', name: 'Due-diligence pack (website capability map + on-chain balances)', price_usdc: 1000000, price_usd: 1.0, url: `${url.origin}/api/x402/diligence-pack${venue && venue !== 'direct' ? `?venue=${venue}` : ''}`, order_spec: ORDER_SPECS['diligence-pack'] || null, note: 'Most x402 spend on Base is in the $1+ band; this one call is the consolidated $1 product.' };
        await logHit(deps.store, request, { resource, kind: 'challenge', status: 402, venue });
        // ブラウザ（Accept: text/html）には人間用の値札ページ。機械は JSON のまま。
        const _accept = String(request.headers.get('accept') || '');
        if (_accept.includes('text/html') && !_accept.includes('application/json')) {
          return new Response(priceTagHtml(priced), { status: 402, headers: { 'content-type': 'text/html; charset=utf-8', 'PAYMENT-REQUIRED': requiredHeader(ch.body), 'WWW-Authenticate': `X402 realm="${env.AGENT_NAME || 'wealth-agent'}", resource="/api/x402/${resource}"`, 'cache-control': 'no-store', ...PAY_CORS } });
        }
        return new Response(JSON.stringify(priced), { status: 402, headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': requiredHeader(ch.body), 'WWW-Authenticate': `X402 realm="${env.AGENT_NAME || 'wealth-agent'}", resource="/api/x402/${resource}"`, 'cache-control': 'no-store', ...PAY_CORS } });
      }
      // 決済「前」に注文内容を検査する。満たさないものは請求せずに断る（払わせてから失敗しない）。
      let body = {};
      try { const t = await request.text(); body = t ? JSON.parse(t) : {}; } catch { body = {}; }
      if (request.method === 'GET') for (const [k, v] of url.searchParams) if (!(k in body)) body[k] = v;
      const order = validateOrder(exItem ? exItem.op : resource, exItem ? { ...body, ...(exItem.preset || {}) } : body);
      if (!order.ok) {
        return new Response(JSON.stringify({ ok: false, charged: false, ...order }), { status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      }
      const settled = await verifyAndSettle({ env, resource, paymentHeader: header, feePayer: pf.feePayer });
      if (!settled.ok) {
        // 保留は決済が確定していない状態。中身は渡さず、入金としても記録しない。
        const status = settled.error === 'facilitator_unreachable' ? 503 : 402;
        await logHit(deps.store, request, { resource, kind: 'rejected', status, note: settled.error, venue });
        return new Response(JSON.stringify({ ...ch.body, error: settled.error, detail: settled.detail || null, note: settled.note }), { status, headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': requiredHeader(ch.body), 'WWW-Authenticate': `X402 realm="${env.AGENT_NAME || 'wealth-agent'}", resource="/api/x402/${resource}"`, 'cache-control': 'no-store', ...PAY_CORS } });
      }
      await logHit(deps.store, request, { resource, kind: 'paid', status: 200, note: settled.tx || null, venue });
      const item = X402_CATALOG.find((i) => i.resource === resource);
      // 買い手の住所が自分の受取先と同じなら、それは自己購入（動作確認）。
      // 外部の売上と混ぜない印を付けて記録する。
      // 自己テストの見分けは3経路: ①自分の受取先と一致 ②X402_SELFTEST_ADDRS に列挙した検証用ウォレット
      // ③本人トークン付きの申告ヘッダ。認証の無いヘッダは受け付けない（他人が自称して売上を隠せてしまうため）。
      // 取りこぼすと自己テストが実売上として台帳に載り、数字が嘘になる。
      const ownAddrs = [env.X402_PAY_TO, env.X402_SOLANA_PAY_TO, ...String(env.X402_SELFTEST_ADDRS || '').split(',')]
        .filter(Boolean).map((a) => String(a).trim().toLowerCase()).filter(Boolean);
      const headerSelfTest = String(request.headers.get('x-wa-selftest') || '') === '1' && authorized(request, env);
      const selfTest = headerSelfTest || (!!settled.payer && ownAddrs.includes(String(settled.payer).toLowerCase()));
      const receipt = await recordReceipt(deps.store, {
        self_test: selfTest,
        source: sourceTag(venue, resource), external_id: settled.tx || `x402_${Date.now().toString(36)}`,
        // USDC は最小単位（6桁）で届くので、人が読める単位に直してから記録する。
        amount: Number(((Number(settled.amount) || 0) / 1e6).toFixed(6)), currency: 'USDC', fee: settled.fee || 0, payer: settled.payer,
        job_id: body.job_id || null, thread_id: body.thread_id || null,
        signature_verified: true, testnet: env.X402_TESTNET === '1', raw: settled,
      }).catch((e) => ({ ok: false, error: 'receipt_failed', detail: String(e?.message || e).slice(0, 160) }));
      // 入金は確定したのに台帳に載らなかった場合は、黙って流さず必ず人の判断を仰ぐ
      // （売上の取りこぼしが無言で起きるのが一番まずい）。テスト網の 0 円決済は対象外。
      if (!receipt?.ok && env.X402_TESTNET !== '1') {
        await deps.store.insert('approvals', {
          id: `apr_rcpt_${Date.now().toString(36)}`, task_id: null, action: 'x402_receipt_not_recorded', risk_level: 'high',
          payload: JSON.stringify({ resource, tx: settled.tx, payer: settled.payer, amount: settled.amount, error: receipt?.error || null, detail: receipt?.detail || null }),
          status: 'pending', requested_at: new Date().toISOString(), decided_at: null,
          note: '決済は成立しましたが台帳に記録できませんでした。売上の取りこぼしなので内容を確認してください。',
        }).catch(() => {});
      }
      // 確定した注文は、その場で作って同じ応答で渡す（買い手を待たせない・取りこぼさない）。
      const done = await fulfillOrder(exItem ? exItem.op : resource, order.input, { router: deps.router, research: deps.research, store: deps.store });
      const job = await createJob(deps.store, {
        title: `${item?.description || resource}（x402 受注）`, price: settled.amount,
        state: done.ok ? 'delivered' : 'in_progress', thread_id: body.thread_id || null,
        note: done.ok ? `x402 で受注し即納品: ${settled.payer || 'unknown payer'}`
          : `x402 で受注・納品失敗（${done.error}）。返金か再納品の判断が必要: ${settled.payer || 'unknown payer'} / tx ${settled.tx || '-'}`,
      }).catch(() => null);
      if (!done.ok) {
        await deps.store.insert('approvals', {
          id: `apr_x402_${Date.now().toString(36)}`, task_id: null, action: 'x402_refund_or_redeliver', risk_level: 'high',
          payload: JSON.stringify({ resource, tx: settled.tx, payer: settled.payer, amount: settled.amount, error: done.error, job_id: job?.id || null }),
          status: 'pending', requested_at: new Date().toISOString(), decided_at: null, note: '支払い済みの注文を納品できませんでした。返金か再納品を決めてください。',
        }).catch(() => {});
      }
      return new Response(JSON.stringify({
        ok: done.ok, resource, status: done.ok ? 'delivered' : 'paid_not_delivered', job_id: job?.id || null,
        receipt_id: receipt?.receipt?.id || null, tx: settled.tx || null,
        deliverable: done.ok ? done.deliverable : null,
        error: done.ok ? null : done.error,
        note: done.ok ? '支払いを確認し、納品しました。' : '支払いは確認しましたが納品に失敗しました。担当者が返金か再納品を行います。',
      }), { status: done.ok ? 200 : 502, headers: { 'content-type': 'application/json', 'PAYMENT-RESPONSE': responseHeader(settled.response), ...PAY_CORS } });
    }

    const m = matchRoute(deps.api.routes, request.method, url.pathname);
    if (!m) return json({ ok: false, error: 'not_found', path: url.pathname }, 404);

    let body = {};
    if (request.method !== 'GET') {
      try {
        const text = await request.text();
        body = text ? JSON.parse(text) : {};
      } catch { body = {}; }
    }
    const req = { query: url.searchParams, headers: request.headers, url };

    try {
      const out = await m.handler(req, body, m.params);
      // Every successful route response carries an explicit ok:true. The PWA
      // guards on d.ok, so a payload without the flag would be misread as a
      // failure and render the error banner despite valid data.
      const payload = (out && typeof out === 'object' && !Array.isArray(out) && !('ok' in out))
        ? { ok: true, ...out }
        : out;
      const status = payload && payload.ok === false ? 400 : 200;
      return json(payload, status);
    } catch (e) {
      // Never leak internals; log the real error into the runs table.
      try {
        await deps.store.insert('runs', {
          id: `err_${Date.now().toString(36)}`, task_id: null, mission_id: null, state: 'api_error',
          step: 0, summary: `${url.pathname}: ${String(e.message || e).slice(0, 300)}`, detail: JSON.stringify({ stack: String(e.stack || '').slice(0, 1200) }),
          created_at: new Date().toISOString(),
        });
      } catch { /* ignore */ }
      return json({ ok: false, error: 'internal_error', detail: String(e.message || e).slice(0, 300) }, 500);
    }
  },

  /** Cron Trigger entry — the autonomous heartbeat. */
  async scheduled(event, env, ctx) {
    const deps = wire(env);
    try {
      await ensureSchema(deps.store);
      // 動きっぱなしに見えるだけの作業を先に回収してから周期を回す。
      let reaped = null;
      try { const { reapStaleTasks } = await import('./engine/reaper.js'); reaped = await reapStaleTasks(deps.store, env); } catch (e) { reaped = { error: String((e && e.message) || e) }; }
      const report = await deps.scheduler.scheduledTick({ source: 'cron' });
      // IndexNow: 口座不要の検索面への自動通知（1日1回・settings で抑止）
      try {
        const { pingIndexNow } = await import('./agent/indexnow.js');
        report.indexnow = await pingIndexNow(env, deps);
      } catch (e) { report.indexnow = { ok: false, error: String((e && e.message) || e) }; }
      console.log('scheduled tick', JSON.stringify(report).slice(0, 1200), 'reaped', JSON.stringify(reaped || {}).slice(0, 300));
    } catch (e) {
      console.error('scheduled tick failed', e.message);
      try {
        await deps.store.insert('runs', {
          id: `cerr_${Date.now().toString(36)}`, task_id: null, mission_id: null, state: 'cron_error',
          step: 0, summary: String(e.message || e).slice(0, 300), detail: null, created_at: new Date().toISOString(),
        });
      } catch { /* ignore */ }
    }
  },
};

export { wire, json, matchRoute };
