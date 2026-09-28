import type { HttpClient } from "../core.js";
import { buildIdempotencyKey } from "../idempotency.js";
import { validateIdempotencyKey } from "../validation.js";
import type {
  AttachBlockVolumeRequest,
  BlockVolume,
  BlockVolumeAction,
  BlockVolumeDelete,
  BlockVolumeOperation,
  CreateBlockVolumeRequest,
  DetachBlockVolumeRequest,
  ResizeBlockVolumeRequest,
} from "../types.js";

const pathId = (value: string) => encodeURIComponent(value);

/**
 * Resolve the idempotency key for a volume write: an explicit argument wins,
 * then a key already in the request body, else a portal-style generated key.
 */
function volumeKey(
  action: string,
  ident: string | undefined,
  explicit?: string | null,
  inBody?: string | null,
): string {
  const supplied = explicit ?? inBody ?? undefined;
  if (supplied !== undefined) return validateIdempotencyKey(supplied);
  return buildIdempotencyKey(`block-volume-${action}`, ident);
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

/** Persistent block-volume lifecycle. */
export class BlockStorageResource {
  constructor(private readonly http: HttpClient) {}

  listVolumes(args: { workspaceId: string }): Promise<BlockVolume[]> {
    return this.http.request({
      method: "GET",
      path: "/block-storage/volumes",
      workspaceId: args.workspaceId,
    });
  }

  async createVolume(
    args: { workspaceId: string } & VolumeIdempotencyArgs & CreateBlockVolumeRequest,
  ): Promise<BlockVolumeAction> {
    const { workspaceId, idempotencyKey, ...body } = args;
    return this.http.request({
      method: "POST",
      path: "/block-storage/volumes",
      workspaceId,
      body: {
        ...body,
        idempotency_key: volumeKey("create", body.name, idempotencyKey, body.idempotency_key),
      },
    });
  }

  getVolume(args: {
    workspaceId: string;
    volumeId: string;
  }): Promise<BlockVolume> {
    return this.http.request({
      method: "GET",
      path: `/block-storage/volumes/${pathId(args.volumeId)}`,
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Delete a volume. The `idempotency_key` query parameter is not yet part of
   * the published API contract; behaviour may change.
   */
  async deleteVolume(args: {
    workspaceId: string;
    volumeId: string;
    force?: boolean;
  } & VolumeIdempotencyArgs): Promise<BlockVolumeDelete> {
    return this.http.request({
      method: "DELETE",
      path: `/block-storage/volumes/${pathId(args.volumeId)}`,
      workspaceId: args.workspaceId,
      query: {
        force: args.force,
        idempotency_key: volumeKey("delete", args.volumeId, args.idempotencyKey),
      },
    });
  }

  listVolumeOperations(args: {
    workspaceId: string;
    volumeId: string;
  }): Promise<BlockVolumeOperation[]> {
    return this.http.request({
      method: "GET",
      path: `/block-storage/volumes/${pathId(args.volumeId)}/operations`,
      workspaceId: args.workspaceId,
    });
  }

  async attachVolume(args: {
    workspaceId: string;
    volumeId: string;
    request: AttachBlockVolumeRequest;
  } & VolumeIdempotencyArgs): Promise<BlockVolumeAction> {
    return this.http.request({
      method: "POST",
      path: `/block-storage/volumes/${pathId(args.volumeId)}/attachments`,
      workspaceId: args.workspaceId,
      body: {
        ...args.request,
        idempotency_key: volumeKey(
          "attach",
          args.volumeId,
          args.idempotencyKey,
          args.request?.idempotency_key,
        ),
      },
    });
  }

  async detachVolume(args: {
    workspaceId: string;
    volumeId: string;
    request: DetachBlockVolumeRequest;
  } & VolumeIdempotencyArgs): Promise<BlockVolumeAction> {
    return this.http.request({
      method: "POST",
      path: `/block-storage/volumes/${pathId(args.volumeId)}/detach`,
      workspaceId: args.workspaceId,
      body: {
        ...args.request,
        idempotency_key: volumeKey(
          "detach",
          args.volumeId,
          args.idempotencyKey,
          args.request?.idempotency_key,
        ),
      },
    });
  }

  async resizeVolume(args: {
    workspaceId: string;
    volumeId: string;
    request: ResizeBlockVolumeRequest;
  } & VolumeIdempotencyArgs): Promise<BlockVolumeAction> {
    return this.http.request({
      method: "POST",
      path: `/block-storage/volumes/${pathId(args.volumeId)}/resize`,
      workspaceId: args.workspaceId,
      body: {
        ...args.request,
        idempotency_key: volumeKey(
          "resize",
          args.volumeId,
          args.idempotencyKey,
          args.request?.idempotency_key,
        ),
      },
    });
  }
}
