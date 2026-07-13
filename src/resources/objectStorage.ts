import type { HttpClient } from "../core.js";
import type { Bucket, BucketList, DeleteResponse } from "../types.js";

export class ObjectStorageResource {
  constructor(private readonly http: HttpClient) {}

  listBuckets(args: {
    workspaceId: string;
    limit?: number;
    continuationToken?: string;
  }): Promise<BucketList> {
    return this.http.request({
      method: "GET",
      path: "/object-storage/buckets",
      workspaceId: args.workspaceId,
      query: {
        limit: args.limit,
        continuation_token: args.continuationToken,
      },
    });
  }

  createBucket(args: {
    workspaceId: string;
    name: string;
    /** Storage region, e.g. "in-south-1". Required by the API. */
    region: string;
    isPublic?: boolean;
  }): Promise<Bucket> {
    return this.http.request({
      method: "POST",
      path: "/object-storage/buckets",
      workspaceId: args.workspaceId,
      body: {
        name: args.name,
        region: args.region,
        is_public: args.isPublic,
      },
    });
  }

  deleteBucket(args: {
    workspaceId: string;
    bucketName: string;
  }): Promise<DeleteResponse> {
    return this.http.request({
      method: "DELETE",
      path: `/object-storage/buckets/${encodeURIComponent(args.bucketName)}`,
      workspaceId: args.workspaceId,
    });
  }
}
