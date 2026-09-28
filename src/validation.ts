/**
 * Client-side validation shared by every resource. All checks run before any
 * HTTP request and throw `IbeeValidationError`.
 */

import { IbeeEnvironment } from "./environments.js";
import { IbeeError } from "./errors.js";

/** A request was rejected on the client before it was sent. */
export class IbeeValidationError extends IbeeError {
  /** Name of the offending field, when there is one. */
  readonly field?: string;

  constructor(message: string, code: string, field?: string) {
    super(message, code);
    this.name = "IbeeValidationError";
    this.field = field;
  }
}

// ---------------------------------------------------------------- workspace

export const WORKSPACE_ID_PATTERN = /^[1-9][0-9]*$/;
export const WORKSPACE_ID_ERROR =
  "workspace_id must be a positive numeric string (for example, '710995').";

/** Validate a workspace ID (`^[1-9][0-9]*$`, string only) and return it. */
export function validateWorkspaceId(workspaceId: unknown): string {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new IbeeValidationError(WORKSPACE_ID_ERROR, "invalid_workspace_id", "workspace_id");
  }
  return workspaceId;
}

// ------------------------------------------------------ environment / token

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Resolve and normalise the API base URL. Explicit `baseUrl` wins over
 * `environment`; the default is production. The URL must be absolute https
 * (http only for localhost), with no credentials, query, fragment or dot
 * path segments. A trailing `/` is removed.
 */
export function resolveBaseUrl(
  baseUrl?: string | null,
  environment?: string | null,
): string {
  const raw = String(baseUrl ?? environment ?? IbeeEnvironment.DEFAULT).trim();
  const fail = (): never => {
    throw new IbeeValidationError(
      "The IBEE base URL must be an absolute https URL (http is allowed only for localhost) without credentials, query or fragment.",
      "invalid_base_url",
      "base_url",
    );
  };
  if (/[\r\n\s]/.test(raw)) fail();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail();
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") fail();
  if (!url.hostname) fail();
  if (url.username || url.password) fail();
  if (url.search || url.hash || raw.includes("?") || raw.includes("#")) fail();
  // URL() already collapsed dot segments; inspect the raw path instead.
  const afterHost = raw.replace(/^[a-z]+:\/\/[^/]*/i, "");
  if (afterHost.split("/").some((seg) => seg === "." || seg === "..")) fail();
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname.toLowerCase())) fail();
  return raw.replace(/\/+$/, "");
}

/** Validate a token's basic shape (non-empty, no CR/LF). */
export function validateToken(token: unknown): string {
  if (typeof token !== "string" || token.trim() === "") {
    throw new IbeeValidationError("An API token is required.", "invalid_token", "token");
  }
  if (/[\r\n]/.test(token)) {
    throw new IbeeValidationError(
      "The API token must not contain line breaks.",
      "invalid_token",
      "token",
    );
  }
  return token;
}

/**
 * Reject a development token against the production endpoint and vice versa.
 * Other hosts and tokens without an `ibee_dev_key_` / `ibee_prod_key_` prefix
 * are not checked.
 */
export function checkTokenEnvironment(token: string, baseUrl: string): void {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return;
  }
  const mismatch =
    (host === "api.ibee.ai" && token.startsWith("ibee_dev_key_")) ||
    (host === "api.ibee.co.in" && token.startsWith("ibee_prod_key_"));
  if (mismatch) {
    throw new IbeeValidationError(
      "The API token environment does not match the configured IBEE endpoint.",
      "token_environment_mismatch",
      "token",
    );
  }
}

// -------------------------------------------------------------- idempotency

export const IDEMPOTENCY_KEY_PATTERN = /^[!-~]{1,128}$/;

/** Validate a caller-supplied idempotency key (printable ASCII, 1..128). */
export function validateIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new IbeeValidationError(
      "idempotency key must be 1-128 printable ASCII characters without spaces.",
      "invalid_idempotency_key",
      "idempotency_key",
    );
  }
  return key;
}

// ----------------------------------------------------------- request bodies

/** Maximum JSON body size the edge accepts on billable creates. */
export const MAX_BILLABLE_BODY_BYTES = 65_536;

const BILLABLE_CREATE_PATHS: RegExp[] = [
  /^\/secret-store\/stores\/?$/,
  /^\/secret-store\/stores\/[^/]+\/secrets\/?$/,
  /^\/object-storage\/buckets\/?$/,
  /^\/object-storage\/credentials\/?$/,
  /^\/networking\/vpcs\/[^/]+\/nat-gateways\/?$/,
  /^\/networking\/reserved-ips\/?$/,
  /^\/networking\/load-balancers\/(l4|l7)\/?$/,
  /^\/compute\/(cloud-vms|gpu-vms)\/?$/,
  /^\/block-storage\/volumes\/?$/,
  /^\/cdn\/distributions\/?$/,
  /^\/cdn\/distributions\/[^/]+\/custom-domains\/?$/,
];

function normalisePath(path: string): string {
  const p = String(path).split("?")[0];
  const withSlash = p.startsWith("/") ? p : `/${p}`;
  return withSlash.replace(/^\/v1(?=\/)/, "");
}

/** True for POST paths the edge runs billing admission on. */
export function isBillableCreate(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const p = normalisePath(path);
  return BILLABLE_CREATE_PATHS.some((re) => re.test(p));
}

/** Enforce the 64 KiB edge limit on billable create bodies. */
export function assertBillableBodySize(method: string, path: string, serialized: string | undefined): void {
  if (!isBillableCreate(method, path) || serialized === undefined) return;
  const size = new TextEncoder().encode(serialized).length;
  if (size > MAX_BILLABLE_BODY_BYTES) {
    throw new IbeeValidationError(
      `Request body is ${size} bytes; billable create requests are limited to ${MAX_BILLABLE_BODY_BYTES} bytes.`,
      "request_body_too_large",
    );
  }
}

// ------------------------------------------------------ billing eligibility

export const ELIGIBILITY_OPERATIONS = [
  "CREATE_RESOURCE",
  "CREATE_CREDENTIAL",
  "INCREASE_CAPACITY",
  "MUTATE_RESOURCE",
  "READ_RESOURCE",
  "DELETE_RESOURCE",
  "REVOKE_CREDENTIAL",
  "SECURITY_RECOVERY",
] as const;

/** Trim a SKU code; `undefined` when blank; throws when longer than 64. */
export function normaliseSkuCode(skuCode: unknown): string | undefined {
  if (skuCode === undefined || skuCode === null) return undefined;
  if (typeof skuCode !== "string") {
    throw new IbeeValidationError("sku_code must be a string.", "invalid_sku_code", "sku_code");
  }
  const s = skuCode.trim();
  if (s === "") return undefined;
  if (s.length > 64) {
    throw new IbeeValidationError(
      "sku_code must be at most 64 characters.",
      "invalid_sku_code",
      "sku_code",
    );
  }
  return s;
}

/** Validate and round an estimated cost in minor units. */
export function normaliseEstimatedCostMinor(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    Math.round(value) > Number.MAX_SAFE_INTEGER
  ) {
    throw new IbeeValidationError(
      "estimated_cost_minor must be a finite number >= 0 (minor currency units).",
      "invalid_estimated_cost_minor",
      "estimated_cost_minor",
    );
  }
  return Math.round(value);
}

/** Normalise an eligibility operation (case-insensitive). */
export function normaliseEligibilityOperation(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const op = String(value).trim().toUpperCase();
  if (!(ELIGIBILITY_OPERATIONS as readonly string[]).includes(op)) {
    throw new IbeeValidationError(
      `operation must be one of ${ELIGIBILITY_OPERATIONS.join(", ")}.`,
      "invalid_operation",
      "operation",
    );
  }
  return op;
}

// --------------------------------------------------------------- operations

/** Validate a compute operation ID and return it trimmed. */
export function validateOperationId(operationId: unknown): string {
  const id = typeof operationId === "string" ? operationId.trim() : "";
  if (!id) {
    throw new IbeeValidationError(
      "operation_id must be a non-empty string.",
      "invalid_operation_id",
      "operation_id",
    );
  }
  return id;
}

export const WAIT_DEFAULT_TIMEOUT_MS = 1_200_000;
export const WAIT_DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Validate wait bounds: timeout 1 s..2 h; poll interval 1..60 s and <= timeout. */
export function validateWaitOptions(
  timeoutMs: number = WAIT_DEFAULT_TIMEOUT_MS,
  pollIntervalMs: number = WAIT_DEFAULT_POLL_INTERVAL_MS,
): { timeoutMs: number; pollIntervalMs: number } {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 7_200_000) {
    throw new IbeeValidationError(
      "timeoutMs must be between 1000 and 7200000 (1 second to 2 hours).",
      "invalid_timeout",
      "timeout",
    );
  }
  if (
    typeof pollIntervalMs !== "number" ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 1_000 ||
    pollIntervalMs > 60_000 ||
    pollIntervalMs > timeoutMs
  ) {
    throw new IbeeValidationError(
      "pollIntervalMs must be between 1000 and 60000 and not exceed timeoutMs.",
      "invalid_poll_interval",
      "poll_interval",
    );
  }
  return { timeoutMs, pollIntervalMs };
}

// --------------------------------------------------------------- pagination

export interface ListPagingArgs {
  limit?: number;
  offset?: number;
  search?: string;
  sortBy?: string;
  sortDirection?: string;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Validate `limit` (1..maxLimit) and `offset` (>= 0). */
export function validateLimitOffset(
  args: { limit?: number; offset?: number },
  maxLimit: number,
): void {
  if (args.limit !== undefined && (!isInt(args.limit) || args.limit < 1 || args.limit > maxLimit)) {
    throw new IbeeValidationError(
      `limit must be an integer between 1 and ${maxLimit}.`,
      "invalid_limit",
      "limit",
    );
  }
  if (args.offset !== undefined && (!isInt(args.offset) || args.offset < 0)) {
    throw new IbeeValidationError("offset must be an integer >= 0.", "invalid_offset", "offset");
  }
}

export const VM_LIST_SORT_FIELDS = ["created_at", "name", "status", "os_type"] as const;

/**
 * Validate VM list paging parameters and return the query to send
 * (search trimmed and omitted when blank).
 */
export function vmListQuery(args: ListPagingArgs): Record<string, string | number | undefined> {
  validateLimitOffset(args, 100);
  let search: string | undefined;
  if (args.search !== undefined && args.search !== null) {
    search = String(args.search).trim() || undefined;
    if (search && search.length > 120) {
      throw new IbeeValidationError("search must be at most 120 characters.", "invalid_search", "search");
    }
  }
  if (args.sortBy !== undefined && !(VM_LIST_SORT_FIELDS as readonly string[]).includes(args.sortBy)) {
    throw new IbeeValidationError(
      `sortBy must be one of ${VM_LIST_SORT_FIELDS.join(", ")}.`,
      "invalid_sort_by",
      "sort_by",
    );
  }
  if (args.sortDirection !== undefined && args.sortDirection !== "asc" && args.sortDirection !== "desc") {
    throw new IbeeValidationError(
      "sortDirection must be 'asc' or 'desc'.",
      "invalid_sort_direction",
      "sort_direction",
    );
  }
  return {
    limit: args.limit,
    offset: args.offset,
    search,
    sort_by: args.sortBy,
    sort_direction: args.sortDirection,
  };
}

// ------------------------------------------------------------ environments

/**
 * Resolve an environment name the way the CLI reads `IBEE_ENV`:
 * `dev`/`development` -> DEVELOPMENT; empty, `prod`/`production` -> PRODUCTION
 * (trimmed, case-insensitive). Anything else throws `invalid_environment`.
 */
export function environmentFromName(name: string | null | undefined): string {
  const n = String(name ?? "").trim().toLowerCase();
  if (n === "dev" || n === "development") return IbeeEnvironment.DEVELOPMENT;
  if (n === "" || n === "prod" || n === "production") return IbeeEnvironment.PRODUCTION;
  throw new IbeeValidationError(
    "Invalid IBEE_ENV: use dev, development, prod or production",
    "invalid_environment",
    "environment",
  );
}
