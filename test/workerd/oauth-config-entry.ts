import { oauthWorkerHandler } from "../../src/adapters/cloudflare/oauth";
import type { Env } from "../../src/env";

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    const scenario = new URL(request.url).searchParams.get("scenario");
    const testEnv = {
      ...env,
      PUBLIC_BASE_URL:
        scenario === "missing"
          ? undefined
          : scenario === "credentials"
            ? "https://user:secret@deploy.example"
            : "http://deploy.example",
    } as unknown as Env;
    return oauthWorkerHandler.fetch(request, testEnv, executionContext);
  },
};
