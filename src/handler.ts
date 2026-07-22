import { handleApi } from "./api";
import { errorResponse } from "./domain/errors";
import type { Env } from "./env";
import { handleMcp } from "./mcp";
import { requestIdForRequest } from "./request-id";

export const workerHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    let requestId: string = crypto.randomUUID();
    try {
      requestId = requestIdForRequest(request);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({
          ok: true,
          service: "kale-release-control-plane",
          contractRevision: "kale.release.v1",
        });
      }
      if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: new URL("/mcp", request.url).toString(),
          authorization_servers: env.CAIL_AUTHORIZATION_SERVER
            ? [env.CAIL_AUTHORIZATION_SERVER]
            : [],
          bearer_methods_supported: ["header"],
        });
      }
      if (request.method === "POST" && url.pathname === "/mcp")
        return await handleMcp(request, env, requestId);
      return await handleApi(request, env, requestId);
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith("X-CAIL-Request-Id")) {
        return Response.json(
          {
            error: {
              code: "invalid_request_id",
              message: "X-CAIL-Request-Id must be a UUID.",
              requestId,
            },
          },
          { status: 400 },
        );
      }
      return errorResponse(error, requestId);
    }
  },
};
