// D1-compatible adapter over Node 22's built-in `node:sqlite`.
// This is what lets the EXACT same application code run locally and on
// Cloudflare — the Worker only ever sees the D1 interface.

import { DatabaseSync } from 'node:sqlite';

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...params) { this.params = params.map(norm); return this; }
  async all() {
    const st = this.db.prepare(this.sql);
    const rows = this.params.length ? st.all(...this.params) : st.all();
    return { results: rows || [], success: true };
  }
  async first() {
    const st = this.db.prepare(this.sql);
    const row = this.params.length ? st.get(...this.params) : st.get();
    return row ?? null;
  }
  async run() {
    const st = this.db.prepare(this.sql);
    const r = this.params.length ? st.run(...this.params) : st.run();
    return { success: true, meta: { changes: Number(r?.changes ?? 0), last_row_id: Number(r?.lastInsertRowid ?? 0) } };
  }
  async raw() {
    const st = this.db.prepare(this.sql);
    return this.params.length ? st.all(...this.params).map((r) => Object.values(r)) : st.all().map((r) => Object.values(r));
  }
}

export class D1Shim {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }
  prepare(sql) { return new Statement(this.db, sql); }
  async exec(sql) { this.db.exec(sql); return { count: 0, duration: 0 }; }
  async batch(statements) {
    const out = [];
    this.db.exec('BEGIN');
    try {
      for (const st of statements) out.push(await st.run());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return out;
  }
  async dump() { return new Uint8Array(); }
  close() { this.db.close(); }
}

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return v;
}
