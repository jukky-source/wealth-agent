// market-1.0 — 市場の真実を測る → 足りない売り物を名指しする → 作れるものは自分で作り、動くまで確かめる。
//
// なぜ要るか（2026-10-20 の人手の実測から）:
//   * 自前ログの「呼び出し6,422・402を6,390回」は索引ボットの巡回で、買い手ではなかった。
//     買い手側の真実は CDP 公式ディスカバリの quality（30日の呼び出し数・ユニーク支払者数）にしか出ない。
//   * 市場の需要は、競合が無料公開している CDP 全カタログの5%サンプル（1,295件）で測れる。
//     支払者の50%・呼び出しの91%が $0.001〜0.005 帯 → 値段は壁ではない。
//   * 値段も発見性も壁ではなかった（我々は "website capability report" 検索で1位、
//     競合 api.kadec0.xyz は我々の8倍の $0.08 で32呼ばれている）。足りないのは
//     「その瞬間に必要とされている品」だけ。だから市場が金を払っているカテゴリを数え、
//     持っていないものを名指しし、既存の実行部品で作れるものは自分で作って自分で確かめる。
//
// 設計の規律:
//   1. 数字には必ず出所を付ける（snapshot / source_url / at）。推定は「推定」と書く。
//   2. 分類は決定的（正規表現）。AI の意見は仮説の側だけに置き、事実の欄には混ぜない。
//   3. 作るのは既存の実行部品（OPS）で賄える品だけ。新しいコードが要る案は仮説として記録し、
//      「完成」とは言わない。作った品は**その場で実際に呼んで**中身が返るまで確かめ、
//      通らなければ掲載を取り消す（トライアンドエラーを自動で回す）。
import { nowIso } from '../util.js';
import { setting, setSetting } from '../db.js';

export const MARKET_VERSION = 'market-1.0';
export const MS = 'market_scans';
export const MH = 'market_hypotheses';
export const MSTATE = 'market:state';
export const EXTRA_KEY = 'x402:extra_catalog';
export const TEASER_URL = 'https://x402-bazaar-rank.x402-bazaar-rank-worker.workers.dev/dataset/teaser';
export const CDP_SEARCH_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search';
export const MARKET_UA = 'WealthAgent-Market/1.0';
export const OWN_HOST = 'wealthagent-app.workers.dev';
/** 仮説として立てる下限（支払者数）。これ未満は「まだ市場が無い」として数えない。 */
export const MIN_PAYERS_FOR_GAP = 10;
export const PRICE = { floor_atomic: 100, entry_atomic: 5000, max_atomic: 10000 };
export const SCAN_EVERY_MINUTES = 120;
/** 自作の品を試し打ちするときの宛先（自分自身＝公開アドレス。秘密ではない）。 */
export const SELFTEST_ADDRESS = '0x3291398dC7070472CF2ED2e757246d089760Ca91';

const num = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const clip = (s, n = 240) => String(s == null ? '' : s).slice(0, n);
const rid = () => `mkt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
// store の読み取りは実装ごとに名前が揺れるので、あるものを使う（無ければ空で返す）。
export const dbFirst = (store, sql, ...p) => q1(store, sql, ...p);
export const dbAll = (store, sql, ...p) => qa(store, sql, ...p);
const unwrap = (r) => (r == null ? null : (Array.isArray(r) ? r : (Array.isArray(r.results) ? r.results : r)));
// 読み取り口の実装差を吸収する。どの口も例外を投げない前提で、当たるまで順に試す。
const q1 = async (store, sql, ...p) => {
  if (!store) return null;
  const tries = [
    () => (typeof store.first === 'function' ? store.first(sql, ...p) : null),
    () => (typeof store.get === 'function' ? store.get(sql, ...p) : null),
    () => (typeof store.prepare === 'function' ? (p.length ? store.prepare(sql).bind(...p) : store.prepare(sql)).first() : null),
    () => (typeof store.query === 'function' ? store.query(sql, ...p) : null),
  ];
  let last = null;
  for (const t of tries) {
    try { const r = unwrap(await t()); if (Array.isArray(r)) { if (r.length) return r[0]; } else if (r != null) return r; } catch { /* 次の口を試す */ }
  }
  return last;
};
const qa = async (store, sql, ...p) => {
  if (!store) return [];
  const tries = [
    () => (typeof store.all === 'function' ? store.all(sql, ...p) : null),
    () => (typeof store.query === 'function' ? store.query(sql, ...p) : null),
    () => (typeof store.prepare === 'function' ? (p.length ? store.prepare(sql).bind(...p) : store.prepare(sql)).all() : null),
    () => (typeof store.first === 'function' ? store.first(sql, ...p) : null),
  ];
  for (const t of tries) {
    try { const r = unwrap(await t()); if (Array.isArray(r) && r.length) return r; } catch { /* 次の口を試す */ }
  }
  return [];
};

/** 市場のカテゴリ。measured_* は 2026-10-20 の5%サンプル実測（そのまま事実として残す）。 */
export const CATS = [
  { key: 'balance', label: '残高・ウォレット照会', re: /(balance|erc[-\s]?20|token[-\s]?hold|allowance|wallet)/i, measured_payers: 321, measured_calls: 329, note: '市場の支払者数1位。原価0で作れる。' },
  { key: 'llm', label: '推論・テキスト生成', re: /(chat\/completions|completions|llm|inference|generate[-\s]?text|embedding|chatbot)/i, measured_payers: 270, measured_calls: 82709, note: '呼び出し数は最大だが我々の原価0制約では提供できない。' },
  { key: 'random', label: '乱数・公平性の証明', re: /(random|rand|drand|nonce|shuffle|lottery|entropy|beacon|dice)/i, measured_payers: 196, measured_calls: 6571, note: 'drand ビーコンで原価0で作れる。' },
  { key: 'market_data', label: '市場データ（足・価格）', re: /(candle|ohlc|ticker|symbols|fx|forex|quote|price|market[-\s]?data)/i, measured_payers: 180, measured_calls: 280 },
  { key: 'security', label: '安全性・脆弱性の検査', re: /(audit|security|vulnerab|malware|phish|sanction|aml|kyc|safety|exploit)/i, measured_payers: 43, measured_calls: 0, note: '人が金を払う枠が残っている。' },
  { key: 'evidence', label: '証跡・来歴・検証', re: /(evidence|provenance|attest|notar|timestamp|receipt|proof|verify|audit[-\s]?trail)/i, measured_payers: 42, measured_calls: 0, note: '人が金を払う枠が残っている。' },
  { key: 'search', label: '検索・索引', re: /(search|lookup|directory|index|discover|catalog|registry)/i },
  { key: 'scrape', label: '取得・抽出', re: /(scrape|crawl|extract|html|metadata|screenshot|render|pdf|dom)/i },
  { key: 'translate', label: '翻訳・言語', re: /(translat|i18n|language|locale)/i },
  { key: 'storage', label: '保管・配布', re: /(storage|upload|ipfs|bucket|blob|file[-\s]?host)/i },
  { key: 'payment', label: '支払い・決済補助', re: /(invoice|checkout|swap|bridge|transfer|payment|pay[-\s]?link)/i },
];
export const catByKey = (k) => CATS.find((c) => c.key === String(k || '')) || null;

/** 既に持っている品（カテゴリ → 我々の品）。ここに無いカテゴリが「隙間」。 */
export const OWNED = {
  balance: 'onchain-balance', random: 'random', evidence: 'surface-report',
  security: 'code-review', scrape: 'url-meta', search: 'brief',
};

/** 自律で作れる品の部品表。既存の実行部品（op）＋固定引数（preset）だけで作れるものだけを並べる。
 *  新しいコードが要る案はここに入れない（＝勝手に「作った」と言わない）。 */
export const OPS = [
  {
    op: 'onchain-balance', category: 'balance', slug: 'base-usdc-balance', label_ja: 'Base の USDC 残高照会', price_atomic: 3000,
    preset: { chain: 'base', tokens: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'] },
    desc: 'Base の任意アドレスの USDC（0x8335…2913）残高を、コントラクトの decimals ごと実測して返す。ブロック高・RPC 経路・読めなかったものの errors 付き。市場で支払者数が最多のカテゴリ。',
  },
  {
    op: 'onchain-balance', category: 'balance', slug: 'eth-usdc-balance', label_ja: 'Ethereum の USDC 残高照会', price_atomic: 3000,
    preset: { chain: 'ethereum', tokens: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'] },
    desc: 'Ethereum の任意アドレスの USDC（0xA0b8…eB48）残高を、コントラクトの decimals ごと実測して返す。ブロック高付き。',
  },
  {
    op: 'random', category: 'random', slug: 'drand-1d100', label_ja: '検証可能な乱数（1〜100）', price_atomic: 3000,
    preset: { n: 1, min: 1, max: 100 },
    desc: 'drand League of Entropy のビーコンから導出した検証可能な乱数（1〜100）。ラウンド・乱数・BLS 署名を返すので第三者が再計算して検算できる。ビーコンに届かなければ乱数を発行しない。',
  },
];
export const opBySlug = (slug) => OPS.find((o) => o.slug === String(slug || '').trim()) || null;

// ------------------------------------------------------------------ 測る（決定的）

export function classify(text = '') {
  const s = String(text || '');
  for (const c of CATS) if (c.re.test(s)) return c.key;
  return 'other';
}

export const BANDS = [[0, 0.001], [0.001, 0.005], [0.005, 0.01], [0.01, 0.05], [0.05, 0.5], [0.5, Infinity]];
export function bandOf(usd) {
  const p = num(usd, 0);
  const b = BANDS.find(([lo, hi]) => p >= lo && p < hi);
  return b ? (b[1] === Infinity ? `>${b[0]}` : `${b[0]}-${b[1]}`) : 'other';
}

/**
 * 5%サンプル（services）を決定的に集計する。
 * u=resource URL / n=name / d=desc / p=price USD / c=calls30d / y=unique paying wallets30d / r=demand rank
 * 収益は「推定」であることが分かるよう revenue_est_usd と名付ける（実測ではない）。
 */
export function summarizeSample(services = [], { snapshot = null, count = null, sample = null } = {}) {
  const seen = new Map();
  const cats = new Map((CATS.map((c) => [c.key, { key: c.key, label: c.label, n: 0, payers: 0, calls: 0, revenue_est_usd: 0, prices: [], top: [] }])).concat([['other', { key: 'other', label: 'その他', n: 0, payers: 0, calls: 0, revenue_est_usd: 0, prices: [], top: [] }]]));
  const bands = new Map();
  let totalCalls = 0; let totalPayers = 0; const ge = { 1: 0, 2: 0, 3: 0, 5: 0 };
  for (const s of Array.isArray(services) ? services : []) {
    if (!s || typeof s !== 'object') continue;
    const url = String(s.u || '');
    if (url && seen.has(url)) continue;          // 同じ資源の重複は数えない
    if (url) seen.set(url, 1);
    const price = Number.isFinite(Number(s.p)) ? Number(s.p) : null;
    const calls = num(s.c, 0); const payers = num(s.y, 0);
    totalCalls += calls; totalPayers += payers;
    for (const k of [1, 2, 3, 5]) if (payers >= k) ge[k] += 1;
    const key = classify([s.n, s.d, s.u, Array.isArray(s.t) ? s.t.join(' ') : s.t].filter(Boolean).join(' '));
    const row = cats.get(key) || cats.get('other');
    row.n += 1; row.payers += payers; row.calls += calls;
    if (price != null) { row.prices.push(price); row.revenue_est_usd += price * calls; }
    const bkey = bandOf(price == null ? -1 : price);
    const b = bands.get(bkey) || { band: bkey, n: 0, payers: 0, calls: 0 };
    b.n += 1; b.payers += payers; b.calls += calls; bands.set(bkey, b);
    if (url) { row.top.push({ u: url, p: price, c: calls, y: payers, d: clip(s.d, 90) }); row.top.sort((a, b2) => b2.y - a.y || b2.c - a.c); if (row.top.length > 5) row.top.length = 5; }
  }
  const byCategory = [...cats.values()].map((r) => ({
    ...r,
    revenue_est_usd: Number(r.revenue_est_usd.toFixed(4)),
    median_price_usd: r.prices.length ? Number([...r.prices].sort((a, b) => a - b)[Math.floor(r.prices.length / 2)].toFixed(6)) : null,
    prices: undefined,
  })).sort((a, b) => b.payers - a.payers || b.calls - a.calls);
  return {
    snapshot, count: count == null ? (Array.isArray(services) ? services.length : 0) : count,
    sample: sample || null, services: Array.isArray(services) ? services.length : 0, unique_resources: seen.size,
    total_calls: totalCalls, total_payers: totalPayers, payers_ge: ge,
    by_category: byCategory,
    bands: [...bands.values()].sort((a, b) => String(a.band).localeCompare(String(b.band))),
    source_url: TEASER_URL,
    note: 'CDP 全カタログの5%サンプル（競合が無料公開している teaser）。呼び出し数は買い手の実測だが、収益は価格×呼び出しの推定で、実測ではない。',
  };
}

/** 市場が金を払っているのに我々が持っていないカテゴリ＝隙間。作れるかどうかも添える。 */
export function gapsOf(summary = {}, { ours = OWNED, launched = [] } = {}) {
  const out = [];
  const byKey = new Map((summary.by_category || []).map((c) => [c.key, c]));
  const push = (cat, buildable, note) => {
    const c = byKey.get(cat) || { key: cat, label: (catByKey(cat) || {}).label || cat, payers: 0, calls: 0 };
    if (num(c.payers, 0) < MIN_PAYERS_FOR_GAP) return;
    out.push({
      category: cat, label: c.label, payers: num(c.payers, 0), calls: num(c.calls, 0),
      revenue_est_usd: c.revenue_est_usd || 0, median_price_usd: c.median_price_usd == null ? null : c.median_price_usd,
      have_generic: ours[cat] || null, buildable, note,
    });
  };
  // ① 持っていないカテゴリ
  for (const c of summary.by_category || []) {
    if (c.key === 'other' || ours[c.key]) continue;
    push(c.key, OPS.filter((o) => o.category === c.key && !launched.includes(o.slug)).map((o) => ({ slug: o.slug, op: o.op, price_atomic: o.price_atomic })), '我々は未提供');
  }
  // ② 持ってはいるが、市場が実際に買っている「形」が違うカテゴリ。
  //    汎用品1つでカテゴリを押さえた気にならない（市場の1位は単機能のプリセット品）。
  for (const cat of new Set(OPS.map((o) => o.category))) {
    if (out.some((g) => g.category === cat)) continue;
    const b = OPS.filter((o) => o.category === cat && !launched.includes(o.slug)).map((o) => ({ slug: o.slug, op: o.op, price_atomic: o.price_atomic }));
    if (!b.length) continue;
    push(cat, b, ours[cat] ? `汎用品(${ours[cat]})はあるが、市場が買っている単機能の形は出していない` : '我々は未提供');
  }
  return out.sort((a, b) => b.payers - a.payers);
}

/** 隙間から仮説（作る候補）を立てる。AI が使えるときは AI の案を混ぜるが、部品表の外は捨てる。 */
export function hypothesesFrom(gaps = [], { ai = null, max = 6 } = {}) {
  const out = [];
  for (const g of gaps) {
    for (const b of g.buildable || []) {
      if (out.length >= max) break;
      out.push({
        id: rid(), slug: b.slug, category: g.category, op: b.op, price_atomic: b.price_atomic, source: 'deterministic',
        why: `${g.label}: 市場の支払者 ${g.payers}人 / 呼び出し ${g.calls}回 / 価格中央値 ${g.median_price_usd == null ? '不明' : `$${g.median_price_usd}`}。我々は未提供。`,
        score: num(g.payers, 0),
      });
    }
  }
  const seen = new Set(out.map((h) => h.slug));
  for (const idea of Array.isArray(ai) ? ai : []) {
    const op = opBySlug(idea && idea.slug);
    if (!op || seen.has(op.slug) || out.length >= max) continue;
    seen.add(op.slug);
    out.push({
      id: rid(), slug: op.slug, category: op.category, op: op.op,
      price_atomic: Math.min(PRICE.max_atomic, Math.max(PRICE.floor_atomic, num(idea.price_atomic, op.price_atomic))),
      source: 'ai', why: clip(idea.why, 300) || 'AI の提案（部品表に一致するものだけ採用）',
      score: num(idea.confidence, 0.5) * 100,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

// ------------------------------------------------------------------ 作る（部品表の範囲で）

/** 仮説 → カタログ1件。既に同じ品・同じ固定引数があれば作らない（冪等）。 */
export function materialize(hyp = {}, { existing = [] } = {}) {
  const op = opBySlug(hyp.slug) || OPS.find((o) => o.op === hyp.op && o.category === hyp.category);
  if (!op) return { ok: false, reason: 'no_buildable_op', slug: hyp.slug || null };
  const list = Array.isArray(existing) ? existing.filter(Boolean) : [];
  if (list.some((i) => i.resource === op.slug)) return { ok: false, reason: 'already_listed', slug: op.slug };
  if (list.some((i) => i.op === op.op && JSON.stringify(i.preset || {}) === JSON.stringify(op.preset))) return { ok: false, reason: 'duplicate_preset', slug: op.slug };
  const price = Math.min(PRICE.max_atomic, Math.max(PRICE.floor_atomic, num(hyp.price_atomic, op.price_atomic)));
  return {
    ok: true,
    item: {
      resource: op.slug, op: op.op, preset: op.preset, description: clip(op.desc, 460), label_ja: op.label_ja,
      unit: 'call', free_tier: false, price_usdc: price, created_by: MARKET_VERSION, created_at: nowIso(),
      why: clip(hyp.why, 300), source: hyp.source || 'deterministic',
    },
  };
}

/** 新しい品を、その場で実際に呼んで確かめる（原価0・中身が返るまで掲載しない）。
 *  決済は挟めないので「決済済みの入力で中身が組み立てられるか」を見る＝納品不能を掲載前に潰す。 */
export async function verifyProduct(item, { deps = {} } = {}) {
  const sample = item.op === 'onchain-balance' ? { address: SELFTEST_ADDRESS }
    : item.op === 'random' ? {} : {};
  const input = { ...sample, ...(item.preset || {}) };
  try {
    const { validateOrder, fulfillOrder } = await import('./fulfill.js');
    const v = validateOrder(item.op, input);
    if (!v || v.ok === false) return { ok: false, step: 'validate', detail: clip(JSON.stringify(v), 240) };
    const r = await fulfillOrder(item.op, input, deps);
    if (!r || r.ok !== true) return { ok: false, step: 'fulfill', detail: clip(JSON.stringify(r), 240) };
    const d = (r.deliverable && r.deliverable.deliverable) || r.deliverable || {};
    // 「中身が返った」= 実データの入った配列が少なくとも1つある。項目名の揺れでは判定しない。
    const arr = Object.values(d).filter((v) => Array.isArray(v));
    const filled = arr.filter((a) => a.length > 0);
    const real = filled.length > 0 && (item.op !== 'onchain-balance' || (d.chain && d.block));
    if (!real) return { ok: false, step: 'empty', detail: clip(JSON.stringify({ summary: d.summary || null, notes: d.note || null, errors: d.errors || null, arrays: Object.fromEntries(Object.entries(d).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])) }), 700) };
    const keys = Object.keys(d).filter((k) => !['kind', 'summary'].includes(k));
    return { ok: true, step: 'verified', detail: clip(JSON.stringify({ summary: d.summary || null, arrays_filled: filled.map((a) => a.length), keys }), 300) };
  } catch (e) {
    return { ok: false, step: 'error', detail: clip(e && e.message, 200) };
  }
}

/** 掲載中の自律生成品（D1 の settings が正）。 */
export async function extraCatalog(store) {
  if (!store) return [];
  try {
    const raw = await setting(store, EXTRA_KEY, null);
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.items)) return raw.items;
    if (typeof raw === 'string' && raw.trim().startsWith('[')) return JSON.parse(raw);
  } catch { /* 壊れていても空で返す（勝手に消さない） */ }
  return [];
}

// ------------------------------------------------------------------ 買い手側から見た自分（真実）

/** CDP 公式ディスカバリの quality = 買い手側から見た我々の実数。取れなければ取れないと書く。 */
export async function ownTruth({ env = {}, deps = {}, fetchImpl = fetch } = {}) {
  const out = { ok: false, source_url: CDP_SEARCH_URL, at: nowIso(), products: [], note: null };
  let token = null;
  try {
    if (deps && typeof deps.cdpBearer === 'function') token = await deps.cdpBearer(env);
    else {
      const m = await import('./cdp-auth.js');
      const f = m.cdpBearer || m.cdpToken || m.bearer || null;
      if (typeof f === 'function') token = await f(env);
    }
  } catch (e) { out.note = `認証の取得に失敗: ${clip(e && e.message, 120)}`; }
  const url = `${CDP_SEARCH_URL}?query=${encodeURIComponent(OWN_HOST)}`;
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': MARKET_UA, ...(token ? { authorization: `Bearer ${token}` } : {}) }, redirect: 'manual' });
    out.http = res.status;
    if (!res.ok) { out.note = `CDP ディスカバリが HTTP ${res.status} を返した`; return out; }
    const body = await res.json().catch(() => null);
    const rows = (body && (body.resources || (body.data && body.data.resources))) || [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const u = String(r.resource || r.url || '');
      if (!u.includes(OWN_HOST)) continue;
      const q = r.quality || {};
      out.products.push({
        resource: u, calls30d: num(q.l30DaysTotalCalls, 0), payers30d: num(q.l30DaysUniquePayers, 0),
        last_called_at: q.lastCalledAt || null, description: clip(r.description, 160),
      });
    }
    out.products.sort((a, b) => b.payers30d - a.payers30d || b.calls30d - a.calls30d);
    out.ok = true;
    out.note = '呼び出し数とユニーク支払者数は CDP の実測（買い手側から見た値）。';
  } catch (e) { out.note = `取得に失敗: ${clip(e && e.message, 160)}`; }
  return out;
}

/** 我々の入口に来た形跡（自前ログ）。買い手かどうかはここでは断定できない。 */
export async function ownFunnel(store) {
  const out = { ok: false, reached: 0, quotes: 0, by_resource: [], revenue_usd: 0, note: null };
  if (!store) return out;
  try {
    const r = await q1(store, `SELECT COUNT(*) n, SUM(CASE WHEN CAST(status AS TEXT)='402' THEN 1 ELSE 0 END) q, MAX(at) last FROM x402_hits`);
    out.reached = num(r && r.n, 0); out.quotes = num(r && r.q, 0);
    const rows = await qa(store, `SELECT resource, COUNT(*) n, SUM(CASE WHEN CAST(status AS TEXT)='402' THEN 1 ELSE 0 END) q, MAX(at) last FROM x402_hits GROUP BY resource ORDER BY n DESC LIMIT 12`);
    out.by_resource = (rows || []).map((x) => ({ resource: x.resource, hits: num(x.n, 0), quotes: num(x.q, 0) }));
    out.ok = true;
  } catch (e) { out.note = clip(e && e.message, 160); }
  try {
    const rev = await q1(store, `SELECT COUNT(*) n FROM ledger WHERE kind='revenue' AND basis <> 'self_test'`);
    out.revenue_count = num(rev && rev.n, 0);
  } catch { /* 台帳が無くても続ける */ }
  out.note = out.note || '全期間の自前ログ。402 は「値札を出した回数」で、到達は買い手の数ではない（索引ボットの巡回を含む）。';
  return out;
}

// ------------------------------------------------------------------ 1スキャン

export async function ensureMarketTables(store) {
  if (!store) return false;
  const ddl = [
    `CREATE TABLE IF NOT EXISTS ${MS} (id TEXT PRIMARY KEY, at TEXT, snapshot TEXT, count INTEGER, services INTEGER, payers INTEGER, calls INTEGER, top_json TEXT, bands_json TEXT, own_json TEXT, gaps_json TEXT, note TEXT)`,
    `CREATE TABLE IF NOT EXISTS ${MH} (id TEXT PRIMARY KEY, at TEXT, slug TEXT, category TEXT, op TEXT, price_atomic INTEGER, why TEXT, score REAL, source TEXT, state TEXT, evidence_json TEXT, note TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_market_scans_at ON ${MS}(at)`,
    `CREATE INDEX IF NOT EXISTS idx_market_hyp_state ON ${MH}(state)`,
  ];
  for (const q of ddl) { try { await store.run(q); } catch { /* 既にあれば何もしない */ } }
  return true;
}

async function fetchJson(fetchImpl, url, { token = null, timeoutMs = 20000 } = {}) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': MARKET_UA, ...(token ? { authorization: `Bearer ${token}` } : {}) }, redirect: 'manual', ...(ctrl ? { signal: ctrl.signal } : {}) });
    if (!res.ok) return { ok: false, http: res.status, body: null };
    return { ok: true, http: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, http: 0, body: null, error: clip(e && e.message, 120) };
  } finally { if (t) clearTimeout(t); }
}

/**
 * 1スキャン = 市場の真実を取る → 自分の真実を取る → 隙間を名指しする → 仮説を残す。
 * ネットワークが落ちていても、取れた分だけで正直に記録する（捏造しない）。
 */
export async function marketScan({ store, env = {}, deps = {}, fetchImpl = fetch, now = null, force = false, ai = null } = {}) {
  await ensureMarketTables(store);
  const at = now || nowIso();
  const prev = await setting(store, MSTATE, null).catch(() => null);
  if (!force && prev && prev.last_scan_at) {
    const age = Date.now() - Date.parse(prev.last_scan_at);
    if (Number.isFinite(age) && age < SCAN_EVERY_MINUTES * 60000) {
      return { ok: true, skipped: 'fresh', age_minutes: Math.round(age / 60000), last_scan_at: prev.last_scan_at };
    }
  }
  const launched = (await extraCatalog(store)).map((i) => i && i.resource).filter(Boolean);
  const t = await fetchJson(fetchImpl, TEASER_URL);
  const services = t.ok && t.body && Array.isArray(t.body.services) ? t.body.services : [];
  const summary = services.length ? summarizeSample(services, { snapshot: snapOf(t.body), count: t.body && t.body.count, sample: t.body && t.body.sample })
    : { snapshot: null, services: 0, total_calls: 0, total_payers: 0, payers_ge: {}, by_category: [], bands: [], source_url: TEASER_URL, note: `市場サンプルを取得できなかった（HTTP ${t.http}${t.error ? ` / ${t.error}` : ''}）` };
  const own = await ownTruth({ env, deps, fetchImpl });
  const funnel = await ownFunnel(store);
  const gaps = gapsOf(summary, { launched });
  const hyps = hypothesesFrom(gaps, { ai });
  const id = rid();
  try {
    await store.run(`INSERT INTO ${MS} (id,at,snapshot,count,services,payers,calls,top_json,bands_json,own_json,gaps_json,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, at, summary.snapshot || null, num(summary.count, 0), num(summary.services, 0), num(summary.total_payers, 0), num(summary.total_calls, 0),
      JSON.stringify((summary.by_category || []).slice(0, 8)), JSON.stringify(summary.bands || []), JSON.stringify({ own, funnel }), JSON.stringify(gaps), clip(summary.note, 300));
    for (const h of hyps) {
      await store.run(`INSERT INTO ${MH} (id,at,slug,category,op,price_atomic,why,score,source,state,evidence_json,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        h.id, at, h.slug, h.category, h.op, num(h.price_atomic, 0), clip(h.why, 400), num(h.score, 0), h.source, 'proposed', JSON.stringify({ snapshot: summary.snapshot, payers: (gaps.find((g) => g.category === h.category) || {}).payers || 0 }), null);
    }
  } catch (e) { return { ok: false, error: 'store_failed', detail: clip(e && e.message, 200) }; }
  await setSetting(store, MSTATE, { last_scan_at: at, snapshot: summary.snapshot, services: summary.services, gaps: gaps.length, hypotheses: hyps.length }).catch(() => {});
  return { ok: true, id, at, snapshot: summary.snapshot, market: { services: summary.services, count: summary.count, total_payers: summary.total_payers, total_calls: summary.total_calls, payers_ge: summary.payers_ge, by_category: (summary.by_category || []).slice(0, 8), bands: summary.bands, note: summary.note }, own, funnel, gaps, hypotheses: hyps.map((h) => ({ slug: h.slug, category: h.category, source: h.source, why: h.why })) };
}

function snapOf(body) {
  if (!body) return null;
  const s = body.snapshot;
  if (!s) return null;
  if (typeof s === 'string') return s;
  const v = s.id || s.hash || s.key || (s.at ? String(s.at) : null);
  if (v) return String(v).slice(0, 80);
  try { return JSON.stringify(s).slice(0, 80); } catch { return null; }
}

// ------------------------------------------------------------------ 掲載（作って、自分で確かめる）

/**
 * 仮説のうち「部品表で作れて、まだ出していない」ものを1つ選び、掲載して、その場で呼んで確かめる。
 * 確かめられなければ掲載を取り消す（売れない物を店頭に置かない）。
 */
export async function launchTopProduct({ store, env = {}, deps = {}, now = null, dryRun = false } = {}) {
  await ensureMarketTables(store);
  const at = now || nowIso();
  let existing = await extraCatalog(store);
  const rows = await qa(store, `SELECT * FROM ${MH} WHERE state IN ('proposed','build') ORDER BY score DESC LIMIT 12`).catch(() => []);
  const cands = [];
  for (const r of rows || []) {
    const m = materialize({ slug: r.slug, op: r.op, category: r.category, price_atomic: r.price_atomic, why: r.why, source: r.source }, { existing });
    cands.push({ row: r, ...m });
  }
  const pick = cands.find((c) => c.ok);
  if (!pick) return { ok: false, change: 'launch_product', evidence: { tried: cands.length, reasons: [...new Set(cands.map((c) => c.reason || 'ok'))], note: 'いま作れる新しい品が無い（全部既に出ているか、部品表の外）' } };
  const item = pick.item;
  if (dryRun) return { ok: false, change: 'launch_product', evidence: { dry_run: true, would_list: item.resource, price_atomic: item.price_usdc, why: item.why } };
  const ver = await verifyProduct(item, { deps: { ...deps, env } });
  if (!ver.ok) {
    await store.run(`UPDATE ${MH} SET state='failed', note=?, evidence_json=? WHERE id=?`, clip(`検証で落ちた: ${ver.step} ${ver.detail}`, 300), JSON.stringify(ver), pick.row.id).catch(() => {});
    return { ok: false, change: 'launch_product', evidence: { slug: item.resource, verified: false, step: ver.step, detail: ver.detail, note: '作ったが自分で呼んで確かめられなかったので掲載していない' } };
  }
  existing = [...existing, item];
  await setSetting(store, EXTRA_KEY, existing);
  await store.run(`UPDATE ${MH} SET state='listed', note=? WHERE id=?`, clip(`掲載 ${item.resource} @ ${item.price_usdc} atomic`, 200), pick.row.id).catch(() => {});
  return {
    ok: true, change: 'launch_product',
    evidence: { slug: item.resource, price_atomic: item.price_usdc, label_ja: item.label_ja, op: item.op, why: item.why, verified: true, verify: ver.detail, listed_total: existing.length, endpoint: `/api/x402/${item.resource}` },
  };
}

/** 落ちた品を畳む（呼んでも中身が返らない品を店頭に残さない）。 */
export async function delistProduct({ store, slug, now = null } = {}) {
  const list = await extraCatalog(store);
  const keep = list.filter((i) => i && i.resource !== String(slug || ''));
  if (keep.length === list.length) return { ok: false, reason: 'not_listed', slug };
  await setSetting(store, EXTRA_KEY, keep);
  await store.run(`UPDATE ${MH} SET state='delisted', note=? WHERE slug=?`, `掲載取り消し ${nowIso()}`, String(slug)).catch(() => {});
  return { ok: true, slug, remaining: keep.length };
}

// ------------------------------------------------------------------ 見せる

export async function marketStatus(store) {
  await ensureMarketTables(store);
  const st = await setting(store, MSTATE, null).catch(() => null);
  const last = await q1(store, `SELECT * FROM ${MS} ORDER BY at DESC LIMIT 1`).catch(() => null);
  const hyps = await qa(store, `SELECT slug,category,op,price_atomic,source,state,score,why FROM ${MH} ORDER BY at DESC LIMIT 20`).catch(() => []);
  const listed = await extraCatalog(store);
  return {
    version: MARKET_VERSION, last_scan_at: (last && last.at) || null, state: st || null,
    market: last ? { snapshot: last.snapshot, services: last.services, count: last.count, payers: last.payers, calls: last.calls, top: safeJson(last.top_json, []), bands: safeJson(last.bands_json, []), note: last.note } : null,
    own: last ? safeJson(last.own_json, null) : null,
    gaps: last ? safeJson(last.gaps_json, []) : [],
    hypotheses: hyps || [],
    listed_products: listed.map((i) => ({ resource: i.resource, op: i.op, price_atomic: i.price_usdc, why: i.why || null })),
    sources: { market: TEASER_URL, own: CDP_SEARCH_URL, note: '市場サンプルは競合が無料公開している CDP 全カタログの5%標本。収益は価格×呼び出しの推定。' },
  };
}

export async function marketPublic(store) {
  const s = await marketStatus(store);
  const h = (s.hypotheses || [])[0] || null;
  return {
    version: MARKET_VERSION, at: s.last_scan_at, snapshot: s.market ? s.market.snapshot : null,
    market_size_note: s.market ? s.market.note : null,
    categories: (s.market && s.market.top ? s.market.top : []).map((c) => ({ category: c.key, label: c.label, services: c.n, payers: c.payers, calls: c.calls, revenue_est_usd: c.revenue_est_usd })),
    price_bands: s.market ? s.market.bands : [],
    own_products_seen_by_buyers: (s.own && s.own.own ? (s.own.own.products || []) : []).slice(0, 8),
    gaps: (s.gaps || []).map((g) => ({ category: g.category, label: g.label, payers: g.payers, buildable: (g.buildable || []).length })),
    products_created: s.listed_products,
    latest_hypothesis: h ? { slug: h.slug, why: h.why } : null,
    sources: s.sources,
  };
}

export function marketText(s = {}) {
  const L = [];
  L.push(`市場の真実 (${MARKET_VERSION})  最終スキャン ${s.last_scan_at || '未実施'}`);
  if (s.market) { L.push(`  標本 ${s.market.services}件（全カタログ ${s.market.count}件の5%）  snapshot ${s.market.snapshot || '-'}`); L.push(`  標本内の支払者合計 ${s.market.payers}人 / 呼び出し ${s.market.calls}回`); }
  for (const c of (s.market && s.market.top) || []) L.push(`  ${String(c.key).padEnd(12)} ${String(c.label).padEnd(20)} 支払者${String(c.payers).padStart(5)} 呼${String(c.calls).padStart(6)} 推定$${c.revenue_est_usd}`);
  if (s.own && s.own.ok) { L.push('  買い手側から見た我々:'); for (const p of (s.own.products || []).slice(0, 6)) L.push(`    ${p.resource.replace(/^https?:\/\/[^/]+/, '')} 呼${p.calls30d} 支払者${p.payers30d} 最終${p.last_called_at || '-'}`); } else L.push(`  買い手側から見た我々: 取得できず（${(s.own && s.own.note) || '理由不明'}）`);
  for (const g of s.gaps || []) L.push(`  隙間 ${g.category}(${g.label}) 支払者${g.payers} 作れる品${(g.buildable || []).length} — ${g.note}`);
  for (const h of s.hypotheses || []) L.push(`  仮説 ${h.slug} [${h.source}/${h.state}] $${(h.price_atomic / 1e6).toFixed(4)} ${h.why || ''}`);
  for (const p of s.listed_products || []) L.push(`  掲載中 ${p.resource} $${(p.price_atomic / 1e6).toFixed(4)} op=${p.op}`);
  return L.join('\n');
}

export function marketHelp(base = '') {
  return [
    `market-1.0 — 市場の真実を測り、足りない売り物を名指しし、作れるものは作って自分で確かめる。`,
    `  GET  ${base}/api/market            — 公開: カテゴリ別の支払者数・価格帯・隙間・作った品（無料の呼び水）`,
    `  GET  ${base}/api/market?format=text — 人が読む形`,
    `  POST ${base}/api/market/scan       — 実測を1回やり直す（オーナー）`,
    `  POST ${base}/api/market/launch     — 仮説から1品だけ作って、その場で呼んで確かめてから出す（オーナー）`,
    `  POST ${base}/api/market/delist?slug=<slug> — 掲載を取り消す（オーナー）`,
    ``,
    `数字の出所: 市場 = ${TEASER_URL}（CDP 全カタログの5%標本・競合が無料公開）／自分 = ${CDP_SEARCH_URL}`,
    `作れるのは既存の実行部品（${OPS.map((o) => o.slug).join(', ')}）だけ。新しいコードが要る案は仮説として残す（勝手に「作った」とは言わない）。`,
  ].join('\n');
}

function safeJson(v, d) { if (v == null) return d; try { const x = typeof v === 'string' ? JSON.parse(v) : v; return x == null ? d : x; } catch { return d; } }
