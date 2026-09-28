import type { HttpClient } from "../core.js";
import {
  IbeeValidationError,
  validateRequestedBy,
  validateVmId,
  validateWorkspaceId,
} from "../validation.js";
import type {
  VmConsoleClose,
  VmConsoleSession,
  VmConsoleSessionStatus,
  VmType,
} from "../types.js";

const pathId = (value: string) => encodeURIComponent(value);

/** Short-lived graphical console sessions for Cloud and GPU VMs. */
export class VmConsoleResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Open a graphical console session for a cloud VM. GPU VMs do not support
   * socket consoles yet, so `vmType: "gpu"` is rejected. With `checkState`
   * the VM must be running. `connect_url` carries a short-lived token: do
   * not log it.
   */
  async createSession(args: {
    workspaceId: string;
    vmId: string;
    vmType?: VmType;
    consoleType?: "graphical";
    requestedBy?: string | null;
    userId?: string | null;
    checkState?: boolean;
  }): Promise<VmConsoleSession> {
    validateWorkspaceId(args.workspaceId);
    const vmId = validateVmId(args.vmId);
    if (args.vmType !== undefined && args.vmType !== "cloud") {
      throw new IbeeValidationError(
        "Socket-based console sessions are currently available only for cloud VMs.",
        "console_not_supported",
        "vm_type",
      );
    }
    if (args.consoleType !== undefined && args.consoleType !== "graphical") {
      throw new IbeeValidationError("consoleType must be 'graphical'.", "invalid_console_type", "console_type");
    }
    validateRequestedBy(args.requestedBy ?? undefined);
    if (args.checkState) {
      const vm = await this.http.request<{ status?: string }>({
        method: "GET",
        path: `/compute/cloud-vms/${pathId(vmId)}`,
        workspaceId: args.workspaceId,
      });
      if (String(vm?.status ?? "").toLowerCase() !== "running") {
        throw new IbeeValidationError(
          "The console is available only while the VM is running.",
          "invalid_vm_state",
          "status",
        );
      }
    }
    return this.http.request({
      method: "POST",
      path: "/compute/console/sessions",
      workspaceId: args.workspaceId,
      body: {
        vm_id: vmId,
        vm_type: args.vmType ?? "cloud",
        console_type: args.consoleType ?? "graphical",
        requested_by: args.requestedBy ?? "api",
        user_id: args.userId,
      },
    });
  }

  getSession(args: {
    workspaceId: string;
    sessionId: string;
  }): Promise<VmConsoleSessionStatus> {
    return this.http.request({
      method: "GET",
      path: `/compute/console/sessions/${pathId(args.sessionId)}`,
      workspaceId: args.workspaceId,
    });
  }

  closeSession(args: {
    workspaceId: string;
    sessionId: string;
    reason?: string;
  }): Promise<VmConsoleClose> {
    return this.http.request({
      method: "DELETE",
      path: `/compute/console/sessions/${pathId(args.sessionId)}`,
      workspaceId: args.workspaceId,
      query: { reason: args.reason },
    });
  }
}
