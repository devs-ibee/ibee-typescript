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

test("cloud VM lifecycle uses canonical paths, methods, and idempotency", async () => {
  const { calls, fetchImpl } = stub({
    json: {
      operation_id: "op1",
      vm_id: "vm1",
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
  });
  await client.cloudVms.get({ workspaceId: "710995", vmId: "vm/1" });
  await client.cloudVms.start({
    workspaceId: "710995",
    vmId: "vm1",
    idempotencyKey: "start-key",
  });
  await client.cloudVms.stop({
    workspaceId: "710995",
    vmId: "vm1",
    force: true,
    idempotencyKey: "stop-key",
  });
  await client.cloudVms.reboot({
    workspaceId: "710995",
    vmId: "vm1",
    force: false,
    idempotencyKey: "reboot-key",
  });
  await client.cloudVms.getMetrics({ workspaceId: "710995", vmId: "vm1" });
  await client.cloudVms.delete({
    workspaceId: "710995",
    vmId: "vm1",
    idempotencyKey: "delete-key",
  });
  await client.operations.get({ workspaceId: "710995", operationId: "op/1" });

  assert.deepEqual(
    calls.map(({ method }) => method),
    ["GET", "POST", "GET", "POST", "POST", "POST", "GET", "DELETE", "GET"],
  );
  assert.match(calls[0].url, /\/compute\/cloud-vms\?workspace_id=710995$/);
  assert.match(calls[1].url, /\/compute\/cloud-vms\?workspace_id=710995$/);
  assert.equal(calls[1].headers.get("x-idempotency-key"), "create-key");
  assert.equal(JSON.parse(calls[1].body).site_id, "site-1");
  assert.match(calls[2].url, /\/compute\/cloud-vms\/vm%2F1\?/);
  assert.match(calls[3].url, /\/actions\/start\?/);
  assert.equal(calls[3].body, undefined);
  assert.equal(calls[3].headers.get("x-idempotency-key"), "start-key");
  assert.deepEqual(JSON.parse(calls[4].body), { force: true });
  assert.deepEqual(JSON.parse(calls[5].body), { force: false });
  assert.match(calls[6].url, /\/compute\/cloud-vms\/vm1\/metrics\?/);
  assert.equal(calls[7].headers.get("x-idempotency-key"), "delete-key");
  assert.match(calls[8].url, /\/compute\/operations\/op%2F1\?/);
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

test("VM create never performs a hidden billing preflight", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
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

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/compute\/cloud-vms\?/);
});

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
