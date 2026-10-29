import assert from "node:assert/strict";
import { test } from "node:test";
import { Ibee, IbeeEnvironment, IbeeError, VERSION } from "../dist/index.js";
import { stubClient } from "./helpers.mjs";

const ENV_NAMES = ["IBEE_API_TOKEN", "IBEE_TOKEN", "IBEE_WORKSPACE_ID", "IBEE_ENV", "IBEE_API_URL"];

function withEnv(values, fn) {
    const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
    for (const n of ENV_NAMES) delete process.env[n];
    Object.assign(process.env, values);
    try {
        return fn();
    } finally {
        for (const n of ENV_NAMES) {
            if (saved[n] === undefined) delete process.env[n];
            else process.env[n] = saved[n];
        }
    }
}

function recordingFetch(calls) {
    return async (url, init) => {
        calls.push({ url: new URL(String(url)), headers: new Headers(init.headers) });
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
}

test("version is 0.6.0", () => {
    assert.equal(VERSION, "0.6.0");
});

test("reads token, workspace and environment from the environment", async () => {
    const calls = [];
    const client = withEnv(
        { IBEE_API_TOKEN: "ibee_dev_key_env", IBEE_WORKSPACE_ID: "42", IBEE_ENV: "dev" },
        () => new Ibee({ fetch: recordingFetch(calls) }),
    );
    await client.cloudVms.listCloudVms({ limit: 5 });
    assert.equal(calls[0].url.origin + calls[0].url.pathname, `${IbeeEnvironment.Development}/compute/cloud-vms`);
    assert.equal(calls[0].url.searchParams.get("workspace_id"), "42");
    assert.equal(calls[0].headers.get("authorization"), "Bearer ibee_dev_key_env");
});

test("IBEE_TOKEN and IBEE_API_URL are accepted; explicit options win", async () => {
    const calls = [];
    const client = withEnv(
        { IBEE_TOKEN: "t-env", IBEE_API_URL: "http://localhost:8080/v1", IBEE_WORKSPACE_ID: "1" },
        () => new Ibee({ workspaceId: "2", fetch: recordingFetch(calls) }),
    );
    await client.cloudVms.listCloudVms({ limit: 1 });
    assert.equal(calls[0].url.origin, "http://localhost:8080");
    assert.equal(calls[0].url.searchParams.get("workspace_id"), "2");
    assert.equal(calls[0].headers.get("authorization"), "Bearer t-env");
});

test("a per-call workspace_id overrides the default", async () => {
    const { client, calls } = stubClient(() => ({ json: [] }));
    await client.cloudVms.listCloudVms({ workspace_id: "99", limit: 1 });
    assert.equal(calls[0].url.searchParams.get("workspace_id"), "99");
});

test("defaults to production and requires a token", () => {
    withEnv({}, () => {
        assert.throws(() => new Ibee(), IbeeError);
        const client = new Ibee({ token: "t" });
        assert.equal(client._options.baseUrl, IbeeEnvironment.Production);
    });
});

test("rejects unsafe base URLs", () => {
    for (const baseUrl of ["http://api.ibee.ai/v1", "https://user:pw@api.ibee.ai/v1", "https://api.ibee.ai/v1?x=1", "nope"]) {
        assert.throws(() => new Ibee({ token: "t", baseUrl }), IbeeError, baseUrl);
    }
});

test("the token is sent as given; the server decides whether it fits the environment", async () => {
    const calls = [];
    const client = new Ibee({ token: "ibee_dev_key_x", environment: IbeeEnvironment.Production, fetch: recordingFetch(calls) });
    await client.cloudVms.listCloudVms({ limit: 1 });
    assert.equal(calls[0].url.origin + "/v1", IbeeEnvironment.Production);
    assert.equal(calls[0].headers.get("authorization"), "Bearer ibee_dev_key_x");
});

test("the token is not in the client's enumerable state", () => {
    const client = new Ibee({ token: "ibee_prod_key_secret" });
    assert.ok(!JSON.stringify(client).includes("ibee_prod_key_secret"));
});

test("fills X-Idempotency-Key only where the contract requires it", async () => {
    const { client, calls } = stubClient(() => ({ json: { operation_id: "op" } }));
    await client.cloudVms.startCloudVm({ vm_id: "vm1" });
    await client.cloudVms.startCloudVm({ vm_id: "vm1", "X-Idempotency-Key": "mine" });
    await client.gpuVms.deleteGpuVm({ vm_id: "vm2" });
    await client.cloudVms.createCloudVmSnapshot({
        vm_id: "vm1",
        body: { name: "s", billing_catalog: { sku_id: 1, sku_code: "SNAPSHOT-STD" } },
    });
    assert.match(calls[0].headers.get("x-idempotency-key"), /^[0-9a-f-]{36}$/);
    assert.equal(calls[1].headers.get("x-idempotency-key"), "mine");
    assert.match(calls[2].headers.get("x-idempotency-key"), /^[0-9a-f-]{36}$/);
    assert.equal(calls[3].headers.get("x-idempotency-key"), null);
    assert.deepEqual(calls[3].body.billing_catalog, { sku_id: 1, sku_code: "SNAPSHOT-STD" });
});
