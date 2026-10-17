// 端末の再ペアリング — 恒久的な合言葉を人に見せずに、端末へトークンを渡し直す仕組み。
//
// なぜ要るのか:
//   OWNER_TOKEN は Worker の secret で、Cloudflare からも読み出せない（書き込み専用）。
//   いま端末のトークンが古くなると、人がダッシュボードで secret を作り直すしかなかった。
//   代わりに「期限つき・1回だけ有効なコード」を発行し、コードを持つ端末にだけ
//   トークンを渡す。コードは使い捨てなので、会話に残っても価値が減衰する。
//
// 守っている線:
//   * コードは 30 分で失効し、1回使うと消える
//   * 3回間違えたら無効化する（総当たりを成立させない）
//   * 発行できるのは正しいトークンを持っている人だけ（/api/owner/pair-code は認証必須）
//   * トークン未設定のときはコードを消費しない（設定が入るまで使える）

import { nowIso, j, safeJson, round } from '../util.js';

export const PAIR_KEY = 'owner:pair';
export const PAIR_TTL_MS = 30 * 60 * 1000;
export const PAIR_MAX_TRIES = 3;

// 紛らわしい文字（0/O、1/I/L）を除く。口頭や手入力で写し間違えないため。
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

export function generateCode(rnd = Math.random) {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** 入力を「区切りも大小も無視した形」に均す（人が見ながら打ち直す前提）。 */
export function normalizeCode(input) {
  return String(input == null ? '' : input).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 比較は平文でなくハッシュで行う（保存側に平文を残さない）。 */
export async function hashCode(code) {
  const norm = normalizeCode(code);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`wa-pair:v1:${norm}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function load(store) {
  const row = await store.first(`SELECT value FROM settings WHERE key=?`, PAIR_KEY).catch(() => null);
  return safeJson(row?.value, null);
}

async function save(store, rec, at) {
  await store.run(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    PAIR_KEY, j(rec), at,
  );
}

async function clear(store) {
  await store.run(`DELETE FROM settings WHERE key=?`, PAIR_KEY).catch(() => {});
}

/** 新しいコードを発行する。平文のコードはこの戻り値にしか現れない。 */
export async function mintPairing(store, { ttlMs = PAIR_TTL_MS, now = null, rnd = Math.random } = {}) {
  const at = now || nowIso();
  const code = generateCode(rnd);
  const exp = Date.parse(at) + ttlMs;
  await save(store, { hash: await hashCode(code), exp, tries: 0, at }, at);
  return { code, expires_at: new Date(exp).toISOString(), ttl_minutes: Math.round(ttlMs / 60000) };
}

/** いまペアリングを受け付けているか（人に見せる用。コードは返さない）。 */
export async function pairState(store, now = null) {
  const at = Date.parse(now || nowIso());
  const rec = await load(store);
  if (!rec || !rec.hash) return { open: false, reason: 'no_pairing' };
  const left = Number(rec.exp || 0) - at;
  if (left <= 0) return { open: false, reason: 'expired' };
  return {
    open: true,
    expires_at: new Date(Number(rec.exp)).toISOString(),
    minutes_left: Math.max(0, Math.floor(left / 60000)),
    tries_left: Math.max(0, PAIR_MAX_TRIES - Number(rec.tries || 0)),
  };
}

/**
 * コードを引き換えてトークンを返す。成功したらコードは消える（1回だけ有効）。
 * token が未設定のときはコードを消費せずに失敗する（設定前の空振りでコードを失わない）。
 */
export async function redeemPairing(store, input, { token = null, now = null } = {}) {
  const at = now || nowIso();
  const rec = await load(store);
  if (!rec || !rec.hash) return { ok: false, error: 'no_pairing_open', hint: 'サーバー側でコードを発行してください。' };
  if (Number(rec.exp || 0) - Date.parse(at) <= 0) return { ok: false, error: 'expired', hint: 'コードの期限が切れています。新しく発行してください。' };

  const tries = Number(rec.tries || 0);
  if (tries >= PAIR_MAX_TRIES) { await clear(store); return { ok: false, error: 'too_many_tries', hint: 'コードを無効にしました。新しく発行してください。' }; }

  const given = await hashCode(input);
  if (given !== rec.hash) {
    const next = tries + 1;
    if (next >= PAIR_MAX_TRIES) {
      await clear(store);
      return { ok: false, error: 'too_many_tries', hint: '何度も間違えたためコードを無効にしました。新しく発行してください。' };
    }
    await save(store, { ...rec, tries: next }, at);
    return { ok: false, error: 'bad_code', tries_left: PAIR_MAX_TRIES - next, hint: 'コードが違います。' };
  }

  if (!token) return { ok: false, error: 'token_not_configured', hint: 'サーバーに OWNER_TOKEN が設定されていません（ローカル動作では不要です）。' };

  await clear(store);
  return { ok: true, token, note: 'この端末に保存しました。以降は自動でつながります。' };
}

export function pairingHelp() {
  return [
    '端末のトークンが古くなったときに、secret を作り直さずに接続し直すための仕組みです。',
    `サーバー側でコードを発行し（有効 ${round(PAIR_TTL_MS / 60000, 0)} 分）、アプリの「設定」→「この端末をつなぐ」に入れると、その端末だけ接続が戻ります。`,
    'コードは1回使うと消え、3回間違えると無効になります。トークンそのものは画面に出ません。',
  ].join('\n\n');
}
