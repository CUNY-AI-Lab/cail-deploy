import { generateKeyPairSync } from "node:crypto";
import type { TestContext } from "node:test";
import { SignJWT, base64url, importPKCS8 } from "jose";

import type {
  BuildJobRecord,
  BuildRunnerJobRequest,
  DeploymentRecord,
  ProjectRecord,
  RuntimeLane
} from "@cuny-ai-lab/build-contract";

import deployServiceWorker, { deployServiceApp } from "./index";
import type { ProjectPolicyRecord } from "./lib/control-plane";
import { encryptStoredText } from "./lib/sealed-data";

export const TEST_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: {
    format: "pem",
    type: "pkcs8"
  },
  publicKeyEncoding: {
    format: "pem",
    type: "spki"
  }
}).privateKey;

export const TEST_ACCESS_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: {
    format: "pem",
    type: "pkcs8"
  },
  publicKeyEncoding: {
    format: "jwk"
  }
});

export type TestEnv = {
  CONTROL_PLANE_DB: D1Database;
  DEPLOYMENT_ARCHIVE: R2Bucket;
  BUILD_QUEUE: Queue<BuildRunnerJobRequest>;
  OAUTH_KV: KVNamespace;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID?: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_ALLOWED_EMAILS?: string;
  CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS?: string;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  KALE_ADMIN_EMAILS?: string;
  FEATURED_PROJECT_ADMIN_EMAILS?: string;
  DEFAULT_MAX_LIVE_DEDICATED_WORKERS_PER_OWNER?: string;
  MCP_OAUTH_BASE_URL?: string;
  PROJECT_CONTROL_FORM_TOKEN_SECRET?: string;
  WFP_NAMESPACE: string;
  PROJECT_BASE_URL: string;
  PROJECT_HOST_SUFFIX?: string;
  GATEWAY_PREVIEW_TOKEN?: string;
  SHARED_STATIC_VALIDATION_ATTEMPTS?: string;
  SHARED_STATIC_VALIDATION_RETRY_MS?: string;
  DEPLOY_SERVICE_BASE_URL?: string;
  DEPLOY_API_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_NAME?: string;
  GITHUB_APP_MANIFEST_ORG?: string;
  CONTROL_PLANE_ENCRYPTION_KEY?: string;
  BUILD_RUNNER_TOKEN?: string;
};

export function createTestContext(overrides: Partial<TestEnv> = {}): {
  env: TestEnv;
  db: FakeD1Database;
  queue: FakeQueue;
  archive: FakeArchiveBucket;
  kv: FakeKVNamespace;
} {
  const db = new FakeD1Database();
  const queue = new FakeQueue();
  const archive = createArchiveBucketStub();
  const kv = new FakeKVNamespace();

  const env: TestEnv = {
    CONTROL_PLANE_DB: db as unknown as D1Database,
    DEPLOYMENT_ARCHIVE: archive as unknown as R2Bucket,
    BUILD_QUEUE: queue as unknown as Queue<BuildRunnerJobRequest>,
    OAUTH_KV: kv as unknown as KVNamespace,
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_API_TOKEN: "cloudflare-token",
    WFP_NAMESPACE: "cail-production",
    PROJECT_BASE_URL: "https://gateway.example",
    PROJECT_HOST_SUFFIX: "cuny.qzz.io",
    GATEWAY_PREVIEW_TOKEN: "preview-token",
    SHARED_STATIC_VALIDATION_ATTEMPTS: "1",
    SHARED_STATIC_VALIDATION_RETRY_MS: "0",
    DEPLOY_SERVICE_BASE_URL: "https://deploy.example",
    DEFAULT_MAX_LIVE_DEDICATED_WORKERS_PER_OWNER: "5",
    MCP_OAUTH_BASE_URL: "https://auth.example",
    PROJECT_CONTROL_FORM_TOKEN_SECRET: "project-control-form-token-secret",
    DEPLOY_API_TOKEN: "deploy-token",
    GITHUB_APP_ID: "3196468",
    GITHUB_APP_CLIENT_ID: "Iv1.test-client-id",
    GITHUB_APP_CLIENT_SECRET: "test-client-secret",
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
    GITHUB_APP_SLUG: "cail-deploy",
    GITHUB_APP_NAME: "CAIL Deploy",
    GITHUB_APP_MANIFEST_ORG: "CUNY-AI-Lab",
    CONTROL_PLANE_ENCRYPTION_KEY: "test-control-plane-encryption-key",
    ...overrides
  };

  return { env, db, queue, archive, kv };
}

// `fetchApp` and `fetchWorker` are now both routed through the worker's OAuth provider
// entrypoint so that bearer validation, DCR, token exchange, and well-known metadata all
// land on the same code path the production Worker runs. Tests that need to reach the raw
// Hono app without the provider's 401-on-/mcp handling should stay on the older
// deployServiceApp.fetch export directly — see `fetchHonoAppDirect` below.
export async function fetchApp(
  method: string,
  pathname: string,
  env: TestEnv,
  body?: unknown,
  headers?: HeadersInit
): Promise<Response> {
  return fetchWorker(method, pathname, env, body, headers);
}

export async function fetchHonoAppDirect(
  method: string,
  pathname: string,
  env: TestEnv,
  body?: unknown,
  headers?: HeadersInit
): Promise<Response> {
  const request = new Request(`https://deploy.example${pathname}`, {
    method,
    headers: body
      ? {
          "content-type": "application/json",
          ...headers
        }
      : headers,
    body: body ? JSON.stringify(body) : undefined
  });

  return deployServiceApp.fetch(request, env, createExecutionContext());
}

export async function fetchRaw(request: Request, env: TestEnv): Promise<Response> {
  return deployServiceWorker.fetch(request, env, createExecutionContext());
}

export async function fetchWorker(
  method: string,
  pathname: string,
  env: TestEnv,
  body?: unknown,
  headers?: HeadersInit
): Promise<Response> {
  const baseUrl = env.DEPLOY_SERVICE_BASE_URL ?? "https://deploy.example";
  const origin = new URL(baseUrl).origin;
  const isRawBody = typeof body === "string";
  const defaultContentType = isRawBody ? "application/x-www-form-urlencoded" : "application/json";
  const request = new Request(`${origin}${pathname}`, {
    method,
    headers: body === undefined
      ? headers
      : {
          "content-type": defaultContentType,
          ...headers
        },
    body: body === undefined
      ? undefined
      : isRawBody
        ? body
        : JSON.stringify(body)
  });

  return deployServiceWorker.fetch(request, env, createExecutionContext());
}

export function createExecutionContext(): ExecutionContext {
  return {
    props: {},
    passThroughOnException() {},
    waitUntil() {}
  } as unknown as ExecutionContext;
}

export function installGitHubFetchMock(
  t: TestContext,
  options: { repositoryName: string; headSha: string; installed?: boolean }
): void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === `/repos/szweibel/${options.repositoryName}/installation`) {
      if (options.installed === false) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      return jsonResponse({ id: 42, account: { login: "szweibel" } });
    }

    if (url.pathname === "/app/installations/42/access_tokens") {
      return jsonResponse({ token: "installation-token", expires_at: "2030-01-01T00:00:00.000Z" });
    }

    if (url.pathname === `/repos/szweibel/${options.repositoryName}`) {
      return jsonResponse({
        id: 7,
        name: options.repositoryName,
        full_name: `szweibel/${options.repositoryName}`,
        default_branch: "main",
        html_url: `https://github.com/szweibel/${options.repositoryName}`,
        clone_url: `https://github.com/szweibel/${options.repositoryName}.git`,
        private: false,
        owner: { login: "szweibel" }
      });
    }

    if (url.pathname === `/repos/szweibel/${options.repositoryName}/commits/main`) {
      return jsonResponse({ sha: options.headSha });
    }

    if (url.pathname === `/repos/szweibel/${options.repositoryName}/check-runs` && request.method === "POST") {
      return jsonResponse({
        id: 321,
        html_url: `https://github.com/szweibel/${options.repositoryName}/runs/321`,
        status: "queued",
        conclusion: null
      });
    }

    if (url.pathname.startsWith(`/repos/szweibel/${options.repositoryName}/check-runs/`) && request.method === "PATCH") {
      const body = await request.json() as {
        status?: string;
        conclusion?: string | null;
      };
      const checkRunId = Number(url.pathname.split("/").pop() ?? "0");
      return jsonResponse({
        id: checkRunId,
        html_url: `https://github.com/szweibel/${options.repositoryName}/runs/${checkRunId}`,
        status: body.status ?? "completed",
        conclusion: body.conclusion ?? "failure"
      });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

export function installAccessFetchMock(t: TestContext): void {
  installAccessJwksMock();

  t.after(() => {
    // The global JWKS mock is additive (it only returns a canned response for the test
    // Access origin). It is safe to leave installed across tests, but per-test teardown
    // keeps the fetch chain clean for tests that also mock other upstreams.
  });
}

let accessJwksMockInstalled = false;

// Globally intercepts the Cloudflare Access JWKS URL used by the test harness so that any
// test which needs to exercise `/api/oauth/authorize` can fabricate a valid Access JWT
// without having to call `installAccessFetchMock(t)` explicitly. Only the one certs URL
// is intercepted; everything else is delegated to the original fetch implementation.
export function installAccessJwksMock(): void {
  if (accessJwksMockInstalled) return;
  accessJwksMockInstalled = true;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://access.example" && url.pathname === "/cdn-cgi/access/certs") {
      return jsonResponse({
        keys: [
          {
            ...TEST_ACCESS_PRIVATE_KEY.publicKey,
            use: "sig",
            alg: "RS256",
            kid: "test-access-key"
          }
        ]
      });
    }
    return originalFetch(input, init);
  };
}

export async function createAccessJwt(email: string): Promise<string> {
  const key = await importPKCS8(TEST_ACCESS_PRIVATE_KEY.privateKey, "RS256");
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key", typ: "JWT" })
    .setIssuer("https://access.example")
    .setAudience("test-access-aud")
    .setSubject(`user:${email}`)
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(key);
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url.encode(new Uint8Array(digest));
}

// Runs the real OAuth 2.1 dance against the Worker's `@cloudflare/workers-oauth-provider`
// entrypoint: registers a DCR client, opens the browser-flow authorize endpoint with a
// fabricated Cloudflare Access JWT, follows the loopback continue page or redirect, and
// exchanges the authorization code for an access token. Returns the provider-issued
// bearer. Auto-installs the Access JWKS mock and fills in default Access env vars when
// the test context did not set them explicitly.
export async function issueTestMcpAccessToken(env: TestEnv, email: string): Promise<string> {
  installAccessJwksMock();
  if (!env.CLOUDFLARE_ACCESS_TEAM_DOMAIN) env.CLOUDFLARE_ACCESS_TEAM_DOMAIN = "https://access.example";
  if (!env.CLOUDFLARE_ACCESS_AUD) env.CLOUDFLARE_ACCESS_AUD = "test-access-aud";
  if (!env.CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS && !env.CLOUDFLARE_ACCESS_ALLOWED_EMAILS) {
    env.CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS = "cuny.edu";
  }

  const baseUrl = env.DEPLOY_SERVICE_BASE_URL ?? "https://deploy.example";
  const callbackUrl = `http://127.0.0.1:${Math.floor(10000 + Math.random() * 40000)}/callback`;

  const registerResponse = await fetchWorker("POST", "/oauth/register", env, {
    client_name: "issueTestMcpAccessToken",
    redirect_uris: [callbackUrl],
    token_endpoint_auth_method: "none"
  });
  if (registerResponse.status !== 201 && registerResponse.status !== 200) {
    throw new Error(`DCR failed: ${registerResponse.status} ${await registerResponse.text()}`);
  }
  const client = await registerResponse.json() as { client_id: string };

  const codeVerifier = "test-code-verifier-" + Math.random().toString(36).slice(2).padEnd(43, "x");
  const codeChallenge = await createPkceChallenge(codeVerifier);
  const accessJwt = await createAccessJwt(email);
  const authorizeQuery = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: callbackUrl,
    state: "test-state",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: "cail:deploy"
  });
  const authorizeResponse = await fetchWorker(
    "GET",
    `/api/oauth/authorize?${authorizeQuery.toString()}`,
    env,
    undefined,
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": email
    }
  );

  let code: string | null = null;
  if (authorizeResponse.status === 302) {
    const location = authorizeResponse.headers.get("location");
    if (!location) throw new Error("authorize redirect missing Location");
    code = new URL(location).searchParams.get("code");
  } else if (authorizeResponse.status === 200) {
    const html = await authorizeResponse.text();
    const match = html.match(/const callbackUrl = "([^"]+)";/);
    if (!match) throw new Error("authorize response did not include a callback URL");
    const decoded = JSON.parse(`"${match[1]}"`);
    code = new URL(decoded).searchParams.get("code");
  }
  if (!code) {
    throw new Error(
      `authorize flow did not return a code: status ${authorizeResponse.status} body ${await authorizeResponse.text()}`
    );
  }

  const tokenResponse = await fetchWorker(
    "POST",
    "/oauth/token",
    env,
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: callbackUrl,
      code,
      code_verifier: codeVerifier
    }).toString(),
    { "content-type": "application/x-www-form-urlencoded" }
  );
  if (tokenResponse.status !== 200) {
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }
  const body = await tokenResponse.json() as { access_token: string };
  if (!body.access_token) {
    throw new Error(`Token exchange returned no access_token: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

export async function issueTestMcpPatToken(
  db: FakeD1Database,
  email: string,
  options?: {
    expiresAt?: string;
    revokedAt?: string | null;
    label?: string;
  }
): Promise<string> {
  const random = new Uint8Array(18);
  crypto.getRandomValues(random);
  const token = `kale_pat_${base64url.encode(random)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  db.putMcpToken({
    token_hash: tokenHash,
    email,
    subject: `user:${email}`,
    label: options?.label ?? "Test token",
    created_at: "2026-03-30T12:00:00",
    expires_at: options?.expiresAt ?? "2030-01-01T00:00:00",
    revoked_at: options?.revokedAt ?? null
  });
  return token;
}

export async function sealStoredValueForTest(env: TestEnv, plaintext: string): Promise<string> {
  const secret = env.CONTROL_PLANE_ENCRYPTION_KEY ?? "test-control-plane-encryption-key";
  return JSON.stringify(await encryptStoredText(secret, plaintext));
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

export function repositoryRecord(name: string) {
  return {
    id: 7,
    ownerLogin: "szweibel",
    name,
    fullName: `szweibel/${name}`,
    defaultBranch: "main",
    htmlUrl: `https://github.com/szweibel/${name}`,
    cloneUrl: `https://github.com/szweibel/${name}.git`,
    private: false
  };
}

function createArchiveBucketStub(): FakeArchiveBucket {
  return new FakeArchiveBucket();
}

export class FakeArchiveBucket {
  private readonly objects = new Map<string, {
    body: ArrayBuffer;
    contentType?: string;
  }>();

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | Blob, options?: { httpMetadata?: { contentType?: string } }): Promise<void> {
    const blob = value instanceof Blob ? value : new Blob([coerceBlobPart(value)]);
    this.objects.set(key, {
      body: await blob.arrayBuffer(),
      contentType: options?.httpMetadata?.contentType
    });
  }

  async get(key: string): Promise<{
    body: ReadableStream<Uint8Array>;
    httpEtag: string;
    size: number;
    text(): Promise<string>;
    writeHttpMetadata(headers: Headers): void;
  } | null> {
    const entry = this.objects.get(key);
    if (!entry) {
      return null;
    }

    return {
      body: new Blob([entry.body]).stream(),
      httpEtag: `"${key}"`,
      size: entry.body.byteLength,
      async text() {
        return new TextDecoder().decode(entry.body);
      },
      writeHttpMetadata(headers: Headers) {
        if (entry.contentType) {
          headers.set("content-type", entry.contentType);
        }
      }
    };
  }

  async list(options?: { prefix?: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated: false;
    cursor: undefined;
  }> {
    const prefix = options?.prefix ?? "";
    return {
      objects: Array.from(this.objects.keys())
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => ({ key })),
      truncated: false,
      cursor: undefined
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }

  readText(key: string): string | null {
    const entry = this.objects.get(key);
    return entry ? new TextDecoder().decode(entry.body) : null;
  }
}

export class FakeQueue {
  readonly sent: BuildRunnerJobRequest[] = [];

  async send(message: BuildRunnerJobRequest): Promise<void> {
    this.sent.push(message);
  }
}

// Minimal in-memory KVNamespace stand-in for @cloudflare/workers-oauth-provider. The
// provider only uses `get`, `put`, `delete`, and `list`; everything else is omitted.
type FakeKVEntry = {
  value: string;
  expiresAt?: number;
  metadata?: unknown;
};

export class FakeKVNamespace {
  private readonly store = new Map<string, FakeKVEntry>();

  async get(key: string, options?: string | { type?: string }): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now() / 1000) {
      this.store.delete(key);
      return null;
    }
    const type = typeof options === "string" ? options : options?.type;
    if (type === "json") {
      return JSON.parse(entry.value);
    }
    if (type === "arrayBuffer") {
      return new TextEncoder().encode(entry.value).buffer;
    }
    if (type === "stream") {
      throw new Error("FakeKVNamespace does not support stream reads.");
    }
    return entry.value;
  }

  async getWithMetadata<M = unknown>(key: string): Promise<{ value: string | null; metadata: M | null }> {
    const entry = this.store.get(key);
    if (!entry) return { value: null, metadata: null };
    if (entry.expiresAt && entry.expiresAt <= Date.now() / 1000) {
      this.store.delete(key);
      return { value: null, metadata: null };
    }
    return { value: entry.value, metadata: (entry.metadata ?? null) as M | null };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expiration?: number; expirationTtl?: number; metadata?: unknown }
  ): Promise<void> {
    let stringValue: string;
    if (typeof value === "string") {
      stringValue = value;
    } else if (value instanceof ArrayBuffer) {
      stringValue = new TextDecoder().decode(new Uint8Array(value));
    } else if (ArrayBuffer.isView(value)) {
      stringValue = new TextDecoder().decode(value as ArrayBufferView);
    } else {
      throw new Error("FakeKVNamespace does not support ReadableStream writes.");
    }
    let expiresAt: number | undefined;
    if (options?.expiration) expiresAt = options.expiration;
    else if (options?.expirationTtl) expiresAt = Math.floor(Date.now() / 1000) + options.expirationTtl;
    this.store.set(key, { value: stringValue, expiresAt, metadata: options?.metadata });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
    cacheStatus: null;
  }> {
    const prefix = options?.prefix ?? "";
    const keys = Array.from(this.store.entries())
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, entry]) => ({ name, expiration: entry.expiresAt, metadata: entry.metadata }));
    return { keys, list_complete: true, cacheStatus: null };
  }
}

export class FakeD1Database {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly deployments = new Map<string, DeploymentRecord>();
  private readonly buildJobs = new Map<string, BuildJobRecord>();
  private readonly projectPolicies = new Map<string, ProjectPolicyRecord>();
  private readonly githubUserAuth = new Map<string, Record<string, unknown>>();
  private readonly mcpTokens = new Map<string, Record<string, unknown>>();
  private readonly projectSecrets = new Map<string, Record<string, unknown>>();
  private readonly projectDomains = new Map<string, Record<string, unknown>>();
  private readonly projectDeletionBacklogs = new Map<string, Record<string, unknown>>();
  private readonly featuredProjects = new Map<string, Record<string, unknown>>();
  private readonly ownerCapacityOverrides = new Map<string, Record<string, unknown>>();
  private readonly usedOauthGrants = new Set<string>();
  private readonly usedOauthRefreshTokens = new Set<string>();

  withSession(): this {
    return this;
  }

  prepare(sql: string): FakePreparedStatement {
    return new FakePreparedStatement(this, sql);
  }

  putProject(project: ProjectRecord): void {
    this.projects.set(project.projectName, project);
  }

  putBuildJob(job: BuildJobRecord): void {
    this.buildJobs.set(job.jobId, job);
  }

  putDeployment(deployment: DeploymentRecord): void {
    this.deployments.set(deployment.deploymentId, deployment);
  }

  putProjectPolicy(policy: ProjectPolicyRecord): void {
    this.projectPolicies.set(policy.githubRepo, policy);
  }

  putGitHubUserAuth(row: {
    access_subject: string;
    access_email: string;
    github_user_id: number;
    github_login: string;
    access_token_encrypted: string;
    access_token_expires_at: string | null;
    refresh_token_encrypted: string | null;
    refresh_token_expires_at: string | null;
    created_at: string;
    updated_at: string;
  }): void {
    this.githubUserAuth.set(row.access_subject, row);
  }

  putMcpToken(row: {
    token_hash: string;
    email: string;
    subject: string;
    label: string;
    created_at: string;
    expires_at: string;
    revoked_at?: string | null;
  }): void {
    this.mcpTokens.set(row.token_hash, {
      ...row,
      revoked_at: row.revoked_at ?? null
    });
  }

  putProjectSecret(row: {
    github_repo: string;
    project_name: string;
    secret_name: string;
    ciphertext: string;
    iv: string;
    github_user_id: number;
    github_login: string;
    created_at: string;
    updated_at: string;
  }): void {
    this.projectSecrets.set(`${row.github_repo}:${row.secret_name}`, row);
  }

  putProjectDomain(row: {
    domain_label: string;
    project_name: string;
    github_repo: string;
    is_primary: number;
    created_at: string;
    updated_at: string;
  }): void {
    this.projectDomains.set(row.domain_label, row);
  }

  putProjectDeletionBacklog(row: {
    github_repo: string;
    project_name: string;
    requested_at: string;
    updated_at: string;
    worker_script_names_json: string;
    database_ids_json: string;
    files_bucket_names_json: string;
    cache_namespace_ids_json: string;
    artifact_prefixes_json: string;
    last_error: string | null;
  }): void {
    this.projectDeletionBacklogs.set(row.github_repo, row);
  }

  putFeaturedProject(row: {
    github_repo: string;
    project_name: string;
    headline: string | null;
    sort_order: number;
    created_at: string;
    updated_at: string;
  }): void {
    this.featuredProjects.set(row.github_repo, row);
  }

  putOwnerCapacityOverride(row: {
    owner_login: string;
    max_live_dedicated_workers: number;
    note: string | null;
    created_at: string;
    updated_at: string;
  }): void {
    this.ownerCapacityOverrides.set(row.owner_login, row);
  }

  upsertProjectFromParams(params: unknown[]): void {
    const project: ProjectRecord = {
      projectName: String(params[0]),
      ownerLogin: String(params[1]),
      githubRepo: String(params[2]),
      description: nullableString(params[3]) ?? undefined,
      deploymentUrl: String(params[4]),
      databaseId: nullableString(params[5]) ?? undefined,
      filesBucketName: nullableString(params[6]) ?? undefined,
      cacheNamespaceId: nullableString(params[7]) ?? undefined,
      runtimeLane: (nullableString(params[8]) ?? "dedicated_worker") as RuntimeLane,
      recommendedRuntimeLane: (nullableString(params[9]) ?? nullableString(params[8]) ?? "dedicated_worker") as RuntimeLane,
      hasAssets: Number(params[10]) === 1,
      latestDeploymentId: nullableString(params[11]) ?? undefined,
      createdAt: String(params[12]),
      updatedAt: String(params[13])
    };

    this.putProject(project);
  }

  upsertDeploymentFromParams(params: unknown[]): void {
    const deployment: DeploymentRecord = {
      deploymentId: String(params[0]),
      jobId: nullableString(params[1]) ?? undefined,
      projectName: String(params[2]),
      ownerLogin: String(params[3]),
      githubRepo: String(params[4]),
      headSha: nullableString(params[5]) ?? undefined,
      status: String(params[6]) as DeploymentRecord["status"],
      deploymentUrl: String(params[7]),
      artifactPrefix: String(params[8]),
      archiveKind: String(params[9]) as DeploymentRecord["archiveKind"],
      manifestKey: nullableString(params[10]) ?? undefined,
      runtimeLane: (nullableString(params[11]) ?? "dedicated_worker") as RuntimeLane,
      recommendedRuntimeLane: (nullableString(params[12]) ?? nullableString(params[11]) ?? "dedicated_worker") as RuntimeLane,
      hasAssets: Number(params[13]) === 1,
      createdAt: String(params[14])
    };

    this.putDeployment(deployment);
  }

  getBuildJob(jobId: string): BuildJobRecord | undefined {
    return this.buildJobs.get(jobId);
  }

  selectProjectPolicy(githubRepo: string): Record<string, unknown> | null {
    const policy = this.projectPolicies.get(githubRepo);
    if (!policy) {
      return null;
    }

    return {
      github_repo: policy.githubRepo,
      project_name: policy.projectName ?? null,
      ai_enabled: policy.aiEnabled ? 1 : 0,
      vectorize_enabled: policy.vectorizeEnabled ? 1 : 0,
      rooms_enabled: policy.roomsEnabled ? 1 : 0,
      max_validations_per_day: policy.maxValidationsPerDay,
      max_deployments_per_day: policy.maxDeploymentsPerDay,
      max_concurrent_builds: policy.maxConcurrentBuilds,
      max_asset_bytes: policy.maxAssetBytes,
      created_at: policy.createdAt,
      updated_at: policy.updatedAt
    };
  }

  selectGitHubUserAuth(accessSubject: string): Record<string, unknown> | null {
    return this.githubUserAuth.get(accessSubject) ?? null;
  }

  selectMcpTokenByHash(tokenHash: string): Record<string, unknown> | null {
    return this.mcpTokens.get(tokenHash) ?? null;
  }

  selectLatestActiveMcpTokenForEmail(email: string): Record<string, unknown> | null {
    return Array.from(this.mcpTokens.values())
      .filter((token) =>
        token.email === email
        && token.revoked_at === null
        && new Date(`${String(token.expires_at)}Z`) > new Date()
      )
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0] ?? null;
  }

  selectProjectSecret(githubRepo: string, secretName: string): Record<string, unknown> | null {
    return this.projectSecrets.get(`${githubRepo}:${secretName}`) ?? null;
  }

  selectProjectDeletionBacklog(githubRepo: string): Record<string, unknown> | null {
    return this.projectDeletionBacklogs.get(githubRepo) ?? null;
  }

  selectFeaturedProject(githubRepo: string): Record<string, unknown> | null {
    return this.featuredProjects.get(githubRepo) ?? null;
  }

  selectOwnerCapacityOverride(ownerLogin: string): Record<string, unknown> | null {
    return this.ownerCapacityOverrides.get(ownerLogin) ?? null;
  }

  listProjectSecrets(githubRepo: string): Record<string, unknown>[] {
    return Array.from(this.projectSecrets.values())
      .filter((secret) => secret.github_repo === githubRepo)
      .sort((left, right) => String(left.secret_name).localeCompare(String(right.secret_name)));
  }

  listProjectDeletionBacklogs(limit: number): Record<string, unknown>[] {
    return Array.from(this.projectDeletionBacklogs.values())
      .sort((left, right) => String(left.updated_at).localeCompare(String(right.updated_at)))
      .slice(0, limit);
  }

  listFeaturedProjects(): Record<string, unknown>[] {
    const featuredRows: Array<Record<string, unknown> | null> = Array.from(this.featuredProjects.values())
      .map((feature): Record<string, unknown> | null => {
        const liveProject = Array.from(this.projects.values())
          .filter((project) => project.githubRepo === feature.github_repo && Boolean(project.latestDeploymentId))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        if (!liveProject) {
          return null;
        }

        return {
          github_repo: feature.github_repo,
          project_name: liveProject.projectName,
          headline: feature.headline ?? null,
          sort_order: feature.sort_order,
          created_at: feature.created_at,
          updated_at: feature.updated_at,
          owner_login: liveProject.ownerLogin,
          deployment_url: liveProject.deploymentUrl,
          description: liveProject.description ?? null,
          runtime_lane: liveProject.runtimeLane ?? "dedicated_worker"
        };
      });

    return featuredRows
      .filter((feature): feature is Record<string, unknown> => feature !== null)
      .sort((left, right) => {
        const orderDiff = Number(left.sort_order) - Number(right.sort_order);
        if (orderDiff !== 0) {
          return orderDiff;
        }
        return String(right.updated_at).localeCompare(String(left.updated_at));
      });
  }

  listOwnerCapacityOverrides(): Record<string, unknown>[] {
    return Array.from(this.ownerCapacityOverrides.values())
      .sort((left, right) => String(left.owner_login).localeCompare(String(right.owner_login)));
  }

  upsertGitHubUserAuthFromParams(params: unknown[]): void {
    this.putGitHubUserAuth({
      access_subject: String(params[0]),
      access_email: String(params[1]),
      github_user_id: Number(params[2]),
      github_login: String(params[3]),
      access_token_encrypted: String(params[4]),
      access_token_expires_at: nullableString(params[5]),
      refresh_token_encrypted: nullableString(params[6]),
      refresh_token_expires_at: nullableString(params[7]),
      created_at: String(params[8]),
      updated_at: String(params[9])
    });
  }

  upsertProjectSecretFromParams(params: unknown[]): void {
    const key = `${String(params[0])}:${String(params[2])}`;
    const existing = this.projectSecrets.get(key);
    this.putProjectSecret({
      github_repo: String(params[0]),
      project_name: String(params[1]),
      secret_name: String(params[2]),
      ciphertext: String(params[3]),
      iv: String(params[4]),
      github_user_id: Number(params[5]),
      github_login: String(params[6]),
      created_at: existing?.created_at ? String(existing.created_at) : String(params[7]),
      updated_at: String(params[8])
    });
  }

  upsertProjectDomainFromParams(params: unknown[]): void {
    const existing = this.projectDomains.get(String(params[0]));
    this.putProjectDomain({
      domain_label: String(params[0]),
      project_name: String(params[1]),
      github_repo: String(params[2]),
      is_primary: Number(params[3]),
      created_at: existing?.created_at ? String(existing.created_at) : String(params[4]),
      updated_at: String(params[5])
    });
  }

  upsertProjectDeletionBacklogFromParams(params: unknown[]): void {
    const existing = this.projectDeletionBacklogs.get(String(params[0]));
    this.putProjectDeletionBacklog({
      github_repo: String(params[0]),
      project_name: String(params[1]),
      requested_at: existing?.requested_at ? String(existing.requested_at) : String(params[2]),
      updated_at: String(params[3]),
      worker_script_names_json: String(params[4]),
      database_ids_json: String(params[5]),
      files_bucket_names_json: String(params[6]),
      cache_namespace_ids_json: String(params[7]),
      artifact_prefixes_json: String(params[8]),
      last_error: nullableString(params[9])
    });
  }

  upsertFeaturedProjectFromParams(params: unknown[]): void {
    const existing = this.featuredProjects.get(String(params[0]));
    this.putFeaturedProject({
      github_repo: String(params[0]),
      project_name: String(params[1]),
      headline: nullableString(params[2]),
      sort_order: Number(params[3]),
      created_at: existing?.created_at ? String(existing.created_at) : String(params[4]),
      updated_at: String(params[5])
    });
  }

  upsertOwnerCapacityOverrideFromParams(params: unknown[]): void {
    const existing = this.ownerCapacityOverrides.get(String(params[0]));
    this.putOwnerCapacityOverride({
      owner_login: String(params[0]),
      max_live_dedicated_workers: Number(params[1]),
      note: nullableString(params[2]),
      created_at: existing?.created_at ? String(existing.created_at) : String(params[3]),
      updated_at: String(params[4])
    });
  }

  deleteGitHubUserAuthByGitHubUserId(githubUserId: number): void {
    for (const [accessSubject, row] of this.githubUserAuth.entries()) {
      if (Number(row.github_user_id) === githubUserId) {
        this.githubUserAuth.delete(accessSubject);
      }
    }
  }

  revokeActiveMcpTokensForEmail(email: string): void {
    const revokedAt = "2026-03-30T12:30:00";
    for (const [tokenHash, row] of this.mcpTokens.entries()) {
      if (row.email === email && row.revoked_at === null) {
        this.mcpTokens.set(tokenHash, {
          ...row,
          revoked_at: revokedAt
        });
      }
    }
  }

  deleteProjectSecret(githubRepo: string, secretName: string): void {
    this.projectSecrets.delete(`${githubRepo}:${secretName}`);
  }

  deleteProjectSecretsForProject(projectName: string): void {
    for (const [key, secret] of this.projectSecrets.entries()) {
      if (secret.project_name === projectName) {
        this.projectSecrets.delete(key);
      }
    }
  }

  deleteProjectDomain(domainLabel: string): void {
    this.projectDomains.delete(domainLabel);
  }

  deleteProjectDomainsForProject(projectName: string): void {
    for (const [domainLabel, domain] of this.projectDomains.entries()) {
      if (domain.project_name === projectName) {
        this.projectDomains.delete(domainLabel);
      }
    }
  }

  deleteProject(projectName: string): void {
    this.projects.delete(projectName);
  }

  deleteProjectsForRepository(githubRepo: string): void {
    for (const [projectName, project] of this.projects.entries()) {
      if (project.githubRepo === githubRepo) {
        this.projects.delete(projectName);
      }
    }
  }

  deleteBuildJobsForProject(projectName: string): void {
    for (const [jobId, job] of this.buildJobs.entries()) {
      if (job.projectName === projectName) {
        this.buildJobs.delete(jobId);
      }
    }
  }

  deleteBuildJobsForRepository(githubRepo: string): void {
    for (const [jobId, job] of this.buildJobs.entries()) {
      if (job.repository.fullName === githubRepo) {
        this.buildJobs.delete(jobId);
      }
    }
  }

  deleteDeploymentsForProject(projectName: string): void {
    for (const [deploymentId, deployment] of this.deployments.entries()) {
      if (deployment.projectName === projectName) {
        this.deployments.delete(deploymentId);
      }
    }
  }

  deleteDeploymentsForRepository(githubRepo: string): void {
    for (const [deploymentId, deployment] of this.deployments.entries()) {
      if (deployment.githubRepo === githubRepo) {
        this.deployments.delete(deploymentId);
      }
    }
  }

  deleteProjectSecretsForRepository(githubRepo: string): void {
    for (const [key, secret] of this.projectSecrets.entries()) {
      if (secret.github_repo === githubRepo) {
        this.projectSecrets.delete(key);
      }
    }
  }

  deleteProjectDomainsForRepository(githubRepo: string): void {
    for (const [domainLabel, domain] of this.projectDomains.entries()) {
      if (domain.github_repo === githubRepo) {
        this.projectDomains.delete(domainLabel);
      }
    }
  }

  deleteProjectPolicy(githubRepo: string): void {
    this.projectPolicies.delete(githubRepo);
  }

  deleteProjectDeletionBacklog(githubRepo: string): void {
    this.projectDeletionBacklogs.delete(githubRepo);
  }

  deleteFeaturedProject(githubRepo: string): void {
    this.featuredProjects.delete(githubRepo);
  }

  deleteOwnerCapacityOverride(ownerLogin: string): void {
    this.ownerCapacityOverrides.delete(ownerLogin);
  }

  updateDeploymentArchiveState(
    deploymentId: string,
    archiveKind: DeploymentRecord["archiveKind"],
    manifestKey?: string
  ): void {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) {
      return;
    }

    this.deployments.set(deploymentId, {
      ...deployment,
      archiveKind,
      manifestKey
    });
  }

  selectProjectDomain(domainLabel: string): Record<string, unknown> | null {
    return this.projectDomains.get(domainLabel) ?? null;
  }

  selectPrimaryProjectDomain(projectName: string): Record<string, unknown> | null {
    return Array.from(this.projectDomains.values()).find((domain) =>
      domain.project_name === projectName && Number(domain.is_primary) === 1
    ) ?? null;
  }

  listProjectDomains(projectName: string): Record<string, unknown>[] {
    return Array.from(this.projectDomains.values())
      .filter((domain) => domain.project_name === projectName)
      .sort((left, right) => {
        const primaryDiff = Number(right.is_primary) - Number(left.is_primary);
        if (primaryDiff !== 0) {
          return primaryDiff;
        }
        return String(left.domain_label).localeCompare(String(right.domain_label));
      });
  }

  listProjectDomainsForRepository(githubRepo: string): Record<string, unknown>[] {
    return Array.from(this.projectDomains.values())
      .filter((domain) => domain.github_repo === githubRepo)
      .sort((left, right) => {
        const primaryDiff = Number(right.is_primary) - Number(left.is_primary);
        if (primaryDiff !== 0) {
          return primaryDiff;
        }
        return String(left.domain_label).localeCompare(String(right.domain_label));
      });
  }

  listDeployments(projectName: string): Record<string, unknown>[] {
    return Array.from(this.deployments.values())
      .filter((deployment) => deployment.projectName === projectName)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((deployment) => ({
        deployment_id: deployment.deploymentId,
        job_id: deployment.jobId ?? null,
        project_name: deployment.projectName,
        owner_login: deployment.ownerLogin,
        github_repo: deployment.githubRepo,
        head_sha: deployment.headSha ?? null,
        status: deployment.status,
        deployment_url: deployment.deploymentUrl,
        artifact_prefix: deployment.artifactPrefix,
        archive_kind: deployment.archiveKind,
        manifest_key: deployment.manifestKey ?? null,
        runtime_lane: deployment.runtimeLane ?? "dedicated_worker",
        recommended_runtime_lane: deployment.recommendedRuntimeLane ?? deployment.runtimeLane ?? "dedicated_worker",
        has_assets: deployment.hasAssets ? 1 : 0,
        created_at: deployment.createdAt
      }));
  }

  listDeploymentsForRepository(githubRepo: string): Record<string, unknown>[] {
    return Array.from(this.deployments.values())
      .filter((deployment) => deployment.githubRepo === githubRepo)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((deployment) => ({
        deployment_id: deployment.deploymentId,
        job_id: deployment.jobId ?? null,
        project_name: deployment.projectName,
        owner_login: deployment.ownerLogin,
        github_repo: deployment.githubRepo,
        head_sha: deployment.headSha ?? null,
        status: deployment.status,
        deployment_url: deployment.deploymentUrl,
        artifact_prefix: deployment.artifactPrefix,
        archive_kind: deployment.archiveKind,
        manifest_key: deployment.manifestKey ?? null,
        runtime_lane: deployment.runtimeLane ?? "dedicated_worker",
        recommended_runtime_lane: deployment.recommendedRuntimeLane ?? deployment.runtimeLane ?? "dedicated_worker",
        has_assets: deployment.hasAssets ? 1 : 0,
        created_at: deployment.createdAt
      }));
  }

  listProjectsForRepository(githubRepo: string): Record<string, unknown>[] {
    return Array.from(this.projects.values())
      .filter((project) => project.githubRepo === githubRepo)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((project) => ({
        project_name: project.projectName,
        owner_login: project.ownerLogin,
        github_repo: project.githubRepo,
        description: project.description ?? null,
        deployment_url: project.deploymentUrl,
        database_id: project.databaseId ?? null,
        files_bucket_name: project.filesBucketName ?? null,
        cache_namespace_id: project.cacheNamespaceId ?? null,
        runtime_lane: project.runtimeLane ?? "dedicated_worker",
        recommended_runtime_lane: project.recommendedRuntimeLane ?? project.runtimeLane ?? "dedicated_worker",
        has_assets: project.hasAssets ? 1 : 0,
        latest_deployment_id: project.latestDeploymentId ?? null,
        created_at: project.createdAt,
        updated_at: project.updatedAt
      }));
  }

  listRetainedSuccessfulDeployments(projectName: string): Record<string, unknown>[] {
    return this.listDeployments(projectName).filter((deployment) =>
      deployment.status === "success" && deployment.archive_kind === "full"
    );
  }

  listRetainedSuccessfulDeploymentsForRepository(githubRepo: string): Record<string, unknown>[] {
    return this.listDeploymentsForRepository(githubRepo).filter((deployment) =>
      deployment.status === "success" && deployment.archive_kind === "full"
    );
  }

  listExpiredRetainedFailedDeployments(cutoffIso: string): Record<string, unknown>[] {
    return Array.from(this.deployments.values())
      .filter((deployment) =>
        deployment.status === "failure"
        && deployment.archiveKind !== "none"
        && deployment.createdAt < cutoffIso
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((deployment) => ({
        deployment_id: deployment.deploymentId,
        job_id: deployment.jobId ?? null,
        project_name: deployment.projectName,
        owner_login: deployment.ownerLogin,
        github_repo: deployment.githubRepo,
        head_sha: deployment.headSha ?? null,
        status: deployment.status,
        deployment_url: deployment.deploymentUrl,
        artifact_prefix: deployment.artifactPrefix,
        archive_kind: deployment.archiveKind,
        manifest_key: deployment.manifestKey ?? null,
        runtime_lane: deployment.runtimeLane ?? "dedicated_worker",
        recommended_runtime_lane: deployment.recommendedRuntimeLane ?? deployment.runtimeLane ?? "dedicated_worker",
        has_assets: deployment.hasAssets ? 1 : 0,
        created_at: deployment.createdAt
      }));
  }

  updateProjectDeploymentUrl(projectName: string, deploymentUrl: string, updatedAt: string): void {
    const project = this.projects.get(projectName);
    if (project) {
      this.projects.set(projectName, {
        ...project,
        deploymentUrl,
        updatedAt
      });
    }
  }

  unpublishProjectsForRepository(githubRepo: string, updatedAt: string): void {
    for (const [projectName, project] of this.projects.entries()) {
      if (project.githubRepo === githubRepo) {
        this.projects.set(projectName, {
          ...project,
          latestDeploymentId: undefined,
          updatedAt
        });
      }
    }
  }

  updateBuildJobDeploymentUrl(projectName: string, deploymentUrl: string): void {
    for (const [jobId, job] of this.buildJobs.entries()) {
      if (job.projectName === projectName && job.deploymentUrl) {
        this.buildJobs.set(jobId, {
          ...job,
          deploymentUrl
        });
      }
    }
  }

  listProjects(): Record<string, unknown>[] {
    return Array.from(this.projects.values())
      .filter((project) => project.latestDeploymentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((project) => ({
        project_name: project.projectName,
        owner_login: project.ownerLogin,
        github_repo: project.githubRepo,
        description: project.description ?? null,
        deployment_url: project.deploymentUrl,
        database_id: project.databaseId ?? null,
        files_bucket_name: project.filesBucketName ?? null,
        cache_namespace_id: project.cacheNamespaceId ?? null,
        runtime_lane: project.runtimeLane ?? "dedicated_worker",
        recommended_runtime_lane: project.recommendedRuntimeLane ?? project.runtimeLane ?? "dedicated_worker",
        has_assets: project.hasAssets ? 1 : 0,
        latest_deployment_id: project.latestDeploymentId ?? null,
        created_at: project.createdAt,
        updated_at: project.updatedAt
      }));
  }

  selectProject(projectName: string): Record<string, unknown> | null {
    const project = this.projects.get(projectName);
    if (!project) {
      return null;
    }

    return {
      project_name: project.projectName,
      owner_login: project.ownerLogin,
      github_repo: project.githubRepo,
      description: project.description ?? null,
      deployment_url: project.deploymentUrl,
      database_id: project.databaseId ?? null,
      files_bucket_name: project.filesBucketName ?? null,
      cache_namespace_id: project.cacheNamespaceId ?? null,
      runtime_lane: project.runtimeLane ?? "dedicated_worker",
      recommended_runtime_lane: project.recommendedRuntimeLane ?? project.runtimeLane ?? "dedicated_worker",
      has_assets: project.hasAssets ? 1 : 0,
      latest_deployment_id: project.latestDeploymentId ?? null,
      created_at: project.createdAt,
      updated_at: project.updatedAt
    };
  }

  selectLatestProjectForRepository(repositoryFullName: string): Record<string, unknown> | null {
    const matches = Array.from(this.projects.values())
      .filter((project) => project.githubRepo === repositoryFullName)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const project = matches[0];
    if (!project) {
      return null;
    }

    return {
      project_name: project.projectName,
      owner_login: project.ownerLogin,
      github_repo: project.githubRepo,
      description: project.description ?? null,
      deployment_url: project.deploymentUrl,
      database_id: project.databaseId ?? null,
      files_bucket_name: project.filesBucketName ?? null,
      cache_namespace_id: project.cacheNamespaceId ?? null,
      runtime_lane: project.runtimeLane ?? "dedicated_worker",
      recommended_runtime_lane: project.recommendedRuntimeLane ?? project.runtimeLane ?? "dedicated_worker",
      has_assets: project.hasAssets ? 1 : 0,
      latest_deployment_id: project.latestDeploymentId ?? null,
      created_at: project.createdAt,
      updated_at: project.updatedAt
    };
  }

  selectBuildJob(jobId: string): Record<string, unknown> | null {
    const job = this.buildJobs.get(jobId);
    return job ? buildJobRow(job) : null;
  }

  selectDeployment(deploymentId: string): Record<string, unknown> | null {
    const deployment = this.deployments.get(deploymentId);
    return deployment
      ? {
          deployment_id: deployment.deploymentId,
          job_id: deployment.jobId ?? null,
          project_name: deployment.projectName,
          owner_login: deployment.ownerLogin,
          github_repo: deployment.githubRepo,
          head_sha: deployment.headSha ?? null,
          status: deployment.status,
          deployment_url: deployment.deploymentUrl,
          artifact_prefix: deployment.artifactPrefix,
          archive_kind: deployment.archiveKind,
          manifest_key: deployment.manifestKey ?? null,
          runtime_lane: deployment.runtimeLane ?? "dedicated_worker",
          recommended_runtime_lane: deployment.recommendedRuntimeLane ?? deployment.runtimeLane ?? "dedicated_worker",
          has_assets: deployment.hasAssets ? 1 : 0,
          created_at: deployment.createdAt
        }
      : null;
  }

  selectLatestPushBuildJob(projectName: string): Record<string, unknown> | null {
    const matches = Array.from(this.buildJobs.values())
      .filter((job) => job.projectName === projectName && job.eventName === "push")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return matches[0] ? buildJobRow(matches[0]) : null;
  }

  countBuildJobsForRepositoryOnDate(repositoryFullName: string, eventName: "push" | "validate", usageDate: string): number {
    return Array.from(this.buildJobs.values()).filter((job) =>
      job.eventName === eventName
      && job.repository.fullName === repositoryFullName
      && job.createdAt.slice(0, 10) === usageDate
    ).length;
  }

  countActiveBuildJobsForRepository(repositoryFullName: string): number {
    return Array.from(this.buildJobs.values()).filter((job) =>
      job.repository.fullName === repositoryFullName
      && (job.status === "queued" || job.status === "in_progress" || job.status === "deploying")
    ).length;
  }

  listActiveBuildJobsForRepository(repositoryFullName: string): Record<string, unknown>[] {
    return Array.from(this.buildJobs.values())
      .filter((job) =>
        job.repository.fullName === repositoryFullName
        && (job.status === "queued" || job.status === "in_progress" || job.status === "deploying")
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((job) => buildJobRow(job));
  }

  upsertBuildJobFromParams(params: unknown[]): void {
    const job: BuildJobRecord = {
      jobId: String(params[0]),
      deliveryId: nullableString(params[1]) ?? undefined,
      eventName: String(params[2]) as BuildJobRecord["eventName"],
      installationId: Number(params[3]),
      repository: JSON.parse(String(params[4])) as BuildJobRecord["repository"],
      ref: String(params[5]),
      headSha: String(params[6]),
      previousSha: nullableString(params[7]) ?? undefined,
      checkRunId: Number(params[8]),
      status: String(params[9]) as BuildJobRecord["status"],
      createdAt: String(params[10]),
      updatedAt: String(params[11]),
      startedAt: nullableString(params[12]) ?? undefined,
      completedAt: nullableString(params[13]) ?? undefined,
      projectName: nullableString(params[14]) ?? undefined,
      deploymentUrl: nullableString(params[15]) ?? undefined,
      deploymentId: nullableString(params[16]) ?? undefined,
      buildLogUrl: nullableString(params[17]) ?? undefined,
      errorKind: (nullableString(params[18]) as BuildJobRecord["errorKind"]) ?? undefined,
      errorMessage: nullableString(params[19]) ?? undefined,
      errorDetail: nullableString(params[20]) ?? undefined,
      runnerId: nullableString(params[21]) ?? undefined
    };

    this.putBuildJob(job);
  }

  consumeOauthGrant(jti: string): boolean {
    if (this.usedOauthGrants.has(jti)) {
      return false;
    }

    this.usedOauthGrants.add(jti);
    return true;
  }

  consumeOauthRefreshToken(jti: string): boolean {
    if (this.usedOauthRefreshTokens.has(jti)) {
      return false;
    }

    this.usedOauthRefreshTokens.add(jti);
    return true;
  }
}

class FakePreparedStatement {
  private params: unknown[] = [];

  constructor(
    private readonly db: FakeD1Database,
    private readonly sql: string
  ) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const normalized = normalizeSql(this.sql);

    if (normalized.includes("from projects") && normalized.includes("where project_name = ?")) {
      return this.db.selectProject(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from projects") && normalized.includes("where github_repo = ?") && normalized.includes("limit 1")) {
      return this.db.selectLatestProjectForRepository(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from project_policies") && normalized.includes("where github_repo = ?")) {
      return this.db.selectProjectPolicy(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from project_deletion_backlogs") && normalized.includes("where github_repo = ?")) {
      return this.db.selectProjectDeletionBacklog(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from featured_projects") && normalized.includes("where github_repo = ?")) {
      return this.db.selectFeaturedProject(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from owner_capacity_overrides") && normalized.includes("where owner_login = ?")) {
      return this.db.selectOwnerCapacityOverride(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from build_jobs") && normalized.includes("where job_id = ?")) {
      return this.db.selectBuildJob(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from build_jobs") && normalized.includes("where project_name = ?") && normalized.includes("event_name = 'push'")) {
      return this.db.selectLatestPushBuildJob(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from deployments") && normalized.includes("where deployment_id = ?")) {
      return this.db.selectDeployment(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from github_user_auth") && normalized.includes("where access_subject = ?")) {
      return this.db.selectGitHubUserAuth(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from mcp_tokens") && normalized.includes("where email = ?")
      && normalized.includes("revoked_at is null") && normalized.includes("datetime(expires_at) > datetime('now')")
      && normalized.includes("limit 1")) {
      return this.db.selectLatestActiveMcpTokenForEmail(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from mcp_tokens") && normalized.includes("where token_hash = ?")) {
      return this.db.selectMcpTokenByHash(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from project_domains") && normalized.includes("where domain_label = ?")) {
      return this.db.selectProjectDomain(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from project_domains") && normalized.includes("where project_name = ?") && normalized.includes("and is_primary = 1")) {
      return this.db.selectPrimaryProjectDomain(String(this.params[0])) as T | null;
    }

    if (normalized.includes("select count(*) as count from build_jobs")
      && normalized.includes("json_extract(repository_json, '$.fullname') = ?")
      && normalized.includes("status in ('queued', 'in_progress', 'deploying')")) {
      return ({
        count: this.db.countActiveBuildJobsForRepository(String(this.params[0]))
      } as T);
    }

    if (normalized.includes("select count(*) as count from build_jobs")
      && normalized.includes("json_extract(repository_json, '$.fullname') = ?")
      && normalized.includes("substr(created_at, 1, 10) = ?")) {
      return ({
        count: this.db.countBuildJobsForRepositoryOnDate(
          String(this.params[1]),
          String(this.params[0]) as "push" | "validate",
          String(this.params[2])
        )
      } as T);
    }

    if (normalized.includes("insert into oauth_used_grants")) {
      const consumed = this.db.consumeOauthGrant(String(this.params[0]));
      return consumed ? ({ jti: String(this.params[0]) } as T) : null;
    }

    if (normalized.includes("insert into oauth_used_refresh_tokens")) {
      const consumed = this.db.consumeOauthRefreshToken(String(this.params[0]));
      return consumed ? ({ jti: String(this.params[0]) } as T) : null;
    }

    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const normalized = normalizeSql(this.sql);

    if (normalized.includes("from projects") && normalized.includes("where latest_deployment_id is not null")) {
      return { results: this.db.listProjects() as T[] };
    }

    if (normalized.includes("from featured_projects fp") && normalized.includes("join projects p")) {
      return { results: this.db.listFeaturedProjects() as T[] };
    }

    if (normalized.includes("from owner_capacity_overrides") && normalized.includes("order by owner_login asc")) {
      return { results: this.db.listOwnerCapacityOverrides() as T[] };
    }

    if (normalized.includes("from project_secrets") && normalized.includes("where github_repo = ?")) {
      return { results: this.db.listProjectSecrets(String(this.params[0])) as T[] };
    }

    if (normalized.includes("from project_domains") && normalized.includes("where project_name = ?")) {
      return { results: this.db.listProjectDomains(String(this.params[0])) as T[] };
    }

    if (normalized.includes("from project_domains") && normalized.includes("where github_repo = ?")) {
      return { results: this.db.listProjectDomainsForRepository(String(this.params[0])) as T[] };
    }

    if (normalized.includes("from deployments") && normalized.includes("where project_name = ?") && normalized.includes("and status = 'success'") && normalized.includes("and archive_kind = 'full'")) {
      return { results: this.db.listRetainedSuccessfulDeployments(String(this.params[0])) as T[] };
    }

    if (normalized.includes("from deployments") && normalized.includes("where github_repo = ?") && normalized.includes("and status = 'success'") && normalized.includes("and archive_kind = 'full'")) {
      return { results: this.db.listRetainedSuccessfulDeploymentsForRepository(String(this.params[0])) as T[] };
    }

    if (normalized.includes("from deployments") && normalized.includes("where status = 'failure'") && normalized.includes("and archive_kind != 'none'") && normalized.includes("created_at < ?")) {
      return { results: this.db.listExpiredRetainedFailedDeployments(String(this.params[0])) as T[] };
    }

    if (normalized.includes("from deployments") && normalized.includes("where project_name = ?")) {
      return { results: this.db.listDeployments(String(this.params[0])) as T[] };
    }

    if (normalized.includes("from deployments") && normalized.includes("where github_repo = ?")) {
      return { results: this.db.listDeploymentsForRepository(String(this.params[0])) as T[] };
    }

    if (normalized.includes("from build_jobs")
      && normalized.includes("json_extract(repository_json, '$.fullname') = ?")
      && normalized.includes("status in ('queued', 'in_progress', 'deploying')")) {
      return { results: this.db.listActiveBuildJobsForRepository(String(this.params[0])) as T[] };
    }

    if (normalized.includes("from projects") && normalized.includes("where github_repo = ?") && !normalized.includes("limit 1")) {
      return { results: this.db.listProjectsForRepository(String(this.params[0])) as T[] };
    }

    if (normalized.includes("from project_deletion_backlogs") && normalized.includes("order by updated_at asc") && normalized.includes("limit ?")) {
      return { results: this.db.listProjectDeletionBacklogs(Number(this.params[0])) as T[] };
    }

    return { results: [] };
  }

  async run(): Promise<Record<string, never>> {
    const normalized = normalizeSql(this.sql);

    if (normalized.includes("insert into projects")) {
      this.db.upsertProjectFromParams(this.params);
    }

    if (normalized.includes("insert into build_jobs")) {
      this.db.upsertBuildJobFromParams(this.params);
    }

    if (normalized.includes("insert into deployments")) {
      this.db.upsertDeploymentFromParams(this.params);
    }

    if (normalized.includes("insert into github_user_auth")) {
      this.db.upsertGitHubUserAuthFromParams(this.params);
    }

    if (normalized.includes("insert into project_policies")) {
      this.db.putProjectPolicy({
        githubRepo: String(this.params[0]),
        projectName: nullableString(this.params[1]) ?? undefined,
        aiEnabled: Number(this.params[2]) === 1,
        vectorizeEnabled: Number(this.params[3]) === 1,
        roomsEnabled: Number(this.params[4]) === 1,
        maxValidationsPerDay: Number(this.params[5]),
        maxDeploymentsPerDay: Number(this.params[6]),
        maxConcurrentBuilds: Number(this.params[7]),
        maxAssetBytes: Number(this.params[8]),
        createdAt: String(this.params[9]),
        updatedAt: String(this.params[10])
      });
    }

    if (normalized.includes("insert into project_secrets")) {
      this.db.upsertProjectSecretFromParams(this.params);
    }

    if (normalized.includes("insert into project_domains")) {
      this.db.upsertProjectDomainFromParams(this.params);
    }

    if (normalized.includes("insert into project_deletion_backlogs")) {
      this.db.upsertProjectDeletionBacklogFromParams(this.params);
    }

    if (normalized.includes("insert into featured_projects")) {
      this.db.upsertFeaturedProjectFromParams(this.params);
    }

    if (normalized.includes("insert into owner_capacity_overrides")) {
      this.db.upsertOwnerCapacityOverrideFromParams(this.params);
    }

    if (normalized.includes("insert into mcp_tokens")) {
      this.db.putMcpToken({
        token_hash: String(this.params[0]),
        email: String(this.params[1]),
        subject: String(this.params[2]),
        label: String(this.params[3]),
        created_at: "2026-03-30T12:00:00",
        expires_at: String(this.params[4]),
        revoked_at: null
      });
    }

    if (normalized.includes("delete from github_user_auth") && normalized.includes("where github_user_id = ?")) {
      this.db.deleteGitHubUserAuthByGitHubUserId(Number(this.params[0]));
    }

    if (normalized.includes("delete from project_secrets") && normalized.includes("where github_repo = ?") && normalized.includes("and secret_name = ?")) {
      this.db.deleteProjectSecret(String(this.params[0]), String(this.params[1]));
    }

    if (normalized.includes("delete from project_domains") && normalized.includes("where domain_label = ?")) {
      this.db.deleteProjectDomain(String(this.params[0]));
    }

    if (normalized.includes("delete from project_domains") && normalized.includes("where project_name = ?")) {
      this.db.deleteProjectDomainsForProject(String(this.params[0]));
    }

    if (normalized.includes("delete from project_domains") && normalized.includes("where github_repo = ?")) {
      this.db.deleteProjectDomainsForRepository(String(this.params[0]));
    }

    if (normalized.includes("delete from project_secrets") && normalized.includes("where project_name = ?")) {
      this.db.deleteProjectSecretsForProject(String(this.params[0]));
    }

    if (normalized.includes("delete from project_secrets") && normalized.includes("where github_repo = ?")) {
      this.db.deleteProjectSecretsForRepository(String(this.params[0]));
    }

    if (normalized.includes("delete from deployments") && normalized.includes("where project_name = ?")) {
      this.db.deleteDeploymentsForProject(String(this.params[0]));
    }

    if (normalized.includes("delete from deployments") && normalized.includes("where github_repo = ?")) {
      this.db.deleteDeploymentsForRepository(String(this.params[0]));
    }

    if (normalized.includes("delete from build_jobs") && normalized.includes("where project_name = ?")) {
      this.db.deleteBuildJobsForProject(String(this.params[0]));
    }

    if (normalized.includes("delete from build_jobs") && normalized.includes("json_extract(repository_json, '$.fullname') = ?")) {
      this.db.deleteBuildJobsForRepository(String(this.params[0]));
    }

    if (normalized.includes("delete from projects") && normalized.includes("where project_name = ?")) {
      this.db.deleteProject(String(this.params[0]));
    }

    if (normalized.includes("delete from projects") && normalized.includes("where github_repo = ?")) {
      this.db.deleteProjectsForRepository(String(this.params[0]));
    }

    if (normalized.includes("delete from project_policies") && normalized.includes("where github_repo = ?")) {
      this.db.deleteProjectPolicy(String(this.params[0]));
    }

    if (normalized.includes("delete from project_deletion_backlogs") && normalized.includes("where github_repo = ?")) {
      this.db.deleteProjectDeletionBacklog(String(this.params[0]));
    }

    if (normalized.includes("delete from featured_projects") && normalized.includes("where github_repo = ?")) {
      this.db.deleteFeaturedProject(String(this.params[0]));
    }

    if (normalized.includes("delete from owner_capacity_overrides") && normalized.includes("where owner_login = ?")) {
      this.db.deleteOwnerCapacityOverride(String(this.params[0]));
    }

    if (normalized.includes("update deployments") && normalized.includes("set archive_kind = ?, manifest_key = ?") && normalized.includes("where deployment_id = ?")) {
      this.db.updateDeploymentArchiveState(
        String(this.params[2]),
        String(this.params[0]) as DeploymentRecord["archiveKind"],
        nullableString(this.params[1]) ?? undefined
      );
    }

    if (normalized.includes("update projects") && normalized.includes("set latest_deployment_id = null") && normalized.includes("where github_repo = ?")) {
      this.db.unpublishProjectsForRepository(String(this.params[1]), String(this.params[0]));
    }

    if (normalized.includes("update projects") && normalized.includes("set deployment_url = ?, updated_at = ?") && normalized.includes("where project_name = ?")) {
      this.db.updateProjectDeploymentUrl(String(this.params[2]), String(this.params[0]), String(this.params[1]));
    }

    if (normalized.includes("update build_jobs") && normalized.includes("set deployment_url = ?") && normalized.includes("where project_name = ?")) {
      this.db.updateBuildJobDeploymentUrl(String(this.params[1]), String(this.params[0]));
    }

    if (normalized.includes("update mcp_tokens") && normalized.includes("set revoked_at = datetime('now')") && normalized.includes("where email = ?")) {
      this.db.revokeActiveMcpTokensForEmail(String(this.params[0]));
    }

    return {};
  }
}

function buildJobRow(job: BuildJobRecord): Record<string, unknown> {
  return {
    job_id: job.jobId,
    delivery_id: job.deliveryId ?? null,
    event_name: job.eventName,
    installation_id: job.installationId,
    repository_json: JSON.stringify(job.repository),
    ref: job.ref,
    head_sha: job.headSha,
    previous_sha: job.previousSha ?? null,
    check_run_id: job.checkRunId,
    status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    started_at: job.startedAt ?? null,
    completed_at: job.completedAt ?? null,
    project_name: job.projectName ?? null,
    deployment_url: job.deploymentUrl ?? null,
    deployment_id: job.deploymentId ?? null,
    build_log_url: job.buildLogUrl ?? null,
    error_kind: job.errorKind ?? null,
    error_message: job.errorMessage ?? null,
    error_detail: job.errorDetail ?? null,
    runner_id: job.runnerId ?? null
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function coerceBlobPart(value: string | ArrayBuffer | ArrayBufferView | Blob): string | ArrayBuffer | Blob {
  if (typeof value === "string" || value instanceof ArrayBuffer || value instanceof Blob) {
    return value;
  }

  const bytes = new Uint8Array(value.byteLength);
  bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return bytes.buffer;
}
