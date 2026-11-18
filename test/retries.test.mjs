import assert from "node:assert/strict";
import { test } from "node:test";
import { IbeeError } from "../dist/index.js";
import { stubClient } from "./helpers.mjs";

const NOW = { "retry-after": "0" };

/** First `failures` answers use `status`/`json`, then 200. */
function flaky(failures, status, json = { error: "unavailable" }) {
    return (call, n) => (n <= failures ? { status, json, headers: NOW } : { json: [] });
}

test("GET is retried on 503 and 429", async () => {
    for (const status of [503, 429]) {
        const { client, calls } = stubClient(flaky(2, status));
        assert.deepEqual(await client.cloudVms.listCloudVms({ limit: 1 }), []);
        assert.equal(calls.length, 3, String(status));
    }
});

test("GET is retried on 502 and 504; 500 and other statuses are not", async () => {
    for (const status of [502, 504]) {
        const { client, calls } = stubClient(flaky(2, status));
        assert.deepEqual(await client.cloudVms.listCloudVms({ limit: 1 }), []);
        assert.equal(calls.length, 3, String(status));
    }
    for (const status of [500, 400, 402, 409]) {
        const { client, calls } = stubClient(flaky(5, status));
        await assert.rejects(client.cloudVms.listCloudVms({ limit: 1 }), IbeeError);
        assert.equal(calls.length, 1, String(status));
    }
});

test("keyed writes are retried; unkeyed writes and VM create are not", async () => {
    let s = stubClient(flaky(1, 503));
    await s.client.cloudVms.rebootCloudVm({ vm_id: "vm1" });
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0].headers.get("x-idempotency-key"), s.calls[1].headers.get("x-idempotency-key"));

    s = stubClient(flaky(1, 503));
    await s.client.blockStorage.createBlockVolume({ name: "v", size_gb: 10, site_id: "s", idempotency_key: "k1" });
    assert.equal(s.calls.length, 2);

    s = stubClient(flaky(1, 503));
    await assert.rejects(s.client.blockStorage.createBlockVolume({ name: "v", size_gb: 10, site_id: "s" }));
    assert.equal(s.calls.length, 1);

    s = stubClient(flaky(1, 429));
    await assert.rejects(
        s.client.cloudVms.createCloudVm({
            name: "n",
            plan_id: "p",
            template_id: "t",
            os_distro: "ubuntu",
            os_type: "linux",
            cpu: 1,
            ram_mb: 1024,
            billing_catalog: { sku_id: 1, sku_code: "X" },
        }),
    );
    assert.equal(s.calls.length, 1);
});

test("issuing a Secret Manager secret ID is an unkeyed write and is never retried", async () => {
    // Each call replaces the previous secret ID; the contract gives it no idempotency header.
    const { client, calls } = stubClient(flaky(1, 503));
    await assert.rejects(client.secretManager.issueSecretManagerAppCredentialSecretId({ credential_id: "c1" }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.get("idempotency-key"), null);
    assert.equal(calls[0].headers.get("x-idempotency-key"), null);
});

test("Secret Manager and load balancer writes get a random Idempotency-Key, reused on retry", async () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const call of [
        (c) => c.secretManager.createSecretManagerAppCredential({ name: "app", access: "read", folder: "apps" }),
        (c) => c.secretManager.enableSecretManagerWorkspace({ namespace: "team-a" }),
        (c) => c.loadBalancers.deleteLoadBalancer({ load_balancer_id: "lb1" }),
    ]) {
        const { client, calls } = stubClient(flaky(1, 503));
        await call(client).catch(() => {});
        assert.equal(calls.length, 2);
        assert.match(calls[0].headers.get("idempotency-key"), UUID);
        assert.equal(calls[0].headers.get("idempotency-key"), calls[1].headers.get("idempotency-key"));
        assert.equal(calls[0].headers.get("x-idempotency-key"), null);
    }
    const { client, calls } = stubClient(flaky(1, 503));
    await client.loadBalancers.listLoadBalancerRegions().catch(() => {});
    assert.equal(calls[0].headers.get("idempotency-key"), null, "reads get no key");
});

test("maxRetries limits attempts (client and per request)", async () => {
    let s = stubClient(flaky(5, 503), { maxRetries: 0 });
    await assert.rejects(s.client.cloudVms.listCloudVms({ limit: 1 }));
    assert.equal(s.calls.length, 1);

    s = stubClient(flaky(5, 503));
    await assert.rejects(s.client.cloudVms.listCloudVms({ limit: 1 }, { maxRetries: 1 }));
    assert.equal(s.calls.length, 2);
});

test("client.fetch passthrough is not retried", async () => {
    const { client, calls } = stubClient(flaky(5, 503));
    const res = await client.fetch("/compute/cloud-vms?workspace_id=710995");
    assert.equal(res.status, 503);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.get("authorization"), "Bearer ibee_prod_key_test");
});
