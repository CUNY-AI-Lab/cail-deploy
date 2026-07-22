const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function requestIdForRequest(request: Request): string {
  const supplied = request.headers.get("X-CAIL-Request-Id");
  if (!supplied) return crypto.randomUUID();
  if (!UUID_PATTERN.test(supplied)) {
    throw new TypeError("X-CAIL-Request-Id must be a UUID.");
  }
  return supplied;
}
