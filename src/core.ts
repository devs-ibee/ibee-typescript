import { apiErrorFromResponse } from "./errors.js";
import { isRetrySafe, retryDelayMs, shouldRetryStatus } from "./retry.js";
import {
  assertBillableBodySize,
  checkTokenEnvironment,
  isBillableCreate,
  resolveBaseUrl,
  validateToken,
  validateWorkspaceId,
} from "./validation.js";
import { sleepMs } from "./polling.js";

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
  /** Aborts the request (and any pending retry). */
  signal?: AbortSignal;
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
  /**
   * Retries for retry-safe requests on 429/502/503/504 or transport errors
   * (default 2; 0 disables).
   */
  maxRetries?: number;
}

function idempotencyKeyOf(args: RequestArgs): string | undefined {
  if (args.idempotencyKey) return args.idempotencyKey;
  const b = args.body as Record<string, unknown> | undefined;
  if (b && typeof b === "object" && typeof b.idempotency_key === "string" && b.idempotency_key) {
    return b.idempotency_key;
  }
  const q = args.query?.idempotency_key;
  return typeof q === "string" && q ? q : undefined;
}

export class HttpClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  /** Pre-built auth header. Non-enumerable so the token never leaks into
   *  JSON.stringify / console.log / structured-logger output of the client. */
  private readonly authHeader!: string;

  constructor(opts: ClientOptions) {
    const token = validateToken(opts.token);
    this.baseUrl = resolveBaseUrl(opts.baseUrl);
    checkTokenEnvironment(token, this.baseUrl);
    Object.defineProperty(this, "authHeader", {
      value: `Bearer ${token}`,
      enumerable: false,
      writable: false,
    });
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    const maxRetries = opts.maxRetries ?? 2;
    this.maxRetries = Number.isInteger(maxRetries) && maxRetries > 0 ? maxRetries : 0;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        "No fetch implementation found. Use Node 18+ or pass `fetch` in the client options.",
      );
    }
  }

  async request<T>(args: RequestArgs): Promise<T> {
    validateWorkspaceId(args.workspaceId);
    const url = new URL(this.baseUrl + args.path);
    url.searchParams.set("workspace_id", args.workspaceId);
    if (args.query) {
      for (const [k, v] of Object.entries(args.query)) {
        if (v !== undefined && k !== "workspace_id") url.searchParams.set(k, String(v));
      }
    }

    // Billable creates must carry a JSON object body (the edge reads it).
    const body =
      args.body === undefined && isBillableCreate(args.method, args.path) ? {} : args.body;
    const serialized = body !== undefined ? JSON.stringify(body) : undefined;
    assertBillableBodySize(args.method, args.path, serialized);

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
    if (serialized !== undefined) headers["Content-Type"] = "application/json";
    if (args.idempotencyKey) headers["X-Idempotency-Key"] = args.idempotencyKey;

    const key = idempotencyKeyOf(args);
    const retrySafe = isRetrySafe(args.method, args.path, headers, body, args.query);

    for (let attempt = 0; ; attempt += 1) {
      const canRetry = attempt < this.maxRetries;
      let res: Response;
      let parsed: unknown = undefined;
      try {
        ({ res, parsed } = await this.send(url.toString(), args.method, headers, serialized, args.signal));
      } catch (err) {
        if (args.signal?.aborted) throw err;
        if (retrySafe && canRetry) {
          await sleepMs(retryDelayMs(attempt), args.signal);
          continue;
        }
        if (key && err && typeof err === "object") {
          try {
            (err as { idempotencyKey?: string }).idempotencyKey = key;
          } catch {
            // Non-extensible error object; ignore.
          }
        }
        throw err;
      }

      if (res.ok) return parsed as T;
      if (retrySafe && canRetry && shouldRetryStatus(res.status)) {
        await sleepMs(retryDelayMs(attempt, res.headers), args.signal);
        continue;
      }
      throw apiErrorFromResponse(res.status, parsed, {
        headers: res.headers,
        idempotencyKey: key,
        path: args.path,
      });
    }
  }

  private async send(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ res: Response; parsed: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    // The abort signal (and timer) stay active through the body read, so a
    // stalled response body can't hang the request past the timeout.
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body,
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
      return { res, parsed };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
