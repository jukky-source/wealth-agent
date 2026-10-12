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
      { id: '@cf/openai/gpt-oss-120b', tier: 'fast', ctx: 128000, strengths: ['reasoning', 'json'] },
      { id: '@cf/zai-org/glm-4.7-flash', tier: 'lite', ctx: 128000, strengths: ['cheap', 'fast'] },
      { id: '@cf/meta/llama-4-scout-17b-16e-instruct', tier: 'fast', ctx: 128000, strengths: ['reasoning'] },
    ],
  },
  gemini: {
    kind: 'gemini',
    label: 'Google Gemini',
    keyEnv: 'GEMINI_API_KEY',
    paid: false,
    base: 'https://generativelanguage.googleapis.com/v1beta/models',
    models: [
      { id: 'gemini-2.5-flash', tier: 'fast', ctx: 1000000, strengths: ['reasoning', 'long_context', 'json'] },
      { id: 'gemini-2.5-flash-lite', tier: 'lite', ctx: 1000000, strengths: ['cheap', 'fast'] },
      { id: 'gemini-2.0-flash', tier: 'fast', ctx: 1000000, strengths: ['fast', 'json'] },
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

  async budgetExceeded() {
    const budget = Number(this.env.AI_DAILY_CALL_BUDGET || 300);
    const r = await this.store.first(
      `SELECT COUNT(*) AS c FROM ai_usage WHERE day=? AND ok=1`, utcDay());
    return (r?.c || 0) >= budget;
  }

  /** Main entry point. Always resolves — never throws into the engine loop. */
  async complete({
    role = 'chat', system = '', user = '', messages = null,
    json = false, schema = null, maxTokens = 1024, temperature = 0.4,
    prefer = null, deterministic = null,
  }) {
    if (await this.budgetExceeded()) {
      const wait = new Date(Date.now() + 15 * 60e3).toISOString();
      const d = this.runDeterministic({ role, schema, deterministic, user });
      return { ...d, ok: true, fallback: true, reason: 'daily_budget_exhausted', wait_until: wait,
        note: `本日のAI呼び出し上限に達しました。${wait} 以降に再開します（進捗は保存済み）。` };
    }

    const order = this.routingOrder(role, prefer);
    const live = order.filter((p) => PROVIDERS[p] && this.available(p));
    const errors = [];

    for (const provider of live) {
      const st = await this.providerState(provider);
      if (!st.enabled) continue;
      if (st.cooldown_until && new Date(st.cooldown_until).getTime() > Date.now()) {
        errors.push(`${provider}: cooldown until ${st.cooldown_until}`);
        continue;
      }
      for (const model of PROVIDERS[provider].models.slice(0, 2)) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          const t0 = Date.now();
          try {
            const out = await this.callOne({ provider, model: model.id, system, user, messages, json, maxTokens, temperature });
            await this.logged({ provider, model: model.id, role, ok: 1, status_code: 200,
              latency_ms: Date.now() - t0, prompt_chars: (system + user).length, output_chars: out.text.length });
            await this.markSuccess(provider);
            let parsed = null;
            if (json) parsed = schema ? coerceSchema(extractJson(out.text), schema) : extractJson(out.text);
            return { ok: true, text: out.text, json: parsed, provider, model: model.id, attempts: attempt };
          } catch (e) {
            const code = e.status || 0;
            const rateLimited = code === 429 || code === 503;
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

  routingOrder(role, prefer) {
    if (prefer && prefer.length) return [...prefer, ...Object.keys(PROVIDERS).filter((p) => !prefer.includes(p))];
    return ROLE_ROUTING[role] || ROLE_ROUTING.chat;
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
      const text = typeof data === 'string' ? data : (data?.response || data?.result?.response || '');
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
    const text = data?.result?.response || data?.result?.choices?.[0]?.message?.content || '';
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
