// SNS投稿の「人の手出し最小化」レイヤ — X / note / YouTube の3媒体。
//
// 何を最小化するのか: 人が持つ工程を「最後の1タップ」だけにする。
//   ① 書く中身は scout（無料・鍵不要の巡回）が拾った実データから自動で下書きする（原価0）
//   ② X は intent URL に本文を入れて渡す → リンクを開いた時点で本文が入っている＝タップ1回
//   ③ note / YouTube は「貼るだけの塊」（タイトル・本文・概要欄・台本）をそのまま出す
//   ④ 本数の上限と重複検査は publish.js が既に持っているので、ここでは再実装しない
//
// やらないこと（意図的に残す）: 自動投稿・自動アップロード。
//   envelope の public_post=approval により投稿は人の承認で、アカウント連携（OAuth）と
//   本人確認は human_only。凍結は入金経路ごと失うので、ここは自動化しない。
//
// 動画そのものについての正直な事実（コードに埋め込んで隠さない）:
//   Workers 上では ffmpeg が動かない。無料の動画合成APIも無い。したがって
//   「動画ファイルが勝手に出来ている」状態にはできない。台本・概要欄・サムネ指示・
//   章立てまでは自動で作れるので、動画の生成は (a) 実行環境（runner）で ffmpeg、
//   (b) 有料の動画生成 のどちらかになる。ここでは (a) の材料を全部そろえて出す。

import { id as newId, nowIso, j, safeJson, truncate } from '../util.js';
import {
  CAPS, createDraft, queueDraft, listDrafts, approveDraft, publishState, capsUsage, weekKey,
} from './publish.js';
import { listFindings } from './scout.js';

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, Math.max(0, n - 1))}…`;
};

// X の280文字は「重み付き」で数える（日本語などの全角は1文字=2）。素の文字数で
// 切ると、日本語の投稿では上限を超えて**URLが消える**。重みで測ってから切る。
export const X_LIMIT = 280;
export const X_URL_WEIGHT = 23; // X はURLを23文字として数える
const WIDE_RE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

export function weightedLen(s) {
  let n = 0;
  for (const ch of String(s)) n += WIDE_RE.test(ch) ? 2 : 1;
  return n;
}

export function clipWeighted(s, budget) {
  let out = ''; let n = 0;
  for (const ch of String(s)) {
    const w = WIDE_RE.test(ch) ? 2 : 1;
    if (n + w > budget) break;
    out += ch; n += w;
  }
  return out.trimEnd();
}

/** X に収まる形にする。末尾のURLは絶対に落とさない（落とすと意味が変わる）。 */
export function fitToX(text) {
  const body = String(text || '').trim();
  const m = body.match(/https?:\/\/\S+$/);
  const url = m ? m[0] : '';
  const head = url ? body.slice(0, body.length - url.length).trimEnd() : body;
  const budget = X_LIMIT - (url ? X_URL_WEIGHT + 1 : 0);
  const trimmed = clipWeighted(head, budget);
  const out = url ? `${trimmed}\n${url}` : trimmed;
  return { text: out, weighted: weightedLen(out), truncated: trimmed !== head };
}

// ---------------------------------------------------------------------------
// 媒体レジストリ。mode が「人の操作が何になるか」を決める。
//   prefilled … リンクを開くと本文が入っている（タップ1回）
//   paste     … 貼るだけの塊を出す
//   upload    … ファイルを選んで、用意済みのメタ情報を貼る
// ---------------------------------------------------------------------------
export const CHANNELS = [
  {
    id: 'x', label: 'X（旧Twitter）', mode: 'prefilled',
    intent: (text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`,
    intent_fallback: (text) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`,
    home: 'https://x.com/home',
    cap: { n: CAPS.x.linked_per_day, window: 'day', note: CAPS.x.note },
    needs_disclosure: false, needs_video: false,
    human: 'リンクを開いて「ポスト」を押すだけ（本文は既に入っています）',
    notes: [
      'リンク付きは1日3件まで（重複・大量投稿は凍結対象）。',
      'URLはX側で23文字に圧縮されるので、本文の残りは約250文字と考えてください。',
      '長く書く場合はそのまま連投（スレッド）にしてください。本数上限はスレッド単位で数えません。',
    ],
  },
  {
    id: 'note', label: 'note', mode: 'paste',
    compose: () => 'https://note.com/notes/new',
    home: 'https://note.com/',
    cap: { n: 2, window: 'week', note: '日本語圏のリーチを取るが、量産に見えない本数に留める。' },
    needs_disclosure: true, needs_video: false,
    human: 'リンクを開いて、タイトルと本文を貼り「公開」を押すだけ',
    notes: [
      'AI開示文を本文の冒頭に入れています（そのまま貼れば規約を満たします）。',
      '見出しは「##」で入れているので、noteの見出しボタンにそのまま対応します。',
    ],
  },
  {
    id: 'coconala', label: 'ココナラ', mode: 'paste',
    compose: () => 'https://coconala.com/services/add',
    home: 'https://coconala.com/mypage',
    cap: { n: 2, window: 'week', note: '出品そのものが在庫になる。週2本まで（同じ品目を二度出さない）。' },
    needs_disclosure: false, needs_video: false,
    human: 'リンクを開いて、タイトルと説明を貼り「公開」を押すだけ',
    notes: [
      '出品は無料。売れたときに手数料が引かれます（率はココナラの公式ページで確認してください。こちらでは断定しません）。',
      '出品者情報・本人確認・振込口座は人が必要です（そこは自動化しません）。',
      'ここは「自分の作業」を売る場所なので、拾った記事ではなく手持ちの品目から下書きを作ります。',
      '説明文のAI利用についての開示要否はココナラの規約で確認してください（こちらでは断定しません）。',
    ],
  },
  {
    // 2026-10-16 本人の指示で、この媒体は自動の対象から外した（動画ファイルが要る＝無料で完結しない）。
    // retired: true の媒体は「下書きの自動生成」「一括承認」「画面のカード」から外れる。
    // レジストリには残すので、過去に作った下書きの表示や /studio.html は壊れない。
    id: 'youtube', label: 'YouTube', mode: 'upload', retired: true,
    upload: () => 'https://studio.youtube.com/channel/UC/videos/upload',
    compose: () => 'https://studio.youtube.com',
    home: 'https://studio.youtube.com',
    cap: { n: CAPS.youtube.uploads_per_week, window: 'week', note: CAPS.youtube.note },
    needs_disclosure: true, needs_video: true,
    human: '動画ファイルを選び、用意済みのタイトル・概要欄を貼って公開',
    notes: [
      '動画の合成はWorkersでできない（ffmpegが動かない）。実行環境か有料の動画生成が要ります。',
      'AI開示と独自の解説が必須です（外部リンク目的だけの動画は規約違反）。',
      'サムネイル指示も一緒に出しています（画像生成は無料枠で足ります）。',
    ],
  },
];

// ---------------------------------------------------------------------------
// 媒体ごとの「画面の見出し／ボタン／完了ボタン」と、貼るだけ媒体の手順。
// 画面側で媒体名を決め打ちしないための唯一の出所（新しい媒体を足しても画面を直さない）。
// ---------------------------------------------------------------------------
export const CHANNEL_UI = {
  x: { action: 'Xにポスト', cta: '開いて、ポストする', done: '投稿済みにする' },
  note: { action: 'noteに公開', cta: '開いて、公開する', done: '公開した' },
  coconala: {
    action: 'ココナラに出品', cta: '開いて、出品する', done: '出品した',
    steps: [
      '① 下のリンクを開く（出品ページが直接開きます）',
      '② タイトルを貼り、「説明文の塊」を本文に貼る',
      '③ 価格は「案」のままか、あなたの値段に直す',
      '④ 初回だけ出品者情報・本人確認・振込口座を設定し、「公開」を押す',
    ],
  },
  youtube: { action: 'YouTubeにアップロード', cta: '開いて、アップロードする', done: 'アップロードした' },
};
export const FALLBACK_UI = { action: '投稿する', cta: '開いて、進める', done: '完了にする' };
export const uiFor = (id) => CHANNEL_UI[String(id)] || FALLBACK_UI;

// 自動生成・一括承認・画面に出すのは、閉じていない媒体だけ。
export const CHANNEL_IDS = CHANNELS.filter((c) => !c.retired).map((c) => c.id);
export const RETIRED_IDS = CHANNELS.filter((c) => c.retired).map((c) => c.id);
export const isRetired = (id) => RETIRED_IDS.includes(String(id || ''));
export const channelById = (id) => CHANNELS.find((c) => c.id === String(id)) || null;

// ---------------------------------------------------------------------------
// 「貼るだけ／押すだけ」の塊を作る。人が開くURLと、貼るテキストを返す。
// ---------------------------------------------------------------------------
export function composeFor(channelId, draft = {}) {
  const c = channelById(channelId || draft.channel);
  if (!c) return { ok: false, error: 'unknown_channel', reason: '知らない媒体です' };
  const ui = uiFor(c.id);
  const body = String(draft.body || '');
  const title = String(draft.title || '');
  if (c.mode === 'prefilled') {
    const fit = fitToX(body);
    return {
      ok: true, channel: c.id, mode: c.mode, url: c.intent(fit.text), fallback_url: c.intent_fallback(fit.text),
      open_first: 'url', copy_text: fit.text, title: null,
      channel_label: c.label, action: ui.action, cta: ui.cta, done_label: ui.done,
      weighted: fit.weighted, limit: X_LIMIT, truncated: fit.truncated,
      steps: [
        '① 下のリンクを開く（本文が入力済みで開きます）',
        '② 内容を確認して「ポスト」を押す',
        '③ 投稿できたら「投稿済みにする」を押す',
      ],
      human: c.human, notes: c.notes,
    };
  }
  if (c.mode === 'paste') {
    return {
      ok: true, channel: c.id, mode: c.mode, url: c.compose(), open_first: 'url',
      copy_text: `${title}\n\n${body}`, title,
      channel_label: c.label, action: ui.action, cta: ui.cta, done_label: ui.done, copy_label: 'タイトルと本文をコピー',
      steps: ui.steps || [
        '① 下のリンクを開いて「新規作成」を選ぶ',
        '② タイトルと本文の塊をそのまま貼る',
        '③ 「公開」を押す',
      ],
      human: c.human, notes: c.notes,
    };
  }
  return {
    ok: true, channel: c.id, mode: c.mode, url: c.upload(), open_first: 'video', video_required: true,
    channel_label: c.label, action: ui.action, cta: ui.cta, done_label: ui.done,
    copy_text: body, title,
    steps: [
      '① 動画ファイルを用意する（この環境では合成できないので、実行環境か外部の生成が必要です）',
      '② 下のリンクを開いてファイルを選ぶ',
      '③ タイトルと概要欄を貼る',
      '④ サムネイルを設定して「公開」を押す',
    ],
    human: c.human, notes: c.notes,
  };
}

// ---------------------------------------------------------------------------
// scout の実データから下書きを作る（原価0・決定的）。事実は拾った記録だけを使い、
// 無い数字は書かない（捏造しない）。
// ---------------------------------------------------------------------------
export function templateX(finding = {}) {
  const title = clip(finding.title, 80);
  const why = clip(finding.excerpt, 70);
  const url = finding.url || '';
  const signals = (safeJson(finding.signals_json, []) || []).slice(0, 3).join('/') || 'なし';
  const fits = (safeJson(finding.fits_json, []) || []).slice(0, 3).join('/') || 'なし';
  // 候補ごとに違う要素（合図・売り方・点数）を必ず入れる。同じ定型文だけだと
  // 重複ゲートに正しく弾かれる（＝量産と判定される投稿になる）。
  const head = [
    title, '',
    why, '',
    `合図: ${signals}${finding.score != null ? ` / 採点 ${finding.score}` : ''}`,
    `売り方: ${fits}`,
    '(AIが拾った候補をAIが要約しています)',
  ].join('\n');
  const fit = fitToX(url ? `${head}\n\n${url}` : head);
  return { title: clip(title, 60), body: fit.text, kind: 'post', linked: url ? 1 : 0, ai_disclosure: 1, unique_commentary: 1 };
}

export function templateNote(finding = {}) {
  const fits = safeJson(finding.fits_json, []) || [];
  const signals = safeJson(finding.signals_json, []) || [];
  const trial = safeJson(finding.trial_json, {}) || {};
  const steps = (trial.steps || []).map((s, i) => `${i + 1}. ${s.action}${s.human && s.human.length ? `（人が要る: ${s.human.join(' / ')}）` : '（自動）'}`);
  const title = `${clip(finding.title, 56)}｜どう試すか`;
  const body = [
    'この記事はAI（人工知能）を使って作成しました。',
    '',
    '## 何が話題になっているか',
    String(finding.title || ''),
    '',
    `出典: ${finding.url || ''}`,
    '',
    '## なぜ拾ったか',
    `自動採点は ${finding.score || 0} 点です。人が金を払う気配のある言葉（賞金・有料・収益など）を重く数えています。`,
    signals.length ? `反応した合図: ${signals.join(', ')}` : '反応した合図: （記録なし）',
    fits.length ? `相性のよい売り方: ${fits.join(' / ')}` : '',
    '',
    '## 小さく試す手順',
    steps.length ? steps.join('\n') : '1. まず無料の範囲で小さく試す',
    '',
    '## この記事の立場',
    '上の内容は自動で拾った記録そのままで、確認できていない数字は書いていません。試した結果は次の判定に使い、うまくいかなければそのまま捨てます。',
  ].filter((l) => l !== '').join('\n');
  return { title, body, kind: 'article', linked: 0, ai_disclosure: 1, unique_commentary: 1 };
}

export function templateYoutube(finding = {}) {
  const title = `${clip(finding.title, 60)}｜何が起きて、どう試すか`;
  const body = [
    '【台本】',
    '0:00 導入 — 今日拾った候補を1つ紹介します。',
    `0:20 何が起きたか — ${String(finding.title || '')}（出典: ${finding.url || 'なし'}）`,
    `0:50 なぜ拾ったか — 自動採点 ${finding.score || 0} 点。金を払う気配のある言葉を重く数えています。`,
    '1:20 どう試すか — 無料でできる手順を1つずつ実行します。',
    '2:20 結果 — 実際に試した結果と、次にやることを話します。',
    '',
    '【概要欄】',
    'この動画はAI（人工知能）を使って作成しています。',
    '',
    '■ 出典',
    String(finding.url || 'なし'),
    '',
    '■ 独自の解説',
    '拾った候補そのものの紹介ではなく、無料で小さく試す手順と、試した結果の解釈を話しています。',
    '確認できていない数字は使いません。',
    '',
    '【サムネイル指示】',
    `白背景に黒の太字で「${clip(finding.title, 24)}」、右下に小さく「試して検証」。`,
    '実在の人物・企業ロゴは入れないこと（規約違反と誤認を避ける）。',
  ].join('\n');
  return { title, body, kind: 'script', linked: finding.url ? 1 : 0, ai_disclosure: 1, unique_commentary: 1 };
}

// ---------------------------------------------------------------------------
// ココナラ（自分の作業を売る場所）— 拾った記事ではなく、手持ちの品目を出品にする。
// 価格は必ず「案」として出し、決めるのは人（勝手に値付けしない）。手数料率も断定しない。
// ---------------------------------------------------------------------------
export const COCONALA_OFFERS = [
  {
    key: 'data-clean', title: 'CSV・Excelの整理（重複除去・名寄せ）します', jpy_hint: 980, hours: 24,
    can: 'バラバラのCSVやExcelを、重複の除去・表記ゆれの名寄せ・列名の統一まで整えて、そのまま使える形にします。',
    deliver: '整形済みのCSV（またはExcel）と、どこをどう直したかの一覧。',
    ask: '元データをそのまま送ってください。個人情報が入っている場合は、消してから送ってください。',
    cannot: 'データの意味の判断（何が正しいか）はできません。元データの復元もできません。',
  },
  {
    key: 'code-review', title: 'コードレビューします（バグ・安全性の指摘レポート）', jpy_hint: 980, hours: 48,
    can: '送っていただいたコードを読み、バグ・例外の抜け・セキュリティ上の危なさ・直しやすい書き方を指摘します。',
    deliver: '指摘一覧（重大度つき）と、直した例。実行して確認できた範囲はそう書きます。',
    ask: 'リポジトリのURL、またはファイル一式と、何を心配しているかを添えてください。',
    cannot: '動かして検証できない環境の挙動は断定できません。動作の保証はできません。',
  },
  {
    key: 'brief', title: '調査レポート（出典つき・A4で1〜2枚）を作ります', jpy_hint: 980, hours: 24,
    can: '決めたテーマについて、公開情報だけを使い、出典URLつきで要点を1〜2枚にまとめます。',
    deliver: 'PDF（またはMarkdown）の1〜2枚。数字には必ず出典を付けます。',
    ask: '知りたいことを1〜3行で書いてください（「誰が」「何を決めるために」が分かると強くなります）。',
    cannot: '有料データベースの中身や、公開されていない数字は書けません。推測は「推測」と明記します。',
  },
  {
    key: 'csv-json', title: 'CSV・JSONの変換処理を作ります（テストつき）', jpy_hint: 980, hours: 24,
    can: 'CSV→JSON、JSON→CSV、項目名の付け替え、1ファイルにまとめる等の小さな変換処理を書きます。',
    deliver: '実行できるスクリプトと、動くことを示す小さなテスト。',
    ask: '入力のサンプル（数行でOK）と、欲しい出力のサンプルを送ってください。',
    cannot: '巨大データの本番運用や、外部サービスの有料API前提の処理は対象外です。',
  },
  {
    key: 'regex', title: '正規表現を書きます・直します（テスト付き）', jpy_hint: 980, hours: 12,
    can: 'ログやテキストから欲しい部分を取り出す正規表現を書き、通る例と通らない例のテストを付けます。',
    deliver: '正規表現と、テスト（実データに近い例で確認した結果）。',
    ask: '対象の文字列の例と、取り出したい部分を送ってください。',
    cannot: '対象の言語やツールによっては書き方が変わるため、環境を教えていただく必要があります。',
  },
  {
    key: 'diff', title: '2つのデータ・テキストの差分レポートを作ります', jpy_hint: 980, hours: 12,
    can: '2つの版の違いを、追加・削除・変更に分けて一覧にします。見落としやすい空白や並び順の違いも拾います。',
    deliver: '差分の一覧（変更点の要約つき）。',
    ask: '比べたい2つを送ってください（個人情報は消してから）。',
    cannot: 'どちらが正しいかの判断はできません。差分を示すだけです。',
  },
  {
    key: 'url-meta', title: 'URLからタイトル・概要を抜き出す処理を作ります', jpy_hint: 980, hours: 12,
    can: '指定したURLの一覧から、タイトル・説明文・公開日などを取り出す小さなスクリプトを作ります。',
    deliver: 'スクリプトと、実際に取得した結果のサンプル。',
    ask: '対象のURLを10件ほどと、欲しい項目を教えてください。',
    cannot: 'ログインが要るページ、botを拒否しているサイトからの取得はできません（規約とrobotsに従います）。',
  },
];

export const offerKey = (o = {}) => String(o.title || '').slice(0, 40);

// 2026-10-16 に本人が決めた価格（ココナラ全7品目）。ここを変えれば下書きの価格も揃う。
export const DECIDED_JPY = 980;

export function templateCoconala(offer = {}) {
  const o = offer && offer.title ? offer : COCONALA_OFFERS[0];
  // 2026-10-16 に本人が 980円 と決定（全7品目）。変えたいときは出品画面で書き換えるだけ。
  const price = o.jpy_hint ? `${o.jpy_hint.toLocaleString('ja-JP')}円（税込・変えたいときは出品画面で変更できます）` : 'あなたが決めてください';
  const title = clip(o.title, 40);
  const body = [
    '【できること】',
    o.can,
    '',
    '【納品物】',
    o.deliver,
    '',
    '【納期の目安】',
    `${o.hours}時間以内（急ぎはご相談ください）`,
    '',
    '【価格】',
    price,
    `ココナラの手数料は売上から引かれます（率は公式ページで確認してください）。`,
    '',
    '【お願い】',
    o.ask,
    '',
    '【できないこと】',
    o.cannot,
    '',
    '（この説明文はAIが下書きし、内容は本人が確認しています。作業は本人が行います。）',
  ].join('\n');
  // 出品本文に外部URLは入れない（外部誘導は規約に触れうるため、ここでは入れない）。
  return { title, body, kind: 'description', linked: 0, ai_disclosure: 0, unique_commentary: 1 };
}

export function templateFor(channelId, finding = {}) {
  if (channelId === 'x') return templateX(finding);
  if (channelId === 'note') return templateNote(finding);
  if (channelId === 'youtube') return templateYoutube(finding);
  if (channelId === 'coconala') return templateCoconala(finding); // finding は品目として渡す（refill からは別枠で呼ぶ）
  return null;
}

// ---------------------------------------------------------------------------
// キューを自動で満たす — scout の上位候補を、媒体をローテーションして下書き化する。
// 上限に当たる下書きは作らない（人が見る前に publish.js が止めるので、そもそも作らない）。
// ---------------------------------------------------------------------------
export async function refillQueue({ store, limit = 2, minScore = 30, channels = null, now = null } = {}) {
  const at = now || nowIso();
  // 価格は本人が決めた（980円）。下書きをそろえるたびに、古い「案: …円」を直しておく（冪等）。
  const priceFix = await applyDecidedPrice(store, { jpy: DECIDED_JPY }).catch(() => ({ updated: 0 }));
  // channels に null / [] / 知らないIDが来ても、既定の全媒体に戻す。null を素通しすると
  // channels.length で落ち、画面には「0件」とだけ出て原因が見えなくなる（実際にこれで詰まった）。
  // 閉じた媒体は、明示的に指定されても作らない（やめた理由が消えていない限り復活させない）。
  const requested = (Array.isArray(channels) && channels.length ? channels : CHANNEL_IDS)
    .map((c) => channelById(c)?.id).filter((id) => id && !isRetired(id));
  const chans = requested.length ? requested : CHANNEL_IDS;
  // ココナラは「拾った記事」ではなく自分の品目を売る場所なので、候補のローテーションには
  // 混ぜず、別枠（この下）で出品を作る。
  const spins = chans.filter((c) => c !== 'coconala');
  const report = { at, created: [], blocked: [], deferred: 0, skipped: 0, considered: 0, channels: chans, price_aligned: priceFix.updated || 0 };

  const findings = (await listFindings(store, { limit: 40, minScore }).catch(() => [])) || [];
  // 結果の書き戻し: 過去に「売れた/反応があった」候補は点数が同じでも前に出す。
  // これが無いと、巡回→下書き→投稿が一方通行になり、同じ手を繰り返すだけになる。
  const fb = await findingFeedback(store).catch(() => ({}));
  findings.sort((a, b) => (Number(b.score || 0) + (fb[b.id] || 0)) - (Number(a.score || 0) + (fb[a.id] || 0)));
  report.feedback = { recorded: Object.keys(fb).length, positive: Object.values(fb).filter((v) => Number(v) > 0).length };
  const existing = (await listDrafts(store, { limit: 80 }).catch(() => [])) || [];
  const usedUrls = new Set();
  const titleKeys = new Set();
  for (const d of existing) {
    if (String(d.state) === 'blocked') continue; // 差し戻した下書きは「使った」ことにしない（一時的な上限で候補を消さないため）
    const m = String(d.body || '').match(/https?:\/\/\S+/g) || [];
    for (const u of m) usedUrls.add(u.replace(/[),.。]+$/, ''));
    if (d.title) titleKeys.add(String(d.title).slice(0, 40));
  }

  const idxRaw = await store.first(`SELECT value FROM settings WHERE key='social:idx'`).catch(() => null);
  let idx = Number(safeJson(idxRaw?.value, 0)) || 0;

  const pool = spins.length ? findings : []; // ココナラだけ指定されたら候補ローテーションは行わない
  for (const f of pool) {
    if (report.created.length >= limit) break;
    report.considered++;
    const url = String(f.url || '').replace(/[),.。]+$/, '');
    const titleKey = String(f.title || '').slice(0, 40);
    if ((url && usedUrls.has(url)) || titleKeys.has(titleKey)) { report.skipped++; continue; }

    const channel = spins[idx % spins.length];
    const tpl = templateFor(channel, f);
    if (!tpl) { report.skipped++; continue; }
    idx++;

    const { draft, verdict } = await queueDraft(store, {
      ...tpl, channel, created_at: at,
      // scout の id を thread_id に残す（どの候補から作ったかを追えるように）
      thread_id: f.id || null,
    });
    if (verdict.ok) {
      report.created.push({ id: draft.id, channel, title: draft.title, from: f.title, score: f.score });
      if (url) usedUrls.add(url);
      titleKeys.add(titleKey);
    } else {
      // 上限による差し戻しは「一時的」— 日／週が変われば同じ候補を別の媒体で使える。
      // だから候補は消費せずに残す。重複・禁止カテゴリは恒久的なので消費する。
      const transient = verdict.blocks.some((b) => b.includes('上限'));
      report.blocked.push({ channel, title: draft.title, blocks: verdict.blocks, transient });
      if (transient) report.deferred++;
      else { if (url) usedUrls.add(url); titleKeys.add(titleKey); }
    }
  }

  // ココナラ（自分の品目を売る場所）: 拾った候補が無くても出品は作れる。上限まで、
  // まだ出していない品目から作る。無料でできるのは「出品の下書き」まで（公開は人）。
  if (chans.includes('coconala')) {
    while (report.created.length < limit) {
      const off = COCONALA_OFFERS.find((o) => !titleKeys.has(offerKey(o)));
      if (!off) break;
      const tpl = templateCoconala(off);
      const { draft, verdict } = await queueDraft(store, { ...tpl, channel: 'coconala', created_at: at, thread_id: null });
      titleKeys.add(offerKey(off));
      if (!verdict.ok) {
        report.blocked.push({ channel: 'coconala', title: draft.title, blocks: verdict.blocks, transient: false });
        break;
      }
      report.created.push({ id: draft.id, channel: 'coconala', title: draft.title, from: '自分の品目（出品）', score: null });
    }
  }

  // 0件のときに「なぜ0件か」を必ず言えるようにする（黙って0件にしない）。
  if (!report.created.length) {
    report.reason = report.considered === 0
      ? '拾った候補がまだ足りません（scoutの巡回待ち。次の巡回で増えます）'
      : `候補は${report.considered}件見ましたが、すべて使用済み・上限・重複で見送りました（skipped ${report.skipped}件 / blocked ${report.blocked.length}件）`;
  }

  idx = idx % Math.max(1, spins.length);
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES ('social:idx',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    JSON.stringify(idx), at);
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES ('social:last_refill',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    j({ at, created: report.created.length, blocked: report.blocked.length, skipped: report.skipped }), at);
  return report;
}

// 一括承認 — 待ち行列の全てを承認し、「開くだけのリンク」と「貼るだけの塊」を返す。
// これが人の手出しを最小にする本体（1回の操作で全媒体ぶんの材料が揃う）。
// ---------------------------------------------------------------------------
export async function approveAll(store, { channels = null } = {}) {
  const rows = await listDrafts(store, { limit: 80 }).catch(() => []);
  // 閉じた媒体は、承認済みの下書きが残っていても画面に出さない（材料として復活させない）。
  const want = rows.filter((r) => (!channels || channels.includes(r.channel)) && !isRetired(r.channel));
  const queued = want.filter((r) => r.state === 'queued');
  // 承認済みでまだ投稿していないものも返す。前は「押した瞬間に材料が消える」ため、
  // もう一度押すと『出す材料がありません』になり、開くリンクを二度と出せなかった。
  const already = want.filter((r) => r.state === 'approved');
  const approved = []; const failed = [];
  for (const r of queued) {
    const v = await approveDraft(store, r.id);
    if (v.ok) approved.push({ id: r.id, channel: r.channel, title: r.title, kind: r.kind, ...composeFor(r.channel, r) });
    else failed.push({ id: r.id, channel: r.channel, blocks: v.blocks });
  }
  for (const r of already) {
    approved.push({ id: r.id, channel: r.channel, title: r.title, kind: r.kind, reused: true, ...composeFor(r.channel, r) });
  }
  return { ok: true, approved, failed, count: approved.length };
}

// ---------------------------------------------------------------------------
// 状態と表示
// ---------------------------------------------------------------------------
export async function socialReport(store, at = nowIso()) {
  const state = await publishState(store);
  const rows = state.rows || [];
  const day = at.slice(0, 10);
  const wk = weekKey(at);
  const usedOf = (id) => {
    const counted = rows.filter((r) => ['queued', 'approved', 'posted'].includes(r.state) && r.channel === id);
    if (id === 'x') return counted.filter((r) => Number(r.linked) === 1 && String(r.day || r.created_at || '').slice(0, 10) === day).length;
    return counted.filter((r) => weekKey(r.created_at || at) === wk).length;
  };
  const by_channel = CHANNELS.filter((c) => !c.retired).map((c) => {
    const used = usedOf(c.id);
    return {
      id: c.id, label: c.label, mode: c.mode, human: c.human, notes: c.notes,
      needs_disclosure: c.needs_disclosure, needs_video: c.needs_video,
      used, limit: c.cap.n, window: c.cap.window, left: Math.max(0, c.cap.n - used),
      queued: rows.filter((r) => r.channel === c.id && r.state === 'queued').length,
      posted: rows.filter((r) => r.channel === c.id && r.state === 'posted').length,
    };
  });
  const queued_rows = rows.filter((r) => r.state === 'queued').map((r) => ({
    id: r.id, channel: r.channel, title: r.title, kind: r.kind,
    ...composeFor(r.channel, r),
  }));
  return {
    ok: true, at, counts: state.counts, caps: state.caps,
    measured: counts0(rows) > 0,
    outcomes: await outcomeBoard(store).catch(() => ({ recorded: 0 })),
    by_channel, queued: queued_rows,
    one_tap_total: queued_rows.length,
    video_note: 'YouTube は下書きの対象から外しました（動画ファイルを用意する必要があり、無料では完結しないため）。手元で作るときは /studio.html が使えます。',
    retired_channels: RETIRED_IDS,
  };
}

const counts0 = (rows) => rows.filter((r) => ['queued', 'approved', 'posted'].includes(r.state)).length;

export function socialCards(report = {}) {
  const ch = report.by_channel || [];
  const kpi = {
    type: 'kpi', title: 'SNS投稿（下書きまで自動・操作は最小）',
    items: [
      { label: 'いま押すだけ', value: report.one_tap_total || 0, unit: '件（リンクを開けば本文が入ります）' },
      { label: '自動で作り直した', value: report.counts?.blocked || 0, unit: '件（重複・上限で止めた）' },
      { label: 'X 残り', value: ch.find((c) => c.id === 'x')?.left ?? '—', unit: '本/日' },
      { label: 'note 残り', value: ch.find((c) => c.id === 'note')?.left ?? '—', unit: '本/週' },
      { label: 'ココナラ 残り', value: ch.find((c) => c.id === 'coconala')?.left ?? '—', unit: '品/週（出品が在庫になる）' },
      { label: '結果の記録', value: report.outcomes?.recorded || 0, unit: '件（売れた／反応なし等）' },
    ],
  };
  const list = {
    type: 'list', title: '媒体ごとに、あなたがやること',
    items: ch.map((c) => ({
      label: c.label,
      value: c.mode === 'prefilled' ? 'タップ1回' : c.mode === 'paste' ? '貼るだけ' : '動画を選んで貼る',
      unit: c.human,
    })),
  };
  const note = {
    type: 'note',
    text: report.video_note || '投稿は承認制です（凍結は入金経路ごと失うため）。',
  };
  return [kpi, list, note];
}

export function socialHelp() {
  return [
    'X・note・ココナラ の3媒体について、あなたの操作を「押すだけ・貼るだけ」に寄せる層です。下書きは scout（無料・鍵不要の巡回）が拾った実データから自動で作るので、原価は0です。',
    'X はリンクを開いた時点で本文が入力されています（intent URL に本文を載せているため）。あなたは「ポスト」を押すだけです。',
    'note はタイトルと本文の塊をそのまま貼るだけ、ココナラは出品ページにタイトルと説明を貼るだけです。note のAI開示文は最初から入っています。',
    'YouTube は 2026-10-16 に下書きの対象から外しました。動画ファイルを用意する必要があり、無料では完結しないためです（手元で作りたいときは /studio.html が使えます）。',
    '本数の上限（Xのリンク付き=1日3件、note=週2本、ココナラ=週2品）と重複検査はコードで強制しています。規約が禁じているのは自動化ではなく、量産と重複です。',
    '投稿の実行だけは人の承認を残しています。アカウント連携（OAuth）と本人確認が人にしかできないためで、凍結は入金経路ごと失うためです。',
    '拾ったネタと「試す計画」は「拾ったネタと試す計画」（/api/scout）で見られます。巡回先は開発者コミュニティ（Hacker News / GitHub / dev.to / Qiita / Zenn / Product Hunt / Lobsters / Indie Hackers / MCPレジストリ）で、SNSの投稿そのものを巡回しているわけではありません。',
    '「開いた / 出した / 反応あり / 売れた / 反応なし」を記録すると、次にどの候補を優先するかに効きます（＝試行錯誤の輪）。反応なしは「同じ手を繰り返さない」判断に使います。',
    'Reddit は下書きの対象に入れていません。理由は規約と技術の両方です: 公式Wikiが hosted service provider の netblock からのアクセスに有効なOAuthを要求するため Workers からは読めず（実測でも403）、新規OAuthは承認制、そして公式の基準が「参加9割・宣伝1割」で違反時はサイト全体の永久BANまで上がります。凍結は入金経路ごと失うので、ここは自動化しません。いま取れる確定した現金は AgentHansa の本人確認（最大$14.50）で、これは人の操作です。',
    'X の公式APIは従量課金のみです（2026-10-17時点: 投稿 $0.015 / URL付き投稿 $0.200 / 自分の投稿の読み取り $0.001）。無料枠の記載は無いので、リンク付きを1日3件出すと月 $18（約2,844円）かかります。原価0の制約があるため、本文を載せた intent URL を人が1タップ、という今の形を維持します。',
    '価格は本人が 980円 と決めました（全7品目）。出品画面で変えたいときは変えてください。',
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// 結果の書き戻し — 試行錯誤の輪を閉じる部分。
//
// なぜ要るか: 巡回 → 下書き → 投稿 が一方通行だと、同じ手を繰り返すだけで学びが積まれない。
// ここで「開いた／出した／反応あり／売れた／反応なし」を1タップで記録し、次に拾う候補の
// 優先順位（採点の補正）に効かせる。FX Lab が自動で回している輪を、SNS側にも作る。
// 原価0: 記録はD1に置くだけで、外部APIは呼ばない。
// ---------------------------------------------------------------------------
export const T_OUTCOME = 'social_outcomes';
export const OUTCOMES = [
  { id: 'opened', label: 'リンクを開いた', weight: 1, note: '第一歩。開いただけでも記録する価値がある' },
  { id: 'posted', label: '投稿・出品した', weight: 3, note: '外に出た時点で反応が測れる' },
  { id: 'replied', label: '反応があった（返信・いいね）', weight: 5, note: '需要の証拠になりはじめる' },
  { id: 'sold', label: '売れた・受注した', weight: 20, note: '唯一の確定した答え' },
  { id: 'no_reaction', label: '反応なし', weight: -3, note: '同じ手を繰り返さないための記録' },
];
export const outcomeById = (id) => OUTCOMES.find((o) => o.id === String(id || '')) || null;

export async function ensureOutcomeTable(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${T_OUTCOME} (
    id TEXT PRIMARY KEY, draft_id TEXT, finding_id TEXT, channel TEXT,
    outcome TEXT NOT NULL, weight REAL DEFAULT 0, note TEXT, created_at TEXT NOT NULL
  )`).catch(() => {});
  await store.run(`CREATE INDEX IF NOT EXISTS ${T_OUTCOME}_finding ON ${T_OUTCOME}(finding_id)`).catch(() => {});
}

const newOutcomeId = () => `oc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export async function recordOutcome(store, { draft_id = null, channel = null, outcome = null, note = null, now = null } = {}) {
  const o = outcomeById(outcome);
  if (!o) return { ok: false, error: 'unknown_outcome', allowed: OUTCOMES.map((x) => x.id), summary: '記録できるのは「開いた / 出した / 反応あり / 売れた / 反応なし」の5つだけです。' };
  await ensureOutcomeTable(store);
  const at = now || nowIso();
  const draft = draft_id ? await store.get('publish_drafts', draft_id).catch(() => null) : null;
  const findingId = draft?.thread_id || null;
  const row = {
    id: newOutcomeId(), draft_id: draft_id || null, finding_id: findingId, channel: channel || draft?.channel || null,
    outcome: o.id, weight: o.weight, note: note || null, created_at: at,
  };
  await store.insert(T_OUTCOME, row);
  // 拾った候補にも書き戻す（次に同じ候補を選ぶかどうかの材料）。
  if (findingId) {
    const status = (o.id === 'sold' || o.id === 'replied') ? 'won' : (o.id === 'no_reaction' ? 'cold' : 'tried');
    await store.run(`UPDATE scout_findings SET status=?, updated_at=? WHERE id=?`, status, at, findingId).catch(() => {});
  }
  return {
    ok: true, recorded: row, label: o.label, finding_id: findingId,
    next: o.weight > 0 ? '次はこの方向（同じ能力・同じ媒体）を優先します' : '同じ手を繰り返さない判断に使います',
    summary: `「${o.label}」を記録しました。${o.weight > 0 ? '次の選別で前になります。' : '同じ手を繰り返さない材料にします。'}`,
  };
}

export async function listOutcomes(store, { limit = 50 } = {}) {
  await ensureOutcomeTable(store);
  return await store.all(`SELECT * FROM ${T_OUTCOME} ORDER BY created_at DESC LIMIT ?`, limit).catch(() => []);
}

export async function outcomeBoard(store) {
  const rows = await listOutcomes(store, { limit: 200 });
  const counts = {};
  for (const o of OUTCOMES) counts[o.id] = 0;
  let weight = 0;
  for (const r of rows) { counts[r.outcome] = (counts[r.outcome] || 0) + 1; weight += Number(r.weight) || 0; }
  return {
    outcome_options: OUTCOMES.map((o) => ({ id: o.id, label: o.label, note: o.note })),
    recorded: rows.length, counts, weight: Math.round(weight * 10) / 10,
    sold: counts.sold || 0, replied: counts.replied || 0, posted: counts.posted || 0,
    opened: counts.opened || 0, no_reaction: counts.no_reaction || 0,
    recent: rows.slice(0, 8).map((r) => ({ channel: r.channel, outcome: r.outcome, at: r.created_at, note: r.note })),
  };
}

/** 候補IDごとの重み（＝次の優先順位の補正）。 */
export async function findingFeedback(store) {
  await ensureOutcomeTable(store);
  const rows = await store.all(`SELECT finding_id, outcome, weight, channel FROM ${T_OUTCOME} WHERE finding_id IS NOT NULL`).catch(() => []);
  const map = {};
  for (const r of rows) {
    if (!r.finding_id) continue;
    map[r.finding_id] = Math.round(((map[r.finding_id] || 0) + (Number(r.weight) || 0)) * 10) / 10;
  }
  return map;
}

/** 既に作った下書きの「案: 1,000円（あなたが決めてください）」を、決めた価格に直す（冪等）。 */
export async function applyDecidedPrice(store, { jpy = 980 } = {}) {
  const rows = await listDrafts(store, { limit: 200 }).catch(() => []);
  const re = /案: [\d,]+円（あなたが決めてください）/;
  const to = `${Number(jpy).toLocaleString('ja-JP')}円（税込・変えたいときは出品画面で変更できます）`;
  let updated = 0;
  for (const r of rows) {
    if (r.channel !== 'coconala') continue;
    const body = String(r.body || '');
    if (!re.test(body)) continue;
    const next = body.replace(re, to);
    if (next === body) continue;
    await store.run(`UPDATE publish_drafts SET body=?, updated_at=? WHERE id=?`, next, nowIso(), r.id);
    updated += 1;
  }
  return { ok: true, jpy: Number(jpy), updated, scanned: rows.length, summary: `ココナラの下書き ${updated}件 の価格を ${Number(jpy).toLocaleString('ja-JP')}円 に直しました（他は触っていません）。` };
}
