import lock from "../bun.lock";
import {
  verifyCloudflareToolchainReceipt,
  type CloudflareCompatibilityReceipt,
} from "./cloudflare-toolchain-receipt";

const expected = {
  dependencies: {
    "@modelcontextprotocol/client": {
      version: "2.0.0",
      integrity:
        "sha512-8f1OghQ2rjzIOfqgUCP+8GiUWqRs89njoWLNqAe8kWmDePv3s1fZXseej+QXemssEuuOvLLmLO/kqM3IQHtISw==",
    },
    "@modelcontextprotocol/server": {
      version: "2.0.0",
      integrity:
        "sha512-YhHWdHfpFMQfd0prsEnxKeS3Qz3ytIGmsS0sth4KDjnacIT7hxk6hXHkJ9KysxlkvTM+WZAtQbbcUhdoP4Hvtw==",
    },
    agents: {
      version: "0.20.1",
      integrity:
        "sha512-HQRYMeZpD3k8djYBH7atRPojZMee3NvmXkzsmMWXfdHZ94vMljmWqSsD1XZd70LovHyQrw6/R81AZZIsRiFM6Q==",
    },
  },
  devDependencies: {
    "@modelcontextprotocol/sdk": {
      version: "1.30.0",
      integrity:
        "sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==",
    },
    "@modelcontextprotocol/sdk-legacy": {
      declared: "npm:@modelcontextprotocol/sdk@1.29.0",
      version: "1.29.0",
      integrity:
        "sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==",
    },
  },
} as const;

const root = new URL("../", import.meta.url);
const packageJson = (await Bun.file(new URL("package.json", root)).json()) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const compatibility = (await Bun.file(
  new URL("cloudflare-compatibility.json", root),
).json()) as CloudflareCompatibilityReceipt;

const toolchain = verifyCloudflareToolchainReceipt(packageJson, lock, compatibility);

for (const dependencyKind of ["dependencies", "devDependencies"] as const) {
  for (const [name, receipt] of Object.entries(expected[dependencyKind])) {
    const declared = "declared" in receipt ? receipt.declared : receipt.version;
    if (packageJson[dependencyKind][name] !== declared) {
      throw new Error(`${name} must be pinned exactly to ${declared}`);
    }
    const installed = (await Bun.file(
      new URL(`node_modules/${name}/package.json`, root),
    ).json()) as { version?: string };
    if (installed.version !== receipt.version) {
      throw new Error(`${name} installed version drifted from ${receipt.version}`);
    }
    const lockRecord = lock.packages[name];
    if (!Array.isArray(lockRecord) || lockRecord[3] !== receipt.integrity) {
      throw new Error(`${name} lock integrity drifted`);
    }
  }
}

const agentsReceipt = compatibility.packages.agents;
if (
  agentsReceipt?.accepted !== expected.dependencies.agents.version ||
  `sha512-${agentsReceipt.npmIntegritySha512}` !== expected.dependencies.agents.integrity ||
  agentsReceipt.boundary !== "src/adapters/cloudflare/mcp.ts" ||
  agentsReceipt.legacyClientPin !== "@modelcontextprotocol/sdk@1.29.0" ||
  JSON.stringify(agentsReceipt.peerPins) !==
    JSON.stringify({
      "@modelcontextprotocol/client": "2.0.0",
      "@modelcontextprotocol/server": "2.0.0",
      "@modelcontextprotocol/sdk": "1.30.0",
    })
) {
  throw new Error("Agents MCP compatibility receipt drifted");
}

console.log(
  `MCP package pins and lock integrities passed: agents@0.20.1, MCP SDK v2.0.0, peer SDK@1.30.0, legacy client SDK@1.29.0; Cloudflare toolchain receipt passed: Wrangler ${toolchain.wranglerVersion}, pool ${toolchain.poolVersion}`,
);
