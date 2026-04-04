import { AwsClient } from "aws4fetch";

import type {
  CloudflareEnvelope,
  D1CreateResult,
  WorkerUploadMetadata,
  WorkersAssetsUploadResult,
  WorkersAssetsUploadSessionResult
} from "@cuny-ai-lab/build-contract";

type CloudflareClientOptions = {
  accountId: string;
  apiToken: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
};

type KvNamespaceResult = {
  id: string;
  title: string;
};

type R2BucketResult = {
  name: string;
};

type CloudflareTokenVerifyResult = {
  id: string;
};

type CloudflareTokenVerifyAttempt = {
  id: string | null;
  error?: string;
};

export class CloudflareApiClient {
  private r2AwsClientPromise: Promise<AwsClient> | null = null;

  constructor(private readonly options: CloudflareClientOptions) {}

  async findD1DatabaseByName(name: string): Promise<D1CreateResult | undefined> {
    let page = 1;

    for (;;) {
      const envelope = await this.jsonRequest<D1CreateResult[]>(`/d1/database?page=${page}&per_page=100`, {
        method: "GET"
      });
      const match = envelope.result.find((database) => database.name === name);
      if (match) {
        return match;
      }

      if (envelope.result.length < 100) {
        return undefined;
      }

      page += 1;
    }
  }

  async createD1Database(name: string, locationHint?: string): Promise<D1CreateResult> {
    const envelope = await this.jsonRequest<D1CreateResult>("/d1/database", {
      method: "POST",
      body: JSON.stringify({
        name,
        ...(locationHint ? { primary_location_hint: locationHint } : {})
      })
    });

    return envelope.result;
  }

  async deleteD1Database(databaseId: string): Promise<void> {
    await this.rawRequest(`/d1/database/${encodeURIComponent(databaseId)}`, {
      method: "DELETE"
    }, [404]);
  }

  async findKvNamespaceByTitle(title: string): Promise<KvNamespaceResult | undefined> {
    let page = 1;

    for (;;) {
      const envelope = await this.jsonRequest<KvNamespaceResult[]>(`/storage/kv/namespaces?page=${page}&per_page=100`, {
        method: "GET"
      });
      const match = envelope.result.find((namespace) => namespace.title === title);
      if (match) {
        return match;
      }

      if (envelope.result.length < 100) {
        return undefined;
      }

      page += 1;
    }
  }

  async createKvNamespace(title: string): Promise<KvNamespaceResult> {
    const envelope = await this.jsonRequest<KvNamespaceResult>("/storage/kv/namespaces", {
      method: "POST",
      body: JSON.stringify({ title })
    });

    return envelope.result;
  }

  async deleteKvNamespace(namespaceId: string): Promise<void> {
    await this.rawRequest(`/storage/kv/namespaces/${encodeURIComponent(namespaceId)}`, {
      method: "DELETE"
    }, [404]);
  }

  async findR2BucketByName(name: string): Promise<R2BucketResult | undefined> {
    let cursor: string | undefined;

    for (;;) {
      const query = new URLSearchParams({ per_page: "1000" });
      if (cursor) {
        query.set("cursor", cursor);
      }

      const response = await this.rawRequest(`/r2/buckets?${query.toString()}`, {
        method: "GET"
      });
      const envelope = await response.json<CloudflareEnvelope<{ buckets: R2BucketResult[] }> & {
        result_info?: { cursor?: string };
      }>();
      if (!envelope.success) {
        throw new Error(envelope.errors.map((error) => error.message).join("; "));
      }

      const match = envelope.result.buckets.find((bucket) => bucket.name === name);
      if (match) {
        return match;
      }

      cursor = envelope.result_info?.cursor;
      if (!cursor) {
        return undefined;
      }
    }
  }

  async createR2Bucket(name: string): Promise<R2BucketResult> {
    const envelope = await this.jsonRequest<R2BucketResult>("/r2/buckets", {
      method: "POST",
      body: JSON.stringify({ name })
    });

    return envelope.result;
  }

  async deleteR2Bucket(name: string): Promise<void> {
    await this.rawRequest(`/r2/buckets/${encodeURIComponent(name)}`, {
      method: "DELETE"
    }, [404]);
  }

  async emptyAndDeleteR2Bucket(name: string): Promise<void> {
    for (;;) {
      const keys = await this.listR2ObjectKeys(name);
      if (keys.length === 0) {
        break;
      }

      await Promise.all(keys.map((key) => this.deleteR2Object(name, key)));
    }

    await this.deleteR2Bucket(name);
  }

  async uploadUserWorker(
    namespace: string,
    scriptName: string,
    metadata: WorkerUploadMetadata,
    files: Array<{ name: string; file: File }>
  ): Promise<void> {
    const body = new FormData();
    body.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");

    for (const entry of files) {
      body.append(
        entry.name,
        new Blob([entry.file], { type: workerModuleContentType(entry.name, entry.file.type) }),
        entry.name
      );
    }

    await this.rawRequest(`/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`, {
      method: "PUT",
      body
    });
  }

  async deleteUserWorker(namespace: string, scriptName: string): Promise<void> {
    await this.rawRequest(`/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`, {
      method: "DELETE"
    }, [404]);
  }

  async setUserWorkerSecret(
    namespace: string,
    scriptName: string,
    secretName: string,
    secretValue: string
  ): Promise<void> {
    await this.jsonRequest(
      `/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/secrets`,
      {
        method: "PUT",
        body: JSON.stringify({
          name: secretName,
          text: secretValue,
          type: "secret_text"
        })
      }
    );
  }

  async deleteUserWorkerSecret(
    namespace: string,
    scriptName: string,
    secretName: string
  ): Promise<void> {
    await this.rawRequest(
      `/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/secrets/${encodeURIComponent(secretName)}`,
      {
        method: "DELETE"
      },
      [404]
    );
  }

  async createAssetsUploadSession(
    namespace: string,
    scriptName: string,
    manifest: Record<string, { hash: string; size: number }>
  ): Promise<WorkersAssetsUploadSessionResult> {
    const envelope = await this.jsonRequest<WorkersAssetsUploadSessionResult>(
      `/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/assets-upload-session`,
      {
        method: "POST",
        body: JSON.stringify({ manifest })
      }
    );

    return envelope.result;
  }

  async uploadAssetsBucket(
    uploadJwt: string,
    files: Array<{ key: string; base64: File; contentType?: string }>
  ): Promise<WorkersAssetsUploadResult> {
    const body = new FormData();

    for (const entry of files) {
      const content = await entry.base64.arrayBuffer();
      const encoded = arrayBufferToBase64(content);
      body.append(
        entry.key,
        new Blob([encoded], { type: entry.contentType ?? "application/octet-stream" }),
        entry.key
      );
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}/workers/assets/upload?base64=true`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${uploadJwt}`
        },
        body
      }
    );

    if (!response.ok) {
      throw new Error(`Cloudflare assets upload failed with ${response.status}.`);
    }

    const envelope = await response.json<CloudflareEnvelope<WorkersAssetsUploadResult>>();
    if (!envelope.success) {
      throw new Error(envelope.errors.map((error) => error.message).join("; "));
    }

    return envelope.result;
  }

  private async jsonRequest<T>(path: string, init: RequestInit): Promise<CloudflareEnvelope<T>> {
    const response = await this.rawRequest(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers
      }
    });

    const envelope = await response.json<CloudflareEnvelope<T>>();
    if (!envelope.success) {
      throw new Error(envelope.errors.map((error) => error.message).join("; "));
    }

    return envelope;
  }

  private async rawRequest(path: string, init: RequestInit, allowedStatuses: number[] = []): Promise<Response> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.apiToken}`,
        ...init.headers
      }
    });

    if (!response.ok && !allowedStatuses.includes(response.status)) {
      throw new Error(`Cloudflare API request failed with ${response.status}.`);
    }

    return response;
  }

  private async listR2ObjectKeys(bucketName: string): Promise<string[]> {
    const client = await this.resolveR2AwsClient();
    const response = await client.fetch(
      this.buildR2ObjectUrl(bucketName, "?list-type=2&max-keys=1000"),
      { method: "GET" }
    );
    if (!response.ok) {
      throw new Error(`Cloudflare R2 object listing failed with ${response.status}.`);
    }

    return extractXmlValues(await response.text(), "Key");
  }

  private async deleteR2Object(bucketName: string, key: string): Promise<void> {
    const client = await this.resolveR2AwsClient();
    const response = await client.fetch(this.buildR2ObjectUrl(bucketName, `/${encodeR2ObjectKey(key)}`), {
      method: "DELETE"
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Cloudflare R2 object deletion failed with ${response.status}.`);
    }
  }

  private buildR2ObjectUrl(bucketName: string, suffix: string): string {
    const normalizedSuffix = suffix.startsWith("?") || suffix.startsWith("/")
      ? suffix
      : `/${suffix}`;
    return `https://${this.options.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucketName)}${normalizedSuffix}`;
  }

  private async resolveR2AwsClient(): Promise<AwsClient> {
    if (!this.r2AwsClientPromise) {
      this.r2AwsClientPromise = this.buildR2AwsClient();
    }

    return await this.r2AwsClientPromise;
  }

  private async buildR2AwsClient(): Promise<AwsClient> {
    if (this.options.r2AccessKeyId && this.options.r2SecretAccessKey) {
      return new AwsClient({
        service: "s3",
        region: "auto",
        accessKeyId: this.options.r2AccessKeyId,
        secretAccessKey: this.options.r2SecretAccessKey
      });
    }

    const accessKeyId = await this.resolveR2AccessKeyIdFromApiToken();

    return new AwsClient({
      service: "s3",
      region: "auto",
      accessKeyId,
      secretAccessKey: await sha256Hex(this.options.apiToken)
    });
  }

  private async resolveR2AccessKeyIdFromApiToken(): Promise<string> {
    const userTokenResult = await this.verifyCloudflareToken(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      "user"
    );
    if (userTokenResult.id) {
      return userTokenResult.id;
    }

    const accountTokenResult = await this.verifyCloudflareToken(
      `https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}/tokens/verify`,
      "account"
    );
    if (accountTokenResult.id) {
      return accountTokenResult.id;
    }

    throw new Error(
      `Cloudflare token verification failed. ${[
        userTokenResult.error ?? "user token verification did not return an active token id",
        accountTokenResult.error ?? "account token verification did not return an active token id"
      ].join("; ")}`
    );
  }

  private async verifyCloudflareToken(
    url: string,
    tokenKind: "user" | "account"
  ): Promise<CloudflareTokenVerifyAttempt> {
    const tokenResponse = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.options.apiToken}`
      }
    });
    if (!tokenResponse.ok) {
      return {
        id: null,
        error: `Cloudflare ${tokenKind} token verification failed with ${tokenResponse.status}`
      };
    }

    const envelope = await tokenResponse.json<CloudflareEnvelope<CloudflareTokenVerifyResult>>();
    if (!envelope.success || !envelope.result?.id) {
      return {
        id: null,
        error: envelope.errors.map((error) => error.message).join("; ")
          || `Cloudflare ${tokenKind} token verification did not return an active token id`
      };
    }

    return { id: envelope.result.id };
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function workerModuleContentType(fileName: string, contentType: string): string {
  if (fileName.endsWith(".js") || fileName.endsWith(".mjs")) {
    return "application/javascript+module";
  }

  return contentType || "application/octet-stream";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extractXmlValues(xml: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "g");
  return [...xml.matchAll(pattern)].map((match) => decodeXmlText(match[1] ?? ""));
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'");
}

function encodeR2ObjectKey(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
