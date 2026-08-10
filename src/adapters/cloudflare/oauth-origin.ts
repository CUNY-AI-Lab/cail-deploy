import { ApiError } from "../../domain/errors";

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
