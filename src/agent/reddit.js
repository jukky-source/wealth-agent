// ---------------------------------------------------------------------------
// Reddit 横断収集 — ジャンルを横断して「有益情報（お金・特典・ポイ活・無料枠）」だけを
// 拾い上げる。読むだけ・原価0。投稿もコメントもしない（自動化はBAN対象）。
//
// 経路の制約（実測）:
//   - Reddit 公式 Data API は hosted service provider の netblock からの
//     OAuth なしアクセスをブロックする → Workers からは読めない。
//   - 使えるのは接続済みの Reddit MCP（読み取り専用8ツール）を
//     gsk mcp call で叩く経路。これはサンドボックス側から実行し、
//     結果を /api/perks/ingest に push する。
//   - したがって「Worker が勝手に Reddit を巡回する」ことはできない。
//     ここは計画（どのサブレをどの順で見るか）と選別（有益情報だけ残す）を持つ。
// ---------------------------------------------------------------------------

import { perkSignals, isBeneficial, perkFrom } from './perks.js';

/** ジャンル横断のサブレ一覧。genre ごとに「なぜ見るか」を持つ。 */
export const SUBREDDITS = [
  { name: 'AI_Agents', genre: 'AIエージェント経済', why: 'x402 販売者の実体験・発見の壁の一次情報（2026-10-21 実測: 売り手スレッドから署名・発見の知見を取得済み）' },
  { name: 'beermoney', genre: '現金化', why: '少額でも実際に現金化できた報告が集まる。$表記つきの実績が濃い' },
  { name: 'sidehustle', genre: '副業', why: '「これで月$X入った」の一次報告。無料で始められるものが混ざる' },
  { name: 'passive_income', genre: '不労', why: '放置で入る仕組みの共有。原価0のものだけ拾う' },
  { name: 'freebies', genre: '無料配布', why: '無料で貰えるものの一次情報。期限が短い' },
  { name: 'Frugal', genre: '節約', why: '割引・還元・二重払いの解消。実額の話が多い' },
  { name: 'deals', genre: 'セール', why: '値下げ・クーポンの一次情報' },
  { name: 'personalfinance', genre: '家計', why: '制度・控除・還元の一次整理。金額の裏取りに向く' },
  { name: 'japanfinance', genre: '日本のお金', why: '日本の制度・ポイント・NISA。日本語の一次情報' },
  { name: 'japanlife', genre: '日本生活', why: '日本の生活お得情報（キャンペーン・補助金）' },
  { name: 'AwardBonanza', genre: 'ポイント', why: 'ポイント・バッジ・少額報酬の実績報告' },
  { name: 'promos', genre: 'プロモ', why: '紹介コード・キャンペーンの集積（規約違反のものは除外する）' },
  { name: 'aifinance', genre: 'AI×金', why: 'AIを使った収益の一次報告' },
  { name: 'LocalLLaMA', genre: 'AI技術', why: '無料で使えるモデル・無料枠の共有（原価0の道具）' },
  { name: 'artificial', genre: 'AI全般', why: 'AIの無料枠・新サービス開始の一次情報' },
  { name: 'Entrepreneur', genre: '起業', why: '「これを売って$X」の一次報告' },
  { name: 'indiehackers', genre: '個人開発', why: '小さく出して売れた実例。値付けの一次情報' },
  { name: 'SaaS', genre: 'SaaS', why: '無料枠の比較・値付けの議論' },
  { name: 'webdev', genre: '開発', why: '開発者向けの無料クレジット・ツール配布' },
  { name: 'programming', genre: '開発', why: 'ツール・無料枠の共有' },
  { name: 'devops', genre: 'インフラ', why: 'クラウド無料枠の情報（原価0で動かすため）' },
  { name: 'forhire', genre: '仕事', why: '「[Hiring]」の実案件。賞金・単発案件の一次情報' },
  { name: 'mcp', genre: 'MCP', why: 'MCP サーバの公開・無料配布の一次情報' },
];

export const MCP_TOOL = {
  hot: 'get_subreddit_hot_posts',
  top: 'get_subreddit_top_posts',
  new: 'get_subreddit_new_posts',
};

/** どのサブレをどの順で見るか。未巡回 → 前回から時間が空いた順。 */
export function sweepPlan({ limit = 8, seen = {}, mode = 'top' } = {}) {
  const now = Date.now();
  const scored = SUBREDDITS.map((s) => {
    const last = seen[s.name] ? Date.parse(seen[s.name]) : 0;
    const ageH = (now - (last || 0)) / 3600000;
    return { ...s, tool: MCP_TOOL[mode] || MCP_TOOL.top, last_seen: seen[s.name] || null, age_hours: Math.round(ageH), priority: Math.min(ageH, 1000) };
  });
  scored.sort((a, b) => b.priority - a.priority);
  return scored.slice(0, limit);
}

/** MCP の戻り値を素の投稿配列にする（envelope の形が違っても通す）。 */
export function postsFromMcp(raw) {
  let d = raw;
  for (let i = 0; i < 4; i++) {
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return []; } continue; }
    if (Array.isArray(d)) return d;
    if (d && typeof d === 'object') {
      if (Array.isArray(d.content)) {
        const t = d.content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
        if (t) { d = t.text; continue; }
      }
      if (Array.isArray(d.posts)) return d.posts;
      if (Array.isArray(d.data)) return d.data;
      if (Array.isArray(d.result)) return d.result;
    }
    return [];
  }
  return Array.isArray(d) ? d : [];
}

/** 1件を正規化する。 */
export function normalizePost(p = {}, subreddit = null) {
  return {
    id: p.id || null,
    title: (p.title || '').trim(),
    url: p.url || (p.permalink ? `https://www.reddit.com${p.permalink}` : null),
    subreddit: p.subreddit || subreddit || null,
    score: Number.isFinite(p.score) ? p.score : null,
    comments: Number.isFinite(p.comment_count) ? p.comment_count : (Number.isFinite(p.num_comments) ? p.num_comments : null),
    created_at: p.created_at || null,
    excerpt: (p.selftext || p.content || '').slice(0, 400),
  };
}

const NOISE_RE = /(\?|should i|help me|どうすれば|悩んで|愚痴|rant|scam\?|is this legit)/i;
const HYPE_RE = /(to the moon|guaranteed|100x|必ず儲か|絶対稼げ)/i;

/** 有益情報スコア。金額の記載・実績の報告・賛成数で上げ、質問・愚痴・誇大で下げる。 */
export function benefitScore(post = {}) {
  const text = `${post.title || ''} ${post.excerpt || ''}`;
  const sig = perkSignals(text);
  let s = 0;
  if (sig.includes('money')) s += 4;
  for (const k of sig) if (k !== 'money') s += 1;
  if (NOISE_RE.test(text)) s -= 3;
  if (HYPE_RE.test(text)) s -= 5;
  const sc = Number.isFinite(post.score) ? post.score : 0;
  s += Math.min(4, Math.log10(Math.max(sc, 1)) * 1.5);
  return Math.round(s * 100) / 100;
}

export function rankPosts(posts = [], { minScore = 1 } = {}) {
  return posts
    .map((p) => ({ ...p, benefit: benefitScore(p), beneficial: isBeneficial(`${p.title || ''} ${p.excerpt || ''}`) }))
    .filter((p) => p.beneficial && p.benefit >= minScore)
    .sort((a, b) => b.benefit - a.benefit);
}

/** 有益情報として残った投稿を、取り込み用の items に変換する。 */
export function toPerkItems(posts = [], { minScore = 1 } = {}) {
  return rankPosts(posts, { minScore }).map((p) => ({
    ...perkFrom({ title: p.title, url: p.url, excerpt: p.excerpt, source: `reddit:${p.subreddit || 'unknown'}` }),
    source: `reddit:${p.subreddit || 'unknown'}`,
    excerpt: p.excerpt,
    reddit_score: p.score,
    benefit_signal: p.benefit,
  }));
}

/** 1つのサブレの結果をまとめて選別する（MCP の生データ → 残った投稿）。 */
export function selectFromSubreddit(raw, subreddit, { minScore = 1, max = 5 } = {}) {
  const posts = postsFromMcp(raw).map((p) => normalizePost(p, subreddit));
  const ranked = rankPosts(posts, { minScore });
  return { subreddit, scanned: posts.length, kept: ranked.slice(0, max), dropped: posts.length - ranked.length };
}

export function redditPlanText(plan = []) {
  const L = [];
  L.push('Reddit 横断巡回の計画（読むだけ・原価0・投稿しない）');
  L.push(`  ジャンル数: ${new Set(SUBREDDITS.map((s) => s.genre)).size} / サブレ数: ${SUBREDDITS.length}`);
  L.push('  経路: 接続済み Reddit MCP（読み取り専用8ツール）を gsk mcp call で叩き、結果を /api/perks/ingest に push する。');
  L.push('  Worker からは Reddit 公式APIに到達できない（hosted provider の netblock は OAuth 必須）ので、巡回はサンドボックス側で行う。');
  L.push('');
  for (const s of plan) {
    L.push(`  [${s.genre}] r/${s.name}  ${s.tool}  前回: ${s.last_seen || '未巡回'}`);
    L.push(`     なぜ: ${s.why}`);
  }
  return L.join('\n');
}

export function redditHelp() {
  return [
    'Reddit 横断収集 — ジャンルをまたいで「お金・特典・ポイ活・無料枠」だけを拾う。',
    '',
    'GET  /api/reddit/plan?format=text : 次に見るサブレの順番（未巡回優先）',
    'POST /api/perks/ingest            : 拾った投稿を取り込む（有益情報だけ残す）',
    '',
    '経路: 接続済み Reddit MCP（読み取り専用・8ツール）を gsk mcp call で叩く。',
    '      Reddit 公式API は Workers からは読めない（OAuth 必須・承認制）ので、巡回はサンドボックス側。',
    '',
    '守っていること: 読むだけ。投稿・コメント・DM は絶対に自動化しない（削除→サブレ限定シャドウバン→サイト全体の永久BAN）。',
    '               誇大な儲け話（to the moon / 必ず儲かる）は選別で落とす。',
  ].join('\n');
}
