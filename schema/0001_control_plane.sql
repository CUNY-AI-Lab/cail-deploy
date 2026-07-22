PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  owner_subject TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE revisions (
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  artifact_bytes INTEGER NOT NULL,
  artifact_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE TABLE releases (
  release_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('preview', 'production')),
  approval TEXT NOT NULL CHECK (approval IN ('required', 'automatic')),
  status TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL,
  prepared_key TEXT,
  prepared_digest TEXT,
  publication_name TEXT,
  rollback_of_release_id TEXT,
  approved_by_subject TEXT,
  operational_subject TEXT,
  request_id TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id, revision_id) REFERENCES revisions(project_id, revision_id),
  FOREIGN KEY (rollback_of_release_id) REFERENCES releases(release_id)
);

CREATE TABLE release_events (
  release_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor_subject TEXT,
  detail_json TEXT,
  PRIMARY KEY (release_id, sequence),
  FOREIGN KEY (release_id) REFERENCES releases(release_id)
);

CREATE TABLE idempotency (
  project_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, operation, idempotency_key)
);

CREATE UNIQUE INDEX one_release_terminal
  ON release_events(release_id)
  WHERE type IN ('release.live', 'release.failed', 'release.rejected');

CREATE UNIQUE INDEX one_release_approval
  ON release_events(release_id)
  WHERE type = 'release.approval_accepted';
