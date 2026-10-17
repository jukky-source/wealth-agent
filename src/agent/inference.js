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


/* ================= free inference lanes (appended) ================= */

/**
 * Free inference lanes — the agent's own cognition budget.
 *
 * SCOPE (important): this is NOT used to fulfil paid orders. Paid products stay
 * deterministic and model-free so that one call always yields one identical,
 * verifiable answer. These lanes exist so the agent can think, draft listing
 * copy, triage opportunities and summarise research at zero marginal cost.
 *
 * Determinism rule: a dead or missing provider is skipped, never guessed. The
 * chain returns the first lane that answers, and reports the whole attempt trail
 * so a failure is auditable rather than silent.
 */

export const FREE_LANES = [
  {
    id: 'cloudflare-workers-ai',
    label: 'Cloudflare Workers AI',
    base_url: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-120b'],
    key_env: ['CF_ACCOUNT_ID', 'CF_AI_TOKEN'],
    notes: '10,000 Neurons/day free, 60+ models, no credit card. Same vendor as the Worker itself.',
  },
  {
    id: 'llm7-anonymous',
    label: 'LLM7.io (anonymous, no key)',
    base_url: 'https://api.llm7.io/v1/chat/completions',
    model: 'gpt-oss:20b',
    models: ['gpt-oss:20b', 'mistral-Nemo-Instruct-2407'],
    key_env: [],
    notes: 'Anonymous access needs no key and reaches the turbo models.',
  },
  {
    id: 'groq',
    label: 'Groq',
    base_url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    key_env: ['GROQ_API_KEY'],
    notes: '30 RPM, 1,000 RPD, no card. LPU hardware, fastest free tier.',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    base_url: 'https://api.cerebras.ai/v1/chat/completions',
    model: 'llama-3.3-70b',
    key_env: ['CEREBRAS_API_KEY'],
    notes: '~1M tokens/day, 30 RPM, no card.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    models: ['meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-120b:free'],
    key_env: ['OPENROUTER_API_KEY'],
    notes: '20+ free models, 20 RPM / 50 RPD; 1,000/day after a $10 top-up.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    base_url: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-small-latest',
    key_env: ['MISTRAL_API_KEY'],
    notes: 'Experiment tier ~1B tokens/month, but requires opting into data training.',
  },
  {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    base_url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    key_env: ['NVIDIA_API_KEY'],
    notes: 'Free with Developer Program membership; 40 RPM, 10,000 RPD, 100+ models.',
  },
];

function renderBase(lane, env) {
  if (!lane.base_url.includes('{account_id}')) return lane.base_url;
  const acct = env && env.CF_ACCOUNT_ID;
  return acct ? lane.base_url.replace('{account_id}', acct) : null;
}

function laneKey(lane, env) {
  if (lane.key_env.length === 0) return { ok: true, headers: {} };
  const missing = lane.key_env.filter((k) => !(env && env[k]));
  if (missing.length) return { ok: false, missing };
  const h = {};
  // Cloudflare Workers AI uses the same bearer slot; every lane here is OpenAI-compatible.
  const token = lane.key_env.map((k) => env[k]).join('');
  h.authorization = `Bearer ${env[lane.key_env[0]]}`;
  if (lane.key_env.length > 1) h.authorization = `Bearer ${env.CF_AI_TOKEN}`;
  void token;
  return { ok: true, headers: h };
}

export function laneStatus(env) {
  return FREE_LANES.map((l) => {
    const k = laneKey(l, env || {});
    return {
      id: l.id,
      label: l.label,
      model: l.model,
      key_env: l.key_env,
      notes: l.notes,
      ready: k.ok && Boolean(renderBase(l, env || {})),
      missing: k.ok ? [] : k.missing,
    };
  });
}

async function callLane(lane, prompt, env, opts, modelId) {
  const model = modelId || lane.model;
  const url = renderBase(lane, env);
  const key = laneKey(lane, env);
  if (!url || !key.ok) return { lane: lane.id, skipped: true, missing: key.missing ?? ['account_id'] };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...key.headers, 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: prompt },
        ],
        max_tokens: opts.maxTokens,
        temperature: 0,
      }),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok || !body) return { lane: lane.id, model: modelId, http: res.status, error: 'non_ok_or_non_json', snippet: text.slice(0, 200), ms: Date.now() - started };
    const msg = body?.choices?.[0]?.message ?? null;
    // Reasoning models (gpt-oss, deepseek-r1) put the visible answer in `reasoning`
    // when the token budget is spent on the hidden trace, so accept either field.
    const out =
      (msg && typeof msg.content === 'string' && msg.content.trim()) ||
      (msg && typeof msg.reasoning === 'string' && msg.reasoning.trim()) ||
      (typeof body?.result?.response === 'string' && body.result.response) ||
      (typeof body?.response === 'string' && body.response) ||
      null;
    if (typeof out !== 'string' || !out.length) return { lane: lane.id, model: modelId, http: res.status, error: 'empty_completion', snippet: JSON.stringify(body).slice(0, 200), ms: Date.now() - started };
    return { lane: lane.id, http: res.status, ms: Date.now() - started, text: out, model: body.model ?? model };
  } catch (err) {
    return { lane: lane.id, error: String(err && err.message ? err.message : err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the free chain. Returns the first answer, plus every attempt made.
 * Never throws — an empty chain is a normal, reportable outcome.
 */
export async function freeInference(prompt, env, opts = {}) {
  const o = {
    system: opts.system ?? 'You are a concise, factual assistant. Answer plainly and never invent data.',
    maxTokens: Number(opts.max_tokens ?? opts.maxTokens ?? 1200),
    timeoutMs: Number(opts.timeout_ms ?? opts.timeoutMs ?? 20000),
    lanes: opts.lanes ?? null,
  };
  if (!prompt || typeof prompt !== 'string') {
    return { ok: false, error: 'prompt_required', trails: [] };
  }
  const chain = FREE_LANES.filter((l) => !o.lanes || o.lanes.includes(l.id));
  const trails = [];
  for (const lane of chain) {
    const candidates = lane.models && lane.models.length ? lane.models : [lane.model];
    for (const modelId of candidates) {
      const r = await callLane(lane, prompt, env || {}, o, modelId);
      trails.push(r);
      if (r.text) {
        return { ok: true, lane: r.lane, model: r.model, ms: r.ms, text: r.text, trails };
      }
      if (r.skipped) break;
    }
  }
  return { ok: false, error: 'all_lanes_failed', trails };
}
