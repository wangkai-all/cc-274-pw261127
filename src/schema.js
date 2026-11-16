/**
 * SQLite schema. Raw events are append-only and are the source of truth for
 * every rebuild and every full-baseline verification. Derived state lives in
 * epoch-scoped tables and is never treated as the origin of new results.
 */

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  source_version_id INTEGER,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  activated_at INTEGER,
  retired_at INTEGER,
  superseded_at INTEGER
);

CREATE INDEX IF NOT EXISTS rule_versions_status ON rule_versions(status);

CREATE TABLE IF NOT EXISTS epochs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  status TEXT NOT NULL,
  strategy TEXT NOT NULL,
  coverage_start_seq INTEGER NOT NULL,
  checkpoint_seq INTEGER NOT NULL DEFAULT 0,
  watermark REAL,
  parent_epoch_id INTEGER,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER,
  note TEXT
);

CREATE INDEX IF NOT EXISTS epochs_status ON epochs(status);

CREATE TABLE IF NOT EXISTS raw_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS raw_events_time ON raw_events(event_time);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch_id INTEGER NOT NULL REFERENCES epochs(id),
  version_id INTEGER NOT NULL,
  group_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  count INTEGER NOT NULL,
  sum REAL NOT NULL,
  min REAL,
  max REAL,
  contributions_count INTEGER NOT NULL,
  contributions_digest TEXT NOT NULL,
  contributions_sample TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  closed_at INTEGER NOT NULL,
  UNIQUE(epoch_id, group_key, window_start, window_end)
);

CREATE INDEX IF NOT EXISTS results_epoch ON results(epoch_id);
CREATE INDEX IF NOT EXISTS results_window ON results(epoch_id, window_start);

CREATE TABLE IF NOT EXISTS adjudications (
  seq INTEGER NOT NULL,
  epoch_id INTEGER NOT NULL REFERENCES epochs(id),
  version_id INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  group_key TEXT,
  windows_json TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  at INTEGER NOT NULL,
  inherited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (epoch_id, seq)
);

CREATE INDEX IF NOT EXISTS adjudications_seq ON adjudications(seq);

CREATE TABLE IF NOT EXISTS rebuild_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  epoch_id INTEGER NOT NULL REFERENCES epochs(id),
  from_seq INTEGER NOT NULL,
  target_seq INTEGER NOT NULL,
  cursor_seq INTEGER NOT NULL,
  strategy TEXT NOT NULL,
  status TEXT NOT NULL,
  replayed INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  metrics_json TEXT,
  verification_json TEXT
);

CREATE TABLE IF NOT EXISTS epoch_snapshots (
  epoch_id INTEGER PRIMARY KEY REFERENCES epochs(id),
  seq INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_batches (
  epoch_id INTEGER NOT NULL,
  batch_key TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  primary key (epoch_id, batch_key)
);

CREATE TABLE IF NOT EXISTS stale_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch_id INTEGER,
  fence TEXT,
  worker_id TEXT,
  received_at INTEGER NOT NULL,
  claimed_version INTEGER,
  active_epoch INTEGER,
  active_version INTEGER,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch_id INTEGER,
  version_id INTEGER,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
`;
