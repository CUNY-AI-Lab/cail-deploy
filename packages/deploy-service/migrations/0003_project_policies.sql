CREATE TABLE IF NOT EXISTS project_policies (
  github_repo TEXT PRIMARY KEY,
  project_name TEXT,
  ai_enabled INTEGER NOT NULL DEFAULT 0,
  vectorize_enabled INTEGER NOT NULL DEFAULT 0,
  rooms_enabled INTEGER NOT NULL DEFAULT 0,
  max_validations_per_day INTEGER NOT NULL DEFAULT 10,
  max_deployments_per_day INTEGER NOT NULL DEFAULT 10,
  max_concurrent_builds INTEGER NOT NULL DEFAULT 1,
  max_asset_bytes INTEGER NOT NULL DEFAULT 262144000,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS project_policies_project_name_idx
  ON project_policies(project_name);
