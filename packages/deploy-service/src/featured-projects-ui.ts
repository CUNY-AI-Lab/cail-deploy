import type { FeaturedProjectDisplayRecord } from "./lib/control-plane";
import { baseStyles, escapeHtml, faviconLink, logoHtml } from "./ui";
import { formatRuntimeLaneLabel } from "./runtime-lanes";

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
        <a href="${escapeHtml(`${serviceBaseUrl}/projects/control`)}">Project settings</a>
      </div>
    </main>
  </body>
</html>`;
}
