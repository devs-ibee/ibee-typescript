import type { HttpClient } from "../core.js";
import { ApiError } from "../errors.js";
import type { BillingResource } from "./billing.js";
import type {
  CloudVm,
  CreateGpuVmRequest,
  CreateVmRequest,
  GpuVm,
  OperationAccepted,
  OperationStatus,
  VmMetrics,
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
    private readonly billing: BillingResource,
    private readonly segment: string,
    private readonly vmType: "cloud" | "gpu",
  ) {}

  private base(id?: string): string {
    return id
      ? `/compute/${this.segment}/${encodeURIComponent(id)}`
      : `/compute/${this.segment}`;
  }

  /** The API returns a bare array of VMs. */
  list(args: { workspaceId: string }): Promise<TVm[]> {
    return this.http.request({
      method: "GET",
      path: this.base(),
      workspaceId: args.workspaceId,
    });
  }

  async create(
    args: { workspaceId: string; idempotencyKey?: string } & TCreate,
  ): Promise<OperationAccepted> {
    const { workspaceId, idempotencyKey, ...body } = args;
    const plans = await this.http.request<{
      plans?: Array<{
        plan_id?: string;
        code?: string;
        selectable?: boolean;
        pricing_status?: string;
      }>;
    }>({
      method: "GET",
      path: "/compute/plans",
      workspaceId,
      query: {
        vm_type: this.vmType,
        site_id: body.site_id,
      },
    });
    const plan = Array.isArray(plans?.plans)
      ? plans.plans.find((candidate) => candidate.plan_id === body.plan_id)
      : undefined;
    if (
      !plan ||
      !plan.code ||
      plan.selectable !== true ||
      plan.pricing_status !== "priced"
    ) {
      throw new ApiError(
        422,
        {
          error: {
            code: "VM_PLAN_NOT_BILLABLE",
            message: "The requested VM plan is missing, unavailable, or unpriced",
            details: { plan_id: body.plan_id, vm_type: this.vmType },
          },
        },
        "The requested VM plan is missing, unavailable, or unpriced",
      );
    }
    await this.billing.requireResourceEligibility({
      workspaceId,
      skuCode: plan.code,
    });
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
