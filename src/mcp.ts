import { ARTIFACT_MEDIA_TYPE, handleApi } from "./api";
import { ApiError } from "./domain/errors";
import type { Env } from "./env";

const tools = [
  ["kale.create_project", ["name", "idempotencyKey"]],
  ["kale.upload_revision", ["projectId", "artifactBase64", "contentDigest"]],
  ["kale.create_release", ["projectId", "revisionId", "target", "approval", "idempotencyKey"]],
  ["kale.get_release", ["projectId", "releaseId"]],
  ["kale.approve_release", ["projectId", "releaseId", "idempotencyKey"]],
  ["kale.rollback_release", ["projectId", "releaseId", "approval", "idempotencyKey"]],
] as const;

export async function handleMcp(request: Request, env: Env, requestId: string): Promise<Response> {
  const message = (await request.json()) as {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (message.jsonrpc !== "2.0")
    throw new ApiError(400, "invalid_mcp", "MCP requires JSON-RPC 2.0.");
  if (message.method === "initialize") {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "kale-release-control-plane", version: "0.1.0" },
      },
    });
  }
  if (message.method === "tools/list") {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: tools.map(([name, required]) => ({
          name,
          description: `Kale release operation ${name}.`,
          inputSchema: {
            type: "object",
            required,
            additionalProperties: false,
            properties: Object.fromEntries(required.map((key) => [key, { type: "string" }])),
          },
        })),
      },
    });
  }
  if (message.method !== "tools/call")
    throw new ApiError(400, "unknown_mcp_method", "The MCP method is not supported.");
  const name = message.params?.name;
  const args = (message.params?.arguments ?? {}) as Record<string, string>;
  if (typeof name !== "string")
    throw new ApiError(400, "invalid_mcp", "tools/call requires a tool name.");
  const headers = new Headers();
  const authorization = request.headers.get("Authorization");
  const identityJwt = request.headers.get("X-CAIL-Identity-JWT");
  if (authorization) headers.set("Authorization", authorization);
  if (identityJwt) headers.set("X-CAIL-Identity-JWT", identityJwt);
  if (args.idempotencyKey) headers.set("Idempotency-Key", args.idempotencyKey);
  let path: string;
  let method: "GET" | "POST" = "POST";
  let body: BodyInit | undefined;
  if (name === "kale.create_project") {
    path = "/v1/projects";
    body = JSON.stringify({ name: args.name });
  } else if (name === "kale.upload_revision") {
    path = `/v1/projects/${args.projectId}/revisions`;
    headers.set("Content-Type", ARTIFACT_MEDIA_TYPE);
    headers.set("Content-Digest", args.contentDigest ?? "");
    body = Uint8Array.from(atob(args.artifactBase64 ?? ""), (character) => character.charCodeAt(0));
  } else if (name === "kale.create_release") {
    path = `/v1/projects/${args.projectId}/releases`;
    body = JSON.stringify({
      revisionId: args.revisionId,
      target: args.target,
      approval: args.approval,
    });
  } else if (name === "kale.get_release") {
    path = `/v1/projects/${args.projectId}/releases/${args.releaseId}`;
    method = "GET";
  } else if (name === "kale.approve_release") {
    path = `/v1/projects/${args.projectId}/releases/${args.releaseId}/approve`;
    body = JSON.stringify({ decision: "approved" });
  } else if (name === "kale.rollback_release") {
    path = `/v1/projects/${args.projectId}/releases/${args.releaseId}/rollback`;
    body = JSON.stringify({ approval: args.approval });
  } else {
    throw new ApiError(404, "mcp_tool_not_found", "The MCP tool was not found.");
  }
  const response = await handleApi(
    new Request(new URL(path, request.url), { method, headers, body }),
    env,
    requestId,
  );
  const text = await response.text();
  return Response.json({
    jsonrpc: "2.0",
    id: message.id,
    result: { content: [{ type: "text", text }], isError: !response.ok },
  });
}
