import { describe, expect, test, vi } from "vitest";
import { appendReleaseStatus, appendTerminalStatus } from "../../src/storage";
import { publishWorker, publicationName } from "../../src/adapters/cloudflare/wfp";
import type { Env, ReleaseWorkflowParams } from "../../src/env";
import { ReleaseWorkflow } from "../../src/workflow";

const projectId = `prj_${"7".repeat(32)}`;
const revisionId = `rev_sha256_${"8".repeat(64)}`;
const sourceReleaseId = `rel_${"9".repeat(31)}a`;
const rollbackReleaseId = `rel_${"9".repeat(31)}b`;
const requestId = "77777777-7777-4777-8777-777777777777";
const now = "2026-08-01T00:00:00.000Z";
const preparedKey = `prepared/${projectId}/${sourceReleaseId}/fixture.json`;
const preparedDigest = "39ecdb36dd53fa72b36e940ea1a630da26c20600bee94d30a7ccc0f05748554d";

interface MemoryRelease {
  release_id: string;
  project_id: string;
  revision_id: string;
  target: "preview";
  approval: "automatic";
  status: string;
  workflow_instance_id: string;
  prepared_key: string | null;
  prepared_digest: string | null;
  publication_name: string | null;
  rollback_of_release_id: string | null;
  approved_by_subject: string | null;
  operational_subject: string | null;
  request_id: string;
  admitted_at: string;
  created_at: string;
  updated_at: string;
}

interface MemoryStatement {
  query: string;
  values: unknown[];
}

class MemoryD1 {
  readonly releases = new Map<string, MemoryRelease>();
  readonly events = new Map<string, string[]>();
  afterTransition: ((type: string) => Promise<void>) | undefined;

  prepare(query: string) {
    const db = this;
    return {
      bind(...values: unknown[]): MemoryStatement & {
        first<T>(): Promise<T | null>;
        all<T>(): Promise<{ results: T[] }>;
        run(): Promise<{ meta: { changes: number } }>;
      } {
        const statement: MemoryStatement & {
          first<T>(): Promise<T | null>;
          all<T>(): Promise<{ results: T[] }>;
          run(): Promise<{ meta: { changes: number } }>;
        } = {
          query,
          values,
          async first<T>() {
            if (query.includes("FROM revisions")) {
              return {
                project_id: projectId,
                revision_id: revisionId,
                artifact_digest: "27f7b3925cee0332e3e827bac24d88941b62ba3e24efe4f99efcd1ec0ca336df",
                artifact_bytes: 1,
                artifact_key: `revisions/${projectId}/${revisionId}.json`,
                status: "ready",
                created_at: now,
              } as T;
            }
            if (query.includes("terminal_outcome")) {
              const releaseId = String(values[0]);
              const release = db.releases.get(releaseId);
              if (!release) return null;
              return {
                terminal_outcome:
                  ["live", "failed", "rejected"].includes(release.status) ||
                  (db.events.get(releaseId) ?? []).some((event) =>
                    ["release.live", "release.failed", "release.rejected"].includes(event),
                  )
                    ? 1
                    : 0,
              } as T;
            }
            if (query.includes("FROM releases") && query.includes("EXISTS")) {
              const releaseId = String(values.at(-1));
              const release = db.releases.get(releaseId);
              if (!release) return null;
              const type = String(values[1]);
              return {
                status: release.status,
                matching_event: db.events.get(releaseId)?.includes(type) ? 1 : 0,
                terminal_event: db.events
                  .get(releaseId)
                  ?.some((event) =>
                    ["release.live", "release.failed", "release.rejected"].includes(event),
                  )
                  ? 1
                  : 0,
              } as T;
            }
            if (query.includes("FROM releases")) {
              const releaseId = String(values.at(-1));
              return (db.releases.get(releaseId) as T | undefined) ?? null;
            }
            throw new Error(`Unexpected first query: ${query}`);
          },
          async all<T>() {
            const releaseId = String(values[0]);
            return {
              results: (db.events.get(releaseId) ?? []).map((type) => ({ type }) as T),
            };
          },
          async run() {
            if (query.includes("publication_name")) {
              const releaseId = String(values.at(-1));
              const release = db.releases.get(releaseId);
              if (
                !release ||
                release.status !== "publishing" ||
                (db.events.get(releaseId) ?? []).some((event) =>
                  ["release.live", "release.failed", "release.rejected"].includes(event),
                )
              )
                return { meta: { changes: 0 } };
              release.publication_name = String(values[0]);
              release.updated_at = String(values[1]);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
        return statement;
      },
    };
  }

  async batch(statements: MemoryStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const results: Array<{ meta: { changes: number } }> = [];
    for (const statement of statements) {
      if (statement.query.includes("SET status = ?")) {
        const releaseId = String(
          [...this.releases.keys()].find((value) => statement.values.includes(value)),
        );
        const release = this.releases.get(releaseId);
        const nextStatus = String(statement.values[0]);
        const transitionType = String(statement.values.at(-1));
        const terminal = this.events
          .get(releaseId)
          ?.some((event) => ["release.live", "release.failed", "release.rejected"].includes(event));
        const matching = this.events.get(releaseId)?.includes(transitionType);
        const predecessorValues = statement.values.slice(3, -4).map(String);
        if (
          release &&
          !terminal &&
          !["live", "failed", "rejected"].includes(release.status) &&
          !matching &&
          predecessorValues.includes(release.status)
        ) {
          release.status = nextStatus;
          release.updated_at = String(statement.values[1]);
          const preparedKey = statement.values.find((value) => value === preparedKeyValue);
          if (typeof preparedKey === "string") release.prepared_key = preparedKey;
          const digest = statement.values.find((value) => value === preparedDigest);
          if (typeof digest === "string") release.prepared_digest = digest;
          results.push({ meta: { changes: 1 } });
        } else {
          results.push({ meta: { changes: 0 } });
        }
      } else if (statement.query.includes("INSERT INTO release_events")) {
        const releaseId = String(statement.values[0]);
        const eventType = String(statement.values[2]);
        const previous = results.at(-1)?.meta.changes === 1;
        if (previous) {
          this.events.get(releaseId)?.push(eventType);
          results.push({ meta: { changes: 1 } });
        } else {
          results.push({ meta: { changes: 0 } });
        }
      } else {
        results.push({ meta: { changes: 0 } });
      }
    }
    const transition = statements.find((statement) => statement.query.includes("SET status = ?"));
    if (transition && results[0]?.meta.changes === 1 && this.afterTransition) {
      const transitionType = String(transition.values.at(-1));
      await this.afterTransition(transitionType);
    }
    return results;
  }
}

const preparedKeyValue = preparedKey;

class MemoryBucket {
  readonly values = new Map<string, string>();
  readonly getCalls: string[] = [];
  beforeGet: ((key: string, count: number) => Promise<void>) | undefined;

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async get(
    key: string,
  ): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null> {
    this.getCalls.push(key);
    if (this.beforeGet)
      await this.beforeGet(key, this.getCalls.filter((value) => value === key).length);
    const value = this.values.get(key);
    if (value === undefined) return null;
    return {
      text: async () => value,
      arrayBuffer: async () => new TextEncoder().encode(value).buffer,
    };
  }
}

const preparedJson = JSON.stringify({
  schemaVersion: "kale.prepared-worker.v1",
  projectId,
  releaseId: sourceReleaseId,
  revisionId,
  mainModule: "index.js",
  modules: { "index.js": "export default {}" },
  compatibilityDate: "2026-07-22",
  compatibilityFlags: [],
});
const artifactJson = `${JSON.stringify({
  schemaVersion: "kale.artifact.v1",
  runtime: "worker",
  entrypoint: "src/index.ts",
  files: { "src/index.ts": "export default {}" },
  compatibility: { date: "2026-07-22", flags: [] },
  requestedBindings: [],
})}\n`;

const terminalReplayReleaseId = `rel_${"9".repeat(31)}c`;
const buildingReplayReleaseId = `rel_${"9".repeat(31)}d`;
const eventOnlyTerminalReplayReleaseId = `rel_${"9".repeat(31)}e`;

function seedFixture(db: MemoryD1, bucket: MemoryBucket): void {
  bucket.values.set(`revisions/${projectId}/${revisionId}.json`, artifactJson);
  bucket.values.set(preparedKey, preparedJson);
  db.releases.set(sourceReleaseId, {
    release_id: sourceReleaseId,
    project_id: projectId,
    revision_id: revisionId,
    target: "preview",
    approval: "automatic",
    status: "live",
    workflow_instance_id: sourceReleaseId,
    prepared_key: preparedKey,
    prepared_digest: preparedDigest,
    publication_name: "kp-workflow-fence-source",
    rollback_of_release_id: null,
    approved_by_subject: null,
    operational_subject: null,
    request_id: requestId,
    admitted_at: now,
    created_at: now,
    updated_at: now,
  });
  db.events.set(sourceReleaseId, ["release.live"]);
  db.releases.set(rollbackReleaseId, {
    release_id: rollbackReleaseId,
    project_id: projectId,
    revision_id: revisionId,
    target: "preview",
    approval: "automatic",
    status: "queued",
    workflow_instance_id: rollbackReleaseId,
    prepared_key: null,
    prepared_digest: null,
    publication_name: null,
    rollback_of_release_id: sourceReleaseId,
    approved_by_subject: null,
    operational_subject: null,
    request_id: requestId,
    admitted_at: now,
    created_at: now,
    updated_at: now,
  });
  db.events.set(rollbackReleaseId, ["release.queued"]);
}

function seedTerminalReplay(db: MemoryD1): void {
  db.releases.set(terminalReplayReleaseId, {
    release_id: terminalReplayReleaseId,
    project_id: projectId,
    revision_id: revisionId,
    target: "preview",
    approval: "automatic",
    status: "live",
    workflow_instance_id: terminalReplayReleaseId,
    prepared_key: null,
    prepared_digest: null,
    publication_name: "kp-workflow-fence-terminal",
    rollback_of_release_id: null,
    approved_by_subject: null,
    operational_subject: null,
    request_id: requestId,
    admitted_at: now,
    created_at: now,
    updated_at: now,
  });
  db.events.set(terminalReplayReleaseId, ["release.live"]);
}

function seedEventOnlyTerminalReplay(db: MemoryD1): void {
  db.releases.set(eventOnlyTerminalReplayReleaseId, {
    release_id: eventOnlyTerminalReplayReleaseId,
    project_id: projectId,
    revision_id: revisionId,
    target: "preview",
    approval: "automatic",
    status: "reconciling",
    workflow_instance_id: eventOnlyTerminalReplayReleaseId,
    prepared_key: null,
    prepared_digest: null,
    publication_name: null,
    rollback_of_release_id: null,
    approved_by_subject: null,
    operational_subject: null,
    request_id: requestId,
    admitted_at: now,
    created_at: now,
    updated_at: now,
  });
  db.events.set(eventOnlyTerminalReplayReleaseId, ["release.live"]);
}

function seedQueuedBuild(db: MemoryD1): void {
  db.releases.set(buildingReplayReleaseId, {
    release_id: buildingReplayReleaseId,
    project_id: projectId,
    revision_id: revisionId,
    target: "preview",
    approval: "automatic",
    status: "queued",
    workflow_instance_id: buildingReplayReleaseId,
    prepared_key: null,
    prepared_digest: null,
    publication_name: null,
    rollback_of_release_id: null,
    approved_by_subject: null,
    operational_subject: null,
    request_id: requestId,
    admitted_at: now,
    created_at: now,
    updated_at: now,
  });
  db.events.set(buildingReplayReleaseId, ["release.queued"]);
}

describe("release Workflow terminal replay fence", () => {
  test("a paused publication step resumes after reconciliation without republishing", async () => {
    const db = new MemoryD1();
    const bucket = new MemoryBucket();
    seedFixture(db, bucket);
    const workflowEnv = {
      DB: db,
      ARTIFACTS: bucket,
      RUN_ID: "workflow-fence",
      WFP_ACCOUNT_ID: "account",
      WFP_NAMESPACE: "namespace",
      WFP_PUBLISH_TIMEOUT_MS: "1000",
      CLOUDFLARE_API_TOKEN: "test-only",
    } as unknown as Env;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    let releasePublicationStep: (() => void) | undefined;
    const publicationReached = new Promise<void>((resolve) => {
      releasePublicationStep = resolve;
    });
    let openPublication: (() => void) | undefined;
    const publicationGate = new Promise<void>((resolve) => {
      openPublication = resolve;
    });
    const step = {
      async do(name: string, ...options: unknown[]) {
        const callback = options.find(
          (option): option is () => Promise<unknown> => typeof option === "function",
        );
        if (!callback) throw new Error(`Missing callback for ${name}.`);
        if (name === "publish prepared worker") {
          releasePublicationStep?.();
          await publicationGate;
        }
        return callback();
      },
    };
    const params: ReleaseWorkflowParams = {
      projectId,
      releaseId: rollbackReleaseId,
      revisionId,
      requestId,
      admittedAt: now,
    };
    const runPromise = ReleaseWorkflow.prototype.run.call(
      { env: workflowEnv } as ReleaseWorkflow,
      { payload: params },
      step as never,
    );
    await publicationReached;

    expect(await appendTerminalStatus(workflowEnv, rollbackReleaseId, "live", "release.live")).toBe(
      true,
    );
    openPublication?.();
    await runPromise;
    expect(fetchSpy).not.toHaveBeenCalled();

    const replayStep = {
      async do(_name: string, ...options: unknown[]) {
        const callback = options.find(
          (option): option is () => Promise<unknown> => typeof option === "function",
        );
        if (!callback) throw new Error("Missing replay callback.");
        return callback();
      },
    };
    await ReleaseWorkflow.prototype.run.call(
      { env: workflowEnv } as ReleaseWorkflow,
      { payload: params },
      replayStep as never,
    );

    expect(db.releases.get(rollbackReleaseId)).toMatchObject({
      status: "live",
      prepared_key: preparedKey,
      prepared_digest: preparedDigest,
      publication_name: null,
    });
    expect(db.events.get(rollbackReleaseId)).toEqual([
      "release.queued",
      "release.validating",
      "release.prepared",
      "release.live",
    ]);
    expect(db.releases.get(sourceReleaseId)).toMatchObject({
      status: "live",
      prepared_key: preparedKey,
      prepared_digest: preparedDigest,
      publication_name: "kp-workflow-fence-source",
    });
    fetchSpy.mockRestore();
  });

  test("a stale non-rollback replay with legacy validating output performs no side effects", async () => {
    const db = new MemoryD1();
    const bucket = new MemoryBucket();
    seedFixture(db, bucket);
    seedTerminalReplay(db);
    const workflowEnv = {
      DB: db,
      ARTIFACTS: bucket,
      RUN_ID: "workflow-fence",
      WFP_ACCOUNT_ID: "account",
      WFP_NAMESPACE: "namespace",
      WFP_PUBLISH_TIMEOUT_MS: "1000",
      CLOUDFLARE_API_TOKEN: "test-only",
    } as unknown as Env;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const step = {
      async do(name: string) {
        if (name === "mark validating") return undefined;
        throw new Error(`Unexpected replay step ${name}.`);
      },
    };

    await ReleaseWorkflow.prototype.run.call(
      { env: workflowEnv } as ReleaseWorkflow,
      {
        payload: {
          projectId,
          releaseId: terminalReplayReleaseId,
          revisionId,
          requestId,
          admittedAt: now,
        },
      },
      step as never,
    );

    expect(bucket.getCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.releases.get(terminalReplayReleaseId)?.status).toBe("live");
    fetchSpy.mockRestore();
  });

  test("an event-only terminal replay skips loader, R2, and provider side effects", async () => {
    const db = new MemoryD1();
    const bucket = new MemoryBucket();
    seedFixture(db, bucket);
    seedEventOnlyTerminalReplay(db);
    const workflowEnv = {
      DB: db,
      ARTIFACTS: bucket,
      RUN_ID: "workflow-fence",
      WFP_ACCOUNT_ID: "account",
      WFP_NAMESPACE: "namespace",
      WFP_PUBLISH_TIMEOUT_MS: "1000",
      CLOUDFLARE_API_TOKEN: "test-only",
    } as unknown as Env;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const loader = {
      load() {
        throw new Error("Loader must not run for an event-only terminal release.");
      },
    };
    const step = {
      async do(name: string) {
        if (name === "mark validating") return undefined;
        throw new Error(`Unexpected event-only replay step ${name}.`);
      },
    };

    await ReleaseWorkflow.prototype.run.call(
      { env: { ...workflowEnv, LOADER: loader } as unknown as Env } as ReleaseWorkflow,
      {
        payload: {
          projectId,
          releaseId: eventOnlyTerminalReplayReleaseId,
          revisionId,
          requestId,
          admittedAt: now,
        },
      },
      step as never,
    );

    expect(bucket.getCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.releases.get(eventOnlyTerminalReplayReleaseId)?.status).toBe("reconciling");
    expect(db.events.get(eventOnlyTerminalReplayReleaseId)).toEqual(["release.live"]);
    fetchSpy.mockRestore();
  });

  test("legacy prepared and approval outputs recheck terminal D1 state without repeating writes", async () => {
    const scenarios = ["record prepared artifact", "mark awaiting approval"] as const;
    for (const legacyStep of scenarios) {
      const db = new MemoryD1();
      const bucket = new MemoryBucket();
      seedFixture(db, bucket);
      const rollback = db.releases.get(rollbackReleaseId);
      if (!rollback) throw new Error("Rollback fixture missing.");
      if (legacyStep === "mark awaiting approval") rollback.approval = "required";
      const workflowEnv = {
        DB: db,
        ARTIFACTS: bucket,
        RUN_ID: "workflow-fence",
        WFP_ACCOUNT_ID: "account",
        WFP_NAMESPACE: "namespace",
        WFP_PUBLISH_TIMEOUT_MS: "1000",
        CLOUDFLARE_API_TOKEN: "test-only",
      } as unknown as Env;
      const step = {
        async do(name: string, ...options: unknown[]) {
          const callback = options.find(
            (option): option is () => Promise<unknown> => typeof option === "function",
          );
          if (!callback) throw new Error(`Missing callback for ${name}.`);
          if (name === "reuse retained rollback artifact") {
            const oldOutput = await callback();
            if (legacyStep === "record prepared artifact") {
              await appendTerminalStatus(workflowEnv, rollbackReleaseId, "live", "release.live");
              return {
                preparedKey: (oldOutput as { preparedKey: string }).preparedKey,
                preparedDigest: (oldOutput as { preparedDigest: string }).preparedDigest,
                preparedJson: (oldOutput as { preparedJson: string }).preparedJson,
              };
            }
            return oldOutput;
          }
          if (name === legacyStep) {
            if (legacyStep === "mark awaiting approval") {
              await callback();
              await appendTerminalStatus(workflowEnv, rollbackReleaseId, "live", "release.live");
            }
            return undefined;
          }
          if (name === "wait for release approval") {
            throw new Error("Legacy terminal replay waited for approval.");
          }
          return callback();
        },
        async waitForEvent() {
          throw new Error("Legacy terminal replay waited for approval.");
        },
      };

      await ReleaseWorkflow.prototype.run.call(
        { env: workflowEnv } as ReleaseWorkflow,
        {
          payload: {
            projectId,
            releaseId: rollbackReleaseId,
            revisionId,
            requestId,
            admittedAt: now,
          },
        },
        step as never,
      );

      expect(db.releases.get(rollbackReleaseId)?.status).toBe("live");
      expect(db.events.get(rollbackReleaseId)?.at(-1)).toBe("release.live");
    }
  });

  test("publishing after a winning CAS remains deterministic if terminal reconciliation wins before the PUT", async () => {
    const db = new MemoryD1();
    const bucket = new MemoryBucket();
    seedFixture(db, bucket);
    let openPreparedRead: (() => void) | undefined;
    const preparedReadGate = new Promise<void>((resolve) => {
      openPreparedRead = resolve;
    });
    let preparedReadReached: (() => void) | undefined;
    const preparedReadBarrier = new Promise<void>((resolve) => {
      preparedReadReached = resolve;
    });
    bucket.beforeGet = async (key, count) => {
      if (key === preparedKey && count === 2) {
        preparedReadReached?.();
        await preparedReadGate;
      }
    };
    const workflowEnv = {
      DB: db,
      ARTIFACTS: bucket,
      RUN_ID: "workflow-fence",
      WFP_ACCOUNT_ID: "account",
      WFP_NAMESPACE: "namespace",
      WFP_PUBLISH_TIMEOUT_MS: "1000",
      CLOUDFLARE_API_TOKEN: "test-only",
    } as unknown as Env;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        errors: [],
        messages: [],
        success: true,
        result: { id: publicationName("workflow-fence", projectId), startup_time_ms: 1 },
      }),
    );
    const step = {
      async do(_name: string, ...options: unknown[]) {
        const callback = options.find(
          (option): option is () => Promise<unknown> => typeof option === "function",
        );
        if (!callback) throw new Error("Missing callback.");
        return callback();
      },
      async waitForEvent() {
        throw new Error("Unexpected approval wait.");
      },
    };
    const runPromise = ReleaseWorkflow.prototype.run.call(
      { env: workflowEnv } as ReleaseWorkflow,
      {
        payload: {
          projectId,
          releaseId: rollbackReleaseId,
          revisionId,
          requestId,
          admittedAt: now,
        },
      },
      step as never,
    );
    await preparedReadBarrier;
    expect(db.releases.get(rollbackReleaseId)?.status).toBe("publishing");
    expect(await appendTerminalStatus(workflowEnv, rollbackReleaseId, "live", "release.live")).toBe(
      true,
    );
    openPreparedRead?.();
    await runPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).url).toContain(
      `/scripts/${publicationName("workflow-fence", projectId)}`,
    );
    const firstForm = await (request as Request).clone().formData();
    await publishWorker(
      workflowEnv,
      projectId,
      revisionId,
      JSON.parse(preparedJson) as Parameters<typeof publishWorker>[3],
    );
    const secondRequest = fetchSpy.mock.calls[1]?.[0];
    expect(secondRequest).toBeInstanceOf(Request);
    expect((secondRequest as Request).url).toBe((request as Request).url);
    const secondForm = await (secondRequest as Request).clone().formData();
    expect(await (firstForm.get("metadata") as File).text()).toBe(
      await (secondForm.get("metadata") as File).text(),
    );
    expect(await (firstForm.get("index.js") as File).text()).toBe(
      await (secondForm.get("index.js") as File).text(),
    );
    expect(db.releases.get(rollbackReleaseId)).toMatchObject({
      status: "live",
      prepared_key: preparedKey,
      prepared_digest: preparedDigest,
      publication_name: null,
    });
    expect(db.events.get(rollbackReleaseId)).toEqual([
      "release.queued",
      "release.validating",
      "release.prepared",
      "release.publishing",
      "release.live",
    ]);
    expect(
      await appendReleaseStatus(
        workflowEnv,
        rollbackReleaseId,
        "reconciling",
        "release.reconciling",
        { code: "publication_ambiguous" },
      ),
    ).toEqual({ state: "fenced" });
    expect(db.events.get(rollbackReleaseId)).not.toContain("release.reconciling");
    fetchSpy.mockRestore();
  });

  test("a terminal winner at the building barrier skips loader and R2 retention", async () => {
    const db = new MemoryD1();
    const bucket = new MemoryBucket();
    seedFixture(db, bucket);
    seedQueuedBuild(db);
    let openBuilding: (() => void) | undefined;
    const buildingGate = new Promise<void>((resolve) => {
      openBuilding = resolve;
    });
    let buildingReached: (() => void) | undefined;
    const buildingBarrier = new Promise<void>((resolve) => {
      buildingReached = resolve;
    });
    db.afterTransition = async (type) => {
      if (type === "release.building") {
        buildingReached?.();
        await buildingGate;
      }
    };
    const workflowEnv = {
      DB: db,
      ARTIFACTS: bucket,
      RUN_ID: "workflow-fence",
      WFP_ACCOUNT_ID: "account",
      WFP_NAMESPACE: "namespace",
      WFP_PUBLISH_TIMEOUT_MS: "1000",
      CLOUDFLARE_API_TOKEN: "test-only",
    } as unknown as Env;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const loader = {
      load() {
        throw new Error("Loader must not run after terminal fencing.");
      },
    };
    const step = {
      async do(_name: string, ...options: unknown[]) {
        const callback = options.find(
          (option): option is () => Promise<unknown> => typeof option === "function",
        );
        if (!callback) throw new Error("Missing callback.");
        return callback();
      },
    };
    const runPromise = ReleaseWorkflow.prototype.run.call(
      { env: { ...workflowEnv, LOADER: loader } as unknown as Env } as ReleaseWorkflow,
      {
        payload: {
          projectId,
          releaseId: buildingReplayReleaseId,
          revisionId,
          requestId,
          admittedAt: now,
        },
      },
      step as never,
    );
    await buildingBarrier;
    expect(db.releases.get(buildingReplayReleaseId)?.status).toBe("building");
    expect(
      await appendTerminalStatus(workflowEnv, buildingReplayReleaseId, "live", "release.live"),
    ).toBe(true);
    openBuilding?.();
    await runPromise;
    expect(bucket.getCalls).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
