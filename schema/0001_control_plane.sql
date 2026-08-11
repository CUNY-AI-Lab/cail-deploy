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
  release_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  approval TEXT NOT NULL CHECK (approval IN ('required', 'automatic')),
  status TEXT NOT NULL CHECK (status IN (
    'queued',
    'validating',
    'building',
    'prepared',
    'awaiting_approval',
    'publishing',
    'reconciling',
    'live',
    'failed'
  )),
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
  WHERE type IN ('release.live', 'release.failed');

CREATE UNIQUE INDEX one_release_approval
  ON release_events(release_id)
  WHERE type = 'release.approval_accepted';

CREATE INDEX latest_live_release
  ON releases(project_id, status, release_sequence DESC);

CREATE TABLE oauth_consent_nonces (
  nonce TEXT PRIMARY KEY,
  owner_subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX oauth_consent_nonces_expiry
  ON oauth_consent_nonces(expires_at);

CREATE TRIGGER release_terminal_status_fence
BEFORE UPDATE OF status ON releases
WHEN (
    OLD.status IN ('live', 'failed')
    OR EXISTS (
      SELECT 1 FROM release_events
      WHERE release_id = OLD.release_id
        AND type IN ('release.live', 'release.failed')
    )
  )
  AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'terminal release status cannot regress');
END;
