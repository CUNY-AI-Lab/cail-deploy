import assert from "node:assert/strict";
import test from "node:test";

import gatewayWorker from "./index";

type ProjectRow = {
  project_name: string;
  owner_login: string;
  github_repo: string;
  description: string | null;
  deployment_url: string;
  runtime_lane: "dedicated_worker" | "shared_static" | "shared_app";
  artifact_prefix: string | null;
  archive_kind: "none" | "manifest" | "full" | null;
  manifest_key: string | null;
  created_at: string;
  updated_at: string;
};

test("shared static projects serve archived index pages without dispatching a worker", async () => {
  const archive = new FakeArchiveBucket();
  const project = createSharedStaticProjectRow("dep-index");
  archive.putJson(project.manifest_key!, {
    staticAssets: [
      {
        path: "/index.html",
        partName: "asset-0",
        contentType: "text/html; charset=utf-8"
      }
    ],
    metadata: {
      staticAssets: {
        config: {
          html_handling: "auto-trailing-slash"
        }
      }
    }
  });
  archive.putText(`${project.artifact_prefix}/assets/index.html`, "<h1>Shared Static</h1>", "text/html; charset=utf-8");
  const dispatcher = new FakeDispatchNamespace();

  const response = await fetchGateway("https://shared-site.cuny.qzz.io/", {
    CONTROL_PLANE_DB: new FakeD1Database(project),
    DEPLOYMENT_ARCHIVE: archive,
    DISPATCHER: dispatcher
  });

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Shared Static/);
  assert.equal(dispatcher.calls, 0);
});

test("shared static projects honor auto trailing slash redirects", async () => {
  const archive = new FakeArchiveBucket();
  const project = createSharedStaticProjectRow("dep-docs");
  archive.putJson(project.manifest_key!, {
    staticAssets: [
      {
        path: "/docs/index.html",
        partName: "asset-0",
        contentType: "text/html; charset=utf-8"
      }
    ],
    metadata: {
      staticAssets: {
        config: {
          html_handling: "auto-trailing-slash"
        }
      }
    }
  });
  archive.putText(`${project.artifact_prefix}/assets/docs/index.html`, "<h1>Docs</h1>", "text/html; charset=utf-8");

  const response = await fetchGateway("https://shared-site.cuny.qzz.io/docs", {
    CONTROL_PLANE_DB: new FakeD1Database(project),
    DEPLOYMENT_ARCHIVE: archive,
    DISPATCHER: new FakeDispatchNamespace()
  });

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "https://shared-site.cuny.qzz.io/docs/");
});

test("shared static projects serve configured 404 pages and reject non-GET methods", async () => {
  const archive = new FakeArchiveBucket();
  const project = createSharedStaticProjectRow("dep-404");
  archive.putJson(project.manifest_key!, {
    staticAssets: [
      {
        path: "/404.html",
        partName: "asset-404",
        contentType: "text/html; charset=utf-8"
      }
    ],
    metadata: {
      staticAssets: {
        config: {
          html_handling: "auto-trailing-slash",
          not_found_handling: "404-page"
        }
      }
    }
  });
  archive.putText(`${project.artifact_prefix}/assets/404.html`, "<h1>Missing</h1>", "text/html; charset=utf-8");
  const env = {
    CONTROL_PLANE_DB: new FakeD1Database(project),
    DEPLOYMENT_ARCHIVE: archive,
    DISPATCHER: new FakeDispatchNamespace()
  };

  const missingResponse = await fetchGateway("https://shared-site.cuny.qzz.io/missing-page", env);
  assert.equal(missingResponse.status, 404);
  assert.match(await missingResponse.text(), /Missing/);

  const postResponse = await fetchGateway("https://shared-site.cuny.qzz.io/", env, { method: "POST" });
  assert.equal(postResponse.status, 405);
  assert.equal(postResponse.headers.get("allow"), "GET, HEAD");
});

test("shared static projects return empty 404s when no custom 404 page exists", async () => {
  const archive = new FakeArchiveBucket();
  const project = createSharedStaticProjectRow("dep-empty-404");
  archive.putJson(project.manifest_key!, {
    staticAssets: [
      {
        path: "/index.html",
        partName: "asset-0",
        contentType: "text/html; charset=utf-8"
      }
    ],
    metadata: {
      staticAssets: {
        config: {
          html_handling: "auto-trailing-slash"
        }
      }
    }
  });
  archive.putText(`${project.artifact_prefix}/assets/index.html`, "<h1>Shared Static</h1>", "text/html; charset=utf-8");

  const response = await fetchGateway("https://shared-site.cuny.qzz.io/api/health", {
    CONTROL_PLANE_DB: new FakeD1Database(project),
    DEPLOYMENT_ARCHIVE: archive,
    DISPATCHER: new FakeDispatchNamespace()
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-kale-gateway-miss"), null);
  assert.equal(await response.text(), "");
});

test("unknown project 404s include a gateway miss marker", async () => {
  const response = await fetchGateway("https://missing-project.cuny.qzz.io/", {
    CONTROL_PLANE_DB: new FakeD1Database(null),
    DEPLOYMENT_ARCHIVE: new FakeArchiveBucket(),
    DISPATCHER: new FakeDispatchNamespace()
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-kale-gateway-miss"), "project-unknown");
});

test("preview route dispatches to the requested script with public-origin headers", async () => {
  const dispatcher = new FakeDispatchNamespace(async (request) => new Response(JSON.stringify({
    url: request.url,
    publicOrigin: request.headers.get("x-cail-public-origin"),
    projectName: request.headers.get("x-cail-project-name"),
    basePath: request.headers.get("x-cail-base-path"),
    auth: request.headers.get("authorization")
  }), {
    headers: { "content-type": "application/json" }
  }));

  const response = await fetchGateway(
    "https://gateway.example/__kale_preview/shared-site/preview-script/docs?draft=1",
    {
      CONTROL_PLANE_DB: new FakeD1Database(null),
      DEPLOYMENT_ARCHIVE: new FakeArchiveBucket(),
      DISPATCHER: dispatcher
    },
    {
      headers: {
        authorization: "Bearer preview-token",
        "x-kale-preview-deployment-url": "https://shared-site.cuny.qzz.io",
        "x-kale-preview-requested-label": "shared-site",
        "x-kale-preview-routing-mode": "host"
      }
    }
  );

  assert.equal(response.status, 200);
  const body = await response.json() as {
    url: string;
    publicOrigin: string | null;
    projectName: string | null;
    basePath: string | null;
    auth: string | null;
  };
  assert.equal(dispatcher.scriptNames[0], "preview-script");
  assert.equal(body.url, "https://shared-site.cuny.qzz.io/docs?draft=1");
  assert.equal(body.publicOrigin, "https://shared-site.cuny.qzz.io");
  assert.equal(body.projectName, "shared-site");
  assert.equal(body.basePath, "/");
  assert.equal(body.auth, null);
});

test("preview route requires a valid bearer token", async () => {
  const response = await fetchGateway(
    "https://gateway.example/__kale_preview/shared-site/preview-script/",
    {
      CONTROL_PLANE_DB: new FakeD1Database(null),
      DEPLOYMENT_ARCHIVE: new FakeArchiveBucket(),
      DISPATCHER: new FakeDispatchNamespace()
    }
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
});

function createSharedStaticProjectRow(deploymentId: string): ProjectRow {
  return {
    project_name: "shared-site",
    owner_login: "szweibel",
    github_repo: "szweibel/shared-site",
    description: null,
    deployment_url: "https://shared-site.cuny.qzz.io",
    runtime_lane: "shared_static",
    artifact_prefix: `deployments/shared-site/${deploymentId}`,
    archive_kind: "full",
    manifest_key: `deployments/shared-site/${deploymentId}/manifest.json`,
    created_at: "2026-04-01T12:00:00.000Z",
    updated_at: "2026-04-01T12:00:00.000Z"
  };
}

async function fetchGateway(
  url: string,
  envOverrides: {
    CONTROL_PLANE_DB: FakeD1Database;
    DEPLOYMENT_ARCHIVE: FakeArchiveBucket;
    DISPATCHER: FakeDispatchNamespace;
  },
  init?: RequestInit
): Promise<Response> {
  const env = {
    CONTROL_PLANE_DB: envOverrides.CONTROL_PLANE_DB as unknown as D1Database,
    DEPLOYMENT_ARCHIVE: envOverrides.DEPLOYMENT_ARCHIVE as unknown as R2Bucket,
    DISPATCHER: envOverrides.DISPATCHER as unknown as DispatchNamespace,
    PLATFORM_BASE_URL: "https://gateway.example",
    INSTALL_URL: "https://cuny.qzz.io/kale/github/install",
    GATEWAY_PREVIEW_TOKEN: "preview-token",
    PROJECT_HOST_SUFFIX: "cuny.qzz.io",
    PROJECT_CPU_LIMIT_MS: "100",
    PROJECT_SUBREQUEST_LIMIT: "100"
  };

  return gatewayWorker.fetch(new Request(url, init), env, {
    passThroughOnException() {},
    props: {},
    waitUntil() {}
  } as unknown as ExecutionContext);
}

class FakeD1Database {
  constructor(private readonly project: ProjectRow | null) {}

  withSession(): this {
    return this;
  }

  prepare(sql: string): FakePreparedStatement {
    return new FakePreparedStatement(this.project, sql);
  }
}

class FakePreparedStatement {
  private params: unknown[] = [];

  constructor(
    private readonly project: ProjectRow | null,
    private readonly sql: string
  ) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const normalized = this.sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalized.includes("from project_domains")) {
      return null;
    }

    if (
      normalized.includes("from projects")
      && normalized.includes("left join deployments")
      && this.project
      && String(this.params[0]) === this.project.project_name
    ) {
      return this.project as T;
    }

    return null;
  }
}

class FakeDispatchNamespace {
  calls = 0;
  readonly scriptNames: string[] = [];

  constructor(
    private readonly handler: (request: Request) => Promise<Response> = async () => new Response("worker-response")
  ) {}

  get(scriptName: string) {
    this.calls += 1;
    this.scriptNames.push(scriptName);
    return {
      fetch: this.handler
    };
  }
}

class FakeArchiveBucket {
  private readonly objects = new Map<string, {
    body: ArrayBuffer;
    contentType?: string;
  }>();

  putJson(key: string, value: unknown): void {
    this.putText(key, JSON.stringify(value), "application/json");
  }

  putText(key: string, value: string, contentType?: string): void {
    this.objects.set(key, {
      body: new TextEncoder().encode(value).buffer,
      contentType
    });
  }

  async get(key: string): Promise<{
    body: ReadableStream<Uint8Array>;
    httpEtag: string;
    size: number;
    text(): Promise<string>;
    writeHttpMetadata(headers: Headers): void;
  } | null> {
    const entry = this.objects.get(key);
    if (!entry) {
      return null;
    }

    return {
      body: new Blob([entry.body]).stream(),
      httpEtag: `"${key}"`,
      size: entry.body.byteLength,
      async text() {
        return new TextDecoder().decode(entry.body);
      },
      writeHttpMetadata(headers: Headers) {
        if (entry.contentType) {
          headers.set("content-type", entry.contentType);
        }
      }
    };
  }
}
