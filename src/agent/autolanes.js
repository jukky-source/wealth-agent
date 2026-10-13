// Automatic earning lanes (自動で稼げる売り場) — ranked by HOW MUCH HUMAN WORK
// each one costs. The owner's binding constraint is his own time, not money, so
// every lane declares: hands (how often a person must touch it), discovery (how
// a buyer actually finds it), and the fees. Fees come from channels.js so there
// is ONE source of truth; anything unverified stays null and prints as 要確認.

import { nowIso } from '../util.js';
import { channelById, netOf } from './channels.js';

export const HANDS = { none: 'none', once: 'once', often: 'often' };
export const HANDS_RANK = { none: 0, once: 1, often: 2 };
export const HANDS_LABEL = { none: '人手ゼロ', once: '立ち上げ1回だけ', often: '定期メンテ要' };
export const DISCOVERY_LABEL = {
  marketplace: '売り場の検索が客を連れる',
  registry: 'エージェントが自動発見',
  pull: '自分で告知が要る',
};

export const AUTO_LANES = [
  {
    id: 'monitor_subscription', label: '監視型サブスク（変化だけ毎日届ける）', kind: '監視',
    channel: 'x402', hands: 'once', setup_minutes: 30, discovery: 'pull',
    revenue_shape: 'サブスク / 従量', price_model: '月額、または1チェック課金',
    needs: [], note: '原価0。条件が変わるたびに課金が積み上がる。告知だけ人が要る。',
    verified: true, source: 'https://solana.com/x402',
  },
  {
    id: 'mcp_tool', label: 'MCPツールとして公開（エージェントが買う）', kind: 'MCP',
    channel: 'x402', hands: 'once', setup_minutes: 45, discovery: 'registry',
    revenue_shape: '従量', price_model: '1呼び出し課金',
    needs: [],
    note: '買い手がエージェントなので、人が見つける必要がない。既存APIをそのまま出す。',
    verified: true, source: 'https://docs.x402.org/guides/mcp-server-with-x402',
  },
  {
    id: 'apify_store', label: 'Apify Store に Actor を出品', kind: 'API',
    channel: 'apify', hands: 'once', setup_minutes: 60, discovery: 'marketplace',
    revenue_shape: '従量', price_model: 'Pay-per-event',
    needs: [], note: '売り場の検索が客を連れてくる＝自分で集客しない。',
    verified: false, source: 'https://apify.com/partners/actor-developers',
  },
  {
    id: 'rapidapi', label: 'RapidAPI に API を出品', kind: 'API',
    channel: 'rapidapi', hands: 'once', setup_minutes: 40, discovery: 'marketplace',
    revenue_shape: '従量', price_model: 'サブスク枠 + 従量',
    needs: [], note: '出金は PayPal のみ（銀行振込なし）。',
    verified: true, source: 'https://docs.rapidapi.com/docs/payouts-and-finance',
  },
  {
    id: 'x402_api', label: 'x402 直販（自分のAPIに値札を付ける）', kind: 'API',
    channel: 'x402', hands: 'once', setup_minutes: 30, discovery: 'pull',
    revenue_shape: '従量', price_model: '1呼び出し課金（USDC）',
    needs: [], note: '手数料ゼロ。ただし自分で知らせないと誰も来ない。',
    verified: true, source: 'https://solana.com/x402',
  },
  {
    id: 'lemonsqueezy', label: 'Lemon Squeezy でデジタル商品を販売', kind: 'デジタル',
    channel: 'lemonsqueezy', hands: 'once', setup_minutes: 45, discovery: 'pull',
    revenue_shape: '在庫', price_model: '買い切り',
    needs: ['本人確認（初回）'], note: '日本の銀行へ着金可。海外税務は MoR 側が納付。',
    verified: true, source: 'https://www.lemonsqueezy.com/pricing',
  },
  {
    id: 'payhip', label: 'Payhip でデジタル商品を販売（保険）', kind: 'デジタル',
    channel: 'payhip', hands: 'once', setup_minutes: 40, discovery: 'pull',
    revenue_shape: '在庫', price_model: '買い切り',
    needs: ['本人確認（初回）'], note: 'Lemon Squeezy の審査に落ちたときの代替。',
    verified: false, source: 'https://payhip.com/pricing',
  },
  {
    id: 'github_sponsors', label: 'GitHub で OSS 公開 → Sponsors', kind: 'その他',
    channel: null, hands: 'often', setup_minutes: 60, discovery: 'pull',
    revenue_shape: '寄付', price_model: '任意',
    needs: [], note: '手数料は GitHub 側の設定で変わり未確認。定期的な発信が要る。',
    verified: false, source: 'https://docs.github.com/sponsors',
  },
  {
    id: 'adobe_stock', label: 'Adobe Stock へ素材を投入', kind: 'コンテンツ',
    channel: 'adobe_stock', hands: 'often', setup_minutes: 90, discovery: 'marketplace',
    revenue_shape: '在庫', price_model: '従量（受取33%）',
    needs: ['審査の差し戻し対応'],
    note: '審査2〜4週。差し戻し対応が人の仕事になるので放置ではない。',
    verified: true,
    source: 'https://helpx.adobe.com/stock/contributor/payments-earnings/royalties-pricing/royalty-rates-assets.html',
  },
];

// 監視型サブスク = 「毎日見張って、変わったときだけ届ける」を売る形。
// 原価0・在庫なし・従量で積み上がる。既存の watch.js（見張り）がそのまま商品になる。
// 価格は提案であり、確認済みの相場ではない（proposed: true）。
export const MONITOR_PRODUCTS = [
  {
    id: 'price_watch', label: '価格の見張り', what: '競合や対象商品の価格',
    input: 'URL または 商品名', cadence: '毎時 / 毎日',
    price_model: '月額 または 1チェック課金',
    suggested: { amount: 5, currency: 'USD', per: '月', proposed: true },
    cost: 0, build_minutes: 30, discovery: 'pull', needs: [],
  },
  {
    id: 'stock_watch', label: '在庫・再入荷の見張り', what: '対象商品の在庫と再入荷',
    input: 'URL', cadence: '毎時',
    price_model: '月額 または 1チェック課金',
    suggested: { amount: 5, currency: 'USD', per: '月', proposed: true },
    cost: 0, build_minutes: 25, discovery: 'pull', needs: [],
  },
  {
    id: 'page_watch', label: 'ページ差分の見張り', what: '規約・仕様・告知ページの変更',
    input: 'URL', cadence: '毎日',
    price_model: '月額 または 1チェック課金',
    suggested: { amount: 9, currency: 'USD', per: '月', proposed: true },
    cost: 0, build_minutes: 25, discovery: 'pull', needs: [],
  },
  {
    id: 'keyword_watch', label: '新着の見張り', what: '求人・公募・入札の新着',
    input: 'キーワード', cadence: '毎時 / 毎日',
    price_model: '月額 または 1チェック課金',
    suggested: { amount: 9, currency: 'USD', per: '月', proposed: true },
    cost: 0, build_minutes: 35, discovery: 'pull', needs: [],
  },
  {
    id: 'reputation_watch', label: '評判・レビューの見張り', what: '自社・競合の評判の変化',
    input: '社名 / キーワード', cadence: '毎日',
    price_model: '月額 または 1チェック課金',
    suggested: { amount: 9, currency: 'USD', per: '月', proposed: true },
    cost: 0, build_minutes: 35, discovery: 'pull', needs: [],
  },
  {
    id: 'regulation_watch', label: '規制・告示の見張り', what: '官公庁の告示・ガイドライン改訂',
    input: '所管 / キーワード', cadence: '毎日',
    price_model: '月額 または 1チェック課金',
    suggested: { amount: 19, currency: 'USD', per: '月', proposed: true },
    cost: 0, build_minutes: 40, discovery: 'pull', needs: [],
  },
];

export function laneById(id) {
  return AUTO_LANES.find((l) => l.id === id) || null;
}

/** 手残り（channels.js が唯一の出所）。チャネル無し／手数料未確認は null。 */
export function laneNet(id, gross = 19) {
  const l = laneById(id);
  if (!l || !l.channel) return null;
  const n = netOf(l.channel, gross);
  return n && n.net != null ? n.net : null;
}

export function laneTakePct(id) {
  const l = laneById(id);
  if (!l || !l.channel) return null;
  const n = netOf(l.channel, 100);
  return n ? n.take_pct : null;
}

/** 手間の少ない順 → 手残りの多い順。束縛条件は「俺の時間」。 */
export function rankByLeastHands(gross = 19) {
  return AUTO_LANES.map((l) => ({
    id: l.id, label: l.label, kind: l.kind, hands: l.hands,
    hands_label: HANDS_LABEL[l.hands], setup_minutes: l.setup_minutes,
    discovery: l.discovery, discovery_label: DISCOVERY_LABEL[l.discovery],
    net: laneNet(l.id, gross), take_pct: laneTakePct(l.id), verified: l.verified,
  })).sort((a, b) => (HANDS_RANK[a.hands] - HANDS_RANK[b.hands]) || ((b.net ?? -1) - (a.net ?? -1)));
}

/**
 * 手間最小の推奨構成。要点は「自分で告知しなくても客が来る所」だけを選ぶこと。
 * marketplace=売り場の検索、registry=エージェントの自動発見。pull は告知が要る。
 */
export function autoPlan() {
  const ranked = rankByLeastHands();
  const unattended = ranked.filter((r) => r.hands !== 'often');
  const selfServing = unattended.filter((r) => r.discovery === 'marketplace' || r.discovery === 'registry');
  return {
    chosen: selfServing.slice(0, 3),
    recurring: MONITOR_PRODUCTS.map((p) => p.id),
    rationale: '売り場の検索かエージェントが客を連れてくる所だけを選ぶ（自分で告知しない）。告知が要る直販は、告知が苦でない時だけ足す。',
    excluded: ranked.filter((r) => r.hands === 'often').map((r) => r.id),
    residual_human: [...new Set([...unattended.flatMap((r) => (laneById(r.id)?.needs) || [])])],
  };
}

export function laneCard(gross = 19) {
  const rows = rankByLeastHands(gross);
  const plan = autoPlan();
  const top = rows.slice(0, 8);
  return {
    head: {
      label: '手間の少ない順',
      value: `${rows.length} 本`,
      unit: `${gross} の販売・手残り順`,
      tone: 'accent',
    },
    lanes: top.map((r) => ({
      label: `${r.label}`,
      value: r.net == null ? '手残り未確認' : `${r.net}`,
      unit: `${r.hands_label} · 立ち上げ${r.setup_minutes}分 · ${r.discovery_label}`,
      tone: r.hands === 'often' ? 'warn' : r.net == null ? 'mut' : 'ok',
    })),
    blocked: [],
    human_only: plan.residual_human,
    checked_at: nowIso(),
  };
}

export function autoLaneCards(gross = 19) {
  const plan = autoPlan();
  const kpi = {
    type: 'kpi',
    title: '手間を最小にした構成',
    items: [
      { label: '立ち上げ', value: plan.chosen.reduce((a, c) => a + c.setup_minutes, 0), unit: '分（1回だけ）' },
      { label: '以後の人手', value: 0, unit: '分/日' },
      { label: '継続課金', value: plan.recurring.length, unit: '本（監視型）' },
    ],
  };
  const list = {
    type: 'list',
    title: 'この順で置く（集客も自動の所だけ）',
    items: plan.chosen.map((c) => ({
      label: c.label,
      value: c.net == null ? '手残り未確認' : `${c.net}`,
      unit: c.discovery_label,
    })),
  };
  const note = {
    type: 'note',
    text: `理由: ${plan.rationale}　除外: ${plan.excluded.join('・') || 'なし'}`,
  };
  return [kpi, list, note];
}

export function autoLaneHelp() {
  return [
    '「手間」＝あなたが触る時間です。人手ゼロ → 立ち上げ1回だけ → 定期メンテ要、の順で並べています。',
    '「客がどこから来るか」を分けています。売り場の検索（Apify / RapidAPI）とエージェントの自動発見（MCP）は、あなたが告知しなくても売れます。直販（x402）は手数料ゼロですが、自分で知らせないと誰も来ません。',
    '手数料が未確認のチャネルは、数字を出さず「手残り未確認」と表示します。',
    '監視型サブスクは、既存の「見張り」機能がそのまま商品になります（原価0・在庫なし・毎日課金が積み上がる）。',
  ].join('\n');
}

export function monitorHelp() {
  return [
    '監視型サブスク＝「毎日見張って、変わったときだけ届ける」を売る形です。',
    '在庫を持たない・原価0・従量で積み上がるので、寝ている間も課金が伸びます。',
    '価格は提案です（確認済みの相場ではありません）。相手が既に金を払っている市場（開発者・事業者）から始めるのが安全です。',
  ].join('\n');
}
