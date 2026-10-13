// x402（④ エージェント同士の市場で売る側）— HTTP 402 で値段を示し、署名つきの支払いを
// 受け取ってから中身を返す、というやり取りを実装する。
//
// 設計上の要点:
//  * 価格はサーバーが提示し、クライアントが選ぶ。こちらから値引きも要求もしない。
//  * 支払いの検証は facilitator（検証・決済の代行）に投げる。**クライアントが付けた
//    ヘッダを信用して中身を返すことは絶対にしない**。
//  * 検証が通った決済だけが receipts に入る。つまり x402 の売上も自己申告ではなく
//    実測として台帳に載る。
//  * 売りに出してよいか（受け取り先の形式・ネットワーク・facilitator の対応）を
//    先に確認し、**確認できないものは値札を出さない**。払えない値札は迷惑行為になる。
//  * 決済が「保留」で返ってきたときは中身を渡さない（まだ入金が確定していない）。
//
// 設定（環境変数、いずれも秘密ではない）:
//   X402_PAY_TO           受け取りアドレス（必須。無いと売り物を出さない）
//   X402_NETWORK          base | base-sepolia | polygon | avalanche | solana | solana-devnet |
//                         eip155:<chainId> | solana:<genesisHash>（既定 base）
//   X402_FACILITATOR_URL  検証と決済の代行（既定 https://x402.org/facilitator）
//   X402_ASSET            USDC のコントラクト/ミント（既定は上記ネットワークの USDC）
//   X402_FEE_PAYER        Solana の手数料肩代わりアドレス（未設定なら facilitator に問い合わせる）
//   X402_MAX_TIMEOUT      支払いの有効秒数（既定 60）
//
// ネットワーク識別子は x402 v2 の CAIP-2 表記（例 eip155:8453 / solana:5eykt4Us…）で出す。
// v1 の短い名前は入力として受け取り、正規化して出す。

import { j } from '../util.js';

export const X402_VERSION = 2;
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/**
 * 対応ネットワークの表。CAIP-2 識別子と既定トークン（すべて USDC、桁数は 6）。
 * 出典: x402 公式ドキュメント「Network Identifiers (CAIP-2)」の既定アセット表。
 */
export const NETWORKS = {
  base: { caip2: 'eip155:8453', family: 'evm', asset: USDC_BASE, label: 'Base' },
  'base-sepolia': { caip2: 'eip155:84532', family: 'evm', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', label: 'Base Sepolia' },
  polygon: { caip2: 'eip155:137', family: 'evm', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', label: 'Polygon' },
  avalanche: { caip2: 'eip155:43114', family: 'evm', asset: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', label: 'Avalanche' },
  solana: { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', family: 'svm', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', label: 'Solana' },
  'solana-devnet': { caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', family: 'svm', asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', label: 'Solana Devnet' },
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** EVM アドレス（0x + 40 桁の16進）。 */
export function isEvmAddress(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
}

/** Solana の公開鍵（base58、デコードして32バイトになるものだけ通す）。 */
export function isSolanaAddress(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return false;
    n = n * 58n + BigInt(i);
  }
  let bytes = 0;
  while (n > 0n) { n /= 256n; bytes += 1; }
  const leading = (s.match(/^1+/) || [''])[0].length;
  return leading + bytes === 32;
}

/** 名前でも CAIP-2 表記でも受け取り、表の形に正規化する。未知なら null。 */
export function resolveNetwork(name) {
  if (!name) return NETWORKS.base;
  const s = String(name).trim();
  if (NETWORKS[s]) return NETWORKS[s];
  for (const v of Object.values(NETWORKS)) if (v.caip2 === s) return v;
  if (/^eip155:\d+$/.test(s)) return { caip2: s, family: 'evm', asset: null, label: s };
  if (/^solana:/.test(s)) return { caip2: s, family: 'svm', asset: null, label: s };
  return null;
}

/** アドレスがそのネットワークの形式かどうか。 */
export const addressMatches = (addr, family) =>
  family === 'svm' ? isSolanaAddress(addr) : isEvmAddress(addr);

const cfg = (env = {}) => {
  const net = resolveNetwork(env.X402_NETWORK);
  return {
    payTo: env.X402_PAY_TO || null,
    networkRaw: env.X402_NETWORK || 'base',
    net,
    caip2: net?.caip2 || null,
    family: net?.family || null,
    asset: env.X402_ASSET || net?.asset || null,
    facilitator: String(env.X402_FACILITATOR_URL || 'https://x402.org/facilitator').replace(/\/+$/, ''),
    feePayer: env.X402_FEE_PAYER || null,
    timeout: Number(env.X402_MAX_TIMEOUT || 60),
  };
};

/** 受け取り先が設定され、かつそのネットワークの形式になっているか。 */
export function x402Enabled(env = {}) {
  const c = cfg(env);
  return !!c.payTo && !!c.family && !!c.asset && addressMatches(c.payTo, c.family);
}

/** 売り物（エージェントが実際に納品できるもの）。価格は USDC の最小単位（6桁）。 */
export const X402_CATALOG = [
  { resource: 'brief', price_usdc: 1_000_000, description: '調べた内容を出典つきで1枚にまとめた報告（調査1件）', unit: '件' },
  { resource: 'data-clean', price_usdc: 2_000_000, description: '表データの整形・検証（品質チェック結果つき）', unit: '件' },
  { resource: 'code-review', price_usdc: 3_000_000, description: 'コードの問題点と修正案（根拠つき・検証済み）', unit: '件' },
];

/** 買う側に見せる値札。売れない状態なら理由も返す（隠さない）。 */
export function catalog(env = {}) {
  const c = cfg(env);
  const why = !c.payTo ? 'X402_PAY_TO が未設定'
    : !c.family ? 'X402_NETWORK が未知'
      : !addressMatches(c.payTo, c.family) ? `受け取り先が ${c.net?.label || c.family} の形式ではありません`
        : null;
  return X402_CATALOG.map((it) => ({
    resource: it.resource, description: it.description, unit: it.unit,
    price_usdc: it.price_usdc, price_label: `${(it.price_usdc / 1e6).toFixed(2)} USDC`,
    network: c.caip2, network_name: c.net?.label || null, family: c.family, asset: c.asset,
    pay_to: c.payTo, sellable: x402Enabled(env), blocked_reason: why,
  }));
}

// ---------------------------------------------------------------- facilitator への問い合わせ
// /supported は「この facilitator が exact をどのネットワークで扱えるか」を返す。
// 応答の形は実装ごとに揺れるので、木をたどって (scheme, network) の組を探す。
const supportedCache = new Map(); // facilitator URL -> { at, kinds }
const SUPPORTED_TTL_MS = 5 * 60 * 1000;

function collectKinds(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const v of node) collectKinds(v, out); return out; }
  if (typeof node.scheme === 'string' && typeof node.network === 'string') out.push(node);
  for (const v of Object.values(node)) collectKinds(v, out);
  return out;
}

/** facilitator が扱える (scheme, network) の一覧を取り出す（取れなければ null）。 */
export async function supportedKinds({ env = {}, fetchImpl = fetch, useCache = true } = {}) {
  const c = cfg(env);
  const hit = useCache ? supportedCache.get(c.facilitator) : null;
  if (hit && Date.now() - hit.at < SUPPORTED_TTL_MS) return hit.kinds;
  try {
    const r = await fetchImpl(`${c.facilitator}/supported`, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const body = await r.json().catch(() => null);
    if (!body) return null;
    const kinds = collectKinds(body);
    if (useCache) supportedCache.set(c.facilitator, { at: Date.now(), kinds });
    return kinds;
  } catch { return null; }
}

const pickFeePayer = (kind) =>
  kind?.extra?.feePayer || kind?.feePayer || (Array.isArray(kind?.extra?.signers) ? kind.extra.signers[0] : null) || null;

/**
 * 売りに出してよいかの事前確認。1つでも欠けたら値札を出さない。
 *   not_configured       受け取り先が未設定
 *   payto_network_mismatch 受け取り先の形式がネットワークと違う（例: Solana に 0x…）
 *   facilitator_unreachable /supported が取れない
 *   facilitator_unsupported この facilitator が (exact, ネットワーク) を扱えない
 *   fee_payer_unavailable Solana なのに手数料肩代わりアドレスが分からない
 */
export async function preflight(env = {}, { fetchImpl = fetch, useCache = true } = {}) {
  const c = cfg(env);
  if (!c.payTo) return { ok: false, error: 'not_configured', reason: 'X402_PAY_TO が未設定のため、x402 の売り物は出していません' };
  if (!c.family) return { ok: false, error: 'unknown_network', reason: `X402_NETWORK=${c.networkRaw} を解釈できません` };
  if (!addressMatches(c.payTo, c.family)) {
    return {
      ok: false, error: 'payto_network_mismatch',
      reason: `受け取り先が ${c.net?.label || c.family} の形式ではありません（${c.family === 'svm' ? 'base58 の公開鍵' : '0x + 40桁'} が必要）。売りに出しません`,
    };
  }
  if (!c.asset) return { ok: false, error: 'no_asset', reason: 'USDC のコントラクト/ミントが不明です（X402_ASSET を設定してください）' };
  const kinds = await supportedKinds({ env, fetchImpl, useCache });
  if (!kinds) return { ok: false, error: 'facilitator_unreachable', reason: `${c.facilitator}/supported を確認できないため、値札を出しません` };
  const kind = kinds.find((k) => k.scheme === 'exact' && (k.network === c.caip2 || k.network === c.networkRaw));
  if (!kind) return { ok: false, error: 'facilitator_unsupported', reason: `この facilitator は exact / ${c.caip2} を扱っていません` };
  let feePayer = c.feePayer || pickFeePayer(kind);
  if (c.family === 'svm') {
    if (!feePayer) return { ok: false, error: 'fee_payer_unavailable', reason: 'Solana は手数料肩代わり（feePayer）の提示が必須です。facilitator が返していないため値札を出しません' };
    if (!isSolanaAddress(feePayer)) return { ok: false, error: 'fee_payer_invalid', reason: `X402_FEE_PAYER が base58 の公開鍵ではありません` };
  } else {
    feePayer = null; // EVM では EIP-3009 の署名で足りるため不要
  }
  return { ok: true, caip2: c.caip2, family: c.family, asset: c.asset, feePayer, network_name: c.net?.label || null };
}

/** 402 で返す値札（v2 の PAYMENT-REQUIRED ヘッダに Base64 で入れる中身）。 */
export function challenge(resource, env = {}, { origin = '', feePayer = null } = {}) {
  const c = cfg(env);
  const item = X402_CATALOG.find((i) => i.resource === resource);
  if (!item) return null;
  if (!c.payTo) return { configured: false, reason: 'X402_PAY_TO が未設定のため、x402 の売り物は出していません' };
  if (!c.family) return { configured: false, reason: `X402_NETWORK=${c.networkRaw} を解釈できません` };
  if (!addressMatches(c.payTo, c.family)) return { configured: false, reason: '受け取り先の形式がネットワークと一致しません' };
  const fp = feePayer || c.feePayer;
  if (c.family === 'svm' && !isSolanaAddress(fp)) {
    return { configured: false, reason: 'Solana は feePayer の提示が必須です（facilitator から取得できていません）' };
  }
  const accepts = {
    scheme: 'exact', network: c.caip2, asset: c.asset, payTo: c.payTo,
    // v2 の正式名は amount（最小単位）。v1 名も併記して古い facilitator でも読めるようにする。
    amount: String(item.price_usdc),
    maxAmountRequired: String(item.price_usdc),
    resource: `${origin}/api/x402/${item.resource}`,
    description: item.description, mimeType: 'application/json', maxTimeoutSeconds: c.timeout,
  };
  if (fp) accepts.extra = { feePayer: fp };
  return {
    configured: true,
    body: {
      x402Version: X402_VERSION,
      error: 'payment required',
      resource: { url: `${origin}/api/x402/${item.resource}`, description: item.description, mimeType: 'application/json' },
      accepts: [accepts],
    },
  };
}

/**
 * 支払いの検証と決済。facilitator が無い/落ちているときは必ず false を返す
 * （＝中身を渡さない）。クライアントの申告は一切信用しない。
 */
export async function verifyAndSettle({ env = {}, resource, paymentHeader, fetchImpl = fetch, feePayer = null } = {}) {
  const c = cfg(env);
  if (!c.payTo) return { ok: false, error: 'not_configured' };
  if (!paymentHeader) return { ok: false, error: 'no_payment' };
  const item = X402_CATALOG.find((i) => i.resource === resource);
  if (!item) return { ok: false, error: 'unknown_resource' };
  let payment;
  try { payment = JSON.parse(Buffer.from(String(paymentHeader), 'base64').toString('utf8')); }
  catch { try { payment = JSON.parse(String(paymentHeader)); } catch { return { ok: false, error: 'bad_payment_payload' }; } }

  const requirements = {
    scheme: 'exact', network: c.caip2, asset: c.asset, payTo: c.payTo,
    amount: String(item.price_usdc), maxAmountRequired: String(item.price_usdc),
    resource, maxTimeoutSeconds: c.timeout,
  };
  const fp = feePayer || c.feePayer;
  if (fp) requirements.extra = { feePayer: fp };

  // 1) 値段を下回る支払いを先に弾く。読める形のときだけ自前で確認する
  //    （Solana のペイロードは base64 の取引そのもので、金額は facilitator しか判定できない）。
  const amt = Number(
    payment?.payload?.authorization?.value        // EVM: EIP-3009
    ?? payment?.accepted?.amount ?? payment?.payload?.amount ?? payment?.amount
    ?? 0,
  );
  const readableAmount = Number.isFinite(amt) && amt > 0;
  if (readableAmount && amt < item.price_usdc) {
    return { ok: false, error: 'underpaid', required: item.price_usdc, got: amt };
  }
  try {
    const post = async (path) => {
      const r = await fetchImpl(`${c.facilitator}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: j({ x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: requirements }),
      });
      const body = await r.json().catch(() => ({}));
      return { r, body };
    };
    const { r: vr, body: vj } = await post('/verify');
    if (!vr.ok || vj?.isValid === false || vj?.valid === false) {
      return { ok: false, error: 'invalid', detail: vj?.errorReason || vj?.invalidReason || vj };
    }
    const { r: sr, body: sj } = await post('/settle');
    // 保留（ブロードキャスト済み・未確定）は成功でも失敗でもない。中身は渡さず、二重計上もしない。
    if (sj?.errorReason === 'settlement_pending' || sj?.error === 'settlement_pending') {
      return { ok: false, error: 'settlement_pending', tx: sj?.transaction || null, note: '決済が保留です。確定を確認するまで中身は渡しません' };
    }
    if (!sr.ok || sj?.success === false) {
      return { ok: false, error: 'settle_failed', detail: sj?.errorReason || sj };
    }
    const amount = Number(vj?.amount ?? (readableAmount ? amt : item.price_usdc)) || item.price_usdc;
    return {
      ok: true, payer: vj?.payer || sj?.payer || payment?.payload?.authorization?.from || null,
      // Solana の payer は手数料を肩代わりしたアカウント（買い手とは限らない）。
      payer_role: c.family === 'svm' ? 'fee_payer' : 'buyer',
      amount, currency: 'USDC', fee: 0,
      tx: sj?.transaction || null,
      response: {
        success: true, network: c.caip2, transaction: sj?.transaction || null,
        payer: vj?.payer || sj?.payer || null,
      },
    };
  } catch (e) {
    return { ok: false, error: 'facilitator_unreachable', detail: String(e?.message || e) };
  }
}

/** PAYMENT-RESPONSE ヘッダ（Base64）。 */
export const responseHeader = (obj) => Buffer.from(j(obj)).toString('base64');
/** 402 の値札ヘッダ（Base64）。 */
export const requiredHeader = (obj) => Buffer.from(j(obj)).toString('base64');

/** facilitator からの非同期通知を、そのまま入金として扱える形に整える。 */
export function receiptFromCallback(body = {}) {
  const b = body || {};
  const raw = Number(b.amount ?? b.maxAmountRequired ?? b.value ?? 0);
  const currency = String(b.currency || 'USDC').toUpperCase();
  const amount = currency === 'USDC' ? Number((raw / 1e6).toFixed(6)) : raw;  // 最小単位→表示単位
  return {
    source: 'x402',
    external_id: String(b.transaction || b.txHash || b.id || b.paymentId || ''),
    amount, currency,
    fee: Number(b.fee || 0),
    payer: b.payer || b.from || null,
    job_id: b.job_id || b.jobId || null,
    thread_id: b.thread_id || b.threadId || null,
    occurred_on: b.occurred_on || null,
    raw: b,
  };
}
