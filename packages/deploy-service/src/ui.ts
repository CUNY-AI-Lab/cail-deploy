// Shared UI helpers for CAIL Deploy pages — aligned to the CUNY AI Lab logo palette

const LOGO_PNG_BASE64 = "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";

const FAVICON_SVG_BASE64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3QgeD0iMyIgeT0iNCIgd2lkdGg9IjI2IiBoZWlnaHQ9IjQiIHJ4PSIyIiBmaWxsPSIjMUIyQTRBIi8+PHJlY3QgeD0iNSIgeT0iMTAiIHdpZHRoPSIyMiIgaGVpZ2h0PSI0IiByeD0iMiIgZmlsbD0iIzNCNkJDQyIvPjxyZWN0IHg9IjIiIHk9IjE2IiB3aWR0aD0iMjAiIGhlaWdodD0iNCIgcng9IjIiIGZpbGw9IiMyREM0QzQiLz48cmVjdCB4PSI0IiB5PSIyMiIgd2lkdGg9IjI0IiBoZWlnaHQ9IjQiIHJ4PSIyIiBmaWxsPSIjNEE3RkQ0Ii8+PC9zdmc+";

export function faviconLink(): string {
  return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${FAVICON_SVG_BASE64}" />`;
}

export function logoHtml(maxHeight = "48px"): string {
  return `<img src="data:image/png;base64,${LOGO_PNG_BASE64}" alt="CUNY AI Lab" style="max-height: ${maxHeight}; width: auto; display: block;" />`;
}

export function baseStyles(extra = ""): string {
  return `<style>
      :root {
        color-scheme: light;
        --bg: #f4f6f9;
        --panel: #ffffff;
        --ink: #1B2A4A;
        --muted: #5a6a7e;
        --border: #d4dbe6;
        --accent: #3B6BCC;
        --accent-hover: #2f59ad;
        --teal: #2DC4C4;
        --success: #1a8a3e;
        --error: #c9351e;
        --notice-bg: #f0f5ff;
        --code-bg: #eef2f7;
        --radius-card: 16px;
        --radius-button: 999px;
        --radius-code: 6px;
        --radius-notice: 12px;
        --shadow-card: 0 4px 24px rgba(27, 42, 74, 0.08);
        --max-width: 860px;
        --font-body: "Inter", system-ui, -apple-system, sans-serif;
        --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      *, *::before, *::after { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: var(--font-body);
        color: var(--ink);
        background: var(--bg);
      }
      main {
        max-width: var(--max-width);
        margin: 0 auto;
        padding: 48px 20px 72px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-card);
        padding: 28px;
        box-shadow: var(--shadow-card);
      }
      h1, h2 {
        margin: 0 0 14px;
        line-height: 1.15;
        color: var(--ink);
      }
      h1 { font-size: clamp(1.8rem, 4vw, 2.8rem); font-weight: 700; }
      h2 { font-size: 1.15rem; margin-top: 28px; font-weight: 600; }
      p, li {
        font-size: 1.02rem;
        line-height: 1.6;
        color: var(--muted);
      }
      ol, ul { padding-left: 1.2rem; }
      a { color: var(--accent); }
      code {
        font-family: var(--font-mono);
        font-size: 0.9em;
        background: var(--code-bg);
        padding: 0.15rem 0.35rem;
        border-radius: var(--radius-code);
        color: var(--ink);
      }
      textarea {
        font-family: var(--font-mono);
        width: 100%;
        min-height: 120px;
        border-radius: var(--radius-notice);
        border: 1px solid var(--border);
        background: var(--code-bg);
        padding: 14px;
        font-size: 0.9rem;
        line-height: 1.5;
        box-sizing: border-box;
        color: var(--ink);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin: 24px 0 8px;
      }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 12px 20px;
        border-radius: var(--radius-button);
        border: 1px solid var(--accent);
        background: var(--accent);
        color: white;
        text-decoration: none;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .button:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
      .button.secondary {
        background: transparent;
        color: var(--accent);
      }
      .button.secondary:hover { background: var(--notice-bg); }
      .notice {
        margin-top: 18px;
        padding: 14px 16px;
        border-radius: var(--radius-notice);
        border: 1px solid var(--border);
        background: var(--notice-bg);
      }
      .notice p { margin: 0; }
      .logo { margin-bottom: 24px; }
      ${extra}
    </style>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function serializeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}
