// MCP (Model Context Protocol) — 他のAIエージェントやホストが、このエージェントの
// 有料サービスを「ツール」として呼べるようにする。転送方式は Streamable HTTP（POST /mcp）。
// 支払いは x402。402 応答の PAYMENT-REQUIRED を見て、呼ぶ側が自動で払って再送する。
import { X402_CATALOG, INPUT_SCHEMAS, INPUT_EXAMPLES, discoveryFeed, challenge, preflight, requiredHeader, verifyAndSettle } from './x402.js';
import { validateOrder } from './fulfill.js';
import { deliver } from './a2a.js';

const PROTOCOL_VERSION = '2025-06-18';
const TOOL = { brief: 'buy_research_brief', 'data-clean': 'buy_data_clean', 'code-review': 'buy_code_review' };
const RESOURCE = Object.fromEntries(Object.entries(TOOL).map(([k, v]) => [v, k]));

export function toolList() {
  const tools = X402_CATALOG.map((item) => ({
    name: TOOL[item.resource] || item.resource,
    description: `${item.description}。【価格】${(Number(item.price_usdc) / 1e6).toFixed(2)} USDC。【使い方】呼ぶと 402 と PAYMENT-REQUIRED（支払い条件）が返る。USDC で支払い、同じ引数に PAYMENT-SIGNATURE ヘッダを添えて再送すると結果が返る。`,
    inputSchema: { type: 'object', properties: INPUT_SCHEMAS[item.resource]?.properties || {}, required: INPUT_SCHEMAS[item.resource]?.required || [] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { price: { currency: 'USDC', amount: (Number(item.price_usdc) / 1e6).toFixed(2) }, example: INPUT_EXAMPLES[item.resource] || {} },
  }));
  tools.push({ name: 'list_services', description: '販売中の有料サービスと価格・支払い条件の一覧（無料）', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } });
  return tools;
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,payment-signature,x-payment,mcp-protocol-version,authorization', 'access-control-allow-methods': 'POST,GET,OPTIONS' };
const ok = (id, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json', ...cors } });
const err = (id, code, message, data) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }), { status: 200, headers: { 'content-type': 'application/json', ...cors } });

export async function handleMcp(request, env, url, deps = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, protocol: 'mcp', transport: 'streamable-http', protocolVersion: PROTOCOL_VERSION, endpoint: `${url.origin}/mcp`, tools: toolList().map((t) => t.name) }), { status: 200, headers: { 'content-type': 'application/json', ...cors } });
  }
  let msg = {};
  try { msg = JSON.parse(await request.text()); } catch { return err(null, -32700, 'parse error'); }
  const id = msg.id ?? null;
  const method = String(msg.method || '');
  if (method.startsWith('notifications/')) return new Response(null, { status: 202, headers: cors });
  if (method === 'initialize') {
    return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'wealth-agent', version: '1.0.0' }, instructions: '有料ツールは x402 で支払う。呼ぶと 402 と PAYMENT-REQUIRED（支払い条件）が返る。支払い後、同じ引数に PAYMENT-SIGNATURE を添えて再送すると納品物が返る。' });
  }
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: toolList() });
  if (method !== 'tools/call') return err(id, -32601, `method not found: ${method}`);

  const name = String(msg?.params?.name || '');
  const args = msg?.params?.arguments || {};
  if (name === 'list_services') return ok(id, { content: [{ type: 'text', text: JSON.stringify(discoveryFeed(env, url.origin), null, 2) }], isError: false });
  const resource = RESOURCE[name];
  if (!resource) return err(id, -32602, `unknown tool: ${name}`);

  const pf = await preflight(env);
  const ch = pf.ok ? challenge(resource, env, { origin: url.origin, feePayer: pf.feePayer, solanaFeePayer: pf.solanaFeePayer }) : null;
  if (!ch || !ch.configured) return err(id, -32000, ch?.reason || pf.reason || 'not configured');
  const order = validateOrder(resource, args);
  if (!order.ok) return ok(id, { content: [{ type: 'text', text: `入力が不正: ${order.reason}` }], isError: true });
  const header = request.headers.get('PAYMENT-SIGNATURE') || request.headers.get('X-PAYMENT') || '';
  const pay402 = (why) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32402, message: `payment required: ${why}`, data: ch.body } }), { status: 402, headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': requiredHeader(ch.body), ...cors } });
  if (!header) return pay402('PAYMENT-SIGNATURE ヘッダがありません');
  const settled = await verifyAndSettle({ env, resource, paymentHeader: header, feePayer: pf.feePayer });
  if (!settled.ok) return pay402(settled.error);
  const done = await deliver(resource, order.input, settled, deps, url);
  return ok(id, { content: [{ type: 'text', text: JSON.stringify(done.artifacts?.[0]?.parts?.[0]?.text ? JSON.parse(done.artifacts[0].parts[0].text) : done, null, 2) }], isError: !(done.status?.state === 'completed'), _meta: done.metadata });
}
