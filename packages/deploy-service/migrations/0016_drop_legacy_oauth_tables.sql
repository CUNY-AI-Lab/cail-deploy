-- The custom OAuth 2.1 implementation that stored single-use JTIs in D1 has been
-- replaced by @cloudflare/workers-oauth-provider, which stores all grant, auth-code,
-- and refresh-token state (hashed, with encrypted props) in the OAUTH_KV namespace.
-- These tables are no longer read or written by the deploy-service.
DROP TABLE IF EXISTS oauth_used_grants;
DROP TABLE IF EXISTS oauth_used_refresh_tokens;
