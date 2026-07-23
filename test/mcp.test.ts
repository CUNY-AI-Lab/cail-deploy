import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Principal } from "../src/auth";
import type { Env } from "../src/env";
import { handleMcpWithPrincipal, MAX_ARTIFACT_BASE64_CHARS, MAX_MCP_BODY_BYTES } from "../src/mcp";

const requestId = "11111111-1111-4111-8111-111111111111";
const principal: Principal = {
  subject: "cail-0123456789abcdef0123456789abcdef",
  authentication: "cail-identity-jwt",
};

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
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

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected MCP text content.");
  return content.text;
}

describe("MCP tool argument boundary", () => {
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
