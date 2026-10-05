import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

// Set this to ibee-sdk in an installed tarball consumer to exercise exports.
const specifier = process.env.IBEE_TEST_PACKAGE ?? "../dist/index.js";
const esm = await import(specifier);
const cjs = createRequire(import.meta.url)(process.env.IBEE_TEST_PACKAGE ?? "../dist/index.cjs");
const workspaceId = "710995";
const vmId = "0123456789abcdef01234567";
const accepted = { operation_id: `op_${vmId}`, vm_id: vmId, status: "accepted", submitted_at: "2026-10-04T00:00:00Z" };

function invoke(client, scenario) {
  const idempotencyKey = scenario.headers?.["X-Idempotency-Key"];
  if (scenario.path.endsWith("/actions/start")) return client.cloudVms.start({ workspaceId, vmId, idempotencyKey });
  if (scenario.method === "GET" && scenario.path === "/compute/cloud-vms") return client.cloudVms.list({ workspaceId, limit: 10 });
  if (scenario.path === "/secret-store/identities/id-1/access") return client.secretStore.getSecretIdentityAccess({ workspaceId, identityId: "id-1" });
  if (scenario.method === "POST" && ["/compute/cloud-vms", "/compute/gpu-vms"].includes(scenario.path)) {
    const args = { workspaceId, idempotencyKey, name: "fixture-vm", site_id: "site-1", plan_id: "plan-1",
      template_id: "image-1", cpu: 2, ram_mb: 8192, disk_gb: 50, os_type: "linux", os_distro: "ubuntu",
      billing_catalog: { sku_id: 11, sku_code: "STANDARD-2-8-50" }, resolveCatalog: false, preflightBilling: true };
    return scenario.path === "/compute/gpu-vms" ? client.gpuVms.create({ ...args, gpu_count: 1, gpu_model: "L4" }) : client.cloudVms.create(args);
  }
  throw new Error(`unmapped public fixture: ${scenario.name}`);
}

const path = process.env.IBEE_CONFORMANCE_FIXTURES;
if (path === undefined) {
  test("public shared policy conformance", { skip: "IBEE_CONFORMANCE_FIXTURES is unset" }, () => {});
} else {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.version, 1);
  assert.ok(fixture.cases.length);
  for (const [format, { Ibee, ApiError }] of [["ESM", esm], ["CJS", cjs]]) {
    for (const scenario of fixture.cases) {
      test(`${format} public policy: ${scenario.name}`, {
        skip: scenario.path === "/future-product/resources" && "future-product has no public method; covered by transport conformance",
      }, async () => {
        const calls = [];
        const headers = { "Content-Type": "application/json", "Retry-After": "0" };
        if (scenario.request_id) headers["X-Request-ID"] = scenario.request_id;
        const client = new Ibee({ token: "fixture", baseUrl: "https://fixture.test/v1", maxRetries: 3,
          fetch: async (url, init) => {
            calls.push({ url: new URL(url), ...init });
            return new Response(JSON.stringify(scenario.response), { status: scenario.status, headers });
          } });
        await assert.rejects(invoke(client, scenario), error => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.statusCode, scenario.status);
          assert.deepEqual(error.body, scenario.response);
          assert.equal(error.requestId, scenario.request_id);
          for (const [source, attr] of [["error", "rawCode"], ["billing_reason", "reason"],
            ["billing_sku_code", "billingSkuCode"], ["admission_context_id", "admissionContextId"]]) {
            if (source in scenario.response) assert.equal(error[attr], scenario.response[source]);
          }
          return true;
        });
        assert.equal(calls.length, scenario.attempts);
        for (const call of calls) {
          assert.equal(call.method, scenario.method);
          assert.equal(call.url.pathname, "/v1" + scenario.path.replace("vm-1", vmId));
          assert.equal(call.url.searchParams.get("workspace_id"), workspaceId);
          assert.equal(new Headers(call.headers).get("Authorization"), "Bearer fixture");
          for (const [name, value] of Object.entries(scenario.headers ?? {})) assert.equal(new Headers(call.headers).get(name), value);
          assert.equal(call.body, calls[0].body);
        }
        if (scenario.method === "POST" && scenario.path.endsWith("-vms")) {
          assert.equal(JSON.parse(calls[0].body).billing_catalog.sku_code, "STANDARD-2-8-50");
        }
      });
    }
  }
}

for (const [format, { Ibee }] of [["ESM", esm], ["CJS", cjs]]) {
  for (const currency of [undefined, "USD", "INR"]) {
    test(`${format} public catalog currency: ${currency ?? "omitted"}`, async () => {
      const calls = [];
      const payload = { plans: [], count: 0, vm_type: "cloud", currency: "USD", billing_interval: "HOURLY" };
      const mismatch = { detail: "Currency must match organization profile currency" };
      const client = new Ibee({ token: "fixture", fetch: async (url, init) => {
        calls.push({ url: new URL(url), ...init });
        return new Response(JSON.stringify(currency === "INR" ? mismatch : payload), { status: currency === "INR" ? 400 : 200 });
      } });
      const args = { workspaceId, vmType: "cloud", ...(currency === undefined ? {} : { currency }) };
      if (currency === "INR") {
        await assert.rejects(client.computeCatalog.listPlans(args), error => {
          assert.equal(error.statusCode, 400);
          assert.deepEqual(error.body, mismatch);
          return true;
        });
      } else assert.equal((await client.computeCatalog.listPlans(args)).currency, "USD");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, "GET");
      assert.equal(calls[0].url.pathname, "/v1/compute/plans");
      assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
        workspace_id: workspaceId, vm_type: "cloud", ...(currency === undefined ? {} : { currency }),
      });
    });
  }
  test(`${format} public action recovers with a stable generated key`, async () => {
    const calls = [];
    const client = new Ibee({ token: "fixture", fetch: async (url, init) => {
      calls.push(init);
      return new Response(JSON.stringify(calls.length === 1 ? { detail: "busy" } : accepted),
        { status: calls.length === 1 ? 503 : 202, headers: { "Retry-After": "0" } });
    } });
    const result = await client.cloudVms.start({ workspaceId, vmId });
    assert.equal(result.operation_id, accepted.operation_id);
    assert.equal(calls.length, 2);
    assert.ok(new Headers(calls[0].headers).get("X-Idempotency-Key"));
    assert.equal(new Headers(calls[0].headers).get("X-Idempotency-Key"), new Headers(calls[1].headers).get("X-Idempotency-Key"));
  });
}
