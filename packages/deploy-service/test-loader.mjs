// Node.js ESM loader that stubs `cloudflare:workers` so tests can import modules which
// depend on `@cloudflare/workers-oauth-provider`. The provider imports `WorkerEntrypoint`
// from the `cloudflare:workers` built-in, which only exists in the Workers runtime. The
// deploy-service never instantiates WorkerEntrypoint in tests (apiHandler/defaultHandler
// are plain objects with `.fetch`), so a minimal class stub is enough for module
// resolution.

const STUB_SOURCE = `
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
`;

const STUB_URL = "data:application/javascript," + encodeURIComponent(STUB_SOURCE);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: STUB_URL,
      shortCircuit: true,
      format: "module"
    };
  }
  return nextResolve(specifier, context);
}
