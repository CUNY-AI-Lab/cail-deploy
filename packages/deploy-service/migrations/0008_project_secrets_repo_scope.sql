ALTER TABLE project_secrets
  ADD COLUMN github_repo TEXT;

UPDATE project_secrets
SET github_repo = (
  SELECT projects.github_repo
  FROM projects
  WHERE projects.project_name = project_secrets.project_name
)
WHERE github_repo IS NULL;

DELETE FROM project_secrets
WHERE github_repo IS NOT NULL
  AND rowid NOT IN (
    SELECT rowid
    FROM (
      SELECT
        rowid,
        ROW_NUMBER() OVER (
          PARTITION BY github_repo, secret_name
          ORDER BY updated_at DESC, rowid DESC
        ) AS row_number
      FROM project_secrets
      WHERE github_repo IS NOT NULL
    )
    WHERE row_number = 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_secrets_repo_secret
  ON project_secrets (github_repo, secret_name);

CREATE INDEX IF NOT EXISTS idx_project_secrets_github_repo
  ON project_secrets (github_repo);
