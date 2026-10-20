// discwatch.js — 発見面の日次観測（discwatch-1.0）。
//
// 存在理由（実測で確定した障害のため）:
//   我々の商品は CDP Bazaar の索引に存在するのに、一般のキーワード検索で上位20件に入らない
//   （順位は直近30日の呼び出し数と支払者数で決まり、6時間ごとに再計算される）。
//   そして順位は「我々が直せるもの」と「実利用でしか積めないもの」に分かれる。
//   日次で観測して記録しないと、施策の効果が測れず、悪化にも気付けない。
//
// 原則: 売上（receipts）とは別物の需要計器。未測定を推定で埋めない。
//   鍵不要の公開APIだけを使い、原価0で回す。

import { allItems } from './x402.js';

export const DISCWATCH_VERSION = 'discwatch-1.0';
const CDP = 'https://api.cdp.coinbase.com/platform/v2/x402';
const UA = 'WealthAgent/1.0';

/** 説明文の審査: 500字以内（超過は verify/settle が拒否される）＋「指示に読める文言」の排除。
 *  Bazaar はプロンプト注入の恐れがあるメタデータを掲載しない（コンテンツ規律）。 */
const INJECTION = /(you must|you should|please |do not|don't |ignore (all|previous)|system prompt|instructions:|call me|follow these|as an ai)/i;

export function descAudit(env = {}) {
  const items = allItems(env).filter((i) => i && i.resource && i.sellable !== false);
  const rows = [];
  for (const it of items) {
    const d = String(it.description || '');
    const issues = [];
    if (d.length > 500) issues.push(`desc_${d.length}chars_over500`);
    if (INJECTION.test(d)) issues.push('desc_instruction_like');
    if (!d.trim()) issues.push('desc_empty');
    // pay_to / 価格 / ネットワークはカタログ（マニフェスト層）が組み立てる列挙なので、
    // ここでは審査しない（ライブ検証で /.well-known/x402.json が持っていることを確認済み）。
    rows.push({ resource: it.resource, desc_chars: d.length, method: String(it.method || 'POST').toUpperCase(), issues });
  }
  const bad = rows.filter((r) => r.issues.length);
  return { checked: rows.length, ok: rows.length - bad.length, bad, rows };
}

/** CDP の審査（鍵不要）。valid / simulation.outcome / index.active / 最終巡回を返す。 */
export async function cdpValidate(origin, resource, method = 'POST', { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`${CDP}/validate`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ resource: `${origin}/api/x402/${resource}`, method }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    return {
      resource, method,
      valid: j.valid === true,
      outcome: (j.simulation && j.simulation.outcome) || null,
      indexed: !!(j.index && j.index.active === true),
      last_crawled: (j.index && j.index.lastCrawledAt) || null,
    };
  } catch (e) {
    return { resource, method, valid: null, outcome: null, indexed: null, last_crawled: null, error: String((e && e.message) || e).slice(0, 100) };
  }
}

/** 一般語の検索で我々が上位20件に入るか。順位（1始まり）か null。 */
export async function searchRank(origin, query, { fetchImpl = fetch, limit = 20 } = {}) {
  try {
    const r = await fetchImpl(`${CDP}/discovery/search?query=${encodeURIComponent(query)}&limit=${limit}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    const items = j.resources || j.items || [];
    const hit = items.findIndex((x) => String((x && (x.resource || x.url)) || '').includes(origin));
    return { query, rank: hit >= 0 ? hit + 1 : null, scanned: items.length };
  } catch (e) {
    return { query, rank: null, scanned: 0, error: String((e && e.message) || e).slice(0, 100) };
  }
}

/** 日次の実行。settings の discwatch:<日付> に残す。原価0。 */
export async function runDiscWatch(env, store, { origin, now = new Date(), force = false, fetchImpl = fetch } = {}) {
  const day = now.toISOString().slice(0, 10);
  const last = await store.first(`SELECT value FROM settings WHERE key = ? LIMIT 1`, 'discwatch:last_run_on').catch(() => null);
  let lastOn = null;
  try { lastOn = last && last.value ? String(last.value).slice(0, 10) : null; } catch { lastOn = null; }
  if (!force && lastOn === day) return { ok: true, skipped: 'already_ran_today', day };
  const items = allItems(env).filter((i) => i && i.resource && i.sellable !== false);
  const descs = descAudit(env);
  const checks = [];
  for (const it of items) checks.push(await cdpValidate(origin, it.resource, String(it.method || 'POST').toUpperCase(), { fetchImpl }));
  const queries = ['wealth-agent', 'diff text compare', 'crypto price api', 'dns lookup', 'defi tvl', 'time convert timezone'];
  const ranks = [];
  for (const q of queries) ranks.push(await searchRank(origin, q, { fetchImpl }));
  const report = {
    version: DISCWATCH_VERSION, day, at: now.toISOString(),
    products: items.length,
    validate: { accepted: checks.filter((c) => c.outcome === 'accepted').length, indexed: checks.filter((c) => c.indexed).length, invalid: checks.filter((c) => c.valid === false), checked: checks },
    desc_audit: { ok: descs.ok, bad: descs.bad },
    search_ranks: ranks,
    note: 'indexed=CDP索引に掲載済み。rank=一般語検索での順位（null=上位20件に入らない）。順位は直近30日の実利用で6時間ごとに再計算される。',
  };
  try {
    await store.run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)`, `discwatch:${day}`, JSON.stringify(report).slice(0, 90000), now.toISOString());
    await store.run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)`, 'discwatch:last_run_on', day, now.toISOString());
    await store.run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)`, 'discwatch:latest', JSON.stringify(report).slice(0, 90000), now.toISOString());
  } catch { /* 記録できなくても観測自体は返す */ }
  return { ok: true, day, report };
}

/** 保存済みの最新スナップショット。無ければ未測定。 */
export async function discSnapshot(store) {
  const row = await store.first(`SELECT value, updated_at FROM settings WHERE key = 'discwatch:latest' LIMIT 1`).catch(() => null);
  if (!row || !row.value) return { ok: true, measured: false, note: '未測定（discwatch がまだ走っていない）。runDiscWatch を1回実行すれば測れる。' };
  try { return { ok: true, measured: true, snapshot: JSON.parse(row.value), saved_at: row.updated_at }; }
  catch (e) { return { ok: false, error: 'snapshot_parse_failed' }; }
}
