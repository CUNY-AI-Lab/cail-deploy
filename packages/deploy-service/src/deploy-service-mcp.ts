import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { HttpError } from "./http-error";

type McpPayload = Record<string, unknown>;
type McpStatusResponse = {
  status: number;
  body: McpPayload;
};

type ConnectionHealthPayload = McpPayload & {
  localWrapperStatus?: {
    warning?: boolean;
    summary?: string;
  };
};

type RepositoryLifecyclePayload = McpPayload & {
  summary: string;
  nextAction?: string;
};

export function createDeployServiceMcpServer(input: {
  serviceBaseUrl: string;
  identityType: string;
  maxProjectNameLength: number;
  getRuntimeManifest: () => McpPayload;
  getConnectionHealth: (input?: {
    harness?: string;
    localBundleVersion?: string;
  }) => ConnectionHealthPayload;
  getRepositoryLifecycle: (
    repository: { owner: string; repo: string },
    projectName?: string
  ) => Promise<RepositoryLifecyclePayload>;
  queueValidation: (input: {
    repositoryFullName?: string;
    repositoryUrl?: string;
    ref?: string;
    projectName?: string;
  }) => Promise<McpStatusResponse>;
  getProjectStatus: (projectName: string) => Promise<McpStatusResponse>;
  summarizeProjectStatus: (payload: McpPayload) => string;
  getBuildJobStatus: (jobId: string) => Promise<McpStatusResponse>;
  summarizeBuildJobStatus: (payload: McpPayload) => string;
  listProjectSecrets: (projectName: string) => Promise<McpStatusResponse & { summary: string }>;
  setProjectSecret: (projectName: string, secretName: string, value: string) => Promise<McpStatusResponse & { summary: string }>;
  deleteProjectSecret: (projectName: string, secretName: string) => Promise<McpStatusResponse & { summary: string }>;
  deleteProject: (projectName: string, confirmProjectName: string) => Promise<McpStatusResponse & { summary: string }>;
  getAdminOverview?: () => Promise<McpStatusResponse & { summary: string }>;
  setFeaturedProject?: (projectName: string, headline?: string, sortOrder?: number) => Promise<McpStatusResponse & { summary: string }>;
  unfeatureProject?: (projectName: string) => Promise<McpStatusResponse & { summary: string }>;
}): McpServer {
  const server = new McpServer(
    {
      name: "kale-deploy",
      version: "0.1.0"
    },
    {
      instructions: [
        "Use register_project to determine the canonical slug and guided GitHub install URL.",
        "Use get_runtime_manifest for dynamic_skill_policy, current harness install policy, and update policy if local add-on guidance looks stale.",
        "Use validate_project for a build-only check before asking the user to go live.",
        "If guidedInstallUrl is present, the next step still requires a human browser handoff to GitHub.",
        "Kale Deploy uses standard MCP OAuth on /mcp; let your harness open the browser login flow automatically.",
        "Only use the GitHub user-authorization step when managing sensitive project-admin features such as secrets or project deletion."
      ].join(" "),
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
    }
  );

  server.registerTool(
    "get_runtime_manifest",
    {
      title: "Get runtime manifest",
      description: "Return the current Kale Deploy runtime manifest, including the agent API and MCP endpoint.",
      inputSchema: {}
    },
    async () => createMcpToolResult("Returned the current Kale Deploy runtime manifest.", input.getRuntimeManifest())
  );

  server.registerTool(
    "test_connection",
    {
      title: "Test connection",
      description: "Confirm that Kale Deploy is authenticated and return the next step, optionally for a specific repository.",
      inputSchema: {
        repository: z.string().optional().describe("Optional GitHub repository as owner/repo or a full GitHub URL."),
        projectName: z.string().optional().describe("Optional requested project slug override."),
        harness: z.string().optional().describe("Optional local harness id, such as claude, codex, or gemini."),
        localBundleVersion: z.string().optional().describe("Optional local Kale wrapper bundle version for stale-wrapper checks.")
      }
    },
    async ({ repository, projectName, harness, localBundleVersion }) => {
      const connectionHealth = input.getConnectionHealth({ harness, localBundleVersion });
      if (repository) {
        const lifecycle = await input.getRepositoryLifecycle(parseRepositoryInput(repository), projectName);
        return createMcpToolResult(
          `Kale Deploy is connected and authenticated. ${lifecycle.summary}`,
          {
            ...connectionHealth,
            nextAction: lifecycle.nextAction,
            summary: connectionHealth.localWrapperStatus?.warning
              ? `Kale Deploy is connected and authenticated. ${lifecycle.summary} ${connectionHealth.localWrapperStatus.summary}`
              : `Kale Deploy is connected and authenticated. ${lifecycle.summary}`,
            repositoryStatus: lifecycle
          }
        );
      }

      return createMcpToolResult(
        "Kale Deploy is connected and authenticated.",
        {
          ...connectionHealth,
          nextAction: "register_project",
          summary: connectionHealth.localWrapperStatus?.warning
            ? `Kale Deploy is connected and authenticated. Call register_project for the repository you want to deploy next. ${connectionHealth.localWrapperStatus.summary}`
            : "Kale Deploy is connected and authenticated. Call register_project for the repository you want to deploy next."
        }
      );
    }
  );

  server.registerTool(
    "get_repository_status",
    {
      title: "Get repository status",
      description: "Return the repo-first lifecycle state for a GitHub repository, including slug, install coverage, and next action.",
      inputSchema: {
        repository: z.string().describe("GitHub repository as owner/repo or a full GitHub URL."),
        projectName: z.string().optional().describe("Optional requested project slug override.")
      }
    },
    async ({ repository, projectName }) => {
      const lifecycle = await input.getRepositoryLifecycle(parseRepositoryInput(repository), projectName);
      return createMcpToolResult(lifecycle.summary, lifecycle);
    }
  );

  server.registerTool(
    "register_project",
    {
      title: "Register project",
      description: "Determine the canonical project slug and install state for a repository before the first push.",
      inputSchema: {
        repository: z.string().describe("GitHub repository as owner/repo or a full GitHub URL."),
        projectName: z.string().optional().describe("Optional requested project slug override.")
      }
    },
    async ({ repository, projectName }) => {
      const lifecycle = await input.getRepositoryLifecycle(parseRepositoryInput(repository), projectName);
      return createMcpToolResult(lifecycle.summary, lifecycle);
    }
  );

  server.registerTool(
    "validate_project",
    {
      title: "Validate project",
      description: "Queue a build-only validation job for a GitHub branch or commit without deploying it.",
      inputSchema: {
        repository: z.string().describe("GitHub repository as owner/repo or a full GitHub URL."),
        ref: z.string().optional().describe("Branch, tag, or commit to validate. Defaults to the repo default branch."),
        projectName: z.string().optional().describe("Optional requested project slug override.")
      }
    },
    async ({ repository, ref, projectName }) => {
      const validation = await input.queueValidation({
        ...parseRepositoryBody(repository),
        ref,
        projectName
      });

      if (validation.status >= 400) {
        return createMcpToolErrorResult(extractMcpErrorMessage(validation.body), validation.body);
      }

      return createMcpToolResult(
        `Validation queued for ${repository}${ref ? ` at ${ref}` : ""}.`,
        validation.body
      );
    }
  );

  server.registerTool(
    "get_project_status",
    {
      title: "Get project status",
      description: "Return the current deployment lifecycle state for a project slug.",
      inputSchema: {
        projectName: z.string().describe(`Kale project slug in lowercase kebab-case, up to ${input.maxProjectNameLength} characters.`)
      }
    },
    async ({ projectName }) => {
      const status = await input.getProjectStatus(projectName);
      if (status.status >= 400) {
        return createMcpToolErrorResult(extractMcpErrorMessage(status.body), status.body);
      }

      return createMcpToolResult(input.summarizeProjectStatus(status.body), status.body);
    }
  );

  server.registerTool(
    "get_build_job_status",
    {
      title: "Get build job status",
      description: "Return the current lifecycle state for a queued, running, passed, or failed build job.",
      inputSchema: {
        jobId: z.string().describe("Build job ID returned by validate_project or deployment status.")
      }
    },
    async ({ jobId }) => {
      const status = await input.getBuildJobStatus(jobId);
      if (status.status >= 400) {
        return createMcpToolErrorResult(extractMcpErrorMessage(status.body), status.body);
      }

      return createMcpToolResult(input.summarizeBuildJobStatus(status.body), status.body);
    }
  );

  server.registerTool(
    "list_project_secrets",
    {
      title: "List project secrets",
      description: "List stored secret names for a Kale project. Secret values are never returned.",
      inputSchema: {
        projectName: z.string().describe(`Kale project slug in lowercase kebab-case, up to ${input.maxProjectNameLength} characters.`)
      }
    },
    async ({ projectName }) => {
      const result = await input.listProjectSecrets(projectName);
      if (result.status >= 400) {
        return createMcpToolErrorResult(result.summary, result.body);
      }

      return createMcpToolResult(result.summary, result.body);
    }
  );

  server.registerTool(
    "set_project_secret",
    {
      title: "Set project secret",
      description: "Create or update a project secret. Secret values are write-only and never returned.",
      inputSchema: {
        projectName: z.string().describe(`Kale project slug in lowercase kebab-case, up to ${input.maxProjectNameLength} characters.`),
        secretName: z.string().describe("Secret name, usually uppercase like OPENAI_API_KEY."),
        value: z.string().describe("Secret value to store for this project.")
      }
    },
    async ({ projectName, secretName, value }) => {
      const result = await input.setProjectSecret(projectName, secretName, value);
      if (result.status >= 400) {
        return createMcpToolErrorResult(result.summary, result.body);
      }

      return createMcpToolResult(result.summary, result.body);
    }
  );

  server.registerTool(
    "delete_project_secret",
    {
      title: "Delete project secret",
      description: "Remove a stored project secret by name.",
      inputSchema: {
        projectName: z.string().describe(`Kale project slug in lowercase kebab-case, up to ${input.maxProjectNameLength} characters.`),
        secretName: z.string().describe("Secret name to remove.")
      }
    },
    async ({ projectName, secretName }) => {
      const result = await input.deleteProjectSecret(projectName, secretName);
      if (result.status >= 400) {
        return createMcpToolErrorResult(result.summary, result.body);
      }

      return createMcpToolResult(result.summary, result.body);
    }
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete project",
      description: "Permanently delete a Kale project and its Kale-managed resources. This does not delete the GitHub repository.",
      inputSchema: {
        projectName: z.string().describe(`Kale project slug in lowercase kebab-case, up to ${input.maxProjectNameLength} characters.`),
        confirmProjectName: z.string().describe("Repeat the exact project slug to confirm permanent deletion.")
      }
    },
    async ({ projectName, confirmProjectName }) => {
      const result = await input.deleteProject(projectName, confirmProjectName);
      if (result.status >= 400) {
        return createMcpToolErrorResult(result.summary, result.body);
      }

      return createMcpToolResult(result.summary, result.body);
    }
  );

  if (input.getAdminOverview && input.setFeaturedProject && input.unfeatureProject) {
    const getAdminOverview = input.getAdminOverview;
    const setFeaturedProject = input.setFeaturedProject;
    const unfeatureProject = input.unfeatureProject;

    server.registerTool(
      "get_admin_overview",
      {
        title: "Get admin overview",
        description: "List the current live project inventory, featured shortlist, and pending deletion backlogs for Kale admins.",
        inputSchema: {}
      },
      async () => {
        const result = await getAdminOverview();
        if (result.status >= 400) {
          return createMcpToolErrorResult(result.summary, result.body);
        }

        return createMcpToolResult(result.summary, result.body);
      }
    );

    server.registerTool(
      "set_featured_project",
      {
        title: "Set featured project",
        description: "Feature a live project on the public Kale Deploy featured page.",
        inputSchema: {
          projectName: z.string().describe(`Kale project slug in lowercase kebab-case, up to ${input.maxProjectNameLength} characters.`),
          headline: z.string().optional().describe("Optional editorial blurb for the public featured page."),
          sortOrder: z.number().int().nonnegative().optional().describe("Lower numbers appear first. Defaults to 100.")
        }
      },
      async ({ projectName, headline, sortOrder }) => {
        const result = await setFeaturedProject(projectName, headline, sortOrder);
        if (result.status >= 400) {
          return createMcpToolErrorResult(result.summary, result.body);
        }

        return createMcpToolResult(result.summary, result.body);
      }
    );

    server.registerTool(
      "unfeature_project",
      {
        title: "Unfeature project",
        description: "Remove a project from the public Kale Deploy featured page.",
        inputSchema: {
          projectName: z.string().describe(`Kale project slug in lowercase kebab-case, up to ${input.maxProjectNameLength} characters.`)
        }
      },
      async ({ projectName }) => {
        const result = await unfeatureProject(projectName);
        if (result.status >= 400) {
          return createMcpToolErrorResult(result.summary, result.body);
        }

        return createMcpToolResult(result.summary, result.body);
      }
    );
  }

  server.registerResource(
    "runtime-manifest",
    "kale://runtime/manifest",
    {
      mimeType: "application/json",
      description: "Kale Deploy runtime manifest"
    },
    async () => ({
      contents: [
        {
          uri: "kale://runtime/manifest",
          mimeType: "application/json",
          text: JSON.stringify(input.getRuntimeManifest(), null, 2)
        }
      ]
    })
  );

  server.registerResource(
    "mcp-auth-model",
    "kale://runtime/auth",
    {
      mimeType: "application/json",
      description: "Authentication requirements for the Kale Deploy MCP server"
    },
    async () => ({
      contents: [
        {
          uri: "kale://runtime/auth",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              identityType: input.identityType,
              notes: [
                "Kale Deploy uses standard MCP OAuth on /mcp.",
                "Your harness should discover /.well-known/oauth-protected-resource/mcp, open the browser login flow, and store the returned token automatically."
              ]
            },
            null,
            2
          )
        }
      ]
    })
  );

  return server;
}

function createMcpToolResult<TPayload extends McpPayload>(text: string, payload: TPayload) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: payload
  };
}

function createMcpToolErrorResult<TPayload extends McpPayload>(text: string, payload: TPayload) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: payload,
    isError: true
  };
}

function parseRepositoryInput(repository: string): { owner: string; repo: string } {
  return parseRepositoryReference(parseRepositoryBody(repository));
}

function parseRepositoryBody(repository: string): {
  repositoryFullName?: string;
  repositoryUrl?: string;
} {
  const trimmed = repository.trim();
  return /^https?:\/\//i.test(trimmed)
    ? { repositoryUrl: trimmed }
    : { repositoryFullName: trimmed };
}

function parseRepositoryReference(body: {
  repositoryUrl?: string;
  repositoryFullName?: string;
}): { owner: string; repo: string } {
  if (body.repositoryFullName) {
    const match = body.repositoryFullName.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (match) {
      return { owner: match[1], repo: stripGitSuffix(match[2]) };
    }
  }

  if (body.repositoryUrl) {
    let url: URL;
    try {
      url = new URL(body.repositoryUrl);
    } catch {
      throw new HttpError(400, "Repository URL must be a valid GitHub URL.");
    }

    if (url.hostname !== "github.com") {
      throw new HttpError(400, "Repository URL must point to github.com.");
    }

    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) {
      throw new HttpError(400, "Repository URL must include owner and repository name.");
    }

    return {
      owner: parts[0],
      repo: stripGitSuffix(parts[1])
    };
  }

  throw new HttpError(400, "Provide repositoryUrl or repositoryFullName.");
}

function stripGitSuffix(repositoryName: string): string {
  return repositoryName.replace(/\.git$/i, "");
}

function extractMcpErrorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }

  return "Request failed.";
}
