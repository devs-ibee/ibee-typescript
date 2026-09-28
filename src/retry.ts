/**
 * Key-aware retry policy.
 *
 * A request is retried only when it is safe to repeat: GET/HEAD/OPTIONS, or a
 * write that carries an idempotency key on a route whose backend honours it.
 * Only 429/502/503/504 responses are retried; 408, 409, 500 and other 4xx
 * are never retried.
 */

import { parseRetryAfterSeconds } from "./errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** Max delay between attempts, in milliseconds. */
export const MAX_RETRY_DELAY_MS = 30_000;

// VM create is deliberately excluded: replaying a create with the same key
// can surface as a "name already exists" conflict instead of the original
// operation, so creates are never retried automatically.
const HEADER_KEY_ROUTE =
  /^\/?compute\/(cloud-vms|gpu-vms)\/[^/]+(\/actions\/(start|stop|reboot|access|resize|resize-plan|resize-root-disk|attach-volume|detach-volume))?\/?$/;
const BODY_KEY_ROUTE = /^\/?block-storage\/volumes(\/[^/]+\/(attachments|detach|resize))?\/?$/;
const QUERY_KEY_ROUTE = /^\/?block-storage\/volumes\/[^/]+\/?$/;

function relPath(path: string): string {
  return String(path).split("?")[0].replace(/^\/?v1(?=\/)/, "");
}

function nonEmpty(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** Whether repeating this request cannot duplicate a side effect. */
export function isRetrySafe(
  method: string,
  path: string,
  headers?: Record<string, string>,
  body?: unknown,
  query?: Record<string, unknown>,
): boolean {
  const m = method.toUpperCase();
  if (SAFE_METHODS.has(m)) return true;
  const p = relPath(path);
  if (nonEmpty(headerValue(headers, "X-Idempotency-Key")) && ["POST", "PATCH", "DELETE"].includes(m)) {
    if (HEADER_KEY_ROUTE.test(p)) return true;
  }
  if (
    m === "POST" &&
    body &&
    typeof body === "object" &&
    nonEmpty((body as Record<string, unknown>).idempotency_key) &&
    BODY_KEY_ROUTE.test(p)
  ) {
    return true;
  }
  if (m === "DELETE" && query && nonEmpty(query.idempotency_key) && QUERY_KEY_ROUTE.test(p)) {
    return true;
  }
  return false;
}

/** True for 429/502/503/504. */
export function shouldRetryStatus(status: number): boolean {
  return RETRY_STATUSES.has(status);
}

/**
 * Delay before retry `attempt` (0-based), in milliseconds. Honours
 * `retry-after-ms` and `Retry-After` (seconds or HTTP date), clamped to
 * 0..30 s; otherwise exponential backoff 1 s * 2^attempt with ±10% jitter.
 */
export function retryDelayMs(
  attempt: number,
  headers?: Headers | Record<string, string>,
  random: () => number = Math.random,
): number {
  const retryAfter = parseRetryAfterSeconds(headers);
  if (retryAfter !== undefined) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retryAfter * 1000));
  }
  const base = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** attempt);
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, base * (1 + (random() - 0.5) * 0.2)));
}
