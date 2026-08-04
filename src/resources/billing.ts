import type { HttpClient } from "../core.js";
import type {
  BillingEligibility,
  BillingEligibilityRequest,
} from "../types.js";

/** Point-in-time billing checks for planned billable resource creation. */
export class BillingResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Check whether the workspace is currently eligible to create a billable
   * resource. This preflight does not reserve funds or create the resource.
   */
  checkResourceEligibility(args: {
    workspaceId: string;
    skuCode?: string;
    estimatedCostMinor?: number;
  }): Promise<BillingEligibility> {
    const body: BillingEligibilityRequest = {
      sku_code: args.skuCode,
      estimated_cost_minor: args.estimatedCostMinor,
    };

    return this.http.request({
      method: "POST",
      path: "/billing/resource-eligibility",
      workspaceId: args.workspaceId,
      body,
    });
  }
}
