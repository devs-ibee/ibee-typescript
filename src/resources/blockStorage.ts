import type { HttpClient } from "../core.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { buildIdempotencyKey } from "../idempotency.js";
import { collect, paginateOffset } from "../pagination.js";
import {
  IbeeValidationError,
  assertVolumeNotTransient,
  blockVolumeListQuery,
  buildBlockVolumeCreateBody,
  resolveSingleAttachment,
  validateAttachMode,
  validateBlockVolumeId,
  validateBoundedId,
  validateIdempotencyKey,
  validateIntRange,
  validateNodeSafeDetach,
  validateVolumeResize,
  validateVolumeVmState,
  validateVolumeVmType,
  validateWorkspaceId,
  volumeVmType,
  type BlockVolumeCreateInput,
  type BlockVolumeVmType,
} from "../validation.js";
import type {
  AttachBlockVolumeRequest,
  BillingCatalogSelection,
  BlockVolume,
  BlockVolumeAction,
  BlockVolumeDelete,
  BlockVolumeOperation,
  ComputeSiteList,
  CreateBlockVolumeRequest,
  DetachBlockVolumeRequest,
  OperationAcceptedResult,
  ResizeBlockVolumeRequest,
  VmType,
} from "../types.js";
import { VmResource, type VmWaitOptions } from "./vms.js";

const pathId = (value: string) => encodeURIComponent(value);

/**
 * Resolve the idempotency key for a volume write: an explicit argument wins,
 * then a key already in the request body, else a portal-style generated key
 * (`create-volume-...`, `attach-volume-...`, ...).
 */
function volumeKey(
  action: string,
  ident: string | undefined,
  explicit?: string | null,
  inBody?: string | null,
): string {
  const supplied = explicit ?? inBody ?? undefined;
  if (supplied !== undefined) return validateIdempotencyKey(supplied);
  return buildIdempotencyKey(`${action}-volume`, ident);
}

/** Optional idempotency key argument shared by volume writes. */
export interface VolumeIdempotencyArgs {
  /**
   * Deduplicates retries of this write for 24 h. Generated when omitted; the
   * SDK reuses it on automatic retries and reports it on errors
   * (`err.idempotencyKey`).
   */
  idempotencyKey?: string;
}

/** Options of `blockStorage.createVolume`. */
export interface CreateVolumeOptions {
  /**
   * When `site_name` is omitted, read the compute sites (needs `vm.read`) and
   * fill it from the site with this `site_id`, like the portal's location
   * picker (default true). An unknown `site_id` is refused; a 403/404 skips
   * the lookup.
   */
  resolveSiteName?: boolean;
}

/** Filters and paging for `blockStorage.listVolumes`. */
export interface ListVolumesArgs {
  workspaceId: string;
  siteId?: string;
  /** `cloud` also matches older volumes that have no VM type. */
  vmType?: VmType;
  /** 1..1000 (server default 100). */
  limit?: number;
  offset?: number;
}

/** Result of `attachToVm` / `detachFromVm`. */
export interface VolumeVmActionResult extends OperationAcceptedResult {
  /** The volume re-read after the operation (only with `wait`). */
  volume?: BlockVolume;
}

/** Arguments of `blockStorage.attachToVm`. */
export interface AttachVolumeToVmArgs extends VolumeIdempotencyArgs {
  workspaceId: string;
  volumeId: string;
  vmId: string;
  /** VM type of `vmId`. Must match the volume's `vm_type` (default: the volume's). */
  vmType?: VmType;
  /** Default `single-writer` (what the portal sends). */
  mode?: "single-writer" | "multi-writer";
  /** Block Storage SKU. Read from the volume when omitted. */
  billingCatalog?: BillingCatalogSelection;
  requestedBy?: string;
  /** Poll the operation (every 2 s, up to 2 min) and re-read the volume. */
  wait?: boolean | VmWaitOptions;
}

/** Arguments of `blockStorage.detachFromVm`. */
export interface DetachVolumeFromVmArgs extends VolumeIdempotencyArgs {
  workspaceId: string;
  volumeId: string;
  /** VM to detach from. Read from the volume's single attachment when omitted. */
  vmId?: string;
  /** VM type of the VM (default: the attachment's or the volume's). */
  vmType?: VmType;
  /** You unmounted the volume inside the server (the portal's mandatory tick). */
  confirmUnmounted?: boolean;
  /** Detach without the unmount safety check. */
  force?: boolean;
  requestedBy?: string;
  /** Poll the operation (every 2 s, up to 2 min) and re-read the volume. */
  wait?: boolean | VmWaitOptions;
}

const VOLUME_WAIT_DEFAULTS = { timeoutMs: 120_000, pollIntervalMs: 2_000 };

const waitOpts = (wait: boolean | VmWaitOptions | undefined): VmWaitOptions | undefined =>
  wait === true ? { ...VOLUME_WAIT_DEFAULTS } : wait ? { ...VOLUME_WAIT_DEFAULTS, ...wait } : undefined;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Persistent block volumes.
 *
 * To attach a volume to a cloud or GPU VM use `attachToVm` / `detachFromVm`
 * (or `cloudVms.attachVolume` / `gpuVms.attachVolume`), which is what the
 * portal does. `attachVolume` / `detachVolume` here are advanced node-level
 * calls.
 */
export class BlockStorageResource {
  private readonly vms: Record<BlockVolumeVmType, VmResource>;

  constructor(private readonly http: HttpClient) {
    this.vms = {
      cloud: new VmResource(http, "cloud-vms", "cloud"),
      gpu: new VmResource(http, "gpu-vms", "gpu") as unknown as VmResource,
    };
  }

  private fetchVolume(workspaceId: string, volumeId: string): Promise<BlockVolume> {
    return this.http.request({
      method: "GET",
      path: `/block-storage/volumes/${pathId(volumeId)}`,
      workspaceId,
    });
  }

  /** Read the volume for a pre-check; undefined when the token lacks block-storage.read. */
  private async fetchVolumeForCheck(workspaceId: string, volumeId: string): Promise<BlockVolume | undefined> {
    try {
      return await this.fetchVolume(workspaceId, volumeId);
    } catch (err) {
      if (err instanceof ForbiddenError) return undefined;
      throw err;
    }
  }

  /**
   * One page of volumes (server default 100, newest first). Use
   * `listAllVolumes` / `iterateVolumes` to read every volume.
   */
  async listVolumes(args: ListVolumesArgs): Promise<BlockVolume[]> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "GET",
      path: "/block-storage/volumes",
      workspaceId: args.workspaceId,
      query: blockVolumeListQuery(args),
    });
  }

  /** Iterate every volume, `pageSize` (default 100) at a time. */
  async *iterateVolumes(
    args: Omit<ListVolumesArgs, "limit" | "offset"> & { pageSize?: number },
  ): AsyncGenerator<BlockVolume, void, undefined> {
    const { pageSize = 100, ...filters } = args;
    validateWorkspaceId(filters.workspaceId);
    blockVolumeListQuery({ ...filters, limit: pageSize });
    yield* paginateOffset<BlockVolume>(
      (limit, offset) => this.listVolumes({ ...filters, limit, offset }),
      { pageSize },
    );
  }

  /** Every volume in the workspace (pages of `pageSize`, default 100). */
  async listAllVolumes(
    args: Omit<ListVolumesArgs, "limit" | "offset"> & { pageSize?: number },
  ): Promise<BlockVolume[]> {
    return collect(this.iterateVolumes(args));
  }

  /**
   * Create a volume. The SDK applies the portal rules before sending:
   * name 3..255 of `[a-z0-9-]` (never renamed), size a whole number of GB
   * from 10 to 10000, a site, and valid class/replicas/VM type. The Block
   * Storage SKU and price are chosen by the server; `sku_code` is optional.
   * The idempotency key is sent in the body and as `X-Idempotency-Key`.
   *
   * `vm_type` and `delete_on_termination` are not yet part of the published
   * API contract; behaviour may change.
   */
  async createVolume(
    args: { workspaceId: string } & VolumeIdempotencyArgs & CreateBlockVolumeRequest & CreateVolumeOptions,
  ): Promise<BlockVolumeAction> {
    const { workspaceId, idempotencyKey, resolveSiteName, idempotency_key, ...input } = args;
    validateWorkspaceId(workspaceId);
    const body = buildBlockVolumeCreateBody(input as unknown as BlockVolumeCreateInput);
    const key = volumeKey("create", String(body.name), idempotencyKey, idempotency_key);
    if (body.site_name === undefined && resolveSiteName !== false) {
      let sites: ComputeSiteList | undefined;
      try {
        sites = await this.http.request<ComputeSiteList>({ method: "GET", path: "/compute/sites", workspaceId });
      } catch (err) {
        if (!(err instanceof ForbiddenError) && !(err instanceof NotFoundError)) throw err;
      }
      if (sites && Array.isArray(sites.sites)) {
        const site = sites.sites.find((s) => String(s?.site_id ?? "") === body.site_id);
        if (!site) throw new IbeeValidationError("Unknown site_id", "invalid_site_id", "site_id");
        if (site.name) body.site_name = site.name;
      }
    }
    return this.http.request({
      method: "POST",
      path: "/block-storage/volumes",
      workspaceId,
      idempotencyKey: key,
      body: { ...body, idempotency_key: key },
    });
  }

  async getVolume(args: { workspaceId: string; volumeId: string }): Promise<BlockVolume> {
    validateWorkspaceId(args.workspaceId);
    return this.fetchVolume(args.workspaceId, validateBlockVolumeId(args.volumeId));
  }

  /**
   * Delete a volume. Like the portal, the SDK first reads the volume and
   * refuses while it is attached ("Detach this volume from all servers
   * before deleting.") or busy, unless `force` is set. `force` detaches the
   * volume from every server first and erases its data. Set
   * `checkAttachments: false` to skip the read.
   *
   * The `idempotency_key` query parameter is not yet part of the published
   * API contract; behaviour may change.
   */
  async deleteVolume(args: {
    workspaceId: string;
    volumeId: string;
    force?: boolean;
    /** Read the volume and refuse an attached or busy volume (default true; skipped with force). */
    checkAttachments?: boolean;
  } & VolumeIdempotencyArgs): Promise<BlockVolumeDelete> {
    validateWorkspaceId(args.workspaceId);
    const volumeId = validateBlockVolumeId(args.volumeId);
    if (args.force !== undefined && typeof args.force !== "boolean") {
      throw new IbeeValidationError("force must be a boolean.", "invalid_force", "force");
    }
    const key = volumeKey("delete", volumeId, args.idempotencyKey);
    if (args.force !== true && args.checkAttachments !== false) {
      const vol = await this.fetchVolumeForCheck(args.workspaceId, volumeId);
      if (vol) {
        const atts = Array.isArray(vol.attachments) ? vol.attachments : [];
        if (atts.length > 0) {
          throw new IbeeValidationError(
            "Detach this volume from all servers before deleting.",
            "volume_attached",
            "volume_id",
            { attachments: atts.map((a) => ({ vm_id: a?.vm_id ?? null, vm_name: a?.vm_name ?? null })) },
          );
        }
        assertVolumeNotTransient(vol, "delete");
      }
    }
    return this.http.request({
      method: "DELETE",
      path: `/block-storage/volumes/${pathId(volumeId)}`,
      workspaceId: args.workspaceId,
      query: { force: args.force, idempotency_key: key },
    });
  }

  /** Recent operations on a volume, newest first (limit 1..200, server default 20). */
  async listVolumeOperations(args: {
    workspaceId: string;
    volumeId: string;
    limit?: number;
  }): Promise<BlockVolumeOperation[]> {
    validateWorkspaceId(args.workspaceId);
    const volumeId = validateBlockVolumeId(args.volumeId);
    validateIntRange(args.limit, "limit", 1, 200);
    return this.http.request({
      method: "GET",
      path: `/block-storage/volumes/${pathId(volumeId)}/operations`,
      workspaceId: args.workspaceId,
      query: { limit: args.limit },
    });
  }

  /**
   * Advanced: records a storage-node attachment only and does not attach the
   * disk to a VM. Use `attachToVm` for VMs. Do not manage the same
   * attachment through both surfaces.
   *
   * When `vm_site_id` is given the SDK reads the volume and refuses a site
   * mismatch.
   */
  async attachVolume(args: {
    workspaceId: string;
    volumeId: string;
    request: AttachBlockVolumeRequest;
  } & VolumeIdempotencyArgs): Promise<BlockVolumeAction> {
    validateWorkspaceId(args.workspaceId);
    const volumeId = validateBlockVolumeId(args.volumeId);
    const req = args.request;
    if (!isRecord(req)) throw new IbeeValidationError("request must be an object.", "invalid_attach", "request");
    const body: Record<string, unknown> = { ...req, node_name: validateBoundedId(req.node_name, "node_name", 255) };
    body.mode = validateAttachMode(req.mode);
    if (req.vm_state !== undefined && req.vm_state !== null) body.vm_state = validateVolumeVmState(req.vm_state);
    if (req.vm_type !== undefined && req.vm_type !== null) body.vm_type = validateVolumeVmType(req.vm_type);
    const key = volumeKey("attach", volumeId, args.idempotencyKey, req.idempotency_key);
    const vmSite = typeof req.vm_site_id === "string" ? req.vm_site_id.trim() : "";
    if (vmSite) {
      const vol = await this.fetchVolumeForCheck(args.workspaceId, volumeId);
      const volSite = String(vol?.site_id ?? "").trim();
      if (vol && volSite && volSite !== vmSite) {
        throw new IbeeValidationError(`Select a server in ${vol.site_name || volSite}`, "site_mismatch", "vm_site_id");
      }
    }
    return this.http.request({
      method: "POST",
      path: `/block-storage/volumes/${pathId(volumeId)}/attachments`,
      workspaceId: args.workspaceId,
      body: { ...body, idempotency_key: key },
    });
  }

  /**
   * Advanced: removes a storage-node attachment only. Use `detachFromVm`
   * for VMs. Needs `force`, `confirm_unmounted`, or `vm_state` stopped or
   * suspended. When `node_name` is omitted the SDK reads the volume and uses
   * its single attachment (and the volume's `vm_type`).
   */
  async detachVolume(args: {
    workspaceId: string;
    volumeId: string;
    request?: DetachBlockVolumeRequest;
  } & VolumeIdempotencyArgs): Promise<BlockVolumeAction> {
    validateWorkspaceId(args.workspaceId);
    const volumeId = validateBlockVolumeId(args.volumeId);
    const req: DetachBlockVolumeRequest = args.request ?? {};
    if (!isRecord(req as unknown)) throw new IbeeValidationError("request must be an object.", "invalid_detach", "request");
    validateNodeSafeDetach(req);
    if (req.vm_state !== undefined && req.vm_state !== null) validateVolumeVmState(req.vm_state);
    let vmType = req.vm_type === undefined || req.vm_type === null ? undefined : validateVolumeVmType(req.vm_type);
    const body: Record<string, unknown> = { ...req };
    const key = volumeKey("detach", volumeId, args.idempotencyKey, req.idempotency_key);
    if (req.node_name === undefined || req.node_name === null) {
      const vol = await this.fetchVolume(args.workspaceId, volumeId);
      const att = resolveSingleAttachment(vol);
      body.node_name = validateBoundedId(att.node_name, "node_name", 255);
      vmType = vmType ?? volumeVmType(vol);
    } else {
      body.node_name = validateBoundedId(req.node_name, "node_name", 255);
    }
    if (vmType !== undefined) body.vm_type = vmType;
    return this.http.request({
      method: "POST",
      path: `/block-storage/volumes/${pathId(volumeId)}/detach`,
      workspaceId: args.workspaceId,
      body: { ...body, idempotency_key: key },
    });
  }

  /**
   * Grow a volume (increase-only, 1..10000 GB). The SDK first reads the
   * volume (`checkState`, default true): it refuses a shrink, a busy volume,
   * and resizing an attached volume unless `vm_state` is stopped/suspended or
   * `allow_online` is true. An equal size is sent and returns a no-op. Grow
   * the filesystem inside the server afterwards.
   */
  async resizeVolume(args: {
    workspaceId: string;
    volumeId: string;
    request: ResizeBlockVolumeRequest;
    /** Read the volume and apply the grow-only and attached rules (default true). */
    checkState?: boolean;
  } & VolumeIdempotencyArgs): Promise<BlockVolumeAction> {
    validateWorkspaceId(args.workspaceId);
    const volumeId = validateBlockVolumeId(args.volumeId);
    const req = args.request;
    if (!isRecord(req)) throw new IbeeValidationError("request must be an object.", "invalid_resize", "request");
    if ("billing_catalog" in req) {
      throw new IbeeValidationError(
        "billing_catalog cannot be sent on a volume resize.",
        "forbidden_field",
        "billing_catalog",
      );
    }
    validateVolumeResize(req);
    const key = volumeKey("resize", volumeId, args.idempotencyKey, req.idempotency_key);
    if (args.checkState !== false) {
      const vol = await this.fetchVolumeForCheck(args.workspaceId, volumeId);
      if (vol) {
        assertVolumeNotTransient(vol, "resize");
        validateVolumeResize(req, vol);
      }
    }
    return this.http.request({
      method: "POST",
      path: `/block-storage/volumes/${pathId(volumeId)}/resize`,
      workspaceId: args.workspaceId,
      body: { ...req, idempotency_key: key },
    });
  }

  /**
   * Attach a volume to a cloud or GPU VM, the way the portal does. The SDK
   * reads the volume (it must be unattached, created for the VM's type, and
   * in the VM's site), uses its Block Storage SKU as `billing_catalog`, and
   * calls `cloudVms.attachVolume` or `gpuVms.attachVolume`. With `wait` it
   * polls the operation every 2 s for up to 2 minutes and re-reads the volume.
   */
  async attachToVm(args: AttachVolumeToVmArgs): Promise<VolumeVmActionResult> {
    validateWorkspaceId(args.workspaceId);
    const volumeId = validateBlockVolumeId(args.volumeId);
    const requestedType = validateVolumeVmType(args.vmType);
    const mode = validateAttachMode(args.mode);
    let volume: BlockVolume | undefined;
    try {
      volume = await this.fetchVolume(args.workspaceId, volumeId);
    } catch (err) {
      if (!(err instanceof ForbiddenError)) throw err;
      if (!args.billingCatalog) {
        throw new IbeeValidationError(
          "billing_catalog is required; grant block-storage.read or pass billingCatalog",
          "invalid_billing_catalog",
          "billing_catalog",
        );
      }
    }
    const vmType: BlockVolumeVmType = volume ? volumeVmType(volume) : (requestedType ?? "cloud");
    if (volume && requestedType && requestedType !== vmType) {
      throw new IbeeValidationError(
        `Volume was created for ${vmType} VMs and cannot attach to a ${requestedType} VM`,
        "vm_type_mismatch",
        "vm_type",
      );
    }
    const accepted = await this.vms[vmType].attachVolume({
      workspaceId: args.workspaceId,
      vmId: args.vmId,
      volume,
      idempotencyKey: args.idempotencyKey,
      request: {
        volume_id: volumeId,
        mode,
        ...(args.billingCatalog ? { billing_catalog: args.billingCatalog } : {}),
        ...(args.requestedBy !== undefined ? { requested_by: args.requestedBy } : {}),
      },
      wait: waitOpts(args.wait),
    });
    if (!args.wait) return accepted;
    return { ...accepted, volume: await this.fetchVolume(args.workspaceId, volumeId) };
  }

  /**
   * Detach a volume from its cloud or GPU VM, the way the portal does. Pass
   * `confirmUnmounted: true` after unmounting it inside the server, or
   * `force: true`. The SDK reads the volume to find the VM (when `vmId` is
   * omitted) and its type, then calls `cloudVms.detachVolume` or
   * `gpuVms.detachVolume`. With `wait` it polls the operation and re-reads
   * the volume.
   */
  async detachFromVm(args: DetachVolumeFromVmArgs): Promise<VolumeVmActionResult> {
    validateWorkspaceId(args.workspaceId);
    const volumeId = validateBlockVolumeId(args.volumeId);
    if (args.confirmUnmounted !== true && args.force !== true) {
      throw new IbeeValidationError(
        "Unmount the volume inside the server, then pass confirmUnmounted: true (or force: true)",
        "detach_not_confirmed",
        "confirm_unmounted",
      );
    }
    const requestedType = validateVolumeVmType(args.vmType);
    const vmIdArg = args.vmId === undefined || args.vmId === null ? undefined : String(args.vmId).trim();
    const volume = await this.fetchVolume(args.workspaceId, volumeId);
    const att = resolveSingleAttachment(volume, { vmId: vmIdArg || undefined, forVm: true });
    const vmId = String(att.vm_id);
    const vmType: BlockVolumeVmType =
      requestedType ?? (att.vm_type ? volumeVmType({ vm_type: att.vm_type }) : volumeVmType(volume));
    const accepted = await this.vms[vmType].detachVolume({
      workspaceId: args.workspaceId,
      vmId,
      idempotencyKey: args.idempotencyKey,
      request: {
        volume_id: volumeId,
        confirm_unmounted: args.confirmUnmounted === true,
        force: args.force === true,
        ...(args.requestedBy !== undefined ? { requested_by: args.requestedBy } : {}),
      },
      wait: waitOpts(args.wait),
    });
    if (!args.wait) return accepted;
    return { ...accepted, volume: await this.fetchVolume(args.workspaceId, volumeId) };
  }
}
