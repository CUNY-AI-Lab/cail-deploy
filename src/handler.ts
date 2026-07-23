import { handleApi } from "./api";
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
        return Response.json({
          ok: true,
          service: "kale-release-control-plane",
          contractRevision: "kale.release.v1",
        });
      }
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
