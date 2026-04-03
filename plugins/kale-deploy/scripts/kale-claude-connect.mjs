import os from "node:os";
import path from "node:path";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_MCP_ENDPOINT = "https://cuny.qzz.io/kale/mcp";
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".claude.json");
const DEFAULT_AUTH_ROOT = path.join(os.homedir(), ".mcp-auth");
const DEFAULT_SERVER_NAME = "kale";
const TOKEN_EXPIRY_GRACE_SECONDS = 60;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function printUsage() {
  console.error(`Usage:
  node kale-claude-connect.mjs sync [--config <path>] [--auth-root <path>] [--mcp-endpoint <url>] [--name <server-name>]
  node kale-claude-connect.mjs headers [--auth-root <path>] [--mcp-endpoint <url>]
  node kale-claude-connect.mjs status [--config <path>] [--auth-root <path>] [--mcp-endpoint <url>] [--name <server-name>]`);
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) {
      continue;
    }

    if (!value.startsWith("--")) {
      throw new Error(`Unexpected argument: ${value}`);
    }

    const [flagName, inlineValue] = value.split("=", 2);
    const nextValue = inlineValue ?? args[index + 1];
    if (!nextValue) {
      throw new Error(`Missing value for ${flagName}`);
    }

    switch (flagName) {
      case "--config":
        options.configPath = nextValue;
        break;
      case "--auth-root":
        options.authRoot = nextValue;
        break;
      case "--mcp-endpoint":
        options.mcpEndpoint = nextValue;
        break;
      case "--name":
        options.serverName = nextValue;
        break;
      default:
        throw new Error(`Unknown flag: ${flagName}`);
    }

    if (inlineValue == null) {
      index += 1;
    }
  }

  return {
    command,
    configPath: options.configPath ?? DEFAULT_CONFIG_PATH,
    authRoot: options.authRoot ?? DEFAULT_AUTH_ROOT,
    mcpEndpoint: options.mcpEndpoint ?? DEFAULT_MCP_ENDPOINT,
    serverName: options.serverName ?? DEFAULT_SERVER_NAME
  };
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function parseJwtPayload(token) {
  const segments = token.split(".");
  if (segments.length < 2) {
    return undefined;
  }

  try {
    return JSON.parse(base64UrlDecode(segments[1]));
  } catch {
    return undefined;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\"'\"'`)}'`;
}

function buildHeadersHelperCommand(options) {
  return `${shellQuote(process.execPath)} ${shellQuote(SCRIPT_PATH)} headers --auth-root ${shellQuote(options.authRoot)} --mcp-endpoint ${shellQuote(options.mcpEndpoint)}`;
}

function buildTokenEndpoint(mcpEndpoint) {
  const endpointBase = mcpEndpoint.replace(/\/mcp$/u, "");
  return `${endpointBase}/oauth/token`;
}

function isTokenStillValid(expiresAtEpochSeconds, graceSeconds = TOKEN_EXPIRY_GRACE_SECONDS) {
  return typeof expiresAtEpochSeconds === "number" && expiresAtEpochSeconds > Math.floor(Date.now() / 1000) + graceSeconds;
}

function normalizeTokenMetadata(token, payload) {
  const resource = typeof payload?.resource === "string" ? payload.resource : undefined;
  const issuer = typeof payload?.iss === "string" ? payload.iss : undefined;
  const expiresAtEpochSeconds = typeof payload?.exp === "number" ? payload.exp : undefined;
  const expiresAt = typeof expiresAtEpochSeconds === "number"
    ? new Date(expiresAtEpochSeconds * 1000).toISOString()
    : undefined;
  const clientId = typeof payload?.client_id === "string" ? payload.client_id : undefined;

  return {
    accessToken: token,
    resource,
    issuer,
    expiresAtEpochSeconds,
    expiresAt,
    clientId
  };
}

function isMatchingKaleToken(metadata, mcpEndpoint) {
  const endpointBase = mcpEndpoint.replace(/\/mcp$/u, "");
  return metadata.resource === mcpEndpoint && metadata.issuer === endpointBase;
}

async function refreshTokenFile({ tokenFilePath, tokens, refreshTokenMetadata, mcpEndpoint }) {
  if (!refreshTokenMetadata.clientId) {
    return undefined;
  }

  const response = await fetch(buildTokenEndpoint(mcpEndpoint), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: refreshTokenMetadata.clientId,
      refresh_token: tokens.refresh_token
    }).toString()
  });

  if (!response.ok) {
    return undefined;
  }

  const refreshed = await response.json();
  if (typeof refreshed?.access_token !== "string" || refreshed.access_token.length === 0) {
    return undefined;
  }

  const nextTokens = {
    ...tokens,
    ...refreshed
  };
  await writeFile(tokenFilePath, `${JSON.stringify(nextTokens, null, 2)}\n`, "utf8");

  const accessTokenMetadata = normalizeTokenMetadata(
    nextTokens.access_token,
    parseJwtPayload(nextTokens.access_token)
  );
  if (!isMatchingKaleToken(accessTokenMetadata, mcpEndpoint) || !isTokenStillValid(accessTokenMetadata.expiresAtEpochSeconds)) {
    return undefined;
  }

  const tokenType = typeof nextTokens.token_type === "string" ? nextTokens.token_type : "Bearer";

  return {
    filePath: tokenFilePath,
    accessToken: nextTokens.access_token,
    authorizationHeader: `${tokenType} ${nextTokens.access_token}`,
    resource: accessTokenMetadata.resource,
    issuer: accessTokenMetadata.issuer,
    expiresAt: accessTokenMetadata.expiresAt,
    expiresAtEpochSeconds: accessTokenMetadata.expiresAtEpochSeconds,
    clientId: accessTokenMetadata.clientId
  };
}

async function findTokenFiles(root) {
  const candidates = [];
  let authRoots = [];

  try {
    authRoots = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of authRoots) {
    if (!entry.isDirectory() || !entry.name.startsWith("mcp-remote-")) {
      continue;
    }

    const versionRoot = path.join(root, entry.name);
    let files = [];
    try {
      files = await readdir(versionRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith("_tokens.json")) {
        continue;
      }

      const filePath = path.join(versionRoot, file.name);
      let metadata;
      try {
        metadata = await stat(filePath);
      } catch {
        continue;
      }

      candidates.push({ filePath, mtimeMs: metadata.mtimeMs });
    }
  }

  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function loadLatestToken({ authRoot, mcpEndpoint }) {
  const tokenFiles = await findTokenFiles(authRoot);

  for (const candidate of tokenFiles) {
    let raw;
    try {
      raw = await readFile(candidate.filePath, "utf8");
    } catch {
      continue;
    }

    let tokens;
    try {
      tokens = JSON.parse(raw);
    } catch {
      continue;
    }

    if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
      continue;
    }

    const accessTokenMetadata = normalizeTokenMetadata(
      tokens.access_token,
      parseJwtPayload(tokens.access_token)
    );
    const tokenType = typeof tokens.token_type === "string" ? tokens.token_type : "Bearer";

    if (isMatchingKaleToken(accessTokenMetadata, mcpEndpoint) && isTokenStillValid(accessTokenMetadata.expiresAtEpochSeconds)) {
      return {
        filePath: candidate.filePath,
        accessToken: tokens.access_token,
        authorizationHeader: `${tokenType} ${tokens.access_token}`,
        resource: accessTokenMetadata.resource,
        issuer: accessTokenMetadata.issuer,
        expiresAt: accessTokenMetadata.expiresAt,
        expiresAtEpochSeconds: accessTokenMetadata.expiresAtEpochSeconds,
        clientId: accessTokenMetadata.clientId
      };
    }

    if (typeof tokens.refresh_token !== "string" || tokens.refresh_token.length === 0) {
      continue;
    }

    const refreshTokenMetadata = normalizeTokenMetadata(
      tokens.refresh_token,
      parseJwtPayload(tokens.refresh_token)
    );
    if (!isMatchingKaleToken(refreshTokenMetadata, mcpEndpoint) || !isTokenStillValid(refreshTokenMetadata.expiresAtEpochSeconds, 0)) {
      continue;
    }

    const refreshed = await refreshTokenFile({
      tokenFilePath: candidate.filePath,
      tokens,
      refreshTokenMetadata,
      mcpEndpoint
    });
    if (refreshed) {
      return refreshed;
    }
  }
  return undefined;
}

async function readClaudeConfig(configPath) {
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeClaudeConfig(configPath, config) {
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function runStatus(options) {
  const token = await loadLatestToken(options);
  const config = await readClaudeConfig(options.configPath);
  const existingEntry = config?.mcpServers?.[options.serverName];

  console.log(JSON.stringify({
    configPath: options.configPath,
    authRoot: options.authRoot,
    mcpEndpoint: options.mcpEndpoint,
    serverName: options.serverName,
    hasConfigEntry: Boolean(existingEntry),
    configEntryType: existingEntry?.type,
    configEntryUrl: existingEntry?.url,
    configEntryHeadersHelper: existingEntry?.headersHelper,
    configEntryHasStaticAuthorization: typeof existingEntry?.headers?.Authorization === "string",
    hasValidToken: Boolean(token),
    tokenSourcePath: token?.filePath,
    tokenResource: token?.resource,
    tokenIssuer: token?.issuer,
    tokenExpiresAt: token?.expiresAt
  }, null, 2));
}

async function runHeaders(options) {
  const token = await loadLatestToken(options);
  if (!token) {
    throw new Error(`No valid Kale mcp-remote OAuth token found under ${options.authRoot}. Run the Kale mcp-remote bootstrap again.`);
  }

  process.stdout.write(`${JSON.stringify({
    Authorization: token.authorizationHeader
  })}\n`);
}

async function runSync(options) {
  const token = await loadLatestToken(options);
  if (!token) {
    throw new Error(`No valid Kale mcp-remote OAuth token found under ${options.authRoot}. Run the Kale mcp-remote bootstrap first.`);
  }

  const config = await readClaudeConfig(options.configPath);
  const mcpServers = typeof config.mcpServers === "object" && config.mcpServers !== null
    ? { ...config.mcpServers }
    : {};

  mcpServers[options.serverName] = {
    type: "http",
    url: options.mcpEndpoint,
    headersHelper: buildHeadersHelperCommand(options)
  };

  config.mcpServers = mcpServers;
  await writeClaudeConfig(options.configPath, config);

  console.log(JSON.stringify({
    configPath: options.configPath,
    serverName: options.serverName,
    mcpEndpoint: options.mcpEndpoint,
    tokenSourcePath: token.filePath,
    tokenResource: token.resource,
    tokenIssuer: token.issuer,
    tokenExpiresAt: token.expiresAt,
    headersHelper: buildHeadersHelperCommand(options),
    summary: "Claude Kale config updated to direct HTTP with a headersHelper backed by the latest valid Kale mcp-remote OAuth token."
  }, null, 2));
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  switch (parsed.command) {
    case "headers":
      await runHeaders(parsed);
      break;
    case "status":
      await runStatus(parsed);
      break;
    case "sync":
      await runSync(parsed);
      break;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
