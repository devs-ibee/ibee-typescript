import { HttpClient, type ClientOptions } from "./core.js";
import { resolveBaseUrl } from "./validation.js";
import { BillingResource } from "./resources/billing.js";
import { BlockStorageResource } from "./resources/blockStorage.js";
import { CdnResource } from "./resources/cdn.js";
import { ComputeCatalogResource } from "./resources/compute.js";
import {
  FirewallsResource,
  LoadBalancersResource,
  ReservedIpsResource,
  VpcsResource,
} from "./resources/networking.js";
import { ObjectStorageResource } from "./resources/objectStorage.js";
import { SecretStoreResource } from "./resources/secretStore.js";
import {
  OperationsResource,
  VmResource,
  type WaitForOperationArgs,
} from "./resources/vms.js";
import { VmConsoleResource } from "./resources/vmConsole.js";
import type { CreateGpuVmRequest, GpuVm, OperationStatus } from "./types.js";

export { IbeeEnvironment } from "./environments.js";
export type { IbeeEnvironmentUrl } from "./environments.js";
export { VERSION } from "./version.js";
export {
  ApiError,
  ApiKeyInactiveError,
  BadGatewayError,
  BadRequestError,
  BillingAdmissionError,
  BillingDeniedError,
  BillingForbiddenError,
  ConflictError,
  ForbiddenError,
  GatewayTimeoutError,
  IbeeError,
  InsufficientScopeError,
  InternalServerError,
  InvalidWorkspaceError,
  NotFoundError,
  OperationFailedError,
  OperationTimeoutError,
  OrganizationRestrictedError,
  OrganizationSuspendedError,
  PayloadTooLargeError,
  PaymentRequiredError,
  RecoveryFailedError,
  RecoveryRestoreFailedError,
  ResizeBlockedError,
  RouteNotAvailableError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  UnprocessableEntityError,
  WorkspaceNotAllowedError,
  apiErrorFromResponse,
  defaultCodeForStatus,
  isPaymentBlockError,
  parseErrorBody,
} from "./errors.js";
export type {
  ApiErrorInit,
  BillingDeniedInit,
  OperationLike,
  ParsedErrorBody,
} from "./errors.js";
export {
  ELIGIBILITY_OPERATIONS,
  IbeeValidationError,
  MAX_BILLABLE_BODY_BYTES,
  VM_LIST_SORT_FIELDS,
  WAIT_DEFAULT_POLL_INTERVAL_MS,
  WAIT_DEFAULT_TIMEOUT_MS,
  checkTokenEnvironment,
  environmentFromName,
  isBillableCreate,
  normaliseEligibilityOperation,
  normaliseEstimatedCostMinor,
  normaliseSkuCode,
  resolveBaseUrl,
  validateIdempotencyKey,
  validateLimitOffset,
  validateOperationId,
  validateToken,
  validateWaitOptions,
  validateWorkspaceId,
  // Compute (VM) rules
  BACKUP_FREQUENCIES,
  BACKUP_RUN_STATUSES,
  MAX_VM_BATCH_SIZE,
  NETWORK_CONNECTIVITY_MODES,
  OPERATION_ID_PATTERN,
  SNAPSHOT_MODES,
  SSH_KEY_TYPES,
  VM_ID_PATTERN,
  VM_METRICS_RANGES,
  VM_NAME_PATTERN,
  VM_RESIZE_LIMITS,
  VM_VOLUME_MODES,
  assertVmActionAllowed,
  expandBatchNames,
  isValidTimeZone,
  isWindowsVm,
  normaliseIdList,
  normaliseSshKeys,
  normaliseVpcConnectivityType,
  resolveDeletePublicIpAction,
  validateAccessUpdate,
  validateAccessUpdateAgainstVm,
  validateBackupRetention,
  validateBackupSchedule,
  validateBandwidthMonth,
  validateDetachConfirmation,
  validateMetricsRange,
  validateNetworkFields,
  validateNextRunAt,
  validateResizePlanChange,
  validateResizeTarget,
  validateRootDiskGrow,
  validateSnapshotCreate,
  validateSshPublicKey,
  validateVmId,
  validateVmName,
  validateVmNetworkPlacement,
} from "./validation.js";
export type { VmStateAction } from "./validation.js";
export {
  BILLING_TERMS,
  ROOT_DISK_COMPONENTS,
  applyBillingTerm,
  billingCatalogForTerm,
  billingOptionsOf,
  buildVmCreateBillingCatalog,
  normaliseBillingTerm,
  requireBillingSku,
  selectBillingOption,
  validateBillingCatalog,
  windowsLicenseAttachment,
  withAttachedBillingSkus,
} from "./billingCatalog.js";
export type { BuildVmBillingCatalogArgs, ValidateBillingCatalogOptions } from "./billingCatalog.js";
export {
  recoveryCapturedDataVolumes,
  recoveryDateStamp,
  recoveryDefaultVmName,
  recoveryMinRootDiskGb,
  recoveryTargetVolumeNames,
  restoreTargetFromPlan,
  validateNewVmTarget,
  validateRestoreRequest,
} from "./recovery.js";
export type { RecoveryKind } from "./recovery.js";
export {
  CREATE_TYPE_LABELS,
  HOURLY_BILLING_PERIOD_HOURS,
  INR_MINIMUM_TOPUP_MINOR,
  billingBlockMessage,
  estimateEligibilityCostMinor,
  isBillingTopupAllowed,
  minimumTopupMinor,
} from "./billingHelpers.js";
export type { BillingCreateType, BillingDecisionLike } from "./billingHelpers.js";
export { buildIdempotencyKey, buildStableIdempotencyKey } from "./idempotency.js";
export { MAX_RETRY_DELAY_MS, isRetrySafe, retryDelayMs, shouldRetryStatus } from "./retry.js";
export { collect, paginateOffset, paginatePages } from "./pagination.js";
export type { PaginateOffsetOptions, PaginatePagesOptions } from "./pagination.js";
export {
  MAX_CONSECUTIVE_POLL_FAILURES,
  OPERATION_FAILURE_STATES,
  OPERATION_SUCCESS_STATES,
  pollUntil,
} from "./polling.js";
export type { PollUntilOptions } from "./polling.js";
export type { ClientOptions } from "./core.js";
export type {
  CheckResourceEligibilityArgs,
  RequireResourceEligibilityArgs,
} from "./resources/billing.js";
export { normalizeVmRecord } from "./resources/vms.js";
export type {
  RecoveryWaitOptions,
  VmActionOptions,
  VmCreateOptions,
  VmListAllArgs,
  VmListArgs,
  VmWaitOptions,
  WaitForOperationArgs,
} from "./resources/vms.js";
export type { VolumeIdempotencyArgs } from "./resources/blockStorage.js";
export * from "./types.js";

export interface IbeeOptions extends Omit<ClientOptions, "baseUrl"> {
  /**
   * Base URL, or an IbeeEnvironment value. Defaults to production
   * (IbeeEnvironment.PRODUCTION — https://api.ibee.ai/v1). A token for the
   * other environment (`ibee_dev_key_` against production or
   * `ibee_prod_key_` against development) is rejected at construction.
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
  readonly blockStorage: BlockStorageResource;
  readonly cdn: CdnResource;
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
    const baseUrl = resolveBaseUrl(options.baseUrl, options.environment);
    const http = new HttpClient({ ...options, baseUrl });

    this.billing = new BillingResource(http);
    this.secretStore = new SecretStoreResource(http);
    this.objectStorage = new ObjectStorageResource(http);
    this.cloudVms = new VmResource(http, "cloud-vms", "cloud");
    this.gpuVms = new VmResource<CreateGpuVmRequest, GpuVm>(
      http,
      "gpu-vms",
      "gpu",
    );
    this.operations = new OperationsResource(http);
    this.vmConsole = new VmConsoleResource(http);
    this.computeCatalog = new ComputeCatalogResource(http);
    this.vpcs = new VpcsResource(http);
    this.reservedIps = new ReservedIpsResource(http);
    this.firewalls = new FirewallsResource(http);
    this.loadBalancers = new LoadBalancersResource(http);
    this.blockStorage = new BlockStorageResource(http);
    this.cdn = new CdnResource(http);
  }
}

/**
 * Wait for an async compute operation to finish (same as
 * `client.operations.wait(args)`).
 */
export function waitForComputeOperation(
  client: Ibee,
  args: WaitForOperationArgs,
): Promise<OperationStatus> {
  return client.operations.wait(args);
}
