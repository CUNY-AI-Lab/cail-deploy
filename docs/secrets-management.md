# Per-Project Secrets Management

## Status

Kale Deploy now supports per-project secret management:

- secrets are stored in the control plane with application-layer encryption
- the build runner never sees secret values
- secrets are injected into deployed Workers as `secret_text` bindings
- live projects attempt a hot update immediately when a secret changes
- ordinary deploys still avoid the second GitHub user-auth step

## Research Summary

Research across Cloudflare's Workers for Platforms (WfP) documentation, community discussions, and the broader PaaS ecosystem (Vercel, Heroku, Railway, Fly.io, Render) converges on a single recommended pattern.

## Cloudflare WfP Native Support

### `secret_text` bindings at deploy time

When uploading a user Worker via `PUT /accounts/{id}/workers/dispatch/namespaces/{ns}/scripts/{name}`, the metadata accepts `secret_text` bindings alongside the existing `d1`, `kv_namespace`, and `r2_bucket` types:

```json
{
  "type": "secret_text",
  "name": "OPENAI_API_KEY",
  "text": "sk-..."
}
```

Cloudflare encrypts these at rest automatically. This is the same mechanism Shopify Oxygen uses for merchant secrets on their WfP-based platform.

### Dedicated secrets API for dispatch namespace scripts

WfP exposes CRUD endpoints specifically for per-script secrets, independent of code deploys:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| PUT | `.../dispatch/namespaces/{ns}/scripts/{name}/secrets` | Add or update a secret |
| GET | `.../dispatch/namespaces/{ns}/scripts/{name}/secrets` | List secrets (values omitted) |
| DELETE | `.../dispatch/namespaces/{ns}/scripts/{name}/secrets/{secret_name}` | Remove a secret |

The PUT body is `{ "name": "MY_SECRET", "text": "value", "type": "secret_text" }`.

### Settings PATCH API (hot-update without redeploy)

Bindings can be updated on an already-deployed dispatch Worker without re-uploading the code:

```
PATCH /accounts/{id}/workers/dispatch/namespaces/{ns}/scripts/{name}/settings
```

This accepts a partial settings object with updated bindings. The Worker picks up new values on the next request. Use `keep_bindings` to preserve existing bindings while adding or replacing specific ones.

### Important: `wrangler secret put` does not work for dispatch namespace scripts

The CLI command only targets regular Workers. The REST API is the only supported path for WfP user Workers.

## Industry Pattern

Every major PaaS follows the same architecture:

1. **Control plane is the source of truth** for secrets (not the runtime's native secrets store).
2. **Secrets are encrypted at the application layer** before writing to the control-plane database.
3. **At deploy time**, secrets are decrypted and injected into the runtime as environment bindings.
4. **Secrets are write-only in the UI/API** -- values are never returned after creation.

| Platform | Storage | Injection | Secret change behavior |
|----------|---------|-----------|----------------------|
| Vercel | Control plane DB (envelope encryption) | Build-time and runtime env vars | Requires manual redeploy |
| Heroku | Control plane DB | OS env vars | Auto-restarts dyno |
| Railway | Control plane DB | Build and runtime env vars | Auto-redeploys |
| Fly.io | Control plane DB (Vault-backed) | VM env vars | Auto rolling restart |
| Render | Control plane DB | OS env vars | Requires manual redeploy |
| Shopify Oxygen (WfP) | Shopify control plane | `secret_text` bindings at deploy | Requires redeploy |

## Recommended Design for Kale

### Storage: `project_secrets` table in the control-plane D1

Encrypt secret values at the application layer using AES-256-GCM via `crypto.subtle` (available in Workers). Store the encryption key as a Worker secret (`CONTROL_PLANE_ENCRYPTION_KEY`).

```sql
CREATE TABLE project_secrets (
  project_name TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_name, secret_name)
);
```

Why application-level encryption on top of D1's at-rest encryption:
- DB-level encryption protects against storage-layer compromise, not application-level access or SQL injection.
- Application-level encryption means a DB dump is not enough to read secret values.

### Injection: two complementary mechanisms

1. **At deploy time**: the deploy service reads stored secrets for the project, decrypts them, and includes `secret_text` entries in the `bindings` array of `WorkerUploadMetadata`. This happens alongside the existing DB/FILES/CACHE binding injection.

2. **On secret change (without redeploy)**: use the WfP secrets API (`PUT .../dispatch/namespaces/{ns}/scripts/{name}/secrets`) or the Settings PATCH endpoint to update the live Worker's bindings immediately.

### UX: MCP tools and/or API endpoints

Expose through the existing MCP tool surface and control-plane API:

- `set_project_secret(projectName, secretName, secretValue)` -- create or update
- `delete_project_secret(projectName, secretName)` -- remove
- `list_project_secrets(projectName)` -- returns names and timestamps only, never values

Auth: Kale's permanent project-admin rule:

- Cloudflare Access confirms the user is a CUNY person.
- GitHub user auth confirms that the same person has write or admin access to the project repository.

This second GitHub user-auth step should appear only when someone is managing secrets or another sensitive project setting. Ordinary Kale deploys should continue to rely only on the shared GitHub App installation flow.

In practice this means secret CRUD should be allowed only when:

1. the current Kale identity is authenticated through Access or MCP OAuth,
2. the user has linked a GitHub account to Kale, and
3. GitHub reports write, maintain, or admin access on the repository that owns the Kale project.

### Student-side usage

The deploy service is the authority for production bindings. In student code, secrets are accessed as standard Worker environment variables:

```typescript
app.get('/api/chat', async (c) => {
  const apiKey = c.env.OPENAI_API_KEY; // injected by Kale at deploy time
  // ...
});
```

### Build runner stays untrusted for secrets

Secrets flow from the control-plane D1 directly to the Cloudflare Workers API. The build runner never sees secret values. It produces the code artifact; the deploy service attaches bindings (including secrets) when uploading to the dispatch namespace.

## What to avoid

- **Reading secrets from KV or D1 at request time**: adds latency on every request and requires extra bindings. Use native `secret_text` bindings instead.
- **Baking secrets into Worker code**: obvious security risk.
- **Relying only on D1 at-rest encryption**: insufficient without application-level encryption.
- **Flowing secrets through the build runner**: keep it untrusted for secret material.

## Cloudflare Secrets Store (beta)

Cloudflare launched an account-level Secrets Store in April 2025. It allows centralized secrets shared across Workers via `secrets_store_secrets` bindings. This could be useful for platform-wide secrets (e.g., a shared API key used by all tenants) but is not designed for per-tenant isolation. Per-project unique secrets still need the per-script secrets API described above.

## Implemented Scope

### Contract changes

Add `secret_text` to the `WorkerBinding` union in `build-contract`:

```typescript
| { type: "secret_text"; name: string; text: string }
```

### Deploy service changes

- New `project_secrets` table in the control-plane D1 schema.
- New encryption utilities using `crypto.subtle` (AES-256-GCM).
- New API routes for secret CRUD, protected by the existing auth layer.
- New MCP tools: `set_project_secret`, `delete_project_secret`, `list_project_secrets`.
- Modify the deploy path (around the existing binding-merge logic) to read and inject stored secrets.
- New `CONTROL_PLANE_ENCRYPTION_KEY` Worker secret.

### CloudflareApiClient changes

- New method: `setUserWorkerSecret(namespace, scriptName, secretName, secretValue)` for hot updates.
- New method: `deleteUserWorkerSecret(namespace, scriptName, secretName)`.
