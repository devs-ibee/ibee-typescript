import type { HttpClient } from "../core.js";
import { BillingAdmissionError, BillingDeniedError } from "../errors.js";
import { billingBlockMessage, type BillingCreateType } from "../billingHelpers.js";
import {
  normaliseEligibilityOperation,
  normaliseEstimatedCostMinor,
  normaliseSkuCode,
  validateWorkspaceId,
} from "../validation.js";
import type {
  BillingEligibility,
  BillingEligibilityRequest,
  EnforcementOperation,
} from "../types.js";

export interface CheckResourceEligibilityArgs {
  workspaceId: string;
  /** Plan SKU (the plan's `billing_catalog.sku_code`). Trimmed; blank is omitted; max 64. */
  skuCode?: string;
  /**
   * Estimated cost in minor units (>= 0). Non-integers are rounded. Compute
   * it with `estimateEligibilityCostMinor`.
   */
  estimatedCostMinor?: number;
  /**
   * Billing operation to evaluate (default CREATE_RESOURCE; case-insensitive).
   * Not yet part of the published API contract; behaviour may change.
   */
  operation?: EnforcementOperation | (string & {});
}

export interface RequireResourceEligibilityArgs extends CheckResourceEligibilityArgs {
  /** Resource kind used to word the denial message (not sent). */
  resourceType?: BillingCreateType | (string & {});
}

/** SKU the edge admits NAT gateway creates against. */
export const NAT_GATEWAY_SKU_CODE = "NAT-GATEWAY";
/** SKU for Reserved IPs (reserve, convert, reserve-on-NAT-delete). */
export const RESERVED_IP_SKU_CODE = "RESERVED-IP";
/** SKU the edge admits L4/L7 load-balancer creates against. */
export const LOAD_BALANCER_SKU_CODE = "LOADBALA-STD";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Optional billing-admission preview for applications that need it. */
export class BillingResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Check whether the workspace may create a billable resource.
   *
   * Returns the decision without throwing when `allowed` is false. Product
   * creates still make one request; the public edge performs the
   * authoritative billing admission before forwarding a create.
   */
  async checkResourceEligibility(args: CheckResourceEligibilityArgs): Promise<BillingEligibility> {
    validateWorkspaceId(args.workspaceId);
    const skuCode = normaliseSkuCode(args.skuCode);
    const estimatedCostMinor = normaliseEstimatedCostMinor(args.estimatedCostMinor);
    const operation = normaliseEligibilityOperation(args.operation);
    const body: BillingEligibilityRequest = {
      ...(skuCode === undefined ? {} : { sku_code: skuCode }),
      ...(estimatedCostMinor === undefined ? {} : { estimated_cost_minor: estimatedCostMinor }),
      ...(operation === undefined ? {} : { operation: operation as EnforcementOperation }),
    };
    return this.http.request({
      method: "POST",
      path: "/billing/resource-eligibility",
      workspaceId: args.workspaceId,
      body,
    });
  }

  /**
   * Require an affirmative billing decision before a billable create (the
   * portal's preflight). Continues only when `allowed` is exactly `true`.
   *
   * @throws BillingDeniedError (402, code `billing_denied`) with the portal's
   *   message and `topupAllowed` when billing does not approve.
   * @throws BillingAdmissionError (502, code `invalid_billing_decision`) when
   *   the decision is malformed or does not confirm the requested SKU.
   *
   * The preflight does not reserve funds; the edge repeats admission on the
   * real create and is authoritative.
   */
  async requireResourceEligibility(
    args: RequireResourceEligibilityArgs,
  ): Promise<BillingEligibility> {
    const { resourceType, ...checkArgs } = args;
    const decision = await this.checkResourceEligibility(checkArgs);
    const invalid = (message: string) =>
      new BillingAdmissionError(502, decision, message, { code: "invalid_billing_decision" });

    if (
      !isRecord(decision) ||
      typeof decision.allowed !== "boolean" ||
      typeof decision.organization_id !== "string" ||
      !decision.organization_id ||
      typeof decision.reason !== "string" ||
      !decision.reason
    ) {
      throw invalid("Billing eligibility returned an invalid response");
    }
    if (decision.allowed !== true) {
      throw new BillingDeniedError(
        402,
        decision,
        billingBlockMessage(decision, resourceType ?? "resource"),
        {
          code: "billing_denied",
          reason: decision.reason,
          skuCode: decision.sku_code ?? undefined,
          decision,
          resourceType: resourceType ?? "resource",
        },
      );
    }
    const requested = normaliseSkuCode(args.skuCode);
    if (
      requested !== undefined &&
      String(decision.sku_code ?? "").trim().toUpperCase() !== requested.toUpperCase()
    ) {
      throw invalid("Billing eligibility did not confirm the requested SKU");
    }
    return decision;
  }
}
