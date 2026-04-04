CREATE TABLE IF NOT EXISTS featured_projects (
  github_repo TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  headline TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS featured_projects_sort_idx
  ON featured_projects(sort_order ASC, updated_at DESC);
