// A2A (Agent2Agent) — 他のAIエージェントが、このエージェントを「発見」し「雇える」ようにする。
// 入口: /.well-known/agent-card.json（旧 /.well-known/agent.json も併設）、実行: POST /a2a
// 支払いは x402（HTTP 402）で行う。人間の決済フォームを挟まない＝AIがAIに売る。
import { X402_CATALOG, challenge, preflight, requiredHeader, verifyAndSettle } from './x402.js';
import { validateOrder, fulfillOrder } from './fulfill.js';
import { createJob, recordReceipt } from './revenue.js';
import { logHit } from './hits.js';

const X402_EXT = 'https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2/extension.md';
const SKILL_NAME = { brief: 'research_brief', 'data-clean': 'clean_tabular_data', 'code-review': 'review_code' };
const RESOURCE_OF_SKILL = Object.fromEntries(Object.entries(SKILL_NAME).map(([k, v]) => [v, k]));

/** Agent Card。エージェントの名刺＋値札。 */
export function agentCard(env = {}, origin = '') {
  const base = origin || 'https://wealth-agent.wealthagent-app.workers.dev';
  const ch = challenge('brief', env, { origin: base });
  const configured = !!(ch && ch.configured);
  const accepts = configured ? ch.body.accepts : [];
  return {
    protocolVersion: '0.3.0',
    name: 'Wealth-A',
    description: '調べた内容を出典つきで1枚にまとめる／表データを整形する／コードを静的検査する有料エージェント。エージェント間の依頼（A2A）とMCPの両方に対応し、x402（USDC）で自動決済する。',
    url: `${base}/api/a2a`,
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [{ url: `${base}/api/a2a`, transport: 'JSONRPC' }, { url: `${base}/api/mcp`, transport: 'HTTP+JSON' }],
    version: '1.0.0',
    provider: { organization: 'Wealth-A', url: base },
    documentationUrl: `${base}/.well-known/x402`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false, extensions: [{ uri: X402_EXT, description: 'x402 による従量課金（HTTP 402 / USDC）', required: false, params: { x402: { accepts, network: configured ? ch.body.accepts[0].network : null } } }] },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json'],
    securitySchemes: { x402: { type: 'http', scheme: 'x402', description: 'PAYMENT-SIGNATURE ヘッダに支払いを添えて再送する' } },
    security: [{ x402: [] }],
    skills: X402_CATALOG.map((item) => ({
      id: SKILL_NAME[item.resource] || item.resource,
      name: item.resource,
      description: `${item.description}（${(Number(item.price_usdc) / 1e6).toFixed(2)} USDC / 1回）`,
      tags: ['x402', 'paid', 'usdc', item.resource],
      examples: [JSON.stringify(INPUT_EXAMPLE[item.resource] || {})],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
    })),
    // A2A 拡張の値札（呼ぶ側が「予算内か」を事前に判断できる）
    extensions: {
      x402: {
        payment: {
          required: true,
          scheme: 'exact',
          currency: 'USDC',
          accepts,
          challengeHeader: 'PAYMENT-REQUIRED',
          proofHeader: 'PAYMENT-SIGNATURE',
          endpoint: `${base}/api/a2a`,
        },
        skills: Object.fromEntries(X402_CATALOG.map((i) => [SKILL_NAME[i.resource] || i.resource, { price: (Number(i.price_usdc) / 1e6).toFixed(2), currency: 'USDC' }])),
      },
    },
  };
}

/** 同一ドメインに複数エージェントを置く場合の索引（A2A registry の agents.json）。 */
export function agentsIndex(card) {
  return { schemaVersion: '1.0', agents: [{ name: card.name, url: card.url, card: `${String(card.url).replace(/\/api\/a2a$/, '')}/.well-known/agent-card.json`, description: card.description, skills: (card.skills || []).map((s) => s.id) }] };
}

const INPUT_EXAMPLE = {
  brief: { question: 'x402 に対応した facilitator を比較して' },
  'data-clean': { data: 'name,price\nA,100\nA,100' },
  'code-review': { code: 'function add(a,b){ return a+b }', language: 'javascript' },
};

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,payment-signature,x-payment,authorization', 'access-control-allow-methods': 'POST,OPTIONS' };
const rpcOk = (id, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json', ...cors } });
const rpcErr = (id, code, message, data) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }), { status: 200, headers: { 'content-type': 'application/json', ...cors } });

/** POST /a2a — JSON-RPC 2.0。message/send が有料の雇われ窓口。 */
export async function handleA2a(request, env, url, deps = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, protocol: 'a2a', endpoint: `${url.origin}/a2a`, card: `${url.origin}/.well-known/agent-card.json` }), { status: 200, headers: { 'content-type': 'application/json', ...cors } });
  }
  let msg = {};
  try { msg = JSON.parse(await request.text()); } catch { return rpcErr(null, -32700, 'parse error'); }
  const id = msg.id ?? null;
  const method = String(msg.method || '');
  if (method === 'message/send' || method === 'tasks/send') {
    try { return await sell(msg, request, env, url, deps); }
    catch (e) { return rpcErr(id, -32603, `internal error: ${String(e && e.message || e)}`); }
  }
  if (method === 'tasks/get') return rpcErr(id, -32001, 'task not found（このエージェントは即時納品のみで、状態は保持しません）');
  return rpcErr(id, -32601, `method not found: ${method}`);
}

async function sell(msg, request, env, url, deps) {
  const id = msg.id ?? null;
  const skillId = String(msg?.params?.metadata?.skillId || msg?.params?.metadata?.skill || 'research_brief');
  const resource = RESOURCE_OF_SKILL[skillId];
  if (!resource) return rpcErr(id, -32602, `unknown skill: ${skillId}`, { available: Object.keys(RESOURCE_OF_SKILL) });
  let input = {};
  const parts = msg?.params?.message?.parts || msg?.params?.message?.content?.parts || [];
  const text = parts.filter((p) => typeof p?.text === 'string').map((p) => p.text).join('\n').trim();
  if (text) { try { input = JSON.parse(text); } catch { input = { question: text }; } }
  if (!Object.keys(input).length && msg?.params?.metadata?.input) input = msg.params.metadata.input;

  const pf = await preflight(env);
  const ch = pf.ok ? challenge(resource, env, { origin: url.origin, feePayer: pf.feePayer, solanaFeePayer: pf.solanaFeePayer }) : null;
  if (!ch || !ch.configured) return rpcErr(id, -32000, ch?.reason || pf.reason || 'not configured');
  const order = validateOrder(resource, input);
  if (!order.ok) return rpcErr(id, -32602, order.reason, { order_spec: order.spec });
  const header = request.headers.get('PAYMENT-SIGNATURE') || request.headers.get('X-PAYMENT') || '';
  const pay402 = async (why) => {
    await logHit(deps.store, request, { resource, kind: 'challenge', status: 402, note: why });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32402, message: `payment required: ${why}`, data: { ...ch.body, order_spec: undefined } } }), { status: 402, headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': requiredHeader(ch.body), ...cors } });
  };
  if (!header) return pay402('PAYMENT-SIGNATURE ヘッダがありません');
  const settled = await verifyAndSettle({ env, resource, paymentHeader: header, feePayer: pf.feePayer });
  if (!settled.ok) return pay402(settled.error);
  return rpcOk(id, { kind: 'task', id: `task_${Date.now().toString(36)}`, status: { state: 'working' }, ...(await deliver(resource, order.input, settled, deps, url)) });
}

/** 決済確定後の納品。同じ応答で結果を返し、入金と受注を記録する。 */
export async function deliver(resource, input, settled, deps, url) {
  let done;
  try { done = await fulfillOrder(resource, input, { router: deps.router || null, research: deps.research || null, store: deps.store || null }); }
  catch (e) { done = { ok: false, error: 'fulfill_failed', reason: String(e && e.message || e) }; }
  try {
    if (deps.store) {
      const item = X402_CATALOG.find((i) => i.resource === resource);
      await recordReceipt(deps.store, { source: 'x402', external_id: settled.tx || `x402_${Date.now().toString(36)}`, amount: Number(((Number(settled.amount) || 0) / 1e6).toFixed(6)), currency: 'USDC', fee: settled.fee || 0, payer: settled.payer, signature_verified: true, raw: settled });
      await createJob(deps.store, { title: `${item?.description || resource}（エージェント間 受注）`, price: settled.amount, state: done.ok ? 'delivered' : 'in_progress', note: `A2A/MCP 経由: ${settled.payer || 'unknown payer'}` });
    }
  } catch { /* 記録に失敗しても納品は返す */ }
  const artifact = { artifactId: `art_${Date.now().toString(36)}`, name: resource, parts: [{ kind: 'text', text: JSON.stringify(done) }] };
  return {
    status: { state: done.ok ? 'completed' : 'failed' },
    artifacts: [artifact],
    metadata: { paid: true, amount: settled.amount, currency: 'USDC', payer: settled.payer, tx: settled.tx || null },
  };
}
