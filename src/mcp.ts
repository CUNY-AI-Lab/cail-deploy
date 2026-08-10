import { type CallToolResult, Server, type Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ARTIFACT_MEDIA_TYPE, handleApiForPrincipal, MAX_ARTIFACT_BYTES } from "./api";
import type { Principal } from "./auth";
import { emitDeployDiagnostic, observeDetachedCleanup } from "./diagnostics";
import {
  createProjectSchema,
  createReleaseSchema,
  PROJECT_PATTERN,
  RELEASE_PATTERN,
  rollbackSchema,
} from "./domain/contracts";
import { parseContentDigest } from "./domain/digests";
import { ApiError, apiErrorSnapshot, errorResponse } from "./domain/errors";
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
export const MAX_MCP_RESPONSE_BYTES = MAX_MCP_BODY_BYTES;
export const MAX_MCP_OPERATION_MS = 30_000;
// Compatibility alias for existing response-reader callers; tool operations
// use the single MAX_MCP_OPERATION_MS budget for dispatch and response reads.
export const MAX_MCP_INTERNAL_RESPONSE_MS = MAX_MCP_OPERATION_MS;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SHA256_CONTENT_DIGEST = /^sha-256=:[A-Za-z0-9+/]{43}=:$/u;
const createProjectArgumentsSchema = createProjectSchema
  .extend({ idempotencyKey: idempotencyKeySchema })
  .strict();
const uploadRevisionArgumentsSchema = z
  .object({
    projectId: projectIdSchema,
    artifactBase64: z.string().min(1).max(MAX_ARTIFACT_BASE64_CHARS).regex(CANONICAL_BASE64),
    contentDigest: z
      .string()
      .regex(SHA256_CONTENT_DIGEST)
      .refine(
        (value) => parseContentDigest(value)?.byteLength === 32,
        "The Content-Digest header must contain one SHA-256 digest.",
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

function inputSchemaFor(
  schema: z.ZodType,
  override?: (generated: Record<string, unknown>) => void,
): Tool["inputSchema"] {
  const generated = z.toJSONSchema(schema, { target: "draft-2020-12" });
  if (generated.type !== "object") {
    throw new Error("MCP tool arguments must use an object JSON Schema.");
  }
  override?.(generated as Record<string, unknown>);
  return generated as unknown as Tool["inputSchema"];
}

function createProjectInputSchemaOverride(generated: Record<string, unknown>): void {
  const properties = generated.properties;
  if (typeof properties !== "object" || properties === null) {
    throw new Error("MCP create-project schema must expose object properties.");
  }
  const name = (properties as Record<string, unknown>).name;
  if (typeof name !== "object" || name === null) {
    throw new Error("MCP create-project schema must expose a name property.");
  }
  // Zod trims before checking non-emptiness and the project contract bounds
  // the trimmed value to 80 Unicode code points. JSON Schema's `pattern` uses
  // the same ECMA-262 code-point regex model, so one closed expression mirrors
  // both checks without advertising whitespace-only or overlong names.
  (properties as Record<string, unknown>).name = {
    ...(name as Record<string, unknown>),
    pattern: "^\\s*(?:\\S|\\S[\\s\\S]{0,78}\\S)\\s*$",
  };
}

const toolDefinitions = [
  { name: "kale.create_project", schema: createProjectArgumentsSchema },
  { name: "kale.upload_revision", schema: uploadRevisionArgumentsSchema },
  { name: "kale.create_release", schema: createReleaseArgumentsSchema },
  { name: "kale.get_release", schema: getReleaseArgumentsSchema },
  { name: "kale.approve_release", schema: approveReleaseArgumentsSchema },
  { name: "kale.rollback_release", schema: rollbackReleaseArgumentsSchema },
] as const;

export const tools = toolDefinitions.map(({ name, schema }) => ({
  name,
  schema,
  inputSchema: inputSchemaFor(
    schema,
    name === "kale.create_project" ? createProjectInputSchemaOverride : undefined,
  ),
}));

function invalidToolArguments(): ApiError {
  return new ApiError(
    400,
    "invalid_mcp_arguments",
    "The tool arguments don't match what the tool expects.",
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

function requestCancelled(requestId: string, cause: unknown): ApiError {
  return new ApiError(499, "request_cancelled", "The request was cancelled.", { cause });
}

function cancelMcpBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  requestId: string,
  reason?: unknown,
): void {
  observeDetachedCleanup(() => reader.cancel(reason), "mcp_body_cancel_failed", { requestId });
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

async function readMcpChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  requestId: string,
  cancel: (reason?: unknown) => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    const error = requestCancelled(requestId, signal.reason);
    cancel(signal.reason);
    throw error;
  }
  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const finish = (continuation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      continuation();
    };
    const onAbort = () => {
      const error = requestCancelled(requestId, signal.reason);
      cancel(signal.reason);
      finish(() => reject(error));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => finish(() => resolve(result)),
      (cause) => finish(() => reject(cause)),
    );
  });
}

export async function readMcpMessage(request: Request, requestId: string): Promise<unknown> {
  const tooLarge = () => new ApiError(413, "mcp_request_too_large", "The request is too large.");
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
  if (!request.body) throw new ApiError(400, "invalid_mcp", "The request body must be valid JSON.");

  const reader = request.body.getReader();
  const signal = request.signal ?? new AbortController().signal;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancellationStarted = false;
  const cancel = (reason?: unknown) => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    cancelMcpBody(reader, requestId, reason);
  };
  try {
    while (true) {
      const { done, value } = await readMcpChunk(reader, signal, requestId, cancel);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MCP_BODY_BYTES) {
        const error = tooLarge();
        cancel(error);
        throw error;
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new ApiError(400, "invalid_mcp", "The request body must be valid JSON.", { cause });
  }
}

function cancelMcpResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  requestId: string,
  reason?: unknown,
): void {
  observeDetachedCleanup(() => reader.cancel(reason), "mcp_response_cancel_failed", { requestId });
}

function releaseMcpResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  requestId: string,
): void {
  try {
    reader.releaseLock();
  } catch {
    emitDeployDiagnostic("mcp_response_release_failed", { requestId });
  }
}

export async function readMcpResponseText(
  response: Response,
  signal: AbortSignal,
  requestId: string,
  timeoutMs = MAX_MCP_INTERNAL_RESPONSE_MS,
  externalDeadlineSignal?: AbortSignal,
  externalDeadlineError?: ApiError,
): Promise<string> {
  if (!response.body) return "";
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_MCP_INTERNAL_RESPONSE_MS
  ) {
    throw new Error("MCP internal response timeout is outside its safe bounds.");
  }
  const reader = response.body.getReader();
  const deadlineError =
    externalDeadlineError ??
    new ApiError(504, "mcp_operation_timeout", "That took too long. Try again.");
  const deadlineController = externalDeadlineSignal ? undefined : new AbortController();
  const timeoutHandle = deadlineController
    ? setTimeout(() => deadlineController.abort(deadlineError), timeoutMs)
    : undefined;
  const readSignal = externalDeadlineSignal
    ? AbortSignal.any([signal, externalDeadlineSignal])
    : AbortSignal.any([signal, deadlineController?.signal ?? new AbortController().signal]);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  let complete = false;
  let cancellationStarted = false;
  const cancel = (reason?: unknown) => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    cancelMcpResponse(reader, requestId, reason);
  };
  try {
    while (true) {
      const { done, value } = await readMcpChunk(reader, readSignal, requestId, cancel);
      if (done) {
        complete = true;
        text += decoder.decode();
        return text;
      }
      total += value.byteLength;
      if (total > MAX_MCP_RESPONSE_BYTES) {
        const error = new ApiError(
          502,
          "mcp_response_too_large",
          "The response is too large to return.",
        );
        cancel(error);
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (!complete) cancel(error);
    if (externalDeadlineSignal?.aborted && !signal.aborted) throw deadlineError;
    if (!externalDeadlineSignal && deadlineController?.signal.aborted && !signal.aborted)
      throw deadlineError;
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    releaseMcpResponseReader(reader, requestId);
  }
}

async function errorToolResult(error: unknown, requestId: string): Promise<CallToolResult> {
  const text = await errorResponse(error, requestId).text();
  return { content: [{ type: "text", text }], isError: true };
}

async function mcpToolResult(
  response: Response,
  requestId: string,
  signal: AbortSignal,
  timeoutMs = MAX_MCP_INTERNAL_RESPONSE_MS,
  externalDeadlineSignal?: AbortSignal,
  externalDeadlineError?: ApiError,
): Promise<CallToolResult> {
  try {
    const text = await readMcpResponseText(
      response,
      signal,
      requestId,
      timeoutMs,
      externalDeadlineSignal,
      externalDeadlineError,
    );
    return { content: [{ type: "text", text }], isError: !response.ok };
  } catch (error) {
    return errorToolResult(error, requestId);
  }
}

export function createMcpApiRequest(
  requestUrl: string,
  path: string,
  method: "GET" | "POST",
  headers: Headers,
  body: BodyInit | undefined,
  signal: AbortSignal,
): Request {
  return new Request(new URL(path, requestUrl), { method, headers, body, signal });
}

interface McpOperation {
  callerSignal: AbortSignal;
  deadlineSignal: AbortSignal;
  operationSignal: AbortSignal;
  deadlineError: ApiError;
  deadlineAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

function operationTimeoutError(): ApiError {
  return new ApiError(504, "mcp_operation_timeout", "That took too long. Try again.");
}

function createMcpOperation(callerSignal: AbortSignal, deadlineMs: number): McpOperation {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_MCP_OPERATION_MS) {
    throw new Error("MCP operation deadline is outside its safe bounds.");
  }
  const deadlineController = new AbortController();
  const deadlineError = operationTimeoutError();
  const deadlineAt = Date.now() + deadlineMs;
  const timeoutHandle = setTimeout(() => deadlineController.abort(deadlineError), deadlineMs);
  const operationSignal = AbortSignal.any([callerSignal, deadlineController.signal]);
  return {
    callerSignal,
    deadlineSignal: deadlineController.signal,
    operationSignal,
    deadlineError,
    deadlineAt,
    timeoutHandle,
  };
}

function operationAbortError(operation: McpOperation, requestId: string): ApiError {
  if (operation.deadlineSignal.aborted && !operation.callerSignal.aborted) {
    return operation.deadlineError;
  }
  return requestCancelled(requestId, operation.callerSignal.reason);
}

function observeLateMcpResponse(response: Response, requestId: string, reason: unknown): void {
  if (!response.body) return;
  observeDetachedCleanup(() => response.body?.cancel(reason), "mcp_response_cancel_failed", {
    requestId,
  });
}

async function dispatchMcpApi(
  dispatch: () => Promise<Response>,
  operation: McpOperation,
  requestId: string,
): Promise<Response> {
  const dispatchPromise = Promise.resolve().then(dispatch);
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (continuation: () => void) => {
      if (settled) return;
      settled = true;
      operation.operationSignal.removeEventListener("abort", onAbort);
      continuation();
    };
    const onAbort = () => {
      finish(() => reject(operationAbortError(operation, requestId)));
    };
    if (operation.operationSignal.aborted) {
      onAbort();
    } else {
      operation.operationSignal.addEventListener("abort", onAbort, { once: true });
    }
    // Both continuations are attached immediately.  If cancellation wins,
    // the late rejection is still observed and cannot become unhandled.
    dispatchPromise.then(
      (response) => {
        if (settled) {
          observeLateMcpResponse(response, requestId, operationAbortError(operation, requestId));
          return;
        }
        finish(() => resolve(response));
      },
      (cause) => {
        if (settled) return;
        finish(() => reject(cause));
      },
    );
  });
}

async function callKaleTool(
  name: string,
  argumentsValue: unknown,
  requestUrl: string,
  env: Env,
  requestId: string,
  principal: Principal,
  signal: AbortSignal,
  operationDeadlineMs = MAX_MCP_OPERATION_MS,
): Promise<CallToolResult> {
  if (signal.aborted) return errorToolResult(requestCancelled(requestId, signal.reason), requestId);
  const operation = createMcpOperation(signal, operationDeadlineMs);
  try {
    if (operation.operationSignal.aborted)
      return errorToolResult(operationAbortError(operation, requestId), requestId);
    const headers = new Headers();
    let path: string;
    let method: "GET" | "POST" = "POST";
    let body: BodyInit | undefined;
    try {
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
        throw new ApiError(404, "mcp_tool_not_found", "That tool doesn't exist.");
      }
    } catch (error) {
      if (!apiErrorSnapshot(error)) throw error;
      return errorToolResult(error, requestId);
    }
    if (operation.operationSignal.aborted)
      return errorToolResult(operationAbortError(operation, requestId), requestId);
    let response: Response;
    try {
      response = await dispatchMcpApi(
        () =>
          handleApiForPrincipal(
            createMcpApiRequest(requestUrl, path, method, headers, body, operation.operationSignal),
            env,
            principal,
            requestId,
          ),
        operation,
        requestId,
      );
    } catch (error) {
      if (operation.callerSignal.aborted || operation.deadlineSignal.aborted) {
        return errorToolResult(operationAbortError(operation, requestId), requestId);
      }
      response = errorResponse(error, requestId);
    }
    const remainingMs = operation.deadlineAt - Date.now();
    if (remainingMs < 1) {
      // The deadline timer may not have run yet if dispatch resolved after the
      // clock deadline during a busy turn.  We still own this late response,
      // so detach and cancel its body before returning the primary timeout.
      observeLateMcpResponse(response, requestId, operation.deadlineError);
      return errorToolResult(operation.deadlineError, requestId);
    }
    return mcpToolResult(
      response,
      requestId,
      operation.callerSignal,
      remainingMs,
      operation.deadlineSignal,
      operation.deadlineError,
    );
  } finally {
    clearTimeout(operation.timeoutHandle);
  }
}

const TOOL_DESCRIPTIONS: Record<(typeof toolDefinitions)[number]["name"], string> = {
  "kale.create_project": "Create a project.",
  "kale.upload_revision": "Upload a new version of your app.",
  "kale.create_release": "Publish a version.",
  "kale.get_release": "Check on a release.",
  "kale.approve_release": "Approve a release.",
  "kale.rollback_release": "Roll back to an earlier version.",
};

function listedTools() {
  return tools.map((tool) => ({
    name: tool.name,
    description: TOOL_DESCRIPTIONS[tool.name],
    inputSchema: tool.inputSchema,
  }));
}

function legacyToolResponse(id: unknown, result: CallToolResult, requestId: string): Response {
  return Response.json(
    { jsonrpc: "2.0", id, result },
    {
      headers: {
        "X-CAIL-Request-Id": requestId,
        "x-request-id": requestId,
      },
    },
  );
}

export async function handleLegacyMcpMessage(
  parsedBody: unknown,
  requestUrl: string,
  env: Env,
  requestId: string,
  principal: Principal,
  signal: AbortSignal,
  operationDeadlineMs = MAX_MCP_OPERATION_MS,
): Promise<Response> {
  if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
    throw new ApiError(400, "invalid_mcp", "The request must be a JSON-RPC 2.0 object.");
  }
  const message = parsedBody as {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (message.jsonrpc !== "2.0")
    throw new ApiError(400, "invalid_mcp", "The request must use JSON-RPC 2.0.");
  if (message.method === "initialize") {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "Kale Deploy", version: "0.1.0" },
      },
    });
  }
  if (message.method === "tools/list") {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: listedTools() },
    });
  }
  if (message.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (message.method !== "tools/call")
    throw new ApiError(400, "unknown_mcp_method", "That method isn't supported.");
  const name = message.params?.name;
  if (typeof name !== "string") {
    return legacyToolResponse(
      message.id,
      await errorToolResult(invalidToolArguments(), requestId),
      requestId,
    );
  }
  return legacyToolResponse(
    message.id,
    await callKaleTool(
      name,
      message.params?.arguments,
      requestUrl,
      env,
      requestId,
      principal,
      signal,
      operationDeadlineMs,
    ),
    requestId,
  );
}

export function createKaleMcpServer(
  requestUrl: string,
  env: Env,
  requestId: string,
  principal: Principal,
  signal: AbortSignal,
  operationDeadlineMs = MAX_MCP_OPERATION_MS,
): Server {
  const server = new Server(
    { name: "Kale Deploy", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      supportedProtocolVersions: ["2026-07-28", "2025-06-18"],
    },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: listedTools() }));
  server.setRequestHandler("tools/call", async (request) =>
    callKaleTool(
      request.params.name,
      request.params.arguments,
      requestUrl,
      env,
      requestId,
      principal,
      signal,
      operationDeadlineMs,
    ),
  );
  return server;
}
