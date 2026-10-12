-- Wealth Agent — D1 / SQLite schema (v1)
-- Applied with: wrangler d1 execute wealth-agent --file=./schema.sql --remote

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Character / persona
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS characters (
  id            TEXT PRIMARY KEY,
  preset        TEXT,                 -- ambitious_businessman | cold_researcher | autonomous_engineer | strategist | custom
  name          TEXT NOT NULL,
  avatar        TEXT,                 -- 1-2 character monogram (fallback mark)
  avatar_url    TEXT,                 -- the icon itself: data URL (upload or generated)
  avatar_source TEXT,                 -- 'upload' | 'generated'
  avatar_prompt TEXT,                 -- the instruction used for the last generation
  avatar_model  TEXT,                 -- engine/model that produced it (e.g. workersai/@cf/...)
  avatar_updated_at TEXT,
  description   TEXT,
  personality   TEXT,
  tone          TEXT,
  values_json   TEXT DEFAULT '[]',
  strengths     TEXT,
  weaknesses    TEXT,
  creativity    INTEGER DEFAULT 60,   -- 0..100
  caution       INTEGER DEFAULT 60,
  risk_tolerance INTEGER DEFAULT 30,
  report_frequency TEXT DEFAULT 'daily',  -- realtime | hourly | daily | weekly | milestones
  autonomy_level INTEGER DEFAULT 4,   -- 1..5
  long_term_goals TEXT,
  prohibitions  TEXT,
  is_active     INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Missions / tasks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS missions (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  goal          TEXT NOT NULL,
  constraints   TEXT,
  success_metric TEXT,          -- machine-checkable metric definition
  target_value  REAL,
  metric_unit   TEXT DEFAULT 'JPY',
  status        TEXT NOT NULL DEFAULT 'active', -- active|paused|completed|failed|cancelled
  priority      INTEGER DEFAULT 50,
  autonomy_level INTEGER DEFAULT 4,
  progress      REAL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  mission_id    TEXT REFERENCES missions(id) ON DELETE CASCADE,
  parent_id     TEXT,
  title         TEXT NOT NULL,
  description   TEXT,
  category      TEXT,                 -- research|analysis|coding|testing|income_fx|income_rewards|income_sidehustle|verification|writing
  state         TEXT NOT NULL DEFAULT 'queued',
  priority      REAL DEFAULT 50,
  score         REAL DEFAULT 0,       -- computed selection score (with reasons)
  score_reasons TEXT,
  depends_on    TEXT,                 -- JSON array of task ids
  attempt       INTEGER DEFAULT 0,
  max_attempts  INTEGER DEFAULT 3,
  last_success_step TEXT,
  next_action   TEXT,
  tool_name     TEXT,
  tool_args     TEXT,                 -- JSON
  result_ref    TEXT,
  error_history TEXT DEFAULT '[]',    -- JSON array of {at,error,diagnosis}
  strategy      TEXT,                 -- current strategy label (for anti-loop switching)
  strategy_switches INTEGER DEFAULT 0,
  progress_marker TEXT,               -- last evidence hash used for progress detection
  artifacts     TEXT DEFAULT '[]',    -- JSON array of artifact refs
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_state   ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC);

-- ---------------------------------------------------------------------------
-- Execution logs / runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT,
  mission_id    TEXT,
  state         TEXT NOT NULL,
  step          INTEGER DEFAULT 0,
  summary       TEXT,
  detail        TEXT,               -- JSON
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);

-- ---------------------------------------------------------------------------
-- Workflow checkpoints (resume points)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checkpoints (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,       -- engine | task:<id> | mission:<id>
  state         TEXT NOT NULL,
  payload       TEXT,                -- JSON
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ckpt_scope ON checkpoints(scope, created_at DESC);

-- ---------------------------------------------------------------------------
-- Persistent memory (searchable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,       -- goal|preference|prohibition|experience|failure|success|rejected|constraint|fact|next_action|checkpoint
  scope         TEXT,                -- global | mission:<id> | task:<id>
  key           TEXT,                -- dedupe key
  text          TEXT NOT NULL,
  data_json     TEXT,
  evidence      TEXT,                -- measured|third_party|estimated|unverified
  importance    INTEGER DEFAULT 50,
  hits          INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_mem_key ON memories(key);

-- FTS5 full-text index over memories (searchable long-term memory)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text, kind, key,
  content='memories', content_rowid='rowid'
);

-- ---------------------------------------------------------------------------
-- Income opportunities & ranking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opportunities (
  id            TEXT PRIMARY KEY,
  domain        TEXT NOT NULL,        -- fx | rewards | side_hustle
  name          TEXT NOT NULL,
  summary       TEXT,
  initial_cost  REAL DEFAULT 0,
  recurring_cost REAL DEFAULT 0,
  hours_per_week REAL,
  automation    INTEGER DEFAULT 0,    -- 0..100
  time_to_revenue_days INTEGER,
  est_monthly_revenue REAL,
  revenue_basis TEXT,                 -- measured|third_party|estimated|unverified
  evidence_urls TEXT DEFAULT '[]',
  risk          TEXT,
  durability    TEXT,
  cashability   TEXT,
  japan_availability TEXT,            -- yes|no|unknown|conditional
  tos_compliance TEXT,                -- ok|risky|violation|unknown
  verified_results TEXT,
  status        TEXT DEFAULT 'candidate', -- candidate|approved|running|rejected|converted
  rejection_reason TEXT,
  score         REAL DEFAULT 0,
  score_breakdown TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opp_domain ON opportunities(domain);
CREATE INDEX IF NOT EXISTS idx_opp_status ON opportunities(status);

-- ---------------------------------------------------------------------------
-- FX strategies (versioned)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_strategies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  version       INTEGER DEFAULT 1,
  hypothesis    TEXT,
  params_json   TEXT,
  pine_code     TEXT,
  pine_version  TEXT,
  non_repaint   INTEGER DEFAULT 0,    -- 1 = passed linter
  lint_json     TEXT,
  status        TEXT DEFAULT 'draft', -- draft|tested|promoted|rejected
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fx_backtests (
  id            TEXT PRIMARY KEY,
  strategy_id   TEXT REFERENCES fx_strategies(id) ON DELETE CASCADE,
  symbol        TEXT,
  timeframe     TEXT,
  data_source   TEXT,
  date_from     TEXT,
  date_to       TEXT,
  bars          INTEGER,
  metrics_json  TEXT,
  equity_json   TEXT,
  trades_json   TEXT,
  walkforward_json TEXT,
  overfit_json  TEXT,
  cost_model_json TEXT,
  pass          INTEGER DEFAULT 0,
  notes         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bt_strategy ON fx_backtests(strategy_id);

-- ---------------------------------------------------------------------------
-- AI provider router state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  model         TEXT,
  role          TEXT,
  ok            INTEGER DEFAULT 1,
  status_code   INTEGER,
  error         TEXT,
  latency_ms    INTEGER,
  prompt_chars  INTEGER,
  output_chars  INTEGER,
  day           TEXT NOT NULL,        -- YYYY-MM-DD (UTC)
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_day ON ai_usage(day, provider);

CREATE TABLE IF NOT EXISTS ai_provider_state (
  provider      TEXT PRIMARY KEY,
  enabled       INTEGER DEFAULT 1,
  status        TEXT DEFAULT 'unknown', -- unknown|ok|rate_limited|error|disabled
  cooldown_until TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  last_error    TEXT,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Research / knowledge base
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS research_reports (
  id            TEXT PRIMARY KEY,
  mission_id    TEXT,
  task_id       TEXT,
  question      TEXT NOT NULL,
  summary       TEXT,
  findings_json TEXT,      -- [{claim, evidence, confidence, as_of, sources:[url]}]
  sources_json  TEXT,
  gaps_json     TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  mime          TEXT,
  size          INTEGER,
  chunks        INTEGER DEFAULT 0,
  text_preview  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_chunks (
  id            TEXT PRIMARY KEY,
  doc_id        TEXT REFERENCES documents(id) ON DELETE CASCADE,
  seq           INTEGER,
  text          TEXT NOT NULL,
  tokens        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunk_doc ON doc_chunks(doc_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
  text, content='doc_chunks', content_rowid='rowid'
);

-- ---------------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflows (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  definition    TEXT NOT NULL,      -- JSON: steps, conditions, schedules
  enabled       INTEGER DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT REFERENCES workflows(id) ON DELETE CASCADE,
  status        TEXT DEFAULT 'queued',
  cursor        INTEGER DEFAULT 0,
  context       TEXT,
  log_json      TEXT DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Approvals (human-in-the-loop for sensitive operations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  task_id       TEXT,
  action        TEXT NOT NULL,
  risk_level    TEXT NOT NULL,      -- money|irreversible|publish|delete|spend|identity
  payload       TEXT,
  status        TEXT DEFAULT 'pending', -- pending|approved|rejected|expired
  requested_at  TEXT NOT NULL,
  decided_at    TEXT,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_appr_status ON approvals(status);

-- ---------------------------------------------------------------------------
-- Financial ledger — measured vs estimated are kept apart, always
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,      -- revenue|cost
  amount        REAL NOT NULL,
  currency      TEXT DEFAULT 'JPY',
  basis         TEXT NOT NULL,      -- measured|third_party|estimated|unverified
  source        TEXT,
  opportunity_id TEXT,
  occurred_on   TEXT NOT NULL,      -- YYYY-MM-DD
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_day ON ledger(occurred_on);

-- ---------------------------------------------------------------------------
-- Engine state / settings (key-value)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Cost / quota guard for paid operations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spend_guard (
  day           TEXT PRIMARY KEY,
  paid_calls    INTEGER DEFAULT 0,
  est_cost_usd  REAL DEFAULT 0,
  blocked       INTEGER DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Browser-agent fetch cache (respectful crawling)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fetch_cache (
  url_hash      TEXT PRIMARY KEY,
  url           TEXT,
  status        INTEGER,
  body          TEXT,
  fetched_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Multi-agent fleet (added with the fleet feature; applied automatically by
-- ensureSchema() as an additive migration on existing databases).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, preset TEXT, specialty TEXT, instructions TEXT,
  avatar TEXT, avatar_url TEXT, status TEXT NOT NULL DEFAULT 'idle',
  autonomy_level INTEGER DEFAULT 4, max_steps_per_tick INTEGER DEFAULT 2,
  focus_json TEXT DEFAULT '[]', stats_json TEXT DEFAULT '{}',
  last_run_at TEXT, last_result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
-- Ownership columns for the fleet (nullable = unassigned).
--   missions.agent_id  which agent owns the mission
--   tasks.agent_id     denormalised from the mission for fast filtering
--   runs.agent_id      stamped by the engine after each agent slice

-- Conversation storage: the owner's threads and every exchange inside them,
-- so the same conversation can be picked up from any device.
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  mode TEXT DEFAULT 'normal',
  pinned INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  role TEXT,
  text TEXT,
  cards_json TEXT,
  events_json TEXT,
  kind TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_threads_updated ON chat_threads(updated_at);

-- ---------------------------------------------------------------------------
-- Watch rules (proactive check-ins: "tell me when measured revenue passes X")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watch_rules (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT,               -- the conversation the report is written into
  metric        TEXT NOT NULL,      -- measured_revenue|completed_tasks|failed_tasks|pending_approvals
  op            TEXT DEFAULT '>=',
  threshold     REAL,
  note          TEXT,
  status        TEXT DEFAULT 'active',   -- active|triggered|paused
  last_value    REAL,
  last_checked_at TEXT,
  triggered_count INTEGER DEFAULT 0,
  created_at    TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_watch_status ON watch_rules(status);
