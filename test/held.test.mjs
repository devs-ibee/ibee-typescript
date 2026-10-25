// Tests for the temporary client-side behaviour in src/wrapper/held.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stubClient } from "./helpers.mjs";

const PLAN_CATALOG = {
    sku_id: 11,
    sku_code: "VM-STD-2",
    billing_options: [
        { billing_interval: "HOURLY", committed: false, unit_price_minor: 500 },
        { billing_interval: "MONTHLY", committed: true, commitment_months: 1, unit_price_minor: 300000 },
    ],
};
const PLANS = {
    plans: [{ plan_id: "plan-1", cpu: 4, ram_mb: 8192, disk_gb: 80, billing_catalog: PLAN_CATALOG }],
};
const VM = { name: "web", site_id: "site-1", plan_id: "plan-1", template_id: "t", os_distro: "ubuntu", os_type: "linux", cpu: 4, ram_mb: 8192 };

function api(extra = {}) {
    return (call) => {
        if (call.path === "/compute/plans") return { json: PLANS };
        for (const [path, json] of Object.entries(extra)) if (call.path === path) return { json };
        return { json: { operation_id: "op-1" } };
    };
}
const sent = (calls, method, path) => calls.find((c) => c.method === method && c.path === path);

test("VM create without billing_catalog uses the plan SKU priced HOURLY", async () => {
    const { client, calls } = stubClient(api());
    await client.cloudVms.createCloudVm(VM);
    const plans = sent(calls, "GET", "/compute/plans");
    assert.equal(plans.url.searchParams.get("vm_type"), "cloud");
    assert.equal(plans.url.searchParams.get("site_id"), "site-1");
    const body = sent(calls, "POST", "/compute/cloud-vms").body;
    assert.equal(body.billing_catalog.sku_code, "VM-STD-2");
    assert.equal(body.billing_catalog.billing_interval, "HOURLY");
    assert.equal(body.billing_catalog.unit_price_minor, 500);
    assert.equal(body.billing_term, undefined);
});

test("VM create merges billing_term, the Windows licence and the Reserved IP SKU", async () => {
    const rip = { id: "rip-1", billing_catalog: { sku_id: 7, sku_code: "RESERVED-IP" } };
    const { client, calls } = stubClient(api({ "/networking/reserved-ips/rip-1": rip }));
    await client.cloudVms.createCloudVm({
        ...VM,
        os_type: "windows",
        billing_term: "MONTHLY",
        windows_license: { sku_id: 9, sku_code: "WIN-LIC" },
        reserved_public_ip_id: "rip-1",
    });
    const catalog = sent(calls, "POST", "/compute/cloud-vms").body.billing_catalog;
    assert.equal(catalog.billing_interval, "MONTHLY");
    assert.equal(catalog.commitment_months, 1);
    assert.equal(catalog.attached_skus.windows_license.quantity, 4);
    assert.equal(catalog.attached_skus.windows_license.quantity_basis, "VCPU");
    assert.deepEqual(catalog.attached_skus.reserved_ip, rip.billing_catalog);
});

test("a given billing_catalog is sent as is; GPU plans get no default term", async () => {
    let s = stubClient(api());
    const given = { sku_id: 1, sku_code: "MINE" };
    await s.client.cloudVms.createCloudVm({ ...VM, billing_catalog: given });
    assert.deepEqual(sent(s.calls, "POST", "/compute/cloud-vms").body.billing_catalog, given);
    assert.equal(sent(s.calls, "GET", "/compute/plans"), undefined);

    s = stubClient(api());
    await s.client.gpuVms.createGpuVm({ ...VM, gpu_count: 1, gpu_model: "A100" });
    assert.equal(sent(s.calls, "GET", "/compute/plans").url.searchParams.get("vm_type"), "gpu");
    assert.deepEqual(sent(s.calls, "POST", "/compute/gpu-vms").body.billing_catalog, PLAN_CATALOG);
});

test("VM delete sends the body as given, with no public_ip_action default", async () => {
    const { client, calls } = stubClient(api());
    await client.cloudVms.deleteCloudVm({ vm_id: "vm1" });
    await client.gpuVms.deleteGpuVm({ vm_id: "vm2", body: {} });
    await client.gpuVms.deleteGpuVm({
        vm_id: "vm3",
        body: { public_ip_action: "reserve", reserved_ip_billing_catalog: { sku_id: 7 } },
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].body, {});
    assert.deepEqual(calls[1].body, {});
    assert.deepEqual(calls[2].body, { public_ip_action: "reserve", reserved_ip_billing_catalog: { sku_id: 7 } });
    assert.ok(calls.every((c) => c.method === "DELETE"), "no VM read to decide the action");
});

test("VM delete without a choice relays the server's 400", async () => {
    const { client, calls } = stubClient(() => ({
        status: 400,
        json: { error: "public_ip_action_required" },
        headers: { "x-request-id": "req-9" },
    }));
    await assert.rejects(client.cloudVms.deleteCloudVm({ vm_id: "vm1" }), (err) => {
        assert.equal(err.statusCode, 400);
        assert.deepEqual(err.body, { error: "public_ip_action_required" });
        return true;
    });
    assert.equal(calls.length, 1);
});

test("attach-volume reads billing_catalog from the volume's metadata when omitted", async () => {
    const volume = { id: "vol-1", metadata: { billing_catalog: { sku_id: 3, sku_code: "BLOCK-STD" } } };
    const { client, calls } = stubClient(api({ "/block-storage/volumes/vol-1": volume }));
    await client.cloudVms.attachCloudVmVolume({ vm_id: "vm1", body: { volume_id: "vol-1" } });
    assert.deepEqual(sent(calls, "POST", "/compute/cloud-vms/vm1/actions/attach-volume").body, {
        volume_id: "vol-1",
        billing_catalog: volume.metadata.billing_catalog,
    });
});

test("attach-volume leaves billing_catalog out when the volume has none", async () => {
    const volume = { id: "vol-2", metadata: { billing_catalog: null } };
    const { client, calls } = stubClient(api({ "/block-storage/volumes/vol-2": volume }));
    await client.gpuVms.attachGpuVmVolume({ vm_id: "vm1", body: { volume_id: "vol-2", billing_catalog: null } });
    const body = sent(calls, "POST", "/compute/gpu-vms/vm1/actions/attach-volume").body;
    assert.deepEqual(body, { volume_id: "vol-2" });
});

test("attach-volume with a billing_catalog makes no lookup", async () => {
    const sku = { sku_id: 4, sku_code: "BLOCK-FAST" };
    const { client, calls } = stubClient(api());
    await client.cloudVms.attachCloudVmVolume({ vm_id: "vm1", body: { volume_id: "vol-1", billing_catalog: sku } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { volume_id: "vol-1", billing_catalog: sku });
});

test("resize-plan and root-disk resize pass billing_catalog through", async () => {
    const sku = { sku_id: 12, sku_code: "VM-STD-4" };
    const { client, calls } = stubClient(api());
    await client.gpuVms.resizeGpuVmPlan({ vm_id: "vm1", body: { cpu: 4, ram_mb: 8192, billing_catalog: sku } });
    await client.cloudVms.resizeCloudVmRootDisk({ vm_id: "vm1", body: { new_size_gb: 100, billing_catalog: sku } });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, { cpu: 4, ram_mb: 8192, billing_catalog: sku });
    assert.deepEqual(calls[1].body, { new_size_gb: 100, billing_catalog: sku });
});

test("resize with plan_id sends the plan shape and SKU, carrying a Windows licence", async () => {
    const license = { sku_id: 9, sku_code: "WIN-LIC", quantity: 2 };
    const vm = { _id: "vm1", site_id: "site-1", billing_catalog: { attached_skus: { windows_license: license } } };
    const { client, calls } = stubClient(api({ "/compute/cloud-vms/vm1": vm }));
    await client.cloudVms.resizeCloudVm({ vm_id: "vm1", body: { plan_id: "plan-1" } });
    const body = sent(calls, "POST", "/compute/cloud-vms/vm1/actions/resize").body;
    assert.equal(body.cpu, 4);
    assert.equal(body.ram_mb, 8192);
    assert.equal(body.disk_gb, 80);
    assert.equal(body.plan_id, undefined);
    assert.equal(body.billing_catalog.billing_interval, "HOURLY");
    assert.deepEqual(body.billing_catalog.attached_skus.windows_license, license);

    await client.cloudVms.resizeCloudVmPlan({ vm_id: "vm1", body: { plan_id: "plan-1", billing_term: "MONTHLY" } });
    const plan = sent(calls, "PATCH", "/compute/cloud-vms/vm1/actions/resize-plan").body;
    assert.equal(plan.disk_gb, undefined);
    assert.equal(plan.billing_catalog.billing_interval, "MONTHLY");
});

test("VM and firewall-group lists read every page unless limit/offset is given", async () => {
    const page = (offset, n) => Array.from({ length: n }, (_, i) => ({ _id: `vm-${offset + i}` }));
    const { client, calls } = stubClient((call) => {
        const offset = Number(call.url.searchParams.get("offset") ?? 0);
        if (call.path === "/networking/firewall-groups") return { json: [{ id: "fw-1" }] };
        return { json: offset === 0 ? page(0, 100) : [...page(99, 1), ...page(100, 20)] };
    });
    const vms = await client.cloudVms.listCloudVms();
    assert.equal(vms.length, 120);
    assert.deepEqual(
        calls.map((c) => c.url.searchParams.get("offset")),
        ["0", "100"],
    );
    assert.equal((await client.cloudVms.listCloudVms({ limit: 5 })).length, 100);
    assert.equal(calls.at(-1).url.searchParams.get("limit"), "5");
    assert.deepEqual(await client.firewalls.listFirewallGroups(), [{ id: "fw-1" }]);
});

test("NAT billing catalogs are passed through on VPC and NAT gateway create", async () => {
    const sku = { sku_id: 5, sku_code: "NAT-GATEWAY" };
    const { client, calls } = stubClient(api());
    await client.vpcs.createVpc({ name: "v", site_id: "s", connectivity_type: "nat_gateway", nat_billing_catalog: sku });
    await client.vpcs.createNatGateway({ vpc_id: "vpc-1", billing_catalog: sku });
    assert.deepEqual(calls[0].body.nat_billing_catalog, sku);
    assert.deepEqual(calls[1].body.billing_catalog, sku);
});
