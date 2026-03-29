CREATE TABLE IF NOT EXISTS project_secrets (
  project_name TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, secret_name),
  FOREIGN KEY (project_name) REFERENCES projects(project_name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_secrets_project_name
  ON project_secrets (project_name);
