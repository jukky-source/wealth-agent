// xindex-1.0 — 自前の「x402 市場索引」。
//
// なぜ作るか
//  * 我々の売り物（テキスト道具）は数千の類似品と横並びで、買う理由が弱い。
//    一方で「x402 の市場そのもの」の実データを持っているのは我々だけになれる:
//    公開ディスカバリ（CDP）を読むと、売り手・値段・生存・カテゴリが全部見える。
//  * これは原価0で、真似されにくく、買い手（他のエージェント）が最も欲しがる情報:
//    「どの x402 の売り手が生きていて、いくらで、何を売っているか」。
//  * 索引そのものは無料で公開する（呼び水）。無料の索引を読みに来たエージェントが
//    有料の道具（/api/x402/*）に触れる導線を作る。原価0の設計制約は破らない。
//
// 原則
//  * 読むのは公開面だけ。GET のみ。403/401 は「生きているが認証が要る」として記録し、
//    迂回はしない。robots/規約を尊重し、1ラウンドあたりの取得量を固定して全体を少しずつ回る
//    （カーソル式の増分クロール）。
//  * 「未測定」と「0」を混ぜない。測っていない列は null のまま返す。

export const XI_VERSION = 'xindex-1.0';
export const XH = 'xindex_hosts';
export const XI_STATE = 'xindex:state';
export const CDP_DISCOVERY = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
export const XI_UA = 'WealthAgent-Index/1.0 (+https://wealth-agent.wealthagent-app.workers.dev/llms.txt)';
export const PAGE = 1000;
export const MAX_BATCH = 200;
export const PROBE_TIMEOUT_MS = 8000;

/** 値段の帯（atomic・1e6 = 1 USDC）。買い手が実際に動く帯を可視化するための区切り。 */
export const BANDS = [
  { key: 'free', label: '0（無料）', max: 0 },
  { key: 'under_1m', label: '$0.0001–$0.001', max: 1_000 },
  { key: 'under_10m', label: '$0.001–$0.01', max: 10_000 },
  { key: 'under_100m', label: '$0.01–$0.1', max: 100_000 },
  { key: 'under_1', label: '$0.1–$1', max: 1_000_000 },
  { key: 'over_1', label: '$1 以上', max: Infinity },
];

const j = (v) => JSON.stringify(v);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function safeJson(s, f) { try { return JSON.parse(s); } catch { return f; } }
export function hostOf(u) { try { return new URL(String(u)).host.toLowerCase(); } catch { return ''; } }
export function bandOf(atomic) {
  const n = num(atomic);
  for (const b of BANDS) if (n <= b.max) return b.key;
  return 'over_1';
}

// ---------------------------------------------------------------- 表と状態

export async function ensureXindexTables(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${XH} (
    host TEXT PRIMARY KEY,
    n INTEGER DEFAULT 0,
    n_priced INTEGER DEFAULT 0,
    min_price INTEGER,
    max_price INTEGER,
    networks TEXT,
    sample_resource TEXT,
    sample_desc TEXT,
    discoverable INTEGER DEFAULT 0,
    first_seen TEXT,
    updated_at TEXT,
    live INTEGER,
    live_at TEXT,
    status INTEGER,
    latency_ms INTEGER
  )`);
  try { await store.run(`CREATE INDEX IF NOT EXISTS idx_xindex_probe ON ${XH}(live_at)`); } catch { /* 索引は必須ではない */ }
  try { await store.run(`CREATE INDEX IF NOT EXISTS idx_xindex_n ON ${XH}(n)`); } catch { /* 同上 */ }
}

export async function loadState(store) {
  const r = await store.first('SELECT value FROM settings WHERE key=?', XI_STATE).catch(() => null);
  const s = r ? safeJson(r.value, null) : null;
  return {
    cursor: num(s && s.cursor), pages_done: num(s && s.pages_done), total: num(s && s.total),
    last_at: (s && s.last_at) || null, last_full_at: (s && s.last_full_at) || null,
    full_scans: num(s && s.full_scans), bands: (s && s.bands) || {}, hosts: num(s && s.hosts),
    probed: num(s && s.probed), live: num(s && s.live), dead: num(s && s.dead), version: XI_VERSION,
  };
}

async function saveState(store, patch) {
  const cur = await loadState(store);
  const next = { ...cur, ...patch, version: XI_VERSION };
  await store.run(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    XI_STATE, j(next), new Date().toISOString(),
  );
  return next;
}

// ---------------------------------------------------------------- 取り込み（読み取りのみ）

/** 公開ディスカバリの1ページを読む。total は pagination.total（測った事実）。 */
export async function pageOf({ env = {}, offset = 0, fetchImpl = fetch } = {}) {
  const u = `${CDP_DISCOVERY}?limit=${PAGE}&offset=${Math.max(0, num(offset))}`;
  const res = await fetchImpl(u, { headers: { accept: 'application/json', 'user-agent': XI_UA }, redirect: 'manual' });
  if (!res.ok) throw new Error(`discovery ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body.items) ? body.items : [];
  const total = num(body.pagination && body.pagination.total);
  return { items, total, offset: num(offset) };
}

/** 出品1件を、我々が使う形へ落とす（推測しない・無い列は null）。 */
export function normalizeItem(it = {}, origin = '') {
  const resource = String(it.resource || '');
  const host = hostOf(resource);
  const acc = Array.isArray(it.accepts) ? it.accepts : [];
  const amounts = acc.map((a) => Number(a.amount)).filter((n) => Number.isFinite(n));
  const price = amounts.length ? Math.min(...amounts) : null;
  const nets = [...new Set(acc.map((a) => String(a.network || '')).filter(Boolean))];
  const bazaar = it.extensions && it.extensions.bazaar;
  const info = bazaar && bazaar.info;
  const discoverable = !!(info && info.input && info.input.discoverable);
  let self = false;
  try { self = !!origin && new URL(resource).origin === origin; } catch { self = false; }
  return {
    host, resource, price, amounts: amounts.length, networks: nets,
    description: String(it.description || '').slice(0, 400), discoverable, self,
    lastUpdated: it.lastUpdated || null, quality: (it.quality && it.quality.score) || it.quality || null,
    payTo: acc.length ? String(acc[0].payTo || '') : '',
  };
}

/** host ごとにまとめる（1 host が何品目を、いくらで出しているか）。 */
export function aggregate(items = [], origin = '') {
  const map = new Map();
  const bands = {};
  for (const raw of items) {
    const it = normalizeItem(raw, origin);
    if (!it.host) continue;
    bands[bandOf(it.price === null ? 0 : it.price)] = (bands[bandOf(it.price === null ? 0 : it.price)] || 0) + 1;
    const cur = map.get(it.host) || {
      host: it.host, n: 0, n_priced: 0, min_price: null, max_price: null,
      networks: new Set(), sample_resource: it.resource, sample_desc: it.description,
      discoverable: 0, self: false,
    };
    cur.n += 1;
    if (it.price !== null) {
      cur.n_priced += 1;
      cur.min_price = cur.min_price === null ? it.price : Math.min(cur.min_price, it.price);
      cur.max_price = cur.max_price === null ? it.price : Math.max(cur.max_price, it.price);
    }
    for (const n of it.networks) cur.networks.add(n);
    if (it.discoverable) cur.discoverable = 1;
    if (it.self) cur.self = true;
    if (!cur.sample_desc && it.description) cur.sample_desc = it.description;
    map.set(it.host, cur);
  }
  return {
    hosts: [...map.values()].map((h) => ({ ...h, networks: [...h.networks] })),
    bands,
  };
}

async function upsertHosts(store, hosts, at) {
  let written = 0;
  const rows = hosts.filter((h) => !h.self); // 自分の行は市場データに混ぜない
  for (let i = 0; i < rows.length; i += MAX_BATCH) {
    const slice = rows.slice(i, i + MAX_BATCH);
    const stmts = slice.map((h) => ({
      sql: `INSERT INTO ${XH} (host,n,n_priced,min_price,max_price,networks,sample_resource,sample_desc,discoverable,first_seen,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(host) DO UPDATE SET n=excluded.n, n_priced=excluded.n_priced, min_price=excluded.min_price,
              max_price=excluded.max_price, networks=excluded.networks, sample_resource=excluded.sample_resource,
              sample_desc=excluded.sample_desc, discoverable=excluded.discoverable, updated_at=excluded.updated_at`,
      params: [
        h.host, h.n, h.n_priced, h.min_price, h.max_price, j(h.networks || []),
        String(h.sample_resource || '').slice(0, 400), String(h.sample_desc || '').slice(0, 400),
        h.discoverable ? 1 : 0, at, at,
      ],
    }));
    try { await store.batch(stmts); written += slice.length; } catch { /* 1バッチ落ちても他は入れる */ }
  }
  return written;
}

/**
 * 増分クロール。1ラウンドで pages ページだけ読み、カーソルを進める。
 * 26,088 件を一度に読むと Worker の時間予算を使い切るので、全体を少しずつ覆う。
 */
export async function refreshIndex({ store, env = {}, pages = 2, fetchImpl = fetch } = {}) {
  await ensureXindexTables(store);
  const st = await loadState(store);
  const per = Math.max(1, Math.min(8, num(pages) || 2));
  const at = new Date().toISOString();
  let offset = st.cursor;
  let total = st.total;
  let items = [];
  let read = 0;
  for (let i = 0; i < per; i++) {
    let p;
    try { p = await pageOf({ env, offset, fetchImpl }); } catch (e) {
      if (read === 0) throw e;
      break;
    }
    if (p.total) total = p.total;
    items = items.concat(p.items);
    read += p.items.length;
    offset += PAGE;
    if (total && offset >= total) { offset = 0; break; }
    if (p.items.length < PAGE) { offset = 0; break; }
  }
  const agg = aggregate(items, String((env.AGENT_ORIGIN || env.PUBLIC_ORIGIN) || '').replace(/\/+$/, ''));
  const written = await upsertHosts(store, agg.hosts, at);
  const bands = { ...(st.bands || {}) };
  for (const [k, v] of Object.entries(agg.bands)) bands[k] = (bands[k] || 0) + v;
  const wrapped = offset === 0;
  const next = await saveState(store, {
    cursor: offset, pages_done: st.pages_done + per, total,
    last_at: at, last_full_at: wrapped ? at : st.last_full_at, full_scans: st.full_scans + (wrapped ? 1 : 0),
    bands, hosts: Math.max(st.hosts, 0) + written,
  });
  return { at, total, read, hosts_seen: agg.hosts.length, written, cursor: next.cursor, bands: next.bands, version: XI_VERSION };
}

// ---------------------------------------------------------------- 生存の実測

/**
 * 未測定の host を n 件だけ叩いて生存を測る。402/401/403 は「生きている」に数える
 * （402 は x402 の値札そのもの＝生きている証拠）。5xx/応答なしは死んでいる側。
 */
export async function probeSlice({ store, env = {}, n = 25, fetchImpl = fetch } = {}) {
  await ensureXindexTables(store);
  const lim = Math.max(1, Math.min(60, num(n) || 25));
  let rows = [];
  try {
    rows = await store.all(
      `SELECT host, sample_resource FROM ${XH}
       WHERE sample_resource IS NOT NULL AND sample_resource <> ''
       ORDER BY CASE WHEN live_at IS NULL THEN 0 ELSE 1 END, live_at ASC LIMIT ?`, lim,
    );
  } catch { rows = []; }
  const at = new Date().toISOString();
  let live = 0; let dead = 0; const results = [];
  for (const r of rows) {
    const started = Date.now();
    let status = 0;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
      const res = await fetchImpl(String(r.sample_resource), {
        method: 'GET', redirect: 'manual', signal: ctl.signal,
        headers: { accept: 'application/json, text/plain, */*', 'user-agent': XI_UA },
      });
      clearTimeout(t);
      status = res.status;
      try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* 本文は読まない */ }
    } catch { status = 0; }
    const ms = Date.now() - started;
    const ok = status >= 200 && status < 500;
    if (ok) live += 1; else dead += 1;
    results.push({ host: r.host, status, ms, live: ok });
    try {
      await store.run(`UPDATE ${XH} SET live=?, live_at=?, status=?, latency_ms=? WHERE host=?`, ok ? 1 : 0, at, status, ms, r.host);
    } catch { /* 1行落ちても続ける */ }
  }
  const st = await loadState(store);
  await saveState(store, { probed: st.probed + results.length, live: st.live + live, dead: st.dead + dead });
  return { at, probed: results.length, live, dead, sample: results.slice(0, 12) };
}

// ---------------------------------------------------------------- 外向けの面

export async function summary(store) {
  const st = await loadState(store);
  let hosts = 0; let measured = 0; let live = 0; let dead = 0;
  let cheap = 0; let priced = 0;
  try {
    hosts = num((await store.first(`SELECT COUNT(*) AS n FROM ${XH}`)).n);
    measured = num((await store.first(`SELECT COUNT(*) AS n FROM ${XH} WHERE live_at IS NOT NULL`)).n);
    live = num((await store.first(`SELECT COUNT(*) AS n FROM ${XH} WHERE live=1`)).n);
    dead = num((await store.first(`SELECT COUNT(*) AS n FROM ${XH} WHERE live=0`)).n);
    priced = num((await store.first(`SELECT COUNT(*) AS n FROM ${XH} WHERE n_priced>0`)).n);
    cheap = num((await store.first(`SELECT COUNT(*) AS n FROM ${XH} WHERE min_price IS NOT NULL AND min_price<=1000`)).n);
  } catch { /* 表がまだ無ければ 0 として返す（未測定とは別物なので下で明示） */ }
  return {
    version: XI_VERSION,
    source: CDP_DISCOVERY,
    services_indexed: st.total || null,
    hosts_known: hosts,
    hosts_priced: priced,
    hosts_with_cheap_entry: cheap,
    liveness_measured: measured,
    liveness_live: measured ? live : null,
    liveness_dead: measured ? dead : null,
    liveness_unmeasured: Math.max(0, hosts - measured),
    price_bands: st.bands || {},
    crawl: { cursor: st.cursor, total: st.total || null, pages_done: st.pages_done, last_at: st.last_at, last_full_at: st.last_full_at, full_scans: st.full_scans },
    honesty: '未測定は null。0 は「測って0」の意味でだけ使う。',
  };
}

/** 索引の本体（呼び水。上位だけ・無料）。並びは 品目数 → 生存 → 安さ。 */
export async function topHosts(store, { q = '', limit = 25, live = false, sort = 'n' } = {}) {
  const lim = Math.max(1, Math.min(50, num(limit) || 25));
  const order = sort === 'cheap' ? 'min_price IS NULL, min_price ASC, n DESC'
    : sort === 'live' ? 'live DESC, n DESC'
      : 'n DESC, host ASC';
  let sql = `SELECT host,n,n_priced,min_price,max_price,networks,sample_resource,sample_desc,discoverable,live,status,latency_ms,live_at,updated_at FROM ${XH} WHERE 1=1`;
  const p = [];
  if (String(q || '').trim()) { sql += ' AND (instr(host, ?) > 0 OR instr(sample_desc, ?) > 0)'; p.push(String(q).trim(), String(q).trim()); }
  if (live) sql += ' AND live=1';
  sql += ` ORDER BY ${order} LIMIT ?`;
  p.push(lim);
  let rows = [];
  try { rows = await store.all(sql, ...p); } catch { rows = []; }
  return rows.map((r) => ({
    host: r.host, services: num(r.n), priced_services: num(r.n_priced),
    price_min_usdc: r.min_price === null ? null : num(r.min_price) / 1e6,
    price_max_usdc: r.max_price === null ? null : num(r.max_price) / 1e6,
    networks: safeJson(r.networks, []), sample_resource: r.sample_resource, sample: r.sample_desc,
    discoverable: !!num(r.discoverable),
    live: r.live === null ? null : !!num(r.live), status: r.status === null ? null : num(r.status),
    latency_ms: r.latency_ms === null ? null : num(r.latency_ms), checked_at: r.live_at, updated_at: r.updated_at,
  }));
}

export async function xindexStatus(store) {
  const s = await summary(store);
  const top = await topHosts(store, { limit: 10 });
  const newest = await topHosts(store, { limit: 10, sort: 'cheap' });
  return { ...s, top_by_size: top, cheapest_entries: newest };
}

export function xindexPublic(st = {}) {
  return {
    version: XI_VERSION,
    what: 'x402 市場の公開索引（無料）。公開ディスカバリを読んで、売り手・値段・生存を実測して並べる。',
    read: { summary: '/api/xindex/summary', hosts: '/api/xindex/hosts?q=&limit=&sort=', page: '/x402-index' },
    services_indexed: st.services_indexed, hosts_known: st.hosts_known,
    liveness: { measured: st.liveness_measured, live: st.liveness_live, dead: st.liveness_dead, unmeasured: st.liveness_unmeasured },
    price_bands: st.price_bands, crawl: st.crawl,
    top_by_size: (st.top_by_size || []).slice(0, 10),
    cheapest_entries: (st.cheapest_entries || []).slice(0, 10),
    honesty: st.honesty,
  };
}

export function xindexText(st = {}) {
  const L = [];
  L.push(`x402 市場索引（${XI_VERSION}）`);
  L.push(`  索引した品目 ${st.services_indexed === null || st.services_indexed === undefined ? '未測定' : st.services_indexed}`);
  L.push(`  把握した売り手 ${st.hosts_known}`);
  L.push(`  生存を測った売り手 ${st.liveness_measured} / 生 ${st.liveness_live === null ? '未測定' : st.liveness_live} / 死 ${st.liveness_dead === null ? '未測定' : st.liveness_dead} / 未測定 ${st.liveness_unmeasured}`);
  L.push(`  値段の帯 ${j(st.price_bands || {})}`);
  L.push(`  クロール カーソル ${(st.crawl && st.crawl.cursor) || 0} / 全体 ${(st.crawl && st.crawl.total) || '未測定'} / 最終 ${(st.crawl && st.crawl.last_at) || '未実行'}`);
  L.push('  大きい売り手:');
  for (const h of (st.top_by_size || []).slice(0, 10)) {
    L.push(`    ${h.host} — ${h.services}品目 / 最安 ${h.price_min_usdc === null ? '不明' : '$' + h.price_min_usdc} / ${h.live === null ? '生存未測定' : h.live ? '生存' : '応答なし'}`);
  }
  return L.join('\n');
}

export function xindexHelp() {
  return {
    version: XI_VERSION,
    routes: [
      'GET /api/xindex/summary — 市場の要約（認証不要・無料）',
      'GET /api/xindex/hosts?q=&limit=&sort=n|live|cheap — 売り手一覧（認証不要・無料・最大50件）',
      'GET /x402-index — 人が読む索引ページ',
      'POST /api/xindex/refresh — 取り込みを1ラウンド（要認証・?pages=）',
      'POST /api/xindex/probe — 生存の実測を1ラウンド（要認証・?n=）',
    ],
    env: {
      XINDEX_ENABLED: 'false で停止', XINDEX_PAGES_PER_ROUND: '1ラウンドで読むページ数（既定2・最大8）',
      XINDEX_PROBE_PER_ROUND: '1ラウンドで叩く売り手の数（既定25・最大60）', XINDEX_EVERY_MINUTES: '取り込み間隔（既定180）',
    },
    note: '索引は無料で公開する（呼び水）。読むのは公開面だけで、GET のみ。403/401 は迂回せず「生きている」として記録する。',
  };
}
