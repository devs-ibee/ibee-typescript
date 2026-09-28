import type { HttpClient } from "../core.js";
import {
  IbeeValidationError,
  assertBucketDeletable,
  buildBucketCreateBody,
  buildS3CredentialBody,
  resolveObjectStorageRegion,
  validateBoundedId,
  validateBucketPathName,
  validateLimitOffset,
  validateWorkspaceId,
  type S3BucketScope,
  type S3PermissionType,
} from "../validation.js";
import type {
  Bucket,
  BucketList,
  BucketSummary,
  DefaultRetention,
  DeleteResponse,
  S3Credential,
  S3CredentialCreated,
  S3CredentialList,
  S3CredentialRevoked,
} from "../types.js";
import { BillingResource } from "./billing.js";

/** SKU the edge admits bucket and S3 credential creates against. */
export const OBJECT_STORAGE_SKU_CODE = "OBJECTST-STD";

const bucketPath = (name: string) => `/object-storage/buckets/${encodeURIComponent(name)}`;

/** Buckets and S3 credentials. */
export class ObjectStorageResource {
  private readonly billing: BillingResource;

  constructor(private readonly http: HttpClient) {
    this.billing = new BillingResource(http);
  }

  /** One page of buckets (limit 1..1000, server default 100). */
  async listBuckets(args: {
    workspaceId: string;
    limit?: number;
    continuationToken?: string;
  }): Promise<BucketList> {
    validateWorkspaceId(args.workspaceId);
    validateLimitOffset({ limit: args.limit }, 1000);
    if (args.continuationToken !== undefined && args.continuationToken !== null) {
      if (typeof args.continuationToken !== "string" || !args.continuationToken.trim()) {
        throw new IbeeValidationError("continuationToken cannot be blank.", "invalid_continuation_token", "continuation_token");
      }
    }
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

  /** Iterate every bucket, following `next_continuation_token`. */
  async *iterateBuckets(args: { workspaceId: string; pageSize?: number }): AsyncGenerator<BucketSummary, void, undefined> {
    const limit = args.pageSize ?? 100;
    let token: string | undefined;
    for (let page = 0; page < 1000; page += 1) {
      const res = await this.listBuckets({ workspaceId: args.workspaceId, limit, continuationToken: token });
      for (const bucket of res?.buckets ?? []) yield bucket;
      const next = res?.next_continuation_token;
      if (!res?.is_truncated || !next || next === token) return;
      token = next;
    }
  }

  /** Every bucket in the workspace. */
  async listAllBuckets(args: { workspaceId: string; pageSize?: number }): Promise<BucketSummary[]> {
    const out: BucketSummary[] = [];
    for await (const bucket of this.iterateBuckets(args)) out.push(bucket);
    return out;
  }

  /**
   * Create a bucket. The name follows the portal rule: 3..63 characters,
   * lower-case letters, digits and hyphens, starting and ending with a
   * letter or digit (uppercase is refused, not lower-cased).
   *
   * `region` defaults to the region the portal uses for the client's API
   * host (production `in-south-1`, development `in-south-2`); it is required
   * for any other base URL. A `defaultRetention` (GOVERNANCE or COMPLIANCE,
   * exactly one of `days` 1..36500 or `years` 1..100) turns Object Lock on.
   *
   * Never retried automatically: a replay could be reported as a name
   * conflict.
   */
  async createBucket(args: {
    workspaceId: string;
    name: string;
    /** Object Storage region (not a compute site ID). Defaults per environment. */
    region?: string;
    isPublic?: boolean;
    objectLockEnabled?: boolean;
    defaultRetention?: DefaultRetention;
    tags?: string[];
    /** Check billing eligibility (OBJECTST-STD) before creating (default false). */
    preflightBilling?: boolean;
  }): Promise<Bucket> {
    validateWorkspaceId(args.workspaceId);
    const region = resolveObjectStorageRegion(args.region, this.http.baseUrl);
    const body = buildBucketCreateBody({ ...args, region });
    if (args.preflightBilling) {
      await this.billing.requireResourceEligibility({
        workspaceId: args.workspaceId,
        skuCode: OBJECT_STORAGE_SKU_CODE,
        resourceType: "object_storage",
      });
    }
    return this.http.request({
      method: "POST",
      path: "/object-storage/buckets",
      workspaceId: args.workspaceId,
      body,
    });
  }

  async getBucket(args: {
    workspaceId: string;
    bucketName: string;
  }): Promise<Bucket> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "GET",
      path: bucketPath(validateBucketPathName(args.bucketName)),
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Make a bucket public or private. Making a bucket private also disables
   * its public URL and deletes any CDN distribution that uses it as origin.
   */
  async updateBucket(args: {
    workspaceId: string;
    bucketName: string;
    isPublic: boolean;
  }): Promise<Bucket> {
    validateWorkspaceId(args.workspaceId);
    const name = validateBucketPathName(args.bucketName);
    if (typeof args.isPublic !== "boolean") {
      throw new IbeeValidationError("isPublic must be true or false.", "invalid_is_public", "is_public");
    }
    return this.http.request({
      method: "PATCH",
      path: bucketPath(name),
      workspaceId: args.workspaceId,
      body: { is_public: args.isPublic },
    });
  }

  /**
   * Delete an empty bucket. Objects are not deleted: the API refuses a
   * bucket that still has objects (409). Like the portal, the SDK first
   * reads the bucket and refuses when Object Lock is on or it still has
   * objects. `skipPreflight` skips only the object-count check (counts can
   * lag behind recent deletes).
   */
  async deleteBucket(args: {
    workspaceId: string;
    bucketName: string;
    /** Skip the object-count pre-check (the Object Lock check still runs). */
    skipPreflight?: boolean;
  }): Promise<DeleteResponse> {
    validateWorkspaceId(args.workspaceId);
    const name = validateBucketPathName(args.bucketName);
    const bucket = await this.getBucket({ workspaceId: args.workspaceId, bucketName: name });
    assertBucketDeletable(bucket, { skipPreflight: args.skipPreflight });
    return this.http.request({
      method: "DELETE",
      path: bucketPath(name),
      workspaceId: args.workspaceId,
    });
  }

  /** S3 credentials (at most the 100 newest). */
  async listS3Credentials(args: {
    workspaceId: string;
  }): Promise<S3CredentialList> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "GET",
      path: "/object-storage/credentials",
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Create an S3 credential. Follows the portal: `name` defaults to
   * "Default Key" (1..100 characters), `permissionType` defaults to
   * `admin_rw`, admin permissions always cover all buckets, and
   * `bucketScope: "specific"` (object permissions only) needs at least one
   * bucket in `allowedBuckets` (trimmed and de-duplicated).
   *
   * `secret_access_key` is returned only once. The request is never retried
   * automatically so the secret cannot be lost to a duplicate create.
   */
  async createS3Credential(args: {
    workspaceId: string;
    name?: string;
    permissionType?: S3PermissionType | (string & {});
    bucketScope?: S3BucketScope;
    allowedBuckets?: string[];
    /** Check billing eligibility (OBJECTST-STD) before creating (default false). */
    preflightBilling?: boolean;
  }): Promise<S3CredentialCreated> {
    validateWorkspaceId(args.workspaceId);
    const body = buildS3CredentialBody(args);
    if (args.preflightBilling) {
      await this.billing.requireResourceEligibility({
        workspaceId: args.workspaceId,
        skuCode: OBJECT_STORAGE_SKU_CODE,
        resourceType: "object_storage",
      });
    }
    return this.http.request({
      method: "POST",
      path: "/object-storage/credentials",
      workspaceId: args.workspaceId,
      body,
    });
  }

  async getS3Credential(args: {
    workspaceId: string;
    accessKeyId: string;
  }): Promise<S3Credential> {
    validateWorkspaceId(args.workspaceId);
    const id = validateBoundedId(args.accessKeyId, "access_key_id", 256);
    return this.http.request({
      method: "GET",
      path: `/object-storage/credentials/${encodeURIComponent(id)}`,
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Permanently delete an S3 credential. It cannot be restored or
   * re-enabled (the portal's soft revoke is not available through the public
   * API). Same as `deleteS3Credential`.
   */
  async revokeS3Credential(args: {
    workspaceId: string;
    accessKeyId: string;
  }): Promise<S3CredentialRevoked> {
    validateWorkspaceId(args.workspaceId);
    const id = validateBoundedId(args.accessKeyId, "access_key_id", 256);
    return this.http.request({
      method: "DELETE",
      path: `/object-storage/credentials/${encodeURIComponent(id)}`,
      workspaceId: args.workspaceId,
    });
  }

  /** Permanently delete an S3 credential (alias of `revokeS3Credential`). */
  deleteS3Credential(args: {
    workspaceId: string;
    accessKeyId: string;
  }): Promise<S3CredentialRevoked> {
    return this.revokeS3Credential(args);
  }
}
