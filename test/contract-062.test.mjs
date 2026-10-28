// Contract 0.6.2: generated calls, sent as given, answers unchanged. The SDK adds no
// client-side logic (no plan lookups, defaults, billing_catalog composition or paging).
import assert from "node:assert/strict";
import { test } from "node:test";
import { stubClient } from "./helpers.mjs";

const route = (c) => [c.method, c.path];

// The plan's billing_catalog with its HOURLY billing_options entry merged in (README recipe).
const SELECTION = {
    sku_id: "019f25b7-c1b3-7a9e-bfb9-8c83e323b517",
    sku_code: "PERFORMA-1-2-50",
    price_currency: "INR",
    billing_options: [{ billing_interval: "HOURLY", committed: false, commitment_period: "HOURLY", unit_price_minor: 82 }],
    billing_interval: "HOURLY",
    committed: false,
    commitment_period: "HOURLY",
    unit_price_minor: 82,
};
const VM = {
    name: "web",
    site_id: "site-1",
    plan_id: "plan-1",
    template_id: "t",
    os_distro: "ubuntu",
    os_type: "linux",
    cpu: 1,
    ram_mb: 2048,
    billing_catalog: SELECTION,
};

test("VM create sends the request as given: no plan lookup, no billing_catalog change", async () => {
    const { client, calls } = stubClient(() => ({ status: 202, json: { operation_id: "op-1" } }));
    await client.cloudVms.createCloudVm(VM);
    await client.gpuVms.createGpuVm({ ...VM, gpu_count: 1, gpu_model: "A100" });
    assert.deepEqual(calls.map(route), [
        ["POST", "/compute/cloud-vms"],
        ["POST", "/compute/gpu-vms"],
    ]);
    assert.deepEqual(calls[0].body, VM);
    assert.deepEqual(calls[1].body.billing_catalog, SELECTION);
    assert.ok(calls.every((c) => /^[0-9a-f-]{36}$/.test(c.headers.get("x-idempotency-key"))));
});

test("VM create returns the server's billing-term answer unchanged", async () => {
    const answer = { error: "compute_billing_term_required", admission_context_id: "adm_1" };
    const { client, calls } = stubClient(() => ({ status: 400, json: answer, headers: { "x-request-id": "req-1" } }));
    const { billing_catalog: _none, ...noTerm } = VM;
    await assert.rejects(client.cloudVms.createCloudVm({ ...noTerm, billing_catalog: { sku_id: 1, sku_code: "X" } }), (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "compute_billing_term_required");
        assert.equal(err.requestId, "req-1");
        assert.deepEqual(err.body, answer);
        return true;
    });
    assert.equal(calls.length, 1);
});

test("VM delete, attach-volume and resize send their bodies as given", async () => {
    const { client, calls } = stubClient(() => ({ status: 202, json: { operation_id: "op-1" } }));
    await client.cloudVms.deleteCloudVm({ vm_id: "vm1", body: { public_ip_action: "release" } });
    await client.cloudVms.attachCloudVmVolume({ vm_id: "vm1", body: { volume_id: "vol-1", billing_catalog: { sku_id: 3, sku_code: "BLOCK" } } });
    await client.gpuVms.resizeGpuVm({ vm_id: "vm2", body: { cpu: 2, ram_mb: 4096, disk_gb: 60 } });
    assert.deepEqual(calls.map(route), [
        ["DELETE", "/compute/cloud-vms/vm1"],
        ["POST", "/compute/cloud-vms/vm1/actions/attach-volume"],
        ["POST", "/compute/gpu-vms/vm2/actions/resize"],
    ]);
    assert.deepEqual(calls[0].body, { public_ip_action: "release" });
    assert.deepEqual(calls[1].body, { volume_id: "vol-1", billing_catalog: { sku_id: 3, sku_code: "BLOCK" } });
    assert.deepEqual(calls[2].body, { cpu: 2, ram_mb: 4096, disk_gb: 60 });
});

test("lists make one call with the caller's paging", async () => {
    const { client, calls } = stubClient(() => ({ json: Array.from({ length: 10 }, (_, i) => ({ id: `vm-${i}` })) }));
    assert.equal((await client.cloudVms.listCloudVms()).length, 10);
    await client.firewalls.listFirewallGroups({ limit: 50, offset: 100 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.searchParams.get("limit"), null);
    assert.equal(calls[1].url.searchParams.get("limit"), "50");
    assert.equal(calls[1].url.searchParams.get("offset"), "100");
});

test("backups/disable sends the JSON body {} (fern/overrides.yml)", async () => {
    const { client, calls } = stubClient(() => ({ json: { policy_id: "p", enabled: false } }));
    await client.cloudVms.disableCloudVmBackups({ vm_id: "vm1" });
    await client.gpuVms.disableGpuVmBackups({ vm_id: "vm2" });
    assert.deepEqual(
        calls.map((c) => [c.method, c.path, c.body, c.headers.get("content-type")]),
        [
            ["POST", "/compute/cloud-vms/vm1/backups/disable", {}, "application/json"],
            ["POST", "/compute/gpu-vms/vm2/backups/disable", {}, "application/json"],
        ],
    );
});

test("S3 keys: revoke is POST .../revoke (soft), delete is DELETE (hard)", async () => {
    const { client, calls } = stubClient(() => ({ json: { access_key_id: "AK1", status: "revoked" } }));
    await client.objectStorage.revokeS3Credential({ access_key_id: "AK1" });
    await client.objectStorage.deleteS3Credential({ access_key_id: "AK1" });
    await client.objectStorage.createS3Credential({ name: "ci", permission_type: "object_ro" });
    assert.deepEqual(calls.map(route), [
        ["POST", "/object-storage/credentials/AK1/revoke"],
        ["DELETE", "/object-storage/credentials/AK1"],
        ["POST", "/object-storage/credentials"],
    ]);
    assert.equal(calls[2].body.permission_type, "object_ro");
});

test("bucket CORS: write takes snake_case, the read is returned as the server sends it", async () => {
    const s3Cased = { rules: [{ AllowedOrigins: ["https://a.example"], AllowedMethods: ["GET"] }] };
    const { client, calls } = stubClient((call) => (call.method === "GET" ? { json: s3Cased } : { json: {} }));
    await client.objectStorage.setBucketCors({
        bucket_name: "b1",
        body: { rules: [{ allowed_origins: ["https://a.example"], allowed_methods: ["GET"] }] },
    });
    const read = await client.objectStorage.getBucketCors({ bucket_name: "b1" });
    assert.deepEqual(calls.map(route), [
        ["PUT", "/object-storage/buckets/b1/cors"],
        ["GET", "/object-storage/buckets/b1/cors"],
    ]);
    assert.deepEqual(calls[0].body.rules[0].allowed_origins, ["https://a.example"]);
    assert.deepEqual(read, s3Cased);
});

test("bucket settings, recovery-storage plans and the new list routes", async () => {
    const { client, calls } = stubClient(() => ({ json: {} }));
    await client.objectStorage.getBucketLifecycle({ bucket_name: "b1" });
    await client.objectStorage.getBucketObjectLock({ bucket_name: "b1" });
    await client.objectStorage.getBucketNotifications({ bucket_name: "b1" });
    await client.objectStorage.getBucketCustomDomains({ bucket_name: "b1" });
    await client.objectStorage.removeBucketCustomDomain({ bucket_name: "b1", domain: "cdn.example.com" });
    await client.objectStorage.getBucketMetrics({ bucket_name: "b1" });
    await client.computeCatalog.listSnapshotStoragePlans();
    await client.computeCatalog.listBackupStoragePlans();
    await client.computeCatalog.listComputePlans({ vm_type: "cloud", billing_interval: "MONTHLY" });
    await client.blockStorage.listBlockStoragePlans();
    await client.cloudVms.listAllCloudVmSnapshots();
    await client.gpuVms.listAllGpuVmBackupRuns();
    await client.cloudVms.deleteCloudVmBackupRun({ run_id: "run-1" });
    await client.cdn.getCdnDistributionMetrics({ distribution_id: "d1" });
    await client.vpcs.updateNatGatewayPublicIp({ vpc_id: "v1", nat_gateway_id: "n1", reserved_public_ip_id: "r1" });
    assert.deepEqual(calls.map(route), [
        ["GET", "/object-storage/buckets/b1/lifecycle"],
        ["GET", "/object-storage/buckets/b1/object-lock"],
        ["GET", "/object-storage/buckets/b1/notifications"],
        ["GET", "/object-storage/buckets/b1/custom-domains"],
        ["DELETE", "/object-storage/buckets/b1/custom-domains/cdn.example.com"],
        ["GET", "/object-storage/buckets/b1/metrics"],
        ["GET", "/compute/plans/snapshot-storage"],
        ["GET", "/compute/plans/backup-storage"],
        ["GET", "/compute/plans"],
        ["GET", "/block-storage/plans"],
        ["GET", "/compute/cloud-vm-snapshots"],
        ["GET", "/compute/gpu-vm-backups/runs"],
        ["DELETE", "/compute/cloud-vm-backups/runs/run-1"],
        ["GET", "/cdn/distributions/d1/metrics"],
        ["PUT", "/networking/vpcs/v1/nat-gateways/n1/public-ip"],
    ]);
    assert.equal(calls[8].url.searchParams.get("billing_interval"), "MONTHLY");
    assert.equal(calls[8].url.searchParams.get("vm_type"), "cloud");
    assert.deepEqual(calls[14].body, { reserved_public_ip_id: "r1" });
    assert.ok(calls.every((c) => c.url.searchParams.get("workspace_id") === "710995"));
});

test("NAT port-forwarding rules come back as sent (port_forward_rule_id)", async () => {
    const rule = { port_forward_rule_id: "pf-1", target_type: "vm", external_port: 2222, internal_port: 22 };
    const { client } = stubClient(() => ({ json: [rule] }));
    assert.deepEqual(await client.vpcs.listNatPortForwardingRules({ vpc_id: "v1", nat_gateway_id: "n1" }), [rule]);
});

test("removed operations are gone from the client", async () => {
    const { client } = stubClient();
    for (const [resource, name] of [
        ["cloudVms", "resizeCloudVmPlan"],
        ["cloudVms", "resizeCloudVmRootDisk"],
        ["gpuVms", "resizeGpuVmPlan"],
        ["gpuVms", "resizeGpuVmRootDisk"],
        ["cloudVms", "acknowledgeCloudVmMountGuidance"],
        ["cloudVms", "createCloudVmBackupRun"],
        ["cloudVms", "rescheduleCloudVmBackup"],
        ["blockStorage", "attachBlockVolume"],
        ["blockStorage", "detachBlockVolume"],
        ["cdn", "generateCdnUrl"],
        ["vpcs", "updateVpcSubnet"],
        ["secretStore", "patchSecretValue"],
        ["secretStore", "updateSecretStore"],
        ["containerRegistry", "emptyContainerRegistry"],
    ]) {
        assert.equal(typeof client[resource][name], "undefined", `${resource}.${name}`);
    }
    assert.equal(client.vmConsole, undefined, "console sessions");
    assert.equal(client.billing, undefined, "billing resource-eligibility");
});
