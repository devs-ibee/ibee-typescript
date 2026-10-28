// Contract 0.6.2: generated calls for the moved and added operations, answers unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stubClient } from "./helpers.mjs";

const route = (c) => [c.method, c.path];

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
