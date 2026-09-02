import { ApiError } from "../../domain/errors";

export const CANONICAL_DOORWAY_ORIGIN = "https://tools.ailab.gc.cuny.edu" as const;

interface OAuthUrlValidationOptions {
  readonly allowOrigin: (url: URL) => boolean;
  readonly path: string;
}

function validatedOAuthUrl(value: string, options: OAuthUrlValidationOptions): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(
      503,
      "oauth_not_configured",
      "Sign-in is unavailable right now. Try again shortly.",
    );
  }
  const loopbackHttp =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    (!options.allowOrigin(url) && !loopbackHttp) ||
    url.username ||
    url.password ||
    url.pathname !== options.path ||
    url.search ||
    url.hash
  ) {
    throw new ApiError(
      503,
      "oauth_not_configured",
      "Sign-in is unavailable right now. Try again shortly.",
    );
  }
  return url;
}

export function validatedOAuthPublicBaseUrl(value: string): string {
  return validatedOAuthUrl(value, {
    allowOrigin: (url) => url.protocol === "https:",
    path: "/",
  }).origin;
}

export function validatedOAuthAuthorizeUrl(value: string): string {
  return validatedOAuthUrl(value, {
    allowOrigin: (url) => url.origin === CANONICAL_DOORWAY_ORIGIN,
    path: "/api/oauth/authorize",
  }).toString();
}
