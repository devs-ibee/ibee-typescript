import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, Ibee, IbeeEnvironment } from "../dist/index.js";

/** Build a client with a stub fetch that records the request and returns `resp`. */
function stub(resp = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body,
    });
    return new Response(JSON.stringify(resp.json ?? {}), {
      status: resp.status ?? 200,
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

test("DEVELOPMENT environment targets .co.in", async () => {
  const { calls, fetchImpl } = stub();
  const client = new Ibee({ token: "t", environment: IbeeEnvironment.DEVELOPMENT, fetch: fetchImpl });
  await client.secretStore.listSecretStores({ workspaceId: "1" });
  assert.match(calls[0].url, /^https:\/\/api\.ibee\.co\.in\/v1\/secret-store\/stores/);
});

test("sends bearer auth header", async () => {
  const { calls, fetchImpl } = stub();
  const client = new Ibee({ token: "ibee_dev_key_abc", fetch: fetchImpl });
  await client.secretStore.listSecretStores({ workspaceId: "1" });
  assert.equal(calls[0].headers.get("authorization"), "Bearer ibee_dev_key_abc");
});

test("token does not leak via JSON.stringify of the client", () => {
  const client = new Ibee({ token: "ibee_dev_key_secret" });
  assert.ok(!JSON.stringify(client).includes("ibee_dev_key_secret"));
});

test("createBucket sends required site and optional region in the body", async () => {
  const { calls, fetchImpl } = stub({ json: { name: "b" } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.objectStorage.createBucket({
    workspaceId: "1",
    name: "b",
    siteId: "site1",
    region: "in-south-1",
  });
  const body = JSON.parse(calls[0].body);
  assert.equal(body.site_id, "site1");
  assert.equal(body.region, "in-south-1");
  assert.equal(calls[0].method, "POST");
});

test("createSecret sends secret_name and value (spec field names)", async () => {
  const { calls, fetchImpl } = stub({ json: { id: "s1" } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.secretStore.createSecret({
    workspaceId: "1",
    storeId: "st1",
    name: "db-url",
    value: { url: "postgres://x" },
  });
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
    workspaceId: "1",
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
  await client.secretStore.rollbackSecret({ workspaceId, secretId, version: 1 });
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

  assert.deepEqual(
    calls.map((call) => [call.method, new URL(call.url).pathname]),
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

  const storeListQuery = new URL(calls[0].url).searchParams;
  assert.equal(storeListQuery.get("page"), "2");
  assert.equal(storeListQuery.get("limit"), "25");
  assert.equal(storeListQuery.get("include_archived"), "true");
  const secretListQuery = new URL(calls[7].url).searchParams;
  assert.equal(secretListQuery.get("q"), "database");
  assert.equal(secretListQuery.get("page"), "3");
  assert.equal(secretListQuery.get("limit"), "10");

  assert.deepEqual(JSON.parse(calls[1].body), { name: "production" });
  assert.deepEqual(JSON.parse(calls[3].body), { description: "updated" });
  assert.deepEqual(JSON.parse(calls[8].body), {
    secret_name: "database-url",
    value: { url: "redacted" },
  });
  assert.deepEqual(JSON.parse(calls[9].body), {
    secrets: [{ secret_name: "api-key", value: { key: "redacted" } }],
  });
  assert.deepEqual(JSON.parse(calls[13].body), {
    value: { key: "replacement" },
    cas: 1,
  });
  assert.deepEqual(JSON.parse(calls[14].body), { value: { username: "ibee" } });
  assert.deepEqual(JSON.parse(calls[15].body), { versions: [1] });
  assert.deepEqual(JSON.parse(calls[16].body), { versions: [1] });
  assert.deepEqual(JSON.parse(calls[20].body), { version: 1 });
  assert.deepEqual(JSON.parse(calls[22].body), {
    auth_method: "approle",
    name: "payments-api",
    token_policy_mode: "read_write",
  });
  assert.deepEqual(JSON.parse(calls[24].body), { token_policy_mode: "read_only" });
  assert.deepEqual(JSON.parse(calls[31].body), {
    store_id: storeId,
    access_mode: "read_write",
    allow_rollback: true,
  });
  assert.deepEqual(JSON.parse(calls[32].body), { access_mode: "read_only" });
});

test("cloudVms.create attaches an idempotency key", async () => {
  const { calls, fetchImpl } = stub({ json: { operation_id: "op1" } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.cloudVms.create({
    workspaceId: "1",
    name: "web",
    site_id: "site-1",
    plan_id: "plan-1",
    template_id: "image-1",
    os_distro: "ubuntu",
    os_type: "linux",
    cpu: 2,
    ram_mb: 4096,
  });
  assert.ok(calls[0].headers.get("x-idempotency-key"));
  assert.match(calls[0].url, /\/compute\/cloud-vms/);
});

test("gpuVms.create forwards gpu_count and gpu_model", async () => {
  const { calls, fetchImpl } = stub({ json: { operation_id: "op1" } });
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
  });
  const body = JSON.parse(calls[0].body);
  assert.equal(body.gpu_count, 1);
  assert.equal(body.gpu_model, "A100");
  assert.match(calls[0].url, /\/compute\/gpu-vms/);
});

test("power actions send force when provided", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.cloudVms.stop({ workspaceId: "1", vmId: "vm1", force: true });
  assert.deepEqual(JSON.parse(calls[0].body), { force: true });
  assert.match(calls[0].url, /\/actions\/stop\?/);
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
  });
  assert.match(calls[0].url, /\/nat-gateways\/nat1\/port-forwarding-rules\?/);
  assert.equal(JSON.parse(calls[0].body).internal_ip, "10.0.0.10");

  await client.reservedIps.attach({
    workspaceId: "1",
    reservedIpId: "ip1",
    vmId: "vm1",
    vpcId: "vpc1",
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

test("throws ApiError on non-2xx with parsed body", async () => {
  const { fetchImpl } = stub({ status: 401, json: { error: "invalid_api_key" } });
  const client = new Ibee({ token: "bad", fetch: fetchImpl });
  await assert.rejects(
    () => client.secretStore.listSecretStores({ workspaceId: "1" }),
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
