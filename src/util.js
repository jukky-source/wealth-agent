// Shared utilities. No dependencies — runs identically on Workers and Node 22.

export function id(prefix = '') {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  const c = (idCounter++).toString(36);
  return `${prefix}${prefix ? '_' : ''}${t}${r}${c}`;
}
let idCounter = 0;

export const nowIso = () => new Date().toISOString();
export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const round = (v, n = 2) => {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  const f = 10 ** n;
  return Math.round(v * f) / f;
};

export function safeJson(str, fallback = null) {
  if (str === null || str === undefined) return fallback;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

export const j = (v) => JSON.stringify(v ?? null);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter, bounded. */
export function backoffMs(attempt, base = 500, cap = 30000) {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

/** Stable short hash (FNV-1a) — used for progress markers & cache keys. */
export function hash(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function hashStr(str) { return hash(str); }

export function slug(s, max = 60) {
  return String(s).toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, max);
}

export function truncate(s, n = 400) {
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** Extract the first JSON object/array from an LLM response, tolerant of prose/fences. */
export function extractJson(text) {
  if (!text) return null;
  const direct = safeJson(text);
  if (direct && typeof direct === 'object') return direct;
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const firstBrace = String(text).indexOf('{');
  const firstBracket = String(text).indexOf('[');
  const start = [firstBrace, firstBracket].filter((x) => x >= 0).sort((a, b) => a - b)[0];
  if (start >= 0) {
    const openCh = String(text)[start];
    const closeCh = openCh === '{' ? '}' : ']';
    const end = String(text).lastIndexOf(closeCh);
    if (end > start) candidates.push(String(text).slice(start, end + 1));
  }
  for (const c of candidates) {
    const p = safeJson(c);
    if (p && typeof p === 'object') return p;
  }
  return null;
}

/** Deterministic pseudo-random from a string seed (reproducible experiments). */
export function seededRandom(seedStr) {
  let h = 2166136261 >>> 0;
  const s = String(seedStr);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  let x = h || 1;
  return function next() {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

export function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
export function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

/** Clamp text for prompts to protect the free-tier token budget. */
export function clipForPrompt(s, chars = 6000) {
  const t = String(s ?? '');
  return t.length <= chars ? t : t.slice(0, Math.floor(chars * 0.7)) + '\n…[truncated]…\n' + t.slice(-Math.floor(chars * 0.2));
}

export function stableSort(arr, keyFn) {
  return arr.map((v, i) => [v, i]).sort((a, b) => {
    const ka = keyFn(a[0]), kb = keyFn(b[0]);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return a[1] - b[1];
  }).map(([v]) => v);
}


/** SQLite/D1 の LIKE に渡すパターン。長すぎる語やワイルドカードは安全側に倒す。 */
export function likePattern(s, max = 64) {
  const t = String(s == null ? '' : s).replace(/[%_\\]/g, ' ').trim().slice(0, max);
  return `%${t}%`;
}
