import type { HttpClient } from "../core.js";
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

/** Cross-platform UUID (Node 18+ and browsers expose globalThis.crypto). */
function randomUUID(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

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

  /** The API returns a bare array of VMs. */
  list(args: { workspaceId: string }): Promise<TVm[]> {
    return this.http.request({
      method: "GET",
      path: this.base(),
      workspaceId: args.workspaceId,
    });
  }

  create(
    args: { workspaceId: string; idempotencyKey?: string } & TCreate,
  ): Promise<OperationAccepted> {
    const { workspaceId, idempotencyKey, ...body } = args;
    return this.http.request({
      method: "POST",
      path: this.base(),
      workspaceId,
      idempotencyKey: idempotencyKey ?? randomUUID(),
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
  delete(args: {
    workspaceId: string;
    vmId: string;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "DELETE",
      path: this.base(args.vmId),
      workspaceId: args.workspaceId,
      idempotencyKey: args.idempotencyKey ?? randomUUID(),
    });
  }

  private action(
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
      idempotencyKey: idempotencyKey ?? randomUUID(),
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

  updateAccess(args: {
    workspaceId: string;
    vmId: string;
    request: VmAccessUpdateRequest;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "PATCH",
      path: `${this.base(args.vmId)}/actions/access`,
      workspaceId: args.workspaceId,
      idempotencyKey: args.idempotencyKey ?? randomUUID(),
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

  resize(args: {
    workspaceId: string;
    vmId: string;
    request: VmResizeRequest;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/actions/resize`,
      workspaceId: args.workspaceId,
      idempotencyKey: args.idempotencyKey ?? randomUUID(),
      body: args.request,
    });
  }

  resizePlan(args: {
    workspaceId: string;
    vmId: string;
    request: VmResizePlanRequest;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "PATCH",
      path: `${this.base(args.vmId)}/actions/resize-plan`,
      workspaceId: args.workspaceId,
      idempotencyKey: args.idempotencyKey ?? randomUUID(),
      body: args.request,
    });
  }

  resizeRootDisk(args: {
    workspaceId: string;
    vmId: string;
    request: VmResizeRootDiskRequest;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "PATCH",
      path: `${this.base(args.vmId)}/actions/resize-root-disk`,
      workspaceId: args.workspaceId,
      idempotencyKey: args.idempotencyKey ?? randomUUID(),
      body: args.request,
    });
  }

  attachVolume(args: {
    workspaceId: string;
    vmId: string;
    request: VmAttachVolumeRequest;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/actions/attach-volume`,
      workspaceId: args.workspaceId,
      idempotencyKey: args.idempotencyKey ?? randomUUID(),
      body: args.request,
    });
  }

  detachVolume(args: {
    workspaceId: string;
    vmId: string;
    request: VmDetachVolumeRequest;
    idempotencyKey?: string;
  }): Promise<OperationAccepted> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/actions/detach-volume`,
      workspaceId: args.workspaceId,
      idempotencyKey: args.idempotencyKey ?? randomUUID(),
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

  get(args: {
    workspaceId: string;
    operationId: string;
  }): Promise<OperationStatus> {
    return this.http.request({
      method: "GET",
      path: `/compute/operations/${encodeURIComponent(args.operationId)}`,
      workspaceId: args.workspaceId,
    });
  }
}
