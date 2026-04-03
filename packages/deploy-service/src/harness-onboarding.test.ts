import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConnectionHarnessCatalog,
  buildHarnessSetupPrompts
} from "./harness-onboarding";

const promptContext = {
  marketingName: "Kale Deploy",
  serviceBaseUrl: "https://cuny.qzz.io/kale",
  mcpEndpoint: "https://cuny.qzz.io/kale/mcp"
};

test("Claude catalog entry uses mcp-remote only as OAuth bootstrap and then finalizes to direct HTTP with headersHelper", () => {
  const harnesses = buildConnectionHarnessCatalog(promptContext);
  const claude = harnesses.find((entry) => entry.id === "claude");

  assert.ok(claude);
  assert.equal(claude.installSurface, "plugin_marketplace");
  assert.equal(claude.installMode, "command");
  assert.equal(claude.manualFallback?.authMode, "oauth_bridge_to_http");
  assert.match(claude.manualFallback?.hint ?? "", /Current recommended Claude bootstrap and finalize path/i);
  assert.ok(
    claude.installNotes.some((note) => /Use mcp-remote only to complete the OAuth browser flow/i.test(note))
  );
  assert.ok(
    claude.installNotes.some((note) => /single user-scope kale HTTP server/i.test(note))
  );
  assert.ok(
    (claude.manualFallback?.notes ?? []).some((note) => /headersHelper to read the latest valid Kale mcp-remote OAuth token/i.test(note))
  );
  assert.ok(
    (claude.manualFallback?.notes ?? []).some((note) => /rerun the mcp-remote bootstrap and sync steps/i.test(note))
  );
  assert.ok(
    claude.installNotes.some((note) => /do not search the MCP registry first/i.test(note))
  );
  assert.ok(
    claude.installNotes.some((note) => /do not invent claude mcp auth, login, or authenticate commands/i.test(note))
  );
  assert.ok(
    (claude.manualFallback?.notes ?? []).some((note) => /Use mcp-remote only long enough to complete the OAuth browser flow/i.test(note))
  );
  assert.ok(
    (claude.manualFallback?.instruction ?? "").includes("mcp-remote")
  );
  assert.ok(
    (claude.manualFallback?.instruction ?? "").includes("kale-claude-connect.mjs")
  );
  assert.ok(
    (claude.manualFallback?.notes ?? []).some((note) => /Last-resort token bridge:/i.test(note))
  );
});

test("Claude setup prompt tells the harness to finalize from the bootstrap bridge to direct HTTP with headersHelper", () => {
  const prompts = buildHarnessSetupPrompts("current", promptContext);
  const claude = prompts.find((entry) => entry.id === "claude");

  assert.ok(claude);
  assert.match(claude.prompt, /do not search the MCP registry first when the local Kale plugin is installed/i);
  assert.match(claude.prompt, /Use `mcp-remote` only to complete the browser OAuth flow/i);
  assert.match(claude.prompt, /replace that temporary bridge with one direct HTTP `kale` server/i);
  assert.match(claude.prompt, /kale-claude-connect\.mjs/);
  assert.match(claude.prompt, /headersHelper/i);
  assert.match(claude.prompt, /If the helper reports no valid token, rerun the `mcp-remote` bootstrap/i);
  assert.match(claude.prompt, /do not invent `claude mcp auth`, `claude mcp login`, or `claude mcp authenticate` commands/i);
  assert.match(claude.prompt, /claude mcp add -s user kale -- npx -y mcp-remote/i);
  assert.match(claude.prompt, /Only if `mcp-remote` also fails/i);
  assert.match(claude.prompt, /https:\/\/cuny\.qzz\.io\/kale\/connect/);
});
