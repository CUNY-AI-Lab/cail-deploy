import {
  hostHeaderValidationResponse,
  isLegacyRequest,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Principal } from "../../auth";
import type { Env } from "../../env";
import { createKaleMcpServer, handleLegacyMcpMessage, readMcpMessage } from "../../mcp";

export async function handleMcpWithPrincipal(
  request: Request,
  env: Env,
  requestId: string,
  principal: Principal,
): Promise<Response> {
  if (typeof request.url === "string") {
    const requestHostname = new URL(request.url).hostname;
    const boundaryRejection =
      (request.headers.has("Host")
        ? hostHeaderValidationResponse(request, [requestHostname])
        : undefined) ?? originValidationResponse(request, [requestHostname]);
    if (boundaryRejection) return boundaryRejection;
  }

  const parsedBody = await readMcpMessage(request, requestId);
  const headers = new Headers(request.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json, text/event-stream");
  }
  const transportRequest = new Request(request.url, {
    method: request.method,
    headers,
    signal: request.signal,
  });
  if (await isLegacyRequest(transportRequest, parsedBody)) {
    return handleLegacyMcpMessage(parsedBody, request.url, env, requestId, principal);
  }
  const handler = createMcpHandler(
    () => createKaleMcpServer(request.url, env, requestId, principal),
    {
      route: "/mcp",
      legacy: "reject",
      corsOptions: false,
      allowedOriginHostnames: "*",
    },
  );
  return handler.fetch(transportRequest, { parsedBody });
}
