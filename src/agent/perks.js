// ---------------------------------------------------------------------------
// 有益情報 (perks) — 「契約すると / 買うと / 応募すると、これが貰える」を
// 1件のレコードにして、公式ページで実額と期限を確認し、期限順に出す。
//
// なぜ要るか: こういう情報は「誰かの投稿」で流れてきて、条件と期限が落ちる。
// 落ちた状態で動くと損をする（期限切れ・対象外・自動更新）。ここでは
//   - 一次情報（公式ページ）を出典として必ず持つ
//   - 実額・条件・期限・人の1タップを分けて書く
//   - 期限が近いものから上に出す（今日動くべきものだけ見える）
// を守る。ポイ活の「自動クリック・自動応募」は規約違反になるので実装しない。
// ---------------------------------------------------------------------------

import { nowIso, id, safeJson } from '../util.js';

export const T = 'perks';

/** 有益情報の種類 */
export const PERK_KINDS = [
  { id: 'perk', label: '特典・無料で貰える', probe: 'perk' },
  { id: 'points', label: 'ポイ活・ポイント還元', probe: 'perk' },
  { id: 'discount', label: '割引', probe: 'perk' },
  { id: 'cashback', label: 'キャッシュバック・還元', probe: 'perk' },
  { id: 'reward', label: '現金・報酬（確認するだけで貰える）', probe: 'perk' },
];
export const PERK_KIND_IDS = PERK_KINDS.map((k) => k.id);
export const perkKindById = (k) => PERK_KINDS.find((x) => x.id === k) || null;

/** USD → JPY の換算（表示用。実レートではない） */
export const USD_JPY = 158;

const H = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
export const perkKey = (o = {}) => 'pk_' + H(`${o.kind || ''}|${o.site || ''}|${o.url || ''}|${(o.title || '').slice(0, 60)}`).toString(36);

// ---------------------------------------------------------------------------
// 種 — 一次情報（または出典が明示できる情報）で裏が取れている有益情報。
//   source_quality: primary = 公式ページそのもの / secondary = 二次情報（公式で要再確認）
//   outlay_jpy: 自分が先に払う金額（0 = 無料。買い物が前提のものはその旨を正直に書く）
// ---------------------------------------------------------------------------
export const SEED_PERKS = [
  {
    kind: 'cashback',
    title: 'ローソン: Google Play ギフトカード購入で もれなく最大10%分のギフトコード（1人5,000円分まで）',
    site: 'lawson.co.jp',
    url: 'https://www.lawson.co.jp/lab/campaign/googlemileage2609/',
    benefit: '購入額の最大10%分のGoogle Playギフトコード（6コース全部で5,000円分相当）',
    benefit_jpy: 5000,
    conditions: [
      'ローソンアプリでキャンペーンにエントリー（先にエントリーが必要）',
      '会計時にローソンIDに登録した Pontaカード / dポイントカード を提示',
      'Google Playギフトカード・ギフトコード・コンビニ決済を合計1,000円ごとに1スタンプ',
      'ローソンストア100・Lミニマートでの購入は対象外',
    ],
    steps: [
      'ローソンアプリでエントリーする（これが無いと1円も貰えない）',
      'Ponta/dポイントカードを提示してギフトカードを買う',
      'スタンプが翌々日午後に付くのを待つ',
      'スタンプ数に応じてコースごとに応募（応募しないと受け取れない）',
      '特典取得期間内にギフトコードを受け取る',
    ],
    human: ['アプリのエントリー', '店頭での購入とカード提示', 'コースの応募', '特典の受け取り'],
    outlay_jpy: 1000,
    outlay_note: 'ギフトカードの購入額は自分の買い物。払った額の最大10%が戻る形（元手は要る）',
    expires_at: '2026-11-02T23:59:00+09:00',
    deadline_note: '購入は 2026-10-19 23:59 まで / 応募は 2026-10-26 23:59 まで / 特典取得は 2026-11-02 23:59 まで',
    verified_at: '2026-10-18',
    source_quality: 'primary',
    evidence: '「対象期間中、ローソンアプリでエントリーの上、会員カードを提示して、Google Play ギフトカード…を合計1,000円購入するごとに1スタンプ」「もれなく購入金額の最大10％分のGoogle Playギフトコード」「おひとり様最大5,000円分相当まで」',
  },
  {
    kind: 'perk',
    title: 'ローソン: 50スタンプで3,000円コース応募者から抽選1,000名に Google AI Pro 3か月無料コード',
    site: 'lawson.co.jp',
    url: 'https://www.lawson.co.jp/lab/campaign/googlemileage2609/',
    benefit: 'Google AI Pro 3か月無料コード（抽選1,000名）',
    benefit_jpy: 8700,
    benefit_note: 'Pro は月2,900円なので3か月=8,700円相当（抽選なので期待値ではない）',
    conditions: [
      '50スタンプためて「3,000円分コース」に応募した人が対象',
      '抽選期間中に、アプリ内の抽選参加専用バナーから応募する必要がある',
      'Google AI Pro コードは18歳以上のGoogleアカウントのみ',
    ],
    steps: [
      'まず上の10%還元に応募して50スタンプまでためる',
      '抽選期間になったらアプリのキャンペーンタブに専用バナーが出るので、そこから応募',
      '当選したら引換期間内にコードを登録する',
    ],
    human: ['抽選への応募', 'コードの登録'],
    outlay_jpy: 0,
    outlay_note: '上のギフトカード購入の副産物なので追加の出費は0（抽選）',
    expires_at: '2026-11-23T23:59:00+09:00',
    deadline_note: '抽選期間 2026-11-10 10:00 〜 11-16 23:59 / 引換 11-10 〜 11-23 23:59',
    verified_at: '2026-10-18',
    source_quality: 'primary',
    evidence: '「50スタンプためて3,000円分コース応募者限定で、後日抽選でGoogle AI Pro 3か月無料コードが1,000名様に当たる！」',
  },
  {
    kind: 'perk',
    title: 'Google AI Pro / Ultra には YouTube Premium Lite が付帯する',
    site: 'lawson.co.jp',
    url: 'https://www.lawson.co.jp/lab/campaign/googlemileage2609/',
    benefit: 'YouTube Premium Lite（対象: Google AI Pro / Google AI Ultra）',
    conditions: ['対象プランは Google AI Pro と Google AI Ultra', 'Pro に付くのは「YouTube Premium Lite」（通常の Premium とは別物）'],
    steps: [
      '自分のプランが Pro / Ultra か確認する',
      '付帯特典の有無を Google の公式ページで確認する（この記載はローソン公式ページの案内）',
      'すでに YouTube Premium を単体で払っているなら二重払いになっていないか確認する',
    ],
    human: ['契約の確認・変更'],
    outlay_jpy: 0,
    outlay_note: 'すでに Pro を契約しているなら追加0円。YouTube Premium を別途払っている場合だけ節約になる',
    expires_at: null,
    verified_at: '2026-10-18',
    source_quality: 'primary',
    evidence: '「プランによっては YouTube Premium や Gemini Spark が特典として付いてくる！ ※対象プラン：Google AI Pro、Google AI Ultra」「Google AI Pro の YouTube 有料プラン特典は『YouTube Premium Lite』となります」',
    needs_official_recheck: 'Google 側の公式ページでも同じ付帯が確認できるかは未確認（出典はローソン公式ページ）',
  },
  {
    kind: 'perk',
    title: 'Pixel 11 Pro / 11 Pro XL / 11 Pro Fold の購入特典: Google AI Pro が6か月無料',
    site: 'coplus-one.jp',
    url: 'https://coplus-one.jp/google-ai-pro-campaign/',
    benefit: 'Google AI Pro 6か月無料',
    benefit_jpy: 17400,
    benefit_note: '月2,900円×6か月＝17,400円相当（端末購入が前提）',
    conditions: ['対象端末の購入が必要', '引き換え期限 2027-10-31 23:59（太平洋時間）', '期間終了後は通常料金で自動更新'],
    steps: ['対象端末の購入を決める前に、特典の引き換え期限と対象外条件を公式で確認する'],
    human: ['端末購入', '特典の引き換え'],
    outlay_jpy: 0,
    outlay_note: '端末代は別。特典そのものの追加出費は0',
    expires_at: '2027-10-31T23:59:00-07:00',
    verified_at: '2026-10-18',
    source_quality: 'secondary',
    evidence: '「Pixel 11 Pro、Pixel 11 Pro XL、Pixel 11 Pro Foldの特典では、Google AI Proを6か月無料で使うことが出来ます。引き換え期限は2027年10月31日午後11時59分（太平洋時間）」',
  },
  {
    kind: 'perk',
    title: 'Pixel 10 Pro シリーズ（日本）: Google AI Pro 6か月無料 — 引き換え期限が近い',
    site: 'coplus-one.jp',
    url: 'https://coplus-one.jp/google-ai-pro-campaign/',
    benefit: 'Google AI Pro 6か月無料',
    benefit_jpy: 17400,
    conditions: ['引き換え期限 2026-10-31（残りわずか）', '5TBプラン利用者とファミリープランのメンバーは対象外'],
    steps: ['Pixel 10 Pro を持っているなら、期限前に引き換えたか確認する'],
    human: ['特典の引き換え'],
    outlay_jpy: 0,
    outlay_note: 'すでに端末を持っているなら追加0円',
    expires_at: '2026-10-31T23:59:00+09:00',
    verified_at: '2026-10-18',
    source_quality: 'secondary',
    evidence: '「Pixel 10 Proシリーズも、日本ではGoogle AI Proが6か月無料となります。引き換え期限は2026年10月31日と近く、5TBプランを使っている方とファミリープランのメンバーは対象外」',
  },
  {
    kind: 'perk',
    title: 'Chromebook Plus の購入特典: Google AI Pro が12か月無料',
    site: 'coplus-one.jp',
    url: 'https://coplus-one.jp/google-ai-pro-campaign/',
    benefit: 'Google AI Pro 12か月無料',
    benefit_jpy: 34800,
    conditions: ['18歳以上', '引き換え期限 2027-01-31 23:59（太平洋標準時）', 'いつでも解約可能'],
    steps: ['対象端末を買う予定があるなら、引き換え期限と対象条件を公式で確認する'],
    human: ['端末購入', '特典の引き換え'],
    outlay_jpy: 0,
    expires_at: '2027-01-31T23:59:00-08:00',
    verified_at: '2026-10-18',
    source_quality: 'secondary',
    evidence: '「Chromebook Plusでは、Google AI Proを12か月間無料で使うことが出来ます。引き換えの期限は2027年1月31日午後11時59分（太平洋標準時）で、18歳以上の方だけが対象」',
  },
  {
    kind: 'discount',
    title: 'au / UQ mobile 経由の Google AI Pro は 月2,420円（Google直販 2,900円）',
    site: 'coplus-one.jp',
    url: 'https://coplus-one.jp/google-ai-pro-campaign/',
    benefit: '月480円の差（直販2,900円 → 経由2,420円・税込）',
    benefit_jpy: 5760,
    benefit_note: '月480円×12か月＝5,760円（法人契約は割引・ポイント還元の対象外）',
    conditions: ['KDDI提供価格・2026-10-01時点', '法人契約は割引もポイント還元も対象外', '2026-09-30までに加入した方向けの660円引きは終了し、10月利用分から2,420円'],
    steps: ['すでに au / UQ を使っているなら、直販で契約していないか確認する（経由のほうが安い）'],
    human: ['契約の見直し'],
    outlay_jpy: 0,
    expires_at: null,
    verified_at: '2026-10-18',
    source_quality: 'secondary',
    evidence: '「KDDI提供価格は2026年10月1日時点の情報で月2,420円（税込）となっており、Google提供価格の2,900円/月も並べて書かれています」「法人契約はそもそも割引もポイント還元も対象外」',
  },
  {
    kind: 'perk',
    title: '学生は Google AI Pro が1年間無料（米国の対象大学生・$19.99/月相当）',
    site: 'blog.google',
    url: 'https://blog.google/innovation-and-ai/products/gemini-app/student-offer-google-ai/',
    benefit: 'Google AI Pro 1年間無料（$19.99/月相当 = 約37,900円）',
    benefit_jpy: 37900,
    conditions: ['米国の対象大学生', '16歳以上', '対象国・対象校の条件あり'],
    steps: ['日本の学割はプラン名の記載が割れている（AI Plus 1年無料と案内する媒体あり）ので、Google公式で対象プランを確認する'],
    human: ['学生資格の確認', '特典の引き換え'],
    outlay_jpy: 0,
    expires_at: null,
    verified_at: '2026-10-18',
    source_quality: 'primary',
    evidence: '「For eligible college students in the U.S., we\'re offering one year of Google AI Pro for free (valued at $19.99/mo)」（blog.google・2026-08-19）',
    needs_official_recheck: '日本の学割（ローソン公式ページは「Gemini 学割キャンペーン(1年間無料) 対象プラン：Google AI Plus」と記載）とプラン名が食い違うため、日本の対象プランは未確定',
  },
  {
    kind: 'reward',
    title: 'AgentHansa: Reddit の本人確認で最大 $14.50（+ X 確認で $0.50）',
    site: 'agenthansa.com',
    url: 'https://www.agenthansa.com/',
    benefit: '最大 $14.50（約2,291円）+ $0.50',
    benefit_jpy: 2291,
    conditions: ['自分の Reddit / X アカウントが要る', '本人確認の操作は人が行う'],
    steps: ['サイトで Reddit の本人確認タスクを開く', '自分のアカウントで確認を通す', 'X も併せて確認すると +$0.50'],
    human: ['本人確認の操作そのもの'],
    outlay_jpy: 0,
    expires_at: null,
    verified_at: '2026-10-18',
    source_quality: 'secondary',
    evidence: '到達確認済み（http 200・ページ内に実額「$1」の記載を検出）。実額の上限は要再確認',
    needs_official_recheck: '実額（$14.50）は公式ページの表示で再確認する',
  },
  {
    kind: 'reward',
    title: 'Superteam Earn: 暗号通貨バウンティ（参加費0・常時100件以上）',
    site: 'earn.superteam.fun',
    url: 'https://earn.superteam.fun/',
    benefit: '1件あたり $50〜$1,000 帯（成果物を出して受領）',
    benefit_jpy: 7900,
    conditions: ['参加費0', '締切が短いものが多い', '提出は公開書き込み'],
    steps: ['締切順に募集中のバウンティを拾う', '既存のコードで出せるものを1件だけ出す'],
    human: ['提出（公開書き込み）'],
    outlay_jpy: 0,
    expires_at: null,
    verified_at: '2026-10-18',
    source_quality: 'secondary',
    evidence: '本番probeで到達確認済み（http 200 / alive）。ページに参加無料の記載があり、登録料・参加費は0。実額は案件ごとに異なる',
  },
  // --- 期限切れ（＝監視の見本。同じ店・同じ形で毎回やっている） ---
  {
    kind: 'cashback',
    title: 'ファミリーマート: Google Play ギフトカード5,000円以上で最大8%分（2026-09 実施済み）',
    site: 'prepaidmania.jp',
    url: 'https://prepaidmania.jp/2026/09/google-play-%E3%82%AE%E3%83%95%E3%83%88%E3%82%AB%E3%83%BC%E3%83%89-%E3%83%95%E3%82%A1%E3%83%9F%E3%83%AA%E3%83%BC%E3%83%9E%E3%83%BC%E3%83%88google%E3%83%9E%E3%83%8D%E3%82%BF%E3%83%AA/',
    benefit: '最大8%分（5,000円以上の購入が条件）',
    benefit_jpy: 400,
    conditions: ['2026-09-14 までの期間限定', 'ファミリーマートで5,000円以上購入＋特設サイトから応募'],
    steps: ['同じ形で再開催されるので、次回の開始を監視する'],
    human: [],
    outlay_jpy: 5000,
    expires_at: '2026-09-14T23:59:00+09:00',
    verified_at: '2026-10-18',
    source_quality: 'secondary',
    evidence: '「ファミリーマートにて、キャンペーン期間中に Google Play ギフトカード 5,000 円以上を購入して特設サイトより応募すると、もれなく最大 8 %円分」',
  },
  {
    kind: 'discount',
    title: 'ソフトバンク: ギフトコードストア限定で Google Play ギフトコード 10%OFF（2026-08 実施済み）',
    site: 'softbank.jp',
    url: 'https://www.softbank.jp/mobile/info/personal/news/cm_campaign/20260825a/',
    benefit: '10%OFF',
    benefit_jpy: 0,
    conditions: ['2026-08 の期間限定', 'ソフトバンクギフトコードストア限定'],
    steps: ['定期開催なので、次回の告知を監視する'],
    human: [],
    outlay_jpy: 0,
    expires_at: '2026-08-31T23:59:00+09:00',
    verified_at: '2026-10-18',
    source_quality: 'secondary',
    evidence: '「『ソフトバンクギフトコードストア』限定で、Google Play ギフトコードを10％OFFで購入できるキャンペーンを実施します。キャンペーン期間は、2026年8月…」',
  },
];

// ---------------------------------------------------------------------------
// 判定 — 有益情報かどうか
// ---------------------------------------------------------------------------
const PERK_RULES = [
  { kind: 'cashback', re: /(cashback|キャッシュバック|還元|ポイントバック|もれなく.*%|%分)/i },
  { kind: 'points', re: /(ポイント|ponta|dポイント|楽天ポイント|paypay|スタンプ|マイル)/i },
  { kind: 'discount', re: /(割引|discount|\d+\s?%\s?off|半額|クーポン|coupon|無料コード|優待|セール|値下げ)/i },
  { kind: 'reward', re: /(bounty|賞金|報酬|reward|airdrop|エアドロ|もらえる|貰える|verif|referral|紹介|bonus|ボーナス|支払わ|earn(ed|ing)?\b)/i },
  { kind: 'free', re: /(無料|free\b|トライアル|trial|無料コード|フリーミント)/i },
  { kind: 'perk', re: /(特典|perk|付帯|プレゼント|貰える|もらえる|ギフト|優待)/i },
];
const MONEY_RE = /(\$\s?\d[\d,.]*|\d[\d,]*\s?円|\d+\s?%|最大\s?\d)/i;

export function perkSignals(text = '') {
  const s = String(text || '');
  const out = [];
  for (const r of PERK_RULES) if (r.re.test(s)) out.push(r.kind);
  if (MONEY_RE.test(s)) out.push('money');
  return out;
}

// 質問・愚痴・不満は「有益情報」ではない（金額が書いてあっても行動に移せない）
const BENEFIT_NOISE = /(\?|？|教えて|悩んで|愚痴|不満|減った|気がする|scam|legit|help me|どうすれば|って本当)/i;

export function isBeneficial(text = '') {
  const s = String(text || '');
  if (BENEFIT_NOISE.test(s)) return false;
  const sig = perkSignals(s);
  if (!sig.length) return false;
  const kinds = new Set(sig.filter((k) => k !== 'money' && k !== 'perk'));  // 総称の perk は数えない
  if (!kinds.size) return false;                                   // 金額だけ（資金調達・値段の話）は有益情報にしない
  if (sig.includes('money')) return true;                          // 金額 + 受け取れる形
  return kinds.size >= 2;                                          // 金額が無くても、独立した特典が2つ
}

export function classifyPerk(item = {}) {
  const hay = `${item.title || ''} ${item.excerpt || ''} ${item.conditions || ''} ${item.url || ''}`;
  for (const r of PERK_RULES) if (r.re.test(hay)) return r.kind === 'free' ? 'perk' : r.kind;
  return 'perk';
}

function hostOf(u) { try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; } }

/** 任意の1件（Reddit の投稿・scout の項目・手書きの種）から有益情報を作る。 */
export function perkFrom(item = {}, { now = null } = {}) {
  const kind = item.kind && PERK_KIND_IDS.includes(item.kind) ? item.kind : classifyPerk(item);
  const url = item.url || null;
  const site = item.site || hostOf(url) || null;
  const title = (item.title || '').trim().slice(0, 200);
  return {
    key: perkKey({ kind, site, url, title }),
    kind,
    title: title || (perkKindById(kind) || {}).label || '有益情報',
    site,
    url,
    benefit: item.benefit || '',
    benefit_jpy: Number.isFinite(item.benefit_jpy) ? item.benefit_jpy : null,
    benefit_note: item.benefit_note || '',
    conditions: item.conditions || [],
    steps: item.steps || [],
    human: item.human || [],
    outlay_jpy: Number.isFinite(item.outlay_jpy) ? item.outlay_jpy : 0,
    outlay_note: item.outlay_note || '',
    expires_at: item.expires_at || null,
    deadline_note: item.deadline_note || '',
    verified_at: item.verified_at || null,
    source_quality: item.source_quality || 'secondary',
    evidence: (item.evidence || '').slice(0, 900),
    needs_official_recheck: item.needs_official_recheck || null,
    source: item.source || (item.seed ? 'seed' : null),
    status: 'new',
    tries: 0,
    result: null,
    created_at: now || nowIso(),
  };
}

export function daysLeft(expiresAt, now = null) {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  const n = now ? Date.parse(now) : Date.now();
  return Math.floor((t - n) / 86400000);
}

export function expiryState(perk = {}, now = null) {
  const d = daysLeft(perk.expires_at, now);
  if (d === null) return 'unknown';
  if (d < 0) return 'expired';
  if (d <= 7) return 'soon';
  return 'active';
}

/** 期限が近い × 実額 が大きい順のスコア。今日動くべきものだけ上に来るようにする。 */
export function perkScore(perk = {}, now = null) {
  const st = expiryState(perk, now);
  const money = Number.isFinite(perk.benefit_jpy) ? perk.benefit_jpy : 0;
  // 期限切れは 0（金額が大きくても、もう動けないので沈める）
  const urgency = st === 'soon' ? 3 : st === 'active' ? 1.5 : st === 'unknown' ? 1 : 0;
  return Math.round(money * urgency);
}

export function rankPerks(rows = [], { now = null } = {}) {
  return [...rows].sort((a, b) => perkScore(b, now) - perkScore(a, now));
}

// ---------------------------------------------------------------------------
// 確認 — 公式ページを読み、実額の記載と「終了」の有無を見る（読み取りのみ・原価0）
// ---------------------------------------------------------------------------
const UA = 'wealth-agent-perks/1.0 (+https://wealth-agent.wealthagent-app.workers.dev)';
const ENDED_RE = /(終了しました|受付を終了|キャンペーンは終了|本キャンペーンは終了|開催は終了)/;

async function httpGet(url, fetchImpl, ms = 12000) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  try {
    const res = await fetchImpl(url, { headers: { accept: 'text/html,*/*;q=0.5', 'user-agent': UA }, signal: ctl ? ctl.signal : undefined, redirect: 'follow' });
    return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 80000) };
  } finally { if (timer) clearTimeout(timer); }
}

export async function runPerkProbe(perk = {}, { fetchImpl = fetch, now = null } = {}) {
  const at = now || nowIso();
  if (!perk.url) return { at, probe: 'perk', ok: false, evidence: {}, verdict: 'no_url', next: '出典URLを入れる' };
  let r;
  try { r = await httpGet(perk.url, fetchImpl); }
  catch (e) { return { at, probe: 'perk', ok: false, evidence: { error: e.message }, verdict: 'error', next: '次tickで再試行' }; }
  const money = (r.text.match(MONEY_RE) || [])[0] || null;
  const ended = ENDED_RE.test(r.text);
  const state = expiryState(perk, at);
  const verdict = !r.ok ? 'unreachable' : ended ? 'ended' : money ? 'mentions_amount' : 'alive_no_amount';
  return {
    at, probe: 'perk', ok: r.ok,
    evidence: { url: perk.url, http: r.status, matched: money, ended_word: ended, expiry_state: state, days_left: daysLeft(perk.expires_at, at) },
    verdict,
    next: !r.ok ? 'URLか到達性を確認'
      : ended ? 'ページに終了の記載。次の回の開催を監視する'
        : state === 'expired' ? '期限が過ぎている。次回開催の監視に切り替える'
          : state === 'soon' ? '期限が近い。人の1タップで今すぐ受け取る'
            : '生きている。条件を読んで人の1タップで受け取る',
  };
}

// ---------------------------------------------------------------------------
// 保存 — D1
// ---------------------------------------------------------------------------
export async function ensurePerkTable(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${T} (
    id TEXT PRIMARY KEY, key TEXT NOT NULL, kind TEXT NOT NULL, title TEXT,
    site TEXT, url TEXT, benefit TEXT, benefit_jpy INTEGER, benefit_note TEXT,
    conditions_json TEXT DEFAULT '[]', steps_json TEXT DEFAULT '[]', human_json TEXT DEFAULT '[]',
    outlay_jpy INTEGER DEFAULT 0, outlay_note TEXT, expires_at TEXT, deadline_note TEXT,
    verified_at TEXT, source_quality TEXT, evidence TEXT, needs_recheck TEXT,
    source TEXT, status TEXT DEFAULT 'new', tries INTEGER DEFAULT 0,
    last_try_at TEXT, result_json TEXT, created_at TEXT, updated_at TEXT)`);
  await store.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${T}_key ON ${T}(key)`);
  await store.run(`CREATE INDEX IF NOT EXISTS ${T}_expiry ON ${T}(expires_at)`);
}

function rowToPerk(r = {}) {
  return {
    id: r.id, key: r.key, kind: r.kind, title: r.title, site: r.site, url: r.url,
    benefit: r.benefit || '', benefit_jpy: r.benefit_jpy, benefit_note: r.benefit_note || '',
    conditions: safeJson(r.conditions_json, []), steps: safeJson(r.steps_json, []), human: safeJson(r.human_json, []),
    outlay_jpy: r.outlay_jpy || 0, outlay_note: r.outlay_note || '',
    expires_at: r.expires_at || null, deadline_note: r.deadline_note || '',
    verified_at: r.verified_at || null, source_quality: r.source_quality || 'secondary',
    evidence: r.evidence || '', needs_official_recheck: r.needs_recheck || null,
    source: r.source || null, status: r.status || 'new', tries: r.tries || 0,
    last_try_at: r.last_try_at || null, result: r.result_json ? safeJson(r.result_json, null) : null,
    created_at: r.created_at, updated_at: r.updated_at || null,
  };
}

export async function savePerk(store, perk, { now = null } = {}) {
  const at = now || nowIso();
  const ex = await store.first(`SELECT id FROM ${T} WHERE key = ?`, perk.key);
  if (ex) return { inserted: false, id: ex.id };
  const pid = id('pk');
  await store.run(
    `INSERT INTO ${T} (id,key,kind,title,site,url,benefit,benefit_jpy,benefit_note,conditions_json,steps_json,human_json,outlay_jpy,outlay_note,expires_at,deadline_note,verified_at,source_quality,evidence,needs_recheck,source,status,tries,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    pid, perk.key, perk.kind, perk.title, perk.site, perk.url, perk.benefit, perk.benefit_jpy, perk.benefit_note,
    JSON.stringify(perk.conditions || []), JSON.stringify(perk.steps || []), JSON.stringify(perk.human || []),
    perk.outlay_jpy || 0, perk.outlay_note, perk.expires_at, perk.deadline_note, perk.verified_at, perk.source_quality,
    perk.evidence, perk.needs_official_recheck, perk.source, perk.status || 'new', 0, perk.created_at || at, at,
  );
  return { inserted: true, id: pid };
}

export async function seedPerks(store, { now = null } = {}) {
  let inserted = 0;
  for (const s of SEED_PERKS) {
    const r = await savePerk(store, perkFrom({ ...s, seed: true }), { now });
    if (r.inserted) inserted++;
  }
  return { inserted, total: SEED_PERKS.length };
}

/** Reddit などから拾った有益情報を取り込む（重複は増やさない）。 */
export async function ingestPerks(store, items = [], { now = null, max = 60 } = {}) {
  const at = now || nowIso();
  let scanned = 0; let inserted = 0; const kept = [];
  for (const it of items.slice(0, max)) {
    scanned++;
    if (!isBeneficial(`${it.title || ''} ${it.excerpt || ''}`)) continue;
    const perk = perkFrom({ ...it, source: it.source || 'reddit' }, { now: at });
    const r = await savePerk(store, perk, { now: at });
    if (r.inserted) { inserted++; kept.push({ kind: perk.kind, title: perk.title, url: perk.url, site: perk.site }); }
  }
  return { at, scanned, inserted, kept };
}

export async function listPerks(store, { limit = 40, kind = null, state = null, now = null } = {}) {
  const where = []; const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (state === 'expired') where.push("expires_at IS NOT NULL AND expires_at < ?"), args.push(now || nowIso());
  if (state === 'live') where.push("(expires_at IS NULL OR expires_at >= ?)"), args.push(now || nowIso());
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(limit);
  const rows = await store.all(`SELECT * FROM ${T} ${w} ORDER BY COALESCE(benefit_jpy,0) DESC, created_at DESC LIMIT ?`, ...args);
  return rankPerks((rows || []).map(rowToPerk), { now });
}

export async function tryPerks(store, { limit = 3, fetchImpl = fetch, now = null } = {}) {
  const at = now || nowIso();
  const rows = await store.all(
    `SELECT * FROM ${T} WHERE tries = 0 OR last_try_at IS NULL OR last_try_at < ? ORDER BY COALESCE(benefit_jpy,0) DESC LIMIT ?`,
    new Date(Date.parse(at) - 6 * 3600000).toISOString(), limit);
  const out = [];
  for (const r of rows || []) {
    const perk = rowToPerk(r);
    let res;
    try { res = await runPerkProbe(perk, { fetchImpl, now: at }); }
    catch (e) { res = { at, probe: 'perk', ok: false, evidence: { error: e.message }, verdict: 'error', next: '次tickで再試行' }; }
    const nextStatus = res.verdict === 'mentions_amount' ? 'trying'
      : res.verdict === 'ended' ? 'ended'
        : res.verdict === 'unreachable' ? 'unreachable' : perk.status;
    await store.run(`UPDATE ${T} SET status = ?, tries = COALESCE(tries,0) + 1, last_try_at = ?, result_json = ?, updated_at = ? WHERE id = ?`,
      nextStatus, at, JSON.stringify(res), at, perk.id);
    out.push({ id: perk.id, kind: perk.kind, title: perk.title, verdict: res.verdict, next_status: nextStatus, evidence: res.evidence, next: res.next });
  }
  return { at, tried: out.length, rows: out };
}

export async function perkSummary(store, { now = null } = {}) {
  const byKind = await store.all(`SELECT kind, COUNT(*) AS n FROM ${T} GROUP BY kind`);
  const total = await store.first(`SELECT COUNT(*) AS n FROM ${T}`);
  const soon = await store.first(`SELECT COUNT(*) AS n FROM ${T} WHERE expires_at IS NOT NULL AND expires_at >= ? AND expires_at < ?`,
    now || nowIso(), new Date(Date.parse(now || nowIso()) + 7 * 86400000).toISOString());
  const primary = await store.first(`SELECT COUNT(*) AS n FROM ${T} WHERE source_quality = 'primary'`);
  const cells = {};
  for (const r of byKind || []) cells[r.kind] = r.n;
  return {
    total: total ? total.n : 0,
    primary: primary ? primary.n : 0,
    due_within_7d: soon ? soon.n : 0,
    by_kind: cells,
    note: '実額・条件・期限は出典（公式ページ優先）付き。受け取る操作は人が行う（自動応募・自動クリックは規約違反になるため実装しない）。',
  };
}

/** 人が読む形。今日動くべきもの（期限7日以内）を先頭に出す。 */
export function perkText(rows = [], { now = null } = {}) {
  const L = [];
  const ranked = rankPerks(rows, { now });
  const soon = ranked.filter((p) => expiryState(p, now) === 'soon');
  L.push('有益情報（契約・購入・応募で貰えるもの。実額と期限つき）');
  if (!ranked.length) { L.push('  まだ無い。POST /api/perks/seed で種を入れる。'); return L.join('\n'); }
  if (soon.length) {
    L.push('');
    L.push(`■ 期限が近い（7日以内）: ${soon.length}件`);
    for (const p of soon) L.push(`  - [残${daysLeft(p.expires_at, now)}日] ${p.title}  → ${p.url || ''}`);
  }
  L.push('');
  L.push(`■ 一覧（${ranked.length}件）`);
  for (const p of ranked) {
    const st = expiryState(p, now);
    const mark = st === 'soon' ? '期限近' : st === 'expired' ? '期限切れ' : st === 'active' ? '有効' : '期限不明';
    L.push('');
    L.push(`[${mark}] ${p.kind} | ${p.title}`);
    if (p.site) L.push(`  出典: ${p.site} (${p.source_quality === 'primary' ? '一次情報' : '二次情報'}) ${p.url || ''}`);
    if (p.benefit) L.push(`  貰えるもの: ${p.benefit}${Number.isFinite(p.benefit_jpy) ? `  ≈${p.benefit_jpy.toLocaleString()}円` : ''}`);
    if (p.benefit_note) L.push(`  補足: ${p.benefit_note}`);
    if (p.deadline_note) L.push(`  期限: ${p.deadline_note}`);
    else if (p.expires_at) L.push(`  期限: ${p.expires_at.slice(0, 10)}${st === 'expired' ? '（過ぎている）' : ''}`);
    if (p.outlay_jpy > 0) L.push(`  先に払う: ${p.outlay_jpy.toLocaleString()}円 ${p.outlay_note || ''}`);
    if ((p.conditions || []).length) L.push(`  条件: ${p.conditions.join(' / ')}`);
    if ((p.human || []).length) L.push(`  人の操作: ${p.human.join(' / ')}`);
    if (p.evidence) L.push(`  裏取り: ${p.evidence.slice(0, 240)}`);
    if (p.needs_official_recheck) L.push(`  要再確認: ${p.needs_official_recheck}`);
    if (p.result) L.push(`  確認結果: ${p.result.verdict} ${JSON.stringify(p.result.evidence).slice(0, 200)}`);
  }
  return L.join('\n');
}

export function perkHelp() {
  return [
    '有益情報 — 「契約すると / 買うと / 応募すると、これが貰える」を期限つきで貯める台帳。',
    '',
    'GET  /api/perks                  : 一覧（?format=text / ?kind= / ?state=live|expired / ?limit=）',
    'GET  /api/perks/help             : この説明',
    'POST /api/perks/seed             : 一次情報で裏が取れている有益情報を入れる',
    'POST /api/perks/try              : 出典ページを実際に読み、実額の記載と終了を確認する（読み取りのみ・?limit=N）',
    'POST /api/perks/ingest           : 外で拾った有益情報を取り込む（Reddit など。本文は title/url/excerpt）',
    '',
    '種類: ' + PERK_KINDS.map((k) => `${k.id}(${k.label})`).join(' / '),
    '期限の見方: 7日以内=期限近 / 過ぎた=期限切れ（次回開催の監視に切り替える）',
    '取り込みの選別: 金額の記載があるか、強いシグナルが2つ以上あるものだけ残す（質問・愚痴・誇大な儲け話は落とす）',
    '',
    '守っていること: 出典（公式ページ優先）を必ず持つ。実額は出典の文言をそのまま残す。',
    '自動クリック・自動応募・自動購入は規約違反になるので実装しない（受け取りは人の1タップ）。',
  ].join('\n');
}

export function perkLoopNote() {
  return '有益情報: 特典・ポイ活・割引を出典つきで貯め、期限順に出し、出典ページを読んで実額と終了を確認する（原価0）。';
}
