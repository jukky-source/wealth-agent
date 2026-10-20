// direct-1.0 — 自然言語の指示を受けて、自分で計画し、実行し、検証し、失敗したら
// 手を変えて再試行し、結果を記憶に残す層。
//
// ねらい: 「こんな風に自然言語でエージェントに指示して自律トライアンドエラーできる」
// 状態にすること。指示は既存の検証済みレバー（grow-1.0）に写像して実行するので、
// 新しい実行経路を勝手に増やさない（安全側に倒す）。
//
// 実行の原則:
//   1. 指示を意図に分類する（決定的な語彙 → 足りなければ無料枠のAI → それでも不明なら blocked と正直に記録）
//   2. 意図には手順（レバーの並び）と代替手を定義しておく
//   3. 各手はその場で証拠を返す。証拠が空なら失敗とみなして再試行（最大2回）→ 代替手
//   4. 途中経過と最終結果を directives に残す（次回の文脈になる）

import { guardDirective } from './guardrail.js';

export const DIRECT_VERSION = 'direct-1.0';
export const DK = 'directives';
export const DSTATE = 'direct:state';
export const MAX_TRIES = 2;
export const DIRECT_EVERY_MINUTES = 20;
export const DIRECT_MAX_PER_TICK = 1;

const nowIso = () => new Date().toISOString();
const clip = (s, n = 300) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) : t; };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
export const rid = (p = 'd') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------- 意図の語彙
// 日本語と英語の両方を受ける。lever は grow-1.0 のレバー名（既存の実行部品）。
export const INTENTS = [
  { key: 'find_money', label: '稼げる分野・可能性を探す', lever: ['frontier_think', 'repo_intake'], fallback: ['market_truth'],
    words: ['分野', '可能性', '他に', 'ほかに', '別の稼ぎ', '新しい稼ぎ', '収益源', '稼ぎ方', 'もっと稼', 'opportunit', 'frontier', 'new way', 'other domain', 'ideas'] },
  { key: 'adopt_repo', label: 'GitHub から良いリポジトリを取り入れる', lever: ['repo_intake', 'listing_intake'], fallback: ['frontier_think'],
    words: ['github', 'リポジトリ', 'repo', 'リポジトリー', '取り入', '取り込', 'oss', 'オープンソース', 'ライブラリ', 'adopt'] },
  { key: 'launch', label: '新しい売り物を作って並べる', lever: ['market_truth', 'product_launch'], fallback: ['product_launch'],
    words: ['新しい品', '売り物', '商品', '作って', '並べ', '出品', '追加して', 'ローンチ', 'launch', 'new product', 'list a new'] },
  { key: 'price_down', label: '値札を下げて試し買いの壁を外す', lever: ['price_entry'], fallback: ['market_truth'],
    words: ['値札', '値段', '価格', '安く', '下げ', 'price', 'cheaper', 'lower the price'] },
  { key: 'find_buyers', label: '売り場・買い手を探す', lever: ['listing_intake', 'channel_hunt', 'registry_poll'], fallback: ['frontier_think'],
    words: ['売り場', '買い手', '顧客', '集客', '出品先', 'チャネル', 'channel', 'buyer', 'customer', 'marketplace', 'distribut'] },
  { key: 'scan_market', label: '市場と競合を実測する', lever: ['market_truth'], fallback: ['frontier_think'],
    words: ['市場', '競合', '調査', '測', 'ベンチマーク', 'market scan', 'competitor', 'research the market'] },
  { key: 'improve', label: '売れる形に改善する', lever: ['ai_strategist'], fallback: ['market_truth'],
    words: ['改善', '強く', '賢く', 'もっと良', 'better', 'improve', 'stronger', 'smarter'] },
  { key: 'report', label: '現状をまとめて報告する', lever: ['status'], fallback: [],
    words: ['報告', 'レポート', 'まとめ', '状況', 'どうなって', '現状', 'report', 'summary', 'status'] },
  { key: 'check_status', label: '今の稼ぎを確認する', lever: ['status'], fallback: [],
    words: ['いくら', '稼いだ', '売上', '残高', '入金', 'how much', 'earned', 'revenue', 'balance'] },
];

export const intentByKey = (k) => INTENTS.find((i) => i.key === String(k || '').trim()) || null;

/** 決定的な語彙で意図を分類する。決まらなければ null（AIに委ねる）。 */
export function parseDirective(text = '') {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return null;
  let best = null;
  for (const it of INTENTS) {
    let hits = 0;
    for (const w of it.words) if (s.includes(w.toLowerCase())) hits += 1;
    if (hits && (!best || hits > best.hits)) best = { key: it.key, hits };
  }
  return best ? best.key : null;
}

/** 意図から手順を組み立てる（実行前の計画。証拠を集める手を先に置く）。 */
export function planFor(intent) {
  const it = intentByKey(intent);
  if (!it) return null;
  return { intent: it.key, label: it.label, steps: it.lever.slice(), fallback: (it.fallback || []).slice(), why: it.label };
}

// ---------------------------------------------------------------- 記憶の口
async function run(store, sql, ...p) {
  const tries = [
    () => (store && typeof store.run === 'function' ? store.run(sql, ...p) : null),
    () => (store && typeof store.execute === 'function' ? store.execute(sql, ...p) : null),
    () => (store && typeof store.prepare === 'function' ? store.prepare(sql).bind(...p).run() : null),
  ];
  for (const t of tries) { try { const r = await t(); if (r != null) return r; } catch { /* 次の口 */ } }
  return null;
}
const unwrap = (r) => { if (r == null) return null; if (Array.isArray(r)) return r; if (Array.isArray(r.results)) return r.results; return r; };
async function q1(store, sql, ...p) {
  const tries = [
    () => (store && typeof store.first === 'function' ? store.first(sql, ...p) : null),
    () => (store && typeof store.get === 'function' ? store.get(sql, ...p) : null),
    () => (store && typeof store.query === 'function' ? store.query(sql, ...p) : null),
    () => (store && typeof store.prepare === 'function' ? store.prepare(sql).bind(...p).first() : null),
  ];
  for (const t of tries) { try { const r = await t(); if (r != null) return unwrap(r); } catch { /* 次の口 */ } }
  return null;
}
async function qa(store, sql, ...p) {
  const tries = [
    () => (store && typeof store.all === 'function' ? store.all(sql, ...p) : null),
    () => (store && typeof store.query === 'function' ? store.query(sql, ...p) : null),
    () => (store && typeof store.first === 'function' ? store.first(sql, ...p) : null),
    () => (store && typeof store.prepare === 'function' ? store.prepare(sql).bind(...p).all() : null),
  ];
  for (const t of tries) { try { const r = await t(); const u = unwrap(r); if (Array.isArray(u)) return u; } catch { /* 次の口 */ } }
  return [];
}
export async function ensureDirectTables(store) {
  await run(store, `CREATE TABLE IF NOT EXISTS ${DK} (id TEXT PRIMARY KEY, at TEXT, text TEXT, lang TEXT, intent TEXT, plan_json TEXT, steps_json TEXT, state TEXT, tries INTEGER, result_json TEXT, note TEXT, updated_at TEXT)`).catch(() => {});
  await run(store, `CREATE INDEX IF NOT EXISTS idx_directives_at ON ${DK} (at)`).catch(() => {});
  await run(store, `CREATE INDEX IF NOT EXISTS idx_directives_state ON ${DK} (state)`).catch(() => {});
}

// ---------------------------------------------------------------- 実行
/** 1手を実行して、証拠が出たかまで見る。 */
export async function runStep(lever, ctx = {}) {
  const started = Date.now();
  if (lever === 'status') {
    const { gatherStatus } = await import('./director.js');
    const s = await gatherStatus(ctx);
    return { lever, ok: true, ms: Date.now() - started, evidence: s, change: 'status' };
  }
  try {
    const { runLever } = await import('./grow.js');
    const r = await runLever(lever, ctx);
    return { lever, ok: !!(r && r.ok), change: r && r.change, human_only: !!(r && r.human_only), ms: Date.now() - started, evidence: (r && r.evidence) || {} };
  } catch (e) {
    return { lever, ok: false, ms: Date.now() - started, evidence: { error: clip(e && e.message, 200) } };
  }
}

/** 手の成否を中身で判定する（空の証拠は成功と見なさない）。 */
export function verified(step = {}) {
  if (!step.ok) return false;
  const e = step.evidence || {};
  if (e.error || e.skipped) return false;
  const keys = Object.keys(e).filter((k) => e[k] != null && e[k] !== '' && e[k] !== 0 && !(Array.isArray(e[k]) && !e[k].length));
  return keys.length > 0;
}

/**
 * 指示を1件、最後まで走らせる。
 * - 計画 → 手を順に実行 → 検証 → 失敗なら同じ手をもう一度（証拠が変わる可能性がある）→ 代替手
 * - 途中経過を每手ごとに保存するので、途中で落ちても記録が残る
 */
export async function runDirective({ store, env = {}, deps = {}, text, intent = null, ai = null, now = null, maxTries = MAX_TRIES, id = null } = {}) {
  await ensureDirectTables(store);
  const t = clip(String(text || '').trim(), 600);
  if (!t) return { ok: false, error: 'empty_instruction' };
  const at = now || nowIso();
  const docId = id || rid('d');
  // 指示の門番（ASI01）: 出所が owner 以外、または認証情報・門の無効化・入金操作を求める文は実行しない。
  const guard = guardDirective(t, { origin: 'owner' });
  if (guard.deny) {
    await save(store, { id: docId, at, text: t, lang: guessLang(t), intent: 'refused', plan: { intent: 'refused', label: '拒否', steps: [], fallback: [], why: guard.reason },
      steps: [], state: 'refused', tries: 0, result: { error: 'refused', tag: guard.tag, reason: guard.reason }, note: '危険な指示として何も実行しなかった' });
    return { ok: false, id: docId, state: 'refused', intent: 'refused', steps: [], error: 'refused', reason: guard.reason, tag: guard.tag };
  }
  let resolved = intent || parseDirective(t);
  let how = resolved ? 'words' : null;
  // 決定的に決まらないときだけ、無料枠のAIに分類を頼む。頼めなければ blocked。
  if (!resolved && ai) {
    try {
      const out = await ai({ role: 'direct_router', json: true, maxTokens: 200,
        system: '指示を次のどれか1つに分類する。JSONだけを返す。',
        user: `指示: ${t}\n候補: ${INTENTS.map((i) => i.key).join(', ')}\nどの候補にも当てはまらない場合は none を選ぶ。形: {"intent":"<key|none>"}` });
      const txt = typeof out === 'string' ? out : (out && (out.text || out.content)) || '';
      const m = String(txt).match(/"intent"\s*:\s*"([a-z_]+)"/);
      if (m && intentByKey(m[1])) { resolved = m[1]; how = 'ai'; }
    } catch { /* 分類できなければ blocked として記録する */ }
  }
  if (!resolved) {
    const plan = { intent: 'unknown', label: '判別できず', steps: [], fallback: [], why: '語彙でも無料AIでも決まらなかった' };
    await save(store, { id: docId, at, text: t, lang: guessLang(t), intent: 'unknown', plan, steps: [], state: 'blocked', tries: 0, result: { error: 'unknown_intent', hint: '例: 「新しい分野を探して」「githubで良いリポジトリを取り入れて」「市場を測って」' }, note: '判別できなかったので何も実行していない' });
    return { ok: false, id: docId, state: 'blocked', intent: 'unknown', steps: [], error: 'unknown_intent' };
  }
  const plan = planFor(resolved);
  let state = 'running';
  const steps = [];
  const planned = plan.steps.slice();
  const fallbacks = plan.fallback.slice();
  // 計画の手は「順に全部」やる。1つが通っても次へ進む。
  // 同じ手は証拠が出るまで最大 maxTries 回。出なければ代替手に切り替える。
  let plannedOk = 0;
  for (const lever of planned) {
    const attempts = Math.max(1, num(maxTries, MAX_TRIES));
    let ok = false;
    for (let a = 0; a < attempts && !ok; a += 1) {
      const r = await runStep(lever, { store, env, deps, force: true });
      ok = verified(r);
      steps.push({ ...r, ok, kind: 'planned', attempt: a + 1 });
      await save(store, { id: docId, at, text: t, lang: guessLang(t), intent: plan.intent, plan, steps, state: 'running', tries: steps.length, result: null, note: how ? ('分類:' + how) : null });
    }
    if (ok) plannedOk += 1;
  }
  const allOk = planned.length > 0 && plannedOk === planned.length;
  if (!allOk) {
    for (const lever of fallbacks) {
      const r = await runStep(lever, { store, env, deps, force: true });
      const ok = verified(r);
      steps.push({ ...r, ok, kind: 'fallback', attempt: 1 });
      await save(store, { id: docId, at, text: t, lang: guessLang(t), intent: plan.intent, plan, steps, state: 'running', tries: steps.length, result: null, note: how ? ('分類:' + how) : null });
      if (ok) break;
    }
  }
  const anyOk = steps.some((x) => x.ok);
  state = allOk ? 'done' : (anyOk ? (steps.some((x) => x.kind === 'fallback' && x.ok) ? 'done_alternate' : 'done_partial') : 'blocked');
  const kept = steps.filter((s) => s.ok);
  const result = {
    ok: anyOk, intent: plan.intent, label: plan.label, classified_by: how,
    ran: steps.map((s) => ({ lever: s.lever, ok: s.ok, kind: s.kind, attempt: s.attempt, ms: s.ms, evidence: brief(s.evidence) })),
    kept: kept.map((s) => s.lever), tries: steps.length,
    note: anyOk ? '証拠が出た手だけを成功として数えている。' : 'どの手も証拠を出せなかった。',
  };
  await save(store, { id: docId, at, text: t, lang: guessLang(t), intent: plan.intent, plan, steps, state, tries: steps.length, result, note: how ? `分類:${how}` : null });
  return { id: docId, state, ...result };
}

const brief = (e = {}) => {
  const o = {};
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (typeof v === 'string') o[k] = clip(v, 160);
    else if (typeof v === 'number' || typeof v === 'boolean' || v == null) o[k] = v;
    else if (Array.isArray(v)) o[k] = v.slice(0, 6).map((x) => (typeof x === 'object' ? clip(JSON.stringify(x), 120) : x));
    else o[k] = clip(JSON.stringify(v), 200);
  }
  return o;
};

async function save(store, d = {}) {
  const json = (v) => (v == null ? null : JSON.stringify(v));
  await run(store, `INSERT INTO ${DK} (id,at,text,lang,intent,plan_json,steps_json,state,tries,result_json,note,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET intent=excluded.intent, plan_json=excluded.plan_json, steps_json=excluded.steps_json, state=excluded.state, tries=excluded.tries, result_json=excluded.result_json, note=excluded.note, updated_at=excluded.updated_at`,
    d.id, d.at, d.text, d.lang || guessLang(d.text), d.intent || null, json(d.plan), json(d.steps), d.state || 'running', num(d.tries), json(d.result), d.note || null, nowIso()).catch(() => {});
}

/** D1 の実装差で JSON が文字列で返ることがあるので、読める形に戻す。 */
const jn = (v) => {
  if (typeof v !== 'string') return v == null ? null : v;
  const t = v.trim();
  if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return v;
  try { return JSON.parse(v); } catch { return v; }
};

export function guessLang(t = '') {
  const s = String(t || '');
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(s)) return 'ja';
  if (/[\uac00-\ud7af]/.test(s)) return 'ko';
  if (/[\u0600-\u06ff]/.test(s)) return 'ar';
  if (/[\u0400-\u04ff]/.test(s)) return 'ru';
  return 'en';
}

/** いまの状態を1つの塊にする（レポートの材料。実行はしない）。 */
export async function gatherStatus(ctx = {}) {
  const { store } = ctx;
  const out = { at: nowIso(), revenue: null, hits: null, market: null, catalog: [], channels: null, frontier: null, repos: null };
  try {
    out.revenue = jn(await q1(store, `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM ledger WHERE kind='revenue' AND basis<>'self_test'`));
  } catch { /* 読めなくても続ける */ }
  try {
    out.hits = await q1(store, `SELECT COUNT(*) AS reached FROM x402_hits`);
  } catch { /* 読めなくても続ける */ }
  try {
    const m = await q1(store, 'SELECT at,snapshot,services,payers,calls FROM market_scans ORDER BY at DESC LIMIT 1');
    out.market = jn(m);
  } catch { /* 読めなくても続ける */ }
  try {
    const s = await q1(store, `SELECT value FROM settings WHERE key='x402:extra_catalog'`);
    out.catalog_extra = s && s.value ? clip(s.value, 400) : null;
  } catch { /* 読めなくても続ける */ }
  try {
    const ch = await q1(store, `SELECT COUNT(*) AS n, SUM(CASE WHEN status='listed' THEN 1 ELSE 0 END) AS listed FROM hunt_channels`);
    out.channels = jn(ch);
  } catch { /* 読めなくても続ける */ }
  return out;
}

/** 未処理の指示を拾って1件だけ実行する（cron から回す口）。 */
export async function directiveTick({ store, env = {}, deps = {}, ai = null, now = null } = {}) {
  await ensureDirectTables(store);
  const max = Math.max(1, num(env.DIRECT_MAX_PER_TICK, DIRECT_MAX_PER_TICK));
  const due = await qa(store, `SELECT id,text,intent FROM ${DK} WHERE state IN ('queued','running') ORDER BY at ASC LIMIT ?`, max);
  const ran = [];
  for (const d of due) {
    const r = await runDirective({ store, env, deps, text: d.text, intent: d.intent || null, ai, id: d.id, now });
    ran.push({ id: d.id, intent: r.intent, state: r.state, kept: r.kept });
  }
  return { ok: true, ran: ran.length, results: ran, pending: Math.max(0, due.length - ran.length) };
}

/** 自然言語の指示を受け付ける（実行せずに並べるだけの口）。 */
export async function queueDirective({ store, text, now = null } = {}) {
  await ensureDirectTables(store);
  const t = clip(String(text || '').trim(), 600);
  if (!t) return { ok: false, error: 'empty_instruction' };
  const id = rid('d');
  const guess = parseDirective(t);
  await run(store, `INSERT INTO ${DK} (id,at,text,lang,intent,plan_json,steps_json,state,tries,result_json,note,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, now || nowIso(), t, guessLang(t), guess, null, null, 'queued', 0, null, guess ? '語彙で分類済み' : 'AIで分類する', now || nowIso()).catch(() => {});
  return { ok: true, id, intent: guess, state: 'queued', plan: guess ? planFor(guess) : null };
}

// ---------------------------------------------------------------- 読み出し
export async function directStatus(store, { limit = 20 } = {}) {
  await ensureDirectTables(store);
  const rows = await qa(store, `SELECT id,at,text,intent,state,tries,result_json,note,updated_at FROM ${DK} ORDER BY at DESC LIMIT ?`, Math.max(1, Math.min(100, limit)));
  const pending = await q1(store, `SELECT COUNT(*) AS n FROM ${DK} WHERE state IN ('queued','running')`);
  return { ok: true, version: DIRECT_VERSION, pending: num(pending && pending.n),
    directives: rows.map((r) => ({ id: r.id, at: r.at, text: clip(r.text, 160), intent: r.intent, state: r.state, tries: num(r.tries), note: r.note, result: safeObj(r.result_json) })),
    intents: INTENTS.map((i) => ({ key: i.key, label: i.label, lever: i.lever, fallback: i.fallback, words: i.words.slice(0, 6) })) };
}

export function directText(s = {}) {
  const L = [];
  L.push(`自然言語の指示（${DIRECT_VERSION}） — 未処理 ${s.pending || 0}件`);
  L.push('');
  if (!(s.directives || []).length) L.push('（まだ指示はありません）');
  for (const d of s.directives || []) {
    const r = d.result || {};
    L.push(`${d.at}  [${d.state}] ${d.intent || '?'}  試行${d.tries}  「${d.text}」`);
    if ((r.ran || []).length) L.push('   ' + r.ran.map((x) => `${x.lever}=${x.ok ? 'ok' : 'ng'}`).join(' / '));
  }
  L.push('', '使える言い方の例:');
  for (const i of s.intents || []) L.push(` - 「${i.words[0]}…」→ ${i.label}（${i.lever.join(' → ')}）`);
  return L.join('\n');
}

export function directHelp(base = '') {
  return ['direct-1.0 — 自然言語の指示で自律トライアンドエラーする口',
    '', 'POST ' + base + '/api/direct        {"text":"GitHubでいいリポジトリ取り入れて","run":true}  … 実行まで',
    'POST ' + base + '/api/direct        {"text":"…"}                                       … 並べるだけ（cronが拾う）',
    'GET  ' + base + '/api/direct        直近の指示と結果',
    'GET  ' + base + '/api/direct?format=text',
    'GET  ' + base + '/api/direct/help   この説明',
    '', '実行は既存の検証済みレバーに写像される（新しい実行経路は増やさない）。',
    '証拠が出なかった手は成功と数えず、同じ手をもう一度→代替手の順で試す。',
    '判別できない指示は何も実行せず blocked として理由を残す。'].join('\n');
}

const safeObj = (j) => { try { return JSON.parse(j || 'null'); } catch { return null; } };
