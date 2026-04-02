export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 502 | 503;

export class HttpError extends Error {
  constructor(readonly status: HttpStatus, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function asHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (error instanceof Error) {
    return new HttpError(500, error.message);
  }

  return new HttpError(500, "Unexpected error.");
}
