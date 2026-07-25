import { handleApi } from "./api";
import { identityReady } from "./auth";
import { errorResponse } from "./domain/errors";
import type { Env } from "./env";
import { requestIdForRequest } from "./request-id";

export const workerHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    let requestId: string = crypto.randomUUID();
    try {
      requestId = requestIdForRequest(request);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        // Readiness, not liveness. Reporting ok unconditionally left this
        // service in rotation through an identity outage while every
        // authenticated request failed, and made the fleet's probes disagree
        // about whether identity was healthy.
        const ready = identityReady(env);
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
      return await handleApi(request, env, requestId);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  },
};
