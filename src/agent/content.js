// AI content sales（AI生成コンテンツの販売）— 規約準拠のゲート付き。
//
// なぜ「ゲート付き」なのか: 各プラットフォームが禁じているのは AI の利用そのもの
// ではなく、①量産・反復（YouTube の inauthentic content）②開示の欠落（Medium /
// Etsy / Adobe Stock / KDP）③禁止カテゴリ（Etsy のプロンプト束、Gumroad の転売・
// AIサービスへのアクセス販売、Shutterstock の AI 生成物そのもの）である。
// BAN されると入金経路ごと失うので、こちらから先に落とす。
//
// 出典（2026-10 時点で各社の公式ページを確認したものだけ `verified: true`）:
//   YouTube  inauthentic content（2025-07-15 に繰り返しコンテンツから改称）
//            https://www.layer3labs.io/guides/youtube-ai-content-policy
//   Medium   AI生成文のペイウォール掲載は不可（開示あれば通常配信は可・Boost不可）
//            https://help.medium.com/hc/en-us/articles/22576852947223-Artificial-Intelligence-AI-content-policy
//   Etsy     AI利用は可（出品説明での開示が必須）／AIプロンプト束の販売は禁止
//            https://www.etsy.com/seller-handbook/article/1275449912004
//   Adobe Stock 生成AIコンテンツは可（"Generative AI" ラベル必須・実在の人物/場所は不可）
//            https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/generative-ai-content-guidelines.html
//   Shutterstock 出品者からのAI生成物は受け付けない（公式FAQで明示）
//            https://submit.shutterstock.com/help/en/articles/10594676-ai-generated-content-on-shutterstock-contributor-faq
//   Amazon KDP AI生成は開示必須／AI生成物は1日3タイトル上限（二次情報）
//            https://kdp.amazon.com/help/topic/G200672390
//
// 手数料・規約は channels.js が唯一の出所（ここでは重複させない）。

import { nowIso, utcDay } from '../util.js';
import { DUPLICATE_THRESHOLD, similarity, weekKey } from './publish.js';

/**
 * 宛先レジストリ。`ai` は規約上そのまま出せるか:
 *   allowed               … AI生成物をそのまま出せる（開示の規定なし）
 *   allowed_with_label    … 出せるが開示・ラベルが必須
 *   forbidden             … 出すと規約違反（候補から外す）
 *   own                   … 自前の販路（プラットフォーム規約が存在しない）
 */
export const DESTINATIONS = [
  {
    id: 'x402', label: 'x402 直販（自前の販路）', kind: '直販', ai: 'allowed', needs_label: false,
    autonomy: 'full', human: [], source: 'https://docs.cdp.coinbase.com/x402/seller/get-discovered', verified: true,
    note: 'プラットフォーム規約が無い＝BANの概念が無い。買い手はエージェント。値札・決済・納品が全自動。',
  },
  {
    id: 'gumroad', label: 'Gumroad', kind: 'デジタル', ai: 'allowed_with_label', needs_label: true,
    autonomy: 'full', human: ['本人確認（初回）'], source: 'https://gumroad.com/pricing', verified: true,
    note: '自作の成果物は可。転売（テンプレ・プロンプト・フォント等）と AI サービスへのアクセス販売は禁止。',
  },
  {
    id: 'payhip', label: 'Payhip', kind: 'デジタル', ai: 'allowed_with_label', needs_label: true,
    autonomy: 'full', human: ['本人確認（初回）'], source: 'https://payhip.com/pricing', verified: true,
    note: 'AI生成物は可。EU VAT / UK は自動処理。',
  },
  {
    id: 'lemonsqueezy', label: 'Lemon Squeezy', kind: 'デジタル', ai: 'allowed_with_label', needs_label: true,
    autonomy: 'full', human: ['本人確認（初回）'], source: 'https://www.lemonsqueezy.com/pricing', verified: true,
    note: '自作の成果物は可。Merchant of Record として各国 VAT / 売上税を納付。',
  },
  {
    id: 'adobe_stock', label: 'Adobe Stock', kind: 'ストック素材', ai: 'allowed_with_label', needs_label: true,
    autonomy: 'partial', human: ['審査の差し戻し対応', '出金口座の設定'],
    source: 'https://helpx.adobe.com/stock/contributor/submit-your-content/submit-generative-ai-content/generative-ai-content-guidelines.html', verified: true,
    note: '"Generative AI" ラベルが必須。実在の人物・場所・物を指す内容は不可。審査で差し戻される前提で少数だけ出す。',
  },
  {
    id: 'etsy', label: 'Etsy（デジタル商品）', kind: 'デジタル', ai: 'allowed_with_label', needs_label: true,
    autonomy: 'none', human: ['本人確認', '出品（人手）'],
    source: 'https://www.etsy.com/seller-handbook/article/1275449912004', verified: true,
    note: 'AI利用は可・出品説明での開示が必須。AIプロンプト束の販売は禁止。出品操作が人手なので自動化しない。',
  },
  {
    id: 'kdp', label: 'Amazon KDP', kind: '電子書籍', ai: 'allowed_with_label', needs_label: true,
    autonomy: 'partial', human: ['税務情報', '出版設定'],
    source: 'https://kdp.amazon.com/help/topic/G200672390', verified: true,
    note: 'AI生成の文章・画像・翻訳は開示必須。AI生成物は1日3タイトル上限（二次情報）。',
  },
  {
    id: 'medium', label: 'Medium', kind: '記事', ai: 'allowed_with_label', needs_label: true,
    autonomy: 'none', human: ['アカウント（初回）', '投稿（人手）'],
    source: 'https://help.medium.com/hc/en-us/articles/22576852947223-Artificial-Intelligence-AI-content-policy', verified: true,
    note: 'AI生成文そのものの paywall 掲載は不可。開示すれば通常配信は可（Boost 不可）。SEO目的のアフィリ記事は不可。',
  },
  {
    id: 'substack', label: 'Substack', kind: 'ニュースレター', ai: 'allowed_with_label', needs_label: true,
    autonomy: 'none', human: ['アカウント（初回）', '投稿（人手）'],
    source: 'https://www.inc.com/amy-zwagerman/youtube-linkedin-and-substack-are-flagging-ai-generated-content-brands-need-a-public-policy/91389773', verified: true,
    note: 'AI検出・開示機能が入り、読者に AI 製であることが見える。開示前提でしか出さない。',
  },
  {
    id: 'x', label: 'X（旧Twitter）', kind: 'SNS', ai: 'allowed_with_label', needs_label: false,
    autonomy: 'partial', human: ['投稿の1タップ'], social: true,
    source: 'https://docs.x.com/x-api/getting-started/pricing', verified: true,
    note: '自動化そのものは禁じていないが、重複・ほぼ同内容の連投は凍結対象。リンク付きは1日3件まで自主規制。本文は intent URL に入れて渡すので、操作はタップ1回。公式APIはサブスク無しの従量課金のみ（2026-10-17時点: 投稿 $0.015 / URL付き投稿 $0.200 / 自分の投稿の読み取り $0.001。いずれも1リクエストまたは1リソース）。無料枠の記載は無く、リンク付きを1日3件出すと月 $18（約2,844円）の固定費になるため、原価0の制約下ではAPI経由の自動投稿を使わない。Cookieを持ち込む自動投稿も不可（cf_clearance は発行元のIPとUAに紐づくのでWorkerからは通らない）。',
  },
  {
    id: 'reddit', label: 'Reddit', kind: 'SNS', ai: 'allowed_with_label', needs_label: true,
    autonomy: 'none', human: ['Redditの本人確認（AgentHansa・最大$14.50）', '投稿・返信（人手）'], social: true,
    source: 'https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki', verified: true,
    note: '自動化しない。理由は3つ。(1) 公式Wikiが hosted service provider の netblock からのアクセスに有効なOAuthトークンを要求し、OAuthなしの通信はブロックする＝Cloudflare Workers からは読めない（実測でも reddit.com/search.json は403）。(2) 新規OAuthトークンは Responsible Builder Policy で承認制、r/redditdev では 2027-01-12 から Developer Platform 未移行のAPIアプリを削除開始と告知。(3) 公式の基準は 90/10（参加9割・宣伝1割）で細部は各サブレディットのモデレーター判断、制裁は削除からサイト全体の永久BANまでエスカレートし、永久BANはほぼ戻らない（凍結は入金経路ごと失う）。いま取れる確定した現金は AgentHansa の本人確認（最大$14.50）だけで、これは人の操作。読み取りはコネクタ（読み取り専用）で拾い、書き込みは人が価値先行で行う。',
  },
  {
    id: 'note', label: 'note', kind: '記事', ai: 'allowed_with_label', needs_label: true,
    autonomy: 'partial', human: ['貼って公開'], social: true,
    source: 'https://note.com/', verified: false,
    note: '日本の記事PF。AI開示を冒頭に入れた下書きをそのまま貼れる形で出す。週2本まで自主規制。',
  },
  {
    id: 'youtube', label: 'YouTube', kind: '動画', ai: 'allowed_with_label', needs_label: true,
    autonomy: 'partial', human: ['動画ファイルの用意', 'アップロード'], social: true,
    source: 'https://www.youtube.com/howyoutubeworks/policies/community-guidelines/', verified: false,
    note: 'AI開示と独自の解説が必須。外部リンク目的だけの動画は規約違反。動画の合成はWorkersでできない（ffmpegが動かない）ので、台本・概要欄・サムネ指示までを自動で作る。',
  },
  {
    id: 'shutterstock', label: 'Shutterstock', kind: 'ストック素材', ai: 'forbidden', needs_label: true,
    autonomy: 'none', human: ['—'], blocked: true, blocked_reason: '規約でAI生成物の投稿が不可（公式FAQで明示）',
    source: 'https://submit.shutterstock.com/help/en/articles/10594676-ai-generated-content-on-shutterstock-contributor-faq', verified: true,
    note: '出品者からの AI 生成物は受け付けない。出した時点で規約違反。',
  },
  {
    id: 'fiverr', label: 'Fiverr', kind: '受託', ai: 'allowed_with_label', needs_label: false,
    autonomy: 'partial', human: ['本人確認', 'ギグ作成（人手）'],
    source: 'https://help.fiverr.com/', verified: false,
    note: 'AI は「自分の技能の補助」限定。未加工の AI 出力は品質基準を満たさない。要確認。',
  },
];

export const CONTENT_DESTINATION_IDS = DESTINATIONS.map((d) => d.id);
export const destinationById = (id) => DESTINATIONS.find((d) => d.id === id) || null;

/** 禁止カテゴリ（出す前に本文を機械で走査して落とす）。 */
export const PROHIBITED = [
  { id: 'prompt_bundle', label: 'プロンプト束・プロンプト集の販売', re: /(プロンプト集|プロンプト束|プロンプト\s*パック|prompt\s*(pack|bundle))/i },
  { id: 'account_resale', label: 'アカウント・APIキーの転売', re: /(アカウント|api\s*キー|アクセス権).{0,8}(販売|売却|転売|配布)/i },
  { id: 'real_person', label: '実在の人物・著名人の再現', re: /(実在|本人|著名人|芸能人|有名人|celebrity).{0,8}(の)?(顔|人物|肖像|写真)/i },
  { id: 'affiliate_seo', label: 'アフィリ目的の SEO 量産記事', re: /(アフィリエイト|アフィリ).{0,10}(目的|誘導|量産)/i },
  { id: 'voice_clone', label: '声・顔のクローン（なりすまし）', re: /(声|音声|顔).{0,6}(クローン|なりすまし|コピー)/i },
];

/** 宛先ごとの本数上限（量産と判定されないための自主規制。プラットフォーム上限ではない）。 */
export const CONTENT_CAPS = {
  x402: { n: 200, window: 'day', note: '自前の販路なので量産の概念なし。ただし在庫の品質を保つため1日200件まで。' },
  youtube: { n: 2, window: 'week', note: '量産・反復と判定されないための上限（publish.js と同じ）。' },
  medium: { n: 3, window: 'week', note: '開示しても Boost 対象外。少数精鋭でしか出さない。' },
  substack: { n: 2, window: 'week', note: 'AI検出があるので本数を絞る。' },
  note: { n: 2, window: 'week', note: '日本語圏のリーチを取るが、量産に見えない本数に留める。' },
  gumroad: { n: 5, window: 'week', note: '自作の成果物として整合する本数。' },
  payhip: { n: 5, window: 'week', note: '同上。' },
  lemonsqueezy: { n: 5, window: 'week', note: '同上。' },
  adobe_stock: { n: 30, window: 'week', note: 'ストックは本数が価値。ただしラベル必須・審査前提。' },
  etsy: { n: 10, window: 'week', note: '人手の出品なので自動化はしない（計画のみ）。' },
  kdp: { n: 1, window: 'day', note: '公式の報告はAI生成物1日3タイトル。こちらは安全側の1本/日。' },
  fiverr: { n: 3, window: 'week', note: '受託なので提案ベース。' },
};

/** 売り物にする AI コンテンツの品目（単価は円・推定ではなく提案価格）。 */
export const CONTENT_KINDS = [
  { id: 'research-brief', label: '調査レポート', unit: '本', price_jpy: 1500, needs_label: false,
    description: '出典URLつきの調査レポート。事実と推定を分けて書き、未確認は未確認と明記する。' },
  { id: 'article', label: '記事（SEO見出しつき）', unit: '本', price_jpy: 2000, needs_label: true,
    description: '検索意図に合わせた見出し構造つきの記事。冒頭2段落以内にAI開示文を入れる。' },
  { id: 'social-set', label: 'SNS投稿セット', unit: 'セット', price_jpy: 800, needs_label: true,
    description: '1テーマにつき5本。文面は互いに重複させない（量産判定を避ける）。' },
  { id: 'image-set', label: '画像セット（AIラベル付き）', unit: 'セット', price_jpy: 1200, needs_label: true,
    description: '実在の人物・場所を含まないオリジナル画像。メタデータに AI 生成のラベルを付ける。' },
  { id: 'translation', label: '翻訳・ローカライズ', unit: '件', price_jpy: 1000, needs_label: true,
    description: '原文の意味を変えずに訳す。原文の出所とライセンスを確認できないものは受け付けない。' },
  { id: 'data-summary', label: 'データ要約（表つき）', unit: '件', price_jpy: 1800, needs_label: false,
    description: '渡された表の要約と品質チェック。数字は実際に計算したものだけを書く。' },
];

const kindById = (id) => CONTENT_KINDS.find((k) => k.id === id) || null;

/** 開示文（宛先ごとの流儀に合わせて自動で入れる）。 */
export const DISCLOSURE = {
  en: 'This content was created with the assistance of an AI program.',
  ja: 'この記事はAI（人工知能）を使って作成しました。',
  image: 'This image was created using an AI image generation program.',
  stock: 'Generative AI',
};

export function disclosureFor(destinationId, kindId) {
  if (destinationId === 'adobe_stock') return DISCLOSURE.stock;
  if (kindId === 'image-set') return DISCLOSURE.image;
  return destinationId === 'note' ? DISCLOSURE.ja : DISCLOSURE.en;
}

/** 宛先として使えるか（規約が禁じている宛先は選ばせない）。 */
export function preflightDestination(destinationId) {
  const d = destinationById(String(destinationId || ''));
  if (!d) return { ok: false, error: 'unknown_destination', reason: '知らない宛先です' };
  if (d.ai === 'forbidden' || d.blocked) {
    return { ok: false, error: 'forbidden_by_policy', destination: d.id, reason: d.blocked_reason || d.note, source: d.source };
  }
  return {
    ok: true, destination: d.id, label: d.label, autonomy: d.autonomy,
    requires_label: !!d.needs_label, human: d.human || [], note: d.note, source: d.source, verified: !!d.verified,
  };
}

function windowCount(rows = [], destinationId, window, at = nowIso()) {
  const day = utcDay(new Date(at));
  const wk = weekKey(at);
  const counted = rows.filter((r) => ['queued', 'approved', 'posted'].includes(r.state));
  const mine = counted.filter((r) => String(r.channel || r.destination || '') === destinationId);
  if (window === 'day') return mine.filter((r) => String(r.day || r.created_at || '').slice(0, 10) === day).length;
  return mine.filter((r) => weekKey(r.created_at || at) === wk).length;
}

/**
 * 出す前の判定。人が見る前に、規約違反と量産判定になりうるものを機械で落とす。
 * 返り値の blocks が1つでもあれば出さない（warnings は出せるが記録する）。
 */
export function assessContent(item = {}, { destination, history = [], rows = [], at = nowIso() } = {}) {
  const blocks = []; const warnings = [];
  const d = destinationById(String(destination || item.destination || ''));
  if (!d) return { ok: false, blocks: ['宛先が未指定です'], warnings, checks: {} };
  if (d.ai === 'forbidden' || d.blocked) {
    blocks.push(`規約違反: ${d.label} は ${d.blocked_reason || 'AI生成物の販売が不可'}（出した時点でBAN対象）`);
    return { ok: false, blocks, warnings, checks: { policy: false }, source: d.source };
  }

  const body = String(item.body || item.text || '');
  const title = String(item.title || '');
  const kind = kindById(item.kind) || null;

  // 1) 禁止カテゴリの走査（本文＋タイトル）
  const hay = `${title}\n${body}`;
  const hits = PROHIBITED.filter((p) => p.re.test(hay));
  if (hits.length) blocks.push(`禁止カテゴリ: ${hits.map((h) => h.label).join(' / ')}`);

  // 2) 開示・ラベル
  const needsLabel = !!d.needs_label || !!(kind && kind.needs_label);
  const hasLabel = /(AI|人工知能|生成AI|Generative AI)/i.test(`${title}\n${body}`)
    && /(作成|生成|支援|assistance|generated|created)/i.test(`${title}\n${body}`);
  const label_required = needsLabel;
  if (needsLabel && !hasLabel) {
    blocks.push(`開示がありません: ${d.label} はAI生成であることの明示が必須（冒頭または説明欄）`);
  }
  if (needsLabel && hasLabel && body.length > 0) {
    const head = body.slice(0, 300);
    if (!/(AI|人工知能|生成AI|Generative AI)/i.test(head)) warnings.push('開示が本文の後半にあります。冒頭（最初の2段落以内）に置くのが安全です');
  }

  // 3) 重複（量産判定・重複コンテンツの回避）
  const dup = history.length ? dupMax(body, history) : { max: 0, against: null };
  if (dup.max >= DUPLICATE_THRESHOLD) {
    blocks.push(`重複: 過去の成果物と ${Math.round(dup.max * 100)}% 一致（量産・重複と判定されるため差し戻し）`);
  } else if (dup.max >= 0.5) {
    warnings.push(`過去の成果物と ${Math.round(dup.max * 100)}% 一致。書き出しを変えた方が安全です`);
  }

  // 4) 本数の上限（自主規制）
  const cap = CONTENT_CAPS[d.id];
  let cap_state = null;
  if (cap) {
    const used = windowCount(rows, d.id, cap.window, at);
    cap_state = { used, limit: cap.n, window: cap.window, left: Math.max(0, cap.n - used), note: cap.note };
    if (used >= cap.n) blocks.push(`本数の上限: ${d.label} は ${cap.window === 'day' ? '1日' : '1週'} ${cap.n} 件まで（${used}件で到達）`);
  }

  // 5) 品質の下限（薄い成果物は出さない＝低品質量産と見なされない）
  if (kind && ['article', 'research-brief'].includes(kind.id)) {
    if (body.trim().length < 200) blocks.push(`品質の下限: 本文が ${body.trim().length} 文字です（記事は200文字以上）`);
    if (!title.trim()) blocks.push('品質の下限: タイトルがありません');
  }

  return {
    ok: blocks.length === 0, blocks, warnings,
    checks: { policy: true, label_required, label_present: hasLabel, duplicate_max: dup.max, cap: cap_state, prohibited_hits: hits.map((h) => h.id) },
    destination: d.id, kind: kind ? kind.id : null, source: d.source, at,
  };
}

function dupMax(text, history) {
  let max = 0; let against = null;
  for (const h of history) {
    const s = similarity(text, h.body || h.text || '');
    if (s > max) { max = s; against = h.id || null; }
  }
  return { max: Math.round(max * 100) / 100, against };
}

/** 宛先ごとの公開手順（どこまで自動で、どこから人が要るか）。 */
export function publishPlanFor(destinationId) {
  const pre = preflightDestination(destinationId);
  if (!pre.ok) return pre;
  const d = destinationById(destinationId);
  return {
    ...pre,
    steps: [
      { step: '生成', auto: true, note: '無料AIレーンで下書きを生成。原価0。' },
      { step: '開示', auto: true, note: pre.requires_label ? 'AI開示文を自動で冒頭に入れる。' : '開示の規定なし（付けてもよい）。' },
      { step: '重複検査と本数上限', auto: true, note: '量産判定を避けるための自動ゲート。' },
      { step: '公開', auto: d.autonomy === 'full', human: d.autonomy !== 'full', note: d.autonomy === 'full' ? '自前の販路なので自動で公開できる。' : `人が要る: ${(d.human || []).join(' / ')}` },
      { step: '入金', auto: d.autonomy === 'full', human: false, note: d.id === 'x402' ? 'USDC の入金は facilitator で検証して台帳へ。' : '出金は初回設定のあと自動で回る。' },
    ],
    cap: CONTENT_CAPS[d.id] || null,
    fee_source: 'channels.js',
  };
}

/** いまの在庫と、宛先ごとの残り枠。数字は publish_queue の実データから数える。 */
export async function contentReport(store, at = nowIso()) {
  let rows = [];
  for (const t of ['publish_queue', 'publishes', 'posts', 'content_items']) {
    if (!store) break;
    try { rows = await store.all(`SELECT * FROM ${t} ORDER BY created_at DESC LIMIT 500`); break; } catch { /* テーブルが無ければ次を試す */ }
  }
  const counted = rows.filter((r) => ['queued', 'approved', 'posted'].includes(r.state));
  const by_destination = DESTINATIONS.map((d) => {
    const cap = CONTENT_CAPS[d.id] || null;
    const used = cap ? windowCount(rows, d.id, cap.window, at) : 0;
    return {
      id: d.id, label: d.label, ai: d.ai, autonomy: d.autonomy,
      blocked: !!d.blocked, blocked_reason: d.blocked_reason || null,
      requires_label: !!d.needs_label, human: d.human || [], note: d.note,
      source: d.source, verified: !!d.verified,
      used, limit: cap ? cap.n : null, window: cap ? cap.window : null,
      left: cap ? Math.max(0, cap.n - used) : null, cap_note: cap ? cap.note : null,
    };
  });
  return {
    ok: true,
    measured: counted.length > 0,
    total: counted.length,
    sellable_destinations: by_destination.filter((x) => !x.blocked && x.ai !== 'forbidden').length,
    auto_publish: by_destination.filter((x) => x.autonomy === 'full' && !x.blocked).map((x) => x.id),
    human_only: [...new Set(by_destination.filter((x) => x.autonomy !== 'full' && !x.blocked).flatMap((x) => x.human))],
    kinds: CONTENT_KINDS,
    by_destination, at,
  };
}

export function contentCards(report = {}) {
  const rows = (report.by_destination || []).filter((d) => d.ai !== 'forbidden');
  const blocked = (report.by_destination || []).filter((d) => d.blocked);
  return [
    {
      head: { label: 'AIコンテンツの売り先', value: `${rows.length} 本`, unit: '規約を確認した宛先のみ', tone: 'accent' },
      lanes: rows.map((d) => ({
        label: d.verified ? d.label : `${d.label}（要確認）`,
        value: d.limit == null ? '—' : `残り ${d.left}`,
        unit: `${d.autonomy === 'full' ? '無人可' : '人手あり'}${d.requires_label ? ' · 開示必須' : ''}${d.limit ? ` · ${d.window === 'day' ? '1日' : '週'}${d.limit}件` : ''}`,
        tone: d.autonomy === 'full' ? 'ok' : d.autonomy === 'none' ? 'mut' : 'warn',
      })),
    },
    ...(blocked.length ? [{
      head: { label: '規約で除外した売り先', value: `${blocked.length} 本`, unit: '出すとBAN対象', tone: 'warn' },
      lanes: blocked.map((d) => ({ label: d.label, value: '不可', unit: d.blocked_reason || '規約違反', tone: 'bad' })),
    }] : []),
  ];
}

export function contentHelp() {
  return [
    'AIで作ったコンテンツを売る宛先を、規約の確認済み／未確認を分けて並べます。**禁じているのは「AIを使うこと」ではなく、量産・無開示・禁止カテゴリ**です。だから出す前に、①規約が禁止していない宛先か ②AI開示が入っているか ③似た成果物を出していないか ④本数上限を超えていないか ⑤プロンプト束・実在人物などの禁止カテゴリでないか、を機械で確認してから出します。',
    '一番安全なのは **x402 直販**です。プラットフォーム規約が無いので BAN の概念がなく、値札・決済・納品が全自動で回ります。次に Gumroad / Payhip / Lemon Squeezy（初回の本人確認だけ人が要る＝以後は無人）。',
    '**Shutterstock は除外**しています（公式FAQで出品者からのAI生成物を受け付けないと明示）。Adobe Stock は可ですが "Generative AI" ラベル必須で、実在の人物・場所は不可です。',
    'Medium は AI生成文そのものの paywall 掲載が不可（開示すれば通常配信は可・Boost は不可）。Etsy は AI可・開示必須ですが **AIプロンプト束の販売は禁止**です。KDP は AI生成物の開示が必須で、量産は1日3タイトル前後が上限とされています。',
  ].join('\n\n');
}
