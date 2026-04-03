import assert from "node:assert/strict";
import test from "node:test";

import projectHostProxy from "./index";

const env = {
  INTERNAL_GATEWAY_BASE_URL: "https://gateway.internal",
  INTERNAL_DEPLOY_SERVICE_URL: "https://deploy.internal",
  DEPLOY_SERVICE_PATH_PREFIX: "/kale",
  PROJECT_HOST_SUFFIX: "cuny.qzz.io",
  RUNTIME_MANIFEST_HOST: "runtime.cuny.qzz.io",
  RUNTIME_MANIFEST_URL: "https://deploy.internal/.well-known/kale-runtime.json"
};

test("root OAuth authorization metadata alias proxies to deploy-service", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json"
      }
    });
  };

  try {
    const response = await projectHostProxy.fetch(
      new Request("https://cuny.qzz.io/.well-known/oauth-authorization-server/kale"),
      env
    );

    assert.equal(response.status, 200);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://deploy.internal/.well-known/oauth-authorization-server");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("root OpenID configuration alias proxies to deploy-service", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json"
      }
    });
  };

  try {
    const response = await projectHostProxy.fetch(
      new Request("https://cuny.qzz.io/.well-known/openid-configuration/kale"),
      env
    );

    assert.equal(response.status, 200);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://deploy.internal/.well-known/openid-configuration");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("root protected-resource alias proxies to deploy-service", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json"
      }
    });
  };

  try {
    const response = await projectHostProxy.fetch(
      new Request("https://cuny.qzz.io/.well-known/oauth-protected-resource/kale/mcp"),
      env
    );

    assert.equal(response.status, 200);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://deploy.internal/.well-known/oauth-protected-resource/mcp");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
