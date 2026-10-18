import assert from "node:assert/strict";
import { test } from "node:test";
import { ForbiddenError, IbeeError, PaymentRequiredError } from "../dist/index.js";
import { stubClient } from "./helpers.mjs";

const VM = {
    name: "n",
    plan_id: "p",
    template_id: "t",
    os_distro: "ubuntu",
    os_type: "linux",
    cpu: 1,
    ram_mb: 1024,
    billing_catalog: { sku_id: 1, sku_code: "X" },
};

async function caught(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    assert.fail("expected an error");
}

test("an edge 402 is passed through unchanged", async () => {
    const body = {
        error: "billing_denied",
        required_scope: null,
        billing_reason: "resource_limit_reached",
        billing_sku_code: "VM-STD",
        billing_evaluated_at: "2026-10-19T00:00:00Z",
        admission_context_id: "adm_123",
    };
    const { client } = stubClient(() => ({ status: 402, json: body, headers: { "x-request-id": "req-1" } }));
    const err = await caught(client.cloudVms.createCloudVm(VM));
    assert.ok(err instanceof PaymentRequiredError);
    assert.ok(err instanceof IbeeError);
    assert.equal(err.statusCode, 402);
    assert.equal(err.code, "billing_denied");
    assert.equal(err.billingReason, "resource_limit_reached");
    assert.equal(err.admissionContextId, "adm_123");
    assert.equal(err.requestId, "req-1");
    assert.equal(err.serverMessage, undefined);
    assert.deepEqual(err.body, body);
    assert.match(err.message, /resource_limit_reached/);
});

test("detail envelopes and plain detail strings keep the server's code and message", async () => {
    const facade = { detail: { code: "RESOURCE_LIMIT_REACHED", message: "Your plan allows 2 volumes.", limit: 2 } };
    let s = stubClient(() => ({ status: 409, json: facade }));
    let err = await caught(s.client.blockStorage.createBlockVolume({ name: "v", size_gb: 10, site_id: "s" }));
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, "RESOURCE_LIMIT_REACHED");
    assert.equal(err.serverMessage, "Your plan allows 2 volumes.");
    assert.deepEqual(err.body, facade);

    s = stubClient(() => ({ status: 403, json: { error: "organization_restricted", detail: "Forbidden" } }));
    err = await caught(s.client.cloudVms.getCloudVm({ vm_id: "vm1" }));
    assert.ok(err instanceof ForbiddenError);
    assert.equal(err.code, "organization_restricted");
    assert.equal(err.serverMessage, "Forbidden");
});

test("statuses the operation does not declare still carry the fields", async () => {
    const { client } = stubClient(() => ({ status: 423, json: { error: "organization_suspended" } }));
    const err = await caught(client.cloudVms.listCloudVms({ limit: 1 }));
    assert.ok(err instanceof IbeeError);
    assert.equal(err.statusCode, 423);
    assert.equal(err.code, "organization_suspended");
});
