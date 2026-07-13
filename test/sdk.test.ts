import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, Ibee, IbeeEnvironment } from "../dist/index.js";

/** Build a client with a stub fetch that records the request and returns `resp`. */
function stub(resp: { status?: number; json?: unknown } = {}) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body as string | undefined,
    });
    return new Response(JSON.stringify(resp.json ?? {}), {
      status: resp.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
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
  const client = new Ibee({
    token: "t",
    environment: IbeeEnvironment.DEVELOPMENT,
    fetch: fetchImpl,
  });
  await client.secretStore.listSecretStores({ workspaceId: "1" });
  assert.match(calls[0].url, /^https:\/\/api\.ibee\.co\.in\/v1\/secret-store\/stores/);
});

test("sends bearer auth header", async () => {
  const { calls, fetchImpl } = stub();
  const client = new Ibee({ token: "ibee_dev_key_abc", fetch: fetchImpl });
  await client.secretStore.listSecretStores({ workspaceId: "1" });
  assert.equal(calls[0].headers.get("authorization"), "Bearer ibee_dev_key_abc");
});

test("createBucket sends region in the body", async () => {
  const { calls, fetchImpl } = stub({ json: { name: "b" } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.objectStorage.createBucket({
    workspaceId: "1",
    name: "b",
    region: "in-south-1",
  });
  const body = JSON.parse(calls[0].body!);
  assert.equal(body.region, "in-south-1");
  assert.equal(calls[0].method, "POST");
});

test("VM create attaches an idempotency key", async () => {
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

test("gpuVms uses the gpu-vms path segment", async () => {
  const { calls, fetchImpl } = stub({ json: { items: [] } });
  const client = new Ibee({ token: "t", fetch: fetchImpl });
  await client.gpuVms.list({ workspaceId: "1" });
  assert.match(calls[0].url, /\/compute\/gpu-vms/);
});

test("throws ApiError on non-2xx with parsed body", async () => {
  const { fetchImpl } = stub({ status: 401, json: { error: "invalid_api_key" } });
  const client = new Ibee({ token: "bad", fetch: fetchImpl });
  await assert.rejects(
    () => client.secretStore.listSecretStores({ workspaceId: "1" }),
    (err: unknown) => {
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
