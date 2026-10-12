// Character avatar image generation — free-first, zero-key safe.
// ---------------------------------------------------------------------------
// Three engines, each honest about what actually produced the pixels:
//   workersai  Cloudflare Workers AI — @cf/black-forest-labs/flux-1-schnell
//              Verified against the model docs (2026-10): env.AI.run(model,
//              { prompt, seed }) resolves to { image: <base64 jpeg> }; the same
//              model is reachable over the REST endpoint with a scoped token.
//              Keyless once deployed on Cloudflare (free daily Neuron quota).
//   gemini     Google Gemini image models ("Nano Banana") via the Interactions
//              REST endpoint, models verified on ai.google.dev (2026-10).
//              Used only when GEMINI_API_KEY is present.
//   local      Deterministic procedural SVG drawn from the instruction text.
//              No AI, no network, no key — it cannot fail, and it is always
//              labelled as local so nobody mistakes it for generated artwork.
//
// This module never touches the database: it returns an image, and the caller
// decides whether to store it, so a failed generation cannot leave a half-saved
// avatar behind. Every attempt is logged to ai_usage (role 'image').

import { nowIso, truncate, utcDay, id as newId } from '../util.js';

export const AVATAR_STYLES = [
  { key: 'flat', label: 'フラット', words: 'flat vector illustration, bold simple shapes, limited palette, crisp clean edges, no gradients' },
  { key: 'line', label: '線画', words: 'minimal line art, single-weight outline, monochrome with one accent colour, generous negative space' },
  { key: 'anime', label: 'アニメ調', words: 'anime style character, clean cel shading, expressive eyes, crisp linework' },
  { key: 'photo', label: '写真調', words: 'photorealistic portrait, soft studio lighting, shallow depth of field, natural skin texture' },
  { key: 'render3d', label: '3Dレンダー', words: 'stylized 3D render, soft studio light, matte clay material, subtle ambient occlusion' },
  { key: 'pixel', label: 'ドット絵', words: 'pixel art, limited 32-colour palette, crisp pixels, no anti-aliasing' },
];

const NEGATIVE = 'no text, no letters, no numbers, no captions, no watermark, no signature, no logo, no border, no frame, no collage, no grid, no extra faces, no distorted anatomy';

const ENGINE_ORDER = ['workersai', 'gemini', 'local'];
const ENGINE_LABEL = {
  workersai: 'Cloudflare Workers AI',
  gemini: 'Google Gemini（画像生成）',
  local: 'ローカル生成（AI不使用）',
};
const WORKERSAI_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const GEMINI_MODEL = 'gemini-nano-banana-2.1';
export const MAX_INSTRUCTION_CHARS = 400;

export function createImageGen({ env = {}, store = null, router = null } = {}) {
  const workersModel = env.IMAGE_MODEL_WORKERSAI || WORKERSAI_MODEL;
  const geminiModel = env.IMAGE_MODEL_GEMINI || GEMINI_MODEL;

  // ---- persisted studio settings ------------------------------------------
  // The owner can switch engines on/off, pin model ids, choose the default
  // style and size, and add a standing prompt suffix — from the Settings
  // screen. The local engine cannot be broken by configuration, and "every
  // engine off" returns an actionable error instead of a silent no-op.
  let overrides = {};                       // { workers_model, gemini_model }
  let activeCfg = cloneConfig(DEFAULT_IMAGE_CONFIG);

  async function loadConfig() {
    if (!store) return activeCfg;
    try {
      const r = await store.first("SELECT value FROM settings WHERE key='image:config'");
      if (r && r.value) activeCfg = mergeConfig(activeCfg, parseJsonLoose(r.value));
    } catch { /* keep the in-memory default */ }
    return activeCfg;
  }
  async function config() { await loadConfig(); return cloneConfig(activeCfg); }

  async function setConfig(patch = {}) {
    await loadConfig();
    activeCfg = (patch && patch.reset) ? cloneConfig(DEFAULT_IMAGE_CONFIG) : mergeConfig(activeCfg, patch);
    overrides = { workers_model: activeCfg.workers_model, gemini_model: activeCfg.gemini_model };
    if (store) {
      try {
        await store.run("INSERT INTO settings (key,value,updated_at) VALUES ('image:config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
          JSON.stringify(activeCfg), nowIso());
      } catch (e) { return { ok: false, error: 'persist_failed', hint: String(e.message || e) }; }
    }
    return { ok: true, config: cloneConfig(activeCfg) };
  }

  const geminiKeys = () => ['', '_2', '_3', '_4', '_5'].map((s) => env[`GEMINI_API_KEY${s}`]).filter(Boolean);
  const workersAvailable = () => !!(env.AI && typeof env.AI.run === 'function')
    || !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
  const availability = () => ({ workersai: workersAvailable(), gemini: geminiKeys().length > 0, local: true });

  function options() {
    const a = availability();
    return {
      engines: [
        { key: 'workersai', label: 'Cloudflare Workers AI', available: a.workersai, enabled: activeCfg.engines.workersai !== false, model: workerOrGeminiModel('workersai'),
          cost: '無料枠（Neurons 10,000/日）', note: 'CloudflareへデプロイするとAPIキー不要で使われます' },
        { key: 'gemini', label: 'Google Gemini（画像生成）', available: a.gemini, enabled: activeCfg.engines.gemini !== false, model: workerOrGeminiModel('gemini'),
          cost: '無料枠あり（モデル別・実枠はAI Studioで確認）', note: 'GEMINI_API_KEY を設定すると使われます' },
        { key: 'local', label: 'ローカル生成（AI不使用）', available: true, enabled: activeCfg.engines.local !== false, model: 'procedural-v1',
          cost: '無料', note: '指示文から決定的に描画します。キーが無くても必ず動きます' },
      ],
      styles: AVATAR_STYLES,
      max_instruction_chars: MAX_INSTRUCTION_CHARS,
      order: [...activeCfg.order],
      default_style: activeCfg.style,
      config: cloneConfig(activeCfg),
      sizes: [128, 256, 384, 512],
    };
  }

  async function logCall(provider, model, ok, latencyMs, promptChars, error) {
    if (!store) return;
    try {
      await store.insert('ai_usage', {
        id: newId('aiu'), provider, model, role: 'image', ok: ok ? 1 : 0,
        status_code: ok ? 200 : null, error: error ? truncate(String(error), 200) : null,
        latency_ms: latencyMs, prompt_chars: promptChars, output_chars: 0,
        day: utcDay(), created_at: nowIso(),
      });
    } catch { /* usage logging must never break generation */ }
  }

  /**
   * Generate one avatar. Never throws — always reports which engine answered,
   * or why every engine was unavailable.
   */
  async function generate({ instruction, style = null, character = null, prefer = null } = {}) {
    // style = null means "use the style saved in the image settings".
    const text = normalizeInstruction(instruction);
    if (!text) return { ok: false, error: 'instruction_required', hint: '指示文を入力してください（例: 落ち着いた女性アドバイザー、ネイビー基調）' };
    const c = await loadConfig();
    overrides = { workers_model: c.workers_model, gemini_model: c.gemini_model };
    const st = AVATAR_STYLES.find((s) => s.key === (style || c.style)) || AVATAR_STYLES.find((s) => s.key === c.style) || AVATAR_STYLES[0];
    const avail = availability();
    // Only engines the owner left switched on are tried, in the saved order.
    const enabled = ENGINE_ORDER.filter((k) => c.engines[k] !== false);
    const ordered = [...c.order.filter((k) => enabled.includes(k)), ...enabled.filter((k) => !c.order.includes(k))];
    if (!ordered.length) {
      return { ok: false, error: 'all_engines_disabled', hint: '設定画面の「画像設定」で全ての生成エンジンが無効です。1つ以上を有効にしてください。' };
    }
    const order = prefer && ordered.includes(prefer)
      ? [prefer, ...ordered.filter((k) => k !== prefer)]
      : ordered;

    // The instruction is usually Japanese; image models adhere far better to an
    // English prompt, so the configured AI provider rewrites it first. Any
    // failure here is non-fatal — the raw instruction is used verbatim instead.
    let english = null;
    const aiEngine = order.find((k) => k !== 'local' && avail[k]);
    if (aiEngine && router && typeof router.complete === 'function') {
      let hasProvider = false;
      try { hasProvider = (router.availableProviders?.() || []).length > 0; } catch { hasProvider = false; }
      if (hasProvider) english = await expandPrompt({ instruction: text, style: st, character, prefer: [aiEngine] });
    }
    const prompt = composePrompt({ instruction: english || text, style: st, character }) + (c.prompt_suffix ? `, ${c.prompt_suffix}` : '');

    const errors = [];
    for (const engine of order) {
      if (!avail[engine]) { errors.push(`${engine}: 未設定`); continue; }
      const t0 = Date.now();
      try {
        const out = engine === 'workersai' ? await genWorkersAI(prompt)
          : engine === 'gemini' ? await genGemini(prompt)
            : localAvatar({ instruction: text, character, style: st.key });
        await logCall(engine, out.model, true, Date.now() - t0, prompt.length);
        return {
          ok: true, engine, engine_label: ENGINE_LABEL[engine], model: out.model,
          data_url: out.data_url, mime: out.mime, bytes: out.bytes ?? null,
          instruction: text, prompt_used: prompt, prompt_translated: !!english, style: st.key,
          latency_ms: Date.now() - t0,
          note: engine === 'local'
            ? 'ローカル生成です（AIは使用していません）。指示文から決定的に図形を描画しました。'
            : `${ENGINE_LABEL[engine]} の無料枠で生成しました。`,
          errors: errors.length ? errors : undefined,
        };
      } catch (e) {
        await logCall(engine, workerOrGeminiModel(engine), false, Date.now() - t0, prompt.length, e.message || e);
        errors.push(`${engine}: ${truncate(String(e.message || e), 160)}`);
      }
    }
    return { ok: false, error: 'all_engines_failed', errors, hint: '画像生成に失敗しました。時間をおいて再試行してください。' };
  }

  function workerOrGeminiModel(engine) {
    const o = engine === 'gemini' ? overrides.gemini_model : overrides.workers_model;
    return (o && String(o).trim()) || (engine === 'gemini' ? geminiModel : workersModel);
  }

  async function expandPrompt({ instruction, style, character, prefer }) {
    try {
      const r = await router.complete({
        role: 'chat', prefer,
        system: 'あなたは画像生成プロンプトの編集者です。日本語の指示を、画像生成モデルが忠実に再現できる英語のプロンプト1つに変換します。人物の外見・構図・配色・雰囲気を具体的に補い、指示に無い要素や固有の有名人は足しません。説明や前置きは書かず、JSONのみを返します。',
        user: `指示: ${instruction}\n画風: ${style.words}\n用途: モバイルアプリのキャラクターアイコン（正方形・44pxでも判別できること）${character?.name ? `\nキャラクター名: ${character.name}` : ''}`,
        json: true, schema: ['prompt'], maxTokens: 320, temperature: 0.3,
      });
      const out = String(r?.json?.prompt || '').trim();
      if (!out || out.length < 12 || /^\[deterministic/.test(out)) return null;
      return out.slice(0, 700);
    } catch { return null; }
  }

  /** Workers AI: platform binding when deployed, REST when off-platform. */
  async function genWorkersAI(prompt) {
    const opts = { prompt, seed: Math.floor(Math.random() * 1e9) };
    let image = null;
    if (env.AI && typeof env.AI.run === 'function') {
      const data = await env.AI.run(workerOrGeminiModel('workersai'), opts);
      image = extractImage(data);
      if (!image && data instanceof ArrayBuffer) image = toBase64(new Uint8Array(data));
      if (!image && ArrayBuffer.isView(data)) image = toBase64(data);
    } else {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${workerOrGeminiModel('workersai')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        body: JSON.stringify(opts),
      });
      if (!res.ok) throw httpError(res, await res.text().catch(() => ''));
      image = extractImage(await res.json());
    }
    if (!image) throw new Error('empty image response');
    return { data_url: `data:image/jpeg;base64,${image}`, mime: 'image/jpeg', model: workerOrGeminiModel('workersai') };
  }

  /** Gemini: /v1beta/interactions with an image response format. */
  async function genGemini(prompt) {
    const key = geminiKeys()[0];
    const call = async (withFormat) => {
      const t0 = Date.now();
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          model: workerOrGeminiModel('gemini'),
          input: [{ type: 'text', text: prompt }],
          ...(withFormat ? { response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: '1K' } } : {}),
        }),
      });
      if (!res.ok) throw httpError(res, await res.text().catch(() => ''));
      const data = await res.json();
      const img = findImageBlock(data);
      if (!img?.data) throw new Error('empty image response');
      return { data_url: `data:${img.mime_type || img.mimeType || 'image/png'};base64,${img.data}`, mime: img.mime_type || 'image/png', model: workerOrGeminiModel('gemini'), ms: Date.now() - t0 };
    };
    try { return await call(true); } catch (e) {
      // Older image models reject response_format — retry once without it.
      if (/400|404/.test(String(e.status || e.message))) return await call(false);
      throw e;
    }
  }

  return { options, generate, availability, config, setConfig, loadConfig, DEFAULT_CONFIG: DEFAULT_IMAGE_CONFIG };
}

/** Pure prompt normaliser — exported through generate()'s behaviour only. */
function normalizeInstruction(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, MAX_INSTRUCTION_CHARS);
}

/** Compose the final image prompt from the owner's instruction + style. */
export function composePrompt({ instruction, style, character }) {
  const st = style || AVATAR_STYLES[0];
  const who = character?.name
    ? `${character.name}${character.description ? ` (${truncate(String(character.description), 110)})` : ''}, a personal finance AI agent`
    : 'a personal finance AI agent';
  return [
    `Square avatar icon of ${who}.`,
    instruction,
    `Visual style: ${st.words}.`,
    'One single subject, centred head-and-shoulders framing, generous margins so a circular crop never cuts the face, plain uncluttered background of a flat colour or soft gradient, strong silhouette that stays readable at 44 pixels.',
    `${NEGATIVE}.`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Local engine — deterministic procedural SVG (no AI, no network)
// ---------------------------------------------------------------------------
const PALETTES = [
  ['#0c1424', '#2f6bff'], ['#150d24', '#8b5cf6'], ['#0b1a15', '#12b981'], ['#1d1408', '#f59e0b'],
  ['#1a0d13', '#f43f5e'], ['#08141d', '#06b6d4'], ['#130f1c', '#a78bfa'], ['#111a0c', '#84cc16'],
];

function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

const escXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** 1-2 characters of identity, emoji stripped — never an emoji sticker. */
export function monogram(name) {
  const s = String(name || '').replace(/\p{Extended_Pictographic}+/gu, '').trim();
  if (!s) return '';
  return [...s].slice(0, 2).join('');
}

/**
 * Draw a deterministic SVG from (name, instruction, style). The same input
 * always yields the same mark, so re-running the local engine is reproducible
 * rather than random noise.
 */
export function localAvatarSvg({ instruction = '', name = '', style = 'flat', size = 256 } = {}) {
  const h = fnv1a(`${name}|${instruction}|${style}`);
  const [bg, ac] = PALETTES[h % PALETTES.length];
  const rot = (h >>> 3) % 360;
  const bars = 3 + ((h >>> 7) % 3);
  const r = size;
  const barW = r * 0.052;
  let bars2 = '';
  for (let i = 0; i < bars; i++) {
    const x = r * (0.62 + i * 0.075);
    const hgt = r * (0.10 + i * 0.075);
    bars2 += `<rect x="${x.toFixed(1)}" y="${(r * 0.80 - hgt).toFixed(1)}" width="${barW.toFixed(1)}" height="${hgt.toFixed(1)}" rx="${(barW / 2).toFixed(1)}" fill="#ffffff" opacity="${(0.16 + i * 0.06).toFixed(2)}"/>`;
  }
  const mono = escXml(monogram(name));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r} ${r}" width="${r}" height="${r}">`
    + `<defs>`
    + `<linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ac}"/><stop offset="1" stop-color="${bg}"/></linearGradient>`
    + `<radialGradient id="b" cx="0.5" cy="0.32" r="0.75"><stop offset="0" stop-color="#ffffff" stop-opacity="0.20"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>`
    + `</defs>`
    + `<rect width="${r}" height="${r}" fill="${bg}"/><rect width="${r}" height="${r}" fill="url(#a)"/>`
    + `<g>${bars2}</g>`
    + `<rect width="${r}" height="${r}" fill="url(#b)"/>`
    + `<g transform="rotate(${rot} ${r / 2} ${r / 2})"><circle cx="${r / 2}" cy="${r / 2}" r="${(r * 0.44).toFixed(1)}" fill="none" stroke="#ffffff" stroke-opacity="0.30" stroke-width="${(r * 0.011).toFixed(1)}" stroke-dasharray="${(r * 0.17).toFixed(1)} ${(r * 0.11).toFixed(1)}"/></g>`
    + (mono ? `<text x="${r / 2}" y="${(r * 0.655).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, Hiragino Sans, Noto Sans JP, sans-serif" font-size="${(r * 0.38).toFixed(1)}" font-weight="600" fill="#ffffff" fill-opacity="0.96" letter-spacing="${(r * 0.008).toFixed(1)}">${mono}</text>` : '')
    + `</svg>`;
}

function localAvatar({ instruction, character, style }) {
  const svg = localAvatarSvg({ instruction, name: character?.name || '', style });
  return { data_url: `data:image/svg+xml,${encodeURIComponent(svg)}`, mime: 'image/svg+xml', model: 'procedural-v1', bytes: svg.length };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function httpError(res, text) {
  const e = new Error(`HTTP ${res.status}: ${truncate(text, 240)}`);
  e.status = res.status;
  return e;
}

/** Pull a base64 image out of any of the response shapes the models use. */
function extractImage(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;
  if (typeof data.image === 'string') return data.image;
  if (typeof data.result?.image === 'string') return data.result.image;
  const found = findImageBlock(data);
  return found?.data || null;
}

function findImageBlock(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (typeof node.data === 'string' && typeof (node.mime_type || node.mimeType) === 'string'
    && /^image\//.test(node.mime_type || node.mimeType)) return node;
  const keys = ['output_image', 'outputImage', 'outputs', 'steps', 'content', 'parts', 'candidates', 'result', 'generatedImages', 'images'];
  for (const k of keys) {
    if (!(k in node)) continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const item of v) { const hit = findImageBlock(item, depth + 1); if (hit) return hit; }
    } else {
      const hit = findImageBlock(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function toBase64(bytes) {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}


// ---------------------------------------------------------------------------
// Studio configuration (persisted in settings.image:config)
// ---------------------------------------------------------------------------
export const DEFAULT_IMAGE_CONFIG = {
  engines: { workersai: true, gemini: true, local: true },
  order: ['workersai', 'gemini', 'local'],
  style: 'flat', size: 256, quality: 0.85,
  prompt_suffix: '', workers_model: '', gemini_model: '',
};

function parseJsonLoose(v) { try { return JSON.parse(v); } catch { return {}; } }

function cloneConfig(c) {
  return {
    engines: { ...c.engines }, order: [...c.order], style: c.style, size: c.size,
    quality: c.quality, prompt_suffix: c.prompt_suffix || '',
    workers_model: c.workers_model || '', gemini_model: c.gemini_model || '',
  };
}

function mergeConfig(cur, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const out = cloneConfig(cur);
  if (p.engines && typeof p.engines === 'object') {
    for (const k of Object.keys(out.engines)) {
      if (p.engines[k] !== undefined) out.engines[k] = !!p.engines[k];
    }
  }
  if (Array.isArray(p.order)) out.order = [...new Set([...p.order.filter((k) => ENGINE_ORDER.includes(k)), ...ENGINE_ORDER])];
  if (typeof p.style === 'string' && AVATAR_STYLES.some((s2) => s2.key === p.style)) out.style = p.style;
  if (p.size !== undefined) out.size = [128, 256, 384, 512].includes(Number(p.size)) ? Number(p.size) : out.size;
  if (p.quality !== undefined) out.quality = Math.min(0.95, Math.max(0.5, Number(p.quality) || out.quality));
  if (p.prompt_suffix !== undefined) out.prompt_suffix = String(p.prompt_suffix).slice(0, 200);
  if (p.workers_model !== undefined) out.workers_model = String(p.workers_model).slice(0, 120);
  if (p.gemini_model !== undefined) out.gemini_model = String(p.gemini_model).slice(0, 120);
  return out;
}
