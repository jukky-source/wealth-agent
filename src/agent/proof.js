// proof.js — 応答の署名と検証。統合者がオフラインで検証できる形で応答を出す。
// 出典: r/AI_Agents の実売り手スレッド（2026-10 調査）——「integrator を決めたのは価格ではなく、
// すべての応答が署名済みでオフライン検証できたこと」。未署名の応答は営業資料にならない。
const enc = new TextEncoder();

async function hmac(env, data) {
  const secret = String(env.X402_SIGNING_KEY || env.OWNER_TOKEN || 'wealth-agent-dev');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const canon = (o) => JSON.stringify(o || null, Object.keys(o || {}).sort());

export async function proofBlock(env, resource, input, output) {
  const at = new Date().toISOString();
  const input_hash = await hmac(env, canon(input));
  const output_hash = await hmac(env, canon(output));
  const sig = await hmac(env, `${resource}|${at}|${input_hash}|${output_hash}`);
  return { v: 1, alg: 'HMAC-SHA256', resource, at, input_hash, output_hash, sig, verify: '/api/verify' };
}

export async function verifyBlock(env, block = {}) {
  try {
    const expect = await hmac(env, `${block.resource}|${block.at}|${block.input_hash}|${block.output_hash}`);
    return { ok: expect === block.sig };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
