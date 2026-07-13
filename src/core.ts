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
  /** API token (`ibee_live_...` / `ibee_dev_...`). */
  token: string;
  /** Base URL. Defaults to the production gateway. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
}

export class HttpClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    if (!opts.token) throw new Error("An API token is required.");
    this.token = opts.token;
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
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (args.body !== undefined) headers["Content-Type"] = "application/json";
    if (args.idempotencyKey) headers["X-Idempotency-Key"] = args.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: args.method,
        headers,
        body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      throw new ApiError(res.status, parsed);
    }
    return parsed as T;
  }
}
