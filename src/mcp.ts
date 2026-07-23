import { z } from "zod";
import { ARTIFACT_MEDIA_TYPE, handleApiForPrincipal, MAX_ARTIFACT_BYTES } from "./api";
import type { Principal } from "./auth";
import {
  createProjectSchema,
  createReleaseSchema,
  PROJECT_PATTERN,
  RELEASE_PATTERN,
  rollbackSchema,
} from "./domain/contracts";
import { parseContentDigest } from "./domain/digests";
import { ApiError, apiErrorSnapshot, errorResponse } from "./domain/errors";
import { emitDeployDiagnostic, observeDetachedCleanup } from "./diagnostics";
import type { Env } from "./env";

const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const projectIdSchema = z.string().regex(PROJECT_PATTERN);
const releaseIdSchema = z.string().regex(RELEASE_PATTERN);
export const MAX_ARTIFACT_BASE64_CHARS = Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4;
export const MAX_MCP_BODY_BYTES = MAX_ARTIFACT_BASE64_CHARS + 16 * 1024;
const createProjectArgumentsSchema = createProjectSchema
  .extend({ idempotencyKey: idempotencyKeySchema })
  .strict();
const uploadRevisionArgumentsSchema = z
  .object({
    projectId: projectIdSchema,
    artifactBase64: z.string().min(1).max(MAX_ARTIFACT_BASE64_CHARS),
    contentDigest: z
      .string()
      .refine(
        (value) => parseContentDigest(value)?.byteLength === 32,
        "Content-Digest must contain one SHA-256 digest.",
      ),
  })
  .strict();
const createReleaseArgumentsSchema = createReleaseSchema
  .extend({
    projectId: projectIdSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
const getReleaseArgumentsSchema = z
  .object({ projectId: projectIdSchema, releaseId: releaseIdSchema })
  .strict();
const approveReleaseArgumentsSchema = getReleaseArgumentsSchema
  .extend({ idempotencyKey: idempotencyKeySchema })
  .strict();
const rollbackReleaseArgumentsSchema = z
  .object({
    projectId: projectIdSchema,
    releaseId: releaseIdSchema,
    approval: rollbackSchema.shape.approval,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const tools = [
  ["kale.create_project", ["name", "idempotencyKey"]],
  ["kale.upload_revision", ["projectId", "artifactBase64", "contentDigest"]],
  ["kale.create_release", ["projectId", "revisionId", "target", "approval", "idempotencyKey"]],
  ["kale.get_release", ["projectId", "releaseId"]],
  ["kale.approve_release", ["projectId", "releaseId", "idempotencyKey"]],
  ["kale.rollback_release", ["projectId", "releaseId", "approval", "idempotencyKey"]],
] as const;

function invalidToolArguments(): ApiError {
  return new ApiError(
    400,
    "invalid_mcp_arguments",
    "The MCP tool arguments do not match the tool contract.",
  );
}

function parseToolArguments<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidToolArguments();
  return result.data;
}

function base64DecodedLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function rejectOversizedArtifactArgument(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const artifactBase64 = (value as Record<string, unknown>).artifactBase64;
  if (
    typeof artifactBase64 === "string" &&
    (artifactBase64.length > MAX_ARTIFACT_BASE64_CHARS ||
      (artifactBase64.length % 4 === 0 && base64DecodedLength(artifactBase64) > MAX_ARTIFACT_BYTES))
  ) {
    throw invalidToolArguments();
  }
}

function decodeArtifactBase64(value: string): Uint8Array<ArrayBuffer> {
  if (value.length > MAX_ARTIFACT_BASE64_CHARS) throw invalidToolArguments();
  if (!CANONICAL_BASE64.test(value)) throw invalidToolArguments();
  if (base64DecodedLength(value) > MAX_ARTIFACT_BYTES) throw invalidToolArguments();
  const decoded = atob(value);
  if (btoa(decoded) !== value) throw invalidToolArguments();
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function cancelMcpBody(reader: ReadableStreamDefaultReader<Uint8Array>, requestId: string): void {
  observeDetachedCleanup(() => reader.cancel(), "mcp_body_cancel_failed", { requestId });
}

function releaseMcpBodyReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  requestId: string,
): void {
  try {
    reader.releaseLock();
  } catch {
    emitDeployDiagnostic("mcp_body_release_failed", { requestId });
  }
}

async function readMcpMessage(
  request: Request,
  requestId: string,
): Promise<{
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}> {
  const tooLarge = () =>
    new ApiError(413, "mcp_request_too_large", "The MCP request body exceeds the supported limit.");
  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_MCP_BODY_BYTES
  ) {
    if (request.body) {
      const reader = request.body.getReader();
      cancelMcpBody(reader, requestId);
      releaseMcpBodyReader(reader, requestId);
    }
    throw tooLarge();
  }
  if (!request.body)
    throw new ApiError(400, "invalid_mcp", "The MCP request body must be valid JSON.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MCP_BODY_BYTES) {
        cancelMcpBody(reader, requestId);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    releaseMcpBodyReader(reader, requestId);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
  } catch (cause) {
    throw new ApiError(400, "invalid_mcp", "The MCP request body must be valid JSON.", { cause });
  }
}

async function mcpToolResult(
  id: unknown,
  response: Response,
  requestId: string,
): Promise<Response> {
  const text = await response.text();
  return Response.json(
    {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], isError: !response.ok },
    },
    {
      headers: {
        "X-CAIL-Request-Id": requestId,
        "x-request-id": requestId,
      },
    },
  );
}

export async function handleMcpWithPrincipal(
  request: Request,
  env: Env,
  requestId: string,
  principal: Principal,
): Promise<Response> {
  const message = await readMcpMessage(request, requestId);
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
  if (message.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (message.method !== "tools/call")
    throw new ApiError(400, "unknown_mcp_method", "The MCP method is not supported.");
  const name = message.params?.name;
  if (typeof name !== "string") {
    return mcpToolResult(message.id, errorResponse(invalidToolArguments(), requestId), requestId);
  }
  const headers = new Headers();
  let path: string;
  let method: "GET" | "POST" = "POST";
  let body: BodyInit | undefined;
  try {
    const argumentsValue = message.params?.arguments;
    if (name === "kale.create_project") {
      const args = parseToolArguments(createProjectArgumentsSchema, argumentsValue);
      path = "/v1/projects";
      headers.set("Idempotency-Key", args.idempotencyKey);
      body = JSON.stringify({ name: args.name });
    } else if (name === "kale.upload_revision") {
      rejectOversizedArtifactArgument(argumentsValue);
      const args = parseToolArguments(uploadRevisionArgumentsSchema, argumentsValue);
      path = `/v1/projects/${args.projectId}/revisions`;
      headers.set("Content-Type", ARTIFACT_MEDIA_TYPE);
      headers.set("Content-Digest", args.contentDigest);
      body = decodeArtifactBase64(args.artifactBase64);
    } else if (name === "kale.create_release") {
      const args = parseToolArguments(createReleaseArgumentsSchema, argumentsValue);
      path = `/v1/projects/${args.projectId}/releases`;
      headers.set("Idempotency-Key", args.idempotencyKey);
      body = JSON.stringify({
        revisionId: args.revisionId,
        target: args.target,
        approval: args.approval,
      });
    } else if (name === "kale.get_release") {
      const args = parseToolArguments(getReleaseArgumentsSchema, argumentsValue);
      path = `/v1/projects/${args.projectId}/releases/${args.releaseId}`;
      method = "GET";
    } else if (name === "kale.approve_release") {
      const args = parseToolArguments(approveReleaseArgumentsSchema, argumentsValue);
      path = `/v1/projects/${args.projectId}/releases/${args.releaseId}/approve`;
      headers.set("Idempotency-Key", args.idempotencyKey);
      body = JSON.stringify({ decision: "approved" });
    } else if (name === "kale.rollback_release") {
      const args = parseToolArguments(rollbackReleaseArgumentsSchema, argumentsValue);
      path = `/v1/projects/${args.projectId}/releases/${args.releaseId}/rollback`;
      headers.set("Idempotency-Key", args.idempotencyKey);
      body = JSON.stringify({ approval: args.approval });
    } else {
      throw new ApiError(404, "mcp_tool_not_found", "The MCP tool was not found.");
    }
  } catch (error) {
    if (!apiErrorSnapshot(error)) throw error;
    return mcpToolResult(message.id, errorResponse(error, requestId), requestId);
  }
  let response: Response;
  try {
    response = await handleApiForPrincipal(
      new Request(new URL(path, request.url), { method, headers, body }),
      env,
      principal,
      requestId,
    );
  } catch (error) {
    response = errorResponse(error, requestId);
  }
  return mcpToolResult(message.id, response, requestId);
}
