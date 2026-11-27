// Contract 0.15.0: no delete answers 204; every one says whether the resource is gone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stubClient } from "./helpers.mjs";

test("former 204 deletes return id, status and deletion", async () => {
    const check = "GET /v1/networking/vpcs/v1?workspace_id=ws";
    const answers = [
        { status: 200, json: { id: "v1", status: "deleted", deletion: { resource_id: "v1", state: "deleted", check } } },
        { status: 200, json: { id: "r1", status: "released", deletion: { resource_id: "r1", state: "released" } } },
    ];
    const { client } = stubClient(() => answers.shift());
    const vpc = await client.vpcs.deleteVpc({ vpc_id: "v1" });
    assert.deepEqual([vpc.id, vpc.status, vpc.deletion.state, vpc.deletion.check], ["v1", "deleted", "deleted", check]);
    const ip = await client.reservedIps.releaseReservedIp({ reserved_ip_id: "r1" });
    assert.equal(ip.deletion.state, "released");
});

test("a background delete keeps its fields and says it is deleting", async () => {
    const answer = { operation_id: "op-1", vm_id: "vm-1", status: "accepted", submitted_at: "2026-01-01T00:00:00Z",
        deletion: { resource_id: "vm-1", state: "deleting", operation_id: "op-1" } };
    const { client } = stubClient(() => ({ status: 202, json: answer }));
    const vm = await client.cloudVms.deleteCloudVm({ vm_id: "vm-1" });
    assert.equal(vm.operation_id, "op-1");
    assert.equal(vm.deletion.state, "deleting");
});
