CREATE TABLE IF NOT EXISTS project_domains (
  domain_label TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_domains_primary_per_project
  ON project_domains(project_name)
  WHERE is_primary = 1;

CREATE INDEX IF NOT EXISTS idx_project_domains_project_name
  ON project_domains(project_name);

CREATE INDEX IF NOT EXISTS idx_project_domains_github_repo
  ON project_domains(github_repo);

INSERT OR IGNORE INTO project_domains (
  domain_label,
  project_name,
  github_repo,
  is_primary,
  created_at,
  updated_at
)
SELECT
  project_name,
  project_name,
  github_repo,
  1,
  created_at,
  updated_at
FROM projects
;
