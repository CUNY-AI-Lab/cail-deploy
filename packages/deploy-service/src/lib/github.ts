const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_GITHUB_USER_AGENT = "CAIL-Deploy";

export type GitHubCheckRunStatus = "queued" | "in_progress" | "completed";

export type GitHubCheckRunConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "success"
  | "timed_out";

export type GitHubCheckRunOutput = {
  title: string;
  summary: string;
  text?: string;
};

export type GitHubCheckRun = {
  id: number;
  html_url?: string;
  status: string;
  conclusion: string | null;
  details_url?: string | null;
};

export type GitHubAppManifest = {
  name?: string;
  url: string;
  hook_attributes: {
    url: string;
    active?: boolean;
  };
  redirect_url: string;
  callback_urls?: string[];
  setup_url?: string;
  description?: string;
  public?: boolean;
  default_events?: string[];
  default_permissions?: Record<string, string>;
  request_oauth_on_install?: boolean;
  setup_on_update?: boolean;
};

export type GitHubManifestConversion = {
  id: number;
  slug: string;
  name?: string;
  html_url?: string;
  client_id?: string;
  client_secret?: string;
  webhook_secret?: string;
  pem?: string;
  owner?: {
    login?: string;
    type?: string;
  };
};

export type GitHubRepositoryInstallation = {
  id: number;
  target_type?: string;
  account?: {
    login?: string;
  };
  html_url?: string;
};

export type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  html_url: string;
  clone_url: string;
  private: boolean;
  description?: string | null;
  owner: {
    login: string;
  };
};

export type GitHubCommit = {
  sha: string;
};

type GitHubAppClientOptions = {
  appId: string;
  privateKey: string;
  apiBaseUrl?: string;
};

type GitHubInstallationAccessToken = {
  token?: string;
  expires_at?: string;
};

type GitHubCreateCheckRunInput = {
  owner: string;
  repo: string;
  name: string;
  headSha: string;
  externalId?: string;
  detailsUrl?: string;
  status?: GitHubCheckRunStatus;
  startedAt?: string;
  completedAt?: string;
  conclusion?: GitHubCheckRunConclusion;
  output?: GitHubCheckRunOutput;
};

type GitHubUpdateCheckRunInput = {
  owner: string;
  repo: string;
  checkRunId: number;
  detailsUrl?: string;
  status?: GitHubCheckRunStatus;
  startedAt?: string;
  completedAt?: string;
  conclusion?: GitHubCheckRunConclusion;
  output?: GitHubCheckRunOutput;
};

export class GitHubAppClient {
  private readonly apiBaseUrl: string;

  constructor(private readonly options: GitHubAppClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
  }

  async createInstallationClient(installationId: number): Promise<GitHubInstallationClient> {
    const token = await this.createInstallationAccessToken(installationId);
    return new GitHubInstallationClient(this.apiBaseUrl, token.token, token.expiresAt);
  }

  async getRepositoryInstallation(owner: string, repo: string): Promise<GitHubRepositoryInstallation | null> {
    const response = await fetch(`${this.apiBaseUrl}/repos/${owner}/${repo}/installation`, {
      method: "GET",
      headers: createJsonHeaders(await this.createAppJwt())
    });

    if (response.status === 404) {
      return null;
    }

    return readGitHubJson<GitHubRepositoryInstallation>(response);
  }

  private async createInstallationAccessToken(
    installationId: number
  ): Promise<{ token: string; expiresAt?: string }> {
    const response = await fetch(`${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: createJsonHeaders(await this.createAppJwt())
    });

    const payload = await readGitHubJson<GitHubInstallationAccessToken>(response);
    if (!payload.token) {
      throw new Error("GitHub installation token response did not include a token.");
    }

    return {
      token: payload.token,
      expiresAt: payload.expires_at
    };
  }

  private async createAppJwt(): Promise<string> {
    const header = base64UrlEncodeJson({ alg: "RS256", typ: "JWT" });
    const now = Math.floor(Date.now() / 1000);
    const payload = base64UrlEncodeJson({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: this.options.appId
    });
    const unsignedToken = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemPrivateKeyToPkcs8(this.options.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsignedToken)
    );

    return `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;
  }
}

export class GitHubInstallationClient {
  constructor(
    private readonly apiBaseUrl: string,
    readonly accessToken: string,
    readonly accessTokenExpiresAt?: string
  ) {}

  async createCheckRun(input: GitHubCreateCheckRunInput): Promise<GitHubCheckRun> {
    return this.request<GitHubCheckRun>(`/repos/${input.owner}/${input.repo}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        head_sha: input.headSha,
        external_id: input.externalId,
        details_url: input.detailsUrl,
        status: input.status,
        started_at: input.startedAt,
        completed_at: input.completedAt,
        conclusion: input.conclusion,
        output: input.output
      })
    });
  }

  async updateCheckRun(input: GitHubUpdateCheckRunInput): Promise<GitHubCheckRun> {
    return this.request<GitHubCheckRun>(`/repos/${input.owner}/${input.repo}/check-runs/${input.checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        details_url: input.detailsUrl,
        status: input.status,
        started_at: input.startedAt,
        completed_at: input.completedAt,
        conclusion: input.conclusion,
        output: input.output
      })
    });
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.request<GitHubRepository>(`/repos/${owner}/${repo}`, {
      method: "GET"
    });
  }

  async getCommit(owner: string, repo: string, ref: string): Promise<GitHubCommit> {
    return this.request<GitHubCommit>(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
      method: "GET"
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: createJsonHeaders(this.accessToken)
    });

    return readGitHubJson<T>(response);
  }
}

export async function createGitHubAppFromManifest(
  code: string,
  options?: { apiBaseUrl?: string }
): Promise<GitHubManifestConversion> {
  const apiBaseUrl = options?.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
  const response = await fetch(`${apiBaseUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: createPublicJsonHeaders()
  });

  return readGitHubJson<GitHubManifestConversion>(response);
}

export async function verifyGitHubWebhookSignature(
  request: Request,
  secret: string | undefined
): Promise<boolean> {
  if (!secret) {
    return true;
  }

  const received = request.headers.get("x-hub-signature-256");
  if (!received?.startsWith("sha256=")) {
    return false;
  }

  const body = await request.clone().arrayBuffer();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, body);
  const expected = `sha256=${toHex(signature)}`;
  return timingSafeEqual(received, expected);
}

function createJsonHeaders(token: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": DEFAULT_GITHUB_USER_AGENT,
    "x-github-api-version": "2022-11-28"
  };
}

function createPublicJsonHeaders(): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": DEFAULT_GITHUB_USER_AGENT,
    "x-github-api-version": "2022-11-28"
  };
}

async function readGitHubJson<T>(response: Response): Promise<T> {
  let payload: unknown = null;

  try {
    payload = await response.json();
  } catch {
    if (!response.ok) {
      throw new Error(`GitHub API request failed with ${response.status}.`);
    }
  }

  if (!response.ok) {
    throw new Error(formatGitHubError(response.status, payload));
  }

  return payload as T;
}

function formatGitHubError(status: number, payload: unknown): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = String(payload.message);
    const details =
      "errors" in payload && Array.isArray(payload.errors)
        ? payload.errors.map((error) => JSON.stringify(error)).join("; ")
        : "";
    return details ? `GitHub API request failed with ${status}: ${message} (${details})` : `GitHub API request failed with ${status}: ${message}`;
  }

  return `GitHub API request failed with ${status}.`;
}

function base64UrlEncodeJson(value: object): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function pemPrivateKeyToPkcs8(rawPem: string): ArrayBuffer {
  const pem = rawPem.replaceAll("\\n", "\n").trim();
  if (pem.includes("BEGIN PRIVATE KEY")) {
    return decodePemBlock(pem, "PRIVATE KEY");
  }

  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    const pkcs1 = new Uint8Array(decodePemBlock(pem, "RSA PRIVATE KEY"));
    return toArrayBuffer(wrapPkcs1InPkcs8(pkcs1));
  }

  throw new Error("Unsupported GitHub App private key format.");
}

function decodePemBlock(pem: string, label: string): ArrayBuffer {
  const base64 = pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = encodeDerInteger([0x00]);
  const algorithm = encodeDerSequence([
    encodeDerOid([1, 2, 840, 113549, 1, 1, 1]),
    encodeDerNull()
  ]);
  const privateKey = encodeDerOctetString(pkcs1);

  return encodeDerSequence([version, algorithm, privateKey]);
}

function encodeDerSequence(parts: Uint8Array[]): Uint8Array {
  return encodeDer(0x30, concatBytes(parts));
}

function encodeDerInteger(bytes: number[]): Uint8Array {
  return encodeDer(0x02, Uint8Array.from(bytes));
}

function encodeDerNull(): Uint8Array {
  return Uint8Array.from([0x05, 0x00]);
}

function encodeDerOctetString(value: Uint8Array): Uint8Array {
  return encodeDer(0x04, value);
}

function encodeDerOid(oid: number[]): Uint8Array {
  const [first = 0, second = 0, ...rest] = oid;
  const bytes = [40 * first + second];

  for (const value of rest) {
    const segments: number[] = [value & 0x7f];
    let remaining = value >>> 7;

    while (remaining > 0) {
      segments.unshift((remaining & 0x7f) | 0x80);
      remaining >>>= 7;
    }

    bytes.push(...segments);
  }

  return encodeDer(0x06, Uint8Array.from(bytes));
}

function encodeDer(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.from([tag]), encodeDerLength(value.length), value]);
}

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) {
    return Uint8Array.from([length]);
  }

  const bytes: number[] = [];
  let remaining = length;

  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }

  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
