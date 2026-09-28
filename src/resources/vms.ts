import type { HttpClient } from "../core.js";
import { buildIdempotencyKey } from "../idempotency.js";
import { collect, paginateOffset } from "../pagination.js";
import { pollUntil } from "../polling.js";
import {
  validateIdempotencyKey,
  validateOperationId,
  validateWaitOptions,
  validateWorkspaceId,
  vmListQuery,
} from "../validation.js";
import type {
  BackupPolicy,
  BackupPolicyDisableRequest,
  BackupPolicyEnableRequest,
  BackupPolicyNextRunRequest,
  BackupPolicyUpdateRequest,
  BackupRestoreRequest,
  BackupRun,
  BackupRunList,
  CloudVm,
  CreateGpuVmRequest,
  CreateVmRequest,
  GpuVm,
  ManualBackupRunRequest,
  MountGuidanceAcknowledge,
  OperationAccepted,
  OperationStatus,
  RecoveryRestore,
  RecoveryRestoreRequest,
  SnapshotCreateRequest,
  SnapshotDeleteResult,
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

/** Page size used when auto-paging lists. */
const AUTO_PAGE_SIZE = 100;

/**
 * Shared implementation for Cloud VMs and GPU VMs — identical endpoints under
 * different path segments (`cloud-vms` / `gpu-vms`). `TCreate` is the body type
 * of the create call (GPU VMs additionally require gpu_count / gpu_model).
 */
export class VmResource<
  TCreate extends CreateVmRequest = CreateVmRequest,
  TVm extends CloudVm = CloudVm,
> {
  constructor(
    private readonly http: HttpClient,
    private readonly segment: string,
    private readonly vmType: "cloud" | "gpu",
  ) {}

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

  /**
   * List VMs. With no `limit`/`offset` every page is fetched (100 per request)
   * and de-duplicated; otherwise exactly one page is returned.
   */
  async list(args: VmListArgs): Promise<TVm[]> {
    validateWorkspaceId(args.workspaceId);
    const query = vmListQuery(args);
    if (args.limit === undefined && args.offset === undefined) {
      return collect(this.iterate(args));
    }
    return this.http.request({
      method: "GET",
      path: this.base(),
      workspaceId: args.workspaceId,
      query,
    });
  }

  /** Iterate every VM, fetching pages of 100 on demand. */
  iterate(args: Omit<VmListArgs, "limit" | "offset">): AsyncIterable<TVm> {
    validateWorkspaceId(args.workspaceId);
    const query = vmListQuery(args);
    return paginateOffset<TVm>(
      (limit, offset) =>
        this.http.request<TVm[]>({
          method: "GET",
          path: this.base(),
          workspaceId: args.workspaceId,
          query: { ...query, limit, offset },
        }),
      { pageSize: AUTO_PAGE_SIZE },
    );
  }

  async create(
    args: { workspaceId: string; idempotencyKey?: string } & TCreate,
  ): Promise<OperationAccepted> {
    const { workspaceId, idempotencyKey, ...body } = args;
    return this.http.request({
      method: "POST",
      path: this.base(),
      workspaceId,
      idempotencyKey: this.key("create", (body as { name?: string }).name, idempotencyKey),
      body,
    });
  }

  get(args: { workspaceId: string; vmId: string }): Promise<TVm> {
    return this.http.request({
      method: "GET",
      path: this.base(args.vmId),
      workspaceId: args.workspaceId,
    });
  }

  /** VM deletion is asynchronous — the API returns an OperationAccepted. */
  async delete(args: {
    workspaceId: string;
    vmId: string;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "DELETE",
      path: this.base(args.vmId),
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("delete", args.vmId, args.idempotencyKey),
    });
  }

  private async action(
    workspaceId: string,
    vmId: string,
    action: "start" | "stop" | "reboot",
    force?: boolean,
    idempotencyKey?: string,
  ): Promise<OperationAccepted> {
    return this.http.request({
      method: "POST",
      path: `${this.base(vmId)}/actions/${action}`,
      workspaceId,
      idempotencyKey: this.key(action, vmId, idempotencyKey),
      body: force === undefined ? undefined : { force },
    });
  }

  start(args: {
    workspaceId: string;
    vmId: string;
    force?: boolean;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.action(args.workspaceId, args.vmId, "start", args.force, args.idempotencyKey);
  }

  stop(args: {
    workspaceId: string;
    vmId: string;
    force?: boolean;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.action(args.workspaceId, args.vmId, "stop", args.force, args.idempotencyKey);
  }

  reboot(args: {
    workspaceId: string;
    vmId: string;
    force?: boolean;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.action(args.workspaceId, args.vmId, "reboot", args.force, args.idempotencyKey);
  }

  getMetrics(args: { workspaceId: string; vmId: string }): Promise<VmMetrics> {
    return this.http.request({
      method: "GET",
      path: `${this.base(args.vmId)}/metrics`,
      workspaceId: args.workspaceId,
    });
  }

  async updateAccess(args: {
    workspaceId: string;
    vmId: string;
    request: VmAccessUpdateRequest;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "PATCH",
      path: `${this.base(args.vmId)}/actions/access`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("access", args.vmId, args.idempotencyKey),
      body: args.request,
    });
  }

  precheckResize(args: {
    workspaceId: string;
    vmId: string;
    request: VmResizeRequest;
  }): Promise<VmResizePrecheck> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/actions/resize/precheck`,
      workspaceId: args.workspaceId,
      body: args.request,
    });
  }

  async resize(args: {
    workspaceId: string;
    vmId: string;
    request: VmResizeRequest;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/actions/resize`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("resize", args.vmId, args.idempotencyKey),
      body: args.request,
    });
  }

  async resizePlan(args: {
    workspaceId: string;
    vmId: string;
    request: VmResizePlanRequest;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "PATCH",
      path: `${this.base(args.vmId)}/actions/resize-plan`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("resize-plan", args.vmId, args.idempotencyKey),
      body: args.request,
    });
  }

  async resizeRootDisk(args: {
    workspaceId: string;
    vmId: string;
    request: VmResizeRootDiskRequest;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "PATCH",
      path: `${this.base(args.vmId)}/actions/resize-root-disk`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("resize-root-disk", args.vmId, args.idempotencyKey),
      body: args.request,
    });
  }

  async attachVolume(args: {
    workspaceId: string;
    vmId: string;
    request: VmAttachVolumeRequest;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/actions/attach-volume`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("attach-volume", args.vmId, args.idempotencyKey),
      body: args.request,
    });
  }

  async detachVolume(args: {
    workspaceId: string;
    vmId: string;
    request: VmDetachVolumeRequest;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/actions/detach-volume`,
      workspaceId: args.workspaceId,
      idempotencyKey: this.key("detach-volume", args.vmId, args.idempotencyKey),
      body: args.request,
    });
  }

  acknowledgeMountGuidance(args: {
    workspaceId: string;
    vmId: string;
    volumeId: string;
  }): Promise<MountGuidanceAcknowledge> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/mount-guidance/acknowledge`,
      workspaceId: args.workspaceId,
      body: { volume_id: args.volumeId },
    });
  }

  listEvents(args: {
    workspaceId: string;
    vmId: string;
    limit?: number;
  }): Promise<VmEvent[]> {
    return this.http.request({
      method: "GET",
      path: `${this.base(args.vmId)}/events`,
      workspaceId: args.workspaceId,
      query: { limit: args.limit },
    });
  }

  getMetricsTimeseries(args: {
    workspaceId: string;
    vmId: string;
    range?: VmMetricsRange;
  }): Promise<VmMetricsTimeseries> {
    return this.http.request({
      method: "GET",
      path: `${this.base(args.vmId)}/metrics/timeseries`,
      workspaceId: args.workspaceId,
      query: { range: args.range },
    });
  }

  getBandwidth(args: {
    workspaceId: string;
    vmId: string;
    month: string;
  }): Promise<VmBandwidthSummary> {
    return this.http.request({
      method: "GET",
      path: `${this.base(args.vmId)}/metrics/bandwidth`,
      workspaceId: args.workspaceId,
      query: { month: args.month },
    });
  }

  createSnapshot(args: {
    workspaceId: string;
    vmId: string;
    request: SnapshotCreateRequest;
  }): Promise<SnapshotSet> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/snapshots`,
      workspaceId: args.workspaceId,
      body: args.request,
    });
  }

  listSnapshots(args: {
    workspaceId: string;
    vmId: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<SnapshotSetList> {
    return this.http.request({
      method: "GET",
      path: `${this.base(args.vmId)}/snapshots`,
      workspaceId: args.workspaceId,
      query: { limit: args.limit, offset: args.offset, search: args.search },
    });
  }

  restoreSnapshot(args: {
    workspaceId: string;
    vmId: string;
    snapshotSetId: string;
    request?: RecoveryRestoreRequest;
  }): Promise<RecoveryRestore> {
    return this.http.request({
      method: "POST",
      path: `${this.snapshotBase(args.snapshotSetId)}/actions/restore`,
      workspaceId: args.workspaceId,
      query: { vm_id: args.vmId },
      body: args.request ?? {},
    });
  }

  getSnapshot(args: {
    workspaceId: string;
    snapshotSetId: string;
  }): Promise<SnapshotSet> {
    return this.http.request({
      method: "GET",
      path: this.snapshotBase(args.snapshotSetId),
      workspaceId: args.workspaceId,
    });
  }

  deleteSnapshot(args: {
    workspaceId: string;
    snapshotSetId: string;
  }): Promise<SnapshotDeleteResult> {
    return this.http.request({
      method: "DELETE",
      path: this.snapshotBase(args.snapshotSetId),
      workspaceId: args.workspaceId,
    });
  }

  getSnapshotRestore(args: {
    workspaceId: string;
    restoreId: string;
  }): Promise<RecoveryRestore> {
    return this.http.request({
      method: "GET",
      path: `${this.snapshotBase()}/restores/${encodeURIComponent(args.restoreId)}`,
      workspaceId: args.workspaceId,
    });
  }

  getBackupPolicy(args: {
    workspaceId: string;
    vmId: string;
  }): Promise<BackupPolicy> {
    return this.http.request({
      method: "GET",
      path: `${this.base(args.vmId)}/backups/policy`,
      workspaceId: args.workspaceId,
    });
  }

  updateBackupPolicy(args: {
    workspaceId: string;
    vmId: string;
    request?: BackupPolicyUpdateRequest;
  }): Promise<BackupPolicy> {
    return this.http.request({
      method: "PATCH",
      path: `${this.base(args.vmId)}/backups/policy`,
      workspaceId: args.workspaceId,
      body: args.request ?? {},
    });
  }

  enableBackups(args: {
    workspaceId: string;
    vmId: string;
    request?: BackupPolicyEnableRequest;
  }): Promise<BackupPolicy> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/backups/enable`,
      workspaceId: args.workspaceId,
      body: args.request ?? {},
    });
  }

  disableBackups(args: {
    workspaceId: string;
    vmId: string;
    request?: BackupPolicyDisableRequest;
  }): Promise<BackupPolicy> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/backups/disable`,
      workspaceId: args.workspaceId,
      body: args.request ?? {},
    });
  }

  rescheduleBackup(args: {
    workspaceId: string;
    vmId: string;
    request: BackupPolicyNextRunRequest;
  }): Promise<BackupPolicy> {
    return this.http.request({
      method: "PATCH",
      path: `${this.base(args.vmId)}/backups/policy/next-run-at`,
      workspaceId: args.workspaceId,
      body: args.request,
    });
  }

  createBackupRun(args: {
    workspaceId: string;
    vmId: string;
    request?: ManualBackupRunRequest;
  }): Promise<BackupRun> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/backups/runs`,
      workspaceId: args.workspaceId,
      body: args.request ?? {},
    });
  }

  listBackupRuns(args: {
    workspaceId: string;
    vmId: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<BackupRunList> {
    return this.http.request({
      method: "GET",
      path: `${this.base(args.vmId)}/backups/runs`,
      workspaceId: args.workspaceId,
      query: { limit: args.limit, offset: args.offset, search: args.search },
    });
  }

  getBackupRun(args: {
    workspaceId: string;
    runId: string;
  }): Promise<BackupRun> {
    return this.http.request({
      method: "GET",
      path: `${this.backupBase()}/runs/${encodeURIComponent(args.runId)}`,
      workspaceId: args.workspaceId,
    });
  }

  restoreBackup(args: {
    workspaceId: string;
    vmId: string;
    request: BackupRestoreRequest;
  }): Promise<RecoveryRestore> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/backups/actions/restore`,
      workspaceId: args.workspaceId,
      body: args.request,
    });
  }

  getBackupRestore(args: {
    workspaceId: string;
    restoreId: string;
  }): Promise<RecoveryRestore> {
    return this.http.request({
      method: "GET",
      path: `${this.backupBase()}/restores/${encodeURIComponent(args.restoreId)}`,
      workspaceId: args.workspaceId,
    });
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
