// Worker entry point — routing, auth, cron, and dependency wiring.
// Runs identically on Cloudflare Workers and on the local Node dev server
// (server/local.mjs) because everything here is web-standard.

import { Store, ensureSchema } from './db.js';
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

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
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
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') return json({ ok: true }, 204);

    if (!url.pathname.startsWith('/api/')) {
      // Static PWA assets (Cloudflare): fall back to the index for SPA routes.
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        const res = await env.ASSETS.fetch(request);
        if (res.status === 404) {
          const indexUrl = new URL('/index.html', url.origin);
          return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
        }
        return res;
      }
      return new Response('Not found', { status: 404 });
    }

    const deps = wire(env);
    try {
      if (!schemaDone.has(env)) {
        await ensureSchema(deps.store);
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
    const isPaywall = url.pathname.startsWith('/api/x402/') && !url.pathname.startsWith('/api/x402/catalog');
    if (!isWebhook && !isPaywall && !authorized(request, env)) {
      return json({ ok: false, error: 'unauthorized', hint: 'Authorization: Bearer <OWNER_TOKEN> が必要です' }, 401);
    }

    // x402 — 値札（402）を出し、facilitator が検証・決済した支払いだけを受け取って
    // 中身を返す。クライアントが付けたヘッダは一切信用しない。
    if (url.pathname.startsWith('/api/x402/') && !url.pathname.startsWith('/api/x402/catalog')) {
      const { challenge, preflight, requiredHeader, responseHeader, verifyAndSettle, X402_CATALOG } = await import('./agent/x402.js');
      const { createJob, recordReceipt } = await import('./agent/revenue.js');
      const resource = url.pathname.replace('/api/x402/', '');
      const notFound = () => new Response(JSON.stringify({ ok: false, error: 'not_found', path: url.pathname }), { status: 404, headers: { 'content-type': 'application/json' } });
      if (!X402_CATALOG.some((i) => i.resource === resource)) return notFound();
      // 売りに出してよいかを先に確認する（受け取り先の形式・ネットワーク・facilitator の対応・
      // Solana なら feePayer）。確認できないものは値札を出さない。
      const pf = await preflight(env);
      if (!pf.ok) {
        return new Response(JSON.stringify({ ok: false, enabled: false, error: pf.error, reason: pf.reason }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      }
      const ch = challenge(resource, env, { origin: url.origin, feePayer: pf.feePayer });
      if (!ch || !ch.configured) {
        return new Response(JSON.stringify({ ok: false, enabled: false, error: 'not_configured', reason: ch?.reason || pf.reason }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      const header = request.headers.get('PAYMENT-SIGNATURE') || request.headers.get('X-PAYMENT') || '';
      if (!header) {
        return new Response(JSON.stringify(ch.body), { status: 402, headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': requiredHeader(ch.body.accepts[0]), 'cache-control': 'no-store' } });
      }
      const settled = await verifyAndSettle({ env, resource, paymentHeader: header, feePayer: pf.feePayer });
      if (!settled.ok) {
        // 保留は決済が確定していない状態。中身は渡さず、入金としても記録しない。
        const status = settled.error === 'facilitator_unreachable' ? 503 : 402;
        return new Response(JSON.stringify({ ...ch.body, error: settled.error, detail: settled.detail || null, note: settled.note }), { status, headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': requiredHeader(ch.body.accepts[0]), 'cache-control': 'no-store' } });
      }
      let body = {};
      try { const t = await request.text(); body = t ? JSON.parse(t) : {}; } catch { body = {}; }
      const item = X402_CATALOG.find((i) => i.resource === resource);
      const receipt = await recordReceipt(deps.store, {
        source: 'x402', external_id: settled.tx || `x402_${Date.now().toString(36)}`,
        // USDC は最小単位（6桁）で届くので、人が読める単位に直してから記録する。
        amount: Number(((Number(settled.amount) || 0) / 1e6).toFixed(6)), currency: 'USDC', fee: settled.fee || 0, payer: settled.payer,
        job_id: body.job_id || null, thread_id: body.thread_id || null,
        signature_verified: true, raw: settled,
      }).catch(() => null);
      const job = await createJob(deps.store, {
        title: `${item?.description || resource}（x402 受注）`, price: settled.amount,
        state: 'approved', thread_id: body.thread_id || null,
        note: `x402 で受注: ${settled.payer || 'unknown payer'}`,
      }).catch(() => null);
      return new Response(JSON.stringify({
        ok: true, resource, status: 'accepted', job_id: job?.id || null,
        receipt_id: receipt?.receipt?.id || null,
        note: '支払いを確認しました。納品は案件として実行されます。',
      }), { status: 200, headers: { 'content-type': 'application/json', 'PAYMENT-RESPONSE': responseHeader(settled.response) } });
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
      const report = await deps.scheduler.scheduledTick({ source: 'cron' });
      console.log('scheduled tick', JSON.stringify(report).slice(0, 1500));
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
