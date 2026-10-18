// REA の自動投入キュー — X / Reddit / scout / perks が拾った「有益そうなサイト・サービス」を
// 人が並べなくても自動で解析に回す。原価0（読み取りだけ・鍵なし・登録なし）。
//
// 流れ: 収集（twitter_posts / scout_findings / perks）→ ここで対象化（rea_targets）
//       → inspectRea で表面解析 → 結果を rea_runs に記録 → 使えると分かったものは
//       playbook に変換して「試す → 記録する」ループに渡す。
import { inspectRea, recordRun } from './rea.js';
import { T as PB_T } from './playbook.js';

export const RT = 'rea_targets';
export const REA_QUEUE_VERSION = '1.0';

const nowIso = () => new Date().toISOString();
const id = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
function h10(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i += 1) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}
export const targetKey = (url) => 'rt_' + h10(String(url || '').trim().toLowerCase());
function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }
async function q1(store, sql, ...a) { try { const r = await store.first(sql, ...a); return r ? Number(Object.values(r)[0] || 0) : 0; } catch { return 0; } }

export async function ensureReaQueueTable(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${RT} (
    id TEXT PRIMARY KEY, key TEXT NOT NULL, target TEXT, source TEXT, title TEXT,
    score INTEGER DEFAULT 0, status TEXT DEFAULT 'queued', tries INTEGER DEFAULT 0,
    last_at TEXT, result_json TEXT, playbook_key TEXT, created_at TEXT)`);
  await store.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${RT}_key ON ${RT}(key)`);
  await store.run(`CREATE INDEX IF NOT EXISTS ${RT}_status ON ${RT}(status, score)`);
}

/** 収集済みの外部情報から、解析対象を自動で積む。同じ URL は1件だけ。 */
export async function enqueueFromFindings(store, { limit = 12, minScore = 4, now = null } = {}) {
  const at = now || nowIso();
  await ensureReaQueueTable(store);
  const cands = [];
  const push = (url, title, score, source) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return;
    cands.push({ url: u, title: String(title || u).replace(/\s+/g, ' ').slice(0, 110), score: Number(score || 0), source });
  };
  try { for (const r of (await store.all(`SELECT url, text AS title, score, handle FROM twitter_posts WHERE url IS NOT NULL AND url <> '' AND COALESCE(score,0) >= ? ORDER BY score DESC LIMIT ?`, minScore, limit)) || []) push(r.url, r.title, r.score, 'x:' + (r.handle || '')); } catch { /* 無い環境は飛ばす */ }
  try { for (const r of (await store.all(`SELECT url, title, score, source_id FROM scout_findings WHERE url IS NOT NULL AND url <> '' ORDER BY score DESC LIMIT ?`, limit)) || []) push(r.url, r.title, r.score, 'scout:' + (r.source_id || '')); } catch { /* 同上 */ }
  try { for (const r of (await store.all(`SELECT url, title, site FROM perks WHERE url IS NOT NULL AND url <> '' ORDER BY created_at DESC LIMIT ?`, limit)) || []) push(r.url, r.title || r.site, 6, 'perks'); } catch { /* 同上 */ }
  try { for (const r of (await store.all(`SELECT url, title, score, kind FROM ${PB_T} WHERE url IS NOT NULL AND url <> '' ORDER BY COALESCE(score,0) DESC LIMIT ?`, limit)) || []) push(r.url, r.title, r.score, 'playbook:' + (r.kind || '')); } catch { /* 同上 */ }

  let inserted = 0, skipped = 0;
  const added = [];
  for (const c of cands) {
    const key = targetKey(c.url);
    let dup = null;
    try { dup = await store.first(`SELECT id FROM ${RT} WHERE key = ? LIMIT 1`, key); } catch { dup = null; }
    if (dup) { skipped += 1; continue; }
    try {
      await store.run(
        `INSERT INTO ${RT} (id,key,target,source,title,score,status,tries,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        id('rt'), key, c.url, c.source, c.title, c.score, 'queued', 0, at,
      );
      inserted += 1; added.push({ url: c.url, title: c.title, source: c.source });
    } catch { skipped += 1; }
  }
  return { at, scanned: cands.length, inserted, skipped, added: added.slice(0, 8) };
}

/** 解析結果 → ネタ帳（試すループ）へ。売れる形／取り込める形が分かったものだけ変換する。 */
export function analysisToPlaybook(t = {}, s = {}) {
  const url = String(t.target || '').trim();
  if (!url) return null;
  const caps = (s.capabilities || []).length;
  const tools = ((s.mcp || {}).tools || []).length;
  const kind = (s.kind === 'mcp' || s.kind === 'documented-api' || s.kind === 'api') ? 'api' : (caps >= 4 ? 'demand' : 'content');
  const at = nowIso();
  const why = kind === 'api'
    ? `公開されている入口が実測できた（${s.kind}${tools ? ` / ツール${tools}本` : ''}）。値札を付けて直販する候補になる`
    : kind === 'demand'
      ? `できることが${caps}件、根拠つきで確認できた。困っている人に当てる道具として使える`
      : `解析結果をデータ／記事として出せる（できること${caps}件・不明${(s.unknown || []).length}件）`;
  return {
    id: id('pb'), key: 'ra_' + h10(url), kind,
    title: `${hostOf(url)} の表面解析（${s.kind || 'unknown'}・確度${s.score || 0}/10）`.slice(0, 110),
    site: hostOf(url), url, why_money: why,
    how: [
      '解析結果（できること・根拠・不明）を読む',
      'できることの中から、原価0で1つだけ実際に呼ぶ／叩く',
      '呼べたかどうかを結果として残す',
      '呼べたら値札を付けて売り場に出す（掲載は人の1タップ）',
    ],
    first_step: 'いちばん確度の高い入口を1回だけ叩いて、応答を確かめる',
    cost_jpy: 0, human: ['売り場への掲載（1タップ）'], probe: 'http',
    score: Number(s.score || 0) * 5, source_id: String(t.source || '').slice(0, 40),
    status: 'new', tries: 0, created_at: at, updated_at: at,
  };
}

/** キューを上から解析する。原価0・読み取りのみ。結果は rea_runs と rea_targets の両方に残す。 */
export async function autoAnalyze(store, { limit = 3, fetchImpl = null, now = null, derive = true } = {}) {
  const at = now || nowIso();
  await ensureReaQueueTable(store);
  const rows = await store.all(`SELECT * FROM ${RT} WHERE status = 'queued' ORDER BY COALESCE(score,0) DESC, created_at ASC LIMIT ?`, Math.max(1, Math.min(10, Number(limit) || 3)));
  const out = [];
  for (const r of rows || []) {
    let s = null;
    try { s = await inspectRea(r.target, fetchImpl ? { fetchImpl, now: at } : { now: at }); }
    catch (e) { s = { ok: false, kind: 'unknown', mode: 'remote', state: 'failed', score: 0, capabilities: [], unknown: [String((e && e.message) || e).slice(0, 120)], steps: [{ step: 'fetching', state: 'failed' }] }; }
    const state = String(s.state || (s.ok ? 'done' : 'failed'));
    const status = state === 'done' ? 'analyzed' : (state === 'handoff' ? 'handoff' : 'failed');
    const result = {
      kind: s.kind || 'unknown', mode: s.mode || 'remote', state, score: Number(s.score || 0),
      caps: (s.capabilities || []).map((c) => c.what || c.id || String(c)).slice(0, 8),
      unknowns: (s.unknown || []).slice(0, 6),
      mcp_tools: ((s.mcp || {}).tools || []).map((x) => x.name).slice(0, 20),
    };
    try {
      await store.run(`UPDATE ${RT} SET status = ?, tries = COALESCE(tries,0) + 1, last_at = ?, result_json = ? WHERE id = ?`,
        status, at, JSON.stringify(result), r.id);
    } catch { /* 記録に失敗しても解析自体は続ける */ }
    try { await recordRun(store, s); } catch { /* 同上 */ }

    let derived = null;
    if (derive && state === 'done') {
      const pb = analysisToPlaybook({ target: r.target, source: r.source }, s);
      if (pb) {
        try {
          const dup = await store.first(`SELECT id FROM ${PB_T} WHERE key = ? LIMIT 1`, pb.key);
          if (!dup) {
            await store.run(
              `INSERT INTO ${PB_T} (id,key,kind,title,site,url,why_money,how_json,first_step,cost_jpy,human_json,probe,score,source_id,status,tries,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              pb.id, pb.key, pb.kind, pb.title, pb.site, pb.url, pb.why_money, JSON.stringify(pb.how || []),
              pb.first_step, pb.cost_jpy, JSON.stringify(pb.human || []), pb.probe, pb.score, pb.source_id, pb.status, 0, pb.created_at, pb.updated_at,
            );
            derived = pb.key;
            await store.run(`UPDATE ${RT} SET playbook_key = ? WHERE id = ?`, pb.key, r.id).catch(() => {});
          } else { derived = dup.id; }
        } catch { derived = null; }
      }
    }
    out.push({ target: r.target, source: r.source, kind: result.kind, state, status, score: result.score, caps: result.caps.length, derived });
  }
  return { at, analyzed: out.length, queued_left: await q1(store, `SELECT COUNT(*) FROM ${RT} WHERE status = 'queued'`), rows: out };
}

export async function queueSummary(store) {
  await ensureReaQueueTable(store);
  const byStatus = {};
  for (const r of (await store.all(`SELECT status, COUNT(*) AS n FROM ${RT} GROUP BY status`).catch(() => [])) || []) byStatus[r.status || 'other'] = r.n;
  const byKind = {};
  for (const r of (await store.all(`SELECT kind, COUNT(*) AS n FROM (SELECT json_extract(result_json,'$.kind') AS kind FROM ${RT} WHERE result_json IS NOT NULL) WHERE kind IS NOT NULL GROUP BY kind`).catch(() => [])) || []) byKind[r.kind || 'other'] = r.n;
  const recent = (await store.all(`SELECT target, source, status, score, substr(COALESCE(result_json,''),1,220) AS result, last_at FROM ${RT} WHERE tries > 0 ORDER BY last_at DESC LIMIT 8`).catch(() => [])) || [];
  return {
    total: await q1(store, `SELECT COUNT(*) FROM ${RT}`),
    queued: byStatus.queued || 0,
    analyzed: byStatus.analyzed || 0,
    failed: byStatus.failed || 0,
    handoff: byStatus.handoff || 0,
    derived_playbooks: await q1(store, `SELECT COUNT(*) FROM ${RT} WHERE playbook_key IS NOT NULL`),
    by_status: byStatus, by_kind: byKind,
    recent: recent.map((r) => ({ target: String(r.target || '').slice(0, 90), source: r.source, status: r.status, score: r.score, at: r.last_at })),
    note: '拾った外部情報を、人が並べなくても自動で解析に回す。解析は読み取りのみ（原価0・鍵なし）。',
  };
}

export async function listTargets(store, { limit = 20, status = null } = {}) {
  await ensureReaQueueTable(store);
  const n = Math.max(1, Math.min(60, Number(limit) || 20));
  try {
    return status
      ? (await store.all(`SELECT * FROM ${RT} WHERE status = ? ORDER BY last_at DESC LIMIT ?`, status, n)) || []
      : (await store.all(`SELECT * FROM ${RT} ORDER BY COALESCE(last_at, created_at) DESC LIMIT ?`, n)) || [];
  } catch { return []; }
}

export function reaQueueHelp() {
  return [
    `REA 自動投入キュー v${REA_QUEUE_VERSION} — X / Reddit / scout / perks が拾った情報を、自動で解析に回す`,
    '  GET  /api/rea/queue            キューの中身と結果（要約）',
    '  POST /api/rea/queue/enqueue    いま収集済みの情報から対象を積む（原価0）',
    '  自動: cron が一定間隔で「積む → 解析する → ネタ帳へ変換する」を回す',
    '  解析は公開されている表面だけ。認証回避・課金回避・DRM解除・対象の実行はしない。',
  ].join('\n');
}
