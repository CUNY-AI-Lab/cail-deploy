import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const repositoryRoot = path.resolve(import.meta.dir, "..");

const pluginManifest = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  repository: z.string(),
});

const codexMarketplace = z.object({
  name: z.string(),
  plugins: z.array(z.object({ name: z.string(), source: z.object({ path: z.string() }) })),
});

const claudeMarketplace = z.object({
  name: z.string(),
  plugins: z.array(z.object({ name: z.string(), version: z.string(), source: z.string() })),
});

const mcpConfig = z.object({
  mcpServers: z.object({ kale: z.object({ type: z.literal("http"), url: z.url() }) }),
});

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function readManifest<Schema extends z.ZodType>(
  relativePath: string,
  schema: Schema,
): Promise<z.output<Schema>> {
  return schema.parse(JSON.parse(await readRepositoryFile(relativePath)));
}

describe("Kale Deploy plugin manifests", () => {
  test("Codex and Claude Code plugin manifests describe the same plugin", async () => {
    const codex = await readManifest(
      "plugins/kale-deploy/.codex-plugin/plugin.json",
      pluginManifest,
    );
    const claude = await readManifest(
      "plugins/kale-deploy/.claude-plugin/plugin.json",
      pluginManifest,
    );

    expect(claude).toEqual(codex);
  });

  test("both marketplaces publish the plugin from the same directory", async () => {
    const codex = await readManifest(".agents/plugins/marketplace.json", codexMarketplace);
    const claude = await readManifest(".claude-plugin/marketplace.json", claudeMarketplace);
    const plugin = await readManifest(
      "plugins/kale-deploy/.claude-plugin/plugin.json",
      pluginManifest,
    );

    expect(claude.name).toBe(codex.name);
    expect(codex.plugins).toEqual([
      { name: plugin.name, source: { path: "./plugins/kale-deploy" } },
    ]);
    expect(claude.plugins).toEqual([
      { name: plugin.name, version: plugin.version, source: "./plugins/kale-deploy" },
    ]);
  });

  test("the MCP endpoint in .mcp.json matches the documented endpoint", async () => {
    const { mcpServers } = await readManifest("plugins/kale-deploy/.mcp.json", mcpConfig);
    const skill = await readRepositoryFile("plugins/kale-deploy/skills/kale-deploy/SKILL.md");
    const readme = await readRepositoryFile("README.md");

    expect(skill).toContain(`\`${mcpServers.kale.url}\``);
    expect(readme).toContain(`\`${mcpServers.kale.url}\``);
  });
});
