import type { HttpClient } from "../core.js";
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

  createSession(args: {
    workspaceId: string;
    vmId: string;
    vmType?: VmType;
    consoleType?: "graphical";
    requestedBy?: string | null;
    userId?: string | null;
  }): Promise<VmConsoleSession> {
    return this.http.request({
      method: "POST",
      path: "/compute/console/sessions",
      workspaceId: args.workspaceId,
      body: {
        vm_id: args.vmId,
        vm_type: args.vmType,
        console_type: args.consoleType,
        requested_by: args.requestedBy,
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
