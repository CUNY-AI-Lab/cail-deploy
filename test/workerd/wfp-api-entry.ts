interface Env {
  STATE: KVNamespace;
}

type ResponseMode =
  | "http-503"
  | "identity-mismatch"
  | "invalid-utf8"
  | "malformed-json"
  | "oversized"
  | "stalled"
  | "success-false"
  | "valid"
  | "valid-without-id";

interface ControlState {
  errors: string[];
  observations: PublicationObservation[];
  responseModes: ResponseMode[];
}

interface PublicationObservation {
  call: number;
  accountId: string;
  namespace: string;
  scriptName: string;
  authorizationAccepted: boolean;
  mainModule: string;
  revisionId: string;
  moduleNames: string[];
  moduleSha256: Record<string, string>;
  responseMode: ResponseMode;
  responseStatus: number;
}

const CONTROL_HEADER = "x-kale-wfp-test-control";
const CONTROL_TOKEN = "local-e2e-control";
const STATE_KEY = "state";
const API_PATTERN =
  /^\/client\/v4\/accounts\/([^/]+)\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)$/u;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function state(env: Env): Promise<ControlState> {
  return (
    (await env.STATE.get<ControlState>(STATE_KEY, "json")) ?? {
      errors: [],
      observations: [],
      responseModes: [],
    }
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function providerEnvelope(
  success: boolean,
  result: unknown,
  errors: unknown[] = [],
): Record<string, unknown> {
  return { success, result, errors, messages: [] };
}

async function control(request: Request, env: Env): Promise<Response> {
  if (request.headers.get(CONTROL_HEADER) !== CONTROL_TOKEN) {
    return json({ error: "forbidden" }, 403);
  }
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/__control/reset") {
    const input = (await request.json()) as { responseModes?: unknown };
    const acceptedModes = new Set<ResponseMode>([
      "http-503",
      "identity-mismatch",
      "invalid-utf8",
      "malformed-json",
      "oversized",
      "stalled",
      "success-false",
      "valid",
      "valid-without-id",
    ]);
    if (
      !Array.isArray(input.responseModes) ||
      !input.responseModes.every(
        (value): value is ResponseMode =>
          typeof value === "string" && acceptedModes.has(value as ResponseMode),
      )
    ) {
      return json({ error: "invalid_control" }, 400);
    }
    const next: ControlState = {
      errors: [],
      observations: [],
      responseModes: input.responseModes,
    };
    await env.STATE.put(STATE_KEY, JSON.stringify(next));
    return json(next);
  }
  if (request.method === "GET" && url.pathname === "/__control/state") {
    return json(await state(env));
  }
  return json({ error: "not_found" }, 404);
}

async function publish(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const current = await state(env);
  const reject = async (message: string, status: number, code: number): Promise<Response> => {
    current.errors.push(message);
    await env.STATE.put(STATE_KEY, JSON.stringify(current));
    return json(providerEnvelope(false, null, [{ code, message }]), status);
  };
  const match = url.pathname.match(API_PATTERN);
  if (!match?.[1] || !match[2] || !match[3]) {
    return reject(`unexpected URL ${request.method} ${request.url}`, 404, 7003);
  }
  const call = current.observations.length + 1;
  const authorizationAccepted =
    request.headers.get("authorization") === "Bearer local-contract-token";
  if (
    request.method !== "PUT" ||
    url.origin !== "https://api.cloudflare.com" ||
    match[1] !== "integration-account" ||
    match[2] !== "integration-namespace" ||
    !/^kp-integration-local-e2e-[0-9a-f]{12}$/u.test(match[3]) ||
    !authorizationAccepted
  ) {
    return reject(
      `invalid request ${request.method} ${request.url} auth=${String(request.headers.get("authorization"))}`,
      403,
      10000,
    );
  }

  const form = await request.formData();
  const metadataPart = form.get("metadata");
  if (
    !metadataPart ||
    typeof metadataPart === "string" ||
    metadataPart.type !== "application/json"
  ) {
    return reject(
      `invalid metadata part type=${typeof metadataPart === "string" ? "string" : metadataPart?.type}`,
      400,
      10001,
    );
  }
  const metadata = JSON.parse(await metadataPart.text()) as {
    main_module?: unknown;
    compatibility_date?: unknown;
    compatibility_flags?: unknown;
    bindings?: unknown;
  };
  const revisionBinding =
    Array.isArray(metadata.bindings) &&
    metadata.bindings.length === 1 &&
    typeof metadata.bindings[0] === "object" &&
    metadata.bindings[0] !== null
      ? (metadata.bindings[0] as Record<string, unknown>)
      : undefined;
  if (
    typeof metadata.main_module !== "string" ||
    typeof metadata.compatibility_date !== "string" ||
    !Array.isArray(metadata.compatibility_flags) ||
    !metadata.compatibility_flags.every((value) => typeof value === "string") ||
    revisionBinding?.type !== "plain_text" ||
    revisionBinding.name !== "KALE_REVISION_ID" ||
    typeof revisionBinding.text !== "string"
  ) {
    return reject(`invalid worker metadata ${JSON.stringify(metadata)}`, 400, 10002);
  }

  const modules = [...form.entries()]
    .filter(([name]) => name !== "metadata")
    .sort(([left], [right]) => left.localeCompare(right));
  if (
    modules.length === 0 ||
    !modules.some(([name]) => name === metadata.main_module) ||
    modules.some(
      ([, value]) => typeof value === "string" || value.type !== "application/javascript+module",
    )
  ) {
    return reject(
      `invalid modules names=${modules.map(([name]) => name).join(",")} main=${metadata.main_module}`,
      400,
      10003,
    );
  }
  const moduleSha256 = Object.fromEntries(
    await Promise.all(
      modules.map(async ([name, value]) => [name, await sha256(await (value as File).text())]),
    ),
  );
  const responseMode = current.responseModes[call - 1] ?? "valid";
  const responseStatus = responseMode === "http-503" ? 503 : 200;
  const observation: PublicationObservation = {
    call,
    accountId: match[1],
    namespace: match[2],
    scriptName: match[3],
    authorizationAccepted,
    mainModule: metadata.main_module,
    revisionId: revisionBinding.text,
    moduleNames: modules.map(([name]) => name),
    moduleSha256,
    responseMode,
    responseStatus,
  };
  current.observations.push(observation);
  await env.STATE.put(STATE_KEY, JSON.stringify(current));
  if (responseMode === "http-503") {
    return json(
      providerEnvelope(false, null, [
        { code: 10049, message: "simulated ambiguous provider result" },
      ]),
      responseStatus,
    );
  }
  if (responseMode === "success-false") {
    return json(
      providerEnvelope(false, null, [{ code: 10049, message: "simulated false result" }]),
    );
  }
  if (responseMode === "malformed-json") {
    return new Response("{", {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (responseMode === "invalid-utf8") {
    return new Response(new Uint8Array([0xc3, 0x28]), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (responseMode === "oversized") {
    return json({
      ...providerEnvelope(true, {
        id: match[3],
        startup_time_ms: 1,
      }),
      padding: "x".repeat(1024 * 1024),
    });
  }
  if (responseMode === "stalled") {
    return new Response(new ReadableStream<Uint8Array>(), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (responseMode === "identity-mismatch") {
    return json(
      providerEnvelope(true, {
        id: "wrong-script-name",
        startup_time_ms: 1,
      }),
    );
  }
  return json(
    providerEnvelope(true, {
      etag: `local-${call}`,
      startup_time_ms: 1,
      ...(responseMode === "valid-without-id" ? {} : { id: match[3] }),
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__control/")) {
      return control(request, env);
    }
    return publish(request, env);
  },
};
