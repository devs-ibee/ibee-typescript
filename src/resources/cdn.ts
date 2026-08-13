import type { HttpClient } from "../core.js";
import type {
  CdnCachePurge,
  CdnCustomDomain,
  CdnCustomDomainList,
  CdnCustomDomainVerification,
  CdnDistribution,
  CdnDistributionList,
  CdnWebsiteConfig,
  CreateCdnDistributionRequest,
  GenerateCdnUrlRequest,
  GeneratedCdnUrl,
  PurgeCdnCacheRequest,
  UpdateCdnDistributionRequest,
  UpdateCdnWebsiteConfigRequest,
} from "../types.js";

const pathId = (value: string) => encodeURIComponent(value);

/** CDN distributions, websites, domains, URL generation, and cache purge. */
export class CdnResource {
  constructor(private readonly http: HttpClient) {}

  generateUrl(
    args: { workspaceId: string } & GenerateCdnUrlRequest,
  ): Promise<GeneratedCdnUrl> {
    const { workspaceId, ...body } = args;
    return this.http.request({
      method: "POST",
      path: "/cdn/generate-url",
      workspaceId,
      body,
    });
  }

  listDistributions(args: { workspaceId: string }): Promise<CdnDistributionList> {
    return this.http.request({
      method: "GET",
      path: "/cdn/distributions",
      workspaceId: args.workspaceId,
    });
  }

  createDistribution(
    args: { workspaceId: string } & CreateCdnDistributionRequest,
  ): Promise<CdnDistribution> {
    const { workspaceId, ...body } = args;
    return this.http.request({
      method: "POST",
      path: "/cdn/distributions",
      workspaceId,
      body,
    });
  }

  getDistribution(args: {
    workspaceId: string;
    distributionId: string;
  }): Promise<CdnDistribution> {
    return this.http.request({
      method: "GET",
      path: `/cdn/distributions/${pathId(args.distributionId)}`,
      workspaceId: args.workspaceId,
    });
  }

  updateDistribution(
    args: {
      workspaceId: string;
      distributionId: string;
    } & UpdateCdnDistributionRequest,
  ): Promise<CdnDistribution> {
    const { workspaceId, distributionId, ...body } = args;
    return this.http.request({
      method: "PATCH",
      path: `/cdn/distributions/${pathId(distributionId)}`,
      workspaceId,
      body,
    });
  }

  deleteDistribution(args: {
    workspaceId: string;
    distributionId: string;
  }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/cdn/distributions/${pathId(args.distributionId)}`,
      workspaceId: args.workspaceId,
    });
  }

  getWebsiteConfig(args: {
    workspaceId: string;
    distributionId: string;
  }): Promise<CdnWebsiteConfig> {
    return this.http.request({
      method: "GET",
      path: `/cdn/distributions/${pathId(args.distributionId)}/website-config`,
      workspaceId: args.workspaceId,
    });
  }

  updateWebsiteConfig(args: {
    workspaceId: string;
    distributionId: string;
    request?: UpdateCdnWebsiteConfigRequest;
  }): Promise<CdnWebsiteConfig> {
    return this.http.request({
      method: "PUT",
      path: `/cdn/distributions/${pathId(args.distributionId)}/website-config`,
      workspaceId: args.workspaceId,
      body: args.request ?? {},
    });
  }

  deleteWebsiteConfig(args: {
    workspaceId: string;
    distributionId: string;
  }): Promise<CdnWebsiteConfig> {
    return this.http.request({
      method: "DELETE",
      path: `/cdn/distributions/${pathId(args.distributionId)}/website-config`,
      workspaceId: args.workspaceId,
    });
  }

  listCustomDomains(args: {
    workspaceId: string;
    distributionId: string;
  }): Promise<CdnCustomDomainList> {
    return this.http.request({
      method: "GET",
      path: `/cdn/distributions/${pathId(args.distributionId)}/custom-domains`,
      workspaceId: args.workspaceId,
    });
  }

  createCustomDomain(args: {
    workspaceId: string;
    distributionId: string;
    domain: string;
  }): Promise<CdnCustomDomain> {
    return this.http.request({
      method: "POST",
      path: `/cdn/distributions/${pathId(args.distributionId)}/custom-domains`,
      workspaceId: args.workspaceId,
      body: { domain: args.domain },
    });
  }

  getCustomDomain(args: {
    workspaceId: string;
    distributionId: string;
    domain: string;
  }): Promise<CdnCustomDomain> {
    return this.http.request({
      method: "GET",
      path: `/cdn/distributions/${pathId(args.distributionId)}/custom-domains/${pathId(args.domain)}`,
      workspaceId: args.workspaceId,
    });
  }

  deleteCustomDomain(args: {
    workspaceId: string;
    distributionId: string;
    domain: string;
  }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/cdn/distributions/${pathId(args.distributionId)}/custom-domains/${pathId(args.domain)}`,
      workspaceId: args.workspaceId,
    });
  }

  verifyCustomDomain(args: {
    workspaceId: string;
    distributionId: string;
    domain: string;
  }): Promise<CdnCustomDomainVerification> {
    return this.http.request({
      method: "POST",
      path: `/cdn/distributions/${pathId(args.distributionId)}/custom-domains/${pathId(args.domain)}/verify`,
      workspaceId: args.workspaceId,
    });
  }

  purgeCache(args: {
    workspaceId: string;
    distributionId: string;
    request: PurgeCdnCacheRequest;
  }): Promise<CdnCachePurge> {
    return this.http.request({
      method: "POST",
      path: `/cdn/distributions/${pathId(args.distributionId)}/purge`,
      workspaceId: args.workspaceId,
      body: args.request,
    });
  }
}
