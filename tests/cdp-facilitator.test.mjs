// CDP Facilitator 対応のテスト。
// ・秘密鍵の正規化（32/64byte）
// ・JWT が CDP の仕様どおり（EdDSA / kid / nonce 16桁 / iss cdp / aud / uri / 120秒）
// ・署名が Ed25519 として実際に検証できる（＝送れば通る形になっている）
// ・CDP 非対応チェーンの除外
// ・鍵を入れると自動で CDP に切り替わり、URL 明示が優先されること
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  CDP_FACILITATOR_URL, CDP_CAIP2, isCdpFacilitator, cdpSelected, facilitatorUrl,
  decodeCdpSecret, cdpJwt, facilitatorAuthHeaders, filterNetworksForCdp,
} from '../src/agent/cdp-facilitator.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

// --- 本物の Ed25519 鍵を作り、CDP の secret 形式（seed+pub の 64byte base64）にする ---
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
const seed = pkcs8.subarray(pkcs8.length - 32);
const spki = publicKey.export({ format: 'der', type: 'spki' });
const pub = spki.subarray(spki.length - 32);
const SECRET64 = Buffer.concat([seed, pub]).toString('base64');
const SECRET32 = seed.toString('base64');
const env = { CDP_API_KEY_ID: 'organizations/abc/apiKeys/def', CDP_API_KEY_SECRET: SECRET64 };

// 検証用の公開鍵（raw 32byte → SPKI）
const PUB_DER = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]);
const verifyKey = crypto.createPublicKey({ key: PUB_DER, format: 'der', type: 'spki' });

await t('secret: 64byte は先頭 32byte を seed として使う', () => {
  assert.equal(decodeCdpSecret(SECRET64).length, 32);
  assert.equal(decodeCdpSecret(SECRET64).toString('hex'), seed.toString('hex'));
});
await t('secret: 32byte はそのまま seed', () => {
  assert.equal(decodeCdpSecret(SECRET32).toString('hex'), seed.toString('hex'));
});
await t('secret: 不正な長さは例外', () => {
  assert.throws(() => decodeCdpSecret(Buffer.alloc(17).toString('base64')), /長さが不正/);
});
await t('secret: base64url でも読める', () => {
  const b64 = secret => secret.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(decodeCdpSecret(b64(SECRET32)).toString('hex'), seed.toString('hex'));
});

await t('isCdpFacilitator: CDP だけ true', () => {
  assert.equal(isCdpFacilitator('https://api.cdp.coinbase.com/platform/v2/x402'), true);
  assert.equal(isCdpFacilitator('https://facilitator.payai.network'), false);
  assert.equal(isCdpFacilitator('https://x402.org/facilitator'), false);
  assert.equal(isCdpFacilitator(''), false);
  assert.equal(isCdpFacilitator(null), false);
});

await t('cdpSelected: 鍵を入れるだけで CDP が選ばれる', () => {
  assert.equal(cdpSelected({}), false);
  assert.equal(cdpSelected({ CDP_API_KEY_ID: 'a', CDP_API_KEY_SECRET: 'b' }), true);
  assert.equal(cdpSelected({ X402_FACILITATOR_URL: 'https://facilitator.payai.network' }), false);
  // URL 明示が優先（鍵があっても payai に戻せる）
  assert.equal(cdpSelected({ ...env, X402_FACILITATOR_URL: 'https://facilitator.payai.network' }), false);
});
await t('facilitatorUrl: 鍵ありで URL 未設定なら CDP', () => {
  assert.equal(facilitatorUrl(env), CDP_FACILITATOR_URL);
  assert.equal(facilitatorUrl({}), null);
  assert.equal(facilitatorUrl({ X402_FACILITATOR_URL: 'https://facilitator.payai.network/' }), 'https://facilitator.payai.network');
});

await t('JWT: ヘッダと payload が CDP の仕様どおり', async () => {
  const now = 1_700_000_000;
  const jwt = await cdpJwt({ env, method: 'POST', url: `${CDP_FACILITATOR_URL}/verify`, now });
  const [h, p] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(header.alg, 'EdDSA');
  assert.equal(header.typ, 'JWT');
  assert.equal(header.kid, env.CDP_API_KEY_ID);
  assert.match(header.nonce, /^\d{16}$/);
  assert.equal(payload.sub, env.CDP_API_KEY_ID);
  assert.equal(payload.iss, 'cdp');
  assert.deepEqual(payload.aud, ['cdp_service']);
  assert.equal(payload.nbf, now);
  assert.equal(payload.exp, now + 120);
  assert.equal(payload.uri, 'POST api.cdp.coinbase.com/platform/v2/x402/verify');
});

await t('JWT: 署名が Ed25519 として検証できる', async () => {
  const jwt = await cdpJwt({ env });
  const [h, p, s] = jwt.split('.');
  const ok = crypto.verify(null, Buffer.from(`${h}.${p}`), verifyKey, Buffer.from(s, 'base64url'));
  assert.equal(ok, true);
});

await t('JWT: uri は GET でもメソッドが入る（/supported 用）', async () => {
  const jwt = await cdpJwt({ env, method: 'GET', url: `${CDP_FACILITATOR_URL}/supported` });
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  assert.equal(payload.uri, 'GET api.cdp.coinbase.com/platform/v2/x402/supported');
});

await t('JWT: nonce は毎回変わる', async () => {
  const a = await cdpJwt({ env });
  const b = await cdpJwt({ env });
  assert.notEqual(a, b);
});

await t('JWT: 鍵が無ければ null', async () => {
  assert.equal(await cdpJwt({ env: {} }), null);
  assert.equal(await cdpJwt({ env: { CDP_API_KEY_ID: 'x' } }), null);
});

await t('authHeaders: CDP のときだけ Bearer が付く', async () => {
  const on = await facilitatorAuthHeaders({ env, method: 'POST', url: `${CDP_FACILITATOR_URL}/verify` });
  assert.match(on.authorization, /^Bearer ey/);
  const off = await facilitatorAuthHeaders({ env: {}, method: 'POST', url: `${CDP_FACILITATOR_URL}/verify` });
  assert.deepEqual(off, {});
  // URL が CDP でも鍵が無ければヘッダを付けない（従来動作のまま）
  const noKey = await facilitatorAuthHeaders({ env: { X402_FACILITATOR_URL: CDP_FACILITATOR_URL }, method: 'POST', url: `${CDP_FACILITATOR_URL}/verify` });
  assert.deepEqual(noKey, {});
});

await t('filterNetworksForCdp: 非対応チェーンを落とす', () => {
  const all = [
    { caip2: 'eip155:8453' }, { caip2: 'eip155:137' }, { caip2: 'eip155:42161' },
    { caip2: 'eip155:43114' }, { caip2: 'eip155:1329' }, { caip2: 'eip155:196' },
    { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
  ];
  const kept = filterNetworksForCdp(all, env).map((o) => o.caip2);
  assert.deepEqual(kept, ['eip155:8453', 'eip155:137', 'eip155:42161', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']);
  assert.equal(kept.includes('eip155:43114'), false); // Avalanche は CDP 非対応
  assert.equal(kept.includes('eip155:1329'), false);  // Sei
  assert.equal(kept.includes('eip155:196'), false);   // X Layer
});
await t('filterNetworksForCdp: CDP でなければ素通し', () => {
  const all = [{ caip2: 'eip155:43114' }, { caip2: 'eip155:8453' }];
  assert.deepEqual(filterNetworksForCdp(all, {}).map((o) => o.caip2), ['eip155:43114', 'eip155:8453']);
});
await t('CDP_CAIP2 に Base 本番と Solana 本番が含まれる', () => {
  assert.equal(CDP_CAIP2.has('eip155:8453'), true);
  assert.equal(CDP_CAIP2.has('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), true);
});

console.log(`\n════════ cdp facilitator: ${pass} passed, ${fail} failed ════════`);
process.exit(fail ? 1 : 0);
