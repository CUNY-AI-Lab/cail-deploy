import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test, { type TestContext } from "node:test";
import { SignJWT, base64url, importPKCS8 } from "jose";

import type {
  BuildJobRecord,
  BuildRunnerJobRequest,
  ProjectRecord
} from "@cuny-ai-lab/build-contract";

import deployServiceWorker, { deployServiceApp } from "./index";
import { CloudflareApiClient } from "./lib/cloudflare";
import { encryptStoredText } from "./lib/sealed-data";

const TEST_PRIVATE_KEY = generateKeyPairSync("rsa", {
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

const TEST_ACCESS_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: {
    format: "pem",
    type: "pkcs8"
  },
  publicKeyEncoding: {
    format: "jwk"
  }
});

test("runtime manifest advertises the agent API without duplicate well-known keys", async () => {
  const { env } = createTestContext();
  const response = await fetchApp("GET", "/.well-known/cail-runtime.json", env);
  assert.equal(response.status, 200);

  const body = await response.json() as {
    well_known_runtime_url: string;
    reserved_project_names: string[];
    good_fit_project_types: string[];
    approval_required_project_types: string[];
    default_limits: {
      max_validations_per_day: number | null;
      max_deployments_per_day: number | null;
      max_concurrent_builds: number;
      max_asset_bytes: number;
    };
    limit_rationale: Record<string, string>;
    approval_required_bindings: string[];
    self_service_bindings: string[];
    binding_rationale: Record<string, string>;
    deployment_ready_repository: {
      required_files: string[];
      expected_routes: string[];
      required_scripts: string[];
      must_not_include: string[];
    };
    agent_api: Record<string, string> & {
      mcp_endpoint: string;
      oauth_authorization_metadata: string;
      oauth_protected_resource_metadata: string;
      auth: {
        headless_bootstrap_supported: boolean;
        browser_session_required_for_authorization: boolean;
        human_handoff_rules: string[];
        required_for: string[];
      };
    };
    mcp: {
      endpoint: string;
      transport: string;
      auth: {
        authorization_metadata_url: string;
        protected_resource_metadata_url: string;
        dynamic_client_registration_endpoint: string;
      };
      tools: string[];
    };
  };

  assert.equal(body.well_known_runtime_url, "https://runtime.cuny.qzz.io/.well-known/cail-runtime.json");
  assert.deepEqual(body.reserved_project_names, ["runtime"]);
  assert.deepEqual(body.good_fit_project_types, [
    "exhibit-site",
    "course-site",
    "guestbook-or-form",
    "small-api",
    "archive-or-bibliography"
  ]);
  assert.deepEqual(body.approval_required_project_types, [
    "lightweight-ai-interface",
    "vector-search",
    "realtime-room"
  ]);
  assert.deepEqual(body.default_limits, {
    max_validations_per_day: null,
    max_deployments_per_day: null,
    max_concurrent_builds: 1,
    max_asset_bytes: 94371840
  });
  assert.match(body.limit_rationale.max_validations_per_day, /Not capped by default/i);
  assert.match(body.limit_rationale.max_asset_bytes, /multipart upload/i);
  assert.deepEqual(body.approval_required_bindings, ["AI", "VECTORIZE", "ROOMS"]);
  assert.deepEqual(body.self_service_bindings, ["DB", "FILES", "CACHE"]);
  assert.match(body.binding_rationale.FILES, /isolated R2 bucket/i);
  assert.match(body.binding_rationale.CACHE, /isolated KV namespace/i);
  assert.deepEqual(body.deployment_ready_repository.required_files, [
    "package.json",
    "wrangler.jsonc",
    "src/index.ts",
    "AGENTS.md"
  ]);
  assert.deepEqual(body.deployment_ready_repository.expected_routes, ["/", "/api/health"]);
  assert.deepEqual(body.deployment_ready_repository.required_scripts, ["check", "dev"]);
  assert.deepEqual(body.deployment_ready_repository.must_not_include, [
    "app.listen(...)",
    "python-runtime",
    "native-node-modules",
    "filesystem-backed-runtime-state"
  ]);
  assert.equal(body.agent_api.runtime_manifest, body.well_known_runtime_url);
  assert.equal(body.agent_api.mcp_endpoint, "https://deploy.example/mcp");
  assert.equal(body.agent_api.oauth_authorization_metadata, "https://auth.example/.well-known/oauth-authorization-server");
  assert.equal(body.agent_api.oauth_protected_resource_metadata, "https://deploy.example/.well-known/oauth-protected-resource/mcp");
  assert.equal(body.agent_api.repository_status_template, "https://deploy.example/api/repositories/{owner}/{repo}/status");
  assert.equal(body.agent_api.validate_project, "https://deploy.example/api/validate");
  assert.equal(body.agent_api.build_job_status_template, "https://deploy.example/api/build-jobs/{jobId}/status");
  assert.equal(body.agent_api.auth.headless_bootstrap_supported, false);
  assert.equal(body.agent_api.auth.browser_session_required_for_authorization, true);
  assert.deepEqual(body.agent_api.auth.human_handoff_rules, [
    "If register_project or get_repository_status returns guidedInstallUrl, stop and give that URL to the user.",
    "GitHub repository approval is still a browser step for the user, even when the rest of the loop is agent-driven.",
    "Project secret management may ask the user to confirm their GitHub account separately, because secret changes require repo write/admin access."
  ]);
  assert.deepEqual(body.agent_api.auth.required_for, [
    "repository_status_template",
    "register_project",
    "validate_project",
    "project_status_template",
    "build_job_status_template",
    "project_secrets_template"
  ]);
  assert.equal(body.agent_api.project_secrets_template, "https://deploy.example/api/projects/{projectName}/secrets");
  assert.equal(body.mcp.endpoint, "https://deploy.example/mcp");
  assert.equal(body.mcp.transport, "streamable_http");
  assert.equal(body.mcp.auth.authorization_metadata_url, "https://auth.example/.well-known/oauth-authorization-server");
  assert.equal(body.mcp.auth.protected_resource_metadata_url, "https://deploy.example/.well-known/oauth-protected-resource/mcp");
  assert.equal(body.mcp.auth.dynamic_client_registration_endpoint, "https://auth.example/oauth/register");
  assert.deepEqual(body.mcp.tools, [
    "get_runtime_manifest",
    "test_connection",
    "get_repository_status",
    "register_project",
    "validate_project",
    "get_project_status",
    "get_build_job_status",
    "list_project_secrets",
    "set_project_secret",
    "delete_project_secret"
  ]);
  assert.ok(!("well_known_runtime" in body.agent_api));
});

test("friendly base-path hosting works under /kale", async () => {
  const { env } = createTestContext({
    DEPLOY_SERVICE_BASE_URL: "https://ailab.gc.cuny.edu/kale",
    MCP_OAUTH_BASE_URL: "https://auth.ailab.gc.cuny.edu"
  });

  const homepage = await fetchWorker("GET", "/kale/", env);
  assert.equal(homepage.status, 200);
  const html = await homepage.text();
  assert.match(html, /Kale Deploy/);
  assert.match(html, /action="https:\/\/ailab\.gc\.cuny\.edu\/kale\/github\/setup"/);

  const metadataResponse = await fetchWorker("GET", "/kale/.well-known/oauth-authorization-server", env);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json() as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
  };
  assert.equal(metadata.issuer, "https://auth.ailab.gc.cuny.edu");
  assert.equal(metadata.authorization_endpoint, "https://auth.ailab.gc.cuny.edu/api/oauth/authorize");
  assert.equal(metadata.token_endpoint, "https://auth.ailab.gc.cuny.edu/oauth/token");
});

test("public connection health explains the MCP auth handoff", async () => {
  const { env } = createTestContext();

  const response = await fetchApp("GET", "/.well-known/kale-connection.json", env);
  assert.equal(response.status, 200);

  const body = await response.json() as {
    serviceName: string;
    authenticated: boolean;
    nextAction: string;
    mcpEndpoint: string;
    connectionHealthUrl: string;
    oauthAuthorizationMetadata: string;
    authorizationUrl: string;
    deploymentTrigger: string;
    localFolderUploadSupported: boolean;
  };

  assert.equal(body.serviceName, "Kale Deploy");
  assert.equal(body.authenticated, false);
  assert.equal(body.nextAction, "connect_mcp_or_complete_browser_login");
  assert.equal(body.mcpEndpoint, "https://deploy.example/mcp");
  assert.equal(body.connectionHealthUrl, "https://deploy.example/.well-known/kale-connection.json");
  assert.equal(body.oauthAuthorizationMetadata, "https://auth.example/.well-known/oauth-authorization-server");
  assert.equal(body.authorizationUrl, "https://auth.example/api/oauth/authorize");
  assert.equal(body.deploymentTrigger, "github_push_to_default_branch");
  assert.equal(body.localFolderUploadSupported, false);
});

test("landing page presents the agent-first flow and live project social proof", async () => {
  const { env, db } = createTestContext();
  db.putProject({
    projectName: "cail-deploy-smoke-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-deploy-smoke-test",
    description: "Smoke test for the main Worker flow.",
    deploymentUrl: "https://cail-deploy-smoke-test.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-26T22:40:54.747Z",
    updatedAt: "2026-03-26T22:41:04.957Z"
  });

  const response = await fetchApp("GET", "/", env);
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Kale Deploy/);
  assert.match(html, /From the CUNY AI Lab/);
  assert.match(html, /Build a website or web app with your AI agent and put it online\./);
  assert.match(html, /Claude Code/);
  assert.match(html, /Codex/);
  assert.match(html, /Gemini CLI/);
  assert.match(html, /Get started/);
  assert.match(html, /Pick your agent/);
  assert.match(html, /The first connection may open a browser so your agent can sign you in\./);
  assert.match(html, /claude mcp add --transport http cail https:\/\/[^\s"]+\/mcp/);
  assert.match(html, /codex mcp add cail --url https:\/\/[^\s"]+\/mcp/);
  assert.match(html, /Already have a GitHub repo\?/);
  assert.match(html, /Use Kale Deploy from the CUNY AI Lab to build me a small web app\./);
  assert.match(html, /Kale Deploy goes live from GitHub pushes, not a local-folder upload\./);
  assert.match(html, /register this repo, hand me any guided GitHub install link if approval is needed, validate the project, and deploy it through Kale\./);
  assert.match(html, /smoke-test/);
});

test("mcp advertises OAuth metadata when unauthorized", async () => {
  const { env } = createTestContext({
    MCP_OAUTH_TOKEN_SECRET: "mcp-oauth-secret"
  });

  const response = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    },
    {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26"
    }
  );

  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/deploy\.example\/.well-known\/oauth-protected-resource\/mcp"/);
  assert.deepEqual(await response.json(), {
    error: "invalid_token",
    error_description: "A valid MCP OAuth access token is required."
  });
});

test("mcp handles preflight and returns tools when authorized with OAuth", async () => {
  const { env } = createTestContext({
    MCP_OAUTH_TOKEN_SECRET: "mcp-oauth-secret"
  });
  const accessToken = await issueTestMcpAccessToken(env, "person@cuny.edu");

  const preflight = await fetchApp(
    "OPTIONS",
    "/mcp",
    env,
    undefined,
    {
      origin: "https://inspector.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type,mcp-protocol-version"
    }
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

  const listResponse = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(listResponse.status, 200);

  const toolList = await listResponse.json() as {
    result: {
      tools: Array<{ name: string }>;
    };
  };
  assert.ok(toolList.result.tools.some((tool) => tool.name === "register_project"));
  assert.ok(toolList.result.tools.some((tool) => tool.name === "get_runtime_manifest"));

  const callResponse = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "get_runtime_manifest",
        arguments: {}
      }
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(callResponse.status, 200);

  const toolResult = await callResponse.json() as {
    result: {
      content: Array<{ text: string }>;
      structuredContent: {
        agent_api: { mcp_endpoint: string };
        mcp: { endpoint: string };
      };
    };
  };
  assert.match(toolResult.result.content[0]?.text ?? "", /runtime manifest/i);
  assert.equal(toolResult.result.structuredContent.agent_api.mcp_endpoint, "https://deploy.example/mcp");
  assert.equal(toolResult.result.structuredContent.mcp.endpoint, "https://deploy.example/mcp");

  const testConnectionResponse = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "test_connection",
        arguments: {}
      }
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(testConnectionResponse.status, 200);

  const testConnectionResult = await testConnectionResponse.json() as {
    result: {
      structuredContent: {
        authenticated: boolean;
        nextAction: string;
        summary: string;
      };
    };
  };
  assert.equal(testConnectionResult.result.structuredContent.authenticated, true);
  assert.equal(testConnectionResult.result.structuredContent.nextAction, "register_project");
  assert.match(testConnectionResult.result.structuredContent.summary, /connected and authenticated/i);
});

test("oauth metadata, registration, authorization, and token exchange work for remote MCP", async (t) => {
  const { env } = createTestContext({
    MCP_OAUTH_TOKEN_SECRET: "mcp-oauth-secret",
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);

  const prmResponse = await fetchApp("GET", "/.well-known/oauth-protected-resource/mcp", env);
  assert.equal(prmResponse.status, 200);
  const prm = await prmResponse.json() as { authorization_servers: string[]; resource: string };
  assert.deepEqual(prm.authorization_servers, ["https://auth.example"]);
  assert.equal(prm.resource, "https://deploy.example/mcp");

  for (const aliasPath of [
    "/.well-known/oauth-protected-resource",
    "/mcp/.well-known/oauth-protected-resource"
  ]) {
    const aliasResponse = await fetchApp("GET", aliasPath, env, undefined, {
      "mcp-protocol-version": "2024-11-05"
    });
    assert.equal(aliasResponse.status, 200, aliasPath);
    assert.deepEqual(await aliasResponse.json(), prm, aliasPath);
  }

  const metadataResponse = await fetchApp("GET", "/.well-known/oauth-authorization-server", env);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json() as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  };
  assert.equal(metadata.issuer, "https://auth.example");
  assert.equal(metadata.authorization_endpoint, "https://auth.example/api/oauth/authorize");
  assert.equal(metadata.token_endpoint, "https://auth.example/oauth/token");
  assert.equal(metadata.registration_endpoint, "https://auth.example/oauth/register");

  for (const aliasPath of [
    "/.well-known/oauth-authorization-server/mcp",
    "/mcp/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration/mcp",
    "/mcp/.well-known/openid-configuration"
  ]) {
    const aliasResponse = await fetchApp("GET", aliasPath, env, undefined, {
      "mcp-protocol-version": "2024-11-05"
    });
    assert.equal(aliasResponse.status, 200, aliasPath);
    assert.deepEqual(await aliasResponse.json(), metadata, aliasPath);
  }

  const registerResponse = await fetchApp("POST", "/oauth/register", env, {
    client_name: "Gemini CLI",
    redirect_uris: ["http://127.0.0.1:43123/callback"],
    token_endpoint_auth_method: "none"
  });
  assert.equal(registerResponse.status, 200);
  const client = await registerResponse.json() as { client_id: string; redirect_uris: string[] };
  assert.ok(client.client_id);
  assert.deepEqual(client.redirect_uris, ["http://127.0.0.1:43123/callback"]);

  const codeVerifier = "test-code-verifier-123456789";
  const codeChallenge = await createPkceChallenge(codeVerifier);
  const accessJwt = await createAccessJwt("person@cuny.edu");
  const authorizeResponse = await fetchApp(
    "GET",
    `/api/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}&redirect_uri=${encodeURIComponent("http://127.0.0.1:43123/callback")}&state=test-state&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256&scope=${encodeURIComponent("cail:deploy")}`,
    env,
    undefined,
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );
  assert.equal(authorizeResponse.status, 302);
  const redirect = new URL(authorizeResponse.headers.get("location") ?? "");
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  assert.equal(redirect.searchParams.get("state"), "test-state");

  const tokenResponse = await fetchRaw(
    new Request("https://auth.example/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:43123/callback",
        code: code ?? "",
        code_verifier: codeVerifier
      }).toString()
    }),
    env
  );
  assert.equal(tokenResponse.status, 200);
  const tokenBody = await tokenResponse.json() as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  };
  assert.equal(tokenBody.token_type, "Bearer");
  assert.equal(tokenBody.scope, "cail:deploy");
  assert.ok(tokenBody.access_token);
});

test("mcp validate_project returns structured install guidance instead of a protocol error", async (t) => {
  const { env } = createTestContext({
    MCP_OAUTH_TOKEN_SECRET: "mcp-oauth-secret"
  });
  installGitHubFetchMock(t, {
    repositoryName: "cail-assets-build-test",
    headSha: "abc123def456",
    installed: false
  });
  const accessToken = await issueTestMcpAccessToken(env, "person@cuny.edu");

  const response = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "validate_project",
        arguments: {
          repository: "szweibel/cail-assets-build-test",
          ref: "main"
        }
      }
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );

  assert.equal(response.status, 200);
  const result = await response.json() as {
    result: {
      isError?: boolean;
      structuredContent?: {
        installUrl?: string;
        nextAction?: string;
      };
    };
  };
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent?.nextAction, "install_github_app");
  assert.match(result.result.structuredContent?.installUrl ?? "", /github\.com\/apps\/cail-deploy\/installations\/new/);
});

test("mcp project secret tools return a clear GitHub connect handoff when repo-admin auth is missing", async () => {
  const { env, db } = createTestContext({
    MCP_OAUTH_TOKEN_SECRET: "mcp-oauth-secret"
  });
  db.putProject({
    projectName: "cail-assets-build-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    deploymentUrl: "https://cail-assets-build-test.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-29T12:00:00.000Z",
    updatedAt: "2026-03-29T12:05:00.000Z"
  });
  const accessToken = await issueTestMcpAccessToken(env, "person@cuny.edu");

  const response = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "list_project_secrets",
        arguments: {
          projectName: "cail-assets-build-test"
        }
      }
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );

  assert.equal(response.status, 200);
  const result = await response.json() as {
    result: {
      isError?: boolean;
      structuredContent?: {
        nextAction?: string;
        connectGitHubUserUrl?: string;
      };
    };
  };
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent?.nextAction, "connect_github_user");
  assert.match(
    result.result.structuredContent?.connectGitHubUserUrl ?? "",
    /^https:\/\/auth\.example\/api\/github\/user-auth\/start\?/
  );
});

test("github user auth start redirects to GitHub with signed repository context", async (t) => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@cuny.edu");

  const response = await fetchRaw(new Request("https://auth.example/api/github/user-auth/start?repositoryFullName=szweibel/cail-assets-build-test&projectName=cail-assets-build-test", {
    method: "GET",
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin, "https://github.com");
  assert.equal(location.pathname, "/login/oauth/authorize");
  assert.equal(location.searchParams.get("client_id"), env.GITHUB_APP_CLIENT_ID);
  assert.equal(location.searchParams.get("redirect_uri"), "https://deploy.example/github/user-auth/callback");
  assert.ok(location.searchParams.get("state"));
});

test("github user auth callback stores the linked GitHub account for later project-admin checks", async (t) => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
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

    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
      return jsonResponse({
        access_token: "github-user-token",
        expires_in: 3600,
        refresh_token: "github-refresh-token",
        refresh_token_expires_in: 86400
      });
    }

    if (url.origin === "https://api.github.com" && url.pathname === "/user") {
      return jsonResponse({
        id: 9001,
        login: "szweibel"
      });
    }

    if (url.origin === "https://api.github.com" && url.pathname === "/repos/szweibel/cail-assets-build-test/installation") {
      return jsonResponse({ id: 42, account: { login: "szweibel" } });
    }

    if (url.origin === "https://api.github.com" && url.pathname === "/repos/szweibel/cail-assets-build-test") {
      return jsonResponse({
        id: 7,
        name: "cail-assets-build-test",
        full_name: "szweibel/cail-assets-build-test",
        default_branch: "main",
        html_url: "https://github.com/szweibel/cail-assets-build-test",
        clone_url: "https://github.com/szweibel/cail-assets-build-test.git",
        private: false,
        owner: { login: "szweibel" },
        permissions: {
          admin: false,
          maintain: false,
          push: true,
          pull: true
        }
      });
    }

    return originalFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const startResponse = await fetchRaw(new Request("https://auth.example/api/github/user-auth/start?repositoryFullName=szweibel/cail-assets-build-test&projectName=cail-assets-build-test", {
    method: "GET",
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);
  const state = new URL(startResponse.headers.get("location") ?? "").searchParams.get("state");
  assert.ok(state);

  const callbackResponse = await fetchRaw(new Request(
    `https://auth.example/github/user-auth/callback?code=github-code-123&state=${encodeURIComponent(state ?? "")}`
  ), env);
  assert.equal(callbackResponse.status, 200);
  const callbackHtml = await callbackResponse.text();
  assert.match(callbackHtml, /GitHub is connected to Kale Deploy/);
  assert.match(callbackHtml, /finish checking whether this GitHub account can manage/i);
  assert.match(callbackHtml, /Back to this project&#39;s setup/);
  assert.match(callbackHtml, /Go to the Kale homepage/);
  const stored = db.selectGitHubUserAuth("user:person@cuny.edu");
  assert.ok(stored);
  assert.equal(stored?.github_login, "szweibel");
  assert.equal(stored?.github_user_id, 9001);
  assert.equal(typeof stored?.access_token_encrypted, "string");
  assert.equal(typeof stored?.refresh_token_encrypted, "string");
});

test("github user auth callback returns to project settings when the flow started from settings", async (t) => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
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

    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
      return jsonResponse({
        access_token: "github-user-token",
        expires_in: 3600,
        refresh_token: "github-refresh-token",
        refresh_token_expires_in: 86400
      });
    }

    if (url.origin === "https://api.github.com" && url.pathname === "/user") {
      return jsonResponse({
        id: 9001,
        login: "szweibel"
      });
    }

    return originalFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const startResponse = await fetchRaw(new Request("https://auth.example/api/github/user-auth/start?repositoryFullName=szweibel/cail-assets-build-test&projectName=cail-assets-build-test&returnTo=https%3A%2F%2Fauth.example%2Fprojects%2Fcail-assets-build-test%2Fcontrol", {
    method: "GET",
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);
  const state = new URL(startResponse.headers.get("location") ?? "").searchParams.get("state");
  assert.ok(state);

  const callbackResponse = await fetchRaw(new Request(
    `https://deploy.example/github/user-auth/callback?code=github-code-123&state=${encodeURIComponent(state ?? "")}`
  ), env);
  assert.equal(callbackResponse.status, 200);
  const callbackHtml = await callbackResponse.text();
  assert.match(callbackHtml, /Back to project settings/);
});

test("project secrets API returns a GitHub connect handoff before repo-admin access is confirmed", async (t) => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  db.putProject({
    projectName: "cail-assets-build-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    deploymentUrl: "https://cail-assets-build-test.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-29T12:00:00.000Z",
    updatedAt: "2026-03-29T12:05:00.000Z"
  });
  const accessJwt = await createAccessJwt("person@cuny.edu");

  const response = await fetchApp(
    "GET",
    "/api/projects/cail-assets-build-test/secrets",
    env,
    undefined,
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );

  assert.equal(response.status, 403);
  const body = await response.json() as {
    nextAction: string;
    repositoryFullName: string;
    connectGitHubUserUrl?: string;
  };
  assert.equal(body.nextAction, "connect_github_user");
  assert.equal(body.repositoryFullName, "unknown");
  assert.equal(
    body.connectGitHubUserUrl,
    "https://auth.example/api/github/user-auth/start?projectName=cail-assets-build-test"
  );
});

test("project secrets API does not reveal whether an unknown slug exists", async (t) => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@cuny.edu");

  const response = await fetchApp(
    "GET",
    "/api/projects/does-not-exist/secrets",
    env,
    undefined,
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );

  assert.equal(response.status, 403);
  const body = await response.json() as {
    nextAction: string;
    repositoryFullName: string;
    connectGitHubUserUrl?: string;
  };
  assert.equal(body.nextAction, "connect_github_user");
  assert.equal(body.repositoryFullName, "unknown");
  assert.equal(
    body.connectGitHubUserUrl,
    "https://auth.example/api/github/user-auth/start?projectName=does-not-exist"
  );
});

test("project secrets can be stored, listed, and synced to the live worker", async (t) => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  db.putProject({
    projectName: "cail-assets-build-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    deploymentUrl: "https://cail-assets-build-test.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-29T12:00:00.000Z",
    updatedAt: "2026-03-29T12:05:00.000Z"
  });
  db.putGitHubUserAuth({
    access_subject: "user:person@cuny.edu",
    access_email: "person@cuny.edu",
    github_user_id: 9001,
    github_login: "szweibel",
    access_token_encrypted: await sealStoredValueForTest(env, "github-user-token"),
    access_token_expires_at: "2030-01-01T00:00:00.000Z",
    refresh_token_encrypted: null,
    refresh_token_expires_at: null,
    created_at: "2026-03-29T12:00:00.000Z",
    updated_at: "2026-03-29T12:00:00.000Z"
  });

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

    if (url.origin === "https://api.github.com" && url.pathname === "/repos/szweibel/cail-assets-build-test") {
      return jsonResponse({
        id: 7,
        name: "cail-assets-build-test",
        full_name: "szweibel/cail-assets-build-test",
        default_branch: "main",
        html_url: "https://github.com/szweibel/cail-assets-build-test",
        clone_url: "https://github.com/szweibel/cail-assets-build-test.git",
        private: false,
        owner: { login: "szweibel" },
        permissions: {
          admin: false,
          maintain: false,
          push: true,
          pull: true
        }
      });
    }

    if (
      url.origin === "https://api.cloudflare.com"
      && url.pathname === "/client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/cail-assets-build-test/secrets"
      && request.method === "PUT"
    ) {
      const body = await request.json() as { name: string; text: string; type: string };
      assert.deepEqual(body, {
        name: "OPENAI_API_KEY",
        text: "sk-test-secret",
        type: "secret_text"
      });
      return jsonResponse({ success: true, errors: [], result: {} });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const setResponse = await fetchApp(
    "PUT",
    "/api/projects/cail-assets-build-test/secrets/OPENAI_API_KEY",
    env,
    { value: "sk-test-secret" },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );
  assert.equal(setResponse.status, 200);
  const setBody = await setResponse.json() as {
    liveUpdateApplied: boolean;
    connectedGitHubLogin: string;
    summary: string;
  };
  assert.equal(setBody.liveUpdateApplied, true);
  assert.equal(setBody.connectedGitHubLogin, "szweibel");
  assert.match(setBody.summary, /updated the live Worker/i);

  const stored = db.selectProjectSecret("szweibel/cail-assets-build-test", "OPENAI_API_KEY");
  assert.ok(stored);
  assert.equal(typeof stored?.ciphertext, "string");
  assert.equal(typeof stored?.iv, "string");

  const listResponse = await fetchApp(
    "GET",
    "/api/projects/cail-assets-build-test/secrets",
    env,
    undefined,
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json() as {
    count: number;
    connectedGitHubLogin: string;
    secrets: Array<{ secretName: string }>;
  };
  assert.equal(listBody.count, 1);
  assert.equal(listBody.connectedGitHubLogin, "szweibel");
  assert.deepEqual(listBody.secrets.map((secret) => secret.secretName), ["OPENAI_API_KEY"]);
});

test("project control panel redirects public requests to the Access-protected host", async () => {
  const { env } = createTestContext();

  const response = await fetchRaw(new Request("https://deploy.example/projects/kale-cache-smoke-test/control"), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://auth.example/projects/kale-cache-smoke-test/control");
});

test("project control panel asks the user to connect GitHub before showing settings", async (t) => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  db.putProject({
    projectName: "kale-cache-smoke-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/kale-cache-smoke-test",
    deploymentUrl: "https://kale-cache-smoke-test.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z"
  });
  const accessJwt = await createAccessJwt("person@cuny.edu");

  const response = await fetchRaw(new Request("https://auth.example/projects/kale-cache-smoke-test/control", {
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);

  assert.equal(response.status, 403);
  const html = await response.text();
  assert.match(html, /Connect your GitHub account/);
  assert.match(html, /Kale Deploy can only show project secrets after it verifies a GitHub account with write or admin access/i);
  assert.doesNotMatch(html, /szweibel\/kale-cache-smoke-test/);
  assert.doesNotMatch(html, /kale-cache-smoke-test\.cuny\.qzz\.io/);
  assert.match(html, /Return to Kale Deploy/);
  assert.match(html, /returnTo=https%3A%2F%2Fauth\.example%2Fprojects%2Fkale-cache-smoke-test%2Fcontrol/);
});

test("project control panel does not reveal whether an unknown slug exists", async (t) => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@cuny.edu");

  const response = await fetchRaw(new Request("https://auth.example/projects/does-not-exist/control", {
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);

  assert.equal(response.status, 403);
  const html = await response.text();
  assert.match(html, /Project settings/);
  assert.match(html, /Kale Deploy can only show project secrets after it verifies a GitHub account with write or admin access/i);
  assert.match(html, /Connect your GitHub account/);
  assert.doesNotMatch(html, /github\.com\/[^"' ]+/);
  assert.doesNotMatch(html, /cuny\.qzz\.io/);
});

test("project control panel shows secrets and accepts a browser form submission for repo admins", async (t) => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });

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

    if (url.origin === "https://api.github.com" && url.pathname === "/repos/szweibel/kale-cache-smoke-test") {
      return jsonResponse({
        id: 7,
        name: "kale-cache-smoke-test",
        full_name: "szweibel/kale-cache-smoke-test",
        default_branch: "main",
        html_url: "https://github.com/szweibel/kale-cache-smoke-test",
        clone_url: "https://github.com/szweibel/kale-cache-smoke-test.git",
        private: false,
        owner: { login: "szweibel" },
        permissions: {
          admin: false,
          maintain: false,
          push: true,
          pull: true
        }
      });
    }

    return originalFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  db.putProject({
    projectName: "kale-cache-smoke-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/kale-cache-smoke-test",
    deploymentUrl: "https://kale-cache-smoke-test.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: undefined,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z"
  });
  db.putGitHubUserAuth({
    access_subject: "user:person@cuny.edu",
    access_email: "person@cuny.edu",
    github_user_id: 9001,
    github_login: "szweibel",
    access_token_encrypted: await sealStoredValueForTest(env, "github-user-token"),
    access_token_expires_at: "2030-01-01T00:00:00.000Z",
    refresh_token_encrypted: null,
    refresh_token_expires_at: null,
    created_at: "2026-03-29T00:00:00.000Z",
    updated_at: "2026-03-29T00:00:00.000Z"
  });
  db.putProjectSecret({
    github_repo: "szweibel/kale-cache-smoke-test",
    project_name: "kale-cache-smoke-test",
    secret_name: "OPENAI_API_KEY",
    ciphertext: "ciphertext",
    iv: "iv",
    github_user_id: 9001,
    github_login: "szweibel",
    created_at: "2026-03-29T00:00:00.000Z",
    updated_at: "2026-03-29T00:00:00.000Z"
  });

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const pageResponse = await fetchRaw(new Request("https://auth.example/projects/kale-cache-smoke-test/control", {
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.match(html, /Secrets/);
  assert.match(html, /OPENAI_API_KEY/);

  const formTokenMatch = html.match(/name="formToken" value="([^"]+)"/);
  assert.ok(formTokenMatch);

  const form = new FormData();
  form.set("formToken", formTokenMatch?.[1] ?? "");
  form.set("secretName", "ANTHROPIC_API_KEY");
  form.set("secretValue", "sk-test-value");

  const saveResponse = await fetchRaw(new Request("https://auth.example/projects/kale-cache-smoke-test/control/secrets", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    },
    body: form
  }), env);

  assert.equal(saveResponse.status, 302);
  assert.match(saveResponse.headers.get("location") ?? "", /flash=success/);
  const savedSecret = db.selectProjectSecret("szweibel/kale-cache-smoke-test", "ANTHROPIC_API_KEY");
  assert.ok(savedSecret);
});

test("project registration returns structured state for an existing project", async () => {
  const { env, db } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  db.putProject({
    projectName: "cail-deploy-smoke-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-deploy-smoke-test",
    deploymentUrl: "https://cail-deploy-smoke-test.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-26T22:40:54.747Z",
    updatedAt: "2026-03-26T22:41:04.957Z"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/cail-deploy-smoke-test"
  });
  assert.equal(response.status, 200);

  const body = await response.json() as {
    ok: boolean;
    projectName: string;
    projectAvailable: boolean;
    projectUrl: string;
    installStatus: string;
    guidedInstallUrl?: string;
    latestStatus: string;
  };

  assert.equal(body.ok, true);
  assert.equal(body.projectName, "cail-deploy-smoke-test");
  assert.equal(body.projectAvailable, true);
  assert.equal(body.projectUrl, "https://cail-deploy-smoke-test.cuny.qzz.io");
  assert.equal(body.installStatus, "app_unconfigured");
  assert.equal(body.guidedInstallUrl, undefined);
  assert.equal(body.latestStatus, "live");
});

test("CloudflareApiClient paginates R2 bucket lookup", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    assert.equal(url.pathname, "/client/v4/accounts/account-123/r2/buckets");
    if (url.searchParams.get("cursor") === "page-2") {
      return jsonResponse({
        success: true,
        errors: [],
        result: {
          buckets: [{ name: "wanted-bucket" }]
        },
        result_info: {}
      });
    }

    return jsonResponse({
      success: true,
      errors: [],
      result: {
        buckets: [{ name: "other-bucket" }]
      },
      result_info: {
        cursor: "page-2"
      }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new CloudflareApiClient({
    accountId: "account-123",
    apiToken: "token-123"
  });
  const bucket = await client.findR2BucketByName("wanted-bucket");
  assert.equal(bucket?.name, "wanted-bucket");
});

test("repository status returns a repo-first lifecycle summary", async () => {
  const { env, db } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  db.putProject({
    projectName: "cail-deploy-smoke-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-deploy-smoke-test",
    deploymentUrl: "https://cail-deploy-smoke-test.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-26T22:40:54.747Z",
    updatedAt: "2026-03-26T22:41:04.957Z"
  });

  const response = await fetchApp("GET", "/api/repositories/szweibel/cail-deploy-smoke-test/status", env);
  assert.equal(response.status, 200);

  const body = await response.json() as {
    ok: boolean;
    repositoryStatusUrl: string;
    workflowStage: string;
    nextAction: string;
    summary: string;
    deploymentUrl: string;
  };

  assert.equal(body.ok, true);
  assert.equal(body.repositoryStatusUrl, "https://deploy.example/api/repositories/szweibel/cail-deploy-smoke-test/status");
  assert.equal(body.workflowStage, "live");
  assert.equal(body.nextAction, "view_live_project");
  assert.match(body.summary, /site is live/i);
  assert.equal(body.deploymentUrl, "https://cail-deploy-smoke-test.cuny.qzz.io");
});

test("project registration returns a repo-aware guided install URL when the app is configured", async (t) => {
  const { env } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-deploy-smoke-test",
    headSha: "unused"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/cail-deploy-smoke-test"
  });
  assert.equal(response.status, 200);

  const body = await response.json() as {
    guidedInstallUrl: string;
    installStatus: string;
  };

  assert.equal(
    body.guidedInstallUrl,
    "https://deploy.example/github/install?repositoryFullName=szweibel%2Fcail-deploy-smoke-test&projectName=cail-deploy-smoke-test"
  );
  assert.equal(body.installStatus, "installed");
});

test("project registration returns suggested alternative slugs on conflict", async () => {
  const { env, db } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  db.putProject({
    projectName: "archive",
    ownerLogin: "otherperson",
    githubRepo: "otherperson/archive",
    deploymentUrl: "https://archive.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-archive",
    createdAt: "2026-03-26T22:40:54.747Z",
    updatedAt: "2026-03-26T22:41:04.957Z"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/archive"
  });
  assert.equal(response.status, 409);

  const body = await response.json() as {
    ok: boolean;
    nextAction: string;
    existingRepositoryFullName: string;
    suggestedProjectNames: Array<{ projectName: string; projectUrl: string }>;
  };

  assert.equal(body.ok, false);
  assert.equal(body.nextAction, "choose_different_project_name");
  assert.equal(body.existingRepositoryFullName, "otherperson/archive");
  assert.ok(body.suggestedProjectNames.length > 0);
  assert.equal(body.suggestedProjectNames[0]?.projectName, "archive-szweibel");
  assert.equal(body.suggestedProjectNames[0]?.projectUrl, "https://archive-szweibel.cuny.qzz.io");
});

test("project registration treats same-owner different repositories as a conflict", async () => {
  const { env, db } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  db.putProject({
    projectName: "archive",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/archive-one",
    deploymentUrl: "https://archive.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-archive",
    createdAt: "2026-03-26T22:40:54.747Z",
    updatedAt: "2026-03-26T22:41:04.957Z"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/archive-two",
    projectName: "archive"
  });
  assert.equal(response.status, 409);

  const body = await response.json() as {
    existingRepositoryFullName: string;
    nextAction: string;
  };

  assert.equal(body.existingRepositoryFullName, "szweibel/archive-one");
  assert.equal(body.nextAction, "choose_different_project_name");
});

test("project registration avoids reserved platform hostnames", async () => {
  const { env } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/runtime"
  });
  assert.equal(response.status, 200);

  const body = await response.json() as {
    projectName: string;
    projectUrl: string;
  };

  assert.equal(body.projectName, "runtime-app");
  assert.equal(body.projectUrl, "https://runtime-app.cuny.qzz.io");
});

test("guided install stores repo context and renders a GitHub handoff page", async (t) => {
  const { env } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-deploy-smoke-test",
    headSha: "unused",
    installed: false
  });

  const response = await fetchApp(
    "GET",
    "/github/install?repositoryFullName=szweibel/cail-deploy-smoke-test&projectName=cail-deploy-smoke-test",
    env
  );

  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /cail_github_install_context=/);
  assert.match(setCookie, /Path=\//);
  const html = await response.text();
  assert.match(html, /GitHub needed/);
  assert.match(html, /Ready for GitHub approval/);
  assert.match(html, /Continue to GitHub/);
  assert.match(html, /View setup progress/);
  assert.match(html, /Check again without reloading/);
  assert.match(html, /repository-live-refresh-bootstrap/);
});

test("guided install explains when the repository is already covered", async (t) => {
  const { env } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-deploy-smoke-test",
    headSha: "unused",
    installed: true
  });

  const response = await fetchApp(
    "GET",
    "/github/install?repositoryFullName=szweibel/cail-deploy-smoke-test&projectName=cail-deploy-smoke-test",
    env
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Already connected/);
  assert.match(html, /This repo already has GitHub access/);
  assert.match(html, /View setup progress/);
  assert.match(html, /Open GitHub again/);
  assert.match(html, /Check again without reloading/);
});

test("setup page verifies repository coverage for the guided install context", async (t) => {
  const { env } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-deploy-smoke-test",
    headSha: "unused",
    installed: true
  });

  const response = await fetchApp(
    "GET",
    "/github/setup?repositoryFullName=szweibel/cail-deploy-smoke-test&projectName=cail-deploy-smoke-test&installation_id=42&setup_action=install",
    env
  );
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Ready to deploy/);
  assert.match(html, /szweibel\/cail-deploy-smoke-test/);
  assert.match(html, /GitHub/);
  assert.match(html, /Connected/);
  assert.match(html, /Behind the scenes/);
  assert.match(html, /GitHub is connected/);
  assert.match(html, /You came back from GitHub:/);
  assert.match(html, /Push or validate/);
  assert.match(html, /Check again without reloading/);
  assert.match(html, /https:\/\/deploy\.example\/api\/projects\/cail-deploy-smoke-test\/status/);
  assert.match(html, /https:\/\/deploy\.example\/api\/repositories\/szweibel\/cail-deploy-smoke-test\/status/);
});

test("setup page explains when GitHub returned but the repository is still not covered", async (t) => {
  const { env } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-deploy-smoke-test",
    headSha: "unused",
    installed: false
  });

  const response = await fetchApp(
    "GET",
    "/github/setup?repositoryFullName=szweibel/cail-deploy-smoke-test&projectName=cail-deploy-smoke-test&installation_id=42&setup_action=install",
    env
  );
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /GitHub did not grant access to this repo/);
  assert.match(html, /Try the GitHub flow again/);
  assert.match(html, /Connect GitHub for this repo/);
  assert.match(html, /Nothing to do until the GitHub step is done/i);
});

test("validate queues a build-only job and returns a pollable status URL", async (t) => {
  const { env, db, queue } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-assets-build-test",
    headSha: "abc123def456"
  });

  const response = await fetchApp("POST", "/api/validate", env, {
    repositoryFullName: "szweibel/cail-assets-build-test",
    ref: "main"
  });
  assert.equal(response.status, 202);

  const body = await response.json() as {
    ok: boolean;
    jobId: string;
    jobKind: string;
    status: string;
    buildStatus: string;
    statusUrl: string;
  };

  assert.equal(body.ok, true);
  assert.equal(body.jobKind, "validation");
  assert.equal(body.status, "queued");
  assert.equal(body.buildStatus, "queued");
  assert.match(body.statusUrl, /\/api\/build-jobs\/.+\/status$/);
  assert.equal(queue.sent.length, 1);
  assert.equal(queue.sent[0]?.trigger.event, "validate");

  const savedJob = db.getBuildJob(body.jobId);
  assert.ok(savedJob);
  assert.equal(savedJob?.eventName, "validate");
  assert.equal(savedJob?.headSha, "abc123def456");
});

test("validate reuses the repository's existing project slug by default", async (t) => {
  const { env, db, queue } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-assets-build-test",
    headSha: "abc123def456"
  });

  db.putProject({
    projectName: "custom-assets-site",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    deploymentUrl: "https://custom-assets-site.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:05:00.000Z"
  });

  const response = await fetchApp("POST", "/api/validate", env, {
    repositoryFullName: "szweibel/cail-assets-build-test",
    ref: "main"
  });
  assert.equal(response.status, 202);
  assert.equal(queue.sent.length, 1);
  assert.equal(queue.sent[0]?.deployment.suggestedProjectName, "custom-assets-site");
});

test("validate does not enforce a daily cap by default", async (t) => {
  const { env, db, queue } = createTestContext();
  installGitHubFetchMock(t, {
    repositoryName: "cail-assets-build-test",
    headSha: "abc123def456"
  });

  for (let index = 0; index < 25; index += 1) {
    db.putBuildJob({
      jobId: `job-${index}`,
      eventName: "validate",
      installationId: 42,
      repository: repositoryRecord("cail-assets-build-test"),
      ref: "refs/heads/main",
      headSha: `sha-${index}`,
      checkRunId: 500 + index,
      status: "success",
      projectName: "cail-assets-build-test",
      createdAt: `2026-03-28T0${Math.min(index, 9)}:00:00.000Z`,
      updatedAt: `2026-03-28T0${Math.min(index, 9)}:05:00.000Z`,
      completedAt: `2026-03-28T0${Math.min(index, 9)}:05:00.000Z`
    });
  }

  const response = await fetchApp("POST", "/api/validate", env, {
    repositoryFullName: "szweibel/cail-assets-build-test",
    ref: "main"
  });
  assert.equal(response.status, 202);

  const body = await response.json() as {
    ok: boolean;
    status: string;
  };

  assert.equal(body.ok, true);
  assert.equal(body.status, "queued");
  assert.equal(queue.sent.length, 1);
});

test("deployments reject oversized total upload bundles before provisioning resources", async () => {
  const { env } = createTestContext();
  const metadata = {
    projectName: "oversized-upload",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/oversized-upload",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-03-28",
      bindings: []
    },
    staticAssets: {
      files: [
        {
          path: "assets/hero.bin",
          partName: "asset-hero",
          contentType: "application/octet-stream"
        }
      ]
    }
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("index.js", new File([new Uint8Array(46 * 1024 * 1024)], "index.js", { type: "application/javascript" }));
  form.append("asset-hero", new File([new Uint8Array(46 * 1024 * 1024)], "hero.bin", { type: "application/octet-stream" }));

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token",
    CLOUDFLARE_API_TOKEN: "cloudflare-token"
  });

  assert.equal(response.status, 413);
  const body = await response.json() as { error: string };
  assert.match(body.error, /deployment bundle is too large/i);
});

test("deployments keep repo-scoped DB, FILES, and CACHE resources when a repo changes slugs", async (t) => {
  const { env, db } = createTestContext();
  db.putProject({
    projectName: "old-slug",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/renameable-project",
    deploymentUrl: "https://old-slug.cuny.qzz.io",
    databaseId: "db-existing",
    filesBucketName: "kale-files-old-slug",
    cacheNamespaceId: "kv-existing",
    hasAssets: false,
    latestDeploymentId: "dep-old",
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:05:00.000Z"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/new-slug") {
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings: Array<Record<string, string>>;
      };

      const dbBinding = workerUpload.bindings.find((binding) => binding.name === "DB");
      const cacheBinding = workerUpload.bindings.find((binding) => binding.name === "CACHE");
      const filesBinding = workerUpload.bindings.find((binding) => binding.name === "FILES");
      assert.equal(dbBinding?.id, "db-existing");
      assert.equal(cacheBinding?.namespace_id, "kv-existing");
      assert.equal(filesBinding?.bucket_name, "kale-files-old-slug");
      return new Response("", { status: 200 });
    }

    if (
      url.pathname.includes("/d1/database")
      || url.pathname.includes("/storage/kv/namespaces")
      || url.pathname.includes("/r2/buckets")
    ) {
      throw new Error(`Unexpected resource provisioning lookup during slug rename: ${request.method} ${request.url}`);
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "new-slug",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/renameable-project",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-03-28",
      bindings: [
        { type: "d1", name: "DB", id: "placeholder-db" },
        { type: "kv_namespace", name: "CACHE", namespace_id: "placeholder-cache" },
        { type: "r2_bucket", name: "FILES", bucket_name: "placeholder-files" }
      ]
    }
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("index.js", new File(["export default { fetch() { return new Response('ok'); } };"], "index.js", {
    type: "application/javascript"
  }));

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    project: {
      projectName: string;
    };
  };
  assert.equal(body.project.projectName, "new-slug");

  const renamedProject = db.selectProject("new-slug") as {
    database_id: string | null;
    files_bucket_name: string | null;
    cache_namespace_id: string | null;
  } | null;
  assert.equal(renamedProject?.database_id, "db-existing");
  assert.equal(renamedProject?.files_bucket_name, "kale-files-old-slug");
  assert.equal(renamedProject?.cache_namespace_id, "kv-existing");
});

test("deployments keep repo-scoped project secrets when a repo changes slugs", async (t) => {
  const { env, db } = createTestContext();
  db.putProject({
    projectName: "old-slug",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/renameable-project",
    deploymentUrl: "https://old-slug.cuny.qzz.io",
    databaseId: "db-existing",
    hasAssets: false,
    latestDeploymentId: "dep-old",
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:05:00.000Z"
  });
  const sealed = await encryptStoredText(
    env.CONTROL_PLANE_ENCRYPTION_KEY ?? "test-control-plane-encryption-key",
    "sk-rename-secret"
  );
  db.putProjectSecret({
    github_repo: "szweibel/renameable-project",
    project_name: "old-slug",
    secret_name: "OPENAI_API_KEY",
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    github_user_id: 9001,
    github_login: "szweibel",
    created_at: "2026-03-28T10:00:00.000Z",
    updated_at: "2026-03-28T10:00:00.000Z"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/new-slug") {
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings: Array<Record<string, string>>;
      };

      const secretBinding = workerUpload.bindings.find((binding) => binding.name === "OPENAI_API_KEY");
      assert.deepEqual(secretBinding, {
        type: "secret_text",
        name: "OPENAI_API_KEY",
        text: "sk-rename-secret"
      });
      return new Response("", { status: 200 });
    }

    if (
      url.pathname.includes("/d1/database")
      || url.pathname.includes("/storage/kv/namespaces")
      || url.pathname.includes("/r2/buckets")
    ) {
      throw new Error(`Unexpected resource provisioning lookup during slug rename: ${request.method} ${request.url}`);
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "new-slug",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/renameable-project",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-03-28",
      bindings: [
        { type: "d1", name: "DB", id: "placeholder-db" }
      ]
    }
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("index.js", new File(["export default { fetch() { return new Response('ok'); } };"], "index.js", {
    type: "application/javascript"
  }));

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
});

test("deployments inject stored project secrets as secret_text bindings", async (t) => {
  const { env, db } = createTestContext();
  db.putProject({
    projectName: "secret-app",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/secret-app",
    deploymentUrl: "https://secret-app.cuny.qzz.io",
    databaseId: "db-existing",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-29T12:00:00.000Z",
    updatedAt: "2026-03-29T12:05:00.000Z"
  });
  const sealed = await encryptStoredText(
    env.CONTROL_PLANE_ENCRYPTION_KEY ?? "test-control-plane-encryption-key",
    "sk-live-secret"
  );
  db.putProjectSecret({
    github_repo: "szweibel/secret-app",
    project_name: "secret-app",
    secret_name: "OPENAI_API_KEY",
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    github_user_id: 9001,
    github_login: "szweibel",
    created_at: "2026-03-29T12:00:00.000Z",
    updated_at: "2026-03-29T12:00:00.000Z"
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname === "/client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/secret-app") {
      const form = await request.formData();
      const metadataEntry = form.get("metadata");
      assert.ok(metadataEntry instanceof File);
      const workerUpload = JSON.parse(await metadataEntry.text()) as {
        bindings: Array<Record<string, string>>;
      };

      const secretBinding = workerUpload.bindings.find((binding) => binding.name === "OPENAI_API_KEY");
      assert.deepEqual(secretBinding, {
        type: "secret_text",
        name: "OPENAI_API_KEY",
        text: "sk-live-secret"
      });
      return new Response("", { status: 200 });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const metadata = {
    projectName: "secret-app",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/secret-app",
    workerUpload: {
      main_module: "index.js",
      compatibility_date: "2026-03-29",
      bindings: [
        { type: "d1", name: "DB", id: "placeholder-db" }
      ]
    }
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("index.js", new File(["export default { fetch() { return new Response('ok'); } };"], "index.js", {
    type: "application/javascript"
  }));

  const response = await fetchRaw(new Request("https://deploy.example/api/deployments", {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-token"
    },
    body: form
  }), {
    ...env,
    DEPLOY_API_TOKEN: "deploy-token"
  });

  assert.equal(response.status, 200);
});

test("validate requires auth when Cloudflare Access is configured", async () => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud"
  });

  const response = await fetchApp("POST", "/api/validate", env, {
    repositoryFullName: "szweibel/cail-assets-build-test",
    ref: "main"
  });

  assert.equal(response.status, 401);
  const body = await response.json() as {
    nextAction: string;
    connectionHealthUrl: string;
    oauthProtectedResourceMetadata: string;
  };
  assert.equal(body.nextAction, "complete_browser_login");
  assert.equal(body.connectionHealthUrl, "https://deploy.example/.well-known/kale-connection.json");
  assert.equal(body.oauthProtectedResourceMetadata, "https://deploy.example/.well-known/oauth-protected-resource/mcp");
});

test("project registration requires auth when Cloudflare Access is configured", async () => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/cail-assets-build-test"
  });

  assert.equal(response.status, 401);
});

test("project status requires auth when Cloudflare Access is configured", async () => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud"
  });
  db.putProject({
    projectName: "cail-assets-build-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    deploymentUrl: "https://cail-assets-build-test.cuny.qzz.io",
    hasAssets: true,
    latestDeploymentId: "dep-live",
    createdAt: "2026-03-26T20:00:00.000Z",
    updatedAt: "2026-03-26T20:10:00.000Z"
  });

  const response = await fetchApp("GET", "/api/projects/cail-assets-build-test/status", env);
  assert.equal(response.status, 401);
});

test("project registration requires auth when Cloudflare Access is configured", async () => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud"
  });

  const response = await fetchApp("POST", "/api/projects/register", env, {
    repositoryFullName: "szweibel/cail-assets-build-test"
  });

  assert.equal(response.status, 401);
});

test("api auth session is permanently disabled in favor of MCP OAuth", async () => {
  const { env } = createTestContext();

  const response = await fetchApp("GET", "/api/auth/session", env);
  assert.equal(response.status, 410);
  const body = await response.json() as { error: string };
  assert.match(body.error, /standard MCP OAuth discovery/i);
});

test("Cloudflare Access allows an allowed email to call project registration directly", async (t) => {
  const { env } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined,
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@cuny.edu");

  const registerResponse = await fetchApp(
    "POST",
    "/api/projects/register",
    env,
    {
      repositoryFullName: "szweibel/cail-assets-build-test"
    },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );
  assert.equal(registerResponse.status, 200);

  const registerBody = await registerResponse.json() as {
    ok: boolean;
    projectName: string;
    installStatus: string;
  };
  assert.equal(registerBody.ok, true);
  assert.equal(registerBody.projectName, "cail-assets-build-test");
  assert.equal(registerBody.installStatus, "app_unconfigured");
});

test("Cloudflare Access allows subdomains of configured email domains", async (t) => {
  const { env } = createTestContext({
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_APP_SLUG: undefined,
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@gc.cuny.edu");

  const response = await fetchApp(
    "POST",
    "/api/projects/register",
    env,
    {
      repositoryFullName: "szweibel/cail-assets-build-test"
    },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@gc.cuny.edu"
    }
  );

  assert.equal(response.status, 200);
  const body = await response.json() as {
    ok: boolean;
  };
  assert.equal(body.ok, true);
});

test("Cloudflare Access rejects disallowed email domains", async (t) => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@example.com");

  const response = await fetchApp(
    "POST",
    "/api/projects/register",
    env,
    {
      repositoryFullName: "szweibel/cail-assets-build-test"
    },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@example.com"
    }
  );

  assert.equal(response.status, 403);
});

test("build-job status requires auth when Cloudflare Access is configured", async () => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud"
  });
  db.putBuildJob({
    jobId: "job-protected-1",
    eventName: "validate",
    installationId: 1,
    repository: repositoryRecord("cail-assets-build-test"),
    ref: "main",
    headSha: "validate-sha",
    checkRunId: 99,
    status: "success",
    createdAt: "2026-03-26T21:00:00.000Z",
    updatedAt: "2026-03-26T21:05:00.000Z"
  });

  const response = await fetchApp("GET", "/api/build-jobs/job-protected-1/status", env);
  assert.equal(response.status, 401);
});

test("validate accepts Cloudflare Access auth", async (t) => {
  const { env, queue } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installGitHubFetchMock(t, {
    repositoryName: "cail-assets-build-test",
    headSha: "abc123def456"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@cuny.edu");

  const response = await fetchApp(
    "POST",
    "/api/validate",
    env,
    {
      repositoryFullName: "szweibel/cail-assets-build-test",
      ref: "main"
    },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );

  assert.equal(response.status, 202);
  assert.equal(queue.sent.length, 1);
});

test("project status ignores validate jobs while build-job status normalizes validation success to passed", async () => {
  const { env, db } = createTestContext();
  db.putProject({
    projectName: "cail-assets-build-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    deploymentUrl: "https://cail-assets-build-test.cuny.qzz.io",
    hasAssets: true,
    latestDeploymentId: "dep-live",
    createdAt: "2026-03-26T20:00:00.000Z",
    updatedAt: "2026-03-26T20:10:00.000Z"
  });
  db.putBuildJob({
    jobId: "job-validate-1",
    eventName: "validate",
    installationId: 1,
    repository: repositoryRecord("cail-assets-build-test"),
    ref: "main",
    headSha: "validate-sha",
    checkRunId: 99,
    status: "success",
    createdAt: "2026-03-26T21:00:00.000Z",
    updatedAt: "2026-03-26T21:05:00.000Z",
    startedAt: "2026-03-26T21:00:10.000Z",
    completedAt: "2026-03-26T21:05:00.000Z",
    projectName: "cail-assets-build-test"
  });

  const projectStatusResponse = await fetchApp("GET", "/api/projects/cail-assets-build-test/status", env);
  assert.equal(projectStatusResponse.status, 200);
  const projectStatus = await projectStatusResponse.json() as {
    status: string;
    build_status?: string;
    deployment_url: string;
  };
  assert.equal(projectStatus.status, "live");
  assert.equal(projectStatus.build_status, undefined);
  assert.equal(projectStatus.deployment_url, "https://cail-assets-build-test.cuny.qzz.io");

  const buildJobStatusResponse = await fetchApp("GET", "/api/build-jobs/job-validate-1/status", env);
  assert.equal(buildJobStatusResponse.status, 200);
  const buildJobStatus = await buildJobStatusResponse.json() as {
    jobKind: string;
    status: string;
    build_status: string;
  };
  assert.equal(buildJobStatus.jobKind, "validation");
  assert.equal(buildJobStatus.status, "passed");
  assert.equal(buildJobStatus.build_status, "success");
});

function createTestContext(overrides: Partial<TestEnv> = {}): {
  env: TestEnv;
  db: FakeD1Database;
  queue: FakeQueue;
} {
  const db = new FakeD1Database();
  const queue = new FakeQueue();
  const archive = createArchiveBucketStub();

  const env: TestEnv = {
    CONTROL_PLANE_DB: db as unknown as D1Database,
    DEPLOYMENT_ARCHIVE: archive as unknown as R2Bucket,
    BUILD_QUEUE: queue as unknown as Queue<BuildRunnerJobRequest>,
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    CLOUDFLARE_API_TOKEN: "cloudflare-token",
    WFP_NAMESPACE: "cail-production",
    PROJECT_BASE_URL: "https://gateway.example",
    PROJECT_HOST_SUFFIX: "cuny.qzz.io",
    DEPLOY_SERVICE_BASE_URL: "https://deploy.example",
    MCP_OAUTH_BASE_URL: "https://auth.example",
    DEPLOY_API_TOKEN: "deploy-token",
    MCP_OAUTH_TOKEN_SECRET: "mcp-oauth-secret",
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

  return { env, db, queue };
}

async function fetchApp(
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

async function fetchRaw(request: Request, env: TestEnv): Promise<Response> {
  return deployServiceApp.fetch(request, env, createExecutionContext());
}

async function fetchWorker(
  method: string,
  pathname: string,
  env: TestEnv,
  body?: unknown,
  headers?: HeadersInit
): Promise<Response> {
  const baseUrl = env.DEPLOY_SERVICE_BASE_URL ?? "https://deploy.example";
  const origin = new URL(baseUrl).origin;
  const request = new Request(`${origin}${pathname}`, {
    method,
    headers: body
      ? {
          "content-type": "application/json",
          ...headers
        }
      : headers,
    body: body ? JSON.stringify(body) : undefined
  });

  return deployServiceWorker.fetch(request, env, createExecutionContext());
}

function createExecutionContext(): ExecutionContext {
  return {
    props: {},
    passThroughOnException() {},
    waitUntil() {}
  } as unknown as ExecutionContext;
}

function installGitHubFetchMock(
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

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

function installAccessFetchMock(t: TestContext): void {
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

  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

async function createAccessJwt(email: string): Promise<string> {
  const key = await importPKCS8(TEST_ACCESS_PRIVATE_KEY.privateKey, "RS256");
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key", typ: "JWT" })
    .setIssuer("https://access.example")
    .setAudience("test-access-aud")
    .setSubject(`user:${email}`)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url.encode(new Uint8Array(digest));
}

async function issueTestMcpAccessToken(env: TestEnv, email: string): Promise<string> {
  const oauthBaseUrl = env.MCP_OAUTH_BASE_URL ?? env.DEPLOY_SERVICE_BASE_URL ?? "https://deploy.example";
  const secret = env.MCP_OAUTH_TOKEN_SECRET ?? "mcp-oauth-secret";
  const subject = `user:${email}`;
  const token = await new SignJWT({
    email,
    client_id: "test-client",
    scope: "cail:deploy",
    auth_source: "mcp_oauth"
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(oauthBaseUrl)
    .setAudience("cail-mcp")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));

  return token;
}

async function sealStoredValueForTest(env: TestEnv, plaintext: string): Promise<string> {
  const secret = env.CONTROL_PLANE_ENCRYPTION_KEY ?? "test-control-plane-encryption-key";
  return JSON.stringify(await encryptStoredText(secret, plaintext));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function repositoryRecord(name: string) {
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

function createArchiveBucketStub() {
  return {
    async put() {},
    async list() {
      return {
        objects: [],
        truncated: false,
        cursor: undefined
      };
    },
    async delete() {}
  };
}

class FakeQueue {
  readonly sent: BuildRunnerJobRequest[] = [];

  async send(message: BuildRunnerJobRequest): Promise<void> {
    this.sent.push(message);
  }
}

class FakeD1Database {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly buildJobs = new Map<string, BuildJobRecord>();
  private readonly githubUserAuth = new Map<string, Record<string, unknown>>();
  private readonly projectSecrets = new Map<string, Record<string, unknown>>();
  private readonly usedOauthGrants = new Set<string>();

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
      hasAssets: Number(params[8]) === 1,
      latestDeploymentId: nullableString(params[9]) ?? undefined,
      createdAt: String(params[10]),
      updatedAt: String(params[11])
    };

    this.putProject(project);
  }

  getBuildJob(jobId: string): BuildJobRecord | undefined {
    return this.buildJobs.get(jobId);
  }

  selectGitHubUserAuth(accessSubject: string): Record<string, unknown> | null {
    return this.githubUserAuth.get(accessSubject) ?? null;
  }

  selectProjectSecret(githubRepo: string, secretName: string): Record<string, unknown> | null {
    return this.projectSecrets.get(`${githubRepo}:${secretName}`) ?? null;
  }

  listProjectSecrets(githubRepo: string): Record<string, unknown>[] {
    return Array.from(this.projectSecrets.values())
      .filter((secret) => secret.github_repo === githubRepo)
      .sort((left, right) => String(left.secret_name).localeCompare(String(right.secret_name)));
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

  deleteGitHubUserAuthByGitHubUserId(githubUserId: number): void {
    for (const [accessSubject, row] of this.githubUserAuth.entries()) {
      if (Number(row.github_user_id) === githubUserId) {
        this.githubUserAuth.delete(accessSubject);
      }
    }
  }

  deleteProjectSecret(githubRepo: string, secretName: string): void {
    this.projectSecrets.delete(`${githubRepo}:${secretName}`);
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

    if (normalized.includes("from build_jobs") && normalized.includes("where job_id = ?")) {
      return this.db.selectBuildJob(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from build_jobs") && normalized.includes("where project_name = ?") && normalized.includes("event_name = 'push'")) {
      return this.db.selectLatestPushBuildJob(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from github_user_auth") && normalized.includes("where access_subject = ?")) {
      return this.db.selectGitHubUserAuth(String(this.params[0])) as T | null;
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

    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const normalized = normalizeSql(this.sql);

    if (normalized.includes("from projects") && normalized.includes("where latest_deployment_id is not null")) {
      return { results: this.db.listProjects() as T[] };
    }

    if (normalized.includes("from project_secrets") && normalized.includes("where github_repo = ?")) {
      return { results: this.db.listProjectSecrets(String(this.params[0])) as T[] };
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

    if (normalized.includes("insert into github_user_auth")) {
      this.db.upsertGitHubUserAuthFromParams(this.params);
    }

    if (normalized.includes("insert into project_secrets")) {
      this.db.upsertProjectSecretFromParams(this.params);
    }

    if (normalized.includes("delete from github_user_auth") && normalized.includes("where github_user_id = ?")) {
      this.db.deleteGitHubUserAuthByGitHubUserId(Number(this.params[0]));
    }

    if (normalized.includes("delete from project_secrets") && normalized.includes("where github_repo = ?") && normalized.includes("and secret_name = ?")) {
      this.db.deleteProjectSecret(String(this.params[0]), String(this.params[1]));
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

type TestEnv = {
  CONTROL_PLANE_DB: D1Database;
  DEPLOYMENT_ARCHIVE: R2Bucket;
  BUILD_QUEUE: Queue<BuildRunnerJobRequest>;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_ALLOWED_EMAILS?: string;
  CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS?: string;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  MCP_OAUTH_BASE_URL?: string;
  WFP_NAMESPACE: string;
  PROJECT_BASE_URL: string;
  PROJECT_HOST_SUFFIX?: string;
  DEPLOY_SERVICE_BASE_URL?: string;
  DEPLOY_API_TOKEN?: string;
  MCP_OAUTH_TOKEN_SECRET?: string;
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_NAME?: string;
  GITHUB_APP_MANIFEST_ORG?: string;
  CONTROL_PLANE_ENCRYPTION_KEY?: string;
};
