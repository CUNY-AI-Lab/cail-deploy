import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk-legacy/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk-legacy/client/streamableHttp.js";
import {
  createTestIdentityIssuer,
  TEST_OPERATIONAL_SUBJECTS,
  TEST_SUBJECTS,
} from "@cuny-ai-lab/cail-identity/testing";

const config = "wrangler.oauth-test.jsonc";
const database = "kale-release-control-plane-oauth-local";
const requestId = "22222222-2222-4222-8222-222222222222";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} ${command[1] ?? ""} failed (${exitCode})\n${stdout}\n${stderr}`);
  }
  return stdout.trim();
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(bytes).toString("base64url");
}

interface RegisteredClient {
  client_id: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

interface AuthorizationSession {
  url: URL;
  verifier: string;
  nonce: string;
}

async function responseBody(response: Response): Promise<string> {
  const body = await response.text();
  return `${response.status} ${body.slice(0, 600)}`;
}

async function registerClient(baseUrl: string, name: string): Promise<RegisteredClient> {
  const response = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: ["http://127.0.0.1:43123/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (response.status !== 201) throw new Error(`DCR failed: ${await responseBody(response)}`);
  return (await response.json()) as RegisteredClient;
}

async function beginAuthorization(
  baseUrl: string,
  clientId: string,
  identityJwt: string,
  options: {
    state?: string;
    resource?: string;
    challengeMethod?: string;
    omitChallenge?: boolean;
  } = {},
): Promise<AuthorizationSession | Response> {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${baseUrl}/api/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", "http://127.0.0.1:43123/callback");
  url.searchParams.set("state", options.state ?? crypto.randomUUID());
  if (!options.omitChallenge) {
    url.searchParams.set("code_challenge", await sha256Base64Url(verifier));
    url.searchParams.set("code_challenge_method", options.challengeMethod ?? "S256");
  }
  url.searchParams.set("scope", "cail:deploy");
  url.searchParams.set("resource", options.resource ?? `${baseUrl}/mcp`);
  const response = await fetch(url, {
    headers: { "X-CAIL-Identity-JWT": identityJwt },
    redirect: "manual",
  });
  if (response.status !== 200) return response;
  const html = await response.text();
  const match = html.match(/name="consentNonce" value="([^"]+)"/u);
  assert(match?.[1], "consent page did not contain an opaque nonce");
  assert(html.includes("cail:deploy"), "consent page did not name the exact scope");
  return { url, verifier, nonce: match[1] };
}

async function submitConsent(
  baseUrl: string,
  session: AuthorizationSession,
  identityJwt: string,
  decision: "approve" | "deny",
): Promise<Response> {
  return fetch(session.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: baseUrl,
      "X-CAIL-Identity-JWT": identityJwt,
    },
    body: new URLSearchParams({ consentNonce: session.nonce, decision }),
    redirect: "manual",
  });
}

async function listKvKeys(cwd: string, persistTo: string, prefix: string): Promise<string[]> {
  const output = await run(
    [
      "bunx",
      "wrangler",
      "kv",
      "key",
      "list",
      "--binding",
      "OAUTH_KV",
      "--prefix",
      prefix,
      "--local",
      "--persist-to",
      persistTo,
      "--config",
      config,
    ],
    cwd,
  );
  return (JSON.parse(output) as Array<{ name: string }>).map((entry) => entry.name);
}

async function exchangeCode(
  baseUrl: string,
  clientId: string,
  verifier: string,
  code: string,
): Promise<TokenResponse> {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:43123/callback",
      code,
      code_verifier: verifier,
      resource: `${baseUrl}/mcp`,
    }),
  });
  if (response.status !== 200)
    throw new Error(`token exchange failed: ${await responseBody(response)}`);
  return (await response.json()) as TokenResponse;
}

async function authorize(
  baseUrl: string,
  clientId: string,
  identityJwt: string,
): Promise<TokenResponse> {
  const session = await beginAuthorization(baseUrl, clientId, identityJwt);
  if (session instanceof Response)
    throw new Error(`authorization failed: ${await responseBody(session)}`);
  const approval = await submitConsent(baseUrl, session, identityJwt, "approve");
  if (approval.status !== 302) throw new Error(`approval failed: ${await responseBody(approval)}`);
  const approvalReplay = await submitConsent(baseUrl, session, identityJwt, "approve");
  assert(approvalReplay.status === 409, "approved consent nonce replay was not denied");
  const location = approval.headers.get("Location");
  assert(location, "approval did not redirect");
  const code = new URL(location).searchParams.get("code");
  assert(code, "approval redirect did not contain a code");
  return exchangeCode(baseUrl, clientId, session.verifier, code);
}

async function rpc(
  baseUrl: string,
  token: string,
  message: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
      "X-CAIL-Request-Id": requestId,
      ...headers,
    },
    body: JSON.stringify(message),
  });
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text;
  assert(typeof text === "string", "MCP tool result did not contain text");
  return text;
}

async function mutateTokenRecord(
  cwd: string,
  persistTo: string,
  token: string,
  mutate: (record: Record<string, unknown>) => void,
): Promise<void> {
  const [userId, grantId] = token.split(":", 3);
  assert(userId && grantId, "provider token format changed");
  const id = createHash("sha256").update(token).digest("hex");
  const key = `token:${userId}:${grantId}:${id}`;
  const common = [
    "--binding",
    "OAUTH_KV",
    "--local",
    "--persist-to",
    persistTo,
    "--config",
    config,
  ];
  const value = await run(["bunx", "wrangler", "kv", "key", "get", key, ...common], cwd);
  const record = JSON.parse(value) as Record<string, unknown>;
  mutate(record);
  await run(["bunx", "wrangler", "kv", "key", "put", key, JSON.stringify(record), ...common], cwd);
}

async function expireConsentNonce(cwd: string, persistTo: string, nonce: string): Promise<void> {
  assert(/^ocn_[0-9a-f]{32}$/u.test(nonce), "unsafe consent nonce");
  await run(
    [
      "bunx",
      "wrangler",
      "d1",
      "execute",
      database,
      "--local",
      "--persist-to",
      persistTo,
      "--config",
      config,
      "--command",
      `UPDATE oauth_consent_nonces SET expires_at = '2000-01-01T00:00:00.000Z' WHERE nonce = '${nonce}'`,
    ],
    cwd,
  );
}

const cwd = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const persistTo = await mkdtemp(join(tmpdir(), "kale-oauth-workerd-"));
const portSocket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = portSocket.port;
portSocket.stop(true);
const baseUrl = `http://127.0.0.1:${port}`;
// Defaults to CAIL_CANONICAL_ISSUER; see check-release-workerd.ts for why a
// `.invalid` test issuer no longer reaches token validation at all.
const issuer = await createTestIdentityIssuer();
const aliceJwt = await issuer.mintIdentityJwt({
  audience: "cail:deploy",
  subject: TEST_SUBJECTS.alice,
  operationalSubject: TEST_OPERATIONAL_SUBJECTS.alice,
});
const bobJwt = await issuer.mintIdentityJwt({
  audience: "cail:deploy",
  subject: TEST_SUBJECTS.bob,
  operationalSubject: TEST_OPERATIONAL_SUBJECTS.bob,
});
const wrongAudienceJwt = await issuer.mintIdentityJwt({
  audience: "cail:not-deploy",
  subject: TEST_SUBJECTS.alice,
});
const expiredJwt = await issuer.mintIdentityJwt({
  audience: "cail:deploy",
  subject: TEST_SUBJECTS.alice,
  now: Math.floor(Date.now() / 1000) - 7200,
  expiresInSeconds: 60,
});
const forgedIssuer = await createTestIdentityIssuer({ issuer: issuer.issuer });
const forgedIdentityJwt = await forgedIssuer.mintIdentityJwt({
  audience: "cail:deploy",
  subject: TEST_SUBJECTS.alice,
});

await run(
  [
    "bunx",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    database,
    "--local",
    "--persist-to",
    persistTo,
    "--config",
    config,
  ],
  cwd,
);

const worker = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--local",
    "--config",
    config,
    "--port",
    String(port),
    "--persist-to",
    persistTo,
    "--var",
    `PUBLIC_BASE_URL:${baseUrl}`,
    "--var",
    "AUTH_MODE:cail-jwt",
    "--var",
    "SERVICE_AUDIENCE:cail:deploy",
    "--var",
    `CAIL_IDENTITY_ISSUER:${issuer.issuer}`,
    "--var",
    `CAIL_IDENTITY_JWKS:${issuer.jwksJson}`,
    "--var",
    "RUN_ID:oauth-local-test",
    "--var",
    "WFP_ACCOUNT_ID:not-used",
    "--var",
    "WFP_NAMESPACE:not-used",
  ],
  { cwd, stdout: "pipe", stderr: "pipe" },
);

try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Local workerd is still starting.
    }
    if (worker.exitCode !== null) break;
    await Bun.sleep(100);
  }
  if (!ready) {
    const stdout = await new Response(worker.stdout).text();
    const stderr = await new Response(worker.stderr).text();
    throw new Error(`OAuth workerd did not start\n${stdout}\n${stderr}`);
  }

  const protectedMetadataResponse = await fetch(
    `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
  );
  assert(protectedMetadataResponse.status === 200, "protected-resource metadata failed");
  const protectedMetadata = (await protectedMetadataResponse.json()) as Record<string, unknown>;
  assert(protectedMetadata.resource === `${baseUrl}/mcp`, "metadata resource drifted");
  assert(
    JSON.stringify(protectedMetadata.authorization_servers) === JSON.stringify([baseUrl]),
    "metadata authorization server drifted",
  );
  assert(
    JSON.stringify(protectedMetadata.scopes_supported) === JSON.stringify(["cail:deploy"]),
    "metadata scopes drifted",
  );

  const serverMetadataResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert(serverMetadataResponse.status === 200, "authorization-server metadata failed");
  const serverMetadata = (await serverMetadataResponse.json()) as Record<string, unknown>;
  assert(serverMetadata.issuer === baseUrl, "OAuth issuer drifted");
  assert(
    serverMetadata.authorization_endpoint === `${baseUrl}/api/oauth/authorize` &&
      serverMetadata.token_endpoint === `${baseUrl}/oauth/token` &&
      serverMetadata.registration_endpoint === `${baseUrl}/oauth/register`,
    "OAuth endpoints drifted",
  );
  assert(
    JSON.stringify(serverMetadata.code_challenge_methods_supported) === JSON.stringify(["S256"]),
    "plain PKCE was advertised",
  );
  assert(serverMetadata.client_id_metadata_document_supported === false, "CIMD was enabled");
  assert(
    !(serverMetadata.grant_types_supported as string[]).includes(
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ),
    "token exchange was enabled",
  );

  const client = await registerClient(baseUrl, "Kale OAuth conformance client");
  const secondClient = await registerClient(baseUrl, "Changed client negative");

  const plain = await beginAuthorization(baseUrl, client.client_id, aliceJwt, {
    challengeMethod: "plain",
  });
  assert(plain instanceof Response && plain.status === 400, "plain PKCE was not denied");
  const missingPkce = await beginAuthorization(baseUrl, client.client_id, aliceJwt, {
    omitChallenge: true,
  });
  assert(
    missingPkce instanceof Response && missingPkce.status === 400,
    "missing PKCE was not denied",
  );

  const missingIdentitySession = await beginAuthorization(baseUrl, client.client_id, "");
  assert(
    missingIdentitySession instanceof Response && missingIdentitySession.status === 401,
    "missing CAIL identity was not denied",
  );
  const wrongAudienceSession = await beginAuthorization(
    baseUrl,
    client.client_id,
    wrongAudienceJwt,
  );
  assert(
    wrongAudienceSession instanceof Response && wrongAudienceSession.status === 401,
    "wrong-audience CAIL identity was not denied",
  );
  const expiredIdentitySession = await beginAuthorization(baseUrl, client.client_id, expiredJwt);
  assert(
    expiredIdentitySession instanceof Response && expiredIdentitySession.status === 401,
    "expired CAIL identity was not denied",
  );
  const forgedIdentitySession = await beginAuthorization(
    baseUrl,
    client.client_id,
    forgedIdentityJwt,
  );
  assert(
    forgedIdentitySession instanceof Response && forgedIdentitySession.status === 401,
    "forged CAIL identity was not denied",
  );

  const noGrant = await beginAuthorization(baseUrl, client.client_id, aliceJwt, {
    state: "get-does-not-grant",
  });
  assert(!(noGrant instanceof Response), "valid consent GET failed");
  assert(noGrant.url.searchParams.get("response_type") === "code", "consent request drifted");
  assert((await listKvKeys(cwd, persistTo, "grant:")).length === 0, "consent GET created a grant");

  const malformedRequestId = "not-a-uuid";
  const invalidAuthorizeGet = await fetch(noGrant.url, {
    headers: {
      "X-CAIL-Identity-JWT": aliceJwt,
      "X-CAIL-Request-Id": malformedRequestId,
    },
  });
  assert(invalidAuthorizeGet.status === 400, "authorize GET accepted a malformed request id");
  assert(
    ((await invalidAuthorizeGet.json()) as { error?: { code?: string } }).error?.code ===
      "invalid_request_id",
    "authorize GET request-id error drifted",
  );
  const invalidAuthorizePost = await fetch(noGrant.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: baseUrl,
      "X-CAIL-Identity-JWT": aliceJwt,
      "X-CAIL-Request-Id": malformedRequestId,
    },
    body: new URLSearchParams({ consentNonce: noGrant.nonce, decision: "approve" }),
  });
  assert(invalidAuthorizePost.status === 400, "authorize POST accepted a malformed request id");
  assert(
    ((await invalidAuthorizePost.json()) as { error?: { code?: string } }).error?.code ===
      "invalid_request_id",
    "authorize POST request-id error drifted",
  );

  const missingPostIdentity = await submitConsent(baseUrl, noGrant, "", "approve");
  assert(missingPostIdentity.status === 401, "consent POST accepted missing identity");
  const wrongPostAudience = await submitConsent(baseUrl, noGrant, wrongAudienceJwt, "approve");
  assert(wrongPostAudience.status === 401, "consent POST accepted wrong-audience identity");
  const expiredPostIdentity = await submitConsent(baseUrl, noGrant, expiredJwt, "approve");
  assert(expiredPostIdentity.status === 401, "consent POST accepted expired identity");
  const forgedPostIdentity = await submitConsent(baseUrl, noGrant, forgedIdentityJwt, "approve");
  assert(forgedPostIdentity.status === 401, "consent POST accepted forged identity");

  const changedSubject = await submitConsent(baseUrl, noGrant, bobJwt, "approve");
  assert(changedSubject.status === 409, "changed consent subject was not denied");

  const changedRequestUrl = new URL(noGrant.url);
  changedRequestUrl.searchParams.set("state", "changed-state");
  const changedRequest = await submitConsent(
    baseUrl,
    { ...noGrant, url: changedRequestUrl },
    aliceJwt,
    "approve",
  );
  assert(changedRequest.status === 409, "changed authorization request was not denied");

  const changedClientUrl = new URL(noGrant.url);
  changedClientUrl.searchParams.set("client_id", secondClient.client_id);
  const changedClient = await submitConsent(
    baseUrl,
    { ...noGrant, url: changedClientUrl },
    aliceJwt,
    "approve",
  );
  assert(changedClient.status === 409, "changed consent client was not denied");

  const expiredConsent = await beginAuthorization(baseUrl, client.client_id, aliceJwt);
  assert(!(expiredConsent instanceof Response), "expiry consent GET failed");
  await expireConsentNonce(cwd, persistTo, expiredConsent.nonce);
  const expiredConsentResult = await submitConsent(baseUrl, expiredConsent, aliceJwt, "approve");
  assert(expiredConsentResult.status === 409, "expired consent nonce was not denied");

  const denied = await beginAuthorization(baseUrl, client.client_id, aliceJwt);
  assert(!(denied instanceof Response), "deny consent GET failed");
  const denial = await submitConsent(baseUrl, denied, aliceJwt, "deny");
  assert(denial.status === 302, "consent denial did not redirect");
  assert(
    new URL(denial.headers.get("Location") ?? "http://invalid").searchParams.get("error") ===
      "access_denied",
    "consent denial did not return access_denied",
  );
  const denialReplay = await submitConsent(baseUrl, denied, aliceJwt, "deny");
  assert(denialReplay.status === 409, "consent nonce replay was not denied");
  assert(
    (await listKvKeys(cwd, persistTo, "grant:")).length === 0,
    "consent denial created a grant",
  );

  const aliceToken = await authorize(baseUrl, client.client_id, aliceJwt);
  assert(
    aliceToken.token_type.toLowerCase() === "bearer" && aliceToken.scope === "cail:deploy",
    "issued token contract drifted",
  );

  const missingBearer = await fetch(`${baseUrl}/mcp`, { method: "POST" });
  assert(missingBearer.status === 401, "missing bearer was not denied");
  assert(
    missingBearer.headers
      .get("WWW-Authenticate")
      ?.includes(`resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`),
    "missing bearer challenge metadata drifted",
  );
  const correlatedInitialize = await rpc(baseUrl, aliceToken.access_token, {
    jsonrpc: "2.0",
    id: "correlation",
    method: "initialize",
    params: {},
  });
  assert(correlatedInitialize.status === 200, "authenticated initialize failed");
  assert(
    correlatedInitialize.headers.get("X-CAIL-Request-Id") === requestId,
    "authenticated MCP response omitted the canonical request id",
  );
  await correlatedInitialize.body?.cancel();
  const forgedBearer = await rpc(baseUrl, "forged", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  assert(forgedBearer.status === 401, "forged bearer was not denied");
  assert(!(await forgedBearer.text()).includes("forged"), "forged bearer was echoed");

  const bothCredentials = await rpc(
    baseUrl,
    aliceToken.access_token,
    { jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
    { "X-CAIL-Identity-JWT": aliceJwt },
  );
  assert(bothCredentials.status === 401, "ambiguous credentials were not denied");
  assert(
    ((await bothCredentials.json()) as { error?: { code?: string } }).error?.code ===
      "credential_ambiguity",
    "ambiguous credential error drifted",
  );
  const invalidBearerAndIdentity = await rpc(
    baseUrl,
    "forged",
    { jsonrpc: "2.0", id: "ambiguous-invalid-bearer", method: "initialize", params: {} },
    { "X-CAIL-Identity-JWT": aliceJwt },
  );
  assert(
    invalidBearerAndIdentity.status === 401 &&
      ((await invalidBearerAndIdentity.json()) as { error?: { code?: string } }).error?.code ===
        "credential_ambiguity",
    "credential ambiguity depended on bearer validity",
  );

  const rawBearerResponse = await fetch(`${baseUrl}/v1/projects`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${aliceToken.access_token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "raw-bearer-denied",
    },
    body: JSON.stringify({ name: "must not exist" }),
  });
  assert(rawBearerResponse.status === 401, "raw /v1 accepted an OAuth bearer");
  assert(
    !(await rawBearerResponse.text()).includes(aliceToken.access_token),
    "raw API error echoed an OAuth bearer",
  );
  const rawJwtResponse = await fetch(`${baseUrl}/v1/projects`, {
    method: "POST",
    headers: {
      "X-CAIL-Identity-JWT": aliceJwt,
      "Content-Type": "application/json",
      "Idempotency-Key": "raw-jwt-accepted",
    },
    body: JSON.stringify({ name: "Raw JWT fixture" }),
  });
  assert(rawJwtResponse.status === 201, "raw /v1 no longer accepts its exact CAIL JWT");

  const standardTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${aliceToken.access_token}`,
        "X-CAIL-Request-Id": requestId,
      },
    },
  });
  const standardClient = new Client({ name: "kale-oauth-conformance", version: "0.1.0" });
  await standardClient.connect(standardTransport);
  const listed = await standardClient.listTools();
  assert(listed.tools.length === 6, "standard MCP client did not list six tools");

  const spoofedProjectResult = await standardClient.callTool({
    name: "kale.create_project",
    arguments: {
      name: "OAuth MCP fixture",
      idempotencyKey: "oauth-standard-client-project-spoofed",
      subject: TEST_SUBJECTS.bob,
      log_sub: TEST_OPERATIONAL_SUBJECTS.bob,
    },
  });
  assert(spoofedProjectResult.isError === true, "MCP accepted undeclared identity arguments");
  const spoofedProjectError = JSON.parse(toolText(spoofedProjectResult)) as {
    error?: { code?: string; requestId?: string };
  };
  assert(
    spoofedProjectError.error?.code === "invalid_mcp_arguments" &&
      spoofedProjectError.error.requestId === requestId,
    "MCP undeclared identity rejection lost its correlated contract",
  );

  const projectResult = await standardClient.callTool({
    name: "kale.create_project",
    arguments: {
      name: "OAuth MCP fixture",
      idempotencyKey: "oauth-standard-client-project",
    },
  });
  const project = JSON.parse(toolText(projectResult)) as { projectId: string };
  assert(/^prj_[0-9a-f]{32}$/u.test(project.projectId), "standard client project failed");

  const artifact = new Uint8Array(
    await Bun.file(new URL("../fixtures/worker-artifact.v1.json", import.meta.url)).arrayBuffer(),
  );
  assert(artifact.byteLength === 253 && artifact.at(-1) === 10, "golden artifact bytes drifted");
  const artifactDigest = createHash("sha256").update(artifact).digest("hex");
  assert(
    artifactDigest === "fb711fd92301a9ef5aae345cc3da06408e7d291b8e0cdff1d4434c216e459e82",
    "golden artifact digest drifted",
  );
  const uploadResult = await standardClient.callTool({
    name: "kale.upload_revision",
    arguments: {
      projectId: project.projectId,
      artifactBase64: Buffer.from(artifact).toString("base64"),
      contentDigest: "sha-256=:+3Ef2SMBqe9arjRcw9oGQI59KRuODN/x1ENMIW5FnoI=:",
    },
  });
  const revision = JSON.parse(toolText(uploadResult)) as {
    revisionId: string;
    artifactBytes: number;
  };
  assert(
    revision.revisionId === `rev_sha256_${artifactDigest}` && revision.artifactBytes === 253,
    "MCP upload changed the exact bytes/digest/revision",
  );
  await standardClient.close();

  const modernTransport = new ModernStreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${aliceToken.access_token}`,
        "X-CAIL-Request-Id": requestId,
      },
    },
  });
  const modernClient = new ModernClient(
    { name: "kale-oauth-modern-conformance", version: "0.1.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await modernClient.connect(modernTransport);
  assert(
    modernClient.getNegotiatedProtocolVersion() === "2026-07-28",
    "modern MCP client did not negotiate 2026-07-28",
  );
  const modernListed = await modernClient.listTools();
  assert(
    JSON.stringify(modernListed.tools.map((tool) => tool.name)) ===
      JSON.stringify(listed.tools.map((tool) => tool.name)),
    "modern and legacy MCP clients saw different tools",
  );
  const modernProjectResult = await modernClient.callTool({
    name: "kale.create_project",
    arguments: {
      name: "OAuth MCP modern fixture",
      idempotencyKey: "oauth-modern-client-project",
    },
  });
  const modernProject = JSON.parse(toolText(modernProjectResult)) as { projectId?: string };
  assert(
    typeof modernProject.projectId === "string" &&
      /^prj_[0-9a-f]{32}$/u.test(modernProject.projectId),
    "modern client project failed",
  );
  await modernClient.close();

  const bobToken = await authorize(baseUrl, client.client_id, bobJwt);
  for (const [name, arguments_] of [
    [
      "kale.upload_revision",
      {
        projectId: project.projectId,
        artifactBase64: Buffer.from(artifact).toString("base64"),
        contentDigest: "sha-256=:+3Ef2SMBqe9arjRcw9oGQI59KRuODN/x1ENMIW5FnoI=:",
      },
    ],
    ["kale.get_release", { projectId: project.projectId, releaseId: `rel_${"a".repeat(32)}` }],
    [
      "kale.approve_release",
      {
        projectId: project.projectId,
        releaseId: `rel_${"a".repeat(32)}`,
        idempotencyKey: "cross-subject-approval",
      },
    ],
  ] as const) {
    const denialResponse = await rpc(baseUrl, bobToken.access_token, {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: arguments_ },
    });
    assert(denialResponse.status === 200, `${name} did not return an MCP tool result`);
    const denialBody = (await denialResponse.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    const denialText = denialBody.result?.content?.[0]?.text ?? "";
    assert(
      denialBody.result?.isError === true &&
        denialText.includes('"code":"project_not_found"') &&
        denialText.includes(`"requestId":"${requestId}"`),
      `${name} did not preserve 404 concealment/request id`,
    );
  }

  const expiredAccessToken = await authorize(baseUrl, client.client_id, aliceJwt);
  await mutateTokenRecord(cwd, persistTo, expiredAccessToken.access_token, (record) => {
    record.expiresAt = Math.floor(Date.now() / 1000) - 1;
  });
  const expiredBearer = await rpc(baseUrl, expiredAccessToken.access_token, {
    jsonrpc: "2.0",
    id: 3,
    method: "initialize",
    params: {},
  });
  assert(expiredBearer.status === 401, "expired bearer was not denied");
  assert(
    !(await expiredBearer.text()).includes(expiredAccessToken.access_token),
    "expired bearer was echoed",
  );

  const wrongResourceToken = await authorize(baseUrl, client.client_id, aliceJwt);
  await mutateTokenRecord(cwd, persistTo, wrongResourceToken.access_token, (record) => {
    record.audience = `${baseUrl}/wrong-resource`;
  });
  const wrongResourceBearer = await rpc(baseUrl, wrongResourceToken.access_token, {
    jsonrpc: "2.0",
    id: 4,
    method: "initialize",
    params: {},
  });
  assert(wrongResourceBearer.status === 401, "wrong-resource bearer was not denied");
  assert(
    !(await wrongResourceBearer.text()).includes(wrongResourceToken.access_token),
    "wrong-resource bearer was echoed",
  );

  console.log(
    JSON.stringify(
      {
        gate: "oauth-mcp-local-workerd",
        provider: "@cloudflare/workers-oauth-provider@0.5.0",
        standardClient: "@modelcontextprotocol/sdk@1.29.0",
        modernClient: "@modelcontextprotocol/client@2.0.0",
        protocolVersions: ["2025-06-18", "2026-07-28"],
        tools: listed.tools.map((tool) => tool.name),
        projectId: project.projectId,
        revisionId: revision.revisionId,
        artifactBytes: revision.artifactBytes,
        artifactDigest,
        negatives: [
          "plain_pkce",
          "missing_pkce",
          "identity_missing_forged_wrong_audience_expired_get_post",
          "consent_subject_client_request_expiry_replay",
          "forged_expired_wrong_resource_bearer",
          "credential_ambiguity",
          "cross_subject_upload_read_approval",
          "mcp_undeclared_identity_arguments",
          "request_id_authorize_and_mcp_response",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  worker.kill();
  await worker.exited;
  await rm(persistTo, { recursive: true, force: true });
}
