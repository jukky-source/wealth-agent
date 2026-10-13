// Database access layer. Works unchanged on Cloudflare D1 and on the local
// Node 22 `node:sqlite` adapter (see server/sqlite-d1.mjs) — both expose the
// same D1 interface: prepare().bind().all()/first()/run(), batch(), exec().

import { j, safeJson, nowIso } from './util.js';

export class Store {
  constructor(d1) { this.db = d1; }

  async exec(sql) { return this.db.exec(sql); }

  /** Run a query and return rows. */
  async all(sql, ...params) {
    const st = this.db.prepare(sql);
    const r = params.length ? await st.bind(...params).all() : await st.all();
    return r?.results ?? r ?? [];
  }

  async first(sql, ...params) {
    const st = this.db.prepare(sql);
    const r = params.length ? await st.bind(...params).first() : await st.first();
    return r ?? null;
  }

  async run(sql, ...params) {
    const st = this.db.prepare(sql);
    return params.length ? st.bind(...params).run() : st.run();
  }

  async batch(stmts) {
    // stmts: array of {sql, params:[...]}
    if (typeof this.db.batch === 'function' && stmts.length) {
      return this.db.batch(stmts.map((s) => this.db.prepare(s.sql).bind(...(s.params || []))));
    }
    const out = [];
    for (const s of stmts) out.push(await this.run(s.sql, ...(s.params || [])));
    return out;
  }

  // ---- generic helpers -----------------------------------------------------
  async insert(table, obj) {
    const keys = Object.keys(obj);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    await this.run(sql, ...keys.map((k) => norm(obj[k])));
    return obj;
  }

  async insertMany(table, objs) {
    if (!objs.length) return [];
    const keys = Object.keys(objs[0]);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    await this.batch(objs.map((o) => ({ sql, params: keys.map((k) => norm(o[k])) })));
    return objs;
  }

  async update(table, id, patch) {
    // undefined means "leave unchanged"; the primary key can never be rewritten.
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined && k !== 'id');
    if (!keys.length) return;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`;
    await this.run(sql, ...keys.map((k) => norm(patch[k])), id);
  }

  async get(table, id) { return this.first(`SELECT * FROM ${table} WHERE id=?`, id); }
}

function norm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return j(v);
  return v;
}

// ---------------------------------------------------------------------------
// Settings (key/value)
// ---------------------------------------------------------------------------
export async function setting(store, key, fallback = null) {
  const r = await store.first('SELECT value FROM settings WHERE key=?', key);
  if (!r) return fallback;
  return safeJson(r.value, r.value);
}

export async function setSetting(store, key, value) {
  await store.run(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    key, typeof value === 'string' ? value : j(value), nowIso(),
  );
}

// ---------------------------------------------------------------------------
// Schema bootstrap — idempotent; used by local dev and by POST /api/admin/migrate
// ---------------------------------------------------------------------------
export const SCHEMA_SQL = (s) => s; // re-export hook (schema lives in schema.sql)

export async function ensureSchema(store) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, preset TEXT, name TEXT NOT NULL, avatar TEXT, avatar_url TEXT, avatar_source TEXT, avatar_prompt TEXT, avatar_model TEXT, avatar_updated_at TEXT, description TEXT, personality TEXT, tone TEXT, values_json TEXT DEFAULT '[]', strengths TEXT, weaknesses TEXT, creativity INTEGER DEFAULT 60, caution INTEGER DEFAULT 60, risk_tolerance INTEGER DEFAULT 30, report_frequency TEXT DEFAULT 'daily', autonomy_level INTEGER DEFAULT 4, long_term_goals TEXT, prohibitions TEXT, is_active INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, constraints TEXT, success_metric TEXT, target_value REAL, metric_unit TEXT DEFAULT 'JPY', status TEXT NOT NULL DEFAULT 'active', priority INTEGER DEFAULT 50, autonomy_level INTEGER DEFAULT 4, progress REAL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, mission_id TEXT, parent_id TEXT, title TEXT NOT NULL, description TEXT, category TEXT, state TEXT NOT NULL DEFAULT 'queued', priority REAL DEFAULT 50, score REAL DEFAULT 0, score_reasons TEXT, depends_on TEXT, attempt INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3, last_success_step TEXT, next_action TEXT, tool_name TEXT, tool_args TEXT, result_ref TEXT, error_history TEXT DEFAULT '[]', strategy TEXT, strategy_switches INTEGER DEFAULT 0, progress_marker TEXT, artifacts TEXT DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id)`,
    `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT, mission_id TEXT, state TEXT NOT NULL, step INTEGER DEFAULT 0, summary TEXT, detail TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id)`,
    `CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, scope TEXT NOT NULL, state TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_ckpt_scope ON checkpoints(scope, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT, key TEXT, text TEXT NOT NULL, data_json TEXT, evidence TEXT, importance INTEGER DEFAULT 50, hits INTEGER DEFAULT 0, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_mem_kind ON memories(kind)`,
    `CREATE INDEX IF NOT EXISTS idx_mem_key ON memories(key)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, kind, key, content='memories', content_rowid='rowid')`,
    `CREATE TABLE IF NOT EXISTS opportunities (id TEXT PRIMARY KEY, domain TEXT NOT NULL, name TEXT NOT NULL, summary TEXT, initial_cost REAL DEFAULT 0, recurring_cost REAL DEFAULT 0, hours_per_week REAL, automation INTEGER DEFAULT 0, time_to_revenue_days INTEGER, est_monthly_revenue REAL, revenue_basis TEXT, evidence_urls TEXT DEFAULT '[]', risk TEXT, durability TEXT, cashability TEXT, japan_availability TEXT, tos_compliance TEXT, verified_results TEXT, status TEXT DEFAULT 'candidate', rejection_reason TEXT, score REAL DEFAULT 0, score_breakdown TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_opp_domain ON opportunities(domain)`,
    `CREATE TABLE IF NOT EXISTS fx_strategies (id TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL, version INTEGER DEFAULT 1, hypothesis TEXT, params_json TEXT, pine_code TEXT, pine_version TEXT, non_repaint INTEGER DEFAULT 0, lint_json TEXT, status TEXT DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS fx_backtests (id TEXT PRIMARY KEY, strategy_id TEXT, symbol TEXT, timeframe TEXT, data_source TEXT, date_from TEXT, date_to TEXT, bars INTEGER, metrics_json TEXT, equity_json TEXT, trades_json TEXT, walkforward_json TEXT, overfit_json TEXT, cost_model_json TEXT, pass INTEGER DEFAULT 0, notes TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ai_usage (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT, role TEXT, ok INTEGER DEFAULT 1, status_code INTEGER, error TEXT, latency_ms INTEGER, prompt_chars INTEGER, output_chars INTEGER, day TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_ai_day ON ai_usage(day, provider)`,
    `CREATE TABLE IF NOT EXISTS ai_provider_state (provider TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, status TEXT DEFAULT 'unknown', cooldown_until TEXT, consecutive_failures INTEGER DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS research_reports (id TEXT PRIMARY KEY, mission_id TEXT, task_id TEXT, question TEXT NOT NULL, summary TEXT, findings_json TEXT, sources_json TEXT, gaps_json TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT, size INTEGER, chunks INTEGER DEFAULT 0, text_preview TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS doc_chunks (id TEXT PRIMARY KEY, doc_id TEXT, seq INTEGER, text TEXT NOT NULL, tokens INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_chunk_doc ON doc_chunks(doc_id, seq)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(text, content='doc_chunks', content_rowid='rowid')`,
    `CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL, enabled INTEGER DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    // Conversation storage — the thread list the owner keeps on the left.
    `CREATE TABLE IF NOT EXISTS chat_threads (id TEXT PRIMARY KEY, title TEXT, mode TEXT DEFAULT 'normal', pinned INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, text TEXT, cards_json TEXT, events_json TEXT, kind TEXT, created_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_threads_updated ON chat_threads(updated_at)`,
    // 見張り（先回り報告）— 条件つきの監視。hold=1 は「達成するまで止めない」完了条件。
    `CREATE TABLE IF NOT EXISTS watch_rules (id TEXT PRIMARY KEY, thread_id TEXT, metric TEXT NOT NULL, op TEXT, threshold REAL, note TEXT, status TEXT DEFAULT 'active', hold INTEGER DEFAULT 0, stop_on_hit INTEGER DEFAULT 0, achieved_value REAL, last_value REAL, last_checked_at TEXT, triggered_count INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)`,
    // モード（用途）— 稼ぐ以外の使い方をオーナーが自分で足せるようにする。
    `CREATE TABLE IF NOT EXISTS modes (id TEXT PRIMARY KEY, label TEXT NOT NULL, goal TEXT, blurb TEXT, kpi_title TEXT, outcome_label TEXT, unit TEXT DEFAULT '件', chips_json TEXT DEFAULT '[]', placeholder TEXT, extra_approval_json TEXT DEFAULT '[]', extra_never_json TEXT DEFAULT '[]', created_at TEXT, updated_at TEXT)`, 
    `CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT, status TEXT DEFAULT 'queued', cursor INTEGER DEFAULT 0, context TEXT, log_json TEXT DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, task_id TEXT, action TEXT NOT NULL, risk_level TEXT NOT NULL, payload TEXT, status TEXT DEFAULT 'pending', requested_at TEXT NOT NULL, decided_at TEXT, note TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_appr_status ON approvals(status)`,
    `CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount REAL NOT NULL, currency TEXT DEFAULT 'JPY', basis TEXT NOT NULL, source TEXT, opportunity_id TEXT, occurred_on TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_day ON ledger(occurred_on)`,
    `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, preset TEXT, specialty TEXT, instructions TEXT, avatar TEXT, avatar_url TEXT, status TEXT NOT NULL DEFAULT 'idle', autonomy_level INTEGER DEFAULT 4, max_steps_per_tick INTEGER DEFAULT 2, focus_json TEXT DEFAULT '[]', stats_json TEXT DEFAULT '{}', last_run_at TEXT, last_result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status)`,
    `CREATE TABLE IF NOT EXISTS runner_jobs (id TEXT PRIMARY KEY, command TEXT NOT NULL, cwd TEXT, timeout_ms INTEGER DEFAULT 60000, state TEXT NOT NULL DEFAULT 'queued', runner_id TEXT, exit_code INTEGER, stdout TEXT, stderr TEXT, duration_ms INTEGER, requested_by TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_runner_state ON runner_jobs(state, created_at)`,
    // 稼ぐモードの実行レイヤ: 案件（jobs）と、決済通知からだけ作られる入金（receipts）。
    `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, opportunity_id TEXT, title TEXT NOT NULL, platform TEXT, state TEXT DEFAULT 'candidate', price REAL DEFAULT 0, cost_est REAL DEFAULT 0, cost_actual REAL DEFAULT 0, deliverable_ref TEXT, thread_id TEXT, due_on TEXT, note TEXT, created_at TEXT, updated_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, amount REAL NOT NULL, currency TEXT DEFAULT 'JPY', fee REAL DEFAULT 0, net_amount REAL DEFAULT 0, job_id TEXT, thread_id TEXT, payer TEXT, occurred_on TEXT NOT NULL, verified INTEGER DEFAULT 1, signature_verified INTEGER DEFAULT 1, raw_json TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS publish_drafts (id TEXT PRIMARY KEY, thread_id TEXT, kind TEXT NOT NULL, channel TEXT NOT NULL, title TEXT, body TEXT, lang TEXT DEFAULT 'ja', ai_disclosure INTEGER DEFAULT 0, unique_commentary INTEGER DEFAULT 0, linked INTEGER DEFAULT 0, state TEXT DEFAULT 'drafted', blocks_json TEXT DEFAULT '[]', scheduled_for TEXT, posted_url TEXT, approved_at TEXT, posted_at TEXT, day TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_ext ON receipts(source, external_id)`,
    `CREATE INDEX IF NOT EXISTS idx_receipts_day ON receipts(occurred_on)`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS spend_guard (day TEXT PRIMARY KEY, paid_calls INTEGER DEFAULT 0, est_cost_usd REAL DEFAULT 0, blocked INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS fetch_cache (url_hash TEXT PRIMARY KEY, url TEXT, status INTEGER, body TEXT, fetched_at TEXT NOT NULL)`,
  ];
  for (const sql of statements) {
    try { await store.exec(sql); } catch (e) {
      // FTS5 may be unavailable on some SQLite builds — degrade gracefully.
      if (!/fts5/i.test(String(e))) throw e;
    }
  }

  // Additive migrations — a database created before the avatar columns existed
  // keeps working; a duplicate-column error is the expected "already applied".
  const migrations = [
    `ALTER TABLE characters ADD COLUMN avatar_url TEXT`,
    `ALTER TABLE characters ADD COLUMN avatar_source TEXT`,
    `ALTER TABLE characters ADD COLUMN avatar_prompt TEXT`,
    `ALTER TABLE characters ADD COLUMN avatar_model TEXT`,
    `ALTER TABLE characters ADD COLUMN avatar_updated_at TEXT`,
    `CREATE TABLE IF NOT EXISTS avatars (id TEXT PRIMARY KEY, character_id TEXT, mime TEXT, bytes INTEGER, data_url TEXT NOT NULL, source TEXT, prompt TEXT, model TEXT, created_at TEXT NOT NULL)`,
    // 見張りの完了条件（hold）まわり。既存DBにも後付けで足す。
    `ALTER TABLE watch_rules ADD COLUMN hold INTEGER DEFAULT 0`,
    `ALTER TABLE watch_rules ADD COLUMN stop_on_hit INTEGER DEFAULT 0`,
    `ALTER TABLE watch_rules ADD COLUMN achieved_value REAL`,
    `ALTER TABLE missions ADD COLUMN agent_id TEXT`,
    `ALTER TABLE tasks ADD COLUMN agent_id TEXT`,
    `ALTER TABLE runs ADD COLUMN agent_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_missions_agent ON missions(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id, created_at DESC)`,
  ];
  for (const sql of migrations) {
    try { await store.exec(sql); } catch { /* column/table already present */ }
  }
  return true;
}
