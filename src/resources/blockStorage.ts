import type { HttpClient } from "../core.js";
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

  createVolume(
    args: { workspaceId: string } & CreateBlockVolumeRequest,
  ): Promise<BlockVolumeAction> {
    const { workspaceId, ...body } = args;
    return this.http.request({
      method: "POST",
      path: "/block-storage/volumes",
      workspaceId,
      body,
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

  deleteVolume(args: {
    workspaceId: string;
    volumeId: string;
    force?: boolean;
  }): Promise<BlockVolumeDelete> {
    return this.http.request({
      method: "DELETE",
      path: `/block-storage/volumes/${pathId(args.volumeId)}`,
      workspaceId: args.workspaceId,
      query: { force: args.force },
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

  attachVolume(args: {
    workspaceId: string;
    volumeId: string;
    request: AttachBlockVolumeRequest;
  }): Promise<BlockVolumeAction> {
    return this.http.request({
      method: "POST",
      path: `/block-storage/volumes/${pathId(args.volumeId)}/attachments`,
      workspaceId: args.workspaceId,
      body: args.request,
    });
  }

  detachVolume(args: {
    workspaceId: string;
    volumeId: string;
    request: DetachBlockVolumeRequest;
  }): Promise<BlockVolumeAction> {
    return this.http.request({
      method: "POST",
      path: `/block-storage/volumes/${pathId(args.volumeId)}/detach`,
      workspaceId: args.workspaceId,
      body: args.request,
    });
  }

  resizeVolume(args: {
    workspaceId: string;
    volumeId: string;
    request: ResizeBlockVolumeRequest;
  }): Promise<BlockVolumeAction> {
    return this.http.request({
      method: "POST",
      path: `/block-storage/volumes/${pathId(args.volumeId)}/resize`,
      workspaceId: args.workspaceId,
      body: args.request,
    });
  }
}
