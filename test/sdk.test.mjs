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

test("createBucket sends region in the body", async () => {
  const { calls, fetchImpl } = stub({ json: { name: "b" } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.objectStorage.createBucket({ workspaceId: "1", name: "b", region: "in-south-1" });
  const body = JSON.parse(calls[0].body);
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

test("attachNetworkInterface sends network_id and an idempotency key", async () => {
  const { calls, fetchImpl } = stub({ json: { id: "ni1" } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.cloudVms.attachNetworkInterface({ workspaceId: "1", vmId: "vm1", networkId: "net1" });
  const body = JSON.parse(calls[0].body);
  assert.equal(body.network_id, "net1");
  assert.ok(calls[0].headers.get("x-idempotency-key"));
});

test("power actions send force when provided", async () => {
  const { calls, fetchImpl } = stub({ json: {} });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.cloudVms.stop({ workspaceId: "1", vmId: "vm1", force: true });
  assert.deepEqual(JSON.parse(calls[0].body), { force: true });
  assert.match(calls[0].url, /\/actions\/stop\?/);
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
