import { HttpClient, type ClientOptions } from "./core.js";
import { IbeeEnvironment } from "./environments.js";
import { BillingResource } from "./resources/billing.js";
import { ComputeCatalogResource } from "./resources/compute.js";
import {
  FirewallsResource,
  LoadBalancersResource,
  ReservedIpsResource,
  VpcsResource,
} from "./resources/networking.js";
import { ObjectStorageResource } from "./resources/objectStorage.js";
import { SecretStoreResource } from "./resources/secretStore.js";
import { OperationsResource, VmResource } from "./resources/vms.js";
import { VmConsoleResource } from "./resources/vmConsole.js";
import type { CreateGpuVmRequest, GpuVm } from "./types.js";

export { IbeeEnvironment } from "./environments.js";
export { ApiError } from "./errors.js";
export type { ClientOptions } from "./core.js";
export * from "./types.js";

export interface IbeeOptions extends Omit<ClientOptions, "baseUrl"> {
  /**
   * Base URL, or an IbeeEnvironment value. Defaults to production
   * (IbeeEnvironment.DEFAULT — https://api.ibee.ai/v1).
   */
  environment?: string;
  /** Explicit base URL override (takes precedence over `environment`). */
  baseUrl?: string;
}

/**
 * IBEE Solutions API client.
 *
 * @example
 * ```ts
 * import { Ibee, IbeeEnvironment } from "ibee-sdk";
 *
 * const client = new Ibee({ token: "ibee_prod_key_xxx" });
 * const buckets = await client.objectStorage.listBuckets({ workspaceId: "710995" });
 *
 * // development gateway
 * const dev = new Ibee({ token: "ibee_dev_key_xxx", environment: IbeeEnvironment.DEVELOPMENT });
 * ```
 */
export class Ibee {
  readonly secretStore: SecretStoreResource;
  readonly billing: BillingResource;
  readonly objectStorage: ObjectStorageResource;
  readonly cloudVms: VmResource;
  readonly gpuVms: VmResource<CreateGpuVmRequest, GpuVm>;
  readonly operations: OperationsResource;
  readonly vmConsole: VmConsoleResource;
  readonly computeCatalog: ComputeCatalogResource;
  readonly vpcs: VpcsResource;
  readonly reservedIps: ReservedIpsResource;
  readonly firewalls: FirewallsResource;
  readonly loadBalancers: LoadBalancersResource;

  constructor(options: IbeeOptions) {
    const baseUrl =
      options.baseUrl ?? options.environment ?? IbeeEnvironment.DEFAULT;
    const http = new HttpClient({ ...options, baseUrl });

    this.billing = new BillingResource(http);
    this.secretStore = new SecretStoreResource(http, this.billing);
    this.objectStorage = new ObjectStorageResource(http, this.billing);
    this.cloudVms = new VmResource(http, this.billing, "cloud-vms", "cloud");
    this.gpuVms = new VmResource<CreateGpuVmRequest, GpuVm>(
      http,
      this.billing,
      "gpu-vms",
      "gpu",
    );
    this.operations = new OperationsResource(http);
    this.vmConsole = new VmConsoleResource(http);
    this.computeCatalog = new ComputeCatalogResource(http);
    this.vpcs = new VpcsResource(http, this.billing);
    this.reservedIps = new ReservedIpsResource(http, this.billing);
    this.firewalls = new FirewallsResource(http);
    this.loadBalancers = new LoadBalancersResource(http, this.billing);
  }
}
