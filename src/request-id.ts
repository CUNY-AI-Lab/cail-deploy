import { ApiError } from "./domain/errors";

// Exactly what cail-log accepts for a request correlation id: canonical
// lowercase UUIDv4 or RFC 9562 UUIDv7 with the IETF variant. This was `[1-8]`
// with the `i` flag, so a v1 or uppercase id was adopted here, persisted with the
// release, and echoed to the caller — and then dropped the whole event at the
// cail-log boundary, because a single failed field discards the event. A release
// completed with zero observable operational events.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function requestIdForRequest(request: Request): string {
  const supplied = request.headers.get("X-CAIL-Request-Id");
  if (!supplied) return crypto.randomUUID();
  if (!UUID_PATTERN.test(supplied)) {
    throw new ApiError(400, "invalid_request_id", "X-CAIL-Request-Id must be a UUID.");
  }
  return supplied;
}
