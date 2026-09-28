import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthMethodMismatchError,
  BadGatewayError,
  BillingDeniedError,
  CasConflictError,
  ConflictError,
  DeletionIncompleteError,
  ForbiddenError,
  IdentityDisabledError,
  Ibee,
  IbeeValidationError,
  InsufficientScopeError,
  NotFoundError,
  OrganizationLifecycleError,
  OrganizationRestrictedError,
  ResourceNotFoundError,
  SECRET_MANAGER_SKU_CODE,
  ScopePermissionError,
  ServiceUnavailableError,
  StoreArchivedError,
  StoreDeletingError,
  StoreNotActiveError,
  UnprocessableEntityError,
  WorkspaceNotAllowedError,
  apiErrorFromResponse,
  checkRollbackTarget,
  isRetrySafe,
  normalizeSearchQuery,
  normalizeSecretName,
  normalizeSecretValue,
  normalizeStoreName,
  validateCas,
  validateIdentityCreate,
  validatePagination,
  validateResourceId,
  validateScopePermissions,
  validateVersions,
  validateWorkspaceId,
} from "../dist/index.js";

const WS = "710995";

/** Routed fetch mock (see networking.test.mjs). Unmatched routes answer 404. */
function router(routes, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const call = {
      url: String(url),
      path: u.pathname.replace(/^\/v1/, ""),
      query: u.searchParams,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    for (const [method, re, resp] of routes) {
      if (method === call.method && re.test(call.path)) {
        let r = typeof resp === "function" ? resp(call) : resp;
        if (!(r && typeof r === "object" && "status" in r && "json" in r)) r = { status: 200, json: r };
        return new Response(JSON.stringify(r.json), {
          status: r.status,
          headers: { "content-type": "application/json", ...(r.headers ?? {}) },
        });
      }
    }
    return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
  };
  return { calls, client: new Ibee({ token: "t", fetch: fetchImpl, maxRetries: opts.maxRetries ?? 0 }) };
}

const vErr = (code, pattern) => (err) => {
  assert.ok(err instanceof IbeeValidationError, `expected IbeeValidationError, got ${err?.name}: ${err?.message}`);
  assert.equal(err.code, code);
  if (pattern) assert.match(err.message, pattern);
  return true;
};

const envelope = (code, message, details) => ({ error: { code, message, ...(details ? { details } : {}) } });

// ------------------------------------------------------------------ rules

test("secret-store workspace rule: 2..128 digits, no leading zero", async () => {
  assert.equal(validateWorkspaceId("12", "secret-store"), "12");
  assert.equal(validateWorkspaceId("7"), "7");
  assert.throws(() => validateWorkspaceId("7", "secret-store"), vErr("invalid_workspace_id", /2 to 128 digits/));
  assert.throws(() => validateWorkspaceId("1".repeat(129), "secret-store"), vErr("invalid_workspace_id"));
  const { calls, client } = router([]);
  await assert.rejects(client.secretStore.listSecretStores({ workspaceId: "7" }), vErr("invalid_workspace_id"));
  await assert.rejects(client.secretStore.getSecret({ workspaceId: "07", secretId: "s" }), vErr("invalid_workspace_id"));
  assert.equal(calls.length, 0);
});

test("resource IDs are trimmed and must not contain path characters", async () => {
  assert.equal(validateResourceId("store_id", "  st-1 "), "st-1");
  for (const bad of ["", "   ", "a/b", "a?b", "a#b", "a\nb", undefined, 5]) {
    assert.throws(() => validateResourceId("store_id", bad), vErr("invalid_store_id"));
  }
  const { calls, client } = router([["GET", /^\/secret-store\/stores\/st%201$/, { id: "x" }]]);
  await client.secretStore.getSecretStore({ workspaceId: WS, storeId: " st 1 " });
  assert.equal(calls[0].path, "/secret-store/stores/st%201");
  await assert.rejects(client.secretStore.getSecretIdentity({ workspaceId: WS, identityId: "../x" }), vErr("invalid_identity_id"));
  await assert.rejects(client.secretStore.deleteSecretIdentityScope({ workspaceId: WS, scopeId: " " }), vErr("invalid_scope_id"));
});

test("pagination and search query rules", () => {
  validatePagination({ page: 1, limit: 200 });
  assert.throws(() => validatePagination({ page: 0 }), vErr("invalid_page"));
  assert.throws(() => validatePagination({ page: true }), vErr("invalid_page"));
  assert.throws(() => validatePagination({ limit: 201 }), vErr("invalid_limit"));
  assert.throws(() => validatePagination({ limit: 1.5 }), vErr("invalid_limit"));
  assert.equal(normalizeSearchQuery("  db  "), "db");
  assert.equal(normalizeSearchQuery("   "), undefined);
  assert.throws(() => normalizeSearchQuery("x".repeat(129)), vErr("invalid_query"));
});

test("store and secret name rules match the portal and backend", () => {
  assert.equal(normalizeStoreName("  Prod Store ", { creating: true }), "Prod Store");
  assert.throws(() => normalizeStoreName("  ", { creating: true }), vErr("invalid_store_name", /required/));
  assert.throws(() => normalizeStoreName("---", { creating: true }), vErr("invalid_store_name", /letter or number/));
  assert.equal(normalizeStoreName("---", { creating: false }), "---");
  assert.throws(() => normalizeStoreName("x".repeat(129), { creating: true }), vErr("invalid_store_name"));

  assert.equal(normalizeSecretName("  DB-Url "), "db-url");
  assert.equal(normalizeSecretName("a1"), "a1");
  for (const bad of ["a", "-db", "db_url", "db.url", "x".repeat(65), "d\nb", ""]) {
    assert.throws(() => normalizeSecretName(bad), vErr("invalid_secret_name"), JSON.stringify(bad));
  }
});

test("secret value rules", () => {
  assert.deepEqual(normalizeSecretValue({ " user ": "admin", port: 5432, tls: false }), { user: "admin", port: 5432, tls: false });
  for (const bad of [null, [], "x", {}, { " ": "v" }, { a: "  " }, { a: "" }, { a: null }, { a: "1", " a": "2" }, new Map()]) {
    assert.throws(() => normalizeSecretValue(bad), vErr("invalid_secret_value"));
  }
  assert.deepEqual(normalizeSecretValue({ a: null, b: "x" }, { allowNullValues: true }), { a: null, b: "x" });
});

test("version, versions and cas rules", () => {
  assert.deepEqual(validateVersions([3, 1, 3]), [3, 1]);
  for (const bad of [[], [0], [1.5], [true], "1", Array.from({ length: 101 }, (_, i) => i + 1)]) {
    assert.throws(() => validateVersions(bad), vErr("invalid_versions"));
  }
  assert.equal(validateCas(undefined), undefined);
  assert.equal(validateCas(0), 0);
  assert.throws(() => validateCas(-1), vErr("invalid_cas"));
  assert.throws(() => validateCas(true), vErr("invalid_cas"));
});

test("identity create body: defaults, trimming and Kubernetes fields", () => {
  assert.deepEqual(validateIdentityCreate({ authMethod: "approle", name: "  api  " }), {
    auth_method: "approle", name: "api", token_policy_mode: "read_only",
  });
  assert.deepEqual(validateIdentityCreate({ authMethod: "approle", name: "api", k8sNamespace: null, k8sServiceAccount: " " }), {
    auth_method: "approle", name: "api", token_policy_mode: "read_only",
  });
  assert.deepEqual(
    validateIdentityCreate({ authMethod: "kubernetes", name: "k", tokenPolicyMode: "read_write", k8sNamespace: " ns ", k8sServiceAccount: " sa " }),
    { auth_method: "kubernetes", name: "k", token_policy_mode: "read_write", k8s_namespace: "ns", k8s_service_account: "sa" },
  );
  assert.throws(() => validateIdentityCreate({ authMethod: "kubernetes", name: "k", k8sNamespace: "ns" }), vErr("invalid_kubernetes_identity"));
  assert.throws(() => validateIdentityCreate({ authMethod: "approle", name: "a", k8sNamespace: "ns" }), vErr("invalid_approle_identity"));
  assert.throws(() => validateIdentityCreate({ authMethod: "ldap", name: "a" }), vErr("invalid_auth_method"));
  assert.throws(() => validateIdentityCreate({ authMethod: "approle", name: " " }), vErr("invalid_identity_name"));
  assert.throws(() => validateIdentityCreate({ authMethod: "approle", name: "a", tokenPolicyMode: "admin" }), vErr("invalid_token_policy_mode"));
});

test("scope permission combinations", () => {
  validateScopePermissions({ accessMode: "read_write", allowRollback: true, allowDestroy: true });
  assert.throws(() => validateScopePermissions({ accessMode: "read_only", allowRollback: true }), vErr("invalid_scope_permissions", /Read-only scopes/));
  assert.throws(() => validateScopePermissions({ accessMode: "read_only", allowDestroy: true }), vErr("invalid_scope_permissions"));
  assert.throws(
    () => validateScopePermissions({ accessMode: "read_write", identityMode: "read_only" }),
    vErr("invalid_scope_permissions", /Read-only identities/),
  );
  validateScopePermissions({ accessMode: "read_only", identityMode: "read_only" });
});

test("rollback target rule", () => {
  const versions = { current_version: 3, versions: { 1: { destroyed: true }, 2: { destroyed: false }, 3: { destroyed: false } } };
  checkRollbackTarget(versions, 2);
  assert.throws(() => checkRollbackTarget(versions, 3), vErr("invalid_rollback_target", /current/));
  assert.throws(() => checkRollbackTarget(versions, 1), vErr("invalid_rollback_target", /destroyed/));
  assert.throws(() => checkRollbackTarget(versions, 9), vErr("invalid_rollback_target", /does not exist/));
});

// ------------------------------------------------------------------ stores

test("listSecretStores validates paging; listAllSecretStores pages until total", async () => {
  const { calls, client } = router([
    ["GET", /^\/secret-store\/stores$/, (c) => {
      const page = Number(c.query.get("page"));
      const stores = page === 1 ? [{ id: "a" }, { id: "b" }] : [{ id: "c" }];
      return { stores, total: 3, page, limit: 2 };
    }],
  ]);
  await assert.rejects(client.secretStore.listSecretStores({ workspaceId: WS, limit: 500 }), vErr("invalid_limit"));
  assert.equal(calls.length, 0);
  const all = await client.secretStore.listAllSecretStores({ workspaceId: WS, includeArchived: true, pageSize: 2 });
  assert.deepEqual(all.map((s) => s.id), ["a", "b", "c"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].query.get("include_archived"), "true");
  assert.equal(calls[1].query.get("page"), "2");
  assert.equal(calls[1].query.get("limit"), "2");
});

test("createSecretStore trims fields and validates the name before sending", async () => {
  const { calls, client } = router([["POST", /^\/secret-store\/stores$/, { status: 201, json: { id: "st1" } }]]);
  await assert.rejects(client.secretStore.createSecretStore({ workspaceId: WS, name: " !! " }), vErr("invalid_store_name"));
  assert.equal(calls.length, 0);
  await client.secretStore.createSecretStore({ workspaceId: WS, name: "  Payments ", description: "  main  " });
  assert.deepEqual(calls[0].body, { name: "Payments", description: "main" });
  await client.secretStore.createSecretStore({ workspaceId: WS, name: "Other" });
  assert.deepEqual(calls[1].body, { name: "Other" });
});

test("createSecretStore billing preflight uses SECRETMA-STD and blocks on denial", async () => {
  let allowed = false;
  const { calls, client } = router([
    ["POST", /^\/billing\/resource-eligibility$/, (c) => ({
      organization_id: "org", allowed, reason: allowed ? "ok" : "insufficient_balance", sku_code: c.body.sku_code,
    })],
    ["POST", /^\/secret-store\/stores$/, { status: 201, json: { id: "st1" } }],
  ]);
  await assert.rejects(
    client.secretStore.createSecretStore({ workspaceId: WS, name: "app", billingPreflight: true }),
    (err) => err instanceof BillingDeniedError && err.topupAllowed === true && /secret store/.test(err.message),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.sku_code, SECRET_MANAGER_SKU_CODE);
  assert.equal(SECRET_MANAGER_SKU_CODE, "SECRETMA-STD");
  allowed = true;
  await client.secretStore.createSecretStore({ workspaceId: WS, name: "app", billingPreflight: true });
  assert.deepEqual(calls.slice(1).map((c) => c.path), ["/billing/resource-eligibility", "/secret-store/stores"]);
});

test("billing preflight is skipped with a warning when the token lacks billing.read", async () => {
  const warnings = [];
  const onWarning = (w) => warnings.push(w);
  process.on("warning", onWarning);
  try {
    const { calls, client } = router([
      ["POST", /^\/billing\/resource-eligibility$/, { status: 403, json: { error: "insufficient_scope", required_scope: "billing.read" } }],
      ["POST", /^\/secret-store\/stores\/st1\/secrets$/, { status: 201, json: { id: "s1" } }],
    ]);
    await client.secretStore.createSecret({ workspaceId: WS, storeId: "st1", name: "Api-Key", value: { k: "v" }, billingPreflight: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].body, { secret_name: "api-key", value: { k: "v" } });
    await new Promise((r) => setImmediate(r));
    assert.ok(warnings.some((w) => w.name === "IbeeBillingWarning"));
  } finally {
    process.off("warning", onWarning);
  }
});

test("createSecretStore ifExists 'return' finds the existing store like the portal", async () => {
  const { calls, client } = router([
    ["POST", /^\/secret-store\/stores$/, { status: 409, json: envelope("CONFLICT", "Store 'Payments' already exists") }],
    ["GET", /^\/secret-store\/stores$/, { stores: [{ id: "x", name: "other" }, { id: "st9", name: "payments", status: "archived" }], total: 2 }],
  ]);
  await assert.rejects(client.secretStore.createSecretStore({ workspaceId: WS, name: "Payments" }), ConflictError);
  const existing = await client.secretStore.createSecretStore({ workspaceId: WS, name: " Payments ", ifExists: "return" });
  assert.equal(existing.id, "st9");
  const list = calls.find((c) => c.method === "GET");
  assert.equal(list.query.get("include_archived"), "true");
  assert.equal(list.query.get("limit"), "200");
  await assert.rejects(client.secretStore.createSecretStore({ workspaceId: WS, name: "x", ifExists: "reuse" }), vErr("invalid_if_exists"));
});

test("createSecretStore is never retried (a retried success would be a conflict)", async () => {
  const { calls, client } = router(
    [["POST", /^\/secret-store\/stores$/, { status: 503, json: {}, headers: { "retry-after": "0" } }]],
    { maxRetries: 2 },
  );
  await assert.rejects(client.secretStore.createSecretStore({ workspaceId: WS, name: "a" }), ServiceUnavailableError);
  assert.equal(calls.length, 1);
});

test("updateSecretStore needs a field and sends only provided fields", async () => {
  const { calls, client } = router([["PATCH", /^\/secret-store\/stores\/st1$/, { id: "st1" }]]);
  await assert.rejects(client.secretStore.updateSecretStore({ workspaceId: WS, storeId: "st1" }), vErr("no_changes"));
  await assert.rejects(client.secretStore.updateSecretStore({ workspaceId: WS, storeId: "st1", name: " " }), vErr("invalid_store_name"));
  await client.secretStore.updateSecretStore({ workspaceId: WS, storeId: "st1", name: " New " });
  assert.deepEqual(calls[0].body, { name: "New" });
});

// ------------------------------------------------------------------ secrets

test("listSecrets trims q and omits it when blank; listAllSecrets pages", async () => {
  const { calls, client } = router([
    ["GET", /^\/secret-store\/stores\/st1\/secrets$/, (c) => ({
      secrets: Number(c.query.get("page")) === 1 ? [{ id: "1" }, { id: "2" }] : [],
      total: 2,
    })],
  ]);
  await client.secretStore.listSecrets({ workspaceId: WS, storeId: "st1", q: "   " });
  assert.equal(calls[0].query.has("q"), false);
  await client.secretStore.listSecrets({ workspaceId: WS, storeId: "st1", q: " db ", page: 1, limit: 100 });
  assert.equal(calls[1].query.get("q"), "db");
  const all = await client.secretStore.listAllSecrets({ workspaceId: WS, storeId: "st1" });
  assert.equal(all.length, 2);
  assert.equal(calls[2].query.get("limit"), "200");
  await assert.rejects(client.secretStore.listSecrets({ workspaceId: WS, storeId: "st1", page: 0 }), vErr("invalid_page"));
});

test("createSecret normalises the name and rejects bad values before sending", async () => {
  const { calls, client } = router([["POST", /secrets$/, { status: 201, json: { id: "s1" } }]]);
  await assert.rejects(client.secretStore.createSecret({ workspaceId: WS, storeId: "st1", name: "db_url", value: { a: "b" } }), vErr("invalid_secret_name"));
  await assert.rejects(client.secretStore.createSecret({ workspaceId: WS, storeId: "st1", name: "db", value: {} }), vErr("invalid_secret_value"));
  await assert.rejects(client.secretStore.createSecret({ workspaceId: WS, storeId: "st1", name: "db", value: { a: " " } }), vErr("invalid_secret_value"));
  assert.equal(calls.length, 0);
  await client.secretStore.createSecret({ workspaceId: WS, storeId: "st1", name: " DB-Url ", value: { " url ": "postgres://x" } });
  assert.deepEqual(calls[0].body, { secret_name: "db-url", value: { url: "postgres://x" } });
});

test("batchCreateSecrets validates every item, size and warns on duplicates", async () => {
  const warnings = [];
  const onWarning = (w) => warnings.push(w);
  process.on("warning", onWarning);
  try {
    const { calls, client } = router([["POST", /secrets:batchIngest$/, { results: [], created_count: 1, skipped_count: 1, failed_count: 0 }]]);
    await assert.rejects(client.secretStore.batchCreateSecrets({ workspaceId: WS, storeId: "st1", secrets: [] }), vErr("invalid_batch_size"));
    await assert.rejects(
      client.secretStore.batchCreateSecrets({ workspaceId: WS, storeId: "st1", secrets: [{ secret_name: "ok", value: { a: "b" } }, { secret_name: "Bad_Name", value: { a: "b" } }] }),
      (err) => err instanceof IbeeValidationError && err.field === "secrets[1].secret_name",
    );
    await assert.rejects(
      client.secretStore.batchCreateSecrets({ workspaceId: WS, storeId: "st1", secrets: [{ secret_name: "big", value: { a: "x".repeat(70_000) } }] }),
      vErr("request_body_too_large"),
    );
    assert.equal(calls.length, 0);
    await client.secretStore.batchCreateSecrets({
      workspaceId: WS, storeId: "st1",
      secrets: [{ secret_name: "API-KEY", value: { k: "1" } }, { secret_name: "api-key", value: { k: "2" } }],
    });
    assert.deepEqual(calls[0].body.secrets.map((s) => s.secret_name), ["api-key", "api-key"]);
    await new Promise((r) => setImmediate(r));
    assert.ok(warnings.some((w) => w.name === "IbeeSecretStoreWarning" && /api-key/.test(w.message)));
  } finally {
    process.off("warning", onWarning);
  }
});

test("updateSecretValue validates value and cas; a 502 with cas becomes CasConflictError", async () => {
  let status = 502;
  const { calls, client } = router([
    ["PUT", /\/value$/, () => ({ status, json: envelope("OPENBAO_ERROR", "OpenBao request failed") })],
  ]);
  await assert.rejects(client.secretStore.updateSecretValue({ workspaceId: WS, secretId: "s1", value: { a: "b" }, cas: -1 }), vErr("invalid_cas"));
  await assert.rejects(client.secretStore.updateSecretValue({ workspaceId: WS, secretId: "s1", value: {} }), vErr("invalid_secret_value"));
  assert.equal(calls.length, 0);
  await assert.rejects(
    client.secretStore.updateSecretValue({ workspaceId: WS, secretId: "s1", value: { a: "b" }, cas: 2 }),
    (err) => err instanceof CasConflictError && err instanceof BadGatewayError && /cas=2/.test(err.message),
  );
  assert.deepEqual(calls[0].body, { value: { a: "b" }, cas: 2 });
  await assert.rejects(
    client.secretStore.updateSecretValue({ workspaceId: WS, secretId: "s1", value: { a: "b" } }),
    (err) => err instanceof BadGatewayError && !(err instanceof CasConflictError),
  );
  assert.deepEqual(calls[1].body, { value: { a: "b" } });
  status = 200;
});

test("patchSecretValue allows null (delete key) but not blank keys", async () => {
  const { calls, client } = router([["PATCH", /\/value$/, {}]]);
  await assert.rejects(client.secretStore.patchSecretValue({ workspaceId: WS, secretId: "s1", value: { " ": "x" } }), vErr("invalid_secret_value"));
  await client.secretStore.patchSecretValue({ workspaceId: WS, secretId: "s1", value: { old: null, " new ": "v" } });
  assert.deepEqual(calls[0].body, { value: { old: null, new: "v" } });
});

test("undelete defaults to the current version; destroy validates and de-duplicates", async () => {
  const { calls, client } = router([
    ["GET", /\/versions$/, { current_version: 4, versions: {} }],
    ["POST", /\/undelete$/, { id: "s1" }],
    ["POST", /\/destroy$/, { status: "destroyed" }],
  ]);
  await client.secretStore.undeleteSecret({ workspaceId: WS, secretId: "s1" });
  assert.deepEqual(calls.map((c) => c.method + " " + c.path), ["GET /secret-store/secrets/s1/versions", "POST /secret-store/secrets/s1/undelete"]);
  assert.deepEqual(calls[1].body, { versions: [4] });
  await client.secretStore.destroySecretVersions({ workspaceId: WS, secretId: "s1", versions: [2, 2, 1] });
  assert.deepEqual(calls[2].body, { versions: [2, 1] });
  await assert.rejects(client.secretStore.destroySecretVersions({ workspaceId: WS, secretId: "s1", versions: [0] }), vErr("invalid_versions"));
});

test("getSecretVersion requires version >= 1", async () => {
  const { calls, client } = router([["GET", /\/versions\/2$/, {}]]);
  await assert.rejects(client.secretStore.getSecretVersion({ workspaceId: WS, secretId: "s1", version: 0 }), vErr("invalid_version"));
  await client.secretStore.getSecretVersion({ workspaceId: WS, secretId: "s1", version: 2 });
  assert.equal(calls.length, 1);
});

test("rollbackSecret checks the target like the portal, skipping on missing scope", async () => {
  let versionsResp = { current_version: 3, versions: { 1: { destroyed: true }, 2: { destroyed: false }, 3: { destroyed: false } } };
  const { calls, client } = router([
    ["GET", /\/versions$/, () => versionsResp],
    ["POST", /\/rollback$/, { data: {} }],
  ]);
  await assert.rejects(client.secretStore.rollbackSecret({ workspaceId: WS, secretId: "s1", version: 3 }), vErr("invalid_rollback_target"));
  await assert.rejects(client.secretStore.rollbackSecret({ workspaceId: WS, secretId: "s1", version: 1 }), vErr("invalid_rollback_target"));
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  await client.secretStore.rollbackSecret({ workspaceId: WS, secretId: "s1", version: 2 });
  assert.deepEqual(calls.at(-1).body, { version: 2 });
  versionsResp = { status: 403, json: { error: "insufficient_scope", required_scope: "secret-store.read" } };
  await client.secretStore.rollbackSecret({ workspaceId: WS, secretId: "s1", version: 3 });
  assert.equal(calls.at(-1).method, "POST");
  const before = calls.length;
  await client.secretStore.rollbackSecret({ workspaceId: WS, secretId: "s1", version: 3, checkTarget: false });
  assert.equal(calls.length, before + 1);
});

// ------------------------------------------------------------------ identities

test("createSecretIdentity always sends token_policy_mode and omits k8s fields for AppRole", async () => {
  const { calls, client } = router([["POST", /\/identities$/, { status: 201, json: { id: "i1" } }]]);
  await client.secretStore.createSecretIdentity({ workspaceId: WS, storeId: "st1", authMethod: "approle", name: " api " });
  assert.deepEqual(calls[0].body, { auth_method: "approle", name: "api", token_policy_mode: "read_only" });
  await assert.rejects(
    client.secretStore.createSecretIdentity({ workspaceId: WS, storeId: "st1", authMethod: "kubernetes", name: "k", k8sNamespace: "ns" }),
    vErr("invalid_kubernetes_identity"),
  );
  assert.equal(calls.length, 1);
});

test("updateSecretIdentity requires tokenPolicyMode and never sends name", async () => {
  const { calls, client } = router([["PATCH", /\/identities\/i1$/, { id: "i1" }]]);
  await assert.rejects(client.secretStore.updateSecretIdentity({ workspaceId: WS, identityId: "i1" }), vErr("invalid_token_policy_mode"));
  await client.secretStore.updateSecretIdentity({ workspaceId: WS, identityId: "i1", tokenPolicyMode: "read_write", name: "x" });
  assert.deepEqual(calls[0].body, { token_policy_mode: "read_write" });
});

test("rotateSecretIdentitySecretId checkAuthMethod refuses Kubernetes and disabled identities", async () => {
  let identity = { id: "i1", auth_method: "kubernetes", status: "active" };
  const { calls, client } = router([
    ["GET", /\/identities\/i1$/, () => identity],
    ["POST", /\/rotate-secret-id$/, { identity_id: "i1", auth_method: "approle" }],
  ]);
  await assert.rejects(
    client.secretStore.rotateSecretIdentitySecretId({ workspaceId: WS, identityId: "i1", checkAuthMethod: true }),
    vErr("invalid_auth_method"),
  );
  identity = { id: "i1", auth_method: "approle", status: "disabled" };
  await assert.rejects(
    client.secretStore.rotateSecretIdentitySecretId({ workspaceId: WS, identityId: "i1", checkAuthMethod: true }),
    vErr("identity_disabled"),
  );
  identity = { id: "i1", auth_method: "approle", status: "active" };
  await client.secretStore.rotateSecretIdentitySecretId({ workspaceId: WS, identityId: "i1", checkAuthMethod: true });
  assert.equal(calls.at(-1).path, "/secret-store/identities/i1/rotate-secret-id");
  // Default: no pre-read.
  const n = calls.length;
  await client.secretStore.rotateSecretIdentitySecretId({ workspaceId: WS, identityId: "i1" });
  assert.equal(calls.length, n + 1);
});

test("getSecretIdentityAccess is never retried (it mints a credential)", async () => {
  assert.equal(isRetrySafe("GET", "/secret-store/identities/i1/access"), false);
  assert.equal(isRetrySafe("GET", "/v1/secret-store/identities/i1/access"), false);
  assert.equal(isRetrySafe("GET", "/secret-store/identities/i1"), true);
  const { calls, client } = router(
    [["GET", /\/access$/, { status: 503, json: {}, headers: { "retry-after": "0" } }]],
    { maxRetries: 2 },
  );
  await assert.rejects(client.secretStore.getSecretIdentityAccess({ workspaceId: WS, identityId: "i1" }), ServiceUnavailableError);
  assert.equal(calls.length, 1);
});

test("createSecretIdentityScope sends portal defaults and checks combinations", async () => {
  const { calls, client } = router([["POST", /\/scopes$/, { status: 201, json: { id: "sc1" } }]]);
  await client.secretStore.createSecretIdentityScope({ workspaceId: WS, identityId: "i1", storeId: " st2 " });
  assert.deepEqual(calls[0].body, {
    store_id: "st2", access_mode: "read_only", allow_version_read: true, allow_rollback: false, allow_destroy: false,
  });
  await assert.rejects(
    client.secretStore.createSecretIdentityScope({ workspaceId: WS, identityId: "i1", storeId: "st2", allowRollback: true }),
    vErr("invalid_scope_permissions"),
  );
  assert.equal(calls.length, 1);
});

test("createSecretIdentityScope checkStore refuses inactive, already granted, and write for read-only identities", async () => {
  const { calls, client } = router([
    ["GET", /\/identities\/i1$/, { id: "i1", token_policy_mode: "read_only" }],
    ["GET", /\/identities\/i1\/scopes$/, { scopes: [{ store_id: "st1" }], total: 1 }],
    ["GET", /^\/secret-store\/stores$/, { stores: [{ id: "st1", status: "active" }, { id: "st2", status: "active" }, { id: "st3", status: "deleting" }], total: 3 }],
    ["POST", /\/scopes$/, { status: 201, json: { id: "sc" } }],
  ]);
  const base = { workspaceId: WS, identityId: "i1", checkStore: true };
  await assert.rejects(client.secretStore.createSecretIdentityScope({ ...base, storeId: "st1" }), vErr("scope_store_already_granted"));
  await assert.rejects(client.secretStore.createSecretIdentityScope({ ...base, storeId: "st3" }), vErr("scope_store_not_active"));
  await assert.rejects(client.secretStore.createSecretIdentityScope({ ...base, storeId: "st2", accessMode: "read_write" }), vErr("invalid_scope_permissions"));
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  await client.secretStore.createSecretIdentityScope({ ...base, storeId: "st2" });
  assert.equal(calls.at(-1).method, "POST");
  const storeList = calls.find((c) => c.path === "/secret-store/stores");
  assert.equal(storeList.query.get("include_archived"), "false");
});

test("updateSecretIdentityScope needs a field, checks same-call combos and hints on 422", async () => {
  const { calls, client } = router([
    ["PATCH", /\/scopes\/sc1$/, { status: 422, json: envelope("VALIDATION_ERROR", "Read-only scopes cannot grant rollback or destroy permissions") }],
  ]);
  await assert.rejects(client.secretStore.updateSecretIdentityScope({ workspaceId: WS, scopeId: "sc1" }), vErr("no_changes"));
  await assert.rejects(
    client.secretStore.updateSecretIdentityScope({ workspaceId: WS, scopeId: "sc1", accessMode: "read_only", allowDestroy: true }),
    vErr("invalid_scope_permissions"),
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    client.secretStore.updateSecretIdentityScope({ workspaceId: WS, scopeId: "sc1", allowRollback: true }),
    (err) => err instanceof UnprocessableEntityError && /read_write/.test(err.message),
  );
  assert.deepEqual(calls[0].body, { allow_rollback: true });
});

// ------------------------------------------------------------------ errors

test("Secret Store 403 messages map to typed ForbiddenError subclasses", () => {
  const path = "/secret-store/stores/st1";
  const cases = [
    ["Operation 'CREATE_RESOURCE' is not allowed while organization is suspended", OrganizationLifecycleError],
    ["Store 'st1' does not belong to workspace '710995'", ResourceNotFoundError],
    ["Store 'st1' is not active", StoreNotActiveError],
    ["Identity is disabled", IdentityDisabledError],
    ["rotate-secret-id is only available for AppRole identities", AuthMethodMismatchError],
    ["Read-only identities cannot be granted write, rollback, or destroy permissions", ScopePermissionError],
  ];
  for (const [message, cls] of cases) {
    const err = apiErrorFromResponse(403, envelope("FORBIDDEN", message), { path });
    assert.ok(err instanceof cls, message);
    assert.ok(err instanceof ForbiddenError);
  }
  const life = apiErrorFromResponse(403, envelope("FORBIDDEN", cases[0][0]), { path });
  assert.ok(life instanceof OrganizationRestrictedError);
  assert.equal(life.state, "suspended");
  assert.equal(life.operation, "CREATE_RESOURCE");
  const nf = apiErrorFromResponse(403, envelope("FORBIDDEN", "Identity 'i-9' does not belong to workspace '12'"), { path: "/secret-store/identities/i-9" });
  assert.equal(nf.kind, "identity");
  assert.equal(nf.resourceId, "i-9");
  assert.ok(!(nf instanceof WorkspaceNotAllowedError));
  // Edge errors keep their generic mapping.
  assert.ok(apiErrorFromResponse(403, { error: "insufficient_scope", required_scope: "secret-store.write" }, { path }) instanceof InsufficientScopeError);
  assert.ok(apiErrorFromResponse(403, { error: "workspace_not_allowed" }, { path }) instanceof WorkspaceNotAllowedError);
  const other = apiErrorFromResponse(403, envelope("FORBIDDEN", "X-Workspace-Id header is invalid"), { path });
  assert.equal(other.constructor, ForbiddenError);
});

test("Secret Store 409/404/503 codes map to typed errors", () => {
  const archived = apiErrorFromResponse(409, envelope("STORE_ARCHIVED", "Store 'st1' is archived. Unarchive it first."), { path: "/secret-store/stores/st1/secrets" });
  assert.ok(archived instanceof StoreArchivedError && archived instanceof ConflictError);
  assert.ok(apiErrorFromResponse(409, envelope("STORE_DELETING", "x"), { path: "/secret-store/stores/st1" }) instanceof StoreDeletingError);
  const conflict = apiErrorFromResponse(409, envelope("CONFLICT", "exists"), { path: "/secret-store/stores" });
  assert.equal(conflict.constructor, ConflictError);
  const inc = apiErrorFromResponse(
    503,
    envelope("LIFECYCLE_OPERATION_INCOMPLETE", "Store deletion incomplete", { store_id: "st1", failed_steps: ["openbao_delete"] }),
    { path: "/secret-store/stores/st1/permanent" },
  );
  assert.ok(inc instanceof DeletionIncompleteError && inc instanceof ServiceUnavailableError);
  assert.deepEqual(inc.failedSteps, ["openbao_delete"]);
  assert.equal(inc.storeId, "st1");
  assert.equal(inc.retryable, true);
  const nf = apiErrorFromResponse(404, envelope("NOT_FOUND", "Secret value not found"), { path: "/secret-store/secrets/s1/value" });
  assert.ok(nf instanceof NotFoundError);
  assert.match(nf.message, /soft-deleted/);
  // Other services are unaffected.
  assert.ok(apiErrorFromResponse(409, { detail: { code: "STORE_ARCHIVED" } }, { path: "/compute/cloud-vms" }).constructor === ConflictError);
});

test("typed errors reach callers through the resource methods", async () => {
  const { client } = router([
    ["GET", /^\/secret-store\/stores\/gone$/, { status: 403, json: envelope("FORBIDDEN", "Store 'gone' does not belong to workspace '710995'") }],
    ["POST", /\/secrets$/, { status: 409, json: envelope("STORE_ARCHIVED", "Store 'st1' is archived. Unarchive it first.") }],
  ]);
  await assert.rejects(client.secretStore.getSecretStore({ workspaceId: WS, storeId: "gone" }), ResourceNotFoundError);
  await assert.rejects(
    client.secretStore.createSecret({ workspaceId: WS, storeId: "st1", name: "ab", value: { a: "b" } }),
    StoreArchivedError,
  );
});
