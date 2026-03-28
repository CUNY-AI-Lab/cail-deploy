import type {
  StaticAssetDescriptor,
  StaticAssetUpload,
  WorkersAssetsUploadResult,
  WorkersAssetsUploadSessionResult
} from "@cuny-ai-lab/build-contract";
import type { CloudflareApiClient } from "./cloudflare";

type AssetFile = {
  descriptor: StaticAssetDescriptor;
  file: File;
};

type PreparedStaticAsset = {
  path: string;
  hash: string;
  contentType?: string;
  file: File;
  size: number;
};

export async function prepareStaticAssetsUpload(
  client: CloudflareApiClient,
  namespace: string,
  scriptName: string,
  staticAssets: StaticAssetUpload | undefined,
  files: Array<{ name: string; file: File }>
): Promise<{
  completionJwt?: string;
  manifest?: Record<string, { hash: string; size: number; contentType?: string }>;
}> {
  if (!staticAssets) {
    return {};
  }

  const assetFiles = resolveStaticAssetFiles(staticAssets, files);
  if (assetFiles.length === 0) {
    return {};
  }

  const preparedAssets = await Promise.all(
    assetFiles.map((entry) => prepareStaticAsset(entry, staticAssets.isolationKey))
  );

  const manifest = Object.fromEntries(
    preparedAssets.map((entry) => [
      entry.path,
      {
        hash: entry.hash,
        size: entry.size
      }
    ])
  );

  const session = await client.createAssetsUploadSession(namespace, scriptName, manifest);
  let completionJwt = session.jwt;

  for (const bucket of session.buckets ?? []) {
    const bucketAssets = preparedAssets.filter((entry) => bucket.includes(entry.hash));
    if (bucketAssets.length === 0) {
      continue;
    }

    const upload = await client.uploadAssetsBucket(session.jwt, bucketAssets.map((entry) => ({
      key: entry.hash,
      base64: entry.file,
      contentType: entry.contentType
    })));

    completionJwt = upload.jwt ?? completionJwt;
  }

  return {
    completionJwt,
    manifest: Object.fromEntries(
      preparedAssets.map((entry) => [
        entry.path,
        {
          hash: entry.hash,
          size: entry.size,
          ...(entry.contentType ? { contentType: entry.contentType } : {})
        }
      ])
    )
  };
}

function resolveStaticAssetFiles(
  staticAssets: StaticAssetUpload,
  files: Array<{ name: string; file: File }>
): AssetFile[] {
  const fileMap = new Map(files.map((entry) => [entry.name, entry.file]));

  return staticAssets.files.map((descriptor) => {
    const file = fileMap.get(descriptor.partName);
    if (!file) {
      throw new Error(`Static asset part '${descriptor.partName}' was not included in the upload.`);
    }

    return { descriptor, file };
  });
}

async function prepareStaticAsset(
  entry: AssetFile,
  isolationKey: string | undefined
): Promise<PreparedStaticAsset> {
  const content = new Uint8Array(await entry.file.arrayBuffer());
  const hash = await hashStaticAsset(entry.descriptor.path, content, isolationKey);

  return {
    path: entry.descriptor.path,
    hash,
    contentType: entry.descriptor.contentType || entry.file.type || undefined,
    file: entry.file,
    size: entry.file.size
  };
}

async function hashStaticAsset(
  path: string,
  content: Uint8Array,
  isolationKey: string | undefined
): Promise<string> {
  const prefix = new TextEncoder().encode(`${isolationKey ?? "global"}\u0000${path}\u0000`);
  const digestInput = new Uint8Array(prefix.length + content.length);
  digestInput.set(prefix);
  digestInput.set(content, prefix.length);

  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export type StaticAssetsManifest = Record<string, { hash: string; size: number; contentType?: string }>;

export type StaticAssetUploadSession = WorkersAssetsUploadSessionResult;

export type StaticAssetBucketUpload = WorkersAssetsUploadResult;
