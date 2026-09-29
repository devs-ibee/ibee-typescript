/**
 * Billing admission helpers shared by the billing preflight and the error
 * classes. Messages and rules match the IBEE portal.
 */

/** Resource kinds the portal labels in billing messages. */
export type BillingCreateType =
  | "vm"
  | "gpu_vm"
  | "block_storage"
  | "object_storage"
  | "s3_credential"
  | "container_registry"
  | "load_balancer"
  | "cdn"
  | "custom_domain"
  | "secret_store"
  | "secret"
  | "snapshot"
  | "backup"
  | "reserved_ip"
  | "nat_gateway";

/** Human labels used in billing messages. Unknown types read "resource". */
export const CREATE_TYPE_LABELS: Readonly<Record<BillingCreateType, string>> = Object.freeze({
  vm: "cloud VM",
  gpu_vm: "GPU VM",
  block_storage: "block storage volume",
  object_storage: "object storage bucket",
  s3_credential: "S3 credential",
  load_balancer: "load balancer",
  cdn: "CDN distribution",
  custom_domain: "custom domain",
  secret_store: "secret store",
  secret: "secret",
  snapshot: "snapshot",
  backup: "backup policy",
  reserved_ip: "Reserved IP",
  nat_gateway: "NAT gateway",
  container_registry: "container registry",
});

/** @deprecated Unknown: only upstream can supply a minimum. */
export const INR_MINIMUM_TOPUP_MINOR = null;

/** @deprecated Currency alone cannot establish a minimum; returns unknown. */
export function minimumTopupMinor(currency: string | null | undefined): number | null {
  return null;
}

/** Billing reasons that deny a create. Manual admin reason codes may also appear. */
export const BILLING_DENIED_REASONS: ReadonlySet<string> = new Set([
  "initial_topup_required",
  "insufficient_balance",
  "credit_limit_exceeded",
  "unknown_sku",
  "inactive_sku",
  "billing_limit_exhausted",
  "overage_cap_exceeded",
  "dunning_active",
  "dunning_grace_expired",
]);

/** Anything that looks like a billing decision, or a bare reason string. */
export type BillingDecisionLike =
  | string
  | null
  | undefined
  | {
      reason?: unknown;
      can_create_reason?: unknown;
      billing_state?: unknown;
      currency?: unknown;
      allowed_operations?: unknown;
      [key: string]: unknown;
    };

function field(decision: BillingDecisionLike, key: string): unknown {
  return decision && typeof decision === "object" ? decision[key] : undefined;
}

/**
 * True only when upstream explicitly lists the billing_topup operation.
 */
export function isBillingTopupAllowed(decision: BillingDecisionLike): boolean {
  const ops = field(decision, "allowed_operations");
  return Array.isArray(ops) && ops.some(operation => typeof operation === "string" && operation === "billing_topup");
}

/**
 * Portal wording for a billing denial.
 *
 * @param decision   The eligibility decision, or just the reason string.
 * @param createType Resource kind being created (default "resource").
 */
export function billingBlockMessage(
  decision: BillingDecisionLike,
  createType: BillingCreateType | string = "resource",
  options: { billingState?: string | null; currency?: string | null } = {},
): string {
  const reason = (
    typeof decision === "string"
      ? decision
      : String(field(decision, "can_create_reason") || field(decision, "reason") || "")
  ).trim();
  const state = String(options.billingState ?? field(decision, "billing_state") ?? "").trim().toUpperCase();
  const label =
    (CREATE_TYPE_LABELS as Record<string, string>)[String(createType ?? "").trim().toLowerCase()] ?? "resource";
  const guidance = isBillingTopupAllowed(decision)
    ? "You can add credits in the IBEE portal."
    : "Review billing for available actions.";

  if (reason === "initial_topup_required") {
    return `Billing requires an initial wallet top-up before creating your first ${label}. ${guidance}`;
  }
  if (reason === "insufficient_balance") {
    return `Your available wallet balance does not cover this ${label}. ${guidance}`;
  }
  if (reason === "credit_limit_exceeded") {
    return `Creating this ${label} would exceed this organization's credit limit.`;
  }
  if (reason === "billing_limit_exhausted" || state === "PAST_DUE") {
    return `Billing needs attention before creating a ${label}. ${guidance}`;
  }
  if (reason === "overage_cap_exceeded" || state === "HARD_SUSPENDED") {
    return `This organization is billing-suspended, so new ${label} creation is blocked. Please resolve billing before trying again.`;
  }
  if (reason === "dunning_active" || reason === "dunning_grace_expired") {
    return `An overdue billing case must be resolved before creating this ${label}.`;
  }
  if (reason === "unknown_sku") {
    return `Pricing for this ${label} could not be verified. Check the plan or SKU and try again.`;
  }
  return `Billing did not approve creating this ${label}. Please review billing and try again.`;
}

/** Hours used to turn an hourly rate into the admission estimate. */
export const HOURLY_BILLING_PERIOD_HOURS = 731;

/**
 * @deprecated Legacy arithmetic only; never use this as an admission decision.
 * Historical amount (minor units), computed the way the
 * portal does: hourly rates are multiplied by 731 hours; MONTHLY and YEARLY
 * use the full period price.
 */
export function estimateEligibilityCostMinor(
  billingInterval: "HOURLY" | "MONTHLY" | "YEARLY" | (string & {}),
  unitPriceMinor: number,
  count = 1,
  hourlyPeriodHours = HOURLY_BILLING_PERIOD_HOURS,
): number {
  const rate = Number.isFinite(unitPriceMinor) ? Math.max(0, unitPriceMinor) : 0;
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const hours = Number.isFinite(hourlyPeriodHours)
    ? Math.max(0, hourlyPeriodHours)
    : HOURLY_BILLING_PERIOD_HOURS;
  const period = String(billingInterval).toUpperCase() === "HOURLY" ? rate * hours : rate;
  return Math.round(period * n);
}
