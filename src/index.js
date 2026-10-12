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

    if (!authorized(request, env)) {
      return json({ ok: false, error: 'unauthorized', hint: 'Authorization: Bearer <OWNER_TOKEN> が必要です' }, 401);
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
