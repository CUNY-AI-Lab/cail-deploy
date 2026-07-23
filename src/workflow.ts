import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { publishWorker } from "./adapters/cloudflare/wfp";
import { type PreparedWorker, prepareAndSmokeWorker } from "./adapters/cloudflare/worker-bundler";
import { type Artifact, artifactSchema } from "./domain/contracts";
import { canonicalJson, sha256Hex } from "./domain/digests";
import { ApiError, apiErrorSnapshot } from "./domain/errors";
import type { Env, ReleaseWorkflowParams } from "./env";
import { emitReleaseTerminal } from "./operational-events";
import { appendReleaseStatus, appendTerminalStatus, getRevision, requireRelease } from "./storage";
import { finalizeWorkflowFailure } from "./workflow-failure";

interface PreparedEnvelope extends PreparedWorker {
  schemaVersion: "kale.prepared-worker.v1";
  projectId: string;
  releaseId: string;
  revisionId: string;
}

export class ReleaseWorkflow extends WorkflowEntrypoint<Env, ReleaseWorkflowParams> {
  async run(event: WorkflowEvent<ReleaseWorkflowParams>, step: WorkflowStep): Promise<void> {
    const { projectId, releaseId, revisionId, requestId, logSubject, admittedAt } = event.payload;
    try {
      await step.do("mark validating", () =>
        appendReleaseStatus(this.env, releaseId, "validating", "release.validating"),
      );
      const artifact = await step.do("verify immutable revision", async () => {
        const revision = await getRevision(this.env, projectId, revisionId);
        if (!revision) throw new Error("Revision row is missing.");
        const object = await this.env.ARTIFACTS.get(revision.artifact_key);
        if (!object) throw new Error("Revision object is missing.");
        const bytes = await object.arrayBuffer();
        if ((await sha256Hex(bytes)) !== revision.artifact_digest)
          throw new Error("Revision digest changed.");
        return artifactSchema.parse(JSON.parse(new TextDecoder().decode(bytes))) as Artifact;
      });
      if (artifact.requestedBindings.length > 0)
        throw new Error("Binding requests are not supported by this isolated slice.");
      const initialRelease = await requireRelease(this.env, projectId, releaseId);
      const preparedState = initialRelease.rollback_of_release_id
        ? await step.do("reuse retained rollback artifact", async () => {
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
            const retained = await this.env.ARTIFACTS.get(source.prepared_key);
            if (!retained) throw new Error("Rollback prepared artifact is missing.");
            const preparedJson = await retained.text();
            if ((await sha256Hex(preparedJson)) !== source.prepared_digest) {
              throw new Error("Rollback prepared artifact digest changed.");
            }
            return {
              preparedKey: source.prepared_key,
              preparedDigest: source.prepared_digest,
              preparedJson,
            };
          })
        : await step.do("bundle and retain worker", async () => {
            await appendReleaseStatus(this.env, releaseId, "building", "release.building");
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
            await this.env.ARTIFACTS.put(preparedKey, preparedJson, {
              customMetadata: { projectId, releaseId, revisionId, preparedDigest },
            });
            return { preparedKey, preparedDigest, preparedJson };
          });
      const { preparedKey, preparedDigest } = preparedState;
      await step.do("record prepared artifact", async () => {
        const now = new Date().toISOString();
        await this.env.DB.batch([
          this.env.DB.prepare(
            "UPDATE releases SET status = 'prepared', prepared_key = ?, prepared_digest = ?, updated_at = ? WHERE release_id = ?",
          ).bind(preparedKey, preparedDigest, now, releaseId),
          this.env.DB.prepare(
            `INSERT INTO release_events (release_id, sequence, type, occurred_at, detail_json)
             VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM release_events WHERE release_id = ?), 1), 'release.prepared', ?, ?)`,
          ).bind(releaseId, releaseId, now, JSON.stringify({ preparedDigest })),
        ]);
      });

      const release = await requireRelease(this.env, projectId, releaseId);
      if (release.approval === "required") {
        await step.do("mark awaiting approval", () =>
          appendReleaseStatus(
            this.env,
            releaseId,
            "awaiting_approval",
            "release.awaiting_approval",
          ),
        );
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

      await step.do(
        "publish prepared worker",
        { retries: { limit: 0, delay: "1 second", backoff: "constant" } },
        async () => {
          await appendReleaseStatus(this.env, releaseId, "publishing", "release.publishing");
          const retained = await this.env.ARTIFACTS.get(preparedKey);
          if (!retained) throw new Error("Prepared artifact is missing.");
          const retainedJson = await retained.text();
          if ((await sha256Hex(retainedJson)) !== preparedDigest)
            throw new Error("Prepared artifact digest changed.");
          const name = await publishWorker(
            this.env,
            projectId,
            revisionId,
            JSON.parse(retainedJson) as PreparedEnvelope,
          );
          await this.env.DB.prepare("UPDATE releases SET publication_name = ? WHERE release_id = ?")
            .bind(name, releaseId)
            .run();
          const terminal = await appendTerminalStatus(this.env, releaseId, "live", "release.live", {
            publicationName: name,
            revisionId,
          });
          if (terminal)
            emitReleaseTerminal(
              this.env,
              releaseId,
              requestId,
              logSubject,
              admittedAt,
              "ok",
              "completed",
            );
        },
      );
    } catch (error) {
      if (apiErrorSnapshot(error)?.code === "publication_ambiguous") {
        await step.do("record ambiguous publication", () =>
          appendReleaseStatus(this.env, releaseId, "reconciling", "release.reconciling", {
            code: "publication_ambiguous",
          }),
        );
        return;
      }
      await finalizeWorkflowFailure(
        error,
        () =>
          step.do("record terminal failure", async () => {
            const errorType =
              error instanceof Error && error.message.includes("digest")
                ? "artifact_integrity_failed"
                : "release_failed";
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
