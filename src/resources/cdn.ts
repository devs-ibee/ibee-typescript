import type { HttpClient } from "../core.js";
import { CdnDomainVerificationTimeoutError, ForbiddenError, IbeeCdnPurgeError, NotFoundError } from "../errors.js";
import { sleepMs } from "../polling.js";
import {
  IbeeValidationError,
  buildCdnPurgeBody,
  normalizeCdnDomain,
  validateBoundedId,
  validateCdnDistributionFields,
  validateCdnIndexDocument,
  validateCdnMetricsRange,
  validateCdnUrlRequest,
  validateWorkspaceId,
} from "../validation.js";
import type {
  Bucket,
  CdnCachePolicyList,
  CdnCachePurge,
  CdnCustomDomain,
  CdnCustomDomainDeleteResult,
  CdnCustomDomainList,
  CdnCustomDomainVerification,
  CdnDistribution,
  CdnDistributionDeleteResult,
  CdnDistributionList,
  CdnDistributionMetrics,
  CdnWebsiteConfig,
  CreateCdnDistributionRequest,
  GenerateCdnUrlRequest,
  GeneratedCdnUrl,
  PurgeCdnCacheRequest,
  UpdateCdnDistributionRequest,
  UpdateCdnWebsiteConfigRequest,
} from "../types.js";

/** SKU the edge admits custom-domain creates against. */
export const CDN_CUSTOM_DOMAIN_SKU_CODE = "CUSTOMDO-STD";
/** @deprecated Historical display estimate only; never sent or used for admission. */
export const CDN_CUSTOM_DOMAIN_ESTIMATED_COST_MINOR = 19_900;

const pathId = (value: string) => encodeURIComponent(value);
const distId = (value: unknown) => validateBoundedId(value, "distribution_id", 256);

/** Options of `cdn.waitForCustomDomain`. */
export interface WaitForCdnDomainOptions {
  /** Client deadline (default 600000 = 10 min). */
  timeoutMs?: number;
  /** Delay between verify calls (default 15000). */
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onUpdate?: (result: CdnCustomDomainVerification) => void;
}

/** CDN distributions, websites, domains, URL generation, and cache purge. */
export class CdnResource {

  constructor(private readonly http: HttpClient) {
  }

  /** Signed CDN URL for one object (`expires_in` >= 1 s; `disposition` inline or attachment). */
  async generateUrl(
    args: { workspaceId: string } & GenerateCdnUrlRequest,
  ): Promise<GeneratedCdnUrl> {
    const { workspaceId, ...input } = args;
    validateWorkspaceId(workspaceId);
    return this.http.request({
      method: "POST",
      path: "/cdn/generate-url",
      workspaceId,
      body: validateCdnUrlRequest(input),
    });
  }

  async listDistributions(args: { workspaceId: string }): Promise<CdnDistributionList> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "GET",
      path: "/cdn/distributions",
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Cache policies with their headers. The list also contains
   * `public-development`, which create/update do not accept (portal parity).
   *
   * Not yet part of the published API contract; behaviour may change.
   */
  async listCachePolicies(args: { workspaceId: string }): Promise<CdnCachePolicyList> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "GET",
      path: "/cdn/distributions/cache-policies",
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Create a distribution in front of a public bucket. Follows the portal:
   * name 1..128 characters, `origin_type` `bucket` (default) or `custom`,
   * `cache_policy` one of static-assets (default), media, short, no-cache.
   * Only public buckets can be origins; with `checkOriginPublic` the SDK
   * reads the bucket first and refuses a private one (skipped when the
   * bucket is not found by that name, since `origin_id` may be a bucket ID,
   * or when the read is forbidden, 403).
   * Creating again for the same bucket returns the existing distribution.
   */
  async createDistribution(
    args: { workspaceId: string } & CreateCdnDistributionRequest & {
      /** Refuse a private origin bucket before creating (default false). */
      checkOriginPublic?: boolean;
      /** @deprecated No-op. The upstream mutation decides billing and lifecycle admission. */
      preflightBilling?: boolean;
    },
  ): Promise<CdnDistribution> {
    const { workspaceId, checkOriginPublic, preflightBilling, ...input } = args;
    validateWorkspaceId(workspaceId);
    const body = validateCdnDistributionFields(input);
    if (checkOriginPublic && body.origin_type === "bucket") {
      let bucket: Bucket | undefined;
      try {
        bucket = await this.http.request<Bucket>({
          method: "GET",
          path: `/object-storage/buckets/${pathId(String(body.origin_id))}`,
          workspaceId,
        });
      } catch (err) {
        // The bucket may not be readable by that name (origin_id can be a
        // bucket ID) or by this token: skip the check, as the Python SDK does.
        if (!(err instanceof NotFoundError) && !(err instanceof ForbiddenError)) throw err;
      }
      const isPublic = bucket?.is_public ?? bucket?.public;
      if (bucket && isPublic === false) {
        throw new IbeeValidationError(
          "Only public buckets can be used as CDN origins",
          "origin_not_public",
          "origin_id",
        );
      }
    }
    return this.http.request({
      method: "POST",
      path: "/cdn/distributions",
      workspaceId,
      body,
    });
  }

  async getDistribution(args: {
    workspaceId: string;
    distributionId: string;
  }): Promise<CdnDistribution> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "GET",
      path: `/cdn/distributions/${pathId(distId(args.distributionId))}`,
      workspaceId: args.workspaceId,
    });
  }

  /** Update name, cache policy or enabled flag (at least one is required). */
  async updateDistribution(
    args: {
      workspaceId: string;
      distributionId: string;
    } & UpdateCdnDistributionRequest,
  ): Promise<CdnDistribution> {
    const { workspaceId, distributionId, ...input } = args;
    validateWorkspaceId(workspaceId);
    const id = distId(distributionId);
    return this.http.request({
      method: "PATCH",
      path: `/cdn/distributions/${pathId(id)}`,
      workspaceId,
      body: validateCdnDistributionFields(input, { update: true }),
    });
  }

  /**
   * Delete a distribution. This removes its DNS record and all its custom
   * domains, and purges its cache.
   */
  async deleteDistribution(args: {
    workspaceId: string;
    distributionId: string;
  }): Promise<CdnDistributionDeleteResult> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "DELETE",
      path: `/cdn/distributions/${pathId(distId(args.distributionId))}`,
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Distribution metrics for the last `range` (24h default, 7d or 30d).
   *
   * Not yet part of the published API contract; behaviour may change.
   */
  async getDistributionMetrics(args: {
    workspaceId: string;
    distributionId: string;
    range?: "24h" | "7d" | "30d";
  }): Promise<CdnDistributionMetrics> {
    validateWorkspaceId(args.workspaceId);
    const range = validateCdnMetricsRange(args.range);
    return this.http.request({
      method: "GET",
      path: `/cdn/distributions/${pathId(distId(args.distributionId))}/metrics`,
      workspaceId: args.workspaceId,
      query: { range },
    });
  }

  /**
   * Static-website (SPA) settings. A 404 means the distribution does not
   * exist or website hosting has never been configured (the portal shows
   * that as "disabled").
   */
  async getWebsiteConfig(args: {
    workspaceId: string;
    distributionId: string;
  }): Promise<CdnWebsiteConfig> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "GET",
      path: `/cdn/distributions/${pathId(distId(args.distributionId))}/website-config`,
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Enable website hosting. `index_document` defaults to `index.html`; it
   * must be a relative object key (printable ASCII, no leading `/`, no
   * backslash, no empty/`.`/`..` segments, at most 1024 bytes) that exists
   * in the origin bucket. Bucket origins only.
   */
  async updateWebsiteConfig(args: {
    workspaceId: string;
    distributionId: string;
    request?: UpdateCdnWebsiteConfigRequest;
  }): Promise<CdnWebsiteConfig> {
    validateWorkspaceId(args.workspaceId);
    const id = distId(args.distributionId);
    const indexDocument = validateCdnIndexDocument(args.request?.index_document);
    return this.http.request({
      method: "PUT",
      path: `/cdn/distributions/${pathId(id)}/website-config`,
      workspaceId: args.workspaceId,
      body: { index_document: indexDocument },
    });
  }

  async deleteWebsiteConfig(args: {
    workspaceId: string;
    distributionId: string;
  }): Promise<CdnWebsiteConfig> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "DELETE",
      path: `/cdn/distributions/${pathId(distId(args.distributionId))}/website-config`,
      workspaceId: args.workspaceId,
    });
  }

  async listCustomDomains(args: {
    workspaceId: string;
    distributionId: string;
  }): Promise<CdnCustomDomainList> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "GET",
      path: `/cdn/distributions/${pathId(distId(args.distributionId))}/custom-domains`,
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Add a custom domain (lower-cased; 3..253 characters; must include a
   * subdomain such as `cdn.example.com`). The response carries the CNAME
   * record to create at your DNS provider; then call `verifyCustomDomain`
   * or `waitForCustomDomain`. `preflightBilling` is a deprecated no-op.
   */
  async createCustomDomain(args: {
    workspaceId: string;
    distributionId: string;
    domain: string;
    /** @deprecated No-op. The upstream mutation decides billing and lifecycle admission. */
    preflightBilling?: boolean;
  }): Promise<CdnCustomDomain> {
    validateWorkspaceId(args.workspaceId);
    const id = distId(args.distributionId);
    const domain = normalizeCdnDomain(args.domain, { create: true });
    return this.http.request({
      method: "POST",
      path: `/cdn/distributions/${pathId(id)}/custom-domains`,
      workspaceId: args.workspaceId,
      body: { domain },
    });
  }

  async getCustomDomain(args: {
    workspaceId: string;
    distributionId: string;
    domain: string;
  }): Promise<CdnCustomDomain> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "GET",
      path: `/cdn/distributions/${pathId(distId(args.distributionId))}/custom-domains/${pathId(normalizeCdnDomain(args.domain))}`,
      workspaceId: args.workspaceId,
    });
  }

  /** Remove a custom domain. Also delete its CNAME record at your DNS provider. */
  async deleteCustomDomain(args: {
    workspaceId: string;
    distributionId: string;
    domain: string;
  }): Promise<CdnCustomDomainDeleteResult> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "DELETE",
      path: `/cdn/distributions/${pathId(distId(args.distributionId))}/custom-domains/${pathId(normalizeCdnDomain(args.domain))}`,
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Check the domain's DNS and certificate. `active` means it is live; any
   * other status means the DNS record has not propagated yet (try again in a
   * few minutes) or verification `failed`.
   */
  async verifyCustomDomain(args: {
    workspaceId: string;
    distributionId: string;
    domain: string;
    signal?: AbortSignal;
  }): Promise<CdnCustomDomainVerification> {
    validateWorkspaceId(args.workspaceId);
    return this.http.request({
      method: "POST",
      path: `/cdn/distributions/${pathId(distId(args.distributionId))}/custom-domains/${pathId(normalizeCdnDomain(args.domain))}/verify`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /**
   * Call `verifyCustomDomain` every 15 s until the status is `active` or
   * `failed` (both returned), for up to 10 minutes; then throws
   * CdnDomainVerificationTimeoutError with the last status.
   */
  async waitForCustomDomain(
    args: { workspaceId: string; distributionId: string; domain: string } & WaitForCdnDomainOptions,
  ): Promise<CdnCustomDomainVerification> {
    validateWorkspaceId(args.workspaceId);
    distId(args.distributionId);
    const domain = normalizeCdnDomain(args.domain);
    const timeoutMs = args.timeoutMs ?? 600_000;
    const pollIntervalMs = args.pollIntervalMs ?? 15_000;
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
      throw new IbeeValidationError("timeoutMs must be a positive number.", "invalid_timeout", "timeout");
    }
    if (!(Number.isFinite(pollIntervalMs) && pollIntervalMs > 0)) {
      throw new IbeeValidationError("pollIntervalMs must be a positive number.", "invalid_poll_interval", "poll_interval");
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await this.verifyCustomDomain({ ...args, domain });
      args.onUpdate?.(result);
      if (result?.status === "active" || result?.status === "failed") return result;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new CdnDomainVerificationTimeoutError(domain, timeoutMs, result as unknown as Record<string, unknown>);
      }
      await sleepMs(Math.min(pollIntervalMs, remaining), args.signal);
    }
  }

  /**
   * Purge cached content. Give only the selector for the mode: `url` ->
   * `paths` (1..30), `hostname` -> `hostnames`, `tag` -> `tags`, `prefix`
   * -> `prefixes` (1..100 each); `all` purges everything.
   *
   * The API can accept a purge and still report `success: false` (common
   * for tag and prefix purges); the SDK then throws IbeeCdnPurgeError. Pass
   * `raiseOnFailure: false` to get the raw result instead (0.3.0 behaviour).
   */
  async purgeCache(args: {
    workspaceId: string;
    distributionId: string;
    request: PurgeCdnCacheRequest;
    /** Throw IbeeCdnPurgeError when the result says `success: false` (default true). */
    raiseOnFailure?: boolean;
  }): Promise<CdnCachePurge> {
    validateWorkspaceId(args.workspaceId);
    const id = distId(args.distributionId);
    const body = buildCdnPurgeBody(args.request);
    const result = await this.http.request<CdnCachePurge>({
      method: "POST",
      path: `/cdn/distributions/${pathId(id)}/purge`,
      workspaceId: args.workspaceId,
      body,
    });
    if (args.raiseOnFailure !== false && result && typeof result === "object" && result.success === false) {
      throw new IbeeCdnPurgeError(result as unknown as Record<string, unknown>);
    }
    return result;
  }
}
