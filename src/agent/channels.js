// Sales channels (収益チャネル) ledger.
//
// Each channel knows three things the agent needs in order to be honest about
// money: what it costs (platform + payment fees), whether an autonomous agent
// can actually operate it (KYC / review / manual listing), and what currency it
// pays out in. Fees are configuration, not truth — every entry carries
// `verified` and a `source`, and the UI prints 未確認 next to anything we have
// not read on the vendor's own page.

import { nowIso } from '../util.js';

/**
 * fee model per channel:
 *   platform_pct   % of gross taken by the marketplace
 *   platform_fixed fixed fee per sale (in the channel's sale currency)
 *   processing     true when card/payment processing is charged ON TOP
 *   pricing_note   the exact wording we verified
 * autonomy: can an automated agent run the whole loop (list -> deliver -> settle)?
 */
export const CHANNELS = [
  {
    id: 'coconala', label: 'ココナラ', country: 'JP', kind: '受託', currency: 'JPY',
    fee: { platform_pct: null, platform_fixed: 0, processing: false, pricing_note: '手数料はサービス種別ごとに異なる。要確認。' },
    verified: false, source: 'https://help.coconala.com/',
    autonomy: 'partial', human: ['本人確認', '出品（人手）'],
    ai_policy: 'AI生成の文章・PDFは可。AI生成イラストは不可。',
  },
  {
    id: 'crowdworks', label: 'クラウドワークス', country: 'JP', kind: '受託', currency: 'JPY',
    fee: { platform_pct: 20, platform_fixed: 0, processing: false, pricing_note: '最大20%（二次情報）。要確認。' },
    verified: false, source: 'https://blog.crowdworks.jp/archives/5811/',
    autonomy: 'partial', human: ['本人確認', '提案（人手）'],
    ai_policy: 'AI利用の可否は受発注者の取り決め次第（公式ポリシー）。',
  },
  {
    id: 'lancers', label: 'ランサーズ', country: 'JP', kind: '受託', currency: 'JPY',
    fee: { platform_pct: 16.5, platform_fixed: 0, processing: false, pricing_note: '一律16.5%（二次情報）。要確認。' },
    verified: false, source: 'https://www.lancers.jp/faq/l1011/1009',
    autonomy: 'partial', human: ['本人確認', '提案（人手）'],
    ai_policy: '生成AI利用時の注意点をヘルプで案内。',
  },
  {
    id: 'fiverr', label: 'Fiverr', country: 'GLOBAL', kind: '受託', currency: 'USD',
    fee: { platform_pct: 20, platform_fixed: 0, processing: false, pricing_note: '受注者手数料20%（要確認）。' },
    verified: false, source: 'https://help.fiverr.com/',
    autonomy: 'partial', human: ['本人確認', 'ギグ作成（人手）'],
    ai_policy: 'AI利用可だが「自分の技能の補助」限定。未加工のAI出力は品質基準を満たさない。',
  },
  {
    id: 'lemonsqueezy', label: 'Lemon Squeezy', country: 'GLOBAL', kind: 'デジタル', currency: 'USD',
    fee: { platform_pct: 5, platform_fixed: 0.5, processing: false, pricing_note: '5% + 50¢ / 取引。決済手数料込み。' },
    verified: true, source: 'https://www.lemonsqueezy.com/pricing',
    autonomy: 'full', human: ['本人確認（初回）'],
    ai_policy: '自作の成果物なら可。Merchant of Record として各国VAT/売上税を納付。',
  },
  {
    id: 'payhip', label: 'Payhip', country: 'GLOBAL', kind: 'デジタル', currency: 'USD',
    fee: { platform_pct: 5, platform_fixed: 0, processing: true, pricing_note: '無料プランは 5%（二次情報）。PayPal/Stripe 手数料は別途（公式FAQ）。' },
    verified: false, source: 'https://payhip.com/pricing',
    autonomy: 'full', human: ['本人確認（初回）'],
    ai_policy: 'AI生成物は可。EU VAT / UK は自動処理。',
  },
  {
    id: 'gumroad', label: 'Gumroad', country: 'GLOBAL', kind: 'デジタル', currency: 'USD',
    fee: { platform_pct: 10, platform_fixed: 0.5, processing: true, pricing_note: '直接販売 10% + 50¢ / 売上、$0/月。決済手数料は別途。Discover 経由は 30%。' },
    verified: true, source: 'https://gumroad.com/pricing',
    autonomy: 'full', human: ['本人確認（初回）'],
    ai_policy: '転売（テンプレ・プロンプト・フォント等）とAIサービスへのアクセス販売は禁止。自作なら可。',
  },
  {
    id: 'kdp', label: 'Amazon KDP', country: 'GLOBAL', kind: 'デジタル', currency: 'USD',
    fee: { platform_pct: 30, platform_fixed: 0, processing: false, pricing_note: '電子書籍はロイヤリティ30〜70%（条件別）。要確認。' },
    verified: false, source: 'https://kdp.amazon.com/help/topic/G200672390',
    autonomy: 'partial', human: ['税務情報', '出版設定'],
    ai_policy: 'AI生成の文章・画像・翻訳は開示必須。AI生成物は1日3タイトル上限（二次情報）。',
  },
  {
    id: 'creative_market', label: 'Creative Market', country: 'GLOBAL', kind: 'デジタル', currency: 'USD',
    fee: { platform_pct: null, platform_fixed: 0, processing: false, pricing_note: '手数料は要確認。' },
    verified: false, source: 'https://support.creativemarket.com/hc/en-us/articles/26926388691099',
    autonomy: 'partial', human: ['出品（人手）'],
    ai_policy: 'AI生成物は可（AIラベルの開示が必要）。',
  },
  {
    id: 'etsy', label: 'Etsy', country: 'GLOBAL', kind: 'デジタル', currency: 'USD',
    fee: { platform_pct: null, platform_fixed: 0.2, processing: true, pricing_note: '出品手数料 $0.20 + 取引手数料等。要確認。' },
    verified: false, source: 'https://www.etsy.com/seller-handbook/article/1275449912004',
    autonomy: 'none', human: ['本人確認', '出品（人手）'],
    ai_policy: 'AI生成物は可（説明欄での開示が必須）。プロンプト束の販売は禁止。',
  },
  {
    id: 'envato', label: 'Envato (Market/Elements)', country: 'GLOBAL', kind: 'デジタル', currency: 'USD',
    fee: { platform_pct: null, platform_fixed: 0, processing: false, pricing_note: '—' },
    verified: true, source: 'https://help.author.envato.com/hc/en-us/articles/13313674070681',
    autonomy: 'none', human: ['—'],
    ai_policy: 'AI生成物の販売は禁止（プレビュー画像のみ可）。',
    blocked: true, blocked_reason: '規約で販売不可',
  },
  {
    id: 'rapidapi', label: 'RapidAPI', country: 'GLOBAL', kind: 'API', currency: 'USD',
    fee: { platform_pct: 25, platform_fixed: 0, processing: false, pricing_note: 'マーケット手数料 25% 一律。出金は PayPal のみ。' },
    verified: true, source: 'https://docs.rapidapi.com/docs/payouts-and-finance',
    autonomy: 'full', human: ['本人確認（初回）'],
    ai_policy: '自作APIの出品可。',
  },
  {
    id: 'apify', label: 'Apify Store', country: 'GLOBAL', kind: 'API', currency: 'USD',
    fee: { platform_pct: 20, platform_fixed: 0, processing: false, pricing_note: 'Pay-per-event は開発者に 80%。出金は銀行振込 $100 / PayPal $20 から（二次情報）。' },
    verified: false, source: 'https://apify.com/partners/actor-developers',
    autonomy: 'full', human: ['本人確認（初回）'],
    ai_policy: '自作 Actor の出品可。',
  },
  {
    id: 'adobe_stock', label: 'Adobe Stock', country: 'GLOBAL', kind: 'コンテンツ', currency: 'USD',
    fee: { platform_pct: 67, platform_fixed: 0, processing: false, pricing_note: '受取は正味価格の 33%（写真・ベクター・イラスト）、35%（動画）。' },
    verified: true, source: 'https://helpx.adobe.com/stock/contributor/payments-earnings/royalties-pricing/royalty-rates-assets.html',
    autonomy: 'partial', human: ['審査の差し戻し対応', '出金口座の設定'],
    ai_policy: 'AI生成物は提出可。アップロード時に Generative AI のラベルが必須。実在の人物・場所・物を指す内容は不可。',
  },
  {
    id: 'shutterstock', label: 'Shutterstock', country: 'GLOBAL', kind: 'コンテンツ', currency: 'USD',
    fee: { platform_pct: null, platform_fixed: 0, processing: false, pricing_note: '—' },
    verified: true, source: 'https://submit.shutterstock.com/help/en/articles/10594676-ai-generated-content-on-shutterstock-contributor-faq',
    autonomy: 'none', human: ['—'],
    ai_policy: 'AI生成物の投稿は受け付けない（公式FAQで明示）。',
    blocked: true, blocked_reason: '規約でAI生成物の投稿が不可',
  },
  {
    id: 'depin_bandwidth', label: '回線の共有 (Honeygain / Grass 等)', country: 'GLOBAL', kind: 'その他', currency: 'USD',
    fee: { platform_pct: null, platform_fixed: 0, processing: false, pricing_note: '回線と地域で収益が大きく変動し、公表された歩率が無い。要確認。' },
    verified: false, source: 'https://www.honeygain.com/blog/how-to-sell-bandwidth/',
    autonomy: 'full', human: ['アカウント作成（初回）'],
    ai_policy: '規約上は可。ただし自宅回線を第三者に再販する仕組みなので、ISP の規約と IP の評判リスクを確認すること。',
    risk: 'high',
  },
  {
    id: 'x402', label: 'x402 直販 (自前API)', country: 'GLOBAL', kind: 'API', currency: 'USDC',
    fee: { platform_pct: 0, platform_fixed: 0, processing: false, pricing_note: 'プラットフォーム手数料ゼロ。ネットワーク手数料のみ（Solana は $0.00025 水準）。' },
    verified: true, source: 'https://solana.com/x402',
    autonomy: 'full', human: [],
    ai_policy: '自前の資源なので規約審査なし。KYC も不要。',
  },
  {
    id: 'note', label: 'note（有料記事・メンバーシップ）', country: 'JP', kind: 'コンテンツ', currency: 'JPY',
    fee: { platform_pct: 20, platform_fixed: 0, processing: true, pricing_note: '有料記事は手数料 20% 前後（要確認）。' },
    verified: false, source: 'https://note.com/',
    autonomy: 'none', human: ['記事投稿（人手）'],
    ai_policy: 'AI生成の開示が望ましい。',
  },
];

export const BLOCKED = CHANNELS.filter((c) => c.blocked).map((c) => c.id);

export function channelById(id) {
  return CHANNELS.find((c) => c.id === id) || null;
}

/**
 * Net proceeds of one sale on one channel.
 * gross is in the channel's sale currency; `processing_pct/_fixed` is the card
 * processor's cut, applied only when the channel does not bundle it.
 */
export function netOf(id, gross, opts = {}) {
  const c = channelById(id);
  if (!c) return null;
  if (c.blocked) return { channel: c.id, blocked: true, reason: c.blocked_reason };
  // 手数料が未確認のチャネルを「手数料0」として扱わない。不明は不明として返す。
  if (c.fee.platform_pct == null) {
    return {
      channel: c.id, label: c.label, gross: Number(gross) || 0,
      platform_fee: null, processing_fee: null, net: null, take_pct: null,
      exact: false, note: '手数料が未確認のため手残りは出さない',
    };
  }
  const g = Number(gross) || 0;
  const pct = c.fee.platform_pct == null ? null : (g * c.fee.platform_pct) / 100;
  const platform = pct == null ? null : pct + (c.fee.platform_fixed || 0);
  const proc = c.fee.processing
    ? (g * (opts.processing_pct ?? 2.9)) / 100 + (opts.processing_fixed ?? 0.3)
    : 0;
  const fees = (platform || 0) + proc;
  return {
    channel: c.id,
    label: c.label,
    gross: g,
    platform_fee: platform == null ? null : Number(platform.toFixed(3)),
    processing_fee: Number(proc.toFixed(3)),
    net: Number((g - fees).toFixed(3)),
    take_pct: g ? Number(((fees / g) * 100).toFixed(1)) : null,
    exact: platform != null,
  };
}

/** Which channels an autonomous agent can actually operate end-to-end. */
export function autonomyReport() {
  const full = CHANNELS.filter((c) => c.autonomy === 'full' && !c.blocked);
  const partial = CHANNELS.filter((c) => c.autonomy === 'partial' && !c.blocked);
  const none = CHANNELS.filter((c) => c.autonomy === 'none' || c.blocked);
  return { full, partial, none, human_only: [...new Set([...partial, ...none].flatMap((c) => c.human))] };
}

/** Rank channels by what the agent keeps, per $19 sale. */
export function rankByNet(gross = 19, opts = {}) {
  return CHANNELS.filter((c) => !c.blocked)
    .map((c) => {
      const n = netOf(c.id, gross, opts);
      return {
        id: c.id, label: c.label, kind: c.kind, currency: c.currency,
        net: n.net, take_pct: n.take_pct, exact: n.exact,
        autonomy: c.autonomy, verified: c.verified,
      };
    })
    .sort((a, b) => (b.net ?? -1) - (a.net ?? -1));
}

export function channelCard(gross = 19) {
  const rows = rankByNet(gross);
  const report = autonomyReport();
  return {
    head: {
      label: 'チャネル比較',
      value: `${rows.length} 本`,
      unit: `${gross} の販売で手残り順`,
      tone: 'accent',
    },
    lanes: rows.slice(0, 8).map((r) => ({
      label: r.exact ? r.label : `${r.label}（要確認）`,
      value: r.net == null ? '—' : `${r.net}`,
      unit: `${r.currency} · 手数料 ${r.take_pct == null ? '?' : `${r.take_pct}%`}${r.autonomy === 'full' ? ' · 無人可' : ''}`,
      tone: r.autonomy === 'full' ? 'ok' : r.autonomy === 'none' ? 'mut' : 'warn',
    })),
    blocked: CHANNELS.filter((c) => c.blocked).map((c) => c.label),
    human_only: report.human_only,
    checked_at: nowIso(),
  };
}

export function channelHelp() {
  return [
    '手数料・規約は各社の公式ページで確認したものだけ「確定」として扱い、それ以外は「要確認」と表示します。',
    '無人で回せる（autonomy=full）チャネルだけが、あなたの手を借りずに売上を積めます。',
    '規約で販売不可のチャネルは候補から外れます。',
  ].join('\n');
}
