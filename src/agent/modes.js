// モード（用途の切り替え）— このエージェントは「稼ぐ」ためだけのものではない。
// 「今日は調べものを手伝ってほしい」「文章を書きたい」「暮らしの手続きを整理したい」
// といった用途をモードとして持ち、会話のチップ・見張りの語彙・成果の数え方・
// 承認の範囲がモードに合わせて変わる。組み込みモードは決定的（AI課金なし）に動き、
// オーナーは自分のモードを会話から追加できる。

import { nowIso, safeJson } from '../util.js';
import { setting, setSetting } from '../db.js';

export const MODE_KEY = 'agent:mode';
export const DEFAULT_MODE = 'money';

/** 組み込みモード。すべて同じエンジンで動き、見せ方と数え方だけが変わる。 */
export const BUILTIN_MODES = {
  money: {
    id: 'money',
    label: '稼ぐ',
    blurb: '収益の芽を探して、実行して、実測で確かめる',
    goal_example: '月3万円の追加収益をつくる',
    kpi_title: '収支（実測と推定は分けて数えます）',
    outcome_label: '実測収益',
    unit: '円',
    chips: ['今どうなってる？', '次の一手を進めて', '収益はいくら？', '足あとを見せて', '何ができる？'],
    placeholder: 'エージェントに指示する',
    judge_note: 'お金に触れる操作は必ずあなたの承認を待ちます。',
    extra_approval: [],
    extra_never: [],
  },
  research: {
    id: 'research',
    label: '調べる',
    blurb: '質問を分解して、根拠つきで調べて、要点と出典を残す',
    goal_example: '気になっているテーマを10本調べて要点を残す',
    kpi_title: '調べた成果',
    outcome_label: '調べた件数',
    unit: '件',
    chips: ['今どうなってる？', '次の一手を進めて', '足あとを見せて', 'この調べ方を覚えて', '何ができる？'],
    placeholder: '調べたいことを書く',
    judge_note: '出典のない断定はしません。',
    extra_approval: ['有料データベースの契約'],
    extra_never: [],
  },
  write: {
    id: 'write',
    label: '書く',
    blurb: '下書きを作って、直して、読める形に仕上げる',
    goal_example: 'たまっている下書きを3本仕上げる',
    kpi_title: '書いた成果',
    outcome_label: '仕上げた本数',
    unit: '本',
    chips: ['今どうなってる？', '次の一手を進めて', '足あとを見せて', 'この書き方を覚えて', '何ができる？'],
    placeholder: '書きたいものを書く',
    judge_note: 'あなたの文章は勝手に外部へ出しません。',
    extra_approval: ['外部への投稿・公開', 'あなたの文章の外部送信'],
    extra_never: ['他人の文章の丸写し'],
  },
  build: {
    id: 'build',
    label: 'つくる',
    blurb: 'ものやコードを作って、動かして確かめる',
    goal_example: '小さな道具を1つ動くところまで作る',
    kpi_title: '作った成果',
    outcome_label: '動くようになったもの',
    unit: '件',
    chips: ['今どうなってる？', '次の一手を進めて', '足あとを見せて', '動かして確かめて', '何ができる？'],
    placeholder: '作りたいものを書く',
    judge_note: '壊す操作の前には必ず確認します。',
    extra_approval: ['本番環境への反映', '外部サービスの契約'],
    extra_never: [],
  },
  life: {
    id: 'life',
    label: '暮らし',
    blurb: '手続き・段取り・調べものを整理して、期限までに片づける',
    goal_example: '今月やる手続きを全部片づける',
    kpi_title: '片づいたこと',
    outcome_label: '終わった用事',
    unit: '件',
    chips: ['今どうなってる？', '次の一手を進めて', '足あとを見せて', '忘れないように見張って', '何ができる？'],
    placeholder: 'やってほしい用事を書く',
    judge_note: '個人情報の外部送信はしません。',
    extra_approval: ['役所・金融機関への申請送信', '個人情報の外部送信'],
    extra_never: [],
  },
};

export const getBuiltinMode = (id) => BUILTIN_MODES[id] || null;
export const builtinModes = () => Object.values(BUILTIN_MODES);

function rowToMode(r) {
  return {
    id: r.id,
    label: r.label,
    blurb: r.blurb || 'あなたが追加したモード',
    goal: r.goal || '',
    custom: true,
    kpi_title: r.kpi_title || 'いまの成果',
    outcome_label: r.outcome_label || '終わったこと',
    unit: r.unit || '件',
    chips: safeJson(r.chips_json, []) || [],
    placeholder: r.placeholder || `${r.label}で指示する`,
    judge_note: r.judge_note || '',
    extra_approval: safeJson(r.extra_approval_json, []) || [],
    extra_never: safeJson(r.extra_never_json, []) || [],
  };
}

/** 組み込み + オーナーが追加したモード。 */
export async function allModes(store) {
  const rows = await store.all(`SELECT * FROM modes ORDER BY created_at ASC`).catch(() => []);
  return [...builtinModes(), ...rows.map(rowToMode)];
}

export async function getMode(store, id) {
  if (!id) return BUILTIN_MODES[DEFAULT_MODE];
  const b = getBuiltinMode(id);
  if (b) return b;
  const row = await store.get('modes', id).catch(() => null);
  return row ? rowToMode(row) : null;
}

/** いま使っているモード。設定に保存されているので、端末を変えても同じ。 */
export async function activeMode(store) {
  const id = await setting(store, MODE_KEY, DEFAULT_MODE).catch(() => DEFAULT_MODE);
  const m = await getMode(store, id).catch(() => null);
  return m || BUILTIN_MODES[DEFAULT_MODE];
}

export async function setActiveMode(store, id) {
  const m = await getMode(store, id);
  if (!m) return null;
  await setSetting(store, MODE_KEY, m.id);
  return m;
}

export function defaultChips(mode) {
  const chips = mode?.chips?.length ? mode.chips : ['今どうなってる？', '次の一手を進めて', '足あとを見せて', '何ができる？'];
  return chips.slice(0, 5);
}

/** ラベルから id を作る。日本語ラベルは時刻ベースにフォールバックする。 */
function idFor(label) {
  const slug = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `md_${slug}` : `md_${Date.now().toString(36)}`;
}

/**
 * 自分のモードを追加・更新する。goal（目的）を書いておくと、目標の見張りにそのまま使える。
 */
export async function upsertCustomMode(store, { id = null, label, goal = '', blurb = '', kpi_title = '', outcome_label = '', unit = '件', chips = null, placeholder = '' } = {}) {
  const name = String(label || '').trim().slice(0, 20);
  if (!name) return null;
  const mid = id || idFor(name);
  const existing = await store.get('modes', mid).catch(() => null);
  const row = {
    id: mid, label: name, goal: String(goal || '').slice(0, 300), blurb: String(blurb || `「${name}」を進めるモード`).slice(0, 160),
    kpi_title: kpi_title || `${name}の成果`, outcome_label: outcome_label || '終わったこと', unit,
    chips_json: JSON.stringify(chips && chips.length ? chips : ['今どうしてる？', '次の一手を進めて', '足あとを見せて', '何ができる？']),
    placeholder: placeholder || `${name}で指示する`,
    extra_approval_json: JSON.stringify([]), extra_never_json: JSON.stringify([]),
    created_at: existing?.created_at || nowIso(), updated_at: nowIso(),
  };
  if (existing) await store.run(
    `UPDATE modes SET label=?, goal=?, blurb=?, kpi_title=?, outcome_label=?, unit=?, chips_json=?, placeholder=?, updated_at=? WHERE id=?`,
    row.label, row.goal, row.blurb, row.kpi_title, row.outcome_label, row.unit, row.chips_json, row.placeholder, row.updated_at, mid,
  );
  else await store.insert('modes', row);
  return rowToMode(row);
}

/** モードカード（会話に出す一覧）。 */
export function modeCard(modes, currentId) {
  return {
    type: 'list',
    icon: 'gear',
    title: 'モード（用途を切り替えられます）',
    items: modes.map((m) => ({
      title: m.label,
      sub: [m.custom ? 'あなたが追加' : '組み込み', m.blurb, m.goal || null].filter(Boolean).join(' · '),
      badge: m.id === currentId ? 'いま' : null,
      tone: m.id === currentId ? 'accent' : 'ghost',
      act: m.id === currentId ? null : `mode:${m.id}`,
      act_label: m.id === currentId ? null : '切り替え',
    })),
  };
}

/**
 * 会話からモードの指示を読む: 切り替え / 追加 / 目的の変更 / 一覧。
 * 「調べるモードにして」「文章づくりモードを追加して。目的は 週1本の記事を書く」
 */
export function parseModeRequest(text) {
  const s = String(text || '').trim();
  const label = (s.match(/[「『]([^」』]{1,20})[」』]\s*モード/) || s.match(/([^\s、。のをでにがは]{1,20}?)\s*モード/))?.[1] || null;
  const goalTail = (s.match(/(?:目的|ゴール|狙い)\s*(?:は|を|:)?\s*(.+)$/) || [])[1] || null;
  const goal = goalTail ? goalTail.replace(/^[、。\s]+/, '').trim().slice(0, 300) : null;
  const wantsCreate = /(追加|作って|作成|つくって|登録|欲しい|ほしい)/.test(s);
  const wantsGoal = !!goal && /(変え|変更|設定|にしたい|はこれ)/.test(s);
  const wantsSwitch = /(にして|に切り替え|変えて|で行|でや|にしたい|を使|で使|で動)/.test(s);
  const wantsList = /(一覧|見せて|どれ|なにがあ|何があ|教えて|ある？)/.test(s);
  if (wantsCreate && label) return { action: 'create', label, goal };
  if (wantsGoal) return { action: 'goal', goal, label };
  if (wantsSwitch && label) return { action: 'switch', label };
  return { action: 'list', label };
}
