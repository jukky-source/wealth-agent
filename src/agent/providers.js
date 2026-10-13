// Free / zero-cost AI provider pool.
//
// Design rule: this agent must run with ZERO paid inference. Every provider
// below has a documented permanent free tier; the pool is chosen so that the
// independent free quotas add up (one account per provider, never multi-account
// evasion — that violates provider terms).
//
// Second rule, learned the hard way: lanes that need NO signup at all come
// first in the boot order, because they work before the owner has done a single
// human step (phone call, real-name check, card).
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
 * vendor's own docs (checked 2026-10-13). Providers change them without
 * notice, so the UI always prints the source URL next to the number.
 *
 * `no_key: true` means the lane works with no account and no key at all.
 * `human_gate` records the verification step only a human can pass; the lane
 * is listed but never counted as available until that step is done.
 */
export const FREE_PROVIDERS = [
  // ---- no account, no key: usable the moment the agent boots ----------------
  {
    id: 'kilo',
    label: 'Kilo Gateway (キー不要)',
    env: [],
    no_key: true,
    base: 'https://api.kilo.ai/api/gateway',
    shape: 'openai',
    free: true,
    models: [
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3.5-lightning:free',
      'stepfun/step-3.7-flash:free',
      'kilo-auto/free',
    ],
    limits: { rph: 200, note: 'IP あたり 200 リクエスト/時（無料モデル共通の枠）。登録もキーも不要。' },
    strengths: ['long', 'reason', 'code'],
    caveat: '登録なしで即日使える代わりに、無料モデルは入力が学習に使われ得る。機密は流さない。',
    source: 'https://kilo.ai/docs/gateway/usage-and-billing',
  },
  {
    id: 'llm7',
    label: 'LLM7.io (キー不要の匿名枠)',
    env: [],
    no_key: true,
    base: 'https://api.llm7.io/v1',
    shape: 'openai',
    free: true,
    models: ['gpt-oss:20b', 'minimax-m2.7', 'DeepSeek-V4-Flash-0731'],
    limits: { rpm: 60, rph: 250, note: '匿名は turbo 系のみ。無料トークンを取ると 60 RPM / 250 req/時 に上がる。' },
    strengths: ['reason', 'long'],
    caveat: '匿名枠は品質が落ちるので補欠。トークン取得は無料だが任意。',
    source: 'https://token.llm7.io/',
  },
  {
    id: 'ovh',
    label: 'OVHcloud AI Endpoints (匿名枠)',
    env: [],
    no_key: true,
    base: null,
    shape: 'openai',
    free: true,
    models: ['20 以上のオープンウェイト（EU 内ホスト）'],
    limits: { rpm: 2, note: 'IP・モデルあたり 2 RPM。サインアップ不要の匿名枠。' },
    strengths: ['fast', 'code'],
    caveat: '速度は出ないが、EU 内で完結するのでデータの扱いを気にする案件の逃げ道になる。',
    source: 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/',
  },
  {
    id: 'local',
    label: 'ローカル推論 (Ollama / llama.cpp)',
    env: [],
    no_key: true,
    base: 'http://127.0.0.1:11434/v1',
    shape: 'openai',
    free: true,
    models: ['qwen3:8b', 'gpt-oss:20b', 'gemma3:12b'],
    limits: { note: '上限なし（自分の CPU/GPU が上限）。回線もキーも不要。' },
    strengths: ['fast', 'code', 'reason', 'long'],
    caveat: 'API 従量課金が構造的にゼロ。エージェントの常用レーンはここが本命。',
    source: 'https://github.com/ollama/ollama',
  },

  // ---- one key each, but the quota is large --------------------------------
  {
    id: 'gemma',
    label: 'Google AI Studio (Gemma 4 31B)',
    env: ['GEMINI_API_KEY'],
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    shape: 'openai',
    free: true,
    models: ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'],
    limits: { rpm: 30, rpd: 14400, tpm: 16000, note: 'Gemma 系は別枠で 30 RPM / 14,400 RPD / 16K TPM。1日の本数を稼ぐ主戦力。' },
    strengths: ['fast', 'code', 'reason'],
    caveat: 'クォータはモデル単位で別会計。Gemini 本体とは別の枠として数えてよい（アカウントは1本のまま）。',
    source: 'https://ai.google.dev/gemini-api/docs/rate-limits',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    env: ['NVIDIA_API_KEY'],
    base: 'https://integrate.api.nvidia.com/v1',
    shape: 'openai',
    free: true,
    models: ['nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-20b'],
    limits: { rpm: 40, rpd: 10000, note: 'Developer Program 無料枠で 40 RPM / モデルあたり 10,000 RPD。100 以上のモデル。' },
    strengths: ['long', 'reason', 'vision'],
    human_gate: '携帯番号の確認が必要（人間が1回だけ）。',
    caveat: '1M コンテキスト級を無料で回せる数少ないレーン。ただしモデルごとに文脈長が制限される。',
    source: 'https://build.nvidia.com/',
  },
  {
    id: 'gemini',
    label: 'Google AI Studio (Gemini Flash)',
    env: ['GEMINI_API_KEY'],
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    shape: 'openai',
    free: true,
    models: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'],
    limits: { rpm: 15, rpd: 1500, note: 'Flash 級は 15 RPM / 1,500 RPD。Pro は 5 RPM / 50 RPD。Flash-Lite は 30 RPM。' },
    strengths: ['long', 'vision', 'reason', 'fast'],
    caveat: '無料枠の入力は Google の製品改善に使われ得る（学習させたくなければ有料枠）。E フラグの地域では学習対象外。',
    source: 'https://ai.google.dev/gemini-api/docs/rate-limits',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    env: ['CEREBRAS_API_KEY'],
    base: 'https://api.cerebras.ai/v1',
    shape: 'openai',
    free: true,
    models: ['gpt-oss-120b', 'zai-glm-4.7', 'gemma-4-31b'],
    limits: { rpm: 5, tpm: 30000, tph: 1000000, tpd: 1000000, note: '5 RPM / 30K 非キャッシュ TPM / 100万 tok 毎時 / 100万 tok 毎日。' },
    strengths: ['fast', 'code'],
    caveat: 'TPD が大きいので「1日に大量に回す」用途の主戦力。速度も上位。',
    source: 'https://inference-docs.cerebras.ai/support/rate-limits',
  },
  {
    id: 'codestral',
    label: 'Mistral Codestral (コード専用)',
    env: ['CODESTRAL_API_KEY'],
    base: 'https://codestral.mistral.ai/v1',
    shape: 'openai',
    free: true,
    models: ['codestral-latest'],
    limits: { rpm: 30, rpd: 2000, note: '現在は無料。30 RPM / 2,000 RPD。' },
    strengths: ['code', 'fast'],
    human_gate: '携帯番号の確認が必要（人間が1回だけ）。',
    caveat: 'コード生成に特化。エージェントの実装作業はここに寄せると速い。',
    source: 'https://codestral.mistral.ai/',
  },
  {
    id: 'groq',
    label: 'Groq',
    env: ['GROQ_API_KEY'],
    base: 'https://api.groq.com/openai/v1',
    shape: 'openai',
    free: true,
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    limits: { rpm: 30, rpd: 1000, tpm: 8000, note: 'gpt-oss-120b は 30 RPM / 1,000 RPD / 8K TPM。小さいモデルは 14,400 RPD まで。' },
    strengths: ['fast', 'code'],
    caveat: '速度が最大の武器（LPU）。長文はトークン上限に当たりやすい。',
    source: 'https://console.groq.com/docs/rate-limits',
  },
  {
    id: 'modelscope',
    label: 'ModelScope (Alibaba)',
    env: ['MODELSCOPE_API_KEY'],
    base: 'https://api-inference.modelscope.cn/v1',
    shape: 'openai',
    free: true,
    models: ['Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-27B'],
    limits: { rpd: 2000, note: '合計 2,000 RPD（モデルあたり上限 500 RPD・動的）。' },
    strengths: ['long', 'reason'],
    human_gate: 'Alibaba Cloud アカウントの紐付けと実名確認が必要（人間）。',
    caveat: 'Qwen 系を無料で大量に回せるが、実名確認が要るので後回しの枠。',
    source: 'https://modelscope.cn/my/myaccesstoken',
  },
  {
    id: 'ollamacloud',
    label: 'Ollama Cloud (無料枠)',
    env: ['OLLAMA_API_KEY'],
    base: 'https://ollama.com/v1',
    shape: 'openai',
    free: true,
    models: ['gpt-oss:120b', 'kimi-k3', 'deepseek-v4-flash'],
    limits: { note: '無料枠あり（セッション/週次の上限は非公開）。' },
    strengths: ['reason', 'long'],
    caveat: 'ローカルの Ollama と同じ操作で、手元に GPU が無くても大きいモデルを借りられる。上限が非公開なので常用は避ける。',
    source: 'https://ollama.com/settings/keys',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    env: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    base: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run',
    shape: 'cloudflare',
    free: true,
    models: ['@cf/openai/gpt-oss-120b', '@cf/moonshotai/kimi-k2.7-code', '@cf/zai-org/glm-5.2', '@cf/qwen/qwen3-30b-a3b-fp8'],
    limits: { neurons_per_day: 10000, note: '10,000 Neurons/日（無料・有料プラン共通）。' },
    strengths: ['code', 'vision', 'reason'],
    caveat: '本番デプロイ済みならバインディング経由でキー不要。Neuron はモデル別に重み付けされる。',
    source: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
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
    models: ['mistral-small-latest', 'open-mistral-nemo'],
    limits: { rps: 1, credits_per_month: 10, note: 'Experiment 枠は約 1 req/sec、月 $10 分。' },
    strengths: ['fast', 'code'],
    human_gate: '携帯番号の確認が必要（人間が1回だけ）。',
    caveat: '無料枠の入力は学習に使われ得る（opt-out 可）。',
    source: 'https://docs.mistral.ai/deployment/laplateforme/tier/',
  },
  {
    id: 'vercel',
    label: 'Vercel AI Gateway',
    env: ['AI_GATEWAY_API_KEY'],
    base: null,
    shape: 'openai',
    free: true,
    models: ['無料枠の対象モデル（カタログ参照）'],
    limits: { credits_per_month: 5, note: '月 $5 分の無料クレジット。モデル別のレート制限あり。' },
    strengths: ['reason', 'long'],
    caveat: 'クレジット型なので使い切ると止まる。補欠レーンとして置く。',
    source: 'https://vercel.com/docs/ai-gateway/pricing',
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
];

export const PROVIDER_KEY_ENV = [...new Set(FREE_PROVIDERS.flatMap((p) => p.env))];

/** Lanes that need no account, no key and no card. The zero-human-step floor. */
export function noKeyLanes() {
  return FREE_PROVIDERS.filter((p) => p.no_key).map((p) => ({
    id: p.id,
    label: p.label,
    limits: p.limits,
    note: '登録不要でそのまま使える。',
  }));
}

/** Lanes blocked on a one-time human verification step. */
export function humanGateLanes() {
  return FREE_PROVIDERS.filter((p) => p.human_gate).map((p) => ({ id: p.id, label: p.label, step: p.human_gate }));
}

/**
 * Trial credits: real money, but one-shot or short-lived. Kept separate from
 * the permanent pool on purpose — counting them as capacity would make the
 * agent look funded when it is about to run dry.
 */
export const TRIAL_CREDITS = [
  { id: 'baseten', label: 'Baseten', credits_usd: 30, note: '初回 $30。' },
  { id: 'modal', label: 'Modal', credits_usd: 30, note: 'Starter で月 $30。' },
  { id: 'nlpcloud', label: 'NLP Cloud', credits_usd: 15, note: '電話確認あり。' },
  { id: 'ai21', label: 'AI21', credits_usd: 10, note: '3 か月有効。' },
  { id: 'upstage', label: 'Upstage', credits_usd: 10, note: '3 か月有効。' },
  { id: 'sambanova', label: 'SambaNova Cloud', credits_usd: 5, note: '3 か月有効。' },
  { id: 'inference_net', label: 'Inference.net', credits_usd: 25, note: 'アンケート回答で $25。' },
  { id: 'fireworks', label: 'Fireworks', credits_usd: 1, note: '少量。' },
  { id: 'nebius', label: 'Nebius', credits_usd: 1, note: '少量。' },
  { id: 'hyperbolic', label: 'Hyperbolic', credits_usd: 1, note: '少量。' },
  { id: 'alibaba_intl', label: 'Alibaba Model Studio (国際)', credits_tokens: 1000000, note: 'モデルあたり 100 万トークン、90 日有効。' },
  { id: 'scaleway', label: 'Scaleway Generative APIs', credits_tokens: 1000000, note: '100 万トークン＋音声文字起こし 60 分。' },
];

/**
 * Free compute for hosting the local lane. Verified 2026-10.
 * `verified` marks the ones we re-checked against the vendor's own page.
 */
export const FREE_HOSTS = [
  {
    id: 'oracle_always_free',
    label: 'Oracle Cloud Always Free (ARM)',
    spec: '2 OCPU / 12 GB RAM（旧 4 OCPU / 24 GB から半減）',
    verified: true,
    caveat: '2026-06 に無償枠が半分に減り、2026-08-18 から新上限が適用。小さいモデルを常駐させるには足りる。',
    source: 'https://docs.oracle.com/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm',
  },
  {
    id: 'cloudflare_workers',
    label: 'Cloudflare Workers 無料枠',
    spec: 'Workers + D1 + Cron が無料枠内',
    verified: true,
    caveat: 'このエージェント本体が載っている場所。サーバー代が構造的にゼロ。',
    source: 'https://developers.cloudflare.com/workers/platform/pricing/',
  },
];

/** Which providers have credentials present right now. */
export function providerStatus(env = defaultEnv()) {
  return FREE_PROVIDERS.map((p) => {
    const present = p.env.filter((k) => env[k]);
    const configured = p.env.length === 0 ? true : present.length === p.env.length;
    return { ...p, configured, missing: p.env.filter((k) => !present.includes(k)) };
  });
}

/**
 * Total capacity of the configured lanes. `local` and the unkeyed lanes are
 * reported separately so the headline number stays conservative: only lanes
 * with a published daily request quota are summed into `daily_requests`.
 */
export function poolCapacity(env = defaultEnv()) {
  const status = providerStatus(env);
  const lanes = status.filter((p) => p.configured && !p.no_key && p.id !== 'local');
  const unkeyed = status.filter((p) => p.configured && p.no_key && p.id !== 'local');
  return {
    configured: status.filter((p) => p.configured).length,
    total: status.length,
    daily_requests: lanes.reduce((a, p) => a + (p.limits?.rpd || 0), 0),
    daily_tokens: lanes.reduce((a, p) => a + (p.limits?.tpd || 0), 0),
    hourly_tokens: lanes.reduce((a, p) => a + (p.limits?.tph || 0), 0),
    unkeyed_hourly_requests: unkeyed.reduce((a, p) => a + (p.limits?.rph || 0), 0),
    unkeyed_lanes: unkeyed.map((p) => ({ id: p.id, label: p.label, rph: p.limits?.rph || null })),
    human_gate: humanGateLanes().filter((h) => !status.find((s) => s.id === h.id)?.configured),
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
      // キー不要のレーンを優先する。ただしローカルは「最後の受け皿」なので加点しない。
      if (p.no_key && p.id !== 'local') score += 10;
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
    value: p.no_key ? 'キー不要' : p.configured ? '利用可' : `未設定（${p.missing.join(', ')}）`,
    unit: p.limits?.rpd
      ? `${p.limits.rpd} 回/日`
      : p.limits?.rph
        ? `${p.limits.rph} 回/時`
        : p.limits?.tpd
          ? `${Math.round(p.limits.tpd / 1000)}K tok/日`
          : p.limits?.credits_per_month
            ? `月 $${p.limits.credits_per_month}`
            : '上限なし',
    tone: p.configured ? 'ok' : 'mut',
  }));
  const head = {
    label: '無料AIの枠',
    value: `${cap.configured}/${cap.total}`,
    unit: `合計 約${cap.daily_requests.toLocaleString('ja-JP')} リクエスト/日（キー無しの枠を除く）`,
    tone: cap.configured > 0 ? 'accent' : 'warn',
  };
  return { head, lanes, unmetered: cap.unmetered, checked_at: nowIso() };
}

export function providerHelp() {
  return [
    '無料のレーンを増やすには、各社のキーを入れるだけです（1社ごとに独立した無料枠が加算されます）。',
    'Kilo / LLM7 / OVH / ローカルはキーが無くても動きます。まずはここだけで回してください。',
    '携帯番号や実名確認が要る枠（NVIDIA・Codestral・Mistral・ModelScope）は、人間の1回の作業として最後に回します。',
    '複数アカウントでの上限回避は規約違反なので行いません。',
    'キーが 0 本でもエージェントは全機能動きます（品質が上がるだけ）。',
  ].join('\n');
}
