// Regression tests for the 0.4.0 parity review findings.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BILLING_ADMISSION_CODES,
  BillingAdmissionError,
  BillingDeniedError,
  ConflictError,
  IbeeError,
  Ibee,
  IbeeValidationError,
  InsufficientScopeError,
  NotFoundError,
  ResourceNotFoundError,
  ScopeValidationError,
  SecretValueNotFoundError,
  UnprocessableEntityError,
  WorkspaceNotAllowedError,
  apiErrorFromResponse,
  billingBlockMessage,
  chunkBatchSecrets,
  createTypeForPath,
  isPaymentBlockError,
  validateOperationId,
  validatePathId,
} from "../dist/index.js";

const WS = "710995";
const VM1 = "64b0000000000000000000a1";
const VOL = "64b0000000000000000000b1";
const OP1 = "op_64b0000000000000000000f1";
const ACCEPTED = { operation_id: OP1, vm_id: VM1, status: "accepted", submitted_at: "2026-09-28T00:00:00Z" };
const SKU = { sku_id: 1, sku_code: "STANDARD-2-8-50" };

function router(routes, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const call = {
      url: String(url),
      path: u.pathname.replace(/^\/v1/, ""),
      query: u.searchParams,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    for (const [method, re, resp] of routes) {
      if (method === call.method && re.test(call.path)) {
        let r = typeof resp === "function" ? resp(call) : resp;
        if (!(r && typeof r === "object" && "status" in r && "json" in r)) r = { status: 200, json: r };
        if (r.status === 204) return new Response(null, { status: 204 });
        return new Response(JSON.stringify(r.json), {
          status: r.status,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
    }
    return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
  };
  return { calls, client: new Ibee({ token: "t", fetch: fetchImpl, maxRetries: 0, ...opts }) };
}

const isValidation = (code, pattern) => (err) => {
  assert.ok(err instanceof IbeeValidationError, `expected IbeeValidationError, got ${err?.name}: ${err?.message}`);
  if (code) assert.equal(err.code, code, err.message);
  if (pattern) assert.match(err.message, pattern);
  return true;
};

// ------------------------------------------------------------------ errors

test("a missing scope is never a payment block", () => {
  for (const [scope, path] of [
    ["billing.read", "/billing/resource-eligibility"],
    ["vm.write", "/compute/cloud-vms"],
    ["secret-store.write", "/secret-store/stores"],
  ]) {
    const err = apiErrorFromResponse(403, { error: "insufficient_scope", required_scope: scope }, { path });
    assert.ok(err instanceof InsufficientScopeError);
    assert.match(err.message, /insufficient_scope/);
    assert.equal(isPaymentBlockError(err), false, scope);
  }
  assert.equal(isPaymentBlockError({ code: "insufficient_scope", message: "insufficient" }), false);
  // Server messages still count.
  assert.equal(isPaymentBlockError(apiErrorFromResponse(403, { detail: "Insufficient balance for this plan" })), true);
  assert.equal(isPaymentBlockError(new Error("Please top up your wallet")), true);
});

test("billing admission failures are not retryable and not retried", async () => {
  assert.ok(BILLING_ADMISSION_CODES.has("invalid_billing_decision"));
  const edge = apiErrorFromResponse(502, { error: "invalid_billing_decision" });
  assert.ok(edge instanceof BillingAdmissionError);
  assert.equal(edge.retryable, false);
  assert.equal(apiErrorFromResponse(502, { detail: "upstream" }).retryable, true);
  const { calls, client } = router(
    [["POST", /^\/block-storage\/volumes$/, { status: 502, json: { error: "invalid_billing_decision" } }]],
    { maxRetries: 2 },
  );
  await assert.rejects(
    client.blockStorage.createVolume({ workspaceId: WS, name: "data-1", size_gb: 20, site_id: "s1", resolveSiteName: false }),
    (err) => err instanceof BillingAdmissionError && err.retryable === false,
  );
  assert.equal(calls.length, 1);
  // The preflight's client-side decision error is not retryable either.
  const pre = router([["POST", /resource-eligibility$/, { allowed: true, organization_id: "o", reason: "ok", sku_code: "OTHER" }]]);
  await assert.rejects(
    pre.client.billing.requireResourceEligibility({ workspaceId: WS, skuCode: "NAT-GATEWAY" }),
    (err) => err instanceof BillingAdmissionError && err.code === "invalid_billing_decision" && err.retryable === false,
  );
});

test("a decision that does not confirm the SKU is invalid even when denied", async () => {
  const { client } = router([
    ["POST", /resource-eligibility$/, (c) => ({
      allowed: false, organization_id: "o", reason: "insufficient_balance",
      ...(c.body.sku_code === "MATCH" ? { sku_code: "match" } : {}),
    })],
  ]);
  await assert.rejects(
    client.billing.requireResourceEligibility({ workspaceId: WS, skuCode: "NAT-GATEWAY" }),
    (err) => err instanceof BillingAdmissionError && err.code === "invalid_billing_decision",
  );
  await assert.rejects(
    client.billing.requireResourceEligibility({ workspaceId: WS, skuCode: "MATCH" }),
    (err) => err instanceof BillingDeniedError,
  );
});

test("S3 credentials are labelled 'S3 credential' in billing messages", async () => {
  assert.equal(createTypeForPath("/object-storage/credentials"), "s3_credential");
  assert.equal(createTypeForPath("/v1/object-storage/buckets"), "object_storage");
  const err = apiErrorFromResponse(402, { error: "billing_denied", billing_reason: "insufficient_balance" }, { path: "/object-storage/credentials" });
  assert.match(err.message, /this S3 credential/);
  const { client } = router([
    ["POST", /resource-eligibility$/, (c) => ({ allowed: false, organization_id: "o", reason: "insufficient_balance", sku_code: c.body.sku_code })],
  ]);
  await assert.rejects(
    client.objectStorage.createS3Credential({ workspaceId: WS, preflightBilling: true }),
    (e) => e instanceof BillingDeniedError && /this S3 credential/.test(e.message) && e.resourceType === "s3_credential",
  );
});

test("billingBlockMessage normalises state and type case like the Python SDK", () => {
  assert.match(billingBlockMessage({ reason: "x", billing_state: "past_due" }, "VM"), /^Billing needs attention before creating a cloud VM/);
  assert.match(billingBlockMessage({ reason: "x", billing_state: " hard_suspended " }, " Gpu_Vm "), /new GPU VM creation is blocked/);
});

test("operation IDs accept either hex case (Python parity)", () => {
  assert.equal(validateOperationId("op_64B0000000000000000000F1"), "op_64B0000000000000000000F1");
  assert.throws(() => validateOperationId("op_64b0"), isValidation("invalid_operation_id"));
});

test("dot path segments are refused before any request", async () => {
  assert.throws(() => validatePathId("..", "run_id"), isValidation("invalid_run_id"));
  assert.equal(validatePathId(" run/1 ", "run_id"), "run/1");
  const { calls, client } = router([]);
  await assert.rejects(client.cloudVms.getSnapshotRestore({ workspaceId: WS, restoreId: ".." }), isValidation("invalid_restore_id"));
  await assert.rejects(async () => client.vpcs.getSubnet({ workspaceId: WS, vpcId: "v", subnetId: "." }), isValidation("invalid_subnet_id"));
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------------ compute

test("idempotencyKey: null is treated as omitted on VM writes", async () => {
  const { calls, client } = router([["POST", /\/actions\/start$/, ACCEPTED]]);
  await client.cloudVms.start({ workspaceId: WS, vmId: VM1, idempotencyKey: null });
  assert.match(calls[0].headers.get("x-idempotency-key"), new RegExp(`^cloud-vm-start-${VM1}-`));
});

test("a bad caller key fails before any request", async () => {
  const { calls, client } = router([]);
  await assert.rejects(
    client.cloudVms.create({ workspaceId: WS, idempotencyKey: "bad key", name: "web", site_id: "s1", plan_id: "p", template_id: "t" }),
    isValidation("invalid_idempotency_key"),
  );
  await assert.rejects(
    client.cloudVms.start({ workspaceId: WS, vmId: VM1, idempotencyKey: "", checkState: true }),
    isValidation("invalid_idempotency_key"),
  );
  await assert.rejects(
    client.cloudVms.resizeRootDisk({ workspaceId: WS, vmId: VM1, idempotencyKey: "x".repeat(200), request: { new_size_gb: 100 } }),
    isValidation("invalid_idempotency_key"),
  );
  assert.equal(calls.length, 0);
});

test("create in single-request mode requires disk_gb (and gpu_count for GPU)", async () => {
  const { calls, client } = router([["POST", /^\/compute\/(cloud|gpu)-vms$/, ACCEPTED]]);
  const base = {
    workspaceId: WS, name: "web", site_id: "s1", plan_id: "p", template_id: "t", os_type: "linux", os_distro: "ubuntu",
    cpu: 2, ram_mb: 4096, resolveCatalog: false, billing_catalog: SKU,
  };
  await assert.rejects(client.cloudVms.create(base), isValidation("invalid_disk_gb", /disk_gb/));
  await assert.rejects(client.gpuVms.create({ ...base, disk_gb: 100 }), isValidation("invalid_gpu_count", /gpu_count/));
  assert.equal(calls.length, 0);
  await client.cloudVms.create({ ...base, disk_gb: 50 });
  assert.equal(calls[0].body.disk_gb, 50);
});

test("delete without vm.read falls back to the portal default 'release'", async () => {
  let vmStatus = 403;
  const { calls, client } = router([
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), () =>
      vmStatus === 403 ? { status: 403, json: { error: "insufficient_scope", required_scope: "vm.read" } } : { _id: VM1, status: "running" }],
    ["DELETE", new RegExp(`^/compute/cloud-vms/${VM1}$`), ACCEPTED],
  ]);
  await client.cloudVms.delete({ workspaceId: WS, vmId: VM1 });
  assert.deepEqual(calls.at(-1).body, { public_ip_action: "release" });
  const before = calls.length;
  await assert.rejects(client.cloudVms.delete({ workspaceId: WS, vmId: VM1, checkState: true }), InsufficientScopeError);
  await assert.rejects(
    client.cloudVms.delete({ workspaceId: WS, vmId: VM1, publicIpAction: "reserve", reservedIpBillingCatalog: SKU }),
    InsufficientScopeError,
  );
  assert.equal(calls.slice(before).filter((c) => c.method === "DELETE").length, 0);
  vmStatus = 200;
  await client.cloudVms.delete({ workspaceId: WS, vmId: VM1 });
  assert.equal(calls.at(-1).body, undefined);
});

test("updateAccess reads the VM by default like the Python SDK", async () => {
  let vm = { _id: VM1, status: "stopped", os_type: "linux", admin_username: "ubuntu", ssh_keys: [] };
  const { calls, client } = router([
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), () => vm],
    ["PATCH", /\/actions\/access$/, ACCEPTED],
  ]);
  const update = (request, extra = {}) => client.cloudVms.updateAccess({ workspaceId: WS, vmId: VM1, request, ...extra });
  await assert.rejects(update({ new_password: "S3cure-pass!" }), isValidation("invalid_vm_state"));
  vm = { ...vm, status: "running" };
  await assert.rejects(update({ password_auth_enabled: false }), isValidation("ssh_key_required"));
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  await update({ new_password: "S3cure-pass!" });
  assert.equal(calls.at(-1).body.admin_username, "ubuntu");
  const before = calls.length;
  await update({ password_auth_enabled: false }, { checkState: false });
  assert.deepEqual(calls.slice(before).map((c) => c.method), ["PATCH"]);
});

const PLAN_CATALOG = {
  sku_id: 101, sku_code: "standard-4-16-80",
  billing_options: [
    { billing_interval: "HOURLY", unit_price_minor: 900 },
    { billing_interval: "MONTHLY", unit_price_minor: 500000, committed: true, commitment_months: 1 },
  ],
};
const PLAN4 = { plan_id: "plan-4", cpu: 4, ram_mb: 16384, disk_gb: 80, selectable: true, pricing_status: "priced", billing_catalog: PLAN_CATALOG };
const WIN_LICENSE = { sku_id: 55, sku_code: "WIN-LIC", os_family: "windows", billing_options: [{ billing_interval: "HOURLY", unit_price_minor: 100 }, { billing_interval: "MONTHLY", unit_price_minor: 60000 }] };

test("resizePlan accepts plan_id and billing_term and carries the Windows licence", async () => {
  let vm = { _id: VM1, status: "running", cpu: 2, ram_mb: 8192, disk_gb: 50, site_id: "site-1", os_type: "linux" };
  const { calls, client } = router([
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), () => vm],
    ["GET", /^\/compute\/plans$/, { plans: [PLAN4], count: 1 }],
    ["PATCH", /\/actions\/resize-plan$/, ACCEPTED],
  ]);
  const rp = (request) => client.cloudVms.resizePlan({ workspaceId: WS, vmId: VM1, request });
  await assert.rejects(rp({ plan_id: "plan-4", cpu: 4 }), isValidation("invalid_resize_target", /not both/));
  await assert.rejects(rp({ cpu: 4, ram_mb: 16384, billing_term: "MONTHLY" }), isValidation("invalid_billing_term", /billing_term/));
  assert.equal(calls.length, 0);
  await rp({ plan_id: "plan-4", billing_term: "MONTHLY", allow_online: true });
  const body = calls.at(-1).body;
  assert.equal(body.cpu, 4);
  assert.equal(body.ram_mb, 16384);
  assert.equal(body.allow_online, true);
  assert.equal(body.billing_catalog.sku_code, "STANDARD-4-16-80");
  assert.equal(body.billing_catalog.billing_interval, "MONTHLY");
  for (const k of ["plan_id", "billing_term", "windows_license"]) assert.equal(k in body, false, k);
  // Windows: the current licence is carried over, or an explicit one is priced for the term.
  vm = { ...vm, os_type: "windows", billing_catalog: { sku_id: 9, sku_code: "OLD", attached_skus: { windows_license: { sku_id: 55, sku_code: "WIN-LIC" } } } };
  await rp({ plan_id: "plan-4" });
  assert.equal(calls.at(-1).body.billing_catalog.attached_skus.windows_license.sku_code, "WIN-LIC");
  await rp({ plan_id: "plan-4", billing_term: "MONTHLY", windows_license: WIN_LICENSE });
  const lic = calls.at(-1).body.billing_catalog.attached_skus.windows_license;
  assert.equal(lic.quantity, 4);
  assert.equal(lic.billing_interval, "MONTHLY");
});

test("precheckResize with plan_id needs no Windows licence (shape only)", async () => {
  const { calls, client } = router([
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), { _id: VM1, status: "running", site_id: "site-1", os_type: "windows" }],
    ["GET", /^\/compute\/plans$/, { plans: [PLAN4], count: 1 }],
    ["POST", /\/actions\/resize\/precheck$/, { decision: "in_place", reasons: [], warnings: [] }],
  ]);
  const res = await client.cloudVms.precheckResize({ workspaceId: WS, vmId: VM1, request: { plan_id: "plan-4" } });
  assert.equal(res.decision, "in_place");
  assert.deepEqual(calls.at(-1).body, { cpu: 4, ram_mb: 16384, disk_gb: 80 });
  await assert.rejects(
    client.cloudVms.resize({ workspaceId: WS, vmId: VM1, request: { plan_id: "plan-4" } }),
    isValidation("windows_license_required"),
  );
});

test("updateBackupPolicy rejects a bad schedule before any request", async () => {
  const { calls, client } = router([]);
  const update = (schedule) => client.cloudVms.updateBackupPolicy({ workspaceId: WS, vmId: VM1, request: { schedule } });
  await assert.rejects(update({ hour: 25 }), isValidation("invalid_hour"));
  await assert.rejects(update({ frequency: "hourly" }), isValidation("invalid_frequency"));
  await assert.rejects(update({ timezone: "Mars/Olympus" }), isValidation("invalid_timezone"));
  await assert.rejects(update({ day_of_week: 9 }), isValidation("invalid_day_of_week"));
  await assert.rejects(update("daily"), isValidation("invalid_schedule"));
  assert.equal(calls.length, 0);
});

// --------------------------------------------------------------- networking

test("VPC delete reads the VPC by default and forwards natBillingCatalog", async () => {
  let natGone = false;
  const RIP = { sku_id: "sku-rip", sku_code: "RESERVED-IP" };
  const { calls, client } = router([
    ["GET", /^\/networking\/vpcs\/vpc-1$/, () => ({
      vpc_id: "vpc-1", node_count: 0,
      nat_gateways: natGone ? [] : [{ nat_gateway_id: "nat-1", status: "available", public_ip_source: "platform" }],
    })],
    ["GET", /^\/networking\/vpcs\/vpc-1\/nat-gateways$/, [{ nat_gateway_id: "nat-1", status: "available", public_ip_source: "platform" }]],
    ["GET", /^\/networking\/vpcs\/vpc-1\/virtual-ips$/, []],
    ["GET", /^\/networking\/vpcs\/vpc-1\/virtual-ips$/, []],
    ["DELETE", /^\/networking\/vpcs\/vpc-1\/nat-gateways\/nat-1$/, () => { natGone = true; return { status: 204, json: null }; }],
    ["DELETE", /^\/networking\/vpcs\/vpc-1$/, { status: 204, json: null }],
  ]);
  await assert.rejects(client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1" }), isValidation("vpc_has_nat_gateway"));
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  await assert.rejects(
    client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1", deleteNatGateway: true, natIpAction: "reserve" }),
    isValidation("billing_catalog_required"),
  );
  await assert.rejects(
    client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1", deleteNatGateway: true, natBillingCatalog: RIP }),
    isValidation("invalid_billing_catalog"),
  );
  await client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1", deleteNatGateway: true, natIpAction: "reserve", natBillingCatalog: RIP });
  const natDelete = calls.find((c) => c.method === "DELETE" && /nat-gateways/.test(c.path));
  assert.deepEqual(natDelete.body, { public_ip_action: "reserve", billing_catalog: RIP });
  assert.equal(calls.at(-1).path, "/networking/vpcs/vpc-1");
  // checkDependencies: false skips the read.
  calls.length = 0;
  await client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1", checkDependencies: false });
  assert.deepEqual(calls.map((c) => c.method), ["DELETE"]);
});

test("a NAT delete still pending after the wait is not a validation error", async () => {
  const { calls, client } = router([
    ["DELETE", /nat-gateways\/nat-1$/, { status: 204, json: null }],
    ["GET", /^\/networking\/vpcs\/vpc-1$/, { vpc_id: "vpc-1", nat_gateways: [{ nat_gateway_id: "nat-1" }] }],
  ]);
  const vpcs = client.vpcs;
  const original = vpcs.waitForNatGatewayAbsent.bind(vpcs);
  vpcs.waitForNatGatewayAbsent = (a) => original({ ...a, attempts: 2, intervalMs: 1 });
  await assert.rejects(
    vpcs.deleteNatGateway({ workspaceId: WS, vpcId: "vpc-1", natGatewayId: "nat-1", wait: true }),
    (err) => err instanceof IbeeError && !(err instanceof IbeeValidationError) && err.code === "nat_gateway_deleting",
  );
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
});

test("NAT create retry skips the Reserved IP check when a gateway exists", async () => {
  const { calls, client } = router([
    ["GET", /^\/networking\/vpcs\/v$/, { vpc_id: "v", site_id: "s1", connectivity_type: "nat_gateway", nat_gateways: [{ nat_gateway_id: "n" }] }],
    ["POST", /nat-gateways$/, { nat_gateway_id: "n" }],
  ]);
  await client.vpcs.createNatGateway({ workspaceId: WS, vpcId: "v", reservedPublicIpId: "rip-1", billingCatalog: { sku_id: "x", sku_code: "NAT-GATEWAY" } });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /networking/vpcs/v", "POST /networking/vpcs/v/nat-gateways"]);
});

test("port-forward update: vip without announcers and duplicate ports are refused", async () => {
  const { calls, client } = router([
    ["GET", /^\/networking\/vpcs\/v\/nat-gateways$/, [{ nat_gateway_id: "n", status: "available" }]],
    ["GET", /port-forwarding-rules$/, [
      { port_forward_rule_id: "r1", protocol: "tcp", external_port: 2222, internal_ip: "10.0.0.10", target_type: "vm" },
      { port_forward_rule_id: "r2", protocol: "tcp", external_port: 8080, internal_ip: "10.0.0.11", target_type: "vm" },
    ]],
    ["PATCH", /port-forwarding-rules\/r1$/, (c) => c.body],
  ]);
  const base = { workspaceId: WS, vpcId: "v", natGatewayId: "n", portForwardingRuleId: "r1" };
  await assert.rejects(
    client.vpcs.updatePortForwardingRule({ ...base, targetType: "vip", checkState: false }),
    isValidation("invalid_target_vm_ids", /announcer/),
  );
  await assert.rejects(client.vpcs.updatePortForwardingRule({ ...base, externalPort: 8080 }), isValidation("duplicate_external_port"));
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  await client.vpcs.updatePortForwardingRule({ ...base, targetType: "vip", targetVmIds: ["vm-a"], checkState: false });
  assert.deepEqual(calls.at(-1).body.target_vm_ids, ["vm-a"]);
});

test("subnet create refuses an explicit CIDR with autoCidr: true", async () => {
  const { calls, client } = router([]);
  await assert.rejects(
    client.vpcs.createSubnet({ workspaceId: WS, vpcId: "v", name: "a", cidr: "10.0.0.0/24", autoCidr: true, checkVpc: false }),
    isValidation("invalid_auto_cidr"),
  );
  assert.equal(calls.length, 0);
});

test("load balancer retries get the portal defaults", async () => {
  const { calls, client } = router([["POST", /load-balancers\/l4$/, (c) => c.body]]);
  await client.loadBalancers.createL4({
    workspaceId: WS, name: "edge", protocol: "tcp", backends: [{ target: "10.0.0.5", port: 5432, type: "ip" }],
    policy: { retries: { attempts: 5 } },
  });
  assert.deepEqual(calls[0].body.policy.retries, { attempts: 5, per_retry_timeout_ms: 5000, on: ["5xx", "reset", "connect-failure"] });
});

test("iterateGroups takes a pageSize and de-duplicates by firewall_group_id or id", async () => {
  const { calls, client } = router([
    ["GET", /^\/networking\/firewall-groups$/, (c) => (c.query.get("offset") === "0" ? [{ id: "a" }, { id: "b" }] : [{ id: "b" }])],
  ]);
  const groups = await client.firewalls.listAllGroups({ workspaceId: WS, pageSize: 2 });
  assert.deepEqual(groups.map((g) => g.id), ["a", "b"]);
  assert.equal(calls[0].query.get("limit"), "2");
  await assert.rejects(async () => client.firewalls.listAllGroups({ workspaceId: WS, pageSize: 101 }), isValidation("invalid_limit"));
});

// ------------------------------------------------------------ secret store

const envelope = (code, message, details) => ({ error: { code, message, ...(details ? { details } : {}) } });

test("Secret Store errors: value/version 404, read-only scope 422, not-owned hierarchy", () => {
  const v = apiErrorFromResponse(404, envelope("NOT_FOUND", "Secret version not found"), { path: "/secret-store/secrets/s1/versions/3" });
  assert.ok(v instanceof SecretValueNotFoundError && v instanceof NotFoundError);
  assert.match(v.hint, /undelete it or write a new value/);
  const val = apiErrorFromResponse(404, envelope("NOT_FOUND", "Secret value not found"), { path: "/secret-store/secrets/s1/value" });
  assert.ok(val instanceof SecretValueNotFoundError);
  assert.equal(apiErrorFromResponse(404, envelope("NOT_FOUND", "x"), { path: "/secret-store/secrets/s1" }).constructor, NotFoundError);
  const scope = apiErrorFromResponse(422, envelope("VALIDATION_ERROR", "Read-only scopes cannot grant rollback or destroy permissions"), { path: "/secret-store/scopes/sc1" });
  assert.ok(scope instanceof ScopeValidationError && scope instanceof UnprocessableEntityError);
  assert.match(scope.message, /read_write/);
  const nf = apiErrorFromResponse(403, envelope("FORBIDDEN", "Store 'st1' does not belong to workspace '710995'"), { path: "/secret-store/stores/st1" });
  assert.ok(nf instanceof ResourceNotFoundError && nf instanceof WorkspaceNotAllowedError);
});

test("Secret Store body size is checked before the billing preflight", async () => {
  const { calls, client } = router([]);
  const big = { blob: "x".repeat(70_000) };
  await assert.rejects(
    client.secretStore.createSecret({ workspaceId: WS, storeId: "st1", name: "big", value: big, billingPreflight: true }),
    isValidation("request_body_too_large"),
  );
  await assert.rejects(
    client.secretStore.createSecretStore({ workspaceId: WS, name: "s", description: "d".repeat(70_000), billingPreflight: true }),
    isValidation("request_body_too_large"),
  );
  assert.equal(calls.length, 0);
});

test("createSecretStore ifExists 'return' keeps the ConflictError without read scope", async () => {
  const { client } = router([
    ["POST", /^\/secret-store\/stores$/, { status: 409, json: envelope("CONFLICT", "Store already exists") }],
    ["GET", /^\/secret-store\/stores$/, { status: 403, json: { error: "insufficient_scope", required_scope: "secret-store.read" } }],
  ]);
  const onWarning = () => {};
  process.on("warning", onWarning);
  try {
    await assert.rejects(
      client.secretStore.createSecretStore({ workspaceId: WS, name: "prod", ifExists: "return" }),
      (err) => err instanceof ConflictError,
    );
  } finally {
    process.off("warning", onWarning);
  }
});

test("listAllSecretStores includes archived stores by default and has no item cap", async () => {
  const total = 10_050;
  const { calls, client } = router([
    ["GET", /^\/secret-store\/stores$/, (c) => {
      const page = Number(c.query.get("page"));
      const limit = Number(c.query.get("limit"));
      const start = (page - 1) * limit;
      const n = Math.max(0, Math.min(limit, total - start));
      return { stores: Array.from({ length: n }, (_, i) => ({ id: `st${start + i}` })), total };
    }],
  ]);
  const stores = await client.secretStore.listAllSecretStores({ workspaceId: WS });
  assert.equal(stores.length, total);
  assert.equal(calls[0].query.get("include_archived"), "true");
  await client.secretStore.listAllSecretStores({ workspaceId: WS, includeArchived: false, pageSize: 200 }).then(() => undefined);
  assert.equal(calls.at(-1).query.get("include_archived"), "false");
  // A single page keeps the API default.
  await client.secretStore.listSecretStores({ workspaceId: WS });
  assert.equal(calls.at(-1).query.get("include_archived"), null);
});

test("Secret Store workspace IDs are trimmed like the Python SDK", async () => {
  const { calls, client } = router([["GET", /^\/secret-store\/stores\/st1$/, { id: "st1" }]]);
  await client.secretStore.getSecretStore({ workspaceId: " 710995 ", storeId: "st1" });
  assert.equal(calls[0].query.get("workspace_id"), "710995");
});

test("chunkBatchSecrets splits by item count and body size", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ secret_name: `s${i}`, value: { k: "v".repeat(100) } }));
  assert.deepEqual(chunkBatchSecrets(items, { maxItems: 2 }).map((c) => c.length), [2, 2, 1]);
  const bySize = chunkBatchSecrets(items, { maxBytes: 300 });
  assert.ok(bySize.length > 1);
  for (const chunk of bySize) assert.ok(new TextEncoder().encode(JSON.stringify({ secrets: chunk })).length <= 300);
  assert.equal(bySize.flat().length, 5);
  assert.throws(() => chunkBatchSecrets([{ secret_name: "big", value: { k: "x".repeat(500) } }], { maxBytes: 300 }), isValidation("request_body_too_large"));
  assert.deepEqual(chunkBatchSecrets([]), []);
});
