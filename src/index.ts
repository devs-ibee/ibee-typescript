import { HttpClient, type ClientOptions } from "./core.js";
import { IbeeEnvironment } from "./environments.js";
import { ObjectStorageResource } from "./resources/objectStorage.js";
import { SecretStoreResource } from "./resources/secretStore.js";
import { OperationsResource, VmResource } from "./resources/vms.js";
import type { CreateGpuVmRequest } from "./types.js";

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
 * import { Ibee, IbeeEnvironment } from "@ibee/sdk";
 *
 * const client = new Ibee({ token: "ibee_live_xxx" });
 * const buckets = await client.objectStorage.listBuckets({ workspaceId: "710995" });
 *
 * // development gateway
 * const dev = new Ibee({ token: "ibee_dev_xxx", environment: IbeeEnvironment.DEVELOPMENT });
 * ```
 */
export class Ibee {
  readonly secretStore: SecretStoreResource;
  readonly objectStorage: ObjectStorageResource;
  readonly cloudVms: VmResource;
  readonly gpuVms: VmResource<CreateGpuVmRequest>;
  readonly operations: OperationsResource;

  constructor(options: IbeeOptions) {
    const baseUrl =
      options.baseUrl ?? options.environment ?? IbeeEnvironment.DEFAULT;
    const http = new HttpClient({ ...options, baseUrl });

    this.secretStore = new SecretStoreResource(http);
    this.objectStorage = new ObjectStorageResource(http);
    this.cloudVms = new VmResource(http, "cloud-vms");
    this.gpuVms = new VmResource<CreateGpuVmRequest>(http, "gpu-vms");
    this.operations = new OperationsResource(http);
  }
}
