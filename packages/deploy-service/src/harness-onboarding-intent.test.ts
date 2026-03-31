import test from "node:test";
import assert from "node:assert/strict";

import {
  askedForKaleHandoff,
  askedForKaleToken
} from "./harness-onboarding-intent";

test("askedForKaleToken matches the older explicit token wording", () => {
  const text = "Visit https://cuny.qzz.io/kale/connect in your browser, sign in, click Generate token, and paste the token back here.";
  assert.equal(askedForKaleToken(text), true);
});

test("askedForKaleToken matches natural Claude wording with markdown and articles", () => {
  const text = "Next step: please open **https://cuny.qzz.io/kale/connect**, sign in, generate a token, and paste it back here. I'll use it to configure the Kale MCP server.";
  assert.equal(askedForKaleToken(text), true);
});

test("askedForKaleToken does not fire on plugin installation alone", () => {
  const text = "The `kale-deploy@cuny-ai-lab` plugin is installed and enabled.";
  assert.equal(askedForKaleToken(text), false);
});

test("askedForKaleHandoff still detects the OAuth browser path", () => {
  const text = "MCP server 'kale' requires authentication using OAuth. Open this URL in your browser to continue.";
  assert.equal(askedForKaleHandoff(text), true);
});
