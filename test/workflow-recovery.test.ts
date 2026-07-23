import { describe, expect, mock, test } from "bun:test";
import { ensureWorkflowInstance, handleApiForPrincipal } from "../src/api";
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

function notFound(): Error {
  const error = new Error(`Workflow instance ${releaseId} not found`);
  error.name = "WorkflowInstanceNotFoundError";
  return error;
}

describe("release Workflow recovery", () => {
  test("uses an existing deterministic instance without creating another", async () => {
    const get = mock(async () => ({ id: releaseId }));
    const create = mock(async () => ({ id: releaseId }));

    await ensureWorkflowInstance(
      { RELEASE_WORKFLOW: { get, create } as unknown as TestWorkflowBinding },
      releaseId,
      params,
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  test("recovers a lost create response by re-reading the deterministic ID", async () => {
    let exists = false;
    const get = mock(async () => {
      if (!exists) throw notFound();
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

    expect(get).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ id: releaseId, params });
  });

  test("accepts a concurrent create race only after re-reading the instance", async () => {
    let reads = 0;
    const get = mock(async () => {
      reads += 1;
      if (reads === 1) throw notFound();
      return { id: releaseId };
    });
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

    expect(get).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("does not treat an arbitrary lookup failure as absence", async () => {
    const lookupFailure = new Error("Workflow binding transport failed");
    const get = mock(async () => {
      throw lookupFailure;
    });
    const create = mock(async () => ({ id: releaseId }));

    await expect(
      ensureWorkflowInstance(
        {
          RELEASE_WORKFLOW: {
            get,
            create,
          } as unknown as TestWorkflowBinding,
        },
        releaseId,
        params,
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "workflow_lookup_failed",
      cause: lookupFailure,
    });
    expect(create).not.toHaveBeenCalled();
  });

  test("preserves create and recovery causes when the instance remains absent", async () => {
    const createFailure = new Error("Workflow create failed");
    const recoveryFailure = new Error("Workflow instance still not found");
    let reads = 0;
    const get = mock(async () => {
      reads += 1;
      throw reads === 1 ? notFound() : recoveryFailure;
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
            artifact_key: "revisions/fixture.json",
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

    const get = mock(async () => {
      throw notFound();
    });
    const create = mock(async () => ({ id: releaseId }));
    const env = {
      DB: {
        prepare(sql: string) {
          return new Statement(sql);
        },
      },
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
    expect(create).toHaveBeenCalledWith({
      id: releaseId,
      params,
    });
    expect((create.mock.calls[0]?.[0] as { params: ReleaseWorkflowParams }).params.requestId).toBe(
      originalRequestId,
    );
  });
});
