// MCP (Model Context Protocol) — 他のAIエージェントやホストが、このエージェントの
// 有料サービスを「ツール」として呼べるようにする。転送方式は Streamable HTTP（POST /mcp）。
// 支払いは x402。402 応答の PAYMENT-REQUIRED を見て、呼ぶ側が自動で払って再送する。
import { X402_CATALOG, INPUT_SCHEMAS, INPUT_EXAMPLES, discoveryFeed, challenge, preflight, requiredHeader, verifyAndSettle } from './x402.js';
import { validateOrder } from './fulfill.js';
import { deliver } from './a2a.js';
import { labLoopRound, labLoopStatus } from '../income/labLoop.js';
import { improveRound, improveTick, improveStatus } from './improve.js';

const PROTOCOL_VERSION = '2025-06-18';
const TOOL = { brief: 'buy_research_brief', 'data-clean': 'buy_data_clean', 'code-review': 'buy_code_review', 'surface-report': 'buy_surface_report', 'rea-report': 'buy_rea_report' };
const RESOURCE = Object.fromEntries(Object.entries(TOOL).map(([k, v]) => [v, k]));

export function toolList() {
  const tools = X402_CATALOG.map((item) => ({
    name: TOOL[item.resource] || item.resource,
    description: `${item.description}。【価格】${(Number(item.price_usdc) / 1e6).toFixed(2)} USDC。【使い方】呼ぶと 402 と PAYMENT-REQUIRED（支払い条件）が返る。USDC で支払い、同じ引数に PAYMENT-SIGNATURE ヘッダを添えて再送すると結果が返る。`,
    inputSchema: { type: 'object', properties: INPUT_SCHEMAS[item.resource]?.properties || {}, required: INPUT_SCHEMAS[item.resource]?.required || [] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { price: { currency: 'USDC', amount: (Number(item.price_usdc) / 1e6).toFixed(2) }, example: INPUT_EXAMPLES[item.resource] || {} },
  }));
  tools.push({
    name: 'perk_deadlines',
    description: '日本のお得情報（特典・ポイント還元・キャンペーン）を締切が近い順に返す。実額・期限・出典URLつき。【無料】最大5件。全件と条件・手順・人の操作が必要な部分は /api/perks（オーナー向け）。',
    inputSchema: { type: 'object', properties: { within_days: { type: 'number', description: '何日以内の締切を返すか（既定7・最大60）' }, limit: { type: 'number', description: '件数（既定5・最大5）' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });
  tools.push({
    name: 'perk_search',
    description: '日本のお得情報を本文から検索して返す（実額・期限・出典URLつき）。【無料】最大5件。',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: '検索語（例: Google Play, ローソン, ポイント還元）' }, limit: { type: 'number', description: '件数（既定5・最大5）' } }, required: ['q'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });
  tools.push({
    name: 'rea_inspect',
    description: 'REA: 対象の「表面」を解析し、できること（根拠つき）と入口の候補と、分からなかったことを返す。URL ならサイト/API/MCP を、ローカルのパス（.asar/.exe/.so/.apk 等）なら実行手順を返す。【無料】要約版。全件＋根拠の全文は buy_rea_report（0.5 USDC）。認証回避・課金回避・DRM解除はしない。',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: '公開URL（サイト・API・MCP）' }, target: { type: 'string', description: 'ローカルのパス。Worker では実行できないので手順を返す' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  });
  tools.push({
    name: 'rea_plan',
    description: 'REA: ローカルのファイル種別（elf / pe / macho / asar / apk / jar / js）ごとの解析手順を、実行せずに返す。【無料】実行するのは手元の tools/rea-cli.mjs。',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', description: 'elf / pe / macho / asar / apk / jar / js / unknown' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });
  tools.push({
    name: 'rea_runs',
    description: 'REA: 直近の解析の状態遷移（queued → fetching → parsing → probing → evidence → done/blocked）を返す。【無料】観測用。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '件数（既定20・最大50）' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });
  tools.push({
    name: 'agent_status',
    description: 'このエージェントの収益ファネル（拾う→試す→生きていると確認→売り物→掲置→来訪→支払い）を実測値で返し、どこで詰まっているかと次に打つ手を示す。【無料】',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });
  tools.push({
    name: 'rea_queue',
    description: 'REA の自動投入キュー（X / Reddit / scout / perks から拾った解析対象）の件数と直近の結果を返す。【無料】',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '件数（既定10・最大20）' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });
  tools.push({
    name: 'surface_inspect',
    description: '公開URLを解析し、そのサービスが公開している入口（エンドポイント候補・フォーム・フィード・MCPツール）と根拠、そして分からなかったことを返す。【無料】要約版。全件＋根拠の全文は buy_surface_report（0.25 USDC）。認証回避はしない。',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: '公開 https URL' } }, required: ['url'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  });
  tools.push({ name: 'lab_loop', description: 'FX論理の試行錯誤ループ（無料）。状態では「今ぶつかっている壁」と「次の打ち手」を返し、run:true でその場で1ラウンド回して結果を記録する。', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['own', 'e8'], description: 'own=自己資金 / e8=E8チャレンジ（既定 own）' }, run: { type: 'boolean', description: 'true で1ラウンド実行（既定は状態のみ）' } } }, annotations: { readOnlyHint: false } });
  tools.push({ name: 'improve_status', description: '全般の改善ループの状態（無料）。レーンごとの壁・打ち手・判定と、直近の記録を返す。', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } });
  tools.push({ name: 'improve_round', description: '全般の改善ループをその場で回す（無料）。lane を指定しなければカーソル順に n レーン回す。', inputSchema: { type: 'object', properties: { lane: { type: 'string', description: 'fx / funnel / playbook / perks / rea / discovery / catalog' }, n: { type: 'number', description: '回すレーン数（既定1）' } } }, annotations: { readOnlyHint: false } });
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
  if (name === 'lab_loop') {
    const mode = args && args.mode === 'e8' ? 'e8' : 'own';
    if (args && args.run) return ok(id, { content: [{ type: 'text', text: JSON.stringify(await labLoopRound({ store, env, mode }), null, 2) }], isError: false });
    return ok(id, { content: [{ type: 'text', text: JSON.stringify(await labLoopStatus(store, env), null, 2) }], isError: false });
  }
  if (name === 'improve_status' || name === 'improve_round') {
    if (name === 'improve_round') {
      const lane = (args && args.lane) || null;
      const n = Number((args && args.n) || 1);
      const rounds = lane ? [await improveRound({ store, env, lane })] : await improveTick({ store, env, n });
      return ok(id, { content: [{ type: 'text', text: JSON.stringify({ rounds }, null, 2) }], isError: false });
    }
    return ok(id, { content: [{ type: 'text', text: JSON.stringify(await improveStatus(store, env), null, 2) }], isError: false });
  }
  if (name === 'perk_deadlines' || name === 'perk_search') {
    const { listPerks, rankPerks, perkText } = await import('./perks.js');
    if (!deps.store) return ok(id, { content: [{ type: 'text', text: 'このツールはストア付きで起動していないため使えません' }], isError: true });
    const { nextDeadline } = await import('./perks.js');
    const rows = await listPerks(deps.store, { limit: 200 });
    let picked = rankPerks(rows, {}).map((p) => ({ ...p, next_at: (nextDeadline(p) || {}).at || p.next_at || null }));
    if (name === 'perk_search') {
      const q = String(args.q || '').toLowerCase();
      if (!q) return ok(id, { content: [{ type: 'text', text: 'q が必要です' }], isError: true });
      picked = picked.filter((p) => JSON.stringify([p.title, p.site, p.kind, p.evidence, p.summary, p.url]).toLowerCase().includes(q));
    } else {
      const d = Math.max(1, Math.min(60, Number(args.within_days) || 7));
      const lim = Math.max(1, Math.min(5, Number(args.limit) || 5));
      picked = picked.filter((p) => p.next_at && (new Date(p.next_at).getTime() - Date.now()) <= d * 86400000);
      if (!picked.length) picked = rankPerks(rows, {}).filter((p) => p.next_at);
      picked = picked.slice(0, lim);
    }
    const text = picked.length ? perkText(picked.slice(0, 5)) + '\n\n【無料枠】最大5件・要約。全件／条件・手順・人の操作の内訳は有料面（/api/perks）。' : '該当なし';
    return ok(id, { content: [{ type: 'text', text }], isError: false });
  }
  if (name === 'agent_status') {
    if (!deps.store) return ok(id, { content: [{ type: 'text', text: 'このツールはストア付きで起動していないため使えません' }], isError: true });
    const { loopSummary, loopText } = await import('./loop.js');
    const s = await loopSummary(deps.store, { env });
    return ok(id, { content: [{ type: 'text', text: loopText(s) }], isError: false });
  }
  if (name === 'rea_queue') {
    if (!deps.store) return ok(id, { content: [{ type: 'text', text: 'このツールはストア付きで起動していないため使えません' }], isError: true });
    const { queueSummary } = await import('./reaQueue.js');
    const s = await queueSummary(deps.store);
    return ok(id, { content: [{ type: 'text', text: JSON.stringify(s, null, 2) }], isError: false });
  }
  if (name === 'surface_inspect') {
    const { inspectSurface, surfaceBrief, SURFACE_PRICE_USDC } = await import('./surface.js');
    if (!args.url) return ok(id, { content: [{ type: 'text', text: 'url が必要です' }], isError: true });
    const s = await inspectSurface(args.url, {});
    const text = surfaceBrief(s, { full: false }) + `\n\n【無料枠】要約版。全件＋根拠の全文＋実装メモは buy_surface_report（${SURFACE_PRICE_USDC} USDC）。`;
    return ok(id, { content: [{ type: 'text', text }], isError: false });
  }
  if (name === 'rea_inspect' || name === 'rea_plan' || name === 'rea_runs') {
    const { inspectRea, reaBrief, reaPlan, listRuns, REA_PRICE_USDC, ACTION_RULES } = await import('./rea.js');
    if (name === 'rea_plan') {
      const kind = String(args.kind || 'unknown');
      return ok(id, { content: [{ type: 'text', text: JSON.stringify({ kind, plan: reaPlan(kind), action_rules: ACTION_RULES }, null, 2) }], isError: false });
    }
    if (name === 'rea_runs') {
      if (!deps.store) return ok(id, { content: [{ type: 'text', text: 'このツールはストア付きで起動していないため使えません' }], isError: true });
      const runs = await listRuns(deps.store, Number(args.limit) || 20);
      return ok(id, { content: [{ type: 'text', text: runs.length ? JSON.stringify(runs, null, 2) : 'まだ実行がありません' }], isError: false });
    }
    const target = String(args.url || args.target || '');
    if (!target) return ok(id, { content: [{ type: 'text', text: 'url（または target）が必要です' }], isError: true });
    const s = await inspectRea(target, {});
    const text = reaBrief(s, { full: false }) + `\n\n【無料枠】要約版。全件＋根拠の全文＋実行手順の全文は buy_rea_report（${REA_PRICE_USDC} USDC）。`;
    return ok(id, { content: [{ type: 'text', text }], isError: false });
  }
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
