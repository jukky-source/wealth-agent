#!/usr/bin/env node
// Local development / verification server.
// Runs the REAL Worker code against a real SQLite database with the real API
// surface — so the acceptance tests exercise production behaviour, not a mock.
//
//   node server/local.mjs [--port 8787] [--db .local-data/agent.sqlite] [--autorun]
//
// Env vars are read from the environment (GEMINI_API_KEY, GROQ_API_KEY,
// OPENROUTER_API_KEY, OWNER_TOKEN, ENGINE_STEPS_PER_TICK, ...). With no keys,
// the deterministic fallback keeps every feature working.

import http from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Shim } from './sqlite-d1.mjs';
import worker from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argVal('--port', process.env.PORT || 8787));
const DB_PATH = path.resolve(ROOT, argVal('--db', '.local-data/agent.sqlite'));
const AUTORUN = args.includes('--autorun') || process.env.AUTORUN === 'true';

if (!existsSync(path.dirname(DB_PATH))) await mkdir(path.dirname(DB_PATH), { recursive: true });

// Load .dev.vars (written by `node scripts/set-keys.mjs`) when present so keys
// never need to live in the shell history. Real env vars always win.
const DEV_VARS = path.resolve(ROOT, '.dev.vars');
if (existsSync(DEV_VARS)) {
  const { readFileSync } = await import('node:fs');
  for (const line of readFileSync(DEV_VARS, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = {
      // 稼ぐモードの実行レイヤ — 決済通知の検証と x402 の受け取り先（本番は vars/secrets）
      WEBHOOK_SECRET: process.env.WEBHOOK_SECRET ?? undefined,
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? undefined,
      X402_PAY_TO: process.env.X402_PAY_TO ?? undefined,
      X402_NETWORK: process.env.X402_NETWORK ?? undefined,
      X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL ?? undefined,
      X402_ASSET: process.env.X402_ASSET ?? undefined,
  DB: new D1Shim(DB_PATH),
  ASSETS: null,
  RUNTIME: 'node-local',
  AGENT_NAME: process.env.AGENT_NAME || 'Wealth Agent',
  ENGINE_STEPS_PER_TICK: process.env.ENGINE_STEPS_PER_TICK || '3',
  AI_DAILY_CALL_BUDGET: process.env.AI_DAILY_CALL_BUDGET || '300',
  ALLOW_PAID_AI: process.env.ALLOW_PAID_AI || 'false',
  PAID_DAILY_CAP_USD: process.env.PAID_DAILY_CAP_USD || '',
  OWNER_TOKEN: process.env.OWNER_TOKEN || '',
  // Cloud-PC runner pairing (off unless explicitly enabled)
  RUNNER_ENABLED: process.env.RUNNER_ENABLED || 'false',
  RUNNER_TOKEN: process.env.RUNNER_TOKEN || '',
  RUNNER_ALLOW: process.env.RUNNER_ALLOW || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY || '',
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || '',
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  SEARCH_ENDPOINT: process.env.SEARCH_ENDPOINT || '',
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) throw new Error('dir');
    const buf = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'service-worker-allowed': '/',
    });
    res.end(buf);
  } catch {
    // SPA fallback
    try {
      const buf = await readFile(path.join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const host = req.headers.host || `localhost:${PORT}`;
    const request = new Request(`http://${host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    try {
      const response = await worker.fetch(request, env, { waitUntil: () => {}, passThroughOnException: () => {} });
      const text = await response.text();
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(response.status, headers);
      res.end(text);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'local_server_error', detail: String(e.message || e) }));
    }
    return;
  }
  await serveStatic(req, res);
});

let timer = null;
if (AUTORUN) {
  const everyMs = Number(process.env.AUTORUN_INTERVAL_MS || 60000);
  timer = setInterval(async () => {
    try {
      const request = new Request(`http://localhost:${PORT}/api/scheduler/tick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const r = await worker.fetch(request, env, { waitUntil: () => {} });
      const j = await r.json();
      console.log(`[autorun] tick ${new Date().toISOString()} ->`, (j.steps || []).map((s) => s.step).join(','));
    } catch (e) {
      console.error('[autorun] tick failed:', e.message);
    }
  }, everyMs);
}

server.listen(PORT, async () => {
  // ensure schema + seed so the first request always works
  try {
    const init = new Request(`http://localhost:${PORT}/api/admin/seed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const r = await worker.fetch(init, env, { waitUntil: () => {} });
    const j = await r.json();
    console.log(`[init] seed ok=${j.ok} character_created=${j.character_created} workflows=${(j.workflows || []).length}`);
  } catch (e) {
    console.error('[init] seed failed:', e.message);
  }
  const providers = [env.GEMINI_API_KEY && 'gemini', env.GROQ_API_KEY && 'groq', env.OPENROUTER_API_KEY && 'openrouter'].filter(Boolean);
  console.log(`\n  Wealth Agent — local server`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  DB: ${DB_PATH}`);
  console.log(`  AI providers: ${providers.length ? providers.join(', ') : 'none (deterministic fallback active)'}`);
  console.log(`  Auth: ${env.OWNER_TOKEN ? 'OWNER_TOKEN required' : 'open (dev)'}`);
  console.log(`  Autorun: ${AUTORUN ? `every ${process.env.AUTORUN_INTERVAL_MS || 60000}ms` : 'off'}\n`);
});

process.on('SIGINT', () => {
  if (timer) clearInterval(timer);
  try { env.DB.close(); } catch { /* ignore */ }
  console.log('\nshutting down');
  process.exit(0);
});
