import { oauthWorkerHandler } from "../../src/adapters/cloudflare/oauth";
import type { Env } from "../../src/env";

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    const scenario = new URL(request.url).searchParams.get("scenario");
    // SAFETY: this gate varies only PUBLIC_BASE_URL to exercise configuration
    // rejection; all other Env fields come from the real workerd binding.
    const testEnv = {
      ...env,
      PUBLIC_BASE_URL:
        scenario === "missing"
          ? undefined
          : scenario === "credentials"
            ? "https://user:secret@deploy.example"
            : "http://deploy.example",
    } as Env;
    return oauthWorkerHandler.fetch(request, testEnv, executionContext);
  },
};
