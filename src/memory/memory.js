// Persistent memory — structured, searchable, and *used* (not just stored).
// Backed by SQLite/D1 with an FTS5 index; falls back to LIKE search if FTS is
// unavailable.

import { id as newId, nowIso, j, safeJson, hash, likePattern} from '../util.js';

export const MEMORY_KINDS = [
  'goal', 'preference', 'prohibition', 'experience', 'failure', 'success',
  'rejected', 'constraint', 'fact', 'next_action', 'checkpoint', 'strategy',
];

export class Memory {
  constructor(store) { this.store = store; }

  /**
   * Write a memory. `key` enables dedupe/upsert semantics so repeated runs do
   * not flood the store with the same lesson.
   */
  async write({ kind, text, scope = 'global', key = null, data = null, evidence = 'unverified', importance = 50 }) {
    const k = key || `${kind}:${hash(text)}`;
    const existing = await this.store.first('SELECT * FROM memories WHERE key=? AND scope=?', k, scope);
    if (existing) {
      await this.store.run(
        'UPDATE memories SET text=?, data_json=?, evidence=?, importance=?, created_at=? WHERE id=?',
        text, j(data), evidence, Math.max(importance, existing.importance || 0), nowIso(), existing.id);
      await this.reindex(existing.id);
      return existing.id;
    }
    const row = {
      id: newId('mem'), kind, scope, key: k, text, data_json: j(data),
      evidence, importance, hits: 0, created_at: nowIso(),
    };
    await this.store.insert('memories', row);
    await this.reindex(row.id);
    return row.id;
  }

  async reindex(memId) {
    try {
      const row = await this.store.first('SELECT rowid, text, kind, key FROM memories WHERE id=?', memId);
      if (!row) return;
      await this.store.run('DELETE FROM memories_fts WHERE rowid=?', row.rowid);
      await this.store.run('INSERT INTO memories_fts (rowid, text, kind, key) VALUES (?,?,?,?)',
        row.rowid, row.text, row.kind, row.key);
    } catch { /* FTS unavailable — LIKE search still works */ }
  }

  /** Keyword search over memory. Returns most relevant first. */
  async search(query, { kinds = null, scope = null, limit = 8 } = {}) {
    const terms = tokenize(query);
    let rows = [];
    if (terms.length) {
      const fts = terms.map((t) => `${t}*`).join(' OR ');
      try {
        rows = await this.store.all(
          `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid=f.rowid
            WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`, fts, limit * 3);
      } catch { rows = []; }
      if (!rows.length) {
        const like = String(terms[0] || '').slice(0, 64);
        rows = await this.store.all(
          `SELECT * FROM memories WHERE instr(text, ?) > 0 ORDER BY importance DESC, created_at DESC LIMIT ?`,
          like, limit * 3);
      }
    } else {
      rows = await this.store.all(
        `SELECT * FROM memories ORDER BY importance DESC, created_at DESC LIMIT ?`, limit * 3);
    }
    let out = rows;
    if (kinds) out = out.filter((r) => kinds.includes(r.kind));
    if (scope) out = out.filter((r) => r.scope === scope || r.scope === 'global');
    out = out.slice(0, limit);
    for (const r of out) { await this.store.run('UPDATE memories SET hits=hits+1 WHERE id=?', r.id); }
    return out.map(decorate);
  }

  /** Everything that must steer the next plan (prohibitions, failures, rejections). */
  async guardrails(scope = 'global') {
    return (await this.store.all(
      `SELECT * FROM memories WHERE kind IN ('prohibition','rejected','failure','constraint')
         AND (scope=? OR scope='global') ORDER BY importance DESC, created_at DESC LIMIT 40`, scope)).map(decorate);
  }

  /**
   * Exhaustive fetch by kind — guardrails must NEVER be filtered by keyword
   * relevance, or a rejected candidate could be silently re-proposed.
   */
  async byKinds(kinds = [], scope = 'global', limit = 100) {
    if (!kinds.length) return [];
    const ph = kinds.map(() => '?').join(',');
    const rows = await this.store.all(
      `SELECT * FROM memories WHERE kind IN (${ph}) AND (scope=? OR scope='global')
        ORDER BY importance DESC, created_at DESC LIMIT ?`, ...kinds, scope, limit);
    return rows.map(decorate);
  }

  async recentExperience(scope = 'global', limit = 20) {
    return (await this.store.all(
      `SELECT * FROM memories WHERE kind IN ('experience','success','failure')
         AND (scope=? OR scope='global') ORDER BY created_at DESC LIMIT ?`, scope, limit)).map(decorate);
  }

  /** Compact digest for prompt injection. */
  async digest(query, opts = {}) {
    const [relevant, guards] = await Promise.all([
      this.search(query, opts),
      this.guardrails(opts.scope || 'global'),
    ]);
    const seen = new Set();
    const merged = [];
    for (const m of [...guards.slice(0, 8), ...relevant]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
    return merged.slice(0, 14);
  }

  async stats() {
    const rows = await this.store.all('SELECT kind, COUNT(*) AS c FROM memories GROUP BY kind');
    const total = rows.reduce((s, r) => s + r.c, 0);
    return { total, by_kind: Object.fromEntries(rows.map((r) => [r.kind, r.c])) };
  }
}

function decorate(r) {
  return { ...r, data: safeJson(r.data_json, null) };
}

function tokenize(q) {
  return String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2).slice(0, 6);
}

/** Helper: record the outcome of a task attempt as durable experience. */
export async function recordExperience(mem, task, outcome) {
  const kind = outcome.success ? 'success' : 'failure';
  const text = outcome.success
    ? `「${task.title}」が成功（手法: ${outcome.method || task.tool_name || 'n/a'}）: ${outcome.detail || ''}`.trim()
    : `「${task.title}」が失敗（手法: ${outcome.method || task.tool_name || 'n/a'}）: ${outcome.detail || ''} / 診断: ${outcome.diagnosis || '未特定'}`;
  await mem.write({
    kind,
    scope: task.mission_id ? `mission:${task.mission_id}` : 'global',
    text: text.slice(0, 900),
    data: { task_id: task.id, category: task.category, tool: task.tool_name, diagnosis: outcome.diagnosis || null },
    evidence: outcome.success ? 'measured' : 'unverified',
    importance: outcome.success ? 60 : 75,
  });
  if (!outcome.success && outcome.method) {
    await mem.write({
      kind: 'strategy',
      scope: task.mission_id ? `mission:${task.mission_id}` : 'global',
      key: `failed-strategy:${task.category}:${outcome.method}`,
      text: `手法「${outcome.method}」は ${task.category} で失敗した（原因: ${outcome.diagnosis || '不明'}）。再計画時は別手段を優先する。`,
      evidence: 'measured', importance: 70,
    });
  }
}
