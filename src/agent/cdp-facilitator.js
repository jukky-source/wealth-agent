// CDP Facilitator（Coinbase）対応。
//
// なぜ必要か: x402 Bazaar への索引は「CDP Facilitator 経由で決済が1件成立すること」が
// 唯一の条件で、登録フォームも別 API も存在しない（CDP 公式ドキュメント）。
// つまり facilitator を CDP にしない限り、メタデータをどれだけ磨いても Bazaar には出ない。
//
// 認証: CDP API キー（ID + 秘密鍵）。秘密鍵は Ed25519 で、base64 デコードして 64byte
// （32byte seed + 32byte 公開鍵）または 32byte。JWT は EdDSA。
//
// ネットワーク: CDP が扱えるのは Base / Base Sepolia / Polygon / Arbitrum / Monad /
// World / World Sepolia / Solana のみ。Avalanche(43114) / Sei(1329) / X Layer(196) は
// 非対応なので、CDP 使用時は値札から外す（払えない選択肢を買い手に掴ませない）。
//
// 鍵が無いときは何も付けず素のまま返す。既存の facilitator（payai）はそのまま動く。

export const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

/** CDP Facilitator が決済できる CAIP-2（公式の対応表より）。 */
export const CDP_CAIP2 = new Set([
  'eip155:8453',   // Base
  'eip155:84532',  // Base Sepolia
  'eip155:137',    // Polygon
  'eip155:42161',  // Arbitrum
  'eip155:143',    // Monad
  'eip155:480',    // World
  'eip155:4801',   // World Sepolia
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
]);

export function isCdpFacilitator(url) {
  return /(^|\.)cdp\.coinbase\.com$/i.test(String(url || '')) || /api\.cdp\.coinbase\.com/i.test(String(url || ''));
}

/**
 * CDP を使う設定か。
 *   X402_FACILITATOR_URL が CDP を指していれば true。
 *   未設定でも CDP の鍵が揃っていれば true（＝鍵を入れるだけで切り替わる）。
 *   URL を明示していればそれが優先（payai に戻したいときは URL を書く）。
 */
export function cdpSelected(env = {}) {
  const explicit = String(env.X402_FACILITATOR_URL || '').trim();
  if (explicit) return isCdpFacilitator(explicit);
  return !!(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
}

/** 使う facilitator の URL。null なら呼び出し側の既定（payai 等）に任せる。 */
export function facilitatorUrl(env = {}) {
  const explicit = String(env.X402_FACILITATOR_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  if (cdpSelected(env)) return CDP_FACILITATOR_URL;
  return null;
}

// ---------------------------------------------------------------- JWT（EdDSA / Ed25519）

const b64u = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64uJson = (obj) => b64u(Buffer.from(JSON.stringify(obj), 'utf8'));

// Ed25519 の PKCS#8 ヘッダ。seed(32byte) の前に付けるだけで秘密鍵として読める。
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** CDP の秘密鍵を素の 32byte seed に正規化する。 */
export function decodeCdpSecret(secret) {
  const s = String(secret || '').trim();
  if (!s) throw new Error('CDP_API_KEY_SECRET が空です');
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf.length === 64) return buf.subarray(0, 32); // seed + 公開鍵
  if (buf.length === 32) return buf;                 // seed のみ
  throw new Error(`CDP_API_KEY_SECRET の長さが不正です（${buf.length} bytes / 32 か 64 が必要）`);
}

/** 16バイトを hex 化した nonce。公式 SDK（auth/utils/jwt.js）と同じ形。 */
function makeNonce(cryptoImpl) {
  const b = new Uint8Array(16);
  cryptoImpl.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * CDP 用の JWT を作る。鍵が無ければ null。
 * uri は「METHOD host path」の形（例: "POST api.cdp.coinbase.com/platform/v2/x402/verify"）。
 */
export async function cdpJwt({
  env = {}, method = 'POST', url = `${CDP_FACILITATOR_URL}/verify`,
  now = Math.floor(Date.now() / 1000), nonce = null, cryptoImpl = globalThis.crypto,
} = {}) {
  const keyId = String(env.CDP_API_KEY_ID || '').trim();
  const secret = env.CDP_API_KEY_SECRET;
  if (!keyId || !secret) return null;
  if (!cryptoImpl?.subtle) throw new Error('WebCrypto が使えません');

  const u = new URL(url);
  const uri = `${String(method).toUpperCase()} ${u.host}${u.pathname}`;
  const n = nonce || makeNonce(cryptoImpl);

  const header = { alg: 'EdDSA', typ: 'JWT', kid: keyId, nonce: n };
  // 公式 SDK は `uris`（配列）を出し、iat/nbf/exp を揃える。単数の `uri` は受け付けられない。
  const payload = {
    sub: keyId, iss: 'cdp', aud: ['cdp_service'],
    uris: [uri], iat: now, nbf: now, exp: now + 120,
  };
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;

  const seed = decodeCdpSecret(secret);
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const key = await cryptoImpl.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const sig = new Uint8Array(await cryptoImpl.subtle.sign({ name: 'Ed25519' }, key, Buffer.from(signingInput, 'utf8')));
  return `${signingInput}.${b64u(sig)}`;
}

/** facilitator 呼び出しに付けるヘッダ。CDP でない、または鍵が無いときは空。 */
export async function facilitatorAuthHeaders({ env = {}, method = 'POST', url, cryptoImpl } = {}) {
  if (!cdpSelected(env)) return {};
  if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) return {}; // 鍵が無ければ素のまま（従来動作）
  const jwt = await cdpJwt({ env, method, url, cryptoImpl });
  return jwt ? { authorization: `Bearer ${jwt}` } : {};
}

/** CDP 使用時、CDP が扱えないチェーンを値札から落とす。 */
export function filterNetworksForCdp(options = [], env = {}) {
  if (!cdpSelected(env)) return options;
  return options.filter((o) => CDP_CAIP2.has(o.caip2));
}
