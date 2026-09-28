import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConflictError,
  Ibee,
  IbeeValidationError,
  RecoveryFailedError,
  RecoveryRestoreFailedError,
  ResizeBlockedError,
  apiErrorFromResponse,
  billingCatalogForTerm,
  buildVmCreateBillingCatalog,
  expandBatchNames,
  normalizeVmRecord,
  recoveryDefaultVmName,
  recoveryMinRootDiskGb,
  recoveryTargetVolumeNames,
  resolveDeletePublicIpAction,
  selectBillingOption,
  validateBackupSchedule,
  validateBillingCatalog,
  validateSshPublicKey,
} from "../dist/index.js";

const WS = "710995";
const VM1 = "64b0000000000000000000a1";
const OP1 = "op_64b0000000000000000000f1";
const SSH = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB3x user@host";

const PLAN_CATALOG = {
  sku_id: 101,
  sku_code: "standard-2-8-50",
  product_code: "compute",
  attached_skus: { "Bandwidth-TB": { sku_id: 7, sku_code: "BW-1TB" } },
  billing_options: [
    { billing_interval: "HOURLY", unit_price_minor: 500, committed: false },
    { billing_interval: "MONTHLY", unit_price_minor: 300000, committed: true, commitment_months: 1, discount_percent: 10 },
    { billing_interval: "YEARLY", unit_price_minor: null },
  ],
};
const PLAN = {
  plan_id: "plan-1", vm_type: "cloud", name: "Standard 2", code: "STD-2", cpu: 2, ram_mb: 8192, disk_gb: 50,
  gpu_count: 0, selectable: true, pricing_status: "priced", currency: "INR", billing_interval: "HOURLY",
  hourly_price_minor: 500, monthly_price_minor: 300000, site_id: "site-1", billing_catalog: PLAN_CATALOG,
};
const GPU_PLAN = {
  ...PLAN, plan_id: "gpu-1", vm_type: "gpu", cpu: 8, ram_mb: 65536, disk_gb: 200, gpu_count: 2, gpu_model: "A100",
  billing_catalog: { sku_id: 202, sku_code: "GPU-A100-2", billing_options: [{ billing_interval: "HOURLY", unit_price_minor: 9000 }] },
};
const LINUX_IMAGE = {
  template_id: "ubuntu-24", name: "Ubuntu", os_distro: "ubuntu", os_type: "linux", architecture: "x86_64",
  size_bytes: 1, gpu_compatible: true, compatible_vm_types: ["cloud", "gpu"], site_ids: [],
};
const WIN_IMAGE = { ...LINUX_IMAGE, template_id: "win-2022", os_distro: "windows", os_type: "windows", compatible_vm_types: ["cloud"] };
const WIN_LICENSE = {
  sku_id: 55, sku_code: "WIN-LIC", os_family: "windows",
  billing_options: [{ billing_interval: "HOURLY", unit_price_minor: 100 }, { billing_interval: "MONTHLY", unit_price_minor: 60000 }],
};
const ACCEPTED = { operation_id: OP1, vm_id: VM1, status: "accepted", submitted_at: "2026-09-28T00:00:00Z" };

/**
 * Routed fetch mock. `routes` is a list of [method, RegExp, response], where
 * response is a JSON value, `{ status, json }`, or a function (call) => one of those.
 * Unmatched requests answer 404.
 */
function router(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = {
      url: String(url),
      path: new URL(String(url)).pathname.replace(/^\/v1/, ""),
      query: new URL(String(url)).searchParams,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    for (const [method, re, resp] of routes) {
      if (method === call.method && re.test(call.path)) {
        let r = typeof resp === "function" ? resp(call) : resp;
        if (!(r && typeof r === "object" && "status" in r && "json" in r)) r = { status: 200, json: r };
        return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
  };
  return { calls, fetchImpl, client: new Ibee({ token: "t", fetch: fetchImpl, maxRetries: 0 }) };
}

const catalogRoutes = (plans = [PLAN], images = [LINUX_IMAGE]) => [
  ["GET", /^\/compute\/plans$/, { plans, count: plans.length }],
  ["GET", /^\/compute\/images$/, { images, count: images.length }],
];
const isValidation = (code) => (err) => {
  assert.ok(err instanceof IbeeValidationError, `expected IbeeValidationError, got ${err?.name}: ${err?.message}`);
  if (code) assert.equal(err.code, code, err.message);
  return true;
};

// ------------------------------------------------------------------ create

test("create resolves plan and image like the portal and prices the default HOURLY term", async () => {
  const { calls, client } = router([...catalogRoutes(), ["POST", /^\/compute\/cloud-vms$/, ACCEPTED]]);
  const res = await client.cloudVms.create({
    workspaceId: WS, name: " web-01 ", site_id: "site-1", plan_id: "plan-1", template_id: "ubuntu-24",
    ssh_keys: [SSH, ` ${SSH} `], firewall_group_ids: ["fw-1"], tags: ["a"],
  });
  assert.equal(res.operation_id, OP1);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "GET /compute/plans", "GET /compute/images", "POST /compute/cloud-vms",
  ]);
  assert.equal(calls[0].query.get("vm_type"), "cloud");
  assert.equal(calls[0].query.get("site_id"), "site-1");
  const body = calls[2].body;
  assert.equal(body.name, "web-01");
  assert.equal(body.cpu, 2);
  assert.equal(body.ram_mb, 8192);
  assert.equal(body.disk_gb, 50);
  assert.equal(body.os_type, "linux");
  assert.equal(body.os_distro, "ubuntu");
  assert.deepEqual(body.ssh_keys, [SSH]);
  assert.equal(body.firewall_group_id, "fw-1");
  assert.deepEqual(body.firewall_group_ids, ["fw-1"]);
  assert.equal(body.billing_catalog.sku_code, "STANDARD-2-8-50");
  assert.equal(body.billing_catalog.billing_interval, "HOURLY");
  assert.equal(body.billing_catalog.unit_price_minor, 500);
  assert.equal(body.billing_catalog.committed, false);
  assert.deepEqual(Object.keys(body.billing_catalog.attached_skus), ["bandwidth_tb"]);
  for (const k of ["created_by", "created_by_email", "workspace_id", "vpc_id", "billing_term"]) assert.equal(k in body, false, k);
  assert.match(calls[2].headers.get("x-idempotency-key"), /^cloud-vm-create-web-01-/);
});

test("create applies MONTHLY terms, rejects unsupported terms and unavailable plans", async () => {
  const { calls, client } = router([...catalogRoutes(), ["POST", /^\/compute\/cloud-vms$/, ACCEPTED]]);
  const base = { workspaceId: WS, name: "web", site_id: "site-1", plan_id: "plan-1", template_id: "ubuntu-24" };
  await client.cloudVms.create({ ...base, billing_term: "monthly" });
  const cat = calls.at(-1).body.billing_catalog;
  assert.equal(cat.billing_interval, "MONTHLY");
  assert.equal(cat.commitment_months, 1);
  assert.equal(cat.discount_percent, 10);
  assert.equal(cat.unit_price_minor, 300000);
  await assert.rejects(client.cloudVms.create({ ...base, billing_term: "YEARLY" }), (err) => {
    assert.equal(err.message, "Selected plan does not support yearly billing");
    return true;
  });
  await assert.rejects(client.cloudVms.create({ ...base, billing_term: "WEEKLY" }), isValidation("invalid_billing_term"));
  await assert.rejects(client.cloudVms.create({ ...base, cpu: 4 }), isValidation("catalog_mismatch"));
  await assert.rejects(client.cloudVms.create({ ...base, plan_id: "nope" }), isValidation("invalid_plan"));
  await assert.rejects(client.cloudVms.create({ ...base, template_id: "nope" }), isValidation("invalid_template"));
  const unpriced = router([...catalogRoutes([{ ...PLAN, pricing_status: "unpriced" }])]);
  await assert.rejects(unpriced.client.cloudVms.create(base), isValidation("invalid_plan"));
});

test("create validates names, SSH keys, firewall groups and network fields before any request", async () => {
  const { calls, client } = router([]);
  const base = { workspaceId: WS, name: "web", site_id: "site-1", plan_id: "plan-1", template_id: "ubuntu-24" };
  const bad = [
    [{ name: "web server" }, "invalid_vm_name"],
    [{ name: "  " }, "invalid_vm_name"],
    [{ site_id: undefined }, "site_required"],
    [{ ssh_keys: ["-----BEGIN OPENSSH PRIVATE KEY-----"] }, "invalid_ssh_key"],
    [{ ssh_keys: ["ssh-dss AAAA"] }, "invalid_ssh_key"],
    [{ ssh_keys: ["ssh-rsa AAAA\nssh-rsa BBBB"] }, "invalid_ssh_key"],
    [{ firewall_group_ids: ["a", "b"] }, "invalid_firewall_group_ids"],
    [{ vpc_id: "vpc-1" }, "invalid_network"],
    [{ network_connectivity: "nat" }, "invalid_network"],
    [{ vpc_id: "v", subnet_id: "s", reserved_public_ip_id: "r" }, "invalid_network"],
    [{ os_type: "windows" }, "windows_license_required"],
  ];
  for (const [patch, code] of bad) {
    await assert.rejects(client.cloudVms.create({ ...base, ...patch }), isValidation(code), JSON.stringify(patch));
  }
  await assert.rejects(client.gpuVms.create({ ...base, os_type: "windows" }), isValidation("invalid_os_type"));
  assert.equal(calls.length, 0);
});

test("Windows create attaches the licence priced for the term with quantity = vCPU", async () => {
  const { calls, client } = router([...catalogRoutes([PLAN], [WIN_IMAGE]), ["POST", /^\/compute\/cloud-vms$/, ACCEPTED]]);
  const base = { workspaceId: WS, name: "win", site_id: "site-1", plan_id: "plan-1", template_id: "win-2022" };
  await assert.rejects(client.cloudVms.create(base), isValidation("windows_license_required"));
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  await client.cloudVms.create({ ...base, billing_term: "MONTHLY", windows_license: WIN_LICENSE });
  const lic = calls.at(-1).body.billing_catalog.attached_skus.windows_license;
  assert.equal(lic.quantity, 2);
  assert.equal(lic.quantity_basis, "VCPU");
  assert.equal(lic.component_key, "windows_license");
  assert.equal(lic.os_type, "windows");
  assert.equal(lic.billing_interval, "MONTHLY");
  assert.equal(lic.unit_price_minor, 60000);
  assert.equal(calls.at(-1).body.os_type, "windows");
  // A licence on a Linux image is rejected.
  const linux = router([...catalogRoutes(), ["POST", /^\/compute\/cloud-vms$/, ACCEPTED]]);
  await assert.rejects(
    linux.client.cloudVms.create({ ...base, template_id: "ubuntu-24", windows_license: WIN_LICENSE }),
    isValidation("invalid_billing_catalog"),
  );
});

test("GPU create takes gpu_count/gpu_model from the plan and sends the plan SKU unmodified", async () => {
  const { calls, client } = router([...catalogRoutes([GPU_PLAN]), ["POST", /^\/compute\/gpu-vms$/, ACCEPTED]]);
  const base = { workspaceId: WS, name: "trainer", site_id: "site-1", plan_id: "gpu-1", template_id: "ubuntu-24" };
  await client.gpuVms.create(base);
  const body = calls.at(-1).body;
  assert.equal(calls[0].query.get("vm_type"), "gpu");
  assert.equal(body.gpu_count, 2);
  assert.equal(body.gpu_model, "A100");
  assert.equal(body.disk_gb, 200);
  assert.equal(body.billing_catalog.billing_interval, undefined);
  await assert.rejects(client.gpuVms.create({ ...base, gpu_model: "H100" }), isValidation("catalog_mismatch"));
  await client.gpuVms.create({ ...base, billing_term: "HOURLY" });
  assert.equal(calls.at(-1).body.billing_catalog.billing_interval, "HOURLY");
});

test("VPC placement: NAT only in NAT VPCs, Reserved IP SKU attached, primary attachment", async () => {
  const vpcs = { "vpc-pub": "public", "vpc-nat": "nat_gateway", "vpc-priv": "private" };
  const routes = [
    ...catalogRoutes(),
    ["GET", /^\/networking\/vpcs\/[^/]+\/subnets\/[^/]+$/, (c) => ({ subnet_id: "sub-1", vpc_id: c.path.split("/")[3] })],
    ["GET", /^\/networking\/vpcs\/[^/]+$/, (c) => {
      const id = c.path.split("/")[3];
      return { vpc_id: id, site_id: "site-1", status: "active", connectivity_type: vpcs[id] };
    }],
    ["GET", /^\/networking\/reserved-ips\/rip-free$/, { public_ip_id: "rip-free", site_id: "site-1", billing_catalog: { sku_id: 9, sku_code: "RIP-STD" } }],
    ["GET", /^\/networking\/reserved-ips\/rip-used$/, { public_ip_id: "rip-used", site_id: "site-1", attached_resource_id: "x", billing_catalog: { sku_id: 9, sku_code: "RIP-STD" } }],
    ["POST", /^\/compute\/cloud-vms$/, ACCEPTED],
  ];
  const { calls, client } = router(routes);
  const base = { workspaceId: WS, name: "web", site_id: "site-1", plan_id: "plan-1", template_id: "ubuntu-24", subnet_id: "sub-1" };
  await assert.rejects(client.cloudVms.create({ ...base, vpc_id: "vpc-pub", network_connectivity: "nat" }), isValidation("invalid_network"));
  await assert.rejects(client.cloudVms.create({ ...base, vpc_id: "vpc-nat", network_connectivity: "public_ip" }), isValidation("invalid_network"));
  await assert.rejects(client.cloudVms.create({ ...base, vpc_id: "vpc-priv", network_connectivity: "public_ip" }), isValidation("invalid_network"));
  await assert.rejects(
    client.cloudVms.create({ ...base, vpc_id: "vpc-priv", network_connectivity: "public_ip", reserved_public_ip_id: "rip-used" }),
    isValidation("invalid_network"),
  );
  await client.cloudVms.create({ ...base, vpc_id: "vpc-priv", network_connectivity: "public_ip", reserved_public_ip_id: "rip-free" });
  const body = calls.at(-1).body;
  assert.equal(body.vpc_attachment_mode, "primary");
  assert.equal(body.network_connectivity, "public_ip");
  assert.equal(body.reserved_public_ip_id, "rip-free");
  assert.equal(body.billing_catalog.attached_skus.reserved_ip.sku_code, "RIP-STD");
  await client.cloudVms.create({ ...base, vpc_id: "vpc-nat" });
  assert.equal(calls.at(-1).body.network_connectivity, "private");
});

test("create billing preflight uses the plan SKU and a 731-hour estimate; create is never retried", async () => {
  const decisions = [];
  const { calls, client } = router([
    ...catalogRoutes(),
    ["POST", /^\/billing\/resource-eligibility$/, (c) => {
      decisions.push(c.body);
      return { organization_id: "o1", allowed: true, reason: "ok", sku_code: c.body.sku_code };
    }],
    ["POST", /^\/compute\/cloud-vms$/, { status: 503, json: { detail: "busy" } }],
  ]);
  await assert.rejects(
    client.cloudVms.create({ workspaceId: WS, name: "web", site_id: "site-1", plan_id: "plan-1", template_id: "ubuntu-24", preflightBilling: true }),
    (err) => err.statusCode === 503,
  );
  assert.deepEqual(decisions, [{ sku_code: "STANDARD-2-8-50", estimated_cost_minor: 500 * 731 }]);
  // Even with retries enabled, the create POST is sent once.
  const r2 = router([...catalogRoutes(), ["POST", /^\/compute\/cloud-vms$/, { status: 503, json: {} }]]);
  const c2 = new Ibee({ token: "t", fetch: r2.fetchImpl, maxRetries: 2 });
  await assert.rejects(c2.cloudVms.create({ workspaceId: WS, name: "web", site_id: "site-1", plan_id: "plan-1", template_id: "ubuntu-24" }));
  assert.equal(r2.calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(calls.filter((c) => c.method === "POST" && c.path === "/compute/cloud-vms").length, 1);
});

test("create with wait polls the operation", async () => {
  const { calls, client } = router([
    ...catalogRoutes(),
    ["POST", /^\/compute\/cloud-vms$/, ACCEPTED],
    ["GET", /^\/compute\/operations\//, { ...ACCEPTED, action: "create", status: "succeeded", updated_at: "x" }],
  ]);
  const res = await client.cloudVms.create({
    workspaceId: WS, name: "web", site_id: "site-1", plan_id: "plan-1", template_id: "ubuntu-24", wait: { pollIntervalMs: 1000 },
  });
  assert.equal(res.operation.status, "succeeded");
  assert.equal(calls.at(-1).path, `/compute/operations/${OP1}`);
});

// ------------------------------------------------------------ list / get

test("list, listAll and get copy _id to id", async () => {
  const { calls, client } = router([
    ["GET", /^\/compute\/cloud-vms$/, [{ _id: VM1, name: "a" }, { id: "x", _id: "y" }]],
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), { _id: VM1, name: "a" }],
  ]);
  const page = await client.cloudVms.list({ workspaceId: WS, limit: 5 });
  assert.equal(page[0].id, VM1);
  assert.equal(page[1].id, "x");
  const all = await client.cloudVms.listAll({ workspaceId: WS, pageSize: 50 });
  assert.equal(all.length, 2);
  assert.equal(calls[1].query.get("limit"), "50");
  assert.equal((await client.cloudVms.get({ workspaceId: WS, vmId: VM1 })).id, VM1);
  assert.deepEqual(normalizeVmRecord({ _id: 5 }), { _id: 5, id: "5" });
  await assert.rejects(client.cloudVms.listAll({ workspaceId: WS, pageSize: 101 }), isValidation("invalid_limit"));
});

// ---------------------------------------------------------------- delete

test("delete asks for the public IP choice like the portal (default release)", async () => {
  let vm = { _id: VM1, name: "web", status: "running", public_ip: "203.0.113.5", site_id: "site-1" };
  const { calls, client } = router([
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), () => vm],
    ["DELETE", new RegExp(`^/compute/cloud-vms/${VM1}$`), ACCEPTED],
    ["POST", /^\/billing\/resource-eligibility$/, (c) => ({ organization_id: "o", allowed: true, reason: "ok", sku_code: c.body.sku_code })],
  ]);
  await client.cloudVms.delete({ workspaceId: WS, vmId: VM1 });
  assert.deepEqual(calls.at(-1).body, { public_ip_action: "release" });
  await assert.rejects(client.cloudVms.delete({ workspaceId: WS, vmId: VM1, publicIpAction: "reserve" }), isValidation("invalid_reserved_ip_billing_catalog"));
  await client.cloudVms.delete({
    workspaceId: WS, vmId: VM1, publicIpAction: "reserve", preflightBilling: true,
    reservedIpBillingCatalog: { sku_id: 9, sku_code: "rip-std" },
  });
  assert.deepEqual(calls.at(-1).body, {
    public_ip_action: "reserve",
    reserved_ip_label: "web",
    reserved_ip_billing_catalog: { sku_id: 9, sku_code: "RIP-STD" },
  });
  assert.ok(calls.some((c) => c.path === "/billing/resource-eligibility"));
  vm = { ...vm, reserved_public_ip_id: "rip-1" };
  await client.cloudVms.delete({ workspaceId: WS, vmId: VM1 });
  assert.equal(calls.at(-1).body, undefined);
  await assert.rejects(
    client.cloudVms.delete({ workspaceId: WS, vmId: VM1, publicIpAction: "reserve", reservedIpBillingCatalog: { sku_id: 9, sku_code: "R" } }),
    isValidation("invalid_public_ip_action"),
  );
  vm = { ...vm, status: "deleting" };
  await assert.rejects(client.cloudVms.delete({ workspaceId: WS, vmId: VM1 }), isValidation("vm_state_conflict"));
  assert.deepEqual(
    resolveDeletePublicIpAction({ public_ip: " " }, {}),
    undefined,
  );
});

// ------------------------------------------------------ power and access

test("checkState applies the portal state matrix", async () => {
  const { calls, client } = router([
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), { _id: VM1, status: "running", os_type: "linux" }],
    ["POST", /\/actions\//, ACCEPTED],
  ]);
  await assert.rejects(client.cloudVms.start({ workspaceId: WS, vmId: VM1, checkState: true }), isValidation("vm_state_conflict"));
  await client.cloudVms.stop({ workspaceId: WS, vmId: VM1, checkState: true });
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("updateAccess applies the API and portal access rules", async () => {
  let vm = { _id: VM1, status: "running", os_type: "linux", admin_username: "ubuntu", ssh_keys: [SSH], ssh_password_auth_enabled: false };
  const { calls, client } = router([
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), () => vm],
    ["PATCH", /\/actions\/access$/, ACCEPTED],
  ]);
  const call = (request, extra = {}) => client.cloudVms.updateAccess({ workspaceId: WS, vmId: VM1, request, ...extra });
  await assert.rejects(call({}), isValidation("invalid_access_update"));
  await assert.rejects(call({ ssh_key_mode: "add" }), isValidation("invalid_access_update"));
  await assert.rejects(call({ ssh_keys: [SSH] }), isValidation("invalid_access_update"));
  await assert.rejects(call({ new_password: " short " }), isValidation("invalid_password"));
  await assert.rejects(call({ new_password: "long enough\npassword" }), isValidation("invalid_password"));
  await assert.rejects(call({ ssh_key_mode: "add", ssh_keys: ["not-a-key"] }), isValidation("invalid_ssh_key"));
  assert.equal(calls.length, 0);
  await assert.rejects(call({ ssh_key_mode: "remove", ssh_keys: [SSH] }, { checkState: true }), isValidation("invalid_access_update"));
  await call({ ssh_key_mode: "remove", ssh_keys: [SSH], confirm_remove_last_ssh_key: true }, { checkState: true });
  await call({ new_password: "  s3cret-pass  " }, { checkState: true });
  assert.deepEqual(calls.at(-1).body, { new_password: "s3cret-pass", admin_username: "ubuntu" });
  vm = { ...vm, ssh_keys: [] };
  await assert.rejects(call({ password_auth_enabled: false }, { checkState: true }), isValidation("invalid_access_update"));
  vm = { ...vm, os_type: "windows" };
  await assert.rejects(call({ new_password: "long-enough" }, { checkState: true }), isValidation("vm_os_unsupported"));
  vm = { ...vm, os_type: "linux", status: "stopped" };
  await assert.rejects(call({ new_password: "long-enough" }, { checkState: true }), isValidation("vm_state_conflict"));
});

// ---------------------------------------------------------------- resize

test("resize to a plan: SKU for the term, Windows licence carried over, precheck gate", async () => {
  let decision = "in_place";
  const vm = {
    _id: VM1, status: "running", os_type: "windows", site_id: "site-1", cpu: 2, ram_mb: 4096, disk_gb: 50,
    billing_catalog: { sku_id: 1, sku_code: "OLD", attached_skus: { windows_license: { sku_id: 55, sku_code: "WIN-LIC", quantity: 2 } } },
  };
  const { calls, client } = router([
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), vm],
    ...catalogRoutes([{ ...PLAN, plan_id: "plan-4", cpu: 4, ram_mb: 16384, disk_gb: 80 }]),
    ["POST", /\/actions\/resize\/precheck$/, () => ({ decision, reasons: ["disk shrink"], warnings: [] })],
    ["POST", /\/actions\/resize$/, ACCEPTED],
  ]);
  await client.cloudVms.resize({ workspaceId: WS, vmId: VM1, request: { plan_id: "plan-4", billing_term: "MONTHLY" } });
  const precheck = calls.find((c) => c.path.endsWith("/resize/precheck"));
  assert.deepEqual(precheck.body, { cpu: 4, ram_mb: 16384, disk_gb: 80 });
  const body = calls.at(-1).body;
  assert.equal(body.cpu, 4);
  assert.equal(body.billing_catalog.billing_interval, "MONTHLY");
  assert.equal(body.billing_catalog.attached_skus.windows_license.sku_code, "WIN-LIC");
  decision = "migration_required";
  await assert.rejects(client.cloudVms.resize({ workspaceId: WS, vmId: VM1, request: { disk_gb: 20 } }), (err) => {
    assert.ok(err instanceof IbeeValidationError);
    assert.equal(err.code, "resize_not_in_place");
    assert.equal(err.details.decision, "migration_required");
    assert.match(err.message, /requires migration/);
    return true;
  });
  await assert.rejects(client.cloudVms.resize({ workspaceId: WS, vmId: VM1, request: { plan_id: "plan-4", cpu: 4 } }), isValidation("invalid_resize_target"));
  await assert.rejects(client.cloudVms.resize({ workspaceId: WS, vmId: VM1, request: {} }), isValidation("invalid_resize_target"));
  await assert.rejects(client.cloudVms.precheckResize({ workspaceId: WS, vmId: VM1, request: { cpu: 300 } }), isValidation("invalid_resize_target"));
  await assert.rejects(client.cloudVms.resize({ workspaceId: WS, vmId: VM1, request: { cpu: 2, billing_term: "MONTHLY" } }), isValidation("invalid_resize_target"));
});

test("resizePlan rejects no-op and unconfirmed downgrades; resizeRootDisk is grow-only", async () => {
  const { calls, client } = router([
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), { _id: VM1, status: "stopped", cpu: 4, ram_mb: 8192, disk_gb: 80 }],
    ["PATCH", /\/actions\/resize-(plan|root-disk)$/, ACCEPTED],
  ]);
  const plan = (request) => client.cloudVms.resizePlan({ workspaceId: WS, vmId: VM1, request });
  await assert.rejects(plan({ cpu: 4, ram_mb: 8192 }), isValidation("no_changes"));
  await assert.rejects(plan({ cpu: 2, ram_mb: 8192 }), isValidation("downgrade_not_confirmed"));
  await assert.rejects(plan({ cpu: 2, ram_mb: 256 }), isValidation("invalid_resize_target"));
  await plan({ cpu: 2, ram_mb: 8192, confirm_downgrade: true });
  await plan({ cpu: 8, ram_mb: 16384 });
  const disk = (n) => client.cloudVms.resizeRootDisk({ workspaceId: WS, vmId: VM1, request: { new_size_gb: n } });
  await assert.rejects(disk(80), isValidation("invalid_resize_target"));
  await assert.rejects(disk(40), isValidation("invalid_resize_target"));
  await assert.rejects(disk(10001), isValidation("invalid_resize_target"));
  await disk(120);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 3);
});

test("409 with a precheck decision becomes ResizeBlockedError", () => {
  const err = apiErrorFromResponse(409, { detail: { decision: "blocked", reasons: ["busy"], message: "blocked" } });
  assert.ok(err instanceof ResizeBlockedError);
  assert.ok(err instanceof ConflictError);
  assert.equal(err.decision, "blocked");
  assert.deepEqual(err.reasons, ["busy"]);
});

test("metrics, events, operation and console inputs are validated", async () => {
  const { calls, client } = router([]);
  await assert.rejects(client.cloudVms.getMetricsTimeseries({ workspaceId: WS, vmId: VM1, range: "2h" }), isValidation("invalid_range"));
  await assert.rejects(client.cloudVms.getBandwidth({ workspaceId: WS, vmId: VM1, month: "2026-13" }), isValidation("invalid_month"));
  await assert.rejects(client.cloudVms.listEvents({ workspaceId: WS, vmId: VM1, limit: 501 }), isValidation("invalid_limit"));
  await assert.rejects(client.operations.get({ workspaceId: WS, operationId: "op-1" }), isValidation("invalid_operation_id"));
  await assert.rejects(client.vmConsole.createSession({ workspaceId: WS, vmId: "vm/1" }), isValidation("invalid_vm_id"));
  assert.equal(calls.length, 0);
  const b = router([["GET", /metrics\/bandwidth$/, {}]]);
  await b.client.cloudVms.getBandwidth({ workspaceId: WS, vmId: VM1 });
  assert.match(b.calls[0].query.get("month"), /^\d{4}-\d{2}$/);
});

// ------------------------------------------------------------- volumes

test("attachVolume resolves the Block Storage SKU and checks the volume like the portal", async () => {
  let volume = {
    id: "64b0000000000000000000b1", name: "data", site_id: "site-1", site_name: "Chennai", state: "ready", attachments: [],
    metadata: { billing_catalog: { sku_id: 3, sku_code: "blk-std", product_code: "block_storage" } },
  };
  let vmSite = "site-1";
  const { calls, client } = router([
    ["GET", /^\/block-storage\/volumes\/64b0000000000000000000b1$/, () => volume],
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), () => ({ _id: VM1, site_id: vmSite, status: "running" })],
    ["POST", /\/actions\/attach-volume$/, ACCEPTED],
    ["GET", /^\/compute\/operations\//, { ...ACCEPTED, status: "succeeded", action: "attach_volume", updated_at: "x" }],
  ]);
  const attach = (extra = {}) => client.cloudVms.attachVolume({ workspaceId: WS, vmId: VM1, request: { volume_id: "64b0000000000000000000b1" }, ...extra });
  const res = await attach({ wait: true });
  assert.equal(res.operation.status, "succeeded");
  const post = calls.find((c) => c.path.endsWith("/attach-volume"));
  assert.deepEqual(post.body, {
    volume_id: "64b0000000000000000000b1",
    mode: "single-writer",
    billing_catalog: { sku_id: 3, sku_code: "BLK-STD", product_code: "block_storage" },
  });
  vmSite = "site-2";
  await assert.rejects(attach(), (err) => err.code === "site_mismatch" && /Chennai/.test(err.message));
  vmSite = "site-1";
  volume = { ...volume, attachments: [{ vm_id: "x" }] };
  await assert.rejects(attach(), isValidation("volume_attached"));
  volume = { ...volume, attachments: [], state: "resizing" };
  await assert.rejects(attach(), isValidation("volume_busy"));
  volume = { ...volume, state: "ready", metadata: {} };
  await assert.rejects(attach(), isValidation("invalid_billing_catalog"));
  await assert.rejects(
    client.cloudVms.attachVolume({ workspaceId: WS, vmId: VM1, request: { volume_id: "64b0000000000000000000b1", mode: "rw" } }),
    isValidation("invalid_attach"),
  );
});

test("detachVolume requires confirm_unmounted or force", async () => {
  const { calls, client } = router([["POST", /\/actions\/detach-volume$/, ACCEPTED]]);
  await assert.rejects(
    client.cloudVms.detachVolume({ workspaceId: WS, vmId: VM1, request: { volume_id: "64b0000000000000000000b1" } }),
    isValidation("detach_not_confirmed"),
  );
  await client.cloudVms.detachVolume({ workspaceId: WS, vmId: VM1, request: { volume_id: "64b0000000000000000000b1", force: true } });
  assert.equal(calls.length, 1);
});

// ------------------------------------------------------------ snapshots

const SNAP_SKU = { sku_id: 21, sku_code: "SNAPSHOT-STD", product_code: "snapshot_storage" };
const BACKUP_SKU = { sku_id: 31, sku_code: "BACKUP-STD", product_code: "backup_storage" };

test("createSnapshot requires the snapshot SKU and the portal mode rules", async () => {
  const { calls, client } = router([]);
  const snap = (request) => client.cloudVms.createSnapshot({ workspaceId: WS, vmId: VM1, request });
  await assert.rejects(snap({ name: "s" }), isValidation("billing_catalog_required"));
  await assert.rejects(snap({ name: "s", billing_catalog: BACKUP_SKU }), isValidation("invalid_billing_catalog"));
  await assert.rejects(snap({ name: "s", billing_catalog: { sku_id: 1, sku_code: "ROOTDISK-50" } }), isValidation("invalid_billing_catalog"));
  await assert.rejects(snap({ name: " ", billing_catalog: SNAP_SKU }), isValidation("invalid_snapshot_name"));
  await assert.rejects(snap({ name: "s", mode: "selective", billing_catalog: SNAP_SKU }), isValidation("invalid_snapshot_volumes"));
  await assert.rejects(snap({ name: "s", mode: "root_only", selected_data_volume_ids: ["v"], billing_catalog: SNAP_SKU }), isValidation("invalid_snapshot_volumes"));
  assert.equal(calls.length, 0);
});

test("createSnapshot with wait polls until the snapshot is readable", async () => {
  let gets = 0;
  let listStatus = "running";
  const { calls, client } = router([
    ["POST", /\/snapshots$/, { snapshot_set_id: "ss-1", status: "queued" }],
    ["GET", /\/cloud-vm-snapshots\/ss-1$/, () => (++gets < 2 ? { status: 404, json: { detail: "Snapshot set not found" } } : { snapshot_set_id: "ss-1", status: "succeeded" })],
    ["GET", /\/cloud-vm-snapshots\/ss-2$/, { status: 404, json: { detail: "Snapshot set not found" } }],
    ["GET", /\/cloud-vms\/[^/]+\/snapshots$/, () => ({ snapshots: [{ snapshot_set_id: "ss-1", status: "running" }, { snapshot_set_id: "ss-2", status: listStatus, error_message: "disk busy" }], total: 2 })],
  ]);
  const res = await client.cloudVms.createSnapshot({
    workspaceId: WS, vmId: VM1, request: { name: "s", billing_catalog: SNAP_SKU }, wait: { pollIntervalMs: 1000, timeoutMs: 10_000 },
  });
  assert.equal(res.status, "succeeded");
  assert.equal(gets, 2);
  // While GET is 404 the status comes from the VM's snapshot list.
  assert.ok(calls.some((c) => c.method === "GET" && /\/snapshots$/.test(c.path) && c.query.get("limit") === "200"));
  // A failed snapshot fails the wait instead of polling until the timeout.
  listStatus = "failed";
  await assert.rejects(
    client.cloudVms.waitForSnapshot({ workspaceId: WS, vmId: VM1, snapshotSetId: "ss-2", pollIntervalMs: 1000, timeoutMs: 10_000 }),
    (err) => err instanceof RecoveryFailedError && err.kind === "snapshot" && err.errorMessage === "disk busy",
  );
  // `available` counts as ready.
  listStatus = "available";
  const ready = await client.cloudVms.waitForSnapshot({ workspaceId: WS, vmId: VM1, snapshotSetId: "ss-2", pollIntervalMs: 1000 });
  assert.equal(ready.status, "available");
});

test("deleteSnapshot with checkState refuses a running or restoring snapshot", async () => {
  let status = "restoring";
  const { calls, client } = router([
    ["GET", /\/cloud-vm-snapshots\/ss-1$/, () => ({ snapshot_set_id: "ss-1", status })],
    ["DELETE", /\/cloud-vm-snapshots\/ss-1$/, { status: "deleted" }],
  ]);
  const del = () => client.cloudVms.deleteSnapshot({ workspaceId: WS, snapshotSetId: "ss-1", checkState: true });
  await assert.rejects(del(), isValidation("snapshot_busy"));
  status = "running";
  await assert.rejects(del(), isValidation("snapshot_busy"));
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  status = "succeeded";
  await del();
  assert.equal(calls.at(-1).method, "DELETE");
  await assert.rejects(client.cloudVms.deleteSnapshot({ workspaceId: WS, snapshotSetId: ".." }), isValidation("invalid_snapshot_set_id"));
});

const MANIFEST = [
  { source_volume_id: "root-1", role: "root", size_gb: 51 },
  { source_volume_id: "data-1", role: "data", source_volume_name: "logs", size_gb: 20 },
];

test("restoreSnapshot new_vm resolves the plan, default names and minimum disk", async () => {
  const plans = [
    PLAN,
    { ...PLAN, plan_id: "tiny", disk_gb: 40 },
    { ...PLAN, plan_id: "unpriced", pricing_status: "unpriced" },
    { ...PLAN, plan_id: "hidden", selectable: false },
  ];
  const { calls, client } = router([
    ["GET", /\/cloud-vm-snapshots\/ss-1$/, { snapshot_set_id: "ss-1", status: "succeeded", created_at: "2026-09-01T10:00:00Z", volume_manifest: MANIFEST }],
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), { _id: VM1, name: "web", status: "running", plan_id: "plan-1", site_id: "site-1", data_volumes: [{ volume_id: "data-1" }] }],
    ["GET", /^\/networking\/vpcs\/vpc-1$/, { vpc_id: "vpc-1", site_id: "site-1", status: "available", connectivity_type: "private" }],
    ["GET", /^\/networking\/vpcs\/vpc-nat$/, { vpc_id: "vpc-nat", site_id: "site-1", status: "available", connectivity_type: "nat_gateway" }],
    ["GET", /^\/networking\/vpcs\/[^/]+\/subnets\/sub-1$/, (c) => ({ subnet_id: "sub-1", vpc_id: c.path.split("/")[3] })],
    ...catalogRoutes(plans),
    ["POST", /\/actions\/restore$/, { restore_id: "r1", status: "queued" }],
    ["GET", /\/cloud-vm-snapshots\/restores\/r1$/, { restore_id: "r1", status: "failed", error_message: "no capacity" }],
  ]);
  const restore = (request, extra = {}) => client.cloudVms.restoreSnapshot({ workspaceId: WS, vmId: VM1, snapshotSetId: "ss-1", request, ...extra });
  await restore({ target_mode: "new_vm", vpc_id: "vpc-1", subnet_id: "sub-1" });
  const body = calls.at(-1).body;
  assert.equal(body.target_vm_name, "web-snapshot-restored-20260901");
  assert.deepEqual(body.target_volume_names, { "data-1": "logs-snapshot-restored-20260901" });
  assert.equal(body.target_plan_id, "plan-1");
  assert.equal(body.target_cpu, 2);
  assert.equal(body.target_disk_gb, 50);
  assert.equal(body.target_plan_hourly_rate, 5);
  assert.equal(body.target_billing_catalog.sku_code, "STANDARD-2-8-50");
  assert.equal(body.network_connectivity, "private");
  assert.equal(body.auto_start, true);
  await assert.rejects(restore({ target_mode: "new_vm", target_plan_id: "tiny" }), isValidation("restore_disk_too_small"));
  // Restore plans must be selectable; pricing is not required (Python/portal rule).
  const planBefore = calls.length;
  await assert.rejects(restore({ target_mode: "new_vm", target_plan_id: "hidden" }), isValidation("invalid_restore_plan"));
  await assert.rejects(restore({ target_mode: "new_vm", target_plan_id: "nope" }), isValidation("invalid_restore_plan"));
  assert.equal(calls.slice(planBefore).some((c) => c.method === "POST"), false);
  await restore({ target_mode: "new_vm", target_plan_id: "unpriced" });
  assert.equal(calls.at(-1).body.target_plan_id, "unpriced");
  // Shared NAT-mode VPC rule, checked before the POST.
  const natBefore = calls.length;
  await assert.rejects(
    restore({ target_mode: "new_vm", vpc_id: "vpc-1", subnet_id: "sub-1", network_connectivity: "nat" }),
    isValidation("invalid_network"),
  );
  await assert.rejects(
    restore({ target_mode: "new_vm", vpc_id: "vpc-nat", subnet_id: "sub-1", network_connectivity: "public_ip" }),
    isValidation("invalid_network"),
  );
  assert.equal(calls.slice(natBefore).some((c) => c.method === "POST"), false);
  // A dedicated public IP on a private VPC needs no Reserved IP for a restore.
  await restore({ target_mode: "new_vm", vpc_id: "vpc-1", subnet_id: "sub-1", network_connectivity: "public_ip" });
  assert.equal(calls.at(-1).body.network_connectivity, "public_ip");
  await assert.rejects(restore({ target_mode: "new_vm", target_volume_names: { nope: "x" } }), isValidation("invalid_target_volume_names"));
  await assert.rejects(restore({ target_mode: "volume_only" }), isValidation("invalid_restore"));
  await assert.rejects(restore({ target_vm_name: "x" }), isValidation("invalid_restore"));
  await assert.rejects(restore({ target_mode: "new_vm", network_connectivity: "nat" }), isValidation("invalid_network"));
  await restore({ target_mode: "volume_only", selected_volume_id: "data-1" });
  assert.deepEqual(calls.at(-1).body, { target_mode: "volume_only", selected_volume_id: "data-1", auto_start: true });
  await assert.rejects(restore({ target_mode: "replace" }, { wait: { pollIntervalMs: 1000 } }), (err) => {
    assert.ok(err instanceof RecoveryRestoreFailedError);
    assert.ok(err instanceof RecoveryFailedError);
    assert.equal(err.errorMessage, "no capacity");
    return true;
  });
});

test("restoreBackup needs a succeeded recovery point and rejects snapshot-only fields", async () => {
  let status = "running";
  const { calls, client } = router([
    ["GET", /\/cloud-vm-backups\/runs\/rp-1$/, () => ({ run_id: "rp-1", recovery_point_id: "rp-1", status, volume_manifest: MANIFEST, created_at: "2026-09-02T00:00:00Z" })],
    ["GET", /\/cloud-vm-backups\/runs\/run-1$/, { run_id: "run-1", recovery_point_id: "rp-9", status: "succeeded" }],
    ["GET", /\/cloud-vm-backups\/runs\/run-2$/, { run_id: "run-2", status: "succeeded" }],
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), { _id: VM1, name: "db", plan_id: "plan-1", site_id: "site-1" }],
    ...catalogRoutes(),
    ["POST", /\/backups\/actions\/restore$/, { restore_id: "r2", status: "queued" }],
  ]);
  const restore = (request) => client.cloudVms.restoreBackup({ workspaceId: WS, vmId: VM1, request: { recovery_point_id: "rp-1", ...request } });
  await assert.rejects(restore({}), isValidation("recovery_point_not_ready"));
  status = "succeeded";
  await assert.rejects(restore({ target_mode: "new_vm", vpc_id: "v" }), isValidation("invalid_restore"));
  await restore({ target_mode: "new_vm", auto_start: true });
  const body = calls.at(-1).body;
  assert.equal(body.target_vm_name, "db-backup-restored-20260902");
  assert.deepEqual(body.target_volume_names, { "data-1": "logs-backup-restored-20260902" });
  assert.equal("auto_start" in body, false);
  await assert.rejects(client.cloudVms.restoreBackup({ workspaceId: WS, vmId: VM1, request: {} }), isValidation("invalid_recovery_point_id"));
  // A run ID resolves to the run's recovery point ID for the restore body.
  await client.cloudVms.restoreBackup({ workspaceId: WS, vmId: VM1, request: { recovery_point_id: "run-1" } });
  assert.deepEqual(calls.at(-1).body, { recovery_point_id: "rp-9", target_mode: "replace" });
  const before = calls.length;
  await assert.rejects(
    client.cloudVms.restoreBackup({ workspaceId: WS, vmId: VM1, request: { recovery_point_id: "run-2" } }),
    isValidation("recovery_point_not_ready"),
  );
  assert.equal(calls.slice(before).some((c) => c.method === "POST"), false);
});

// --------------------------------------------------------------- backups

test("enableBackups: SKU required, portal defaults, re-enable reuses saved values, schedule rules", async () => {
  let policy = null;
  const { calls, client } = router([
    ["GET", /\/backups\/policy$/, () => (policy ? policy : { status: 404, json: { detail: "Backup policy not found" } })],
    ["POST", /\/backups\/enable$/, (c) => ({ ...c.body, enabled: true })],
  ]);
  const enable = (request) => client.cloudVms.enableBackups({ workspaceId: WS, vmId: VM1, request });
  await assert.rejects(enable({}), isValidation("billing_catalog_required"));
  await assert.rejects(enable({ billing_catalog: SNAP_SKU }), isValidation("invalid_billing_catalog"));
  await assert.rejects(enable({ billing_catalog: BACKUP_SKU, schedule: { frequency: "hourly" } }), isValidation("invalid_schedule"));
  await assert.rejects(enable({ billing_catalog: BACKUP_SKU, schedule: { frequency: "weekly" } }), isValidation("invalid_schedule"));
  await assert.rejects(enable({ billing_catalog: BACKUP_SKU, schedule: { timezone: "Mars/Olympus" } }), isValidation("invalid_schedule"));
  await assert.rejects(enable({ billing_catalog: BACKUP_SKU, retention_days: 400 }), isValidation("invalid_retention_days"));
  await enable({ billing_catalog: BACKUP_SKU });
  assert.deepEqual(calls.at(-1).body, {
    billing_catalog: BACKUP_SKU,
    schedule: { frequency: "daily", hour: 12, minute: 0, timezone: "UTC", window_minutes: 30 },
    retention_days: 7,
    full_backup_interval_days: 7,
    incremental_enabled: true,
  });
  policy = {
    policy_id: "p1", enabled: false, retention_days: 30, full_backup_interval_days: 14, incremental_enabled: false,
    schedule: { frequency: "weekly", day_of_week: 6, hour: 3, minute: 0, timezone: "Asia/Kolkata", window_minutes: 60 },
  };
  await enable({ billing_catalog: BACKUP_SKU });
  assert.deepEqual(calls.at(-1).body.schedule, policy.schedule);
  assert.equal(calls.at(-1).body.retention_days, 30);
});

test("updateBackupPolicy merges the schedule into the saved one and refuses disabled policies", async () => {
  let policy = { policy_id: "p1", enabled: true, schedule: { frequency: "weekly", day_of_week: 2, hour: 5, minute: 0, timezone: "UTC", window_minutes: 30 } };
  const { calls, client } = router([
    ["GET", /\/backups\/policy$/, () => policy],
    ["PATCH", /\/backups\/policy$/, (c) => c.body],
  ]);
  const update = (request) => client.cloudVms.updateBackupPolicy({ workspaceId: WS, vmId: VM1, request });
  await assert.rejects(update({}), isValidation("no_changes"));
  await update({ schedule: { hour: 9 } });
  assert.deepEqual(calls.at(-1).body.schedule, { frequency: "weekly", hour: 9, minute: 0, timezone: "UTC", window_minutes: 30, day_of_week: 2 });
  await update({ schedule: { frequency: "daily" } });
  assert.equal("day_of_week" in calls.at(-1).body.schedule, false);
  policy = { ...policy, enabled: false };
  await assert.rejects(update({ retention_days: 3 }), isValidation("backups_disabled"));
});

test("rescheduleBackup requires a timezone-aware timestamp", async () => {
  const { calls, client } = router([["PATCH", /next-run-at$/, {}]]);
  const r = (next_run_at) => client.cloudVms.rescheduleBackup({ workspaceId: WS, vmId: VM1, request: { next_run_at } });
  await assert.rejects(r("2026-10-01T10:00:00"), isValidation("invalid_next_run_at"));
  await r("2026-10-01T10:00:00+05:30");
  await r(new Date("2026-10-01T10:00:00Z"));
  assert.equal(calls.at(-1).body.next_run_at, "2026-10-01T10:00:00.000Z");
});

test("createBackupRun sends the SKU and trimmed reason; wait raises on failure", async () => {
  const { calls, client } = router([
    ["GET", /\/backups\/policy$/, { policy_id: "p1", enabled: false }],
    ["POST", /\/backups\/runs$/, { run_id: "run-1", status: "queued" }],
    ["GET", /\/cloud-vm-backups\/runs\/run-1$/, { run_id: "run-1", status: "failed", error_message: "disk busy" }],
  ]);
  const run = (request, extra = {}) => client.cloudVms.createBackupRun({ workspaceId: WS, vmId: VM1, request, ...extra });
  await assert.rejects(run({ reason: "x" }), isValidation("billing_catalog_required"));
  await assert.rejects(run({ billing_catalog: BACKUP_SKU }, { checkState: true }), isValidation("backups_disabled"));
  await assert.rejects(run({ billing_catalog: BACKUP_SKU, reason: " nightly " }, { wait: { pollIntervalMs: 1000 } }), (err) => {
    assert.ok(err instanceof RecoveryFailedError);
    assert.equal(err.kind, "backup_run");
    assert.equal(err.errorMessage, "disk busy");
    return true;
  });
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(post.body, { billing_catalog: BACKUP_SKU, reason: "nightly" });
});

test("listAllBackupRuns and deleteBackupRun use the workspace backup paths", async () => {
  const { calls, client } = router([
    ["GET", /^\/compute\/(cloud|gpu)-vm-backups\/runs$/, { runs: [], total: 0 }],
    ["GET", /^\/compute\/cloud-vm-backups\/runs\/run-1$/, { run_id: "run-1", status: "running" }],
    ["DELETE", /^\/compute\/(cloud|gpu)-vm-backups\/runs\/[^/]+$/, { status: "deleted" }],
    ["GET", /\/backups\/runs$/, { runs: [{ status: "succeeded" }, { status: "failed" }], total: 2 }],
  ]);
  await client.cloudVms.listAllBackupRuns({ workspaceId: WS, status: ["succeeded", "failed"], limit: 20, search: " db " });
  assert.equal(calls[0].path, "/compute/cloud-vm-backups/runs");
  assert.deepEqual(calls[0].query.getAll("status"), ["succeeded", "failed"]);
  assert.equal(calls[0].query.get("vm_type"), "cloud");
  assert.equal(calls[0].query.get("search"), "db");
  await client.gpuVms.listAllBackupRuns({ workspaceId: WS });
  assert.equal(calls[1].path, "/compute/gpu-vm-backups/runs");
  assert.deepEqual(calls[1].query.getAll("status"), ["succeeded"]);
  assert.equal(calls[1].query.get("vm_type"), null);
  await assert.rejects(client.cloudVms.listAllBackupRuns({ workspaceId: WS, status: "done" }), isValidation("invalid_status"));
  await assert.rejects(client.cloudVms.listAllBackupRuns({ workspaceId: WS, limit: 201 }), isValidation("invalid_limit"));
  await assert.rejects(client.cloudVms.deleteBackupRun({ workspaceId: WS, runId: "run-1", checkState: true }), isValidation("backup_not_completed"));
  for (const runId of ["..", "."]) {
    const before = calls.length;
    await assert.rejects(client.gpuVms.deleteBackupRun({ workspaceId: WS, runId }), isValidation("invalid_run_id"));
    await assert.rejects(client.gpuVms.getBackupRestore({ workspaceId: WS, restoreId: runId }), isValidation("invalid_restore_id"));
    assert.equal(calls.length, before);
  }
  await client.gpuVms.deleteBackupRun({ workspaceId: WS, runId: "run/2" });
  assert.equal(calls.at(-1).method, "DELETE");
  assert.equal(calls.at(-1).path, "/compute/gpu-vm-backups/runs/run%2F2");
  const list = await client.cloudVms.listBackupRuns({ workspaceId: WS, vmId: VM1, restorableOnly: true });
  assert.equal(list.runs.length, 1);
  await assert.rejects(client.cloudVms.listSnapshots({ workspaceId: WS, vmId: VM1, limit: 201 }), isValidation("invalid_limit"));
});

// --------------------------------------------------------------- helpers

test("billing catalog helpers port the portal rules", () => {
  const option = selectBillingOption(PLAN_CATALOG);
  assert.equal(option.billing_interval, "HOURLY");
  assert.equal(selectBillingOption({ billing_options: [{ billing_interval: "MONTHLY", unit_price_minor: 1 }] }).billing_interval, "MONTHLY");
  const priced = billingCatalogForTerm({ sku_id: 1, sku_code: "A" }, {
    billing_interval: "YEARLY", committed: true, commitment_period: "YEARLY", commitment_months: 12, unit_price_minor: 9, price_unit: "YEAR",
  });
  assert.deepEqual(priced, {
    sku_id: 1, sku_code: "A", billing_interval: "YEARLY", committed: true, commitment_period: "YEARLY",
    commitment_months: 12, price_unit: "YEAR", unit_price_minor: 9,
  });
  assert.throws(() => validateBillingCatalog({ sku_id: 1, sku_code: "X", attached_skus: { "Root-Disk": { sku_id: 2, sku_code: "Y" } } }), IbeeValidationError);
  assert.throws(() => validateBillingCatalog({ sku_code: "X" }), /sku_id/);
  assert.throws(() => validateBillingCatalog({ sku_id: " ", sku_code: "X" }), /sku_id/);
  assert.equal(validateBillingCatalog({ skuId: 4, skuCode: " abc " }).sku_code, "ABC");
  const built = buildVmCreateBillingCatalog({ catalog: PLAN_CATALOG, cpu: 2, osType: "linux", reservedIpBillingCatalog: { sku_id: 9, sku_code: "rip" } });
  assert.equal(built.catalog.attached_skus.reserved_ip.sku_code, "RIP");
  assert.throws(() => buildVmCreateBillingCatalog({ catalog: PLAN_CATALOG, cpu: 2, osType: "windows" }), /Windows licence/);
});

test("naming, SSH, batch and schedule helpers", () => {
  assert.deepEqual(expandBatchNames("web", 3), ["web-1", "web-2", "web-3"]);
  assert.deepEqual(expandBatchNames("web"), ["web"]);
  assert.throws(() => expandBatchNames("web", 6), IbeeValidationError);
  assert.throws(() => expandBatchNames("web", 2, ["a", "A"]), /unique/);
  assert.equal(validateSshPublicKey(` ${SSH} `), SSH);
  assert.throws(() => validateSshPublicKey("ssh-ed25519 not*base64"), IbeeValidationError);
  assert.equal(recoveryMinRootDiskGb([{ role: "root", size_gb: 51 }]), 50);
  assert.equal(recoveryMinRootDiskGb([{ role: "root", display_size_gb: 80, size_gb: 81 }]), 80);
  assert.equal(recoveryDefaultVmName("", "backup", "2026-01-05T23:00:00Z"), "vm-backup-restored-20260105");
  assert.deepEqual(recoveryTargetVolumeNames([{ source_volume_id: "r" }, { source_volume_id: "d", resource_name: "pvc-1" }], "snapshot", "2026-01-05T00:00:00Z"), {
    d: "pvc-1-snapshot-restored-20260105",
  });
  assert.deepEqual(validateBackupSchedule({ frequency: "weekly", day_of_week: 0 }), {
    frequency: "weekly", hour: 12, minute: 0, timezone: "UTC", window_minutes: 30, day_of_week: 0,
  });
  assert.throws(() => validateBackupSchedule({ frequency: "daily", day_of_week: 1 }), IbeeValidationError);
});
