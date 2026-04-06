CREATE TABLE IF NOT EXISTS owner_capacity_overrides (
  owner_login TEXT PRIMARY KEY,
  max_live_dedicated_workers INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS owner_capacity_overrides_limit_idx
  ON owner_capacity_overrides(max_live_dedicated_workers ASC, updated_at DESC);
