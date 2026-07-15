import type { HttpClient } from "../core.js";
import type {
  CloudVm,
  CreateVmRequest,
  DeleteResponse,
  NetworkInterface,
  OperationAccepted,
  OperationStatus,
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
export class VmResource<TCreate extends CreateVmRequest = CreateVmRequest> {
  constructor(
    private readonly http: HttpClient,
    private readonly segment: string,
  ) {}

  private base(id?: string): string {
    // Collection paths (list/create) keep a trailing slash so the gateway's
    // prefix rewrite lands on the backend's slash-terminated route
    // (/v2/virtual-machines/). Item paths append the id, no trailing slash.
    return id
      ? `/compute/${this.segment}/${encodeURIComponent(id)}`
      : `/compute/${this.segment}/`;
  }

  /** The API returns a bare array of VMs. */
  list(args: { workspaceId: string }): Promise<CloudVm[]> {
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

  get(args: { workspaceId: string; vmId: string }): Promise<CloudVm> {
    return this.http.request({
      method: "GET",
      path: this.base(args.vmId),
      workspaceId: args.workspaceId,
    });
  }

  update(args: {
    workspaceId: string;
    vmId: string;
    name?: string;
    tags?: string[];
  }): Promise<CloudVm> {
    const { workspaceId, vmId, ...body } = args;
    return this.http.request({
      method: "PATCH",
      path: this.base(vmId),
      workspaceId,
      body,
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
  }) {
    return this.action(args.workspaceId, args.vmId, "start", args.force, args.idempotencyKey);
  }

  stop(args: {
    workspaceId: string;
    vmId: string;
    force?: boolean;
    idempotencyKey?: string;
  }) {
    return this.action(args.workspaceId, args.vmId, "stop", args.force, args.idempotencyKey);
  }

  reboot(args: {
    workspaceId: string;
    vmId: string;
    force?: boolean;
    idempotencyKey?: string;
  }) {
    return this.action(args.workspaceId, args.vmId, "reboot", args.force, args.idempotencyKey);
  }

  getMetrics(args: { workspaceId: string; vmId: string }): Promise<unknown> {
    return this.http.request({
      method: "GET",
      path: `${this.base(args.vmId)}/metrics`,
      workspaceId: args.workspaceId,
    });
  }

  /** The API returns a bare array of network interfaces. */
  listNetworkInterfaces(args: {
    workspaceId: string;
    vmId: string;
  }): Promise<NetworkInterface[]> {
    return this.http.request({
      method: "GET",
      path: `${this.base(args.vmId)}/network-interfaces`,
      workspaceId: args.workspaceId,
    });
  }

  attachNetworkInterface(args: {
    workspaceId: string;
    vmId: string;
    networkId: string;
    idempotencyKey?: string;
  }): Promise<NetworkInterface> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/network-interfaces`,
      workspaceId: args.workspaceId,
      idempotencyKey: args.idempotencyKey ?? randomUUID(),
      body: { network_id: args.networkId },
    });
  }

  detachNetworkInterface(args: {
    workspaceId: string;
    vmId: string;
    interfaceId: string;
  }): Promise<DeleteResponse> {
    return this.http.request({
      method: "DELETE",
      path: `${this.base(args.vmId)}/network-interfaces/${encodeURIComponent(
        args.interfaceId,
      )}`,
      workspaceId: args.workspaceId,
    });
  }
}

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
