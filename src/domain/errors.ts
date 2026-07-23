export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiError";
  }
}

export function errorResponse(error: unknown, requestId: string): Response {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError(500, "internal_error", "The request could not be completed.");
  return Response.json(
    { error: { code: apiError.code, message: apiError.message, requestId } },
    { status: apiError.status },
  );
}
