import assert from "node:assert/strict";
import test from "node:test";

import {
  createAccessJwt,
  createTestContext,
  fetchApp,
  fetchRaw,
  installAccessFetchMock,
  issueTestMcpAccessToken,
  issueTestMcpPatToken,
  sealStoredValueForTest,
  TEST_ACCESS_PRIVATE_KEY,
  jsonResponse
} from "./test-support";
import { encryptStoredText } from "./lib/sealed-data";
import { resumePendingProjectDeletionBacklogs } from "./project-delete";

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
  assert.match(callbackHtml, /GitHub connected/);
  assert.match(callbackHtml, /Signed in as/);
  assert.match(callbackHtml, /Back to Kale Deploy/);
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
  const startResponse = await fetchRaw(new Request("https://deploy.example/api/github/user-auth/start?repositoryFullName=szweibel/cail-assets-build-test&projectName=cail-assets-build-test&returnTo=https%3A%2F%2Fdeploy.example%2Fprojects%2Fcail-assets-build-test%2Fcontrol", {
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
    "https://deploy.example/api/github/user-auth/start?projectName=cail-assets-build-test&returnTo=https%3A%2F%2Fdeploy.example%2Fapi%2Fprojects%2Fcail-assets-build-test%2Fsecrets"
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
    "https://deploy.example/api/github/user-auth/start?projectName=does-not-exist&returnTo=https%3A%2F%2Fdeploy.example%2Fapi%2Fprojects%2Fdoes-not-exist%2Fsecrets"
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

test("project secrets reject values above the live Worker secret limit", async (t) => {
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
    latestDeploymentId: undefined,
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
          admin: true,
          maintain: true,
          push: true,
          pull: true
        }
      });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const response = await fetchApp(
    "PUT",
    "/api/projects/cail-assets-build-test/secrets/OPENAI_API_KEY",
    env,
    { value: "x".repeat(5 * 1024 + 1) },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );

  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /5\.0 KB/i);
});

test("project secrets reject new secrets after the Worker secret cap is reached", async (t) => {
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
    latestDeploymentId: undefined,
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

  for (let index = 0; index < 120; index += 1) {
    const sealed = await encryptStoredText(
      env.CONTROL_PLANE_ENCRYPTION_KEY ?? "test-control-plane-encryption-key",
      `secret-${index}`
    );
    db.putProjectSecret({
      github_repo: "szweibel/cail-assets-build-test",
      project_name: "cail-assets-build-test",
      secret_name: `SECRET_${index}`,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      github_user_id: 9001,
      github_login: "szweibel",
      created_at: "2026-03-29T12:00:00.000Z",
      updated_at: "2026-03-29T12:00:00.000Z"
    });
  }

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
          admin: true,
          maintain: true,
          push: true,
          pull: true
        }
      });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const response = await fetchApp(
    "PUT",
    "/api/projects/cail-assets-build-test/secrets/ONE_TOO_MANY",
    env,
    { value: "still-ok" },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );

  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /at most 120 secrets/i);
});

test("project control panel shows the same browser-session message regardless of host when Access headers are missing", async () => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });

  const response = await fetchRaw(new Request("https://auth.example/projects/kale-cache-smoke-test/control"), env);
  assert.equal(response.status, 401);
  const html = await response.text();
  assert.match(html, /This page needs your CUNY browser session/i);
  assert.doesNotMatch(html, /Missing Cloudflare Access JWT assertion/i);
});

test("project admin entry shows a plain-language browser-session message when Access headers are missing", async () => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });

  const response = await fetchRaw(new Request("https://deploy.example/projects/control"), env);
  assert.equal(response.status, 401);
  const html = await response.text();
  assert.match(html, /This page needs your CUNY browser session/i);
  assert.doesNotMatch(html, /Missing Cloudflare Access JWT assertion/i);
});

test("project admin entry shows the same browser-session message regardless of host when Access headers are missing", async () => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });

  const response = await fetchRaw(new Request("https://auth.example/projects/control?repositoryFullName=szweibel%2Fkale-cache-smoke-test"), env);
  assert.equal(response.status, 401);
  const html = await response.text();
  assert.match(html, /This page needs your CUNY browser session/i);
  assert.doesNotMatch(html, /Missing Cloudflare Access JWT assertion/i);
});

test("project admin entry renders a private lookup page for signed-in users", async (t) => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@cuny.edu");

  const response = await fetchRaw(new Request("https://deploy.example/projects/control", {
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Project settings/);
  assert.match(html, /Project name/);
  assert.match(html, /GitHub repo/);
  assert.match(html, /Signed in as/);
});

test("project admin entry can open settings by project name or repo lookup", async (t) => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@cuny.edu");

  const byProject = await fetchRaw(new Request("https://deploy.example/projects/control?projectName=kale-cache-smoke-test", {
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);
  assert.equal(byProject.status, 302);
  assert.equal(byProject.headers.get("location"), "https://deploy.example/projects/kale-cache-smoke-test/control");

  const byRepo = await fetchRaw(new Request("https://deploy.example/projects/control?repositoryFullName=szweibel%2Fkale-cache-smoke-test", {
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);
  assert.equal(byRepo.status, 302);
  assert.equal(
    byRepo.headers.get("location"),
    "https://deploy.example/github/setup?repositoryFullName=szweibel%2Fkale-cache-smoke-test&projectName=kale-cache-smoke-test"
  );
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

  const response = await fetchRaw(new Request("https://deploy.example/projects/kale-cache-smoke-test/control", {
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
  assert.match(html, /Back to Kale Deploy/);
  assert.match(html, /returnTo=https%3A%2F%2Fdeploy\.example%2Fprojects%2Fkale-cache-smoke-test%2Fcontrol/);
});

test("project control panel does not reveal whether an unknown slug exists", async (t) => {
  const { env } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  installAccessFetchMock(t);
  const accessJwt = await createAccessJwt("person@cuny.edu");

  const response = await fetchRaw(new Request("https://deploy.example/projects/does-not-exist/control", {
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
  const pageResponse = await fetchRaw(new Request("https://deploy.example/projects/kale-cache-smoke-test/control", {
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.match(html, /Secrets/);
  assert.match(html, /OPENAI_API_KEY/);
  assert.doesNotMatch(html, /<h2>Domains<\/h2>/);

  const formTokenMatch = html.match(/name="formToken" value="([^"]+)"/);
  assert.ok(formTokenMatch);

  const form = new FormData();
  form.set("formToken", formTokenMatch?.[1] ?? "");
  form.set("secretName", "ANTHROPIC_API_KEY");
  form.set("secretValue", "sk-test-value");

  const saveResponse = await fetchRaw(new Request("https://deploy.example/projects/kale-cache-smoke-test/control/secrets", {
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

test("project control panel does not expose featured settings", async (t) => {
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

    if (url.origin === "https://api.github.com" && url.pathname === "/repos/szweibel/cloze-reader") {
      return jsonResponse({
        id: 7,
        name: "cloze-reader",
        full_name: "szweibel/cloze-reader",
        default_branch: "main",
        html_url: "https://github.com/szweibel/cloze-reader",
        clone_url: "https://github.com/szweibel/cloze-reader.git",
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
    projectName: "cloze-reader",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cloze-reader",
    description: "Practice reading with interactive cloze passages.",
    deploymentUrl: "https://cloze-reader.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-04-04T10:00:00.000Z",
    updatedAt: "2026-04-04T10:10:00.000Z"
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
    created_at: "2026-04-04T10:00:00.000Z",
    updated_at: "2026-04-04T10:00:00.000Z"
  });

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const pageResponse = await fetchRaw(new Request("https://deploy.example/projects/cloze-reader/control", {
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.doesNotMatch(html, /Featured project/);
  assert.doesNotMatch(html, /Show this project on the featured projects page/);
});

test("featured projects admin page can feature and unfeature a live project for an allowlisted editor", async (t) => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu",
    FEATURED_PROJECT_ADMIN_EMAILS: "person@cuny.edu"
  });
  installAccessFetchMock(t);
  db.putProject({
    projectName: "cloze-reader",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cloze-reader",
    description: "Practice reading with interactive cloze passages.",
    deploymentUrl: "https://cloze-reader.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-1",
    createdAt: "2026-04-04T10:00:00.000Z",
    updatedAt: "2026-04-04T10:10:00.000Z"
  });

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const pageResponse = await fetchRaw(new Request("https://deploy.example/featured/control", {
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.match(html, /Featured Projects Admin/);
  assert.match(html, /Show this project on the public featured page/);
  const formTokenMatch = html.match(/name="formToken" value="([^"]+)"/);
  assert.ok(formTokenMatch);

  const enableForm = new FormData();
  enableForm.set("formToken", formTokenMatch?.[1] ?? "");
  enableForm.set("projectName", "cloze-reader");
  enableForm.set("featureProject", "1");
  enableForm.set("featureHeadline", "A reading game for practicing comprehension.");
  enableForm.set("featureSortOrder", "2");

  const enableResponse = await fetchRaw(new Request("https://deploy.example/featured/control", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    },
    body: enableForm
  }), env);
  assert.equal(enableResponse.status, 302);
  assert.match(enableResponse.headers.get("location") ?? "", /flash=success/);
  const featured = db.selectFeaturedProject("szweibel/cloze-reader") as {
    github_repo: string;
    project_name: string;
    headline: string | null;
    sort_order: number;
    created_at: string;
    updated_at: string;
  } | null;
  assert.ok(featured);
  assert.equal(featured?.github_repo, "szweibel/cloze-reader");
  assert.equal(featured?.project_name, "cloze-reader");
  assert.equal(featured?.headline, "A reading game for practicing comprehension.");
  assert.equal(featured?.sort_order, 2);
  assert.equal(typeof featured?.created_at, "string");
  assert.equal(typeof featured?.updated_at, "string");

  const disableForm = new FormData();
  disableForm.set("formToken", formTokenMatch?.[1] ?? "");
  disableForm.set("projectName", "cloze-reader");
  disableForm.set("featureHeadline", "");
  disableForm.set("featureSortOrder", "100");

  const disableResponse = await fetchRaw(new Request("https://deploy.example/featured/control", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    },
    body: disableForm
  }), env);
  assert.equal(disableResponse.status, 302);
  assert.equal(db.selectFeaturedProject("szweibel/cloze-reader"), null);
});

test("featured projects admin page rejects signed-in users who are not editors", async (t) => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu",
    FEATURED_PROJECT_ADMIN_EMAILS: "editor@cuny.edu"
  });
  installAccessFetchMock(t);
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

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const response = await fetchRaw(new Request("https://deploy.example/featured/control", {
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);
  assert.equal(response.status, 403);
  const html = await response.text();
  assert.match(html, /only available to Kale editors/i);
});

test("featured projects admin page dedupes multiple live slugs for the same repository", async (t) => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu",
    FEATURED_PROJECT_ADMIN_EMAILS: "person@cuny.edu"
  });
  installAccessFetchMock(t);
  db.putProject({
    projectName: "old-cloze-reader",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cloze-reader",
    description: "Old live slug that should not get its own featured card.",
    deploymentUrl: "https://old-cloze-reader.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-old",
    createdAt: "2026-04-03T10:00:00.000Z",
    updatedAt: "2026-04-03T10:10:00.000Z"
  });
  db.putProject({
    projectName: "cloze-reader",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cloze-reader",
    description: "Current live slug that should drive the featured card.",
    deploymentUrl: "https://cloze-reader.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-new",
    createdAt: "2026-04-04T10:00:00.000Z",
    updatedAt: "2026-04-04T10:10:00.000Z"
  });
  db.putFeaturedProject({
    github_repo: "szweibel/cloze-reader",
    project_name: "cloze-reader",
    headline: "Current featured headline.",
    sort_order: 3,
    created_at: "2026-04-04T10:00:00.000Z",
    updated_at: "2026-04-04T10:10:00.000Z"
  });

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const response = await fetchRaw(new Request("https://deploy.example/featured/control", {
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal((html.match(/name="projectName" value="cloze-reader"/g) ?? []).length, 1);
  assert.equal((html.match(/name="projectName" value="old-cloze-reader"/g) ?? []).length, 0);
  assert.match(html, /Current featured headline\./);
});

test("admin overview API returns structured auth bootstrap metadata when no MCP token is present", async () => {
  const { env } = createTestContext({
    KALE_ADMIN_EMAILS: "person@cuny.edu"
  });

  const response = await fetchApp("GET", "/api/admin/overview", env);

  assert.equal(response.status, 401);
  const body = await response.json() as {
    error: string;
    summary: string;
    nextAction: string;
    mcpEndpoint: string;
    oauthProtectedResourceMetadata: string;
    oauthAuthorizationMetadata: string;
    authorizationUrl: string;
  };
  assert.match(body.error, /missing bearer token/i);
  assert.equal(body.nextAction, "complete_browser_login");
  assert.match(body.summary, /not authenticated yet/i);
  assert.equal(body.mcpEndpoint, "https://deploy.example/mcp");
  assert.equal(body.oauthProtectedResourceMetadata, "https://deploy.example/.well-known/oauth-protected-resource/mcp");
  assert.equal(body.oauthAuthorizationMetadata, "https://auth.example/.well-known/oauth-authorization-server");
  assert.equal(body.authorizationUrl, "https://deploy.example/api/oauth/authorize");
});

test("admin overview API does not treat featured editors as full Kale admins", async () => {
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
  const response = await fetchApp(
    "GET",
    "/api/admin/overview",
    env,
    undefined,
    {
      authorization: `Bearer ${accessToken}`
    }
  );

  assert.equal(response.status, 503);
  const body = await response.json() as { error: string };
  assert.match(body.error, /not configured on this deployment/i);
});

test("admin overview API returns deduped live repositories and pending deletion cleanup for Kale admins", async () => {
  const { env, db } = createTestContext({
    KALE_ADMIN_EMAILS: "person@cuny.edu"
  });
  db.putProject({
    projectName: "old-cloze-reader",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cloze-reader",
    deploymentUrl: "https://old-cloze-reader.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-old",
    createdAt: "2026-04-03T10:00:00.000Z",
    updatedAt: "2026-04-03T10:10:00.000Z"
  });
  db.putProject({
    projectName: "cloze-reader",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cloze-reader",
    description: "Current live slug.",
    deploymentUrl: "https://cloze-reader.cuny.qzz.io",
    hasAssets: false,
    latestDeploymentId: "dep-new",
    createdAt: "2026-04-04T10:00:00.000Z",
    updatedAt: "2026-04-04T10:10:00.000Z"
  });
  db.putFeaturedProject({
    github_repo: "szweibel/cloze-reader",
    project_name: "cloze-reader",
    headline: "Featured current slug.",
    sort_order: 4,
    created_at: "2026-04-04T10:00:00.000Z",
    updated_at: "2026-04-04T10:10:00.000Z"
  });
  db.putProjectDeletionBacklog({
    github_repo: "szweibel/kale-files-smoke-test",
    project_name: "kale-files-smoke-test",
    requested_at: "2026-04-04T09:00:00.000Z",
    updated_at: "2026-04-04T09:15:00.000Z",
    worker_script_names_json: JSON.stringify(["kale-files-smoke-test"]),
    database_ids_json: JSON.stringify([]),
    files_bucket_names_json: JSON.stringify(["files-kale-files-smoke-test"]),
    cache_namespace_ids_json: JSON.stringify([]),
    artifact_prefixes_json: JSON.stringify([]),
    last_error: "Timed out deleting files bucket."
  });

  const accessToken = await issueTestMcpAccessToken(env, "person@cuny.edu");
  const response = await fetchApp(
    "GET",
    "/api/admin/overview",
    env,
    undefined,
    {
      authorization: `Bearer ${accessToken}`
    }
  );

  assert.equal(response.status, 200);
  const body = await response.json() as {
    projectCount: number;
    featuredProjectCount: number;
    deletionBacklogCount: number;
    projects: Array<{ projectName: string; githubRepo: string; featured: { enabled: boolean; sortOrder: number } }>;
    deletionBacklogs: Array<{ githubRepo: string; projectName: string; lastError?: string }>;
  };
  assert.equal(body.projectCount, 1);
  assert.equal(body.featuredProjectCount, 1);
  assert.equal(body.deletionBacklogCount, 1);
  assert.deepEqual(body.projects.map((project) => project.projectName), ["cloze-reader"]);
  assert.deepEqual(body.projects.map((project) => project.githubRepo), ["szweibel/cloze-reader"]);
  assert.equal(body.projects[0]?.featured.enabled, true);
  assert.equal(body.projects[0]?.featured.sortOrder, 4);
  assert.equal(body.deletionBacklogs[0]?.githubRepo, "szweibel/kale-files-smoke-test");
  assert.match(body.deletionBacklogs[0]?.lastError ?? "", /files bucket/i);
});

test("admin featured update rejects malformed JSON without changing featured state", async () => {
  const { env, db } = createTestContext({
    KALE_ADMIN_EMAILS: "person@cuny.edu"
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
  const response = await fetchRaw(new Request("https://deploy.example/api/admin/projects/cloze-reader/featured", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: "{"
  }), env);

  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /valid JSON body/i);
  assert.equal(db.selectFeaturedProject("szweibel/cloze-reader"), null);
});

test("admin overview API rejects PAT tokens even for allowlisted admins", async () => {
  const { env, db } = createTestContext({
    KALE_ADMIN_EMAILS: "person@cuny.edu"
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

  const token = await issueTestMcpPatToken(db, "person@cuny.edu");
  const response = await fetchApp(
    "GET",
    "/api/admin/overview",
    env,
    undefined,
    {
      authorization: `Bearer ${token}`
    }
  );

  assert.equal(response.status, 403);
  const body = await response.json() as { error: string };
  assert.match(body.error, /require a short-lived MCP OAuth session/i);
});

test("project deletion API removes the Kale project and its managed resources without touching GitHub", async (t) => {
  const { env, db, archive } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu",
    CLOUDFLARE_R2_ACCESS_KEY_ID: "r2-access-key",
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: "r2-secret-key"
  });
  db.putProject({
    projectName: "cail-assets-build-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    deploymentUrl: "https://cail-assets-build-test.cuny.qzz.io",
    databaseId: "db-123",
    filesBucketName: "files-cail-assets-build-test",
    cacheNamespaceId: "kv-123",
    runtimeLane: "dedicated_worker",
    hasAssets: true,
    latestDeploymentId: "dep-1",
    createdAt: "2026-03-29T12:00:00.000Z",
    updatedAt: "2026-03-29T12:05:00.000Z"
  });
  db.putProject({
    projectName: "cail-assets-build-test-old",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    deploymentUrl: "https://cail-assets-build-test-old.cuny.qzz.io",
    runtimeLane: "dedicated_worker",
    hasAssets: true,
    latestDeploymentId: "dep-old",
    createdAt: "2026-03-28T12:00:00.000Z",
    updatedAt: "2026-03-28T12:05:00.000Z"
  });
  db.putDeployment({
    deploymentId: "dep-1",
    projectName: "cail-assets-build-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    status: "success",
    deploymentUrl: "https://cail-assets-build-test.cuny.qzz.io",
    artifactPrefix: "deployments/cail-assets-build-test/dep-1",
    archiveKind: "full",
    manifestKey: "deployments/cail-assets-build-test/dep-1/manifest.json",
    runtimeLane: "dedicated_worker",
    recommendedRuntimeLane: "dedicated_worker",
    hasAssets: true,
    createdAt: "2026-03-29T12:05:00.000Z"
  });
  db.putDeployment({
    deploymentId: "dep-old",
    projectName: "cail-assets-build-test-old",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/cail-assets-build-test",
    status: "success",
    deploymentUrl: "https://cail-assets-build-test-old.cuny.qzz.io",
    artifactPrefix: "deployments/cail-assets-build-test-old/dep-old",
    archiveKind: "full",
    manifestKey: "deployments/cail-assets-build-test-old/dep-old/manifest.json",
    runtimeLane: "dedicated_worker",
    recommendedRuntimeLane: "dedicated_worker",
    hasAssets: true,
    createdAt: "2026-03-28T12:05:00.000Z"
  });
  db.putProjectDomain({
    domain_label: "cail-assets-build-test",
    project_name: "cail-assets-build-test",
    github_repo: "szweibel/cail-assets-build-test",
    is_primary: 1,
    created_at: "2026-03-29T12:00:00.000Z",
    updated_at: "2026-03-29T12:05:00.000Z"
  });
  db.putProjectDomain({
    domain_label: "cail-assets-build-test-history",
    project_name: "cail-assets-build-test",
    github_repo: "szweibel/cail-assets-build-test",
    is_primary: 0,
    created_at: "2026-03-29T12:00:00.000Z",
    updated_at: "2026-03-29T12:05:00.000Z"
  });
  db.putProjectDomain({
    domain_label: "cail-assets-build-test-old",
    project_name: "cail-assets-build-test-old",
    github_repo: "szweibel/cail-assets-build-test",
    is_primary: 1,
    created_at: "2026-03-28T12:00:00.000Z",
    updated_at: "2026-03-28T12:05:00.000Z"
  });
  db.putProjectSecret({
    github_repo: "szweibel/cail-assets-build-test",
    project_name: "cail-assets-build-test",
    secret_name: "OPENAI_API_KEY",
    ciphertext: "ciphertext",
    iv: "iv",
    github_user_id: 9001,
    github_login: "szweibel",
    created_at: "2026-03-29T12:00:00.000Z",
    updated_at: "2026-03-29T12:00:00.000Z"
  });
  db.putProjectSecret({
    github_repo: "szweibel/cail-assets-build-test",
    project_name: "cail-assets-build-test-old",
    secret_name: "ANTHROPIC_API_KEY",
    ciphertext: "ciphertext-old",
    iv: "iv-old",
    github_user_id: 9001,
    github_login: "szweibel",
    created_at: "2026-03-28T12:00:00.000Z",
    updated_at: "2026-03-28T12:00:00.000Z"
  });
  db.putProjectPolicy({
    githubRepo: "szweibel/cail-assets-build-test",
    projectName: "cail-assets-build-test-old",
    aiEnabled: false,
    vectorizeEnabled: false,
    roomsEnabled: false,
    maxValidationsPerDay: 5,
    maxDeploymentsPerDay: 5,
    maxConcurrentBuilds: 1,
    maxAssetBytes: 90 * 1024 * 1024,
    createdAt: "2026-03-28T12:00:00.000Z",
    updatedAt: "2026-03-28T12:00:00.000Z"
  });
  db.putFeaturedProject({
    github_repo: "szweibel/cail-assets-build-test",
    project_name: "cail-assets-build-test",
    headline: "A featured smoke test.",
    sort_order: 10,
    created_at: "2026-03-29T12:00:00.000Z",
    updated_at: "2026-03-29T12:00:00.000Z"
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
  await archive.put("deployments/cail-assets-build-test/dep-1/manifest.json", "{}");
  await archive.put("deployments/cail-assets-build-test/dep-1/assets/index.html", "<h1>Hello</h1>");
  await archive.put("deployments/cail-assets-build-test-old/dep-old/manifest.json", "{}");
  await archive.put("deployments/cail-assets-build-test-old/dep-old/assets/index.html", "<h1>Old</h1>");

  const requests: string[] = [];
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
          admin: true,
          maintain: true,
          push: true,
          pull: true
        }
      });
    }

    if (url.origin === "https://account-123.r2.cloudflarestorage.com"
      && url.pathname === "/files-cail-assets-build-test"
      && url.searchParams.get("list-type") === "2") {
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      return new Response(
        "<ListBucketResult><Name>files-cail-assets-build-test</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>",
        {
          headers: { "content-type": "application/xml" }
        }
      );
    }

    if (url.origin === "https://api.cloudflare.com" && url.pathname === "/client/v4/user/tokens/verify") {
      throw new Error("Delete flow should not verify the Cloudflare API token when explicit R2 credentials are configured.");
    }

    if (url.origin === "https://api.cloudflare.com") {
      requests.push(`${request.method} ${url.pathname}`);
      return jsonResponse({ success: true, errors: [], result: {} });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const response = await fetchApp(
    "DELETE",
    "/api/projects/cail-assets-build-test",
    env,
    { confirmProjectName: "cail-assets-build-test" },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );

  assert.equal(response.status, 200);
  const body = await response.json() as {
    deletedFromKaleOnly: boolean;
    githubRepositoryUnaffected: boolean;
    summary: string;
    deleted: {
      deploymentRecords: number;
      archivedDeployments: number;
      domainLabels: number;
      workerScriptCleanedUp: boolean;
      databaseCleanedUp: boolean;
      filesBucketCleanedUp: boolean;
      cacheNamespaceCleanedUp: boolean;
    };
  };
  assert.equal(body.deletedFromKaleOnly, true);
  assert.equal(body.githubRepositoryUnaffected, true);
  assert.equal(body.deleted.deploymentRecords, 2);
  assert.equal(body.deleted.archivedDeployments, 2);
  assert.equal(body.deleted.domainLabels, 3);
  assert.equal(body.deleted.workerScriptCleanedUp, true);
  assert.equal(body.deleted.databaseCleanedUp, true);
  assert.equal(body.deleted.filesBucketCleanedUp, true);
  assert.equal(body.deleted.cacheNamespaceCleanedUp, true);
  assert.match(body.summary, /GitHub repo szweibel\/cail-assets-build-test was not changed/i);

  assert.equal(db.selectProject("cail-assets-build-test"), null);
  assert.equal(db.selectProject("cail-assets-build-test-old"), null);
  assert.equal(db.selectProjectSecret("szweibel/cail-assets-build-test", "OPENAI_API_KEY"), null);
  assert.equal(db.selectProjectSecret("szweibel/cail-assets-build-test", "ANTHROPIC_API_KEY"), null);
  assert.equal(db.selectProjectDomain("cail-assets-build-test"), null);
  assert.equal(db.selectProjectDomain("cail-assets-build-test-history"), null);
  assert.equal(db.selectProjectDomain("cail-assets-build-test-old"), null);
  assert.equal(db.selectProjectPolicy("szweibel/cail-assets-build-test"), null);
  assert.equal(db.selectFeaturedProject("szweibel/cail-assets-build-test"), null);
  assert.deepEqual(db.listDeployments("cail-assets-build-test"), []);
  assert.deepEqual(db.listDeployments("cail-assets-build-test-old"), []);
  assert.equal(archive.readText("deployments/cail-assets-build-test/dep-1/manifest.json"), null);
  assert.equal(archive.readText("deployments/cail-assets-build-test/dep-1/assets/index.html"), null);
  assert.equal(archive.readText("deployments/cail-assets-build-test-old/dep-old/manifest.json"), null);
  assert.equal(archive.readText("deployments/cail-assets-build-test-old/dep-old/assets/index.html"), null);
  assert.deepEqual([...requests].sort(), [
    "GET /files-cail-assets-build-test?list-type=2&max-keys=1000",
    "DELETE /client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/cail-assets-build-test",
    "DELETE /client/v4/accounts/account-123/workers/dispatch/namespaces/cail-production/scripts/cail-assets-build-test-old",
    "DELETE /client/v4/accounts/account-123/d1/database/db-123",
    "DELETE /client/v4/accounts/account-123/r2/buckets/files-cail-assets-build-test",
    "DELETE /client/v4/accounts/account-123/storage/kv/namespaces/kv-123"
  ].sort());
});

test("project deletion keeps retryable cleanup in the backlog after unpublishing the site", async (t) => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  db.putProject({
    projectName: "delete-failure-smoke-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/delete-failure-smoke-test",
    deploymentUrl: "https://delete-failure-smoke-test.cuny.qzz.io",
    databaseId: "db-fail",
    runtimeLane: "dedicated_worker",
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
  let allowDatabaseDelete = false;
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

    if (url.origin === "https://api.github.com" && url.pathname === "/repos/szweibel/delete-failure-smoke-test") {
      return jsonResponse({
        id: 7,
        name: "delete-failure-smoke-test",
        full_name: "szweibel/delete-failure-smoke-test",
        default_branch: "main",
        html_url: "https://github.com/szweibel/delete-failure-smoke-test",
        clone_url: "https://github.com/szweibel/delete-failure-smoke-test.git",
        private: false,
        owner: { login: "szweibel" },
        permissions: {
          admin: true,
          maintain: true,
          push: true,
          pull: true
        }
      });
    }

    if (url.origin === "https://api.cloudflare.com" && url.pathname.endsWith("/scripts/delete-failure-smoke-test")) {
      return jsonResponse({ success: true, errors: [], result: {} });
    }

    if (url.origin === "https://api.cloudflare.com" && url.pathname.endsWith("/d1/database/db-fail")) {
      if (allowDatabaseDelete) {
        return jsonResponse({ success: true, errors: [], result: {} });
      }
      return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "boom" }] }), { status: 500 });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const response = await fetchApp(
    "DELETE",
    "/api/projects/delete-failure-smoke-test",
    env,
    { confirmProjectName: "delete-failure-smoke-test" },
    {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  );

  assert.equal(response.status, 200);
  const body = await response.json() as {
    summary: string;
    cleanupPending?: {
      databases: number;
      summary: string;
    };
  };
  assert.match(body.summary, /keep retrying/i);
  assert.equal(body.cleanupPending?.databases, 1);

  const storedProject = db.selectProject("delete-failure-smoke-test") as {
    latest_deployment_id: string | null;
  } | null;
  assert.equal(storedProject?.latest_deployment_id, null);
  assert.ok(db.selectProjectDeletionBacklog("szweibel/delete-failure-smoke-test"));

  allowDatabaseDelete = true;
  await resumePendingProjectDeletionBacklogs(env, {
    resolveRequiredCloudflareApiToken: (deleteEnv) => deleteEnv.CLOUDFLARE_API_TOKEN ?? ""
  });
  assert.equal(db.selectProject("delete-failure-smoke-test"), null);
  assert.equal(db.selectProjectDeletionBacklog("szweibel/delete-failure-smoke-test"), null);
});

test("project settings delete form requires typed confirmation and redirects back to the lookup page after success", async (t) => {
  const { env, db } = createTestContext({
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://access.example",
    CLOUDFLARE_ACCESS_AUD: "test-access-aud",
    CLOUDFLARE_ACCESS_ALLOWED_EMAIL_DOMAINS: "cuny.edu"
  });
  db.putProject({
    projectName: "kale-delete-smoke-test",
    ownerLogin: "szweibel",
    githubRepo: "szweibel/kale-delete-smoke-test",
    deploymentUrl: "https://kale-delete-smoke-test.cuny.qzz.io",
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

    if (url.origin === "https://api.github.com" && url.pathname === "/repos/szweibel/kale-delete-smoke-test") {
      return jsonResponse({
        id: 7,
        name: "kale-delete-smoke-test",
        full_name: "szweibel/kale-delete-smoke-test",
        default_branch: "main",
        html_url: "https://github.com/szweibel/kale-delete-smoke-test",
        clone_url: "https://github.com/szweibel/kale-delete-smoke-test.git",
        private: false,
        owner: { login: "szweibel" },
        permissions: {
          admin: true,
          maintain: true,
          push: true,
          pull: true
        }
      });
    }

    if (url.origin === "https://api.cloudflare.com" && url.pathname.endsWith("/scripts/kale-delete-smoke-test")) {
      return jsonResponse({ success: true, errors: [], result: {} });
    }

    throw new Error(`Unexpected fetch during test: ${request.method} ${request.url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const accessJwt = await createAccessJwt("person@cuny.edu");
  const pageResponse = await fetchRaw(new Request("https://deploy.example/projects/kale-delete-smoke-test/control", {
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    }
  }), env);
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.match(html, /Delete project/);
  assert.match(html, /This does not delete the GitHub repository/i);

  const formTokenMatch = html.match(/name="formToken" value="([^"]+)"/);
  assert.ok(formTokenMatch);

  const form = new FormData();
  form.set("formToken", formTokenMatch?.[1] ?? "");
  form.set("confirmProjectName", "kale-delete-smoke-test");

  const deleteResponse = await fetchRaw(new Request("https://deploy.example/projects/kale-delete-smoke-test/control/delete", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": accessJwt,
      "cf-access-authenticated-user-email": "person@cuny.edu"
    },
    body: form
  }), env);

  assert.equal(deleteResponse.status, 302);
  assert.match(deleteResponse.headers.get("location") ?? "", /^https:\/\/deploy\.example\/projects\/control\?flash=success&message=/);
  assert.equal(db.selectProject("kale-delete-smoke-test"), null);
});
