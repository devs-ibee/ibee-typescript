import type { HttpClient } from "../core.js";
import type { BillingResource } from "./billing.js";
import type {
  Secret,
  SecretList,
  SecretStore,
  SecretStoreList,
  SecretValue,
} from "../types.js";

export class SecretStoreResource {
  constructor(
    private readonly http: HttpClient,
    private readonly billing: BillingResource,
  ) {}

  listSecretStores(args: {
    workspaceId: string;
    page?: number;
    limit?: number;
    includeArchived?: boolean;
  }): Promise<SecretStoreList> {
    return this.http.request({
      method: "GET",
      path: "/secret-store/stores",
      workspaceId: args.workspaceId,
      query: {
        page: args.page,
        limit: args.limit,
        include_archived: args.includeArchived,
      },
    });
  }

  async createSecretStore(args: {
    workspaceId: string;
    name: string;
    description?: string;
  }): Promise<SecretStore> {
    await this.billing.requireResourceEligibility({
      workspaceId: args.workspaceId,
      skuCode: "SECRETMA-STD",
    });
    return this.http.request({
      method: "POST",
      path: "/secret-store/stores",
      workspaceId: args.workspaceId,
      body: { name: args.name, description: args.description },
    });
  }

  getSecretStore(args: {
    workspaceId: string;
    storeId: string;
  }): Promise<SecretStore> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}`,
      workspaceId: args.workspaceId,
    });
  }

  updateSecretStore(args: {
    workspaceId: string;
    storeId: string;
    name?: string;
    description?: string;
  }): Promise<SecretStore> {
    return this.http.request({
      method: "PATCH",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}`,
      workspaceId: args.workspaceId,
      body: { name: args.name, description: args.description },
    });
  }

  archiveSecretStore(args: {
    workspaceId: string;
    storeId: string;
  }): Promise<SecretStore> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}/archive`,
      workspaceId: args.workspaceId,
    });
  }

  listSecrets(args: {
    workspaceId: string;
    storeId: string;
    q?: string;
    page?: number;
    limit?: number;
  }): Promise<SecretList> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}/secrets`,
      workspaceId: args.workspaceId,
      query: { q: args.q, page: args.page, limit: args.limit },
    });
  }

  /**
   * Create a secret. `value` is a map of key/value entries.
   * Wire body: `{ secret_name, value }`.
   */
  async createSecret(args: {
    workspaceId: string;
    storeId: string;
    name: string;
    value: Record<string, string>;
  }): Promise<Secret> {
    await this.billing.requireResourceEligibility({
      workspaceId: args.workspaceId,
      skuCode: "SECRETMA-STD",
    });
    return this.http.request({
      method: "POST",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}/secrets`,
      workspaceId: args.workspaceId,
      body: { secret_name: args.name, value: args.value },
    });
  }

  getSecret(args: { workspaceId: string; secretId: string }): Promise<Secret> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}`,
      workspaceId: args.workspaceId,
    });
  }

  /** Soft-delete a secret. The API returns the soft-deleted Secret. */
  deleteSecret(args: {
    workspaceId: string;
    secretId: string;
  }): Promise<Secret> {
    return this.http.request({
      method: "DELETE",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}`,
      workspaceId: args.workspaceId,
    });
  }

  getSecretValue(args: {
    workspaceId: string;
    secretId: string;
  }): Promise<SecretValue> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}/value`,
      workspaceId: args.workspaceId,
    });
  }

  /**
   * Set a new secret value (creates a new version).
   * `cas` is an optional check-and-set version for optimistic concurrency.
   */
  updateSecretValue(args: {
    workspaceId: string;
    secretId: string;
    value: Record<string, string>;
    cas?: number;
  }): Promise<SecretValue> {
    return this.http.request({
      method: "PUT",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}/value`,
      workspaceId: args.workspaceId,
      body: { value: args.value, cas: args.cas },
    });
  }
}
