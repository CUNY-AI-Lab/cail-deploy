export interface ApiErrorSnapshot {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

const apiErrorSnapshots = new WeakMap<object, ApiErrorSnapshot>();
const internalErrorSnapshot: ApiErrorSnapshot = Object.freeze({
  status: 500,
  code: "internal_error",
  message: "The request could not be completed.",
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiError";
    apiErrorSnapshots.set(
      this,
      Object.freeze({
        status,
        code,
        message,
      }),
    );
  }
}

export function apiErrorSnapshot(error: unknown): ApiErrorSnapshot | undefined {
  return apiErrorSnapshots.get(error as object);
}

export function errorResponse(error: unknown, requestId: string): Response {
  const apiError = apiErrorSnapshot(error) ?? internalErrorSnapshot;
  return Response.json(
    { error: { code: apiError.code, message: apiError.message, requestId } },
    {
      status: apiError.status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
