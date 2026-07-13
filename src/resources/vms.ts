import type { HttpClient } from "../core.js";

/** Cross-platform UUID (Node 18+ and browsers expose globalThis.crypto). */
function randomUUID(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for older runtimes.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
import type {
  CloudVm,
  CreateVmRequest,
  DeleteResponse,
  OperationAccepted,
} from "../types.js";

/**
 * Shared implementation for Cloud VMs and GPU VMs — identical endpoints under
 * different path segments (`cloud-vms` / `gpu-vms`).
 */
export class VmResource {
  constructor(
    private readonly http: HttpClient,
    /** URL segment: "cloud-vms" or "gpu-vms". */
    private readonly segment: string,
  ) {}

  private base(id?: string): string {
    return id
      ? `/compute/${this.segment}/${encodeURIComponent(id)}`
      : `/compute/${this.segment}`;
  }

  list(args: { workspaceId: string }): Promise<{ items?: CloudVm[] }> {
    return this.http.request({
      method: "GET",
      path: this.base(),
      workspaceId: args.workspaceId,
    });
  }

  create(args: {
    workspaceId: string;
    idempotencyKey?: string;
  } & CreateVmRequest): Promise<OperationAccepted> {
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

  delete(args: {
    workspaceId: string;
    vmId: string;
    idempotencyKey?: string;
  }): Promise<DeleteResponse> {
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
    idempotencyKey?: string,
  ): Promise<OperationAccepted> {
    return this.http.request({
      method: "POST",
      path: `${this.base(vmId)}/actions/${action}`,
      workspaceId,
      idempotencyKey: idempotencyKey ?? randomUUID(),
    });
  }

  start(args: { workspaceId: string; vmId: string; idempotencyKey?: string }) {
    return this.action(args.workspaceId, args.vmId, "start", args.idempotencyKey);
  }

  stop(args: { workspaceId: string; vmId: string; idempotencyKey?: string }) {
    return this.action(args.workspaceId, args.vmId, "stop", args.idempotencyKey);
  }

  reboot(args: { workspaceId: string; vmId: string; idempotencyKey?: string }) {
    return this.action(args.workspaceId, args.vmId, "reboot", args.idempotencyKey);
  }

  getMetrics(args: { workspaceId: string; vmId: string }): Promise<unknown> {
    return this.http.request({
      method: "GET",
      path: `${this.base(args.vmId)}/metrics`,
      workspaceId: args.workspaceId,
    });
  }

  listNetworkInterfaces(args: {
    workspaceId: string;
    vmId: string;
  }): Promise<unknown> {
    return this.http.request({
      method: "GET",
      path: `${this.base(args.vmId)}/network-interfaces`,
      workspaceId: args.workspaceId,
    });
  }

  attachNetworkInterface(args: {
    workspaceId: string;
    vmId: string;
    body: unknown;
  }): Promise<unknown> {
    return this.http.request({
      method: "POST",
      path: `${this.base(args.vmId)}/network-interfaces`,
      workspaceId: args.workspaceId,
      body: args.body,
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
  }): Promise<import("../types.js").OperationStatus> {
    return this.http.request({
      method: "GET",
      path: `/compute/operations/${encodeURIComponent(args.operationId)}`,
      workspaceId: args.workspaceId,
    });
  }
}
