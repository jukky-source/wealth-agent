// frontier-1.0 — 「AIエージェントが自律で稼げる分野」を常に探索する思考ループ。
//
// 目的: 1つの売り場（x402 Bazaar）の中だけで最適化しても天井がある（実測で市場全体
//       約 $10,000/30日）。そこで「分野そのもの」を定期的に見直し、原価0で増やせる
//       手を名指しし続ける。ここは実行ではなく思考（learn）の層で、実行は既存の
//       レバー（product_launch / channel_hunt / directive など）が担う。
//
// 原理: 主張は必ず実測に紐づける。実測が無い案は evidence='ai_only' として
//       点を下げて並べるだけで、「有望」とは言わない。

export const FRONTIER_VERSION = 'frontier-1.0';
export const FD = 'frontier_domains';
export const FI = 'frontier_ideas';
export const FSTATE = 'frontier:state';
export const FRONTIER_EVERY_MINUTES = 150;

const nowIso = () => new Date().toISOString();
export const clip = (s, n = 300) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) : t; };
const rid = (p = 'fi') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const unwrap = (r) => { if (r == null) return null; if (Array.isArray(r)) return r; if (Array.isArray(r.results)) return r.results; return r; };

export async function q1(store, sql, ...p) {
  const tries = [
    () => (store && typeof store.first === 'function' ? store.first(sql, ...p) : null),
    () => (store && typeof store.get === 'function' ? store.get(sql, ...p) : null),
    () => (store && typeof store.query === 'function' ? store.query(sql, ...p) : null),
    () => (store && typeof store.all === 'function' ? store.all(sql, ...p) : null),
    () => (store && typeof store.prepare === 'function' ? store.prepare(sql).bind(...p).first() : null),
  ];
  for (const t of tries) {
    try { const r = await t(); if (r != null) return unwrap(r); } catch { /* 次の口を試す */ }
  }
  return null;
}

export async function qa(store, sql, ...p) {
  const tries = [
    () => (store && typeof store.all === 'function' ? store.all(sql, ...p) : null),
    () => (store && typeof store.query === 'function' ? store.query(sql, ...p) : null),
    () => (store && typeof store.select === 'function' ? store.select(sql, ...p) : null),
    () => (store && typeof store.first === 'function' ? store.first(sql, ...p) : null),
    () => (store && typeof store.prepare === 'function' ? store.prepare(sql).bind(...p).all() : null),
  ];
  for (const t of tries) {
    try { const r = await t(); const u = unwrap(r); if (Array.isArray(u)) return u; } catch { /* 次の口を試す */ }
  }
  return [];
}

async function run(store, sql, ...p) {
  const tries = [
    () => (store && typeof store.run === 'function' ? store.run(sql, ...p) : null),
    () => (store && typeof store.execute === 'function' ? store.execute(sql, ...p) : null),
    () => (store && typeof store.prepare === 'function' ? store.prepare(sql).bind(...p).run() : null),
  ];
  for (const t of tries) {
    try { const r = await t(); if (r != null) return r; } catch { /* 次の口を試す */ }
  }
  return null;
}

async function setting(store, key, fallback = null) {
  const r = await q1(store, 'SELECT value FROM settings WHERE key=?', key);
  return r && r.value != null ? r.value : fallback;
}
async function setSetting(store, key, value) {
  return run(store, 'INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', key, String(value == null ? '' : value), nowIso());
}

// --------------------------------------------------------------- 分野の一覧
// evidence: 我々が実際に測った「支払者がいる市場のカテゴリ」と対応させる。
// autonomy: 人が要る手が少ないほど高い（3=ほぼ無人 / 0=人が必須）。
// buildable: 既存の実行部品だけで始められるか。
// cost0: 原価0で試せるか（この制約を外す提案は出さない）。
export const DOMAINS = [
  { key: 'x402_api', label: '機械可読APIの直販', evidence_cat: 'other', autonomy: 3, buildable: true, cost0: true,
    note: '402を返して自動で納品する形。すでに稼働中で外部入金1件を実測。',
    first_step: '支払者数の多いカテゴリの単機能APIを1品ずつ増やす（既存レバー product_launch）' },
  { key: 'marketplace_listing', label: '売り場への出品', evidence_cat: null, autonomy: 2, buildable: true, cost0: true,
    note: '宣言された登録APIだけ自動。審査・本人確認がある売り場は人の1タップ。',
    first_step: 'GitHub の索引リポジトリから「投稿を受け付ける売り場」を集めて channel_hunt に流す' },
  { key: 'agent_tool_mcp', label: 'エージェントの道具棚（MCP tool）', evidence_cat: 'other', autonomy: 3, buildable: true, cost0: true,
    note: 'MCP はエージェントが道具を探す場所。x402 と同じ品を MCP 面にも出す。',
    first_step: 'MCP 面の呼び出し回数を実測し、有料化の線を引く' },
  { key: 'data_curation', label: '独自データの販売', evidence_cat: 'other', autonomy: 3, buildable: true, cost0: true,
    note: '自分で測った索引（x402-index / 生存 / 価格帯）は他が持っていない。',
    first_step: '無料の見出しだけでなく深い照会を有料化する' },
  { key: 'bounty_agent', label: '報奨金・懸賞（働いて現金）', evidence_cat: null, autonomy: 2, buildable: false, cost0: true,
    note: 'AIが作業して現金を受け取る形。支払いの証拠がある懸賞は今のところ0件。',
    first_step: '支払い実績が確認できる懸賞だけを対象にする（既存 bounty レーン）' },
  { key: 'content_ai', label: 'AIコンテンツ→有料面への流入', evidence_cat: null, autonomy: 1, buildable: false, cost0: true,
    note: '投稿文の作成は自動、公開は人の承認（既存のゲート）。',
    first_step: '無料の呼び水（索引ページ）から有料APIへの導線を測る' },
  { key: 'task_outsourcing', label: 'AI代行（受託・時給型）', evidence_cat: null, autonomy: 1, buildable: false, cost0: true,
    note: '相手の依頼をAIが処理して納品。単価は高いが人が契約する。',
    first_step: '依頼の入口（フォーム）と受注の条件を決めて掲示する' },
  { key: 'evaluation', label: 'AIによる審査・格付け（judge）', evidence_cat: 'search', autonomy: 3, buildable: true, cost0: true,
    note: '審査そのものを売る。判定の根拠を返せるのが強み。',
    first_step: '既存の code-review / surface-report を「格付け＋根拠」の形に整える' },
  { key: 'monitoring', label: '監視・通知（webhook）', evidence_cat: 'other', autonomy: 3, buildable: false, cost0: true,
    note: '継続課金に最も近い形。今は通知先が未設定で外部送信できない。',
    first_step: '通知先URLを1本用意し、監視の定期実行を売る' },
  { key: 'onchain_service', label: 'オンチェーン実行（残高・清算）', evidence_cat: 'balance', autonomy: 3, buildable: true, cost0: true,
    note: 'RPC は無料の公開ノードで足りる（実測で publicnode が 200）。',
    first_step: '残高照会を複数チェーンへ広げる（実測で balance は支払者531人）' },
  { key: 'trading', label: '金融（FX・合成EA）', evidence_cat: null, autonomy: 2, buildable: false, cost0: true,
    note: '検証は自作で原価0。ただし実弾の前に人が判断する。',
    first_step: '検証済みの論理だけを掲示し、成績の捏造をしない' },
  { key: 'research_report', label: '調査レポートの販売', evidence_cat: 'llm', autonomy: 3, buildable: true, cost0: true,
    note: '既存の rea-report が該当。llm カテゴリは支払者426人。',
    first_step: '「毎回中身が変わるレポート」の型を増やす' },
];

export const domainByKey = (k) => DOMAINS.find((d) => d.key === String(k || '').trim()) || null;

// ------------------------------------------------------------------ 採点
// 実測（evidence）× 自律度 × 原価0 × 新しさ。すべて 0..1 に正規化して重み付けする。
export const WEIGHTS = { evidence: 0.5, autonomy: 0.25, cost0: 0.15, novelty: 0.1 };

export function scoreDomain(d = {}, ev = {}, ctx = {}) {
  const payers = num(ev.payers, 0);
  const calls = num(ev.calls, 0);
  const price = ev.median_price_usd == null ? null : num(ev.median_price_usd, 0);
  const maxPayers = Math.max(1, num(ctx.maxPayers, 859));
  const maxCalls = Math.max(1, num(ctx.maxCalls, 6725));
  const maxPrice = Math.max(0.0005, num(ctx.maxPrice, 0.08));
  // 実測を3つに割る: 買い手の数 0.45 / 呼び出し量 0.35 / 単価 0.20。
  // 分野どうしの相対で正規化するので、100人で頭打ちにならず、支払者2人の差も点に出る。
  const lp = (x, m) => Math.log10(1 + Math.max(0, x)) / Math.log10(1 + Math.max(1, m));
  const evidence = ev.measured
    ? Math.min(1, lp(payers, maxPayers) * 0.45 + lp(calls, maxCalls) * 0.35 + (price == null ? 0 : Math.min(1, price / maxPrice) * 0.20))
    : 0;
  const autonomy = Math.min(1, num(d.autonomy, 0) / 3);
  const cost0 = d.cost0 ? 1 : 0;
  const tried = num(ctx.tried, 0);
  const novelty = Math.max(0, 1 - tried / 6); // 何度も試した分野は新しさが減る
  const score = evidence * WEIGHTS.evidence + autonomy * WEIGHTS.autonomy + cost0 * WEIGHTS.cost0 + novelty * WEIGHTS.novelty;
  return { score: Number(score.toFixed(4)), parts: { evidence: Number(evidence.toFixed(4)), payers, calls, price_usd: price, autonomy: Number(autonomy.toFixed(4)), cost0, novelty: Number(novelty.toFixed(4)) } };
}

/** 実測（market_scans の最新1件）から分野ごとの支払者数・呼び出しを引く。 */
export async function domainEvidence(store) {
  const row = await q1(store, `SELECT at,snapshot,count,services,payers,calls,top_json,bands_json,gaps_json FROM market_scans ORDER BY at DESC LIMIT 1`);
  if (!row) return { measured: false, by_cat: {}, at: null, snapshot: null };
  let top = []; try { top = JSON.parse(row.top_json || '[]'); } catch { top = []; }
  const by = {};
  for (const c of top) by[c.key] = { payers: num(c.payers), calls: num(c.calls), median_price_usd: c.median_price_usd == null ? null : num(c.median_price_usd) };
  return { measured: true, at: row.at, snapshot: row.snapshot, services: num(row.services), payers: num(row.payers), calls: num(row.calls), by_cat: by };
}

/** 分野ごとに「今どうなっているか」を組み立てる（実測が無い分野は正直に 0 と記録）。 */
export function buildBoard(ev = {}, ctx = {}) {
  const out = [];
  const cats = Object.values(ev.by_cat || {});
  const maxPayers = Math.max(1, ...cats.map((c) => num(c.payers, 0)));
  const maxCalls = Math.max(1, ...cats.map((c) => num(c.calls, 0)));
  const maxPrice = Math.max(0.0005, ...cats.map((c) => num(c.median_price_usd, 0)));
  for (const d of DOMAINS) {
    const e = d.evidence_cat && ev.by_cat ? Object.assign({ measured: true }, ev.by_cat[d.evidence_cat] || { payers: 0, calls: 0 }) : { measured: false, payers: 0, calls: 0 };
    const s = scoreDomain(d, e, { tried: (ctx.tried || {})[d.key] || 0, maxPayers, maxCalls, maxPrice });
    out.push({ key: d.key, label: d.label, note: d.note, first_step: d.first_step, autonomy: d.autonomy, buildable: d.buildable,
      evidence_cat: d.evidence_cat, payers: num(e.payers, 0), calls: num(e.calls, 0), measured: !!e.measured,
      score: s.score, parts: s.parts });
  }
  out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return out;
}

/** 上位分野から「次に試す1手」を名指しする（実行は既存レバーが担う）。 */
export function nextActions(board = [], { k = 3 } = {}) {
  return board.slice(0, k).map((b) => ({ domain: b.key, label: b.label, score: b.score, payers: b.payers, measured: b.measured,
    action: b.first_step, buildable: b.buildable, human_needed: b.autonomy < 3 }));
}

// ------------------------------------------------------------------ テーブル
export async function ensureFrontierTables(store) {
  await run(store, `CREATE TABLE IF NOT EXISTS ${FD} (key TEXT PRIMARY KEY, label TEXT, score REAL, payers INTEGER, measured INTEGER, parts_json TEXT, at TEXT)`).catch(() => {});
  await run(store, `CREATE TABLE IF NOT EXISTS ${FI} (id TEXT PRIMARY KEY, at TEXT, domain TEXT, idea TEXT, why TEXT, score REAL, source TEXT, state TEXT, evidence_json TEXT, note TEXT)`).catch(() => {});
  await run(store, 'CREATE INDEX IF NOT EXISTS idx_frontier_ideas_at ON frontier_ideas (at)', []).catch(() => {});
}

// ------------------------------------------------------------------ 1ラウンド
export async function frontierThink({ store, env = {}, deps = {}, ai = null, now = null, force = false } = {}) {
  await ensureFrontierTables(store);
  const everyMin = Math.max(30, num(env.FRONTIER_EVERY_MINUTES, FRONTIER_EVERY_MINUTES));
  const last = await setting(store, `${FSTATE}:last_run_at`, null);
  if (!force && last && Date.now() - new Date(last).getTime() < everyMin * 60e3) {
    return { ok: true, skipped: 'not_due', age_minutes: Math.round((Date.now() - new Date(last).getTime()) / 60000) };
  }
  const ev = await domainEvidence(store);

  // これまで何回試したか（アイデアの本数）＝新しさの減衰に使う。
  const rows = await qa(store, 'SELECT domain, COUNT(*) AS n FROM frontier_ideas GROUP BY domain');
  const tried = {}; for (const r of rows) tried[r.domain] = num(r.n);
  const board = buildBoard(ev, { tried });

  // 無料枠のAIには「分野そのものの追加提案」だけを許す。実測が無いので点は低く置く。
  const ideas = []; let aiError = null;
  if (ai) {
    try {
      const digest = { measured_at: ev.at, sample_services: ev.services, categories: Object.entries(ev.by_cat).map(([k, v]) => ({ k, payers: v.payers, calls: v.calls })).sort((a, b) => b.payers - a.payers).slice(0, 8),
        existing_domains: DOMAINS.map((d) => d.key), ours: ctxOwn(deps) };
      const out = await ai({ role: 'frontier_scout', json: true, maxTokens: 700,
        system: 'あなたは「AIエージェントが原価0で自律的に稼ぐ」分野の調査担当。実測データに無い分野を提案してよいが、根拠の無い数字を書いてはいけない。JSONだけを返す。',
        user: 'いま分かっていること:\n' + JSON.stringify(digest) + '\n\n既存の分野に含まれない、まだ試していない稼ぎ方の分野を最大3つ提案してください。形は {"domains":[{"key":"<英小文字_>","label":"<20字以内>","why":"<100字以内・根拠>","first_step":"<60字以内・原価0で今日できる最初の1手>","autonomy":<0..3>,"cost0":true}]} だけ。' });
      const txt = typeof out === 'string' ? out : (out && (out.text || out.content)) || '';
      const parsed = jsonBlock(txt);
      if (parsed && Array.isArray(parsed.domains)) for (const x of parsed.domains.slice(0, 3)) ideas.push(x);
    } catch (e) { aiError = clip(e && e.message, 160); }
  }

  const at = now || nowIso();
  const saved = [];
  for (const b of board) {
    await run(store, `INSERT INTO ${FD} (key,label,score,payers,measured,parts_json,at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET label=excluded.label, score=excluded.score, payers=excluded.payers, measured=excluded.measured, parts_json=excluded.parts_json, at=excluded.at`,
      b.key, b.label, b.score, b.payers, b.measured ? 1 : 0, JSON.stringify(b.parts), at).catch(() => {});
  }
  for (const a of nextActions(board, { k: 3 })) {
    const id = rid('fi');
    await run(store, `INSERT INTO ${FI} (id,at,domain,idea,why,score,source,state,evidence_json,note) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, at, a.domain, clip(a.action, 300), clip(DOMAINS.find((d) => d.key === a.domain)?.note || '', 300), a.score, 'deterministic', 'proposed',
      JSON.stringify({ payers: a.payers, measured: a.measured, buildable: a.buildable }), null).catch(() => {});
    saved.push({ id, ...a, source: 'deterministic' });
  }
  for (const x of ideas) {
    const key = String(x.key || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
    if (!key || domainByKey(key)) continue; // 既存分野の言い換えは捨てる
    const id = rid('fi');
    await run(store, `INSERT INTO ${FI} (id,at,domain,idea,why,score,source,state,evidence_json,note) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, at, key, clip(x.first_step, 300), clip(x.why, 400), 0.25, 'ai', 'proposed_new_domain',
      JSON.stringify({ autonomy: x.autonomy == null ? null : num(x.autonomy), cost0: !!x.cost0, measured: false }), clip(x.label, 80)).catch(() => {});
    saved.push({ id, domain: key, label: clip(x.label, 40), action: clip(x.first_step, 200), why: clip(x.why, 300), score: 0.25, source: 'ai', measured: false });
  }
  await setSetting(store, `${FSTATE}:last_run_at`, at);
  const top = board[0] || null;
  return { ok: true, at, measured: ev.measured, measured_at: ev.at, board, next: nextActions(board, { k: 3 }),
    ai_available: !!ai, ai_error: aiError, new_domains_from_ai: ideas.length, ideas_saved: saved.length, top: top && { key: top.key, label: top.label, score: top.score, payers: top.payers } };
}

const ctxOwn = (deps) => {
  try {
    const c = (deps && (deps.catalog_list || deps.own)) || [];
    return Array.isArray(c) ? c.slice(0, 20) : [];
  } catch { return []; }
};

/** 無料AIの応答から JSON ブロックだけ取り出す（前置き・コードフェンス許容）。 */
export function jsonBlock(text = '') {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const a = body.indexOf('{'); const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

// ------------------------------------------------------------------ 読み出し
export async function frontierStatus(store) {
  await ensureFrontierTables(store);
  const board = (await qa(store, `SELECT key,label,score,payers,measured,parts_json,at FROM ${FD} ORDER BY score DESC`)).map((r) => ({
    key: r.key, label: r.label, score: num(r.score), payers: num(r.payers), measured: !!num(r.measured),
    parts: safe(r.parts_json), at: r.at,
  }));
  const ideas = await qa(store, `SELECT id,at,domain,idea,why,score,source,state FROM ${FI} ORDER BY at DESC LIMIT 30`);
  const state = { version: FRONTIER_VERSION, every_minutes: FRONTIER_EVERY_MINUTES, last_run_at: await setting(store, `${FSTATE}:last_run_at`, null),
    domains: DOMAINS.length, measured: !!(await q1(store, 'SELECT 1 AS x FROM market_scans LIMIT 1')) };
  return { ok: true, state, board, ideas, next: nextActions(board, { k: 3 }), weights: WEIGHTS, ai_only: ideas.filter((i) => i.source === 'ai').length };
}

export function frontierPublic(s = {}) {
  return { version: FRONTIER_VERSION, measured_at: (s.state || {}).last_run_at || null,
    domains_ranked: (s.board || []).map((b) => ({ key: b.key, label: b.label, score: b.score, payers: b.payers })),
    next: (s.next || []).map((n) => ({ domain: n.domain, label: n.label, action: n.action })),
    note: '実測（支払者が確認できた市場）に基づく分野ランキング。実測が無い分野は0点。' };
}

export function frontierText(s = {}) {
  const L = [];
  L.push(`分野ランキング（${FRONTIER_VERSION}）  — 実測 ${s.measured_at || '未測定'}`);
  L.push('');
  for (const b of s.board || []) L.push(`${b.score.toFixed(3)}  ${b.key.padEnd(20)} 支払者=${String(b.payers).padStart(5)}${b.measured ? '' : ' (実測なし)'}  ${clip(b.label, 30)}`);
  L.push('');
  L.push('次に試す手:');
  for (const n of s.next || []) L.push(` - [${n.domain}] ${n.action}${n.human_needed ? '（人の1タップ要）' : ''}`);
  if (s.ai_only) L.push('', `AIによる新分野の提案: ${s.ai_only}件（実測が無いので点は低く置いている）`);
  return L.join('\n');
}

export function frontierHelp(base = '') {
  return ['frontier-1.0 — 「AIエージェントが自律で稼げる分野」を定期的に見直す思考ループ',
    '', 'GET  ' + base + '/api/frontier            盤面（分野ランキング・実測・次に試す手）',
    'GET  ' + base + '/api/frontier?format=text 同じ内容を読みやすい文字で',
    'GET  ' + base + '/api/frontier/public      公開版（実測に基づく順位だけ）',
    'POST ' + base + '/api/frontier/think     いますぐ1回考える（{force:true}で間隔を無視）',
    '', '採点 = 実測0.50 + 自律度0.25 + 原価0 0.15 + 新しさ0.10（実測が無い分野は0点）'].join('\n');
}

const safe = (j) => { try { return JSON.parse(j || '{}'); } catch { return {}; } };
