import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Principal } from "../src/auth";
import type { Env } from "../src/env";
import { handleMcpWithPrincipal } from "../src/mcp";

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
});
