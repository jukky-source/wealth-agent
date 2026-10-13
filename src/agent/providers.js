// Free / zero-cost AI provider pool.
//
// Design rule: this agent must run with ZERO paid inference. Every provider
// below has a documented permanent free tier; the pool is chosen so that the
// independent free quotas add up (one account per provider, never multi-account
// evasion — that violates provider terms).
//
// The deterministic engine already answers every command without any key.
// Keys only upgrade the *quality* of free-form reasoning, so a missing key is
// never an error — it is just one fewer lane in the pool.

import { nowIso } from '../util.js';

// Env is injected by the worker (globalThis.__WA_ENV) or read from process.env
// locally, so the pool can report its own status without threading env around.
function defaultEnv() {
  if (globalThis.__WA_ENV) return globalThis.__WA_ENV;
  if (typeof process !== 'undefined' && process.env) return process.env;
  return {};
}

/** Model reasoning "shapes" we route by. */
export const TASKS = ['fast', 'code', 'long', 'vision', 'reason'];

/**
 * Registry. `limits` are per-project free-tier numbers gathered from each
 * vendor's own docs (2026-10). Providers change them without notice, so the
 * UI always prints the source URL next to the number.
 */
export const FREE_PROVIDERS = [
  {
    id: 'gemini',
    label: 'Google AI Studio (Gemini)',
    env: ['GEMINI_API_KEY'],
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    shape: 'openai',
    free: true,
    models: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'],
    limits: { rpm: 15, rpd: 1500, note: 'Flash 級は 15 RPM / 1,500 RPD。Pro は 5 RPM / 50 RPD。' },
    strengths: ['long', 'vision', 'reason', 'fast'],
    caveat: '無料枠の入力は Google の製品改善に使われ得る（学習させたくなければ有料枠）。',
    source: 'https://ai.google.dev/gemini-api/docs/rate-limits',
  },
  {
    id: 'groq',
    label: 'Groq',
    env: ['GROQ_API_KEY'],
    base: 'https://api.groq.com/openai/v1',
    shape: 'openai',
    free: true,
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    limits: { rpm: 30, rpd: 1000, tpm: 8000, note: 'モデル別。旧 Llama 系は終了し gpt-oss / Qwen 系に。' },
    strengths: ['fast', 'code'],
    caveat: '速度が最大の武器（LPU）。長文はトークン上限に当たりやすい。',
    source: 'https://console.groq.com/docs/rate-limits',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    env: ['CEREBRAS_API_KEY'],
    base: 'https://api.cerebras.ai/v1',
    shape: 'openai',
    free: true,
    models: ['gpt-oss-120b', 'llama-4-scout-17b-16e-instruct', 'qwen-3-32b'],
    limits: { rpm: 5, tpm: 30000, tpd: 1000000, note: 'Free Trial: 5 RPM / 30K 非キャッシュ TPM / 100万 TPD。' },
    strengths: ['fast', 'code'],
    caveat: 'TPD が大きいので「1日に大量に回す」用途の主戦力。',
    source: 'https://inference-docs.cerebras.ai/support/rate-limits',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    env: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    base: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run',
    shape: 'cloudflare',
    free: true,
    models: ['@cf/openai/gpt-oss-120b', '@cf/qwen/qwen2.5-coder-32b-instruct', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/zai-org/glm-4.7-flash'],
    limits: { neurons_per_day: 10000, note: '10,000 Neurons/日（無料・有料プラン共通）。' },
    strengths: ['code', 'vision', 'reason'],
    caveat: '本番デプロイ済みならバインディング経由でキー不要。Neuron はモデル別に重み付けされる。',
    source: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (:free モデル)',
    env: ['OPENROUTER_API_KEY'],
    base: 'https://openrouter.ai/api/v1',
    shape: 'openai',
    free: true,
    models: ['<provider>/<model>:free'],
    limits: { rpm: 20, rpd: 50, note: '無料モデルは 20 RPM / 50 RPD。$10 以上の購入履歴で 1,000 RPD に上がる。' },
    strengths: ['reason', 'long'],
    caveat: '複数社の無料モデルを 1 本の API で試せる。無料モデルは提供元が入れ替わる。',
    source: 'https://openrouter.ai/docs/api-reference/limits',
  },
  {
    id: 'mistral',
    label: 'Mistral (Experiment 枠)',
    env: ['MISTRAL_API_KEY'],
    base: 'https://api.mistral.ai/v1',
    shape: 'openai',
    free: true,
    models: ['mistral-small-latest', 'open-mistral-nemo', 'codestral-latest'],
    limits: { rps: 1, note: 'Experiment 枠 約 1 req/sec。' },
    strengths: ['fast', 'code'],
    caveat: '無料枠の入力は学習に使われ得る（opt-out 可）。',
    source: 'https://docs.mistral.ai/deployment/laplateforme/tier/',
  },
  {
    id: 'zhipu',
    label: 'Z.ai (GLM Flash 無料モデル)',
    env: ['ZHIPU_API_KEY'],
    base: 'https://open.bigmodel.cn/api/paas/v4',
    shape: 'openai',
    free: true,
    models: ['glm-4.7-flash', 'glm-4.6v-flash'],
    limits: { concurrent: 1, note: '無料モデルは同時 1 リクエスト。' },
    strengths: ['reason', 'vision'],
    caveat: 'Flash 系が恒久無料。推論系は thinking が長いので上限に注意。',
    source: 'https://open.bigmodel.cn/',
  },
  {
    id: 'cohere',
    label: 'Cohere (Trial)',
    env: ['COHERE_API_KEY'],
    base: 'https://api.cohere.com/v2',
    shape: 'openai',
    free: true,
    models: ['command-a-03-2025', 'command-r7b-12-2024'],
    limits: { rpm: 20, calls_per_month: 1000, note: 'Trial キーは月 1,000 コール。' },
    strengths: ['long', 'reason'],
    caveat: 'Trial は非商用限定。売る仕事に使うならここは避ける。',
    source: 'https://docs.cohere.com/docs/rate-limits',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face Inference Providers',
    env: ['HF_TOKEN'],
    base: 'https://router.huggingface.co/v1',
    shape: 'openai',
    free: true,
    models: ['meta-llama/Llama-3.1-8B-Instruct', 'Qwen/Qwen2.5-Coder-7B-Instruct'],
    limits: { credits: 0.1, note: '無料ユーザーは月 $0.10 分のクレジット（変動あり）。' },
    strengths: ['fast'],
    caveat: 'クレジットが小さいので補欠。数千モデルを試す用途向け。',
    source: 'https://huggingface.co/docs/inference-providers',
  },
  {
    id: 'local',
    label: 'ローカル推論 (Ollama / llama.cpp)',
    env: [],
    base: 'http://127.0.0.1:11434/v1',
    shape: 'openai',
    free: true,
    models: ['qwen3:8b', 'gpt-oss:20b', 'gemma3:12b'],
    limits: { note: '上限なし（自分の CPU/GPU が上限）。回線もキーも不要。' },
    strengths: ['fast', 'code', 'reason', 'long'],
    caveat: 'API 従量課金が構造的にゼロ。エージェントの常用レーンはここが本命。',
    source: 'https://github.com/ollama/ollama',
  },
];

export const PROVIDER_KEY_ENV = FREE_PROVIDERS.flatMap((p) => p.env);

/** Which providers have credentials present right now. */
export function providerStatus(env = defaultEnv()) {
  return FREE_PROVIDERS.map((p) => {
    const present = p.env.filter((k) => env[k]);
    const configured = p.env.length === 0 ? true : present.length === p.env.length;
    return { ...p, configured, missing: p.env.filter((k) => !present.includes(k)) };
  });
}

/** Total daily request capacity of the configured lanes (excludes unmetered local). */
export function poolCapacity(env = defaultEnv()) {
  const status = providerStatus(env);
  const lanes = status.filter((p) => p.configured && p.id !== 'local');
  const rpd = lanes.reduce((a, p) => a + (p.limits?.rpd || 0), 0);
  return {
    configured: status.filter((p) => p.configured).length,
    total: status.length,
    daily_requests: rpd,
    daily_tokens: lanes.reduce((a, p) => a + (p.limits?.tpd || 0), 0),
    unmetered: status.some((p) => p.id === 'local' && p.configured),
    lanes: lanes.map((p) => ({ id: p.id, label: p.label, rpd: p.limits?.rpd || null })),
  };
}

/**
 * Order the lanes for one kind of work. Cheap-first, quality-second, and the
 * unmetered local lane always last (it is the safety net, not the default).
 */
export function routePlan(task = 'reason', env = defaultEnv()) {
  const status = providerStatus(env);
  const scored = status
    .filter((p) => p.configured)
    .map((p) => {
      let score = p.strengths.includes(task) ? 100 : 0;
      if (p.id === 'local') score -= 5;
      if (p.limits?.rpd) score += Math.min(p.limits.rpd, 1500) / 100;
      return { id: p.id, label: p.label, model: p.models[0], score };
    })
    .sort((a, b) => b.score - a.score);
  return { task, lanes: scored, fallback: 'deterministic', lanes_available: scored.length };
}

/**
 * Hard gate: paid inference stays OFF unless the owner turns it on.
 * Returns the list of providers that would cost money if used.
 */
export function paidLanes(env = defaultEnv()) {
  const allow = String(env.ALLOW_PAID_AI || '').toLowerCase() === 'true';
  return { paid_allowed: allow, blocked: allow ? [] : ['有料モデル全般', '有料 API キーでの従量課金'] };
}

export function providerCard(env = defaultEnv()) {
  const cap = poolCapacity(env);
  const lanes = providerStatus(env).map((p) => ({
    label: p.label,
    value: p.configured ? '利用可' : `未設定（${p.missing.join(', ')}）`,
    unit: p.limits?.rpd ? `${p.limits.rpd} 回/日` : p.limits?.tpd ? `${Math.round(p.limits.tpd / 1000)}K tok/日` : '上限なし',
    tone: p.configured ? 'ok' : 'mut',
  }));
  const head = {
    label: '無料AIの枠',
    value: `${cap.configured}/${cap.total}`,
    unit: `合計 約${cap.daily_requests.toLocaleString('ja-JP')} リクエスト/日`,
    tone: cap.configured > 0 ? 'accent' : 'warn',
  };
  return { head, lanes, unmetered: cap.unmetered, checked_at: nowIso() };
}

export function providerHelp() {
  return [
    '無料のレーンを増やすには、各社のキーを入れるだけです（1社ごとに独立した無料枠が加算されます）。',
    '複数アカウントでの上限回避は規約違反なので行いません。',
    'キーが 0 本でもエージェントは全機能動きます（品質が上がるだけ）。',
  ].join('\n');
}
