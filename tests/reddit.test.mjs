// Reddit 横断収集のテスト — 経路の制約・選別・巡回計画
import {
  SUBREDDITS, MCP_TOOL, sweepPlan, postsFromMcp, normalizePost,
  benefitScore, rankPosts, toPerkItems, selectFromSubreddit, redditPlanText, redditHelp,
} from '../src/agent/reddit.js';

let pass = 0; const fails = [];
const t = async (name, fn) => {
  try { await fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); }
};
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m = '') => { if (!v) throw new Error(m || 'expected truthy'); };

// gsk mcp call が返す実際の形（入れ子の文字列）
const ENVELOPE = JSON.stringify({
  meta: null,
  content: [{ type: 'text', text: JSON.stringify([
    { id: 'p1', title: 'Get $14.50 for verifying your Reddit account', author: 'a', score: 210, subreddit: 'beermoney', url: 'https://www.reddit.com/r/beermoney/comments/p1/x/', created_at: '2026-10-16T17:36:18+00:00', comment_count: 42, content: 'they pay $14.50' },
    { id: 'p2', title: 'Is this a scam? help me', author: 'b', score: 3, subreddit: 'beermoney', url: 'https://www.reddit.com/r/beermoney/comments/p2/y/', content: '' },
  ]) }],
});

await t('サブレ一覧はジャンル横断で、なぜ見るかを持つ', async () => {
  ok(SUBREDDITS.length >= 20, `少なすぎる: ${SUBREDDITS.length}`);
  for (const s of SUBREDDITS) { ok(s.name && s.genre && s.why, `欠けがある: ${JSON.stringify(s)}`); }
  const genres = new Set(SUBREDDITS.map((s) => s.genre));
  ok(genres.size >= 8, `ジャンルが少ない: ${genres.size}`);
});

await t('MCP の戻り値を投稿配列にできる（入れ子文字列 / 配列 / 壊れた値）', async () => {
  const a = postsFromMcp(ENVELOPE);
  eq(a.length, 2, 'envelope');
  eq(a[0].id, 'p1');
  eq(postsFromMcp([{ id: 'x' }]).length, 1, '素の配列');
  eq(postsFromMcp({ content: [{ type: 'text', text: '[{"id":"z"}]' }] }).length, 1, 'オブジェクト');
  eq(postsFromMcp('not json').length, 0, '壊れた値');
  eq(postsFromMcp(null).length, 0, 'null');
});

await t('投稿の正規化', async () => {
  const p = normalizePost({ id: 'a', title: 't', url: 'https://x/1', score: 10, comment_count: 2, created_at: '2026-10-16T00:00:00Z' }, 'deals');
  eq(p.subreddit, 'deals', 'サブレが補われる');
  eq(p.score, 10);
  eq(p.comments, 2);
  const q = normalizePost({ id: 'b', permalink: '/r/x/comments/1/y/' }, 'x');
  ok(q.url.startsWith('https://www.reddit.com/r/x'), 'permalink からURLを作る');
});

await t('有益情報スコア: 金額+賛成で上がり、質問・誇大で下がる', async () => {
  const good = benefitScore({ title: 'Get $14.50 for verifying your account', score: 210 });
  const bad = benefitScore({ title: 'Is this a scam? help me', score: 3 });
  const hype = benefitScore({ title: 'Guaranteed 100x returns, to the moon', score: 500 });
  ok(good > bad, '金額つきの報告が上');
  ok(hype < 0, '誇大はマイナス');
});

await t('選別: 有益なものだけ残る', async () => {
  const posts = postsFromMcp(ENVELOPE).map((p) => normalizePost(p, 'beermoney'));
  const ranked = rankPosts(posts);
  eq(ranked.length, 1, '質問は落ちる');
  ok(ranked[0].title.includes('$14.50'));
  ok(ranked[0].beneficial === true);
});

await t('1サブレの結果をまとめる（scanned / kept / dropped）', async () => {
  const r = selectFromSubreddit(ENVELOPE, 'beermoney', { max: 5 });
  eq(r.subreddit, 'beermoney');
  eq(r.scanned, 2);
  eq(r.kept.length, 1);
  eq(r.dropped, 1);
});

await t('取り込み用に変換すると reddit:<subreddit> が出典になる', async () => {
  const items = toPerkItems(postsFromMcp(ENVELOPE).map((p) => normalizePost(p, 'beermoney')));
  eq(items.length, 1);
  eq(items[0].source, 'reddit:beermoney');
  ok(items[0].key && items[0].url && items[0].title, 'perk の形になっている');
  ok(items[0].outlay_jpy === 0, 'Reddit 由来は先払い0で入る');
});

await t('巡回計画: 未巡回を先に、limit 件だけ返す', async () => {
  const plan = sweepPlan({ limit: 5, seen: { beermoney: new Date().toISOString() } });
  eq(plan.length, 5);
  ok(plan[0].name !== 'beermoney', 'ついさっき見たものは後ろに回る');
  ok(plan[0].tool === MCP_TOOL.top, '既定は top');
  const plan2 = sweepPlan({ limit: 3, mode: 'new' });
  ok(plan2.every((p) => p.tool === MCP_TOOL.new), 'モードで tool が変わる');
});

await t('説明文: 経路の制約と「投稿しない」方針が載っている', async () => {
  const txt = redditPlanText(sweepPlan({ limit: 3 }));
  ok(txt.includes('読むだけ'));
  ok(txt.includes('Worker からは Reddit 公式APIに到達できない'));
  ok(redditHelp().includes('永久BAN'), '自動化しない理由が載る');
  ok(redditHelp().includes('gsk mcp call'));
});

if (fails.length) { console.log(`reddit: ${pass} passed, ${fails.length} FAILED`); for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log(`reddit: ${pass}/0 (all passed)`);
