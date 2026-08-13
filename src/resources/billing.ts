import type { HttpClient } from "../core.js";
import { ApiError } from "../errors.js";
import type {
  BillingEligibility,
  BillingEligibilityRequest,
} from "../types.js";

/** Optional billing-admission preview for applications that need it. */
export class BillingResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Check whether the workspace may create a billable resource.
   *
   * Call this directly when an application needs to display admission state.
   * Product creates make one request. The public edge performs authoritative
   * billing admission before it forwards that request to the product service.
   */
  checkResourceEligibility(args: {
    workspaceId: string;
    skuCode?: string;
    estimatedCostMinor?: number;
  }): Promise<BillingEligibility> {
    const body: BillingEligibilityRequest = {
      ...(args.skuCode === undefined ? {} : { sku_code: args.skuCode }),
      ...(args.estimatedCostMinor === undefined
        ? {}
        : { estimated_cost_minor: args.estimatedCostMinor }),
    };
    return this.http.request({
      method: "POST",
      path: "/billing/resource-eligibility",
      workspaceId: args.workspaceId,
      body,
    });
  }

  /**
   * Require a positive, well-formed billing decision before provisioning.
   *
   * This opt-in helper is useful for form previews. It does not reserve funds
   * or replace the authoritative edge admission performed during create.
   */
  async requireResourceEligibility(args: {
    workspaceId: string;
    skuCode?: string;
    estimatedCostMinor?: number;
  }): Promise<BillingEligibility> {
    const decision = await this.checkResourceEligibility(args);
    if (!decision || typeof decision !== "object" || typeof decision.allowed !== "boolean") {
      throw new ApiError(502, decision, "Billing eligibility returned an invalid response");
    }
    if (!decision.allowed) {
      throw new ApiError(
        402,
        {
          error: {
            code: "BILLING_CREATE_BLOCKED",
            message: decision.reason || "Billing eligibility denied resource creation",
            details: decision,
          },
        },
        decision.reason || "Billing eligibility denied resource creation",
      );
    }
    if (
      !decision.organization_id ||
      typeof decision.organization_id !== "string" ||
      !decision.reason ||
      typeof decision.reason !== "string"
    ) {
      throw new ApiError(502, decision, "Billing eligibility response is incomplete");
    }
    if (args.skuCode !== undefined && decision.sku_code !== args.skuCode) {
      throw new ApiError(502, decision, "Billing eligibility did not confirm the requested SKU");
    }
    return decision;
  }
}
