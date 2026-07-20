import type { HttpClient } from "../core.js";

/**
 * Compute catalog — read-only discovery of where VMs can run, which plans are
 * billable, and which OS images are available. Use the returned IDs with
 * `cloudVms.create` / `gpuVms.create` (`plan_id`, `template_id`, placement).
 */
export class ComputeCatalogResource {
  constructor(private readonly http: HttpClient) {}

  /** Sites where cloud and GPU VMs can be placed. */
  listSites(args: {
    workspaceId: string;
    regionId?: string;
    countryId?: string;
  }): Promise<unknown> {
    return this.http.request({
      method: "GET",
      path: "/compute/sites",
      workspaceId: args.workspaceId,
      query: { region_id: args.regionId, country_id: args.countryId },
    });
  }

  /** Billable plans for cloud or GPU VMs. */
  listPlans(args: {
    workspaceId: string;
    vmType?: string;
    siteId?: string;
    currency?: string;
    billingInterval?: string;
  }): Promise<unknown> {
    return this.http.request({
      method: "GET",
      path: "/compute/plans",
      workspaceId: args.workspaceId,
      query: {
        vm_type: args.vmType,
        site_id: args.siteId,
        currency: args.currency,
        billing_interval: args.billingInterval,
      },
    });
  }

  /** OS templates/images compatible with cloud or GPU VMs. */
  listImages(args: {
    workspaceId: string;
    vmType?: string;
    currency?: string;
  }): Promise<unknown> {
    return this.http.request({
      method: "GET",
      path: "/compute/images",
      workspaceId: args.workspaceId,
      query: { vm_type: args.vmType, currency: args.currency },
    });
  }
}
