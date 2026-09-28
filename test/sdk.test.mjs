import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, Ibee, IbeeEnvironment } from "../dist/index.js";

/** Build a client with a stub fetch that records the request and returns `resp`. */
function stub(resp = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const requestUrl = String(url);
    calls.push({
      url: requestUrl,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body,
    });
    const requestBody = init.body ? JSON.parse(init.body) : {};
    const isBilling = requestUrl.includes("/billing/resource-eligibility?");
    const isPlans = requestUrl.includes("/compute/plans?");
    const defaultPlans = {
      plans: [
        { plan_id: "plan-1", code: "STANDARD-2-8-50", selectable: true, pricing_status: "priced" },
        { plan_id: "gpu-plan-1", code: "GPU-A100-1", selectable: true, pricing_status: "priced" },
      ],
    };
    const defaultDecision = {
      organization_id: "org1",
      allowed: true,
      reason: "ok",
      sku_code: requestBody.sku_code ?? null,
    };
    const json = isBilling
      ? (resp.billingJson ?? (resp.status >= 400 || typeof resp.json?.allowed === "boolean" ? resp.json : defaultDecision))
      : isPlans
        ? (resp.catalogJson ?? defaultPlans)
        : (resp.json ?? {});
    const status = isBilling ? (resp.billingStatus ?? resp.status ?? 200) : (resp.status ?? 200);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

test("defaults to the production base URL", async () => {
  const { calls, fetchImpl } = stub({ json: { buckets: [] } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.objectStorage.listBuckets({ workspaceId: "710995" });
  assert.match(calls[0].url, /^https:\/\/api\.ibee\.ai\/v1\/object-storage\/buckets/);
  assert.match(calls[0].url, /workspace_id=710995/);
});

test("rejects invalid workspace IDs before transport", async () => {
  const { calls, fetchImpl } = stub();
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  const message = "workspace_id must be a positive numeric string (for example, '710995').";

  for (const workspaceId of ["", "0", "01", "-1", "abc", "1.0", " 1"]) {
    await assert.rejects(
      client.objectStorage.listBuckets({ workspaceId }),
      (error) => error instanceof Error && error.message === message,
    );
  }

  assert.equal(calls.length, 0);
});

test("DEVELOPMENT environment targets .co.in", async () => {
  const { calls, fetchImpl } = stub();
  const client = new Ibee({ token: "t", environment: IbeeEnvironment.DEVELOPMENT, fetch: fetchImpl });
  await client.secretStore.listSecretStores({ workspaceId: "12" });
  assert.match(calls[0].url, /^https:\/\/api\.ibee\.co\.in\/v1\/secret-store\/stores/);
});

test("sends bearer auth header", async () => {
  const { calls, fetchImpl } = stub();
  const client = new Ibee({
    token: "ibee_dev_key_abc",
    environment: IbeeEnvironment.DEVELOPMENT,
    fetch: fetchImpl,
  });
  await client.secretStore.listSecretStores({ workspaceId: "12" });
  assert.equal(calls[0].headers.get("authorization"), "Bearer ibee_dev_key_abc");
});

test("token does not leak via JSON.stringify of the client", () => {
  const client = new Ibee({ token: "ibee_dev_key_secret", environment: IbeeEnvironment.DEVELOPMENT });
  assert.ok(!JSON.stringify(client).includes("ibee_dev_key_secret"));
});

test("createBucket requires a storage region and never sends a compute site", async () => {
  const { calls, fetchImpl } = stub({ json: { name: "b" } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.objectStorage.createBucket({
    workspaceId: "12",
    name: "bkt",
    region: "in-south-1",
    objectLockEnabled: true,
    defaultRetention: { mode: "GOVERNANCE", days: 30 },
  });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].body);
  assert.equal("site_id" in body, false);
  assert.equal(body.region, "in-south-1");
  assert.equal(body.object_lock_enabled, true);
  assert.deepEqual(body.default_retention, { mode: "GOVERNANCE", days: 30 });
  assert.equal(calls[0].method, "POST");
});

test("createSecret sends secret_name and value (spec field names)", async () => {
  const { calls, fetchImpl } = stub({ json: { id: "s1" } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.secretStore.createSecret({
    workspaceId: "12",
    storeId: "st1",
    name: "db-url",
    value: { url: "postgres://x" },
  });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.secret_name, "db-url");
  assert.deepEqual(body.value, { url: "postgres://x" });
  assert.equal(body.name, undefined);
  assert.equal(body.data, undefined);
});

test("updateSecretValue sends value and optional cas", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.secretStore.updateSecretValue({
    workspaceId: "12",
    secretId: "sec1",
    value: { k: "v" },
    cas: 3,
  });
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(body.value, { k: "v" });
  assert.equal(body.cas, 3);
});

test("Secret Store exposes all 35 control-plane operations", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
  const client = new Ibee({ token: "t", baseUrl: "https://api.example.test/v1", fetch: fetchImpl });
  const workspaceId = "973318";
  const storeId = "store-123";
  const secretId = "secret-456";

  const methods = [
    "listSecretStores", "createSecretStore", "getSecretStore", "updateSecretStore",
    "archiveSecretStore", "unarchiveSecretStore", "permanentlyDeleteSecretStore",
    "listSecrets", "createSecret", "batchCreateSecrets", "getSecret", "deleteSecret",
    "getSecretValue", "updateSecretValue", "patchSecretValue", "undeleteSecret",
    "destroySecretVersions", "permanentlyDeleteSecret", "listSecretVersions",
    "getSecretVersion", "rollbackSecret",
    "listSecretIdentities", "createSecretIdentity", "getSecretIdentity",
    "updateSecretIdentity", "disableSecretIdentity", "enableSecretIdentity",
    "getSecretIdentityAccess", "rotateSecretIdentitySecretId",
    "revokeSecretIdentitySessions", "listSecretIdentityScopes",
    "createSecretIdentityScope", "updateSecretIdentityScope",
    "deleteSecretIdentityScope", "deleteSecretIdentity",
  ];
  for (const method of methods) {
    assert.equal(typeof client.secretStore[method], "function", `secretStore.${method}`);
  }

  await client.secretStore.listSecretStores({ workspaceId, page: 2, limit: 25, includeArchived: true });
  await client.secretStore.createSecretStore({ workspaceId, name: "production" });
  await client.secretStore.getSecretStore({ workspaceId, storeId });
  await client.secretStore.updateSecretStore({ workspaceId, storeId, description: "updated" });
  await client.secretStore.archiveSecretStore({ workspaceId, storeId });
  await client.secretStore.unarchiveSecretStore({ workspaceId, storeId });
  await client.secretStore.permanentlyDeleteSecretStore({ workspaceId, storeId });
  await client.secretStore.listSecrets({ workspaceId, storeId, q: "database", page: 3, limit: 10 });
  await client.secretStore.createSecret({ workspaceId, storeId, name: "database-url", value: { url: "redacted" } });
  await client.secretStore.batchCreateSecrets({
    workspaceId,
    storeId,
    secrets: [{ secret_name: "api-key", value: { key: "redacted" } }],
  });
  await client.secretStore.getSecret({ workspaceId, secretId });
  await client.secretStore.deleteSecret({ workspaceId, secretId });
  await client.secretStore.getSecretValue({ workspaceId, secretId });
  await client.secretStore.updateSecretValue({ workspaceId, secretId, value: { key: "replacement" }, cas: 1 });
  await client.secretStore.patchSecretValue({ workspaceId, secretId, value: { username: "ibee" } });
  await client.secretStore.undeleteSecret({ workspaceId, secretId, versions: [1] });
  await client.secretStore.destroySecretVersions({ workspaceId, secretId, versions: [1] });
  await client.secretStore.permanentlyDeleteSecret({ workspaceId, secretId });
  await client.secretStore.listSecretVersions({ workspaceId, secretId });
  await client.secretStore.getSecretVersion({ workspaceId, secretId, version: 1 });
  await client.secretStore.rollbackSecret({ workspaceId, secretId, version: 1, checkTarget: false });
  const identityId = "identity-789";
  const scopeId = "scope-123";
  await client.secretStore.listSecretIdentities({ workspaceId, storeId });
  await client.secretStore.createSecretIdentity({
    workspaceId,
    storeId,
    authMethod: "approle",
    name: "payments-api",
    tokenPolicyMode: "read_write",
  });
  await client.secretStore.getSecretIdentity({ workspaceId, identityId });
  await client.secretStore.updateSecretIdentity({ workspaceId, identityId, tokenPolicyMode: "read_only" });
  await client.secretStore.disableSecretIdentity({ workspaceId, identityId });
  await client.secretStore.enableSecretIdentity({ workspaceId, identityId });
  await client.secretStore.getSecretIdentityAccess({ workspaceId, identityId });
  await client.secretStore.rotateSecretIdentitySecretId({ workspaceId, identityId });
  await client.secretStore.revokeSecretIdentitySessions({ workspaceId, identityId });
  await client.secretStore.listSecretIdentityScopes({ workspaceId, identityId });
  await client.secretStore.createSecretIdentityScope({
    workspaceId,
    identityId,
    storeId,
    accessMode: "read_write",
    allowRollback: true,
  });
  await client.secretStore.updateSecretIdentityScope({
    workspaceId,
    scopeId,
    accessMode: "read_only",
  });
  await client.secretStore.deleteSecretIdentityScope({ workspaceId, scopeId });
  await client.secretStore.deleteSecretIdentity({ workspaceId, identityId });

  const secretCalls = calls.filter(
    (call) => new URL(call.url).pathname !== "/v1/billing/resource-eligibility",
  );
  assert.deepEqual(
    secretCalls.map((call) => [call.method, new URL(call.url).pathname]),
    [
      ["GET", "/v1/secret-store/stores"],
      ["POST", "/v1/secret-store/stores"],
      ["GET", `/v1/secret-store/stores/${storeId}`],
      ["PATCH", `/v1/secret-store/stores/${storeId}`],
      ["POST", `/v1/secret-store/stores/${storeId}/archive`],
      ["POST", `/v1/secret-store/stores/${storeId}/unarchive`],
      ["DELETE", `/v1/secret-store/stores/${storeId}/permanent`],
      ["GET", `/v1/secret-store/stores/${storeId}/secrets`],
      ["POST", `/v1/secret-store/stores/${storeId}/secrets`],
      ["POST", `/v1/secret-store/stores/${storeId}/secrets:batchIngest`],
      ["GET", `/v1/secret-store/secrets/${secretId}`],
      ["DELETE", `/v1/secret-store/secrets/${secretId}`],
      ["GET", `/v1/secret-store/secrets/${secretId}/value`],
      ["PUT", `/v1/secret-store/secrets/${secretId}/value`],
      ["PATCH", `/v1/secret-store/secrets/${secretId}/value`],
      ["POST", `/v1/secret-store/secrets/${secretId}/undelete`],
      ["POST", `/v1/secret-store/secrets/${secretId}/destroy`],
      ["DELETE", `/v1/secret-store/secrets/${secretId}/permanent`],
      ["GET", `/v1/secret-store/secrets/${secretId}/versions`],
      ["GET", `/v1/secret-store/secrets/${secretId}/versions/1`],
      ["POST", `/v1/secret-store/secrets/${secretId}/rollback`],
      ["GET", `/v1/secret-store/stores/${storeId}/identities`],
      ["POST", `/v1/secret-store/stores/${storeId}/identities`],
      ["GET", `/v1/secret-store/identities/${identityId}`],
      ["PATCH", `/v1/secret-store/identities/${identityId}`],
      ["POST", `/v1/secret-store/identities/${identityId}/disable`],
      ["POST", `/v1/secret-store/identities/${identityId}/enable`],
      ["GET", `/v1/secret-store/identities/${identityId}/access`],
      ["POST", `/v1/secret-store/identities/${identityId}/rotate-secret-id`],
      ["POST", `/v1/secret-store/identities/${identityId}/revoke`],
      ["GET", `/v1/secret-store/identities/${identityId}/scopes`],
      ["POST", `/v1/secret-store/identities/${identityId}/scopes`],
      ["PATCH", `/v1/secret-store/scopes/${scopeId}`],
      ["DELETE", `/v1/secret-store/scopes/${scopeId}`],
      ["DELETE", `/v1/secret-store/identities/${identityId}`],
    ],
  );
  for (const call of calls) {
    assert.equal(new URL(call.url).searchParams.get("workspace_id"), workspaceId);
  }

  const storeListQuery = new URL(secretCalls[0].url).searchParams;
  assert.equal(storeListQuery.get("page"), "2");
  assert.equal(storeListQuery.get("limit"), "25");
  assert.equal(storeListQuery.get("include_archived"), "true");
  const secretListQuery = new URL(secretCalls[7].url).searchParams;
  assert.equal(secretListQuery.get("q"), "database");
  assert.equal(secretListQuery.get("page"), "3");
  assert.equal(secretListQuery.get("limit"), "10");

  assert.deepEqual(JSON.parse(secretCalls[1].body), { name: "production" });
  assert.deepEqual(JSON.parse(secretCalls[3].body), { description: "updated" });
  assert.deepEqual(JSON.parse(secretCalls[8].body), {
    secret_name: "database-url",
    value: { url: "redacted" },
  });
  assert.deepEqual(JSON.parse(secretCalls[9].body), {
    secrets: [{ secret_name: "api-key", value: { key: "redacted" } }],
  });
  assert.deepEqual(JSON.parse(secretCalls[13].body), {
    value: { key: "replacement" },
    cas: 1,
  });
  assert.deepEqual(JSON.parse(secretCalls[14].body), { value: { username: "ibee" } });
  assert.deepEqual(JSON.parse(secretCalls[15].body), { versions: [1] });
  assert.deepEqual(JSON.parse(secretCalls[16].body), { versions: [1] });
  assert.deepEqual(JSON.parse(secretCalls[20].body), { version: 1 });
  assert.deepEqual(JSON.parse(secretCalls[22].body), {
    auth_method: "approle",
    name: "payments-api",
    token_policy_mode: "read_write",
  });
  assert.deepEqual(JSON.parse(secretCalls[24].body), { token_policy_mode: "read_only" });
  assert.deepEqual(JSON.parse(secretCalls[31].body), {
    store_id: storeId,
    access_mode: "read_write",
    // Portal defaults are sent explicitly (0.4.0).
    allow_version_read: true,
    allow_rollback: true,
    allow_destroy: false,
  });
  assert.deepEqual(JSON.parse(secretCalls[32].body), { access_mode: "read_only" });
});

const VM1 = "64b0000000000000000000a1";
const GPU1 = "64b0000000000000000000b2";
const OP1 = "op_64b0000000000000000000f1";
const PLAN_SKU = { sku_id: 11, sku_code: "STANDARD-2-8-50" };
const SNAP_SKU = { sku_id: 21, sku_code: "SNAPSHOT-STD", product_code: "snapshot_storage" };
const BACKUP_SKU = { sku_id: 31, sku_code: "BACKUP-STD", product_code: "backup_storage" };

test("cloudVms.create attaches an idempotency key and never omits site_id", async () => {
  const { calls, fetchImpl } = stub({ json: { operation_id: OP1 } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await assert.rejects(
    client.cloudVms.create({
      workspaceId: "1", name: "web", plan_id: "plan-1", template_id: "image-1",
      os_distro: "ubuntu", os_type: "linux", cpu: 2, ram_mb: 4096,
    }),
    (err) => err.code === "site_required",
  );
  assert.equal(calls.length, 0);
  await client.cloudVms.create({
    workspaceId: "1", name: "web", site_id: "site-1", plan_id: "plan-1", template_id: "image-1",
    os_distro: "ubuntu", os_type: "linux", cpu: 2, ram_mb: 4096, resolveCatalog: false, disk_gb: 50,
    billing_catalog: PLAN_SKU,
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].headers.get("x-idempotency-key"));
  assert.equal(JSON.parse(calls[0].body).site_id, "site-1");
  assert.match(calls[0].url, /\/compute\/cloud-vms/);
});

test("cloud VM lifecycle uses canonical paths, methods, and idempotency", async () => {
  const { calls, fetchImpl } = stub({
    json: {
      operation_id: OP1,
      vm_id: VM1,
      status: "accepted",
      submitted_at: "2026-08-04T10:00:00Z",
    },
  });
  const client = new Ibee({ token: "t", fetch: fetchImpl });

  await client.cloudVms.list({ workspaceId: "710995" });
  await client.cloudVms.create({
    workspaceId: "710995",
    idempotencyKey: "create-key",
    name: "web",
    site_id: "site-1",
    plan_id: "plan-1",
    template_id: "image-1",
    os_distro: "ubuntu",
    os_type: "linux",
    cpu: 2,
    ram_mb: 4096,
    resolveCatalog: false, disk_gb: 50,
    billing_catalog: PLAN_SKU,
  });
  await client.cloudVms.get({ workspaceId: "710995", vmId: VM1 });
  await client.cloudVms.start({ workspaceId: "710995", vmId: VM1, idempotencyKey: "start-key" });
  await client.cloudVms.stop({ workspaceId: "710995", vmId: VM1, force: true, idempotencyKey: "stop-key" });
  await client.cloudVms.reboot({ workspaceId: "710995", vmId: VM1, force: false, idempotencyKey: "reboot-key" });
  await client.cloudVms.getMetrics({ workspaceId: "710995", vmId: VM1 });
  await client.cloudVms.delete({ workspaceId: "710995", vmId: VM1, idempotencyKey: "delete-key" });
  await client.operations.get({ workspaceId: "710995", operationId: OP1 });

  assert.deepEqual(
    calls.map(({ method }) => method),
    ["GET", "POST", "GET", "POST", "POST", "POST", "GET", "GET", "DELETE", "GET"],
  );
  assert.match(calls[0].url, /\/compute\/cloud-vms\?workspace_id=710995&limit=100&offset=0$/);
  assert.match(calls[1].url, /\/compute\/cloud-vms\?workspace_id=710995$/);
  assert.equal(calls[1].headers.get("x-idempotency-key"), "create-key");
  assert.equal(JSON.parse(calls[1].body).site_id, "site-1");
  assert.match(calls[2].url, new RegExp(`/compute/cloud-vms/${VM1}\\?`));
  assert.match(calls[3].url, /\/actions\/start\?/);
  assert.equal(calls[3].body, undefined);
  assert.equal(calls[3].headers.get("x-idempotency-key"), "start-key");
  assert.deepEqual(JSON.parse(calls[4].body), { force: true });
  assert.deepEqual(JSON.parse(calls[5].body), { force: false });
  assert.match(calls[6].url, new RegExp(`/compute/cloud-vms/${VM1}/metrics\\?`));
  // Delete reads the VM first to decide the public IP choice (none here).
  assert.equal(calls[8].headers.get("x-idempotency-key"), "delete-key");
  assert.equal(calls[8].body, undefined);
  assert.match(calls[9].url, new RegExp(`/compute/operations/${OP1}\\?`));
});

test("VM IDs must be 24-character hex before any request", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  for (const vmId of ["vm/1", "all", "", "64b0000000000000000000a1x"]) {
    await assert.rejects(client.gpuVms.get({ workspaceId: "1", vmId }), (err) => err.code === "invalid_vm_id");
    await assert.rejects(client.cloudVms.start({ workspaceId: "1", vmId }), (err) => err.code === "invalid_vm_id");
  }
  assert.equal(calls.length, 0);
});

test("gpuVms.create forwards gpu_count and gpu_model", async () => {
  const { calls, fetchImpl } = stub({ json: { operation_id: OP1 } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.gpuVms.create({
    workspaceId: "1",
    name: "trainer",
    site_id: "site-1",
    plan_id: "gpu-plan-1",
    template_id: "gpu-image-1",
    os_distro: "ubuntu",
    os_type: "linux",
    cpu: 8,
    ram_mb: 32768,
    gpu_count: 1,
    gpu_model: "A100",
    resolveCatalog: false, disk_gb: 50,
    billing_catalog: { sku_id: 5, sku_code: "GPU-A100-1" },
  });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.gpu_count, 1);
  assert.equal(body.gpu_model, "A100");
  assert.match(calls[0].url, /\/compute\/gpu-vms/);
});

test("power actions send force when provided", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.cloudVms.stop({ workspaceId: "1", vmId: VM1, force: true });
  assert.deepEqual(JSON.parse(calls[0].body), { force: true });
  assert.match(calls[0].url, /\/actions\/stop\?/);
});

test("Cloud and GPU VM resources expose the complete lifecycle surface", () => {
  const client = new Ibee({ token: "t" });
  const methods = [
    "list", "listAll", "iterate", "create", "get", "delete", "start", "stop", "reboot", "getMetrics",
    "updateAccess", "precheckResize", "resize", "resizePlan", "resizeRootDisk",
    "attachVolume", "detachVolume", "acknowledgeMountGuidance", "listEvents",
    "getMetricsTimeseries", "getBandwidth", "createSnapshot", "listSnapshots",
    "restoreSnapshot", "getSnapshot", "deleteSnapshot", "getSnapshotRestore", "waitForSnapshotRestore",
    "getBackupPolicy", "getBackupPolicyOrNull", "updateBackupPolicy", "enableBackups", "disableBackups",
    "rescheduleBackup", "createBackupRun", "listBackupRuns", "listAllBackupRuns", "getBackupRun",
    "deleteBackupRun", "restoreBackup", "getBackupRestore", "waitForBackupRestore",
  ];
  for (const resource of [client.cloudVms, client.gpuVms]) {
    for (const method of methods) {
      assert.equal(typeof resource[method], "function", method);
    }
  }
  for (const method of ["createSession", "getSession", "closeSession"]) {
    assert.equal(typeof client.vmConsole[method], "function", `vmConsole.${method}`);
  }
  for (const method of ["get", "wait", "waitFor"]) {
    assert.equal(typeof client.operations[method], "function", `operations.${method}`);
  }
});

test("extended VM writes use canonical bodies and idempotency headers", async () => {
  const { calls, fetchImpl } = stub({ json: { decision: "in_place", cpu: 2, ram_mb: 4096, disk_gb: 50 } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });

  await client.cloudVms.updateAccess({
    workspaceId: "710995",
    vmId: VM1,
    idempotencyKey: "access-key",
    request: { ssh_key_mode: "add", ssh_key_ids: ["key-1"], password_auth_enabled: false },
    checkState: false,
  });
  await client.cloudVms.precheckResize({
    workspaceId: "710995",
    vmId: VM1,
    request: { cpu: 4, ram_mb: 8192 },
  });
  await client.cloudVms.resize({
    workspaceId: "710995",
    vmId: VM1,
    idempotencyKey: "resize-key",
    request: { cpu: 4, ram_mb: 8192, requested_by: "sdk" },
  });
  await client.cloudVms.resizePlan({
    workspaceId: "710995",
    vmId: VM1,
    idempotencyKey: "plan-key",
    request: { cpu: 8, ram_mb: 16384, allow_online: true },
  });
  await client.cloudVms.resizeRootDisk({
    workspaceId: "710995",
    vmId: VM1,
    idempotencyKey: "disk-key",
    request: { new_size_gb: 200, allow_online: false },
  });
  await client.cloudVms.attachVolume({
    workspaceId: "710995",
    vmId: VM1,
    idempotencyKey: "attach-key",
    request: { volume_id: "64b0000000000000000000b1", mode: "single-writer", billing_catalog: { sku_id: 3, sku_code: "block-std" } },
    checkState: false,
  });
  await client.cloudVms.detachVolume({
    workspaceId: "710995",
    vmId: VM1,
    idempotencyKey: "detach-key",
    request: { volume_id: "64b0000000000000000000b1", force: true, confirm_unmounted: true },
  });
  await client.cloudVms.acknowledgeMountGuidance({ workspaceId: "710995", vmId: VM1, volumeId: "64b0000000000000000000b1" });

  const writes = calls.filter((c) => c.method !== "GET");
  assert.deepEqual(
    writes.map(({ method, url }) => `${method} ${new URL(url).pathname.split(`${VM1}/`)[1]}`),
    [
      "PATCH actions/access",
      "POST actions/resize/precheck",
      "POST actions/resize/precheck",
      "POST actions/resize",
      "PATCH actions/resize-plan",
      "PATCH actions/resize-root-disk",
      "POST actions/attach-volume",
      "POST actions/detach-volume",
      "POST mount-guidance/acknowledge",
    ],
  );
  assert.equal(writes[0].headers.get("x-idempotency-key"), "access-key");
  assert.deepEqual(JSON.parse(writes[0].body), {
    ssh_key_mode: "add",
    ssh_key_ids: ["key-1"],
    password_auth_enabled: false,
  });
  assert.equal(writes[1].headers.get("x-idempotency-key"), null);
  assert.deepEqual(JSON.parse(writes[1].body), { cpu: 4, ram_mb: 8192 });
  assert.equal(writes[3].headers.get("x-idempotency-key"), "resize-key");
  assert.deepEqual(JSON.parse(writes[3].body), { cpu: 4, ram_mb: 8192, requested_by: "sdk" });
  assert.deepEqual(JSON.parse(writes[4].body), { cpu: 8, ram_mb: 16384, allow_online: true });
  assert.equal(writes[4].headers.get("x-idempotency-key"), "plan-key");
  assert.deepEqual(JSON.parse(writes[5].body), { new_size_gb: 200, allow_online: false });
  assert.equal(writes[5].headers.get("x-idempotency-key"), "disk-key");
  assert.deepEqual(JSON.parse(writes[6].body), {
    volume_id: "64b0000000000000000000b1",
    mode: "single-writer",
    billing_catalog: { sku_id: 3, sku_code: "BLOCK-STD" },
  });
  assert.equal(writes[6].headers.get("x-idempotency-key"), "attach-key");
  assert.deepEqual(JSON.parse(writes[7].body), { volume_id: "64b0000000000000000000b1", force: true, confirm_unmounted: true });
  assert.equal(writes[7].headers.get("x-idempotency-key"), "detach-key");
  assert.deepEqual(JSON.parse(writes[8].body), { volume_id: "64b0000000000000000000b1" });
  assert.equal(writes[8].headers.get("x-idempotency-key"), null);
});

test("VM observability methods forward limit, range, and month queries", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
  const client = new Ibee({ token: "t", fetch: fetchImpl });

  await client.cloudVms.listEvents({ workspaceId: "710995", vmId: VM1, limit: 250 });
  await client.cloudVms.getMetricsTimeseries({ workspaceId: "710995", vmId: VM1, range: "24h" });
  await client.cloudVms.getBandwidth({ workspaceId: "710995", vmId: VM1, month: "2026-08" });

  assert.match(calls[0].url, /\/events\?workspace_id=710995&limit=250$/);
  assert.match(calls[1].url, /\/metrics\/timeseries\?workspace_id=710995&range=24h$/);
  assert.match(calls[2].url, /\/metrics\/bandwidth\?workspace_id=710995&month=2026-08$/);
  assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET", "GET"]);
});

test("snapshot and backup lifecycle forwards exact paths, queries, and bodies", async () => {
  const { calls, fetchImpl } = stub({
    json: {
      status: "succeeded",
      snapshot_set_id: "snap-1",
      run_id: "backup-1",
      recovery_point_id: "backup-1",
      enabled: true,
      policy_id: "pol-1",
      schedule: { frequency: "daily", hour: 20, minute: 0, timezone: "UTC", window_minutes: 30 },
      volume_manifest: [],
    },
  });
  const client = new Ibee({ token: "t", fetch: fetchImpl });

  await client.cloudVms.createSnapshot({
    workspaceId: "710995",
    vmId: VM1,
    request: { name: " before-upgrade ", mode: "selective", selected_data_volume_ids: ["vol-1"], billing_catalog: SNAP_SKU },
  });
  await client.cloudVms.listSnapshots({ workspaceId: "710995", vmId: VM1, limit: 25, offset: 50, search: "upgrade" });
  await client.cloudVms.restoreSnapshot({ workspaceId: "710995", vmId: VM1, snapshotSetId: "snap/1" });
  await client.cloudVms.getSnapshot({ workspaceId: "710995", snapshotSetId: "snap/1" });
  await client.cloudVms.deleteSnapshot({ workspaceId: "710995", snapshotSetId: "snap/1" });
  await client.cloudVms.getSnapshotRestore({ workspaceId: "710995", restoreId: "restore/1" });
  await client.cloudVms.getBackupPolicy({ workspaceId: "710995", vmId: VM1 });
  await client.cloudVms.updateBackupPolicy({
    workspaceId: "710995",
    vmId: VM1,
    request: { retention_days: 30, incremental_enabled: true },
  });
  await client.cloudVms.enableBackups({
    workspaceId: "710995",
    vmId: VM1,
    request: { schedule: { frequency: "daily", hour: 20 }, retention_days: 14, billing_catalog: BACKUP_SKU },
  });
  await client.cloudVms.disableBackups({ workspaceId: "710995", vmId: VM1, request: { requested_by: "sdk" } });
  await client.cloudVms.rescheduleBackup({
    workspaceId: "710995",
    vmId: VM1,
    request: { next_run_at: "2026-08-10T20:00:00Z" },
  });
  await client.cloudVms.createBackupRun({
    workspaceId: "710995",
    vmId: VM1,
    request: { reason: " release ", billing_catalog: BACKUP_SKU },
  });
  await client.cloudVms.listBackupRuns({ workspaceId: "710995", vmId: VM1, limit: 10, offset: 20, search: "release" });
  await client.cloudVms.getBackupRun({ workspaceId: "710995", runId: "run/1" });
  await client.cloudVms.restoreBackup({
    workspaceId: "710995",
    vmId: VM1,
    request: { recovery_point_id: "backup-1", target_mode: "replace", auto_start: true },
  });
  await client.cloudVms.getBackupRestore({ workspaceId: "710995", restoreId: "restore/2" });

  const byPath = (re) => calls.filter((c) => re.test(c.url));
  const snapCreate = byPath(new RegExp(`/cloud-vms/${VM1}/snapshots\\?`))[0];
  assert.equal(snapCreate.method, "POST");
  assert.deepEqual(JSON.parse(snapCreate.body), {
    name: "before-upgrade",
    mode: "selective",
    selected_data_volume_ids: ["vol-1"],
    billing_catalog: SNAP_SKU,
  });
  assert.match(calls[1].url, /limit=25&offset=50&search=upgrade$/);
  const restore = calls.find((c) => /\/actions\/restore\?workspace_id=710995&vm_id=/.test(c.url));
  assert.match(restore.url, new RegExp(`/cloud-vm-snapshots/snap%2F1/actions/restore\\?workspace_id=710995&vm_id=${VM1}$`));
  assert.deepEqual(JSON.parse(restore.body), { target_mode: "replace", auto_start: true });
  assert.ok(byPath(/\/cloud-vm-snapshots\/restores\/restore%2F1\?workspace_id=710995$/).length === 1);
  const patch = calls.find((c) => c.method === "PATCH" && /\/backups\/policy\?/.test(c.url));
  assert.deepEqual(JSON.parse(patch.body), { retention_days: 30, incremental_enabled: true });
  const enable = calls.find((c) => /\/backups\/enable\?/.test(c.url));
  assert.deepEqual(JSON.parse(enable.body), {
    billing_catalog: BACKUP_SKU,
    schedule: { frequency: "daily", hour: 20, minute: 0, timezone: "UTC", window_minutes: 30 },
    retention_days: 14,
    full_backup_interval_days: 7,
    incremental_enabled: true,
  });
  const disable = calls.find((c) => /\/backups\/disable\?/.test(c.url));
  assert.deepEqual(JSON.parse(disable.body), { requested_by: "sdk" });
  const next = calls.find((c) => /\/next-run-at\?/.test(c.url));
  assert.deepEqual(JSON.parse(next.body), { next_run_at: "2026-08-10T20:00:00Z" });
  const run = calls.find((c) => c.method === "POST" && /\/backups\/runs\?/.test(c.url));
  assert.deepEqual(JSON.parse(run.body), { billing_catalog: BACKUP_SKU, reason: "release" });
  assert.ok(byPath(/\/backups\/runs\?workspace_id=710995&limit=10&offset=20&search=release$/).length === 1);
  assert.ok(byPath(/\/cloud-vm-backups\/runs\/run%2F1\?workspace_id=710995$/).length === 1);
  const backupRestore = calls.find((c) => /\/backups\/actions\/restore\?/.test(c.url));
  // auto_start is not a backup restore field and is not sent.
  assert.deepEqual(JSON.parse(backupRestore.body), { recovery_point_id: "backup-1", target_mode: "replace" });
  assert.ok(byPath(/\/cloud-vm-backups\/restores\/restore%2F2\?workspace_id=710995$/).length === 1);
  for (const call of calls) assert.equal(call.headers.get("x-idempotency-key"), null);
});

test("GPU recovery uses GPU-specific collection paths", async () => {
  const { calls, fetchImpl } = stub({ json: { status: "succeeded", recovery_point_id: "backup/1", volume_manifest: [] } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.gpuVms.listEvents({ workspaceId: "710995", vmId: GPU1 });
  await client.gpuVms.createSnapshot({
    workspaceId: "710995",
    vmId: GPU1,
    request: { name: "checkpoint", billing_catalog: SNAP_SKU },
  });
  await client.gpuVms.restoreSnapshot({ workspaceId: "710995", vmId: GPU1, snapshotSetId: "snap/1" });
  await client.gpuVms.getSnapshot({ workspaceId: "710995", snapshotSetId: "snap/2" });
  await client.gpuVms.getSnapshotRestore({ workspaceId: "710995", restoreId: "restore/1" });
  await client.gpuVms.restoreBackup({ workspaceId: "710995", vmId: GPU1, request: { recovery_point_id: "backup/1" } });
  await client.gpuVms.getBackupRun({ workspaceId: "710995", runId: "run/1" });
  await client.gpuVms.getBackupRestore({ workspaceId: "710995", restoreId: "restore/2" });
  const urls = calls.map((c) => `${c.method} ${c.url}`);
  const has = (re) => assert.ok(urls.some((u) => re.test(u)), String(re));
  has(new RegExp(`GET .*/compute/gpu-vms/${GPU1}/events\\?`));
  has(new RegExp(`POST .*/compute/gpu-vms/${GPU1}/snapshots\\?`));
  has(new RegExp(`POST .*/compute/gpu-vm-snapshots/snap%2F1/actions/restore\\?workspace_id=710995&vm_id=${GPU1}$`));
  has(/GET .*\/compute\/gpu-vm-snapshots\/snap%2F2\?/);
  has(/GET .*\/compute\/gpu-vm-snapshots\/restores\/restore%2F1\?/);
  has(new RegExp(`POST .*/compute/gpu-vms/${GPU1}/backups/actions/restore\\?`));
  has(/GET .*\/compute\/gpu-vm-backups\/runs\/backup%2F1\?/);
  has(/GET .*\/compute\/gpu-vm-backups\/runs\/run%2F1\?/);
  has(/GET .*\/compute\/gpu-vm-backups\/restores\/restore%2F2\?/);
  const restore = calls.find((c) => /gpu-vm-snapshots\/snap%2F1\/actions\/restore/.test(c.url));
  assert.deepEqual(JSON.parse(restore.body), { target_mode: "replace", auto_start: true });
});

test("VM console sessions use encoded IDs and the close reason query", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await assert.rejects(
    client.vmConsole.createSession({ workspaceId: "710995", vmId: VM1, vmType: "gpu" }),
    (err) => err.code === "console_not_supported",
  );
  await client.vmConsole.createSession({
    workspaceId: "710995",
    vmId: VM1,
    requestedBy: "sdk",
    userId: "user-1",
  });
  await client.vmConsole.getSession({ workspaceId: "710995", sessionId: "session/1" });
  await client.vmConsole.closeSession({
    workspaceId: "710995",
    sessionId: "session/1",
    reason: "finished",
  });
  assert.deepEqual(JSON.parse(calls[0].body), {
    vm_id: VM1,
    vm_type: "cloud",
    console_type: "graphical",
    requested_by: "sdk",
    user_id: "user-1",
  });
  assert.match(calls[1].url, /\/compute\/console\/sessions\/session%2F1\?workspace_id=710995$/);
  assert.match(calls[2].url, /\/compute\/console\/sessions\/session%2F1\?workspace_id=710995&reason=finished$/);
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET", "DELETE"]);
});

test("exposes every public networking resource family", () => {
  const client = new Ibee({ token: "t" });
  for (const method of [
    "listSites", "list", "create", "get", "update", "delete",
    "listSubnets", "createSubnet", "getSubnet", "updateSubnet", "deleteSubnet",
    "listNodes", "attachNode", "detachNode",
    "listNatGateways", "createNatGateway", "deleteNatGateway",
    "listPortForwardingRules", "createPortForwardingRule",
    "updatePortForwardingRule", "deletePortForwardingRule",
  ]) {
    assert.equal(typeof client.vpcs[method], "function", `vpcs.${method}`);
  }
  for (const method of ["list", "reserve", "get", "update", "release", "attach", "move", "detach"]) {
    assert.equal(typeof client.reservedIps[method], "function", `reservedIps.${method}`);
  }
  for (const method of [
    "listGroups", "createGroup", "getGroup", "deleteGroup",
    "createRule", "updateRule", "deleteRule",
    "listAttachments", "attach", "detach",
  ]) {
    assert.equal(typeof client.firewalls[method], "function", `firewalls.${method}`);
  }
  for (const method of [
    "list", "createL4", "createL7", "get", "delete", "updateL4", "updateL7", "getStatus",
  ]) {
    assert.equal(typeof client.loadBalancers[method], "function", `loadBalancers.${method}`);
  }
});

test("VPC creation uses the public path and API field names", async () => {
  const { calls, fetchImpl } = stub({ json: { vpc_id: "vpc1" } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.vpcs.create({
    workspaceId: "607005",
    name: "production",
    siteId: "site1",
    autoCidr: true,
    createDefaultSubnet: true,
  });
  assert.match(calls[0].url, /\/networking\/vpcs\?workspace_id=607005/);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), {
    name: "production",
    site_id: "site1",
    auto_cidr: true,
    create_default_subnet: true,
  });
});

test("port forwarding, Reserved IP, firewall, and load balancer bodies are mapped", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
  const client = new Ibee({ token: "t", fetch: fetchImpl });

  await client.vpcs.createPortForwardingRule({
    workspaceId: "1",
    vpcId: "vpc1",
    natGatewayId: "nat1",
    name: "https",
    externalPort: 443,
    internalIp: "10.0.0.10",
    internalPort: 8443,
    checkState: false,
  });
  assert.match(calls[0].url, /\/nat-gateways\/nat1\/port-forwarding-rules\?/);
  assert.equal(JSON.parse(calls[0].body).internal_ip, "10.0.0.10");

  await client.reservedIps.attach({
    workspaceId: "1",
    reservedIpId: "ip1",
    vmId: "vm1",
    vpcId: "vpc1",
    checkState: false,
  });
  assert.deepEqual(JSON.parse(calls[1].body), {
    vm_id: "vm1",
    vpc_id: "vpc1",
  });

  await client.reservedIps.move({
    workspaceId: "1",
    reservedIpId: "ip1",
    vmId: "vm2",
    vpcId: "vpc1",
    checkState: false,
  });
  assert.match(calls[2].url, /\/networking\/reserved-ips\/ip1\/move\?/);
  assert.equal(JSON.parse(calls[2].body).vm_id, "vm2");

  await client.firewalls.createRule({
    workspaceId: "1",
    firewallGroupId: "fw1",
    direction: "ingress",
    protocol: "tcp",
    portStart: 443,
    portEnd: 443,
    remoteTargets: ["0.0.0.0/0"],
  });
  assert.equal(JSON.parse(calls[3].body).remote_targets[0], "0.0.0.0/0");

  await client.loadBalancers.createL7({
    workspaceId: "1",
    name: "web",
    protocol: "https",
    backends: [{ target: "vm1", port: 8443 }],
    customDomain: { hostname: "app.example.com" },
  });
  assert.deepEqual(JSON.parse(calls[4].body).custom_domain, {
    hostname: "app.example.com",
  });
  assert.match(calls[4].url, /\/networking\/load-balancers\/l7\?/);
});

test("object storage bucket and S3 credential lifecycle uses canonical paths", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
  const client = new Ibee({ token: "t", fetch: fetchImpl });

  await client.objectStorage.getBucket({ workspaceId: "1", bucketName: "assets" });
  await client.objectStorage.updateBucket({
    workspaceId: "1",
    bucketName: "assets",
    isPublic: true,
  });
  await client.objectStorage.listS3Credentials({ workspaceId: "1" });
  await client.objectStorage.createS3Credential({
    workspaceId: "1",
    name: "ci",
    permissionType: "object_rw",
    bucketScope: "specific",
    allowedBuckets: ["assets"],
  });
  await client.objectStorage.getS3Credential({ workspaceId: "1", accessKeyId: "AK123" });
  await client.objectStorage.revokeS3Credential({ workspaceId: "1", accessKeyId: "AK123" });

  assert.match(calls[0].url, /\/object-storage\/buckets\/assets\?/);
  assert.equal(calls[1].method, "PATCH");
  assert.deepEqual(JSON.parse(calls[1].body), { is_public: true });
  assert.match(calls[2].url, /\/object-storage\/credentials\?/);
  assert.deepEqual(JSON.parse(calls[3].body).allowed_buckets, ["assets"]);
  assert.match(calls[4].url, /\/object-storage\/credentials\/AK123\?/);
  assert.equal(calls[5].method, "DELETE");
});

test("Block Storage exposes all 8 operations with canonical paths and bodies", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  const workspaceId = "710995";
  const volumeId = "64b0000000000000000000b1";

  await client.blockStorage.listVolumes({ workspaceId });
  await client.blockStorage.createVolume({
    workspaceId, name: "database", size_gb: 100, site_id: "site-1", site_name: "Chennai",
    volume_class: "balanced", replica_count: 2, backup_enabled: true,
  });
  await client.blockStorage.getVolume({ workspaceId, volumeId });
  await client.blockStorage.listVolumeOperations({ workspaceId, volumeId });
  await client.blockStorage.attachVolume({
    workspaceId, volumeId,
    request: { node_name: "worker-1", mode: "single-writer", vm_id: "vm-1" },
  });
  await client.blockStorage.detachVolume({
    workspaceId, volumeId,
    request: { node_name: "worker-1", confirm_unmounted: true },
  });
  await client.blockStorage.resizeVolume({
    workspaceId, volumeId, request: { new_size_gb: 200, allow_online: false }, checkState: false,
  });
  await client.blockStorage.deleteVolume({ workspaceId, volumeId, force: true });

  const p = `/v1/block-storage/volumes/${volumeId}`;
  assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname]), [
    ["GET", "/v1/block-storage/volumes"],
    ["POST", "/v1/block-storage/volumes"],
    ["GET", p],
    ["GET", `${p}/operations`],
    ["POST", `${p}/attachments`],
    ["POST", `${p}/detach`],
    ["POST", `${p}/resize`],
    ["DELETE", p],
  ]);
  assert.equal(calls.every((call) => new URL(call.url).searchParams.get("workspace_id") === workspaceId), true);
  const { idempotency_key: createKey, ...createBody } = JSON.parse(calls[1].body);
  assert.deepEqual(createBody, {
    name: "database", size_gb: 100, site_id: "site-1", site_name: "Chennai",
    volume_class: "balanced", replica_count: 2, backup_enabled: true,
  });
  assert.match(createKey, /^block-volume-create-database-[A-Za-z0-9_-]+$/);
  assert.equal(calls[1].headers.get("x-idempotency-key"), createKey);
  const { idempotency_key: attachKey, ...attachBody } = JSON.parse(calls[4].body);
  assert.deepEqual(attachBody, {
    node_name: "worker-1", mode: "single-writer", vm_id: "vm-1",
  });
  assert.match(attachKey, new RegExp(`^block-volume-attach-${volumeId}-`));
  assert.equal(new URL(calls[7].url).searchParams.get("force"), "true");
  assert.match(new URL(calls[7].url).searchParams.get("idempotency_key"), new RegExp(`^block-volume-delete-${volumeId}-`));
});

test("CDN exposes all 15 operations with encoded IDs and canonical bodies", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  const workspaceId = "710995";
  const distributionId = "dist/1";
  const domain = "cdn.example.com";

  await client.cdn.generateUrl({ workspaceId, bucket_name: "assets", object_key: "images/logo.svg", disposition: "inline" });
  await client.cdn.listDistributions({ workspaceId });
  await client.cdn.createDistribution({ workspaceId, name: "assets", origin_id: "assets", origin_type: "bucket" });
  await client.cdn.getDistribution({ workspaceId, distributionId });
  await client.cdn.updateDistribution({ workspaceId, distributionId, enabled: false });
  await client.cdn.deleteDistribution({ workspaceId, distributionId });
  await client.cdn.getWebsiteConfig({ workspaceId, distributionId });
  await client.cdn.updateWebsiteConfig({ workspaceId, distributionId, request: { index_document: "home.html" } });
  await client.cdn.deleteWebsiteConfig({ workspaceId, distributionId });
  await client.cdn.listCustomDomains({ workspaceId, distributionId });
  await client.cdn.createCustomDomain({ workspaceId, distributionId, domain });
  await client.cdn.getCustomDomain({ workspaceId, distributionId, domain });
  await client.cdn.deleteCustomDomain({ workspaceId, distributionId, domain });
  await client.cdn.verifyCustomDomain({ workspaceId, distributionId, domain });
  await client.cdn.purgeCache({ workspaceId, distributionId, request: { mode: "prefix", prefixes: ["/images/"] } });

  assert.equal(calls.length, 15);
  assert.deepEqual(calls.map((call) => call.method), [
    "POST", "GET", "POST", "GET", "PATCH", "DELETE", "GET", "PUT",
    "DELETE", "GET", "POST", "GET", "DELETE", "POST", "POST",
  ]);
  assert.equal(calls.every((call) => new URL(call.url).searchParams.get("workspace_id") === workspaceId), true);
  assert.match(new URL(calls[3].url).pathname, /\/cdn\/distributions\/dist%2F1$/);
  assert.match(new URL(calls[11].url).pathname, /\/custom-domains\/cdn\.example\.com$/);
  assert.deepEqual(JSON.parse(calls[0].body), {
    bucket_name: "assets", object_key: "images/logo.svg", disposition: "inline",
  });
  assert.deepEqual(JSON.parse(calls[2].body), {
    name: "assets", origin_id: "assets", origin_type: "bucket", cache_policy: "static-assets",
  });
  assert.deepEqual(JSON.parse(calls[14].body), { mode: "prefix", prefixes: ["/images/"] });
});

test("compute catalog sends required VM type and placement filters", async () => {
  const { calls, fetchImpl } = stub({ json: { plans: [], count: 0 } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });

  await client.computeCatalog.listSites({ workspaceId: "1" });
  await client.computeCatalog.listPlans({
    workspaceId: "1",
    vmType: "gpu",
    siteId: "site1",
    currency: "INR",
    billingInterval: "MONTHLY",
  });
  await client.computeCatalog.listImages({
    workspaceId: "1",
    vmType: "gpu",
    siteId: "site1",
  });

  assert.match(calls[0].url, /\/compute\/sites\?workspace_id=1$/);
  assert.match(calls[1].url, /vm_type=gpu/);
  assert.match(calls[1].url, /billing_interval=MONTHLY/);
  assert.match(calls[2].url, /\/compute\/images\?/);
  assert.match(calls[2].url, /site_id=site1/);
});

test("billing eligibility is an explicit typed preflight for billable creates", async () => {
  const decision = {
    organization_id: "org1",
    allowed: true,
    reason: "ok",
    billing_mode: "PREPAID",
    billing_state: "CURRENT",
    currency: "INR",
    sku_code: "STANDARD-2-8-50",
    estimated_cost_minor: 120000,
    effective_balance_minor: 200000,
    evaluated_at: "2026-08-04T10:00:00Z",
  };
  const { calls, fetchImpl } = stub({ json: decision });
  const client = new Ibee({ token: "t", fetch: fetchImpl });

  const result = await client.billing.checkResourceEligibility({
    workspaceId: "710995",
    skuCode: "STANDARD-2-8-50",
    estimatedCostMinor: 120000,
  });

  assert.deepEqual(result, decision);
  assert.equal(calls.length, 1, "the preflight is one explicit request");
  assert.equal(calls[0].method, "POST");
  assert.match(
    calls[0].url,
    /\/billing\/resource-eligibility\?workspace_id=710995$/,
  );
  assert.deepEqual(JSON.parse(calls[0].body), {
    sku_code: "STANDARD-2-8-50",
    estimated_cost_minor: 120000,
  });
  assert.equal(calls[0].headers.get("x-idempotency-key"), null);
});

const billableCreates = [
  {
    name: "secret store",
    productPath: "/secret-store/stores?",
    run: (client) => client.secretStore.createSecretStore({ workspaceId: "12", name: "app" }),
  },
  {
    name: "secret",
    productPath: "/secret-store/stores/st1/secrets?",
    run: (client) => client.secretStore.createSecret({
      workspaceId: "12", storeId: "st1", name: "token", value: { token: "x" },
    }),
  },
  {
    name: "bucket",
    productPath: "/object-storage/buckets?",
    run: (client) => client.objectStorage.createBucket({
      workspaceId: "1", name: "assets", region: "in-south-1",
    }),
  },
  {
    name: "S3 credential",
    productPath: "/object-storage/credentials?",
    run: (client) => client.objectStorage.createS3Credential({ workspaceId: "1", name: "ci" }),
  },
  {
    name: "NAT gateway",
    productPath: "/networking/vpcs/vpc1/nat-gateways?",
    run: (client) => client.vpcs.createNatGateway({
      workspaceId: "1", vpcId: "vpc1", validateVpc: false, billingCatalog: { sku_code: "NAT-GATEWAY" },
    }),
  },
  {
    name: "Reserved IP",
    productPath: "/networking/reserved-ips?",
    run: (client) => client.reservedIps.reserve({ workspaceId: "1", siteId: "site1" }),
  },
  {
    name: "L4 load balancer",
    productPath: "/networking/load-balancers/l4?",
    run: (client) => client.loadBalancers.createL4({
      workspaceId: "1", name: "edge", protocol: "tcp", backends: [{ target: "edge-svc", port: 443 }],
    }),
  },
  {
    name: "L7 load balancer",
    productPath: "/networking/load-balancers/l7?",
    run: (client) => client.loadBalancers.createL7({
      workspaceId: "1", name: "web", protocol: "http", backends: [{ target: "web-svc", port: 80 }],
    }),
  },
  {
    name: "Cloud VM",
    productPath: "/compute/cloud-vms?",
    run: (client) => client.cloudVms.create({
      workspaceId: "1", idempotencyKey: "cloud-key", name: "web", site_id: "s1", plan_id: "plan-1",
      template_id: "image-1", os_distro: "ubuntu", os_type: "linux", cpu: 2, ram_mb: 4096,
      resolveCatalog: false, disk_gb: 50, billing_catalog: { sku_id: 1, sku_code: "STANDARD-2-8-50" },
    }),
  },
  {
    name: "GPU VM",
    productPath: "/compute/gpu-vms?",
    run: (client) => client.gpuVms.create({
      workspaceId: "1", idempotencyKey: "gpu-key", name: "trainer", site_id: "s1", plan_id: "gpu-plan-1",
      template_id: "image-1", os_distro: "ubuntu", os_type: "linux", cpu: 8, ram_mb: 32768,
      gpu_count: 1, gpu_model: "A100", resolveCatalog: false, disk_gb: 50, billing_catalog: { sku_id: 2, sku_code: "GPU-A100-1" },
    }),
  },
];

for (const scenario of billableCreates) {
  test(`${scenario.name} create sends exactly one product request`, async () => {
    const { calls, fetchImpl } = stub({ json: {} });
    const client = new Ibee({ token: "t", fetch: fetchImpl });

    await scenario.run(client);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.ok(calls[0].url.includes(scenario.productPath));
    assert.equal(calls[0].url.includes("/billing/resource-eligibility?"), false);
  });
}

test("billing eligibility denial is preserved as an ApiError", async () => {
  const denial = {
    error: {
      code: "BILLING_CREATE_BLOCKED",
      message: "Insufficient balance",
      details: { reason: "insufficient_balance" },
    },
  };
  const { fetchImpl } = stub({ status: 402, json: denial });
  const client = new Ibee({ token: "t", fetch: fetchImpl });

  await assert.rejects(
    () => client.billing.checkResourceEligibility({ workspaceId: "1" }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 402);
      assert.deepEqual(err.body, denial);
      return true;
    },
  );
});

test("throws ApiError on non-2xx with parsed body", async () => {
  const { fetchImpl } = stub({ status: 401, json: { error: "invalid_api_key" } });
  const client = new Ibee({ token: "bad", fetch: fetchImpl });
  await assert.rejects(
    () => client.secretStore.listSecretStores({ workspaceId: "12" }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 401);
      assert.deepEqual(err.body, { error: "invalid_api_key" });
      return true;
    },
  );
});

test("requires a token", () => {
  assert.throws(() => new Ibee({ token: "" }), /token is required/i);
});
