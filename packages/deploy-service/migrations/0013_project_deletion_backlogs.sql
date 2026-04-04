CREATE TABLE IF NOT EXISTS project_deletion_backlogs (
  github_repo TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  worker_script_names_json TEXT NOT NULL,
  database_ids_json TEXT NOT NULL,
  files_bucket_names_json TEXT NOT NULL,
  cache_namespace_ids_json TEXT NOT NULL,
  artifact_prefixes_json TEXT NOT NULL,
  last_error TEXT
);
