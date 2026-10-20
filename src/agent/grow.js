// grow-1.0 — 自律成長エンジン（指示なしで回り続けるための「監督」）。
//
// 何をするか
//  販路(sales)は「どの段で死んでいるか」を測り、開拓(hunt)は「売り場を増やす」。
//  足りないのは**全体を1つの目的関数で見て、次に一番効く一手を自分で選ぶ層**だった。
//  ここがそれ: 観測 → 仮説 → 実行 → 検証 → 記憶 → また観測。人が指示しなくても回る。
//
// 目的関数（北極星）
//  外部の人が実際に払った USDC（台帳 kind='revenue' かつ basis <> 'self_test'）。
//  自己テストの金額は絶対に混ぜない（達成を偽装しない）。
//
// 先行指標（支払いより早く動くもの）
//  露出（索引に載っているか）→ 呼ばれた回数 → 402 を返した数 → 払われた数 → 入金。
//  買い手が1人の段では入金は動かないので、**先行指標で探索する**。
//
// 自律の限界（ここは自分で越えない）
//  原価0を守る／不可逆・金・人の身元が要る手は human_only として記録だけする。
//  値札は「下げる」方向だけ自動（上げない）。値上げは人の判断にする。

import { setting, setSetting } from '../db.js';
import { nowIso } from '../util.js';
import { venueBoard, venueAutoQueue, venueHumanQueue, probeVenues } from './venues.js';

export const GROW_VERSION = 'grow-1.0';
export const GR = 'grow_rounds';
export const GLV = 'grow_levers';
export const GSTATE = 'grow:state';
export const GLEDGER_BASE = 'measured';
export const GROW_UA = 'WealthAgent-Grow/1.0 (+https://wealth-agent.wealthagent-app.workers.dev/llms.txt)';

const j = (v) => JSON.stringify(v);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function safeJson(s, f) { try { return JSON.parse(s); } catch { return f; } }
const clip = (s, n = 300) => String(s === null || s === undefined ? '' : s).slice(0, n);

/** 我々が公開している面（drift 検出の基準）。ここに無いものは「面ではない」。 */
export const SURFACES = [
  { path: '/llms.txt', kind: 'text' },
  { path: '/openapi.json', kind: 'json' },
  { path: '/.well-known/x402.json', kind: 'json' },
  { path: '/agents.json', kind: 'json' },
  { path: '/server.json', kind: 'json' },
  { path: '/mcp', kind: 'json' },
  { path: '/sitemap.xml', kind: 'xml' },
  { path: '/robots.txt', kind: 'text' },
  { path: '/api/x402/catalog.json', kind: 'json' },
  { path: '/api/hunt/public', kind: 'json' },
  { path: '/api/sales/public', kind: 'json' },
  { path: '/api/xindex/summary', kind: 'json' },
  { path: '/api/xindex/hosts', kind: 'json' },
  { path: '/api/contact', kind: 'json' },
  { path: '/x402-index', kind: 'html' },
  { path: '/grow', kind: 'html' },
];

/**
 * レバー（打ち手）の目録。needs='human' は記録だけして人に渡す。
 * everyMin はクールダウン。weight は「効きそう」の初期値で、実測で塗り替える。
 */
export const LEVERS = [
  { key: 'price_entry', kind: 'price', needs: 'auto', weight: 30, everyMin: 240, desc: '入口の値札を下げて「試し買いの壁」を外す（下げる方向だけ・原価0）' },
  { key: 'index_magnet', kind: 'product', needs: 'auto', weight: 28, everyMin: 120, desc: '自前の市場索引を更新し、無料の呼び水を新しくする' },
  { key: 'demand_capture', kind: 'learn', needs: 'auto', weight: 24, everyMin: 90, desc: '呼ばれた形跡から「売っていない需要」を名指しする' },
  { key: 'channel_hunt', kind: 'channel', needs: 'auto', weight: 22, everyMin: 60, desc: '新しい売り場を探し、宣言された登録APIにだけ載せる' },
  { key: 'registry_poll', kind: 'channel', needs: 'auto', weight: 20, everyMin: 45, desc: '登録した売り場の審査結果を見に行き、通れば盤面に反映する' },
  { key: 'liveness', kind: 'data', needs: 'auto', weight: 18, everyMin: 120, desc: '売り手の生存を実測してデータの厚みを増やす' },
  { key: 'channel_retire', kind: 'channel', needs: 'auto', weight: 12, everyMin: 360, desc: '成果の出ない売り場を畳んで手数を空ける' },
  { key: 'market_truth', kind: 'learn', needs: 'auto', weight: 26, everyMin: 120, desc: '市場の支払者数と価格帯を実測し、足りない売り物を名指しする' },
  { key: 'ai_strategist', kind: 'learn', needs: 'auto', weight: 20, everyMin: 180, desc: '無料AIに市場の実測を渡し、部品表の中で次の品を提案させる' },
  { key: 'product_launch', kind: 'product', needs: 'auto', weight: 30, everyMin: 90, desc: '名指しされた隙間から1品だけ作り、その場で呼んで確かめてから店頭に出す' },
  { key: 'frontier_think', kind: 'learn', needs: 'auto', weight: 32, everyMin: 150, desc: '「AIエージェントが稼げる分野」を実測に紐づけて見直し、次の一手を名指しする' },
  { key: 'repo_intake', kind: 'learn', needs: 'auto', weight: 28, everyMin: 240, desc: 'GitHub から良いリポジトリを探し、出品窓口・無料API・競合の値札を抜いて台帳に足す' },
  { key: 'listing_intake', kind: 'channel', needs: 'auto', weight: 26, everyMin: 120, desc: 'GitHubから抜いた出品窓口を台帳に落とし、宣言APIのある売り場は登録を試す' },
  { key: 'venue_expand', kind: 'channel', needs: 'auto', weight: 24, everyMin: 180, desc: '大手の売り場（API市場・パッケージ配布・エージェント棚）を実測し、自動で行ける順に並べる' },
  { key: 'directive_run', kind: 'learn', needs: 'auto', weight: 34, everyMin: 20, desc: '自然言語で並べられた指示を拾い、計画→実行→検証→再試行まで走らせる' },
  { key: 'copy_focus', kind: 'copy', needs: 'human', weight: 10, everyMin: 1440, desc: '売れ筋の掲載文を強める（掲載文の書き換えは人の承認）' },
];

export const leverByKey = (k) => LEVERS.find((x) => x.key === String(k || '').trim()) || null;

// ---------------------------------------------------------------- 表

export async function ensureGrowTables(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${GR} (
    id TEXT PRIMARY KEY, at TEXT, lever TEXT, kind TEXT, needs TEXT,
    hypothesis TEXT, action TEXT, verdict TEXT, delta_json TEXT, evidence_json TEXT, note TEXT
  )`);
  await store.run(`CREATE TABLE IF NOT EXISTS ${GLV} (
    key TEXT PRIMARY KEY, kind TEXT, needs TEXT, trials INTEGER DEFAULT 0, keeps INTEGER DEFAULT 0,
    discards INTEGER DEFAULT 0, last_at TEXT, next_at TEXT, score REAL, last_verdict TEXT, note TEXT
  )`);
  try { await store.run(`CREATE INDEX IF NOT EXISTS idx_grow_rounds_at ON ${GR}(at)`); } catch { /* 任意 */ }
}

// ---------------------------------------------------------------- 観測

async function one(store, sql, ...p) { try { return await store.first(sql, ...p); } catch { return null; } }

/** いまの状態を、すべて実測で数える。「取れなかった」は null（0 と混ぜない）。 */
export async function observe({ store, env = {} } = {}) {
  const rev = await one(store, `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS v FROM ledger WHERE kind='revenue' AND (basis IS NULL OR basis <> 'self_test')`);
  const selftest = await one(store, `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS v FROM ledger WHERE kind='revenue' AND basis='self_test'`);
  const hits = await one(store, 'SELECT COUNT(*) AS n FROM x402_hits');
  const probes = await one(store, `SELECT COUNT(*) AS n FROM x402_hits WHERE CAST(status AS TEXT)='402'`);
  const paid = await one(store, `SELECT COUNT(*) AS n FROM x402_hits WHERE CAST(status AS TEXT)='200' OR kind='paid'`);
  const callers = await one(store, `SELECT COUNT(DISTINCT caller) AS n FROM x402_hits WHERE caller IS NOT NULL AND caller <> '' AND instr(lower(caller),'wealthagent') = 0`);
  // 402 は「値札を出した」＝売る気がある証拠。エラーと混ぜると需要を誤読するので除く。
  const miss = await one(store, `SELECT COUNT(*) AS n FROM x402_hits WHERE CAST(status AS TEXT) LIKE '4%' AND CAST(status AS TEXT) <> '402'`);
  const ch = await one(store, `SELECT COUNT(*) AS total, SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN listed=1 THEN 1 ELSE 0 END) AS listed FROM hunt_channels`);
  const tr = await one(store, `SELECT COUNT(*) AS n, SUM(CASE WHEN outcome IN ('ok','listed','submitted') THEN 1 ELSE 0 END) AS ok FROM hunt_trials`);
  const ap = await one(store, `SELECT COUNT(*) AS n FROM approvals WHERE state='pending'`);
  let idx = null;
  try { const m = await import('./xindex.js'); idx = await m.summary(store); } catch { idx = null; }

  return {
    at: nowIso(),
    revenue: { external_usd: num(rev && rev.v), external_events: num(rev && rev.n), self_test_usd: num(selftest && selftest.v), self_test_events: num(selftest && selftest.n) },
    traffic: { hits: num(hits && hits.n), challenges_402: num(probes && probes.n), paid_like: num(paid && paid.n), callers_external: num(callers && callers.n), client_errors: num(miss && miss.n) },
    channels: { total: num(ch && ch.total), active: num(ch && ch.active), listed: num(ch && ch.listed), trials: num(tr && tr.n), trials_ok: num(tr && tr.ok) },
    index: idx ? { services: idx.services_indexed, hosts: idx.hosts_known, live: idx.liveness_live, measured: idx.liveness_measured, last_at: idx.crawl && idx.crawl.last_at } : null,
    approvals_pending: num(ap && ap.n),
    surfaces: SURFACES.length,
  };
}

/**
 * 壁（ボトルネック）を名指しする。ファネルの最初に 0 になった段が「いまの壁」。
 * 段: 露出(索引に載る) → 呼ばれた → 値札(402) → 払われた → 入金。
 */
export function bottleneck(obs = {}) {
  const t = obs.traffic || {}; const c = obs.channels || {}; const r = obs.revenue || {};
  if (num(c.listed) === 0 && num(c.total) > 0) return { stage: 'listed', why: '掲載が0（売り場には居るが載っていない）', lever: 'channel_hunt' };
  if (num(t.hits) === 0) return { stage: 'traffic', why: '誰も呼んでいない', lever: 'index_magnet' };
  if (num(r.external_events) === 0) {
    if (num(t.challenges_402) === 0) return { stage: 'quote', why: '呼ばれているが402まで届かない', lever: 'demand_capture' };
    return { stage: 'paid', why: '402は返しているが払われない', lever: 'price_entry' };
  }
  if (num(r.external_events) < 3) return { stage: 'repeat', why: '1回は買われたが繰り返されない', lever: 'liveness' };
  return { stage: 'scale', why: '入金はある。量を増やす段', lever: 'channel_hunt' };
}

// ---------------------------------------------------------------- 選ぶ（探索と活用）

export async function leverStats(store) {
  const rows = await store.all(`SELECT * FROM ${GLV}`).catch(() => []);
  const m = new Map(rows.map((r) => [r.key, r]));
  return LEVERS.map((l) => {
    const r = m.get(l.key) || {};
    const trials = num(r.trials); const keeps = num(r.keeps);
    const rate = (keeps + 1) / (trials + 2); // ラプラス平滑化: 未試行でも0点にしない
    const unknown = trials === 0 ? 1.35 : 1;  // まず全部を1回は試す
    return { ...l, trials, keeps, discards: num(r.discards), next_at: r.next_at || null, last_verdict: r.last_verdict || null, score: (l.weight / 10) * rate * unknown };
  });
}

export async function choose({ store, env = {}, obs, k = 2 } = {}) {
  const stats = await leverStats(store);
  const wall = bottleneck(obs);
  const now = Date.now();
  const ready = stats.filter((s) => !s.next_at || now - new Date(s.next_at).getTime() >= 0);
  const cool = stats.filter((s) => !ready.includes(s));
  for (const s of ready) if (s.key === wall.lever) s.score *= 1.6; // いまの壁に効く手を前に
  const ranked = ready.slice().sort((a, b) => b.score - a.score);
  const auto = ranked.filter((s) => s.needs === 'auto').slice(0, Math.max(1, Math.min(4, num(k) || 2)));
  return { wall, ranked: ranked.map((s) => `${s.key}:${s.score.toFixed(2)}`), chosen: auto, cooling: cool.map((s) => s.key), human_candidates: ranked.filter((s) => s.needs === 'human').map((s) => s.key) };
}

// ---------------------------------------------------------------- 打つ

async function leverPriceEntry({ store, env = {}, obs }) {
  const { X402_CATALOG } = await import('./x402.js');
  const cur = await one(store, `SELECT value FROM settings WHERE key='grow:price_json'`);
  const parsed = safeJson(cur && cur.value, {}) || {};
  const prices = parsed.prices && typeof parsed.prices === 'object' ? parsed.prices : {};
  const paid = X402_CATALOG.filter((x) => !x.free_tier).sort((a, b) => a.price_usdc - b.price_usdc);
  const entry = paid[0] || X402_CATALOG[0];
  const floor = Math.max(0, num(env.GROW_PRICE_FLOOR_ATOMIC) || 100); // $0.0001。0（無料）には落とさない
  const nowAtomic = Number.isFinite(Number(prices[entry.resource])) ? Number(prices[entry.resource]) : entry.price_usdc;
  if (nowAtomic <= floor) return { ok: false, change: 'price_entry', evidence: { resource: entry.resource, price_atomic: nowAtomic, floor, why: '下限に到達（これ以上は下げない）' } };
  const target = Math.max(floor, Math.round(nowAtomic / 2));
  prices[entry.resource] = target;
  await setSetting(store, 'grow:price_json', { prices, at: nowIso(), why: '入口の値札を下げて試し買いの壁を外す', lever: GROW_VERSION });
  return {
    ok: true, change: 'price_entry',
    evidence: { resource: entry.resource, from_atomic: nowAtomic, to_atomic: target, from_usd: nowAtomic / 1e6, to_usd: target / 1e6, floor_atomic: floor, direction: 'down_only', note: '値上げは人の判断。値札は /api/x402/catalog.json に即反映される' },
  };
}

async function leverIndexMagnet({ store, env = {} }) {
  const { refreshIndex } = await import('./xindex.js');
  const s = await refreshIndex({ store, env, pages: num(env.XINDEX_PAGES_PER_ROUND) || 2 });
  return { ok: s.hosts_seen > 0, change: 'index_refresh', evidence: { services_read: s.read, hosts_updated: s.written, total_in_market: s.total, cursor: s.cursor } };
}

async function leverLiveness({ store, env = {} }) {
  const { probeSlice } = await import('./xindex.js');
  const r = await probeSlice({ store, env, n: num(env.XINDEX_PROBE_PER_ROUND) || 25 });
  return { ok: r.probed > 0, change: 'liveness_probe', evidence: { probed: r.probed, live: r.live, dead: r.dead } };
}

/** 「呼ばれたのに売っていないもの」を名指しする。次の商品開発の根拠になる実データ。 */
async function leverDemandCapture({ store }) {
  let paths = [];
  try {
    paths = await store.all(`SELECT resource AS path, COUNT(*) AS n,
        SUM(CASE WHEN CAST(status AS TEXT) LIKE '4%' AND CAST(status AS TEXT) <> '402' THEN 1 ELSE 0 END) AS miss,
        SUM(CASE WHEN CAST(status AS TEXT)='402' THEN 1 ELSE 0 END) AS quoted
      FROM x402_hits GROUP BY resource ORDER BY n DESC LIMIT 30`);
  } catch { paths = []; }
  let uas = [];
  try { uas = await store.all(`SELECT ua, COUNT(*) AS n FROM x402_hits WHERE ua IS NOT NULL AND ua <> '' GROUP BY ua ORDER BY n DESC LIMIT 15`); } catch { uas = []; }
  const unmet = paths.filter((p) => num(p.miss) > 0 && num(p.quoted) === 0).map((p) => ({ path: p.path, misses: num(p.miss) })).slice(0, 10);
  const selling = paths.filter((p) => num(p.quoted) > 0).map((p) => ({ path: p.path, calls: num(p.n), quoted: num(p.quoted), misses: num(p.miss) }));
  const out = { at: nowIso(), unmet_demand: unmet, quoted_paths: selling, top_callers: uas.map((u) => ({ ua: clip(u.ua, 90), n: num(u.n) })), note: '実際に来た要求だけを数える。推測の需要は書かない。' };
  await setSetting(store, 'grow:demand', out);
  return { ok: paths.length > 0, change: 'demand_capture', evidence: { paths_seen: paths.length, unmet: unmet.length, quoted: selling.length, top_callers: out.top_callers.slice(0, 5) } };
}

async function leverChannelHunt({ store, env = {} }) {
  const { huntRound } = await import('./chanhunt.js');
  const r = await huntRound({ store, env, n: 2 });
  const acts = (r && r.actions) || [];
  const ok = acts.some((a) => a.ok);
  return { ok, change: 'channel_hunt', evidence: { verdict: r && r.verdict, actions: acts.map((a) => `${a.host}:${a.action}:${a.outcome || (a.ok ? 'ok' : 'pending')}`).slice(0, 8), new_hosts: r && r.discovered ? r.discovered.candidates : null } };
}

async function leverChannelRetire({ store }) {
  let changes = 0;
  try {
    const r = await store.run(
      `UPDATE hunt_channels SET active=0, updated_at=?
       WHERE active=1 AND attempts>=3 AND COALESCE(listed,0)=0
         AND COALESCE(status,'') NOT IN ('submitted','listed')`,
      nowIso(),
    );
    changes = num(r && r.meta && r.meta.changes);
  } catch { changes = 0; }
  return { ok: changes > 0, change: 'channel_retire', evidence: { retired: changes, rule: 'attempts>=3 かつ 未掲載 かつ 提出もしていない' } };
}

/** 登録した売り場の審査を自分で見に行く（承認されたら盤面に反映）。 */
async function leverRegistryPoll({ store }) {
  const row = await one(store, `SELECT value FROM settings WHERE key='registry:agentshare'`);
  const s = safeJson(row && row.value, null);
  if (!s || !s.status_api_url) return { ok: false, change: 'registry_poll', evidence: { skipped: 'no_registry_on_file' } };
  let status = null; let http = 0;
  try {
    const res = await fetch(s.status_api_url, { headers: { accept: 'application/json', 'user-agent': GROW_UA }, redirect: 'manual' });
    http = res.status;
    const body = await res.json().catch(() => null);
    status = body && (body.status || (body.data && (body.data.status || (body.data.listing && body.data.listing.status))));
  } catch { http = 0; }
  const approved = !!status && /approv|list|active|live|publish/i.test(String(status));
  if (approved) {
    try { await store.run(`UPDATE hunt_channels SET listed=1, status='listed', updated_at=? WHERE key='hn_agentshare_dev'`, nowIso()); } catch { /* 反映できなくても記録は残す */ }
  }
  await setSetting(store, 'grow:registry:last', { at: nowIso(), http, status: status || null, approved });
  return { ok: approved, change: 'registry_poll', evidence: { http, status: status || null, approved, listing_id: s.id || null, note: approved ? '掲載へ反映した' : 'まだ審査中。掲載済みとは言わない' } };
}

// 無料のAIを1つだけ借りる（有料は使わない）。名前の揺れは候補を順に試して吸収する。
// 借りられなければ null を返し、決定的な手だけを回す（エンジンは止めない）。
const AI_CANDIDATES = ["AIRouter", "aiCacheKey"];
const jsonBlock = (s) => { const m = String(s == null ? '' : s).match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } };
let aiProbeError = null;
export async function freeLlm(env, store) {
  aiProbeError = null;
  try {
    const { dbFirst, dbAll } = await import('./market.js');
    const m = await import('../ai/router.js');
    for (const n of AI_CANDIDATES) {
      const v = m[n];
      if (!v) continue;
      if (typeof v === 'function') {
        const runSql = (sql, ...p) => (store && typeof store.run === 'function') ? store.run(sql, ...p) : store.prepare(sql).bind(...p).run();
        // AI 側が使う口（first/all/run/insert など）を一式そろえる。足りない口は Proxy で
        // 「何もしない」に落とし、使用量の記録のような付随処理で本体を止めない。
        const shop = {
          first: (sql, ...p) => dbFirst(store, sql, ...p), all: (sql, ...p) => dbAll(store, sql, ...p),
          get: (sql, ...p) => dbFirst(store, sql, ...p), query: (sql, ...p) => dbAll(store, sql, ...p),
          run: runSql, prepare: (store && typeof store.prepare === 'function') ? store.prepare.bind(store) : undefined,
          insert: async (table, obj) => {
            const ks = Object.keys(obj || {});
            if (!ks.length) return null;
            return runSql('INSERT INTO ' + table + ' (' + ks.join(',') + ') VALUES (' + ks.map(() => '?').join(',') + ')',
              ...ks.map((k) => { const v = obj[k]; return (v && typeof v === 'object') ? JSON.stringify(v) : v; }));
          },
          batch: async () => [], update: async () => null, delete: async () => null,
        };
        const shopAny = new Proxy(shop, { get: (t, k) => (k in t ? t[k] : (() => Promise.resolve(null))) });
        // 作り方（引数の形）が実装で揺れるので、store が生えている形を優先して順に試す。
        const shapes = [
          () => new v(shopAny, env), () => new v({ env, store: shopAny }), () => v(env, shopAny), () => new v(env, { store: shopAny }),
          () => new v({ env, store: shopAny, db: shopAny }), () => v({ env, store: shopAny }), () => v(env, shopAny),
        ];
        let fallback = null;
        for (const f of shapes) {
          let r = null;
          try { r = f(); } catch (e1) { aiProbeError = clip(e1 && e1.message, 140); continue; }
          if (!r || typeof r.complete !== 'function') continue;
          const st = r.store || r.db || null;
          if (!st || typeof st.first === 'function') return (req) => r.complete(req);
          if (!fallback) fallback = r;
        }
        if (fallback) return (req) => fallback.complete(req);
      } else if (typeof v === 'object' && typeof v.complete === 'function') {
        return (req) => v.complete(req);
      }
    }
  } catch (e) { aiProbeError = clip(e && e.message, 160); }
  return null;
}

/** 市場の実測をとる（market-1.0）。 */
async function leverMarketTruth(ctx) {
  const { marketScan } = await import('./market.js');
  const r = await marketScan({ store: ctx.store, env: ctx.env || {}, deps: ctx, force: false });
  if (r.skipped) return { ok: false, change: 'market_truth', evidence: { skipped: r.skipped, age_minutes: r.age_minutes } };
  return { ok: !!(r.ok && r.market && r.market.services > 0), change: 'market_truth',
    evidence: { scan_id: r.id || null, snapshot: r.snapshot || null, services: r.market && r.market.services, payers_ge: r.market && r.market.payers_ge,
      top: ((r.market && r.market.by_category) || []).slice(0, 3).map((c) => c.key + ':' + c.payers),
      own_seen_by_buyers: ((r.own && r.own.products) || []).slice(0, 2).map((p) => p.resource.replace(/^https?:\/\/[^/]+/, '') + ' payers=' + p.payers30d),
      gaps: (r.gaps || []).map((y) => y.category + ':' + y.payers), hypotheses: (r.hypotheses || []).length } };
}

/** 無料AIに次の品を提案させる。使えなければ決定的な案だけで続け、正直に記録する。 */
async function leverAiStrategist(ctx) {
  const { marketStatus, hypothesesFrom, OPS } = await import('./market.js');
  const st = await marketStatus(ctx.store);
  const gaps = (st.gaps || []).filter((y) => (y.buildable || []).length);
  if (!gaps.length) return { ok: false, change: 'ai_strategist', evidence: { skipped: 'no_buildable_gap', note: 'いま作れる隙間が無い' } };
  const llm = await freeLlm(ctx.env || {}, ctx.store);
  const ideas = []; let aiError = null;
  if (llm) {
    try {
      const digest = { market: st.market && { services: st.market.services, price_bands: st.market.bands, top: (st.market.top || []).slice(0, 6).map((c) => ({ key: c.key, payers: c.payers, calls: c.calls, median_price_usd: c.median_price_usd })) },
        gaps: gaps.slice(0, 5).map((y) => ({ category: y.category, label: y.label, payers: y.payers })),
        ours: st.listed_products.map((p) => p.resource), buildable: OPS.map((o) => ({ slug: o.slug, op: o.op, category: o.category, price_atomic: o.price_atomic })) };
      const out = await llm({ role: 'grow_strategist', json: true, maxTokens: 700,
        system: 'あなたは原価0の売り物を設計する戦略担当。与えられた buildable の中からしか選べない。JSONだけを返す。',
        user: '市場の実測:\n' + JSON.stringify(digest) + '\n\n次の形のJSONだけを返してください: {"ideas":[{"slug":"<buildableのslug>","price_atomic":<100..10000>,"why":"<80字以内>","confidence":<0..1>}]}' });
      const txt = typeof out === 'string' ? out : (out && (out.text || out.content)) || '';
      const parsed = jsonBlock(txt);
      if (parsed && Array.isArray(parsed.ideas)) for (const i of parsed.ideas) ideas.push(i);
    } catch (e) { aiError = clip(e && e.message, 160); }
  }
  const hyps = hypothesesFrom(gaps, { ai: ideas, max: 4 });
  for (const h of hyps) {
    if (h.source !== 'ai') continue;
    try { await ctx.store.run('INSERT INTO market_hypotheses (id,at,slug,category,op,price_atomic,why,score,source,state,evidence_json,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      h.id, nowIso(), h.slug, h.category, h.op, h.price_atomic, clip(h.why, 400), h.score, h.source, 'proposed', JSON.stringify({ provider: 'free' }), null); } catch { /* 残せなくても続ける */ }
  }
  return { ok: !!(llm && ideas.length), change: 'ai_strategist', evidence: { ai_available: !!llm, ai_error: aiError || aiProbeError, ideas_from_ai: ideas.length, kept: hyps.filter((h) => h.source === 'ai').length, note: llm ? '無料枠のみ。部品表の外の提案は捨てた。' : '無料AIを借りられず決定的な案で続行' } };
}

/** 名指しされた隙間から1品だけ作り、その場で呼んで確かめてから店頭に出す。 */
async function leverProductLaunch(ctx) {
  const { launchTopProduct } = await import('./market.js');
  const r = await launchTopProduct({ store: ctx.store, env: ctx.env || {}, deps: ctx });
  return { ok: !!r.ok, change: 'launch_product', evidence: r.evidence || {} };
}

export async function runLever(key, ctx = {}) {
  const L = leverByKey(key);
  if (!L) return { ok: false, change: key, evidence: { error: 'unknown_lever' } };
  if (L.needs !== 'auto') return { ok: false, change: key, human_only: true, evidence: { why: '人の承認が要る手。実行していない。', desc: L.desc } };
  try {
    if (key === 'price_entry') return await leverPriceEntry(ctx);
    if (key === 'index_magnet') return await leverIndexMagnet(ctx);
    if (key === 'liveness') return await leverLiveness(ctx);
    if (key === 'demand_capture') return await leverDemandCapture(ctx);
    if (key === 'channel_hunt') return await leverChannelHunt(ctx);
    if (key === 'channel_retire') return await leverChannelRetire(ctx);
    if (key === 'registry_poll') return await leverRegistryPoll(ctx);
    if (key === 'market_truth') return await leverMarketTruth(ctx);
    if (key === 'ai_strategist') return await leverAiStrategist(ctx);
    if (key === 'product_launch') return await leverProductLaunch(ctx);
    if (key === 'frontier_think') {
      const { frontierThink } = await import('./frontier.js');
      const ai = await freeLlm(ctx.env || {}, ctx.store);
      const r = await frontierThink({ store: ctx.store, env: ctx.env || {}, deps: ctx, ai, force: !!(ctx && ctx.force) });
      return { ok: !!(r.ok && !r.skipped), change: 'frontier_think', evidence: { measured: r.measured, measured_at: r.measured_at || null,
        top: r.top || null, next: (r.next || []).slice(0, 3).map((n) => n.domain + ': ' + n.action),
        ai_available: r.ai_available, ai_error: r.ai_error || null, new_domains: r.new_domains_from_ai || 0, skipped: r.skipped || null } };
    }
    if (key === 'repo_intake') {
      const { repoIntake } = await import('./repo.js');
      const r = await repoIntake({ store: ctx.store, env: ctx.env || {}, force: !!(ctx && ctx.force) });
      return { ok: !!(r.ok && !r.skipped), change: 'repo_intake', evidence: { scanned: r.scanned, adopt: r.adopt, listing_candidates: r.listing_candidates,
        payto_found: r.payto_found, readmes: r.readmes, top: r.top ? { full_name: r.top.full_name, stars: r.top.stars, adopt: r.top.adopt, why: r.top.why } : null,
        errors: r.errors, skipped: r.skipped || null } };
    }
    if (key === 'venue_expand') {
      const r = await probeVenues({ env: ctx.env, fetchImpl: ctx.fetchImpl, dry: !!ctx.dry });
      const board = venueBoard();
      return {
        ok: !!r.ok, change: 'venue_expand',
        evidence: {
          venues: board.length,
          probed: r.probed,
          auto_queue: venueAutoQueue().length,
          human_queue: venueHumanQueue().length,
          by_signal: r.by_signal,
        },
      };
    }

    if (key === 'listing_intake') {
      const { repoProspectIntake } = await import('./repo.js');
      const r = await repoProspectIntake({ store: ctx.store, env: ctx.env || {}, limit: (ctx && ctx.limit) || 8 });
      return { ok: !!r.ok, change: 'listing_intake', evidence: { hosts: r.hosts, probed: r.probed, auto_ready: r.auto_ready, human_required: r.human_required,
        top: (r.items || []).slice(0, 3).map((x) => x.host + ':' + x.signal) } };
    }
    if (key === 'directive_run') {
      const { directiveTick } = await import('./director.js');
      const ai = await freeLlm(ctx.env || {}, ctx.store);
      const r = await directiveTick({ store: ctx.store, env: ctx.env || {}, deps: ctx, ai });
      return { ok: true, change: 'directive_run', evidence: { ran: r.ran, results: r.results, pending: r.pending, note: r.ran ? null : '未処理の指示なし' } };
    }
    return { ok: false, change: key, evidence: { error: 'not_implemented' } };
  } catch (e) {
    return { ok: false, change: key, evidence: { error: clip(e && e.message, 200) } };
  }
}

// ---------------------------------------------------------------- 1ラウンド

export async function growRound({ store, env = {}, n = null, now = null, lever = null } = {}) {
  await ensureGrowTables(store);
  const at = now || nowIso();
  const before = await observe({ store, env });
  const forced = lever ? leverByKey(lever) : null;
  const base = await choose({ store, env, obs: before, k: num(n) || num(env.GROW_MAX_PER_ROUND) || 2 });
  const pick = forced ? { ...base, chosen: [forced], forced: true } : base;
  const actions = [];
  for (const L of pick.chosen) {
    const r = await runLever(L.key, { store, env, obs: before });
    actions.push({ key: L.key, kind: L.kind, ok: r.ok, human_only: !!r.human_only, change: r.change, evidence: r.evidence });
    // 記憶を更新（次にいつ、何点か）
    const verdict = r.ok ? 'keep' : (r.evidence && r.evidence.skipped ? 'skip' : 'discard');
    try {
      const cur = await one(store, `SELECT * FROM ${GLV} WHERE key=?`, L.key);
      const trials = num(cur && cur.trials) + 1;
      const keeps = num(cur && cur.keeps) + (verdict === 'keep' ? 1 : 0);
      const discards = num(cur && cur.discards) + (verdict === 'discard' ? 1 : 0);
      const rate = (keeps + 1) / (trials + 2);
      const score = (L.weight / 10) * rate;
      const nextAtRaw = L.everyMin * 60000 * (verdict === 'keep' ? 1 : 1.6); // 通らなかった手は次を少し遠ざける
      await store.run(
        `INSERT INTO ${GLV} (key,kind,needs,trials,keeps,discards,last_at,next_at,score,last_verdict,note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET kind=excluded.kind, needs=excluded.needs, trials=excluded.trials,
           keeps=excluded.keeps, discards=excluded.discards, last_at=excluded.last_at, next_at=excluded.next_at,
           score=excluded.score, last_verdict=excluded.last_verdict, note=excluded.note`,
        L.key, L.kind, L.needs, trials, keeps, discards, at, new Date(Date.now() + nextAtRaw).toISOString(), score, verdict, clip(L.desc, 200),
      );
    } catch { /* 記憶が書けなくても実行は記録する */ }
  }
  const after = await observe({ store, env });
  const delta = {
    external_usd: after.revenue.external_usd - before.revenue.external_usd,
    external_events: after.revenue.external_events - before.revenue.external_events,
    hits: after.traffic.hits - before.traffic.hits,
    challenges: after.traffic.challenges_402 - before.traffic.challenges_402,
    listed: after.channels.listed - before.channels.listed,
    index_hosts: (after.index ? after.index.hosts : 0) - (before.index ? before.index.hosts : 0),
  };
  const verdict = actions.some((a) => a.ok) ? (num(delta.external_events) > 0 ? 'revenue' : 'improved') : 'tried';
  const id = `gr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const rec = {
    id, at, lever: actions.map((a) => a.key).join('+') || 'none', kind: pick.wall.stage, needs: 'auto',
    hypothesis: `${pick.wall.why} → ${pick.wall.lever} 系の手を打つ`,
    action: actions.map((a) => a.change).join(',') || 'none',
    verdict, delta, actions,
    wall: pick.wall, ranked: pick.ranked, cooling: pick.cooling, human_candidates: pick.human_candidates,
    note: actions.length ? `${actions.length}本 実行 / ${actions.filter((a) => a.ok).length}本 成立` : '打ち手なし（全部クールダウン中）',
  };
  try {
    await store.run(
      `INSERT INTO ${GR} (id,at,lever,kind,needs,hypothesis,action,verdict,delta_json,evidence_json,note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, at, rec.lever, rec.kind, 'auto', clip(rec.hypothesis, 400), clip(rec.action, 400), verdict,
      j(delta), j({ wall: pick.wall, actions, ranked: pick.ranked }), clip(rec.note, 200),
    );
  } catch { /* 記録が落ちても返り値は返す */ }
  let totalRounds = 0;
  try { totalRounds = num((await one(store, `SELECT COUNT(*) AS n FROM ${GR}`)).n); } catch { totalRounds = 0; }
  await setSetting(store, GSTATE, { last_at: at, wall: pick.wall, verdict, rounds: totalRounds });
  return rec;
}

export async function growTick({ store, env = {}, n = null, now = null } = {}) {
  if (env && env.GROW_ENABLED === 'false') return null;
  const every = Math.max(10, num(env.GROW_EVERY_MINUTES) || 45);
  const last = await setting(store, 'grow:last_run_at', null);
  if (last && Date.now() - new Date(last).getTime() < every * 60e3) return null;
  const rec = await growRound({ store, env, n, now });
  await setSetting(store, 'grow:last_run_at', nowIso());
  return rec;
}

// ---------------------------------------------------------------- 外向けの面

export async function growStatus(store, env = {}) {
  await ensureGrowTables(store);
  const obs = await observe({ store, env });
  const wall = bottleneck(obs);
  const rounds = await store.all(`SELECT id,at,lever,verdict,delta_json,note FROM ${GR} ORDER BY at DESC LIMIT 12`).catch(() => []);
  const levers = await leverStats(store);
  const demand = safeJson((await one(store, `SELECT value FROM settings WHERE key='grow:demand'`))?.value, null);
  const priceOver = safeJson((await one(store, `SELECT value FROM settings WHERE key='grow:price_json'`))?.value, null);
  return {
    version: GROW_VERSION, at: obs.at, north_star: '外部の人が実際に払ったUSDC（basis<>self_test）',
    obs, wall, rounds: rounds.map((r) => ({ ...r, delta: safeJson(r.delta_json, null) })),
    levers: levers.map((l) => ({ key: l.key, kind: l.kind, needs: l.needs, trials: l.trials, keeps: l.keeps, discards: l.discards, score: Number(l.score.toFixed(3)), next_at: l.next_at })),
    demand, price_overrides: priceOver,
    gates: { enabled: env.GROW_ENABLED !== 'false', every_minutes: Math.max(10, num(env.GROW_EVERY_MINUTES) || 45), max_per_round: num(env.GROW_MAX_PER_ROUND) || 2, price_floor_atomic: Math.max(0, num(env.GROW_PRICE_FLOOR_ATOMIC) || 100) },
    rules: [
      '値札は下げる方向だけ自動（上げない）。原価0を守る。',
      '不可逆・金・身元が要る手は human_only として記録だけする。',
      '自己テストの金額は北極星に混ぜない。',
      '未測定は null。0 は「測って0」の意味でだけ使う。',
    ],
  };
}

export function growPublic(st = {}) {
  const o = st.obs || {};
  return {
    version: GROW_VERSION,
    read: { status: '/api/grow', public: '/api/grow/public', page: '/grow' },
    north_star: st.north_star,
    now: {
      external_usd: (o.revenue || {}).external_usd, external_events: (o.revenue || {}).external_events,
      hits: (o.traffic || {}).hits, challenges_402: (o.traffic || {}).challenges_402,
      callers_external: (o.traffic || {}).callers_external, listed_channels: (o.channels || {}).listed,
      index_hosts: o.index ? o.index.hosts : null, index_services: o.index ? o.index.services : null,
      self_test_usd: (o.revenue || {}).self_test_usd,
    },
    wall: st.wall,
    how: '観測 → 壁を名指し → 期待値の高い手を選ぶ → 打つ → 測る → 記憶（通った手を優先）。人に指示されなくても45分ごとに回る。',
    rounds: (st.rounds || []).slice(0, 8).map((r) => ({ at: r.at, lever: r.lever, verdict: r.verdict, note: r.note })),
    rules: st.rules,
  };
}

export function growText(st = {}) {
  const o = st.obs || {};
  const L = [];
  L.push(`自律成長エンジン（${GROW_VERSION}）`);
  L.push(`  北極星 外部入金 $${(o.revenue || {}).external_usd || 0} / ${(o.revenue || {}).external_events || 0}件（自己テスト $${(o.revenue || {}).self_test_usd || 0} は別枠）`);
  L.push(`  いまの壁 ${(st.wall || {}).stage} — ${(st.wall || {}).why}`);
  L.push(`  流量 呼び出し ${(o.traffic || {}).hits || 0} / 402 ${(o.traffic || {}).challenges_402 || 0} / 外部の呼び手 ${(o.traffic || {}).callers_external || 0}`);
  L.push(`  露出 掲載 ${(o.channels || {}).listed || 0} / 売り場 ${(o.channels || {}).total || 0} / 索引host ${o.index ? o.index.hosts : '未測定'}`);
  L.push('  レバー（実測の当たり率順）:');
  for (const lv of (st.levers || []).slice().sort((a, b) => b.score - a.score)) {
    L.push(`    ${lv.key.padEnd(16)} ${lv.needs === 'auto' ? '自動' : '要承認'} 試行${lv.trials} 成功${lv.keeps} 失敗${lv.discards} 点${lv.score}`);
  }
  L.push('  直近のラウンド:');
  for (const r of (st.rounds || []).slice(0, 6)) L.push(`    ${r.at} ${r.lever} → ${r.verdict} ${r.note}`);
  return L.join('\n');
}

export function growHelp() {
  return {
    version: GROW_VERSION,
    routes: [
      'GET /api/grow — 状態（?format=text / ?help=1、要認証）',
      'GET /api/grow/public — 認証なしの要約（公開ボード /grow.html が読む）',
      'POST /api/grow — その場で1ラウンド（?n=打つ手の数）',
    ],
    levers: LEVERS.map((l) => ({ key: l.key, kind: l.kind, needs: l.needs, every_minutes: l.everyMin, desc: l.desc })),
    env: { GROW_ENABLED: 'false で停止', GROW_EVERY_MINUTES: '既定45', GROW_MAX_PER_ROUND: '既定2', GROW_PRICE_FLOOR_ATOMIC: '値札の下限（既定100 = $0.0001）' },
    note: '原価0・下げる方向だけ・不可逆は人の承認。指示がなくても回るが、止めたい時は GROW_ENABLED=false。',
  };
}

/** 自律価格レバーの実体を、値札を出す前に env へ注入する（index.js が呼ぶ）。 */
export async function withOverrides(env = {}, store = null) {
  if (!store) return env;
  try {
    const r = await store.first("SELECT value FROM settings WHERE key='grow:price_json'");
    if (!r || !r.value) return env;
    const o = safeJson(r.value, null);
    if (!o || !o.prices || !Object.keys(o.prices).length) return env;
    return { ...env, X402_OVERRIDES: typeof r.value === 'string' ? r.value : j(r.value) };
  } catch { return env; }
}
