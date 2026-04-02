import { baseStyles, escapeHtml, faviconLink, logoHtml } from "./ui";
import { formatRuntimeLaneLabel } from "./runtime-lanes";

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
  baseUrl: string,
  projectName: string,
  options?: { flash?: "success" | "warning" | "error"; message?: string }
): string {
  const url = new URL(`${baseUrl}/projects/${encodeURIComponent(projectName)}/control`);
  if (options?.flash) {
    url.searchParams.set("flash", options.flash);
  }
  if (options?.message) {
    url.searchParams.set("message", options.message);
  }
  return url.toString();
}

export function buildProjectAdminEntryUrl(
  baseUrl: string,
  options?: { flash?: "success" | "warning" | "error"; message?: string }
): string {
  const url = new URL(`${baseUrl}/projects/control`);
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

export function renderProjectControlPanelAuthErrorPage(message: string, serviceBaseUrl: string): string {
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
          <a class="button" href="${escapeHtml(serviceBaseUrl)}">Return to Kale Deploy</a>
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
  controlBaseUrl: string;
  serviceBaseUrl: string;
  signedInEmail: string;
  errorMessage?: string;
  flash?: ProjectControlFlash;
}): string {
  const { controlBaseUrl, serviceBaseUrl, signedInEmail, errorMessage, flash } = input;
  const toneClass = flash ? `notice notice-${flash.tone}` : "";

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
        <p class="page-meta">Signed in as <strong>${escapeHtml(signedInEmail)}</strong></p>
        ${flash ? `<div class="${toneClass}"><p>${escapeHtml(flash.message)}</p></div>` : ""}
        ${errorMessage ? `<div class="notice notice-error"><p>${escapeHtml(errorMessage)}</p></div>` : ""}
        <div class="lookup-grid">
          <form class="lookup-group" method="get" action="${escapeHtml(`${controlBaseUrl}/projects/control`)}">
            <label for="projectName">Project name</label>
            <div class="lookup-row">
              <input id="projectName" type="text" name="projectName" placeholder="my-project" />
              <button class="button" type="submit">Go</button>
            </div>
          </form>
          <p class="divider-or">or</p>
          <form class="lookup-group" method="get" action="${escapeHtml(`${controlBaseUrl}/projects/control`)}">
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
  serviceBaseUrl: string;
  summary: string;
  connectUrl?: string;
  flash?: ProjectControlFlash;
}): string {
  const { serviceBaseUrl, summary, connectUrl, flash } = input;
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
          <a class="button secondary" href="${escapeHtml(serviceBaseUrl)}">Return to Kale Deploy</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function renderProjectControlPanelPage(input: {
  controlBaseUrl: string;
  signedInEmail: string;
  projectName: string;
  repositoryFullName: string;
  statusSlug: string;
  deploymentUrl?: string;
  runtimeLane?: string;
  recommendedRuntimeLane?: string;
  runtimeEvidenceFramework?: string;
  runtimeEvidenceClassification?: string;
  runtimeEvidenceConfidence?: string;
  runtimeEvidenceBasis?: string[];
  runtimeEvidenceSummary?: string;
  buildLogUrl?: string;
  errorMessage?: string;
  errorDetail?: string;
  errorKind?: string;
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
    controlBaseUrl,
    signedInEmail,
    projectName,
    repositoryFullName,
    statusSlug,
    deploymentUrl,
    runtimeLane,
    recommendedRuntimeLane,
    runtimeEvidenceFramework,
    runtimeEvidenceClassification,
    runtimeEvidenceConfidence,
    runtimeEvidenceBasis,
    runtimeEvidenceSummary,
    buildLogUrl,
    errorMessage,
    errorDetail,
    errorKind,
    updatedAt,
    repoUrl,
    setupUrl,
    secrets,
    formToken,
    flash
  } = input;
  const statusLabel = statusSlug.replaceAll("_", " ");
  const runtimeLaneLabel = runtimeLane ? formatRuntimeLaneLabel(runtimeLane as Parameters<typeof formatRuntimeLaneLabel>[0]) : undefined;
  const recommendedRuntimeLaneLabel = recommendedRuntimeLane
    ? formatRuntimeLaneLabel(recommendedRuntimeLane as Parameters<typeof formatRuntimeLaneLabel>[0])
    : undefined;
  const runtimeEvidenceClassificationLabel = formatRuntimeEvidenceClassification(runtimeEvidenceClassification);
  const runtimeEvidenceConfidenceLabel = formatRuntimeEvidenceConfidence(runtimeEvidenceConfidence);
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
      .danger-panel {
        margin-top: 20px;
        animation: fadeUp 0.4s ease both;
        animation-delay: 0.12s;
      }
      .domains-panel {
        margin-top: 20px;
        animation: fadeUp 0.4s ease both;
        animation-delay: 0.04s;
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
      .runtime-assessment {
        margin-top: 14px;
        padding: 14px 16px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.74);
      }
      .runtime-assessment-label {
        margin: 0 0 6px;
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .runtime-assessment-summary {
        margin: 0;
        font-size: 0.92rem;
        line-height: 1.55;
        color: var(--ink);
      }
      .runtime-assessment-summary code {
        font-size: 0.8rem;
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
      .domain-primary-card {
        margin-top: 16px;
        padding: 18px 20px;
        border-radius: 14px;
        background: #fafbfd;
        border: 1px solid var(--border);
      }
      .domain-primary-label {
        margin: 0;
        font-size: 0.76rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .domain-primary-url {
        margin: 8px 0 0;
      }
      .domain-primary-url a {
        font-family: var(--font-technical);
        font-size: 1.02rem;
        font-weight: 500;
        color: var(--accent);
        text-decoration: none;
        word-break: break-all;
      }
      .domain-primary-url a:hover {
        text-decoration: underline;
      }
      .domain-list {
        list-style: none;
        margin: 16px 0 0;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: 12px;
        overflow: hidden;
      }
      .domain-item {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        padding: 12px 16px;
        background: white;
      }
      .domain-item + .domain-item {
        border-top: 1px solid var(--border);
      }
      .domain-item p {
        margin: 0;
      }
      .domain-name {
        font-family: var(--font-technical);
        font-size: 0.9rem;
        font-weight: 500;
        color: var(--ink);
      }
      .domain-url {
        margin-top: 2px;
        font-size: 0.82rem;
        color: var(--muted);
      }
      .domain-url a {
        color: inherit;
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
      .danger-zone {
        margin-top: 16px;
        padding: 18px 20px;
        border-radius: 14px;
        border: 1px solid #efb7ad;
        background: #fff6f4;
      }
      .danger-zone p {
        margin: 0;
      }
      .danger-help {
        margin-top: 8px;
        color: var(--muted);
        font-size: 0.82rem;
      }
      .danger-actions {
        margin-top: 14px;
      }
      .danger-button {
        background: #a52f1a;
      }
      .danger-button:hover {
        background: #8c2715;
      }

      .build-log-detail {
        margin-top: 12px;
        border: 1px solid var(--status-border, var(--border));
        border-radius: 8px;
        background: var(--bg);
      }
      .build-log-detail summary {
        cursor: pointer;
        padding: 10px 14px;
        font-size: 0.88rem;
        color: var(--muted);
        user-select: none;
      }
      .build-log-detail summary:hover {
        color: var(--ink);
      }
      .build-log-detail[open] summary {
        border-bottom: 1px solid var(--border);
      }
      .build-log-intro {
        padding: 10px 14px 0;
        font-size: 0.88rem;
        color: var(--muted);
      }
      .build-log-detail pre {
        margin: 0;
        padding: 12px 14px;
        max-height: 400px;
        overflow: auto;
        font-family: var(--font-technical, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 0.82rem;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--ink);
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
        ${errorDetail ? `<details class="build-log-detail"${isFailed ? " open" : ""}>
          <summary>Build output</summary>
          <p class="build-log-intro">${escapeHtml(
            errorKind === "needs_adaptation"
              ? "This project needs changes before it can deploy:"
              : errorKind === "unsupported"
                ? "This project type is not supported:"
                : "The build produced this output:")}</p>
          <pre><code>${escapeHtml(errorDetail)}</code></pre>
        </details>` : ""}
        <div class="deploy-panel">
          <div class="deploy-url">
            <span class="deploy-url-label">Live at</span>
            ${deploymentUrl
              ? `<a href="${escapeHtml(deploymentUrl)}">${escapeHtml(deploymentUrl)}</a>`
              : `<span class="deploy-url-none">Not deployed yet</span>`}
          </div>
          <div class="deploy-meta">
            <span class="deploy-meta-item">Updated ${escapeHtml(updatedAt)}</span>
            ${runtimeLaneLabel ? `<span class="deploy-meta-dot"></span><span class="deploy-meta-item">Current lane: ${escapeHtml(runtimeLaneLabel)}</span>` : ""}
            ${recommendedRuntimeLaneLabel && recommendedRuntimeLaneLabel !== runtimeLaneLabel
              ? `<span class="deploy-meta-dot"></span><span class="deploy-meta-item">Recommended lane: ${escapeHtml(recommendedRuntimeLaneLabel)}</span>`
              : ""}
            ${buildLogUrl ? `<span class="deploy-meta-dot"></span><span class="deploy-meta-item"><a href="${escapeHtml(buildLogUrl)}">Build log</a></span>` : ""}
          </div>
          ${runtimeEvidenceSummary
            ? `<div class="runtime-assessment">
                <p class="runtime-assessment-label">Build assessment</p>
                <p class="runtime-assessment-summary">${escapeHtml(runtimeEvidenceSummary)}</p>
                <div class="deploy-meta">
                  ${runtimeEvidenceClassificationLabel ? `<span class="deploy-meta-item">Classification: ${escapeHtml(runtimeEvidenceClassificationLabel)}</span>` : ""}
                  ${runtimeEvidenceConfidenceLabel ? `<span class="deploy-meta-dot"></span><span class="deploy-meta-item">Confidence: ${escapeHtml(runtimeEvidenceConfidenceLabel)}</span>` : ""}
                  ${runtimeEvidenceFramework ? `<span class="deploy-meta-dot"></span><span class="deploy-meta-item">Framework: ${escapeHtml(runtimeEvidenceFramework)}</span>` : ""}
                  ${runtimeEvidenceBasis && runtimeEvidenceBasis.length > 0 ? `<span class="deploy-meta-dot"></span><span class="deploy-meta-item">Signals: <code>${escapeHtml(runtimeEvidenceBasis.join(", "))}</code></span>` : ""}
                </div>
              </div>`
            : ""}
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
                  <form class="inline-form" method="post" action="${escapeHtml(`${controlBaseUrl}/projects/${encodeURIComponent(projectName)}/control/secrets/${encodeURIComponent(secret.secretName)}/delete`)}">
                    <input type="hidden" name="formToken" value="${escapeHtml(formToken)}" />
                    <button class="btn-delete" type="submit">Delete</button>
                  </form>
                </li>
              `).join("")}
            </ul>`
          : `<div class="notice" style="margin-top: 16px;"><p>No secrets stored yet.</p></div>`}
        <form class="secret-form" method="post" action="${escapeHtml(`${controlBaseUrl}/projects/${encodeURIComponent(projectName)}/control/secrets`)}">
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

      <section class="card danger-panel">
        <div class="section-header">
          <h2>Delete project</h2>
        </div>
        <p class="section-desc">Delete this Kale project, its live URL, stored secrets, deployment history, archived artifacts, and project storage. This does not delete the GitHub repository.</p>
        <div class="danger-zone">
          <p><strong>This cannot be undone inside Kale Deploy.</strong> Type <code>${escapeHtml(projectName)}</code> to confirm permanent deletion.</p>
          <form method="post" action="${escapeHtml(`${controlBaseUrl}/projects/${encodeURIComponent(projectName)}/control/delete`)}">
            <input type="hidden" name="formToken" value="${escapeHtml(formToken)}" />
            <div class="field-group" style="margin-top: 14px;">
              <label for="confirm-project-delete">Project name</label>
              <input
                id="confirm-project-delete"
                name="confirmProjectName"
                placeholder="${escapeHtml(projectName)}"
                required
                autocomplete="off"
                spellcheck="false"
              />
            </div>
            <p class="danger-help">The site will disappear from Kale immediately. If you need it later, redeploy from GitHub.</p>
            <div class="danger-actions">
              <button class="button danger-button" type="submit">Delete project</button>
            </div>
          </form>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function formatRuntimeEvidenceClassification(value?: string): string | undefined {
  switch (value) {
    case "shared_static_eligible":
      return "Shared Static Eligible";
    case "dedicated_required":
      return "Dedicated Required";
    case "unknown":
      return "Unknown";
    default:
      return undefined;
  }
}

function formatRuntimeEvidenceConfidence(value?: string): string | undefined {
  switch (value) {
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return undefined;
  }
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
