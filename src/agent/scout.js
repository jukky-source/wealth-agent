// Opportunity Scout — 「新鮮な情報を常に拾い、稼げそうなものだけ小さく試す」ループ。
//
// なぜ要るか: 稼げるネタは静的なカタログの中には無い。日々どこかのSNS・掲示板・
// マーケットに「金を払うと言っている人」が現れる。ここでは**無料かつAPIキー不要**の
// 公開エンドポイントだけを巡回し（鍵が要る所は使わない＝原価0を守る）、
//   ① 収益意図のシグナルで点数化
//   ② 既存の能力（x402 / MCP / 監視サブスク / コンテンツ / FX-EA）で
//      「小さく試す」計画へ変換
//   ③ 記録して、次回は同じ物を二度拾わない
// までを自動で回す。
//
// ここが**絶対にやらないこと**: 投稿する・買う・アカウントを作る・金を使う。
// それらは規約と凍結と財布に直接触れるので、計画までを自動にし、実行の最終判断は人に残す。
// したがって scout が出すのは「試す価値のある候補」と「試し方」であり、収益ではない。

import { id as newId, nowIso, safeJson, j, round } from '../util.js';

// ---------------------------------------------------------------------------
// 巡回先。すべて無料・鍵不要。verified は「このセッションで実際に叩いて確認した」印で、
// 実測は probe の結果で更新される（推測で true にしない）。
// ---------------------------------------------------------------------------
export const SOURCES = [
  { id: 'hn_show', label: 'Hacker News (Show HN)', kind: 'launch', free: true, needs_key: false,
    url: (n) => `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=${n}`,
    format: 'json', parse: 'hn', source: 'https://hn.algolia.com/api' },
  { id: 'hn_ask', label: 'Hacker News (Ask HN)', kind: 'demand', free: true, needs_key: false,
    url: (n) => `https://hn.algolia.com/api/v1/search_by_date?tags=ask_hn&hitsPerPage=${n}`,
    format: 'json', parse: 'hn', source: 'https://hn.algolia.com/api' },
  { id: 'hn_money', label: 'Hacker News (bounty / paying の言及)', kind: 'money', free: true, needs_key: false,
    url: (n) => `https://hn.algolia.com/api/v1/search_by_date?query=bounty%20OR%20%22paying%20for%22%20OR%20%22willing%20to%20pay%22&hitsPerPage=${n}`,
    format: 'json', parse: 'hn', source: 'https://hn.algolia.com/api' },
  { id: 'gh_bounty', label: 'GitHub の賞金付き Issue', kind: 'money', free: true, needs_key: false,
    url: (n) => `https://api.github.com/search/issues?q=label%3Abounty+state%3Aopen&sort=created&order=desc&per_page=${n}`,
    format: 'json', parse: 'gh_issues', source: 'https://docs.github.com/rest/search' },
  { id: 'gh_new_tools', label: 'GitHub の新着ツール（伸びている）', kind: 'build', free: true, needs_key: false,
    url: (n) => `https://api.github.com/search/repositories?q=created%3A%3E2026-09-01+topic%3Aapi&sort=stars&order=desc&per_page=${n}`,
    format: 'json', parse: 'gh_repos', source: 'https://docs.github.com/rest/search' },
  { id: 'gh_x402', label: 'GitHub の x402 / agent 決済まわり', kind: 'agent_commerce', free: true, needs_key: false,
    url: (n) => `https://api.github.com/search/repositories?q=x402+in%3Areadme+in%3Aname&sort=updated&order=desc&per_page=${n}`,
    format: 'json', parse: 'gh_repos', source: 'https://docs.github.com/rest/search' },
  { id: 'mcp_registry', label: '公式 MCP レジストリの新着', kind: 'agent_commerce', free: true, needs_key: false,
    url: (n) => `https://registry.modelcontextprotocol.io/v0/servers?limit=${n}`,
    format: 'json', parse: 'mcp', source: 'https://registry.modelcontextprotocol.io/' },
  { id: 'lobsters', label: 'Lobsters', kind: 'community', free: true, needs_key: false,
    url: () => 'https://lobste.rs/hottest.json', format: 'json', parse: 'lobsters',
    source: 'https://lobste.rs/' },
  { id: 'devto', label: 'dev.to の注目記事', kind: 'content', free: true, needs_key: false,
    url: (n) => `https://dev.to/api/articles?per_page=${n}&top=7`, format: 'json', parse: 'devto',
    source: 'https://developers.forem.com/api' },
  { id: 'qiita', label: 'Qiita の新着（日本語圏）', kind: 'content', free: true, needs_key: false,
    url: (n) => `https://qiita.com/api/v2/items?per_page=${n}&page=1`, format: 'json', parse: 'qiita',
    source: 'https://qiita.com/api/v2/docs' },
  { id: 'zenn', label: 'Zenn の新着（日本語圏）', kind: 'content', free: true, needs_key: false,
    url: (n) => `https://zenn.dev/api/articles?order=latest&count=${n}`, format: 'json', parse: 'zenn',
    source: 'https://zenn.dev/' },
  { id: 'producthunt', label: 'Product Hunt の新着', kind: 'launch', free: true, needs_key: false,
    url: () => 'https://www.producthunt.com/feed', format: 'rss', parse: 'rss',
    source: 'https://www.producthunt.com/feed' },
  // --- ここから下は 2026-10-17 に実際に叩いて「生きている」ことを確認した追加分 -----
  // Indie Hackers は Cloudflare で 403 になったため巡回先から外した（死んだ先を回しても
  // 原価0の枠を無駄にするだけなので、実測で落ちた先は残さない）。
  { id: 'hn_whoishiring', label: 'HN「Who is hiring」（毎月の雇用・受託スレ）', kind: 'money', free: true, needs_key: false,
    url: () => 'https://hnrss.org/whoishiring/jobs', format: 'rss', parse: 'rss',
    source: 'https://hnrss.org/whoishiring/jobs' },
  { id: 'hn_hot50', label: 'Hacker News の急上昇（50点以上・新しい順）', kind: 'community', free: true, needs_key: false,
    url: () => 'https://hnrss.org/newest?points=50', format: 'rss', parse: 'rss',
    source: 'https://hnrss.org/' },
  { id: 'wwr', label: 'We Work Remotely（有償のリモート案件）', kind: 'money', free: true, needs_key: false,
    url: () => 'https://weworkremotely.com/categories/remote-programming-jobs.rss', format: 'rss', parse: 'rss',
    source: 'https://weworkremotely.com/' },
  { id: 'remotive', label: 'Remotive（有償のリモート案件・公開API）', kind: 'money', free: true, needs_key: false,
    url: (n) => `https://remotive.com/api/remote-jobs?limit=${n}`, format: 'json', parse: 'remotive',
    source: 'https://remotive.com/api/remote-jobs' },
  { id: 'remoteok', label: 'RemoteOK（有償のリモート案件・公開API）', kind: 'money', free: true, needs_key: false,
    url: () => 'https://remoteok.com/api', format: 'json', parse: 'remoteok',
    source: 'https://remoteok.com/api' },
  // 下の2本はタイトルが短く素点が低い（＝しきい値30では落ちる）が、仕様が変わったら
  // 必ず知りたい一次情報なので、この2本だけ下限を個別に下げて必ず拾う。
  { id: 'x402_releases', label: 'x402 本体のリリース（仕様変更の一次情報）', kind: 'agent_commerce', free: true, needs_key: false, min_score: 12,
    url: () => 'https://github.com/coinbase/x402/releases.atom', format: 'rss', parse: 'rss',
    source: 'https://github.com/coinbase/x402/releases' },
  { id: 'awesome_x402_commits', label: 'awesome-x402 の更新（新しい売り場の出現）', kind: 'agent_commerce', free: true, needs_key: false,
    url: () => 'https://github.com/xpaysh/awesome-x402/commits/main.atom', format: 'rss', parse: 'rss',
    source: 'https://github.com/xpaysh/awesome-x402' },
  { id: 'tool_registry_commits', label: 'ERC-8257 ToolRegistry の更新（登録仕様の変化）', kind: 'agent_commerce', free: true, needs_key: false, min_score: 12,
    url: () => 'https://github.com/ProjectOpenSea/tool-registry/commits/main.atom', format: 'rss', parse: 'rss',
    source: 'https://github.com/ProjectOpenSea/tool-registry' },
];

export const SOURCE_IDS = SOURCES.map((s) => s.id);
export const sourceById = (id) => SOURCES.find((s) => s.id === id) || null;

// ---------------------------------------------------------------------------
// 点数化 — 「金を払う人がいるか」を最優先に置く。話題性は加点しない
// （バズは収益ではない）。
// ---------------------------------------------------------------------------
export const MONEY_SIGNALS = [
  { id: 'price', re: /(\$\s?\d|USD|\d+\s?(ドル|円)\/|price|pricing|値段|価格|単価)/i, w: 12 },
  { id: 'pay_intent', re: /(willing to pay|pay(s|ing)? for|paid (service|api|tool)|buy|購入|有料|課金|有償)/i, w: 16 },
  { id: 'revenue', re: /(revenue|MRR|ARR|売上|収益|収入|儲か|稼げ)/i, w: 14 },
  { id: 'bounty', re: /(bounty|賞金|懸賞|報酬|budget|予算|grant|助成)/i, w: 18 },
  { id: 'hire_paid', re: /(hiring|contract|freelanc|commission|受託|募集|外注|業務委託)/i, w: 10 },
  { id: 'launch', re: /(launch|launched|now live|リリース|公開しました)/i, w: 6 },
];

export const CAPABILITY_SIGNALS = [
  { id: 'x402_agent', re: /(x402|agent(ic)? (payment|commerce)|machine.?to.?machine|ai agent.*pay)/i, w: 15 },
  { id: 'mcp', re: /(\bMCP\b|model context protocol)/i, w: 12 },
  { id: 'api_product', re: /(\bAPI\b|endpoint|sdk|webhook|自前API)/i, w: 7 },
  { id: 'data_work', re: /(csv|json|clean|dedup|正規化|データ整理|スクレイピング|scrape|crawler)/i, w: 8 },
  { id: 'monitor_work', re: /(monitor|watch|alert|通知|見張|監視|差分|diff|再入荷|値下げ)/i, w: 9 },
  { id: 'dev_work', re: /(code review|regex|正規表現|リファクタ|test|レビュー|バグ)/i, w: 6 },
  { id: 'trading', re: /(\bFX\b|forex|為替|EA|expert advisor|backtest|prop firm|トレード|裁量)/i, w: 7 },
  { id: 'content_sell', re: /(note|zenn|qiita|youtube|twitter|記事|動画|コンテンツ販売)/i, w: 5 },
];

export const DEMAND_SIGNALS = [
  { id: 'looking_for', re: /(looking for|is there a (tool|service)|recommend|anyone know|探して|教えて|おすすめ|代替|alternative to)/i, w: 11 },
  { id: 'pain', re: /(broken|frustrat|painful|pain point|annoying|手間|面倒|困って|失敗した|バグ)/i, w: 8 },
];

export const PENALTIES = [
  { id: 'job_only', re: /^(hiring|we are hiring|job|求人|正社員)/i, w: -6 },
  { id: 'funding_only', re: /(raises? \$|funding round|IPO)/i, w: -4 },
  { id: 'crypto_hype', re: /(airdrop|presale|100x|to the moon)/i, w: -10 },
];

export function scoreItem(item = {}) {
  const hay = `${item.title || ''} ${item.excerpt || ''} ${(item.tags || []).join(' ')}`;
  const signals = [];
  let score = 0;
  for (const s of [...MONEY_SIGNALS, ...CAPABILITY_SIGNALS, ...DEMAND_SIGNALS, ...PENALTIES]) {
    if (s.re.test(hay)) { score += s.w; signals.push({ id: s.id, w: s.w }); }
  }
  // 新しさ（48時間で半減）。古い情報は稼げない。
  const ageH = item.created_at ? (Date.now() - new Date(item.created_at).getTime()) / 3600e3 : 999;
  const fresh = ageH <= 6 ? 12 : ageH <= 24 ? 8 : ageH <= 72 ? 4 : ageH <= 168 ? 1 : -4;
  score += fresh;
  // 反応（人が実際に集まっている＝需要の代理指標）。ただし上限を切る。
  const engage = Math.min(10, Math.log10(1 + (item.points || 0) + (item.comments || 0)) * 5);
  score += engage;
  return {
    score: Math.round(score),
    fresh, engage: round(engage, 1), age_hours: Math.round(ageH),
    signals: signals.map((s) => s.id),
    money: signals.filter((s) => MONEY_SIGNALS.some((m) => m.id === s.id)).map((s) => s.id),
  };
}

// ---------------------------------------------------------------------------
// 既存の能力で「どこに載せられるか」を決める（＝試し方の入口）。
// ---------------------------------------------------------------------------
export const CAPABILITIES = [
  { id: 'x402', label: 'x402 直販APIに値札を付ける', cost: 0, human: ['価格の最終判断'], auto: true },
  { id: 'mcp', label: 'MCPツールとして出す（エージェントが買う）', cost: 0, human: [], auto: true },
  { id: 'monitor', label: '監視型サブスクの商品にする（毎日見張る）', cost: 0, human: ['告知'], auto: true },
  { id: 'content', label: 'note / X / ココナラ のネタにする', cost: 0, human: ['投稿の1タップ'], auto: true },
  { id: 'fx_ea', label: 'FX/EAの検証テーマにする（バックテストで確かめる）', cost: 0, human: [], auto: true },
  { id: 'marketplace', label: 'Apify / RapidAPI に出品する', cost: 0, human: ['本人確認'], auto: false },
];

export function capabilityFit(item = {}) {
  const hay = `${item.title || ''} ${item.excerpt || ''}`;
  const fits = [];
  if (/(x402|agent.*pay|machine.?to.?machine)/i.test(hay)) fits.push('x402');
  if (/\bMCP\b|model context protocol/i.test(hay)) fits.push('mcp');
  if (/(monitor|watch|alert|通知|監視|差分|再入荷)/i.test(hay)) fits.push('monitor');
  if (/(note|zenn|qiita|youtube|記事|動画|twitter)/i.test(hay)) fits.push('content');
  if (/(FX|forex|為替|EA|backtest|prop firm|トレード)/i.test(hay)) fits.push('fx_ea');
  if (/(API|endpoint|scrape|crawler|データ)/i.test(hay)) fits.push('x402');
  if (!fits.length) fits.push('content');
  return [...new Set(fits)];
}

/** 「小さく試す」計画。ここに費用のある手順を入れない（原価0を守る）。 */
export function trialPlan(item, fits) {
  const steps = [];
  for (const f of fits) {
    const c = CAPABILITIES.find((x) => x.id === f);
    if (!c) continue;
    steps.push({ capability: c.id, action: c.label, cost_jpy: c.cost, auto: c.auto, human: c.human });
  }
  steps.push({ capability: 'measure', action: '試した結果（反応・問い合わせ・成約）を記録し、次の判定に使う', cost_jpy: 0, auto: true, human: [] });
  return {
    steps,
    money_at_risk_jpy: 0,
    human_taps: [...new Set(steps.flatMap((s) => s.human))],
    note: '原価0の手順だけ。投げる・買う・アカウント作成は自動化しない（凍結と財布の防衛）。',
  };
}

// ---------------------------------------------------------------------------
// 保存 — D1。同じ物を二度拾わないための key を持つ。
// ---------------------------------------------------------------------------
export const T = 'scout_findings';

export async function ensureScoutTable(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${T} (
    id TEXT PRIMARY KEY, key TEXT NOT NULL, source_id TEXT NOT NULL,
    title TEXT, url TEXT, excerpt TEXT, tags_json TEXT DEFAULT '[]',
    score INTEGER DEFAULT 0, fresh INTEGER DEFAULT 0, engage REAL DEFAULT 0,
    age_hours INTEGER, signals_json TEXT DEFAULT '[]', money_json TEXT DEFAULT '[]',
    fits_json TEXT DEFAULT '[]', trial_json TEXT DEFAULT '{}',
    status TEXT DEFAULT 'new', note TEXT, created_at TEXT, updated_at TEXT
  )`);
  await store.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${T}_key ON ${T}(key)`).catch(() => {});
}

export function dedupeKey(item) {
  const s = `${item.source_id}|${String(item.url || '').replace(/[?#].*$/, '')}|${String(item.title || '').slice(0, 60)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `k${h.toString(36)}${s.length.toString(36)}`;
}

// ---------------------------------------------------------------------------
// 巡回 — 1回で叩く先を絞る（CPUとレートの防衛）。順番に回して全先をカバーする。
// ---------------------------------------------------------------------------
export async function scoutTick({ store, fetchImpl = null, maxSources = 3, perSource = 12, minScore = 30, now = null }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const report = { at: now || nowIso(), sources: [], inserted: 0, top: [] };
  await ensureScoutTable(store);

  const idxRaw = await store.first(`SELECT value FROM settings WHERE key='scout:idx'`).catch(() => null);
  let idx = Number(safeJson(idxRaw?.value, 0)) || 0;
  const picks = [];
  for (let i = 0; i < Math.min(maxSources, SOURCES.length); i++) {
    picks.push(SOURCES[(idx + i) % SOURCES.length]);
  }
  idx = (idx + picks.length) % SOURCES.length;
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES ('scout:idx',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    JSON.stringify(idx), now || nowIso());

  for (const src of picks) {
    const r = { source: src.id, label: src.label, fetched: 0, parsed: 0, kept: 0, status: null, error: null };
    try {
      const url = src.url(perSource);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      let res;
      try {
        res = await doFetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'WealthAgent-Scout/1.0 (+research; non-commercial)', accept: src.format === 'rss' ? 'application/rss+xml, application/xml, text/xml, */*' : 'application/json' } });
      } finally { clearTimeout(timer); }
      r.status = res.status;
      if (!res.ok) { r.error = `http_${res.status}`; report.sources.push(r); continue; }
      const text = await res.text();
      r.fetched = text.length;
      const parsedAll = parseItems(src, text);
      // RSS/Atom は1本で100件以上返る先もある。点数は鮮度で重み付けしているので、
      // フィードの並び順に頼らず「新しい順」に perSource 件だけを採点対象にする。
      const items = parsedAll
        .map((it) => ({ it, t: it.created_at ? (new Date(it.created_at).getTime() || 0) : 0 }))
        .sort((a, b) => b.t - a.t)
        .slice(0, Math.max(1, perSource))
        .map((x) => x.it);
      r.parsed = items.length;
      for (const it of items) {
        const sc = scoreItem(it);
        // 巡回先ごとの下限（src.min_score）があればそれを使う。無ければ全体のしきい値。
        if (sc.score < (src.min_score ?? minScore)) continue;
        const fits = capabilityFit(it);
        const row = {
          id: newId('sc_'), key: dedupeKey(it), source_id: src.id,
          title: String(it.title || '').slice(0, 300), url: it.url || null,
          excerpt: String(it.excerpt || '').slice(0, 600), tags_json: j(it.tags || []),
          score: sc.score, fresh: sc.fresh, engage: sc.engage, age_hours: sc.age_hours,
          signals_json: j(sc.signals), money_json: j(sc.money), fits_json: j(fits),
          trial_json: j(trialPlan(it, fits)), status: 'new', note: null,
          created_at: it.created_at || nowIso(), updated_at: now || nowIso(),
        };
        try {
          await store.run(`INSERT INTO ${T} (id,key,source_id,title,url,excerpt,tags_json,score,fresh,engage,age_hours,signals_json,money_json,fits_json,trial_json,status,note,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO NOTHING`,
            row.id, row.key, row.source_id, row.title, row.url, row.excerpt, row.tags_json, row.score, row.fresh, row.engage, row.age_hours, row.signals_json, row.money_json, row.fits_json, row.trial_json, row.status, row.note, row.created_at, row.updated_at);
          r.kept++;
          report.inserted++;
          report.top.push({ score: row.score, title: row.title, url: row.url, source: src.id, fits });
        } catch (e) { /* 重複は無視 */ }
      }
    } catch (e) { r.error = e.name === 'AbortError' ? 'timeout' : e.message; }
    report.sources.push(r);
  }
  report.top.sort((a, b) => b.score - a.score);
  report.top = report.top.slice(0, 12);
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES ('scout:last_run',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    j({ at: report.at, inserted: report.inserted, sources: report.sources.map((s) => `${s.source}:${s.kept}`) }), report.at);
  return report;
}

// ---------------------------------------------------------------------------
// 解析 — 巡回先ごとに形が違うので、それぞれの形を吸収して共通の形に落とす。
// ---------------------------------------------------------------------------
export function parseItems(src, text) {
  try {
    const p = src.parse;
    if (p === 'hn') {
      const d = JSON.parse(text);
      return (d.hits || []).map((h) => ({
        title: h.title || h.story_title || '', url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        excerpt: String(h.story_text || h.comment_text || '').replace(/<[^>]+>/g, ' '),
        created_at: h.created_at, points: h.points || 0, comments: h.num_comments || 0, tags: h._tags || [],
      }));
    }
    if (p === 'gh_issues') {
      const d = JSON.parse(text);
      return (d.items || []).map((i) => ({
        title: i.title || '', url: i.html_url, excerpt: String(i.body || '').slice(0, 400),
        created_at: i.created_at, points: 0, comments: i.comments || 0,
        tags: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
      }));
    }
    if (p === 'gh_repos') {
      const d = JSON.parse(text);
      return (d.items || []).map((r) => ({
        title: `${r.full_name} — ${r.description || ''}`, url: r.html_url,
        excerpt: String(r.description || ''), created_at: r.created_at,
        points: r.stargazers_count || 0, comments: r.open_issues_count || 0, tags: r.topics || [],
      }));
    }
    if (p === 'mcp') {
      const d = JSON.parse(text);
      const arr = d.servers || d.data || [];
      return arr.map((s) => {
        const srv = s.server || s;
        return {
          title: `MCP: ${srv.name || ''}`, url: srv.repository?.url || srv.websiteUrl || 'https://registry.modelcontextprotocol.io/',
          excerpt: String(srv.description || ''), created_at: srv.publishedAt || s.updatedAt || null,
          points: 0, comments: 0, tags: ['mcp'],
        };
      });
    }
    if (p === 'lobsters') {
      const d = JSON.parse(text);
      return (Array.isArray(d) ? d : []).map((s) => ({
        title: s.title || '', url: s.url || s.comments_url, excerpt: String(s.description || ''),
        created_at: s.created_at, points: s.score || 0, comments: s.comment_count || 0, tags: s.tags || [],
      }));
    }
    if (p === 'devto') {
      const d = JSON.parse(text);
      return (Array.isArray(d) ? d : []).map((a) => ({
        title: a.title || '', url: a.url, excerpt: String(a.description || ''),
        created_at: a.published_at, points: a.public_reactions_count || 0, comments: a.comments_count || 0,
        tags: a.tag_list || [],
      }));
    }
    if (p === 'qiita') {
      const d = JSON.parse(text);
      return (Array.isArray(d) ? d : []).map((a) => ({
        title: a.title || '', url: a.url, excerpt: String((a.body || '').slice(0, 300)),
        created_at: a.created_at, points: a.likes_count || 0, comments: a.comments_count || 0, tags: (a.tags || []).map((t) => t.name),
      }));
    }
    if (p === 'zenn') {
      const d = JSON.parse(text);
      return (d.articles || []).map((a) => ({
        title: a.title || '', url: `https://zenn.dev${a.path || `/articles/${a.slug || ''}`}`,
        excerpt: String(a.emoji || ''), created_at: a.published_at,
        points: a.liked_count || 0, comments: a.comments_count || 0, tags: [],
      }));
    }
    if (p === 'remotive') {
      const d = JSON.parse(text);
      const arr = Array.isArray(d) ? d : (d.jobs || []);
      return arr.map((x) => ({
        title: `${x.company_name ? x.company_name + ' — ' : ''}${x.title || ''}`,
        url: x.url,
        excerpt: [String(x.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360),
          x.salary ? `salary: ${x.salary}` : ''].filter(Boolean).join(' '),
        created_at: x.publication_date || null, points: 0, comments: 0,
        tags: (x.tags || []).slice(0, 8),
      }));
    }
    if (p === 'remoteok') {
      const d = JSON.parse(text);
      // 先頭の要素は利用規約の告知で求人ではない。求人だけを残す。
      return (Array.isArray(d) ? d : []).filter((x) => x && x.url && (x.position || x.title)).map((x) => ({
        title: `${x.company ? x.company + ' — ' : ''}${x.position || x.title || ''}`,
        url: x.url,
        excerpt: [String(x.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360),
          (x.salary_min || x.salary_max) ? `salary: ${x.salary_min || '?'}-${x.salary_max || '?'}` : ''].filter(Boolean).join(' '),
        created_at: x.date || (x.epoch ? new Date(x.epoch * 1000).toISOString() : null),
        points: 0, comments: 0, tags: (x.tags || []).slice(0, 8),
      }));
    }
    if (p === 'rss') return parseRss(text);
  } catch (e) { return []; }
  return [];
}

export function parseRss(xml) {
  const out = [];
  const blocks = String(xml).split(/<item[\s>]|<entry[\s>]/).slice(1);
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    };
    const title = pick('title');
    let url = pick('link');
    if (!url) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      if (m) url = m[1];
    }
    if (!title && !url) continue;
    out.push({
      title, url, excerpt: pick('description') || pick('summary') || pick('content'),
      created_at: pick('pubDate') || pick('published') || pick('updated') || null,
      points: 0, comments: 0, tags: [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 読み出し（UI/レポート用）
// ---------------------------------------------------------------------------
export async function listFindings(store, { limit = 30, minScore = 0 } = {}) {
  await ensureScoutTable(store);
  return await store.all(`SELECT * FROM ${T} WHERE score >= ? ORDER BY score DESC, created_at DESC LIMIT ?`, minScore, limit).catch(() => []);
}

export async function scoutSummary(store) {
  const rows = await listFindings(store, { limit: 40 });
  const by = {};
  for (const r of rows) by[r.source_id] = (by[r.source_id] || 0) + 1;
  return {
    measured: rows.length > 0,
    total_kept: rows.length,
    best: rows[0] ? { title: rows[0].title, url: rows[0].url, score: rows[0].score, fits: safeJson(rows[0].fits_json, []) } : null,
    by_source: by,
    rows,
  };
}

export function scoutCards(summary = {}) {
  const rows = summary.rows || [];
  const kpi = {
    type: 'kpi', title: 'スカウト（無料の巡回先だけ・原価0）',
    items: [
      { label: '拾った候補', value: summary.total_kept || 0, unit: '件（しきい値以上）' },
      { label: '巡回先', value: SOURCES.length, unit: '箇所（すべて鍵不要）' },
      { label: '試す計画つき', value: rows.filter((r) => safeJson(r.trial_json, {}).steps).length, unit: '件' },
      { label: '金を使う手順', value: 0, unit: '件（原価0を強制）' },
    ],
  };
  const list = {
    type: 'list', title: 'いま試す価値のある順',
    items: rows.slice(0, 8).map((r) => ({
      label: String(r.title || '').slice(0, 84),
      value: `${r.score}点`,
      unit: `${r.source_id} · ${(safeJson(r.fits_json, []) || []).join('/')}`,
    })),
  };
  const note = {
    type: 'note',
    text: '巡回先はすべて無料・APIキー不要です（Hacker News / HN急上昇 / Who is hiring / GitHub / MCPレジストリ / Lobsters / dev.to / Qiita / Zenn / Product Hunt / We Work Remotely / Remotive / RemoteOK / x402リリース / awesome-x402 / ERC-8257 ToolRegistry）。鍵が要る所は使いません。投稿・購入・アカウント作成は自動化しません。',
  };
  return [kpi, list, note];
}

export function scoutHelp() {
  return [
    'SNS・掲示板・マーケットを自動で巡回して「金を払う人がいそうな話」だけを拾い、点数をつけて残します。',
    '使うのは無料でAPIキーが不要な公開エンドポイントだけです（原価0）。鍵が要る所は候補から外しています。',
    '拾った候補は、既存の能力（x402直販 / MCP / 監視サブスク / コンテンツ / FX-EA）で「小さく試す」手順に自動で変換されます。',
    '点数は「金の話＞能力との相性＞新しい＞人が集まっている」の順で重み付けしています。話題性だけでは上がりません（バズは収益ではないため）。',
    'ここは候補を出すだけで、投稿・購入・アカウント作成はしません。最後の判断は人が持ちます。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 外に出す口（/api/scout）— 拾った候補と「試す計画」を画面から見えるようにする。
// これが無いと、候補と計画は下書きの本文の中にしか存在せず、人が確認できない
// （「集めているのに見えない」状態になる）。
// ---------------------------------------------------------------------------
export function shapeFinding(r = {}) {
  const trial = safeJson(r.trial_json, {}) || {};
  const steps = Array.isArray(trial.steps) ? trial.steps : [];
  const src = sourceById(r.source_id);
  return {
    id: r.id, title: r.title, url: r.url,
    excerpt: String(r.excerpt || '').replace(/\s+/g, ' ').slice(0, 220),
    source: r.source_id, source_label: (src && (src.label || src.name)) || r.source_id,
    score: Number(r.score) || 0, fresh: r.fresh, engage: r.engage, age_hours: r.age_hours,
    money: safeJson(r.money_json, []), signals: safeJson(r.signals_json, []), fits: safeJson(r.fits_json, []),
    status: r.status || 'new',
    trial: { steps, money_at_risk_jpy: trial.money_at_risk_jpy ?? 0, human_taps: trial.human_taps || [], note: trial.note || '' },
    trial_cost_jpy: steps.reduce((a, s) => a + (Number(s.cost_jpy) || 0), 0),
    created_at: r.created_at,
  };
}

export async function scoutFindings(store, { limit = 20, minScore = 30 } = {}) {
  const rows = await listFindings(store, { limit, minScore });
  return rows.map(shapeFinding);
}

export function scoutLoopNote() {
  return '巡回・採点・保存・「試す計画」は全自動（原価0）。実行（投稿・出品・応募）は人の1タップ。記録した結果（売れた／反応なし）は次に拾う候補の優先順位に効きます。FXは実験ループ（fx_lab）が自動で閉じています。';
}
