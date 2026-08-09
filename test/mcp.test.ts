import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Ajv2020 from "ajv/dist/2020.js";
import { handleMcpWithPrincipal } from "../src/adapters/cloudflare/mcp";
import type { Principal } from "../src/auth";
import { apiErrorSnapshot } from "../src/domain/errors";
import type { Env } from "../src/env";
import {
  createMcpApiRequest,
  handleLegacyMcpMessage,
  MAX_ARTIFACT_BASE64_CHARS,
  MAX_MCP_BODY_BYTES,
  MAX_MCP_RESPONSE_BYTES,
  readMcpResponseText,
  tools,
} from "../src/mcp";

const requestId = "11111111-1111-4111-8111-111111111111";
const principal: Principal = {
  subject: "cail-0123456789abcdef0123456789abcdef",
  authentication: "cail-identity-jwt",
};

const clients: Client[] = [];
const modernClients: ModernClient[] = [];
const validContentDigest = `sha-256=:${Buffer.alloc(32).toString("base64")}:`;

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
  signal?: AbortSignal,
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
    signal,
  });
}

const validToolArguments = {
  "kale.create_project": { name: "Example", idempotencyKey: "create-1" },
  "kale.upload_revision": {
    projectId: "prj_22222222222222222222222222222222",
    artifactBase64: "e30=",
    contentDigest: validContentDigest,
  },
  "kale.create_release": {
    projectId: "prj_22222222222222222222222222222222",
    revisionId: `rev_sha256_${"a".repeat(64)}`,
    target: "preview",
    approval: "required",
    idempotencyKey: "release-1",
  },
  "kale.get_release": {
    projectId: "prj_22222222222222222222222222222222",
    releaseId: "rel_33333333333333333333333333333333",
  },
  "kale.approve_release": {
    projectId: "prj_22222222222222222222222222222222",
    releaseId: "rel_33333333333333333333333333333333",
    idempotencyKey: "approve-1",
  },
  "kale.rollback_release": {
    projectId: "prj_22222222222222222222222222222222",
    releaseId: "rel_33333333333333333333333333333333",
    approval: "automatic",
    idempotencyKey: "rollback-1",
  },
} as const;

const invalidToolArguments = {
  "kale.create_project": [
    { ...validToolArguments["kale.create_project"], name: "   " },
    { ...validToolArguments["kale.create_project"], name: "😀".repeat(81) },
    { ...validToolArguments["kale.create_project"], unexpected: true },
  ],
  "kale.upload_revision": [
    { ...validToolArguments["kale.upload_revision"], artifactBase64: "%%%" },
    { ...validToolArguments["kale.upload_revision"], projectId: "prj_invalid" },
    { ...validToolArguments["kale.upload_revision"], unexpected: true },
  ],
  "kale.create_release": [
    { ...validToolArguments["kale.create_release"], target: "staging" },
    { ...validToolArguments["kale.create_release"], revisionId: "rev_invalid" },
    { ...validToolArguments["kale.create_release"], unexpected: true },
  ],
  "kale.get_release": [
    { ...validToolArguments["kale.get_release"], releaseId: "rel_invalid" },
    { ...validToolArguments["kale.get_release"], unexpected: true },
  ],
  "kale.approve_release": [
    { ...validToolArguments["kale.approve_release"], idempotencyKey: 42 },
    { ...validToolArguments["kale.approve_release"], projectId: "prj_invalid" },
    { ...validToolArguments["kale.approve_release"], unexpected: true },
  ],
  "kale.rollback_release": [
    { ...validToolArguments["kale.rollback_release"], approval: "yes" },
    { ...validToolArguments["kale.rollback_release"], releaseId: "rel_invalid" },
    { ...validToolArguments["kale.rollback_release"], unexpected: true },
  ],
} as const;

describe("MCP tool argument boundary", () => {
  test("serves the stateless 2026-07-28 protocol with the frozen tool surface", async () => {
    const client = await modernClientAgainst({} as Env);

    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect((await client.listTools()).tools).toEqual(
      tools.map((tool) => ({
        name: tool.name,
        description: `Kale release operation ${tool.name}.`,
        inputSchema: tool.inputSchema,
      })),
    );

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

  test("keeps advertised draft-2020-12 schemas equivalent to runtime Zod boundaries", async () => {
    const advertised = await (await modernClientAgainst({} as Env)).listTools();
    const advertisedByName = new Map(advertised.tools.map((tool) => [tool.name, tool.inputSchema]));
    const validator = new Ajv2020({ strict: false });

    for (const tool of tools) {
      const validate = validator.compile(advertisedByName.get(tool.name) as object);
      const valid = validToolArguments[tool.name];
      expect(validate(valid), `${tool.name} valid argument`).toBe(true);
      expect(tool.schema.safeParse(valid).success, `${tool.name} runtime valid argument`).toBe(
        true,
      );
      for (const invalid of invalidToolArguments[tool.name]) {
        expect(validate(invalid), `${tool.name} advertised invalid argument`).toBe(false);
        expect(
          tool.schema.safeParse(invalid).success,
          `${tool.name} runtime invalid argument`,
        ).toBe(false);
      }
    }
  });

  test("matches create-project trim and Unicode code-point length boundaries", () => {
    const createTool = tools.find((tool) => tool.name === "kale.create_project");
    if (!createTool) throw new Error("create-project tool schema is missing");
    const validate = new Ajv2020({ strict: false }).compile(createTool.inputSchema as object);
    for (const name of [
      "a".repeat(80),
      "😀".repeat(80),
      "a".repeat(79) + "😀",
      "  Example  ",
      "\n😀 mixed\t",
    ]) {
      expect(validate({ name, idempotencyKey: "boundary-1" })).toBe(true);
      expect(createTool.schema.safeParse({ name, idempotencyKey: "boundary-1" }).success).toBe(
        true,
      );
    }
    for (const name of ["   ", "\t\n", "a".repeat(81), "😀".repeat(81), "a".repeat(80) + "😀"]) {
      expect(validate({ name, idempotencyKey: "boundary-2" })).toBe(false);
      expect(createTool.schema.safeParse({ name, idempotencyKey: "boundary-2" }).success).toBe(
        false,
      );
    }
    for (const token of ["a", "😀", "é", " ", "\n", "\u200b", "\u180e"]) {
      for (const length of [0, 1, 2, 39, 40, 79, 80, 81, 82]) {
        const name = token.repeat(length);
        expect(validate({ name, idempotencyKey: "property-1" })).toBe(
          createTool.schema.safeParse({ name, idempotencyKey: "property-1" }).success,
        );
      }
    }
    for (const [bmp, astral] of [
      [0, 80],
      [1, 79],
      [39, 41],
      [40, 40],
      [79, 1],
      [80, 0],
      [80, 1],
    ]) {
      const name = "a".repeat(bmp) + "😀".repeat(astral);
      expect(validate({ name, idempotencyKey: "property-2" })).toBe(
        createTool.schema.safeParse({ name, idempotencyKey: "property-2" }).success,
      );
    }
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

  test("keeps legacy and modern tool discovery byte-equivalent", async () => {
    const modern = await modernClientAgainst({} as Env);
    const modernTools = (await modern.listTools()).tools;
    const legacy = await handleLegacyMcpMessage(
      { jsonrpc: "2.0", id: "legacy-tools", method: "tools/list" },
      "https://deploy.invalid/mcp",
      {} as Env,
      requestId,
      principal,
      new AbortController().signal,
    );
    const payload = (await legacy.json()) as { result: { tools: unknown[] } };
    expect(payload.result.tools).toEqual(modernTools);
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
      contentDigest: validContentDigest,
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
                contentDigest: validContentDigest,
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
                contentDigest: validContentDigest,
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

  test("cancels and unlocks a truly stalled MCP request body on caller abort", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted MCP request");
    let cancelCount = 0;
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel(value) {
        cancelCount += 1;
        cancelReason = value;
      },
    });
    const request = new Request("https://deploy.invalid/mcp", {
      method: "POST",
      body,
      duplex: "half",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
    } as RequestInit);

    const pending = handleMcpWithPrincipal(request, {} as Env, requestId, principal);
    controller.abort(reason);
    const error = await pending.catch((caught: unknown) => caught);
    expect(apiErrorSnapshot(error)).toEqual({
      status: 499,
      code: "request_cancelled",
      message: "The request was cancelled.",
    });
    await Bun.sleep(0);
    expect(cancelCount).toBe(1);
    expect(cancelReason).toBe(reason);
    expect(body.locked).toBe(false);
  });

  test("bounds, cancels, and unlocks an oversized internal MCP response", async () => {
    let cancelCount = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_MCP_RESPONSE_BYTES + 1));
      },
      cancel() {
        cancelCount += 1;
      },
    });
    const response = new Response(body);
    const error = await readMcpResponseText(
      response,
      new AbortController().signal,
      requestId,
    ).catch((caught: unknown) => caught);
    expect(apiErrorSnapshot(error)).toEqual({
      status: 502,
      code: "mcp_response_too_large",
      message: "The MCP tool response exceeds the supported limit.",
    });
    await Bun.sleep(0);
    expect(cancelCount).toBe(1);
    expect(body.locked).toBe(false);
  });

  test("preserves an internal response read failure when cleanup and diagnostics fail", async () => {
    const primary = new Error("PRIMARY_MCP_RESPONSE_READ_FAILURE");
    const response = {
      body: {
        getReader: () => ({
          read: async () => {
            throw primary;
          },
          cancel: () => {
            throw new Error("PRIVATE_MCP_RESPONSE_CANCEL_FAILURE");
          },
          releaseLock: () => {
            throw new Error("PRIVATE_MCP_RESPONSE_RELEASE_FAILURE");
          },
        }),
      },
    } as unknown as Response;
    const originalConsoleError = console.error;
    console.error = () => {
      throw new Error("PRIVATE_DIAGNOSTIC_SINK_FAILURE");
    };
    try {
      await expect(
        readMcpResponseText(response, new AbortController().signal, requestId),
      ).rejects.toBe(primary);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("cancels and unlocks a stalled internal MCP response on caller abort", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted MCP response");
    let cancelCount = 0;
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel(value) {
        cancelCount += 1;
        cancelReason = value;
      },
    });
    const pending = readMcpResponseText(new Response(body), controller.signal, requestId);
    controller.abort(reason);
    const error = await pending.catch((caught: unknown) => caught);
    expect(apiErrorSnapshot(error)).toEqual({
      status: 499,
      code: "request_cancelled",
      message: "The request was cancelled.",
    });
    await Bun.sleep(0);
    expect(cancelCount).toBe(1);
    expect(cancelReason).toBe(reason);
    expect(body.locked).toBe(false);
  });

  test("cancels and unlocks a stalled internal MCP response at its deadline", async () => {
    let cancelCount = 0;
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel(value) {
        cancelCount += 1;
        cancelReason = value;
      },
    });
    const error = await readMcpResponseText(
      new Response(body),
      new AbortController().signal,
      requestId,
      10,
    ).catch((caught: unknown) => caught);
    expect(apiErrorSnapshot(error)).toEqual({
      status: 504,
      code: "mcp_operation_timeout",
      message: "The MCP tool operation did not complete before its deadline.",
    });
    await Bun.sleep(0);
    expect(cancelCount).toBe(1);
    expect(cancelReason).toBeInstanceOf(Error);
    expect(body.locked).toBe(false);
  });

  test("threads caller cancellation into the internal API request", () => {
    const controller = new AbortController();
    const reason = new Error("internal API caller cancelled");
    const request = createMcpApiRequest(
      "https://deploy.invalid/mcp",
      "/v1/projects",
      "POST",
      new Headers({ "content-type": "application/json" }),
      JSON.stringify({ name: "Project" }),
      controller.signal,
    );
    expect(request.signal.aborted).toBe(false);
    controller.abort(reason);
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe(reason);
  });

  test("keeps a claimless legacy tools/call correlated when the adapter request is aborted", async () => {
    const controller = new AbortController();
    const requestBody = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "legacy-adapter-abort",
              method: "tools/call",
              params: {
                name: "kale.get_release",
                arguments: validToolArguments["kale.get_release"],
              },
            }),
          ),
        );
        streamController.close();
      },
    });
    const request = new Request("https://deploy.invalid/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);
    const lateError = new Error("PRIVATE_LEGACY_ADAPTER_LATE_REJECTION");
    let effectCalls = 0;
    let lateRejected = false;
    let resolveDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      resolveDispatchStarted = resolve;
    });
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                first: () => {
                  effectCalls += 1;
                  resolveDispatchStarted();
                  return new Promise<never>((_, reject) => {
                    setTimeout(() => {
                      lateRejected = true;
                      reject(lateError);
                    }, 35);
                  });
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const pending = handleMcpWithPrincipal(request, env, requestId, principal);
      await Promise.race([
        dispatchStarted,
        Bun.sleep(100).then(() => {
          throw new Error("legacy adapter dispatch did not start");
        }),
      ]);
      expect(effectCalls).toBe(1);
      expect(requestBody.locked).toBe(false);

      const reason = new Error("caller stopped claimless legacy adapter request");
      controller.abort(reason);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(requestBody.locked).toBe(false);
      const payload = (await response.json()) as {
        jsonrpc: string;
        id: unknown;
        result: { content: [{ text: string }]; isError: boolean };
      };
      expect(payload.jsonrpc).toBe("2.0");
      expect(payload.id).toBe("legacy-adapter-abort");
      expect(payload.result.isError).toBe(true);
      expect(JSON.parse(payload.result.content[0].text)).toEqual({
        error: {
          code: "request_cancelled",
          message: "The request was cancelled.",
          requestId,
        },
      });

      await Bun.sleep(50);
      expect(lateRejected).toBe(true);
      expect(effectCalls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("closes the modern HTTP exchange when an adapter request is aborted", async () => {
    const controller = new AbortController();
    const request = modernRequest(
      "tools/call",
      {
        name: "kale.get_release",
        arguments: validToolArguments["kale.get_release"],
      },
      { "Mcp-Name": "kale.get_release" },
      controller.signal,
    );
    const lateError = new Error("PRIVATE_MODERN_ADAPTER_LATE_REJECTION");
    let effectCalls = 0;
    let lateRejected = false;
    let resolveDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      resolveDispatchStarted = resolve;
    });
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                first: () => {
                  effectCalls += 1;
                  resolveDispatchStarted();
                  return new Promise<never>((_, reject) => {
                    setTimeout(() => {
                      lateRejected = true;
                      reject(lateError);
                    }, 35);
                  });
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const pending = handleMcpWithPrincipal(request, env, requestId, principal);
      await dispatchStarted;
      expect(effectCalls).toBe(1);
      expect(request.body?.locked).toBe(false);

      controller.abort(new Error("caller stopped modern adapter request"));
      const response = await pending;
      expect(response.status).toBe(499);
      expect(response.body).toBeNull();
      expect(request.body?.locked).toBe(false);

      await Bun.sleep(50);
      expect(lateRejected).toBe(true);
      expect(effectCalls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("races a hung legacy API dispatch against caller abort and observes its late rejection", async () => {
    const controller = new AbortController();
    const lateError = new Error("LATE_LEGACY_DISPATCH_REJECTION");
    let lateRejected = false;
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                first: () =>
                  new Promise<never>((_, reject) => {
                    setTimeout(() => {
                      lateRejected = true;
                      reject(lateError);
                    }, 30);
                  }),
              };
            },
          };
        },
      },
    } as unknown as Env;
    const pending = handleLegacyMcpMessage(
      {
        jsonrpc: "2.0",
        id: "legacy-abort",
        method: "tools/call",
        params: {
          name: "kale.get_release",
          arguments: validToolArguments["kale.get_release"],
        },
      },
      "https://deploy.invalid/mcp",
      env,
      requestId,
      principal,
      controller.signal,
      1_000,
    );
    controller.abort(new Error("caller stopped legacy dispatch"));
    const response = await pending;
    const payload = (await response.json()) as { result: { content: [{ text: string }] } };
    expect(JSON.parse(payload.result.content[0].text).error.code).toBe("request_cancelled");
    await Bun.sleep(50);
    expect(lateRejected).toBe(true);
  });

  test("returns a stable 504 when the whole legacy dispatch exceeds an injected deadline", async () => {
    let lateRejected = false;
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return {
                first: () =>
                  new Promise<never>((_, reject) => {
                    setTimeout(() => {
                      lateRejected = true;
                      reject(new Error("LATE_LEGACY_DEADLINE_REJECTION"));
                    }, 35);
                  }),
              };
            },
          };
        },
      },
    } as unknown as Env;
    const response = await handleLegacyMcpMessage(
      {
        jsonrpc: "2.0",
        id: "legacy-deadline",
        method: "tools/call",
        params: {
          name: "kale.get_release",
          arguments: validToolArguments["kale.get_release"],
        },
      },
      "https://deploy.invalid/mcp",
      env,
      requestId,
      principal,
      new AbortController().signal,
      10,
    );
    const payload = (await response.json()) as { result: { content: [{ text: string }] } };
    expect(JSON.parse(payload.result.content[0].text)).toEqual({
      error: {
        code: "mcp_operation_timeout",
        message: "The MCP tool operation did not complete before its deadline.",
        requestId,
      },
    });
    await Bun.sleep(50);
    expect(lateRejected).toBe(true);
  });

  test("cancels a response that resolves after the deadline clock but before its timer callback", async () => {
    const projectId = validToolArguments["kale.get_release"].projectId;
    const releaseId = validToolArguments["kale.get_release"].releaseId;
    const releaseRow = {
      project_id: projectId,
      release_id: releaseId,
      revision_id: `rev_sha256_${"a".repeat(64)}`,
      target: "preview",
      approval: "required",
      status: "queued",
      workflow_instance_id: releaseId,
      prepared_digest: null,
      publication_name: null,
      rollback_of_release_id: null,
      operational_subject: null,
      request_id: requestId,
      admitted_at: "2026-08-01T00:00:00.000Z",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    };
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () => {
                  if (sql.includes("FROM projects"))
                    return { project_id: projectId, owner_subject: principal.subject };
                  if (sql.includes("FROM releases")) return releaseRow;
                  if (sql.includes("event_count")) return { event_count: 0, event_bytes: 0 };
                  throw new Error(`Unexpected test SQL: ${sql}`);
                },
                all: async () => ({ results: [] }),
              };
            },
          };
        },
      },
    } as unknown as Env;
    let cancelCount = 0;
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel(reason) {
        cancelCount += 1;
        cancelReason = reason;
      },
    });
    const responseJsonDescriptor = Object.getOwnPropertyDescriptor(Response, "json");
    const originalResponseJson = Response.json;
    let apiResponseIntercepted = false;
    Object.defineProperty(Response, "json", {
      value: (value: unknown, init?: ResponseInit) => {
        if (
          !apiResponseIntercepted &&
          typeof value === "object" &&
          value !== null &&
          "events" in value
        ) {
          apiResponseIntercepted = true;
          const busyUntil = Date.now() + 40;
          let spins = 0;
          while (Date.now() < busyUntil) spins += 1;
          void spins;
          return new Response(body, { status: 200 });
        }
        return Reflect.apply(originalResponseJson, Response, [value, init]);
      },
    });
    try {
      const response = await handleLegacyMcpMessage(
        {
          jsonrpc: "2.0",
          id: "legacy-late-response",
          method: "tools/call",
          params: {
            name: "kale.get_release",
            arguments: validToolArguments["kale.get_release"],
          },
        },
        "https://deploy.invalid/mcp",
        env,
        requestId,
        principal,
        new AbortController().signal,
        10,
      );
      const payload = (await response.json()) as { result: { content: [{ text: string }] } };
      expect(JSON.parse(payload.result.content[0].text)).toEqual({
        error: {
          code: "mcp_operation_timeout",
          message: "The MCP tool operation did not complete before its deadline.",
          requestId,
        },
      });
      expect(apiResponseIntercepted).toBe(true);
      await Bun.sleep(0);
      expect(cancelCount).toBe(1);
      expect(cancelReason).toBeInstanceOf(Error);
      expect(body.locked).toBe(false);
    } finally {
      if (responseJsonDescriptor) Object.defineProperty(Response, "json", responseJsonDescriptor);
    }
  });
});
