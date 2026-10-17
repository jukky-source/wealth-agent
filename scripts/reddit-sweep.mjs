// Reddit 横断巡回 — サンドボックス側から実行する（Worker からは Reddit 公式APIに到達できない）
//
//   使い方: node scripts/reddit-sweep.mjs [--limit 14] [--mode top|hot|new] [--per 25] [--push]
//
// 読むだけ。投稿・コメント・DM はしない。拾った結果は /api/perks/ingest に push する。
// top は time を渡さないと空が返るサブレがあるので time=week を付け、
// それでも0件なら hot に切り替えて取り直す。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { sweepPlan, selectFromSubreddit, MCP_TOOL } from '../src/agent/reddit.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(arg('limit', 14));
const MODE = arg('mode', 'top');
const PER = Number(arg('per', 25));
const TIME = arg('time', 'week');
const PUSH = argv.includes('--push');
const SERVER = arg('server', 'mcp_7c69c40f');
const BASE = arg('base', 'https://wealth-agent.wealthagent-app.workers.dev');
const TOKEN_PATH = arg('token', '.secrets/owner_token');

function mcpCall(tool, sub, per) {
  const a = { subreddit_name: sub, limit: per };
  if (tool === MCP_TOOL.top) a.time = TIME;
  const out = execFileSync('gsk', ['mcp', 'call', SERVER, '-t', tool, '-a', JSON.stringify(a)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
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
    let tool = s.tool;
    let r = selectFromSubreddit(mcpCall(tool, s.name, PER), s.name, { minScore: 1, max: 5 });
    if (r.scanned === 0 && tool !== MCP_TOOL.hot) {
      tool = MCP_TOOL.hot;
      const r2 = selectFromSubreddit(mcpCall(tool, s.name, PER), s.name, { minScore: 1, max: 5 });
      if (r2.scanned > 0) r = r2;
    }
    results.push({ subreddit: s.name, genre: s.genre, tool, scanned: r.scanned, kept: r.kept.length, top: r.kept[0] ? r.kept[0].title.slice(0, 90) : null });
    for (const p of r.kept) items.push({ title: p.title, url: p.url, excerpt: p.excerpt, subreddit: s.name, score: p.score, source: `reddit:${s.name}` });
    seen[s.name] = new Date().toISOString();
  } catch (e) {
    results.push({ subreddit: s.name, genre: s.genre, error: String(e.message || e).slice(0, 160) });
  }
}

writeFileSync(seenPath, JSON.stringify(seen, null, 1));
writeFileSync('/tmp/reddit-sweep.json', JSON.stringify({ at: new Date().toISOString(), mode: MODE, plan: plan.map((p) => p.name), results, items }, null, 1));

const scanned = results.reduce((n, r) => n + (r.scanned || 0), 0);
console.log(`Reddit 巡回: ${plan.length}サブレ / 走査 ${scanned}件 / 有益情報 ${items.length}件（読むだけ・原価0）`);
for (const r of results) {
  if (r.error) console.log(`  NG r/${r.subreddit} (${r.genre}): ${r.error}`);
  else console.log(`  OK r/${r.subreddit} (${r.genre}/${r.tool}): ${r.scanned}件中 ${r.kept}件採用  ${r.top || ''}`);
}
if (items.length) { console.log('  --- 採用したもの ---'); for (const i of items) console.log(`   * [${i.subreddit}] ${i.title}`); }

if (PUSH) {
  const token = readFileSync(TOKEN_PATH, 'utf8').trim();
  const res = await fetch(`${BASE}/api/perks/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ items, source: 'reddit' }),
  });
  console.log(`push: http ${res.status} ${(await res.text()).slice(0, 400)}`);
}
