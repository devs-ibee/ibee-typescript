import type { HttpClient } from "../core.js";
import type { BillingResource } from "./billing.js";
import type {
  BatchCreateSecretItem,
  BatchCreateSecretsResponse,
  Secret,
  SecretIdentity,
  SecretIdentityAccess,
  SecretIdentityActionStatus,
  SecretIdentityAuthMethod,
  SecretIdentityList,
  SecretIdentityPolicyMode,
  SecretIdentityScope,
  SecretIdentityScopeList,
  SecretLifecycleStatus,
  SecretList,
  SecretStore,
  SecretStoreList,
  SecretValue,
  SecretVersion,
  SecretVersions,
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

  unarchiveSecretStore(args: {
    workspaceId: string;
    storeId: string;
  }): Promise<SecretStore> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}/unarchive`,
      workspaceId: args.workspaceId,
    });
  }

  /** Permanently remove a store and all store-scoped resources. This cannot be undone. */
  permanentlyDeleteSecretStore(args: {
    workspaceId: string;
    storeId: string;
  }): Promise<SecretLifecycleStatus> {
    return this.http.request({
      method: "DELETE",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}/permanent`,
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
    value: Record<string, unknown>;
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

  /** Create up to 500 secrets without overwriting existing names. */
  batchCreateSecrets(args: {
    workspaceId: string;
    storeId: string;
    secrets: BatchCreateSecretItem[];
  }): Promise<BatchCreateSecretsResponse> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}/secrets:batchIngest`,
      workspaceId: args.workspaceId,
      body: { secrets: args.secrets },
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
    value: Record<string, unknown>;
    cas?: number;
  }): Promise<SecretValue> {
    return this.http.request({
      method: "PUT",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}/value`,
      workspaceId: args.workspaceId,
      body: { value: args.value, cas: args.cas },
    });
  }

  /** Merge keys into the current value and create a new version. */
  patchSecretValue(args: {
    workspaceId: string;
    secretId: string;
    value: Record<string, unknown>;
  }): Promise<SecretValue> {
    return this.http.request({
      method: "PATCH",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}/value`,
      workspaceId: args.workspaceId,
      body: { value: args.value },
    });
  }

  undeleteSecret(args: {
    workspaceId: string;
    secretId: string;
    versions: number[];
  }): Promise<Secret> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}/undelete`,
      workspaceId: args.workspaceId,
      body: { versions: args.versions },
    });
  }

  /** Irreversibly destroy selected versions. */
  destroySecretVersions(args: {
    workspaceId: string;
    secretId: string;
    versions: number[];
  }): Promise<SecretLifecycleStatus> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}/destroy`,
      workspaceId: args.workspaceId,
      body: { versions: args.versions },
    });
  }

  /** Irreversibly remove every version and the secret metadata. */
  permanentlyDeleteSecret(args: {
    workspaceId: string;
    secretId: string;
  }): Promise<SecretLifecycleStatus> {
    return this.http.request({
      method: "DELETE",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}/permanent`,
      workspaceId: args.workspaceId,
    });
  }

  /** List version metadata without returning secret values. */
  listSecretVersions(args: {
    workspaceId: string;
    secretId: string;
  }): Promise<SecretVersions> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}/versions`,
      workspaceId: args.workspaceId,
    });
  }

  /** Return one version, including its secret value. */
  getSecretVersion(args: {
    workspaceId: string;
    secretId: string;
    version: number;
  }): Promise<SecretVersion> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}/versions/${args.version}`,
      workspaceId: args.workspaceId,
    });
  }

  /** Copy a previous version into a new current version. */
  rollbackSecret(args: {
    workspaceId: string;
    secretId: string;
    version: number;
  }): Promise<SecretValue> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}/rollback`,
      workspaceId: args.workspaceId,
      body: { version: args.version },
    });
  }

  listSecretIdentities(args: {
    workspaceId: string;
    storeId: string;
  }): Promise<SecretIdentityList> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}/identities`,
      workspaceId: args.workspaceId,
    });
  }

  createSecretIdentity(args: {
    workspaceId: string;
    storeId: string;
    authMethod: SecretIdentityAuthMethod;
    name: string;
    tokenPolicyMode?: SecretIdentityPolicyMode;
    k8sNamespace?: string | null;
    k8sServiceAccount?: string | null;
  }): Promise<SecretIdentity> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}/identities`,
      workspaceId: args.workspaceId,
      body: {
        auth_method: args.authMethod,
        name: args.name,
        token_policy_mode: args.tokenPolicyMode,
        k8s_namespace: args.k8sNamespace,
        k8s_service_account: args.k8sServiceAccount,
      },
    });
  }

  getSecretIdentity(args: {
    workspaceId: string;
    identityId: string;
  }): Promise<SecretIdentity> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/identities/${encodeURIComponent(args.identityId)}`,
      workspaceId: args.workspaceId,
    });
  }

  updateSecretIdentity(args: {
    workspaceId: string;
    identityId: string;
    tokenPolicyMode?: SecretIdentityPolicyMode;
  }): Promise<SecretIdentity> {
    return this.http.request({
      method: "PATCH",
      path: `/secret-store/identities/${encodeURIComponent(args.identityId)}`,
      workspaceId: args.workspaceId,
      body: { token_policy_mode: args.tokenPolicyMode },
    });
  }

  disableSecretIdentity(args: {
    workspaceId: string;
    identityId: string;
  }): Promise<SecretIdentity> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/identities/${encodeURIComponent(args.identityId)}/disable`,
      workspaceId: args.workspaceId,
    });
  }

  enableSecretIdentity(args: {
    workspaceId: string;
    identityId: string;
  }): Promise<SecretIdentity> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/identities/${encodeURIComponent(args.identityId)}/enable`,
      workspaceId: args.workspaceId,
    });
  }

  /** For AppRole, this generates a fresh secret ID. Do not log the response. */
  getSecretIdentityAccess(args: {
    workspaceId: string;
    identityId: string;
  }): Promise<SecretIdentityAccess> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/identities/${encodeURIComponent(args.identityId)}/access`,
      workspaceId: args.workspaceId,
    });
  }

  /** Generate a fresh secret ID for an AppRole identity. */
  rotateSecretIdentitySecretId(args: {
    workspaceId: string;
    identityId: string;
  }): Promise<SecretIdentityAccess> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/identities/${encodeURIComponent(args.identityId)}/rotate-secret-id`,
      workspaceId: args.workspaceId,
    });
  }

  revokeSecretIdentitySessions(args: {
    workspaceId: string;
    identityId: string;
  }): Promise<SecretIdentityActionStatus> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/identities/${encodeURIComponent(args.identityId)}/revoke`,
      workspaceId: args.workspaceId,
    });
  }

  listSecretIdentityScopes(args: {
    workspaceId: string;
    identityId: string;
  }): Promise<SecretIdentityScopeList> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/identities/${encodeURIComponent(args.identityId)}/scopes`,
      workspaceId: args.workspaceId,
    });
  }

  createSecretIdentityScope(args: {
    workspaceId: string;
    identityId: string;
    storeId: string;
    accessMode?: SecretIdentityPolicyMode;
    allowVersionRead?: boolean;
    allowRollback?: boolean;
    allowDestroy?: boolean;
  }): Promise<SecretIdentityScope> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/identities/${encodeURIComponent(args.identityId)}/scopes`,
      workspaceId: args.workspaceId,
      body: {
        store_id: args.storeId,
        access_mode: args.accessMode,
        allow_version_read: args.allowVersionRead,
        allow_rollback: args.allowRollback,
        allow_destroy: args.allowDestroy,
      },
    });
  }

  updateSecretIdentityScope(args: {
    workspaceId: string;
    scopeId: string;
    accessMode?: SecretIdentityPolicyMode;
    allowVersionRead?: boolean;
    allowRollback?: boolean;
    allowDestroy?: boolean;
  }): Promise<SecretIdentityScope> {
    return this.http.request({
      method: "PATCH",
      path: `/secret-store/scopes/${encodeURIComponent(args.scopeId)}`,
      workspaceId: args.workspaceId,
      body: {
        access_mode: args.accessMode,
        allow_version_read: args.allowVersionRead,
        allow_rollback: args.allowRollback,
        allow_destroy: args.allowDestroy,
      },
    });
  }

  deleteSecretIdentityScope(args: {
    workspaceId: string;
    scopeId: string;
  }): Promise<SecretIdentityActionStatus> {
    return this.http.request({
      method: "DELETE",
      path: `/secret-store/scopes/${encodeURIComponent(args.scopeId)}`,
      workspaceId: args.workspaceId,
    });
  }

  /** Permanently removes the identity, scopes, role, policy, and sessions. */
  deleteSecretIdentity(args: {
    workspaceId: string;
    identityId: string;
  }): Promise<SecretIdentityActionStatus> {
    return this.http.request({
      method: "DELETE",
      path: `/secret-store/identities/${encodeURIComponent(args.identityId)}`,
      workspaceId: args.workspaceId,
    });
  }
}
