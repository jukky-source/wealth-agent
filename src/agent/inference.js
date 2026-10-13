// 無料推論の「使用量」と「円換算」を出す計測レイヤ。
//
// 設計の柱は2つだけで、混ぜないこと:
//   1. 実測 — ai_usage テーブルに記録された**実際の呼び出し**だけを数える。
//      自己申告・見積りは入れない（お金の実測と同じ扱い）。
//   2. 換算 — 有料で同じ量を買ったらいくらになるかを、各社の公表単価で計算する。
//      単価は必ず出典URLとセットで返す。数字だけを裸で出さない。
//
// 実測が0件のときは 0 円と正直に言う。空想の金額は出さない。
// クォータからの推定は「推定」と明示して別枠で出す（実測の欄には入れない）。

import { nowIso } from '../util.js';

export const USD_JPY_DEFAULT = 158;

/** 文字数→トークン。日本語中心の本文なので 1 トークン ≒ 2.5 文字で置く。 */
export const CHARS_PER_TOKEN = 2.5;

/** 推定モードのときだけ使う架空の1ターン（この値を実測に混ぜない）。 */
export const TURN = { in: 4000, out: 800 };

/**
 * 換算アンカー（USD / 100万トークン）。全部「公表値」。出典を消さない。
 * 安い方だけで見積もると過小になるので、3本併記する。
 */
export const PRICE_ANCHORS = [
  {
    id: 'gpt5_mini',
    label: 'GPT-5 mini 級',
    in_usd: 0.25,
    out_usd: 2.0,
    source: 'https://pricepertoken.com/pricing-page/model/openai-gpt-5-mini',
  },
  {
    id: 'haiku45',
    label: 'Claude Haiku 4.5 級',
    in_usd: 1.0,
    out_usd: 5.0,
    source: 'https://pricepertoken.com/pricing-page/model/anthropic-claude-haiku-4.5',
  },
  {
    id: 'gemini_flash',
    label: 'Gemini 3.5 Flash 級',
    in_usd: 1.5,
    out_usd: 9.0,
    source: 'https://openrouter.ai/google/gemini-3.5-flash',
  },
];

export const DEFAULT_ANCHOR = 'haiku45';

export function anchorById(id) {
  return PRICE_ANCHORS.find((a) => a.id === id)
    || PRICE_ANCHORS.find((a) => a.id === DEFAULT_ANCHOR);
}

/** トークン数 → 円。換算そのものは純関数（テストできる）。 */
export function jpyFromTokens({ in_tokens = 0, out_tokens = 0 } = {}, anchorId = DEFAULT_ANCHOR, { usd_jpy = USD_JPY_DEFAULT } = {}) {
  const a = anchorById(anchorId);
  const usd = (Number(in_tokens) * a.in_usd + Number(out_tokens) * a.out_usd) / 1_000_000;
  return {
    anchor: a.id,
    label: a.label,
    usd: Number(usd.toFixed(4)),
    yen: Math.round(usd * usd_jpy),
    usd_jpy,
    source: a.source,
  };
}

export function tokensOf(chars) {
  return Math.round(Number(chars || 0) / CHARS_PER_TOKEN);
}

/**
 * ai_usage の行を集計する。ここが「実際にいくら分使ったか」の唯一の出所。
 */
export function usageBoard(rows = [], { usd_jpy = USD_JPY_DEFAULT, anchor = DEFAULT_ANCHOR } = {}) {
  const by = new Map();
  let calls = 0; let ok = 0; let fail = 0;
  let prompt_chars = 0; let output_chars = 0;
  let latency = 0; let latency_n = 0;
  const days = new Set();

  for (const r of rows || []) {
    const p = String(r.provider || 'unknown');
    const cur = by.get(p) || { provider: p, calls: 0, ok: 0, fail: 0, prompt_chars: 0, output_chars: 0 };
    calls += 1; cur.calls += 1;
    if (Number(r.ok) === 1) { ok += 1; cur.ok += 1; } else { fail += 1; cur.fail += 1; }
    const pc = Number(r.prompt_chars || 0); const oc = Number(r.output_chars || 0);
    prompt_chars += pc; cur.prompt_chars += pc;
    output_chars += oc; cur.output_chars += oc;
    if (r.latency_ms) { latency += Number(r.latency_ms); latency_n += 1; }
    if (r.day) days.add(String(r.day));
    by.set(p, cur);
  }

  const in_tokens = tokensOf(prompt_chars);
  const out_tokens = tokensOf(output_chars);
  const measured = calls > 0;
  const value = jpyFromTokens({ in_tokens, out_tokens }, anchor, { usd_jpy });

  return {
    measured,
    basis: measured
      ? 'ai_usage に記録された実際の呼び出しだけを数えています（自己申告・見積りは含みません）。'
      : 'まだ呼び出しが1件も記録されていないので、金額は 0 円です。実測が無いうちは推定を出しません。',
    calls,
    ok_calls: ok,
    failed: fail,
    prompt_chars,
    output_chars,
    in_tokens,
    out_tokens,
    chars_per_token: CHARS_PER_TOKEN,
    avg_latency_ms: latency_n ? Math.round(latency / latency_n) : null,
    active_days: days.size,
    lanes: [...by.values()].sort((a, b) => b.calls - a.calls),
    value,
    alternatives: PRICE_ANCHORS.map((a) => jpyFromTokens({ in_tokens, out_tokens }, a.id, { usd_jpy })),
    usd_jpy,
    checked_at: nowIso(),
  };
}

/**
 * クォータからの推定値。「上限まで回したらいくら分か」。
 * これは推定なので、実測の欄には決して入れない。
 */
export function capacityValue(cap = {}, { usd_jpy = USD_JPY_DEFAULT, anchor = DEFAULT_ANCHOR, hours = 8 } = {}) {
  const turns = Number(cap.daily_requests || 0) + Number(cap.unkeyed_hourly_requests || 0) * Number(hours || 8);
  const in_tokens = turns * TURN.in;
  const out_tokens = turns * TURN.out;
  const v = jpyFromTokens({ in_tokens, out_tokens }, anchor, { usd_jpy });
  return { turns: Math.round(turns), per_day_yen: v.yen, per_month_yen: v.yen * 30, label: v.label, source: v.source };
}

/** 実際の使用ログを読んで盤面にする（store は D1 / sqlite どちらでも同じ）。 */
export async function readUsageBoard(store, opts = {}) {
  let rows = [];
  try {
    rows = await store.all('SELECT provider, ok, prompt_chars, output_chars, latency_ms, day FROM ai_usage');
  } catch { rows = []; }
  return usageBoard(rows, opts);
}

/** 会話でそのまま出せる形（UI が解釈できる type だけを使う）。 */
export function inferenceCards(board, { capacity = null } = {}) {
  const kpi = {
    type: 'kpi',
    title: '無料推論の使用量（実測）',
    items: [
      { label: '呼び出し', value: board.calls, unit: '回', hl: true },
      { label: '成功', value: board.ok_calls, unit: '回' },
      { label: '有料なら', value: board.value.yen, unit: '円相当' },
      { label: '入力トークン', value: board.in_tokens, unit: 'tok' },
      { label: '出力トークン', value: board.out_tokens, unit: 'tok' },
    ],
  };
  const cards = [kpi];
  if (board.lanes.length) {
    cards.push({
      type: 'list',
      icon: 'pulse',
      title: 'レーン別の内訳',
      items: board.lanes.slice(0, 8).map((l) => ({
        title: l.provider,
        sub: `成功 ${l.ok}・失敗 ${l.fail}・${(l.prompt_chars + l.output_chars).toLocaleString('ja-JP')} 文字`,
        badge: `${l.calls} 回`,
      })),
    });
  }
  const lines = [`換算: ${board.alternatives.map((a) => `${a.label} ¥${a.yen.toLocaleString('ja-JP')}`).join(' / ')}`];
  if (capacity) lines.push(`推定（クォータの上限まで回した場合）: 約 ${capacity.turns.toLocaleString('ja-JP')} ターン/日 ＝ ${capacity.label} で月 約 ¥${capacity.per_month_yen.toLocaleString('ja-JP')} 相当`);
  lines.push(board.basis);
  lines.push(`1ドル = ¥${board.usd_jpy} で換算。単価の出典: ${board.value.source}`);
  cards.push({ type: 'note', icon: 'book', title: '換算の根拠', text: lines.join('\n') });
  return cards;
}

export function inferenceHelp() {
  return [
    '「無料推論いくら使った？」で、実際に走った回数と、有料で同じ量を買った場合の金額（円）を出します。',
    '数えるのは ai_usage（実際の呼び出しログ）だけです。申告した数字は入れません。実測が0件なら 0 円と正直に出します。',
    '単価は GPT-5 mini 級・Claude Haiku 4.5 級・Gemini 3.5 Flash 級の公表値を併記します（安い方だけだと過小になるため）。',
    'クォータ（枠）から上限まで回した額は「推定」として別に表示し、実測とは混ぜません。',
  ].join('\n');
}
