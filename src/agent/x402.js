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
  arbitrum: { caip2: 'eip155:42161', family: 'evm', asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', label: 'Arbitrum' },
  sei: { caip2: 'eip155:1329', family: 'evm', asset: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', label: 'Sei' },
  xlayer: { caip2: 'eip155:196', family: 'evm', asset: '0xB6CEceAB302E2E4948951eE7843FC24E92933061', label: 'X Layer' },
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

// 同じ EVM アドレスはどの EVM チェーンでも受け取れるので、対応 facilitator が扱える
// チェーンを複数まとめて値札に並べる（買い手は自分のチェーンを選べる＝人手ゼロで間口が広がる）。
// X402_MULTICHAIN=0 で単一チェーンに戻せる。X402_EXTRA_NETWORKS="arbitrum,sei" で明示指定。
const EVM_MULTICHAIN = ['base', 'arbitrum', 'polygon', 'avalanche', 'sei', 'xlayer'];
const EVM_MAINNET_CAIP2 = new Set(['eip155:8453', 'eip155:137', 'eip155:43114', 'eip155:42161', 'eip155:1329', 'eip155:196']);
function netOptionsAll(env = {}, { solanaFeePayer = env.X402_FEE_PAYER || null } = {}) {
  const primary = resolveNetwork(env.X402_NETWORK);
  if (!primary) return [];
  // 受取先はネットワークごとに違う（EVM は 0x…、Solana は base58）。1つの値では兼ねられないので
  // 選択肢ごとに payTo を持たせる。取り違えると facilitator の検証で必ず落ちる。
  const evmPayTo = env.X402_PAY_TO || null;
  const first = { caip2: primary.caip2, family: primary.family, asset: env.X402_ASSET || primary.asset, label: primary.label, payTo: evmPayTo };
  // Solana は買い手のガスを facilitator が肩代わりする（feePayer の提示が必須）。
  // 提示が無い・形が違うときは選択肢に載せない（払えない値札を出さない）。
  const solTo = String(env.X402_SOLANA_PAY_TO || '').trim();
  const solNet = resolveNetwork('solana');
  const sol = solTo && isSolanaAddress(solTo) && isSolanaAddress(solanaFeePayer)
    ? { caip2: solNet.caip2, family: 'svm', asset: env.X402_SOLANA_ASSET || solNet.asset, label: 'Solana', payTo: solTo, feePayer: solanaFeePayer }
    : null;
  if (env.X402_MULTICHAIN === '0') return [first];
  if (primary.family !== 'evm' || !EVM_MAINNET_CAIP2.has(primary.caip2)) return [first];
  const names = env.X402_EXTRA_NETWORKS ? String(env.X402_EXTRA_NETWORKS).split(',') : EVM_MULTICHAIN;
  const seen = new Set([primary.caip2]);
  const out = [first];
  for (const raw of names) {
    const n = resolveNetwork(String(raw).trim());
    if (!n || n.family !== 'evm' || seen.has(n.caip2) || !EVM_MAINNET_CAIP2.has(n.caip2)) continue;
    seen.add(n.caip2);
    out.push({ caip2: n.caip2, family: 'evm', asset: n.asset, label: n.label, payTo: evmPayTo });
  }
  if (sol) out.push(sol);
  return out;
}

/**
 * 値札に並べる受け口。CDP Facilitator を使うときは、CDP が扱えないチェーンを落とす
 * （Avalanche / Sei / X Layer）。払えない選択肢を買い手に掴ませないため。
 * 1つも残らないときは元の一覧を返し、preflight の facilitator_unsupported で
 * 売り物ごと止める（空の accepts を出さない）。
 */
export function netOptions(env = {}, opts = {}) {
  const all = netOptionsAll(env, opts);
  if (!cdpSelected(env)) return all;
  const kept = filterNetworksForCdp(all, env);
  return kept.length ? kept : all;
}

import { cdpSelected, facilitatorUrl, facilitatorAuthHeaders, filterNetworksForCdp } from './cdp-facilitator.js';

/** ネットワークごとの既定 facilitator（本番は本番対応のもの、テストネットは x402.org）。 */
export const DEFAULT_FACILITATORS = {
  mainnet: 'https://facilitator.payai.network',
  testnet: 'https://x402.org/facilitator',
};
export function defaultFacilitator(net) {
  const id = String(net?.caip2 || '');
  return /84532|EtWTRAB|devnet|sepolia/i.test(id) ? DEFAULT_FACILITATORS.testnet : DEFAULT_FACILITATORS.mainnet;
}

const cfg = (env = {}) => {
  const net = resolveNetwork(env.X402_NETWORK);
  return {
    payTo: env.X402_PAY_TO || null,
    networkRaw: env.X402_NETWORK || 'base',
    net,
    caip2: net?.caip2 || null,
    family: net?.family || null,
    asset: env.X402_ASSET || net?.asset || null,
    // 既定は Base 本番に対応した無料・キー不要の facilitator。
    // x402.org/facilitator はテストネット専用（Base 本番 eip155:8453 非対応）なので既定にしない。
    // CDP の鍵（CDP_API_KEY_ID / CDP_API_KEY_SECRET）が入っていれば CDP に切り替わる
    // （Bazaar 索引の唯一の条件が「CDP Facilitator 経由の決済成立」のため）。
    facilitator: String(facilitatorUrl(env) || defaultFacilitator(net)).replace(/\/+$/, ''),
    feePayer: env.X402_FEE_PAYER || null,
    timeout: Number(env.X402_MAX_TIMEOUT || 60),
  };
};

/** 受け取り先が設定され、かつそのネットワークの形式になっているか。 */
export function x402Enabled(env = {}) {
  const c = cfg(env);
  return !!c.payTo && !!c.family && !!c.asset && addressMatches(c.payTo, c.family);
}

/**
 * 索引（Bazaar）に出す品目ごとの掲載文。外部の監査（x402 Endpoint Checker）で
 * 「サービス名がブランド名・日本語」「説明が短すぎる」「タグが6個（先頭5個しか残らない）」と
 * 指摘されたため、買い手が検索する英語の言い回しにそろえる。
 */
export const LISTING = {
  brief: {
    serviceName: 'Research Brief with Sources',
    description: 'Returns a one-page research brief with cited source URLs, key findings and open gaps for a question. Call it when an agent needs a sourced answer instead of an unsourced guess. Input: {"question": "..."} (5-400 chars, any language).',
    tags: ['research brief', 'web research', 'answer with sources', 'summarize a topic', 'citations'],
  },
  'data-clean': {
    serviceName: 'CSV Data Cleaner',
    description: 'Cleans a CSV/TSV/JSON table: removes duplicate and empty rows, trims whitespace, and returns the cleaned CSV with before/after quality checks and per-column stats. Call it before analysing or importing messy tabular data. Input: {"data": "<csv text>"}.',
    tags: ['clean csv', 'data cleaning', 'deduplicate rows', 'csv validation', 'data quality'],
  },
  'code-review': {
    serviceName: 'Code Review',
    description: 'Reviews source code and returns line-numbered findings with severity and a concrete fix, combining deterministic static rules (eval, SQL concat, secrets, shell injection) with an AI review. Call it before merging or running untrusted code. Input: {"code": "...", "language": "javascript"}.',
    tags: ['code review', 'security review', 'static analysis', 'find bugs', 'sql injection'],
  },
};

/** 売り物（エージェントが実際に納品できるもの）。価格は USDC の最小単位（6桁）。 */
// 価格は「買い手が実際に払える額」に合わせる。x402 の公式 SDK（@x402/fetch）は既定で
// 1支払い $1 上限（spendControls.maxAmountPerPayment = "$1"）なので、$2 や $3 の品目は
// 既定設定の買い手エージェントからはそもそも買えない（自前の実購入でも$3の品目が
// 「rejected by spendControls.maxAmountPerPayment ($1)」で弾かれた）。
// 実測した競合の価格帯（中央値 0.005〜0.05 USDC）も踏まえ、全品目を $1 未満に置く。
// 値札（USD建て・atomic 6桁）。上位3品は「人が読む成果物」、下位4品は
// 「エージェントが何千回でも呼ぶ決定的な道具」— 後者は原価ゼロで利益率が高く、
// x402 の実勢（$0.10 以下が多数派）に合わせて量を取りにいく層。
// free_tier: true の品目は /api/free/<資源> から支払いなしで試せる（無料枠）。
// 原価がゼロの決定的処理だけを無料にする＝「原価0」の設計制約を壊さずに
// 初回の支払いという壁を外すための印。一覧は freemium.js がここから読む。
export const X402_CATALOG = [
  { resource: 'brief', price_usdc: 250_000, label_ja: '出典つき調査ブリーフ', description: LISTING.brief.description, unit: '件' },
  { resource: 'data-clean', price_usdc: 500_000, label_ja: '表データの整形・検証', description: LISTING['data-clean'].description, unit: '件' },
  { resource: 'code-review', price_usdc: 750_000, label_ja: 'コードレビュー（静的＋AI）', description: LISTING['code-review'].description, unit: '件' },
  { resource: 'url-meta', price_usdc: 30_000, free_tier: true, label_ja: 'URL の見出し情報', description: 'Fetch one public URL and return machine-readable page metadata: HTTP status, title, meta/og description, canonical URL, language, link count and a short text sample. Honest 4xx/5xx statuses are returned as data, not as errors. Use it for link previews, source triage and citation checks.', unit: '件' },
  { resource: 'csv-json', price_usdc: 20_000, free_tier: true, label_ja: 'CSV⇔JSON 変換', description: 'Convert tabular data between CSV/TSV and a JSON array of objects, in either direction, with detected delimiter and typed columns. Use it when a tool returns CSV but your pipeline needs JSON (or the reverse) and you do not want to run a parser yourself.', unit: '件' },
  { resource: 'regex', price_usdc: 10_000, free_tier: true, label_ja: '正規表現の一括抽出', description: 'Apply one regular expression to a text blob on the server and return every match with its index and capture groups. Deterministic, so the same input always returns the same answer. Useful for log triage, field extraction and validation at scale.', unit: '件' },
  { resource: 'diff', price_usdc: 10_000, free_tier: true, label_ja: 'テキスト差分', description: 'Return the line-level diff between two texts as added/removed/unified hunks with counts. Use it to review a patch, compare two API responses, or decide whether two documents actually differ before spending tokens on them.', unit: '件' },
  { resource: 'surface-report', price_usdc: 250_000, label_ja: '公開表面の解析レポート', description: 'Inspect one publicly reachable website or API and return a machine-readable capability report: the entry points it exposes (endpoints, forms, feeds, MCP tools), the evidence behind every finding, and an explicit list of what could not be determined. Only public responses are read; a 401/403 is recorded as auth_required and never bypassed. Use it to plan an integration, document an undocumented API, or triage a vendor before you build on it.', unit: '件' },
];

// 品目ごとの掲載文（Bazaar / 検索 / 404 で共通に使う）。サービス名は検索語を含む英名。
Object.assign(LISTING, {
  'url-meta': {
    serviceName: 'URL Metadata Extractor',
    description: X402_CATALOG.find((x) => x.resource === 'url-meta').description,
    tags: ['url', 'metadata', 'link preview', 'scraping', 'web', 'open graph', 'crawler'],
  },
  'csv-json': {
    serviceName: 'CSV to JSON Converter',
    description: X402_CATALOG.find((x) => x.resource === 'csv-json').description,
    tags: ['csv', 'json', 'convert', 'converter', 'data', 'tsv', 'parser'],
  },
  regex: {
    serviceName: 'Regex Extract API',
    description: X402_CATALOG.find((x) => x.resource === 'regex').description,
    tags: ['regex', 'regular expression', 'extract', 'text', 'parser', 'validate', 'grep'],
  },
  diff: {
    serviceName: 'Text Diff API',
    description: X402_CATALOG.find((x) => x.resource === 'diff').description,
    tags: ['diff', 'compare', 'patch', 'text', 'merge', 'review', 'delta'],
  },
});


/** テスト網（X402_TESTNET=1）では金額を X402_TEST_AMOUNT（既定 0）に置き換える。本番の値札は変えない。 */
function priceOf(item, env = {}) {
  if (env.X402_TESTNET === '1') { const n = Number(env.X402_TEST_AMOUNT); return Number.isFinite(n) && n >= 0 ? n : 0; }
  return item.price_usdc;
}

/** 買う側に見せる値札。売れない状態なら理由も返す（隠さない）。 */
export function catalog(env = {}) {
  const c = cfg(env);
  const why = !c.payTo ? 'X402_PAY_TO が未設定'
    : !c.family ? 'X402_NETWORK が未知'
      : !addressMatches(c.payTo, c.family) ? `受け取り先が ${c.net?.label || c.family} の形式ではありません`
        : null;
  return X402_CATALOG.map((it) => ({
    resource: it.resource, description: it.description, label_ja: it.label_ja || null, unit: it.unit, free_tier: !!it.free_tier,
    price_usdc: priceOf(it, env), price_label: `${(priceOf(it, env) / 1e6).toFixed(2)} USDC`,
    network: c.caip2, networks: netOptions(env).map((o) => o.caip2), network_name: c.net?.label || null, family: c.family, asset: c.asset,
    pay_to: c.payTo, sellable: x402Enabled(env), blocked_reason: why,
  }));
}

// ---------------------------------------------------------------- facilitator への問い合わせ
// /supported は「この facilitator が exact をどのネットワークで扱えるか」を返す。
// 応答の形は実装ごとに揺れるので、木をたどって (scheme, network) の組を探す。
const supportedCache = new Map(); // facilitator URL -> { at, kinds }
const SUPPORTED_TTL_MS = 60 * 60 * 1000; // 値札の応答を速く保つ（監査で 3.3 秒 → 1.5 秒未満が基準）

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
    const sUrl = `${c.facilitator}/supported`;
    const sAuth = await facilitatorAuthHeaders({ env, method: 'GET', url: sUrl });
    const r = await fetchImpl(sUrl, { headers: { accept: 'application/json', ...sAuth } });
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
  // 追加の受け口（Solana）。facilitator が exact / solana を扱い、feePayer を提示しているときだけ足す。
  // 扱えないものを値札に載せると、買い手は払えない選択肢を掴まされる。
  let solanaFeePayer = null;
  const solTo = String(env.X402_SOLANA_PAY_TO || '').trim();
  if (solTo && isSolanaAddress(solTo) && c.family !== 'svm') {
    const sn = resolveNetwork('solana');
    const sk = kinds.find((k) => k.scheme === 'exact' && (k.network === sn.caip2 || k.network === 'solana'));
    const sfp = pickFeePayer(sk);
    if (sfp && isSolanaAddress(sfp)) solanaFeePayer = sfp;
  }
  return { ok: true, caip2: c.caip2, family: c.family, asset: c.asset, feePayer, solanaFeePayer, network_name: c.net?.label || null };
}

/** 402 で返す値札（v2 の PAYMENT-REQUIRED ヘッダに Base64 で入れる中身）。 */
export function challenge(resource, env = {}, { origin = '', feePayer = null, method = 'POST', solanaFeePayer = null } = {}) {
  const c = cfg(env);
  const item = X402_CATALOG.find((i) => i.resource === resource);
  if (!item) return null;
  if (!c.payTo) return { configured: false, reason: 'X402_PAY_TO が未設定のため、x402 の売り物は出していません' };
  if (!c.family) return { configured: false, reason: `X402_NETWORK=${c.networkRaw} を解釈できません` };
  if (!addressMatches(c.payTo, c.family)) return { configured: false, reason: '受け取り先の形式がネットワークと一致しません' };
  const fp = feePayer || c.feePayer;
  // Solana の feePayer は facilitator が提示する（EVM では不要）。
  const solFee = solanaFeePayer || env.X402_FEE_PAYER || (c.family === 'svm' ? fp : null);
  const opts = netOptions(env, { solanaFeePayer: solFee });
  const dom = eip712For(env, c.asset);
  if (c.family === 'svm' && !isSolanaAddress(fp)) {
    return { configured: false, reason: 'Solana は feePayer の提示が必須です（facilitator から取得できていません）' };
  }
  const accepts = opts.map((o) => {
    const a = {
      scheme: 'exact', network: o.caip2, asset: o.asset, payTo: o.payTo || c.payTo,
      // v2 の正式名は amount（最小単位）。v1 名も併記して古い facilitator でも読めるようにする。
      amount: String(priceOf(item, env)),
      maxAmountRequired: String(priceOf(item, env)),
      resource: `${origin}${env.X402_TESTNET === '1' ? '/api/x402-testnet/' : '/api/x402/'}${item.resource}`,
      description: (LISTING[item.resource] || item).description, mimeType: 'application/json', maxTimeoutSeconds: c.timeout,
    };
    a.extra = { ...(eip712For(env, o.asset) || {}), ...(o.family === 'svm' && (o.feePayer || fp) ? { feePayer: o.feePayer || fp } : {}) };
    return a;
  });
  return {
    configured: true,
    body: {
      x402Version: X402_VERSION,
      extensions: { bazaar: bazaarExtension(item.resource, { method }) },
      error: 'payment required',
      resource: { url: `${origin}${env.X402_TESTNET === '1' ? '/api/x402-testnet/' : '/api/x402/'}${item.resource}`, description: (LISTING[item.resource] || item).description, mimeType: 'application/json', serviceName: (LISTING[item.resource] || {}).serviceName || 'Wealth Agent', tags: (LISTING[item.resource] || {}).tags || ['x402'] },
      accepts,
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

  const opts = netOptions(env, { solanaFeePayer: feePayer || env.X402_FEE_PAYER || null });
  const wanted = String(payment?.accepted?.network || payment?.network || '').trim();
  const chosen = (wanted ? opts.find((o) => o.caip2 === wanted) : opts[0]) || null;
  if (!chosen) return { ok: false, error: 'network_not_offered', detail: wanted };
  const requirements = {
    scheme: 'exact', network: chosen.caip2, asset: chosen.asset, payTo: chosen.payTo || c.payTo,
    amount: String(priceOf(item, env)),
    resource, maxTimeoutSeconds: c.timeout,
  };
  const fp = chosen.feePayer || feePayer || c.feePayer;
  const dom = eip712For(env, chosen.asset);
  requirements.extra = { ...(dom || {}), ...(chosen.family === 'svm' && fp ? { feePayer: fp } : {}) };

  // 1) 値段を下回る支払いを先に弾く。読める形のときだけ自前で確認する
  //    （Solana のペイロードは base64 の取引そのもので、金額は facilitator しか判定できない）。
  const amt = Number(
    payment?.payload?.authorization?.value        // EVM: EIP-3009
    ?? payment?.accepted?.amount ?? payment?.payload?.amount ?? payment?.amount
    ?? 0,
  );
  const readableAmount = Number.isFinite(amt) && amt > 0;
  const want = priceOf(item, env);
  if (readableAmount && amt < want) {
    return { ok: false, error: 'underpaid', required: want, got: amt };
  }
  try {
    const post = async (path) => {
      const fUrl = `${c.facilitator}${path}`;
      const auth = await facilitatorAuthHeaders({ env, method: 'POST', url: fUrl });
      const r = await fetchImpl(fUrl, {
        method: 'POST', headers: { 'content-type': 'application/json', ...auth },
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
    const amount = Number(vj?.amount ?? (readableAmount ? amt : want)) || want;
    return {
      ok: true, payer: vj?.payer || sj?.payer || payment?.payload?.authorization?.from || null,
      // Solana の payer は手数料を肩代わりしたアカウント（買い手とは限らない）。
      payer_role: chosen.family === 'svm' ? 'fee_payer' : 'buyer',
      amount, currency: 'USDC', fee: 0,
      tx: sj?.transaction || null,
      response: {
        success: true, network: chosen.caip2, transaction: sj?.transaction || null,
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
// 資産ごとの EIP-712 ドメイン。買い手はこれが無いと署名を作れない。
const EIP712_DOMAINS = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { name: 'USD Coin', version: '2' }, // USDC on Base
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { name: 'USDC', version: '2' },      // USDC on Base Sepolia
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { name: 'USD Coin', version: '2' }, // USDC on Arbitrum
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { name: 'USD Coin', version: '2' }, // USDC on Polygon
  '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': { name: 'USD Coin', version: '2' }, // USDC on Avalanche
  '0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392': { name: 'USDC', version: '2' }, // USDC on Sei（オンチェーンで name()=USDC を実測）
  '0xb6ceceab302e2e4948951ee7843fc24e92933061': { name: 'USDC', version: '2' }, // USDC on X Layer（オンチェーンで name()=USDC を実測）
};
function eip712For(env, asset) {
  const hit = EIP712_DOMAINS[String(asset || '').toLowerCase()];
  if (hit) return hit;
  const n = env.X402_EIP712_NAME; const v = env.X402_EIP712_VERSION;
  return n && v ? { name: n, version: v } : null;
}

// 品目の入力スキーマ（発見メタデータ用。エージェントが値札だけで正しい呼び出しを組み立てられるようにする）
export const INPUT_SCHEMAS = {
  brief: { type: 'object', properties: { question: { type: 'string', description: 'The question to research (5-400 chars, any language)' } }, required: ['question'] },
  'data-clean': { type: 'object', properties: { data: { type: 'string', description: 'Table as CSV / TSV text or a JSON array of objects (max 60,000 chars)' }, format: { type: 'string', enum: ['csv', 'tsv', 'json'], description: 'Optional input format; auto-detected when omitted' } }, required: ['data'] },
  'code-review': { type: 'object', properties: { code: { type: 'string', description: 'Source code to review (10-60,000 chars)' }, language: { type: 'string', description: 'Optional language hint, e.g. javascript, python, go' } }, required: ['code'] },
  'surface-report': { type: 'object', properties: { url: { type: 'string', description: 'Public https URL to inspect (site root or any public page on it)' }, focus: { type: 'string', description: 'Optional: what you want to learn, e.g. "how do I call their API"' } }, required: ['url'] },
};
export const INPUT_EXAMPLES = {
  brief: { question: 'x402 に対応した facilitator を比較して' },
  'data-clean': { data: 'name,price\nA,100\nA,100\nB,' },
  'code-review': { code: 'function add(a,b){ return a+b }', language: 'javascript' },
  'surface-report': { url: 'https://example.com' },
};

/** x402 Bazaar（CDP の索引）に載るための発見メタデータ。402 応答の extensions に入れる。 */
// 出力の例は実際の納品物の形（{ok, resource, status, deliverable:{...}}）に合わせる。
export const OUTPUT_EXAMPLES = {
  brief: { ok: true, resource: 'brief', status: 'delivered', deliverable: { kind: 'brief', summary: 'Sourced one-page answer', findings: ['finding with citation'], gaps: ['what could not be verified'], sources: [{ title: 'Doc', url: 'https://example.com/doc' }] } },
  'data-clean': { ok: true, resource: 'data-clean', status: 'delivered', deliverable: { kind: 'data-clean', summary: '3 rows -> 2 rows', changes: { duplicates_removed: 1, empty_rows_removed: 0, cells_trimmed: 0 }, csv: 'name,price\nA,100\nB,' } },
  'code-review': { ok: true, resource: 'code-review', status: 'delivered', deliverable: { kind: 'code-review', summary: '8 lines checked', static_findings: [{ rule: 'sqlcat', severity: 'high', line: 6, message: 'SQL string concatenation' }], ai_review: { findings: [{ line: 6, severity: 'high', issue: 'SQL injection', fix: 'Use placeholders', confidence: 'high' }] } } },
};
const DELIVERABLE_PROPS = {
  brief: { kind: { type: 'string' }, summary: { type: 'string' }, findings: { type: 'array', items: {} }, gaps: { type: 'array', items: {} }, sources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } } } } },
  'data-clean': { kind: { type: 'string' }, summary: { type: 'string' }, changes: { type: 'object', properties: { duplicates_removed: { type: 'integer' }, empty_rows_removed: { type: 'integer' }, cells_trimmed: { type: 'integer' } } }, csv: { type: 'string' } },
  'code-review': { kind: { type: 'string' }, summary: { type: 'string' }, static_findings: { type: 'array', items: { type: 'object', properties: { rule: { type: 'string' }, severity: { type: 'string' }, line: { type: 'integer' }, message: { type: 'string' } } } }, ai_review: { type: ['object', 'null'] } },
};
export function outputSchema(resource) {
  return {
    type: 'object', required: ['ok', 'resource', 'status', 'deliverable'],
    properties: {
      ok: { type: 'boolean' }, resource: { type: 'string' }, status: { type: 'string', enum: ['delivered', 'paid_not_delivered'] },
      job_id: { type: ['string', 'null'] }, receipt_id: { type: ['string', 'null'] }, tx: { type: ['string', 'null'] },
      deliverable: { type: ['object', 'null'], required: ['kind', 'summary'], properties: DELIVERABLE_PROPS[resource] || {} },
      error: { type: ['string', 'null'] }, note: { type: 'string' },
    },
  };
}

// Coinbase の検証器は「bazaar.info.input.method が実際のリクエストの method と一致するか」を見る
// （GET で叩かれた値札に POST と書くと valid=false）。GET でも同じ入力を query で受け付けるので、
// 叩かれた method に合わせて書く。
export function bazaarExtension(resource, { method = 'POST' } = {}) {
  const body = INPUT_SCHEMAS[resource] || { type: 'object' };
  const m = String(method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const ex = INPUT_EXAMPLES[resource] || {};
  const input = m === 'GET'
    ? { type: 'http', method: 'GET', queryParams: Object.fromEntries(Object.entries(ex).map(([k, v]) => [k, String(v)])) }
    : { type: 'http', method: 'POST', bodyType: 'json', body: ex };
  const inputSchema = m === 'GET'
    ? { type: 'object', required: ['type', 'method'], properties: { type: { type: 'string', const: 'http' }, method: { type: 'string', enum: ['GET'] }, queryParams: body } }
    : { type: 'object', required: ['type', 'method', 'bodyType', 'body'], properties: { type: { type: 'string', const: 'http' }, method: { type: 'string', enum: ['POST'] }, bodyType: { type: 'string', enum: ['json'] }, body } };
  return {
    info: { input, output: { type: 'json', example: OUTPUT_EXAMPLES[resource] || {} } },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
      properties: { input: inputSchema, output: { type: 'object', properties: { type: { type: 'string' }, example: outputSchema(resource) } } },
      required: ['input'],
    },
  };
}

/** 発見用フィード（Circle の Discovery API と同じ形）。買い側エージェントが1回の GET で全部読める。 */
export function discoveryFeed(env = {}, origin = '') {
  const base = origin || 'https://wealth-agent.wealthagent-app.workers.dev';
  const c = cfg(env);
  const items = X402_CATALOG.map((item) => ({
    resource: `${base}/api/x402/${item.resource}`,
    type: 'http',
    x402Version: X402_VERSION,
    accepts: netOptions(env).map((o) => ({ scheme: 'exact', network: o.caip2, asset: o.asset, amount: String(item.price_usdc), payTo: c.payTo, extra: eip712For(env, o.asset) || undefined })),
    metadata: {
      provider: { name: 'Wealth-A', description: '出典つき調査・表データ整形・コード静的検査をエージェントに売る自律エージェント', category: 'WEB_SEARCH_RESEARCH', tags: ['x402', 'research', 'data-cleaning', 'code-review'], website: base },
      path: `/api/x402/${item.resource}`, method: 'POST', description: (LISTING[item.resource] || item).description, serviceName: (LISTING[item.resource] || {}).serviceName, tags: (LISTING[item.resource] || {}).tags, mimeType: 'application/json',
      input: INPUT_SCHEMAS[item.resource] || { type: 'object' },
      supportsVanillax402: true,
    },
    agent: { a2a: `${base}/.well-known/agent-card.json`, mcp: `${base}/mcp` },
  }));
  // 外部クローラ（x402scan の Discovery & Registration Spec）が読む形を必ず含める。
  // version / resources / ownershipProofs が無いと「発見できない」＝売り場に並ばない。
  const resources = items.map((it) => it.resource);
  const ownershipProofs = [c.payTo, env.X402_SOLANA_PAY_TO].filter(Boolean);
  return {
    version: 1,
    resources,
    ownershipProofs,
    instructions: 'Every resource is a POST endpoint gated by x402 (USDC, scheme exact). Send no payment first: the 402 carry the price quote in the PAYMENT-REQUIRED header. Retry the same request with PAYMENT-SIGNATURE to get the deliverable. No account and no API key are needed.',
    x402Version: X402_VERSION, items, pagination: { limit: 50, offset: 0, total: items.length },
  };
}

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

// 軽量品の入出力仕様（Bazaar の索引と買い手の期待値合わせに使う）。
Object.assign(INPUT_SCHEMAS, {
  'url-meta': { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'Absolute http(s) URL of a public page' } } },
  'csv-json': { type: 'object', required: ['data'], properties: { data: { type: 'string', description: 'CSV/TSV text or a JSON array of objects' }, to: { type: 'string', enum: ['json', 'csv'], description: 'Target format (optional; inferred when omitted)' } } },
  regex: { type: 'object', required: ['pattern', 'text'], properties: { pattern: { type: 'string', description: 'Regular expression (max 200 chars)' }, text: { type: 'string', description: 'Text to search (max 20,000 chars)' }, flags: { type: 'string', description: 'g, i, m, s, u, y (optional)' } } },
  diff: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'string', description: 'Original text' }, b: { type: 'string', description: 'Changed text' } } },
});
Object.assign(INPUT_EXAMPLES, {
  'url-meta': { url: 'https://x402.org/' },
  'csv-json': { data: 'name,price\nA,100\nB,250', to: 'json' },
  regex: { pattern: 'ERROR (\\w+)', text: 'ERROR timeout\nINFO ok\nERROR io', flags: 'g' },
  diff: { a: 'line1\nline2\nline3', b: 'line1\nline2 changed\nline3\nline4' },
});
Object.assign(OUTPUT_EXAMPLES, {
  'url-meta': { kind: 'url-meta', status: 200, title: 'x402', description: 'Payment standard for the internet', links_count: 42, text_chars: 1830, took_ms: 240 },
  'csv-json': { kind: 'csv-json', direction: 'to-json', rows: 2, columns: ['name', 'price'], json: [{ name: 'A', price: 100 }] },
  regex: { kind: 'regex', count: 2, matches: [{ match: 'ERROR timeout', index: 0, groups: ['timeout'] }] },
  diff: { kind: 'diff', added: 2, removed: 1, hunk_count: 1, unified: '@@ -1,3 +1,4 @@' },
});
