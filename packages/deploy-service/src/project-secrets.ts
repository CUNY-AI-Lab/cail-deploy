import type {
  DeploymentMetadata,
  ProjectRecord,
  WorkerBinding
} from "@cuny-ai-lab/build-contract";

import { CloudflareApiClient } from "./lib/cloudflare";
import {
  deleteProjectSecretForRepository,
  listProjectSecretMetadataForRepository,
  listProjectSecretsForRepository,
  putProjectSecret
} from "./lib/control-plane";
import { decryptStoredText, encryptStoredText } from "./lib/sealed-data";
import { HttpError } from "./http-error";

const MAX_PROJECT_SECRET_VALUE_BYTES = 5 * 1024;
const RESERVED_WORKER_TEXT_BINDINGS = 8;
const MAX_PROJECT_SECRETS_PER_PROJECT = 128 - RESERVED_WORKER_TEXT_BINDINGS;

export type ProjectSecretMetadataPayload = {
  secretName: string;
  githubLogin: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectSecretsListPayload = {
  ok: true;
  projectName: string;
  repositoryFullName: string;
  connectedGitHubLogin: string;
  secrets: ProjectSecretMetadataPayload[];
  count: number;
  summary: string;
};

export type ProjectSecretMutationPayload = {
  ok: true;
  projectName: string;
  repositoryFullName: string;
  connectedGitHubLogin: string;
  secretName: string;
  liveDeploymentDetected: boolean;
  liveUpdateApplied: boolean;
  nextAction: "none" | "redeploy_to_apply_secret";
  summary: string;
  warning?: string;
};

export type ProjectSecretsAccessContext = {
  project: ProjectRecord;
  repositoryFullName: string;
  githubLogin: string;
  githubUserId: number;
};

export type ProjectSecretsConfig<Env> = {
  resolveControlPlaneEncryptionKey(env: Env): string;
  resolveRequiredCloudflareApiToken(env: Env): string;
  formatBytes(value: number): string;
};

type ProjectSecretsEnv = {
  CONTROL_PLANE_DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID: string;
  WFP_NAMESPACE: string;
};

export async function buildProjectSecretsListPayload(
  env: ProjectSecretsEnv,
  project: ProjectRecord,
  githubLogin: string
): Promise<ProjectSecretsListPayload> {
  const secrets = await listProjectSecretMetadataForRepository(env.CONTROL_PLANE_DB, project.githubRepo);

  return {
    ok: true,
    projectName: project.projectName,
    repositoryFullName: project.githubRepo,
    connectedGitHubLogin: githubLogin,
    secrets: secrets.map((secret) => ({
      secretName: secret.secretName,
      githubLogin: secret.githubLogin,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt
    })),
    count: secrets.length,
    summary: secrets.length === 0
      ? `No project secrets are stored for ${project.projectName} yet.`
      : `${secrets.length} project secret${secrets.length === 1 ? "" : "s"} configured for ${project.projectName}.`
  };
}

export async function setProjectSecretValue<Env extends ProjectSecretsEnv>(
  env: Env,
  config: ProjectSecretsConfig<Env>,
  authorization: ProjectSecretsAccessContext,
  secretNameInput: string,
  secretValue: string | undefined
): Promise<ProjectSecretMutationPayload> {
  const secretName = assertValidProjectSecretName(secretNameInput);
  const secretText = assertValidProjectSecretValue(secretValue, config.formatBytes);
  const encryptionKey = config.resolveControlPlaneEncryptionKey(env);
  const sealed = await encryptStoredText(encryptionKey, secretText);
  const now = new Date().toISOString();
  const existing = await listProjectSecretMetadataForRepository(env.CONTROL_PLANE_DB, authorization.project.githubRepo);
  const existingSecret = existing.find((secret) => secret.secretName === secretName);
  assertProjectSecretCapacity(existing.length, Boolean(existingSecret));

  await putProjectSecret(env.CONTROL_PLANE_DB, {
    githubRepo: authorization.project.githubRepo,
    projectName: authorization.project.projectName,
    secretName,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    githubUserId: authorization.githubUserId,
    githubLogin: authorization.githubLogin,
    createdAt: existingSecret?.createdAt ?? now,
    updatedAt: now
  });

  return syncProjectSecretToLiveWorker(env, config, authorization, secretName, secretText, "set");
}

export async function removeProjectSecretValue<Env extends ProjectSecretsEnv>(
  env: Env,
  config: ProjectSecretsConfig<Env>,
  authorization: ProjectSecretsAccessContext,
  secretNameInput: string
): Promise<ProjectSecretMutationPayload> {
  const secretName = assertValidProjectSecretName(secretNameInput);
  await deleteProjectSecretForRepository(env.CONTROL_PLANE_DB, authorization.project.githubRepo, secretName);
  return syncProjectSecretToLiveWorker(env, config, authorization, secretName, undefined, "delete");
}

export async function buildProjectSecretBindings<Env extends ProjectSecretsEnv>(
  env: Env,
  config: ProjectSecretsConfig<Env>,
  metadata: DeploymentMetadata
): Promise<WorkerBinding[]> {
  const secrets = await listProjectSecretsForRepository(env.CONTROL_PLANE_DB, metadata.githubRepo);
  if (secrets.length === 0) {
    return [];
  }

  if (secrets.length > MAX_PROJECT_SECRETS_PER_PROJECT) {
    throw new HttpError(
      400,
      `This project has ${secrets.length} stored secrets, which exceeds Kale Deploy's current limit of ${MAX_PROJECT_SECRETS_PER_PROJECT}. Remove some secrets before deploying again.`
    );
  }

  const existingBindingNames = new Set((metadata.workerUpload.bindings ?? []).map((binding) => binding.name));
  const conflicts = secrets.filter((secret) => existingBindingNames.has(secret.secretName)).map((secret) => secret.secretName);
  if (conflicts.length > 0) {
    throw new HttpError(
      400,
      `This deployment already defines bindings that are reserved by stored Kale project secrets: ${conflicts.join(", ")}. Rename the binding in the repo or remove the stored project secret first.`
    );
  }

  const encryptionKey = config.resolveControlPlaneEncryptionKey(env);
  return await Promise.all(
    secrets.map(async (secret) => {
      const text = await decryptStoredText(encryptionKey, {
        ciphertext: secret.ciphertext,
        iv: secret.iv
      });
      assertValidProjectSecretValue(text, config.formatBytes);
      return {
        type: "secret_text" as const,
        name: secret.secretName,
        text
      };
    })
  );
}

async function syncProjectSecretToLiveWorker<Env extends ProjectSecretsEnv>(
  env: Env,
  config: ProjectSecretsConfig<Env>,
  authorization: ProjectSecretsAccessContext,
  secretName: string,
  secretValue: string | undefined,
  operation: "set" | "delete"
): Promise<ProjectSecretMutationPayload> {
  const liveDeploymentDetected = Boolean(authorization.project.latestDeploymentId);
  if (!liveDeploymentDetected) {
    return {
      ok: true,
      projectName: authorization.project.projectName,
      repositoryFullName: authorization.repositoryFullName,
      connectedGitHubLogin: authorization.githubLogin,
      secretName,
      liveDeploymentDetected: false,
      liveUpdateApplied: false,
      nextAction: "none",
      summary: operation === "set"
        ? `Saved ${secretName} for ${authorization.project.projectName}. It will be injected automatically on the first deployment.`
        : `Removed ${secretName} from ${authorization.project.projectName}.`
    };
  }

  try {
    const client = new CloudflareApiClient({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: config.resolveRequiredCloudflareApiToken(env)
    });

    if (operation === "set") {
      await client.setUserWorkerSecret(env.WFP_NAMESPACE, authorization.project.projectName, secretName, secretValue ?? "");
    } else {
      await client.deleteUserWorkerSecret(env.WFP_NAMESPACE, authorization.project.projectName, secretName);
    }

    return {
      ok: true,
      projectName: authorization.project.projectName,
      repositoryFullName: authorization.repositoryFullName,
      connectedGitHubLogin: authorization.githubLogin,
      secretName,
      liveDeploymentDetected: true,
      liveUpdateApplied: true,
      nextAction: "none",
      summary: operation === "set"
        ? `Saved ${secretName} and updated the live Worker for ${authorization.project.projectName}.`
        : `Removed ${secretName} from both Kale storage and the live Worker for ${authorization.project.projectName}.`
    };
  } catch (error) {
    console.error("Applying project secret to the live Worker failed.", error);
    return {
      ok: true,
      projectName: authorization.project.projectName,
      repositoryFullName: authorization.repositoryFullName,
      connectedGitHubLogin: authorization.githubLogin,
      secretName,
      liveDeploymentDetected: true,
      liveUpdateApplied: false,
      nextAction: "redeploy_to_apply_secret",
      summary: operation === "set"
        ? `Saved ${secretName}, but the live Worker was not updated immediately.`
        : `Removed ${secretName} from Kale storage, but the live Worker still needs a redeploy to pick up the change.`,
      warning: "The desired secret state is stored safely in Kale Deploy. Push a new commit to the default branch to apply this change to the live Worker."
    };
  }
}

function assertValidProjectSecretName(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(normalized)) {
    throw new HttpError(
      400,
      "Project secret names must start with a letter and contain only uppercase letters, numbers, and underscores."
    );
  }

  if (isReservedProjectSecretName(normalized)) {
    throw new HttpError(
      400,
      `${normalized} is reserved by Kale Deploy. Choose another project secret name.`
    );
  }

  return normalized;
}

function assertValidProjectSecretValue(
  value: string | undefined,
  formatBytes: (value: number) => string
): string {
  if (typeof value !== "string" || !value.length) {
    throw new HttpError(400, "Project secret values must be a non-empty string.");
  }

  const byteLength = new TextEncoder().encode(value).byteLength;
  if (byteLength > MAX_PROJECT_SECRET_VALUE_BYTES) {
    throw new HttpError(
      400,
      `Project secret values must stay under ${formatBytes(MAX_PROJECT_SECRET_VALUE_BYTES)}.`
    );
  }

  return value;
}

function assertProjectSecretCapacity(existingSecretCount: number, updatingExistingSecret: boolean): void {
  if (!updatingExistingSecret && existingSecretCount >= MAX_PROJECT_SECRETS_PER_PROJECT) {
    throw new HttpError(
      400,
      `Projects can store at most ${MAX_PROJECT_SECRETS_PER_PROJECT} secrets.`
    );
  }
}

function isReservedProjectSecretName(name: string): boolean {
  return new Set(["DB", "FILES", "CACHE", "AI", "VECTORIZE", "ROOMS"]).has(name);
}
