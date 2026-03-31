import { buildProjectControlPanelUrl } from "./project-control-ui";
import {
  buildRepositoryBannerPresentationMap,
  buildRepositoryCoveragePresentationMap,
  buildRepositorySetupStagePresentationMap,
  describeRepositoryCoverage,
  describeRepositorySetupStage,
  renderLifecycleSteps,
  renderRepositoryLiveRefreshScript,
  type RepositoryInstallStatus,
} from "./repository-lifecycle-presentation";
import { baseStyles, escapeHtml, faviconLink, logoHtml, serializeJsonForHtml } from "./ui";

export type RepositoryLifecycleViewModel = {
  repository: {
    fullName: string;
    htmlUrl: string;
  };
  projectName: string;
  projectUrl: string;
  suggestedProjectNames?: Array<{ projectName: string; projectUrl: string }>;
  installStatus: RepositoryInstallStatus;
  guidedInstallUrl?: string;
  repositoryStatusUrl: string;
  statusUrl: string;
  validateUrl: string;
  workflowStage: "app_setup" | "github_install" | "awaiting_push" | "build_queued" | "build_running" | "build_failed" | "live" | "name_conflict";
  summary: string;
  buildJobStatusUrl?: string;
  deploymentUrl?: string;
  errorMessage?: string;
  errorDetail?: string;
};

const INSTALL_AND_SETUP_SHARED_STYLES = `
  .state-grid {
    display: grid;
    gap: 16px;
    margin: 18px 0;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
  .state-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-notice);
    background: #fafbfd;
    padding: 16px;
  }
  .state-card.primary {
    background: linear-gradient(180deg, #f8fbff 0%, #eef4fb 100%);
  }
  .state-card h2,
  .state-card h3 {
    margin: 0 0 10px;
  }
  .state-card h2 {
    font-size: 1.2rem;
  }
  .state-card h3 {
    font-size: 1rem;
  }
  .state-label {
    margin: 0 0 10px;
    color: var(--accent);
    font-size: 0.82rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .state-card p:last-child {
    margin-bottom: 0;
  }
  .quick-links {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin: 18px 0 0;
  }
  .live-refresh-result {
    margin-top: 12px;
  }
  .live-refresh-result p {
    margin: 0;
  }
  .details-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 16px;
    margin-top: 18px;
    padding: 16px;
    border-radius: var(--radius-notice);
    background: var(--code-bg);
    border: 1px solid var(--border);
  }
  .detail-label { font-weight: 600; color: var(--muted); font-size: 0.92rem; }
  .detail-value { overflow-wrap: break-word; min-width: 0; }
  .detail-value code { font-size: 0.85em; }
  details.dev-details {
    margin-top: 18px;
    border-top: 1px solid var(--border);
    padding-top: 14px;
  }
  details.dev-details summary {
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--muted);
  }
  .lookup-form {
    display: grid;
    gap: 10px;
    margin-top: 18px;
  }
  .lookup-form input {
    width: 100%;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    font: inherit;
  }
  .lookup-form label {
    font-size: 0.92rem;
    color: var(--muted);
    font-weight: 600;
  }
  .section-muted { opacity: 0.75; }
  .section-muted h2 { font-size: 1.05rem; }
`;

const SETUP_PAGE_STYLES = `
  .status-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 18px;
    border-radius: var(--radius-notice);
    font-weight: 600;
    font-size: 1.1rem;
    margin-bottom: 16px;
  }
  .status-icon { font-size: 1.3rem; }
  .status-ready { background: #edf7f0; color: var(--success); border: 1px solid #b8dcc4; }
  .status-pending { background: var(--notice-bg); color: var(--accent); border: 1px solid var(--border); }
  .status-config { background: #f3f4f6; color: var(--muted); border: 1px solid var(--border); }
  .status-danger { background: #fff0ed; color: var(--error); border: 1px solid #efc6be; }
  .setup-primary {
    margin: 12px 0 16px;
  }
  .setup-primary h2 {
    margin: 0 0 6px;
    font-size: 1.2rem;
  }
  .setup-primary p {
    margin: 0;
    color: var(--muted);
  }
  .notice-error {
    background: #fff3f1;
    border-color: #f3b8ad;
  }
  .lifecycle-list {
    margin: 18px 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 10px;
  }
  .lifecycle-list li {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: #fafbfd;
  }
  .lifecycle-list li.active {
    border-color: var(--accent);
    background: var(--notice-bg);
  }
  .lifecycle-step {
    width: 26px;
    height: 26px;
    border-radius: 999px;
    background: var(--code-bg);
    color: var(--accent);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.84rem;
    font-weight: 700;
    flex: 0 0 auto;
  }
  .lifecycle-step-copy strong {
    display: block;
    color: var(--ink);
  }
  ${INSTALL_AND_SETUP_SHARED_STYLES}
`;

const INSTALL_PAGE_STYLES = `
  .status-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 18px;
    border-radius: var(--radius-notice);
    font-weight: 600;
    font-size: 1.1rem;
    margin-bottom: 16px;
    background: var(--notice-bg);
    color: var(--accent);
    border: 1px solid var(--border);
  }
  ${INSTALL_AND_SETUP_SHARED_STYLES}
`;

export function buildGuidedSetupUrl(
  serviceBaseUrl: string,
  repositoryFullName: string,
  projectName?: string
): string {
  const url = new URL(`${serviceBaseUrl.replace(/\/$/, "")}/github/setup`);
  url.searchParams.set("repositoryFullName", repositoryFullName);
  if (projectName) {
    url.searchParams.set("projectName", projectName);
  }
  return url.toString();
}

export function renderOauthAuthorizationErrorPage(message: string): string {
  return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kale Deploy Sign-In Error</title>
    ${faviconLink()}
    ${baseStyles("")}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>Sign-in could not continue</h1>
        <p>${escapeHtml(message)}</p>
        <p>Go back to your agent and try connecting again.</p>
      </section>
    </main>
  </body>
  </html>`;
}

export function renderOauthLoopbackContinuePage(input: {
  callbackUrl: string;
  appName?: string;
}): string {
  const appName = input.appName ?? "your agent";
  const callbackUrlJson = serializeJsonForHtml(input.callbackUrl);

  return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Return To ${escapeHtml(appName)}</title>
    ${faviconLink()}
    ${baseStyles(`
      .helper-steps {
        margin-top: 16px;
      }
      .helper-steps li + li {
        margin-top: 8px;
      }
      .callback-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 24px;
      }
      .callback-status {
        margin-top: 18px;
        font-weight: 600;
        color: var(--accent);
      }
      .callback-help {
        margin-top: 14px;
      }
      .callback-help summary {
        cursor: pointer;
        color: var(--muted);
        font-weight: 600;
      }
      .callback-help p {
        margin-bottom: 0;
      }
      .callback-frame {
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
        pointer-events: none;
        border: 0;
      }
    `)}
  </head>
  <body>
    <main>
      <div class="logo">${logoHtml("52px")}</div>
      <section class="card">
        <h1>Return to ${escapeHtml(appName)}</h1>
        <p>Kale Deploy has finished the browser sign-in step. This page is now handing the result back to your local agent so it can finish logging in.</p>
        <div class="notice">
          <p>You should not need to do anything else here. Once the handoff completes, you can close this tab and return to the terminal.</p>
        </div>
        <ol class="helper-steps">
          <li>Wait a moment for your local agent to receive the login result.</li>
          <li>Close this tab and return to the terminal.</li>
          <li>If your agent is still waiting, use <strong>Try handoff again</strong> once.</li>
        </ol>
        <div class="callback-actions">
          <button class="button" type="button" id="close-tab-button">Close this tab</button>
          <button class="button secondary" type="button" id="retry-handoff-button">Try handoff again</button>
        </div>
        <p class="callback-status" id="callback-status">Handing off to your local agent…</p>
        <details class="callback-help">
          <summary>Advanced troubleshooting</summary>
          <p>If the agent still does not continue after you retry, the manual loopback URL is <code>${escapeHtml(input.callbackUrl)}</code>.</p>
        </details>
      </section>
    </main>
    <script>
      const callbackUrl = ${callbackUrlJson};
      const statusEl = document.getElementById("callback-status");
      const closeButton = document.getElementById("close-tab-button");
      const retryButton = document.getElementById("retry-handoff-button");
      let iframe;
      function beginHandoff() {
        if (iframe) {
          iframe.remove();
        }
        iframe = document.createElement("iframe");
        iframe.className = "callback-frame";
        iframe.src = callbackUrl;
        iframe.onload = () => {
          statusEl.textContent = "Your agent should be able to continue now. You can close this tab.";
        };
        iframe.onerror = () => {
          statusEl.textContent = "If your agent is still waiting, try the handoff again once and then return to the terminal.";
        };
        document.body.appendChild(iframe);
      }
      closeButton?.addEventListener("click", () => {
        window.close();
      });
      retryButton?.addEventListener("click", () => {
        statusEl.textContent = "Trying the handoff again…";
        beginHandoff();
      });
      beginHandoff();
      window.setTimeout(() => {
        statusEl.textContent = "If nothing changes in the terminal, try the handoff again once or close this tab and return to the agent.";
      }, 1500);
    </script>
  </body>
  </html>`;
}

export function renderManifestSuccessPage(input: {
  appName: string;
  serviceBaseUrl: string;
  installUrl?: string;
  appUrl?: string;
  envSnippet: string;
  pem?: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.appName)} Registered</title>
    ${faviconLink()}
    ${baseStyles(`
      :root { --accent: var(--success); --accent-hover: #157332; }
      .notice { background: #edf7f0; border-color: #b8dcc4; }
    `)}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>${escapeHtml(input.appName)} Registered</h1>
        <p>Copy these values into Cloudflare before you leave. GitHub only returns the private key PEM once.</p>
        <div class="actions">
          ${input.installUrl ? `<a class="button" href="${escapeHtml(input.installUrl)}">Install the GitHub App</a>` : ""}
          ${input.appUrl ? `<a class="button secondary" href="${escapeHtml(input.appUrl)}">Open the app in GitHub</a>` : ""}
          <a class="button secondary" href="${escapeHtml(`${input.serviceBaseUrl}/github/setup`)}">Back to setup</a>
        </div>
        <div class="notice">
          <p><strong>Next:</strong> put <code>GITHUB_APP_PRIVATE_KEY</code> and <code>GITHUB_WEBHOOK_SECRET</code> into Wrangler secrets, set <code>GITHUB_APP_ID</code> and <code>GITHUB_APP_SLUG</code> in Worker vars, and redeploy the deploy service.</p>
        </div>
        <h2>Worker vars</h2>
        <textarea readonly>${escapeHtml(input.envSnippet)}</textarea>
        <h2>Private key</h2>
        <textarea readonly>${escapeHtml(input.pem ?? "GitHub did not return a PEM in the manifest conversion response.")}</textarea>
        <h2>Suggested next commands</h2>
        <textarea readonly>${escapeHtml(`npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config packages/deploy-service/wrangler.jsonc
npx wrangler secret put GITHUB_WEBHOOK_SECRET --config packages/deploy-service/wrangler.jsonc
npx wrangler deploy --config packages/deploy-service/wrangler.jsonc`)}</textarea>
        <h2>What to verify</h2>
        <ol>
          <li>Open <code>${escapeHtml(`${input.serviceBaseUrl}/github/app`)}</code> and confirm the app ID and slug are now populated.</li>
          <li>Install the app on a test repository.</li>
          <li>Push to <code>main</code> and watch the GitHub check run.</li>
        </ol>
      </section>
    </main>
  </body>
</html>`;
}

export function renderManifestErrorPage(appName: string, message: string, serviceBaseUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(appName)} Registration Error</title>
    ${faviconLink()}
    ${baseStyles(`
      :root { --accent: var(--error); --accent-hover: #a82c18; }
    `)}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>${escapeHtml(appName)} Registration Error</h1>
        <p>${escapeHtml(message)}</p>
        <div class="actions">
          <a class="button" href="${escapeHtml(`${serviceBaseUrl}/github/register`)}">Start the manifest flow again</a>
          <a class="button secondary" href="${escapeHtml(`${serviceBaseUrl}/github/setup`)}">Back to setup</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function renderGitHubRegisterPage(input: {
  appName: string;
  manifestOrg: string;
  configuredSlug?: string;
  registrationUrl: string;
  manifestJson: string;
  serviceBaseUrl: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.appName)} Registration</title>
    ${faviconLink()}
    ${baseStyles(`
      .manifest {
        margin-top: 18px;
        padding: 16px;
        border: 1px solid var(--border);
        border-radius: var(--radius-notice);
        background: var(--code-bg);
      }
      .manifest p { margin: 0.4rem 0; }
      form { margin: 0; }
    `)}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>${escapeHtml(input.appName)} Registration</h1>
        ${input.configuredSlug ? `<div class="notice"><p><strong>Already configured:</strong> <code>GITHUB_APP_SLUG=${escapeHtml(input.configuredSlug)}</code>. Only continue if you intend to replace the existing app.</p></div>` : ""}
        <div class="actions">
          <form action="${escapeHtml(input.registrationUrl)}" method="post">
            <input type="hidden" name="manifest" value="${escapeHtml(input.manifestJson)}" />
            <button class="button" type="submit">Create the GitHub App in ${escapeHtml(input.manifestOrg)}</button>
          </form>
          <a class="button secondary" href="${escapeHtml(`${input.serviceBaseUrl}/github/manifest`)}">View manifest JSON</a>
        </div>
        <div class="manifest">
          <h2>Registration target</h2>
          <p><strong>Webhook URL:</strong> <code>${escapeHtml(`${input.serviceBaseUrl}/github/webhook`)}</code></p>
          <p><strong>Setup URL:</strong> <code>${escapeHtml(`${input.serviceBaseUrl}/github/setup`)}</code></p>
          <p><strong>Redirect URL:</strong> <code>${escapeHtml(`${input.serviceBaseUrl}/github/manifest/callback`)}</code></p>
          <p><strong>Permissions:</strong> <code>Checks: Read &amp; write</code>, <code>Contents: Read</code>, <code>Metadata: Read</code></p>
          <p><strong>Webhook events:</strong> <code>Push</code></p>
          <p><strong>Installability:</strong> <code>Any account</code></p>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function renderGitHubInstallPage(input: {
  appName: string;
  marketingName: string;
  serviceBaseUrl: string;
  oauthBaseUrl: string;
  continueUrl?: string;
  lifecycle?: RepositoryLifecycleViewModel;
}): string {
  const primaryAction = input.lifecycle
    ? renderRepositoryInstallActions({
        lifecycle: input.lifecycle,
        appName: input.appName,
        continueUrl: input.continueUrl,
        serviceBaseUrl: input.serviceBaseUrl
      })
    : `<div class="actions">
          ${input.continueUrl
            ? `<a class="button" href="${escapeHtml(input.continueUrl)}">Continue to GitHub</a>`
            : `<a class="button" href="${escapeHtml(`${input.serviceBaseUrl}/github/register`)}">Set up GitHub for Kale Deploy</a>`}
          <a class="button secondary" href="${escapeHtml(`${input.serviceBaseUrl}/github/setup`)}">View setup progress</a>
        </div>
        <form class="lookup-form" method="get" action="${escapeHtml(`${input.serviceBaseUrl}/github/install`)}">
          <label for="repositoryFullName">Open the GitHub step for a specific repo</label>
          <input id="repositoryFullName" type="text" name="repositoryFullName" placeholder="owner/repo" />
          <button class="button" type="submit">Open this repo</button>
        </form>
        <div class="notice"><p>Kale Deploy uses the GitHub app named <strong>${escapeHtml(input.appName)}</strong>.</p></div>`;

  const installOverview = input.lifecycle
    ? renderRepositoryLifecycleOverview({
        lifecycle: input.lifecycle,
        appName: input.appName,
        serviceBaseUrl: input.serviceBaseUrl,
        flowPhase: "install"
      })
    : `<div class="notice"><p>Continue to GitHub to connect a repository to Kale Deploy.</p></div>`;

  const installDetails = input.lifecycle
    ? renderRepositoryDeveloperDetails({
        lifecycle: input.lifecycle,
        serviceBaseUrl: input.serviceBaseUrl,
        oauthBaseUrl: input.oauthBaseUrl
      })
    : "";

  const installLiveRefresh = input.lifecycle
    ? renderRepositoryLiveRefreshPanel({
        lifecycle: input.lifecycle,
        phase: "install",
        appName: input.appName,
        installReturnObserved: false
      })
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.marketingName)} GitHub Setup</title>
    ${faviconLink()}
    ${baseStyles(INSTALL_PAGE_STYLES)}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <div class="status-banner"><span aria-hidden="true">&#10132;</span> Connect GitHub</div>
        ${installOverview}
        ${primaryAction}
        ${installDetails}
        ${installLiveRefresh}
      </section>
    </main>
  </body>
</html>`;
}

export function renderGitHubSetupPage(input: {
  appName: string;
  marketingName: string;
  serviceBaseUrl: string;
  oauthBaseUrl: string;
  installUrl?: string;
  installationId?: string;
  setupAction?: string;
  lifecycle?: RepositoryLifecycleViewModel;
}): string {
  const bannerByStage = input.lifecycle
    ? {
        live: { className: "status-ready", icon: "&#10003;", label: "Live" },
        build_running: { className: "status-pending", icon: "&#8635;", label: "Building" },
        build_queued: { className: "status-pending", icon: "&#9719;", label: "Build queued" },
        build_failed: { className: "status-danger", icon: "&#9888;", label: "Build failed" },
        github_install: { className: "status-pending", icon: "&#9719;", label: "GitHub needed" },
        awaiting_push: { className: "status-ready", icon: "&#10148;", label: "Ready to deploy" },
        name_conflict: { className: "status-danger", icon: "&#9888;", label: "Name taken" },
        app_setup: { className: "status-config", icon: "&#9881;", label: "Setup needed" }
      }[input.lifecycle.workflowStage]
    : undefined;

  const statusBanner = bannerByStage
    ? `<div id="setup-status-banner" class="status-banner ${bannerByStage.className}"><span id="setup-status-banner-icon" class="status-icon">${bannerByStage.icon}</span> <span id="setup-status-banner-label">${escapeHtml(bannerByStage.label)}</span></div>`
    : "";

  const installReturnObserved = Boolean(input.installationId || input.setupAction);
  const setupContent = input.lifecycle
    ? renderSetupPageContent({
        lifecycle: input.lifecycle,
        appName: input.appName,
        serviceBaseUrl: input.serviceBaseUrl,
        oauthBaseUrl: input.oauthBaseUrl,
        installUrl: input.installUrl,
        installReturnObserved
      })
    : `<div class="actions">
          ${input.installUrl
            ? `<a class="button" href="${escapeHtml(input.installUrl)}">Connect GitHub</a>`
            : `<a class="button" href="${escapeHtml(`${input.serviceBaseUrl}/github/register`)}">Set up GitHub for Kale Deploy</a>`}
        </div>
        <form class="lookup-form" method="get" action="${escapeHtml(`${input.serviceBaseUrl}/github/setup`)}">
          <label for="repositoryFullName">Check an existing repo</label>
          <input id="repositoryFullName" type="text" name="repositoryFullName" placeholder="owner/repo" />
          <button class="button" type="submit">Check repository</button>
        </form>`;

  const projectDetails = input.lifecycle
    ? renderRepositoryDeveloperDetails({
        lifecycle: input.lifecycle,
        serviceBaseUrl: input.serviceBaseUrl,
        oauthBaseUrl: input.oauthBaseUrl
      })
    : "";

  const showProgress = input.lifecycle
    && input.lifecycle.workflowStage !== "live"
    && input.lifecycle.workflowStage !== "name_conflict";
  const liveLifecycle = showProgress ? input.lifecycle : undefined;

  const lifecycleSteps = liveLifecycle
    ? renderLifecycleSteps(liveLifecycle.workflowStage)
    : "";

  const setupLiveRefresh = liveLifecycle
    && liveLifecycle.workflowStage !== "app_setup"
    ? renderRepositoryLiveRefreshPanel({
        lifecycle: liveLifecycle,
        phase: "setup",
        appName: input.appName,
        installReturnObserved
      })
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.marketingName)} Setup</title>
    ${faviconLink()}
    ${baseStyles(SETUP_PAGE_STYLES)}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        ${statusBanner}
        ${setupContent}
        ${projectDetails}
        ${setupLiveRefresh}
        ${lifecycleSteps}
      </section>
    </main>
  </body>
</html>`;
}

function renderRepositoryInstallActions(input: {
  lifecycle: RepositoryLifecycleViewModel;
  appName: string;
  continueUrl?: string;
  serviceBaseUrl: string;
}): string {
  const { lifecycle, appName, continueUrl, serviceBaseUrl } = input;
  const setupUrl = buildGuidedSetupUrl(serviceBaseUrl, lifecycle.repository.fullName, lifecycle.projectName);

  switch (lifecycle.workflowStage) {
    case "app_setup":
      return `<div class="actions">
          <a class="button" href="${escapeHtml(`${serviceBaseUrl}/github/register`)}">Set up GitHub for Kale Deploy</a>
          <a class="button secondary" href="${escapeHtml(`${serviceBaseUrl}/github/app`)}">Learn about the ${escapeHtml(appName)} app</a>
        </div>`;
    case "github_install":
      return `<div class="actions">
          ${continueUrl
            ? `<a class="button" href="${escapeHtml(continueUrl)}">Continue to GitHub</a>`
            : ""}
          <a class="button secondary" href="${escapeHtml(setupUrl)}">View setup progress</a>
        </div>`;
    case "name_conflict":
      return `<div class="notice">
          <p>This repo needs a different public project name before the GitHub install step is useful.</p>
          <div class="actions">
            ${(lifecycle.suggestedProjectNames ?? []).map((suggestion) => `
              <a class="button secondary" href="${escapeHtml(buildGuidedGitHubInstallUrl(serviceBaseUrl, lifecycle.repository.fullName, suggestion.projectName))}">${escapeHtml(suggestion.projectName)}</a>
            `).join("")}
          </div>
        </div>`;
    default:
      return `<div class="actions">
          <a class="button" href="${escapeHtml(setupUrl)}">View setup progress</a>
          ${continueUrl ? `<a class="button secondary" href="${escapeHtml(continueUrl)}">Open GitHub again</a>` : ""}
        </div>
        <div class="notice"><p>This repository is already connected to CAIL.</p></div>`;
  }
}

function renderSetupPageContent(input: {
  lifecycle: RepositoryLifecycleViewModel;
  appName: string;
  serviceBaseUrl: string;
  oauthBaseUrl: string;
  installUrl?: string;
  installReturnObserved?: boolean;
}): string {
  const { lifecycle, appName, serviceBaseUrl, installUrl, installReturnObserved } = input;
  const settingsUrl = buildProjectControlPanelUrl(serviceBaseUrl, lifecycle.projectName);
  const stage = describeRepositorySetupStage(lifecycle, appName, {
    installReturnObserved,
    flowPhase: "setup"
  });

  let actions: string;
  switch (lifecycle.workflowStage) {
    case "app_setup":
      actions = `<div class="actions">
          <a class="button" href="${escapeHtml(`${serviceBaseUrl}/github/register`)}">Set up GitHub for Kale Deploy</a>
        </div>`;
      break;
    case "github_install":
      actions = installUrl
        ? `<div class="actions">
            <a class="button" href="${escapeHtml(lifecycle.guidedInstallUrl ?? installUrl)}">Connect GitHub for this repo</a>
          </div>`
        : "";
      break;
    case "awaiting_push":
      actions = `<div class="actions">
          <a class="button secondary" href="${escapeHtml(settingsUrl)}">Project settings</a>
        </div>`;
      break;
    case "build_queued":
    case "build_running":
      actions = `<div class="actions">
          <a class="button secondary" href="${escapeHtml(settingsUrl)}">Project settings</a>
          ${lifecycle.deploymentUrl ? `<a class="button secondary" href="${escapeHtml(lifecycle.deploymentUrl)}">Open live site</a>` : ""}
        </div>`;
      break;
    case "build_failed":
      actions = `<div class="actions">
          <a class="button secondary" href="${escapeHtml(settingsUrl)}">Project settings</a>
          ${lifecycle.buildJobStatusUrl ? `<a class="button secondary" href="${escapeHtml(lifecycle.buildJobStatusUrl)}">Build details</a>` : ""}
        </div>`;
      break;
    case "live":
      actions = `<div class="actions">
          ${lifecycle.deploymentUrl ? `<a class="button" href="${escapeHtml(lifecycle.deploymentUrl)}">Open live site</a>` : ""}
          <a class="button secondary" href="${escapeHtml(settingsUrl)}">Project settings</a>
        </div>`;
      break;
    case "name_conflict":
      actions = `<div class="notice">
          <div class="actions">
            ${(lifecycle.suggestedProjectNames ?? []).map((suggestion) => `
              <a class="button secondary" href="${escapeHtml(buildGuidedGitHubInstallUrl(serviceBaseUrl, lifecycle.repository.fullName, suggestion.projectName))}">${escapeHtml(suggestion.projectName)}</a>
            `).join("")}
          </div>
        </div>`;
      break;
    default:
      actions = `<div class="actions">
          <a class="button secondary" href="${escapeHtml(serviceBaseUrl)}">Return to Kale Deploy</a>
        </div>`;
  }

  const failureNotice = lifecycle.errorMessage
    ? `<div class="notice notice-error"><p><strong>Build error:</strong> ${escapeHtml(lifecycle.errorMessage)}${lifecycle.errorDetail ? `<br /><code>${escapeHtml(lifecycle.errorDetail)}</code>` : ""}</p></div>`
    : "";

  return `<div class="setup-primary">
      <h2 id="current-state-headline">${escapeHtml(stage.headline)}</h2>
      <p id="current-state-summary">${escapeHtml(stage.summary)}</p>
    </div>
    ${failureNotice}
    ${actions}`;
}

function renderRepositoryLifecycleOverview(input: {
  lifecycle: RepositoryLifecycleViewModel;
  appName: string;
  serviceBaseUrl: string;
  installationId?: string;
  setupAction?: string;
  flowPhase?: "install" | "setup";
}): string {
  const { lifecycle, appName, serviceBaseUrl, installationId, setupAction, flowPhase = "setup" } = input;
  const setupUrl = buildGuidedSetupUrl(serviceBaseUrl, lifecycle.repository.fullName, lifecycle.projectName);
  const repositoryCoverage = describeRepositoryCoverage(lifecycle, appName);
  const stage = describeRepositorySetupStage(lifecycle, appName, {
    installReturnObserved: Boolean(installationId || setupAction),
    flowPhase
  });
  const handoffSummary = installationId || setupAction
    ? `GitHub redirected here${installationId ? ` after installation ${installationId}` : ""}${setupAction ? ` with setup action '${setupAction}'` : ""}.`
    : undefined;
  const refreshLabel = flowPhase === "install" ? "View setup progress" : "Refresh this page";

  return `<div class="state-grid">
      <section class="state-card primary">
        <p class="state-label">Status</p>
        <h2 id="current-state-headline">${escapeHtml(stage.headline)}</h2>
        <p id="current-state-summary">${escapeHtml(lifecycle.summary)}</p>
        <p id="github-handoff-summary"${handoffSummary ? "" : " hidden"}>${handoffSummary ? `<strong>You came back from GitHub:</strong> ${escapeHtml(handoffSummary)}` : ""}</p>
        <div class="quick-links">
          <a class="button secondary" href="${escapeHtml(setupUrl)}">${escapeHtml(refreshLabel)}</a>
        </div>
      </section>
      <section class="state-card">
        <p class="state-label">GitHub</p>
        <h3 id="repository-coverage-title">${escapeHtml(repositoryCoverage.title)}</h3>
        <p id="repository-coverage-body">${escapeHtml(repositoryCoverage.body)}</p>
      </section>
      <section class="state-card">
        <p class="state-label">Next step</p>
        <h3 id="user-next-title">${escapeHtml(stage.userTitle)}</h3>
        <p id="user-next-body">${escapeHtml(stage.userBody)}</p>
      </section>
      <section class="state-card">
        <p class="state-label">Behind the scenes</p>
        <h3 id="agent-next-title">${escapeHtml(stage.agentTitle)}</h3>
        <p id="agent-next-body">${escapeHtml(stage.agentBody)}</p>
      </section>
    </div>`;
}

function renderRepositoryLiveRefreshPanel(input: {
  lifecycle: RepositoryLifecycleViewModel;
  phase: "install" | "setup";
  appName: string;
  installReturnObserved: boolean;
}): string {
  const setupStagePresentation = buildRepositorySetupStagePresentationMap(input.appName, {
    installReturnObserved: input.installReturnObserved,
    flowPhase: input.phase
  });
  const coveragePresentation = buildRepositoryCoveragePresentationMap(input.appName);
  const bannerPresentation = buildRepositoryBannerPresentationMap();
  const bootstrap = serializeJsonForHtml({
    phase: input.phase,
    installReturnObserved: input.installReturnObserved,
    coveragePresentation,
    setupStagePresentation,
    bannerPresentation,
    lifecycle: input.lifecycle
  });

  return `<div id="live-refresh-panel" style="margin-top: 16px;">
      <div class="actions">
        <button class="button secondary" type="button" id="live-refresh-button">Check for updates</button>
      </div>
      <div id="live-refresh-result" class="live-refresh-result"></div>
    </div>
    <script id="repository-live-refresh-bootstrap" type="application/json">${bootstrap}</script>
    <script>${renderRepositoryLiveRefreshScript()}</script>`;
}

function renderRepositoryDeveloperDetails(input: {
  lifecycle: RepositoryLifecycleViewModel;
  serviceBaseUrl: string;
  oauthBaseUrl: string;
}): string {
  const { lifecycle, serviceBaseUrl } = input;

  return `<details class="dev-details">
      <summary>Developer details</summary>
      <div class="details-grid">
        <div class="detail-label">Repository</div><div class="detail-value"><a href="${escapeHtml(lifecycle.repository.htmlUrl)}"><code>${escapeHtml(lifecycle.repository.fullName)}</code></a></div>
        <div class="detail-label">Project</div><div class="detail-value"><code>${escapeHtml(lifecycle.projectName)}</code></div>
        <div class="detail-label">Public URL</div><div class="detail-value"><code>${escapeHtml(lifecycle.projectUrl)}</code></div>
        <div class="detail-label">Settings URL</div><div class="detail-value"><code>${escapeHtml(buildProjectControlPanelUrl(serviceBaseUrl, lifecycle.projectName))}</code></div>
        <div class="detail-label">Repo status API</div><div class="detail-value"><code>${escapeHtml(lifecycle.repositoryStatusUrl)}</code></div>
        <div class="detail-label">Project status API</div><div class="detail-value"><code>${escapeHtml(lifecycle.statusUrl)}</code></div>
        <div class="detail-label">Validate API</div><div class="detail-value"><code>${escapeHtml(lifecycle.validateUrl)}</code></div>
        <div class="detail-label">Setup URL</div><div class="detail-value"><code>${escapeHtml(buildGuidedSetupUrl(serviceBaseUrl, lifecycle.repository.fullName, lifecycle.projectName))}</code></div>
        ${lifecycle.buildJobStatusUrl ? `<div class="detail-label">Build job</div><div class="detail-value"><code>${escapeHtml(lifecycle.buildJobStatusUrl)}</code></div>` : ""}
        ${lifecycle.deploymentUrl ? `<div class="detail-label">Live deployment</div><div class="detail-value"><a href="${escapeHtml(lifecycle.deploymentUrl)}"><code>${escapeHtml(lifecycle.deploymentUrl)}</code></a></div>` : ""}
      </div>
    </details>`;
}

function buildGuidedGitHubInstallUrl(
  serviceBaseUrl: string,
  repositoryFullName: string,
  projectName: string
): string {
  const url = new URL(`${serviceBaseUrl.replace(/\/$/, "")}/github/install`);
  url.searchParams.set("repositoryFullName", repositoryFullName);
  url.searchParams.set("projectName", projectName);
  return url.toString();
}
