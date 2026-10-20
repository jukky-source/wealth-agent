// attribution.js — 販路帰属（どの売り場が買い手を連れてきたかを決済の行に残す）。
//
// 存在理由（実測で必要になった）:
//   receipts.source が 'x402' の一言だったため「どの販路の売上か」を永久に測れず、
//   KPI でも『未測定』のままだった。掲載URLに ?venue=<id> を付け、決済時に
//   x402:<venue>:<resource> として残せば、販路別・商品別の売上を後から分解できる。
//
// 方針: 来た値をそのまま信用しない（誰でも付けられる）。記号 [a-z0-9_-] 32字までに正規化し、
//   不正な値は 'direct'（帰属不明）として扱う。推測で埋めない。
export const VENUE_NONE = 'direct';
const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** リクエストから販路IDを取り出す（?venue= / ?v= / ?ref= / X-WA-Venue）。無ければ 'direct'。 */
export function venueFromRequest(request, url) {
  let v = null;
  try { if (url && url.searchParams) v = url.searchParams.get('venue') || url.searchParams.get('v') || url.searchParams.get('ref'); } catch { v = null; }
  if (!v && request && request.headers) v = request.headers.get('x-wa-venue');
  const s = String(v || '').trim().toLowerCase();
  return SLUG.test(s) ? s : VENUE_NONE;
}

/** 決済行の source タグ。販路と商品を1つの文字列に載せる（後から分解できる形）。 */
export function sourceTag(venue, resource) {
  const v = SLUG.test(String(venue || '').trim().toLowerCase()) ? String(venue).trim().toLowerCase() : VENUE_NONE;
  const r = String(resource || 'unknown').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 64) || 'unknown';
  return `x402:${v}:${r}`;
}

/** source タグを分解する。旧形式 'x402'（販路不明）も壊さず読む。 */
export function parseSource(source) {
  const s = String(source || '');
  const m = /^([a-z_][a-z0-9_]*):([a-z0-9_-]{1,32}):(.+)$/i.exec(s);
  if (m) return { channel: m[1].toLowerCase(), venue: m[2].toLowerCase(), resource: m[3], tagged: true };
  const m2 = /^([a-z_][a-z0-9_]*):(.+)$/i.exec(s);
  if (m2) return { channel: m2[1].toLowerCase(), venue: 'unknown', resource: m2[2], tagged: false };
  return { channel: s || 'unknown', venue: null, resource: null, tagged: false };
}

/** 掲載用のURLに販路を焼き込む。販路が不明なら何も付けない（帰属不明＝direct のまま）。
 *  販路に提出する掲載 payload は必ずこれを通す（掲載後に売上がどの販路から来たか分解できる）。 */
export function venueUrl(origin, resource, venue) {
  const v = SLUG.test(String(venue || '').trim().toLowerCase()) ? String(venue).trim().toLowerCase() : null;
  const base = `${String(origin || '').replace(/\/+$/, '')}/api/x402/${String(resource || '')}`;
  return v ? `${base}?venue=${v}` : base;
}
