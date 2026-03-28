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
};

type KvNamespaceResult = {
  id: string;
  title: string;
};

type R2BucketResult = {
  name: string;
};

export class CloudflareApiClient {
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

  private async rawRequest(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.apiToken}`,
        ...init.headers
      }
    });

    if (!response.ok) {
      throw new Error(`Cloudflare API request failed with ${response.status}.`);
    }

    return response;
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
