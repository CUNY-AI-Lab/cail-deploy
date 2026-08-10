import { WorkerEntrypoint } from "cloudflare:workers";
import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { ApiError, errorResponse } from "../../domain/errors";
import { readLoggingContext, type Env, type OAuthHelpersLike } from "../../env";
import { workerHandler } from "../../handler";
import { handleOAuthAuthorize } from "../../oauth-consent";
import {
  insufficientScopeResponse,
  OAUTH_REQUIRED_SCOPE,
  type OAuthPrincipalProps,
  oauthPrincipalFromProps,
} from "../../oauth-principal";
import { requestIdForRequest } from "../../request-id";
import { handleMcpWithPrincipal } from "./mcp";
import { validatedOAuthPublicBaseUrl } from "./oauth-origin";

function publicBaseUrl(env: Env): string {
  return validatedOAuthPublicBaseUrl(env.PUBLIC_BASE_URL);
}

function resourceMetadataUrl(env: Env): string {
  return `${publicBaseUrl(env)}/.well-known/oauth-protected-resource/mcp`;
}

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-CAIL-Request-Id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

class McpOAuthApiHandler extends WorkerEntrypoint<Env, OAuthPrincipalProps> {
  override async fetch(request: Request): Promise<Response> {
    let requestId: string = crypto.randomUUID();
    try {
      requestId = requestIdForRequest(request);
      if (request.headers.has("X-CAIL-Identity-JWT")) {
        throw new ApiError(401, "credential_ambiguity", "Send one sign-in credential, not two.");
      }
      const principalResult = oauthPrincipalFromProps(this.ctx.props as unknown);
      if (principalResult.kind === "insufficient_scope") {
        return insufficientScopeResponse(resourceMetadataUrl(this.env), requestId);
      }
      if (principalResult.kind === "invalid") {
        throw new ApiError(401, "invalid_credential", "Your sign-in isn't valid. Sign in again.");
      }
      return withRequestId(
        await handleMcpWithPrincipal(request, this.env, requestId, principalResult.principal),
        requestId,
      );
    } catch (error) {
      return withRequestId(errorResponse(error, requestId), requestId);
    }
  }
}

const oauthDefaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/oauth/authorize") {
      let requestId: string = crypto.randomUUID();
      try {
        requestId = requestIdForRequest(request);
        if (!env.OAUTH_PROVIDER) {
          throw new ApiError(
            503,
            "oauth_not_configured",
            "Sign-in is unavailable right now. Try again shortly.",
          );
        }
        return withRequestId(
          await handleOAuthAuthorize(request, env, env.OAUTH_PROVIDER),
          requestId,
        );
      } catch (error) {
        return withRequestId(errorResponse(error, requestId), requestId);
      }
    }
    return workerHandler.fetch(request, env);
  },
};

export function createOAuthProviderOptions(env: Env): OAuthProviderOptions<Env> {
  const baseUrl = publicBaseUrl(env);
  const resource = `${baseUrl}/mcp`;
  return {
    apiRoute: resource,
    apiHandler: McpOAuthApiHandler,
    defaultHandler: oauthDefaultHandler,
    authorizeEndpoint: `${baseUrl}/api/oauth/authorize`,
    tokenEndpoint: `${baseUrl}/oauth/token`,
    clientRegistrationEndpoint: `${baseUrl}/oauth/register`,
    scopesSupported: [OAUTH_REQUIRED_SCOPE],
    accessTokenTTL: 3600,
    allowPlainPKCE: false,
    allowImplicitFlow: false,
    allowTokenExchangeGrant: false,
    clientIdMetadataDocumentEnabled: false,
    disallowPublicClientRegistration: false,
    resourceMatchOriginOnly: false,
    resourceMetadata: {
      resource,
      authorization_servers: [baseUrl],
      scopes_supported: [OAUTH_REQUIRED_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Kale Deploy",
    },
  };
}

export const oauthWorkerHandler = {
  async fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    let requestId: string = crypto.randomUUID();
    try {
      requestId = requestIdForRequest(request);
      const path = new URL(request.url).pathname;
      const operationalPath =
        path !== "/health" &&
        (path === "/mcp" ||
          path.startsWith("/v1/") ||
          path.startsWith("/api/oauth/") ||
          path.startsWith("/oauth/") ||
          path.startsWith("/.well-known/"));
      if (operationalPath && !readLoggingContext(env)) {
        throw new ApiError(
          503,
          "logging_configuration_error",
          "This service isn't available right now.",
        );
      }
      if (
        path === "/mcp" &&
        request.headers.has("Authorization") &&
        request.headers.has("X-CAIL-Identity-JWT")
      ) {
        return withRequestId(
          errorResponse(
            new ApiError(401, "credential_ambiguity", "Send one sign-in credential, not two."),
            requestId,
          ),
          requestId,
        );
      }
      const options = createOAuthProviderOptions(env);
      return await new OAuthProvider<Env>(options).fetch(request, env, executionContext);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  },
};

export type { OAuthHelpersLike };
