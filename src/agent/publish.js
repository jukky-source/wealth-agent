// Publish queue (投稿キュー) — 下書きまでは全自動、投稿ボタンの1タップだけ人に残す。
//
// Why: the platforms do NOT ban automation, they ban MASS PRODUCTION and
// DUPLICATION (YouTube: 自動化または合成による大量生成 / 重複の多いコンテンツ,
// X: 重複ツイート・ほぼ同内容の投稿). So the safe shape is 自動×少数精鋭 —
// draft everything automatically, then hard-cap the volume and refuse
// near-duplicates before a human ever looks at it. The only human step that
// survives is the final tap, because a BAN costs the whole payout path.

import { id as newId, nowIso, utcDay } from '../util.js';

export const DRAFT_KIND_LABEL = {
  research: 'リサーチ原稿',
  script: '台本（動画）',
  article: '記事',
  post: 'SNS投稿',
  thumbnail: 'サムネイル指示',
  description: '概要欄・説明文',
};

// Volume caps. These are the anti-mass-production gates, not platform limits:
// the YouTube API would allow 100 uploads/day, and X charges per post — the
// reason to stay small is the spam policy and the per-post cost.
export const CAPS = {
  x: { linked_per_day: 3, note: 'リンク付きは1日3件まで（1件=約31.6円、月約2,844円の想定）。' },
  youtube: { uploads_per_week: 2, note: '週2本まで。量産と判定されないための上限。' },
};

// どこまで自動で、どこから人が要るか。実行環境（runner）が要る工程だけを分けて出す。
export const PIPELINE = [
  { step: 'research', label: 'リサーチ', auto: true, needs_runner: false, cost: 0, note: '無料AIレーン＋クロール。原価0。' },
  { step: 'script', label: '原稿・台本づくり', auto: true, needs_runner: false, cost: 0, note: '無料AIレーンで生成。' },
  { step: 'thumbnail', label: 'サムネイル・図の生成', auto: true, needs_runner: false, cost: 0, note: '画像生成は無料枠（Cloudflare Workers AI のNeurons等）で足りる。' },
  { step: 'voice', label: '音声（TTS）', auto: true, needs_runner: true, cost: 0, note: 'オープン重みのTTSを実行環境で動かす。' },
  { step: 'encode', label: '動画の合成（エンコード）', auto: true, needs_runner: true, cost: 0, note: 'ffmpeg。Cloudflare Workers上では動かないので実行環境が要る。' },
  { step: 'description', label: '概要欄・説明文', auto: true, needs_runner: false, cost: 0, note: 'AI開示の文面もここで自動で入れる。' },
  { step: 'dup_check', label: '重複検査と本数上限', auto: true, needs_runner: false, cost: 0, note: '量産と判定されないための自動ゲート。' },
  { step: 'approve', label: '投稿の承認（1タップ）', auto: false, needs_runner: false, cost: 0, human: true, note: 'ここだけ人が持ちます。BANで入金経路ごと失うのを避ける最小コスト。' },
];

// ------------------------------------------------------------------ 重複検査
// 正規化してから文字4-gramのJaccard係数で比べる。URLや句読点の違いを無視し、
// 「文言・画像・ハッシュタグだけ変えたテンプレ投げ」を検出するのが目的。
export function normalizeText(s = '') {
  return String(s)
    .replace(/https?:\/\/\S+/g, ' ')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,!?;:'"`()\[\]{}<>/\\|~^*_=+\-—–…、。！？「」『』【】（）]/g, '')
    .trim();
}

export function shingleSet(s, n = 4) {
  const t = normalizeText(s);
  const out = new Set();
  if (t.length <= n) { if (t) out.add(t); return out; }
  for (let i = 0; i + n <= t.length; i += 1) out.add(t.slice(i, i + n));
  return out;
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  const A = shingleSet(a); const B = shingleSet(b);
  if (!A.size || !B.size) return normalizeText(a) === normalizeText(b) ? 1 : 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export const DUPLICATE_THRESHOLD = 0.7;

export function dupCheck(text, history = [], threshold = DUPLICATE_THRESHOLD) {
  let max = 0; let against = null;
  for (const h of history) {
    const s = similarity(text, h.body || h.text || '');
    if (s > max) { max = s; against = h.id || null; }
  }
  return { duplicate: max >= threshold, max: Math.round(max * 100) / 100, against };
}

// ------------------------------------------------------------------ 本数の上限
export function weekKey(iso) {
  const d = new Date(iso || nowIso());
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const start = new Date(Date.UTC(y, 0, 1));
  const wk = Math.ceil(((t - start) / 86400000 + 1) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}

const COUNTED_STATES = ['queued', 'approved', 'posted'];
export const COUNTED = COUNTED_STATES;

export function capsUsage(rows = [], at = nowIso()) {
  const day = utcDay(new Date(at));
  const wk = weekKey(at);
  const counted = rows.filter((r) => COUNTED_STATES.includes(r.state));
  const xLinked = counted.filter((r) => r.channel === 'x' && Number(r.linked) === 1
    && String(r.day || r.created_at || '').slice(0, 10) === day).length;
  const yt = counted.filter((r) => r.channel === 'youtube'
    && weekKey(r.created_at || at) === wk).length;
  return {
    day,
    week: wk,
    x: { linked_today: xLinked, limit: CAPS.x.linked_per_day, left: Math.max(0, CAPS.x.linked_per_day - xLinked) },
    youtube: { this_week: yt, limit: CAPS.youtube.uploads_per_week, left: Math.max(0, CAPS.youtube.uploads_per_week - yt) },
  };
}

// ------------------------------------------------------------------ 下書きの判定
// 通してはいけないものを、人が見る前に自動で止める。
export function assessDraft(draft, { history = [], rows = [] } = {}) {
  const blocks = []; const warnings = [];
  const d = draft || {};

  const dup = dupCheck(d.body || '', history);
  if (dup.duplicate) {
    blocks.push(`重複: 過去の下書きと ${Math.round(dup.max * 100)}% 一致（量産と判定されるため差し戻し）`);
  } else if (dup.max >= 0.5) {
    warnings.push(`類似: 過去の下書きと ${Math.round(dup.max * 100)}% 一致。文言・画角を変えてください。`);
  }

  const u = capsUsage(rows, d.created_at || nowIso());
  if (d.channel === 'x' && Number(d.linked) === 1 && u.x.left <= 0) {
    blocks.push(`上限: Xのリンク付きは1日${CAPS.x.linked_per_day}件まで（本日は使い切り。自動投稿は規約違反ではありませんが、重複・大量は凍結対象です）`);
  }
  if (d.channel === 'youtube') {
    if (u.youtube.left <= 0) {
      blocks.push(`上限: YouTubeは週${CAPS.youtube.uploads_per_week}本まで（今週は使い切り。コミュニティガイドラインの「大量生成」回避）`);
    }
    if (Number(d.ai_disclosure) !== 1) {
      blocks.push('AI開示: 実物然とした合成・改変は開示が必須（未設定のため差し戻し）');
    }
    if (Number(d.linked) === 1 && Number(d.unique_commentary) !== 1) {
      blocks.push('独自性: 外部リンクのみを目的とした動画は禁止。独自の解説が要ります');
    }
  }
  if (!DRAFT_KIND_LABEL[d.kind]) warnings.push(`種別が未分類です（${d.kind || '空'}）`);

  return { ok: blocks.length === 0, blocks, warnings, duplicate: dup, caps: u };
}

// ------------------------------------------------------------------ 下書きの生成
export function createDraft(input = {}) {
  const now = nowIso();
  const body = String(input.body || '');
  const channel = String(input.channel || 'x');
  const linked = input.linked != null
    ? (input.linked ? 1 : 0)
    : (/https?:\/\//.test(body) ? 1 : 0);
  return {
    id: input.id || newId('dr_'),
    thread_id: input.thread_id || null,
    kind: DRAFT_KIND_LABEL[input.kind] ? input.kind : 'post',
    channel,
    title: input.title || '',
    body,
    lang: input.lang || 'ja',
    hash: null,
    ai_disclosure: input.ai_disclosure ? 1 : 0,
    unique_commentary: input.unique_commentary ? 1 : 0,
    linked,
    state: input.state || 'drafted',
    blocks_json: '[]',
    scheduled_for: input.scheduled_for || null,
    posted_url: null,
    approved_at: null,
    posted_at: null,
    created_at: input.created_at || now,
    updated_at: now,
    day: utcDay(new Date(input.created_at || now)),
  };
}

// ------------------------------------------------------------------ 永続化
const T = 'publish_drafts';

export async function listDrafts(store, { limit = 20 } = {}) {
  return await store.all(`SELECT * FROM ${T} ORDER BY created_at DESC LIMIT ?`, limit);
}

export async function historyFor(store, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return await store.all(`SELECT id, body, created_at FROM ${T} WHERE created_at >= ? ORDER BY created_at DESC`, since);
}

export async function queueDraft(store, input = {}) {
  const draft = createDraft(input);
  const verdict = assessDraft(draft, {
    history: await historyFor(store).catch(() => []),
    rows: await listDrafts(store, { limit: 60 }).catch(() => []),
  });
  draft.blocks_json = JSON.stringify(verdict.blocks);
  draft.state = verdict.ok ? 'queued' : 'blocked';
  draft.updated_at = nowIso();
  await store.insert(T, draft);
  return { draft, verdict };
}

export async function approveDraft(store, draftId) {
  const row = await store.get(T, draftId);
  if (!row) return { ok: false, blocks: ['下書きが見つかりません'] };
  const verdict = assessDraft(row, {
    history: (await historyFor(store).catch(() => [])).filter((h) => h.id !== draftId),
    rows: (await listDrafts(store, { limit: 60 }).catch(() => [])).filter((r) => r.id !== draftId),
  });
  if (!verdict.ok) {
    await store.run(`UPDATE ${T} SET state='blocked', blocks_json=?, updated_at=? WHERE id=?`,
      JSON.stringify(verdict.blocks), nowIso(), draftId);
    return { ok: false, blocks: verdict.blocks, warnings: verdict.warnings };
  }
  await store.run(`UPDATE ${T} SET state='approved', approved_at=?, blocks_json='[]', updated_at=? WHERE id=?`,
    nowIso(), nowIso(), draftId);
  return { ok: true, blocks: [], warnings: verdict.warnings };
}

export async function markPosted(store, draftId, url = null) {
  await store.run(`UPDATE ${T} SET state='posted', posted_url=?, posted_at=?, updated_at=? WHERE id=?`,
    url, nowIso(), nowIso(), draftId);
  return { ok: true };
}

export async function publishState(store) {
  const rows = await listDrafts(store, { limit: 60 }).catch(() => []);
  return {
    counts: {
      drafted: rows.filter((r) => r.state === 'drafted').length,
      queued: rows.filter((r) => r.state === 'queued').length,
      blocked: rows.filter((r) => r.state === 'blocked').length,
      approved: rows.filter((r) => r.state === 'approved').length,
      posted: rows.filter((r) => r.state === 'posted').length,
    },
    caps: capsUsage(rows),
    rows,
  };
}

// ------------------------------------------------------------------ 表示
export function publishCards(state) {
  const s = state || { counts: {}, caps: capsUsage([]), rows: [] };
  const kpi = {
    type: 'kpi',
    title: '投稿キュー（下書きまでは全自動）',
    items: [
      { label: '承認待ち', value: s.counts.queued || 0, unit: '件（1タップで投稿）' },
      { label: '自動で止めた', value: s.counts.blocked || 0, unit: '件（重複・上限・開示）' },
      { label: 'Xのリンク付き 残り', value: s.caps.x.left, unit: `本/日（上限${s.caps.x.limit}）` },
      { label: 'YouTube 残り', value: s.caps.youtube.left, unit: `本/週（上限${s.caps.youtube.limit}）` },
    ],
  };
  const rows = (s.rows || []).slice(0, 8);
  const list = {
    type: 'list',
    title: 'キューの中身',
    items: rows.length ? rows.map((r) => ({
      label: `${DRAFT_KIND_LABEL[r.kind] || r.kind}｜${r.title || '(無題)'}`,
      value: r.state === 'blocked' ? '自動で止めた' : r.state === 'queued' ? '承認待ち' : r.state,
      unit: `${r.channel}${Number(r.linked) === 1 ? ' · リンク有' : ''}${Number(r.ai_disclosure) === 1 ? ' · AI開示済' : ''}`,
    })) : [{ label: 'まだ下書きがありません', value: '0', unit: '「下書きを作って」で追加' }],
  };
  const auto = PIPELINE.filter((p) => p.auto).length;
  const note = {
    type: 'note',
    text: `自動 ${auto}工程（リサーチ・台本・画像・音声・動画合成・説明文・重複検査）＋人が ${PIPELINE.length - auto} 工程（投稿の承認だけ）。動画合成と音声は実行環境（runner）が要ります。`,
  };
  return [kpi, list, note];
}

export function publishHelp() {
  return [
    '投稿ボタンまで自動です。リサーチ・原稿・台本・サムネイル・音声・動画の合成・概要欄まで自動で作り、最後の「投稿する」だけがあなたの1タップです。',
    '動画の合成（ffmpeg）と音声（TTS）だけは実行環境が要ります。Cloudflare Workers上ではffmpegが動かないため、ここはOracleのVMか手元PCに置く工程です。',
    '投稿そのものを完全自動にもできますが、既定では承認制にしています。凍結は入金経路ごと失うため、1日1分のタップを残す方が得です。',
    '本数の上限はコードで強制しています（Xのリンク付き=1日3件、YouTube=週2本）。規約が禁じているのは自動化ではなく、量産と重複です。',
    '文面の重複は自動で検出して、人が見る前に止めます（表記ゆれ・URL差を無視して比較）。',
  ].join('\n');
}

export function pipelineCards() {
  const items = PIPELINE.map((p) => ({
    label: p.label,
    value: p.human ? '人が1タップ' : '全自動',
    unit: p.needs_runner ? '実行環境が要る' : '0円',
  }));
  return [
    { type: 'kpi', title: 'どこまで自動か', items: [
      { label: '全自動の工程', value: PIPELINE.filter((p) => p.auto).length, unit: `/${PIPELINE.length} 工程` },
      { label: '人が持つ工程', value: PIPELINE.filter((p) => p.human).length, unit: '投稿の承認だけ' },
      { label: '実行環境が要る工程', value: PIPELINE.filter((p) => p.needs_runner).length, unit: '動画合成・音声' },
    ] },
    { type: 'list', title: '工程ごとの自動化', items },
  ];
}
