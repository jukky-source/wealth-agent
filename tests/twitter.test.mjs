// X（Twitter）無料巡回のテスト。ネットワークには一切出ない（fetch は差し替える）。
import {
  parseRss, decodeXml, stripTags, normalizeTweet, tweetScore, isBeneficialTweet,
  rankTweets, toPerkItems, watchList, queryList, newsRssUrl,
  fxStatuses, fxSearch, nitterRss, sweepTwitter, tryTwitter, saveTweets, ensureTwitterTable, listTweets, twitterSummary,
} from '../src/agent/twitter.js';

let pass = 0; let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

// ---- 記憶に残っている形をそのまま使う（実物の応答から抜いた形） ----
const NITTER_XML = `<?xml version="1.0"?><rss><channel>
<title>Elon Musk / @elonmusk</title>
<item><title>Upgrades</title><description>&lt;p&gt;Upgrades&lt;/p&gt;</description><pubDate>Sun, 18 Oct 2026 01:00:00 GMT</pubDate><link>https://nitter.kareem.one/elonmusk/status/2111278766152700208#m</link></item>
<item><title>Google Play ギフトコード 1,000円分がもれなく還元、期限は10/19まで</title><description>&lt;p&gt;Google Play ギフトコード 1,000円分がもれなく還元、期限は10/19まで&lt;/p&gt;</description><pubDate>Sat, 17 Oct 2026 22:00:00 GMT</pubDate><link>https://nitter.kareem.one/someone/status/2111278766152700209#m</link></item>
</channel></rss>`;

const NEWS_XML = `<?xml version="1.0"?><rss><channel>
<item><title>ポイ活キャンペーン、最大10%還元 - 例のサイト</title><link>https://news.google.com/rss/articles/ABC</link><description>&lt;a href="x"&gt;ポイ活キャンプ&lt;/a&gt;</description><pubDate>Fri, 17 Oct 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

const FX_STATUS = {
  id: '2111642949071364231', url: 'https://x.com/GooglePlay/status/2111642949071364231',
  text: 'Google Play ギフトコード 500円分を先着で配布、期限は10/19まで',
  created_at: 'Sun Oct 18 02:00:00 +0000 2026', likes: 12, reposts: 3, replies: 1, lang: 'ja',
  author: { screen_name: 'GooglePlay' },
};

console.log('twitter: parseRss / xml');
eq('decodeXml が実体参照を戻す', decodeXml('a&amp;b&lt;c&gt;d&#39;e'), "a&b<c>d'e");
eq('stripTags がタグを落とす', stripTags('<p>あ</p>').trim(), 'あ');
{
  const p = parseRss(NITTER_XML, { provider: 'nitter', handle: 'elonmusk' });
  eq('channel の title を item と数えない', p.length, 2);
  eq('link から tweet_id を取る', p[0].tweet_id, '2111278766152700208');
  ok('created_at が ISO になる', /^\d{4}-\d{2}-\d{2}T/.test(p[0].created_at || ''), p[0].created_at);
  ok('本文にタグが残らない', !/[<>]/.test(p[1].text), p[1].text);
}
{
  const p = parseRss(NEWS_XML, { provider: 'google_news' });
  eq('Google News も同じ形で読める', p.length, 1);
  ok('status が無い link でも安定した鍵を作る（同じ記事は1件に畳まれる）', typeof p[0].tweet_id === 'string' && p[0].tweet_id.startsWith('k'), String(p[0].tweet_id));
  eq('同じ記事なら同じ鍵', parseRss(NEWS_XML, { provider: 'google_news' })[0].tweet_id, p[0].tweet_id);
}

console.log('twitter: normalizeTweet');
{
  const t = normalizeTweet(FX_STATUS, 'GooglePlay');
  eq('id を文字列で持つ', t.tweet_id, '2111642949071364231');
  eq('provider は fxtwitter', t.provider, 'fxtwitter');
  ok('created_at が ISO', /^\d{4}-\d{2}-\d{2}T/.test(t.created_at), t.created_at);
  eq('url を保持', t.url, 'https://x.com/GooglePlay/status/2111642949071364231');
}

console.log('twitter: 選別');
{
  ok('金額＋期限＋特典は採用', isBeneficialTweet({ text: 'ギフトコード 1,000円分がもれなく、期限は10/19まで' }));
  ok('金額だけの感想は採用しない', !isBeneficialTweet({ text: '円安がすごい' }));
  eq('ノイズ（稼げる系）は 0 点', tweetScore({ text: 'AIで稼げる副業、月100万円' }), 0);
  const r = rankTweets([
    { text: 'ギフトコード 1,000円分 もれなく 期限 10/19', tweet_id: '1', created_at: '2026-10-18T00:00:00Z' },
    { text: '今日はいい天気', tweet_id: '2', created_at: '2026-10-18T01:00:00Z' },
  ], { minScore: 3 });
  eq('閾値未満は落ちる', r.length, 1);
  eq('残ったのは有益な方', r[0].tweet_id, '1');
}
{
  const items = toPerkItems([{ text: 'あ'.repeat(400), url: 'https://x.com/a/status/1', provider: 'nitter', title: 't' }]);
  eq('perks に渡す形になる', Object.keys(items[0]).sort(), ['excerpt', 'kind', 'site', 'source', 'title', 'url'].sort());
  ok('excerpt は 300 字まで', items[0].excerpt.length === 300);
  ok('title は 120 字まで', items[0].title.length <= 120);
}

console.log('twitter: env');
{
  eq('既定の監視先', watchList(null), ['googlejapan', 'GooglePlay']);
  eq('env で差し替え＋@ を落とす', watchList({ TW_WATCH: '@a, b' }), ['a', 'b']);
  ok('空の env なら既定に戻る', queryList({ TW_QUERIES: '  ' }).length > 0);
  ok('newsRssUrl がエンコードする', newsRssUrl('ポイ活 キャンペーン').includes('%E3%83%9D%E3%82%A4%E6%B4%BB'));
}

console.log('twitter: 取得（fetch 差し替え）');
const okFetch = (json) => async () => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
const xmlFetch = (xml) => async () => ({ ok: true, status: 200, text: async () => xml });
const badFetch = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => '' });
{
  const r = await fxStatuses('GooglePlay', { fetchImpl: okFetch({ code: 200, results: [FX_STATUS] }) });
  ok('fxStatuses が投稿を返す', r.ok && r.posts.length === 1);
  const s = await fxStatuses('x', { fetchImpl: okFetch({ code: 404, results: [] }) });
  ok('code 404 は ok:false（黙って空にしない）', s.ok === false && s.error);
  const e = await fxStatuses('x', { fetchImpl: badFetch });
  ok('HTTP 429 も理由つきで失敗', e.ok === false && e.error === 'http_429');
}
{
  const s = await fxSearch('openai', { fetchImpl: okFetch({ code: 404, results: [] }) });
  ok('検索は使えないことを記録する', s.ok === false && /上流/.test(s.note || ''));
}
{
  const r = await nitterRss('elonmusk', { instances: ['https://bad', 'https://good'], fetchImpl: async (u) => (u.startsWith('https://bad') ? { ok: false, status: 403, text: async () => '' } : { ok: true, status: 200, text: async () => NITTER_XML }) });
  ok('落ちたインスタンスを飛ばして次で取る', r.ok && r.instance === 'https://good' && r.posts.length === 2);
  const n = await nitterRss('elonmusk', { instances: ['https://bad'], fetchImpl: async () => ({ ok: false, status: 403, text: async () => '' }) });
  ok('全滅なら理由を残す', n.ok === false && n.tried.length === 1);
}

console.log('twitter: 貯める（store 差し替え）');
function stubStore() {
  const rows = new Map();
  const settings = new Map();
  return {
    rows, settings,
    async run(sql, ...a) {
      if (/CREATE TABLE/i.test(sql)) return { meta: { changes: 0 } };
      if (/INSERT OR IGNORE/i.test(sql)) {
        const [tweet_id, handle, provider, url, title, text, created_at, score, likes, reposts, fetched_at] = a;
        if (rows.has(tweet_id)) return { meta: { changes: 0 } };
        rows.set(tweet_id, { tweet_id, handle, provider, url, title, text, created_at, score, likes, reposts, fetched_at });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    },
    async first(sql) {
      if (/COUNT\(\*\)/.test(sql)) return { n: rows.size };
      if (/MAX\(score\)/.test(sql)) return { s: Math.max(0, ...[...rows.values()].map((r) => r.score)) };
      return null;
    },
    async all(sql) {
      if (/GROUP BY provider/.test(sql)) {
        const m = new Map();
        for (const r of rows.values()) m.set(r.provider, (m.get(r.provider) || 0) + 1);
        return [...m.entries()].map(([provider, n]) => ({ provider, n }));
      }
      return [...rows.values()].sort((a, b) => b.score - a.score);
    },
  };
}
{
  const store = stubStore();
  const s = await saveTweets(store, [{ tweet_id: '1', provider: 'fxtwitter', text: 'ギフトコード 1,000円分 もれなく 期限 10/19', handle: 'a' }]);
  eq('1件入る', s.inserted, 1);
  const again = await saveTweets(store, [{ tweet_id: '1', provider: 'fxtwitter', text: 'x', handle: 'a' }]);
  eq('同じ tweet_id は増えない', again.inserted, 0);
  const rows = await listTweets(store, { limit: 10 });
  eq('読める', rows.length, 1);
  const sum = await twitterSummary(store);
  eq('要約が数える', sum.total, 1);
}

console.log('twitter: 巡回（1回ぶん）');
{
  const store = stubStore();
  const fetchImpl = async (u) => {
    if (u.includes('/2/profile/')) return { ok: true, status: 200, json: async () => ({ code: 200, results: [FX_STATUS] }) };
    if (u.includes('news.google.com')) return { ok: true, status: 200, text: async () => NEWS_XML };
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
  const r = await sweepTwitter(store, { env: { TW_WATCH: 'GooglePlay', TW_QUERIES: 'ポイ活' }, fetchImpl });
  ok('取れた件数を数える', r.fetched === 2, String(r.fetched));
  ok('有益な2件を残す', r.kept === 2, String(r.kept));
  ok('経路ごとの内訳を残す', r.sources.length === 2 && r.sources.every((s) => typeof s.posts === 'number'));
  eq('落ちた経路は無い', r.errors, []);

  const store2 = stubStore();
  const r2 = await sweepTwitter(store2, { env: { TW_WATCH: 'a', TW_QUERIES: 'q' }, fetchImpl: badFetch });
  ok('全経路失敗でも落ちない', r2.kept === 0 && r2.errors.length >= 1);
  ok('失敗の理由を残す', r2.errors.some((e) => /fxtwitter|nitter|google_news/.test(e)), JSON.stringify(r2.errors));
}

console.log('twitter: perks 取り込みは失敗しても本体を止めない');
{
  const store = stubStore();
  const fetchImpl = async (u) => (u.includes('/2/profile/')
    ? { ok: true, status: 200, json: async () => ({ code: 200, results: [FX_STATUS] }) }
    : { ok: false, status: 404, text: async () => '', json: async () => ({}) });
  const r = await tryTwitter(store, { env: { TW_WATCH: 'GooglePlay', TW_QUERIES: 'x' }, fetchImpl });
  ok('kept を返す', r.kept === 1, String(r.kept));
  ok('ingested が付く（perks 実体 or エラー）', r.ingested !== undefined && r.ingested !== null);
}

console.log(`\ntwitter: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
