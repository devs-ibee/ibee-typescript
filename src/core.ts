import { ApiError } from "./errors.js";

export interface RequestArgs {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path after the base URL, e.g. `/secret-store/stores`. */
  path: string;
  /** Workspace scope — sent as the required `workspace_id` query param. */
  workspaceId: string;
  /** Extra query parameters. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON request body. */
  body?: unknown;
  /** Sent as the `X-Idempotency-Key` header on write operations. */
  idempotencyKey?: string;
}

export interface ClientOptions {
  /** API token (`ibee_prod_key_...` / `ibee_dev_key_...`). */
  token: string;
  /** Base URL. Defaults to the production gateway. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** Pre-built auth header. Non-enumerable so the token never leaks into
   *  JSON.stringify / console.log / structured-logger output of the client. */
  private readonly authHeader!: string;

  constructor(opts: ClientOptions) {
    if (!opts.token) throw new Error("An API token is required.");
    Object.defineProperty(this, "authHeader", {
      value: `Bearer ${opts.token}`,
      enumerable: false,
      writable: false,
    });
    this.baseUrl = (opts.baseUrl ?? "https://api.ibee.ai/v1").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        "No fetch implementation found. Use Node 18+ or pass `fetch` in the client options.",
      );
    }
  }

  async request<T>(args: RequestArgs): Promise<T> {
    const url = new URL(this.baseUrl + args.path);
    url.searchParams.set("workspace_id", args.workspaceId);
    if (args.query) {
      for (const [k, v] of Object.entries(args.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
    if (args.body !== undefined) headers["Content-Type"] = "application/json";
    if (args.idempotencyKey) headers["X-Idempotency-Key"] = args.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // The abort signal (and timer) stay active through the body read, so a
    // stalled response body can't hang the request past the timeout.
    try {
      const res = await this.fetchImpl(url.toString(), {
        method: args.method,
        headers,
        body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!res.ok) throw new ApiError(res.status, parsed);
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
