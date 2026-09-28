import type { HttpClient } from "../core.js";
import {
  BadGatewayError,
  CasConflictError,
  ConflictError,
  InsufficientScopeError,
  StoreArchivedError,
  StoreDeletingError,
  UnprocessableEntityError,
} from "../errors.js";
import { collect, paginatePages } from "../pagination.js";
import {
  IbeeValidationError,
  assertRotateAllowed,
  checkRollbackTarget,
  checkScopeStoreEligibility,
  normalizeSearchQuery,
  normalizeSecretName,
  normalizeSecretValue,
  normalizeStoreDescription,
  normalizeStoreName,
  requireAtLeastOneField,
  validateCas,
  validateIdentityCreate,
  validateOptionalBoolean,
  validatePagination,
  validatePolicyMode,
  validateResourceId,
  validateScopePermissions,
  validateVersion,
  validateVersions,
  validateWorkspaceId,
  MAX_SECRET_BATCH_SIZE,
  SECRET_STORE_MAX_PAGE_LIMIT,
} from "../validation.js";
import { BillingResource, SECRET_MANAGER_SKU_CODE } from "./billing.js";
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

const SERVICE = "secret-store" as const;
const enc = encodeURIComponent;

const storePath = (storeId: unknown) => `/secret-store/stores/${enc(validateResourceId("store_id", storeId))}`;
const secretPath = (secretId: unknown) => `/secret-store/secrets/${enc(validateResourceId("secret_id", secretId))}`;
const identityPath = (identityId: unknown) =>
  `/secret-store/identities/${enc(validateResourceId("identity_id", identityId))}`;
const scopePath = (scopeId: unknown) => `/secret-store/scopes/${enc(validateResourceId("scope_id", scopeId))}`;

const lookup = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Emit a non-fatal warning (Node `process.emitWarning`, else console). */
function emitWarning(message: string, type: string): void {
  const proc = (globalThis as { process?: { emitWarning?: (m: string, t?: string) => void } }).process;
  if (proc && typeof proc.emitWarning === "function") proc.emitWarning(message, type);
  else if (typeof console !== "undefined") console.warn(`${type}: ${message}`);
}

/**
 * Run an optional read-only pre-check. When the token lacks the read scope
 * (403 insufficient_scope) the check is skipped and `undefined` returned:
 * the server enforces the same or a weaker rule.
 */
async function optionalRead<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InsufficientScopeError) return undefined;
    throw err;
  }
}

/** Common per-call options. */
export interface SecretStoreCallOptions {
  /** Aborts the request. */
  signal?: AbortSignal;
}

export interface ListSecretStoresArgs extends SecretStoreCallOptions {
  workspaceId: string;
  /** Page number (>= 1, default 1). */
  page?: number;
  /** Stores per page (1..200, default 50). */
  limit?: number;
  /**
   * Include archived stores (default false on the API). The portal lists
   * with `true` so archived stores can be restored.
   */
  includeArchived?: boolean;
}

export interface ListAllSecretStoresArgs extends SecretStoreCallOptions {
  workspaceId: string;
  includeArchived?: boolean;
  /** Stores requested per page (1..200, default 200). */
  pageSize?: number;
}

export interface CreateSecretStoreArgs extends SecretStoreCallOptions {
  workspaceId: string;
  /** Trimmed; 1..128 characters with at least one letter or digit. Unique per workspace. */
  name: string;
  /** Trimmed. */
  description?: string;
  /**
   * Run the portal's billing check (SECRETMA-STD) before creating. Throws
   * `BillingDeniedError` when billing does not approve. Skipped with a
   * warning when the token lacks `billing.read`.
   */
  billingPreflight?: boolean;
  /**
   * On a name conflict: `"error"` (default) throws `ConflictError`;
   * `"return"` returns the existing store with that name or store key
   * (archived stores included), as the portal does.
   */
  ifExists?: "error" | "return";
}

export interface ListSecretsArgs extends SecretStoreCallOptions {
  workspaceId: string;
  storeId: string;
  /** Case-insensitive name search. Trimmed; omitted when blank; max 128. */
  q?: string;
  page?: number;
  /** 1..200 (default 50). */
  limit?: number;
}

export interface ListAllSecretsArgs extends SecretStoreCallOptions {
  workspaceId: string;
  storeId: string;
  q?: string;
  /** Secrets requested per page (1..200, default 200). */
  pageSize?: number;
}

export interface CreateSecretArgs extends SecretStoreCallOptions {
  workspaceId: string;
  storeId: string;
  /**
   * Secret name (wire `secret_name`). Trimmed and lower-cased; then 2..64
   * characters of lower-case letters, digits and `-`, starting with a letter
   * or digit.
   */
  name: string;
  /** Key/value entries: at least one; keys trimmed and non-blank; string values non-blank. */
  value: Record<string, unknown>;
  /** Run the portal's SECRETMA-STD billing check first (see `createSecretStore`). */
  billingPreflight?: boolean;
}

/** Operations on the Secret Store control plane. */
export class SecretStoreResource {
  private readonly billing: BillingResource;

  constructor(private readonly http: HttpClient) {
    this.billing = new BillingResource(http);
  }

  private async preflight(workspaceId: string, resourceType: "secret_store" | "secret"): Promise<void> {
    try {
      await this.billing.requireResourceEligibility({
        workspaceId,
        skuCode: SECRET_MANAGER_SKU_CODE,
        resourceType,
      });
    } catch (err) {
      if (err instanceof InsufficientScopeError) {
        emitWarning(
          "Skipping the billing preflight: the token lacks billing.read. The API still checks billing on create.",
          "IbeeBillingWarning",
        );
        return;
      }
      throw err;
    }
  }

  /** List stores (one page). Archived stores are listed only with `includeArchived`. */
  async listSecretStores(args: ListSecretStoresArgs): Promise<SecretStoreList> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    validatePagination(args);
    const includeArchived = validateOptionalBoolean(args.includeArchived, "include_archived");
    return this.http.request({
      method: "GET",
      path: "/secret-store/stores",
      workspaceId: args.workspaceId,
      query: { page: args.page, limit: args.limit, include_archived: includeArchived },
      signal: args.signal,
    });
  }

  /** Iterate every store, requesting `pageSize` stores per page. */
  async *iterateSecretStores(args: ListAllSecretStoresArgs): AsyncGenerator<SecretStore, void, undefined> {
    const limit = args.pageSize ?? SECRET_STORE_MAX_PAGE_LIMIT;
    validateWorkspaceId(args.workspaceId, SERVICE);
    validatePagination({ limit });
    yield* paginatePages<SecretStore>(
      (page, pageLimit) =>
        this.listSecretStores({
          workspaceId: args.workspaceId,
          page,
          limit: pageLimit,
          includeArchived: args.includeArchived,
          signal: args.signal,
        }) as Promise<Record<string, unknown>>,
      { limit, itemsKey: "stores" },
    );
  }

  /** Every store across all pages (the API returns at most 200 per page). */
  listAllSecretStores(args: ListAllSecretStoresArgs): Promise<SecretStore[]> {
    return collect(this.iterateSecretStores(args));
  }

  /**
   * Create a store. The name and description are trimmed and validated as
   * in the portal. Never retried automatically (a retried success would
   * come back as a name conflict).
   */
  async createSecretStore(args: CreateSecretStoreArgs): Promise<SecretStore> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const name = normalizeStoreName(args.name, { creating: true });
    const description = normalizeStoreDescription(args.description);
    const ifExists = args.ifExists ?? "error";
    if (ifExists !== "error" && ifExists !== "return") {
      throw new IbeeValidationError("ifExists must be 'error' or 'return'.", "invalid_if_exists", "if_exists");
    }
    if (args.billingPreflight) await this.preflight(args.workspaceId, "secret_store");
    try {
      return await this.http.request<SecretStore>({
        method: "POST",
        path: "/secret-store/stores",
        workspaceId: args.workspaceId,
        body: description === undefined ? { name } : { name, description },
        signal: args.signal,
      });
    } catch (err) {
      if (
        ifExists === "return" &&
        err instanceof ConflictError &&
        !(err instanceof StoreArchivedError) &&
        !(err instanceof StoreDeletingError)
      ) {
        const wanted = lookup(name);
        const stores = await this.listAllSecretStores({
          workspaceId: args.workspaceId,
          includeArchived: true,
          signal: args.signal,
        });
        const existing = stores.find((s) => lookup(s.name) === wanted || lookup(s.store_key) === wanted);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async getSecretStore(args: { workspaceId: string; storeId: string } & SecretStoreCallOptions): Promise<SecretStore> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "GET",
      path: storePath(args.storeId),
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /**
   * Rename a store or change its description (at least one is required).
   * The store key is not regenerated on rename. Archived stores cannot be
   * updated (`StoreArchivedError`).
   */
  async updateSecretStore(args: {
    workspaceId: string;
    storeId: string;
    name?: string;
    description?: string;
  } & SecretStoreCallOptions): Promise<SecretStore> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = storePath(args.storeId);
    const body: Record<string, unknown> = {};
    if (args.name !== undefined && args.name !== null) body.name = normalizeStoreName(args.name, { creating: false });
    const description = normalizeStoreDescription(args.description);
    if (description !== undefined) body.description = description;
    requireAtLeastOneField(body, "Provide name or description to update.");
    return this.http.request({ method: "PATCH", path, workspaceId: args.workspaceId, body, signal: args.signal });
  }

  /**
   * Archive a store. Access is blocked (all runtime sessions are revoked)
   * until the store is restored. Archiving an archived store is a no-op.
   */
  async archiveSecretStore(args: { workspaceId: string; storeId: string } & SecretStoreCallOptions): Promise<SecretStore> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "POST",
      path: `${storePath(args.storeId)}/archive`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /** Restore an archived store. Restoring an active store is a no-op. */
  async unarchiveSecretStore(args: { workspaceId: string; storeId: string } & SecretStoreCallOptions): Promise<SecretStore> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "POST",
      path: `${storePath(args.storeId)}/unarchive`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /**
   * Permanently remove a store, its secrets and its access entries. This
   * cannot be undone. When a cleanup step fails the API answers
   * `DeletionIncompleteError` (503, `failedSteps`); repeating the call is safe.
   */
  async permanentlyDeleteSecretStore(
    args: { workspaceId: string; storeId: string } & SecretStoreCallOptions,
  ): Promise<SecretLifecycleStatus> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "DELETE",
      path: `${storePath(args.storeId)}/permanent`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /** List secrets in a store (one page). Soft-deleted secrets are included. */
  async listSecrets(args: ListSecretsArgs): Promise<SecretList> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = `${storePath(args.storeId)}/secrets`;
    validatePagination(args);
    const q = normalizeSearchQuery(args.q);
    return this.http.request({
      method: "GET",
      path,
      workspaceId: args.workspaceId,
      query: { q, page: args.page, limit: args.limit },
      signal: args.signal,
    });
  }

  /** Iterate every secret in a store, `pageSize` per page. */
  async *iterateSecrets(args: ListAllSecretsArgs): AsyncGenerator<Secret, void, undefined> {
    const limit = args.pageSize ?? SECRET_STORE_MAX_PAGE_LIMIT;
    validateWorkspaceId(args.workspaceId, SERVICE);
    validateResourceId("store_id", args.storeId);
    validatePagination({ limit });
    normalizeSearchQuery(args.q);
    yield* paginatePages<Secret>(
      (page, pageLimit) =>
        this.listSecrets({
          workspaceId: args.workspaceId,
          storeId: args.storeId,
          q: args.q,
          page,
          limit: pageLimit,
          signal: args.signal,
        }) as Promise<Record<string, unknown>>,
      { limit, itemsKey: "secrets" },
    );
  }

  /** Every secret in a store across all pages. */
  listAllSecrets(args: ListAllSecretsArgs): Promise<Secret[]> {
    return collect(this.iterateSecrets(args));
  }

  /**
   * Create a secret. `name` is trimmed and lower-cased (as the portal does)
   * and sent as `secret_name`. `value` needs at least one key/value entry.
   * Never retried automatically.
   */
  async createSecret(args: CreateSecretArgs): Promise<Secret> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = `${storePath(args.storeId)}/secrets`;
    const secretName = normalizeSecretName(args.name, "name");
    const value = normalizeSecretValue(args.value);
    if (args.billingPreflight) await this.preflight(args.workspaceId, "secret");
    return this.http.request({
      method: "POST",
      path,
      workspaceId: args.workspaceId,
      body: { secret_name: secretName, value },
      signal: args.signal,
    });
  }

  /**
   * Create up to 500 secrets without overwriting existing names. Each item
   * is normalised and validated like `createSecret`; the request body must
   * stay within 64 KiB (split larger imports). Names repeated in one request
   * are reported by the API as `skipped` (`duplicate_in_request`); the SDK
   * warns about them.
   */
  async batchCreateSecrets(args: {
    workspaceId: string;
    storeId: string;
    secrets: BatchCreateSecretItem[];
  } & SecretStoreCallOptions): Promise<BatchCreateSecretsResponse> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = `${storePath(args.storeId)}/secrets:batchIngest`;
    if (!Array.isArray(args.secrets) || args.secrets.length === 0 || args.secrets.length > MAX_SECRET_BATCH_SIZE) {
      throw new IbeeValidationError(
        `secrets must contain 1 to ${MAX_SECRET_BATCH_SIZE} items.`,
        "invalid_batch_size",
        "secrets",
      );
    }
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    const secrets = args.secrets.map((item, i) => {
      if (!item || typeof item !== "object") {
        throw new IbeeValidationError(`secrets[${i}] must be an object.`, "invalid_batch_item", `secrets[${i}]`);
      }
      const secretName = normalizeSecretName(item.secret_name, `secrets[${i}].secret_name`);
      const value = normalizeSecretValue(item.value, { field: `secrets[${i}].value` });
      if (seen.has(secretName)) duplicates.add(secretName);
      seen.add(secretName);
      return { secret_name: secretName, value };
    });
    if (duplicates.size) {
      emitWarning(
        `Duplicate secret names in one batch are skipped by the API: ${[...duplicates].join(", ")}`,
        "IbeeSecretStoreWarning",
      );
    }
    return this.http.request({
      method: "POST",
      path,
      workspaceId: args.workspaceId,
      body: { secrets },
      signal: args.signal,
    });
  }

  async getSecret(args: { workspaceId: string; secretId: string } & SecretStoreCallOptions): Promise<Secret> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "GET",
      path: secretPath(args.secretId),
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /**
   * Soft-delete a secret (its latest version). The API returns the
   * soft-deleted Secret; `getSecretValue` then answers 404 until
   * `undeleteSecret` or a new `updateSecretValue`.
   */
  async deleteSecret(args: { workspaceId: string; secretId: string } & SecretStoreCallOptions): Promise<Secret> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "DELETE",
      path: secretPath(args.secretId),
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /** Read the current value. Sensitive: do not log the response. */
  async getSecretValue(args: { workspaceId: string; secretId: string } & SecretStoreCallOptions): Promise<SecretValue> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "GET",
      path: `${secretPath(args.secretId)}/value`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /**
   * Replace the value (creates a new version; reactivates a soft-deleted
   * secret). `cas` (integer >= 0) is an optional check-and-set version; a
   * mismatch throws `CasConflictError`. Never retried automatically.
   */
  async updateSecretValue(args: {
    workspaceId: string;
    secretId: string;
    value: Record<string, unknown>;
    cas?: number;
  } & SecretStoreCallOptions): Promise<SecretValue> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = `${secretPath(args.secretId)}/value`;
    const value = normalizeSecretValue(args.value);
    const cas = validateCas(args.cas);
    try {
      return await this.http.request<SecretValue>({
        method: "PUT",
        path,
        workspaceId: args.workspaceId,
        body: cas === undefined ? { value } : { value, cas },
        signal: args.signal,
      });
    } catch (err) {
      if (cas !== undefined && err instanceof BadGatewayError) {
        const wrapped = new CasConflictError(
          err.statusCode,
          err.body,
          `${err.message} (the secret's current version probably differs from cas=${cas})`,
          { headers: err.headers, idempotencyKey: err.idempotencyKey },
        );
        throw wrapped;
      }
      throw err;
    }
  }

  /**
   * Merge keys into the current value and create a new version. A `null`
   * value deletes that key.
   */
  async patchSecretValue(args: {
    workspaceId: string;
    secretId: string;
    value: Record<string, unknown>;
  } & SecretStoreCallOptions): Promise<SecretValue> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = `${secretPath(args.secretId)}/value`;
    const value = normalizeSecretValue(args.value, { allowNullValues: true });
    return this.http.request({ method: "PATCH", path, workspaceId: args.workspaceId, body: { value }, signal: args.signal });
  }

  /**
   * Restore soft-deleted versions (1..100, de-duplicated). When `versions`
   * is omitted the current version is restored (a delete soft-deletes only
   * the latest version).
   */
  async undeleteSecret(args: {
    workspaceId: string;
    secretId: string;
    versions?: number[];
  } & SecretStoreCallOptions): Promise<Secret> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = `${secretPath(args.secretId)}/undelete`;
    let versions: number[];
    if (args.versions === undefined || args.versions === null) {
      const current = await this.listSecretVersions({
        workspaceId: args.workspaceId,
        secretId: args.secretId,
        signal: args.signal,
      });
      versions = validateVersions([current?.current_version]);
    } else {
      versions = validateVersions(args.versions);
    }
    return this.http.request({ method: "POST", path, workspaceId: args.workspaceId, body: { versions }, signal: args.signal });
  }

  /** Irreversibly destroy selected versions (1..100, de-duplicated). */
  async destroySecretVersions(args: {
    workspaceId: string;
    secretId: string;
    versions: number[];
  } & SecretStoreCallOptions): Promise<SecretLifecycleStatus> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = `${secretPath(args.secretId)}/destroy`;
    const versions = validateVersions(args.versions);
    return this.http.request({ method: "POST", path, workspaceId: args.workspaceId, body: { versions }, signal: args.signal });
  }

  /** Irreversibly remove every version and the secret metadata. */
  async permanentlyDeleteSecret(
    args: { workspaceId: string; secretId: string } & SecretStoreCallOptions,
  ): Promise<SecretLifecycleStatus> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "DELETE",
      path: `${secretPath(args.secretId)}/permanent`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /** List version metadata without returning secret values. */
  async listSecretVersions(args: { workspaceId: string; secretId: string } & SecretStoreCallOptions): Promise<SecretVersions> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "GET",
      path: `${secretPath(args.secretId)}/versions`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /** Return one version (>= 1), including its secret value. */
  async getSecretVersion(args: {
    workspaceId: string;
    secretId: string;
    version: number;
  } & SecretStoreCallOptions): Promise<SecretVersion> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = secretPath(args.secretId);
    const version = validateVersion(args.version);
    return this.http.request({
      method: "GET",
      path: `${path}/versions/${version}`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /**
   * Copy a previous version into a new current version. With `checkTarget`
   * (default true) the versions are read first and, as in the portal, the
   * current version and destroyed or missing versions are refused. The
   * check is skipped when the token cannot read versions.
   */
  async rollbackSecret(args: {
    workspaceId: string;
    secretId: string;
    version: number;
    checkTarget?: boolean;
  } & SecretStoreCallOptions): Promise<SecretValue> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = `${secretPath(args.secretId)}/rollback`;
    const version = validateVersion(args.version);
    if (args.checkTarget !== false) {
      const versions = await optionalRead(() =>
        this.listSecretVersions({ workspaceId: args.workspaceId, secretId: args.secretId, signal: args.signal }),
      );
      if (versions) checkRollbackTarget(versions, version);
    }
    return this.http.request({ method: "POST", path, workspaceId: args.workspaceId, body: { version }, signal: args.signal });
  }

  async listSecretIdentities(
    args: { workspaceId: string; storeId: string } & SecretStoreCallOptions,
  ): Promise<SecretIdentityList> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "GET",
      path: `${storePath(args.storeId)}/identities`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /**
   * Create an application identity for an active store. The name is trimmed
   * (1..128, unique per workspace, cannot be changed later).
   * `tokenPolicyMode` defaults to `read_only` and is always sent. Kubernetes
   * identities need `k8sNamespace` and `k8sServiceAccount`; AppRole
   * identities must not set them. Credentials are not returned: use
   * `getSecretIdentityAccess`.
   */
  async createSecretIdentity(args: {
    workspaceId: string;
    storeId: string;
    authMethod: SecretIdentityAuthMethod;
    name: string;
    tokenPolicyMode?: SecretIdentityPolicyMode;
    k8sNamespace?: string | null;
    k8sServiceAccount?: string | null;
  } & SecretStoreCallOptions): Promise<SecretIdentity> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = `${storePath(args.storeId)}/identities`;
    const body = validateIdentityCreate(args);
    return this.http.request({ method: "POST", path, workspaceId: args.workspaceId, body, signal: args.signal });
  }

  async getSecretIdentity(args: { workspaceId: string; identityId: string } & SecretStoreCallOptions): Promise<SecretIdentity> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "GET",
      path: identityPath(args.identityId),
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /**
   * Change the identity's token policy mode. `tokenPolicyMode` is required
   * (an empty update changes nothing). Switching to `read_only` clears
   * rollback and destroy on every scope and revokes active sessions.
   */
  async updateSecretIdentity(args: {
    workspaceId: string;
    identityId: string;
    /** Required. */
    tokenPolicyMode?: SecretIdentityPolicyMode;
  } & SecretStoreCallOptions): Promise<SecretIdentity> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = identityPath(args.identityId);
    const mode = validatePolicyMode(args.tokenPolicyMode, "token_policy_mode");
    return this.http.request({
      method: "PATCH",
      path,
      workspaceId: args.workspaceId,
      body: { token_policy_mode: mode },
      signal: args.signal,
    });
  }

  /** Disable an identity (revokes its sessions). Idempotent. */
  async disableSecretIdentity(args: { workspaceId: string; identityId: string } & SecretStoreCallOptions): Promise<SecretIdentity> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "POST",
      path: `${identityPath(args.identityId)}/disable`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /** Enable a disabled identity. Idempotent. */
  async enableSecretIdentity(args: { workspaceId: string; identityId: string } & SecretStoreCallOptions): Promise<SecretIdentity> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "POST",
      path: `${identityPath(args.identityId)}/enable`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /**
   * Login details for an active identity. For AppRole every call mints a new
   * secret ID that is not revoked, so this call is never retried
   * automatically. Sensitive: do not log the response. A disabled identity
   * throws `IdentityDisabledError`.
   */
  async getSecretIdentityAccess(
    args: { workspaceId: string; identityId: string } & SecretStoreCallOptions,
  ): Promise<SecretIdentityAccess> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "GET",
      path: `${identityPath(args.identityId)}/access`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /**
   * Generate a fresh secret ID for an active AppRole identity. The previous
   * secret ID is not revoked. With `checkAuthMethod` the identity is read
   * first and a Kubernetes or disabled identity is refused locally (the
   * portal only offers rotation for AppRole). Never retried automatically.
   */
  async rotateSecretIdentitySecretId(args: {
    workspaceId: string;
    identityId: string;
    checkAuthMethod?: boolean;
  } & SecretStoreCallOptions): Promise<SecretIdentityAccess> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = `${identityPath(args.identityId)}/rotate-secret-id`;
    if (args.checkAuthMethod) {
      const identity = await optionalRead(() =>
        this.getSecretIdentity({ workspaceId: args.workspaceId, identityId: args.identityId, signal: args.signal }),
      );
      if (identity) assertRotateAllowed(identity);
    }
    return this.http.request({ method: "POST", path, workspaceId: args.workspaceId, signal: args.signal });
  }

  /** Revoke every active session of an identity. */
  async revokeSecretIdentitySessions(
    args: { workspaceId: string; identityId: string } & SecretStoreCallOptions,
  ): Promise<SecretIdentityActionStatus> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "POST",
      path: `${identityPath(args.identityId)}/revoke`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  async listSecretIdentityScopes(
    args: { workspaceId: string; identityId: string } & SecretStoreCallOptions,
  ): Promise<SecretIdentityScopeList> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "GET",
      path: `${identityPath(args.identityId)}/scopes`,
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /**
   * Grant an identity access to another store. Defaults match the portal:
   * `accessMode` `read_only`, `allowVersionRead` true, `allowRollback` and
   * `allowDestroy` false (all sent explicitly). Rollback and destroy need
   * `read_write`. With `checkStore` the SDK first reads the identity, its
   * scopes and the active stores, and refuses a store that is not active or
   * already granted, or write access for a read-only identity (as the
   * portal does). Checks the token cannot read are skipped.
   */
  async createSecretIdentityScope(args: {
    workspaceId: string;
    identityId: string;
    storeId: string;
    accessMode?: SecretIdentityPolicyMode;
    allowVersionRead?: boolean;
    allowRollback?: boolean;
    allowDestroy?: boolean;
    checkStore?: boolean;
  } & SecretStoreCallOptions): Promise<SecretIdentityScope> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = `${identityPath(args.identityId)}/scopes`;
    const storeId = validateResourceId("store_id", args.storeId);
    const accessMode =
      args.accessMode === undefined || args.accessMode === null
        ? "read_only"
        : validatePolicyMode(args.accessMode, "access_mode");
    const allowVersionRead = validateOptionalBoolean(args.allowVersionRead, "allow_version_read") ?? true;
    const allowRollback = validateOptionalBoolean(args.allowRollback, "allow_rollback") ?? false;
    const allowDestroy = validateOptionalBoolean(args.allowDestroy, "allow_destroy") ?? false;
    validateScopePermissions({ accessMode, allowRollback, allowDestroy });

    if (args.checkStore) {
      const common = { workspaceId: args.workspaceId, signal: args.signal };
      const identity = await optionalRead(() =>
        this.getSecretIdentity({ ...common, identityId: args.identityId }),
      );
      if (identity) {
        validateScopePermissions({
          accessMode,
          allowRollback,
          allowDestroy,
          identityMode: identity.token_policy_mode,
        });
      }
      const scopes = await optionalRead(() =>
        this.listSecretIdentityScopes({ ...common, identityId: args.identityId }),
      );
      const stores = await optionalRead(() =>
        this.listAllSecretStores({ ...common, includeArchived: false }),
      );
      checkScopeStoreEligibility(
        storeId,
        stores?.filter((s) => lookup(s.status) === "active").map((s) => String(s.id)),
        scopes?.scopes?.map((s) => String(s.store_id)),
      );
    }

    return this.http.request({
      method: "POST",
      path,
      workspaceId: args.workspaceId,
      body: {
        store_id: storeId,
        access_mode: accessMode,
        allow_version_read: allowVersionRead,
        allow_rollback: allowRollback,
        allow_destroy: allowDestroy,
      },
      signal: args.signal,
    });
  }

  /**
   * Update a scope (at least one field). Fields sent in the same call are
   * checked: `read_only` cannot be combined with rollback or destroy. The
   * API also checks the merged scope.
   */
  async updateSecretIdentityScope(args: {
    workspaceId: string;
    scopeId: string;
    accessMode?: SecretIdentityPolicyMode;
    allowVersionRead?: boolean;
    allowRollback?: boolean;
    allowDestroy?: boolean;
  } & SecretStoreCallOptions): Promise<SecretIdentityScope> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    const path = scopePath(args.scopeId);
    const body: Record<string, unknown> = {};
    if (args.accessMode !== undefined && args.accessMode !== null) {
      body.access_mode = validatePolicyMode(args.accessMode, "access_mode");
    }
    const flags: Array<[keyof typeof args, string]> = [
      ["allowVersionRead", "allow_version_read"],
      ["allowRollback", "allow_rollback"],
      ["allowDestroy", "allow_destroy"],
    ];
    for (const [arg, field] of flags) {
      const v = validateOptionalBoolean(args[arg], field);
      if (v !== undefined) body[field] = v;
    }
    requireAtLeastOneField(body, "Provide at least one of accessMode, allowVersionRead, allowRollback or allowDestroy.");
    validateScopePermissions({
      accessMode: body.access_mode,
      allowRollback: body.allow_rollback,
      allowDestroy: body.allow_destroy,
    });
    try {
      return await this.http.request<SecretIdentityScope>({
        method: "PATCH",
        path,
        workspaceId: args.workspaceId,
        body,
        signal: args.signal,
      });
    } catch (err) {
      if (err instanceof UnprocessableEntityError && /Read-only scopes cannot grant/.test(err.message)) {
        throw new UnprocessableEntityError(
          err.statusCode,
          err.body,
          `${err.message} (send accessMode 'read_write' or clear allowRollback/allowDestroy)`,
          { headers: err.headers },
        );
      }
      throw err;
    }
  }

  /** Remove a scope; the identity loses access to that store. */
  async deleteSecretIdentityScope(
    args: { workspaceId: string; scopeId: string } & SecretStoreCallOptions,
  ): Promise<SecretIdentityActionStatus> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "DELETE",
      path: scopePath(args.scopeId),
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }

  /** Permanently removes the identity, its scopes, permissions and login details. */
  async deleteSecretIdentity(
    args: { workspaceId: string; identityId: string } & SecretStoreCallOptions,
  ): Promise<SecretIdentityActionStatus> {
    validateWorkspaceId(args.workspaceId, SERVICE);
    return this.http.request({
      method: "DELETE",
      path: identityPath(args.identityId),
      workspaceId: args.workspaceId,
      signal: args.signal,
    });
  }
}
