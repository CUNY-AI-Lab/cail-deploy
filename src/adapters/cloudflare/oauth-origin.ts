import { ApiError } from "../../domain/errors";

export const CANONICAL_DOORWAY_ORIGIN = "https://tools.ailab.gc.cuny.edu" as const;

export function validatedOAuthPublicBaseUrl(value: string): string {
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
    (url.protocol !== "https:" && !loopbackHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ApiError(
      503,
      "oauth_not_configured",
      "Sign-in is unavailable right now. Try again shortly.",
    );
  }
  return url.origin;
}

export function validatedOAuthAuthorizeUrl(value: string): string {
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
  const canonicalDoorway = url.origin === CANONICAL_DOORWAY_ORIGIN;
  if (
    (!canonicalDoorway && !loopbackHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/api/oauth/authorize" ||
    url.search ||
    url.hash
  ) {
    throw new ApiError(
      503,
      "oauth_not_configured",
      "Sign-in is unavailable right now. Try again shortly.",
    );
  }
  return url.toString();
}
