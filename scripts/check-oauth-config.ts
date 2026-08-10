const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = socket.port;
socket.stop(true);
const process = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--local",
    "--config",
    "wrangler.oauth-config-test.jsonc",
    "--port",
    String(port),
  ],
  { stdout: "pipe", stderr: "pipe" },
);

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/?scenario=invalid`);
      if (response.status === 503) break;
    } catch {
      // Local workerd is still starting.
    }
    if (process.exitCode !== null) break;
    await Bun.sleep(100);
  }
  const requestId = "33333333-3333-4333-8333-333333333333";
  for (const scenario of ["invalid", "missing", "credentials"]) {
    const response = await fetch(`http://127.0.0.1:${port}/?scenario=${scenario}`, {
      headers: { "X-CAIL-Request-Id": requestId },
    });
    if (response.status !== 503) {
      throw new Error(
        `${scenario} OAuth config returned ${response.status}: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; requestId?: string; stack?: unknown };
    };
    if (
      body.error?.code !== "oauth_not_configured" ||
      body.error.message !== "Sign-in is unavailable right now. Try again shortly." ||
      body.error.requestId !== requestId ||
      body.error.stack !== undefined
    ) {
      throw new Error(`${scenario} OAuth config leaked or drifted: ${JSON.stringify(body)}`);
    }
  }
  console.log("OAuth adapter config failure gate passed: invalid, missing, credentials");
} finally {
  process.kill();
  await process.exited;
}
