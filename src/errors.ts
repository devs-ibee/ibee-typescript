/**
 * Error hierarchy for the IBEE SDK.
 *
 * - `IbeeError` is the base for SDK-originated, non-HTTP errors
 *   (client-side validation, operation wait failures and timeouts).
 * - `ApiError` is thrown for every non-2xx HTTP response. Status-specific
 *   subclasses (`NotFoundError`, `BillingDeniedError`, ...) all extend it, so
 *   `err instanceof ApiError` keeps working exactly as in 0.3.0.
 *
 * Every error exposes a stable lower-case `code`.
 */

import {
  BILLING_DENIED_REASONS,
  billingBlockMessage,
  isBillingTopupAllowed,
  type BillingCreateType,
} from "./billingHelpers.js";

/** Base class for SDK-originated errors that are not HTTP responses. */
export class IbeeError extends Error {
  /** Stable lower-case snake_case identifier. */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "IbeeError";
    this.code = code;
  }
}

/** Optional metadata attached to an ApiError when it is created. */
export interface ApiErrorInit {
  /** Response headers. */
  headers?: Headers | Record<string, string>;
  /** Idempotency key sent with the failed request, if any. */
  idempotencyKey?: string;
  /** Overrides the code parsed from the body. */
  code?: string;
  /** Overrides the reason parsed from the body. */
  reason?: string;
  /** Request path relative to the API base URL (used to label billing errors). */
  path?: string;
}

/** Fields extracted from any IBEE error body shape. */
export interface ParsedErrorBody {
  rawCode?: string;
  code: string;
  reason?: string;
  message?: string;
  details?: unknown;
  requiredScope?: string;
  billingSkuCode?: string;
  admissionContextId?: string;
}

const STATUS_DEFAULT_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  402: "payment_required",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "request_body_too_large",
  422: "validation_error",
  423: "locked",
  429: "rate_limited",
  500: "internal_error",
  502: "bad_gateway",
  503: "service_unavailable",
  504: "gateway_timeout",
};

/** Default `code` for a status when the body carries none. */
export function defaultCodeForStatus(status: number): string {
  return STATUS_DEFAULT_CODES[status] ?? `http_${status}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** Portal-style formatting of a FastAPI validation list. */
function formatValidationList(items: unknown[]): string | undefined {
  const messages = items
    .map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item) && typeof item.msg === "string") {
        const loc = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : undefined;
        return loc !== undefined && loc !== null && loc !== ""
          ? `${String(loc)}: ${item.msg}`
          : item.msg;
      }
      if (isRecord(item) && typeof item.message === "string") return item.message;
      return undefined;
    })
    .filter((m): m is string => Boolean(m));
  return messages.length ? messages.join(", ") : undefined;
}

/**
 * Parse any IBEE error body (edge, FastAPI detail string/object/list,
 * Secret Store `{error:{code,message,details}}`, plain strings).
 * First match wins.
 */
export function parseErrorBody(status: number, body: unknown): ParsedErrorBody {
  let rawCode: string | undefined;
  let reason: string | undefined;
  let message: string | undefined;
  let details: unknown;
  let requiredScope: string | undefined;
  let billingSkuCode: string | undefined;
  let admissionContextId: string | undefined;

  if (isRecord(body) && typeof body.error === "string") {
    // 1. Edge authorization response.
    rawCode = str(body.error);
    reason = str(body.billing_reason);
    requiredScope = str(body.required_scope);
    billingSkuCode = str(body.billing_sku_code);
    admissionContextId = str(body.admission_context_id);
    message = str(body.message);
  } else if (isRecord(body) && isRecord(body.error)) {
    // 2. Secret Store envelope.
    rawCode = str(body.error.code);
    message = str(body.error.message);
    details = body.error.details;
  } else if (isRecord(body) && isRecord(body.detail)) {
    // 3. FastAPI object detail.
    const detail = body.detail;
    rawCode = str(detail.code) ?? str(detail.error_code) ?? str(detail.error);
    message = str(detail.message);
    reason = str(detail.reason);
    details = detail;
  } else if (isRecord(body) && Array.isArray(body.detail)) {
    // 4. FastAPI validation list.
    rawCode = "validation_error";
    message = formatValidationList(body.detail);
    details = body.detail;
  } else if (isRecord(body) && typeof body.detail === "string") {
    // 5. FastAPI string detail.
    message = str(body.detail);
  } else if (isRecord(body)) {
    // 6. Top-level fields.
    rawCode = str(body.code);
    reason = str(body.reason);
    message = str(body.message);
  } else if (typeof body === "string") {
    // 7. Plain text.
    message = str(body);
  }

  const code = rawCode ? rawCode.trim().toLowerCase() : defaultCodeForStatus(status);
  return {
    rawCode,
    code,
    reason,
    message,
    details,
    requiredScope,
    billingSkuCode,
    admissionContextId,
  };
}

function headerGet(
  headers: Headers | Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Parse `retry-after-ms` / `Retry-After` into seconds (not clamped). */
export function parseRetryAfterSeconds(
  headers: Headers | Record<string, string> | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  const ms = headerGet(headers, "retry-after-ms");
  if (ms !== undefined && ms.trim() !== "") {
    const n = Number(ms);
    if (Number.isFinite(n)) return Math.max(0, n / 1000);
  }
  const ra = headerGet(headers, "retry-after");
  if (ra === undefined || ra.trim() === "") return undefined;
  const trimmed = ra.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Number(trimmed));
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, (date - nowMs) / 1000);
  return undefined;
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** Thrown when the API returns a non-2xx response. */
export class ApiError extends Error {
  readonly statusCode: number;
  /** Parsed JSON body, or the raw text when the body is not JSON. */
  readonly body: unknown;
  /** Stable lower-case code (e.g. `insufficient_scope`, `not_found`). */
  readonly code: string;
  /** Code exactly as the server sent it, when present. */
  readonly rawCode?: string;
  /** Billing or domain reason, when the server sent one. */
  readonly reason?: string;
  /** Scope the token is missing (edge 403 insufficient_scope). */
  readonly requiredScope?: string;
  /** SKU the edge evaluated for billing admission. */
  readonly billingSkuCode?: string;
  /** Edge billing admission context identifier (quote to support). */
  readonly admissionContextId?: string;
  /** Additional structured details from the body. */
  readonly details?: unknown;
  /** Response headers. */
  readonly headers?: Headers | Record<string, string>;
  /** `x-request-id` response header. */
  readonly requestId?: string;
  /** Server-requested retry delay in seconds, when present. */
  readonly retryAfterSeconds?: number;
  /** Idempotency key sent with the failed request (reuse it to retry safely). */
  idempotencyKey?: string;
  /**
   * True for 429/502/503/504, except deterministic billing admission
   * failures (`BILLING_ADMISSION_CODES`).
   */
  readonly retryable: boolean;
  /** Short suggestion for resolving the error, when the SDK has one. */
  hint?: string;

  constructor(statusCode: number, body: unknown, message?: string, init: ApiErrorInit = {}) {
    const parsed = parseErrorBody(statusCode, body);
    super(message ?? describe(statusCode, parsed));
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.body = body;
    this.code = (init.code ?? parsed.code).trim().toLowerCase();
    this.rawCode = parsed.rawCode;
    this.reason = init.reason ?? parsed.reason;
    this.requiredScope = parsed.requiredScope;
    this.billingSkuCode = parsed.billingSkuCode;
    this.admissionContextId = parsed.admissionContextId;
    this.details = parsed.details;
    this.headers = init.headers;
    this.requestId = headerGet(init.headers, "x-request-id");
    this.retryAfterSeconds = parseRetryAfterSeconds(init.headers);
    this.idempotencyKey = init.idempotencyKey;
    this.retryable = RETRYABLE_STATUSES.has(statusCode) && !BILLING_ADMISSION_CODES.has(this.code);
  }
}

function describe(status: number, parsed: ParsedErrorBody): string {
  if (parsed.message) return parsed.message;
  if (parsed.rawCode) {
    const scope = parsed.requiredScope ? ` (requires scope ${parsed.requiredScope})` : "";
    return `IBEE API error ${status}: ${parsed.code}${scope}`;
  }
  return `IBEE API error ${status}`;
}

// Status classes. Each is a real subclass so `instanceof` works.
export class BadRequestError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "BadRequestError"; }
}
export class InvalidWorkspaceError extends BadRequestError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "InvalidWorkspaceError"; }
}
export class UnauthorizedError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "UnauthorizedError"; }
}
export class PaymentRequiredError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "PaymentRequiredError"; }
}

/** Extra fields for a billing denial. */
export interface BillingDeniedInit extends ApiErrorInit {
  skuCode?: string;
  decision?: Record<string, unknown>;
  resourceType?: BillingCreateType | string;
}

/**
 * Billing did not approve a billable create (edge 402 `billing_denied` or a
 * `billing.requireResourceEligibility` preflight denial). The message is the
 * portal's wording for the denial reason.
 */
export class BillingDeniedError extends PaymentRequiredError {
  readonly skuCode?: string;
  /** Full eligibility decision (preflight only). */
  readonly decision?: Record<string, unknown>;
  /** True when adding wallet credits in the portal can resolve the denial. */
  readonly topupAllowed: boolean;
  readonly resourceType: string;

  constructor(statusCode: number, body: unknown, message?: string, init: BillingDeniedInit = {}) {
    const parsed = parseErrorBody(statusCode, body);
    const reason = init.reason ?? parsed.reason ?? str((init.decision ?? {}).reason);
    const resourceType = init.resourceType ?? "resource";
    const decisionLike = init.decision ?? { reason };
    super(
      statusCode,
      body,
      message ?? billingBlockMessage(decisionLike, resourceType),
      { ...init, code: init.code ?? "billing_denied", reason },
    );
    this.name = "BillingDeniedError";
    this.skuCode =
      init.skuCode ?? parsed.billingSkuCode ?? str((init.decision ?? {}).sku_code);
    this.decision = init.decision;
    this.topupAllowed = isBillingTopupAllowed(decisionLike);
    this.resourceType = resourceType;
  }
}

export class ForbiddenError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "ForbiddenError"; }
}
/** The token lacks the scope named in `requiredScope`. */
export class InsufficientScopeError extends ForbiddenError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "InsufficientScopeError"; }
}
/** The workspace does not belong to the token's organization/context. */
export class WorkspaceNotAllowedError extends ForbiddenError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "WorkspaceNotAllowedError"; }
}
/** The API key is revoked, disabled, inactive or expired. */
export class ApiKeyInactiveError extends ForbiddenError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "ApiKeyInactiveError"; }
}
/** The route is not available through the public API. */
export class RouteNotAvailableError extends ForbiddenError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "RouteNotAvailableError"; }
}
/** The organization's lifecycle state forbids this operation. */
export class OrganizationRestrictedError extends ForbiddenError {
  /** Organization state (e.g. `SUSPENDED`) when the server reports it. */
  readonly state?: string;
  /** Operation that was refused (e.g. `CREATE_RESOURCE`) when reported. */
  readonly operation?: string;
  constructor(...a: ConstructorParameters<typeof ApiError>) {
    super(...a);
    this.name = "OrganizationRestrictedError";
    const match = ORG_RESTRICTED_PATTERN.exec(this.message);
    if (match) {
      this.operation = match[1];
      this.state = match[2];
    }
  }
}
/** Secret Store refused a billable create for a billing reason (`reason`). */
export class BillingForbiddenError extends ForbiddenError {
  constructor(statusCode: number, body: unknown, message?: string, init: ApiErrorInit = {}) {
    const parsed = parseErrorBody(statusCode, body);
    super(statusCode, body, message, { ...init, reason: init.reason ?? parsed.message?.trim() });
    this.name = "BillingForbiddenError";
  }
}
export class NotFoundError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "NotFoundError"; }
}
export class ConflictError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "ConflictError"; }
}
/**
 * 409 from a resize whose precheck is not `in_place`
 * (`detail.decision` is `migration_required` or `blocked`).
 */
export class ResizeBlockedError extends ConflictError {
  readonly decision?: string;
  readonly reasons: string[];
  readonly warnings: string[];
  constructor(...a: ConstructorParameters<typeof ApiError>) {
    super(...a);
    this.name = "ResizeBlockedError";
    const d = isRecord(this.details) ? this.details : {};
    this.decision = str(d.decision);
    this.reasons = Array.isArray(d.reasons) ? d.reasons.map(String) : [];
    this.warnings = Array.isArray(d.warnings) ? d.warnings.map(String) : [];
  }
}
export class PayloadTooLargeError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "PayloadTooLargeError"; }
}
export class UnprocessableEntityError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "UnprocessableEntityError"; }
}
/** 423: organization suspended by billing. */
export class OrganizationSuspendedError extends ApiError {
  readonly billingState?: string;
  readonly serviceEnforcementState?: string;
  readonly allowedOperations?: string[];
  constructor(...a: ConstructorParameters<typeof ApiError>) {
    super(...a);
    this.name = "OrganizationSuspendedError";
    const d = isRecord(this.details) ? this.details : {};
    this.billingState = str(d.billing_state);
    this.serviceEnforcementState = str(d.service_enforcement_state);
    this.allowedOperations = Array.isArray(d.allowed_operations)
      ? d.allowed_operations.map(String)
      : undefined;
  }
}
export class TooManyRequestsError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "TooManyRequestsError"; }
}
export class InternalServerError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "InternalServerError"; }
}
export class BadGatewayError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "BadGatewayError"; }
}
/** The edge (or the SDK preflight) could not obtain a valid billing decision. */
export class BillingAdmissionError extends BadGatewayError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "BillingAdmissionError"; }
}
export class ServiceUnavailableError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "ServiceUnavailableError"; }
}
export class GatewayTimeoutError extends ApiError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "GatewayTimeoutError"; }
}

// ------------------------------------------------------------ Secret Store

/**
 * Secret Store refused an operation because of the organization's lifecycle
 * state (`restricted`, `suspended`, `deleting` or `deleted`). The service
 * reports this as 403 FORBIDDEN with a message; `state` and `operation`
 * are parsed from it.
 */
export class OrganizationLifecycleError extends OrganizationRestrictedError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "OrganizationLifecycleError"; }
}

const SECRET_RESOURCE_PATTERN =
  /^(Store|Secret|Identity|Scope) '([^']+)' does not belong to workspace '([^']*)'$/;

/**
 * The store, secret, identity or scope does not exist in this workspace.
 * Secret Store answers 403 (not 404) for missing and foreign resources, so
 * this is a `ForbiddenError` (and `WorkspaceNotAllowedError`) subclass.
 */
export class ResourceNotFoundError extends WorkspaceNotAllowedError {
  /** `store`, `secret`, `identity` or `scope`. */
  readonly kind?: string;
  readonly resourceId?: string;
  readonly workspaceId?: string;
  constructor(...a: ConstructorParameters<typeof ApiError>) {
    super(...a);
    this.name = "ResourceNotFoundError";
    this.hint = "it does not exist or belongs to another workspace";
    const match = SECRET_RESOURCE_PATTERN.exec(this.message);
    if (match) {
      this.kind = match[1].toLowerCase();
      this.resourceId = match[2];
      this.workspaceId = match[3];
    }
  }
}
/** The store is archived or being deleted, so identities and scopes cannot use it. */
export class StoreNotActiveError extends ForbiddenError {
  constructor(...a: ConstructorParameters<typeof ApiError>) {
    super(...a);
    this.name = "StoreNotActiveError";
    this.hint = "restore (unarchive) the store first";
  }
}
/** The application identity is disabled; enable it first. */
export class IdentityDisabledError extends ForbiddenError {
  constructor(...a: ConstructorParameters<typeof ApiError>) {
    super(...a);
    this.name = "IdentityDisabledError";
    this.hint = "enable the identity first";
  }
}
/** The operation needs a different auth method (secret-ID rotation is AppRole only). */
export class AuthMethodMismatchError extends ForbiddenError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "AuthMethodMismatchError"; }
}
/** A read-only identity cannot be granted write, rollback or destroy permissions. */
export class ScopePermissionError extends ForbiddenError {
  constructor(...a: ConstructorParameters<typeof ApiError>) {
    super(...a);
    this.name = "ScopePermissionError";
    this.hint = "change the identity's token_policy_mode to read_write first";
  }
}
/** 409 STORE_ARCHIVED: unarchive the store first. */
export class StoreArchivedError extends ConflictError {
  constructor(...a: ConstructorParameters<typeof ApiError>) {
    super(...a);
    this.name = "StoreArchivedError";
    this.hint = "unarchive the store first";
  }
}
/** 409 STORE_DELETING: the store is being permanently deleted. */
export class StoreDeletingError extends ConflictError {
  constructor(...a: ConstructorParameters<typeof ApiError>) { super(...a); this.name = "StoreDeletingError"; }
}
/**
 * A secret value write with `cas` failed. Secret Store reports every
 * backing-store failure, including a check-and-set mismatch, as 502; when
 * `cas` was sent the most likely cause is that the current version differs.
 */
export class CasConflictError extends BadGatewayError {
  constructor(...a: ConstructorParameters<typeof ApiError>) {
    super(...a);
    this.name = "CasConflictError";
    this.hint = "the current version differs from cas";
  }
}

/** Hint for `SecretValueNotFoundError`. */
const SECRET_VALUE_NOT_FOUND_HINT =
  "the latest version may be soft-deleted or destroyed; undelete it or write a new value";

/**
 * 404 reading a secret value or one version: that version is soft-deleted,
 * destroyed or does not exist. A `NotFoundError` subclass.
 */
export class SecretValueNotFoundError extends NotFoundError {
  constructor(...a: ConstructorParameters<typeof ApiError>) {
    super(...a);
    this.name = "SecretValueNotFoundError";
    this.hint = SECRET_VALUE_NOT_FOUND_HINT;
  }
}

/** Hint for `ScopeValidationError`. */
const SCOPE_VALIDATION_HINT = "send accessMode 'read_write' or clear allowRollback/allowDestroy";

/**
 * 422 "Read-only scopes cannot grant rollback or destroy permissions": the
 * updated scope would be `read_only` with rollback or destroy allowed. An
 * `UnprocessableEntityError` subclass.
 */
export class ScopeValidationError extends UnprocessableEntityError {
  constructor(...a: ConstructorParameters<typeof ApiError>) {
    super(...a);
    this.name = "ScopeValidationError";
    this.hint = SCOPE_VALIDATION_HINT;
  }
}
/**
 * 503 LIFECYCLE_OPERATION_INCOMPLETE: a permanent store delete did not
 * finish. The store stays in `deleting`; repeating the same call is safe.
 */
export class DeletionIncompleteError extends ServiceUnavailableError {
  readonly failedSteps: string[];
  readonly storeId?: string;
  constructor(...a: ConstructorParameters<typeof ApiError>) {
    super(...a);
    this.name = "DeletionIncompleteError";
    const d = isRecord(this.details) ? this.details : {};
    this.failedSteps = Array.isArray(d.failed_steps) ? d.failed_steps.map(String) : [];
    this.storeId = str(d.store_id);
    this.hint = "repeat the same call to finish the deletion";
  }
}

/** True for a request path under `/secret-store/`. */
function isSecretStoreErrorPath(path: string | undefined): boolean {
  return /^\/?(v1\/)?secret-store(\/|$)/.test(String(path ?? ""));
}

/**
 * Secret Store specific mapping, or `undefined` to fall back to the generic
 * mapping. Handles the service envelope `{error:{code,message,details}}`.
 */
function secretStoreErrorFromResponse(
  statusCode: number,
  body: unknown,
  init: ApiErrorInit,
): ApiError | undefined {
  const parsed = parseErrorBody(statusCode, body);
  const message = (parsed.message ?? "").trim();
  const rawCode = String(parsed.rawCode ?? "").toUpperCase();
  const path = String(init.path ?? "").split("?")[0];
  switch (statusCode) {
    case 403:
      if (parsed.code === "insufficient_scope" || parsed.code === "workspace_not_allowed") return undefined;
      if (ORG_RESTRICTED_PATTERN.test(message)) {
        return new OrganizationLifecycleError(statusCode, body, undefined, init);
      }
      if (SECRET_RESOURCE_PATTERN.test(message)) {
        return new ResourceNotFoundError(statusCode, body, undefined, init);
      }
      if (/^Store '.+' is not active$/.test(message)) {
        return new StoreNotActiveError(statusCode, body, undefined, init);
      }
      if (message === "Identity is disabled") {
        return new IdentityDisabledError(statusCode, body, undefined, init);
      }
      if (message === "rotate-secret-id is only available for AppRole identities") {
        return new AuthMethodMismatchError(statusCode, body, undefined, init);
      }
      if (/^Read-only identities cannot be granted/.test(message)) {
        return new ScopePermissionError(statusCode, body, undefined, init);
      }
      return undefined;
    case 404:
      if (/\/secret-store\/secrets\/[^/]+\/(value|versions\/[^/]+)\/?$/.test(path)) {
        return new SecretValueNotFoundError(
          statusCode,
          body,
          `${message || "Secret value not found"} (${SECRET_VALUE_NOT_FOUND_HINT})`,
          init,
        );
      }
      return undefined;
    case 422:
      if (message.startsWith("Read-only scopes cannot grant")) {
        return new ScopeValidationError(statusCode, body, `${message} (${SCOPE_VALIDATION_HINT})`, init);
      }
      return undefined;
    case 409:
      if (rawCode === "STORE_ARCHIVED") return new StoreArchivedError(statusCode, body, undefined, init);
      if (rawCode === "STORE_DELETING") return new StoreDeletingError(statusCode, body, undefined, init);
      return undefined;
    case 503:
      if (rawCode === "LIFECYCLE_OPERATION_INCOMPLETE") {
        return new DeletionIncompleteError(statusCode, body, undefined, init);
      }
      return undefined;
    default:
      return undefined;
  }
}

const ORG_RESTRICTED_PATTERN =
  /^Operation '([A-Z_]+)' is not allowed while organization is ([A-Za-z_]+)$/;
const STORAGE_RESTRICTED_MESSAGES = new Set([
  "Storage namespace changes are restricted",
  "Storage namespace is not active",
]);
const WORKSPACE_MISMATCH = /does not match API token context|does not belong to workspace/i;
const INACTIVE_KEY_CODES = new Set(["key_revoked", "key_disabled", "key_inactive", "key_expired"]);
/**
 * 502 codes for a deterministic billing admission failure (no usable
 * decision, catalog or plan). Retrying cannot fix them, so they are never
 * retried and `retryable` is false.
 */
export const BILLING_ADMISSION_CODES: ReadonlySet<string> = new Set([
  "billing_admission_error",
  "invalid_billing_decision",
  "compute_catalog_error",
  "invalid_compute_catalog_response",
  "ambiguous_compute_plan",
  "unpriced_compute_plan",
  "product_catalog_error",
  "invalid_product_catalog_response",
  "block_storage_plan_unavailable",
  "ambiguous_block_storage_plan",
]);

/** Best-effort billing create type for a billable create path. */
export function createTypeForPath(path: string | undefined): BillingCreateType | "resource" {
  const p = String(path ?? "").replace(/^\/?(v1\/)?/, "/").split("?")[0];
  if (/^\/compute\/gpu-vms\/?$/.test(p)) return "gpu_vm";
  if (/^\/compute\/cloud-vms\/?$/.test(p)) return "vm";
  if (/^\/block-storage\/volumes\/?$/.test(p)) return "block_storage";
  if (/^\/object-storage\/buckets\/?$/.test(p)) return "object_storage";
  if (/^\/object-storage\/credentials\/?$/.test(p)) return "s3_credential";
  if (/^\/networking\/load-balancers\//.test(p)) return "load_balancer";
  if (/^\/networking\/reserved-ips(\/convert)?\/?$/.test(p)) return "reserved_ip";
  if (/^\/networking\/vpcs\/[^/]+\/nat-gateways\/?$/.test(p)) return "nat_gateway";
  if (/^\/cdn\/distributions\/[^/]+\/custom-domains\/?$/.test(p)) return "custom_domain";
  if (/^\/cdn\/distributions\/?$/.test(p)) return "cdn";
  if (/^\/secret-store\/stores\/[^/]+\/secrets\/?$/.test(p)) return "secret";
  if (/^\/secret-store\/stores\/?$/.test(p)) return "secret_store";
  return "resource";
}

/**
 * Build the typed error for an HTTP error response. All shapes returned by the
 * public API (edge, product services) are recognised.
 */
export function apiErrorFromResponse(
  statusCode: number,
  body: unknown,
  init: ApiErrorInit = {},
): ApiError {
  if (isSecretStoreErrorPath(init.path)) {
    const mapped = secretStoreErrorFromResponse(statusCode, body, init);
    if (mapped) return mapped;
  }
  const parsed = parseErrorBody(statusCode, body);
  const code = parsed.code;
  const message = parsed.message ?? "";
  switch (statusCode) {
    case 400:
      return code === "workspace_id_required" || code === "invalid_workspace_id"
        ? new InvalidWorkspaceError(statusCode, body, undefined, init)
        : new BadRequestError(statusCode, body, undefined, init);
    case 401:
      return new UnauthorizedError(statusCode, body, undefined, init);
    case 402:
      if (code === "billing_denied") {
        return new BillingDeniedError(statusCode, body, undefined, {
          ...init,
          resourceType: createTypeForPath(init.path),
        });
      }
      return new PaymentRequiredError(statusCode, body, undefined, init);
    case 403:
      if (code === "insufficient_scope") return new InsufficientScopeError(statusCode, body, undefined, init);
      if (code === "workspace_not_allowed" || WORKSPACE_MISMATCH.test(message)) {
        return new WorkspaceNotAllowedError(statusCode, body, undefined, init);
      }
      if (INACTIVE_KEY_CODES.has(code)) return new ApiKeyInactiveError(statusCode, body, undefined, init);
      if (code === "unknown_route") return new RouteNotAvailableError(statusCode, body, undefined, init);
      if (
        code === "organization_restricted" ||
        ORG_RESTRICTED_PATTERN.test(message) ||
        STORAGE_RESTRICTED_MESSAGES.has(message.trim())
      ) {
        return new OrganizationRestrictedError(statusCode, body, undefined, init);
      }
      if (code === "forbidden" && BILLING_DENIED_REASONS.has(message.trim().toLowerCase())) {
        return new BillingForbiddenError(statusCode, body, undefined, init);
      }
      return new ForbiddenError(statusCode, body, undefined, init);
    case 404:
      return new NotFoundError(statusCode, body, undefined, init);
    case 409:
      if (isRecord(parsed.details) && typeof parsed.details.decision === "string") {
        return new ResizeBlockedError(statusCode, body, undefined, init);
      }
      return new ConflictError(statusCode, body, undefined, init);
    case 413:
      return new PayloadTooLargeError(statusCode, body, undefined, init);
    case 422:
      return new UnprocessableEntityError(statusCode, body, undefined, init);
    case 423:
      return new OrganizationSuspendedError(statusCode, body, undefined, init);
    case 429:
      return new TooManyRequestsError(statusCode, body, undefined, init);
    case 500:
      return new InternalServerError(statusCode, body, undefined, init);
    case 502:
      return BILLING_ADMISSION_CODES.has(code)
        ? new BillingAdmissionError(statusCode, body, undefined, init)
        : new BadGatewayError(statusCode, body, undefined, init);
    case 503:
      return new ServiceUnavailableError(statusCode, body, undefined, init);
    case 504:
      return new GatewayTimeoutError(statusCode, body, undefined, init);
    default:
      return new ApiError(statusCode, body, undefined, init);
  }
}

/**
 * True when an error means the create was blocked for payment reasons
 * (billing denial, insufficient balance, no payment method).
 */
export function isPaymentBlockError(err: unknown): boolean {
  if (err instanceof BillingDeniedError || err instanceof BillingForbiddenError) return true;
  if (!err || typeof err !== "object") return false;
  const e = err as { statusCode?: unknown; status?: unknown; code?: unknown; message?: unknown };
  if (e.statusCode === 402 || e.status === 402) return true;
  const code = String(e.code ?? "").trim().toLowerCase();
  if (code === "billing_denied" || code === "insufficient_balance" || code === "insufficient_funds") {
    return true;
  }
  // A missing scope is a permission problem, never a payment wall (its
  // SDK-built message mentions "insufficient_scope").
  if (err instanceof InsufficientScopeError || code === "insufficient_scope") return false;
  // For API errors only the server's own message is inspected, not the
  // SDK's fallback text built from the status and code.
  const msg = (
    err instanceof ApiError ? parseErrorBody(err.statusCode, err.body).message ?? "" : String(e.message ?? "")
  ).toLowerCase();
  return (
    msg.includes("insufficient") ||
    msg.includes("payment required") ||
    msg.includes("add a payment method") ||
    msg.includes("top up")
  );
}

/** Metadata about an async compute operation carried by wait errors. */
export interface OperationLike {
  operation_id?: string;
  vm_id?: string;
  status?: string;
  error_code?: string | null;
  error_message?: string | null;
  [key: string]: unknown;
}

/** An async operation reached `failed`, `cancelled` or `timed_out`. */
export class OperationFailedError extends IbeeError {
  readonly operationId?: string;
  readonly vmId?: string;
  readonly status: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  /** Last operation status returned by the API. */
  readonly operation: OperationLike;

  constructor(operation: OperationLike, operationId?: string) {
    const status = String(operation?.status ?? "failed");
    const id = operation?.operation_id ?? operationId;
    const detail = [operation?.error_code, operation?.error_message].filter(Boolean).join(": ");
    super(
      `Operation ${id ?? ""} ended with status ${status}${detail ? `: ${detail}` : ""}`.replace(/\s+/g, " "),
      "operation_failed",
    );
    this.name = "OperationFailedError";
    this.operationId = id;
    this.vmId = operation?.vm_id;
    this.status = status;
    this.errorCode = operation?.error_code ?? undefined;
    this.errorMessage = operation?.error_message ?? undefined;
    this.operation = operation;
  }
}

/**
 * The client-side wait deadline passed while the operation was still running.
 * Distinct from the backend's own `timed_out` status. The operation may still
 * complete; resume waiting with `operations.wait`.
 */
export class OperationTimeoutError extends IbeeError {
  readonly operationId: string;
  readonly lastStatus?: string;
  readonly timeoutMs: number;
  readonly operation?: OperationLike;

  constructor(operationId: string, timeoutMs: number, operation?: OperationLike) {
    const lastStatus = operation?.status !== undefined ? String(operation.status) : undefined;
    super(
      `Operation ${operationId} still ${lastStatus ?? "pending"} after ${Math.round(timeoutMs / 1000)}s`,
      "operation_wait_timeout",
    );
    this.name = "OperationTimeoutError";
    this.operationId = operationId;
    this.lastStatus = lastStatus;
    this.timeoutMs = timeoutMs;
    this.operation = operation;
  }
}


/** A snapshot, backup run or restore finished as `failed` or `cancelled`. */
export class RecoveryFailedError extends IbeeError {
  /** `snapshot`, `backup_run` or `restore`. */
  readonly kind: string;
  readonly resourceId?: string;
  readonly status: string;
  readonly errorMessage?: string;
  /** Last value returned by the API. */
  readonly resource: Record<string, unknown>;

  constructor(kind: string, resource: Record<string, unknown>, resourceId?: string) {
    const status = String(resource?.status ?? "failed");
    const detail = typeof resource?.error_message === "string" ? resource.error_message : undefined;
    super(
      `${kind.replace(/_/g, " ")} ${resourceId ?? ""} ended with status ${status}${detail ? `: ${detail}` : ""}`
        .replace(/\s+/g, " ")
        .trim(),
      "recovery_failed",
    );
    this.name = "RecoveryFailedError";
    this.kind = kind;
    this.resourceId = resourceId;
    this.status = status;
    this.errorMessage = detail;
    this.resource = resource;
  }
}

/** A snapshot or backup restore finished as `failed` or `cancelled`. */
export class RecoveryRestoreFailedError extends RecoveryFailedError {
  constructor(resource: Record<string, unknown>, restoreId?: string) {
    super("restore", resource, restoreId);
    this.name = "RecoveryRestoreFailedError";
  }
}

/**
 * A CDN cache purge was accepted (HTTP 200) but the CDN reported
 * `success: false` (common for tag and prefix purges on plans without them).
 * Nothing was purged; `mode` and `body` carry the API result.
 */
export class IbeeCdnPurgeError extends ApiError {
  readonly mode?: string;
  constructor(body: Record<string, unknown>) {
    const message = typeof body?.message === "string" && body.message.trim() ? body.message : "Cache purge failed";
    super(200, body, message, { code: "cdn_purge_failed" });
    this.name = "IbeeCdnPurgeError";
    this.mode = typeof body?.mode === "string" ? body.mode : undefined;
  }
}
/** Python SDK name for `IbeeCdnPurgeError`. */
export const CdnPurgeFailedError = IbeeCdnPurgeError;
/** Python SDK name for `IbeeCdnPurgeError` (type). */
export type CdnPurgeFailedError = IbeeCdnPurgeError;

/** A CDN custom domain was still pending when the client-side wait ended. */
export class CdnDomainVerificationTimeoutError extends IbeeError {
  readonly domain: string;
  readonly lastStatus?: string;
  readonly timeoutMs: number;
  /** Last verification result. */
  readonly result?: Record<string, unknown>;
  constructor(domain: string, timeoutMs: number, result?: Record<string, unknown>) {
    const lastStatus = typeof result?.status === "string" ? result.status : undefined;
    const detail = typeof result?.message === "string" && result.message ? ` ${result.message}` : "";
    super(
      `Custom domain ${domain} is still ${lastStatus ?? "pending"} after ${Math.round(timeoutMs / 1000)}s.${detail}`,
      "cdn_domain_wait_timeout",
    );
    this.name = "CdnDomainVerificationTimeoutError";
    this.domain = domain;
    this.lastStatus = lastStatus;
    this.timeoutMs = timeoutMs;
    this.result = result;
  }
}
