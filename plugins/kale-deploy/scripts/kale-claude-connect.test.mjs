import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve("/Users/stephenzweibel/Apps/CAIL-deploy/plugins/kale-deploy/scripts/kale-claude-connect.mjs");

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function createTestJwt(payload) {
  return [
    base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" })),
    base64UrlEncode(JSON.stringify(payload)),
    "signature"
  ].join(".");
}

async function writeTokenFixture(root, fileName, payload) {
  const versionRoot = path.join(root, "mcp-remote-0.1.37");
  await mkdir(versionRoot, { recursive: true });
  await writeFile(path.join(versionRoot, fileName), JSON.stringify({
    access_token: createTestJwt(payload),
    token_type: "Bearer"
  }, null, 2));
}

test("sync ignores unrelated and expired mcp-remote tokens", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "kale-claude-connect-"));
  const authRoot = path.join(tempRoot, "mcp-auth");
  const configPath = path.join(tempRoot, "claude.json");
  const nowEpochSeconds = Math.floor(Date.now() / 1000);

  await writeTokenFixture(authRoot, "001_foreign_tokens.json", {
    iss: "https://example.com",
    resource: "https://example.com/mcp",
    exp: nowEpochSeconds + 3600
  });
  await writeTokenFixture(authRoot, "002_expired_tokens.json", {
    iss: "https://cuny.qzz.io/kale",
    resource: "https://cuny.qzz.io/kale/mcp",
    exp: nowEpochSeconds - 60
  });

  const syncResult = await execFileAsync(process.execPath, [
    SCRIPT_PATH,
    "sync",
    "--config",
    configPath,
    "--auth-root",
    authRoot,
    "--mcp-endpoint",
    "https://cuny.qzz.io/kale/mcp"
  ], {
    cwd: "/Users/stephenzweibel/Apps/CAIL-deploy"
  }).catch((error) => error);

  assert.equal(syncResult.code, 1);
  assert.match(syncResult.stderr ?? "", /No valid Kale mcp-remote OAuth token found/i);
});

test("sync writes a headersHelper-backed direct HTTP entry from the latest valid Kale token", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "kale-claude-connect-"));
  const authRoot = path.join(tempRoot, "mcp-auth");
  const configPath = path.join(tempRoot, "claude.json");
  const nowEpochSeconds = Math.floor(Date.now() / 1000);

  await writeTokenFixture(authRoot, "001_valid_tokens.json", {
    iss: "https://cuny.qzz.io/kale",
    resource: "https://cuny.qzz.io/kale/mcp",
    exp: nowEpochSeconds + 3600
  });

  const { stdout } = await execFileAsync(process.execPath, [
    SCRIPT_PATH,
    "sync",
    "--config",
    configPath,
    "--auth-root",
    authRoot,
    "--mcp-endpoint",
    "https://cuny.qzz.io/kale/mcp"
  ], {
    cwd: "/Users/stephenzweibel/Apps/CAIL-deploy"
  });

  const syncBody = JSON.parse(stdout);
  assert.match(syncBody.summary, /headersHelper/i);
  assert.match(syncBody.headersHelper, /kale-claude-connect\.mjs' headers/u);

  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config.mcpServers.kale.type, "http");
  assert.deepEqual(config.mcpServers.kale.url, "https://cuny.qzz.io/kale/mcp");
  assert.equal(typeof config.mcpServers.kale.headersHelper, "string");
  assert.equal(config.mcpServers.kale.headers, undefined);

  const { stdout: headersStdout } = await execFileAsync(process.execPath, [
    SCRIPT_PATH,
    "headers",
    "--auth-root",
    authRoot,
    "--mcp-endpoint",
    "https://cuny.qzz.io/kale/mcp"
  ], {
    cwd: "/Users/stephenzweibel/Apps/CAIL-deploy"
  });

  assert.equal(typeof JSON.parse(headersStdout).Authorization, "string");
});
