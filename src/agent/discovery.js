// 発見面（machine-readable discovery）— エージェントが「何を・いくらで買えるか」を
// 機械だけで判断できるようにするためのファイル群を1か所で組み立てる。
//
// 値段は必ず x402.js のカタログから読む（ここで数字を二重に書かない）。
// 二重に書くと、値段を変えたときにカタログとマニフェストが食い違い、
// 買い手のエージェントが「表示と請求が違う」と判断して離れる。

import { catalog as x402Catalog, netOptions, LISTING } from './x402.js';
import { ORDER_SPECS } from './fulfill.js';

const METHOD = 'POST';

/** 品目の「仕事の言葉」。索引（agent402 のルーター等）は OpenAPI の operationId を
 *  検索語として採点する。パス由来の x402_diff では slug 一致 30 点を毎回落とすため、
 *  買い手が検索する言い回し（'Diff two texts' → diff_two_texts）に寄せる。 */
export function listingSlug(resource) {
  const L = LISTING[resource] || {};
  if (L.slug) return L.slug;
  const nm = L.name || resource;
  return String(nm).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** /.well-known/x402 と /.well-known/x402.json が返す中身（V2 マニフェスト）。 */
export function discoveryManifest(env = {}, origin = '', opts = {}) {
  const venue = opts.venue ? `?venue=${opts.venue}` : '';
  const items = x402Catalog(env).map((i) => ({
    resource: `${origin}/api/x402/${i.resource}${venue}`,
    method: METHOD,
    description: i.description,
    price: i.price_label,
    // 人が読む値段は USD（1.00 = 1 USDC）。実行時の accepts[].amount は最小単位なので分けて持たせる。
    price_usdc: Number((Number(i.price_usdc) || 0) / 1e6),
    price_atomic: String(i.price_usdc),
    unit: i.unit,
    mime_type: 'application/json',
    network: i.network,
    networks: i.networks,
    network_name: i.network_name,
    asset: i.asset,
    pay_to: i.pay_to,
    sellable: i.sellable,
    blocked_reason: i.blocked_reason,
  }));
  return {
    x402Version: 2,
    provider: env.AGENT_NAME || 'Wealth Agent',
    selling: items.length > 0 && items.some((i) => i.sellable),
    discovery: {
      manifest: `${origin}/.well-known/x402.json`,
      catalog: `${origin}/api/x402/discovery/resources`,
      openapi: `${origin}/openapi.json`,
      llms: `${origin}/llms.txt`,
      agent_card: `${origin}/.well-known/agent.json`,
      a2a: `${origin}/a2a`,
      mcp: `${origin}/mcp`,
    },
    payment: {
      protocol: 'x402', version: 2, scheme: 'exact', currency: 'USDC',
      header: 'PAYMENT-SIGNATURE',
      challenge_header: 'PAYMENT-REQUIRED',
      networks: netOptions(env).map((o) => o.caip2),
      facilitator: env.X402_FACILITATOR_URL || null,
      accounts_required: false,
      api_keys_required: false,
    },
    // 買い手（エージェント）が「どんなときに使うか」を判断できる短い説明。
    use_when: 'When an agent needs a sourced research brief, cleaned tabular data or a code review without creating an account or an API key, and wants to pay per call in USDC over x402.',
    items,
  };
}

/** /openapi.json — x402scan / @agentcash/discovery の discovery spec に沿った OpenAPI 3.1。
 *  必須: openapi / info.title / info.x-guidance / info.version / paths、
 *  有料ルートに responses.402 と x-payment-info（protocols + 固定価格 + currency）。
 *  価格は decimal USD（例 1.000000）で書き、実行時の accepts[].amount（最小単位）とは別物。 */
export function openapi(env = {}, origin = '') {
  const items = x402Catalog(env);
  const paths = {};
  for (const it of items) {
    const p = `/api/x402/${it.resource}`;
    const spec = ORDER_SPECS[it.resource] || null;
    paths[p] = {
      post: {
        operationId: listingSlug(it.resource),
        summary: (LISTING[it.resource] || {}).name || it.description,
        description: `${(LISTING[it.resource] || {}).name || it.resource}. ${it.description} Price: ${it.price_label} per call, settled in USDC through x402 (exact scheme). No account and no API key; an unpaid call receives HTTP 402 with a PAYMENT-REQUIRED challenge.`,
        tags: (LISTING[it.resource] || {}).tags || ['x402', 'paid'],
        security: [{ x402: [] }],
        'x-payment-info': {
          price: { mode: 'fixed', currency: 'USD', amount: (Number(it.price_usdc) / 1e6).toFixed(6) },
          protocols: [{ x402: {} }],
          x402Version: 2, scheme: 'exact', method: METHOD,
          network: it.network, networks: it.networks, asset: it.asset, pay_to: it.pay_to,
          mime_type: 'application/json', sellable: it.sellable, blocked_reason: it.blocked_reason,
        },
        requestBody: {
          required: true,
          content: { 'application/json': { schema: spec && spec.schema ? spec.schema : { type: 'object' }, example: spec && spec.example ? spec.example : undefined } },
        },
        responses: {
          200: { description: 'Delivered — payment settled', content: { 'application/json': { schema: { type: 'object' } } } },
          400: { description: 'Invalid request body; no charge is made' },
          402: {
            description: 'Payment required. The PAYMENT-REQUIRED header carries the price list (accepts plus the bazaar extension).',
            headers: {
              'PAYMENT-REQUIRED': { description: 'Base64 の x402 v2 PaymentRequired', schema: { type: 'string' } },
              'WWW-Authenticate': { description: 'X402 チャレンジ', schema: { type: 'string' } },
            },
          },
          503: { description: 'Pay-to address is not configured, so no price is quoted' },
        },
      },
    };
  }
  return {
    // x402scan の OpenAPI-first 発見は、この所有証明で「本人の資源だ」と確認する。
    'x-discovery': { ownershipProofs: [...new Set(items.map((x) => x.pay_to).filter(Boolean))] },

    openapi: '3.1.0',
    info: {
      title: env.AGENT_NAME ? `${env.AGENT_NAME} — paid x402 APIs` : 'Wealth Agent — paid x402 APIs',
      version: '2.1.0',
      description: 'Pay-per-call HTTP APIs for AI agents, settled in USDC over x402 (exact scheme). No account and no API key: calling a paid route without payment returns HTTP 402 with a PAYMENT-REQUIRED challenge describing price, asset, network and payTo. Nine tools: sourced research briefs, CSV/TSV/JSON cleaning, line-level text diff, regex extraction, CSV to JSON conversion, URL metadata, source-code review, website capability reports, and full API or binary surface analysis.',
      contact: { name: 'Wealth-A (autonomous agent operating this API)', url: `${origin}/llms.txt` },
        'x-guidance': `Paid routes: ${items.map((i) => `${origin}/api/x402/${i.resource} (${(LISTING[i.resource] || {}).name || i.resource} — ${i.price_label})`).join(', ')}. Call one without payment and you get HTTP 402 with a PAYMENT-REQUIRED header carrying the price list (accepts plus a bazaar extension). Pick one entry from accepts, pay, then resend the same request with the PAYMENT-SIGNATURE header to receive the result. The request body is JSON only; no auth header is needed.`,
    },
    servers: [{ url: origin || '' }],
    security: [{ x402: [] }],
    'x-x402': {
      version: 2,
      manifest: `${origin}/.well-known/x402.json`,
      discovery: `${origin}/api/x402/discovery/resources`,
      facilitator: env.X402_FACILITATOR_URL || null,
      networks: netOptions(env).map((o) => o.caip2),
    },
    paths,
    components: {
      securitySchemes: {
        // x402 は API キーではなく「支払い」が認証。未払いの通話は 402 と PAYMENT-REQUIRED を受け取り、
        // 支払い後に同じ要求へ PAYMENT-SIGNATURE を付けて再送する。
        x402: {
          type: 'apiKey',
          in: 'header',
          name: 'PAYMENT-SIGNATURE',
          description: 'x402 payment signature. An unpaid call receives HTTP 402 with a PAYMENT-REQUIRED challenge; resend the identical request with PAYMENT-SIGNATURE after paying.',
        },
      },
    },
  };
}

/** 価格表の要約（人が読む面 / llms.txt 用）。 */
export function priceLines(env = {}, origin = '') {
  return x402Catalog(env).map((i) => `- ${origin}/api/x402/${i.resource} — ${i.price_label}`);
}
