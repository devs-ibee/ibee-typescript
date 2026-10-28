// Hand-written package entry (listed in src/.fernignore).
export * from "./api/index.js";
export type { BaseClientOptions, BaseRequestOptions } from "./BaseClient.js";
export { IbeeClient } from "./Client.js";
export * from "./core/exports.js";
export { IbeeEnvironment } from "./environments.js";
export { IbeeError, IbeeTimeoutError } from "./errors/index.js";
export { VERSION } from "./version.js";
export { Ibee } from "./wrapper/Ibee.js";
export type {
    HeldBillingTerm,
    HeldCloudVms,
    HeldFirewalls,
    HeldGpuVms,
    HeldVmAttach,
    HeldVmCreate,
    HeldVmCreateFields,
    HeldVmDelete,
    HeldVpcs,
} from "./wrapper/held.js";
