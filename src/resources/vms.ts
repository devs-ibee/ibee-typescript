import type { HttpClient } from "../core.js";
import {
  applyBillingTerm,
  billingOptionsOf,
  buildVmCreateBillingCatalog,
  normaliseBillingTerm,
  validateBillingCatalog,
  withAttachedBillingSkus,
} from "../billingCatalog.js";
import { estimateEligibilityCostMinor } from "../billingHelpers.js";
import { NotFoundError, RecoveryFailedError, RecoveryRestoreFailedError } from "../errors.js";
import { buildIdempotencyKey } from "../idempotency.js";
import { collect, paginateOffset } from "../pagination.js";
import { pollUntil } from "../polling.js";
import {
  recoveryDefaultVmName,
  recoveryMinRootDiskGb,
  recoveryTargetVolumeNames,
  restoreTargetFromPlan,
  validateNewVmTarget,
  validateRestoreRequest,
  type RecoveryKind,
} from "../recovery.js";
import {
  BACKUP_RUN_STATUSES,
  IbeeValidationError,
  VM_VOLUME_MODES,
  assertVmActionAllowed,
  isWindowsVm,
  normaliseBackupReason,
  normaliseFirewallGroupIds,
  normaliseIdList,
  normaliseSshKeys,
  recoveryListQuery,
  resolveDeletePublicIpAction,
  validateAccessUpdate,
  validateAccessUpdateAgainstVm,
  validateBackupRetention,
  validateBackupSchedule,
  validateBandwidthMonth,
  validateDetachConfirmation,
  validateIdempotencyKey,
  validateIntRange,
  validateLimitOffset,
  validateMetricsRange,
  validateNetworkFields,
  validateNextRunAt,
  validateOperationId,
  validateRequestedBy,
  validateRequiredId,
  validateResizePlanChange,
  validateResizeTarget,
  validateRootDiskGrow,
  validateSnapshotCreate,
  validateVmId,
  validateVmName,
  validateVmNetworkPlacement,
  validateWaitOptions,
  validateWorkspaceId,
  vmListQuery,
  type VmStateAction,
} from "../validation.js";
import { BillingResource } from "./billing.js";
import type {
  BackupPolicy,
  BackupPolicyDisableRequest,
  BackupPolicyEnableRequest,
  BackupPolicyNextRunRequest,
  BackupPolicyUpdateRequest,
  BackupRestoreRequest,
  BackupRun,
  BackupRunDeleteResult,
  BackupRunList,
  BackupStatus,
  BillingCatalogSelection,
  BillingTerm,
  BlockVolume,
  CloudVm,
  ComputeImage,
  ComputeImageList,
  ComputePlan,
  ComputePlanList,
  CreateGpuVmRequest,
  CreateVmRequest,
  GpuVm,
  ManualBackupRunRequest,
  MountGuidanceAcknowledge,
  OperationAccepted,
  OperationAcceptedResult,
  OperationStatus,
  PublicIpAction,
  RecoveryRestore,
  SnapshotCreateRequest,
  SnapshotDeleteResult,
  SnapshotRestoreRequest,
  SnapshotSet,
  SnapshotSetList,
  VmAccessUpdateRequest,
  VmAttachVolumeRequest,
  VmBandwidthSummary,
  VmDetachVolumeRequest,
  VmEvent,
  VmMetrics,
  VmMetricsRange,
  VmMetricsTimeseries,
  VmResizePlanRequest,
  VmResizePrecheck,
  VmResizeRequest,
  VmResizeRootDiskRequest,
} from "../types.js";

/** VM write actions that carry an `X-Idempotency-Key`. */
type KeyedAction =
  | "create"
  | "delete"
  | "start"
  | "stop"
  | "reboot"
  | "access"
  | "resize"
  | "resize-plan"
  | "resize-root-disk"
  | "attach-volume"
  | "detach-volume";

/** VM list paging and filtering (not yet part of the published API contract). */
export interface VmListArgs {
  workspaceId: string;
  /**
   * Page size 1..100. When `limit` and `offset` are both omitted, `list`
   * returns every VM by paging automatically.
   * Not yet part of the published API contract; behaviour may change.
   */
  limit?: number;
  /** Offset >= 0. Not yet part of the published API contract; behaviour may change. */
  offset?: number;
  /** Name search (max 120 characters). Not yet part of the published API contract; behaviour may change. */
  search?: string;
  /** Not yet part of the published API contract; behaviour may change. */
  sortBy?: "created_at" | "name" | "status" | "os_type";
  /** Not yet part of the published API contract; behaviour may change. */
  sortDirection?: "asc" | "desc";
}

/** Arguments of `listAll` / `iterate`. */
export interface VmListAllArgs extends Omit<VmListArgs, "limit" | "offset"> {
  /** Items per request, 1..100 (default 100). */
  pageSize?: number;
}

/** How to wait for an async operation. `true` uses the defaults. */
export interface VmWaitOptions {
  /** Client deadline in ms. */
  timeoutMs?: number;
  /** Poll interval in ms. */
  pollIntervalMs?: number;
  /** Throw on failed/cancelled/timed_out (default true). */
  raiseOnFailure?: boolean;
  signal?: AbortSignal;
  onUpdate?: (value: OperationStatus) => void;
}

/** Common options of async VM actions. */
export interface VmActionOptions {
  /** Poll the returned operation until it finishes (`true` or wait options). */
  wait?: boolean | VmWaitOptions;
  /**
   * Read the VM first and apply the portal's state rules (e.g. start only a
   * stopped VM). Default false.
   */
  checkState?: boolean;
}

/** Options of `create`. */
export interface VmCreateOptions {
  workspaceId: string;
  /** Generated per VM when omitted. */
  idempotencyKey?: string;
  /** Run the billing eligibility check first (needs `billing.read`). Default false. */
  preflightBilling?: boolean;
  /**
   * Read the plan and image from the compute catalog to fill and check the
   * request (default true). With false you must pass cpu, ram_mb, os_type,
   * os_distro and billing_catalog yourself.
   */
  resolveCatalog?: boolean;
  wait?: boolean | VmWaitOptions;
}

/** Options for polling a restore, snapshot or backup run. */
export interface RecoveryWaitOptions {
  /** Default 1 800 000 (30 min). */
  timeoutMs?: number;
  /** Default 5000. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onUpdate?: (value: Record<string, unknown>) => void;
}

/** Page size used when auto-paging lists. */
const AUTO_PAGE_SIZE = 100;
const RECOVERY_TERMINAL_SUCCESS: ReadonlySet<string> = new Set(["succeeded"]);
const RECOVERY_TERMINAL_FAILURE: ReadonlySet<string> = new Set(["failed", "cancelled"]);
const SNAPSHOT_BLOCKED_STATES = new Set([
  "pending",
  "provisioning",
  "configuring",
  "starting",
  "stopping",
  "rebooting",
  "resizing",
  "deleting",
  "restoring",
]);
const VOLUME_BUSY_STATES = new Set(["creating", "attaching", "detaching", "resizing", "deleting"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

const fail = (message: string, code: string, field?: string, details?: unknown): never => {
  throw new IbeeValidationError(message, code, field, details);
};

/** Copy `_id` to `id` when the API returns only `_id`. */
export function normalizeVmRecord<T>(vm: T): T {
  if (isRecord(vm) && (vm.id === undefined || vm.id === null || vm.id === "") && vm._id !== undefined && vm._id !== null) {
    return { ...vm, id: String(vm._id) } as T;
  }
  return vm;
}

const waitOpts = (wait: boolean | VmWaitOptions | undefined): VmWaitOptions | undefined =>
  wait === true ? {} : wait ? wait : undefined;

const RESIZE_BLOCK_MESSAGES: Record<string, string> = {
  migration_required: "This downgrade requires migration. In-place disk shrink is blocked.",
  blocked: "Resize is currently blocked.",
};

/**
 * Shared implementation for Cloud VMs and GPU VMs — identical endpoints under
 * different path segments (`cloud-vms` / `gpu-vms`).
 */
export class VmResource<
  TCreate extends CreateVmRequest = CreateVmRequest,
  TVm extends CloudVm = CloudVm,
> {
  private readonly operations: OperationsResource;
  private readonly billing: BillingResource;

  constructor(
    private readonly http: HttpClient,
    private readonly segment: string,
    private readonly vmType: "cloud" | "gpu",
  ) {
    this.operations = new OperationsResource(http);
    this.billing = new BillingResource(http);
  }

  private base(id?: string): string {
    return id
      ? `/compute/${this.segment}/${encodeURIComponent(id)}`
      : `/compute/${this.segment}`;
  }

  private snapshotBase(snapshotSetId?: string): string {
    const collection =
      this.vmType === "cloud" ? "cloud-vm-snapshots" : "gpu-vm-snapshots";
    return snapshotSetId
      ? `/compute/${collection}/${encodeURIComponent(snapshotSetId)}`
      : `/compute/${collection}`;
  }

  private backupBase(): string {
    const collection =
      this.vmType === "cloud" ? "cloud-vm-backups" : "gpu-vm-backups";
    return `/compute/${collection}`;
  }

  /**
   * Resolve the idempotency key for a VM write: validate a caller-supplied
   * key, or build one the way the portal does.
   */
  private key(action: KeyedAction, ident: string | undefined, supplied?: string): string {
    if (supplied !== undefined) return validateIdempotencyKey(supplied);
    return buildIdempotencyKey(`${this.vmType}-vm-${action}`, ident);
  }

  private async finish(
    workspaceId: string,
    accepted: OperationAccepted,
    wait: boolean | VmWaitOptions | undefined,
    defaults: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<OperationAcceptedResult> {
    const opts = waitOpts(wait);
    if (!opts) return accepted;
    const operation = await this.operations.wait({
      workspaceId,
      operationId: accepted.operation_id,
      timeoutMs: opts.timeoutMs ?? defaults.timeoutMs,
      pollIntervalMs: opts.pollIntervalMs ?? defaults.pollIntervalMs,
      raiseOnFailure: opts.raiseOnFailure,
      signal: opts.signal,
      onUpdate: opts.onUpdate,
    });
    return { ...accepted, operation };
  }

  private async fetchVm(workspaceId: string, vmId: string): Promise<TVm> {
    const vm = await this.http.request<TVm>({
      method: "GET",
      path: this.base(vmId),
      workspaceId,
    });
    return normalizeVmRecord(vm);
  }

  private async checkVm(workspaceId: string, vmId: string, action: VmStateAction): Promise<TVm> {
    const vm = await this.fetchVm(workspaceId, vmId);
    assertVmActionAllowed(vm, action);
    return vm;
  }

  /** Find a selectable, priced plan of this VM type in a site. */
  private async findPlan(workspaceId: string, siteId: string, planId: string, field = "plan_id"): Promise<ComputePlan> {
    const list = await this.http.request<ComputePlanList>({
      method: "GET",
      path: "/compute/plans",
      workspaceId,
      query: { vm_type: this.vmType, site_id: siteId },
    });
    const plans = Array.isArray(list?.plans) ? list.plans : [];
    const plan = plans.find((p) => String(p.plan_id) === planId);
    if (!plan) {
      fail(`Plan '${planId}' is not available for ${this.vmType} VMs in site '${siteId}'.`, "invalid_plan", field);
    }
    const p = plan as ComputePlan;
    if (p.selectable !== true || p.pricing_status !== "priced") {
      fail(`Plan '${planId}' is not currently available (not selectable or not priced).`, "invalid_plan", field);
    }
    return p;
  }

  private async findImage(workspaceId: string, siteId: string, templateId: string): Promise<ComputeImage> {
    const list = await this.http.request<ComputeImageList>({
      method: "GET",
      path: "/compute/images",
      workspaceId,
      query: { vm_type: this.vmType, site_id: siteId },
    });
    const images = Array.isArray(list?.images) ? list.images : [];
    const image = images.find((i) => String(i.template_id) === templateId);
    if (!image) {
      fail(`Image '${templateId}' is not available for ${this.vmType} VMs in site '${siteId}'.`, "invalid_template", "template_id");
    }
    const img = image as ComputeImage;
    if (Array.isArray(img.compatible_vm_types) && img.compatible_vm_types.length > 0 && !img.compatible_vm_types.includes(this.vmType)) {
      fail(`Image '${templateId}' cannot be used for ${this.vmType} VMs.`, "invalid_template", "template_id");
    }
    if (Array.isArray(img.site_ids) && img.site_ids.length > 0 && !img.site_ids.includes(siteId)) {
      fail(`Image '${templateId}' is not available in site '${siteId}'.`, "invalid_template", "template_id");
    }
    return img;
  }

  // ------------------------------------------------------------------ list

  /**
   * List VMs. With no `limit`/`offset` every page is fetched (100 per request)
   * and de-duplicated; otherwise exactly one page is returned. Items get `id`
   * copied from `_id`.
   */
  async list(args: VmListArgs): Promise<TVm[]> {
    validateWorkspaceId(args.workspaceId);
    const query = vmListQuery(args);
    if (args.limit === undefined && args.offset === undefined) {
      return collect(this.iterate(args));
    }
    const page = await this.http.request<TVm[]>({
      method: "GET",
      path: this.base(),
      workspaceId: args.workspaceId,
      query,
    });
    return Array.isArray(page) ? page.map((vm) => normalizeVmRecord(vm)) : page;
  }

  /** Every VM, paging `pageSize` (default 100) at a time. */
  async listAll(args: VmListAllArgs): Promise<TVm[]> {
    return collect(this.iterate(args));
  }

  /** Iterate every VM, fetching pages (default 100) on demand. */
  iterate(args: VmListAllArgs): AsyncIterable<TVm> {
    validateWorkspaceId(args.workspaceId);
    const pageSize = args.pageSize ?? AUTO_PAGE_SIZE;
    validateLimitOffset({ limit: pageSize }, 100);
    const query = vmListQuery({ ...args, limit: undefined, offset: undefined });
    const pages = paginateOffset<TVm>(
      (limit, offset) =>
        this.http.request<TVm[]>({
          method: "GET",
          path: this.base(),
          workspaceId: args.workspaceId,
          query: { ...query, limit, offset },
        }),
      { pageSize },
    );
    return {
      async *[Symbol.asyncIterator]() {
        for await (const vm of pages) yield normalizeVmRecord(vm);
      },
    };
  }

  // ---------------------------------------------------------------- create

  /**
   * Create a VM the way the portal does. Needs `name`, `site_id`, `plan_id`
   * and `template_id`; the SDK reads the plan and image, fills cpu, ram_mb,
   * disk_gb, os_type, os_distro (and GPU fields), builds `billing_catalog`
   * for `billing_term`, attaches the Windows licence and Reserved IP SKUs,
   * checks VPC placement, and never retries the POST automatically.
   *
   * @throws IbeeValidationError before any write when a portal rule fails.
   */
  async create(args: VmCreateOptions & TCreate): Promise<OperationAcceptedResult> {
    const {
      workspaceId,
      idempotencyKey,
      preflightBilling,
      resolveCatalog,
      wait,
      ...input
    } = args as VmCreateOptions & CreateGpuVmRequest;
    validateWorkspaceId(workspaceId);
    const isGpu = this.vmType === "gpu";
    const name = validateVmName(input.name);
    const siteId = String(input.site_id ?? "").trim();
    if (!siteId) {
      fail("site_id is required: pick a site from computeCatalog.listSites and use it for the plan and image too.", "site_required", "site_id");
    }
    const planId = validateRequiredId(input.plan_id, "plan_id");
    const templateId = validateRequiredId(input.template_id, "template_id");
    const term = input.billing_term === undefined || input.billing_term === null ? undefined : normaliseBillingTerm(input.billing_term);
    const sshKeys = normaliseSshKeys(input.ssh_keys);
    const sshKeyIds = normaliseIdList(input.ssh_key_ids, "ssh_key_ids");
    const firewallIds = normaliseFirewallGroupIds(input.firewall_group_ids);
    const tags = input.tags === undefined ? undefined : normaliseIdList(input.tags, "tags");
    const net = validateNetworkFields(input);
    validateRequestedBy(input.requested_by);
    let osType = input.os_type === undefined || input.os_type === null ? undefined : String(input.os_type).trim().toLowerCase();
    if (osType !== undefined && osType !== "linux" && osType !== "windows") {
      fail("os_type must be 'linux' or 'windows'.", "invalid_os_type", "os_type");
    }
    if (isGpu && osType === "windows") {
      fail("GPU VMs support Linux images only through the public API.", "invalid_os_type", "os_type");
    }
    if (osType === "windows" && !input.windows_license && !input.billing_catalog?.attached_skus?.windows_license) {
      fail(
        "Windows VMs require a Windows licence SKU (windows_license). The public API does not list it yet; pass the licence SKU you were given.",
        "windows_license_required",
        "windows_license",
      );
    }
    if (osType === "linux" && input.windows_license) {
      fail("windows_license is only allowed for Windows VMs.", "invalid_billing_catalog", "windows_license");
    }

    let cpu = input.cpu;
    let ramMb = input.ram_mb;
    let diskGb = input.disk_gb;
    let osDistro = input.os_distro === undefined || input.os_distro === null ? undefined : String(input.os_distro).trim();
    let gpuCount = input.gpu_count;
    let gpuModel = input.gpu_model === undefined || input.gpu_model === null ? undefined : String(input.gpu_model).trim();
    let plan: ComputePlan | undefined;

    const mismatch = (field: string, given: unknown, expected: unknown, source: string) =>
      fail(`${field} ${String(given)} does not match the selected ${source} (${String(expected)}).`, "catalog_mismatch", field);

    if (resolveCatalog !== false) {
      plan = await this.findPlan(workspaceId, siteId, planId);
      const image = await this.findImage(workspaceId, siteId, templateId);
      if (cpu !== undefined && cpu !== plan.cpu) mismatch("cpu", cpu, plan.cpu, "plan");
      if (ramMb !== undefined && ramMb !== plan.ram_mb) mismatch("ram_mb", ramMb, plan.ram_mb, "plan");
      if (diskGb !== undefined && diskGb !== null && diskGb !== plan.disk_gb) mismatch("disk_gb", diskGb, plan.disk_gb, "plan");
      cpu = plan.cpu;
      ramMb = plan.ram_mb;
      diskGb = plan.disk_gb;
      const imageOs = String(image.os_type ?? "").trim().toLowerCase();
      if (osType !== undefined && imageOs && osType !== imageOs) mismatch("os_type", osType, imageOs, "image");
      osType = imageOs || osType;
      if (osDistro !== undefined && image.os_distro && osDistro.toLowerCase() !== String(image.os_distro).toLowerCase()) {
        mismatch("os_distro", osDistro, image.os_distro, "image");
      }
      osDistro = image.os_distro || osDistro;
      if (isGpu) {
        if (osType !== "linux") fail("GPU VMs support Linux images only through the public API.", "invalid_os_type", "os_type");
        const planCount = Number(plan.gpu_count);
        if (Number.isInteger(planCount) && planCount >= 1) {
          if (gpuCount !== undefined && gpuCount !== planCount) mismatch("gpu_count", gpuCount, planCount, "plan");
          gpuCount = planCount;
        }
        const planModel = String(plan.gpu_model ?? "").trim();
        if (planModel) {
          if (gpuModel && gpuModel.toLowerCase() !== planModel.toLowerCase()) mismatch("gpu_model", gpuModel, planModel, "plan");
          gpuModel = planModel;
        }
      }
    } else {
      for (const [field, value] of [
        ["cpu", cpu],
        ["ram_mb", ramMb],
        ["os_type", osType],
        ["os_distro", osDistro],
        ["billing_catalog", input.billing_catalog],
      ] as const) {
        if (value === undefined || value === null || value === "") {
          fail(`${field} is required when resolveCatalog is false.`, "missing_field", field);
        }
      }
    }
    if (typeof cpu !== "number" || !Number.isInteger(cpu) || cpu < 1) fail("cpu must be an integer >= 1.", "invalid_cpu", "cpu");
    if (typeof ramMb !== "number" || !Number.isInteger(ramMb) || ramMb < 512) fail("ram_mb must be an integer >= 512.", "invalid_ram_mb", "ram_mb");
    if (diskGb !== undefined && diskGb !== null && (!Number.isInteger(diskGb) || diskGb < 10)) {
      fail("disk_gb must be an integer >= 10.", "invalid_disk_gb", "disk_gb");
    }
    if (!osDistro) fail("os_distro is required.", "missing_field", "os_distro");
    if (isGpu) {
      if (gpuCount === undefined || gpuCount === null) gpuCount = 1;
      if (!Number.isInteger(gpuCount) || gpuCount < 1) fail("gpu_count must be an integer >= 1.", "invalid_gpu_count", "gpu_count");
    }

    // VPC / Reserved IP placement.
    let reservedIpCatalog: unknown;
    if (net.vpc_id) {
      const vpc = await this.http.request<Record<string, unknown>>({
        method: "GET",
        path: `/networking/vpcs/${encodeURIComponent(net.vpc_id)}`,
        workspaceId,
      });
      const subnet = await this.http.request<Record<string, unknown>>({
        method: "GET",
        path: `/networking/vpcs/${encodeURIComponent(net.vpc_id)}/subnets/${encodeURIComponent(net.subnet_id as string)}`,
        workspaceId,
      });
      let reservedIp: Record<string, unknown> | undefined;
      if (net.reserved_public_ip_id) {
        reservedIp = await this.http.request<Record<string, unknown>>({
          method: "GET",
          path: `/networking/reserved-ips/${encodeURIComponent(net.reserved_public_ip_id)}`,
          workspaceId,
        });
        if (!isRecord(reservedIp?.billing_catalog)) {
          fail("The selected Reserved IP has no billing catalog, so it cannot be attached at launch.", "invalid_network", "reserved_public_ip_id");
        }
        reservedIpCatalog = reservedIp?.billing_catalog;
      }
      validateVmNetworkPlacement({
        siteId,
        vpc: isRecord(vpc) ? vpc : {},
        subnet: isRecord(subnet) ? subnet : null,
        subnetId: net.subnet_id as string,
        connectivity: net.network_connectivity ?? "private",
        reservedIp,
      });
    }

    // Billing catalog.
    let billingCatalog: BillingCatalogSelection;
    let unitPriceMinor: number | undefined;
    let effectiveTerm: BillingTerm | undefined = term;
    if (input.billing_catalog !== undefined && input.billing_catalog !== null) {
      // A caller-supplied SKU is sent as-is unless a term is also given.
      const built = buildVmCreateBillingCatalog({
        catalog: input.billing_catalog,
        term,
        applyTerm: term !== undefined,
        osType,
        cpu: cpu as number,
        windowsLicense: input.windows_license,
        reservedIpBillingCatalog: reservedIpCatalog,
      });
      billingCatalog = built.catalog;
      unitPriceMinor = built.option?.unit_price_minor;
    } else {
      if (!plan?.billing_catalog) {
        fail("The selected plan has no billing catalog, so it cannot be created.", "invalid_plan", "plan_id");
      }
      const built = buildVmCreateBillingCatalog({
        catalog: plan?.billing_catalog,
        term,
        applyTerm: !isGpu,
        osType,
        cpu: cpu as number,
        windowsLicense: input.windows_license,
        reservedIpBillingCatalog: reservedIpCatalog,
      });
      billingCatalog = built.catalog;
      unitPriceMinor = built.option?.unit_price_minor;
      effectiveTerm = built.option?.billing_interval ?? term;
    }
    if (osType === "windows" && !billingCatalog.attached_skus?.windows_license) {
      fail("Windows VMs require a Windows licence SKU (windows_license).", "windows_license_required", "windows_license");
    }

    if (preflightBilling) {
      const interval = effectiveTerm ?? "HOURLY";
      const price =
        unitPriceMinor ??
        (interval === "HOURLY" ? plan?.hourly_price_minor : interval === "MONTHLY" ? plan?.monthly_price_minor : undefined);
      await this.billing.requireResourceEligibility({
        workspaceId,
        skuCode: billingCatalog.sku_code,
        estimatedCostMinor: typeof price === "number" ? estimateEligibilityCostMinor(interval, price, 1) : undefined,
        resourceType: isGpu ? "gpu_vm" : "vm",
      });
    }

    const body: Record<string, unknown> = {
      name,
      site_id: siteId,
      plan_id: planId,
      template_id: templateId,
      os_type: osType,
      os_distro: osDistro,
      cpu,
      ram_mb: ramMb,
      ...(diskGb !== undefined && diskGb !== null ? { disk_gb: diskGb } : {}),
      billing_catalog: billingCatalog,
      ...(isGpu ? { gpu_count: gpuCount } : {}),
      ...(isGpu && gpuModel ? { gpu_model: gpuModel } : {}),
      ...(sshKeyIds.length ? { ssh_key_ids: sshKeyIds } : {}),
      ...(sshKeys.length ? { ssh_keys: sshKeys } : {}),
      ...(firewallIds.length ? { firewall_group_id: firewallIds[0], firewall_group_ids: firewallIds } : {}),
      ...(net.vpc_id
        ? {
            vpc_id: net.vpc_id,
            subnet_id: net.subnet_id,
            network_connectivity: net.network_connectivity ?? "private",
            vpc_attachment_mode: "primary",
          }
        : {}),
      ...(net.reserved_public_ip_id ? { reserved_public_ip_id: net.reserved_public_ip_id } : {}),
      ...(tags && tags.length ? { tags } : {}),
      ...(input.requested_by !== undefined ? { requested_by: input.requested_by } : {}),
    };
    const accepted = await this.http.request<OperationAccepted>({
      method: "POST",
      path: this.base(),
      workspaceId,
      idempotencyKey: this.key("create", name, idempotencyKey),
      body,
    });
    return this.finish(workspaceId, accepted, wait);
  }

  /** Get a VM (`id` is filled from `_id`). */
  async get(args: { workspaceId: string; vmId: string }): Promise<TVm> {
    validateWorkspaceId(args.workspaceId);
    return this.fetchVm(args.workspaceId, validateVmId(args.vmId));
  }

  /**
   * Delete a VM. A VM with an auto-assigned public IP must say what happens
   * to it: `publicIpAction` `release` (default, as in the portal) or
   * `reserve` (keeps the address as a billed Reserved IP; needs
   * `reservedIpBillingCatalog`). When `publicIpAction` is omitted the SDK
   * reads the VM to decide, and refuses VMs that are already deleting.
   */
  async delete(args: {
    workspaceId: string;
    vmId: string;
    idempotencyKey?: string;
    publicIpAction?: PublicIpAction;
    /** Label for the new Reserved IP (default: the VM name). */
    reservedIpLabel?: string;
    /**
     * Reserved IP SKU, required with `reserve`. The public API cannot list it
     * yet: copy `billing_catalog` from an existing Reserved IP in the same site.
     */
    reservedIpBillingCatalog?: BillingCatalogSelection;
    /** Check billing eligibility for the Reserved IP first (reserve only). */
    preflightBilling?: boolean;
    requestedBy?: string;
  } & VmActionOptions): Promise<OperationAcceptedResult> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    validateRequestedBy(args.requestedBy);
    let body: Record<string, unknown> | undefined;
    if (args.publicIpAction === "release" && !args.checkState) {
      body = { public_ip_action: "release" };
    } else {
      if (args.publicIpAction !== undefined && args.publicIpAction !== "reserve" && args.publicIpAction !== "release") {
        fail("publicIpAction must be 'reserve' or 'release'.", "invalid_public_ip_action", "public_ip_action");
      }
      const vm = await this.fetchVm(args.workspaceId, vmId);
      assertVmActionAllowed(vm, "delete");
      body = resolveDeletePublicIpAction(vm, args);
      if (body?.public_ip_action === "reserve") {
        const catalog = validateBillingCatalog(args.reservedIpBillingCatalog, {
          context: "reservedIpBillingCatalog",
          field: "reserved_ip_billing_catalog",
        });
        body.reserved_ip_billing_catalog = catalog;
        if (args.preflightBilling) {
          await this.billing.requireResourceEligibility({
            workspaceId: args.workspaceId,
            skuCode: catalog.sku_code,
            resourceType: "reserved_ip",
          });
        }
      }
    }
    if (args.requestedBy !== undefined) body = { ...(body ?? {}), requested_by: args.requestedBy };
    const accepted = await this.http.request<OperationAccepted>({
      method: "DELETE",
      path: this.base(vmId),
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("delete", vmId, args.idempotencyKey),
      body,
    });
    return this.finish(args.workspaceId, accepted, args.wait);
  }

  private async action(
    args: { workspaceId: string; vmId: string; force?: boolean; idempotencyKey?: string } & VmActionOptions,
    action: "start" | "stop" | "reboot",
  ): Promise<OperationAcceptedResult> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    if (args.force !== undefined && typeof args.force !== "boolean") {
      fail("force must be a boolean.", "invalid_force", "force");
    }
    if (args.checkState) await this.checkVm(args.workspaceId, vmId, action);
    const accepted = await this.http.request<OperationAccepted>({
      method: "POST",
      path: `${this.base(vmId)}/actions/${action}`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key(action, vmId, args.idempotencyKey),
      body: args.force === undefined ? undefined : { force: args.force },
    });
    return this.finish(args.workspaceId, accepted, args.wait);
  }

  /** Start a VM (portal: only when stopped; checked with `checkState`). */
  start(args: {
    workspaceId: string;
    vmId: string;
    force?: boolean;
    idempotencyKey?: string;
  } & VmActionOptions): Promise<OperationAcceptedResult> {
    return this.action(args, "start");
  }

  /** Stop a VM (portal: only when running; checked with `checkState`). */
  stop(args: {
    workspaceId: string;
    vmId: string;
    force?: boolean;
    idempotencyKey?: string;
  } & VmActionOptions): Promise<OperationAcceptedResult> {
    return this.action(args, "stop");
  }

  /** Reboot a VM (portal: only when running; checked with `checkState`). */
  reboot(args: {
    workspaceId: string;
    vmId: string;
    force?: boolean;
    idempotencyKey?: string;
  } & VmActionOptions): Promise<OperationAcceptedResult> {
    return this.action(args, "reboot");
  }

  async getMetrics(args: { workspaceId: string; vmId: string }): Promise<VmMetrics> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "GET",
      path: `${this.base(validateVmId(args.vmId))}/metrics`,
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Update SSH keys, reset the password or toggle SSH password login.
   * `ssh_key_mode` is required with keys; `new_password` needs 8+ characters
   * without line breaks. With `checkState` the VM must be a running Linux VM
   * and the last-key / password-login rules are checked; `admin_username`
   * defaults to the VM's admin user on a password reset.
   */
  async updateAccess(args: {
    workspaceId: string;
    vmId: string;
    request: VmAccessUpdateRequest;
    idempotencyKey?: string;
  } & VmActionOptions): Promise<OperationAcceptedResult> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const body = validateAccessUpdate(args.request as Record<string, unknown>);
    validateRequestedBy(body.requested_by);
    if (args.checkState) {
      const vm = await this.fetchVm(args.workspaceId, vmId);
      validateAccessUpdateAgainstVm(vm, body);
      if (body.new_password && !body.admin_username && vm.admin_username) body.admin_username = vm.admin_username;
    }
    const accepted = await this.http.request<OperationAccepted>({
      method: "PATCH",
      path: `${this.base(vmId)}/actions/access`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("access", vmId, args.idempotencyKey),
      body,
    });
    return this.finish(args.workspaceId, accepted, args.wait);
  }

  /** Resolve `plan_id` to a target shape (and SKU) for this VM's site. */
  private async planTarget(
    workspaceId: string,
    vm: TVm,
    planId: string,
    term: BillingTerm | undefined,
  ): Promise<{ plan: ComputePlan; billingCatalog: BillingCatalogSelection }> {
    const siteId = String(vm.site_id ?? "").trim();
    if (!siteId) fail("The VM has no site, so its plans cannot be listed.", "invalid_plan", "plan_id");
    const plan = await this.findPlan(workspaceId, siteId, planId);
    if (!plan.billing_catalog) fail("Selected plan is missing Billing catalog data", "invalid_plan", "plan_id");
    const base = validateBillingCatalog(plan.billing_catalog, { context: "Selected plan" });
    const priced =
      billingOptionsOf(base).length === 0 && term === undefined
        ? base
        : applyBillingTerm(base, term ?? "HOURLY").catalog;
    let license: unknown;
    if (isWindowsVm(vm)) {
      license = (vm.billing_catalog as BillingCatalogSelection | null | undefined)?.attached_skus?.windows_license;
      if (!license) {
        fail(
          "This Windows VM has no Windows licence SKU on record, so it cannot be resized to a plan through the API.",
          "windows_license_required",
          "billing_catalog",
        );
      }
    }
    return { plan, billingCatalog: withAttachedBillingSkus(priced, { windows_license: license }, "Selected plan") };
  }

  /** Build the resize target from a request (plan or explicit shape). */
  private async resizeTarget(
    workspaceId: string,
    vmId: string,
    request: VmResizeRequest,
  ): Promise<{ body: Record<string, unknown>; vm?: TVm }> {
    if (!isRecord(request)) fail("request must be an object.", "invalid_resize_target", "request");
    validateRequestedBy(request.requested_by);
    const planId = request.plan_id === undefined || request.plan_id === null ? undefined : String(request.plan_id).trim();
    const term = request.billing_term === undefined || request.billing_term === null ? undefined : normaliseBillingTerm(request.billing_term);
    if (planId) {
      if (request.cpu !== undefined || request.ram_mb !== undefined || request.disk_gb !== undefined) {
        fail("Pass plan_id or cpu/ram_mb/disk_gb, not both.", "invalid_resize_target", "plan_id");
      }
      const vm = await this.fetchVm(workspaceId, vmId);
      const { plan, billingCatalog } = await this.planTarget(workspaceId, vm, planId, term);
      const body: Record<string, unknown> = {
        cpu: plan.cpu,
        ram_mb: plan.ram_mb,
        disk_gb: plan.disk_gb,
        billing_catalog: request.billing_catalog ? validateBillingCatalog(request.billing_catalog) : billingCatalog,
      };
      validateResizeTarget(body);
      if (request.requested_by !== undefined) body.requested_by = request.requested_by;
      return { body, vm };
    }
    if (term !== undefined && !request.billing_catalog) {
      fail("billing_term needs plan_id (or an explicit billing_catalog).", "invalid_resize_target", "billing_term");
    }
    validateResizeTarget(request);
    const body: Record<string, unknown> = {};
    for (const k of ["cpu", "ram_mb", "disk_gb", "requested_by"] as const) {
      if (request[k] !== undefined && request[k] !== null) body[k] = request[k];
    }
    if (request.billing_catalog) {
      const cat = validateBillingCatalog(request.billing_catalog);
      body.billing_catalog = term === undefined ? cat : applyBillingTerm(cat, term).catalog;
    }
    return { body };
  }

  /**
   * Check whether a resize can run in place. Pass `plan_id` (resolved from
   * the VM's site) or an explicit cpu/ram_mb/disk_gb target.
   */
  async precheckResize(args: {
    workspaceId: string;
    vmId: string;
    request: VmResizeRequest;
  }): Promise<VmResizePrecheck> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const { body } = await this.resizeTarget(args.workspaceId, vmId, args.request);
    return this.postPrecheck(args.workspaceId, vmId, body);
  }

  private postPrecheck(workspaceId: string, vmId: string, target: Record<string, unknown>): Promise<VmResizePrecheck> {
    const body: Record<string, unknown> = {};
    for (const k of ["cpu", "ram_mb", "disk_gb", "requested_by"]) {
      if (target[k] !== undefined) body[k] = target[k];
    }
    return this.http.request({
      method: "POST",
      path: `${this.base(vmId)}/actions/resize/precheck`,
      workspaceId,
      body,
    });
  }

  /**
   * Resize a VM like the portal: resolve `plan_id` (cpu/ram/disk and the plan
   * SKU for `billing_term`, carrying a Windows licence over), run the precheck
   * and submit only when the decision is `in_place`. Otherwise throws
   * IbeeValidationError (`resize_not_in_place`) with the precheck in
   * `details`.
   */
  async resize(args: {
    workspaceId: string;
    vmId: string;
    request: VmResizeRequest;
    idempotencyKey?: string;
    /** Skip the precheck gate (not recommended). */
    skipPrecheck?: boolean;
  } & VmActionOptions): Promise<OperationAcceptedResult> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const { body, vm } = await this.resizeTarget(args.workspaceId, vmId, args.request);
    if (args.checkState) assertVmActionAllowed(vm ?? (await this.fetchVm(args.workspaceId, vmId)), "resize");
    if (!args.skipPrecheck) {
      const precheck = await this.postPrecheck(args.workspaceId, vmId, body);
      if (precheck?.decision !== "in_place") {
        const decision = String(precheck?.decision ?? "unknown");
        const reasons = Array.isArray(precheck?.reasons) ? precheck.reasons : [];
        fail(
          [RESIZE_BLOCK_MESSAGES[decision] ?? `Resize precheck returned '${decision}'.`, ...reasons].join(" "),
          "resize_not_in_place",
          "request",
          precheck,
        );
      }
    }
    const accepted = await this.http.request<OperationAccepted>({
      method: "POST",
      path: `${this.base(vmId)}/actions/resize`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("resize", vmId, args.idempotencyKey),
      body,
    });
    return this.finish(args.workspaceId, accepted, args.wait);
  }

  /**
   * Change CPU/RAM only. The SDK reads the VM first: an identical shape is
   * rejected, and a downgrade needs `confirm_downgrade: true`.
   */
  async resizePlan(args: {
    workspaceId: string;
    vmId: string;
    request: VmResizePlanRequest;
    idempotencyKey?: string;
  } & VmActionOptions): Promise<OperationAcceptedResult> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const req = args.request;
    if (!isRecord(req)) fail("request must be an object.", "invalid_resize_target", "request");
    if (req.cpu === undefined || req.ram_mb === undefined) {
      fail("cpu and ram_mb are required.", "invalid_resize_target", "request");
    }
    validateResizeTarget({ cpu: req.cpu, ram_mb: req.ram_mb });
    validateRequestedBy(req.requested_by);
    const vm = await this.fetchVm(args.workspaceId, vmId);
    if (args.checkState) assertVmActionAllowed(vm, "resize-plan");
    validateResizePlanChange(vm, req);
    const body: Record<string, unknown> = { ...req };
    if (req.billing_catalog) body.billing_catalog = validateBillingCatalog(req.billing_catalog);
    const accepted = await this.http.request<OperationAccepted>({
      method: "PATCH",
      path: `${this.base(vmId)}/actions/resize-plan`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("resize-plan", vmId, args.idempotencyKey),
      body,
    });
    return this.finish(args.workspaceId, accepted, args.wait);
  }

  /** Grow the root disk; the new size must exceed the current one (read from the VM). */
  async resizeRootDisk(args: {
    workspaceId: string;
    vmId: string;
    request: VmResizeRootDiskRequest;
    idempotencyKey?: string;
  } & VmActionOptions): Promise<OperationAcceptedResult> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const req = args.request;
    if (!isRecord(req)) fail("request must be an object.", "invalid_resize_target", "request");
    validateRootDiskGrow(req.new_size_gb);
    validateRequestedBy(req.requested_by);
    const vm = await this.fetchVm(args.workspaceId, vmId);
    if (args.checkState) assertVmActionAllowed(vm, "resize-root-disk");
    validateRootDiskGrow(req.new_size_gb, vm.disk_gb);
    const body: Record<string, unknown> = { ...req };
    if (req.billing_catalog) body.billing_catalog = validateBillingCatalog(req.billing_catalog);
    const accepted = await this.http.request<OperationAccepted>({
      method: "PATCH",
      path: `${this.base(vmId)}/actions/resize-root-disk`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("resize-root-disk", vmId, args.idempotencyKey),
      body,
    });
    return this.finish(args.workspaceId, accepted, args.wait);
  }

  // --------------------------------------------------------------- volumes

  /**
   * Attach a block volume. Like the portal, the SDK reads the volume first:
   * it must be unattached, not busy, and in the VM's site; its Block Storage
   * SKU becomes `billing_catalog` when you do not pass one. With `wait` the
   * operation is polled every 2 s for up to 2 minutes.
   */
  async attachVolume(args: {
    workspaceId: string;
    vmId: string;
    request: VmAttachVolumeRequest;
    idempotencyKey?: string;
  } & VmActionOptions): Promise<OperationAcceptedResult> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const req = args.request;
    if (!isRecord(req)) fail("request must be an object.", "invalid_attach", "request");
    const volumeId = validateRequiredId(req.volume_id, "volume_id");
    const mode = req.mode ?? "single-writer";
    if (!(VM_VOLUME_MODES as readonly string[]).includes(mode)) {
      fail("mode must be 'single-writer' or 'multi-writer'.", "invalid_attach", "mode");
    }
    validateRequestedBy(req.requested_by);
    const volume = await this.http.request<BlockVolume>({
      method: "GET",
      path: `/block-storage/volumes/${encodeURIComponent(volumeId)}`,
      workspaceId: args.workspaceId,
    });
    if (Array.isArray(volume?.attachments) && volume.attachments.length > 0) {
      fail("Volume is already attached.", "volume_attached", "volume_id");
    }
    const state = String(volume?.state ?? "").toLowerCase();
    if (VOLUME_BUSY_STATES.has(state)) {
      fail(`Volume is currently ${state}. Retry attach once workflow completes.`, "volume_busy", "volume_id");
    }
    const volumeSite = String(volume?.site_id ?? "").trim();
    if (volumeSite || args.checkState) {
      const vm = await this.fetchVm(args.workspaceId, vmId);
      const vmSite = String(vm.site_id ?? "").trim();
      if (volumeSite && vmSite && volumeSite !== vmSite) {
        fail(`Select a server in ${volume.site_name || volumeSite}.`, "site_mismatch", "vm_id");
      }
      if (args.checkState) assertVmActionAllowed(vm, "resize");
    }
    const rawCatalog = req.billing_catalog ?? volume?.billing_catalog ?? volume?.metadata?.billing_catalog;
    if (!rawCatalog) {
      fail(`Block volume ${volume?.name ?? volumeId} is missing Billing catalog data`, "invalid_billing_catalog", "billing_catalog");
    }
    const billingCatalog = validateBillingCatalog(rawCatalog, {
      context: `Block volume ${volume?.name ?? volumeId}`,
      expectedProduct: "block_storage",
    });
    const body: Record<string, unknown> = { volume_id: volumeId, mode, billing_catalog: billingCatalog };
    if (req.requested_by !== undefined) body.requested_by = req.requested_by;
    const accepted = await this.http.request<OperationAccepted>({
      method: "POST",
      path: `${this.base(vmId)}/actions/attach-volume`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("attach-volume", `${volumeId}-${vmId}`, args.idempotencyKey),
      body,
    });
    return this.finish(args.workspaceId, accepted, args.wait, { timeoutMs: 120_000, pollIntervalMs: 2_000 });
  }

  /**
   * Detach a block volume. Confirm it is unmounted in the guest
   * (`confirm_unmounted: true`) or pass `force: true`. With `checkState` the
   * volume must be attached to this VM.
   */
  async detachVolume(args: {
    workspaceId: string;
    vmId: string;
    request: VmDetachVolumeRequest;
    idempotencyKey?: string;
  } & VmActionOptions): Promise<OperationAcceptedResult> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const req = args.request;
    if (!isRecord(req)) fail("request must be an object.", "invalid_detach", "request");
    const volumeId = validateRequiredId(req.volume_id, "volume_id");
    validateDetachConfirmation(req);
    validateRequestedBy(req.requested_by);
    if (args.checkState) {
      const volume = await this.http.request<BlockVolume>({
        method: "GET",
        path: `/block-storage/volumes/${encodeURIComponent(volumeId)}`,
        workspaceId: args.workspaceId,
      });
      const attached = (volume?.attachments ?? []).some((a) => String(a?.vm_id ?? "") === vmId);
      if (!attached) fail("The volume is not attached to this VM.", "volume_not_attached", "volume_id");
    }
    const accepted = await this.http.request<OperationAccepted>({
      method: "POST",
      path: `${this.base(vmId)}/actions/detach-volume`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("detach-volume", `${volumeId}-${vmId}`, args.idempotencyKey),
      body: { ...req, volume_id: volumeId },
    });
    return this.finish(args.workspaceId, accepted, args.wait, { timeoutMs: 120_000, pollIntervalMs: 2_000 });
  }

  async acknowledgeMountGuidance(args: {
    workspaceId: string;
    vmId: string;
    volumeId: string;
  }): Promise<MountGuidanceAcknowledge> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const volumeId = validateRequiredId(args.volumeId, "volume_id");
    return this.http.request({
      method: "POST",
      path: `${this.base(vmId)}/mount-guidance/acknowledge`,
      workspaceId: args.workspaceId,
      body: { volume_id: volumeId },
    });
  }

  // ---------------------------------------------------------- observability

  /** VM event timeline (limit 1..500, server default 100). */
  async listEvents(args: {
    workspaceId: string;
    vmId: string;
    limit?: number;
  }): Promise<VmEvent[]> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    validateIntRange(args.limit, "limit", 1, 500);
    return this.http.request({
      method: "GET",
      path: `${this.base(vmId)}/events`,
      workspaceId: args.workspaceId,
      query: { limit: args.limit },
    });
  }

  async getMetricsTimeseries(args: {
    workspaceId: string;
    vmId: string;
    range?: VmMetricsRange;
  }): Promise<VmMetricsTimeseries> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    validateMetricsRange(args.range);
    return this.http.request({
      method: "GET",
      path: `${this.base(vmId)}/metrics/timeseries`,
      workspaceId: args.workspaceId,
      query: { range: args.range },
    });
  }

  /** Monthly bandwidth; `month` is `YYYY-MM` (default: the current UTC month). */
  async getBandwidth(args: {
    workspaceId: string;
    vmId: string;
    month?: string;
  }): Promise<VmBandwidthSummary> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const now = new Date();
    const month = validateBandwidthMonth(
      args.month ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
    );
    return this.http.request({
      method: "GET",
      path: `${this.base(vmId)}/metrics/bandwidth`,
      workspaceId: args.workspaceId,
      query: { month },
    });
  }

  // ------------------------------------------------------------- snapshots

  /**
   * Create a snapshot set. `billing_catalog` is required by the API: pass the
   * snapshot storage SKU (product `snapshot_storage`, SKU `SNAPSHOT-STD`),
   * e.g. the `billing_catalog` of an existing snapshot set. `mode: "selective"`
   * needs `selected_data_volume_ids`. Never retried automatically.
   */
  async createSnapshot(args: {
    workspaceId: string;
    vmId: string;
    request: SnapshotCreateRequest;
    /** Billing eligibility check for the snapshot SKU first. */
    preflightBilling?: boolean;
    /** Read the VM: refuse busy states and unattached selected volumes. */
    checkState?: boolean;
    /** Wait until the snapshot is ready (failure shows as a timeout). */
    wait?: boolean | RecoveryWaitOptions;
  }): Promise<SnapshotSet> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const body = validateSnapshotCreate(args.request as unknown as Record<string, unknown>);
    if (args.request?.billing_catalog === undefined || args.request?.billing_catalog === null) {
      fail(
        "billing_catalog is required: pass the snapshot storage SKU (product snapshot_storage, SKU SNAPSHOT-STD), for example the billing_catalog of an existing snapshot set.",
        "billing_catalog_required",
        "billing_catalog",
      );
    }
    const catalog = validateBillingCatalog(args.request.billing_catalog, {
      context: "Snapshot billing_catalog",
      expectedProduct: "snapshot_storage",
    });
    body.billing_catalog = catalog;
    if (args.checkState) {
      const vm = await this.fetchVm(args.workspaceId, vmId);
      const status = String(vm.status ?? "").toLowerCase();
      if (SNAPSHOT_BLOCKED_STATES.has(status)) {
        fail(`Snapshots are unavailable while the VM is ${status}.`, "vm_state_conflict", "status");
      }
      const selected = body.selected_data_volume_ids as string[];
      if (selected.length && Array.isArray(vm.data_volumes)) {
        const attached = new Set(vm.data_volumes.map((d) => String(d?.volume_id ?? "")));
        const missing = selected.filter((id) => !attached.has(id));
        if (missing.length) {
          fail(`Selected data volume(s) are not attached to this VM: ${missing.join(", ")}.`, "invalid_snapshot_volumes", "selected_data_volume_ids");
        }
      }
    }
    if (args.preflightBilling) {
      await this.billing.requireResourceEligibility({
        workspaceId: args.workspaceId,
        skuCode: catalog.sku_code,
        resourceType: "snapshot",
      });
    }
    const snapshot = await this.http.request<SnapshotSet>({
      method: "POST",
      path: `${this.base(vmId)}/snapshots`,
      workspaceId: args.workspaceId,
      body,
    });
    const opts = args.wait === true ? {} : args.wait || undefined;
    if (!opts) return snapshot;
    const status = String(snapshot?.status ?? "").toLowerCase();
    if (RECOVERY_TERMINAL_SUCCESS.has(status)) return snapshot;
    if (RECOVERY_TERMINAL_FAILURE.has(status)) {
      throw new RecoveryFailedError("snapshot", snapshot as unknown as Record<string, unknown>, snapshot.snapshot_set_id);
    }
    // The snapshot is readable only once it has succeeded; until then GET is 404.
    return this.pollRecovery<SnapshotSet>(
      "snapshot",
      snapshot.snapshot_set_id,
      async () => {
        try {
          return await this.getSnapshot({ workspaceId: args.workspaceId, snapshotSetId: snapshot.snapshot_set_id });
        } catch (err) {
          if (err instanceof NotFoundError) return { ...snapshot, status: "running" as BackupStatus };
          throw err;
        }
      },
      opts,
    );
  }

  async listSnapshots(args: {
    workspaceId: string;
    vmId: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<SnapshotSetList> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    return this.http.request({
      method: "GET",
      path: `${this.base(vmId)}/snapshots`,
      workspaceId: args.workspaceId,
      query: recoveryListQuery(args),
    });
  }

  /**
   * Restore a snapshot set: `replace` (default), `new_vm` or `volume_only`.
   * The SDK checks the snapshot is ready and the mode combination; for
   * `new_vm` it resolves the target plan (the given `target_plan_id`, else
   * the VM's plan) into the `target_*` fields and `target_billing_catalog`,
   * and fills the portal's default VM and volume names. `auto_start`
   * defaults to true.
   */
  async restoreSnapshot(args: {
    workspaceId: string;
    vmId: string;
    snapshotSetId: string;
    request?: SnapshotRestoreRequest;
    /** Require the VM to be running or stopped. */
    checkState?: boolean;
    wait?: boolean | RecoveryWaitOptions;
  }): Promise<RecoveryRestore> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const snapshotSetId = validateRequiredId(args.snapshotSetId, "snapshot_set_id");
    const body = validateRestoreRequest({ ...(args.request ?? {}) }, "snapshot");
    validateRequestedBy(body.requested_by);
    const snapshot = await this.getSnapshot({ workspaceId: args.workspaceId, snapshotSetId });
    const status = String(snapshot?.status ?? "").toLowerCase();
    if (status && status !== "succeeded" && status !== "available") {
      fail("Only ready snapshot sets can be restored.", "recovery_point_not_ready", "snapshot_set_id");
    }
    await this.prepareRestore(args.workspaceId, vmId, body, snapshot, "snapshot", args.checkState);
    if (body.auto_start === undefined) body.auto_start = true;
    const restore = await this.http.request<RecoveryRestore>({
      method: "POST",
      path: `${this.snapshotBase(snapshotSetId)}/actions/restore`,
      workspaceId: args.workspaceId,
      query: { vm_id: vmId },
      body,
    });
    const opts = args.wait === true ? {} : args.wait || undefined;
    return opts ? this.waitForSnapshotRestore({ workspaceId: args.workspaceId, restoreId: restore.restore_id, ...opts }) : restore;
  }

  /** Shared new_vm / volume_only preparation for snapshot and backup restores. */
  private async prepareRestore(
    workspaceId: string,
    vmId: string,
    body: Record<string, unknown>,
    point: { volume_manifest?: SnapshotSet["volume_manifest"]; created_at?: string | null },
    kind: RecoveryKind,
    checkState?: boolean,
  ): Promise<void> {
    const mode = body.target_mode;
    const manifest = point.volume_manifest ?? [];
    if (mode === "replace" && !checkState) return;
    const vm = await this.fetchVm(workspaceId, vmId);
    if (checkState) {
      const s = String(vm.status ?? "").toLowerCase();
      if (s !== "running" && s !== "stopped") {
        fail(`${kind === "snapshot" ? "Snapshot" : "Backup"} restore is unavailable while the VM is ${s || "unknown"}.`, "vm_state_conflict", "status");
      }
    }
    if (mode === "volume_only") {
      const selected = String(body.selected_volume_id);
      const item = manifest.find((m) => String(m.source_volume_id) === selected);
      if (manifest.length && !item) {
        fail(`selected_volume_id '${selected}' is not part of this ${kind}.`, "invalid_restore", "selected_volume_id");
      }
      if (kind === "snapshot" && item) {
        const role = String(item.role ?? "").toLowerCase();
        const v = vm as Record<string, unknown>;
        const rootIds = ["root_volume_active_id", "root_volume_clone_id", "root_volume_full_id", "volume_id"]
          .map((k) => String(v[k] ?? "").trim())
          .filter(Boolean);
        const dataIds = Array.isArray(vm.data_volumes) ? vm.data_volumes.map((d) => String(d?.volume_id ?? "")) : undefined;
        const known = role === "root" ? rootIds.length > 0 : dataIds !== undefined;
        const attached = role === "root" ? rootIds.includes(selected) : (dataIds ?? []).includes(selected);
        if (known && !attached) {
          fail(
            "The selected snapshot disk is no longer attached to this VM. Use Create New VM to restore the captured topology, or select a currently attached disk.",
            "invalid_restore",
            "selected_volume_id",
          );
        }
      }
      return;
    }
    if (mode !== "new_vm") return;
    const minRoot = recoveryMinRootDiskGb(manifest);
    const planId = String(body.target_plan_id ?? vm.plan_id ?? "").trim();
    if (planId && (body.target_cpu === undefined || !body.target_billing_catalog)) {
      const siteId = String(body.target_site_id ?? vm.site_id ?? "").trim();
      if (!siteId) fail("Select a valid compute plan for the restored VM", "invalid_restore", "target_plan_id");
      const plan = await this.findPlan(workspaceId, siteId, planId, "target_plan_id");
      if (minRoot > 0 && Number(plan.disk_gb) < minRoot) {
        fail(`Plan '${planId}' has a ${plan.disk_gb} GB disk; this ${kind} needs at least ${minRoot} GB. Choose a larger plan.`, "invalid_restore", "target_plan_id");
      }
      const mapped = restoreTargetFromPlan(plan, vm);
      for (const [k, v] of Object.entries(mapped)) if (body[k] === undefined || body[k] === null) body[k] = v;
    }
    if (body.target_billing_catalog) {
      body.target_billing_catalog = validateBillingCatalog(body.target_billing_catalog, {
        context: "target_billing_catalog",
        field: "target_billing_catalog",
      });
    }
    if (body.target_vm_name === undefined || body.target_vm_name === null) {
      body.target_vm_name = recoveryDefaultVmName(vm.name, kind, point.created_at);
    }
    body.target_volume_names = recoveryTargetVolumeNames(
      manifest,
      kind,
      point.created_at,
      (body.target_volume_names as Record<string, string> | undefined) ?? undefined,
    );
    if (Object.keys(body.target_volume_names as object).length === 0) delete body.target_volume_names;
    validateNewVmTarget(body, minRoot);
  }

  async getSnapshot(args: {
    workspaceId: string;
    snapshotSetId: string;
  }): Promise<SnapshotSet> {
    return this.http.request({
      method: "GET",
      path: this.snapshotBase(validateRequiredId(args.snapshotSetId, "snapshot_set_id")),
      workspaceId: args.workspaceId,
    });
  }

  async deleteSnapshot(args: {
    workspaceId: string;
    snapshotSetId: string;
  }): Promise<SnapshotDeleteResult> {
    return this.http.request({
      method: "DELETE",
      path: this.snapshotBase(validateRequiredId(args.snapshotSetId, "snapshot_set_id")),
      workspaceId: args.workspaceId,
    });
  }

  async getSnapshotRestore(args: {
    workspaceId: string;
    restoreId: string;
  }): Promise<RecoveryRestore> {
    const restoreId = validateRequiredId(args.restoreId, "restore_id");
    return this.http.request({
      method: "GET",
      path: `${this.snapshotBase()}/restores/${encodeURIComponent(restoreId)}`,
      workspaceId: args.workspaceId,
    });
  }

  private async pollRecovery<T>(
    kind: string,
    id: string,
    fetchFn: () => Promise<T>,
    opts: RecoveryWaitOptions,
  ): Promise<T> {
    const { timeoutMs, pollIntervalMs } = validateWaitOptions(opts.timeoutMs ?? 1_800_000, opts.pollIntervalMs ?? 5_000);
    const result = await pollUntil<T>(fetchFn, (v) => (v as { status?: unknown })?.status, {
      operationId: id,
      timeoutMs,
      pollIntervalMs,
      success: RECOVERY_TERMINAL_SUCCESS,
      failure: RECOVERY_TERMINAL_FAILURE,
      raiseOnFailure: false,
      signal: opts.signal,
      onUpdate: opts.onUpdate as ((v: T) => void) | undefined,
    });
    const status = String((result as { status?: unknown })?.status ?? "").toLowerCase();
    if (RECOVERY_TERMINAL_FAILURE.has(status)) {
      const rec = result as unknown as Record<string, unknown>;
      throw kind === "restore" ? new RecoveryRestoreFailedError(rec, id) : new RecoveryFailedError(kind, rec, id);
    }
    return result;
  }

  /**
   * Poll a snapshot restore every 5 s (default timeout 30 min) until it
   * succeeds; throws RecoveryRestoreFailedError on failed/cancelled.
   */
  waitForSnapshotRestore(args: { workspaceId: string; restoreId: string } & RecoveryWaitOptions): Promise<RecoveryRestore> {
    validateWorkspaceId(args.workspaceId);
    const restoreId = validateRequiredId(args.restoreId, "restore_id");
    return this.pollRecovery("restore", restoreId, () => this.getSnapshotRestore({ workspaceId: args.workspaceId, restoreId }), args);
  }

  // --------------------------------------------------------------- backups

  async getBackupPolicy(args: {
    workspaceId: string;
    vmId: string;
  }): Promise<BackupPolicy> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "GET",
      path: `${this.base(validateVmId(args.vmId))}/backups/policy`,
      workspaceId: args.workspaceId,
    });
  }

  /** The backup policy, or null when the VM has none yet (404). */
  async getBackupPolicyOrNull(args: { workspaceId: string; vmId: string }): Promise<BackupPolicy | null> {
    try {
      return await this.getBackupPolicy(args);
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  /**
   * Update schedule/retention of an enabled policy. The SDK merges your
   * schedule into the saved one (the API replaces it wholesale) and checks
   * the portal rules; a missing or disabled policy is rejected (call
   * `enableBackups`).
   */
  async updateBackupPolicy(args: {
    workspaceId: string;
    vmId: string;
    request?: BackupPolicyUpdateRequest;
  }): Promise<BackupPolicy> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const req = { ...(args.request ?? {}) } as Record<string, unknown>;
    validateBackupRetention(req);
    validateRequestedBy(req.requested_by);
    const changes = ["schedule", "retention_days", "full_backup_interval_days", "incremental_enabled", "billing_catalog"];
    if (!changes.some((k) => req[k] !== undefined && req[k] !== null)) {
      fail("Provide at least one of schedule, retention_days, full_backup_interval_days, incremental_enabled or billing_catalog.", "no_changes", "request");
    }
    if (req.billing_catalog) {
      req.billing_catalog = validateBillingCatalog(req.billing_catalog, {
        context: "Backup billing_catalog",
        expectedProduct: "backup_storage",
      });
    }
    const policy = await this.getBackupPolicyOrNull({ workspaceId: args.workspaceId, vmId });
    if (!policy || policy.enabled === false) {
      fail("Backups are disabled for this VM; call enableBackups first.", "backups_disabled", "vm_id");
    }
    if (req.schedule !== undefined && req.schedule !== null) {
      const saved = { ...((policy as BackupPolicy).schedule ?? {}) } as Record<string, unknown>;
      if (isRecord(req.schedule) && req.schedule.frequency === "daily") delete saved.day_of_week;
      req.schedule = validateBackupSchedule(req.schedule as Record<string, unknown>, saved);
    }
    return this.http.request({
      method: "PATCH",
      path: `${this.base(vmId)}/backups/policy`,
      workspaceId: args.workspaceId,
      body: req,
    });
  }

  /**
   * Enable backups. `billing_catalog` is required by the API: pass the backup
   * storage SKU (product `backup_storage`, SKU `BACKUP-STD`). On re-enable
   * without schedule/retention the saved policy values are re-sent; on first
   * enable the portal defaults apply (daily at 12:00 UTC, 30-minute window,
   * 7-day retention, weekly full backup, incremental on). Schedules are
   * daily or weekly (`day_of_week` 0 = Monday).
   */
  async enableBackups(args: {
    workspaceId: string;
    vmId: string;
    request?: BackupPolicyEnableRequest;
    preflightBilling?: boolean;
  }): Promise<BackupPolicy> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const req = { ...(args.request ?? {}) } as Record<string, unknown>;
    if (req.billing_catalog === undefined || req.billing_catalog === null) {
      fail(
        "billing_catalog is required: pass the backup storage SKU (product backup_storage, SKU BACKUP-STD), for example the billing_catalog of an existing backup run.",
        "billing_catalog_required",
        "billing_catalog",
      );
    }
    const catalog = validateBillingCatalog(req.billing_catalog, {
      context: "Backup billing_catalog",
      expectedProduct: "backup_storage",
    });
    validateBackupRetention(req);
    validateRequestedBy(req.requested_by);
    if (req.schedule !== undefined && req.schedule !== null) validateBackupSchedule(req.schedule as Record<string, unknown>);
    const policy = await this.getBackupPolicyOrNull({ workspaceId: args.workspaceId, vmId });
    const noSettings = ["schedule", "retention_days", "full_backup_interval_days", "incremental_enabled"].every(
      (k) => req[k] === undefined || req[k] === null,
    );
    const body: Record<string, unknown> = { billing_catalog: catalog };
    if (policy?.policy_id && noSettings) {
      // Re-enable: re-send the saved settings unchanged (portal behaviour).
      body.schedule = policy.schedule;
      body.retention_days = policy.retention_days;
      body.full_backup_interval_days = policy.full_backup_interval_days;
      body.incremental_enabled = policy.incremental_enabled;
    } else {
      body.schedule = validateBackupSchedule((req.schedule as Record<string, unknown>) ?? {});
      body.retention_days = req.retention_days ?? 7;
      body.full_backup_interval_days = req.full_backup_interval_days ?? 7;
      body.incremental_enabled = req.incremental_enabled ?? true;
    }
    if (req.requested_by !== undefined) body.requested_by = req.requested_by;
    if (args.preflightBilling) {
      await this.billing.requireResourceEligibility({
        workspaceId: args.workspaceId,
        skuCode: catalog.sku_code,
        resourceType: "backup",
      });
    }
    return this.http.request({
      method: "POST",
      path: `${this.base(vmId)}/backups/enable`,
      workspaceId: args.workspaceId,
      body,
    });
  }

  async disableBackups(args: {
    workspaceId: string;
    vmId: string;
    request?: BackupPolicyDisableRequest;
  }): Promise<BackupPolicy> {
    validateWorkspaceId(args.workspaceId);
    validateRequestedBy(args.request?.requested_by);
    return this.http.request({
      method: "POST",
      path: `${this.base(validateVmId(args.vmId))}/backups/disable`,
      workspaceId: args.workspaceId,
      body: args.request ?? {},
    });
  }

  /** Set the next automated run; `next_run_at` must carry a time zone (or be a Date). */
  async rescheduleBackup(args: {
    workspaceId: string;
    vmId: string;
    request: BackupPolicyNextRunRequest;
  }): Promise<BackupPolicy> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    validateRequestedBy(args.request?.requested_by);
    const body = { ...args.request, next_run_at: validateNextRunAt(args.request?.next_run_at) };
    return this.http.request({
      method: "PATCH",
      path: `${this.base(vmId)}/backups/policy/next-run-at`,
      workspaceId: args.workspaceId,
      body,
    });
  }

  /**
   * Run a manual backup. `billing_catalog` (backup storage SKU) is required
   * by the API. Never retried automatically. With `checkState` the policy
   * must exist and be enabled.
   */
  async createBackupRun(args: {
    workspaceId: string;
    vmId: string;
    request?: ManualBackupRunRequest;
    checkState?: boolean;
    preflightBilling?: boolean;
    /** Wait for the run to succeed (RecoveryFailedError on failure). */
    wait?: boolean | RecoveryWaitOptions;
  }): Promise<BackupRun> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const req = args.request ?? {};
    if (req.billing_catalog === undefined || req.billing_catalog === null) {
      fail(
        "billing_catalog is required: pass the backup storage SKU (product backup_storage, SKU BACKUP-STD), for example the billing_catalog of an existing backup run.",
        "billing_catalog_required",
        "billing_catalog",
      );
    }
    const catalog = validateBillingCatalog(req.billing_catalog, {
      context: "Backup billing_catalog",
      expectedProduct: "backup_storage",
    });
    validateRequestedBy(req.requested_by);
    const reason = normaliseBackupReason(req.reason);
    if (args.checkState) {
      const policy = await this.getBackupPolicyOrNull({ workspaceId: args.workspaceId, vmId });
      if (!policy || policy.enabled !== true) {
        fail("Backup policy is disabled for this VM. Enable backups before creating a backup run.", "backups_disabled", "vm_id");
      }
    }
    if (args.preflightBilling) {
      await this.billing.requireResourceEligibility({
        workspaceId: args.workspaceId,
        skuCode: catalog.sku_code,
        resourceType: "backup",
      });
    }
    const run = await this.http.request<BackupRun>({
      method: "POST",
      path: `${this.base(vmId)}/backups/runs`,
      workspaceId: args.workspaceId,
      body: {
        billing_catalog: catalog,
        ...(reason ? { reason } : {}),
        ...(req.requested_by !== undefined ? { requested_by: req.requested_by } : {}),
      },
    });
    const opts = args.wait === true ? {} : args.wait || undefined;
    if (!opts) return run;
    return this.pollRecovery("backup_run", run.run_id, () => this.getBackupRun({ workspaceId: args.workspaceId, runId: run.run_id }), opts);
  }

  /** Backup runs of one VM (limit 1..200). `restorableOnly` keeps succeeded runs. */
  async listBackupRuns(args: {
    workspaceId: string;
    vmId: string;
    limit?: number;
    offset?: number;
    search?: string;
    restorableOnly?: boolean;
  }): Promise<BackupRunList> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const list = await this.http.request<BackupRunList>({
      method: "GET",
      path: `${this.base(vmId)}/backups/runs`,
      workspaceId: args.workspaceId,
      query: recoveryListQuery(args),
    });
    if (!args.restorableOnly || !Array.isArray(list?.runs)) return list;
    return { ...list, runs: list.runs.filter((r) => String(r.status).toLowerCase() === "succeeded") };
  }

  /**
   * Backup runs across the workspace (the portal Backups page); defaults to
   * succeeded runs. Not yet part of the published API contract; behaviour
   * may change.
   */
  async listAllBackupRuns(args: {
    workspaceId: string;
    vmId?: string;
    /** Default `["succeeded"]` (portal). */
    status?: BackupStatus | BackupStatus[];
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<BackupRunList> {
    validateWorkspaceId(args.workspaceId);
    const query: Record<string, string | number | undefined | Array<string | number>> = recoveryListQuery(args);
    const statuses = args.status === undefined ? ["succeeded"] : Array.isArray(args.status) ? args.status : [args.status];
    for (const s of statuses) {
      if (!(BACKUP_RUN_STATUSES as readonly string[]).includes(s)) {
        fail(`status must be one of ${BACKUP_RUN_STATUSES.join(", ")}.`, "invalid_status", "status");
      }
    }
    query.status = statuses;
    if (args.vmId !== undefined) query.vm_id = validateRequiredId(args.vmId, "vm_id");
    if (this.vmType === "cloud") query.vm_type = "cloud";
    return this.http.request({
      method: "GET",
      path: `${this.backupBase()}/runs`,
      workspaceId: args.workspaceId,
      query,
    });
  }

  async getBackupRun(args: {
    workspaceId: string;
    runId: string;
  }): Promise<BackupRun> {
    const runId = validateRequiredId(args.runId, "run_id");
    return this.http.request({
      method: "GET",
      path: `${this.backupBase()}/runs/${encodeURIComponent(runId)}`,
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Delete a completed backup (recovery point). With `checkState` the run
   * must have succeeded. Not yet part of the published API contract;
   * behaviour may change.
   */
  async deleteBackupRun(args: {
    workspaceId: string;
    runId: string;
    checkState?: boolean;
  }): Promise<BackupRunDeleteResult> {
    validateWorkspaceId(args.workspaceId);
    const runId = validateRequiredId(args.runId, "run_id");
    if (args.checkState) {
      const run = await this.getBackupRun({ workspaceId: args.workspaceId, runId });
      if (String(run?.status ?? "").toLowerCase() !== "succeeded") {
        fail("Only a completed backup can be deleted.", "backup_not_completed", "run_id");
      }
    }
    return this.http.request({
      method: "DELETE",
      path: `${this.backupBase()}/runs/${encodeURIComponent(runId)}`,
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Restore a backup recovery point (`replace`, `new_vm` or `volume_only`).
   * The recovery point must have succeeded; `new_vm` resolves the target plan
   * and default names like `restoreSnapshot`. VPC/SSH fields and
   * `auto_start` are not sent for backups.
   */
  async restoreBackup(args: {
    workspaceId: string;
    vmId: string;
    request: BackupRestoreRequest;
    checkState?: boolean;
    wait?: boolean | RecoveryWaitOptions;
  }): Promise<RecoveryRestore> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    const recoveryPointId = validateRequiredId(args.request?.recovery_point_id, "recovery_point_id");
    const body = validateRestoreRequest({ ...(args.request as unknown as Record<string, unknown>) }, "backup");
    body.recovery_point_id = recoveryPointId;
    delete body.auto_start;
    validateRequestedBy(body.requested_by);
    const run = await this.getBackupRun({ workspaceId: args.workspaceId, runId: recoveryPointId });
    if (String(run?.status ?? "").toLowerCase() !== "succeeded") {
      fail("Only successful backups can be restored.", "recovery_point_not_ready", "recovery_point_id");
    }
    await this.prepareRestore(
      args.workspaceId,
      vmId,
      body,
      { volume_manifest: run.volume_manifest, created_at: run.created_at ?? run.completed_at ?? run.started_at },
      "backup",
      args.checkState,
    );
    const restore = await this.http.request<RecoveryRestore>({
      method: "POST",
      path: `${this.base(vmId)}/backups/actions/restore`,
      workspaceId: args.workspaceId,
      body,
    });
    const opts = args.wait === true ? {} : args.wait || undefined;
    return opts ? this.waitForBackupRestore({ workspaceId: args.workspaceId, restoreId: restore.restore_id, ...opts }) : restore;
  }

  async getBackupRestore(args: {
    workspaceId: string;
    restoreId: string;
  }): Promise<RecoveryRestore> {
    const restoreId = validateRequiredId(args.restoreId, "restore_id");
    return this.http.request({
      method: "GET",
      path: `${this.backupBase()}/restores/${encodeURIComponent(restoreId)}`,
      workspaceId: args.workspaceId,
    });
  }

  /** Poll a backup restore until it finishes (see `waitForSnapshotRestore`). */
  waitForBackupRestore(args: { workspaceId: string; restoreId: string } & RecoveryWaitOptions): Promise<RecoveryRestore> {
    validateWorkspaceId(args.workspaceId);
    const restoreId = validateRequiredId(args.restoreId, "restore_id");
    return this.pollRecovery("restore", restoreId, () => this.getBackupRestore({ workspaceId: args.workspaceId, restoreId }), args);
  }
}

export type CloudVmResource = VmResource<CreateVmRequest, CloudVm>;
export type GpuVmResource = VmResource<CreateGpuVmRequest, GpuVm>;

export class OperationsResource {
  constructor(private readonly http: HttpClient) {}

  async get(args: {
    workspaceId: string;
    operationId: string;
    signal?: AbortSignal;
  }): Promise<OperationStatus> {
    validateWorkspaceId(args.workspaceId);
    const operationId = validateOperationId(args.operationId);
    return this.http.request({
      method: "GET",
      path: `/compute/operations/${encodeURIComponent(operationId)}`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /**
   * Poll an async compute operation until it is terminal.
   *
   * Success: `succeeded` (`completed` is accepted as a legacy alias).
   * Failure: `failed`, `cancelled`, `timed_out` -> OperationFailedError
   * (or the final status when `raiseOnFailure` is false).
   * Deadline passed while still running -> OperationTimeoutError.
   * Up to 3 consecutive transient poll failures (429/502/503/504 or network)
   * are tolerated; 404 and other API errors are thrown at once.
   */
  async wait(args: WaitForOperationArgs): Promise<OperationStatus> {
    validateWorkspaceId(args.workspaceId);
    const operationId = validateOperationId(args.operationId);
    const { timeoutMs, pollIntervalMs } = validateWaitOptions(args.timeoutMs, args.pollIntervalMs);
    return pollUntil<OperationStatus>(
      () => this.get({ workspaceId: args.workspaceId, operationId, signal: args.signal }),
      (op) => op?.status,
      {
        operationId,
        timeoutMs,
        pollIntervalMs,
        raiseOnFailure: args.raiseOnFailure ?? true,
        onUpdate: args.onUpdate,
        signal: args.signal,
      },
    );
  }

  /**
   * `wait` with the portal's volume attach/detach defaults: poll every 2 s
   * for up to 2 minutes.
   */
  waitFor(args: WaitForOperationArgs): Promise<OperationStatus> {
    return this.wait({ timeoutMs: 120_000, pollIntervalMs: 2_000, ...args });
  }
}

export interface WaitForOperationArgs {
  workspaceId: string;
  operationId: string;
  /** Client deadline, 1000..7200000 ms (default 1200000 = 20 min). */
  timeoutMs?: number;
  /** Poll interval, 1000..60000 ms and <= timeoutMs (default 5000). */
  pollIntervalMs?: number;
  /** Throw OperationFailedError on failed/cancelled/timed_out (default true). */
  raiseOnFailure?: boolean;
  /** Aborts the wait; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Called after every successful poll. */
  onUpdate?: (operation: OperationStatus) => void;
}
