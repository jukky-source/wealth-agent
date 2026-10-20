// 販路開拓ループ（channel hunt）— hunt-1.0
//
// 問い: 「まだ知らない売り場はどこにあるのか。どうやれば載せられるのか」。
//
// sales.js は「既に知っている11販路」を毎ラウンド診断して打つ。だが販路そのものが
// 増えなければ、売上の天井も固定される。このモジュールは販路を**見つけて増やす**側を担う。
//
// 1ラウンド = 見つける → 見分ける → 載せられる所に載せる → 結果を記録する → 学ぶ
//
//   discover : 既知の索引（CDP / PayAI / agent402 / x402.new / Circle など）が返す
//              中身から、まだ知らないドメインを抽出する（隣人から辿る。検索エンジンは使わない）。
//   classify : 各ドメインの標準の発見面（/.well-known/x402.json, /openapi.json, /llms.txt,
//              /agents.json）を叩き、x402 を喋るか・資源を何本持つか・自分で登録APIを
//              宣言しているかを見分ける。資源を多数並べている＝売り場（索引）、
//              自前の値札を持つ＝売り手、と分類する。
//   register : 「自分で登録APIを宣言している」売り場にだけ、自動で POST する（origin を送る）。
//              宣言の無い売り場＝人手フォーム。フォームのURLを控え、人の1タップ待ちにする。
//   record   : 試行はすべて hunt_trials に残す（送った中身・返ってきた中身・判定）。
//              失敗は指数的に再試行する（30分 → 2時間 → 8時間 → 24時間）。
//   learn    : どの発見源が「載せられる売り場」を生んだかを数え、次ラウンドの探索順を変える。
//
// 原価0の制約:
//   * 読み取り（公開索引の照会・標準パスへの GET/HEAD）と、売り場自身が公開APIとして
//     宣言している登録エンドポイントへの POST だけ。金は1円も使わない。
//   * 人手が要る所（フォーム・本人確認・支払い）は human_only で止め、URLを添えて並べる。
//   * 未知のエンドポイントへ当てずっぽうの POST はしない（宣伝行為になる）。GET/OPTIONS まで。

import { nowIso } from '../util.js';
import { setting, setSetting } from '../db.js';

export const HUNT_VERSION = 'hunt-1.0';
export const HT = 'hunt_trials';
export const HC = 'hunt_channels';
export const HSTATE_KEY = 'hunt:state';
export const SEEN_KEY = 'hunt:seen';

const num = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const hid = () => `hnt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** 自分の受け取り先（入金実績のあるアドレス）。ここが索引に載っているかを見る。 */
export const OWN_PAYTO = '0x3291398dC7070472CF2ED2e757246d089760Ca91';

export const originOf = (env = {}) => String((env && (env.AGENT_ORIGIN || env.PUBLIC_ORIGIN)) || 'https://wealth-agent.wealthagent-app.workers.dev').replace(/\/+$/, '');

export function hostOf(u) { try { return new URL(String(u)).host.toLowerCase(); } catch { return ''; } }
export function keyFor(host) { const h = String(host || '').toLowerCase(); return `hn_${h.replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`; }

/** 売り場ではないドメイン（自分の面・SNS・CDN・ドキュメント・汎用ホスト）は候補から外す。 */
const IGNORE_HOSTS = /(^|\.)(wealthagent-app\.workers\.dev|workers\.dev|github\.com|githubusercontent\.com|twitter\.com|x\.com|t\.co|reddit\.com|discord\.(gg|com)|linkedin\.com|medium\.com|youtube\.com|google\.com|cloudflare\.com|npmjs\.com|schema\.org|w3\.org|json-schema\.org|openai\.com|anthropic\.com|replit\.com|vercel\.app|netlify\.app|localhost|127\.0\.0\.1|example\.(com|org)|wikipedia\.org|coingecko\.com|dexscreener\.com|basescan\.org|etherscan\.io|gutenberg\.org|cloudinary\.com|jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|googleapis\.com|gstatic\.com|mozilla\.org|iana\.org|creativecommons\.org|archive\.org)$/i;

/** 自動 POST を許すパスの語（売り場自身が openapi で宣言している場合だけ）。 */
const REGISTER_PATH = /(register|submit|listing|list_service|index|directory|onboard|add[_-]?service|publish)/i;
/** 危険側の語が入っていれば自動 POST しない（アカウント・管理・削除系は人の領域）。 */
const RISKY_PATH = /(admin|delete|remove|user|account|auth|login|token|key|billing|payment|withdraw)/i;

const UA = 'WealthAgent-Hunt/1.0 (+https://wealth-agent.wealthagent-app.workers.dev)';

async function getText(url, ms = 6000, headers = {}) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*', ...headers }, signal: AbortSignal.timeout(ms) });
    const t = await r.text();
    return { status: r.status, text: t.slice(0, 200000), ct: r.headers.get('content-type') || '' };
  } catch (e) {
    return { status: 0, text: '', error: String((e && e.message) || e).slice(0, 120) };
  }
}

async function postJson(url, body, ms = 8000) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch { /* 非JSONはそのまま */ }
    return { status: r.status, text: t.slice(0, 4000), json: j };
  } catch (e) {
    return { status: 0, text: '', json: null, error: String((e && e.message) || e).slice(0, 120) };
  }
}

/** 本文から URL を拾ってホストごとに数える。形が分からない API でも隣人を辿れる。 */
export function collectHosts(text, cap = 400) {
  const out = {};
  const re = /https?:\/\/[^\s"'<>\\)\]\}]+/g;
  let m; let n = 0;
  while ((m = re.exec(String(text || ''))) !== null && n < cap) {
    n++;
    const h = hostOf(m[0].replace(/[.,;:]+$/, ''));
    if (!h || IGNORE_HOSTS.test(h)) continue;
    out[h] = (out[h] || 0) + 1;
  }
  return out;
}

/** この本文の中に、自分が何回現れているか（0 と「未掲載」を取り違えないための実数）。 */
export function countOwn(text, origin = originOf({}), payTo = OWN_PAYTO) {
  const t = String(text || '').toLowerCase();
  let n = 0;
  const oh = hostOf(origin);
  if (oh) n += t.split(oh).length - 1;
  if (payTo) n += t.split(String(payTo).toLowerCase()).length - 1;
  return n;
}

/** この本文の中に、自分の面（origin のホスト or 受け取り先アドレス）が現れているか。 */
export function listedIn(text, origin = originOf({}), payTo = OWN_PAYTO) {
  const t = String(text || '').toLowerCase();
  const oh = hostOf(origin);
  if (oh && t.includes(oh)) return true;
  if (payTo && t.includes(String(payTo).toLowerCase())) return true;
  return false;
}

/** 再試行の間隔（失敗するほど伸ばす）。1回目30分 → 2時間 → 8時間 → 24時間で頭打ち。 */
/** 宣言されたスキーマから、送る中身を組む。埋められない必須項目があれば「人の領域」として止める。 */
export function bodyFor(required = [], props = [], origin = '') {
  const vals = {
    origin, url: origin, homepage: origin, endpoint: origin, website: origin, api_url: origin, base_url: origin, server_url: origin,
    name: 'Wealth Agent', title: 'Wealth Agent', display_name: 'Wealth Agent', slug: 'wealth-agent',
    description: 'Autonomous x402 agent. 9 paid HTTP-402 routes: diff, regex, csv-json, url-meta, data-clean, brief, code-review, surface-report, rea-report.',
    summary: 'Autonomous x402 agent with 9 paid routes.',
    type: 'api', kind: 'api', category: 'ai', protocol: 'x402', payment_protocol: 'x402',
    currency: 'USDC', network: 'eip155:8453', chain: 'base', version: '2.1.0',
    resources: ['/api/x402/diff', '/api/x402/regex'], tags: ['x402', 'agents', 'api'],
  };
  const keys = Array.from(new Set([...(props || []), ...(required || [])].map(String)));
  const body = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(vals, k)) body[k] = vals[k];
  const missing = (required || []).map(String).filter((k) => !(k in body));
  return { body, missing };
}

export function retryDelayMs(attempts) {
  const a = Math.max(1, Math.min(6, Math.round(num(attempts, 1))));
  const table = [30 * 60e3, 2 * 3600e3, 8 * 3600e3, 24 * 3600e3, 24 * 3600e3, 24 * 3600e3];
  return table[a - 1];
}

export function nextRetryAt(attempts, atMs = Date.now()) {
  return new Date(atMs + retryDelayMs(attempts)).toISOString();
}

/** その売り場が「自分で登録APIを宣言しているか」を openapi から読む。宣言が根拠。 */
export function declaredRegistrations(openapiJson, origin = '') {
  const out = [];
  try {
    const paths = (openapiJson && openapiJson.paths) || {};
    for (const p of Object.keys(paths)) {
      if (!REGISTER_PATH.test(p) || RISKY_PATH.test(p)) continue;
      const item = paths[p] || {};
      const methods = ['post', 'put'].filter((mm) => item[mm]);
      if (!methods.length) continue;
      const op = item.post || item.put || {};
      const sch = (((op.requestBody || {}).content || {})['application/json'] || {}).schema || {};
      const required = Array.isArray(sch.required) ? sch.required.map(String).slice(0, 12) : [];
      const props = Object.keys(sch.properties || {}).slice(0, 20);
      out.push({ path: p, method: 'POST', url: origin ? `${origin}${p}` : p, summary: String(op.summary || '').slice(0, 120), required, props });
    }
  } catch { /* 宣言が読めなければ空 */ }
  return out.slice(0, 4);
}

/** 未知ドメインの標準発見面を叩いて、売り場か売り手かを見分ける。 */
export async function probeHost(host, { ms = 5000 } = {}) {
  const base = `https://${host}`;
  const paths = ['/.well-known/x402.json', '/openapi.json', '/llms.txt', '/agents.json', '/.well-known/agent.json'];
  const faces = {};
  let speaksX402 = false;
  let resources = 0;
  let declared = [];
  const bodies = [];
  for (const p of paths) {
    const r = await getText(base + p, ms);
    faces[p] = r.status;
    if (r.status !== 200 || !r.text) continue;
    bodies.push(r.text.slice(0, 40000));
    if (/x402|accepts|maxAmountRequired|payment-signature/i.test(r.text)) speaksX402 = true;
    const hosts = collectHosts(r.text, 200);
    resources += Object.keys(hosts).length;
    if (p === '/openapi.json' && !declared.length) {
      try { declared = declaredRegistrations(JSON.parse(r.text), base); } catch { /* 非JSONは宣言なし */ }
    }
  }
  const blob = bodies.join('\n');
  const listed_here = listedIn(blob) ? 1 : 0;
  const reachable = Object.values(faces).some((s) => s === 200);
  const looks = !reachable ? 'unreachable' : (resources >= 5 && speaksX402 ? 'directory' : (speaksX402 ? 'seller' : (resources >= 5 ? 'hub' : 'unknown')));
  return { host, origin: base, faces, speaks_x402: speaksX402, neighbors: resources, declared, listed_here, looks, reachable };
}

// ---------------------------------------------------------------------------
// 探索源（既知の索引）。「自分が載っているか」と「まだ知らない隣人」を同時に取る。
// ---------------------------------------------------------------------------

export const SEEDS = [
  { key: 'agent402', label: 'agent402.tools（x402 サービス索引）', feed: 'https://agent402.tools/api/route?q=api', own_url: 'https://agent402.tools/api/route?q=wealthagent', own_authority: 'search', submit_url: 'https://agent402.tools/', machine: true, note: '登録APIを公開（POST /api/index/register）。連続実行は429になるため間隔を空ける。' },
  { key: 'payai', label: 'PayAI Bazaar（facilitator 索引）', feed: 'https://facilitator.payai.network/discovery/resources?limit=100', own_url: 'https://facilitator.payai.network/discovery/resources?limit=100&payTo={payTo}', own_authority: 'list', submit_url: null, machine: true, note: '決済そのものが掲載の引き金。登録フォームは無い。' },
  { key: 'cdp', label: 'CDP Bazaar（Coinbase 公式索引）', feed: 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100', own_url: 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100&payTo={payTo}', own_authority: 'search', submit_url: null, machine: true, note: '決済で索引が発火する。' },
  { key: 'x402new', label: 'x402.new（ディレクトリ）', feed: 'https://x402.new/api/services?limit=100', own_url: 'https://x402.new/api/services?q=wealthagent', own_authority: 'search', submit_url: 'https://x402.new/submit', machine: false, note: '提出はフォーム（人の1タップ）。' },
  { key: 'circle', label: 'Circle x402 ディスカバリ', feed: 'https://api.circle.com/v1/x402/discovery/resources?limit=200', own_url: 'https://api.circle.com/v1/x402/discovery/resources?limit=200&payTo={payTo}', own_authority: 'list', submit_url: null, machine: true, note: '決済連動。同期に遅延がある。' },
  { key: 'sentinel', label: 'Sentinel agents directory', feed: 'https://sentinel.rootstuff.io/agents/directory.json', own_url: 'https://sentinel.rootstuff.io/agents/directory.json', own_authority: 'list', submit_url: 'https://sentinel.rootstuff.io/contact', machine: false, note: '審査制。問い合わせは人の1タップ。' },
  { key: 'mcpreg', label: '公式 MCP レジストリ', feed: 'https://registry.modelcontextprotocol.io/v0/servers?search=x402', submit_url: 'https://registry.modelcontextprotocol.io/', machine: false, note: 'Cloudflare からは到達できないことがある（未測定を未測定と出す）。' },
  { key: 'payapi', label: 'PayAPI Market', feed: 'https://payapi.market/api/services?limit=100', submit_url: 'https://payapi.market/list', machine: false, note: '提出はフォーム。取り分100%。' },
  { key: 'agentshare', label: 'AgentShare registry', feed: 'https://agentshare.dev/registry', submit_url: 'https://agentshare.dev/', machine: false, note: '' },
  { key: 'apiosk', label: 'Apiosk agents', feed: 'https://apiosk.com/agents/', submit_url: 'https://apiosk.com/agents/', machine: false, note: 'アカウント必須の可能性。' },
];

async function q1(store, sql, ...params) {
  try { const r = await store.first(sql, ...params); return r || null; } catch { return null; }
}

export async function ensureHuntTables(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${HC} (key TEXT PRIMARY KEY, at TEXT, origin TEXT, host TEXT, label TEXT, kind TEXT, status TEXT, listed INTEGER, cost REAL, autonomy TEXT, submit_url TEXT, evidence_json TEXT, note TEXT, attempts INTEGER, retry_at TEXT, active INTEGER, updated_at TEXT)`).catch(() => {});
  await store.run(`CREATE TABLE IF NOT EXISTS ${HT} (id TEXT PRIMARY KEY, at TEXT, key TEXT, host TEXT, action TEXT, level TEXT, outcome TEXT, request_json TEXT, result_json TEXT, note TEXT, attempts INTEGER, retry_at TEXT)`).catch(() => {});
}

async function loadChannels(store) {
  const rows = await store.all(`SELECT * FROM ${HC} WHERE COALESCE(active,1)=1 ORDER BY updated_at DESC`).catch(() => []);
  return rows || [];
}

async function upsertChannel(store, c) {
  const at = c.at || nowIso();
  const cur = await q1(store, `SELECT key FROM ${HC} WHERE key=?`, c.key);
  if (cur) {
    await store.run(
      `UPDATE ${HC} SET updated_at=?, status=COALESCE(?,status), listed=COALESCE(?,listed), label=COALESCE(?,label), kind=COALESCE(?,kind), submit_url=COALESCE(?,submit_url), evidence_json=COALESCE(?,evidence_json), note=COALESCE(?,note) WHERE key=?`,
      at, c.status || null, (c.listed === 0 || c.listed === 1) ? c.listed : null, c.label || null, c.kind || null, c.submit_url || null,
      c.evidence ? JSON.stringify(c.evidence) : null, c.note || null, c.key,
    ).catch(() => {});
    return 'updated';
  }
  await store.run(
    `INSERT INTO ${HC} (key,at,origin,host,label,kind,status,listed,cost,autonomy,submit_url,evidence_json,note,attempts,retry_at,active,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    c.key, at, c.origin || '', c.host || '', c.label || c.host || '', c.kind || '未知', c.status || 'new', num(c.listed, 0), 0, c.autonomy || 'approve',
    c.submit_url || null, c.evidence ? JSON.stringify(c.evidence) : null, c.note || null, 0, null, 1, at,
  ).catch(() => {});
  return 'inserted';
}

async function recordTrial(store, t) {
  const rec = {
    id: t.id || hid(), at: t.at || nowIso(), key: t.key || '', host: t.host || '', action: t.action || '',
    level: t.level || 'allow', outcome: t.outcome || 'pending', request_json: t.request ? JSON.stringify(t.request) : null,
    result_json: t.result ? JSON.stringify(t.result).slice(0, 4000) : null, note: String(t.note || '').slice(0, 400),
    attempts: num(t.attempts, 1), retry_at: t.retry_at || null,
  };
  await store.run(
    `INSERT INTO ${HT} (id,at,key,host,action,level,outcome,request_json,result_json,note,attempts,retry_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    rec.id, rec.at, rec.key, rec.host, rec.action, rec.level, rec.outcome, rec.request_json, rec.result_json, rec.note, rec.attempts, rec.retry_at,
  ).catch(() => {});
  return rec;
}

// ---------------------------------------------------------------------------
// 1ラウンド
// ---------------------------------------------------------------------------

/**
 * 見つける: 既知の索引を読み、まだ知らない隣人を抽出する。
 * 「検索エンジンで探す」のではなく「索引に載っている他の売り手が、どこに載っているか」を辿る。
 */
export async function discover(store, env = {}, { now = null } = {}) {
  await ensureHuntTables(store);
  const origin = originOf(env);
  const payTo = env.X402_PAY_TO || env.PAY_TO_ADDRESS || OWN_PAYTO;
  const state = await loadState(store);
  const seeds = [];
  const hosts = {};
  const listed = {};
  for (const s of SEEDS) {
    const tmpl = (u) => String(u || '').replace('{payTo}', payTo).replace('{origin}', origin).replace('{host}', hostOf(origin));
    // 自分の出現は「全体を覆う読み方」（全件一覧・payTo 絞り込み）で測る。
    const own = await getText(s.own_url ? tmpl(s.own_url) : s.feed, 8000);
    const nb = s.own_url ? await getText(s.feed, 8000) : own;
    const ownN = countOwn(own.text, origin, payTo);
    const isListed = own.status === 200 && listedIn(own.text, origin, payTo);
    // 0 件でも、その読み方が全体を覆っていなければ「未掲載」とは書かない（部分照会で実在を見落とす実例がある）。
    const auth = s.own_authority || 'unknown';
    const status = isListed ? 'listed' : (own.status !== 200 ? 'unmeasured' : (auth === 'list' ? 'absent' : 'unconfirmed'));
    listed[s.key] = isListed ? 1 : 0;
    const h = collectHosts(nb.text, 300);
    for (const [k, v] of Object.entries(h)) hosts[k] = (hosts[k] || 0) + v;
    seeds.push({ key: s.key, label: s.label, status, http: own.status, listed: isListed ? 1 : 0, own_n: ownN, authority: auth, hosts_seen: Object.keys(h).length, submit_url: s.submit_url || null, machine: !!s.machine, note: s.note || '' });
    if (s.key === 'agent402') await new Promise((res) => setTimeout(res, 3000)); // 連続実行で429になる
  }
  // 出現回数の多い順（複数の索引に載っているドメイン＝本物の売り場である確率が高い）。
  const cands = Object.entries(hosts)
    .filter(([h]) => h && !IGNORE_HOSTS.test(h) && hostOf(origin) !== h)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([host, n]) => ({ host, seen: n, sources: [] }));
  await setSetting(store, 'hunt:discover_at', now || nowIso()).catch(() => {});
  return { at: now || nowIso(), seeds, candidates: cands, hosts_seen: Object.keys(hosts).length, origin, pay_to: payTo };
}

/** 見分ける: 候補ドメインの発見面を叩き、売り場／売り手／未到達に分類する。 */
export async function classify(cands = [], { cap = 8 } = {}) {
  const out = [];
  for (const c of cands.slice(0, cap)) {
    const p = await probeHost(c.host);
    out.push({ ...c, ...p, key: keyFor(c.host), label: `${c.host}${p.looks === 'directory' ? '（売り場の疑い）' : ''}`, kind: p.looks === 'directory' ? '発見・索引' : (p.looks === 'seller' ? '発見・売り手' : '未知') });
  }
  return out;
}

/** 自動 POST してよいか。売り場自身が openapi で宣言した登録先だけを許す。 */
export function autoPostAllowed(found, env = {}, lastPostAt = null) {
  if (!found || !found.reachable) return { ok: false, why: 'unreachable' };
  if (found.looks !== 'directory' && found.looks !== 'hub') return { ok: false, why: `looks=${found.looks}（売り場でない）` };
  if (env.HUNT_AUTO_POST === 'false') return { ok: false, why: 'disabled' };
  const d = (found.declared || []).find((x) => REGISTER_PATH.test(x.path) && !RISKY_PATH.test(x.path));
  if (!d) return { ok: false, why: '登録APIの宣言なし（人手フォーム）' };
  if (lastPostAt && (Date.now() - new Date(lastPostAt).getTime()) < 24 * 3600e3) return { ok: false, why: '24時間内に送信済み' };
  return { ok: true, endpoint: d };
}

/**
 * 1ラウンド = 見つける → 見分ける → 載せる → 記録する → 学ぶ。
 * 重い探索（見つける）は毎回やらず、見つけた候補を順に消化していく。
 */
export async function huntRound({ store, env = {}, n = 3, now = null, dry = false, discoverNow = false } = {}) {
  await ensureHuntTables(store);
  const at = now || nowIso();
  const state = await loadState(store);
  const everyMin = Math.max(30, Number(env.HUNT_DISCOVER_EVERY_MINUTES || 180));
  const lastDisc = await setting(store, 'hunt:discover_at', null).catch(() => null);
  const discDue = discoverNow || !lastDisc || (Date.now() - new Date(String(lastDisc)).getTime() >= everyMin * 60e3);

  let found = { seeds: [], candidates: [], hosts_seen: 0 };
  if (discDue && !dry) found = await discover(store, env, { now: at }).catch(() => found);
  const seeds = found.seeds && found.seeds.length ? found.seeds : (state.last && state.last.seeds) || [];

  // 既知の売り場の「載っているか」を更新（seed は毎回測る）
  const seedRows = [];
  for (const s of seeds) {
    seedRows.push({ key: `seed_${s.key}`, host: hostOf(s.submit_url || '') || s.key, label: s.label, kind: '既知・索引', status: s.status || (s.listed ? 'listed' : 'absent'), listed: s.listed, autonomy: s.machine ? 'full' : 'human_only', submit_url: s.submit_url, evidence: { http: s.http, own_n: s.own_n, authority: s.authority, hosts_seen: s.hosts_seen }, note: s.note });
  }
  if (!dry) for (const r of seedRows) await upsertChannel(store, { ...r, at });

  // 候補: 既知チャンネルに無いものだけを見分ける
  const existing = await loadChannels(store);
  for (const r of existing) {
    if (r.key && r.key.startsWith('hn_') && IGNORE_HOSTS.test(String(r.host || ''))) {
      await store.run(`UPDATE ${HC} SET active=0, note=?, updated_at=? WHERE key=?`, 'ノイズ（索引が資源URLとして参照していただけ）', at, r.key).catch(() => {});
    }
  }
  const have = new Set(existing.filter((r) => num(r.active, 1) === 1).map((r) => r.key));
  const fresh = (found.candidates || []).filter((c) => !have.has(keyFor(c.host))).slice(0, 12);
  const dueRows = existing.filter((r) => r.key.startsWith('hn_') && (!r.retry_at || new Date(r.retry_at).getTime() <= Date.now()));
  const probeTargets = fresh.length ? fresh : dueRows.slice(0, 6).map((r) => ({ host: r.host, seen: 0, sources: [] }));
  const seenNow = dry ? [] : await classify(probeTargets, { cap: Math.max(1, Math.min(6, Number(n) + 3)) });
  for (const f of seenNow) {
    await upsertChannel(store, {
      key: f.key, at, origin: f.origin, host: f.host, label: f.label, kind: f.kind, status: !f.reachable ? 'unreachable' : (f.listed_here ? 'listed' : 'absent'),
      listed: f.listed_here, autonomy: f.declared && f.declared.length ? 'full' : 'human_only',
      submit_url: f.declared && f.declared.length ? f.declared[0].url : null,
      evidence: { looks: f.looks, faces: f.faces, speaks_x402: f.speaks_x402, neighbors: f.neighbors, declared: f.declared, seen_in: f.sources, seen_count: f.seen }, note: '',
    });
  }

  // 消化: 載っていない売り場に載せに行く。宣言が無ければ人の1タップ待ちに並べる。
  const all = await loadChannels(store);
  const pending = all.filter((r) => r.key.startsWith('hn_') && r.status !== 'listed')
    .filter((r) => !r.retry_at || new Date(r.retry_at).getTime() <= Date.now())
    .slice(0, Math.max(1, Math.min(6, Number(n) || 3)));
  const actions = [];
  const lessons = { auto_posted: 0, human_form: 0, already_listed: 0, unreachable: 0, spoke_x402: 0, directories: 0 };
  for (const r of pending) {
    let ev = {}; try { ev = JSON.parse(r.evidence_json || '{}'); } catch { ev = {}; }
    const found2 = { host: r.host, origin: r.origin, reachable: !!ev.looks && ev.looks !== 'unreachable', looks: ev.looks, declared: ev.declared || [] };
    // 宣言は知っているが中身（必須項目）を知らない場合、送る直前に一度だけ取り直す。自己修正。
    if (!dry && (!found2.declared.length || found2.declared.every((d) => !d.props && !d.required))) {
      const f2 = await probeHost(r.host, { ms: 4000 }).catch(() => null);
      if (f2 && f2.declared && f2.declared.length) {
        found2.declared = f2.declared;
        ev = { ...ev, declared: f2.declared, looks: f2.looks || ev.looks, faces: f2.faces || ev.faces, speaks_x402: !!f2.speaks_x402, neighbors: num(f2.neighbors, ev.neighbors || 0) };
        await store.run(`UPDATE ${HC} SET evidence_json=?, updated_at=? WHERE key=?`, JSON.stringify(ev), at, r.key).catch(() => {});
      }
    }
    if (ev.speaks_x402) lessons.spoke_x402++;
    if (ev.looks === 'directory') lessons.directories++;
    if (!found2.reachable) {
      lessons.unreachable++;
      const tr = await recordTrial(store, { at, key: r.key, host: r.host, action: 'probe', level: 'allow', outcome: 'fail', request: { faces: ev.faces || {} }, result: { step: '再到達不可' }, note: '発見面に到達できない（未測定のまま保持）', attempts: num(r.attempts, 0) + 1, retry_at: nextRetryAt(num(r.attempts, 0) + 2) });
      await store.run(`UPDATE ${HC} SET attempts=?, retry_at=?, updated_at=? WHERE key=?`, num(r.attempts, 0) + 1, tr.retry_at, at, r.key).catch(() => {});
      actions.push({ key: r.key, host: r.host, action: 'probe', outcome: 'fail', note: tr.note });
      continue;
    }
    const gate = autoPostAllowed(found2, env, ev.last_post_at || null);
    if (gate.ok) {
      const org = originOf(env);
      const built = bodyFor(gate.endpoint.required || [], gate.endpoint.props || [], org);
      if (built.missing.length) {
        // 宣言された必須項目を埋められない＝人の領域。当てずっぽうで送らない。
        const trm = await recordTrial(store, { at, key: r.key, host: r.host, action: 'human_form', level: 'human_only', outcome: 'blocked', request: { url: gate.endpoint.url, missing: built.missing }, result: {}, note: `必須項目 ${built.missing.join('/')} を埋められないため人の1タップ待ち`, attempts: num(r.attempts, 0) + 1, retry_at: nextRetryAt(4) });
        await store.run(`UPDATE ${HC} SET attempts=?, retry_at=?, autonomy=?, submit_url=?, note=?, updated_at=? WHERE key=?`, num(r.attempts, 0) + 1, trm.retry_at, 'human_only', gate.endpoint.url, trm.note, at, r.key).catch(() => {});
        actions.push({ key: r.key, host: r.host, action: 'human_form', outcome: 'blocked', submit_url: gate.endpoint.url, note: trm.note });
        continue;
      }
      const body = Object.keys(built.body).length ? built.body : { origin: org, url: org, name: 'Wealth Agent' };
      let res = dry ? { status: 0, text: '', json: null } : await postJson(gate.endpoint.url, body);
      let okPost = res.status >= 200 && res.status < 300;
      // 400 は「形が違う」。最小の形でもう一度だけ試し、それでも駄目なら記録して次の機会へ回す（試行錯誤）。
      if (!dry && !okPost && res.status === 400) {
        const r2 = await postJson(gate.endpoint.url, { origin: org, url: org });
        if (r2.status >= 200 && r2.status < 300) { res = r2; okPost = true; }
        else if (okPost === false) { res = { status: r2.status, text: (res.text || '') + ' | retry:' + (r2.text || ''), json: null }; }
      }
      lessons.auto_posted++;
      const tr = await recordTrial(store, {
        at, key: r.key, host: r.host, action: 'register', level: 'allow', outcome: okPost ? 'ok' : 'fail',
        request: { url: gate.endpoint.url, method: gate.endpoint.method, body, declared_required: gate.endpoint.required || [] }, result: { status: res.status, body: (res.text || '').slice(0, 600) },
        note: okPost ? `登録APIに送信（HTTP ${res.status}）` : `登録APIが拒否（HTTP ${res.status}）`,
        attempts: num(r.attempts, 0) + 1, retry_at: okPost ? nextRetryAt(3) : nextRetryAt(num(r.attempts, 0) + 2),
      });
      await store.run(`UPDATE ${HC} SET attempts=?, retry_at=?, status=?, autonomy=?, submit_url=?, updated_at=? WHERE key=?`,
        num(r.attempts, 0) + 1, tr.retry_at, okPost ? 'register_sent' : r.status, 'full', gate.endpoint.url, at, r.key).catch(() => {});
      actions.push({ key: r.key, host: r.host, action: 'register', outcome: okPost ? 'ok' : 'fail', http: res.status, endpoint: gate.endpoint.url, note: tr.note });
      continue;
    }
    // 人手が要る: フォームURLを控えて並べる（原価0・人の1タップ）
    const submit = (ev.declared && ev.declared[0] && ev.declared[0].url) || r.submit_url || `https://${r.host}/`;
    lessons.human_form++;
    const tr = await recordTrial(store, {
      at, key: r.key, host: r.host, action: 'human_form', level: 'human_only', outcome: 'blocked',
      request: { submit_url: submit }, result: { why: gate.why }, note: `人の1タップ待ち: ${submit}（${gate.why}）`,
      attempts: num(r.attempts, 0) + 1, retry_at: nextRetryAt(4),
    });
    await store.run(`UPDATE ${HC} SET attempts=?, retry_at=?, autonomy=?, submit_url=?, note=?, updated_at=? WHERE key=?`,
      num(r.attempts, 0) + 1, tr.retry_at, 'human_only', submit, tr.note, at, r.key).catch(() => {});
    actions.push({ key: r.key, host: r.host, action: 'human_form', outcome: 'blocked', submit_url: submit, note: tr.note });
  }

  const st = await loadState(store);
  const rec = {
    id: hid(), at, discovered: { seeds: seeds.length, hosts_seen: found.hosts_seen || 0, candidates: (found.candidates || []).length, classify: seenNow.length },
    seeds, actions, lessons,
    verdict: actions.some((a) => a.outcome === 'ok') ? 'expanded' : (actions.length ? 'pending' : 'idle'),
    note: `${seeds.length} の索引を照会 / 新規候補 ${(found.candidates || []).length} 件を抽出 / 見分けた ${seenNow.length} 件 / 打ち手 ${actions.length} 本（自動送信 ${actions.filter((a) => a.action === 'register' && a.outcome === 'ok').length}・人の1タップ待ち ${actions.filter((a) => a.action === 'human_form').length}）`,
  };
  await setSetting(store, HSTATE_KEY, {
    rounds: num(st.rounds, 0) + 1, last: rec,
    discovery_total: num(st.discovery_total, 0) + ((found.candidates || []).length),
    lessons_total: {
      spoke_x402: num(st.lessons_total && st.lessons_total.spoke_x402, 0) + lessons.spoke_x402,
      directories: num(st.lessons_total && st.lessons_total.directories, 0) + lessons.directories,
      auto_posted: num(st.lessons_total && st.lessons_total.auto_posted, 0) + lessons.auto_posted,
      human_form: num(st.lessons_total && st.lessons_total.human_form, 0) + lessons.human_form,
      unreachable: num(st.lessons_total && st.lessons_total.unreachable, 0) + lessons.unreachable,
    },
    history: [{ at, verdict: rec.verdict, note: rec.note.slice(0, 160) }, ...((st.history || []).slice(0, 11))],
  }).catch(() => {});
  // 監査用の生ログ（sales_rounds と同型の別表は持たず、trials に一本化する）
  return rec;
}

export async function huntTick({ store, env = {}, n = null, now = null } = {}) {
  const want = Number(n) > 0 ? Number(n) : Math.max(1, Math.min(6, Number((env && env.HUNT_ACTIONS_PER_ROUND) || 3)));
  return huntRound({ store, env, n: want, now });
}

async function loadState(store) {
  const raw = await setting(store, HSTATE_KEY, null).catch(() => null);
  if (!raw) return { rounds: 0, last: null, history: [], lessons_total: {}, discovery_total: 0 };
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return { rounds: 0, last: null, history: [], lessons_total: {}, discovery_total: 0 }; }
}

// ---------------------------------------------------------------------------
// sales.js への受け渡し: 見つけた売り場を「販路」として盤面に載せる（自己拡張）
// ---------------------------------------------------------------------------

/**
 * 見つけた売り場を sales.js の販路オブジェクトに変換する。読み取りのみ（ネットワークは measure の中）。
 * これにより、販路ボードは静的な11件から、自分で見つけた分だけ増えていく。
 */
export async function dynamicChannels(store, env = {}) {
  const rows = await loadChannels(store).catch(() => []);
  const targets = (rows || [])
    .filter((r) => r.key && r.key.startsWith('hn_') && r.status !== 'unreachable')
    .slice(0, Math.max(0, Math.min(12, Number((env && env.HUNT_BOARD_MAX) || 8))));
  return targets.map((r) => {
    let ev = {}; try { ev = JSON.parse(r.evidence_json || '{}'); } catch { ev = {}; }
    const origin = r.origin || `https://${r.host}`;
    return {
      key: r.key,
      host: r.host,
      label: `${r.host}（発見）`,
      kind: ev.looks === 'directory' ? '発見・索引' : '発見',
      autonomy: r.autonomy || 'human_only',
      cost: 0,
      external: true,
      what: `販路開拓ループが見つけた外部の面（${ev.looks || '未知'}${ev.speaks_x402 ? ' / x402 を喋る' : ''}）。`,
      walls: {
        listed: { why: 'この売り場に我々が載っていない', fix: '載せられる口を突き止める（宣言があれば自動送信、無ければ人の1タップ）', action: 'hunt_register', level: (r.autonomy === 'full') ? 'allow' : 'human_only' },
        quote: { why: '載っているのに値札が読めていない', fix: '発見面の記述を確かめる', action: 'hunt_probe', level: 'allow' },
        traffic: { why: '載っているのに呼ばれない', fix: '説明・例・出力スキーマを充実させて順位を上げる', action: 'expose_boost', level: 'allow' },
        paid: { why: '呼ばれるが払われない', fix: '決済経路を確かめる', action: 'hunt_probe', level: 'allow' },
        settled: { why: '入金が無い', fix: '買い手が付く露出を増やす', action: 'expose_boost', level: 'allow' },
        repeat: { why: '1件で止まる', fix: '最安の入口を増やす', action: 'expose_boost', level: 'allow' },
      },
      async measure(ctx) {
        const p = await probeHost(r.host, { ms: 4000 }).catch(() => null);
        if (!p) return { listed: 0, quote: 0, traffic: 0, paid: 0, settled: 0, evidence: { host: r.host, error: 'probe_failed' }, notes: [] };
        const listed = p.listed_here ? 1 : (r.status === 'listed' ? 1 : 0);
        const t = ctx && ctx.store ? await ctx.store.first(`SELECT COUNT(*) AS n FROM x402_hits WHERE instr(lower(COALESCE(ua,'')), ?) > 0`, r.host).catch(() => null) : null;
        const hits = (t && num(t.n, 0)) || 0;
        return {
          listed,
          quote: (p.reachable && p.speaks_x402) ? 1 : 0,
          traffic: hits > 0 ? 1 : 0,
          paid: 0,
          settled: 0,
          evidence: { host: r.host, looks: p.looks, faces: p.faces, speaks_x402: p.speaks_x402, neighbors: p.neighbors, declared: p.declared.map((d) => d.path), status_from_hunt: r.status, hits_from_host: hits },
          notes: [`販路開拓ループの発見物（${p.looks}）。送信の履歴: ${r.status}`],
        };
      },
    };
  });
}

export async function huntStatus(store, env = {}) {
  await ensureHuntTables(store);
  const state = await loadState(store);
  const rows = await loadChannels(store);
  const trials = await store.all(`SELECT * FROM ${HT} ORDER BY at DESC LIMIT 40`).catch(() => []);
  const byOutcome = {};
  const all = await store.all(`SELECT outcome, COUNT(*) AS n FROM ${HT} GROUP BY outcome`).catch(() => []);
  for (const r of (all || [])) byOutcome[String(r.outcome)] = num(r.n, 0);
  const discovered = (rows || []).filter((r) => r.key.startsWith('hn_'));
  const humanSteps = discovered.filter((r) => r.autonomy === 'human_only' && r.status !== 'listed').map((r) => ({ host: r.host, submit_url: r.submit_url || `https://${r.host}/`, why: r.note || 'フォーム提出', looks: (safe(r.evidence_json).looks || '') }));
  const seeds = (state.last && state.last.seeds) || [];
  return {
    version: HUNT_VERSION,
    at: nowIso(),
    origin: originOf(env),
    seeds: seeds.map((s) => ({ key: s.key, label: s.label, status: s.status, http: s.http, own_n: s.own_n, authority: s.authority, listed: s.listed, submit_url: s.submit_url, machine: s.machine })),
    discovered: discovered.map((r) => ({ key: r.key, host: r.host, status: r.status, autonomy: r.autonomy, attempts: num(r.attempts, 0), retry_at: r.retry_at, submit_url: r.submit_url, evidence: safe(r.evidence_json) })),
    trials: (trials || []).map((t) => ({ at: t.at, host: t.host, action: t.action, level: t.level, outcome: t.outcome, note: t.note, retry_at: t.retry_at })),
    trials_by_outcome: byOutcome,
    human_steps: humanSteps.slice(0, 12),
    state: { rounds: num(state.rounds, 0), discovery_total: num(state.discovery_total, 0), lessons_total: state.lessons_total || {}, last: state.last ? { at: state.last.at, verdict: state.last.verdict, note: state.last.note } : null, history: (state.history || []).slice(0, 6) },
  };
}

function safe(s) { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } }

export function huntPublic(st = {}) {
  return {
    version: st.version, at: st.at,
    seeds: (st.seeds || []).map((s) => ({ key: s.key, label: s.label, status: s.status, listed: s.listed, machine: s.machine })),
    discovered_n: (st.discovered || []).length,
    discovered: (st.discovered || []).slice(0, 20).map((d) => ({ host: d.host, status: d.status, autonomy: d.autonomy, attempts: d.attempts, looks: (d.evidence && d.evidence.looks) || '', x402: !!(d.evidence && d.evidence.speaks_x402), neighbors: (d.evidence && d.evidence.neighbors) || 0 })),
    trials_by_outcome: st.trials_by_outcome || {},
    human_steps: st.human_steps || [],
    last: (st.state && st.state.last) || null,
    rounds: (st.state && st.state.rounds) || 0,
  };
}

export function huntText(st = {}) {
  const L = [];
  L.push(`販路開拓ループ ${st.version || ''} (${st.at || ''})`);
  L.push(`ラウンド ${num(st.state && st.state.rounds, 0)} / 累計の新規候補 ${num(st.state && st.state.discovery_total, 0)} 件`);
  L.push(`試行の内訳: ${Object.entries(st.trials_by_outcome || {}).map(([k, v]) => `${k}=${v}`).join(' ') || 'なし'}`);
  L.push('');
  L.push('■ 既知の索引（載っているか）');
  const SL = { listed: '掲載', absent: '未掲載', unconfirmed: '未確認（部分照会で出ず）', unmeasured: '未測定（到達不可）' };
  for (const s of (st.seeds || [])) L.push(`- [${SL[s.status] || (s.listed ? '掲載' : '不明')}] ${s.label} … HTTP ${s.http || s.status} / 我々の出現 ${(s.own_n == null ? '?' : s.own_n)} 回${s.machine ? '' : '（提出は人の1タップ）'}`);
  L.push('');
  L.push(`■ 見つけた売り場（${(st.discovered || []).length} 件）`);
  for (const d of (st.discovered || []).slice(0, 12)) L.push(`- ${d.host}: ${d.status} / ${d.autonomy} / 試行${d.attempts}回 / ${(d.evidence && d.evidence.looks) || ''}${d.evidence && d.evidence.speaks_x402 ? ' / x402' : ''}`);
  L.push('');
  L.push(`■ 人の1タップ待ち（${(st.human_steps || []).length} 件）`);
  for (const h of (st.human_steps || []).slice(0, 8)) L.push(`- ${h.submit_url}  (${h.why})`);
  L.push('');
  for (const t of (st.trials || []).slice(0, 8)) L.push(`試行 ${t.at}: ${t.host} ${t.action} → ${t.outcome}${t.retry_at ? ` (次回 ${t.retry_at})` : ''}`);
  return L.join('\n');
}

export function huntHelp() {
  return {
    what: 'まだ知らない売り場を自分で見つけ、載せられる所に載せ、結果を記録して学ぶループ。これが回ると、販路そのものが自動で増える。',
    how: '1ラウンド = 既知の索引を照会して隣人ドメインを抽出する → 標準の発見面を叩いて売り場/売り手を見分ける → 売り場自身が openapi で宣言した登録APIにだけ自動POSTする → 宣言が無ければ人の1タップ待ちに並べる → 失敗は指数的に再試行する（30分→2h→8h→24h）。',
    cost: '原価0。公開索引の照会と標準パスへのGET、売り場が公開APIとして宣言した登録先へのPOSTのみ。金は使わない。未知のエンドポイントへの当てずっぽうなPOSTはしない。',
    endpoints: { status: 'GET /api/hunt', public: 'GET /api/hunt/public', run: 'POST /api/hunt?n=<数>', discover_only: 'POST /api/hunt?discover=1', help: 'GET /api/hunt?help=1' },
    seeds: SEEDS.map((s) => ({ key: s.key, label: s.label, machine: !!s.machine, submit_url: s.submit_url, note: s.note })),
    verdicts: ['expanded（載せる動きが成立）', 'pending（全て人の1タップ待ち）', 'idle（動き無し）'],
  };
}

export const HUNT_SEEDS = SEEDS;
