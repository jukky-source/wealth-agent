// 発見面（machine-readable discovery）— エージェントが「何を・いくらで買えるか」を
// 機械だけで判断できるようにするためのファイル群を1か所で組み立てる。
//
// 値段は必ず x402.js のカタログから読む（ここで数字を二重に書かない）。
// 二重に書くと、値段を変えたときにカタログとマニフェストが食い違い、
// 買い手のエージェントが「表示と請求が違う」と判断して離れる。

import { catalog as x402Catalog, netOptions } from './x402.js';
import { ORDER_SPECS } from './fulfill.js';

const METHOD = 'POST';

/** /.well-known/x402 と /.well-known/x402.json が返す中身（V2 マニフェスト）。 */
export function discoveryManifest(env = {}, origin = '') {
  const items = x402Catalog(env).map((i) => ({
    resource: `${origin}/api/x402/${i.resource}`,
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
    use_when: '出典つきの調査、表データの整形、コードレビューを、アカウント登録やAPIキーなしで1回だけ買いたいとき。',
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
        operationId: `x402_${it.resource}`,
        summary: it.description,
        description: `${it.description}。1回ごとに ${it.price_label} を x402（USDC・exact）で支払って購入する。アカウント登録もAPIキーも不要。`,
        tags: ['x402', 'paid'],
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
          200: { description: '納品（支払い済み）', content: { 'application/json': { schema: { type: 'object' } } } },
          400: { description: '注文内容が仕様を満たさない（請求は発生しない）' },
          402: {
            description: '未払い。PAYMENT-REQUIRED ヘッダに値札（accepts と bazaar 拡張）が入る',
            headers: {
              'PAYMENT-REQUIRED': { description: 'Base64 の x402 v2 PaymentRequired', schema: { type: 'string' } },
              'WWW-Authenticate': { description: 'X402 チャレンジ', schema: { type: 'string' } },
            },
          },
          503: { description: '受け取り設定が無効（値札を出さない）' },
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
      version: '2.0.0',
      description: 'HTTP 402 と USDC で1回だけ買える API。登録・APIキー不要。未払いのリクエストには 402 と PAYMENT-REQUIRED を返す。',
      contact: { name: 'Wealth-A (autonomous agent operating this API)', url: `${origin}/llms.txt` },
        'x-guidance': '有料のルートは POST /api/x402/brief（出典つき調査・0.25 USDC）、POST /api/x402/data-clean（表データの整形・0.50 USDC）、POST /api/x402/code-review（コードレビュー・0.75 USDC）。未払いで呼ぶと 402 が返り、PAYMENT-REQUIRED ヘッダに値札（accepts と bazaar 拡張）が入る。その accepts の1つを選んで支払い、同じリクエストを PAYMENT-SIGNATURE ヘッダ付きで送り直すと納品される。入力はJSON本文のみ（認証ヘッダは不要）。 さらに軽量な決定的ツール層として POST /api/x402/regex（正規表現の一括抽出・0.01 USDC）、POST /api/x402/diff（テキスト差分・0.01 USDC）、POST /api/x402/csv-json（CSV⇔JSON 変換・0.02 USDC）、POST /api/x402/url-meta（URLの見出し情報・0.03 USDC）がある。こちらはモデルを使わないため安価で、同じ入力なら同じ結果が返る。',
    },
    servers: [{ url: origin || '' }],
    security: [],
    'x-x402': {
      version: 2,
      manifest: `${origin}/.well-known/x402.json`,
      discovery: `${origin}/api/x402/discovery/resources`,
      facilitator: env.X402_FACILITATOR_URL || null,
      networks: netOptions(env).map((o) => o.caip2),
    },
    paths,
    components: { securitySchemes: {} },
  };
}

/** 価格表の要約（人が読む面 / llms.txt 用）。 */
export function priceLines(env = {}, origin = '') {
  return x402Catalog(env).map((i) => `- ${origin}/api/x402/${i.resource} — ${i.price_label}`);
}
