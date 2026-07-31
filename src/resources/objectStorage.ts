import type { HttpClient } from "../core.js";
import type {
  Bucket,
  BucketList,
  DeleteResponse,
  S3Credential,
  S3CredentialCreated,
  S3CredentialList,
  S3CredentialRevoked,
} from "../types.js";

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
    /** Site/datacenter where the bucket is provisioned. */
    siteId: string;
    siteName?: string;
    region?: string;
    plan?: string;
    isPublic?: boolean;
    bucketLockEnabled?: boolean;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Bucket> {
    return this.http.request({
      method: "POST",
      path: "/object-storage/buckets",
      workspaceId: args.workspaceId,
      body: {
        name: args.name,
        site_id: args.siteId,
        site_name: args.siteName,
        region: args.region,
        plan: args.plan,
        is_public: args.isPublic,
        bucket_lock_enabled: args.bucketLockEnabled,
        tags: args.tags,
        metadata: args.metadata,
      },
    });
  }

  getBucket(args: {
    workspaceId: string;
    bucketName: string;
  }): Promise<Bucket> {
    return this.http.request({
      method: "GET",
      path: `/object-storage/buckets/${encodeURIComponent(args.bucketName)}`,
      workspaceId: args.workspaceId,
    });
  }

  updateBucket(args: {
    workspaceId: string;
    bucketName: string;
    isPublic: boolean;
  }): Promise<Bucket> {
    return this.http.request({
      method: "PATCH",
      path: `/object-storage/buckets/${encodeURIComponent(args.bucketName)}`,
      workspaceId: args.workspaceId,
      body: { is_public: args.isPublic },
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

  listS3Credentials(args: {
    workspaceId: string;
  }): Promise<S3CredentialList> {
    return this.http.request({
      method: "GET",
      path: "/object-storage/credentials",
      workspaceId: args.workspaceId,
    });
  }

  createS3Credential(args: {
    workspaceId: string;
    name?: string;
    permissionType?: string;
    bucketScope?: "all" | "specific";
    allowedBuckets?: string[];
  }): Promise<S3CredentialCreated> {
    return this.http.request({
      method: "POST",
      path: "/object-storage/credentials",
      workspaceId: args.workspaceId,
      body: {
        name: args.name,
        permission_type: args.permissionType,
        bucket_scope: args.bucketScope,
        allowed_buckets: args.allowedBuckets,
      },
    });
  }

  getS3Credential(args: {
    workspaceId: string;
    accessKeyId: string;
  }): Promise<S3Credential> {
    return this.http.request({
      method: "GET",
      path: `/object-storage/credentials/${encodeURIComponent(args.accessKeyId)}`,
      workspaceId: args.workspaceId,
    });
  }

  revokeS3Credential(args: {
    workspaceId: string;
    accessKeyId: string;
  }): Promise<S3CredentialRevoked> {
    return this.http.request({
      method: "DELETE",
      path: `/object-storage/credentials/${encodeURIComponent(args.accessKeyId)}`,
      workspaceId: args.workspaceId,
    });
  }
}
