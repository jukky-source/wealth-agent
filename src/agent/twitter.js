// X（Twitter）を「無料」で巡回する読み取り専用クライアント。
//
// 原価0の制約で使える経路は3つだけ（2026-10-18 に実測して確定）:
//   1) FxTwitter API v2   https://api.fxtwitter.com/2/...   鍵なし・認証なし・1000 req/min/IP
//        実測: /2/profile/{handle}/statuses → 200（本文つき20件）／/2/profile/{handle} → 200
//              /2/trends?type=trending → 200 ／ /2/search → 404（検索は上流の認証が要る＝使えない）
//   2) Nitter の RSS      生きているのは2台だけ（実測 200・各20件）。nitter.net は 410、xcancel は 451。
//   3) Google News RSS    鍵なし。site:x.com で100件返る（ニュースに載った投稿だけ）。
//
// X 公式 API は 2026 年に Free 枠が廃止され、読み取りは従量課金（投稿1件 $0.005 / ユーザー $0.010 /
// 自分の投稿 $0.001）。だから公式 API は使わない。
//
// 絶対にやらないこと: 投稿・返信・引用・DM（読み取り専用）。自動フォロー/いいね。ログインCookieの利用。
// 公式の無料経路には「投稿の検索」が無いので、検索が要る場面はキーワードを Google News RSS に投げる。

export const T = 'twitter_posts';
export const FX_BASE = 'https://api.fxtwitter.com';

/** 実測で RSS を返した Nitter インスタンス（2026-10-18）。順に試す。 */
export const NITTER_INSTANCES = ['https://nitter.kareem.one', 'https://nitter.meowing.monster'];

/** 監視する公式アカウント（存在と投稿取得を実測済み）。env TW_WATCH で差し替え可。 */
export const DEFAULT_WATCH = ['googlejapan', 'GooglePlay'];

/** キーワード監視（Google News RSS に投げる）。env TW_QUERIES で差し替え可。 */
export const DEFAULT_QUERIES = ['ポイ活 キャンペーン', 'Google Play ギフトコード', 'ポイント還元 期限'];

export const PROVIDERS = [
  {
    id: 'fxtwitter', kind: 'json', base: FX_BASE, auth: 'none', cost: 0,
    note: '鍵なし・1000 req/min/IP。プロフィールの投稿一覧とトレンドが取れる。検索(/2/search)は上流の認証が要り 404（実測 2026-10-18）。',
  },
  {
    id: 'nitter', kind: 'rss', bases: NITTER_INSTANCES, auth: 'none', cost: 0,
    note: '生きているのは2台のみ（実測 2026-10-18）。nitter.net=410 / xcancel=451 / 他は bot チェック。ページは bot チェックでも RSS は返る。',
  },
  {
    id: 'google_news', kind: 'rss', base: 'https://news.google.com/rss/search', auth: 'none', cost: 0,
    note: 'site:x.com を含むクエリで100件返る。ニュースに載った投稿だけが拾える。',
  },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// 金銭が動く話かどうか。reddit.js の選別と同じ考え方で、金額の総称（特典/ポイント）だけでは採用しない。
const MONEY_RE = /(円|¥|円分|割引|%off|%オフ|％オフ|還元|ポイント|pt\b|ギフトコード|クーポン|無料|キャッシュバック|スタンプ|値引き)/i;
const PERK_RE = /(キャンペーン|特典|プレゼント|抽選|応募|配布|もれなく|先着|限定|付与|プレゼントコード)/;
const DEADLINE_RE = /(期限|締切|まで|本日|今日|残り|最終日|〜\d|\d+\/\d+)/;
const AMOUNT_RE = /\d+\s*(円|%|％|pt|ポイント|倍)/i;
const NOISE_RE = /(副業|儲か|稼げる|稼ぐ方法|投資|仮想通貨|FX|アフィリ|無在庫|情報商材|フォロワー増)/;

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number(n) || lo)); }

function id(prefix = 'tw') { return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`; }

export function nowIso() { return new Date().toISOString(); }

/** XML の実体参照を戻す。 */
export function decodeXml(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function stripTags(s = '') { return String(s).replace(/<[^>]*>/g, ' '); }

function tag(block = '', name = '') {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1] : '';
}

function fnv10(s = '') {
  let h = 2166136261 >>> 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

/** RSS（Nitter / Google News）を共通の投稿形にする。 */
export function parseRss(xml = '', { provider = 'nitter', handle = null } = {}) {
  const out = [];
  const items = String(xml).split(/<item[\s>]/i).slice(1);
  for (const raw of items) {
    const block = raw.split(/<\/item>/i)[0];
    const title = decodeXml(tag(block, 'title')).replace(/\s+/g, ' ').trim();
    const link = decodeXml(tag(block, 'link')).trim();
    const desc = stripTags(decodeXml(tag(block, 'description'))).replace(/\s+/g, ' ').trim();
    const pub = decodeXml(tag(block, 'pubDate')).trim();
    const t = pub ? Date.parse(pub) : NaN;
    const idm = /\/status\/(\d+)/.exec(link);
    const text = (desc.length > title.length ? desc : title) || title || desc;
    out.push({
      provider, tweet_id: idm ? idm[1] : (link || title ? 'k' + fnv10(link + '|' + title) : null), handle,
      url: link || null, title: title || null, text: text.slice(0, 600),
      created_at: Number.isFinite(t) ? new Date(t).toISOString() : null,
      likes: 0, reposts: 0, replies: 0, lang: null,
    });
  }
  return out;
}

/** FxTwitter の投稿オブジェクトを共通形にする。 */
export function normalizeTweet(r = {}, handle = null) {
  const author = (r.author && r.author.screen_name) || handle || null;
  const text = String(r.text || (r.raw_text && r.raw_text.text) || '').replace(/\s+/g, ' ').trim();
  const created = r.created_at ? Date.parse(r.created_at)
    : (r.created_timestamp ? Number(r.created_timestamp) * 1000 : NaN);
  return {
    provider: 'fxtwitter',
    tweet_id: r.id ? String(r.id) : null,
    handle: author,
    url: r.url || (author && r.id ? `https://x.com/${author}/status/${r.id}` : null),
    title: null,
    text: text.slice(0, 600),
    created_at: Number.isFinite(created) ? new Date(created).toISOString() : null,
    likes: Number(r.likes || 0), reposts: Number(r.reposts || 0), replies: Number(r.replies || 0),
    lang: r.lang || null,
  };
}

/** 有益情報らしさ。金額の話が無いものは拾わない（ニュースの感想を貯めない）。 */
export function tweetScore(p = {}) {
  const t = `${p.text || ''} ${p.title || ''}`;
  if (!t.trim()) return 0;
  if (NOISE_RE.test(t)) return 0;
  let s = 0;
  if (MONEY_RE.test(t)) s += 2;
  if (AMOUNT_RE.test(t)) s += 1;
  if (PERK_RE.test(t)) s += 1;
  if (DEADLINE_RE.test(t)) s += 1;
  return s;
}

export function isBeneficialTweet(p = {}, { minScore = 3 } = {}) {
  return tweetScore(p) >= minScore;
}

export function rankTweets(posts = [], { minScore = 3, max = 20 } = {}) {
  return posts
    .map((p) => ({ ...p, score: tweetScore(p) }))
    .filter((p) => p.score >= minScore)
    .sort((a, b) => b.score - a.score || String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, max);
}

/** 有益情報の取り込み口（perks）に渡す形。 */
export function toPerkItems(posts = []) {
  return posts.map((p) => ({
    title: String(p.title || p.text || '').slice(0, 120),
    url: p.url || null,
    excerpt: String(p.text || '').slice(0, 300),
    kind: 'perk',
    source: p.provider || 'twitter',
    site: 'x.com',
  }));
}

/** 監視アカウント（env のカンマ区切りで差し替え可）。 */
export function watchList(env = null) {
  const raw = env && env.TW_WATCH;
  const list = typeof raw === 'string' && raw.trim()
    ? raw.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean)
    : DEFAULT_WATCH.slice();
  return list.slice(0, 12);
}

/** キーワード監視（env のカンマ区切りで差し替え可）。 */
export function queryList(env = null) {
  const raw = env && env.TW_QUERIES;
  const list = typeof raw === 'string' && raw.trim()
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_QUERIES.slice();
  return list.slice(0, 8);
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) return { ok: false, status: res.status, error: `http_${res.status}` };
  let data = null;
  try { data = await res.json(); } catch { return { ok: false, status: res.status, error: 'bad_json' }; }
  if (data && typeof data.code === 'number' && data.code >= 400) {
    return { ok: false, status: data.code, error: data.message || `code_${data.code}`, data };
  }
  return { ok: true, status: res.status, data };
}

export async function fxProfile(handle, { fetchImpl = fetch } = {}) {
  const h = String(handle || '').replace(/^@/, '').trim();
  if (!h) return { ok: false, provider: 'fxtwitter', error: 'handle_required', user: null };
  const r = await getJson(`${FX_BASE}/2/profile/${encodeURIComponent(h)}`, fetchImpl);
  return r.ok ? { ok: true, provider: 'fxtwitter', user: r.data.user || r.data } : { ok: false, provider: 'fxtwitter', error: r.error, user: null };
}

/** プロフィールの投稿一覧（これが「無料で読めるタイムライン」の本体）。 */
export async function fxStatuses(handle, { count = 20, fetchImpl = fetch } = {}) {
  const h = String(handle || '').replace(/^@/, '').trim();
  if (!h) return { ok: false, provider: 'fxtwitter', error: 'handle_required', posts: [] };
  const url = `${FX_BASE}/2/profile/${encodeURIComponent(h)}/statuses?count=${clamp(count, 1, 50)}`;
  try {
    const r = await getJson(url, fetchImpl);
    if (!r.ok) return { ok: false, provider: 'fxtwitter', handle: h, error: r.error, posts: [] };
    const rows = Array.isArray(r.data.results) ? r.data.results : [];
    return { ok: true, provider: 'fxtwitter', handle: h, posts: rows.map((x) => normalizeTweet(x, h)) };
  } catch (e) {
    return { ok: false, provider: 'fxtwitter', handle: h, error: 'fetch_failed', message: String(e && e.message || e), posts: [] };
  }
}

/** 検索。無料枠では上流が 404 を返すので「使えない」ことを記録して返す（黙って空にしない）。 */
export async function fxSearch(q, { count = 20, fetchImpl = fetch } = {}) {
  const query = String(q || '').trim();
  if (!query) return { ok: false, provider: 'fxtwitter', error: 'query_required', posts: [] };
  try {
    const r = await getJson(`${FX_BASE}/2/search?q=${encodeURIComponent(query)}&feed=latest&count=${clamp(count, 1, 50)}`, fetchImpl);
    if (!r.ok) return { ok: false, provider: 'fxtwitter', query, error: r.error, note: '検索は上流の認証が必要（実測 404）。キーワード監視は Google News RSS を使う。', posts: [] };
    const rows = Array.isArray(r.data.results) ? r.data.results : [];
    return { ok: true, provider: 'fxtwitter', query, posts: rows.map((x) => normalizeTweet(x, null)) };
  } catch (e) {
    return { ok: false, provider: 'fxtwitter', query, error: 'fetch_failed', message: String(e && e.message || e), posts: [] };
  }
}

export async function fxTrends({ count = 20, fetchImpl = fetch } = {}) {
  try {
    const r = await getJson(`${FX_BASE}/2/trends?type=trending&count=${clamp(count, 1, 50)}`, fetchImpl);
    if (!r.ok) return { ok: false, provider: 'fxtwitter', error: r.error, trends: [] };
    const rows = Array.isArray(r.data.trends) ? r.data.trends : [];
    return { ok: true, provider: 'fxtwitter', trends: rows.map((t) => ({ name: t.name, context: t.context || null })) };
  } catch (e) {
    return { ok: false, provider: 'fxtwitter', error: 'fetch_failed', message: String(e && e.message || e), trends: [] };
  }
}

/** Nitter の RSS。生きているインスタンスを順に試す。 */
export async function nitterRss(handle, { instances = NITTER_INSTANCES, fetchImpl = fetch } = {}) {
  const h = String(handle || '').replace(/^@/, '').trim();
  if (!h) return { ok: false, provider: 'nitter', error: 'handle_required', posts: [] };
  const tried = [];
  for (const base of instances) {
    try {
      const res = await fetchImpl(`${base}/${encodeURIComponent(h)}/rss`, {
        headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml, */*' },
      });
      if (!res.ok) { tried.push(`${base}:${res.status}`); continue; }
      const xml = await res.text();
      const posts = parseRss(xml, { provider: 'nitter', handle: h });
      if (posts.length) return { ok: true, provider: 'nitter', instance: base, handle: h, posts, tried };
      tried.push(`${base}:empty`);
    } catch (e) { tried.push(`${base}:${String(e && e.message || e).slice(0, 40)}`); }
  }
  return { ok: false, provider: 'nitter', handle: h, error: 'no_instance', tried, posts: [] };
}

export function newsRssUrl(query, { hl = 'ja', gl = 'JP', ceid = 'JP:ja' } = {}) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

/** Google News RSS によるキーワード監視（無料経路に投稿検索が無いことの代替）。 */
export async function newsRss(query, { fetchImpl = fetch, hl, gl, ceid } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, provider: 'google_news', error: 'query_required', posts: [] };
  try {
    const res = await fetchImpl(newsRssUrl(q, { hl, gl, ceid }), { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml, */*' } });
    if (!res.ok) return { ok: false, provider: 'google_news', query: q, error: `http_${res.status}`, posts: [] };
    const posts = parseRss(await res.text(), { provider: 'google_news', handle: null });
    return { ok: true, provider: 'google_news', query: q, posts };
  } catch (e) {
    return { ok: false, provider: 'google_news', query: q, error: 'fetch_failed', message: String(e && e.message || e), posts: [] };
  }
}

// ---- 貯める ----

export async function ensureTwitterTable(store) {
  await store.run(
    `CREATE TABLE IF NOT EXISTS ${T} (
      tweet_id TEXT PRIMARY KEY, handle TEXT, provider TEXT, url TEXT, title TEXT, text TEXT,
      created_at TEXT, score INTEGER, likes INTEGER, reposts INTEGER, fetched_at TEXT)`,
  );
}

export async function saveTweets(store, posts = [], { now = null } = {}) {
  await ensureTwitterTable(store);
  const at = now || nowIso();
  let inserted = 0;
  for (const p of posts) {
    if (!p || !p.tweet_id) continue;
    const r = await store.run(
      `INSERT OR IGNORE INTO ${T} (tweet_id, handle, provider, url, title, text, created_at, score, likes, reposts, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      String(p.tweet_id), p.handle || null, p.provider || null, p.url || null, p.title || null,
      p.text || null, p.created_at || null, Number(p.score || tweetScore(p)), Number(p.likes || 0), Number(p.reposts || 0), at,
    );
    inserted += Number((r && r.meta && r.meta.changes) || 0);
  }
  return { inserted, total: posts.length, at };
}

export async function listTweets(store, { limit = 40 } = {}) {
  await ensureTwitterTable(store);
  const rows = await store.all(
    `SELECT * FROM ${T} ORDER BY score DESC, COALESCE(created_at,'') DESC LIMIT ?`,
    clamp(limit, 1, 200),
  );
  return rows || [];
}

/** 1回ぶんの巡回。取れた数・落ちた理由を必ず残す（「取れなかった」を隠さない）。 */
export async function sweepTwitter(store, { env = null, fetchImpl = fetch, handles = null, queries = null, perHandle = 20, minScore = 3, max = 20, now = null } = {}) {
  const at = now || nowIso();
  const watch = handles || watchList(env);
  const qs = queries || queryList(env);
  const sources = [];
  const errors = [];
  let fetched = 0;
  const all = [];

  for (const h of watch) {
    const fx = await fxStatuses(h, { count: perHandle, fetchImpl });
    if (fx.ok) { fetched += fx.posts.length; all.push(...fx.posts); sources.push({ provider: 'fxtwitter', handle: h, posts: fx.posts.length }); }
    else {
      sources.push({ provider: 'fxtwitter', handle: h, posts: 0, error: fx.error });
      errors.push(`fxtwitter:${h}:${fx.error}`);
      const nr = await nitterRss(h, { fetchImpl });
      if (nr.ok) { fetched += nr.posts.length; all.push(...nr.posts); sources.push({ provider: 'nitter', handle: h, posts: nr.posts.length, instance: nr.instance }); }
      else errors.push(`nitter:${h}:${nr.error}`);
    }
  }

  for (const q of qs) {
    const nr = await newsRss(q, { fetchImpl });
    if (nr.ok) { fetched += nr.posts.length; all.push(...nr.posts); sources.push({ provider: 'google_news', query: q, posts: nr.posts.length }); }
    else { sources.push({ provider: 'google_news', query: q, posts: 0, error: nr.error }); errors.push(`google_news:${q}:${nr.error}`); }
  }

  const ranked = rankTweets(all, { minScore, max });
  const saved = await saveTweets(store, ranked, { now: at });
  return { at, watch, queries: qs, fetched, candidates: all.length, kept: saved.inserted, ranked, sources, errors };
}

/** 巡回＋有益情報への取り込み。perks 側の選別（isBeneficial）も通す。 */
export async function tryTwitter(store, { env = null, fetchImpl = fetch, now = null } = {}) {
  const r = await sweepTwitter(store, { env, fetchImpl, now });
  let ingested = null;
  try {
    if (r.ranked.length) {
      const pkm = await import('./perks.js');
      ingested = await pkm.ingestPerks(store, toPerkItems(r.ranked), { now: r.at, max: 40 });
    }
  } catch (e) { ingested = { error: String(e && e.message || e) }; }
  return { at: r.at, fetched: r.fetched, candidates: r.candidates, kept: r.kept, ingested, sources: r.sources, errors: r.errors, rows: r.ranked.slice(0, 10) };
}

export async function twitterSummary(store) {
  await ensureTwitterTable(store);
  const total = await store.first(`SELECT COUNT(*) AS n FROM ${T}`);
  const byProvider = await store.all(`SELECT provider, COUNT(*) AS n FROM ${T} GROUP BY provider ORDER BY n DESC`);
  const best = await store.first(`SELECT MAX(score) AS s FROM ${T}`);
  return {
    total: Number((total && total.n) || 0),
    by_provider: (byProvider || []).map((r) => ({ provider: r.provider, n: Number(r.n) })),
    best_score: Number((best && best.s) || 0),
    watch: watchList(null), queries: queryList(null),
  };
}

export function twitterText(rows = []) {
  if (!rows.length) return 'X（Twitter）の巡回: まだ何も貯まっていない。';
  const L = [`X（Twitter）の巡回: ${rows.length}件`, ''];
  for (const r of rows.slice(0, 30)) {
    L.push(`[${r.score}] @${r.handle || '-'} (${r.provider}) ${String(r.text || '').slice(0, 140)}`);
    if (r.url) L.push(`      ${r.url}`);
  }
  return L.join('\n');
}

export function twitterHelp() {
  return [
    'X（Twitter）の無料巡回（読み取り専用）',
    '',
    '経路（すべて鍵なし・原価0）:',
    ...PROVIDERS.map((p) => `  - ${p.id}: ${p.note}`),
    '',
    '使えない経路（実測）:',
    '  - X 公式 API: Free 枠は廃止。読み取りは従量課金（投稿1件 $0.005 / ユーザー $0.010 / 自分の投稿 $0.001）。',
    '  - Nitter のページ: 生きている2台も bot チェックで 0 件（RSS だけが返る）。nitter.net=410 / xcancel=451。',
    '  - FxTwitter の /2/search: 上流の認証が要り 404。キーワード監視は Google News RSS で代替。',
    '',
    'やらないこと: 投稿・返信・引用・DM（読み取り専用）。自動フォロー/いいね。ログインCookieの利用。',
    '',
    'エンドポイント:',
    '  GET /api/twitter            : 巡回状況の要約＋貯まった投稿',
    '  GET /api/twitter?format=text: 人が読む形',
    '  GET /api/twitter/providers  : 使える経路の一覧',
    '  POST/GET /api/twitter/sweep : いますぐ1回巡回する（有益情報にも取り込む）',
    '  GET /api/twitter/posts      : 貯まった投稿だけ',
  ].join('\n');
}
