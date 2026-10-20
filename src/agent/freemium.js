// 無料枠（フリーミアム）— 決定的で原価ゼロの4品目だけを、支払いなしで試せる入口。
//
// なぜやるか:
//   x402 の売り物は「初回の支払い」という壁の向こうにある。買い手のエージェントは
//   値札（402）を見ても中身を知らないまま USDC を払う必要があり、実測でも外部の
//   買い手はまだゼロだった。原価がゼロの品目（モデルを使わない決定的処理＝
//   regex / diff / csv-json / url-meta）に限って無料枠を開き、まず実際に呼んで
//   もらう。AI を使う品目（brief / data-clean / code-review）は有料のままなので、
//   「原価0」という設計制約は壊れない。
//
// 濫用対策（無料 ≠ 無制限）:
//   * IPごと・UTC日ごとに上限を数える（settings テーブルの1文アップサートで加算）。
//   * url-meta だけは外向きの取得を伴うので、より小さい専用枠にする。
//   * 上限に達したら 402（x402 の値札）を返す ＝ そのまま有料の入口になる。
//
// 台帳には一切触れない。receipts は「署名つきの決済が成立した事実」だけを載せる
// 台帳なので、無料の呼び出しを混ぜると売上の測定が濁る。無料の利用数は
// settings の freehits:<day> にだけ数える（需要の計器）。

import { X402_CATALOG, challenge, preflight, requiredHeader } from './x402.js';
import { ORDER_SPECS, fulfillOrder, validateOrder } from './fulfill.js';

/** 無料枠の対象（カタログの free_tier が唯一の出典。二重記載しない）。 */
export function freeTierResources() {
  return X402_CATALOG.filter((i) => i.free_tier).map((i) => i.resource);
}

/** 無料枠の有無。FREE_TIER_ENABLED=0 で閉じられる。 */
export function freeTierEnabled(env = {}) {
  return String(env.FREE_TIER_ENABLED ?? '1') !== '0';
}

const clampInt = (v, def, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.floor(n)) : def;
};

/** IPごと・UTC日ごとの上限。url-meta は外向き取得があるので別枠（既定5）。 */
export function freeQuotaFor(env = {}, resource = '') {
  const shared = clampInt(env.FREE_DAILY_LIMIT, 25, 100000);
  if (resource === 'url-meta') return Math.min(shared, clampInt(env.FREE_URL_META_DAILY_LIMIT, 5, 100000));
  return shared;
}

/** 数え方の単位。url-meta だけ別の枠にする（それ以外は共有の1枠）。 */
export const freeTierScope = (resource) => (resource === 'url-meta' ? 'url-meta' : 'all');

export const dayKey = (now = new Date()) => now.toISOString().slice(0, 10);

/** 翌UTC 0時（枠が戻る時刻）。人が読める形で返す。 */
export function resetsAt(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return d.toISOString();
}

/** 呼び出し元のIP。Cloudflare が付ける CF-Connecting-IP を最優先にする。 */
export function clientIp(request) {
  const h = request.headers;
  const raw = h.get('CF-Connecting-IP') || h.get('x-real-ip')
    || String(h.get('x-forwarded-for') || '').split(',')[0] || '';
  return String(raw).trim() || 'unknown';
}

/**
 * 1つの文で「加算して、いま何回目か」を返す。同時アクセスでも数え落とさない。
 * D1（SQLite 3.35+）は RETURNING を返すので1往復で済む。返さない環境では
 * 読み→書きへ落とす（無料枠なので数回のズレは許容し、例外は投げない）。
 */
async function bumpCounter(store, key, iso) {
  if (!store || typeof store.first !== 'function') return 1;
  try {
    const r = await store.first(
      `INSERT INTO settings (key,value,updated_at) VALUES (?,'1',?)
       ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT), updated_at=excluded.updated_at
       RETURNING value`,
      key, iso,
    );
    const n = Number(r && r.value);
    if (Number.isFinite(n)) return n;
  } catch { /* RETURNING 非対応・テーブル未作成 → 下へ */ }
  try {
    const cur = await store.first('SELECT value FROM settings WHERE key=?', key);
    const n = (Number(cur && cur.value) || 0) + 1;
    await store.run(
      `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      key, String(n), iso,
    );
    return n;
  } catch { return 1; } // 数えられなくても無料枠は開けておく（fail-open）
}

/**
 * 無料枠を1回消費する。上限を超えたら ok:false（呼び出し側は 402 を返す）。
 * 入力検査を通った後でだけ呼ぶ（不正な入力で枠を減らさない）。
 */
export async function consumeFreeQuota(store, { ip, resource, env = {}, now = new Date() } = {}) {
  const day = dayKey(now);
  const scope = freeTierScope(resource);
  const limit = freeQuotaFor(env, resource);
  const key = `free:${day}:${ip}:${scope}`;
  const used = await bumpCounter(store, key, now.toISOString());
  return { ok: used <= limit, used, limit, remaining: Math.max(0, limit - used), scope, key, day, resets_at: resetsAt(now) };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,payment-signature,x-payment',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-expose-headers': 'PAYMENT-REQUIRED,PAYMENT-RESPONSE,X-FREE-TIER,X-FREE-LIMIT',
};

function jres(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...extra },
  });
}

const NOTES = [
  '無料枠はモデルを使わない決定的な4品目だけです（regex / diff / csv-json / url-meta）。原価がゼロだから成立します。',
  '上限は IPごと・UTC日ごと。url-meta は外向きの取得を伴うので別枠で小さくしています。',
  '上限に達すると 402 を返します。同じ品目を POST /api/x402/<品目> に PAYMENT-SIGNATURE（x402 v2 / USDC）で呼ぶと回数制限なしで使えます。',
  'AI を使う品目（brief / data-clean / code-review）は無料枠の対象外です（原価が売価を食うため）。',
];

/**
 * /api/free と /api/free/<品目> の受け口。
 *   GET  /api/free                  … 一覧・当日の利用数・設定値
 *   GET/POST /api/free/<品目>        … 決定的4品目を無料で実行
 */
export async function handleFree(request, env = {}, url, deps = {}) {
  const origin = url.origin || '';
  const list = freeTierResources();
  const store = deps && deps.store ? deps.store : null;
  const tail = url.pathname.replace(/^\/api\/free\/?/, '').replace(/\/+$/, '');

  // ---- 一覧（人間にも機械にも読める形。当日の利用数＝需要の計器）
  if (!tail) {
    const day = dayKey();
    let hits = null;
    try {
      const row = await store.first("SELECT value FROM settings WHERE key=?", `freehits:${day}`);
      hits = Number(row && row.value) || 0;
    } catch { hits = null; }
    const { INPUT_EXAMPLES, usdLabel } = await import('./x402.js');
    return jres({
      ok: true, enabled: freeTierEnabled(env),
      free_resources: list.map((r) => {
        const item = X402_CATALOG.find((i) => i.resource === r) || {};
        const ex = Object.entries(INPUT_EXAMPLES[r] || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
        return {
          resource: r, url: `${origin}/api/free/${r}`, example_url: `${origin}/api/free/${r}?${ex}`,
          price_if_paid_usdc: Number(usdLabel(item.price_usdc || 0)),
          price_label: `${usdLabel(item.price_usdc || 0)} USDC`,
          paid_url: `${origin}/api/x402/${r}`,
          daily_limit_per_ip: freeQuotaFor(env, r), description: item.description || null,
        };
      }),
      hits_today: hits, resets_at: resetsAt(),
      paid_catalog: `${origin}/.well-known/x402`, discovery: `${origin}/llms.txt`,
      notes: NOTES,
    });
  }

  if (!freeTierEnabled(env)) return jres({ ok: false, error: 'free_tier_disabled', note: 'FREE_TIER_ENABLED=0 のため無料枠は閉じています' }, 503);

  const item = X402_CATALOG.find((i) => i.resource === tail);
  if (!list.includes(tail)) {
    return jres({
      ok: false, error: 'not_free', resource: tail, free_resources: list,
      hint: item ? `この品目は有料です。POST ${origin}/api/x402/${tail} へ PAYMENT-SIGNATURE を添えて呼んでください。` : '未知の品目です。',
      paid_catalog: `${origin}/.well-known/x402`,
    }, 404);
  }

  // 本体（query → body）の順で受け取る。GET でも query だけで完結させる。
  let body = {};
  if (request.method !== 'GET') {
    try { const t = await request.text(); body = t ? JSON.parse(t) : {}; } catch { body = {}; }
  }
  for (const [k, v] of url.searchParams) if (!(k in body)) body[k] = v;

  // 入力が悪いものは、枠を消費する前に、課金もしないで断る（x402 側と同じ規律）。
  const order = validateOrder(tail, body);
  if (!order.ok) {
    return jres({ ok: false, charged: false, free: true, ...order, spec: ORDER_SPECS[tail] || order.spec || null }, 400);
  }

  const ip = clientIp(request);
  const q = await consumeFreeQuota(store, { ip, resource: tail, env });

  if (!q.ok) {
    // 上限に達したら、そのまま有料の値札（402）に切り替える。門を閉じるのではなく開く。
    let chBody = null; let pf = { ok: false };
    try {
      pf = await preflight(env);
      const ch = challenge(tail, env, { origin, feePayer: pf && pf.feePayer, solanaFeePayer: pf && pf.solanaFeePayer, method: request.method });
      chBody = (ch && ch.body) || null;
    } catch { chBody = null; }
    const headers = chBody ? { 'PAYMENT-REQUIRED': requiredHeader(chBody), 'WWW-Authenticate': `X402 realm="${env.AGENT_NAME || 'wealth-agent'}", resource="/api/x402/${tail}"` } : {};
    return jres({
      ok: false, error: 'free_quota_exhausted', resource: tail,
      free: { used: q.used, limit: q.limit, remaining: 0, scope: q.scope, resets_at: q.resets_at },
      paid: {
        resource: tail, url: `${origin}/api/x402/${tail}`,
        price_usdc: item ? item.price_usdc : null,
        how: 'POST 同じ本文に PAYMENT-SIGNATURE ヘッダ（x402 v2 / USDC）を添えて再送。回数制限はありません。',
      },
      challenge: chBody,
    }, 402, headers);
  }

  const done = await fulfillOrder(tail, order.input, deps);
  const inner = done && done.deliverable && typeof done.deliverable === 'object' ? done.deliverable : done;

  // 需要の計器（売上ではない）。当日の呼び出し回数だけを数える。
  if (done && done.ok) bumpCounter(store, `freehits:${q.day}`, new Date().toISOString()).catch(() => {});

  return jres({
    ok: !!done.ok, resource: tail, via: 'free', price_usdc: 0,
    free: { used: q.used, limit: q.limit, remaining: q.remaining, scope: q.scope, resets_at: q.resets_at },
    upgrade: { resource: tail, url: `${origin}/api/x402/${tail}`, note: '無料枠は「IPごと・UTC日ごと」の上限つきです。上限なしで使うなら x402（USDC）で同じ品目を買えます。' },
    result: inner,
    error: (done && done.error) || undefined,
  }, done && done.ok ? 200 : 502, { 'X-FREE-TIER': `${q.used}/${q.limit}`, 'X-FREE-LIMIT': String(q.limit) });
}
