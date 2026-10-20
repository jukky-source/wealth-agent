// repo-1.0 — GitHub から「良いリポジトリ」を取り入れる取り込みループ（原価0）。
//
// 「取り入れる」の意味を正直に定義する:
//   ・探す  … GitHub 検索（無料API・鍵は任意）
//   ・読む  … README を取得して、使える資源（登録できる売り場／無料API／競合の値札）を抜く
//   ・足す  … 抜いた資源を我々の台帳（repo_candidates）と分野の台帳（frontier_ideas）に足す
//   ・写す  … 売り場として宣言APIがあるものは既存の channel_hunt が拾って実際に登録を試す
//   コードとして丸ごと持ち込むことはしない（人の承認が要る手として残す）。
//
// よってここは「候補の収集と分類」までを自動化し、採用の最終判断は記録として残す。

import { scanExternal, sanitizeExternal } from './guardrail.js';

export const REPO_VERSION = 'repo-1.0';
export const RC = 'repo_candidates';
export const RSTATE = 'repo:state';
export const LP = 'listing_prospects';
export const REPO_EVERY_MINUTES = 240;
export const GH_API = 'https://api.github.com/search/repositories';
export const GH_UA = 'WealthAgent-Repo/1.0';

const nowIso = () => new Date().toISOString();
const clip = (s, n = 300) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) : t; };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// 検索語は「稼ぎ方の分野」に対応させる。分野が増えたらここも増やす。
export const QUERIES = [
  { q: 'x402 agent payments', domain: 'x402_api', why: 'x402 で売っている/買っている実装' },
  { q: 'awesome x402', domain: 'marketplace_listing', why: '売り場・索引・道具の一覧' },
  { q: 'awesome agentic commerce', domain: 'marketplace_listing', why: 'エージェント商取引の売り場一覧' },
  { q: 'ai agent marketplace registry', domain: 'agent_registry', why: '出品できる場所（レジストリ）' },
  { q: 'agent commerce protocol', domain: 'agent_commerce', why: '商取引プロトコル（ACP/UCP/AP2）' },
  { q: 'agent llm router free', domain: 'llm_router', why: '無料で賢いモデルを呼ぶ経路' },
  { q: 'agent memory framework autonomous', domain: 'agent_runtime', why: '長期記憶と自律運転の作り方' },
];

// 資源の分類。URL と理由を返す（本文に無いものは作らない）。
export const RESOURCE_RULES = [
  { kind: 'listing', label: '出品できる売り場', re: /(marketplace|bazaar|registry|directory|discovery|submit|submission|list-your|\/list|\/listing|publish|onboard)/i, why: '出品・登録の窓口' },
  { kind: 'facilitator', label: '決済の代行', re: /(facilitator|\/verify|\/settle|x402-pay|paywall)/i, why: '402決済の実行役' },
  { kind: 'docs', label: '仕様・手順書', re: /(docs?\.|documentation|spec|readme|whitepaper|guide)/i, why: '仕様の確認用' },
  { kind: 'free_api', label: '無料で使えるAPI', re: /(api\.|api\/|\/v\d|free-tier|rate-limit|apikey|api_key)/i, why: '原価0の材料' },
  { kind: 'dashboard', label: '実測の見える場所', re: /(dashboard|analytics|stats|explorer|leaderboard|volume|metrics)/i, why: '買い手側の実測' },
];

const NOISE = /(github\.com\/[\w.-]+\/[\w.-]+\.(png|svg|jpg|jpeg|gif)|shields\.io|badge|img\.shields|contrib\.rocks|opencollective|ko-fi|patreon|twitter\.com|x\.com|discord\.gg|discord\.com|t\.me|npmjs\.com\/package|pypi\.org|youtube\.com|medium\.com|github\.com\/sponsors|buymeacoffee|licenses?|opensource\.org|choosealicense)/i;

/** README（や本文）から http(s) の URL を抜いて分類する。重複は落とす。 */
export function extractResources(text = '') {
  const s = String(text || '');
  const raw = s.match(/https?:\/\/[^\s)<>"'\]}\\`]+/g) || [];
  const seen = new Map();
  for (let u of raw) {
    u = u.replace(/[.,;:]+$/, '');
    if (NOISE.test(u)) continue;
    let host = '';
    try { host = new URL(u).host.toLowerCase(); } catch { continue; }
    if (!host || /^(localhost|127\.|0\.0\.0\.0)/.test(host)) continue;
    if (!seen.has(u)) seen.set(u, { url: u, host, kind: 'other', label: 'その他', why: '' });
  }
  const out = [];
  for (const r of seen.values()) {
    for (const rule of RESOURCE_RULES) {
      if (rule.re.test(r.url)) { r.kind = rule.kind; r.label = rule.label; r.why = rule.why; break; }
    }
    out.push(r);
  }
  return out;
}

/** x402 の売り手アドレス（payTo）を拾う。競合の値札を測る材料になる。 */
export function extractPayTo(text = '') {
  const s = String(text || '');
  const m = s.match(/0x[a-fA-F0-9]{40}/g) || [];
  return Array.from(new Set(m.map((x) => x.toLowerCase())));
}

/** リポジトリを「我々にとって何か」で分類し、採用の判断と理由を返す。 */
export function classifyRepo(repo = {}, resources = [], payTo = []) {
  const desc = `${repo.description || ''} ${(repo.topics || []).join(' ')}`.toLowerCase();
  const stars = num(repo.stargazers_count);
  const pushedDays = repo.pushed_at ? Math.round((Date.now() - new Date(repo.pushed_at).getTime()) / 86400000) : null;
  const fresh = pushedDays != null ? pushedDays <= 180 : false;
  let kind = 'other'; let adopt = 'skip'; const why = [];
  if (/(awesome|curated|collection|list of)/.test(desc)) {
    kind = 'list';
    const listing = resources.filter((r) => r.kind === 'listing').length;
    adopt = listing >= 2 ? 'catalog' : 'reference';
    why.push(`一覧リポジトリ。出品窓口のURLを${listing}件抜いた`);
  } else if (/(marketplace|registry|directory|discovery)/.test(desc)) {
    kind = 'marketplace'; adopt = 'candidate_listing';
    why.push('売り場そのものの可能性');
  } else if (/(router|inference|llm|model)/.test(desc)) {
    kind = 'ai_router'; adopt = 'reference'; why.push('無料で賢いモデルを呼ぶ経路の候補');
  } else if (/(agent.*framework|runtime|memory|orchestrat)/.test(desc)) {
    kind = 'runtime'; adopt = 'pattern'; why.push('自律運転・長期記憶の設計の参考');
  } else if (/(facilitator|payment|settlement|sdk|protocol)/.test(desc)) {
    kind = 'infra'; adopt = payTo.length ? 'benchmark' : 'reference';
    why.push(payTo.length ? `決済実装。売り手アドレス${payTo.length}件を検体として記録` : '決済実装。仕様の参照');
  }
  if (fresh) why.push('最近も動いている');
  if (stars >= 100) why.push(`★${stars}`);
  if (adopt === 'skip' && fresh && stars >= 200) { adopt = 'watch'; why.push('直接は使えないが動きが活発なので観測'); }
  return { kind, adopt, stars, pushed_days: pushedDays, fresh, why: why.join(' / ') };
}

// ------------------------------------------------------------------ 口
async function run(store, sql, ...p) {
  const tries = [
    () => (store && typeof store.run === 'function' ? store.run(sql, ...p) : null),
    () => (store && typeof store.execute === 'function' ? store.execute(sql, ...p) : null),
    () => (store && typeof store.prepare === 'function' ? store.prepare(sql).bind(...p).run() : null),
  ];
  for (const t of tries) { try { const r = await t(); if (r != null) return r; } catch { /* 次の口 */ } }
  return null;
}
const unwrap = (r) => { if (r == null) return null; if (Array.isArray(r)) return r; if (Array.isArray(r.results)) return r.results; return r; };
async function q1(store, sql, ...p) {
  const tries = [
    () => (store && typeof store.first === 'function' ? store.first(sql, ...p) : null),
    () => (store && typeof store.get === 'function' ? store.get(sql, ...p) : null),
    () => (store && typeof store.query === 'function' ? store.query(sql, ...p) : null),
    () => (store && typeof store.prepare === 'function' ? store.prepare(sql).bind(...p).first() : null),
  ];
  for (const t of tries) { try { const r = await t(); if (r != null) return unwrap(r); } catch { /* 次の口 */ } }
  return null;
}
async function qa(store, sql, ...p) {
  const tries = [
    () => (store && typeof store.all === 'function' ? store.all(sql, ...p) : null),
    () => (store && typeof store.query === 'function' ? store.query(sql, ...p) : null),
    () => (store && typeof store.first === 'function' ? store.first(sql, ...p) : null),
    () => (store && typeof store.prepare === 'function' ? store.prepare(sql).bind(...p).all() : null),
  ];
  for (const t of tries) { try { const r = await t(); const u = unwrap(r); if (Array.isArray(u)) return u; } catch { /* 次の口 */ } }
  return [];
}
async function setting(store, key, fallback = null) {
  const r = await q1(store, 'SELECT value FROM settings WHERE key=?', key);
  return r && r.value != null ? r.value : fallback;
}
async function setSetting(store, key, value) {
  return run(store, 'INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', key, String(value == null ? '' : value), nowIso());
}

export async function ensureRepoTables(store) {
  await run(store, `CREATE TABLE IF NOT EXISTS ${RC} (full_name TEXT PRIMARY KEY, at TEXT, stars INTEGER, pushed_at TEXT, html_url TEXT, description TEXT, lang TEXT, query TEXT, domain TEXT, kind TEXT, adopt TEXT, why TEXT, resources_json TEXT, payto_json TEXT, readme_chars INTEGER, note TEXT)`).catch(() => {});
  await run(store, 'CREATE INDEX IF NOT EXISTS idx_repo_candidates_at ON repo_candidates (at)').catch(() => {});
}

/** GitHub 検索（鍵は任意。無くても動くが回数制限が厳しい）。 */
export async function githubSearch(q, { token = null, perPage = 8, fetchImpl = fetch } = {}) {
  const url = `${GH_API}?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${Math.max(1, Math.min(30, perPage))}`;
  const headers = { accept: 'application/vnd.github+json', 'user-agent': GH_UA };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers });
  const status = res.status;
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) return { ok: false, status, error: clip((body && body.message) || 'github_search_failed', 160), items: [] };
  return { ok: true, status, items: (body && body.items) || [] };
}

/** 資源の一覧を URL でまとめる（前回の測定を消さない）。 */
export function mergeRes(list = [], prev = []) {
  const byUrl = new Map();
  for (const x of prev) if (x && x.url) byUrl.set(x.url, x);
  for (const x of list) if (x && x.url) byUrl.set(x.url, x); // 新しい測定を優先
  return Array.from(byUrl.values());
}

/** README（本文）を取る。失敗しても止めない。 */
export async function fetchReadme(fullName, { token = null, fetchImpl = fetch } = {}) {
  const headers = { accept: 'application/vnd.github.raw', 'user-agent': GH_UA };
  if (token) headers.authorization = `Bearer ${token}`;
  for (const branch of ['main', 'master']) {
    try {
      const res = await fetchImpl(`https://raw.githubusercontent.com/${fullName}/${branch}/README.md`, { headers });
      if (res.ok) { const t = await res.text(); if (t && t.length > 40) return clip(t, 60000); }
    } catch { /* 次の枝を試す */ }
  }
  return '';
}

/**
 * 1ラウンド: 探す→読む→分類する→台帳に足す。
 * 取り入れた資源は repo_candidates に残し、出品候補と新しい分野は frontier_ideas にも入れる。
 */
export async function repoIntake({ store, env = {}, deps = {}, fetchImpl = fetch, now = null, force = false, limit = null, readmes = null } = {}) {
  await ensureRepoTables(store);
  const everyMin = Math.max(30, num(env.REPO_EVERY_MINUTES, REPO_EVERY_MINUTES));
  const last = await setting(store, `${RSTATE}:last_run_at`, null);
  if (!force && last && Date.now() - new Date(last).getTime() < everyMin * 60e3) {
    return { ok: true, skipped: 'not_due', age_minutes: Math.round((Date.now() - new Date(last).getTime()) / 60000) };
  }
  const token = env.GITHUB_TOKEN || null;
  const maxReadme = Limit(readmes, num(env.REPO_README_LIMIT, 4), 0, 8);
  const perQuery = Limit(limit, num(env.REPO_PER_QUERY, 5), 1, 10);
  const at = now || nowIso();
  const seen = new Set();
  const saved = []; const errors = []; let readmeCount = 0;

  for (const { q, domain, why } of QUERIES) {
    const r = await githubSearch(q, { token, perPage: perQuery, fetchImpl });
    if (!r.ok) { errors.push(`${q}: ${r.error}`); continue; }
    for (const it of r.items.slice(0, perQuery)) {
      const full = String(it.full_name || '');
      if (!full || seen.has(full)) continue;
      seen.add(full);
      const known = await q1(store, `SELECT full_name, readme_chars, resources_json, payto_json FROM ${RC} WHERE full_name=?`, full);
      let readme = '';
      if (readmeCount < maxReadme && !(known && num(known.readme_chars) > 0)) {
        readme = await fetchReadme(full, { token, fetchImpl });
        readmeCount += 1;
      }
      // 前回読んだ README の成果は消さない（READMEを取り直さない回で資源が痩せるのを防ぐ）。
      const prevRes = known ? safe(known.resources_json) : [];
      const prevPay = known ? safe(known.payto_json) : [];
      const resources = mergeRes(extractResources(`${it.description || ''}\n${(it.topics || []).join(' ')}` + (readme ? `\n${readme}` : '')), prevRes);
      const payTo = Array.from(new Set(extractPayTo(readme).concat(prevPay.filter((x) => typeof x === 'string'))));
      // 外部の本文（README）に「我々への命令」が混ざっていないかを必ず数える（読むが従わない）。
      const ext = readme ? scanExternal(readme) : { risky: false, hits: [] };
      const c = classifyRepo(it, resources, payTo);
      await run(store, `INSERT INTO ${RC} (full_name,at,stars,pushed_at,html_url,description,lang,query,domain,kind,adopt,why,resources_json,payto_json,readme_chars,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(full_name) DO UPDATE SET at=excluded.at, stars=excluded.stars, pushed_at=excluded.pushed_at, kind=excluded.kind, adopt=excluded.adopt, why=excluded.why, resources_json=excluded.resources_json, payto_json=excluded.payto_json, readme_chars=MAX(COALESCE(repo_candidates.readme_chars,0),COALESCE(excluded.readme_chars,0))`,
        full, at, num(it.stargazers_count), it.pushed_at || null, it.html_url || null, clip(it.description, 300), it.language || null, q, domain, c.kind, c.adopt, clip(c.why, 400),
        JSON.stringify(resources.slice(0, 24)), JSON.stringify(payTo.slice(0, 12)), readme.length, why).catch(() => {});
      saved.push({ full_name: full, stars: c.stars, kind: c.kind, adopt: c.adopt, resources: resources.length, payto: payTo.length, readme_chars: readme.length, domain, why: c.why, injection: ext.hits.length });
      // 出品候補（登録窓口が実際に本文にあったものだけ）を分野の台帳へ渡す。
      if (c.adopt === 'candidate_listing' || c.adopt === 'catalog') {
        const listing = resources.filter((x) => x.kind === 'listing').slice(0, 3);
        if (listing.length) {
          await run(store, 'INSERT INTO frontier_ideas (id,at,domain,idea,why,score,source,state,evidence_json,note) VALUES (?,?,?,?,?,?,?,?,?,?)',
            `fi-repo-${full.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40)}`, at, 'marketplace_listing',
            clip('出品窓口: ' + listing.map((x) => x.url).join(' / '), 300), clip(`${full}（★${c.stars}）から抽出。${c.why}`, 400), 0.35, 'repo', 'proposed',
            JSON.stringify({ repo: full, urls: listing.map((x) => x.url) }), '宣言APIがあるものは channel_hunt が実際に登録を試す').catch(() => {});
        }
      }
    }
  }
  await setSetting(store, `${RSTATE}:last_run_at`, at);
  const top = saved.slice().sort((a, b) => b.stars - a.stars)[0] || null;
  return { ok: true, at, scanned: saved.length, readmes: readmeCount, errors: errors.slice(0, 5),
    adopt: saved.filter((s) => s.adopt !== 'skip' && s.adopt !== 'watch').length,
    listing_candidates: saved.filter((s) => s.adopt === 'candidate_listing' || s.adopt === 'catalog').length,
    payto_found: saved.reduce((n, s) => n + s.payto, 0), injection_hits: saved.reduce((n, s) => n + s.injection, 0), top, items: saved };
}

const Limit = (v, d, lo, hi) => { const n = v == null ? d : num(v, d); return Math.max(lo, Math.min(hi, n)); };

// ------------------------------------------------------------------ 読み出し
export async function repoStatus(store, { limit = 40 } = {}) {
  await ensureRepoTables(store);
  const rows = await qa(store, `SELECT full_name,at,stars,pushed_at,html_url,description,query,domain,kind,adopt,why,resources_json,payto_json,readme_chars FROM ${RC} ORDER BY stars DESC LIMIT ?`, Math.max(1, Math.min(200, limit)));
  const counts = {};
  for (const r of rows) counts[r.adopt] = (counts[r.adopt] || 0) + 1;
  const listings = [];
  for (const r of rows) {
    let res = []; try { res = JSON.parse(r.resources_json || '[]'); } catch { res = []; }
    for (const x of res.filter((y) => y.kind === 'listing').slice(0, 2)) listings.push({ repo: r.full_name, url: x.url, host: x.host });
  }
  return { ok: true, version: REPO_VERSION, last_run_at: await setting(store, `${RSTATE}:last_run_at`, null),
    candidates: rows.map((r) => ({ full_name: r.full_name, stars: num(r.stars), kind: r.kind, adopt: r.adopt, domain: r.domain, why: r.why, html_url: r.html_url, description: clip(r.description, 160), resources: safe(r.resources_json).length, payto: safe(r.payto_json).length, readme_chars: num(r.readme_chars) })),
    by_adopt: counts, listing_candidates: listings.slice(0, 20),
    queries: QUERIES, note: '探す・読む・分類する・台帳に足すまでが自動。コードとして取り込むのは人の承認。' };
}

export function repoText(s = {}) {
  const L = [];
  L.push(`GitHub 取り込み（${REPO_VERSION}） — 最終 ${s.last_run_at || '未実行'}`);
  L.push('');
  L.push('採用の内訳: ' + Object.entries(s.by_adopt || {}).map(([k, v]) => `${k}=${v}`).join(' / '));
  L.push('');
  for (const c of s.candidates || []) L.push(`${String(c.stars).padStart(6)}★ ${c.adopt.padEnd(18)} ${c.full_name.padEnd(42)} ${clip(c.why, 70)}`);
  if ((s.listing_candidates || []).length) {
    L.push('', '出品窓口として抜けたURL:');
    for (const x of s.listing_candidates) L.push(` - ${x.repo}: ${x.url}`);
  }
  return L.join('\n');
}

export function repoHelp(base = '') {
  return ['repo-1.0 — GitHub から良いリポジトリを取り入れる（原価0）',
    '', 'GET  ' + base + '/api/repos            候補と採用の判断',
    'GET  ' + base + '/api/repos?format=text',
    'GET  ' + base + '/api/repos/public     公開版',
    'POST ' + base + '/api/repos/intake     {force:true} で今すぐ探しに行く',
    '', '取り入れ方: 探す→READMEを読む→資源（出品窓口・無料API・競合の値札）を抜く→台帳に足す。',
    '売り場として宣言APIがあるものは channel_hunt が実際に登録を試す。コードの持ち込みは人の承認。'].join('\n');
}

const safe = (j) => { try { return JSON.parse(j || '[]'); } catch { return []; } };


// ------------------------------------------------------------------ 出品窓口の台帳（listing_prospects）
// 「GitHub で見つけた出品先」を、ホスト単位にまとめて台帳に落とし、
// 登録の窓口が機械可読（宣言API）かどうかだけを実際に取りに行って確かめる。
// 登録そのものは門（channel_hunt）を通す。ここでは「どこに・どの形で出せるか」まで。

export async function ensureListingProspects(store) {
  await run(store, `CREATE TABLE IF NOT EXISTS ${LP} (host TEXT PRIMARY KEY, at TEXT, urls_json TEXT, repos_json TEXT, kinds_json TEXT, state TEXT, probes INTEGER, http_status INTEGER, signal TEXT, note TEXT)`).catch(() => {});
  await run(store, `CREATE INDEX IF NOT EXISTS idx_listing_prospects_at ON ${LP} (at)`).catch(() => {});
}

/** URL の形から窓口の種類を決める（決定的）。 */
export function prospectKind(url = '') {
  const u = String(url);
  if (/\/(api|v1|v2)\//i.test(u) || /\.json($|\?)/i.test(u)) return 'api';
  if (/(submit|submission|register|signup|onboard|list-your|\/list\b|\/listing)/i.test(u)) return 'form';
  if (/(docs?|guide|readme|spec)/i.test(u)) return 'docs';
  return 'unknown';
}

/** 同じホストの窓口を1件にまとめる（出典リポジトリも束ねる）。 */
export function dedupeProspects(rows = []) {
  const by = new Map();
  for (const r of rows) {
    for (const x of (r.resources || [])) {
      if (!x || x.kind !== 'listing' || !x.url) continue;
      let host = x.host;
      if (!host) { try { host = new URL(x.url).host.toLowerCase(); } catch { continue; } }
      if (!host) continue;
      const cur = by.get(host) || { host, urls: [], repos: [], kinds: [] };
      if (!cur.urls.includes(x.url)) cur.urls.push(x.url);
      if (r.full_name && !cur.repos.includes(r.full_name)) cur.repos.push(r.full_name);
      const k = prospectKind(x.url);
      if (!cur.kinds.includes(k)) cur.kinds.push(k);
      by.set(host, cur);
    }
  }
  return Array.from(by.values()).sort((a, b) => b.repos.length - a.repos.length || a.host.localeCompare(b.host));
}

/** 窓口を実際に取りに行った結果の見分け。宣言APIがあって登録の語があるときだけ「自動で試せる」。 */
export function classifyProbe(status = 0, body = '') {
  const s = String(body || '');
  const b = s.toLowerCase();
  if (!status) return { signal: 'unreachable', can_register: false };
  if (status >= 500) return { signal: 'down', can_register: false };
  if (status === 404 || status === 410) return { signal: 'gone', can_register: false };
  if (status === 401 || status === 403) return { signal: 'auth_wall', can_register: false };
  const hasApi = /(openapi|swagger|"x402"|x402\.org|facilitator|"resources"\s*:)/i.test(s);
  const hasForm = /<form|type="email"|name="url"/i.test(s);
  const hasSubmit = /(submit|register|list your|add your|publish|出品)/i.test(b);
  const can = hasApi && hasSubmit;
  return { signal: can ? 'api_registerable' : (hasForm || hasSubmit ? 'manual_form' : (hasApi ? 'api_unclear' : 'page_only')), can_register: can, has_api: hasApi, has_form: hasForm };
}

async function probeUrl(u, fetchImpl = fetch, ms = 6000) {
  const ctl = new AbortController();
  const tm = setTimeout(() => { try { ctl.abort(); } catch { /* 任意 */ } }, ms);
  try {
    const res = await fetchImpl(u, { method: 'GET', redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': GH_UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.5' } });
    let body = '';
    try { body = (await res.text()).slice(0, 20000); } catch { body = ''; }
    return { status: res.status || 0, body };
  } catch { return { status: 0, body: '' }; }
  finally { clearTimeout(tm); }
}

/** 1ラウンド: 候補をまとめる → 上位だけ実際に取りに行く → 台帳に残す。 */
export async function repoProspectIntake({ store, env = {}, fetchImpl = fetch, now = null, limit = 8, dry = false } = {}) {
  await ensureRepoTables(store);
  await ensureListingProspects(store);
  const at = now || nowIso();
  const rows = await qa(store, `SELECT full_name, stars, resources_json FROM ${RC} WHERE resources_json IS NOT NULL ORDER BY stars DESC LIMIT 60`);
  const cands = dedupeProspects(rows.map((r) => ({ full_name: r.full_name, stars: num(r.stars), resources: safe(r.resources_json) })));
  const max = Math.max(0, Math.min(20, num(limit, 8)));
  const out = [];
  let probed = 0;
  for (const c of cands) {
    let status = 0; let signal = 'unprobed'; let can = false; let note = '未確認';
    if (!dry && probed < max) {
      const order = ['api', 'form', 'unknown', 'docs'];
      const pick = c.urls.slice().sort((a, b) => order.indexOf(prospectKind(a)) - order.indexOf(prospectKind(b)))[0] || c.urls[0];
      const r = await probeUrl(pick, fetchImpl);
      status = r.status;
      const cl = classifyProbe(status, r.body);
      signal = cl.signal; can = cl.can_register;
      const sn = sanitizeExternal(r.body || '', { max: 160 });
      note = (can ? '宣言APIがあり登録を試せる（登録は channel_hunt の門を通る）' : '人の1タップが要る')
        + ' / 本文: ' + (sn.risky ? `命令文${sn.hits.length}件を検出し無視` : '命令文なし');
      probed += 1;
    }
    const state = can ? 'auto_ready' : (signal === 'manual_form' ? 'human_required' : 'watch');
    await run(store, `INSERT INTO ${LP} (host,at,urls_json,repos_json,kinds_json,state,probes,http_status,signal,note) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(host) DO UPDATE SET at=excluded.at, urls_json=excluded.urls_json, repos_json=excluded.repos_json, kinds_json=excluded.kinds_json, state=excluded.state, probes=${LP}.probes+1, http_status=excluded.http_status, signal=excluded.signal, note=excluded.note`,
      c.host, at, JSON.stringify(c.urls.slice(0, 4)), JSON.stringify(c.repos.slice(0, 6)), JSON.stringify(c.kinds), state, 1, status, signal, clip(note, 400)).catch(() => {});
    out.push({ host: c.host, urls: c.urls.length, repos: c.repos.length, kinds: c.kinds, state, http_status: status, signal, probed_url: (c.urls.slice().sort((a, b) => ['api', 'form', 'unknown', 'docs'].indexOf(prospectKind(a)) - ['api', 'form', 'unknown', 'docs'].indexOf(prospectKind(b)))[0] || c.urls[0]) });
  }
  return { ok: true, at, hosts: cands.length, probed, dry: !!dry,
    auto_ready: out.filter((o) => o.state === 'auto_ready').length,
    human_required: out.filter((o) => o.state === 'human_required').length,
    items: out.slice(0, 20) };
}

/** 台帳の読み出し。 */
export async function repoProspects(store, { limit = 40 } = {}) {
  await ensureListingProspects(store);
  const rows = await qa(store, `SELECT host,at,urls_json,repos_json,kinds_json,state,probes,http_status,signal,note FROM ${LP} ORDER BY at DESC LIMIT ?`, Math.max(1, Math.min(200, limit)));
  const items = rows.map((r) => ({ host: r.host, at: r.at, urls: safe(r.urls_json), repos: safe(r.repos_json), kinds: safe(r.kinds_json),
    state: r.state, probes: num(r.probes), http_status: num(r.http_status), signal: r.signal, note: clip(r.note, 200) }));
  const counts = {};
  for (const i of items) counts[i.state] = (counts[i.state] || 0) + 1;
  return { ok: true, version: REPO_VERSION, at: items[0] ? items[0].at : null, hosts: items.length, by_state: counts,
    auto_ready: counts.auto_ready || 0, human_required: counts.human_required || 0, items };
}

export function prospectsText(s = {}) {
  const L = [];
  L.push(`出品窓口 ${s.hosts || 0}件（自動で試せる ${s.auto_ready || 0} / 人の1タップ ${s.human_required || 0}）`);
  for (const i of (s.items || [])) L.push(` ${String(i.state).padEnd(15)} ${i.host.padEnd(30)} ${i.signal || '-'} ${i.http_status || 0} ${clip(i.note, 60)}`);
  return L.join('\n');
}
