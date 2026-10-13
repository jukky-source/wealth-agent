// x402（④ エージェント同士の市場で売る側）— HTTP 402 で値段を示し、署名つきの支払いを
// 受け取ってから中身を返す、というやり取りを実装する。
//
// 設計上の要点:
//  * 価格はサーバーが提示し、クライアントが選ぶ。こちらから値引きも要求もしない。
//  * 支払いの検証は facilitator（検証・決済の代行）に投げる。**クライアントが付けた
//    ヘッダを信用して中身を返すことは絶対にしない**。
//  * 検証が通った決済だけが receipts に入る。つまり x402 の売上も自己申告ではなく
//    実測として台帳に載る。
//
// 設定（環境変数、いずれも秘密ではない）:
//   X402_PAY_TO          受け取りアドレス（必須。無いと売り物を出さない）
//   X402_NETWORK         base | base-sepolia | solana …（既定 base）
//   X402_FACILITATOR_URL 検証と決済の代行（既定 https://x402.org/facilitator）
//   X402_ASSET           USDC のコントラクト（既定 base USDC）
//   X402_MAX_TIMEOUT     支払いの有効秒数（既定 60）

import { j } from '../util.js';

export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const X402_VERSION = 2;

/** 売り物（エージェントが実際に納品できるもの）。価格は USDC の最小単位（6桁）。 */
export const X402_CATALOG = [
  { resource: 'brief', price_usdc: 1_000_000, description: '調べた内容を出典つきで1枚にまとめた報告（調査1件）', unit: '件' },
  { resource: 'data-clean', price_usdc: 2_000_000, description: '表データの整形・検証（品質チェック結果つき）', unit: '件' },
  { resource: 'code-review', price_usdc: 3_000_000, description: 'コードの問題点と修正案（根拠つき・検証済み）', unit: '件' },
];

const cfg = (env = {}) => ({
  payTo: env.X402_PAY_TO || null,
  network: env.X402_NETWORK || 'base',
  facilitator: env.X402_FACILITATOR_URL || 'https://x402.org/facilitator',
  asset: env.X402_ASSET || USDC_BASE,
  timeout: Number(env.X402_MAX_TIMEOUT || 60),
});

export function x402Enabled(env = {}) { return !!cfg(env).payTo; }

/** 買う側に見せる値札。受け取り先が未設定なら売りに出さない。 */
export function catalog(env = {}) {
  const c = cfg(env);
  return X402_CATALOG.map((it) => ({
    resource: it.resource, description: it.description, unit: it.unit,
    price_usdc: it.price_usdc, price_label: `${(it.price_usdc / 1e6).toFixed(2)} USDC`,
    network: c.network, asset: c.asset, pay_to: c.payTo,
  }));
}

/** 402 で返す値札（x402 v2 の PAYMENT-REQUIRED ヘッダに Base64 で入れる中身）。 */
export function challenge(resource, env = {}, { origin = '' } = {}) {
  const c = cfg(env);
  const item = X402_CATALOG.find((i) => i.resource === resource);
  if (!item) return null;
  if (!c.payTo) return { configured: false, reason: 'X402_PAY_TO が未設定のため、x402 の売り物は出していません' };
  return {
    configured: true,
    body: {
      x402Version: X402_VERSION,
      error: 'payment required',
      accepts: [{
        scheme: 'exact', network: c.network, asset: c.asset, payTo: c.payTo,
        maxAmountRequired: String(item.price_usdc), resource: `${origin}/api/x402/${item.resource}`,
        description: item.description, mimeType: 'application/json', maxTimeoutSeconds: c.timeout,
      }],
    },
  };
}

/**
 * 支払いの検証と決済。facilitator が無い/落ちているときは必ず false を返す
 * （＝中身を渡さない）。クライアントの申告は一切信用しない。
 */
export async function verifyAndSettle({ env = {}, resource, paymentHeader, fetchImpl = fetch } = {}) {
  const c = cfg(env);
  if (!c.payTo) return { ok: false, error: 'not_configured' };
  if (!paymentHeader) return { ok: false, error: 'no_payment' };
  const item = X402_CATALOG.find((i) => i.resource === resource);
  if (!item) return { ok: false, error: 'unknown_resource' };
  let payment;
  try { payment = JSON.parse(Buffer.from(String(paymentHeader), 'base64').toString('utf8')); }
  catch { try { payment = JSON.parse(String(paymentHeader)); } catch { return { ok: false, error: 'bad_payment_payload' }; } }
  const requirements = {
    scheme: 'exact', network: c.network, asset: c.asset, payTo: c.payTo,
    maxAmountRequired: String(item.price_usdc), resource, maxTimeoutSeconds: c.timeout,
  };
  // 1) 値段を下回る支払いを先に弾く（facilitator に渡す前に自前で確認する）
  const amt = Number(payment?.payload?.amount ?? payment?.amount ?? payment?.maxAmountRequired ?? 0);
  if (Number.isFinite(amt) && amt > 0 && amt < item.price_usdc) {
    return { ok: false, error: 'underpaid', required: item.price_usdc, got: amt };
  }
  try {
    const vr = await fetchImpl(`${c.facilitator}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: j({ x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: requirements }),
    });
    const vj = await vr.json().catch(() => ({}));
    if (!vr.ok || vj?.isValid === false || vj?.valid === false) return { ok: false, error: 'invalid', detail: vj };
    const sr = await fetchImpl(`${c.facilitator}/settle`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: j({ x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: requirements }),
    });
    const sj = await sr.json().catch(() => ({}));
    if (!sr.ok || sj?.success === false) return { ok: false, error: 'settle_failed', detail: sj };
    const amount = Number(vj?.amount ?? amt ?? item.price_usdc) || item.price_usdc;
    return {
      ok: true, payer: vj?.payer || sj?.payer || payment?.payload?.from || null,
      amount, currency: 'USDC', fee: 0,
      tx: sj?.transaction || sj?.txHash || sj?.transactionHash || null,
      response: { success: true, network: c.network, transaction: sj?.transaction || sj?.txHash || null, payer: vj?.payer || null },
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
