import type { ProjectRecord } from "@cuny-ai-lab/build-contract";

import type { FeaturedProjectDisplayRecord } from "./lib/control-plane";
import type { ProjectControlFlash } from "./project-control-ui";
import { baseStyles, escapeHtml, faviconLink, logoHtml } from "./ui";
import { formatRuntimeLaneLabel } from "./runtime-lanes";

export type FeaturedProjectAdminRecord = {
  projectName: string;
  ownerLogin: string;
  githubRepo: string;
  deploymentUrl: string;
  description?: string;
  runtimeLane: ProjectRecord["runtimeLane"];
  updatedAt: string;
  featured: {
    enabled: boolean;
    headline?: string;
    sortOrder: number;
  };
};

export function renderFeaturedProjectsPage(input: {
  serviceBaseUrl: string;
  projects: FeaturedProjectDisplayRecord[];
}): string {
  const { serviceBaseUrl, projects } = input;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Featured Projects</title>
    ${faviconLink()}
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
    ${baseStyles(`
      body { font-family: "DM Sans", system-ui, -apple-system, sans-serif; }
      .hero {
        max-width: 760px;
        margin: 0 auto;
        text-align: center;
      }
      .hero .logo {
        margin: 0 auto 16px;
      }
      .eyebrow {
        display: inline-flex;
        padding: 4px 12px;
        border-radius: 999px;
        background: var(--panel);
        border: 1px solid var(--border);
        font-size: 0.76rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .hero h1 {
        margin: 18px 0 12px;
        font-size: clamp(2rem, 4vw, 3rem);
        line-height: 1.05;
      }
      .hero p {
        margin: 0 auto;
        max-width: 620px;
        color: var(--muted);
        line-height: 1.65;
      }
      .project-grid {
        max-width: 1040px;
        margin: 32px auto 0;
        display: grid;
        gap: 18px;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      }
      .project-card {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 22px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: white;
        box-shadow: 0 8px 24px rgba(20, 30, 55, 0.05);
      }
      .project-card h2 {
        margin: 0;
        font-size: 1.15rem;
      }
      .project-card h2 a {
        color: var(--ink);
        text-decoration: none;
      }
      .project-card h2 a:hover {
        color: var(--accent);
      }
      .project-card p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }
      .meta-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .meta-chip {
        display: inline-flex;
        align-items: center;
        padding: 5px 10px;
        border-radius: 999px;
        background: var(--panel);
        border: 1px solid var(--border);
        font-size: 0.78rem;
        color: var(--muted);
      }
      .project-links {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .project-links a {
        color: var(--accent);
        text-decoration: none;
        font-weight: 600;
      }
      .project-links a:hover {
        text-decoration: underline;
      }
      .repo-label {
        font-family: "DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.8rem;
      }
      .empty-card {
        max-width: 640px;
        margin: 32px auto 0;
        padding: 24px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: var(--panel);
        text-align: center;
      }
      .footer-actions {
        margin-top: 28px;
        display: flex;
        justify-content: center;
        gap: 14px;
      }
      .footer-actions a {
        color: var(--muted);
        text-decoration: none;
      }
      .footer-actions a:hover {
        color: var(--accent);
      }
    `)}
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="logo">${logoHtml("46px")}</div>
        <span class="eyebrow">Featured Projects</span>
        <h1>Projects we want people to open first.</h1>
        <p>These are live Kale Deploy sites chosen from the current project list. Each one links directly to the public site and the source repository behind it.</p>
      </section>

      ${projects.length > 0
        ? `<section class="project-grid">
            ${projects.map((project) => `
              <article class="project-card">
                <div>
                  <h2><a href="${escapeHtml(project.deploymentUrl)}">${escapeHtml(project.projectName)}</a></h2>
                  <p>${escapeHtml(project.headline ?? project.description ?? "Live on Kale Deploy.")}</p>
                </div>
                <div class="meta-list">
                  <span class="meta-chip">${escapeHtml(formatRuntimeLaneLabel(project.runtimeLane ?? "dedicated_worker"))}</span>
                  <span class="meta-chip repo-label">${escapeHtml(project.githubRepo)}</span>
                </div>
                <div class="project-links">
                  <a href="${escapeHtml(project.deploymentUrl)}">Open site</a>
                  <a href="${escapeHtml(`https://github.com/${project.githubRepo}`)}">View code</a>
                </div>
              </article>
            `).join("")}
          </section>`
        : `<section class="empty-card">
            <p>No featured projects have been selected yet.</p>
          </section>`
      }

      <div class="footer-actions">
        <a href="${escapeHtml(serviceBaseUrl)}">Back to Kale Deploy</a>
      </div>
    </main>
  </body>
</html>`;
}

export function renderFeaturedProjectsAdminAuthErrorPage(message: string, serviceBaseUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Featured Projects Admin</title>
    ${faviconLink()}
    ${baseStyles("")}
  </head>
  <body>
    <main>
      <section class="card">
        <div class="logo">${logoHtml("44px")}</div>
        <h1>Featured projects admin is not available</h1>
        <p>${escapeHtml(message)}</p>
        <div class="actions">
          <a class="button" href="${escapeHtml(serviceBaseUrl)}">Back to Kale Deploy</a>
          <a class="button secondary" href="${escapeHtml(`${serviceBaseUrl}/featured`)}">Public featured page</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export function renderFeaturedProjectsAdminPage(input: {
  serviceBaseUrl: string;
  signedInEmail: string;
  projects: FeaturedProjectAdminRecord[];
  formToken: string;
  flash?: ProjectControlFlash;
}): string {
  const { serviceBaseUrl, signedInEmail, projects, formToken, flash } = input;
  const toneClass = flash ? `notice notice-${flash.tone}` : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Featured Projects Admin</title>
    ${faviconLink()}
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
    ${baseStyles(`
      body { font-family: "DM Sans", system-ui, -apple-system, sans-serif; }
      .hero {
        max-width: 780px;
        margin: 0 auto;
        text-align: center;
      }
      .hero .logo {
        margin: 0 auto 16px;
      }
      .eyebrow {
        display: inline-flex;
        padding: 4px 12px;
        border-radius: 999px;
        background: var(--panel);
        border: 1px solid var(--border);
        font-size: 0.76rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .hero h1 {
        margin: 18px 0 10px;
        font-size: clamp(2rem, 4vw, 2.8rem);
        line-height: 1.06;
      }
      .hero p {
        margin: 0 auto;
        max-width: 660px;
        color: var(--muted);
        line-height: 1.65;
      }
      .hero-meta {
        margin-top: 12px;
        color: var(--muted);
        font-size: 0.9rem;
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
      .project-grid {
        max-width: 1100px;
        margin: 28px auto 0;
        display: grid;
        gap: 18px;
      }
      .admin-card {
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
        gap: 22px;
        padding: 22px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: white;
        box-shadow: 0 8px 24px rgba(20, 30, 55, 0.05);
      }
      .admin-card.featured {
        border-color: rgba(59, 107, 204, 0.28);
        box-shadow: 0 12px 28px rgba(59, 107, 204, 0.09);
      }
      .project-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 14px;
      }
      .project-header h2 {
        margin: 0;
        font-size: 1.2rem;
      }
      .feature-badge {
        display: inline-flex;
        align-items: center;
        padding: 5px 10px;
        border-radius: 999px;
        border: 1px solid #b8caef;
        background: #eef4ff;
        color: #365ea8;
        font-size: 0.78rem;
        font-weight: 700;
      }
      .project-copy p {
        margin: 8px 0 0;
        color: var(--muted);
        line-height: 1.6;
      }
      .meta-list {
        margin-top: 14px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .meta-chip {
        display: inline-flex;
        align-items: center;
        padding: 5px 10px;
        border-radius: 999px;
        background: var(--panel);
        border: 1px solid var(--border);
        font-size: 0.78rem;
        color: var(--muted);
      }
      .repo-label {
        font-family: "DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.8rem;
      }
      .project-links {
        margin-top: 14px;
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      .project-links a {
        color: var(--accent);
        text-decoration: none;
        font-weight: 600;
      }
      .project-links a:hover {
        text-decoration: underline;
      }
      .curation-form {
        display: grid;
        gap: 14px;
        align-content: start;
      }
      .field-grid {
        display: grid;
        grid-template-columns: 1fr 132px;
        gap: 12px;
      }
      .field-group label {
        display: block;
        margin-bottom: 6px;
        font-size: 0.8rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .field-group input {
        width: 100%;
        box-sizing: border-box;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        font: inherit;
      }
      .field-help {
        margin: 6px 0 0;
        font-size: 0.82rem;
        color: var(--muted);
        line-height: 1.5;
      }
      .toggle-row {
        display: flex;
        align-items: center;
        gap: 10px;
        font-weight: 600;
        color: var(--ink);
      }
      .toggle-row input {
        width: auto;
        margin: 0;
      }
      .form-actions {
        display: flex;
        justify-content: flex-end;
      }
      .empty-card {
        max-width: 720px;
        margin: 28px auto 0;
        padding: 24px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: var(--panel);
        text-align: center;
      }
      .footer-actions {
        margin-top: 28px;
        display: flex;
        justify-content: center;
        gap: 14px;
        flex-wrap: wrap;
      }
      .footer-actions a {
        color: var(--muted);
        text-decoration: none;
      }
      .footer-actions a:hover {
        color: var(--accent);
      }
      @media (max-width: 860px) {
        .admin-card {
          grid-template-columns: 1fr;
        }
        .field-grid {
          grid-template-columns: 1fr;
        }
      }
    `)}
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="logo">${logoHtml("46px")}</div>
        <span class="eyebrow">Featured Projects Admin</span>
        <h1>Curate the public project shortlist.</h1>
        <p>Choose which live Kale Deploy projects appear on the public featured page, add a short editorial blurb, and set the order people see first.</p>
        <p class="hero-meta">Signed in as <strong>${escapeHtml(signedInEmail)}</strong></p>
      </section>

      ${flash ? `<div class="notice ${toneClass}" style="max-width:1100px; margin: 20px auto 0;"><p>${escapeHtml(flash.message)}</p></div>` : ""}

      ${projects.length > 0
        ? `<section class="project-grid">
            ${projects.map((project) => `
              <article class="admin-card${project.featured.enabled ? " featured" : ""}">
                <div class="project-copy">
                  <div class="project-header">
                    <div>
                      <h2>${escapeHtml(project.projectName)}</h2>
                      <p>${escapeHtml(project.featured.headline ?? project.description ?? "Live on Kale Deploy.")}</p>
                    </div>
                    ${project.featured.enabled ? `<span class="feature-badge">Featured</span>` : ""}
                  </div>
                  <div class="meta-list">
                    <span class="meta-chip">${escapeHtml(formatRuntimeLaneLabel(project.runtimeLane ?? "dedicated_worker"))}</span>
                    <span class="meta-chip repo-label">${escapeHtml(project.githubRepo)}</span>
                    <span class="meta-chip">Updated ${escapeHtml(project.updatedAt)}</span>
                  </div>
                  <div class="project-links">
                    <a href="${escapeHtml(project.deploymentUrl)}">Open site</a>
                    <a href="${escapeHtml(`https://github.com/${project.githubRepo}`)}">View code</a>
                  </div>
                </div>
                <form class="curation-form" method="post" action="${escapeHtml(`${serviceBaseUrl}/featured/control`)}">
                  <input type="hidden" name="formToken" value="${escapeHtml(formToken)}" />
                  <input type="hidden" name="projectName" value="${escapeHtml(project.projectName)}" />
                  <div class="field-group">
                    <label class="toggle-row">
                      <input type="checkbox" name="featureProject" value="1"${project.featured.enabled ? " checked" : ""} />
                      Show this project on the public featured page
                    </label>
                    <p class="field-help">Only live projects are shown here, so anything you enable is immediately publishable.</p>
                  </div>
                  <div class="field-grid">
                    <div class="field-group">
                      <label for="feature-headline-${escapeHtml(project.projectName)}">Short blurb</label>
                      <input
                        id="feature-headline-${escapeHtml(project.projectName)}"
                        name="featureHeadline"
                        maxlength="160"
                        placeholder="One sentence about why this belongs on the front page."
                        value="${escapeHtml(project.featured.headline ?? "")}"
                      />
                      <p class="field-help">Optional. Falls back to the project description when blank.</p>
                    </div>
                    <div class="field-group">
                      <label for="feature-sort-order-${escapeHtml(project.projectName)}">Order</label>
                      <input
                        id="feature-sort-order-${escapeHtml(project.projectName)}"
                        name="featureSortOrder"
                        type="number"
                        min="0"
                        step="1"
                        value="${escapeHtml(String(project.featured.sortOrder))}"
                      />
                      <p class="field-help">Lower numbers appear first.</p>
                    </div>
                  </div>
                  <div class="form-actions">
                    <button class="button" type="submit">Save</button>
                  </div>
                </form>
              </article>
            `).join("")}
          </section>`
        : `<section class="empty-card">
            <p>No live projects are available to curate yet.</p>
          </section>`
      }

      <div class="footer-actions">
        <a href="${escapeHtml(`${serviceBaseUrl}/featured`)}">Public featured page</a>
        <a href="${escapeHtml(serviceBaseUrl)}">Back to Kale Deploy</a>
      </div>
    </main>
  </body>
</html>`;
}
