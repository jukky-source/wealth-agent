// Reddit 横断巡回 — サンドボックス側から実行する（Worker からは Reddit に到達できない）
//
//   使い方: node scripts/reddit-sweep.mjs [--limit 8] [--mode top|hot|new] [--per 25] [--push]
//
// 読むだけ。投稿・コメント・DM はしない。拾った結果は /api/perks/ingest に push する。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { sweepPlan, selectFromSubreddit } from '../src/agent/reddit.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(arg('limit', 8));
const MODE = arg('mode', 'top');
const PER = Number(arg('per', 25));
const PUSH = argv.includes('--push');
const SERVER = arg('server', 'mcp_7c69c40f');
const BASE = arg('base', 'https://wealth-agent.wealthagent-app.workers.dev');
const TOKEN_PATH = arg('token', '.secrets/owner_token');

function mcpCall(tool, args) {
  const out = execFileSync('gsk', ['mcp', 'call', SERVER, '-t', tool, '-a', JSON.stringify(args)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const env = JSON.parse(out);
  if (env.status !== 'ok') throw new Error(`gsk status=${env.status} message=${env.message}`);
  return env.data;
}

const seenPath = '/tmp/reddit-seen.json';
let seen = {};
try { seen = JSON.parse(readFileSync(seenPath, 'utf8')); } catch { seen = {}; }

const plan = sweepPlan({ limit: LIMIT, seen, mode: MODE });
const results = [];
const items = [];

for (const s of plan) {
  try {
    const raw = mcpCall(s.tool, { subreddit_name: s.name, limit: PER });
    const r = selectFromSubreddit(raw, s.name, { minScore: 1, max: 5 });
    results.push({ subreddit: s.name, genre: s.genre, scanned: r.scanned, kept: r.kept.length, top: r.kept[0] ? r.kept[0].title.slice(0, 90) : null });
    for (const p of r.kept) items.push({ title: p.title, url: p.url, excerpt: p.excerpt, subreddit: s.name, score: p.score, source: `reddit:${s.name}` });
    seen[s.name] = new Date().toISOString();
  } catch (e) {
    results.push({ subreddit: s.name, genre: s.genre, error: String(e.message || e).slice(0, 160) });
  }
}

writeFileSync(seenPath, JSON.stringify(seen, null, 1));
writeFileSync('/tmp/reddit-sweep.json', JSON.stringify({ at: new Date().toISOString(), mode: MODE, plan: plan.map((p) => p.name), results, items }, null, 1));

console.log(`Reddit 巡回: ${plan.length}サブレ / 有益情報 ${items.length}件（読むだけ・原価0）`);
for (const r of results) {
  if (r.error) console.log(`  NG r/${r.subreddit} (${r.genre}): ${r.error}`);
  else console.log(`  OK r/${r.subreddit} (${r.genre}): ${r.scanned}件中 ${r.kept}件採用  ${r.top || ''}`);
}

if (PUSH) {
  const token = readFileSync(TOKEN_PATH, 'utf8').trim();
  const res = await fetch(`${BASE}/api/perks/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ items, source: 'reddit' }),
  });
  const body = await res.text();
  console.log(`push: http ${res.status} ${body.slice(0, 500)}`);
}
