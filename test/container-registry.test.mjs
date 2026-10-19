import assert from "node:assert/strict";
import { test } from "node:test";
import { Ibee } from "../dist/index.js";
import { stubClient } from "./helpers.mjs";

// Container Registry (contract 0.5.0): generated calls, the Idempotency-Key default,
// answers unchanged.

const REG = "6f1c2c1e-8d3b-4c55-9a43-0d6c1f0b9e11";
const SKU = { sku_code: "REGISTRY-STORAGE-500GB" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOW = { "retry-after": "0" };

test("create sends the body as given and returns the answer unchanged", async () => {
    const answer = { registry_id: REG, registry_name: "acme-apps", observed_state: "PROVISIONING" };
    const { client, calls } = stubClient(() => ({ status: 202, json: answer }));
    const created = await client.containerRegistry.createContainerRegistry({
        registry_name: "acme-apps",
        confirm_registry_name: "acme-apps",
        billing_catalog: { sku_code: "REGISTRY-STORAGE-250GB" },
    });
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/container-registry/registries");
    assert.equal(calls[0].url.searchParams.get("workspace_id"), "710995");
    assert.deepEqual(calls[0].body, {
        registry_name: "acme-apps",
        confirm_registry_name: "acme-apps",
        billing_catalog: { sku_code: "REGISTRY-STORAGE-250GB" },
    });
    assert.deepEqual(created, answer);
});

test("plan upgrade gets a random Idempotency-Key, not X-Idempotency-Key", async () => {
    const { client, calls } = stubClient(() => ({ status: 202, json: { status: "PENDING" } }));
    await client.containerRegistry.upgradeContainerRegistryPackage({ registry_id: REG, billing_catalog: SKU });
    assert.match(calls[0].headers.get("idempotency-key"), UUID);
    assert.equal(calls[0].headers.get("x-idempotency-key"), null);
});

test("a caller's Idempotency-Key is sent unchanged", async () => {
    const { client, calls } = stubClient(() => ({ status: 202, json: {} }));
    await client.containerRegistry.upgradeContainerRegistryPackage({
        registry_id: REG,
        "Idempotency-Key": "up-1",
        billing_catalog: SKU,
    });
    await client.containerRegistry.upgradeContainerRegistryPackage(
        { registry_id: REG, billing_catalog: SKU },
        { headers: { "Idempotency-Key": "up-2" } },
    );
    assert.deepEqual(
        calls.map((c) => c.headers.get("idempotency-key")),
        ["up-1", "up-2"],
    );
});

test("upgrade is retried on 503 with the same key; a billing refusal is not retried", async () => {
    let s = stubClient((call, n) => (n === 1 ? { status: 503, json: { detail: "busy" }, headers: NOW } : { json: {} }));
    await s.client.containerRegistry.upgradeContainerRegistryPackage({ registry_id: REG, billing_catalog: SKU });
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0].headers.get("idempotency-key"), s.calls[1].headers.get("idempotency-key"));

    const refusal = { detail: { code: "billing_resource_not_eligible", reason: "kyc_required" } };
    s = stubClient(() => ({ status: 403, json: refusal }));
    await assert.rejects(
        s.client.containerRegistry.upgradeContainerRegistryPackage({ registry_id: REG, billing_catalog: SKU }),
        (error) => error.statusCode === 403 && JSON.stringify(error.body) === JSON.stringify(refusal),
    );
    assert.equal(s.calls.length, 1);
});

test("other registry writes get no idempotency key", async () => {
    const { client, calls } = stubClient(() => ({ status: 202, json: {} }));
    await client.containerRegistry.updateContainerRegistryVisibility({ registry_id: REG, visibility: "PRIVATE" });
    assert.equal(calls[0].headers.get("idempotency-key"), null);
    assert.equal(calls[0].headers.get("x-idempotency-key"), null);
});

test("token create returns the secret as sent", async () => {
    const secret = { token_id: "t1", token_name: "ci", username: "robot$acme+ci", secret: "s3cr3t", permission: "PULL" };
    const { client, calls } = stubClient(() => ({ status: 201, json: secret }));
    const token = await client.containerRegistry.createContainerRegistryAccessToken({ registry_id: REG, token_name: "ci" });
    assert.deepEqual(calls[0].body, { token_name: "ci" });
    assert.deepEqual(token, secret);
});

test("paging uses page and page_size", async () => {
    const { client, calls } = stubClient(() => ({ json: { items: [], total: 0, page: 2, page_size: 100 } }));
    await client.containerRegistry.listContainerRegistries({ page: 2, page_size: 100 });
    assert.equal(calls[0].url.searchParams.get("page"), "2");
    assert.equal(calls[0].url.searchParams.get("page_size"), "100");
});

test("the client exposes containerRegistry", () => {
    assert.equal(typeof new Ibee({ token: "ibee_prod_key_x" }).containerRegistry.listContainerRegistries, "function");
});
