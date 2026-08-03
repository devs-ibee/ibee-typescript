import type { HttpClient } from "../core.js";
import type {
  BillingEligibility,
  BillingEligibilityRequest,
} from "../types.js";

/** Explicit billing admission checks shared by every billable product. */
export class BillingResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Check whether the workspace may create a billable resource.
   *
   * This method never runs implicitly. Call it immediately before a billable
   * create request, then treat the product service's own admission decision as
   * authoritative because billing state can change between requests.
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
}
