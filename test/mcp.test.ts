import { afterEach, describe, expect, test } from "bun:test";
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk-legacy/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk-legacy/client/streamableHttp.js";
import { handleMcpWithPrincipal } from "../src/adapters/cloudflare/mcp";
import type { Principal } from "../src/auth";
import type { Env } from "../src/env";
import { MAX_ARTIFACT_BASE64_CHARS, MAX_MCP_BODY_BYTES } from "../src/mcp";

const requestId = "11111111-1111-4111-8111-111111111111";
const principal: Principal = {
  subject: "cail-0123456789abcdef0123456789abcdef",
  authentication: "cail-identity-jwt",
};

const clients: Client[] = [];
const modernClients: ModernClient[] = [];

afterEach(async () => {
  await Promise.all([
    ...clients.splice(0).map((client) => client.close()),
    ...modernClients.splice(0).map((client) => client.close()),
  ]);
});

async function standardClientAgainst(env: Env): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("https://deploy.invalid/mcp"), {
    fetch: async (input, init) =>
      handleMcpWithPrincipal(new Request(input, init), env, requestId, principal),
  });
  const client = new Client({
    name: "kale-mcp-argument-regression",
    version: "0.1.0",
  });
  clients.push(client);
  await client.connect(transport);
  return client;
}

async function modernClientAgainst(env: Env): Promise<ModernClient> {
  const transport = new ModernStreamableHTTPClientTransport(new URL("https://deploy.invalid/mcp"), {
    fetch: async (input, init) =>
      handleMcpWithPrincipal(new Request(input, init), env, requestId, principal),
  });
  const client = new ModernClient(
    {
      name: "kale-mcp-modern-regression",
      version: "0.1.0",
    },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  modernClients.push(client);
  await client.connect(transport);
  return client;
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected MCP text content.");
  return content.text;
}

function modernRequest(
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://deploy.invalid/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "modern-regression",
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "kale-mcp-modern-regression",
            version: "0.1.0",
          },
        },
      },
    }),
  });
}

describe("MCP tool argument boundary", () => {
  test("serves the stateless 2026-07-28 protocol with the frozen tool surface", async () => {
    const client = await modernClientAgainst({} as Env);

    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect((await client.listTools()).tools).toEqual([
      {
        name: "kale.create_project",
        description: "Kale release operation kale.create_project.",
        inputSchema: {
          type: "object",
          required: ["name", "idempotencyKey"],
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            idempotencyKey: { type: "string" },
          },
        },
      },
      {
        name: "kale.upload_revision",
        description: "Kale release operation kale.upload_revision.",
        inputSchema: {
          type: "object",
          required: ["projectId", "artifactBase64", "contentDigest"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string" },
            artifactBase64: { type: "string" },
            contentDigest: { type: "string" },
          },
        },
      },
      {
        name: "kale.create_release",
        description: "Kale release operation kale.create_release.",
        inputSchema: {
          type: "object",
          required: ["projectId", "revisionId", "target", "approval", "idempotencyKey"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string" },
            revisionId: { type: "string" },
            target: { type: "string" },
            approval: { type: "string" },
            idempotencyKey: { type: "string" },
          },
        },
      },
      {
        name: "kale.get_release",
        description: "Kale release operation kale.get_release.",
        inputSchema: {
          type: "object",
          required: ["projectId", "releaseId"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string" },
            releaseId: { type: "string" },
          },
        },
      },
      {
        name: "kale.approve_release",
        description: "Kale release operation kale.approve_release.",
        inputSchema: {
          type: "object",
          required: ["projectId", "releaseId", "idempotencyKey"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string" },
            releaseId: { type: "string" },
            idempotencyKey: { type: "string" },
          },
        },
      },
      {
        name: "kale.rollback_release",
        description: "Kale release operation kale.rollback_release.",
        inputSchema: {
          type: "object",
          required: ["projectId", "releaseId", "approval", "idempotencyKey"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string" },
            releaseId: { type: "string" },
            approval: { type: "string" },
            idempotencyKey: { type: "string" },
          },
        },
      },
    ]);

    const invalid = await client.callTool({
      name: "kale.create_project",
      arguments: { name: 42, idempotencyKey: "modern-invalid" },
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.parse(toolText(invalid))).toEqual({
      error: {
        code: "invalid_mcp_arguments",
        message: "The MCP tool arguments do not match the tool contract.",
        requestId,
      },
    });
  });

  test("accepts same-origin modern requests and rejects hostile boundary claims", async () => {
    let envReads = 0;
    const env = new Proxy({} as Env, {
      get() {
        envReads += 1;
        throw new Error("The API handler must not run for rejected modern requests.");
      },
    });

    const sameOrigin = await handleMcpWithPrincipal(
      modernRequest(
        "server/discover",
        {},
        {
          Host: "deploy.invalid",
          Origin: "https://deploy.invalid",
        },
      ),
      env,
      requestId,
      principal,
    );
    expect(sameOrigin.status).toBe(200);

    for (const headers of [{ Host: "other.invalid" }, { Origin: "https://other.invalid" }]) {
      const response = await handleMcpWithPrincipal(
        modernRequest("server/discover", {}, headers),
        env,
        requestId,
        principal,
      );
      expect(response.status).toBe(403);
    }

    const mismatch = await handleMcpWithPrincipal(
      modernRequest("tools/list", {}, { "Mcp-Method": "tools/call" }),
      env,
      requestId,
      principal,
    );
    expect(mismatch.status).toBe(400);
    expect(envReads).toBe(0);
  });

  test("standard SDK calls keep invalid tool arguments inside correlated MCP errors", async () => {
    let envReads = 0;
    const env = new Proxy({} as Env, {
      get() {
        envReads += 1;
        throw new Error("The API handler must not run for invalid arguments.");
      },
    });
    const client = await standardClientAgainst(env);
    const uploadBase = {
      projectId: "prj_22222222222222222222222222222222",
      contentDigest: "sha-256=:+3Ef2SMBqe9arjRcw9oGQI59KRuODN/x1ENMIW5FnoI=:",
    };

    for (const request of [
      { name: "kale.create_project", arguments: { idempotencyKey: "create-1" } },
      {
        name: "kale.create_project",
        arguments: { name: 42, idempotencyKey: "create-2" },
      },
      { name: "kale.upload_revision", arguments: uploadBase },
      {
        name: "kale.upload_revision",
        arguments: { ...uploadBase, artifactBase64: 42 },
      },
      {
        name: "kale.upload_revision",
        arguments: { ...uploadBase, artifactBase64: "%%%" },
      },
      {
        name: "kale.create_release",
        arguments: {
          projectId: "prj_22222222222222222222222222222222",
          revisionId: `rev_sha256_${"a".repeat(64)}`,
          target: "staging",
          approval: "automatic",
          idempotencyKey: "release-1",
        },
      },
      {
        name: "kale.get_release",
        arguments: { projectId: "prj_22222222222222222222222222222222" },
      },
      {
        name: "kale.approve_release",
        arguments: {
          projectId: "prj_22222222222222222222222222222222",
          releaseId: "rel_33333333333333333333333333333333",
          idempotencyKey: 42,
        },
      },
      {
        name: "kale.rollback_release",
        arguments: {
          projectId: "prj_22222222222222222222222222222222",
          releaseId: "rel_33333333333333333333333333333333",
          approval: "yes",
          idempotencyKey: "rollback-1",
        },
      },
      {
        name: "kale.create_project",
        arguments: {
          name: "Strict project",
          idempotencyKey: "strict-create",
          unexpected: true,
        },
      },
      {
        name: "kale.upload_revision",
        arguments: {
          ...uploadBase,
          artifactBase64: "e30=",
          unexpected: true,
        },
      },
      {
        name: "kale.create_release",
        arguments: {
          projectId: "prj_22222222222222222222222222222222",
          revisionId: `rev_sha256_${"a".repeat(64)}`,
          target: "staging",
          approval: "automatic",
          idempotencyKey: "strict-release",
          unexpected: true,
        },
      },
      {
        name: "kale.get_release",
        arguments: {
          projectId: "prj_22222222222222222222222222222222",
          releaseId: "rel_33333333333333333333333333333333",
          unexpected: true,
        },
      },
      {
        name: "kale.approve_release",
        arguments: {
          projectId: "prj_22222222222222222222222222222222",
          releaseId: "rel_33333333333333333333333333333333",
          idempotencyKey: "strict-approve",
          unexpected: true,
        },
      },
      {
        name: "kale.rollback_release",
        arguments: {
          projectId: "prj_22222222222222222222222222222222",
          releaseId: "rel_33333333333333333333333333333333",
          approval: "required",
          idempotencyKey: "strict-rollback",
          unexpected: true,
        },
      },
    ]) {
      const result = await client.callTool(request);
      expect(result.isError).toBe(true);
      const text = toolText(result);
      expect(JSON.parse(text)).toEqual({
        error: {
          code: "invalid_mcp_arguments",
          message: "The MCP tool arguments do not match the tool contract.",
          requestId,
        },
      });
    }

    expect(envReads).toBe(0);
  });

  test("rejects oversized artifactBase64 before decoding or API access", async () => {
    let envReads = 0;
    const env = new Proxy({} as Env, {
      get() {
        envReads += 1;
        throw new Error("The API handler must not run for oversized artifacts.");
      },
    });
    const originalAtob = globalThis.atob;
    let atobCalls = 0;
    globalThis.atob = ((value: string) => {
      atobCalls += 1;
      return originalAtob(value);
    }) as typeof atob;

    try {
      const response = await handleMcpWithPrincipal(
        new Request("https://deploy.invalid/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: {
              name: "kale.upload_revision",
              arguments: {
                projectId: "prj_22222222222222222222222222222222",
                artifactBase64: "A".repeat(MAX_ARTIFACT_BASE64_CHARS + 1),
                contentDigest: "sha-256=:+3Ef2SMBqe9arjRcw9oGQI59KRuODN/x1ENMIW5FnoI=:",
              },
            },
          }),
        }),
        env,
        requestId,
        principal,
      );

      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        result: { content: [{ text: string }]; isError: boolean };
      };
      expect(result.result.isError).toBe(true);
      expect(JSON.parse(result.result.content[0].text)).toEqual({
        error: {
          code: "invalid_mcp_arguments",
          message: "The MCP tool arguments do not match the tool contract.",
          requestId,
        },
      });
      expect(atobCalls).toBe(0);
      expect(envReads).toBe(0);
    } finally {
      globalThis.atob = originalAtob;
    }
  });

  test("rejects base64 that decodes beyond the artifact byte limit before allocation", async () => {
    let envReads = 0;
    const env = new Proxy({} as Env, {
      get() {
        envReads += 1;
        throw new Error("The API handler must not run for oversized artifacts.");
      },
    });
    const originalAtob = globalThis.atob;
    let atobCalls = 0;
    globalThis.atob = ((value: string) => {
      atobCalls += 1;
      return originalAtob(value);
    }) as typeof atob;

    try {
      const response = await handleMcpWithPrincipal(
        new Request("https://deploy.invalid/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 8,
            method: "tools/call",
            params: {
              name: "kale.upload_revision",
              arguments: {
                projectId: "prj_22222222222222222222222222222222",
                artifactBase64: "A".repeat(MAX_ARTIFACT_BASE64_CHARS),
                contentDigest: "sha-256=:+3Ef2SMBqe9arjRcw9oGQI59KRuODN/x1ENMIW5FnoI=:",
              },
            },
          }),
        }),
        env,
        requestId,
        principal,
      );

      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        result: { content: [{ text: string }]; isError: boolean };
      };
      expect(result.result.isError).toBe(true);
      expect(JSON.parse(result.result.content[0].text).error.code).toBe("invalid_mcp_arguments");
      expect(atobCalls).toBe(0);
      expect(envReads).toBe(0);
    } finally {
      globalThis.atob = originalAtob;
    }
  });

  test("rejects declared oversized outer JSON without reading, decoding, or API access", async () => {
    let pulls = 0;
    let cancelled = false;
    let envReads = 0;
    let decoderReads = 0;
    const env = new Proxy({} as Env, {
      get() {
        envReads += 1;
        throw new Error("The API handler must not run for oversized MCP JSON.");
      },
    });
    const textDecoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextDecoder");
    Object.defineProperty(globalThis, "TextDecoder", {
      configurable: true,
      get() {
        decoderReads += 1;
        return textDecoderDescriptor?.value;
      },
    });
    const request = new Request("https://deploy.invalid/mcp", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => undefined);
        },
      }),
      duplex: "half",
      headers: {
        "Content-Length": String(MAX_MCP_BODY_BYTES + 1),
        "Content-Type": "application/json",
      },
    } as RequestInit);

    try {
      await expect(
        handleMcpWithPrincipal(request, env, requestId, principal),
      ).rejects.toMatchObject({
        status: 413,
        code: "mcp_request_too_large",
      });
      expect(pulls).toBe(0);
      expect(cancelled).toBe(true);
      expect(decoderReads).toBe(0);
      expect(envReads).toBe(0);
    } finally {
      if (textDecoderDescriptor)
        Object.defineProperty(globalThis, "TextDecoder", textDecoderDescriptor);
    }
  });

  test("preserves the MCP size error when cancellation, release, and diagnostics throw", async () => {
    const request = {
      headers: new Headers({ "Content-Length": String(MAX_MCP_BODY_BYTES + 1) }),
      body: {
        getReader: () => ({
          cancel: () => {
            throw new Error("PRIVATE_MCP_SYNCHRONOUS_CANCEL_FAILURE");
          },
          releaseLock: () => {
            throw new Error("PRIVATE_MCP_RELEASE_FAILURE");
          },
        }),
      },
    } as unknown as Request;
    const originalConsoleError = console.error;
    console.error = () => {
      throw new Error("PRIVATE_DIAGNOSTIC_SINK_FAILURE");
    };
    try {
      await expect(
        handleMcpWithPrincipal(request, {} as Env, requestId, principal),
      ).rejects.toMatchObject({
        status: 413,
        code: "mcp_request_too_large",
      });
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("rejects chunked oversized outer JSON without decoding or API access", async () => {
    let cancelled = false;
    let envReads = 0;
    let decoderReads = 0;
    const env = new Proxy({} as Env, {
      get() {
        envReads += 1;
        throw new Error("The API handler must not run for oversized MCP JSON.");
      },
    });
    const textDecoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextDecoder");
    Object.defineProperty(globalThis, "TextDecoder", {
      configurable: true,
      get() {
        decoderReads += 1;
        return textDecoderDescriptor?.value;
      },
    });
    const request = new Request("https://deploy.invalid/mcp", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_MCP_BODY_BYTES + 1));
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => undefined);
        },
      }),
      duplex: "half",
      headers: { "Content-Type": "application/json" },
    } as RequestInit);

    try {
      await expect(
        handleMcpWithPrincipal(request, env, requestId, principal),
      ).rejects.toMatchObject({
        status: 413,
        code: "mcp_request_too_large",
      });
      expect(cancelled).toBe(true);
      expect(decoderReads).toBe(0);
      expect(envReads).toBe(0);
    } finally {
      if (textDecoderDescriptor)
        Object.defineProperty(globalThis, "TextDecoder", textDecoderDescriptor);
    }
  });

  test("preserves a primary MCP read failure when release and diagnostics also fail", async () => {
    const primary = new Error("PRIMARY_MCP_READ_FAILURE");
    const request = {
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            throw primary;
          },
          releaseLock: () => {
            throw new Error("PRIVATE_MCP_RELEASE_FAILURE");
          },
        }),
      },
    } as unknown as Request;
    const originalConsoleError = console.error;
    console.error = () => {
      throw new Error("PRIVATE_DIAGNOSTIC_SINK_FAILURE");
    };
    try {
      await expect(handleMcpWithPrincipal(request, {} as Env, requestId, principal)).rejects.toBe(
        primary,
      );
    } finally {
      console.error = originalConsoleError;
    }
  });
});
