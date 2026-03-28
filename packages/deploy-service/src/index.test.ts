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
    "archive-or-bibliography",
    "lightweight-ai-interface"
  ]);
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
    "GitHub repository approval is still a browser step for the user, even when the rest of the loop is agent-driven."
  ]);
  assert.deepEqual(body.agent_api.auth.required_for, [
    "repository_status_template",
    "register_project",
    "validate_project",
    "project_status_template",
    "build_job_status_template"
  ]);
  assert.equal(body.mcp.endpoint, "https://deploy.example/mcp");
  assert.equal(body.mcp.transport, "streamable_http");
  assert.equal(body.mcp.auth.authorization_metadata_url, "https://deploy.example/.well-known/oauth-authorization-server");
  assert.equal(body.mcp.auth.protected_resource_metadata_url, "https://deploy.example/.well-known/oauth-protected-resource/mcp");
  assert.equal(body.mcp.auth.dynamic_client_registration_endpoint, "https://deploy.example/oauth/register");
  assert.deepEqual(body.mcp.tools, [
    "get_runtime_manifest",
    "get_repository_status",
    "register_project",
    "validate_project",
    "get_project_status",
    "get_build_job_status"
  ]);
  assert.ok(!("well_known_runtime" in body.agent_api));
});

test("friendly base-path hosting works under /kale", async () => {
  const { env } = createTestContext({
    DEPLOY_SERVICE_BASE_URL: "https://ailab.gc.cuny.edu/kale"
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
  assert.equal(metadata.issuer, "https://ailab.gc.cuny.edu/kale");
  assert.equal(metadata.authorization_endpoint, "https://ailab.gc.cuny.edu/kale/api/oauth/authorize");
  assert.equal(metadata.token_endpoint, "https://ailab.gc.cuny.edu/kale/oauth/token");
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
  assert.match(html, /Already have a GitHub repo\?/);
  assert.match(html, /Use Kale Deploy from the CUNY AI Lab to build me a small web app\./);
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

  const metadataResponse = await fetchApp("GET", "/.well-known/oauth-authorization-server", env);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json() as {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  };
  assert.equal(metadata.authorization_endpoint, "https://deploy.example/api/oauth/authorize");
  assert.equal(metadata.token_endpoint, "https://deploy.example/oauth/token");
  assert.equal(metadata.registration_endpoint, "https://deploy.example/oauth/register");

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
    new Request("https://deploy.example/oauth/token", {
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
  assert.match(body.summary, /live deployment/i);
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
  assert.match(html, /Connect GitHub/);
  assert.match(html, /This repository is ready for the GitHub approval step/);
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
  assert.match(html, /This repository is already connected to Kale Deploy/);
  assert.match(html, /You do not need to go through GitHub again for this repo/);
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
  assert.match(html, /Ready for first push/);
  assert.match(html, /szweibel\/cail-deploy-smoke-test/);
  assert.match(html, /GitHub connection/);
  assert.match(html, /GitHub is connected for Kale Deploy/);
  assert.match(html, /What happens automatically/);
  assert.match(html, /GitHub connection is confirmed for this repository/);
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
  assert.match(html, /You came back from GitHub, but this repository still is not connected/);
  assert.match(html, /Update repository access in GitHub/);
  assert.match(html, /Connect GitHub for this repo/);
  assert.match(html, /Do not validate or push yet/i);
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

  const env: TestEnv = {
    CONTROL_PLANE_DB: db as unknown as D1Database,
    DEPLOYMENT_ARCHIVE: {} as R2Bucket,
    BUILD_QUEUE: queue as unknown as Queue<BuildRunnerJobRequest>,
    CLOUDFLARE_ACCOUNT_ID: "account-123",
    WFP_NAMESPACE: "cail-production",
    PROJECT_BASE_URL: "https://gateway.example",
    PROJECT_HOST_SUFFIX: "cuny.qzz.io",
    DEPLOY_SERVICE_BASE_URL: "https://deploy.example",
    MCP_OAUTH_TOKEN_SECRET: "mcp-oauth-secret",
    GITHUB_APP_ID: "3196468",
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
    GITHUB_APP_SLUG: "cail-deploy",
    GITHUB_APP_NAME: "CAIL Deploy",
    GITHUB_APP_MANIFEST_ORG: "CUNY-AI-Lab",
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
  const serviceBaseUrl = env.DEPLOY_SERVICE_BASE_URL ?? "https://deploy.example";
  const secret = env.MCP_OAUTH_TOKEN_SECRET ?? "mcp-oauth-secret";
  const subject = `user:${email}`;
  const token = await new SignJWT({
    email,
    client_id: "test-client",
    scope: "cail:deploy",
    auth_source: "mcp_oauth"
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(serviceBaseUrl)
    .setAudience("cail-mcp")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));

  return token;
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

class FakeQueue {
  readonly sent: BuildRunnerJobRequest[] = [];

  async send(message: BuildRunnerJobRequest): Promise<void> {
    this.sent.push(message);
  }
}

class FakeD1Database {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly buildJobs = new Map<string, BuildJobRecord>();
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

  getBuildJob(jobId: string): BuildJobRecord | undefined {
    return this.buildJobs.get(jobId);
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

    if (normalized.includes("from build_jobs") && normalized.includes("where job_id = ?")) {
      return this.db.selectBuildJob(String(this.params[0])) as T | null;
    }

    if (normalized.includes("from build_jobs") && normalized.includes("where project_name = ?") && normalized.includes("event_name = 'push'")) {
      return this.db.selectLatestPushBuildJob(String(this.params[0])) as T | null;
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

    return { results: [] };
  }

  async run(): Promise<Record<string, never>> {
    const normalized = normalizeSql(this.sql);

    if (normalized.includes("insert into build_jobs")) {
      this.db.upsertBuildJobFromParams(this.params);
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
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_ALLOWED_EMAILS?: string;
  CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS?: string;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  WFP_NAMESPACE: string;
  PROJECT_BASE_URL: string;
  PROJECT_HOST_SUFFIX?: string;
  DEPLOY_SERVICE_BASE_URL?: string;
  MCP_OAUTH_TOKEN_SECRET?: string;
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_NAME?: string;
  GITHUB_APP_MANIFEST_ORG?: string;
};
