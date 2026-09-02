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
import type { JsonObject, JsonValue } from "../src/domain/json";
import type { ThrownValue } from "./helpers";
import type { Env } from "../src/env";
import {
  createMcpApiRequest,
  MAX_ARTIFACT_BASE64_CHARS,
  MAX_MCP_BODY_BYTES,
  MAX_MCP_RESPONSE_BYTES,
  readMcpMessage,
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
const legacyTransportHeaders = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

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
  params: JsonObject,
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
    approval: "required",
    idempotencyKey: "release-1",
  },
  "kale.get_release": {
    projectId: "prj_22222222222222222222222222222222",
    releaseId: "rel_33333333333333333333333333333333",
  },
  "kale.preview_project": {
    projectId: "prj_22222222222222222222222222222222",
  },
  "kale.approve_release": {
    projectId: "prj_22222222222222222222222222222222",
    releaseId: "rel_33333333333333333333333333333333",
    idempotencyKey: "approve-1",
  },
  "kale.reconcile_release": {
    projectId: "prj_22222222222222222222222222222222",
    releaseId: "rel_33333333333333333333333333333333",
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
    { ...validToolArguments["kale.create_release"], approval: "yes" },
    { ...validToolArguments["kale.create_release"], revisionId: "rev_invalid" },
    { ...validToolArguments["kale.create_release"], unexpected: true },
  ],
  "kale.get_release": [
    { ...validToolArguments["kale.get_release"], releaseId: "rel_invalid" },
    { ...validToolArguments["kale.get_release"], unexpected: true },
  ],
  "kale.preview_project": [
    { projectId: "prj_invalid" },
    { ...validToolArguments["kale.preview_project"], unexpected: true },
  ],
  "kale.approve_release": [
    { ...validToolArguments["kale.approve_release"], idempotencyKey: 42 },
    { ...validToolArguments["kale.approve_release"], projectId: "prj_invalid" },
    { ...validToolArguments["kale.approve_release"], unexpected: true },
  ],
  "kale.reconcile_release": [
    { ...validToolArguments["kale.reconcile_release"], releaseId: "rel_invalid" },
    { ...validToolArguments["kale.reconcile_release"], unexpected: true },
  ],
  "kale.rollback_release": [
    { ...validToolArguments["kale.rollback_release"], approval: "yes" },
    { ...validToolArguments["kale.rollback_release"], releaseId: "rel_invalid" },
    { ...validToolArguments["kale.rollback_release"], unexpected: true },
  ],
} as const;

describe("MCP tool argument boundary", () => {
  test("serves the stateless 2026-07-28 protocol with the frozen tool surface", async () => {
    // SAFETY: this discovery-only client never dereferences Env because the request is rejected before dispatch.
    const client = await modernClientAgainst({} as Env);

    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const toolDescriptions = {
      "kale.create_project": "Create a project.",
      "kale.upload_revision": "Upload a new version of your app.",
      "kale.create_release": "Publish a version.",
      "kale.get_release": "Check on a release.",
      "kale.preview_project": "Preview the latest live release.",
      "kale.approve_release": "Approve a release.",
      "kale.reconcile_release": "Finish a release whose publication could not be confirmed.",
      "kale.rollback_release": "Roll back to an earlier version.",
    } satisfies { [Name in (typeof tools)[number]["name"]]: string };
    expect((await client.listTools()).tools).toEqual(
      tools.map((tool) => ({
        name: tool.name,
        description: toolDescriptions[tool.name],
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
        message: "The tool arguments don't match what the tool expects.",
        requestId,
      },
    });
  });

  test("keeps advertised draft-2020-12 schemas equivalent to runtime Zod boundaries", async () => {
    // SAFETY: this discovery-only client never dereferences Env because the request is rejected before dispatch.
    const advertised = await (await modernClientAgainst({} as Env)).listTools();
    const advertisedByName = new Map(advertised.tools.map((tool) => [tool.name, tool.inputSchema]));
    const validator = new Ajv2020({ strict: false });

    for (const tool of tools) {
      const advertisedSchema = advertisedByName.get(tool.name);
      if (!advertisedSchema) throw new Error(`Missing advertised schema for ${tool.name}`);
      const validate = validator.compile(advertisedSchema);
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

  test("keeps the augmented create-project schema strict at the JSON Schema boundary", () => {
    const createTool = tools.find((tool) => tool.name === "kale.create_project");
    if (!createTool) throw new Error("create-project tool schema is missing");
    // SAFETY: the MCP tool contract exposes a JSON Schema object after the
    // canonical parser in inputSchemaFor has validated its root shape.
    const schema = createTool.inputSchema as {
      additionalProperties?: boolean;
      properties?: { name?: { pattern?: string } };
      type?: string;
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.name?.pattern).toBe("^\\s*(?:\\S|\\S[\\s\\S]{0,78}\\S)\\s*$");
    // SAFETY: Ajv accepts the MCP Tool input schema as its documented JSON
    // Schema object after the canonical root parser has validated it.
    const validate = new Ajv2020({ strict: false }).compile(createTool.inputSchema as object);
    expect(validate({ name: "Example", idempotencyKey: "strict-boundary" })).toBe(true);
    expect(validate({ name: "Example", idempotencyKey: "strict-boundary", unexpected: true })).toBe(
      false,
    );
  });

  test("exposes reconciliation to OAuth-only MCP clients", async () => {
    const projectId = validToolArguments["kale.reconcile_release"].projectId;
    const releaseId = validToolArguments["kale.reconcile_release"].releaseId;
    // SAFETY: this fixture implements only the reconciliation DB reads; the test rejects before any other Env binding is read.
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () => {
                  if (sql.includes("FROM projects")) {
                    return { project_id: projectId, owner_subject: principal.subject };
                  }
                  if (sql.includes("FROM releases")) {
                    return {
                      project_id: projectId,
                      release_id: releaseId,
                      revision_id: `rev_sha256_${"a".repeat(64)}`,
                      approval: "automatic",
                      status: "publishing",
                      workflow_instance_id: releaseId,
                      prepared_key: null,
                      prepared_digest: null,
                    };
                  }
                  throw new Error(`Unexpected reconciliation SQL: ${sql}`);
                },
              };
            },
          };
        },
      },
    } as Env;
    const result = await (await standardClientAgainst(env)).callTool({
      name: "kale.reconcile_release",
      arguments: validToolArguments["kale.reconcile_release"],
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(toolText(result))).toEqual({
      error: {
        code: "release_not_reconcilable",
        message: "There is nothing left to finish on this release.",
        requestId,
      },
    });
  });

  test("returns the owner-scoped live preview through MCP without response cookies", async () => {
    const projectId = validToolArguments["kale.preview_project"].projectId;
    // SAFETY: this fixture implements the owner/release DB reads and preview dispatcher used by this boundary test.
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                first: async () => {
                  if (sql.includes("FROM projects")) {
                    return { project_id: projectId, owner_subject: principal.subject };
                  }
                  if (sql.includes("FROM releases")) {
                    return { publication_name: "published-revision" };
                  }
                  throw new Error(`Unexpected preview SQL: ${sql}`);
                },
              };
            },
          };
        },
      },
      DISPATCHER: {
        get(name: string) {
          expect(name).toBe("published-revision");
          return {
            async fetch(request: Request) {
              expect(new URL(request.url).pathname).toBe("/");
              return new Response("<h1>Kale preview</h1>", {
                headers: {
                  "content-type": "text/html; charset=utf-8",
                  "set-cookie": "session=must-not-escape",
                },
              });
            },
          };
        },
      },
    } as Env;

    const result = await (await standardClientAgainst(env)).callTool({
      name: "kale.preview_project",
      arguments: validToolArguments["kale.preview_project"],
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(toolText(result))).toEqual({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<h1>Kale preview</h1>",
    });
  });

  test("matches create-project trim and Unicode code-point length boundaries", () => {
    const createTool = tools.find((tool) => tool.name === "kale.create_project");
    if (!createTool) throw new Error("create-project tool schema is missing");
    // SAFETY: the advertised create-project input schema is the object schema returned by the MCP tool contract.
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
    // SAFETY: the hostile proxy intentionally throws on every Env read to prove origin checks run first.
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

  test("serves MCP only at its exact protected-resource path", async () => {
    for (const path of ["/mcpx", "/mcp/extra"]) {
      // SAFETY: this path-rejection test supplies an empty Env because routing must fail before any binding lookup.
      const response = await handleMcpWithPrincipal(
        new Request(`https://deploy.invalid${path}`, {
          method: "POST",
          headers: legacyTransportHeaders,
          body: JSON.stringify({ jsonrpc: "2.0", id: path, method: "initialize", params: {} }),
        }),
        {} as Env,
        requestId,
        principal,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "route_not_found", message: "The route was not found.", requestId },
      });
    }
  });

  test("enforces the maintained MCP HTTP media contract before dispatch", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "media-contract",
      method: "initialize",
      params: {},
    });
    const cases = [
      {
        headers: { "Content-Type": "application/json" },
        status: 406,
      },
      {
        headers: { Accept: "application/json, text/event-stream", "Content-Type": "text/plain" },
        status: 415,
      },
    ] as const;
    for (const { headers, status } of cases) {
      // SAFETY: media validation must reject this request before any Env binding is accessed.
      const response = await handleMcpWithPrincipal(
        new Request("https://deploy.invalid/mcp", { method: "POST", headers, body }),
        {} as Env,
        requestId,
        principal,
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("X-CAIL-Request-Id")).toBe(requestId);
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        error: expect.objectContaining({ code: -32000 }),
        id: null,
      });
    }

    // SAFETY: malformed JSON is rejected before the handler reads any Env binding.
    const malformed = await handleMcpWithPrincipal(
      new Request("https://deploy.invalid/mcp", {
        method: "POST",
        headers: legacyTransportHeaders,
        body: "{",
      }),
      {} as Env,
      requestId,
      principal,
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      jsonrpc: "2.0",
      error: expect.objectContaining({ code: -32700 }),
      id: null,
    });
  });

  test("standard SDK calls keep invalid tool arguments inside correlated MCP errors", async () => {
    let envReads = 0;
    // SAFETY: the hostile proxy intentionally throws on every Env read to prove argument validation runs first.
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
          approval: "yes",
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
          message: "The tool arguments don't match what the tool expects.",
          requestId,
        },
      });
    }

    expect(envReads).toBe(0);
  });

  test("rejects oversized artifactBase64 before decoding or API access", async () => {
    let envReads = 0;
    // SAFETY: the hostile proxy proves size/argument validation runs before API access.
    const env = new Proxy({} as Env, {
      get() {
        envReads += 1;
        throw new Error("The API handler must not run for oversized artifacts.");
      },
    });
    const originalAtob = globalThis.atob;
    let atobCalls = 0;
    // SAFETY: the wrapper preserves the platform atob string-to-string signature while counting calls.
    globalThis.atob = ((value: string) => {
      atobCalls += 1;
      return originalAtob(value);
    }) as typeof atob;

    try {
      const result = await (await standardClientAgainst(env)).callTool({
        name: "kale.upload_revision",
        arguments: {
          projectId: "prj_22222222222222222222222222222222",
          artifactBase64: "A".repeat(MAX_ARTIFACT_BASE64_CHARS + 1),
          contentDigest: validContentDigest,
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(toolText(result))).toEqual({
        error: {
          code: "invalid_mcp_arguments",
          message: "The tool arguments don't match what the tool expects.",
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
    // SAFETY: the hostile proxy proves size/argument validation runs before API access.
    const env = new Proxy({} as Env, {
      get() {
        envReads += 1;
        throw new Error("The API handler must not run for oversized artifacts.");
      },
    });
    const originalAtob = globalThis.atob;
    let atobCalls = 0;
    // SAFETY: the wrapper preserves the platform atob string-to-string signature while counting calls.
    globalThis.atob = ((value: string) => {
      atobCalls += 1;
      return originalAtob(value);
    }) as typeof atob;

    try {
      const result = await (await standardClientAgainst(env)).callTool({
        name: "kale.upload_revision",
        arguments: {
          projectId: "prj_22222222222222222222222222222222",
          artifactBase64: "A".repeat(MAX_ARTIFACT_BASE64_CHARS),
          contentDigest: validContentDigest,
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(toolText(result)).error.code).toBe("invalid_mcp_arguments");
      expect(atobCalls).toBe(0);
      expect(envReads).toBe(0);
    } finally {
      globalThis.atob = originalAtob;
    }
  });

  test("maps MCP request body overflow to its code and diagnostic labels", async () => {
    const diagnostics: JsonValue[] = [];
    // SAFETY: this hostile request fixture supplies only the reader methods needed to exercise wrapper diagnostics.
    const request = {
      headers: new Headers({
        ...legacyTransportHeaders,
        "Content-Length": String(MAX_MCP_BODY_BYTES + 1),
      }),
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
    } as Request;
    // SAFETY: declared-size rejection occurs before the handler reads any Env binding.
    const env = {} as Env;
    const originalConsoleError = console.error;
    console.error = (diagnostic: JsonValue) => diagnostics.push(diagnostic);
    try {
      await expect(
        handleMcpWithPrincipal(request, env, requestId, principal),
      ).rejects.toMatchObject({
        status: 413,
        code: "mcp_request_too_large",
      });
      expect(diagnostics).toEqual([
        {
          event: "deploy.mcp.request.body_cancel_failed",
          error: "body_cancel_failed",
          requestId,
        },
        {
          event: "deploy.mcp.request.body_release_failed",
          error: "body_release_failed",
          requestId,
        },
      ]);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("declared oversize without a body still rejects with 413", async () => {
    const request = new Request("https://deploy.example/mcp", {
      method: "POST",
      headers: { "Content-Length": String(MAX_MCP_BODY_BYTES + 1) },
    });
    await expect(readMcpMessage(request, requestId)).rejects.toMatchObject({
      status: 413,
      code: "mcp_request_too_large",
    });
  });

  test("maps oversized MCP responses to their code and diagnostic labels", async () => {
    const diagnostics: JsonValue[] = [];
    // SAFETY: this hostile response fixture supplies only the reader methods needed to exercise wrapper diagnostics.
    const response = {
      body: {
        getReader: () => ({
          read: async () => ({
            done: false,
            value: new Uint8Array(MAX_MCP_RESPONSE_BYTES + 1),
          }),
          cancel: () => {
            throw new Error("PRIVATE_MCP_RESPONSE_CANCEL_FAILURE");
          },
          releaseLock: () => {
            throw new Error("PRIVATE_MCP_RESPONSE_RELEASE_FAILURE");
          },
        }),
      },
    } as Response;
    const originalConsoleError = console.error;
    console.error = (diagnostic: JsonValue) => diagnostics.push(diagnostic);
    try {
      await expect(
        readMcpResponseText(response, new AbortController().signal, requestId),
      ).rejects.toMatchObject({
        status: 502,
        code: "mcp_response_too_large",
      });
      expect(diagnostics).toEqual([
        {
          event: "deploy.mcp.response.body_cancel_failed",
          error: "body_cancel_failed",
          requestId,
        },
        {
          event: "deploy.mcp.response.body_release_failed",
          error: "body_release_failed",
          requestId,
        },
      ]);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("returns an empty internal MCP response before validating its deadline", async () => {
    await expect(
      readMcpResponseText(new Response(null), new AbortController().signal, requestId, 0),
    ).resolves.toBe("");
  });

  test("cancels and unlocks a stalled internal MCP response at its deadline", async () => {
    let cancelCount = 0;
    let cancelReason: ThrownValue;
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
    ).catch((caught: ThrownValue) => caught);
    expect(apiErrorSnapshot(error)).toEqual({
      status: 504,
      code: "mcp_operation_timeout",
      message:
        "That took too long. For release writes, check the release status first, then reuse the same Idempotency-Key if you need to retry.",
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
    // SAFETY: this fixture implements only the DB read that starts the deliberate late-rejection race.
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
    } as Env;
    const unhandled: ThrownValue[] = [];
    const onUnhandled = (reason: ThrownValue): void => {
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
});
