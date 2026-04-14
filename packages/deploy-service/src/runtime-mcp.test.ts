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
    agent_build_default: string;
    scaffold_shape_required: boolean;
    scaffold_shape_options: string[];
    preferred_worker_framework: string;
    static_project_marker_file: string;
    static_project_shape_value: string;
    worker_project_shape_value: string;
    static_project_assets_directory_hint: string;
    static_project_request_time_logic_key: string;
    static_project_request_time_logic_value: string;
    worker_project_request_time_logic_value: string;
    dynamic_skill_policy: {
      local_bundle_role: string;
      authoritative_tools: string[];
      runtime_manifest_fields: string[];
      test_connection_fields: string[];
      wrapper_check_query_parameters: string[];
      refresh_points: string[];
      notes: string[];
    };
    client_update_policy: {
      remote_mcp_update_mode: string;
      local_wrapper_update_mode: string;
      runtime_manifest_preferred: boolean;
      notes: string[];
    };
    agent_harnesses: Array<{
      id: string;
      install_surface: string;
      install_mode: string;
      install_instruction: string;
      install_notes: string[];
      local_wrapper: {
        kind: string;
        bundle_version: string;
        update_mode: string;
        update_command?: string;
        restart_required_after_update?: boolean;
      };
      manual_fallback?: {
        auth_mode: string;
        instruction: string;
        hint: string;
        notes: string[];
      };
    }>;
    agent_build_guidance: string[];
    reserved_project_names: string[];
    good_fit_project_types: string[];
    approval_required_project_types: string[];
    default_limits: {
      max_validations_per_day: number | null;
      max_deployments_per_day: number | null;
      max_concurrent_builds: number;
      max_asset_bytes: number;
      max_live_dedicated_workers_per_owner: number;
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
  assert.equal(body.agent_build_default, "choose-the-lightest-worker-compatible-shape");
  assert.equal(body.scaffold_shape_required, true);
  assert.deepEqual(body.scaffold_shape_options, ["static", "worker"]);
  assert.equal(body.preferred_worker_framework, "hono");
  assert.equal(body.static_project_marker_file, "kale.project.json");
  assert.equal(body.static_project_shape_value, "static_site");
  assert.equal(body.worker_project_shape_value, "worker_app");
  assert.equal(body.static_project_assets_directory_hint, "public");
  assert.equal(body.static_project_request_time_logic_key, "requestTimeLogic");
  assert.equal(body.static_project_request_time_logic_value, "none");
  assert.equal(body.worker_project_request_time_logic_value, "allowed");
  assert.equal(body.dynamic_skill_policy.local_bundle_role, "bootstrap_only");
  assert.deepEqual(body.dynamic_skill_policy.authoritative_tools, ["get_runtime_manifest", "test_connection"]);
  assert.deepEqual(body.dynamic_skill_policy.runtime_manifest_fields, [
    "dynamic_skill_policy",
    "client_update_policy",
    "agent_harnesses",
    "agent_build_guidance",
    "agent_api.auth.human_handoff_rules"
  ]);
  assert.deepEqual(body.dynamic_skill_policy.test_connection_fields, [
    "dynamicSkillPolicy",
    "clientUpdatePolicy",
    "harnesses",
    "nextAction",
    "summary"
  ]);
  assert.deepEqual(body.dynamic_skill_policy.wrapper_check_query_parameters, [
    "harness",
    "localBundleVersion"
  ]);
  assert.match(body.dynamic_skill_policy.refresh_points[0] ?? "", /When Kale tools first appear/i);
  assert.match(body.dynamic_skill_policy.notes[0] ?? "", /bootstrap layer/i);
  assert.equal(body.client_update_policy.remote_mcp_update_mode, "automatic");
  assert.equal(body.client_update_policy.local_wrapper_update_mode, "harness_specific");
  assert.equal(body.client_update_policy.runtime_manifest_preferred, true);
  assert.match(body.client_update_policy.notes[0] ?? "", /Remote Kale MCP and runtime changes apply immediately/i);
  assert.equal(body.agent_harnesses.length, 3);
  assert.deepEqual(body.agent_harnesses.map((entry) => entry.id), ["claude", "codex", "gemini"]);
  assert.equal(body.agent_harnesses[0]?.local_wrapper.bundle_version, "0.2.9");
  assert.equal(body.agent_harnesses[0]?.local_wrapper.update_mode, "manual");
  assert.equal(body.agent_harnesses[0]?.local_wrapper.update_command, "claude plugins update kale-deploy@cuny-ai-lab -s user");
  assert.equal(body.agent_harnesses[0]?.local_wrapper.restart_required_after_update, true);
  assert.ok(body.agent_harnesses[0]?.install_notes.some((note) => /do not search the MCP registry first/i.test(note)));
  assert.ok(body.agent_harnesses[0]?.install_notes.some((note) => /Use mcp-remote only to complete the OAuth browser flow/i.test(note)));
  assert.ok(body.agent_harnesses[0]?.install_notes.some((note) => /single user-scope kale HTTP server/i.test(note)));
  assert.equal(body.agent_harnesses[0]?.manual_fallback?.auth_mode, "oauth_bridge_to_http");
  assert.match(body.agent_harnesses[0]?.manual_fallback?.hint ?? "", /Current recommended Claude bootstrap and finalize path/i);
  assert.match(body.agent_harnesses[0]?.manual_fallback?.instruction ?? "", /mcp-remote/);
  assert.match(body.agent_harnesses[0]?.manual_fallback?.instruction ?? "", /kale-claude-connect\.mjs/);
  assert.ok((body.agent_harnesses[0]?.manual_fallback?.notes ?? []).some((note) => /Use mcp-remote only long enough to complete the OAuth browser flow/i.test(note)));
  assert.ok((body.agent_harnesses[0]?.manual_fallback?.notes ?? []).some((note) => /headersHelper to read the latest valid Kale mcp-remote OAuth token/i.test(note)));
  assert.ok((body.agent_harnesses[0]?.manual_fallback?.notes ?? []).some((note) => /refreshes it automatically/i.test(note)));
  assert.ok((body.agent_harnesses[0]?.manual_fallback?.notes ?? []).some((note) => /Only rerun the mcp-remote bootstrap if the helper reports that no valid Kale OAuth or refresh token is available/i.test(note)));
  assert.ok((body.agent_harnesses[0]?.manual_fallback?.notes ?? []).some((note) => /Last-resort token bridge:/i.test(note)));
  assert.equal(body.agent_harnesses[1]?.install_surface, "app_add_on");
  assert.equal(body.agent_harnesses[1]?.install_mode, "command");
  assert.match(body.agent_harnesses[1]?.install_instruction ?? "", /codex mcp add kale/i);
  assert.equal(body.agent_harnesses[1]?.local_wrapper.update_mode, "unknown");
  assert.equal(body.agent_harnesses[1]?.manual_fallback?.auth_mode, "oauth_browser");
  assert.match(body.agent_harnesses[1]?.manual_fallback?.instruction ?? "", /codex mcp login kale/i);
  assert.equal(body.agent_harnesses[2]?.install_surface, "extension");
  assert.match(body.agent_harnesses[2]?.install_instruction ?? "", /--auto-update/);
  assert.equal(body.agent_harnesses[2]?.local_wrapper.update_command, "gemini extensions update kale-deploy");
  assert.match(body.agent_build_guidance[0] ?? "", /pick a starter shape explicitly/i);
  assert.match(body.agent_build_guidance[1] ?? "", /prefer a pure static project/i);
  assert.match(body.agent_build_guidance[2] ?? "", /Hono is the preferred Worker framework/i);
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
    max_asset_bytes: 94371840,
    max_live_dedicated_workers_per_owner: 5
  });
  assert.match(body.limit_rationale.max_validations_per_day, /Not capped by default/i);
  assert.match(body.limit_rationale.max_asset_bytes, /multipart upload/i);
  assert.match(body.limit_rationale.max_live_dedicated_workers_per_owner, /per GitHub owner/i);
  assert.deepEqual(body.approval_required_bindings, ["AI", "VECTORIZE", "ROOMS"]);
  assert.deepEqual(body.self_service_bindings, ["DB", "FILES", "CACHE"]);
  assert.match(body.binding_rationale.FILES, /repo-scoped R2 bucket/i);
  assert.match(body.binding_rationale.CACHE, /repo-scoped KV namespace/i);
  assert.deepEqual(body.deployment_ready_repository.required_files, [
    "package.json",
    "kale.project.json",
    "wrangler.jsonc",
    "src/index.ts",
    "AGENTS.md"
  ]);
  assert.deepEqual(body.deployment_ready_repository.expected_routes, ["/"]);
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
    "Sensitive project-admin actions like secrets and project deletion may ask the user to confirm their GitHub account separately, because they require repo write/admin access.",
    "The browser settings page is a private admin surface. Use it only for project-admin tasks such as secrets or project deletion, not for ordinary deploy or status work."
  ]);
  assert.deepEqual(body.agent_api.auth.required_for, [
    "repository_status_template",
    "register_project",
    "validate_project",
    "project_status_template",
    "build_job_status_template",
    "project_secrets_template",
    "project_delete_template"
  ]);
  assert.equal(body.agent_api.project_secrets_template, "https://deploy.example/api/projects/{projectName}/secrets");
  assert.equal(body.agent_api.project_delete_template, "https://deploy.example/api/projects/{projectName}");
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
    "delete_project_secret",
    "delete_project"
  ]);
  assert.ok(!("well_known_runtime" in body.agent_api));
});

test("friendly base-path hosting works under /kale", async () => {
  const { env } = createTestContext({
    DEPLOY_SERVICE_BASE_URL: "https://ailab.gc.cuny.edu/kale",
    MCP_OAUTH_BASE_URL: "https://auth.ailab.gc.cuny.edu"
  });

  // The Hono UI (landing page, /github/setup) still lives under the /kale path prefix.
  const homepage = await fetchWorker("GET", "/kale/", env);
  assert.equal(homepage.status, 200);
  const html = await homepage.text();
  assert.match(html, /Kale Deploy/);
  assert.match(html, /action="https:\/\/ailab\.gc\.cuny\.edu\/kale\/github\/setup"/);

  // OAuth metadata is now served by @cloudflare/workers-oauth-provider at the origin
  // root. The host-proxy rewrites the RFC 9728 path-suffix variant
  // (`/.well-known/oauth-authorization-server/kale`) to this root path upstream.
  const metadataResponse = await fetchWorker("GET", "/.well-known/oauth-authorization-server", env);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json() as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  };
  assert.equal(metadata.issuer, "https://ailab.gc.cuny.edu");
  assert.equal(metadata.authorization_endpoint, "https://ailab.gc.cuny.edu/api/oauth/authorize");
  assert.equal(metadata.token_endpoint, "https://ailab.gc.cuny.edu/oauth/token");
  assert.equal(metadata.registration_endpoint, "https://ailab.gc.cuny.edu/oauth/register");
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
    dynamicSkillPolicy: {
      localBundleRole: string;
      authoritativeTools: string[];
      runtimeManifestFields: string[];
      testConnectionFields: string[];
      wrapperCheckQueryParameters: string[];
      refreshPoints: string[];
      notes: string[];
    };
    localWrapperStatus?: {
      harnessId: string;
      status: string;
      warning: boolean;
      localBundleVersion: string;
      expectedBundleVersion?: string;
      summary: string;
      updateMode?: string;
      updateCommand?: string;
    };
    clientUpdatePolicy: {
      remoteMcpUpdateMode: string;
      localWrapperUpdateMode: string;
      runtimeManifestPreferred: boolean;
      notes: string[];
    };
    harnesses: Array<{
      id: string;
      installSurface: string;
      installMode: string;
      installInstruction: string;
      localWrapper: {
        updateMode: string;
        updateCommand?: string;
      };
    }>;
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
  assert.equal(body.dynamicSkillPolicy.localBundleRole, "bootstrap_only");
  assert.deepEqual(body.dynamicSkillPolicy.authoritativeTools, ["get_runtime_manifest", "test_connection"]);
  assert.deepEqual(body.dynamicSkillPolicy.runtimeManifestFields, [
    "dynamic_skill_policy",
    "client_update_policy",
    "agent_harnesses",
    "agent_build_guidance",
    "agent_api.auth.human_handoff_rules"
  ]);
  assert.deepEqual(body.dynamicSkillPolicy.testConnectionFields, [
    "dynamicSkillPolicy",
    "clientUpdatePolicy",
    "harnesses",
    "nextAction",
    "summary"
  ]);
  assert.deepEqual(body.dynamicSkillPolicy.wrapperCheckQueryParameters, [
    "harness",
    "localBundleVersion"
  ]);
  assert.match(body.dynamicSkillPolicy.refreshPoints[1] ?? "", /After authentication succeeds/i);
  assert.equal(body.clientUpdatePolicy.remoteMcpUpdateMode, "automatic");
  assert.equal(body.clientUpdatePolicy.localWrapperUpdateMode, "harness_specific");
  assert.equal(body.clientUpdatePolicy.runtimeManifestPreferred, true);
  assert.equal(body.localWrapperStatus, undefined);
  assert.deepEqual(body.harnesses.map((entry) => entry.id), ["claude", "codex", "gemini"]);
  assert.equal(body.harnesses[0]?.localWrapper.updateCommand, "claude plugins update kale-deploy@cuny-ai-lab -s user");
  assert.equal(body.harnesses[1]?.installMode, "command");
  assert.equal(body.harnesses[2]?.localWrapper.updateCommand, "gemini extensions update kale-deploy");
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
  assert.match(html, /A web publishing tool from the CUNY AI Lab/);
  assert.match(html, /Claude Code/);
  assert.match(html, /Codex/);
  assert.match(html, /Gemini CLI/);
  assert.match(html, /Install once/);
  assert.match(html, /Use this install step once in your AI agent/i);
  assert.match(html, /\/plugin marketplace add CUNY-AI-Lab\/CAIL-deploy/);
  assert.match(html, /\/plugin install kale-deploy@cuny-ai-lab/);
  assert.match(html, /codex mcp add kale/);
  assert.doesNotMatch(html, /Manual fallback/);
  assert.match(html, /\/extensions install https:\/\/github\.com\/CUNY-AI-Lab\/CAIL-deploy --auto-update/);
  assert.match(html, /Already have a GitHub repo\?/);
  assert.match(html, /Build me a small web app with Kale Deploy and put it online so I can see it live/);
  assert.match(html, /smoke-test/);
  assert.match(html, /Featured Projects/);
  assert.match(html, /href="https:\/\/deploy\.example\/projects\/control"/);
});

test("featured projects page lists curated live projects only", async () => {
  const { env, db } = createTestContext();
  db.putProject({
    projectName: "cloze-reader",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cloze-reader",
    description: "Interactive reading practice with live passages.",
    deploymentUrl: "https://cloze-reader.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-04-04T10:00:00.000Z",
    updatedAt: "2026-04-04T10:10:00.000Z"
  });
  db.putProject({
    projectName: "langames",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/langames",
    description: "Language games.",
    deploymentUrl: "https://langames.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-2",
    createdAt: "2026-04-04T10:00:00.000Z",
    updatedAt: "2026-04-04T10:20:00.000Z"
  });
  db.putFeaturedProject({
    github_repo: "szweibel/cloze-reader",
    project_name: "cloze-reader",
    headline: "A reading game for practicing comprehension.",
    sort_order: 2,
    created_at: "2026-04-04T10:30:00.000Z",
    updated_at: "2026-04-04T10:30:00.000Z"
  });

  const response = await fetchApp("GET", "/featured", env);
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Featured Projects/);
  assert.match(html, /cloze-reader/);
  assert.match(html, /A reading game for practicing comprehension/);
  assert.doesNotMatch(html, /langames/);
  assert.match(html, /Open site/);
  assert.match(html, /View code/);
});

test("mcp advertises OAuth metadata when unauthorized", async () => {
  const { env } = createTestContext({
  });

  for (const method of ["GET", "POST"] as const) {
    const response = await fetchApp(
      method,
      "/mcp",
      env,
      method === "POST"
        ? {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {}
          }
        : undefined,
      {
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26"
      }
    );

    // The workers-oauth-provider returns the standard OAuth 2.1 WWW-Authenticate challenge
    // with an RFC 9728 resource_metadata hint. The exact error wording is library-owned.
    assert.equal(response.status, 401, method);
    assert.match(response.headers.get("www-authenticate") ?? "", /Bearer/i, method);
    assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource[^"]*"/, method);
    const body = await response.json() as { error: string; error_description?: string };
    assert.equal(body.error, "invalid_token", method);
    assert.ok(body.error_description, method);
  }
});

test("mcp rejects expired PAT tokens", async () => {
  const { env, db } = createTestContext({
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

  // PAT resolution runs through the provider's resolveExternalToken callback. Expired,
  // revoked, and unknown PATs all collapse into the standard "invalid_token" challenge.
  // The /connect page continues to guide users to rotate their PAT.
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /Bearer/i);
  const body = await response.json() as { error: string };
  assert.equal(body.error, "invalid_token");
});

test("mcp ping confirms authenticated connection state", async () => {
  const { env } = createTestContext({
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
  // The workers-oauth-provider reflects the request Origin back rather than emitting a
  // wildcard. Any non-empty ACAO response satisfies CORS preflight.
  assert.ok((preflight.headers.get("access-control-allow-origin") ?? "").length > 0);

  const authenticatedGet = await fetchApp(
    "GET",
    "/mcp",
    env,
    undefined,
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(authenticatedGet.status, 405);
  assert.deepEqual(await authenticatedGet.json(), {
    error: "SSE streaming is not supported in stateless mode."
  });

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
        dynamicSkillPolicy: {
          localBundleRole: string;
          authoritativeTools: string[];
          testConnectionFields: string[];
          wrapperCheckQueryParameters: string[];
        };
        localWrapperStatus?: {
          harnessId: string;
          status: string;
          warning: boolean;
          localBundleVersion: string;
          expectedBundleVersion?: string;
          summary: string;
          updateMode?: string;
          updateCommand?: string;
        };
        clientUpdatePolicy: {
          remoteMcpUpdateMode: string;
          localWrapperUpdateMode: string;
        };
        harnesses: Array<{
          id: string;
          localWrapper: {
            updateMode: string;
            updateCommand?: string;
          };
        }>;
      };
    };
  };
  assert.equal(testConnectionResult.result.structuredContent.authenticated, true);
  assert.equal(testConnectionResult.result.structuredContent.nextAction, "register_project");
  assert.match(testConnectionResult.result.structuredContent.summary, /connected and authenticated/i);
  assert.equal(testConnectionResult.result.structuredContent.dynamicSkillPolicy.localBundleRole, "bootstrap_only");
  assert.deepEqual(testConnectionResult.result.structuredContent.dynamicSkillPolicy.authoritativeTools, ["get_runtime_manifest", "test_connection"]);
  assert.deepEqual(testConnectionResult.result.structuredContent.dynamicSkillPolicy.testConnectionFields, [
    "dynamicSkillPolicy",
    "clientUpdatePolicy",
    "harnesses",
    "nextAction",
    "summary"
  ]);
  assert.deepEqual(testConnectionResult.result.structuredContent.dynamicSkillPolicy.wrapperCheckQueryParameters, [
    "harness",
    "localBundleVersion"
  ]);
  assert.equal(testConnectionResult.result.structuredContent.localWrapperStatus, undefined);
  assert.equal(testConnectionResult.result.structuredContent.clientUpdatePolicy.remoteMcpUpdateMode, "automatic");
  assert.equal(testConnectionResult.result.structuredContent.clientUpdatePolicy.localWrapperUpdateMode, "harness_specific");
  assert.equal(testConnectionResult.result.structuredContent.harnesses[0]?.localWrapper.updateMode, "manual");
  assert.equal(testConnectionResult.result.structuredContent.harnesses[0]?.localWrapper.updateCommand, "claude plugins update kale-deploy@cuny-ai-lab -s user");
});

test("mcp exposes admin tools only to allowlisted OAuth admins and supports featured curation", async () => {
  const { env, db } = createTestContext({
    KALE_ADMIN_EMAILS: "person@cuny.edu"
  });
  db.putProject({
    projectName: "cloze-reader",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cloze-reader",
    description: "Practice reading with interactive passages.",
    deploymentUrl: "https://cloze-reader.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-04-04T10:00:00.000Z",
    updatedAt: "2026-04-04T10:10:00.000Z"
  });

  const adminAccessToken = await issueTestMcpAccessToken(env, "person@cuny.edu");
  const nonAdminAccessToken = await issueTestMcpAccessToken(env, "someone@cuny.edu");

  const adminToolListResponse = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/list",
      params: {}
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${adminAccessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(adminToolListResponse.status, 200);
  const adminToolList = await adminToolListResponse.json() as {
    result: {
      tools: Array<{ name: string }>;
    };
  };
  assert.ok(adminToolList.result.tools.some((tool) => tool.name === "get_admin_overview"));
  assert.ok(adminToolList.result.tools.some((tool) => tool.name === "set_featured_project"));
  assert.ok(adminToolList.result.tools.some((tool) => tool.name === "unfeature_project"));
  assert.ok(adminToolList.result.tools.some((tool) => tool.name === "set_owner_capacity_override"));
  assert.ok(adminToolList.result.tools.some((tool) => tool.name === "clear_owner_capacity_override"));

  const nonAdminToolListResponse = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/list",
      params: {}
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${nonAdminAccessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(nonAdminToolListResponse.status, 200);
  const nonAdminToolList = await nonAdminToolListResponse.json() as {
    result: {
      tools: Array<{ name: string }>;
    };
  };
  assert.ok(!nonAdminToolList.result.tools.some((tool) => tool.name === "get_admin_overview"));
  assert.ok(!nonAdminToolList.result.tools.some((tool) => tool.name === "set_featured_project"));
  assert.ok(!nonAdminToolList.result.tools.some((tool) => tool.name === "set_owner_capacity_override"));

  const setFeaturedResponse = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "set_featured_project",
        arguments: {
          projectName: "cloze-reader",
          headline: "A reading game for practicing comprehension.",
          sortOrder: 2
        }
      }
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${adminAccessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(setFeaturedResponse.status, 200);
  const setFeaturedBody = await setFeaturedResponse.json() as {
    result: {
      structuredContent: {
        featured: {
          enabled: boolean;
          headline?: string;
          sortOrder: number;
        };
      };
    };
  };
  assert.equal(setFeaturedBody.result.structuredContent.featured.enabled, true);
  assert.equal(setFeaturedBody.result.structuredContent.featured.headline, "A reading game for practicing comprehension.");
  assert.equal(setFeaturedBody.result.structuredContent.featured.sortOrder, 2);

  const overviewResponse = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: {
        name: "get_admin_overview",
        arguments: {}
      }
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${adminAccessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(overviewResponse.status, 200);
  const overviewBody = await overviewResponse.json() as {
    result: {
      structuredContent: {
        projectCount: number;
        featuredProjectCount: number;
        projects: Array<{ projectName: string; featured: { enabled: boolean; sortOrder: number } }>;
      };
    };
  };
  assert.equal(overviewBody.result.structuredContent.projectCount, 1);
  assert.equal(overviewBody.result.structuredContent.featuredProjectCount, 1);
  assert.equal(overviewBody.result.structuredContent.projects[0]?.projectName, "cloze-reader");
  assert.equal(overviewBody.result.structuredContent.projects[0]?.featured.enabled, true);
  assert.equal(overviewBody.result.structuredContent.projects[0]?.featured.sortOrder, 2);

  const setCapacityResponse = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: {
        name: "set_owner_capacity_override",
        arguments: {
          ownerLogin: "course-org",
          maxLiveDedicatedWorkers: 12,
          note: "Showcase week"
        }
      }
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${adminAccessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(setCapacityResponse.status, 200);
  const setCapacityBody = await setCapacityResponse.json() as {
    result: {
      structuredContent: {
        ownerLogin: string;
        capacityOverride: {
          maxLiveDedicatedWorkers: number;
          note?: string;
        };
      };
    };
  };
  assert.equal(setCapacityBody.result.structuredContent.ownerLogin, "course-org");
  assert.equal(setCapacityBody.result.structuredContent.capacityOverride.maxLiveDedicatedWorkers, 12);
  assert.equal(setCapacityBody.result.structuredContent.capacityOverride.note, "Showcase week");

  const unfeatureResponse = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 25,
      method: "tools/call",
      params: {
        name: "unfeature_project",
        arguments: {
          projectName: "cloze-reader"
        }
      }
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${adminAccessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(unfeatureResponse.status, 200);
  assert.equal(db.selectFeaturedProject("szweibel/cloze-reader"), null);

  const clearCapacityResponse = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 26,
      method: "tools/call",
      params: {
        name: "clear_owner_capacity_override",
        arguments: {
          ownerLogin: "course-org"
        }
      }
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${adminAccessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(clearCapacityResponse.status, 200);
  assert.equal(db.selectOwnerCapacityOverride("course-org"), null);
});

test("mcp does not expose admin tools to legacy featured editors without KALE_ADMIN_EMAILS", async () => {
  const { env, db } = createTestContext({
    FEATURED_PROJECT_ADMIN_EMAILS: "person@cuny.edu"
  });
  db.putProject({
    projectName: "cloze-reader",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cloze-reader",
    deploymentUrl: "https://cloze-reader.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-04-04T10:00:00.000Z",
    updatedAt: "2026-04-04T10:10:00.000Z"
  });

  const accessToken = await issueTestMcpAccessToken(env, "person@cuny.edu");
  const toolListResponse = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 25,
      method: "tools/list",
      params: {}
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(toolListResponse.status, 200);
  const toolList = await toolListResponse.json() as {
    result: {
      tools: Array<{ name: string }>;
    };
  };
  assert.ok(!toolList.result.tools.some((tool) => tool.name === "get_admin_overview"));
  assert.ok(!toolList.result.tools.some((tool) => tool.name === "set_featured_project"));
  assert.ok(!toolList.result.tools.some((tool) => tool.name === "unfeature_project"));
  assert.ok(!toolList.result.tools.some((tool) => tool.name === "set_owner_capacity_override"));
  assert.ok(!toolList.result.tools.some((tool) => tool.name === "clear_owner_capacity_override"));
});

test("connection health reports a stale local wrapper when the harness version is older", async () => {
  const { env } = createTestContext();

  const response = await fetchApp("GET", "/.well-known/kale-connection.json?harness=gemini&localBundleVersion=0.1.0", env);
  assert.equal(response.status, 200);

  const body = await response.json() as {
    summary: string;
    localWrapperStatus?: {
      harnessId: string;
      status: string;
      warning: boolean;
      localBundleVersion: string;
      expectedBundleVersion?: string;
      updateMode?: string;
      updateCommand?: string;
      summary: string;
    };
  };

  assert.equal(body.localWrapperStatus?.harnessId, "gemini");
  assert.equal(body.localWrapperStatus?.status, "stale");
  assert.equal(body.localWrapperStatus?.warning, true);
  assert.equal(body.localWrapperStatus?.localBundleVersion, "0.1.0");
  assert.equal(body.localWrapperStatus?.expectedBundleVersion, "0.2.9");
  assert.equal(body.localWrapperStatus?.updateMode, "manual");
  assert.equal(body.localWrapperStatus?.updateCommand, "gemini extensions update kale-deploy");
  assert.match(body.localWrapperStatus?.summary ?? "", /Refresh or update the local wrapper/i);
  assert.match(body.summary, /Gemini CLI reported local bundle version 0.1.0/i);
});

test("mcp test_connection reports a stale local wrapper when the harness version is older", async () => {
  const { env } = createTestContext({
  });
  const accessToken = await issueTestMcpAccessToken(env, "person@cuny.edu");

  const testConnectionResponse = await fetchApp(
    "POST",
    "/mcp",
    env,
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "test_connection",
        arguments: {
          harness: "codex",
          localBundleVersion: "0.1.0"
        }
      }
    },
    {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": "2025-03-26"
    }
  );
  assert.equal(testConnectionResponse.status, 200);

  const body = await testConnectionResponse.json() as {
    result: {
      structuredContent: {
        summary: string;
        localWrapperStatus?: {
          harnessId: string;
          status: string;
          warning: boolean;
          localBundleVersion: string;
          expectedBundleVersion?: string;
          updateMode?: string;
          summary: string;
        };
      };
    };
  };

  assert.equal(body.result.structuredContent.localWrapperStatus?.harnessId, "codex");
  assert.equal(body.result.structuredContent.localWrapperStatus?.status, "stale");
  assert.equal(body.result.structuredContent.localWrapperStatus?.warning, true);
  assert.equal(body.result.structuredContent.localWrapperStatus?.localBundleVersion, "0.1.0");
  assert.equal(body.result.structuredContent.localWrapperStatus?.expectedBundleVersion, "0.2.9");
  assert.equal(body.result.structuredContent.localWrapperStatus?.updateMode, "unknown");
  assert.match(body.result.structuredContent.summary, /Codex reported local bundle version 0.1.0/i);
});

test("oauth metadata, registration, authorization, and token exchange work for remote MCP", async (t) => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);

  // RFC 9728 protected-resource metadata. The path-suffix variant identifies the /mcp
  // resource; the bare well-known path covers the origin root. Both are served by the
  // Cloudflare Workers OAuth Provider.
  const prmResponse = await fetchApp("GET", "/.well-known/oauth-protected-resource/mcp", env);
  assert.equal(prmResponse.status, 200);
  const prm = await prmResponse.json() as { authorization_servers: string[]; resource: string };
  assert.deepEqual(prm.authorization_servers, ["https://deploy.example"]);
  assert.equal(prm.resource, "https://deploy.example/mcp");

  const rootPrmResponse = await fetchApp("GET", "/.well-known/oauth-protected-resource", env);
  assert.equal(rootPrmResponse.status, 200);
  const rootPrm = await rootPrmResponse.json() as { resource: string };
  assert.equal(rootPrm.resource, "https://deploy.example");

  // RFC 8414 authorization-server metadata.
  const metadataResponse = await fetchApp("GET", "/.well-known/oauth-authorization-server", env);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json() as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    grant_types_supported: string[];
  };
  assert.equal(metadata.issuer, "https://deploy.example");
  assert.equal(metadata.authorization_endpoint, "https://deploy.example/api/oauth/authorize");
  assert.equal(metadata.token_endpoint, "https://deploy.example/oauth/token");
  assert.equal(metadata.registration_endpoint, "https://deploy.example/oauth/register");
  assert.ok(metadata.grant_types_supported.includes("authorization_code"));
  assert.ok(metadata.grant_types_supported.includes("refresh_token"));

  // Dynamic client registration (RFC 7591).
  const registerResponse = await fetchApp("POST", "/oauth/register", env, {
    client_name: "Gemini CLI",
    redirect_uris: ["http://127.0.0.1:43123/callback"],
    token_endpoint_auth_method: "none"
  });
  assert.equal(registerResponse.status, 201);
  const client = await registerResponse.json() as {
    client_id: string;
    redirect_uris: string[];
    token_endpoint_auth_method: string;
  };
  assert.ok(client.client_id);
  assert.deepEqual(client.redirect_uris, ["http://127.0.0.1:43123/callback"]);
  assert.equal(client.token_endpoint_auth_method, "none");

  // Authorize flow: the Hono endpoint requires a Cloudflare Access JWT, then hands the
  // identity to the provider via completeAuthorization, which returns a loopback URL the
  // continue page redirects to.
  const codeVerifier = "test-code-verifier-123456789abcdef";
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
  assert.match(authorizeHtml, /Return [Tt]o (your agent|Gemini CLI)/);
  const callbackMatch = authorizeHtml.match(/const callbackUrl = "([^"]+)";/);
  assert.ok(callbackMatch);
  const redirect = new URL(JSON.parse(`"${callbackMatch?.[1] ?? ""}"`));
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  assert.equal(redirect.searchParams.get("state"), "test-state");

  // Token exchange (provider-implemented).
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
    refresh_token?: string;
    scope: string;
  };
  assert.equal(tokenBody.token_type, "bearer");
  assert.equal(tokenBody.scope, "cail:deploy");
  assert.ok(tokenBody.access_token);
  assert.ok(tokenBody.refresh_token);

  // Refresh exchange rotates the refresh token (one-shot use).
  const refreshResponse = await fetchRaw(
    new Request("https://deploy.example/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: tokenBody.refresh_token ?? ""
      }).toString()
    }),
    env
  );
  assert.equal(refreshResponse.status, 200);
  const refreshBody = await refreshResponse.json() as {
    access_token: string;
    refresh_token?: string;
    token_type: string;
  };
  assert.equal(refreshBody.token_type, "bearer");
  assert.ok(refreshBody.access_token);
});

test("mcp validate_project returns structured install guidance instead of a protocol error", async (t) => {
  const { env } = createTestContext({
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

test("mcp delete project returns a clear GitHub connect handoff when repo-admin auth is missing", async () => {
  const { env, db } = createTestContext({
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
      id: 5,
      method: "tools/call",
      params: {
        name: "delete_project",
        arguments: {
          projectName: "cail-assets-build-test",
          confirmProjectName: "cail-assets-build-test"
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
