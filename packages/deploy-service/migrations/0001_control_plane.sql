CREATE TABLE IF NOT EXISTS projects (
  project_name TEXT PRIMARY KEY,
  owner_login TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  description TEXT,
  deployment_url TEXT NOT NULL,
  database_id TEXT,
  has_assets INTEGER NOT NULL DEFAULT 0,
  latest_deployment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_updated_at_idx
  ON projects(updated_at DESC);

CREATE TABLE IF NOT EXISTS deployments (
  deployment_id TEXT PRIMARY KEY,
  job_id TEXT,
  project_name TEXT NOT NULL,
  owner_login TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  head_sha TEXT,
  status TEXT NOT NULL CHECK(status IN ('success', 'failure')),
  deployment_url TEXT NOT NULL,
  artifact_prefix TEXT NOT NULL,
  archive_kind TEXT NOT NULL DEFAULT 'none' CHECK(archive_kind IN ('none', 'manifest', 'full')),
  manifest_key TEXT,
  has_assets INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deployments_project_created_idx
  ON deployments(project_name, created_at DESC);

CREATE TABLE IF NOT EXISTS build_jobs (
  job_id TEXT PRIMARY KEY,
  delivery_id TEXT UNIQUE,
  event_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  repository_json TEXT NOT NULL,
  ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  previous_sha TEXT,
  check_run_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'in_progress', 'deploying', 'success', 'failure')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  project_name TEXT,
  deployment_url TEXT,
  deployment_id TEXT,
  build_log_url TEXT,
  error_message TEXT,
  runner_id TEXT
);

CREATE INDEX IF NOT EXISTS build_jobs_updated_at_idx
  ON build_jobs(updated_at DESC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  received_at TEXT NOT NULL,
  job_id TEXT
);
