import { baseStyles, escapeHtml, faviconLink, logoHtml } from "./ui";

export type ProjectControlFlash = {
  tone: "success" | "warning" | "error";
  message: string;
};

export type ProjectControlSecretListItem = {
  secretName: string;
  githubLogin: string;
  updatedAt: string;
};

export function renderGitHubUserAuthSuccessPage(input: {
  serviceBaseUrl: string;
  githubLogin: string;
  continueUrl: string;
  continueLabel: string;
  showHomeButton: boolean;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GitHub Connected</title>
    ${faviconLink()}
    ${baseStyles("")}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>GitHub connected</h1>
        <p>Signed in as <strong>${escapeHtml(input.githubLogin)}</strong> on GitHub.</p>
        <div class="actions">
          <a class="button" href="${escapeHtml(input.continueUrl)}">${escapeHtml(input.continueLabel)}</a>
          ${input.showHomeButton ? `<a class="button secondary" href="${escapeHtml(input.serviceBaseUrl)}">Back to Kale Deploy</a>` : ""}
        </div>
        <p>You can close this tab and return to your agent.</p>
      </section>
    </main>
  </body>
</html>`;
}

export function renderGitHubUserAuthErrorPage(message: string, serviceBaseUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GitHub Connection Error</title>
    ${faviconLink()}
    ${baseStyles("")}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>GitHub connection failed</h1>
        <p>${escapeHtml(message)}</p>
        <div class="actions">
          <a class="button" href="${escapeHtml(serviceBaseUrl)}">Return to Kale Deploy</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function buildProjectControlPanelUrl(
  oauthBaseUrl: string,
  projectName: string,
  options?: { flash?: "success" | "warning" | "error"; message?: string }
): string {
  const url = new URL(`${oauthBaseUrl}/projects/${encodeURIComponent(projectName)}/control`);
  if (options?.flash) {
    url.searchParams.set("flash", options.flash);
  }
  if (options?.message) {
    url.searchParams.set("message", options.message);
  }
  return url.toString();
}

export function readProjectControlFlash(requestUrl: string): ProjectControlFlash | undefined {
  const url = new URL(requestUrl);
  const tone = url.searchParams.get("flash");
  const message = url.searchParams.get("message");
  if (!message || (tone !== "success" && tone !== "warning" && tone !== "error")) {
    return undefined;
  }

  return { tone, message };
}

export function renderProjectControlPanelAuthErrorPage(message: string, oauthBaseUrl: string): string {
  const visibleMessage = normalizeProjectControlAuthErrorMessage(message);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Project Settings</title>
    ${faviconLink()}
    ${baseStyles("")}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>Project settings are not available yet</h1>
        <p>${escapeHtml(visibleMessage)}</p>
        <div class="actions">
          <a class="button" href="${escapeHtml(oauthBaseUrl)}">Return to Kale Deploy</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function normalizeProjectControlAuthErrorMessage(message: string): string {
  if (message === "Missing Cloudflare Access JWT assertion.") {
    return "This page needs your CUNY browser session. Open Project settings from Kale Deploy in your browser and try again.";
  }

  return message;
}

export function renderProjectAdminEntryPage(input: {
  oauthBaseUrl: string;
  serviceBaseUrl: string;
  signedInEmail: string;
  errorMessage?: string;
}): string {
  const { oauthBaseUrl, serviceBaseUrl, signedInEmail, errorMessage } = input;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Project Settings</title>
    ${faviconLink()}
    ${baseStyles(`
      .lookup-grid {
        display: grid;
        gap: 18px;
        margin-top: 4px;
      }
      .lookup-group label {
        display: block;
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--muted);
        margin-bottom: 6px;
      }
      .lookup-row {
        display: flex;
        gap: 8px;
      }
      .lookup-row input {
        flex: 1;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 10px;
        font: inherit;
      }
      .lookup-row input:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(59, 107, 204, 0.1);
      }
      .page-meta {
        margin: 4px 0 16px;
        color: var(--muted);
        font-size: 0.92rem;
      }
      .divider-or {
        text-align: center;
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .notice-error {
        background: #fff3f1;
        border-color: #f3b8ad;
      }
    `)}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>Project settings</h1>
        <p class="page-meta">Signed in as <strong>${escapeHtml(signedInEmail)}</strong></p>
        ${errorMessage ? `<div class="notice notice-error"><p>${escapeHtml(errorMessage)}</p></div>` : ""}
        <div class="lookup-grid">
          <form class="lookup-group" method="get" action="${escapeHtml(`${oauthBaseUrl}/projects/control`)}">
            <label for="projectName">Project name</label>
            <div class="lookup-row">
              <input id="projectName" type="text" name="projectName" placeholder="my-project" />
              <button class="button" type="submit">Go</button>
            </div>
          </form>
          <p class="divider-or">or</p>
          <form class="lookup-group" method="get" action="${escapeHtml(`${oauthBaseUrl}/projects/control`)}">
            <label for="repositoryFullName">GitHub repo</label>
            <div class="lookup-row">
              <input id="repositoryFullName" type="text" name="repositoryFullName" placeholder="owner/repo" />
              <button class="button" type="submit">Go</button>
            </div>
          </form>
        </div>
        <div class="actions" style="margin-top: 20px;">
          <a class="button secondary" href="${escapeHtml(serviceBaseUrl)}">Back to Kale Deploy</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function renderProjectControlPanelGatePage(input: {
  oauthBaseUrl: string;
  summary: string;
  connectUrl?: string;
  flash?: ProjectControlFlash;
}): string {
  const { oauthBaseUrl, summary, connectUrl, flash } = input;
  const toneClass = flash ? `notice notice-${flash.tone}` : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Project Settings</title>
    ${faviconLink()}
    ${baseStyles(`
      .panel-meta {
        display: grid;
        gap: 8px;
        margin-top: 18px;
      }
      .panel-meta p {
        margin: 0;
        color: var(--muted);
      }
      .notice-error {
        background: #fff3f1;
        border-color: #f3b8ad;
      }
      .notice-success {
        background: #eefaf3;
        border-color: #b9e3c8;
      }
      .notice-warning {
        background: #fff9ea;
        border-color: #ead28a;
      }
    `)}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>Project settings</h1>
        ${flash ? `<div class="${toneClass}"><p>${escapeHtml(flash.message)}</p></div>` : ""}
        <p>This page is only for people who can manage this project.</p>
        <div class="notice">
          <p>${escapeHtml(summary)}</p>
        </div>
        <div class="actions">
          ${connectUrl ? `<a class="button" href="${escapeHtml(connectUrl)}">Connect your GitHub account</a>` : ""}
          <a class="button secondary" href="${escapeHtml(oauthBaseUrl)}">Return to Kale Deploy</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function renderProjectControlPanelPage(input: {
  oauthBaseUrl: string;
  signedInEmail: string;
  projectName: string;
  repositoryFullName: string;
  statusSlug: string;
  deploymentUrl?: string;
  buildLogUrl?: string;
  errorMessage?: string;
  updatedAt: string;
  repoUrl: string;
  setupUrl: string;
  secrets: {
    count: number;
    secrets: ProjectControlSecretListItem[];
  };
  formToken: string;
  flash?: ProjectControlFlash;
}): string {
  const {
    oauthBaseUrl,
    signedInEmail,
    projectName,
    repositoryFullName,
    statusSlug,
    deploymentUrl,
    buildLogUrl,
    errorMessage,
    updatedAt,
    repoUrl,
    setupUrl,
    secrets,
    formToken,
    flash
  } = input;
  const statusLabel = statusSlug.replaceAll("_", " ");
  const toneClass = flash ? `notice notice-${flash.tone}` : "";
  const isLive = statusSlug === "live";
  const isFailed = statusSlug === "failed";
  const isBuilding = statusSlug === "running" || statusSlug === "queued";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(projectName)} Settings</title>
    ${faviconLink()}
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet" />
    ${baseStyles(`
      :root {
        --font-display: "DM Sans", system-ui, -apple-system, sans-serif;
        --font-technical: "DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        --status-hue: ${isLive ? "142" : isFailed ? "4" : isBuilding ? "38" : "220"};
        --status-color: hsl(var(--status-hue), ${isLive ? "58%, 36%" : isFailed ? "68%, 46%" : isBuilding ? "78%, 44%" : "14%, 52%"});
        --status-bg: hsl(var(--status-hue), ${isLive ? "52%, 95%" : isFailed ? "60%, 96%" : isBuilding ? "80%, 95%" : "14%, 95%"});
        --status-border: hsl(var(--status-hue), ${isLive ? "42%, 82%" : isFailed ? "50%, 85%" : isBuilding ? "60%, 82%" : "14%, 84%"});
      }

      body { font-family: var(--font-display); }

      @keyframes fadeUp {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes statusPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .project-header {
        animation: fadeUp 0.4s ease both;
      }
      .secrets-panel {
        margin-top: 20px;
        animation: fadeUp 0.4s ease both;
        animation-delay: 0.08s;
      }

      .header-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }
      .project-title {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .project-title h1 {
        font-family: var(--font-technical);
        font-size: 1.5rem;
        font-weight: 500;
        letter-spacing: -0.01em;
        margin: 0;
      }
      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 12px 4px 8px;
        border-radius: 999px;
        font-size: 0.8rem;
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: capitalize;
        color: var(--status-color);
        background: var(--status-bg);
        border: 1px solid var(--status-border);
        white-space: nowrap;
      }
      .status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--status-color);
        flex-shrink: 0;
      }
      .status-dot.pulse {
        animation: statusPulse 1.8s ease-in-out infinite;
      }
      .header-meta {
        margin: 8px 0 0;
        font-size: 0.88rem;
        color: var(--muted);
      }
      .header-meta code {
        font-family: var(--font-technical);
        font-size: 0.84rem;
      }
      .header-links {
        display: flex;
        gap: 8px;
        flex-shrink: 0;
      }
      .header-links .button {
        font-size: 0.88rem;
        padding: 8px 16px;
      }

      .flash-msg {
        margin-top: 16px;
      }
      .notice-error {
        background: #fff3f1;
        border-color: #f3b8ad;
      }
      .notice-success {
        background: #eefaf3;
        border-color: #b9e3c8;
      }
      .notice-warning {
        background: #fff9ea;
        border-color: #ead28a;
      }

      .deploy-panel {
        margin-top: 20px;
        padding: 18px 20px;
        border-radius: 14px;
        background: ${isLive ? "linear-gradient(135deg, hsl(142, 52%, 97%) 0%, hsl(180, 40%, 96%) 100%)" : "#fafbfd"};
        border: 1px solid ${isLive ? "hsl(152, 36%, 86%)" : "var(--border)"};
      }
      .deploy-url {
        display: flex;
        align-items: baseline;
        gap: 10px;
        flex-wrap: wrap;
      }
      .deploy-url-label {
        font-size: 0.76rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .deploy-url a {
        font-family: var(--font-technical);
        font-size: 1.05rem;
        font-weight: 500;
        color: var(--accent);
        text-decoration: none;
        word-break: break-all;
      }
      .deploy-url a:hover {
        text-decoration: underline;
      }
      .deploy-url-none {
        font-family: var(--font-technical);
        font-size: 1.05rem;
        font-weight: 500;
        color: var(--muted);
      }
      .deploy-meta {
        display: flex;
        gap: 16px;
        margin-top: 12px;
        font-size: 0.82rem;
        color: var(--muted);
        flex-wrap: wrap;
      }
      .deploy-meta-item {
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .deploy-meta-dot {
        width: 3px;
        height: 3px;
        border-radius: 50%;
        background: var(--border);
        flex-shrink: 0;
      }

      .section-header {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .section-header h2 {
        margin: 0;
        font-family: var(--font-display);
        font-size: 1.15rem;
        font-weight: 700;
      }
      .count-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 22px;
        height: 22px;
        padding: 0 7px;
        border-radius: 999px;
        background: var(--code-bg);
        color: var(--muted);
        font-family: var(--font-technical);
        font-size: 0.76rem;
        font-weight: 500;
      }
      .section-desc {
        margin: 6px 0 0;
        font-size: 0.88rem;
        color: var(--muted);
      }
      .secret-list {
        list-style: none;
        margin: 16px 0 0;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: 12px;
        overflow: hidden;
      }
      .secret-item {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        padding: 12px 16px;
        background: white;
        transition: background 0.15s ease;
      }
      .secret-item:hover {
        background: #fafbfd;
      }
      .secret-item + .secret-item {
        border-top: 1px solid var(--border);
      }
      .secret-item p {
        margin: 0;
      }
      .secret-name {
        font-family: var(--font-technical);
        font-size: 0.9rem;
        font-weight: 500;
        color: var(--ink);
        background: none;
        padding: 0;
      }
      .secret-meta {
        color: var(--muted);
        font-size: 0.8rem;
        margin-top: 2px;
      }
      .btn-delete {
        border: 1px solid transparent;
        border-radius: 8px;
        background: transparent;
        color: var(--muted);
        padding: 6px 10px;
        font: inherit;
        font-size: 0.82rem;
        cursor: pointer;
        transition: all 0.15s ease;
        flex-shrink: 0;
      }
      .btn-delete:hover {
        background: #fff3f1;
        border-color: #f3b8ad;
        color: var(--error);
      }
      .inline-form {
        margin: 0;
      }

      .secret-form {
        margin-top: 20px;
        padding: 18px 20px;
        border-radius: 14px;
        background: #fafbfd;
        border: 1px solid var(--border);
        display: grid;
        gap: 14px;
      }
      .secret-form-title {
        font-size: 0.88rem;
        font-weight: 600;
        color: var(--ink);
        margin: 0;
      }
      .field-grid {
        display: grid;
        gap: 14px;
      }
      .field-group label {
        display: block;
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--muted);
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .field-group input {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 10px;
        font: inherit;
        font-family: var(--font-technical);
        font-size: 0.9rem;
        background: white;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .field-group input:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(59, 107, 204, 0.08);
      }
      .field-group input::placeholder {
        color: var(--border);
      }
      .field-help {
        margin: 4px 0 0;
        font-size: 0.78rem;
        color: var(--muted);
      }
      .form-actions {
        display: flex;
        justify-content: flex-end;
      }
      .form-actions .button {
        font-size: 0.88rem;
        padding: 9px 20px;
      }

      @media (min-width: 640px) {
        .field-grid {
          grid-template-columns: 1fr 1fr;
        }
      }
    `)}
  </head>
  <body>
    <main>
      <section class="card project-header">
        <div class="header-row">
          <div>
            <div class="logo" style="margin-bottom: 14px;">${logoHtml("36px")}</div>
            <div class="project-title">
              <h1>${escapeHtml(projectName)}</h1>
              <span class="status-badge"><span class="status-dot${isBuilding ? " pulse" : ""}"></span>${escapeHtml(statusLabel)}</span>
            </div>
            <p class="header-meta">Signed in as <strong>${escapeHtml(signedInEmail)}</strong> &middot; <code>${escapeHtml(repositoryFullName)}</code></p>
          </div>
          <div class="header-links">
            <a class="button secondary" href="${escapeHtml(repoUrl)}">GitHub</a>
            <a class="button secondary" href="${escapeHtml(setupUrl)}">Setup</a>
          </div>
        </div>
        ${flash ? `<div class="flash-msg ${toneClass}"><p>${escapeHtml(flash.message)}</p></div>` : ""}
        ${errorMessage ? `<div class="flash-msg notice notice-warning"><p><strong>Latest issue:</strong> ${escapeHtml(errorMessage)}</p></div>` : ""}
        <div class="deploy-panel">
          <div class="deploy-url">
            <span class="deploy-url-label">Live at</span>
            ${deploymentUrl
              ? `<a href="${escapeHtml(deploymentUrl)}">${escapeHtml(deploymentUrl)}</a>`
              : `<span class="deploy-url-none">Not deployed yet</span>`}
          </div>
          <div class="deploy-meta">
            <span class="deploy-meta-item">Updated ${escapeHtml(updatedAt)}</span>
            ${buildLogUrl ? `<span class="deploy-meta-dot"></span><span class="deploy-meta-item"><a href="${escapeHtml(buildLogUrl)}">Build log</a></span>` : ""}
          </div>
        </div>
      </section>

      <section class="card secrets-panel">
        <div class="section-header">
          <h2>Secrets</h2>
          <span class="count-badge">${secrets.count}</span>
        </div>
        <p class="section-desc">Environment variables injected at build time. Values are write-only.</p>
        ${secrets.count > 0
          ? `<ul class="secret-list">
              ${secrets.secrets.map((secret) => `
                <li class="secret-item">
                  <div>
                    <p><code class="secret-name">${escapeHtml(secret.secretName)}</code></p>
                    <p class="secret-meta">Set by ${escapeHtml(secret.githubLogin)} &middot; ${escapeHtml(secret.updatedAt)}</p>
                  </div>
                  <form class="inline-form" method="post" action="${escapeHtml(`${oauthBaseUrl}/projects/${encodeURIComponent(projectName)}/control/secrets/${encodeURIComponent(secret.secretName)}/delete`)}">
                    <input type="hidden" name="formToken" value="${escapeHtml(formToken)}" />
                    <button class="btn-delete" type="submit">Delete</button>
                  </form>
                </li>
              `).join("")}
            </ul>`
          : `<div class="notice" style="margin-top: 16px;"><p>No secrets stored yet.</p></div>`}
        <form class="secret-form" method="post" action="${escapeHtml(`${oauthBaseUrl}/projects/${encodeURIComponent(projectName)}/control/secrets`)}">
          <input type="hidden" name="formToken" value="${escapeHtml(formToken)}" />
          <p class="secret-form-title">Add or update a secret</p>
          <div class="field-grid">
            <div class="field-group">
              <label for="secret-name">Name</label>
              <input id="secret-name" name="secretName" placeholder="OPENAI_API_KEY" required autocomplete="off" spellcheck="false" />
              <p class="field-help">Uppercase, numbers, underscores.</p>
            </div>
            <div class="field-group">
              <label for="secret-value">Value</label>
              <input id="secret-value" type="password" name="secretValue" required autocomplete="off" />
              <p class="field-help">Stored securely. Never shown again.</p>
            </div>
          </div>
          <div class="form-actions">
            <button class="button" type="submit">Save secret</button>
          </div>
        </form>
      </section>
    </main>
  </body>
</html>`;
}

export function describeGitHubUserAuthContinueLabel(input: {
  serviceBaseUrl: string;
  continueUrl: string;
  hasRepositoryContext: boolean;
}): string {
  if (input.continueUrl === input.serviceBaseUrl) {
    return "Continue in Kale Deploy";
  }

  const pathname = new URL(input.continueUrl).pathname;
  if (/^\/projects\/[^/]+\/control$/.test(pathname) || /^\/projects\/[^/]+\/settings$/.test(pathname)) {
    return "Back to project settings";
  }

  if (input.hasRepositoryContext) {
    return "Back to this project's setup";
  }

  return "Continue in Kale Deploy";
}
