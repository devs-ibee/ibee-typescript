/** Thrown when the API returns a non-2xx response. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(statusCode: number, body: unknown, message?: string) {
    super(message ?? `IBEE API error ${statusCode}`);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.body = body;
  }
}
