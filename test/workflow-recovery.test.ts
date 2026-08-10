import { describe, expect, mock, test } from "bun:test";
import { ensureWorkflowInstance, handleApiForPrincipal } from "../src/api";
import { apiErrorSnapshot } from "../src/domain/errors";
import type { Env, ReleaseWorkflowParams, TestWorkflowBinding } from "../src/env";

const subject = `cail-${"a".repeat(32)}`;
const projectId = `prj_${"b".repeat(32)}`;
const revisionId = `rev_sha256_${"c".repeat(64)}`;
const releaseId = `rel_${"d".repeat(32)}`;
const originalRequestId = "11111111-1111-4111-8111-111111111111";

const params: ReleaseWorkflowParams = {
  projectId,
  releaseId,
  revisionId,
  requestId: originalRequestId,
  logSubject: `cail-v1-${"e".repeat(32)}`,
  admittedAt: "2026-07-23T00:00:00.000Z",
};

describe("release Workflow recovery", () => {
  test("creates a genuinely missing deterministic instance exactly once", async () => {
    const get = mock(async () => {
      throw new Error("GET_MUST_NOT_RUN_AFTER_SUCCESSFUL_CREATE");
    });
    const create = mock(async () => ({ id: releaseId }));

    await ensureWorkflowInstance(
      { RELEASE_WORKFLOW: { get, create } as unknown as TestWorkflowBinding },
      releaseId,
      params,
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ id: releaseId, params });
    expect(get).not.toHaveBeenCalled();
  });

  test("recovers an existing deterministic instance after create rejects", async () => {
    const duplicate = new Error("Workflow instance ID is already retained");
    const create = mock(async () => {
      throw duplicate;
    });
    const get = mock(async () => ({ id: releaseId }));

    await ensureWorkflowInstance(
      { RELEASE_WORKFLOW: { get, create } as unknown as TestWorkflowBinding },
      releaseId,
      params,
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ id: releaseId, params });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(releaseId);
  });

  test("recovers a lost create response by re-reading the deterministic ID", async () => {
    let exists = false;
    const get = mock(async () => {
      if (!exists) throw new Error("Workflow instance is not visible.");
      return { id: releaseId };
    });
    const lostResponse = new Error("workflow create response lost");
    const create = mock(async () => {
      exists = true;
      throw lostResponse;
    });

    await ensureWorkflowInstance(
      { RELEASE_WORKFLOW: { get, create } as unknown as TestWorkflowBinding },
      releaseId,
      params,
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ id: releaseId, params });
  });

  test("accepts a concurrent create race only after re-reading the instance", async () => {
    const get = mock(async () => ({ id: releaseId }));
    const duplicate = Object.assign(new Error("Workflow instance ID is already used"), {
      code: 409,
    });
    const create = mock(async () => {
      throw duplicate;
    });

    await ensureWorkflowInstance(
      { RELEASE_WORKFLOW: { get, create } as unknown as TestWorkflowBinding },
      releaseId,
      params,
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("preserves arbitrary create and recovery failures without inspecting them", async () => {
    const createFailure = new Error("Workflow create transport failed");
    const recoveryFailure = new Error("Workflow lookup transport failed");
    const create = mock(async () => {
      throw createFailure;
    });
    const get = mock(async () => {
      throw recoveryFailure;
    });

    let captured: unknown;
    try {
      await ensureWorkflowInstance(
        {
          RELEASE_WORKFLOW: {
            get,
            create,
          } as unknown as TestWorkflowBinding,
        },
        releaseId,
        params,
      );
    } catch (error) {
      captured = error;
    }

    expect(apiErrorSnapshot(captured)).toEqual({
      status: 503,
      code: "workflow_start_failed",
      message:
        "We saved your release but couldn't start it. Check the release status first, then reuse the same Idempotency-Key if you need to retry.",
    });
    const cause = (captured as Error).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toEqual([createFailure, recoveryFailure]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("does not inspect hostile create or recovery failures", async () => {
    const createFailure = new Error("PRIVATE_WORKFLOW_CREATE_FAILURE");
    const privateSentinel = new Error("PRIVATE_WORKFLOW_RECOVERY_SENTINEL");
    let traps = 0;
    const recoveryFailure = new Proxy(Object.create(null) as object, {
      get() {
        traps += 1;
        throw privateSentinel;
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw privateSentinel;
      },
      getPrototypeOf() {
        traps += 1;
        throw privateSentinel;
      },
    });
    const create = mock(async () => {
      throw createFailure;
    });
    const get = mock(async () => {
      throw recoveryFailure;
    });

    let captured: unknown;
    try {
      await ensureWorkflowInstance(
        {
          RELEASE_WORKFLOW: {
            get,
            create,
          } as unknown as TestWorkflowBinding,
        },
        releaseId,
        params,
      );
    } catch (error) {
      captured = error;
    }

    expect(apiErrorSnapshot(captured)).toEqual({
      status: 503,
      code: "workflow_start_failed",
      message:
        "We saved your release but couldn't start it. Check the release status first, then reuse the same Idempotency-Key if you need to retry.",
    });
    const cause = (captured as Error).cause as AggregateError;
    expect(cause).toBeInstanceOf(AggregateError);
    expect(cause.errors[0]).toBe(createFailure);
    expect(cause.errors[1]).toBe(recoveryFailure);
    expect(create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(traps).toBe(0);
  });

  test("preserves create and recovery causes when the instance remains absent", async () => {
    const createFailure = new Error("Workflow create failed");
    const recoveryFailure = new Error("Workflow instance still not found");
    const get = mock(async () => {
      throw recoveryFailure;
    });
    const create = mock(async () => {
      throw createFailure;
    });

    let captured: unknown;
    try {
      await ensureWorkflowInstance(
        {
          RELEASE_WORKFLOW: {
            get,
            create,
          } as unknown as TestWorkflowBinding,
        },
        releaseId,
        params,
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toMatchObject({
      status: 503,
      code: "workflow_start_failed",
    });
    const cause = (captured as Error).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toEqual([createFailure, recoveryFailure]);
  });

  test("an idempotent replay creates a missing instance with the original correlation", async () => {
    const response = {
      projectId,
      releaseId,
      revisionId,
      target: "preview",
      approval: "automatic",
      status: "queued",
      workflowInstanceId: releaseId,
      rollbackOfReleaseId: null,
      createdAt: params.admittedAt,
      updatedAt: params.admittedAt,
    };
    const release = {
      release_id: releaseId,
      project_id: projectId,
      revision_id: revisionId,
      target: "preview",
      approval: "automatic",
      status: "queued",
      workflow_instance_id: releaseId,
      prepared_key: null,
      prepared_digest: null,
      publication_name: null,
      rollback_of_release_id: null,
      approved_by_subject: null,
      operational_subject: params.logSubject,
      request_id: originalRequestId,
      admitted_at: params.admittedAt,
      created_at: params.admittedAt,
      updated_at: params.admittedAt,
    };
    const key = "same-logical-release";

    class Statement {
      private args: unknown[] = [];

      constructor(private readonly sql: string) {}

      bind(...args: unknown[]) {
        this.args = args;
        return this;
      }

      async first() {
        if (this.sql.includes("FROM projects")) {
          return {
            project_id: projectId,
            owner_subject: subject,
            name: "Replay fixture",
            created_at: params.admittedAt,
          };
        }
        if (this.sql.includes("FROM revisions")) {
          return {
            project_id: projectId,
            revision_id: revisionId,
            artifact_digest: "c".repeat(64),
            artifact_bytes: 1,
            artifact_key: `revisions/${projectId}/${revisionId}.json`,
            status: "ready",
            created_at: params.admittedAt,
          };
        }
        if (this.sql.includes("FROM idempotency")) {
          return {
            request_digest: await requestDigest(),
            response_json: JSON.stringify(response),
          };
        }
        if (this.sql.includes("FROM releases")) return release;
        throw new Error(`Unexpected first(): ${this.sql} ${this.args.length}`);
      }
    }

    const requestBody = {
      revisionId,
      target: "preview",
      approval: "automatic",
    } as const;
    async function requestDigest(): Promise<string> {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          approval: requestBody.approval,
          revisionId: requestBody.revisionId,
          rollbackOfReleaseId: null,
          target: requestBody.target,
        }),
      );
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    }

    const get = mock(async () => ({ id: releaseId }));
    const create = mock(async () => ({ id: releaseId }));
    const artifactKey = `revisions/${projectId}/${revisionId}.json`;
    const artifactChecksum = Uint8Array.from({ length: 32 }, () => 0xcc).buffer;
    const head = mock(async () => ({
      key: artifactKey,
      size: 1,
      checksums: { sha256: artifactChecksum },
      customMetadata: {
        projectId,
        revisionId,
        artifactDigest: "c".repeat(64),
      },
    }));
    const env = {
      DB: {
        prepare(sql: string) {
          return new Statement(sql);
        },
      },
      ARTIFACTS: { head },
      RELEASE_WORKFLOW: { get, create },
      ALLOW_PRODUCTION_TARGET: "0",
    } as unknown as Env;
    const replayRequestId = "22222222-2222-4222-8222-222222222222";
    const request = new Request(`https://deploy.test/v1/projects/${projectId}/releases`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(requestBody),
    });

    const replay = await handleApiForPrincipal(request, env, { subject }, replayRequestId);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(response);
    expect(head).toHaveBeenCalledWith(artifactKey);
    expect(create).toHaveBeenCalledWith({
      id: releaseId,
      params,
    });
    expect((create.mock.calls[0]?.[0] as { params: ReleaseWorkflowParams }).params.requestId).toBe(
      originalRequestId,
    );
  });
});
