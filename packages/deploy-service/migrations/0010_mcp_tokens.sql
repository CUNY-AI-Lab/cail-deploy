-- Personal access tokens for MCP authentication.
-- Used as a fallback when the agent's OAuth browser flow is broken.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_hash   TEXT    PRIMARY KEY,
  email        TEXT    NOT NULL,
  subject      TEXT    NOT NULL,
  label        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT    NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_email ON mcp_tokens (email);
