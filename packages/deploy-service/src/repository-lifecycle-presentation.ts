import { escapeHtml } from "./ui";

export type RepositoryWorkflowStage =
  | "app_setup"
  | "github_install"
  | "name_conflict"
  | "awaiting_push"
  | "build_queued"
  | "build_running"
  | "build_failed"
  | "live";

export type RepositoryInstallStatus = "app_unconfigured" | "installed" | "not_installed";

export type RepositoryCoveragePresentation = {
  title: string;
  body: string;
};

export type RepositorySetupStagePresentation = {
  headline: string;
  summary: string;
  userTitle: string;
  userBody: string;
  agentTitle: string;
  agentBody: string;
};

export type RepositoryBannerPresentation = {
  className: string;
  icon: string;
  label: string;
};

type RepositoryLifecyclePresentationState = {
  installStatus: RepositoryInstallStatus;
  workflowStage: RepositoryWorkflowStage;
  deploymentUrl?: string;
};

export function buildRepositoryCoveragePresentationMap(
  appName: string
): Record<RepositoryInstallStatus, RepositoryCoveragePresentation> {
  return {
    installed: {
      title: "Connected",
      body: `The ${appName} GitHub app can access this repo.`
    },
    not_installed: {
      title: "Not connected yet",
      body: `Someone with repo access needs to approve the ${appName} app.`
    },
    app_unconfigured: {
      title: "Not set up",
      body: `The ${appName} GitHub app hasn't been created yet.`
    }
  };
}

export function buildRepositorySetupStagePresentationMap(
  appName: string,
  options?: {
    installReturnObserved?: boolean;
    flowPhase?: "install" | "setup";
  }
): Record<RepositoryWorkflowStage, RepositorySetupStagePresentation> {
  const installReturnObserved = options?.installReturnObserved ?? false;
  const flowPhase = options?.flowPhase ?? "setup";

  return {
    app_setup: {
      headline: "GitHub setup is not done yet",
      summary: `The ${appName} GitHub app needs to be created before any repo can deploy.`,
      userTitle: "Complete the one-time GitHub setup",
      userBody: `The ${appName} GitHub app needs to be created before any repo can be deployed. Follow the link above, then come back.`,
      agentTitle: "Waiting on GitHub setup",
      agentBody: "Deploys are blocked until the GitHub app is created. The project can still be prepared in the meantime."
    },
    github_install: {
      headline: installReturnObserved
        ? "GitHub did not grant access to this repo"
        : flowPhase === "install"
          ? "Ready for GitHub approval"
          : "This repo needs GitHub approval",
      summary: installReturnObserved
        ? "This repo was not included. Try the GitHub flow again."
        : `Approve the ${appName} app for this repo, then come back here.`,
      userTitle: installReturnObserved
        ? "Try the GitHub flow again"
        : flowPhase === "install"
          ? "Continue to GitHub"
          : "Approve GitHub access",
      userBody: installReturnObserved
        ? "You came back from GitHub, but this repo wasn't included. Open GitHub again, make sure this repo is selected, then come back."
        : flowPhase === "install"
          ? `Approve this repo in the ${appName} app on GitHub. You'll be sent back here when it's done.`
          : `Click the button below to approve the ${appName} app for this repo. Come back here when you're done.`,
      agentTitle: installReturnObserved
        ? "Waiting for repo access"
        : "Paused for GitHub",
      agentBody: installReturnObserved
        ? "GitHub access isn't confirmed for this repo yet. Nothing to do until the GitHub step is done."
        : flowPhase === "install"
          ? "The user is completing the GitHub approval step in their browser."
          : "Waiting for GitHub access to be approved for this repo."
    },
    awaiting_push: {
      headline: installReturnObserved
        ? "GitHub is connected"
        : flowPhase === "install"
          ? "Already connected"
          : "Connected and ready",
      summary: "Push to the default branch to start your first deploy.",
      userTitle: "Push to deploy",
      userBody: installReturnObserved
        ? "GitHub access is confirmed. Push to the default branch to start your first deploy, or ask for a validation check first."
        : flowPhase === "install"
          ? "This repo already has GitHub access. Push to the default branch whenever you're ready."
          : "Push to the default branch to start your first deploy. Want a dry run first? Ask for a validation check.",
      agentTitle: "Ready to go",
      agentBody: installReturnObserved
        ? "GitHub is confirmed. Validate, push to the default branch, and check for the live URL."
        : flowPhase === "install"
          ? "GitHub is already connected. Validate or push to the default branch, then check for the live URL."
          : "Validate the branch, push to the default branch, and check for the live URL."
    },
    build_queued: {
      headline: "Build is queued",
      summary: "Your build is in line. This page updates when it starts.",
      userTitle: "Nothing to do right now",
      userBody: "Your build is in line. This page will update when it starts.",
      agentTitle: "Build starting soon",
      agentBody: "The build is queued. Keep checking until it finishes or fails."
    },
    build_running: {
      headline: "Building now",
      summary: "This usually takes a minute or two.",
      userTitle: "Sit tight",
      userBody: "Your project is being built. This usually takes a minute or two.",
      agentTitle: "Build in progress",
      agentBody: "A build is running. Keep checking until it goes live or fails."
    },
    build_failed: {
      headline: "Build failed",
      summary: "Check the error below, fix the issue, and push again.",
      userTitle: "Check the error below",
      userBody: "Something went wrong. The details are below — fix the issue and push again, or ask your agent to help.",
      agentTitle: "Fix and retry",
      agentBody: "The build failed. Read the error details below, fix the code, and push again."
    },
    live: {
      headline: "Your project is live",
      summary: "Push to main to deploy updates.",
      userTitle: "Visit your site or keep building",
      userBody: "Your site is live now. Push to main to deploy updates.",
      agentTitle: "Auto-deploy is on",
      agentBody: "Every push to main updates the live site."
    },
    name_conflict: {
      headline: "That project name is taken",
      summary: "Choose from the suggestions below.",
      userTitle: "Pick a different name",
      userBody: "Project names become part of the public URL. Choose from the suggestions below.",
      agentTitle: "Re-register with a new name",
      agentBody: "Pick an available name from the suggestions and re-register the project."
    }
  };
}

export function buildRepositoryBannerPresentationMap(): Record<RepositoryWorkflowStage, RepositoryBannerPresentation> {
  return {
    app_setup: { className: "status-config", icon: "\u2699", label: "Setup needed" },
    github_install: { className: "status-pending", icon: "\u25cf", label: "GitHub needed" },
    name_conflict: { className: "status-danger", icon: "\u26a0", label: "Name taken" },
    awaiting_push: { className: "status-ready", icon: "\u27a4", label: "Ready to deploy" },
    build_queued: { className: "status-pending", icon: "\u25cf", label: "Build queued" },
    build_running: { className: "status-pending", icon: "\u21bb", label: "Building" },
    build_failed: { className: "status-danger", icon: "\u26a0", label: "Build failed" },
    live: { className: "status-ready", icon: "\u2713", label: "Live" }
  };
}

export function describeRepositoryCoverage(
  lifecycle: Pick<RepositoryLifecyclePresentationState, "installStatus">,
  appName: string
): RepositoryCoveragePresentation {
  return buildRepositoryCoveragePresentationMap(appName)[lifecycle.installStatus];
}

export function describeRepositorySetupStage(
  lifecycle: RepositoryLifecyclePresentationState,
  appName: string,
  options?: {
    installReturnObserved?: boolean;
    flowPhase?: "install" | "setup";
  }
): RepositorySetupStagePresentation {
  const fallback: RepositorySetupStagePresentation = {
    headline: "Checking status...",
    summary: "Something unexpected happened. Refresh or reopen the setup link.",
    userTitle: "Refresh this page",
    userBody: "Something unexpected happened. Refresh or reopen the setup link.",
    agentTitle: "Check status again",
    agentBody: "The current state wasn't recognized. Check the repository status and continue from whatever step it reports."
  };
  const stage = buildRepositorySetupStagePresentationMap(appName, options)[lifecycle.workflowStage] ?? fallback;

  if (lifecycle.workflowStage === "live" && lifecycle.deploymentUrl) {
    return {
      ...stage,
      summary: `Live at ${lifecycle.deploymentUrl}. Push to main to deploy updates.`
    };
  }

  return stage;
}

export function renderLifecycleSteps(currentStage: string): string {
  const steps = [
    {
      key: "github_install",
      label: "Connect GitHub",
      description: "Approve the GitHub app once for this repository."
    },
    {
      key: "awaiting_push",
      label: "Push or validate",
      description: "Push to the default branch or run a build-only validation."
    },
    {
      key: "build_running",
      label: "Managed build",
      description: "Kale Deploy builds and uploads the Worker bundle for you."
    },
    {
      key: "live",
      label: "Live project",
      description: "Your app is online and can be opened from its public link."
    }
  ];

  const stageMap = new Map<string, string>([
    ["app_setup", "github_install"],
    ["github_install", "github_install"],
    ["awaiting_push", "awaiting_push"],
    ["build_queued", "build_running"],
    ["build_running", "build_running"],
    ["build_failed", "build_running"],
    ["live", "live"],
    ["name_conflict", "awaiting_push"]
  ]);
  const activeKey = stageMap.get(currentStage) ?? "github_install";

  return `<ul class="lifecycle-list">
    ${steps.map((step, index) => `
      <li class="${step.key === activeKey ? "active" : ""}">
        <span class="lifecycle-step">${index + 1}</span>
        <span class="lifecycle-step-copy">
          <strong>${escapeHtml(step.label)}</strong>
          ${escapeHtml(step.description)}
        </span>
      </li>
    `).join("")}
  </ul>`;
}

export function renderRepositoryLiveRefreshScript(): string {
  return [
    "(function () {",
    "  var bootstrapEl = document.getElementById('repository-live-refresh-bootstrap');",
    "  if (!bootstrapEl) return;",
    "  var bootstrap;",
    "  try {",
    "    bootstrap = JSON.parse(bootstrapEl.textContent || '{}');",
    "  } catch (_error) {",
    "    return;",
    "  }",
    "  var state = bootstrap.lifecycle;",
    "  if (!state || !state.repositoryStatusUrl) return;",
    "  var installReturnObserved = Boolean(bootstrap.installReturnObserved);",
    "  var coveragePresentation = bootstrap.coveragePresentation || {};",
    "  var setupStagePresentation = bootstrap.setupStagePresentation || {};",
    "  var bannerPresentation = bootstrap.bannerPresentation || {};",
    "  var button = document.getElementById('live-refresh-button');",
    "  var summaryEl = document.getElementById('live-refresh-summary');",
    "  var resultEl = document.getElementById('live-refresh-result');",
    "  var bannerEl = document.getElementById('setup-status-banner');",
    "  var bannerIconEl = document.getElementById('setup-status-banner-icon');",
    "  var bannerLabelEl = document.getElementById('setup-status-banner-label');",
    "  var headlineEl = document.getElementById('current-state-headline');",
    "  var currentSummaryEl = document.getElementById('current-state-summary');",
    "  var handoffEl = document.getElementById('github-handoff-summary');",
    "  var coverageTitleEl = document.getElementById('repository-coverage-title');",
    "  var coverageBodyEl = document.getElementById('repository-coverage-body');",
    "  var userTitleEl = document.getElementById('user-next-title');",
    "  var userBodyEl = document.getElementById('user-next-body');",
    "  var agentTitleEl = document.getElementById('agent-next-title');",
    "  var agentBodyEl = document.getElementById('agent-next-body');",
    "  var autoRefreshTimer = null;",
    "",
    "  function buildSetupUrl(nextState) {",
    "    var url = new URL(nextState.setupUrl);",
    "    url.searchParams.set('repositoryFullName', nextState.repository.fullName);",
    "    if (nextState.projectName) url.searchParams.set('projectName', nextState.projectName);",
    "    return url.toString();",
    "  }",
    "",
    "  function describeCoverage(nextState) {",
    "    return coveragePresentation[nextState.installStatus] || coveragePresentation.app_unconfigured || {",
    "      title: 'Not set up',",
    "      body: 'Status is temporarily unavailable.'",
    "    };",
    "  }",
    "",
    "  function describeStage(nextState) {",
    "    return setupStagePresentation[nextState.workflowStage] || {",
    "      headline: 'Checking status...',",
    "      summary: 'Something unexpected happened. Refresh or reopen the setup link.',",
    "      userTitle: 'Refresh this page',",
    "      userBody: 'Something unexpected happened. Refresh or reopen the setup link.',",
    "      agentTitle: 'Check status again',",
    "      agentBody: 'The current state wasn\\u2019t recognized. Check the repository status and continue from whatever step it reports.'",
    "    };",
    "  }",
    "",
    "  function bannerState(nextState) {",
    "    return bannerPresentation[nextState.workflowStage] || {",
    "      className: 'status-config',",
    "      icon: '\\u2699',",
    "      label: 'Setup needed'",
    "    };",
    "  }",
    "",
    "  function setResult(message, nextState) {",
    "    if (!resultEl) return;",
    "    resultEl.replaceChildren();",
    "    var messageEl = document.createElement('p');",
    "    messageEl.textContent = message;",
    "    resultEl.appendChild(messageEl);",
    "    var links = document.createElement('div');",
    "    links.className = 'quick-links';",
    "    if (nextState.deploymentUrl) {",
    "      var liveLink = document.createElement('a');",
    "      liveLink.className = 'button secondary';",
    "      liveLink.href = nextState.deploymentUrl;",
    "      liveLink.textContent = 'Open live site';",
    "      links.appendChild(liveLink);",
    "    }",
    "    if (nextState.buildJobStatusUrl) {",
    "      var buildLink = document.createElement('a');",
    "      buildLink.className = 'button secondary';",
    "      buildLink.href = nextState.buildJobStatusUrl;",
    "      buildLink.textContent = 'Open build details';",
    "      links.appendChild(buildLink);",
    "    }",
    "    var setupLink = document.createElement('a');",
    "    setupLink.className = 'button secondary';",
    "    setupLink.href = buildSetupUrl(nextState);",
    "    setupLink.textContent = 'View setup progress';",
    "    links.appendChild(setupLink);",
    "    resultEl.appendChild(links);",
    "  }",
    "",
    "  function applyState(nextState, message) {",
    "    state = nextState;",
    "    var coverage = describeCoverage(nextState);",
    "    var stage = describeStage(nextState);",
    "    if (headlineEl) headlineEl.textContent = stage.headline;",
    "    if (currentSummaryEl) currentSummaryEl.textContent = nextState.summary;",
    "    if (coverageTitleEl) coverageTitleEl.textContent = coverage.title;",
    "    if (coverageBodyEl) coverageBodyEl.textContent = coverage.body;",
    "    if (userTitleEl) userTitleEl.textContent = stage.userTitle;",
    "    if (userBodyEl) userBodyEl.textContent = stage.userBody;",
    "    if (agentTitleEl) agentTitleEl.textContent = stage.agentTitle;",
    "    if (agentBodyEl) agentBodyEl.textContent = stage.agentBody;",
    "    if (handoffEl) {",
    "      if (installReturnObserved) {",
    "        handoffEl.hidden = false;",
    "        handoffEl.textContent = 'You came back from GitHub: GitHub redirected here from the connect flow.';",
    "      } else {",
    "        handoffEl.hidden = true;",
    "        handoffEl.textContent = '';",
    "      }",
    "    }",
    "    if (bannerEl && bannerIconEl && bannerLabelEl) {",
    "      var banner = bannerState(nextState);",
    "      bannerEl.className = 'status-banner ' + banner.className;",
    "      bannerIconEl.textContent = banner.icon;",
    "      bannerLabelEl.textContent = banner.label;",
    "    }",
    "    if (summaryEl) {",
    "      summaryEl.textContent = 'Check for status updates without leaving this page.';",
    "    }",
    "    if (message) setResult(message, nextState);",
    "  }",
    "",
    "  async function refreshStatus() {",
    "    if (button) {",
    "      button.disabled = true;",
    "      button.textContent = 'Checking...';",
    "    }",
    "    try {",
    "      var response = await fetch(state.repositoryStatusUrl, {",
    "        credentials: 'include',",
    "        headers: { Accept: 'application/json' }",
    "      });",
    "      var contentType = response.headers.get('content-type') || '';",
    "      if (!response.ok || contentType.indexOf('application/json') === -1) {",
    "        if (response.status === 401 || response.status === 403 || contentType.indexOf('text/html') !== -1) {",
    "          throw new Error('Live refresh needs your CUNY sign-in. Sign in through CAIL, then try again.');",
    "        }",
    "        throw new Error('Status refresh failed with HTTP ' + response.status + '.');",
    "      }",
    "      var nextState = await response.json();",
    "      var previousStage = state.workflowStage;",
    "      var checkedAt = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });",
    "      var changed = previousStage !== nextState.workflowStage || state.deploymentUrl !== nextState.deploymentUrl || state.buildJobId !== nextState.buildJobId;",
    "      applyState(nextState, changed",
    "        ? 'Checked at ' + checkedAt + '. The repository state changed to ' + String(nextState.workflowStage).replace(/_/g, ' ') + '.'",
    "        : 'Checked at ' + checkedAt + '. No visible change since the last snapshot.');",
    "      if (nextState.workflowStage === 'build_queued' || nextState.workflowStage === 'build_running') {",
    "        if (autoRefreshTimer) window.clearTimeout(autoRefreshTimer);",
    "        autoRefreshTimer = window.setTimeout(function () { refreshStatus(); }, 15000);",
    "      }",
    "    } catch (error) {",
    "      setResult(error instanceof Error ? error.message : 'Could not refresh repository status.', state);",
    "    } finally {",
    "      if (button) {",
    "        button.disabled = false;",
    "        button.textContent = 'Check for updates';",
    "      }",
    "    }",
    "  }",
    "",
    "  if (button) {",
    "    button.addEventListener('click', function () {",
    "      refreshStatus();",
    "    });",
    "  }",
    "})();"
  ].join("\n");
}
