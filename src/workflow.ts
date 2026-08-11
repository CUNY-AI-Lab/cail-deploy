import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { publishWorker } from "./adapters/cloudflare/wfp";
import { type PreparedWorker, prepareAndSmokeWorker } from "./adapters/cloudflare/worker-bundler";
import { type Artifact, artifactSchema } from "./domain/contracts";
import { canonicalJson, sha256Hex } from "./domain/digests";
import { ApiError, apiErrorSnapshot } from "./domain/errors";
import type { Env, ReleaseWorkflowParams } from "./env";
import { emitReleaseTerminal } from "./operational-events";
import {
  appendReleaseStatus,
  appendTerminalStatus,
  getRevision,
  hasTerminalReleaseOutcome,
  requireRelease,
  transitionReleaseStatus,
} from "./storage";
import type { ReleaseStatus, ReleaseTransitionResult } from "./storage";
import { finalizeWorkflowFailure } from "./workflow-failure";

interface PreparedEnvelope extends PreparedWorker {
  schemaVersion: "kale.prepared-worker.v1";
  projectId: string;
  releaseId: string;
  revisionId: string;
}

function artifactIntegrityFailure(message: string): ApiError {
  return new ApiError(500, "artifact_integrity_failed", message);
}

function terminalFailureType(error: unknown): "artifact_integrity_failed" | "release_failed" {
  return apiErrorSnapshot(error)?.code === "artifact_integrity_failed"
    ? "artifact_integrity_failed"
    : "release_failed";
}

function isTransitionResult(value: unknown): value is ReleaseTransitionResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { state?: unknown }).state !== undefined &&
    ["applied", "already_applied", "fenced"].includes((value as { state: string }).state)
  );
}

/**
 * Workflows retain completed step outputs across code revisions. The first
 * release Workflow revision returned `undefined` from status steps, so a
 * replay can have no transition result even though its D1 write completed.
 * A legacy output is therefore resolved from authoritative D1 state; this
 * read never repeats the old transition side effect.
 */
async function transitionAllowsProgress(
  env: Env,
  projectId: string,
  releaseId: string,
  output: unknown,
  allowedLegacyStatuses: readonly ReleaseStatus[],
): Promise<boolean> {
  if (await hasTerminalReleaseOutcome(env, releaseId)) return false;
  if (isTransitionResult(output)) return output.state !== "fenced";
  const release = await requireRelease(env, projectId, releaseId);
  return allowedLegacyStatuses.includes(release.status as ReleaseStatus);
}

function isPreparedStateFenced(value: unknown): value is { outcome: "fenced" } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === "fenced"
  );
}

function isPreparedStatePrepared(
  value: unknown,
): value is { outcome: "prepared"; preparedKey: string; preparedDigest: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === "prepared" &&
    typeof (value as { preparedKey?: unknown }).preparedKey === "string" &&
    typeof (value as { preparedDigest?: unknown }).preparedDigest === "string"
  );
}

export class ReleaseWorkflow extends WorkflowEntrypoint<Env, ReleaseWorkflowParams> {
  async run(event: WorkflowEvent<ReleaseWorkflowParams>, step: WorkflowStep): Promise<void> {
    const { projectId, releaseId, revisionId, requestId, logSubject, admittedAt } = event.payload;
    try {
      const validating = await step.do("mark validating", () =>
        appendReleaseStatus(this.env, releaseId, "validating", "release.validating"),
      );
      if (
        !(await transitionAllowsProgress(this.env, projectId, releaseId, validating, [
          "validating",
          "building",
          "prepared",
          "awaiting_approval",
          "publishing",
          "reconciling",
        ]))
      )
        return;
      if (await hasTerminalReleaseOutcome(this.env, releaseId)) return;
      const artifact = await step.do("verify immutable revision", async () => {
        if (await hasTerminalReleaseOutcome(this.env, releaseId)) return null;
        const revision = await getRevision(this.env, projectId, revisionId);
        if (!revision) throw new Error("Revision row is missing.");
        const object = await this.env.ARTIFACTS.get(revision.artifact_key);
        if (!object) throw new Error("Revision object is missing.");
        const bytes = await object.arrayBuffer();
        if ((await sha256Hex(bytes)) !== revision.artifact_digest)
          throw artifactIntegrityFailure("Revision digest changed.");
        return artifactSchema.parse(JSON.parse(new TextDecoder().decode(bytes))) as Artifact;
      });
      if (!artifact) return;
      if (artifact.requestedBindings.length > 0)
        throw new Error("Binding requests are not supported by this isolated slice.");
      const initialRelease = await requireRelease(this.env, projectId, releaseId);
      const preparedState = initialRelease.rollback_of_release_id
        ? await step.do("reuse retained rollback artifact", async () => {
            if (await hasTerminalReleaseOutcome(this.env, releaseId)) {
              return { outcome: "fenced" as const };
            }
            const source = await requireRelease(
              this.env,
              projectId,
              initialRelease.rollback_of_release_id as string,
            );
            if (
              !source.prepared_key ||
              !source.prepared_digest ||
              source.revision_id !== revisionId
            ) {
              throw new Error("Rollback prepared artifact is unavailable.");
            }
            if (await hasTerminalReleaseOutcome(this.env, releaseId)) {
              return { outcome: "fenced" as const };
            }
            const retained = await this.env.ARTIFACTS.get(source.prepared_key);
            if (!retained) throw new Error("Rollback prepared artifact is missing.");
            const preparedJson = await retained.text();
            if ((await sha256Hex(preparedJson)) !== source.prepared_digest) {
              throw artifactIntegrityFailure("Rollback prepared artifact digest changed.");
            }
            return {
              outcome: "prepared" as const,
              preparedKey: source.prepared_key,
              preparedDigest: source.prepared_digest,
            };
          })
        : await step.do("bundle and retain worker", async () => {
            const building = await appendReleaseStatus(
              this.env,
              releaseId,
              "building",
              "release.building",
            );
            if (
              !(await transitionAllowsProgress(this.env, projectId, releaseId, building, [
                "building",
                "prepared",
                "awaiting_approval",
                "publishing",
                "reconciling",
              ]))
            ) {
              return { outcome: "fenced" as const };
            }
            if (await hasTerminalReleaseOutcome(this.env, releaseId)) {
              return { outcome: "fenced" as const };
            }
            const prepared = await prepareAndSmokeWorker(artifact, this.env.LOADER);
            const envelope: PreparedEnvelope = {
              schemaVersion: "kale.prepared-worker.v1",
              projectId,
              releaseId,
              revisionId,
              ...prepared,
            };
            const preparedJson = canonicalJson(envelope);
            const preparedDigest = await sha256Hex(preparedJson);
            const preparedKey = `prepared/${projectId}/${releaseId}/${preparedDigest}.json`;
            if (await hasTerminalReleaseOutcome(this.env, releaseId)) {
              return { outcome: "fenced" as const };
            }
            await this.env.ARTIFACTS.put(preparedKey, preparedJson, {
              customMetadata: { projectId, releaseId, revisionId, preparedDigest },
            });
            return { outcome: "prepared" as const, preparedKey, preparedDigest };
          });
      if (isPreparedStateFenced(preparedState)) return;
      if (!isPreparedStatePrepared(preparedState)) {
        if (await hasTerminalReleaseOutcome(this.env, releaseId)) return;
        await requireRelease(this.env, projectId, releaseId);
        throw new Error("Prepared state is incomplete in the persisted Workflow output.");
      }
      const { preparedKey, preparedDigest } = preparedState;
      const preparedRecorded = await step.do("record prepared artifact", async () => {
        return transitionReleaseStatus(this.env, {
          releaseId,
          from: ["validating", "building"],
          to: "prepared",
          type: "release.prepared",
          detail: { preparedDigest },
          set: { preparedKey, preparedDigest },
        });
      });
      if (
        !(await transitionAllowsProgress(this.env, projectId, releaseId, preparedRecorded, [
          "prepared",
          "awaiting_approval",
          "publishing",
          "reconciling",
        ]))
      ) {
        return;
      }

      if (await hasTerminalReleaseOutcome(this.env, releaseId)) return;
      const release = await requireRelease(this.env, projectId, releaseId);
      if (release.approval === "required") {
        const awaitingApproval = await step.do("mark awaiting approval", () =>
          appendReleaseStatus(
            this.env,
            releaseId,
            "awaiting_approval",
            "release.awaiting_approval",
          ),
        );
        if (
          !(await transitionAllowsProgress(this.env, projectId, releaseId, awaitingApproval, [
            "awaiting_approval",
            "publishing",
            "reconciling",
          ]))
        ) {
          return;
        }
        if (await hasTerminalReleaseOutcome(this.env, releaseId)) return;
        const approval = await step.waitForEvent<{
          decision: string;
          actorSubject: string;
          revisionId: string;
        }>("wait for release approval", {
          type: "release-approval",
          timeout: "24 hours",
        });
        const approvedRelease = await requireRelease(this.env, projectId, releaseId);
        if (
          approval.payload.decision !== "approved" ||
          approval.payload.actorSubject !== approvedRelease.approved_by_subject ||
          approval.payload.revisionId !== revisionId
        ) {
          throw new Error("Release approval does not match its owner and revision.");
        }
      }

      const publication = await step.do(
        "publish prepared worker",
        { retries: { limit: 0, delay: "1 second", backoff: "constant" } },
        async () => {
          const publishing = await appendReleaseStatus(
            this.env,
            releaseId,
            "publishing",
            "release.publishing",
          );
          if (
            !(await transitionAllowsProgress(this.env, projectId, releaseId, publishing, [
              "publishing",
              "reconciling",
            ]))
          ) {
            return { outcome: "fenced" as const };
          }
          if (await hasTerminalReleaseOutcome(this.env, releaseId)) {
            return { outcome: "fenced" as const };
          }
          const retained = await this.env.ARTIFACTS.get(preparedKey);
          if (!retained) throw new Error("Prepared artifact is missing.");
          const retainedJson = await retained.text();
          if ((await sha256Hex(retainedJson)) !== preparedDigest)
            throw artifactIntegrityFailure("Prepared artifact digest changed.");
          let name: string;
          try {
            name = await publishWorker(
              this.env,
              projectId,
              revisionId,
              JSON.parse(retainedJson) as PreparedEnvelope,
            );
          } catch (error) {
            if (apiErrorSnapshot(error)?.code === "publication_ambiguous") {
              return { outcome: "ambiguous" as const };
            }
            throw error;
          }
          const publicationRecorded = await this.env.DB.prepare(
            `UPDATE releases SET publication_name = ?, updated_at = ?
             WHERE release_id = ? AND status = 'publishing'
               AND NOT EXISTS (
                 SELECT 1 FROM release_events
                 WHERE release_id = releases.release_id
                   AND type IN ('release.live', 'release.failed', 'release.rejected')
               )`,
          )
            .bind(name, new Date().toISOString(), releaseId)
            .run();
          if ((publicationRecorded.meta.changes ?? 0) !== 1) {
            return { outcome: "fenced" as const };
          }
          const terminal = await appendTerminalStatus(this.env, releaseId, "live", "release.live", {
            publicationName: name,
            revisionId,
          });
          if (!terminal) return { outcome: "fenced" as const };
          emitReleaseTerminal(
            this.env,
            releaseId,
            requestId,
            logSubject,
            admittedAt,
            "ok",
            "completed",
          );
          return { outcome: "live" as const };
        },
      );
      if (publication.outcome === "ambiguous") {
        await step.do("record ambiguous publication", () =>
          appendReleaseStatus(this.env, releaseId, "reconciling", "release.reconciling", {
            code: "publication_ambiguous",
          }),
        );
      }
    } catch (error) {
      await finalizeWorkflowFailure(
        error,
        () =>
          step.do("record terminal failure", async () => {
            const errorType = terminalFailureType(error);
            const terminal = await appendTerminalStatus(
              this.env,
              releaseId,
              "failed",
              "release.failed",
              { code: errorType },
            );
            if (terminal)
              emitReleaseTerminal(
                this.env,
                releaseId,
                requestId,
                logSubject,
                admittedAt,
                "error",
                "upstream_failure",
                errorType,
              );
          }),
        { releaseId, requestId },
      );
    }
  }
}

export type { PreparedEnvelope };
