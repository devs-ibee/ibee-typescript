// Cross-client alignment with the Python SDK (0.4.0): error codes, payment
// walls, backup restore resolution, VPC delete dependencies, CDN origin read,
// firewall group summaries, Secret Store ifExists and SSH key secret refs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiError,
  BillingDeniedError,
  CdnDomainVerificationTimeoutError,
  IbeeError,
  Ibee,
  IbeeValidationError,
  OperationTimeoutError,
  PAYMENT_BLOCK_CODES,
  PAYMENT_BLOCK_PHRASES,
  RecoveryFailedError,
  RecoveryRestoreFailedError,
  apiErrorFromResponse,
  isPaymentBlockError,
  resolveBackupRecoveryPointId,
  validateAccessUpdate,
  validateNetworkFields,
} from "../dist/index.js";

const WS = "710995";
const VM1 = "64b0000000000000000000a1";
const OP1 = "op_64b0000000000000000000f1";
const ACCEPTED = { operation_id: OP1, vm_id: VM1, status: "accepted", submitted_at: "2026-09-28T00:00:00Z" };
const SSH = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq0 user@host";

function router(routes, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const call = {
      path: u.pathname.replace(/^\/v1/, ""),
      query: u.searchParams,
      method: init.method ?? "GET",
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

const FORBIDDEN = { status: 403, json: { error: "insufficient_scope", required_scope: "network.read" } };

// ---------------------------------------------------------- payment walls

test("isPaymentBlockError: structured signals first, then whole phrases only", () => {
  assert.equal(isPaymentBlockError(null), false);
  assert.equal(isPaymentBlockError("insufficient balance"), false);
  assert.equal(isPaymentBlockError(new BillingDeniedError(402, {})), true);
  assert.equal(isPaymentBlockError(apiErrorFromResponse(402, {})), true);
  // Structured codes, operation error codes and billing reasons.
  for (const code of ["billing_denied", "payment_required", "insufficient_funds", "initial_topup_required", "dunning_active"]) {
    assert.ok(PAYMENT_BLOCK_CODES.has(code), code);
  }
  assert.equal(isPaymentBlockError({ code: "PAYMENT_REQUIRED" }), true);
  assert.equal(isPaymentBlockError({ errorCode: "insufficient_balance" }), true);
  assert.equal(isPaymentBlockError({ error_code: "credit_limit_exceeded" }), true);
  assert.equal(isPaymentBlockError({ reason: "initial_topup_required" }), true);
  assert.equal(isPaymentBlockError({ billing_reason: "overage_cap_exceeded" }), true);
  // A missing scope is never a payment wall.
  assert.equal(
    isPaymentBlockError(apiErrorFromResponse(403, { error: "insufficient_scope", required_scope: "billing.read" })),
    false,
  );
  // A server code is authoritative over the message text.
  assert.equal(
    isPaymentBlockError(apiErrorFromResponse(409, { error: { code: "quota_exceeded", message: "payment required to continue" } })),
    false,
  );
  // Whole phrases only: never a bare "insufficient" or "balance".
  assert.equal(isPaymentBlockError(apiErrorFromResponse(409, { detail: "Insufficient capacity in this site" })), false);
  assert.equal(isPaymentBlockError(new Error("insufficient permissions")), false);
  assert.equal(isPaymentBlockError(new Error("load balancer is busy")), false);
  assert.equal(isPaymentBlockError(apiErrorFromResponse(403, { detail: "Insufficient  balance for this plan" })), true);
  assert.equal(isPaymentBlockError(new Error("Please top up your wallet")), true);
  assert.equal(isPaymentBlockError(new Error("Add a payment method to continue")), true);
  // The SDK's own placeholder message is not inspected.
  assert.equal(isPaymentBlockError(new ApiError(500, {})), false);
  assert.ok(PAYMENT_BLOCK_PHRASES.includes("top-up"));
});

// ---------------------------------------------------------- error classes

test("wait and recovery error classes carry the canonical codes", () => {
  const domain = new CdnDomainVerificationTimeoutError("cdn.example.com", 60_000, { status: "pending", message: "DNS not found" });
  assert.ok(domain instanceof OperationTimeoutError);
  assert.equal(domain.code, "operation_wait_timeout");
  assert.equal(domain.domain, "cdn.example.com");
  assert.equal(domain.lastStatus, "pending");
  assert.equal(domain.timeoutMs, 60_000);
  assert.match(domain.message, /cdn\.example\.com is still pending after 60s\. DNS not found/);

  const restore = new RecoveryRestoreFailedError({ status: "failed" }, "r1");
  assert.ok(restore instanceof RecoveryFailedError);
  assert.equal(restore.code, "recovery_restore_failed");
  assert.equal(new RecoveryFailedError("backup_run", { status: "failed" }, "b1").code, "recovery_failed");
});

// --------------------------------------------------------- backup restore

test("resolveBackupRecoveryPointId follows the portal order", () => {
  assert.equal(resolveBackupRecoveryPointId({ recovery_point_id: " rp-1 ", metadata: { recovery_point_id: "rp-2" } }), "rp-1");
  assert.equal(resolveBackupRecoveryPointId({ metadata: { recovery_point_id: "rp-2", recoveryPointId: "rp-3" } }), "rp-2");
  assert.equal(resolveBackupRecoveryPointId({ metadata: { recoveryPointId: "rp-3" } }), "rp-3");
  assert.equal(resolveBackupRecoveryPointId({ r2_prefix: "ws/710995/vm/x/recovery-points/rp-4/" }), "rp-4");
  assert.equal(
    resolveBackupRecoveryPointId({ r2_prefix: "", metadata: { r2_manifest_key: "backups/RECOVERY-POINTS/abc-5/manifest.json" } }),
    "abc-5",
  );
  assert.equal(resolveBackupRecoveryPointId({ metadata: { r2_prefix: "backups/chain-1/rp-6" } }), "rp-6");
  // The run's own prefix wins over the metadata keys.
  assert.equal(
    resolveBackupRecoveryPointId({ r2_prefix: "x/recovery-points/rp-7", metadata: { r2_manifest_key: "y/recovery-points/rp-8/m" } }),
    "rp-7",
  );
  for (const run of [{}, null, { r2_prefix: "backups/chain-1/full" }, { metadata: "rp-9" }]) {
    assert.throws(
      () => resolveBackupRecoveryPointId(run),
      isValidation("recovery_point_not_ready", /missing recovery point id/),
    );
  }
});

test("restoreBackup always reads the run, checks success first and sends the resolved recovery point", async () => {
  const runs = {
    "run-1": { run_id: "run-1", status: "succeeded", r2_prefix: "ws/1/recovery-points/rp-11/" },
    "run-2": { run_id: "run-2", status: "succeeded" },
    "run-3": { run_id: "run-3", status: "running" },
  };
  const { calls, client } = router([
    ["GET", /\/cloud-vm-backups\/runs\/run-\d$/, (c) => runs[c.path.split("/").pop()]],
    ["POST", /\/backups\/actions\/restore$/, { restore_id: "r1", status: "queued" }],
  ]);
  const restore = (id) =>
    client.cloudVms.restoreBackup({ workspaceId: WS, vmId: VM1, checkState: false, request: { recovery_point_id: id } });
  await restore("run-1");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path.replace(/^.*\/(cloud-vm-backups|cloud-vms)/, "$1")}`), [
    "GET cloud-vm-backups/runs/run-1",
    `POST cloud-vms/${VM1}/backups/actions/restore`,
  ]);
  assert.deepEqual(calls.at(-1).body, { recovery_point_id: "rp-11", target_mode: "replace" });
  calls.length = 0;
  await assert.rejects(restore("run-2"), isValidation("recovery_point_not_ready", /missing recovery point id/));
  // Success is checked before the recovery point is resolved.
  await assert.rejects(restore("run-3"), isValidation("recovery_point_not_ready", /Only successful backups/));
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

// ------------------------------------------------------------- VPC delete

function vpcRouter({ vpc, vips = [], natStaysListed = false }) {
  let natDeleted = false;
  return router([
    ["GET", /^\/networking\/vpcs\/vpc-1$/, () =>
      typeof vpc === "function" ? vpc() : { ...vpc, nat_gateways: natDeleted && !natStaysListed ? [] : vpc.nat_gateways ?? [] }],
    ["GET", /^\/networking\/vpcs\/vpc-1\/virtual-ips$/, () => (typeof vips === "function" ? vips() : vips)],
    ["DELETE", /^\/networking\/vpcs\/vpc-1\/nat-gateways\/nat-1$/, () => { natDeleted = true; return { status: 204, json: null }; }],
    ["DELETE", /^\/networking\/vpcs\/vpc-1$/, { status: 204, json: null }],
  ]);
}

test("VPC delete checks virtual IPs by default, after nodes and NAT", async () => {
  const del = (client, extra = {}) => client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1", ...extra });
  let r = vpcRouter({ vpc: { vpc_id: "vpc-1", node_count: 0 }, vips: [{ virtual_ip_id: "vip-1" }] });
  await assert.rejects(del(r.client), isValidation("vpc_has_virtual_ips"));
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [
    "GET /networking/vpcs/vpc-1",
    "GET /networking/vpcs/vpc-1/virtual-ips",
  ]);
  // Nodes are checked before the virtual IPs are listed.
  r = vpcRouter({ vpc: { vpc_id: "vpc-1", node_count: 2 }, vips: [{ virtual_ip_id: "vip-1" }] });
  await assert.rejects(del(r.client), isValidation("vpc_has_nodes"));
  assert.equal(r.calls.length, 1);
  // No virtual IPs: the VPC is deleted.
  r = vpcRouter({ vpc: { vpc_id: "vpc-1", node_count: 0 } });
  await del(r.client);
  assert.deepEqual(r.calls.map((c) => c.method), ["GET", "GET", "DELETE"]);
  // checkDependencies: false without deleteNatGateway is a plain DELETE.
  r = vpcRouter({ vpc: { vpc_id: "vpc-1", node_count: 3 }, vips: [{ virtual_ip_id: "vip-1" }] });
  await del(r.client, { checkDependencies: false });
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), ["DELETE /networking/vpcs/vpc-1"]);
});

test("VPC delete with deleteNatGateway checks virtual IPs before deleting the gateway", async () => {
  const vpc = { vpc_id: "vpc-1", node_count: 0, nat_gateways: [{ nat_gateway_id: "nat-1", public_ip_source: "platform" }] };
  let r = vpcRouter({ vpc, vips: [{ virtual_ip_id: "vip-1" }] });
  await assert.rejects(
    r.client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1", deleteNatGateway: true, checkDependencies: false }),
    isValidation("vpc_has_virtual_ips"),
  );
  assert.equal(r.calls.filter((c) => c.method === "DELETE").length, 0);
  r = vpcRouter({ vpc });
  await r.client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1", deleteNatGateway: true });
  assert.deepEqual(
    r.calls.map((c) => `${c.method} ${c.path}`),
    [
      "GET /networking/vpcs/vpc-1",
      "GET /networking/vpcs/vpc-1/virtual-ips",
      "DELETE /networking/vpcs/vpc-1/nat-gateways/nat-1",
      "GET /networking/vpcs/vpc-1",
      "DELETE /networking/vpcs/vpc-1",
    ],
  );
});

test("a NAT gateway still listed after the VPC delete wait throws IbeeError nat_gateway_deleting", async () => {
  const vpc = { vpc_id: "vpc-1", node_count: 0, nat_gateways: [{ nat_gateway_id: "nat-1", public_ip_source: "platform" }] };
  const { calls, client } = vpcRouter({ vpc, natStaysListed: true });
  client.vpcs.waitForNatGatewayAbsent = async () => false;
  await assert.rejects(client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1", deleteNatGateway: true }), (err) => {
    assert.ok(err instanceof IbeeError);
    assert.ok(!(err instanceof IbeeValidationError));
    assert.equal(err.code, "nat_gateway_deleting");
    assert.match(err.message, /still reconciling; retry deleting the VPC shortly/);
    return true;
  });
  assert.equal(calls.some((c) => c.method === "DELETE" && c.path === "/networking/vpcs/vpc-1"), false);
});

test("VPC delete: a 403 on the reads skips the default checks unless checkDependencies is true", async () => {
  let r = vpcRouter({ vpc: { vpc_id: "vpc-1", node_count: 0 }, vips: () => FORBIDDEN });
  await r.client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1" });
  assert.equal(r.calls.at(-1).method, "DELETE");
  r = vpcRouter({ vpc: { vpc_id: "vpc-1", node_count: 0 }, vips: () => FORBIDDEN });
  await assert.rejects(r.client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1", checkDependencies: true }), (err) => err.statusCode === 403);
  assert.equal(r.calls.some((c) => c.method === "DELETE"), false);
  // The virtual IPs are listed only when the VPC read succeeded.
  r = vpcRouter({ vpc: () => FORBIDDEN, vips: [{ virtual_ip_id: "vip-1" }] });
  await r.client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1" });
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), ["GET /networking/vpcs/vpc-1", "DELETE /networking/vpcs/vpc-1"]);
});

// -------------------------------------------------------------------- CDN

test("createDistribution({ checkOriginPublic }) treats a 403 or 404 on the origin read as non-fatal", async () => {
  for (const bucketResponse of [
    { status: 403, json: { error: "insufficient_scope", required_scope: "object-storage.read" } },
    { status: 403, json: { detail: "Forbidden" } },
    { status: 404, json: { detail: "Bucket not found" } },
  ]) {
    const { calls, client } = router([
      ["GET", /^\/object-storage\/buckets\/assets$/, bucketResponse],
      ["POST", /^\/cdn\/distributions$/, (c) => ({ id: "d1", ...c.body })],
    ]);
    await client.cdn.createDistribution({ workspaceId: WS, name: "site", origin_id: "assets", checkOriginPublic: true });
    assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);
  }
  const { calls, client } = router([
    ["GET", /^\/object-storage\/buckets\/assets$/, { name: "assets", is_public: false }],
    ["POST", /^\/cdn\/distributions$/, {}],
  ]);
  await assert.rejects(
    client.cdn.createDistribution({ workspaceId: WS, name: "site", origin_id: "assets", checkOriginPublic: true }),
    isValidation("origin_not_public"),
  );
  assert.equal(calls.some((c) => c.method === "POST"), false);
});

// ------------------------------------------------------ firewall summaries

test("listGroupSummaries auto-pages without limit/offset; iterateGroupSummaries pages on demand", async () => {
  const all = Array.from({ length: 150 }, (_, i) => ({ firewall_group_id: `fg-${i}`, name: `g${i}`, rule_count: i }));
  const { calls, client } = router([
    ["GET", /^\/networking\/firewall-groups$/, (c) => {
      const limit = Number(c.query.get("limit"));
      const offset = Number(c.query.get("offset"));
      // The last page repeats an item, which is de-duplicated.
      const page = all.slice(offset, offset + limit);
      return offset > 0 ? [all[offset - 1], ...page] : page;
    }],
  ]);
  const every = await client.firewalls.listGroupSummaries({ workspaceId: WS });
  assert.equal(every.length, 150);
  assert.deepEqual(
    calls.map((c) => [c.query.get("summary"), c.query.get("limit"), c.query.get("offset")]),
    [["true", "100", "0"], ["true", "100", "100"]],
  );
  calls.length = 0;
  const page = await client.firewalls.listGroupSummaries({ workspaceId: WS, offset: 20 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query.get("limit"), "10");
  assert.equal(page[1].firewall_group_id, "fg-20");
  calls.length = 0;
  const seen = [];
  for await (const g of client.firewalls.iterateGroupSummaries({ workspaceId: WS, pageSize: 60 })) {
    seen.push(g.firewall_group_id);
    if (seen.length === 70) break;
  }
  assert.equal(seen.length, 70);
  assert.equal(new Set(seen).size, 70);
  assert.deepEqual(calls.map((c) => c.query.get("offset")), ["0", "60"]);
  const listed = await client.firewalls.listAllGroupSummaries({ workspaceId: WS, pageSize: 100 });
  assert.equal(listed.length, 150);
  await assert.rejects(client.firewalls.listGroupSummaries({ workspaceId: WS, limit: 101 }), isValidation("invalid_limit"));
  assert.throws(() => client.firewalls.iterateGroupSummaries({ workspaceId: WS, pageSize: 0 }), isValidation("invalid_limit"));
});

// ------------------------------------------------------------ Secret Store

test("createSecretStore accepts ifExists 'reuse' as an alias of 'return'", async () => {
  const { calls, client } = router([
    ["POST", /^\/secret-store\/stores$/, { status: 409, json: { error: { code: "CONFLICT", message: "Store 'app' already exists" } } }],
    ["GET", /^\/secret-store\/stores$/, { stores: [{ id: "st1", name: "App", store_key: "app" }], total: 1 }],
  ]);
  const store = await client.secretStore.createSecretStore({ workspaceId: WS, name: "app", ifExists: "reuse" });
  assert.equal(store.id, "st1");
  assert.deepEqual(calls.map((c) => c.method), ["POST", "GET"]);
});

// ------------------------------------------------------------- VM access

test("SSH key secret refs: either identifier is enough and store_key defaults to ssh-keys", () => {
  const body = validateAccessUpdate({
    ssh_key_mode: "add",
    ssh_key_secret_refs: [{ secret_name: "deploy" }, { ssh_key_id: "key-2", store_key: "team-keys", ssh_key_name: "ops" }],
  });
  assert.deepEqual(body.ssh_key_secret_refs, [
    { secret_name: "deploy", store_key: "ssh-keys" },
    { ssh_key_id: "key-2", store_key: "team-keys", ssh_key_name: "ops" },
  ]);
  assert.throws(
    () => validateAccessUpdate({ ssh_key_mode: "add", ssh_key_secret_refs: [{ store_key: "ssh-keys", secret_name: " " }] }),
    isValidation("invalid_ssh_key_secret_refs"),
  );
  assert.throws(() => validateAccessUpdate({}), isValidation("no_changes"));
  assert.throws(() => validateAccessUpdate("x"), isValidation("invalid_request"));
});

test("GPU VM access updates read the VM by default; checkState: false opts out", async () => {
  let vm = { _id: VM1, status: "running", os_type: "windows", admin_username: "admin" };
  const { calls, client } = router([
    ["GET", new RegExp(`^/compute/gpu-vms/${VM1}$`), () => vm],
    ["PATCH", new RegExp(`^/compute/gpu-vms/${VM1}/actions/access$`), ACCEPTED],
  ]);
  const update = (extra = {}) =>
    client.gpuVms.updateAccess({ workspaceId: WS, vmId: VM1, request: { ssh_key_mode: "add", ssh_keys: [SSH] }, ...extra });
  await assert.rejects(update(), isValidation("vm_not_linux"));
  vm = { ...vm, os_type: "linux", status: "stopped" };
  await assert.rejects(update(), isValidation("invalid_vm_state"));
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  calls.length = 0;
  await update({ checkState: false });
  assert.deepEqual(calls.map((c) => c.method), ["PATCH"]);
  // A 403 on the pre-read is not skipped: the read is a required rule.
  const denied = router([["GET", new RegExp(`^/compute/gpu-vms/${VM1}$`), { status: 403, json: { error: "insufficient_scope", required_scope: "vm.read" } }]]);
  await assert.rejects(
    denied.client.gpuVms.updateAccess({ workspaceId: WS, vmId: VM1, request: { password_auth_enabled: true } }),
    (err) => err.statusCode === 403,
  );
});

// ------------------------------------------------------------ error codes

test("canonical codes for VM network placement and requests", () => {
  assert.throws(() => validateNetworkFields({ vpc_id: "v" }), isValidation("subnet_required"));
  assert.throws(() => validateNetworkFields({ subnet_id: "s" }), isValidation("vpc_required"));
  assert.throws(() => validateNetworkFields({ network_connectivity: "nat" }), isValidation("vpc_required"));
  assert.throws(() => validateNetworkFields({ network_connectivity: "wifi" }), isValidation("invalid_network_connectivity"));
  assert.throws(
    () => validateNetworkFields({ vpc_id: "v", subnet_id: "s", network_connectivity: "private", reserved_public_ip_id: "r" }),
    isValidation("invalid_network_connectivity"),
  );
});

test("canonical codes for VM resize requests", async () => {
  const { calls, client } = router([
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), { _id: VM1, status: "stopped", cpu: 4, ram_mb: 8192, disk_gb: 80 }],
  ]);
  const vm = { workspaceId: WS, vmId: VM1 };
  await assert.rejects(client.cloudVms.resize({ ...vm, request: {} }), isValidation("no_changes"));
  await assert.rejects(client.cloudVms.resize({ ...vm, request: "big" }), isValidation("invalid_request"));
  await assert.rejects(client.cloudVms.resize({ ...vm, request: { cpu: 0 } }), isValidation("invalid_cpu"));
  await assert.rejects(client.cloudVms.resize({ ...vm, request: { plan_id: "p", cpu: 2 } }), isValidation("invalid_resize_target"));
  await assert.rejects(client.cloudVms.resizePlan({ ...vm, request: { cpu: 4, ram_mb: 8192, windows_license: {} } }), isValidation("invalid_windows_license"));
  await assert.rejects(client.cloudVms.resizeRootDisk({ ...vm, request: {} }), isValidation("invalid_new_size_gb"));
  await assert.rejects(client.cloudVms.resizeRootDisk({ ...vm, request: { new_size_gb: 80 } }), isValidation("root_disk_grow_only"));
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
});
