import { handleApi } from "./api";
import { identityReady } from "./auth";
import { ApiError, errorResponse } from "./domain/errors";
import { readLoggingContext, type Env } from "./env";
import { requestIdForRequest } from "./request-id";

export const workerHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    let requestId: string = crypto.randomUUID();
    try {
      requestId = requestIdForRequest(request);
      const url = new URL(request.url);
      const loggingConfigured = readLoggingContext(env) !== null;
      if (request.method === "GET" && url.pathname === "/health") {
        // Readiness, not liveness. Reporting ok unconditionally left this
        // service in rotation through an identity outage while every
        // authenticated request failed, and made the fleet's probes disagree
        // about whether identity was healthy.
        const ready = loggingConfigured && (await identityReady(env));
        return Response.json(
          {
            ok: ready,
            status: ready ? "ready" : "not_ready",
            service: "kale-release-control-plane",
            contractRevision: "kale.release.v1",
          },
          { status: ready ? 200 : 503 },
        );
      }
      if (url.pathname.startsWith("/v1/") && !loggingConfigured) {
        throw new ApiError(
          503,
          "logging_configuration_error",
          "This service isn't available right now.",
        );
      }
      return await handleApi(request, env, requestId);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  },
};
