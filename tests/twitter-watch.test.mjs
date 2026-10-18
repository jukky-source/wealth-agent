// 監視アカウントの選定と、AIビジネス枠の採点のテスト（網に出ない）
import { WATCH_ENTRIES, DEFAULT_WATCH, watchEntries, watchList, oppScore, isOpportunityTweet, trackScore, tweetScore, sweepTwitter } from '../src/agent/twitter.js';

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } }

// 1) 監視リストは実測して採用したものだけ（handle と topic を持つ）
ok('entries have handle+topic', WATCH_ENTRIES.every((e) => e.handle && (e.topic === 'perk' || e.topic === 'ai')));
ok('entries are unique', new Set(WATCH_ENTRIES.map((e) => e.handle.toLowerCase())).size === WATCH_ENTRIES.length);
ok('has both topics', WATCH_ENTRIES.some((e) => e.topic === 'ai') && WATCH_ENTRIES.some((e) => e.topic === 'perk'));
ok('DEFAULT_WATCH derives handles', DEFAULT_WATCH.length === WATCH_ENTRIES.length && DEFAULT_WATCH.includes('devpost'));

// 2) AIビジネス枠: 金が動く機会だけ拾う
ok('bounty+amount+deadline scores high', oppScore({ text: 'Bounty: $6,000 for creators, apply by 10/30' }) >= 3);
ok('grant scores', oppScore({ text: 'We are giving a grant of 500 USDC to builders' }) >= 3);
ok('plain model news scores 0', oppScore({ text: 'Gemini 4 reaches 45.3% on the benchmark today' }) === 0);
ok('crypto hype is dropped', oppScore({ text: 'airdrop guaranteed 100x, join now' }) === 0);
ok('isOpportunityTweet default', isOpportunityTweet({ text: 'hackathon with a $100,000 prize pool, ends 11/2' }) === true);
ok('isOpportunityTweet rejects noise', isOpportunityTweet({ text: 'I shipped a new feature' }) === false);

// 3) topic ごとの採点の振り分け
ok('trackScore routes ai', trackScore({ text: 'hackathon $100,000 prize, ends 11/2' }, 'ai') >= 3);
ok('trackScore routes perk', trackScore({ text: '対象商品を2個購入で100円引き 10/19まで' }, 'perk') >= 3);
ok('tweetScore ignores opp-only text', tweetScore({ text: 'Hackathon with a $100,000 prize pool, apply by 10/30' }) < 3);

// 4) env 差し替え（handle:ai 記法）
ok('watchEntries parses :ai', JSON.stringify(watchEntries({ TW_WATCH: 'foo,bar:ai' })) === JSON.stringify([{ handle: 'foo', topic: 'perk' }, { handle: 'bar', topic: 'ai' }]));
ok('watchList keeps compat', JSON.stringify(watchList({ TW_WATCH: '@foo,bar:ai' })) === JSON.stringify(['foo', 'bar']));

// 5) 巡回: 2つの topic を別々に採点して貯める（fetch はスタブ）
const posts = {
  perk_acct: [{ id: '1', text: '対象商品を2個購入で100円引き 10/19まで', created_at: '2026-10-17T00:00:00Z' }],
  ai_acct: [{ id: '2', text: 'Bounty: $6,000 for creators, apply by 10/30', created_at: '2026-10-17T00:00:00Z' }],
  quiet: [{ id: '3', text: 'hello world', created_at: '2026-10-17T00:00:00Z' }],
};
const fetchImpl = async (url) => {
  const m = /\/2\/profile\/([^/]+)\/statuses/.exec(String(url));
  const h = m ? decodeURIComponent(m[1]) : '';
  return { ok: true, status: 200, json: async () => ({ results: posts[h] || [] }) };
};
const saved = [];
const store = {
  run: async (sql, ...args) => { if (/INSERT/.test(sql)) saved.push(args); return { meta: { changes: 1 } }; },
  all: async () => [], first: async () => ({ n: 0 }),
};
const r = await sweepTwitter(store, { fetchImpl, entries: [{ handle: 'perk_acct', topic: 'perk' }, { handle: 'ai_acct', topic: 'ai' }, { handle: 'quiet', topic: 'ai' }], queries: [], now: '2026-10-18T00:00:00Z' });
ok('sweep kept 2', r.kept === 2 && saved.length === 2);
ok('sweep tags topic', saved.some((a) => a[a.length - 1] === 'ai') && saved.some((a) => a[a.length - 1] === 'perk'));
ok('sweep records per-source hits', r.sources.find((s) => s.handle === 'quiet').hits === 0);
ok('sweep records errors array', Array.isArray(r.errors) && r.errors.length === 0);

console.log('twitter-watch: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
