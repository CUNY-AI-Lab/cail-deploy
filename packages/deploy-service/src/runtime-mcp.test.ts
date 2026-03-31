import assert from "node:assert/strict";
import test from "node:test";

import {
  createAccessJwt,
  createPkceChallenge,
  createTestContext,
  fetchApp,
  fetchRaw,
  fetchWorker,
  installAccessFetchMock,
  installGitHubFetchMock,
  issueTestMcpAccessToken,
  issueTestMcpPatToken
} from "./test-support";

test("runtime manifest advertises the agent API without duplicate well-known keys", async () => {
  const { env } = createTestContext();
  const response = await fetchApp("GET", "/.well-known/kale-runtime.json", env);
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

  assert.equal(body.well_known_runtime_url, "https://runtime.cuny.qzz.io/.well-known/kale-runtime.json");
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
  assert.equal(body.agent_api.oauth_authorization_metadata, "https://deploy.example/.well-known/oauth-authorization-server");
  assert.equal(body.agent_api.oauth_protected_resource_metadata, "https://deploy.example/.well-known/oauth-protected-resource/mcp");
  assert.equal(body.agent_api.repository_status_template, "https://deploy.example/api/repositories/{owner}/{repo}/status");
  assert.equal(body.agent_api.validate_project, "https://deploy.example/api/validate");
  assert.equal(body.agent_api.build_job_status_template, "https://deploy.example/api/build-jobs/{jobId}/status");
  assert.equal(body.agent_api.auth.headless_bootstrap_supported, false);
  assert.equal(body.agent_api.auth.browser_session_required_for_authorization, true);
  assert.deepEqual(body.agent_api.auth.human_handoff_rules, [
    "If register_project or get_repository_status returns guidedInstallUrl, stop and give that URL to the user.",
    "GitHub repository approval is still a browser step for the user, even when the rest of the loop is agent-driven.",
    "If a harness cannot complete MCP OAuth reliably, send the user to /connect to generate a Kale token and configure the MCP server with an Authorization: Bearer header.",
    "Project secret management may ask the user to confirm their GitHub account separately, because secret changes require repo write/admin access.",
    "The browser settings page is a private admin surface. Use it only for project-admin tasks such as secrets, not for ordinary deploy or status work."
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
  assert.equal(body.mcp.auth.authorization_metadata_url, "https://deploy.example/.well-known/oauth-authorization-server");
  assert.equal(body.mcp.auth.protected_resource_metadata_url, "https://deploy.example/.well-known/oauth-protected-resource/mcp");
  assert.equal(body.mcp.auth.dynamic_client_registration_endpoint, "https://deploy.example/oauth/register");
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
  assert.equal(metadata.authorization_endpoint, "https://ailab.gc.cuny.edu/kale/api/oauth/authorize");
  assert.equal(metadata.token_endpoint, "https://ailab.gc.cuny.edu/kale/oauth/token");
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
  assert.equal(body.authorizationUrl, "https://deploy.example/api/oauth/authorize");
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
  assert.match(html, /Build a website with an AI coding agent/);
  assert.match(html, /Claude Code/);
  assert.match(html, /Codex/);
  assert.match(html, /Gemini CLI/);
  assert.match(html, /Connect your agent/);
  assert.match(html, /claude plugins install kale-deploy@cuny-ai-lab -s local/);
  assert.match(html, /https:\/\/deploy\.example\/connect/);
  assert.match(html, /codex mcp add kale --url https:\/\/[^\s"]+\/mcp/);
  assert.match(html, /Already have a GitHub repo\?/);
  assert.match(html, /Build me a small web app and deploy it with Kale Deploy/);
  assert.match(html, /smoke-test/);
  assert.match(html, /href="https:\/\/deploy\.example\/projects\/control"/);
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

test("mcp returns an actionable PAT expiry error", async () => {
  const { env, db } = createTestContext({
    MCP_OAUTH_TOKEN_SECRET: "mcp-oauth-secret"
  });
  const expiredToken = await issueTestMcpPatToken(db, "person@cuny.edu", {
    expiresAt: "2000-01-01T00:00:00"
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
      authorization: `Bearer ${expiredToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );

  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /Your Kale token has expired/);
  assert.deepEqual(await response.json(), {
    error: "invalid_token",
    error_description: "Your Kale token has expired. Visit https://deploy.example/connect to generate a new one.",
    connect_url: "https://deploy.example/connect",
    auth_mode: "personal_access_token",
    reason: "token_expired"
  });
});

test("mcp ping confirms authenticated connection state", async () => {
  const { env } = createTestContext({
    MCP_OAUTH_TOKEN_SECRET: "mcp-oauth-secret"
  });
  const accessToken = await issueTestMcpAccessToken(env, "person@cuny.edu");

  const response = await fetchApp(
    "GET",
    "/mcp/ping",
    env,
    undefined,
    {
      authorization: `Bearer ${accessToken}`
    }
  );

  assert.equal(response.status, 200);
  const body = await response.json() as {
    ok: boolean;
    authenticated: boolean;
    identityType: string;
    email: string;
    summary: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.authenticated, true);
  assert.equal(body.identityType, "mcp_oauth");
  assert.equal(body.email, "person@cuny.edu");
  assert.match(body.summary, /connected and authenticated/i);
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
  assert.deepEqual(prm.authorization_servers, ["https://deploy.example"]);
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
  assert.equal(metadata.authorization_endpoint, "https://deploy.example/api/oauth/authorize");
  assert.equal(metadata.token_endpoint, "https://deploy.example/oauth/token");
  assert.equal(metadata.registration_endpoint, "https://deploy.example/oauth/register");

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
  assert.equal(authorizeResponse.status, 200);
  const authorizeHtml = await authorizeResponse.text();
  assert.match(authorizeHtml, /Return to your agent/);
  assert.match(authorizeHtml, /Handing off to your local agent/);
  const callbackMatch = authorizeHtml.match(/const callbackUrl = "([^"]+)";/);
  assert.ok(callbackMatch);
  const redirect = new URL(JSON.parse(`"${callbackMatch?.[1] ?? ""}"`));
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
    /^https:\/\/deploy\.example\/api\/github\/user-auth\/start\?/
  );
});
