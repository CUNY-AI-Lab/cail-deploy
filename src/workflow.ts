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

async function loadVerifiedArtifact(
  env: Env,
  projectId: string,
  revisionId: string,
): Promise<Artifact> {
  const revision = await getRevision(env, projectId, revisionId);
  if (!revision) throw new Error("Revision row is missing.");
  const object = await env.ARTIFACTS.get(revision.artifact_key);
  if (!object) throw new Error("Revision object is missing.");
  const bytes = await object.arrayBuffer();
  if ((await sha256Hex(bytes)) !== revision.artifact_digest) {
    throw artifactIntegrityFailure("Revision digest changed.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new ApiError(500, "artifact_integrity_failed", "Revision JSON is invalid.", { cause });
  }
  const artifact = artifactSchema.parse(parsed) as Artifact;
  if (artifact.requestedBindings.length > 0) {
    throw new Error("Binding requests are not supported by this isolated publication service.");
  }
  return artifact;
}

export class ReleaseWorkflow extends WorkflowEntrypoint<Env, ReleaseWorkflowParams> {
  async run(event: WorkflowEvent<ReleaseWorkflowParams>, step: WorkflowStep): Promise<void> {
    const { projectId, releaseId, revisionId, requestId, logSubject, admittedAt } = event.payload;
    try {
      const validating = await step.do("mark validating", () =>
        appendReleaseStatus(this.env, releaseId, "validating", "release.validating"),
      );
      if (validating.state === "fenced") return;
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
            if (building.state === "fenced") return { outcome: "fenced" as const };
            if (await hasTerminalReleaseOutcome(this.env, releaseId)) {
              return { outcome: "fenced" as const };
            }
            const artifact = await loadVerifiedArtifact(this.env, projectId, revisionId);
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
      if (preparedState.outcome === "fenced") return;
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
      if (preparedRecorded.state === "fenced") return;

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
        if (awaitingApproval.state === "fenced") return;
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
          if (publishing.state === "fenced") return { outcome: "fenced" as const };
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
          try {
            const publicationRecorded = await this.env.DB.prepare(
              `UPDATE releases SET publication_name = ?, updated_at = ?
               WHERE release_id = ? AND status = 'publishing'
                 AND NOT EXISTS (
                   SELECT 1 FROM release_events
                   WHERE release_id = releases.release_id
                     AND type IN ('release.live', 'release.failed')
                 )`,
            )
              .bind(name, new Date().toISOString(), releaseId)
              .run();
            if ((publicationRecorded.meta.changes ?? 0) !== 1) {
              return { outcome: "fenced" as const };
            }
            const terminal = await appendTerminalStatus(
              this.env,
              releaseId,
              "live",
              "release.live",
              {
                publicationName: name,
                revisionId,
              },
            );
            if (!terminal) return { outcome: "fenced" as const };
          } catch {
            return { outcome: "uncertain" as const };
          }
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
      if (publication.outcome === "ambiguous" || publication.outcome === "uncertain") {
        try {
          await step.do("record ambiguous publication", () =>
            appendReleaseStatus(this.env, releaseId, "reconciling", "release.reconciling", {
              code: "publication_ambiguous",
            }),
          );
        } catch {
          return;
        }
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
