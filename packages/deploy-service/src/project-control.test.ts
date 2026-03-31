import assert from "node:assert/strict";
import test from "node:test";

import {
  createAccessJwt,
  createTestContext,
  fetchApp,
  fetchRaw,
  installAccessFetchMock,
  sealStoredValueForTest,
  TEST_ACCESS_PRIVATE_KEY,
  jsonResponse
} from "./test-support";
import { encryptStoredText } from "./lib/sealed-data";

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
  assert.match(html, /Return to Kale Deploy/);
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
