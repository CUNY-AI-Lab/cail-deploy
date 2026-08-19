import {
  hostHeaderValidationResponse,
  isJsonContentType,
  isLegacyRequest,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { Principal } from "../../auth";
import { apiErrorSnapshot } from "../../domain/errors";
import type { JsonValue } from "../../domain/json";
import type { Env } from "../../env";
import { createKaleMcpServer, handleLegacyMcpMessage, readMcpMessage } from "../../mcp";

function protocolError(status: number, code: number, message: string, requestId: string): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-CAIL-Request-Id": requestId,
        "X-Content-Type-Options": "nosniff",
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
  const requestUrl = z.string().url().safeParse(request.url);
  if (requestUrl.success) {
    const url = new URL(requestUrl.data);
    if (url.pathname !== "/mcp") {
      return Response.json(
        { error: { code: "route_not_found", message: "The route was not found.", requestId } },
        { status: 404 },
      );
    }
    const requestHostname = url.hostname;
    const boundaryRejection =
      (request.headers.has("Host")
        ? hostHeaderValidationResponse(request, [requestHostname])
        : undefined) ?? originValidationResponse(request, [requestHostname]);
    if (boundaryRejection) return boundaryRejection;
  }

  const accept = request.headers.get("Accept");
  if (!accept?.includes("application/json") || !accept.includes("text/event-stream")) {
    return protocolError(
      406,
      -32000,
      "Not Acceptable: Client must accept both application/json and text/event-stream",
      requestId,
    );
  }
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return protocolError(
      415,
      -32000,
      "Unsupported Media Type: Content-Type must be application/json",
      requestId,
    );
  }

  let parsedBody: JsonValue;
  try {
    parsedBody = await readMcpMessage(request, requestId);
  } catch (error) {
    if (apiErrorSnapshot(error)?.code === "invalid_mcp") {
      return protocolError(400, -32700, "Parse error: Invalid JSON", requestId);
    }
    throw error;
  }
  const transportRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
  });
  if (await isLegacyRequest(transportRequest, parsedBody)) {
    return handleLegacyMcpMessage(
      parsedBody,
      request.url,
      env,
      requestId,
      principal,
      request.signal,
    );
  }
  const handler = createMcpHandler(
    () => createKaleMcpServer(request.url, env, requestId, principal, request.signal),
    {
      route: "/mcp",
      legacy: "reject",
      corsOptions: false,
      allowedOriginHostnames: "*",
    },
  );
  return handler.fetch(transportRequest, { parsedBody });
}
