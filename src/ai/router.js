// AI Provider Router — free-first multi-provider routing.
// ---------------------------------------------------------------------------
// Providers (all with a genuine free tier; verified against vendor docs):
//   workersai  Cloudflare Workers AI  — keyless on deploy (10,000 Neurons/day)
//   gemini     Google AI Studio       — free tier, per-model/project limits
//   groq       Groq                   — free tier
//   cerebras   Cerebras               — Free Trial (gpt-oss-120b 5 RPM/30K TPM/1M TPD)
//   mistral    Mistral La Plateforme  — Experiment (free) ~1 req/s
//   openrouter OpenRouter             — :free models
//   deterministic  rule-based, always available at zero cost
//
// Guarantees:
//  * uniform interface: complete({role, system, user, schema, json, maxTokens})
//  * 429 / 503 / timeout → backoff → key rotation → provider failover → wait
//  * every call is logged; daily budgets enforced; paid calls gated
//  * no key ever leaves the server (read from env / .dev.vars only)

import { backoffMs, extractJson, sleep, truncate, utcDay, id as newId, nowIso } from '../util.js';
import { budgetGuard } from '../agent/guardrail.js';

// Workers AI の Neurons 単価（100万トークンあたり。出典: developers.cloudflare.com/workers-ai/platform/pricing）。
// 無料は1日 10,000 Neurons。Workers Paid では超過分が $0.011/1,000 Neurons で課金されるので、
// 日次の上限（WORKERS_AI_NEURON_CAP、既定 9,000）で止めて「無料枠の内側」から出ない。

/** Flatten every Workers AI / OpenAI-compatible completion shape to plain text. */
function aiText(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  const pick = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x && (x.text || x.content)) || '')).join('');
    return v.text || v.content || '';
  };
  return pick(data.response)
    || pick(data.result?.response)
    || pick(data.choices?.[0]?.message?.content)
    || pick(data.choices?.[0]?.text)
    || pick(data.result?.choices?.[0]?.message?.content)
    || pick(data.result?.choices?.[0]?.text)
    || pick(data.output_text)
    || pick(data.result?.output_text)
    || '';
}

const REASONING_MODEL = /(^|\/)(gemma|thinking|reasoning|deepseek-r1|magistral|qwq)/i;

export const NEURON_RATES = {
  '@cf/openai/gpt-oss-120b': [31818, 68182],
  '@cf/zai-org/glm-4.7-flash': [5500, 36400],
  '@cf/meta/llama-4-scout-17b-16e-instruct': [24545, 77273],
};
export const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
/** 日本語は1文字≒1トークンとして多めに見積もる（安全側）。 */
export function estimateNeurons(model, inChars = 0, outChars = 0) {
  const r = NEURON_RATES[model] || [40000, 120000];
  return Math.ceil((inChars * r[0] + outChars * r[1]) / 1e6);
}
export const neuronCap = (env = {}) => Math.max(0, Number(env.WORKERS_AI_NEURON_CAP ?? 9000));

// 1時間あたりの Neurons 上限。無料枠(10,000/日)を24時間にならして使うための見張り。
// 既定 380 ≒ 9,120/日 で、画像読み取りやチャットの取り分を残す。
export const hourlyNeuronCap = (env = {}) => Math.max(0, Number(env.AI_HOURLY_NEURON_CAP ?? 380));

// 1ティックあたりに使ってよい「AIに聞く回数」を絞り、無料枠を一日中ならして使う。
// 使い切ったら決定的処理に切り替えて、エンジンは止めずに回す。
export const TICK_BUDGET_ROLES = new Set(['planner', 'executor', 'coder', 'optimizer', 'reason']);

// 同一プロンプトの結果を再利用する（AI呼び出しとNeurons消費は0）。
// 計画・最適化・実装は同じ入力が繰り返されるため効果が大きい。
// 鮮度が要る調査(researcher/reason)とユーザー起点(chat/vision)は対象外。
export const CACHE_ROLES = new Set(['planner', 'optimizer', 'executor', 'coder', 'summarizer', 'critic', 'verifier']);
export const cacheTtlMs = (env = {}) => Math.max(0, Number(env.AI_CACHE_TTL_MS ?? 6 * 3600e3));

export async function aiCacheKey({ role, system, user, json, maxTokens, temperature }) {
  const enc = new TextEncoder().encode([role, json ? 1 : 0, maxTokens, temperature, system || '', user || ''].join('\u0001'));
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Public, key-free metadata for the Setup screen (links + honest free-tier notes). */
export const PROVIDER_META = {
  workersai: {
    signup: 'https://developers.cloudflare.com/workers-ai/',
    free_note: 'デプロイ先のCloudflareバインディングで利用。無料枠 10,000 Neurons/日・APIキー不要',
  },
  gemini: {
    signup: 'https://aistudio.google.com/apikey',
    free_note: '無料枠あり（モデル・プロジェクト単位。RPDは太平洋時間0時リセット）',
  },
  groq: {
    signup: 'https://console.groq.com/keys',
    free_note: '無料枠あり（モデル別。実上限はアカウントのLimits画面で確認）',
  },
  cerebras: {
    signup: 'https://cloud.cerebras.ai/',
    free_note: 'Free Trial: gpt-oss-120b は 5 RPM / 30K uncached TPM / 100万 TPD',
  },
  mistral: {
    signup: 'https://console.mistral.ai/api-keys',
    free_note: 'Experiment（無料）枠: 約1リクエスト/秒',
  },
  openrouter: {
    signup: 'https://openrouter.ai/keys',
    free_note: ':free モデルあり（レート制限はアカウント依存）',
  },
};

export const PROVIDERS = {
  workersai: {
    kind: 'workers-ai',
    label: 'Cloudflare Workers AI',
    keyEnv: 'CLOUDFLARE_API_TOKEN',
    paid: false,
    models: [
      // quality: 1=軽量で十分 / 2=現代のMoEで十分 / 3=強い推論が要る。outN=出力Neurons/M（安い順に使う）。
      { id: '@cf/zai-org/glm-4.7-flash', tier: 'lite', ctx: 128000, quality: 2, outN: 36400, strengths: ['cheap', 'fast'] },
      { id: '@cf/google/gemma-4-26b-a4b-it', tier: 'fast', ctx: 128000, quality: 2, outN: 27273, strengths: ['reasoning', 'cheap'] },
      { id: '@cf/qwen/qwen3-30b-a3b-fp8', tier: 'fast', ctx: 128000, quality: 2, outN: 30475, strengths: ['reasoning', 'cheap'] },
      { id: '@cf/openai/gpt-oss-120b', tier: 'fast', ctx: 128000, quality: 3, outN: 68182, strengths: ['reasoning', 'json'] },
      { id: '@cf/meta/llama-4-scout-17b-16e-instruct', tier: 'fast', ctx: 128000, quality: 2, outN: 77273, strengths: ['vision'] },
    ],
  },
  gemini: {
    kind: 'gemini',
    label: 'Google Gemini',
    keyEnv: 'GEMINI_API_KEY',
    paid: false,
    base: 'https://generativelanguage.googleapis.com/v1beta/models',
    models: [
      // 2.5 系は新規ユーザーに開放されなくなった（404: "no longer available to new users"）。
      // 通常は /models からの自動取得が優先され、ここは取得失敗時の控え。
      { id: 'gemini-3.8-flash', tier: 'fast', ctx: 1000000, quality: 3, strengths: ['reasoning', 'long_context', 'json'] },
      { id: 'gemini-3.5-flash-lite', tier: 'lite', ctx: 1000000, quality: 2, strengths: ['cheap', 'fast'] },
    ],
  },
  groq: {
    kind: 'openai',
    label: 'Groq',
    keyEnv: 'GROQ_API_KEY',
    paid: false,
    base: 'https://api.groq.com/openai/v1/chat/completions',
    models: [
      { id: 'llama-3.3-70b-versatile', tier: 'fast', ctx: 128000, strengths: ['reasoning', 'json'] },
      { id: 'llama-3.1-8b-instant', tier: 'lite', ctx: 128000, strengths: ['cheap', 'fast'] },
    ],
  },
  cerebras: {
    kind: 'openai',
    label: 'Cerebras',
    keyEnv: 'CEREBRAS_API_KEY',
    paid: false,
    base: 'https://api.cerebras.ai/v1/chat/completions',
    models: [
      { id: 'gpt-oss-120b', tier: 'fast', ctx: 128000, strengths: ['reasoning', 'fast'] },
      { id: 'qwen-3.8-27b', tier: 'fast', ctx: 128000, strengths: ['reasoning'] },
    ],
  },
  mistral: {
    kind: 'openai',
    label: 'Mistral',
    keyEnv: 'MISTRAL_API_KEY',
    paid: false,
    base: 'https://api.mistral.ai/v1/chat/completions',
    models: [
      { id: 'mistral-small-latest', tier: 'fast', ctx: 128000, strengths: ['fast', 'json'] },
      { id: 'open-mistral-nemo', tier: 'lite', ctx: 128000, strengths: ['cheap'] },
    ],
  },
  openrouter: {
    kind: 'openai',
    label: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    paid: false,
    base: 'https://openrouter.ai/api/v1/chat/completions',
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', tier: 'fast', ctx: 128000, strengths: ['reasoning'] },
      { id: 'google/gemini-2.0-flash-exp:free', tier: 'fast', ctx: 1000000, strengths: ['long_context'] },
    ],
  },
};

export const DETERMINISTIC_PROVIDER = 'deterministic';

/**
 * Task-class routing. Spreading load across DIFFERENT providers is what actually
 * expands usable free capacity — each has its own independent daily allowance.
 */
export const ROLE_ROUTING = {
  planner: ['gemini', 'workersai', 'cerebras', 'groq', 'mistral', 'openrouter'],
  critic: ['groq', 'cerebras', 'workersai', 'gemini', 'mistral', 'openrouter'],
  verifier: ['gemini', 'workersai', 'cerebras', 'groq'],
  optimizer: ['cerebras', 'gemini', 'workersai', 'groq'],
  executor: ['workersai', 'groq', 'cerebras', 'mistral', 'gemini', 'openrouter'],
  researcher: ['gemini', 'openrouter', 'workersai', 'cerebras'],
  summarizer: ['groq', 'mistral', 'workersai', 'gemini'],
  coder: ['cerebras', 'workersai', 'gemini', 'groq', 'mistral'],
  chat: ['gemini', 'workersai', 'groq', 'cerebras', 'mistral', 'openrouter'],
};

/** 役割ごとの品質の下限。軽い仕事は安いモデル、難しい仕事は強いモデルに寄せる。 */
// モデル単位の冷却。プロバイダ全体を止めずに、壊れたモデルだけ避ける。
// 例: workersai の gemma が「empty completion」を返し続けても、同じプロバイダの
// qwen は生きているので、プロバイダ冷却では巻き添えになる。
// プロバイダのモデル一覧は頻繁に変わる（Groq は予告なくモデルを廃止する）。
// 静的なモデル表だけで回すと「キーは生きているのに 404 で一度も使われない」が起きるので、
// 起動時に各社の /models から実在するモデルを取得して使う。取得失敗時だけ静的表に戻す。
const MODEL_DISCOVERY = new Map();
const MODEL_DISCOVERY_TTL_MS = 12 * 3600e3;
const MODEL_LIST_URL = {
  groq: 'https://api.groq.com/openai/v1/models',
  cerebras: 'https://api.cerebras.ai/v1/models',
  mistral: 'https://api.mistral.ai/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
};
// チャットに使えないもの（音声・埋め込み・モデレーション等）は候補から外す。
const NON_CHAT_MODEL = /whisper|tts|guard|moderation|embed|rerank|ocr|dall|stable|sdxl|speech|playai|compound|orpheus|image/i;

const MODEL_COOLDOWN = new Map();
export const MODEL_COOLDOWN_MS = 45 * 60e3;

export const ROLE_MIN_QUALITY = {
  planner: 2, executor: 2, optimizer: 1, verifier: 1, critic: 1, summarizer: 1,
  coder: 2, chat: 2, researcher: 3, reason: 3,
};

/** 品質の下限を満たす中で、出力単価（outN）の安い順にモデルを並べる。 */
export function orderedModels(provider, role) {
  const models = PROVIDERS[provider]?.models || [];
  const need = ROLE_MIN_QUALITY[role] ?? 1;
  const byCost = (a, b) => Number(a.outN ?? 9e9) - Number(b.outN ?? 9e9);
  const fit = models.filter((m) => (m.quality ?? 1) >= need).sort(byCost);
  const rest = models.filter((m) => (m.quality ?? 1) < need).sort(byCost);
  return [...fit, ...rest];
}

export class AIRouter {
  constructor(store, env) {
    this.store = store;
    this.env = env || {};
    this.keyCursor = {};
  }

  /** API keys may be supplied as KEY, KEY_2 ... KEY_5 for rotation. */
  keysFor(provider) {
    const base = PROVIDERS[provider].keyEnv;
    const keys = [];
    for (const suffix of ['', '_2', '_3', '_4', '_5']) {
      const v = this.env[base + suffix];
      if (v) keys.push(v);
    }
    return keys;
  }

  /** Workers AI needs no key on Cloudflare (binding) — only a token off-platform. */
  available(provider) {
    if (provider === 'workersai') {
      return !!(this.env.AI || (this.env.CLOUDFLARE_API_TOKEN && this.env.CLOUDFLARE_ACCOUNT_ID));
    }
    return this.keysFor(provider).length > 0;
  }

  nextKey(provider) {
    const keys = this.keysFor(provider);
    if (!keys.length) return null;
    const i = (this.keyCursor[provider] || 0) % keys.length;
    this.keyCursor[provider] = i + 1;
    return keys[i];
  }

  rotateKey(provider) {
    const n = this.keysFor(provider).length;
    if (n > 1) this.keyCursor[provider] = ((this.keyCursor[provider] || 0) + 1) % n;
    return n > 1;
  }

  availableProviders() {
    return Object.keys(PROVIDERS).filter((p) => this.available(p));
  }

  /** Human-readable status for the Setup/Settings screen. */
  async status() {
    const day = utcDay();
    const usage = await this.store.all(
      `SELECT provider, COUNT(*) AS calls, SUM(ok) AS ok_calls
         FROM ai_usage WHERE day=? GROUP BY provider`, day);
    const state = await this.store.all('SELECT * FROM ai_provider_state');
    const stateMap = Object.fromEntries(state.map((s) => [s.provider, s]));
    return {
      configured: Object.entries(PROVIDERS).map(([name, p]) => ({
        provider: name,
        label: p.label,
        key_present: this.available(name),
        key_env: p.keyEnv,
        keyless: name === 'workersai',
        keys_supplied: this.keysFor(name).length,
        signup: PROVIDER_META[name]?.signup || null,
        free_note: PROVIDER_META[name]?.free_note || null,
        models: p.models.map((m) => m.id),
        state: stateMap[name]?.status || 'unknown',
        cooldown_until: stateMap[name]?.cooldown_until || null,
        failures: stateMap[name]?.consecutive_failures || 0,
      })),
      providers_configured: this.availableProviders(),
      provider_count: this.availableProviders().length,
      free_capacity_note: '異なるプロバイダを併用すると、それぞれ独立した無料枠を合算できます（自動フォールバック）。',
      fallback_available: true,
      fallback_note: 'キー未設定でも決定的フォールバックで計画・検証・ランキングは動作します',
      today: { day, usage },
        neurons: { today: await this.neuronsToday(), cap: neuronCap(this.env), free_per_day: 10000,
          hour_used: await this.neuronsThisHour(), hour_cap: hourlyNeuronCap(this.env) },
      budget: {
        daily_call_budget: Number(this.env.AI_DAILY_CALL_BUDGET || 300),
        used: usage.reduce((s, u) => s + (u.ok_calls || 0), 0),
      },
    };
  }

  async providerState(provider) {
    let s = await this.store.first('SELECT * FROM ai_provider_state WHERE provider=?', provider);
    if (!s) {
      s = { provider, enabled: 1, status: 'unknown', cooldown_until: null, consecutive_failures: 0, last_error: null };
      await this.store.insert('ai_provider_state', { ...s, updated_at: nowIso() });
    }
    return s;
  }

  async markFailure(provider, err, { rateLimited = false } = {}) {
    const s = await this.providerState(provider);
    const failures = (s.consecutive_failures || 0) + 1;
    const cooldownMs = rateLimited ? Math.min(15 * 60e3, 60e3 * failures) : Math.min(5 * 60e3, 15e3 * failures);
    await this.store.run(
      `UPDATE ai_provider_state SET status=?, cooldown_until=?, consecutive_failures=?, last_error=?, updated_at=? WHERE provider=?`,
      rateLimited ? 'rate_limited' : 'error',
      new Date(Date.now() + cooldownMs).toISOString(),
      failures, truncate(String(err), 300), nowIso(), provider);
  }

  async markSuccess(provider) {
    await this.store.run(
      `UPDATE ai_provider_state SET status='ok', cooldown_until=NULL, consecutive_failures=0, last_error=NULL, updated_at=? WHERE provider=?`,
      nowIso(), provider);
  }

  async logged(entry) {
    await this.store.insert('ai_usage', {
      id: newId('aiu'), day: utcDay(), created_at: nowIso(), ok: entry.ok ? 1 : 0, ...entry,
    });
  }

  /** 今日 Workers AI に使った推定 Neurons。 */
  async neuronsToday() {
    const r = await this.store.first(`SELECT COALESCE(SUM(neurons),0) AS n FROM ai_usage WHERE day=? AND provider='workersai'`, utcDay()).catch(() => null);
    return Number(r?.n || 0);
  }

  async workersAiOverCap(extra = 0) {
    return (await this.neuronsToday()) + extra >= neuronCap(this.env);
  }

  /** 直近1時間に Workers AI で使った推定 Neurons（無料枠をならすための見張り）。 */
  async neuronsThisHour() {
    const since = new Date(Date.now() - 3600e3).toISOString();
    const r = await this.store.first(
      `SELECT COALESCE(SUM(neurons),0) AS n FROM ai_usage WHERE provider='workersai' AND created_at>=?`, since).catch(() => null);
    return Number(r?.n || 0);
  }

  async workersAiOverHourCap(extra = 0) {
    const cap = hourlyNeuronCap(this.env);
    if (cap <= 0) return false;
    return (await this.neuronsThisHour()) + extra >= cap;
  }

  /** ティックのAI予算を開始/終了する。 */
  beginTick(n) { this.tickBudget = { left: Math.max(0, Number(n || 0)) }; return this.tickBudget; }
  endTick() { this.tickBudget = null; }


  /**
   * 画像を読む。Workers AI（Llama 4 Scout・無料枠内）→ Gemini（キーがあれば）の順。
   * 読めないときは ok:false と理由を返す（推測で中身を作らない）。
   */
  async vision({ prompt, images = [], maxTokens = 600 }) {
    const imgs = images.slice(0, 3);
    if (!imgs.length) return { ok: false, reason: 'no_image' };
    const t0 = Date.now();
    // 画像1枚 ≈ 1,600 トークンとして見積もる（安全側）。
    const inChars = prompt.length + imgs.length * 1600;
    if (this.env.AI && typeof this.env.AI.run === 'function') {
      const est = estimateNeurons(VISION_MODEL, inChars, maxTokens);
      if (await this.workersAiOverCap(est)) {
        return { ok: false, reason: 'neuron_cap', note: `今日の無料枠（${neuronCap(this.env).toLocaleString('ja-JP')} Neurons）の上限に近いため、画像の読み取りは明日に回します。` };
      }
      try {
        const data = await this.env.AI.run(VISION_MODEL, {
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...imgs.map((u) => ({ type: 'image_url', image_url: { url: u } }))] }],
          max_tokens: maxTokens, temperature: 0.2,
        });
        const text = typeof data === 'string' ? data : (data?.response || data?.result?.response || data?.choices?.[0]?.message?.content || '');
        await this.logged({ provider: 'workersai', model: VISION_MODEL, role: 'vision', ok: text ? 1 : 0, status_code: 200,
          latency_ms: Date.now() - t0, prompt_chars: inChars, output_chars: String(text).length,
          neurons: estimateNeurons(VISION_MODEL, inChars, String(text).length) });
        if (text) return { ok: true, text: String(text).trim(), provider: 'workersai', model: VISION_MODEL };
      } catch (e) {
        await this.logged({ provider: 'workersai', model: VISION_MODEL, role: 'vision', ok: 0, status_code: e.status || 0,
          error: truncate(String(e.message || e), 200), latency_ms: Date.now() - t0, prompt_chars: inChars, output_chars: 0, neurons: 0 });
      }
    }
    const key = this.nextKey('gemini');
    if (key) {
      try {
        const parts = [{ text: prompt }, ...imgs.map((u) => {
          const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(u) || [];
          return { inline_data: { mime_type: m[1] || 'image/jpeg', data: m[2] || '' } };
        })];
        const res = await fetch(`${PROVIDERS.gemini.base}/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 } }),
        });
        const data = await res.json().catch(() => ({}));
        const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        await this.logged({ provider: 'gemini', model: 'gemini-2.5-flash', role: 'vision', ok: text ? 1 : 0, status_code: res.status,
          latency_ms: Date.now() - t0, prompt_chars: inChars, output_chars: text.length });
        if (text) return { ok: true, text: text.trim(), provider: 'gemini', model: 'gemini-2.5-flash' };
      } catch { /* fall through */ }
    }
    return { ok: false, reason: 'no_vision_provider', note: '画像を読めるAIにつながっていません（Workers AI の結合か GEMINI_API_KEY が要ります）。' };
  }

  async budgetExceeded() {
    // 判定は guardrail.budgetGuard に一本化する（純関数のまま誰も呼んでいなかった）。
    // used=今日の成功した呼び出し数, cap=AI_DAILY_CALL_BUDGET。cap を 0 にすれば推論は止まる。
    const cap = Number(this.env.AI_DAILY_CALL_BUDGET || 300);
    const r = await this.store.first(
      `SELECT COUNT(*) AS c FROM ai_usage WHERE day=? AND ok=1`, utcDay());
    const g = budgetGuard({ used: Number((r && r.c) || 0), cap });
    this.lastBudget = g;
    if (!g.allow) console.log('budgetGuard: 推論を止めます', JSON.stringify(g));
    return !g.allow;
  }

  /** Main entry point. Always resolves — never throws into the engine loop. */
  // 思考過程を本文に垂れ流す系統のモデル（回答用途では最後に回す）
  // 内部の思考過程・下書きメモを回答本文から取り除く。小型モデルほど漏らす。
  cleanReply(raw) {
    let t = String(raw == null ? '' : raw);
    t = t.replace(/```(?:thinking|reasoning|analysis)[\s\S]*?```/gi, '');
    const TRACE = /(user's question|user asks|user is asking|agent persona|persona:|core values|constraints:|drafting|thinking|analysis:|internal notes|drafting the response|draft the response|analy[sz]e the request|the user is asking|acknowledge the query|state the status|looking at my|pre-existing data|i do not have|response components|internal notes|long-term memory|personality:|^rules:|final response)/i;
    const lines = t.split(/\r?\n/);
    const kept = lines.filter((ln) => {
      const x = ln.trim();
      if (!x) return true;
      const bullet = /^([*\-\u2022]|\d+[.)]|#{1,6}\s)/.test(x);
      if (bullet && TRACE.test(x)) return false;
      if (/^#{0,6}\s*(thinking|reasoning|internal notes|\u601d\u8003|\u5185\u90e8\u30e1\u30e2|\u4e0b\u66f8\u304d)\b/i.test(x)) return false;
      return true;
    });
    t = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    // ほぼ全部が思考メモだった場合は空にして、次のモデルに回す
    const traceHits = lines.filter((l) => TRACE.test(l)).length;
    const bullets = lines.filter((l) => /^\s*[*\-\u2022]/.test(l)).length;
    if (lines.length >= 4 && (traceHits >= 2 || (bullets / lines.length > 0.6 && traceHits >= 1)) && t.length < 200) return '';
    // 先頭から思考メモが始まっている＝回答ではなく内部メモ。丸ごと捨てて次のモデルへ。
    const firstLine = (lines.find((l) => l.trim()) || '').trim();
    if (/^([*\-\u2022]|#{1,6}\s)/.test(firstLine) && TRACE.test(firstLine)) return '';
    const bulletRatio = lines.length ? bullets / lines.length : 0;
    if (bulletRatio > 0.7 && traceHits >= 1 && t.length < 600) return '';
    return t;
  }

  // 反復ループなど、文章として壊れている出力を検出する
  looksDegenerate(text) {
    const t = String(text == null ? '' : text);
    if (t.length < 40) return false;
    const body = t.replace(/\s/g, '');
    if (new Set(body).size / (body.length || 1) < 0.18) return true;
    for (let i = 0; i + 12 <= Math.min(t.length, 400); i += 1) {
      const g = t.slice(i, i + 12);
      let n = 0; let q = t.indexOf(g);
      while (q !== -1 && n < 8) { n += 1; q = t.indexOf(g, q + 1); }
      if (n >= 7) return true;
    }
    return false;
  }

  async complete({
    role = 'chat', system = '', user = '', messages = null,
    json = false, schema = null, maxTokens = 1024, temperature = 0.4,
    prefer = null, deterministic = null,
  }) {
    // 0) まずキャッシュ。同一の問い合わせならAIを呼ばずNeuronsも使わない。
    const cacheable = CACHE_ROLES.has(role) && cacheTtlMs(this.env) > 0;
    let cacheKey = null;
    if (cacheable) {
      try {
        cacheKey = await aiCacheKey({ role, system, user, json, maxTokens, temperature });
        const row = await this.store.first('SELECT response, provider, model, created_at FROM ai_cache WHERE key=?', cacheKey);
        if (row && (Date.now() - new Date(row.created_at).getTime()) < cacheTtlMs(this.env)) {
          await this.store.run('UPDATE ai_cache SET hits=COALESCE(hits,0)+1, last_hit_at=? WHERE key=?', nowIso(), cacheKey).catch(() => {});
          const txt = row.response || '';
          let parsed = null;
          if (json) parsed = schema ? coerceSchema(extractJson(txt), schema) : extractJson(txt);
          if (txt) return { ok: true, text: txt, json: parsed, provider: row.provider, model: row.model, cached: true, attempts: 1,
            note: '同じ問い合わせの結果を再利用しました（AI呼び出し・Neurons消費は0）。' };
        }
      } catch { cacheKey = null; }
    }
    // ティックのAI予算を使い切っていたら、AIには聞かず決定的処理で続行する。
    if (this.tickBudget && TICK_BUDGET_ROLES.has(role) && Number(this.tickBudget.left) <= 0) {
      const d = this.runDeterministic({ role, schema, deterministic, user });
      return { ...d, ok: true, fallback: true, degraded: true, reason: 'ai_tick_budget', errors: [],
        note: 'このティックのAI予算を使い切ったため、決定的処理で続行します（止めません）。' };
    }
    // 無料枠を一日中ならす：直近1時間の Neurons 上限に達したら、次の時間までAIを休み
    // 決定的処理で続行する（エンジンは止めない）。チャット等のユーザー起点は対象外。
    // 無料の外部キー（Groq / Gemini 等）が使えるときは、Workers AI の時間割り上限で
    // 全体を止めない。「キーを足したのに回転数が増えない」を防ぐ。
    const externalReady = this.availableProviders().some((p) => p !== 'workersai');
    if (!externalReady && TICK_BUDGET_ROLES.has(role)
      && await this.workersAiOverHourCap(estimateNeurons(PROVIDERS.workersai.models[0].id, (system + user).length, maxTokens))) {
      const d = this.runDeterministic({ role, schema, deterministic, user });
      return { ...d, ok: true, fallback: true, degraded: true, reason: 'ai_hour_budget', errors: [],
        note: 'この1時間のAI予算を使い切ったため、決定的処理で続行します（止めません）。次の時間に自動で再開します。' };
    }
    if (await this.budgetExceeded()) {
      const wait = new Date(Date.now() + 15 * 60e3).toISOString();
      const d = this.runDeterministic({ role, schema, deterministic, user });
      return { ...d, ok: true, fallback: true, reason: 'daily_budget_exhausted', wait_until: wait,
        note: `本日のAI呼び出し上限に達しました。${wait} 以降に再開します（進捗は保存済み）。` };
    }

    const rolePref = prefer || (await this.rolePrefFromSettings(role));
    const order = this.routingOrder(role, rolePref);
    const live = order.filter((p) => PROVIDERS[p] && this.available(p));
    const errors = [];

    for (const provider of live) {
      const st = await this.providerState(provider);
      if (!st.enabled) continue;
      if (st.cooldown_until && new Date(st.cooldown_until).getTime() > Date.now()) {
        errors.push(`${provider}: cooldown until ${st.cooldown_until}`);
        continue;
      }
      // 無料枠の外に出ない：Workers AI は日次の Neurons 上限で止める。
      if (provider === 'workersai' && await this.workersAiOverCap(estimateNeurons(PROVIDERS.workersai.models[0].id, (system + user).length, maxTokens))) {
        errors.push('workersai: neuron_cap');
        continue;
      }
      const cands = await this.modelsFor(provider, role);
      const ordered = [...cands.filter((m) => !REASONING_MODEL.test(m.id)),
        ...cands.filter((m) => REASONING_MODEL.test(m.id))];
      for (const model of ordered.slice(0, 4)) {
        const mcUntil = MODEL_COOLDOWN.get(`${provider}/${model.id}`);
        if (mcUntil && mcUntil > Date.now()) { errors.push(`${provider}/${model.id}: model_cooldown`); continue; }
        for (let attempt = 1; attempt <= 2; attempt++) {
          const t0 = Date.now();
          try {
            const out = await this.callOne({ provider, model: model.id, system, user, messages, json, maxTokens, temperature });
            const cleaned = this.cleanReply(out.text);
            if (this.looksDegenerate(cleaned) || (String(out.text || '').trim().length > 120 && cleaned.length < 20)) {
              MODEL_COOLDOWN.set(`${provider}/${model.id}`, Date.now() + MODEL_COOLDOWN_MS);
              await this.logged({ provider, model: model.id, role, ok: 0, status_code: 200,
                latency_ms: Date.now() - t0, prompt_chars: (system + user).length, output_chars: String(out.text || '').length,
                error: 'degenerate_output' });
              errors.push(`${provider}/${model.id}: degenerate_output`);
              break;
            }
            out.text = cleaned;
            await this.logged({ provider, model: model.id, role, ok: 1, status_code: 200,
              latency_ms: Date.now() - t0, prompt_chars: (system + user).length, output_chars: out.text.length,
              ...(provider === 'workersai' ? { neurons: estimateNeurons(model.id, (system + user).length, out.text.length) } : {}) });
            await this.markSuccess(provider);
            let parsed = null;
            if (json) parsed = schema ? coerceSchema(extractJson(out.text), schema) : extractJson(out.text);
            if (cacheable && cacheKey) {
              await this.store.run('DELETE FROM ai_cache WHERE key=?', cacheKey).catch(() => {});
              await this.store.insert('ai_cache', { key: cacheKey, role, response: out.text, provider, model: model.id, created_at: nowIso(), hits: 0 }).catch(() => {});
            }
            if (this.tickBudget && TICK_BUDGET_ROLES.has(role)) this.tickBudget.left = Math.max(0, Number(this.tickBudget.left) - 1);
            return { ok: true, text: out.text, json: parsed, provider, model: model.id, attempts: attempt };
          } catch (e) {
            const code = e.status || 0;
            const rateLimited = code === 429 || code === 503;
            // 空応答はモデル固有の不具合（キーやプロバイダのせいではない）。このモデルだけ休ませる。
            // モデル廃止（404）なら一覧を捨てて次回に取り直す。キー自体は生きているので
            // プロバイダを冷却しない（1モデルの廃止で経路ごと失うのを防ぐ）。
            if (/does not exist|model_not_found|no such model|unknown model|no longer available|is not found for API version|not supported for/i.test(String(e.message || ''))) {
              MODEL_DISCOVERY.delete(provider);
              MODEL_COOLDOWN.set(`${provider}/${model.id}`, Date.now() + MODEL_COOLDOWN_MS);
            }
            if (/empty (completion|response|output)|no content/i.test(String(e.message || e))) {
              MODEL_COOLDOWN.set(`${provider}/${model.id}`, Date.now() + MODEL_COOLDOWN_MS);
            }
            await this.logged({ provider, model: model.id, role, ok: 0, status_code: code,
              error: truncate(String(e.message || e), 200), latency_ms: Date.now() - t0,
              prompt_chars: (system + user).length, output_chars: 0 });
            // A 429 with a spare key rotates keys before giving up on the provider.
            if (rateLimited && this.rotateKey(provider)) {
              errors.push(`${provider}/${model.id}: ${code} (key rotated)`);
              continue;
            }
            if (code && code >= 400 && code < 500 && !rateLimited) { errors.push(`${provider}/${model.id}: ${code}`); break; }
            if (attempt < 2) await sleep(backoffMs(attempt));
            else { await this.markFailure(provider, e, { rateLimited }); errors.push(`${provider}/${model.id}: ${code || 'err'}`); }
          }
        }
      }
    }

    const d = this.runDeterministic({ role, schema, deterministic, user });
    return { ...d, ok: true, fallback: true, degraded: true,
      reason: live.length ? 'all_providers_failed' : 'no_provider_key',
      errors, wait_until: new Date(Date.now() + 5 * 60e3).toISOString(),
      note: live.length
        ? '全プロバイダが失敗したため決定的処理に切り替えました（進捗は保存済み）。'
        : 'AIキー未設定のため決定的処理で動作しています。設定画面でキーを登録すると推論品質が上がります。' };
  }

  // 実在するモデル一覧（12時間キャッシュ）。取れなければ空配列＝静的表にフォールバック。
  async discoveredModels(provider) {
    const cached = MODEL_DISCOVERY.get(provider);
    if (cached && Date.now() - cached.at < MODEL_DISCOVERY_TTL_MS) return cached.models;
    const models = await this.fetchModelList(provider);
    if (models && models.length) { MODEL_DISCOVERY.set(provider, { at: Date.now(), models }); return models; }
    return cached ? cached.models : [];
  }

  async fetchModelList(provider) {
    const url = MODEL_LIST_URL[provider];
    if (!url) return null;
    const key = this.keysFor(provider)[0];
    if (!key) return null;
    try {
      const headers = { accept: 'application/json' };
      if (provider === 'gemini') headers['x-goog-api-key'] = key;
      else headers.authorization = `Bearer ${key}`;
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      const body = await res.json();
      const raw = Array.isArray(body && body.data) ? body.data.map((m) => m && m.id)
        : Array.isArray(body && body.models) ? body.models.map((m) => String((m && m.name) || '').replace(/^models\//, ''))
        : [];
      const ids = [...new Set(raw.filter((id) => id && !NON_CHAT_MODEL.test(id)))];
      if (!ids.length) return null;
      const known = new Map((PROVIDERS[provider].models || []).map((m) => [m.id, m]));
      // 既知のモデルを優先し、次に API の並び順。未知の新モデルも拾える。
      // 並び順はプロバイダの返却順をそのまま使う（廃止済みモデルを先頭に固定しないため）。
      return ids.map((id, i) => ({
        id, order: i, known: known.has(id),
        tier: known.get(id)?.tier || 'fast',
        quality: known.get(id)?.quality ?? 2,
        strengths: known.get(id)?.strengths || ['discovered'],
        discovered: true,
      })).sort((a, b) => a.order - b.order);
    } catch { return null; }
  }

  async modelsFor(provider, role) {
    if (provider === 'workersai' || !MODEL_LIST_URL[provider]) return orderedModels(provider, role);
    const live = await this.discoveredModels(provider);
    if (!live.length) return orderedModels(provider, role);
    const need = ROLE_MIN_QUALITY[role] ?? 1;
    const fit = live.filter((m) => (m.quality ?? 2) >= need);
    const rest = live.filter((m) => (m.quality ?? 2) < need);
    return [...fit, ...rest];
  }

  // 診断用: 各社から実際に取得できているモデル一覧
  async discoveredForAll() {
    const out = {};
    for (const p of this.availableProviders()) {
      out[p] = p === 'workersai' ? (PROVIDERS.workersai.models || []).map((m) => m.id) : await this.discoveredModels(p);
    }
    return out;
  }

  // 役割ごとの優先提供元（設定 ai:model_roles の JSON）。無ければ null。
  async rolePrefFromSettings(role) {
    try {
      const row = await this.store.first("SELECT value FROM settings WHERE key='ai:model_roles'");
      const raw = row && (row.value !== undefined ? row.value : row['value']);
      const map = raw ? JSON.parse(raw) : null;
      const v = map && map[role];
      return typeof v === 'string' && v ? v : null;
    } catch { return null; }
  }

  routingOrder(role, prefer) {
    if (prefer && prefer.length) return [...prefer, ...Object.keys(PROVIDERS).filter((p) => !prefer.includes(p))];
    const base = Object.keys(PROVIDERS);
    // 無料の外部キー（Groq / Gemini 等）が入っているときは、そちらを先に使う。
    // 理由: ①Workers AI の Neurons を温存できる ②外部キーが実際に呼ばれるので
    // キーの生死を実測で確認できる（入れっぱなしで使われない、を防ぐ）
    // ③1社が死んでも次の社へ自動で落ちる。Workers AI は最後の受け皿として残す。
    const external = this.availableProviders().filter((p) => p !== 'workersai');
    if (!external.length) return base;
    const ext = base.filter((p) => external.includes(p));
    const rest = base.filter((p) => !ext.includes(p));
    return [...ext, ...rest];
  }

  async callOne({ provider, model, system, user, messages, json, maxTokens, temperature }) {
    const cfg = PROVIDERS[provider];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const msgs = messages || [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ];

      if (cfg.kind === 'workers-ai') {
        return await this.callWorkersAI({ provider, cfg, model, msgs, json, maxTokens, temperature });
      }

      const key = this.nextKey(provider);
      let url; let body; const headers = { 'content-type': 'application/json' };
      if (cfg.kind === 'gemini') {
        url = `${cfg.base}/${model}:generateContent?key=${encodeURIComponent(key)}`;
        body = {
          contents: msgs.filter((m) => m.role !== 'system').map((m) => ({ role: 'user', parts: [{ text: m.content }] })),
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
        };
      } else {
        url = cfg.base;
        headers.authorization = `Bearer ${key}`;
        if (provider === 'openrouter') { headers['http-referer'] = 'https://wealth-agent.local'; headers['x-title'] = 'Wealth Agent'; }
        body = { model, messages: msgs, temperature, max_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}) };
      }
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${truncate(await res.text().catch(() => ''), 300)}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const text = cfg.kind === 'gemini'
        ? (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('')
        : (data?.choices?.[0]?.message?.content || '');
      if (!text) throw new Error('empty completion');
      return { text };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Workers AI: use the platform binding when deployed, REST when off-platform. */
  async callWorkersAI({ cfg, model, msgs, json, maxTokens, temperature }) {
    const opts = { messages: msgs, max_tokens: maxTokens, temperature, ...(json ? { response_format: { type: 'json_object' } } : {}) };
    if (this.env.AI && typeof this.env.AI.run === 'function') {
      const data = await this.env.AI.run(model, opts);
      const text = aiText(data);
      if (!text) throw new Error('empty completion');
      return { text };
    }
    const account = this.env.CLOUDFLARE_ACCOUNT_ID;
    const token = this.env.CLOUDFLARE_API_TOKEN;
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${truncate(await res.text().catch(() => ''), 300)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = aiText(data?.result ?? data);
    if (!text) throw new Error('empty completion');
    return { text };
  }

  /**
   * The deterministic brain. Not an LLM: rule-based decomposition, scoring and
   * verification. It keeps the loop alive at zero cost and never fabricates.
   */
  runDeterministic({ role, schema, deterministic, user }) {
    const text = deterministic ? deterministic({ role, schema, user }) : deterministicDefault({ role, schema, user });
    let parsed = null;
    if (schema) parsed = coerceSchema(typeof text === 'string' ? extractJson(text) : text, schema);
    return { text: typeof text === 'string' ? text : JSON.stringify(text), json: parsed, provider: DETERMINISTIC_PROVIDER, model: 'rules-v1', attempts: 1 };
  }
}

/** Fill missing schema keys with null so downstream code never sees undefined. */
export function coerceSchema(obj, schema) {
  const out = {};
  for (const k of schema) {
    out[k] = obj && Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null;
  }
  return out;
}

function deterministicDefault({ role }) {
  return `[deterministic:${role}] AIキーが未設定のため、ルールベースで処理しました。`;
}
