/**
 * Polling engine for asynchronous operations (compute operations today,
 * reusable for other operation resources).
 */

import {
  ApiError,
  NotFoundError,
  OperationFailedError,
  OperationTimeoutError,
  type OperationLike,
} from "./errors.js";

export const OPERATION_SUCCESS_STATES: ReadonlySet<string> = new Set(["succeeded", "completed"]);
export const OPERATION_FAILURE_STATES: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
  "timed_out",
]);

/** Consecutive transient poll failures tolerated before giving up. */
export const MAX_CONSECUTIVE_POLL_FAILURES = 3;

export interface PollUntilOptions<T> {
  /** Stable identifier for error messages. */
  operationId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  success?: ReadonlySet<string>;
  failure?: ReadonlySet<string>;
  maxConsecutiveFailures?: number;
  /** Throw OperationFailedError on a failure state (default true). */
  raiseOnFailure?: boolean;
  onUpdate?: (value: T) => void;
  signal?: AbortSignal;
  /** Test hooks. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** True for poll errors worth retrying (429/502/503/504 or transport). */
export function isTransientPollError(err: unknown): boolean {
  if (err instanceof NotFoundError) return false;
  if (err instanceof ApiError) return err.retryable;
  if (err instanceof TypeError) return true; // fetch network failure
  // Per-request timeouts abort the fetch. A caller's own AbortSignal is
  // checked before this function is consulted.
  const name = (err as { name?: unknown })?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

/** Sleep that rejects with the signal's reason when aborted. */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll `fetch` until `statusOf` reports a terminal state or the deadline
 * passes. Returns the final value on success (or on failure when
 * `raiseOnFailure` is false).
 */
export async function pollUntil<T>(
  fetch: () => Promise<T>,
  statusOf: (value: T) => unknown,
  options: PollUntilOptions<T>,
): Promise<T> {
  const success = options.success ?? OPERATION_SUCCESS_STATES;
  const failure = options.failure ?? OPERATION_FAILURE_STATES;
  const maxFailures = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_POLL_FAILURES;
  const sleep = options.sleep ?? sleepMs;
  const now = options.now ?? (() => Date.now());
  const raiseOnFailure = options.raiseOnFailure ?? true;
  const deadline = now() + options.timeoutMs;
  let failures = 0;
  let last: T | undefined;

  for (;;) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    let polled = false;
    try {
      last = await fetch();
      polled = true;
      failures = 0;
    } catch (err) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (!isTransientPollError(err)) throw err;
      failures += 1;
      if (failures >= maxFailures) throw err;
    }
    if (polled) {
      options.onUpdate?.(last as T);
      const status = String(statusOf(last as T) ?? "").toLowerCase();
      if (success.has(status)) return last as T;
      if (failure.has(status)) {
        if (!raiseOnFailure) return last as T;
        throw new OperationFailedError(last as unknown as OperationLike, options.operationId);
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new OperationTimeoutError(
        options.operationId,
        options.timeoutMs,
        last as unknown as OperationLike | undefined,
      );
    }
    await sleep(Math.min(options.pollIntervalMs, remaining), options.signal);
  }
}
