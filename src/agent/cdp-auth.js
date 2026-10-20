// CDP Secret API Key -> Bearer JWT (EdDSA / Ed25519) for the CDP x402 Facilitator.
//
// Shape verified against docs.cdp.coinbase.com/api-reference/v2/authentication
//   header : { alg:"EdDSA", typ:"JWT", kid:<keyId>, nonce:<hex16> }
//   claims : { sub:<keyId>, iss:"cdp", aud:["cdp_service"], nbf, exp,
//              uri:"<METHOD> <host><path>" }
//   secret : base64(seed32 || pubkey32)  -> decodes to exactly 64 bytes
// Tokens are valid for 2 minutes by default (CDP docs).
//
// Cloudflare Workers supports standard Ed25519 importKey/sign ("Secure Curves"),
// but only via pkcs8 for private keys, so the 32-byte seed is wrapped in a
// PKCS#8 Ed25519 envelope before import.

const PKCS8_ED25519 = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

const TE = new TextEncoder();

function b64bytes(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex16() {
  const r = crypto.getRandomValues(new Uint8Array(16));
  return [...r].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// CDP key secret -> CryptoKey (cached per keyId)
export async function importCdpKey(keyId, keySecret) {
  const raw = b64bytes(keySecret);
  if (raw.length !== 64) {
    throw new Error('cdp secret must decode to 64 bytes (32 seed + 32 public), got ' + raw.length);
  }
  const pkcs8 = new Uint8Array(PKCS8_ED25519.length + 32);
  pkcs8.set(PKCS8_ED25519, 0);
  pkcs8.set(raw.subarray(0, 32), PKCS8_ED25519.length);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

export async function cdpBearer({ keyId, keySecret, method, host, path, expiresIn = 120, audience = ['cdp_service'] }) {
  if (!keyId || !keySecret) throw new Error('cdp credentials missing');
  const key = await importCdpKey(keyId, keySecret);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT', kid: keyId, nonce: hex16() };
  // Claim names mirror @coinbase/cdp-sdk auth/utils/jwt.js exactly:
  //   claims.uris is an ARRAY of "<METHOD> <host><path>" (not a scalar `uri`),
  //   and iat/nbf/exp are emitted alongside sub/iss/aud.
  const claims = {
    sub: keyId,
    iss: 'cdp',
    aud: audience,
    uris: [`${String(method).toUpperCase()} ${host}${path}`],
    iat: now,
    nbf: now,
    exp: now + expiresIn,
  };
  const signingInput =
    b64url(TE.encode(JSON.stringify(header))) + '.' + b64url(TE.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('Ed25519', key, TE.encode(signingInput));
  return signingInput + '.' + b64url(new Uint8Array(sig));
}

// fetch() against api.cdp.coinbase.com with a fresh Bearer JWT attached.
export async function cdpFetch(url, init = {}, creds = {}) {
  const u = new URL(url);
  const jwt = await cdpBearer({
    keyId: creds.keyId,
    keySecret: creds.keySecret,
    method: init.method || 'GET',
    host: u.host,
    path: u.pathname + u.search,
    audience: creds.audience,
  });
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', 'Bearer ' + jwt);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(url, { ...init, headers });
}

export const CDP_FACILITATOR_BASE = 'https://api.cdp.coinbase.com/platform/v2/x402';
