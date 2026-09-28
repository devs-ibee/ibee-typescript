import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BillingDeniedError,
  CdnDomainVerificationTimeoutError,
  CdnPurgeFailedError,
  ForbiddenError,
  Ibee,
  IbeeCdnPurgeError,
  IbeeEnvironment,
  IbeeValidationError,
  OrganizationRestrictedError,
  ServiceUnavailableError,
  buildBucketCreateBody,
  buildCdnPurgeBody,
  buildS3CredentialBody,
  normalizeCdnDomain,
  resolveObjectStorageRegion,
  resolveSingleAttachment,
  s3EndpointForWorkspace,
  validateBlockVolumeCreateSize,
  validateBlockVolumeName,
  validateBucketName,
  validateCdnIndexDocument,
} from "../dist/index.js";

const WS = "710995";
const VOL = "64b0000000000000000000b1";
const VM1 = "64b0000000000000000000a1";
const VM2 = "64b0000000000000000000a2";
const OP1 = "op_64b0000000000000000000f1";
const ACCEPTED = { operation_id: OP1, vm_id: VM1, status: "pending", submitted_at: "2026-09-01T00:00:00Z" };
const BLOCK_SKU = { sku_id: 7, sku_code: "blk-std", product_code: "block_storage" };

/**
 * Routed fetch mock: routes are [method, RegExp, response]; response is JSON,
 * `{ status, json }`, or a function (call) => one of those. Unmatched: 404.
 */
function router(routes, options = {}) {
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
        return new Response(JSON.stringify(r.json), {
          status: r.status,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
    }
    return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
  };
  return { calls, client: new Ibee({ token: "t", fetch: fetchImpl, maxRetries: 0, ...options }) };
}

const isValidation = (code, pattern) => (err) => {
  assert.ok(err instanceof IbeeValidationError, `expected IbeeValidationError, got ${err?.name}: ${err?.message}`);
  if (code) assert.equal(err.code, code, err.message);
  if (pattern) assert.match(err.message, pattern);
  return true;
};
const sent = (calls) => calls.map((c) => `${c.method} ${c.path}`);
const volume = (extra = {}) => ({
  id: VOL, name: "data", size_gb: 50, site_id: "site-1", site_name: "Chennai", state: "ready",
  attachments: [], metadata: { billing_catalog: BLOCK_SKU }, ...extra,
});

// ------------------------------------------------------------ block storage

test("volume name, size, SKU and forbidden-field rules follow the portal", () => {
  assert.equal(validateBlockVolumeName("  db-01 "), "db-01");
  assert.throws(() => validateBlockVolumeName("ab"), isValidation("invalid_volume_name", /at least 3 characters/));
  assert.throws(() => validateBlockVolumeName(""), isValidation("invalid_volume_name", /Enter a volume name/));
  assert.throws(
    () => validateBlockVolumeName("My Data_1"),
    (err) => isValidation("invalid_volume_name", /Lowercase letters, numbers, and hyphens only \(try 'my-data-1'\)/)(err) &&
      err.details.suggestion === "my-data-1",
  );
  assert.equal(validateBlockVolumeCreateSize(10), 10);
  assert.equal(validateBlockVolumeCreateSize(10_000), 10_000);
  for (const bad of [9, 10.5, 10_001, true, "20", null]) {
    assert.throws(() => validateBlockVolumeCreateSize(bad), isValidation("invalid_size_gb"), String(bad));
  }
});

test("createVolume validates, fills site_name from the site catalog and sends the key in body and header", async () => {
  const { calls, client } = router([
    ["GET", /^\/compute\/sites$/, { sites: [{ site_id: "site-1", name: "Chennai" }], count: 1 }],
    ["POST", /^\/block-storage\/volumes$/, (c) => ({ volume: { id: VOL, ...c.body }, operation: { status: "succeeded" } })],
  ]);
  const res = await client.blockStorage.createVolume({
    workspaceId: WS, name: " data-1 ", size_gb: 20, site_id: " site-1 ", sku_code: " blk-std ",
    vm_type: "gpu", delete_on_termination: true,
  });
  assert.equal(res.operation.status, "succeeded");
  assert.deepEqual(sent(calls), ["GET /compute/sites", "POST /block-storage/volumes"]);
  const { idempotency_key: key, ...body } = calls[1].body;
  assert.deepEqual(body, {
    name: "data-1", size_gb: 20, site_id: "site-1", site_name: "Chennai", sku_code: "BLK-STD",
    vm_type: "gpu", delete_on_termination: true,
  });
  assert.match(key, /^block-volume-create-data-1-/);
  assert.equal(calls[1].headers.get("x-idempotency-key"), key);

  await assert.rejects(
    client.blockStorage.createVolume({ workspaceId: WS, name: "data-1", size_gb: 20, site_id: "site-9" }),
    isValidation("unknown_site_id", /Unknown site_id/),
  );
  const before = calls.length;
  const bad = [
    [{ size_gb: 5 }, "invalid_size_gb"],
    [{ site_id: " " }, "invalid_site_id"],
    [{ sku_code: "ROOTDISK-STD" }, "invalid_sku_code"],
    [{ volume_class: "fast" }, "invalid_volume_class"],
    [{ replica_count: 6 }, "invalid_replica_count"],
    [{ vm_type: "bare" }, "invalid_vm_type"],
    [{ volume_kind: "vm-root" }, "forbidden_field"],
    [{ billing_catalog: BLOCK_SKU }, "forbidden_field"],
    [{ billing_sku_code: "X" }, "forbidden_field"],
  ];
  for (const [extra, code] of bad) {
    await assert.rejects(
      client.blockStorage.createVolume({ workspaceId: WS, name: "data-1", size_gb: 20, site_id: "site-1", ...extra }),
      isValidation(code),
      JSON.stringify(extra),
    );
  }
  assert.equal(calls.length, before, "validation runs before any request");
});

test("createVolume skips the site lookup on 403 or when site_name is given", async () => {
  const { calls, client } = router([
    ["GET", /^\/compute\/sites$/, { status: 403, json: { error: "insufficient_scope", required_scope: "vm.read" } }],
    ["POST", /^\/block-storage\/volumes$/, { volume: {}, operation: {} }],
  ]);
  await client.blockStorage.createVolume({ workspaceId: WS, name: "data-1", size_gb: 20, site_id: "site-1" });
  assert.equal(calls[1].body.site_name, undefined);
  await client.blockStorage.createVolume({ workspaceId: WS, name: "data-1", size_gb: 20, site_id: "site-1", site_name: "Pune" });
  await client.blockStorage.createVolume({ workspaceId: WS, name: "data-1", size_gb: 20, site_id: "site-1", resolveSiteName: false });
  assert.deepEqual(sent(calls), [
    "GET /compute/sites", "POST /block-storage/volumes", "POST /block-storage/volumes", "POST /block-storage/volumes",
  ]);
});

test("listVolumes sends filters; listAllVolumes pages; ids and limits are validated", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `64b00000000000000000000${i}` }));
  const { calls, client } = router([
    ["GET", /^\/block-storage\/volumes$/, (c) => {
      const limit = Number(c.query.get("limit") ?? 100);
      const offset = Number(c.query.get("offset") ?? 0);
      return rows.slice(offset, offset + limit);
    }],
  ]);
  await client.blockStorage.listVolumes({ workspaceId: WS, siteId: " site-1 ", vmType: "gpu", limit: 50, offset: 10 });
  assert.equal(calls[0].query.get("site_id"), "site-1");
  assert.equal(calls[0].query.get("vm_type"), "gpu");
  assert.equal(calls[0].query.get("limit"), "50");
  assert.equal(calls[0].query.get("offset"), "10");
  assert.equal(calls[0].query.get("volume_kind"), null);
  const all = await client.blockStorage.listAllVolumes({ workspaceId: WS, pageSize: 2 });
  assert.equal(all.length, 5);
  assert.deepEqual(calls.slice(1).map((c) => c.query.get("offset")), ["0", "2", "4"]);

  const n = calls.length;
  await assert.rejects(client.blockStorage.listVolumes({ workspaceId: WS, limit: 1001 }), isValidation("invalid_limit"));
  await assert.rejects(client.blockStorage.listVolumes({ workspaceId: WS, vmType: "bare" }), isValidation("invalid_vm_type"));
  await assert.rejects(client.blockStorage.getVolume({ workspaceId: WS, volumeId: "vol-1" }), isValidation("invalid_volume_id"));
  await assert.rejects(
    client.blockStorage.listVolumeOperations({ workspaceId: WS, volumeId: VOL, limit: 201 }),
    isValidation("invalid_limit"),
  );
  assert.equal(calls.length, n);
});

test("listVolumeOperations forwards limit", async () => {
  const { calls, client } = router([["GET", /\/operations$/, []]]);
  await client.blockStorage.listVolumeOperations({ workspaceId: WS, volumeId: VOL, limit: 200 });
  assert.equal(calls[0].query.get("limit"), "200");
});

test("deleteVolume refuses attached or busy volumes unless forced", async () => {
  let vol = volume({ attachments: [{ node_name: "n1", vm_id: VM1, vm_name: "web" }] });
  const { calls, client } = router([
    ["GET", /^\/block-storage\/volumes\/[0-9a-f]+$/, () => vol],
    ["DELETE", /^\/block-storage\/volumes\//, { status: "deleted", id: VOL, operation_id: "x" }],
  ]);
  await assert.rejects(
    client.blockStorage.deleteVolume({ workspaceId: WS, volumeId: VOL }),
    (err) => isValidation("volume_attached", /Detach this volume from all servers before deleting/)(err) &&
      err.details.attachments[0].vm_name === "web",
  );
  vol = volume({ state: "resizing" });
  await assert.rejects(
    client.blockStorage.deleteVolume({ workspaceId: WS, volumeId: VOL }),
    isValidation("volume_busy", /currently 'resizing'. Retry delete/),
  );
  vol = volume();
  const res = await client.blockStorage.deleteVolume({ workspaceId: WS, volumeId: VOL });
  assert.equal(res.status, "deleted");
  const del = calls.at(-1);
  assert.equal(del.method, "DELETE");
  assert.match(del.query.get("idempotency_key"), new RegExp(`^block-volume-delete-${VOL}-`));
  const n = calls.length;
  await client.blockStorage.deleteVolume({ workspaceId: WS, volumeId: VOL, force: true });
  assert.deepEqual(sent(calls.slice(n)), [`DELETE /block-storage/volumes/${VOL}`]);
  assert.equal(calls.at(-1).query.get("force"), "true");
});

test("deleteVolume lets the server decide when the token cannot read the volume", async () => {
  const { calls, client } = router([
    ["GET", /^\/block-storage\/volumes\//, { status: 403, json: { error: "insufficient_scope", required_scope: "block-storage.read" } }],
    ["DELETE", /^\/block-storage\/volumes\//, { status: "deleted" }],
  ]);
  await client.blockStorage.deleteVolume({ workspaceId: WS, volumeId: VOL });
  assert.deepEqual(sent(calls).map((s) => s.split(" ")[0]), ["GET", "DELETE"]);
});

test("resizeVolume is grow-only and needs a stopped VM or allow_online when attached", async () => {
  let vol = volume({ size_gb: 50 });
  const { calls, client } = router([
    ["GET", /^\/block-storage\/volumes\//, () => vol],
    ["POST", /\/resize$/, { volume: {}, operation: {} }],
  ]);
  const resize = (request, extra = {}) => client.blockStorage.resizeVolume({ workspaceId: WS, volumeId: VOL, request, ...extra });
  await assert.rejects(resize({ new_size_gb: 40 }), isValidation("resize_shrink_not_supported", /increase-only/));
  await assert.rejects(resize({ new_size_gb: 10_001 }), isValidation("invalid_new_size_gb"));
  await assert.rejects(resize({ new_size_gb: 60.5 }), isValidation("invalid_new_size_gb"));
  await assert.rejects(resize({ new_size_gb: 60, vm_state: "paused" }), isValidation("invalid_vm_state"));
  await assert.rejects(resize({ new_size_gb: 60, billing_catalog: BLOCK_SKU }), isValidation("forbidden_field"));
  vol = volume({ size_gb: 50, attachments: [{ node_name: "n1" }] });
  await assert.rejects(resize({ new_size_gb: 60 }), isValidation("resize_requires_offline", /allow_online=true/));
  await resize({ new_size_gb: 60, vm_state: "stopped" });
  await resize({ new_size_gb: 60, allow_online: true });
  vol = volume({ state: "attaching" });
  await assert.rejects(resize({ new_size_gb: 60 }), isValidation("volume_busy"));
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2);
  assert.match(posts[0].body.idempotency_key, new RegExp(`^block-volume-resize-${VOL}-`));
  assert.deepEqual({ ...posts[0].body, idempotency_key: undefined }, { new_size_gb: 60, vm_state: "stopped", idempotency_key: undefined });
});

test("node-level attach/detach validate modes, safe detach and resolve the node", async () => {
  let vol = volume({ vm_type: "gpu", attachments: [{ node_name: "node-a", vm_id: VM1 }] });
  const { calls, client } = router([
    ["GET", /^\/block-storage\/volumes\//, () => vol],
    ["POST", /\/(attachments|detach)$/, { volume: {}, operation: { status: "succeeded" } }],
  ]);
  await client.blockStorage.attachVolume({ workspaceId: WS, volumeId: VOL, request: { node_name: " node-a " } });
  assert.equal(calls[0].body.mode, "single-writer");
  assert.equal(calls[0].body.node_name, "node-a");
  await assert.rejects(
    client.blockStorage.attachVolume({ workspaceId: WS, volumeId: VOL, request: { node_name: "n", mode: "rw" } }),
    isValidation("invalid_mode"),
  );
  await assert.rejects(
    client.blockStorage.attachVolume({ workspaceId: WS, volumeId: VOL, request: { node_name: "n", vm_site_id: "site-2" } }),
    isValidation("site_mismatch", /Select a server in Chennai/),
  );
  await assert.rejects(
    client.blockStorage.detachVolume({ workspaceId: WS, volumeId: VOL, request: { node_name: "node-a" } }),
    isValidation("confirmation_required", /Safe detach requires/),
  );
  const n = calls.length;
  await client.blockStorage.detachVolume({ workspaceId: WS, volumeId: VOL, request: { vm_state: "stopped" } });
  const post = calls.at(-1);
  assert.deepEqual(sent(calls.slice(n)), [`GET /block-storage/volumes/${VOL}`, `POST /block-storage/volumes/${VOL}/detach`]);
  assert.equal(post.body.node_name, "node-a");
  assert.equal(post.body.vm_type, "gpu");
  assert.match(post.body.idempotency_key, /^block-volume-detach-/);
  vol = volume({ attachments: [] });
  await assert.rejects(
    client.blockStorage.detachVolume({ workspaceId: WS, volumeId: VOL, request: { force: true } }),
    isValidation("volume_not_attached"),
  );
  vol = volume({ attachments: [{ node_name: "a" }, { node_name: "b" }] });
  await assert.rejects(
    client.blockStorage.detachVolume({ workspaceId: WS, volumeId: VOL, request: { force: true } }),
    isValidation("ambiguous_attachment"),
  );
});

test("attachToVm reads the volume, dispatches by its VM type, and waits like the portal", async () => {
  let vol = volume({ vm_type: "gpu" });
  let opStatus = "succeeded";
  const { calls, client } = router([
    ["GET", /^\/block-storage\/volumes\//, () => vol],
    ["GET", /^\/compute\/(cloud|gpu)-vms\//, { _id: VM1, site_id: "site-1", status: "running" }],
    ["POST", /\/actions\/attach-volume$/, ACCEPTED],
    ["GET", /^\/compute\/operations\//, () => ({ ...ACCEPTED, status: opStatus })],
  ]);
  const res = await client.blockStorage.attachToVm({ workspaceId: WS, volumeId: VOL, vmId: VM1, wait: { pollIntervalMs: 1000 } });
  assert.equal(res.operation.status, "succeeded");
  assert.equal(res.volume.id, VOL);
  assert.deepEqual(sent(calls), [
    `GET /block-storage/volumes/${VOL}`,
    `GET /compute/gpu-vms/${VM1}`,
    `POST /compute/gpu-vms/${VM1}/actions/attach-volume`,
    `GET /compute/operations/${OP1}`,
    `GET /block-storage/volumes/${VOL}`,
  ]);
  const post = calls[2];
  assert.deepEqual(post.body, {
    volume_id: VOL, mode: "single-writer", billing_catalog: { ...BLOCK_SKU, sku_code: "BLK-STD" },
  });
  assert.match(post.headers.get("x-idempotency-key"), /^gpu-vm-attach-volume-/);

  await assert.rejects(
    client.blockStorage.attachToVm({ workspaceId: WS, volumeId: VOL, vmId: VM1, vmType: "cloud" }),
    isValidation("vm_type_mismatch", /created for gpu VMs and cannot attach to a cloud VM/),
  );
  await assert.rejects(
    client.cloudVms.attachVolume({ workspaceId: WS, vmId: VM1, request: { volume_id: VOL } }),
    isValidation("vm_type_mismatch"),
  );
  vol = volume({ attachments: [{ node_name: "n", vm_id: VM2 }] });
  await assert.rejects(
    client.blockStorage.attachToVm({ workspaceId: WS, volumeId: VOL, vmId: VM1 }),
    isValidation("volume_attached", /already attached; detach it first/),
  );
  vol = volume({ metadata: {} });
  await assert.rejects(
    client.blockStorage.attachToVm({ workspaceId: WS, volumeId: VOL, vmId: VM1 }),
    isValidation("invalid_billing_catalog", /pass billing_catalog explicitly/),
  );
  vol = volume({ metadata: { billing_catalog: { sku_id: 1, sku_code: "ROOTDISK-STD" } } });
  await assert.rejects(client.blockStorage.attachToVm({ workspaceId: WS, volumeId: VOL, vmId: VM1 }), isValidation("invalid_billing_catalog"));
  vol = volume();
  opStatus = "failed";
  await assert.rejects(
    client.blockStorage.attachToVm({ workspaceId: WS, volumeId: VOL, vmId: VM1, wait: { pollIntervalMs: 1000 } }),
    (err) => err.name === "OperationFailedError",
  );
});

test("attachToVm without block-storage.read needs an explicit billing catalog", async () => {
  const { calls, client } = router([
    ["GET", /^\/block-storage\/volumes\//, { status: 403, json: { error: "insufficient_scope", required_scope: "block-storage.read" } }],
    ["GET", /^\/compute\/(cloud|gpu)-vms\/[0-9a-f]{24}$/, { _id: VM1, status: "running", site_id: "site-1" }],
    ["POST", /\/actions\/attach-volume$/, ACCEPTED],
  ]);
  await assert.rejects(
    client.blockStorage.attachToVm({ workspaceId: WS, volumeId: VOL, vmId: VM1 }),
    isValidation("invalid_billing_catalog", /grant block-storage.read or pass billingCatalog/),
  );
  await assert.rejects(
    client.cloudVms.attachVolume({ workspaceId: WS, vmId: VM1, request: { volume_id: VOL } }),
    isValidation("invalid_billing_catalog", /grant block-storage.read/),
  );
  const before = calls.length;
  const res = await client.blockStorage.attachToVm({
    workspaceId: WS, volumeId: VOL, vmId: VM1, vmType: "gpu", billingCatalog: { sku_id: 7, sku_code: "BLK-STD" },
  });
  assert.equal(res.operation_id, OP1);
  assert.equal(calls.at(-1).path, `/compute/gpu-vms/${VM1}/actions/attach-volume`);
  // The volume is read once (403), not again by the VM attach.
  assert.equal(calls.slice(before).filter((c) => c.path.startsWith("/block-storage/volumes/")).length, 1);
});

test("attachToVm and detachFromVm validate vmId before any request", async () => {
  const { calls, client } = router([]);
  await assert.rejects(client.blockStorage.attachToVm({ workspaceId: WS, volumeId: VOL, vmId: "vm-x" }), isValidation("invalid_vm_id"));
  await assert.rejects(
    client.blockStorage.detachFromVm({ workspaceId: WS, volumeId: VOL, vmId: "vm-x", confirmUnmounted: true }),
    isValidation("invalid_vm_id"),
  );
  assert.equal(calls.length, 0);
});

test("attachVolume checks the VM state by default with an attach message", async () => {
  let status = "starting";
  const { calls, client } = router([
    ["GET", /^\/block-storage\/volumes\//, volume({ site_id: "" })],
    ["GET", new RegExp(`^/compute/cloud-vms/${VM1}$`), () => ({ _id: VM1, status, site_id: "site-1" })],
    ["POST", /\/actions\/attach-volume$/, ACCEPTED],
  ]);
  const attach = (extra = {}) => client.cloudVms.attachVolume({ workspaceId: WS, vmId: VM1, request: { volume_id: VOL }, ...extra });
  await assert.rejects(attach(), isValidation("invalid_vm_state", /Cannot attach a volume to this VM while its status is 'starting'/));
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  await attach({ checkState: false });
  status = "stopped";
  await attach();
  assert.equal(calls.filter((c) => c.method === "POST").length, 2);
});

test("detachFromVm without block-storage.read detaches from the given VM", async () => {
  const { calls, client } = router([
    ["GET", /^\/block-storage\/volumes\//, { status: 403, json: { error: "insufficient_scope", required_scope: "block-storage.read" } }],
    ["POST", /\/actions\/detach-volume$/, ACCEPTED],
  ]);
  await assert.rejects(
    client.blockStorage.detachFromVm({ workspaceId: WS, volumeId: VOL, confirmUnmounted: true }),
    isValidation("volume_unreadable", /pass vmId and vmType/),
  );
  const res = await client.blockStorage.detachFromVm({ workspaceId: WS, volumeId: VOL, vmId: VM2, confirmUnmounted: true });
  assert.equal(res.operation_id, OP1);
  assert.equal(calls.at(-1).path, `/compute/cloud-vms/${VM2}/actions/detach-volume`);
  await client.blockStorage.detachFromVm({ workspaceId: WS, volumeId: VOL, vmId: VM2, vmType: "gpu", force: true });
  assert.equal(calls.at(-1).path, `/compute/gpu-vms/${VM2}/actions/detach-volume`);
});

test("volume attach/detach waits use the portal failure and timeout wording", async () => {
  let op = { ...ACCEPTED, status: "failed", error_message: null };
  const { client } = router([
    ["GET", /^\/block-storage\/volumes\//, volume({ attachments: [{ node_name: "n", vm_id: VM1 }] })],
    ["POST", /\/actions\/detach-volume$/, ACCEPTED],
    ["GET", /^\/compute\/operations\//, () => op],
  ]);
  const detach = (wait) => client.blockStorage.detachFromVm({ workspaceId: WS, volumeId: VOL, confirmUnmounted: true, wait });
  await assert.rejects(detach(true), (err) => err.name === "OperationFailedError" && err.message === `Volume operation failed (operation ${OP1})`);
  op = { ...ACCEPTED, status: "failed", error_message: "node offline" };
  await assert.rejects(detach(true), (err) => err.message === `node offline (operation ${OP1})`);
  op = { ...ACCEPTED, status: "running" };
  await assert.rejects(
    detach({ timeoutMs: 1000, pollIntervalMs: 1000 }),
    (err) => err.name === "OperationTimeoutError" &&
      err.message === `Operation timed out. Please refresh to check the latest state. (operation ${OP1})`,
  );
});

test("createVolume skips the optional site lookup on a 5xx", async () => {
  const { calls, client } = router([
    ["GET", /^\/compute\/sites$/, { status: 503, json: { detail: "down" } }],
    ["POST", /^\/block-storage\/volumes$/, (c) => ({ volume: { id: VOL, ...c.body } })],
  ]);
  await client.blockStorage.createVolume({ workspaceId: WS, name: "data-1", size_gb: 20, site_id: "site-1" });
  assert.equal(calls.at(-1).method, "POST");
  assert.equal("site_name" in calls.at(-1).body, false);
});

test("detachFromVm requires unmount confirmation and resolves the VM from the attachment", async () => {
  let vol = volume({ attachments: [{ node_name: "n", vm_id: VM2, vm_type: "gpu" }] });
  const { calls, client } = router([
    ["GET", /^\/block-storage\/volumes\//, () => vol],
    ["POST", /\/actions\/detach-volume$/, ACCEPTED],
    ["GET", /^\/compute\/operations\//, { ...ACCEPTED, status: "succeeded" }],
  ]);
  await assert.rejects(
    client.blockStorage.detachFromVm({ workspaceId: WS, volumeId: VOL }),
    isValidation("confirmation_required", /Unmount the volume inside the server/),
  );
  assert.equal(calls.length, 0);
  const res = await client.blockStorage.detachFromVm({ workspaceId: WS, volumeId: VOL, confirmUnmounted: true, wait: true });
  assert.equal(res.operation.status, "succeeded");
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post.path, `/compute/gpu-vms/${VM2}/actions/detach-volume`);
  assert.deepEqual(post.body, { volume_id: VOL, confirm_unmounted: true, force: false });
  assert.match(post.headers.get("x-idempotency-key"), /^gpu-vm-detach-volume-/);

  await assert.rejects(
    client.blockStorage.detachFromVm({ workspaceId: WS, volumeId: VOL, vmId: VM1, force: true }),
    isValidation("volume_not_attached"),
  );
  vol = volume({ attachments: [{ node_name: "a", vm_id: VM1 }, { node_name: "b", vm_id: VM2 }] });
  await assert.rejects(
    client.blockStorage.detachFromVm({ workspaceId: WS, volumeId: VOL, force: true }),
    isValidation("ambiguous_attachment", /pass vmId/),
  );
  vol = volume({ attachments: [{ node_name: "a" }] });
  await assert.rejects(
    client.blockStorage.detachFromVm({ workspaceId: WS, volumeId: VOL, force: true }),
    isValidation("attachment_without_vm", /no VM ID/),
  );
  vol = volume({ attachments: [] });
  await assert.rejects(
    client.blockStorage.detachFromVm({ workspaceId: WS, volumeId: VOL, force: true }),
    isValidation("volume_not_attached", /not attached to any server/),
  );
});

test("resolveSingleAttachment matches by VM or node", () => {
  const vol = { attachments: [{ node_name: "a", vm_id: VM1 }, { node_name: "b", vm_id: VM2 }] };
  assert.equal(resolveSingleAttachment(vol, { vmId: VM2 }).node_name, "b");
  assert.equal(resolveSingleAttachment(vol, { nodeName: "a" }).vm_id, VM1);
  assert.throws(() => resolveSingleAttachment(vol), isValidation("ambiguous_attachment"));
});

// ----------------------------------------------------------- object storage

test("bucket name, region and retention rules follow the portal", () => {
  assert.equal(validateBucketName(" my-bucket-1 "), "my-bucket-1");
  assert.throws(() => validateBucketName("ab"), isValidation("invalid_bucket_name", /at least 3 characters/));
  assert.throws(() => validateBucketName("a".repeat(64)), isValidation("invalid_bucket_name", /less than 63/));
  for (const bad of ["My-Bucket", "-abc", "abc-", "a_b_c", "a.b.c"]) {
    assert.throws(() => validateBucketName(bad), isValidation("invalid_bucket_name", /start and end with a letter or number/), bad);
  }
  assert.equal(resolveObjectStorageRegion(undefined, IbeeEnvironment.PRODUCTION), "in-south-1");
  assert.equal(resolveObjectStorageRegion(undefined, IbeeEnvironment.DEVELOPMENT), "in-south-2");
  assert.equal(resolveObjectStorageRegion(" eu-1 ", "http://localhost:8080/v1"), "eu-1");
  assert.throws(() => resolveObjectStorageRegion(undefined, "http://localhost:8080/v1"), isValidation("invalid_region"));

  assert.deepEqual(
    buildBucketCreateBody({ name: "logs", region: "r", defaultRetention: { mode: "COMPLIANCE", years: 2 } }),
    { name: "logs", region: "r", object_lock_enabled: true, default_retention: { mode: "COMPLIANCE", years: 2 } },
  );
  const bad = [
    [{ defaultRetention: { mode: "GOVERNANCE", days: 1 }, objectLockEnabled: false }, /must be true when default_retention/],
    [{ defaultRetention: { mode: "NONE", days: 1 } }, /mode/],
    [{ defaultRetention: { mode: "GOVERNANCE" } }, /exactly one of days or years/],
    [{ defaultRetention: { mode: "GOVERNANCE", days: 1, years: 1 } }, /exactly one of days or years/],
    [{ defaultRetention: { mode: "GOVERNANCE", days: 0 } }, /days/],
    [{ defaultRetention: { mode: "GOVERNANCE", days: 1.5 } }, /days/],
    [{ defaultRetention: { mode: "GOVERNANCE", years: 101 } }, /years/],
    [{ tags: "a" }, /tags/],
  ];
  for (const [extra, pattern] of bad) {
    assert.throws(() => buildBucketCreateBody({ name: "logs", region: "r", ...extra }), isValidation(undefined, pattern), JSON.stringify(extra));
  }
});

test("createBucket defaults the region per environment and can preflight billing", async () => {
  const { calls, client } = router([
    ["POST", /^\/billing\/resource-eligibility$/, { allowed: true, organization_id: "o", reason: "ok", sku_code: "OBJECTST-STD" }],
    ["POST", /^\/object-storage\/buckets$/, (c) => ({ ...c.body })],
  ]);
  await client.objectStorage.createBucket({ workspaceId: WS, name: "assets", preflightBilling: true });
  assert.deepEqual(sent(calls), ["POST /billing/resource-eligibility", "POST /object-storage/buckets"]);
  assert.deepEqual(calls[0].body, { sku_code: "OBJECTST-STD" });
  assert.deepEqual(calls[1].body, { name: "assets", region: "in-south-1" });
  await assert.rejects(client.objectStorage.createBucket({ workspaceId: WS, name: "Assets" }), isValidation("invalid_bucket_name"));
  assert.equal(calls.length, 2);

  const dev = router([["POST", /^\/object-storage\/buckets$/, {}]], { environment: IbeeEnvironment.DEVELOPMENT });
  await dev.client.objectStorage.createBucket({ workspaceId: WS, name: "assets", isPublic: false });
  assert.deepEqual(dev.calls[0].body, { name: "assets", region: "in-south-2", is_public: false });
});

test("bucket create billing denial and storage lifecycle errors are typed", async () => {
  const { client } = router([
    ["POST", /^\/object-storage\/buckets$/, { status: 402, json: { error: "billing_denied", billing_reason: "insufficient_balance", billing_sku_code: "OBJECTST-STD" } }],
    ["POST", /^\/object-storage\/credentials$/, { status: 403, json: { detail: "Storage namespace changes are restricted" } }],
  ]);
  await assert.rejects(client.objectStorage.createBucket({ workspaceId: WS, name: "assets" }), (err) =>
    err instanceof BillingDeniedError && err.reason === "insufficient_balance" && /object storage bucket/.test(err.message));
  await assert.rejects(client.objectStorage.createS3Credential({ workspaceId: WS }), OrganizationRestrictedError);
});

test("deleteBucket runs the portal pre-checks", async () => {
  let bucket = { name: "assets", bucket_lock_enabled: true, object_count: 0 };
  const { calls, client } = router([
    ["GET", /^\/object-storage\/buckets\/assets$/, () => bucket],
    ["DELETE", /^\/object-storage\/buckets\/assets$/, { detail: "Bucket deleted" }],
  ]);
  await assert.rejects(client.objectStorage.deleteBucket({ workspaceId: WS, bucketName: "assets" }), isValidation("bucket_object_lock", /Object Lock is enabled/));
  await assert.rejects(
    client.objectStorage.deleteBucket({ workspaceId: WS, bucketName: "assets", skipPreflight: true }),
    isValidation("bucket_object_lock"),
  );
  bucket = { name: "assets", bucket_lock_enabled: false, object_count: 3 };
  await assert.rejects(
    client.objectStorage.deleteBucket({ workspaceId: WS, bucketName: "assets" }),
    isValidation("bucket_not_empty", /Bucket is not empty \(3 objects\)/),
  );
  const res = await client.objectStorage.deleteBucket({ workspaceId: WS, bucketName: " assets ", skipPreflight: true });
  assert.equal(res.detail, "Bucket deleted");
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
  await assert.rejects(client.objectStorage.getBucket({ workspaceId: WS, bucketName: " " }), isValidation("invalid_bucket_name"));
  await assert.rejects(
    client.objectStorage.updateBucket({ workspaceId: WS, bucketName: "assets", isPublic: "yes" }),
    isValidation("invalid_is_public"),
  );
});

test("listBuckets validates paging and listAllBuckets follows continuation tokens", async () => {
  const { calls, client } = router([
    ["GET", /^\/object-storage\/buckets$/, (c) =>
      c.query.get("continuation_token") === "t2"
        ? { buckets: [{ name: "c" }], is_truncated: false }
        : { buckets: [{ name: "a" }, { name: "b" }], is_truncated: true, next_continuation_token: "t2" }],
  ]);
  const all = await client.objectStorage.listAllBuckets({ workspaceId: WS, pageSize: 2 });
  assert.deepEqual(all.map((b) => b.name), ["a", "b", "c"]);
  assert.equal(calls.length, 2);
  await assert.rejects(client.objectStorage.listBuckets({ workspaceId: WS, limit: 0 }), isValidation("invalid_limit"));
  await assert.rejects(client.objectStorage.listBuckets({ workspaceId: WS, continuationToken: " " }), isValidation("invalid_continuation_token"));
});

test("S3 credential rules match the portal and the create is never retried", async () => {
  assert.deepEqual(buildS3CredentialBody({}), {
    name: "Default Key", permission_type: "admin_rw", bucket_scope: "all", allowed_buckets: [],
  });
  assert.deepEqual(
    buildS3CredentialBody({ name: " ci ", permissionType: "object_ro", bucketScope: "specific", allowedBuckets: [" a ", "", "a", "b"] }),
    { name: "ci", permission_type: "object_ro", bucket_scope: "specific", allowed_buckets: ["a", "b"] },
  );
  assert.throws(() => buildS3CredentialBody({ name: " " }), isValidation("invalid_name", /Please enter a credential name/));
  assert.throws(() => buildS3CredentialBody({ name: "x".repeat(101) }), isValidation("invalid_name"));
  assert.throws(() => buildS3CredentialBody({ permissionType: "owner" }), isValidation("invalid_permission_type"));
  assert.throws(() => buildS3CredentialBody({ bucketScope: "specific", allowedBuckets: ["a"] }), isValidation("invalid_bucket_scope"));
  assert.throws(() => buildS3CredentialBody({ allowedBuckets: ["a"] }), isValidation("invalid_bucket_scope"));
  assert.throws(() => buildS3CredentialBody({ permissionType: "object_rw", bucketScope: "specific" }), isValidation("invalid_allowed_buckets", /at least one bucket/));
  assert.throws(() => buildS3CredentialBody({ permissionType: "object_rw", allowedBuckets: ["a"] }), isValidation("invalid_allowed_buckets"));
  assert.equal(s3EndpointForWorkspace(WS), `https://${WS}.blob.ibeestorage.com`);

  const { calls, client } = router(
    [
      ["POST", /^\/object-storage\/credentials$/, { status: 503, json: { detail: "busy" } }],
      ["DELETE", /^\/object-storage\/credentials\/AK%2F1$/, { success: true, message: "deleted" }],
    ],
    { maxRetries: 2 },
  );
  await assert.rejects(client.objectStorage.createS3Credential({ workspaceId: WS, name: "ci" }), ServiceUnavailableError);
  assert.equal(calls.length, 1, "the one-time secret is never put at risk by a retry");
  assert.deepEqual(calls[0].body, { name: "ci", permission_type: "admin_rw", bucket_scope: "all", allowed_buckets: [] });
  const res = await client.objectStorage.deleteS3Credential({ workspaceId: WS, accessKeyId: "AK/1" });
  assert.equal(res.success, true);
  await assert.rejects(client.objectStorage.revokeS3Credential({ workspaceId: WS, accessKeyId: " " }), isValidation("invalid_access_key_id"));
});

// ---------------------------------------------------------------------- CDN

test("distribution create/update validate fields and can check the origin bucket", async () => {
  let bucket = { name: "assets", is_public: false };
  const { calls, client } = router([
    ["GET", /^\/object-storage\/buckets\/assets$/, () => bucket],
    ["POST", /^\/billing\/resource-eligibility$/, { allowed: true, organization_id: "o", reason: "ok" }],
    ["POST", /^\/cdn\/distributions$/, (c) => ({ id: "d1", ...c.body })],
    ["PATCH", /^\/cdn\/distributions\/d1$/, (c) => ({ id: "d1", ...c.body })],
  ]);
  await assert.rejects(
    client.cdn.createDistribution({ workspaceId: WS, name: " site ", origin_id: "assets", checkOriginPublic: true }),
    isValidation("origin_not_public", /Only public buckets/),
  );
  bucket = { name: "assets", is_public: true };
  await client.cdn.createDistribution({ workspaceId: WS, name: " site ", origin_id: " assets ", checkOriginPublic: true, preflightBilling: true, cache_policy: "media" });
  assert.deepEqual(calls.at(-1).body, { name: "site", origin_type: "bucket", origin_id: "assets", cache_policy: "media" });
  assert.deepEqual(calls.at(-2).body, {}, "CDN preflight has no SKU, like the portal");
  const n = calls.length;
  await assert.rejects(client.cdn.createDistribution({ workspaceId: WS, name: " ", origin_id: "a" }), isValidation("invalid_name", /Please enter a name/));
  await assert.rejects(client.cdn.createDistribution({ workspaceId: WS, name: "a", origin_id: " " }), isValidation("invalid_origin_id", /select a bucket/));
  await assert.rejects(client.cdn.createDistribution({ workspaceId: WS, name: "a", origin_id: "b", cache_policy: "public-development" }), isValidation("invalid_cache_policy"));
  await assert.rejects(client.cdn.createDistribution({ workspaceId: WS, name: "a", origin_id: "b", origin_type: "s3" }), isValidation("invalid_origin_type"));
  await assert.rejects(client.cdn.updateDistribution({ workspaceId: WS, distributionId: "d1" }), isValidation("no_changes"));
  await assert.rejects(client.cdn.updateDistribution({ workspaceId: WS, distributionId: "d1", name: "x".repeat(129) }), isValidation("invalid_name"));
  assert.equal(calls.length, n);
  await client.cdn.updateDistribution({ workspaceId: WS, distributionId: "d1", enabled: false, cache_policy: "short" });
  assert.deepEqual(calls.at(-1).body, { cache_policy: "short", enabled: false });
});

test("purge bodies follow the portal and backend rules", () => {
  assert.deepEqual(buildCdnPurgeBody({ mode: "all" }), { mode: "all" });
  assert.deepEqual(buildCdnPurgeBody({ mode: "url", paths: "img/a.png, /b.css\nhttps://cdn.example.com/c" }), {
    mode: "url", paths: ["/img/a.png", "/b.css", "https://cdn.example.com/c"],
  });
  assert.deepEqual(buildCdnPurgeBody({ mode: "hostname", hostnames: [" CDN.Example.com "] }), { mode: "hostname", hostnames: ["cdn.example.com"] });
  assert.deepEqual(buildCdnPurgeBody({ mode: "tag", tags: ["a", " "] }), { mode: "tag", tags: ["a"] });
  const bad = [
    [{ mode: "everything" }, "invalid_mode"],
    [{ mode: "all", paths: ["/a"] }, "invalid_purge_selector"],
    [{ mode: "url" }, "invalid_paths"],
    [{ mode: "url", tags: ["x"], paths: ["/a"] }, "invalid_purge_selector"],
    [{ mode: "url", paths: Array.from({ length: 31 }, (_, i) => `/p${i}`) }, "invalid_paths"],
    [{ mode: "url", paths: ["http://cdn.example.com/a"] }, "invalid_paths"],
    [{ mode: "url", paths: ["https://cdn.example.com/a#x"] }, "invalid_paths"],
    [{ mode: "url", paths: ["https://user:pw@cdn.example.com/a"] }, "invalid_paths"],
    [{ mode: "url", paths: 42 }, "invalid_paths"],
    [{ mode: "prefix", prefixes: ["/a?x=1"] }, "invalid_prefixes"],
    [{ mode: "tag", tags: Array.from({ length: 101 }, (_, i) => `t${i}`) }, "invalid_tags"],
    ["all", "invalid_request"],
  ];
  for (const [req, code] of bad) assert.throws(() => buildCdnPurgeBody(req), isValidation(code), JSON.stringify(req).slice(0, 80));
});

test("purgeCache raises IbeeCdnPurgeError when the CDN reports success false", async () => {
  let result = { success: false, mode: "tag", purged: null, message: "Cache purge failed" };
  const { calls, client } = router([["POST", /\/purge$/, () => result]]);
  const purge = (extra = {}) => client.cdn.purgeCache({ workspaceId: WS, distributionId: "d1", request: { mode: "tag", tags: ["v1"] }, ...extra });
  await assert.rejects(purge(), (err) =>
    err instanceof IbeeCdnPurgeError && err instanceof CdnPurgeFailedError && err.mode === "tag" &&
    err.code === "cdn_purge_failed" && err.statusCode === 200 && err.message === "Cache purge failed");
  assert.equal((await purge({ raiseOnFailure: false })).success, false);
  result = { success: true, mode: "tag", purged: ["v1"] };
  assert.deepEqual((await purge()).purged, ["v1"]);
  assert.deepEqual(calls[0].body, { mode: "tag", tags: ["v1"] });
});

test("website, domain, URL and metrics inputs are validated", async () => {
  assert.equal(validateCdnIndexDocument(undefined), "index.html");
  assert.equal(validateCdnIndexDocument(" app/index.html "), "app/index.html");
  for (const bad of ["/index.html", "a\\b.html", "a//b.html", "./a.html", "a/../b", "ínđex.html", "a".repeat(1025)]) {
    assert.throws(() => validateCdnIndexDocument(bad), isValidation("invalid_index_document"), bad);
  }
  assert.equal(normalizeCdnDomain(" CDN.Example.COM ", { create: true }), "cdn.example.com");
  assert.throws(() => normalizeCdnDomain("localhost", { create: true }), isValidation("invalid_domain", /must include a subdomain/));
  assert.throws(() => normalizeCdnDomain("bad_domain.com", { create: true }), isValidation("invalid_domain"));
  assert.throws(() => normalizeCdnDomain("-a.com", { create: true }), isValidation("invalid_domain"));
  assert.equal(normalizeCdnDomain(" Legacy "), "legacy");

  const { calls, client } = router([
    ["PUT", /website-config$/, (c) => ({ enabled: true, ...c.body })],
    ["POST", /^\/billing\/resource-eligibility$/, (c) => ({ allowed: true, organization_id: "o", reason: "ok", sku_code: c.body.sku_code })],
    ["POST", /custom-domains$/, (c) => ({ ...c.body, status: "pending_validation" })],
    ["GET", /custom-domains\/cdn\.example\.com$/, { domain: "cdn.example.com" }],
    ["POST", /^\/cdn\/generate-url$/, { cdn_url: "u" }],
    ["GET", /^\/cdn\/distributions\/cache-policies$/, { policies: [{ id: "static-assets" }] }],
    ["GET", /^\/cdn\/distributions\/d1\/metrics$/, { distribution_id: "d1" }],
  ]);
  await client.cdn.updateWebsiteConfig({ workspaceId: WS, distributionId: "d1" });
  assert.deepEqual(calls[0].body, { index_document: "index.html" });
  await client.cdn.createCustomDomain({ workspaceId: WS, distributionId: "d1", domain: "CDN.example.com", preflightBilling: true });
  assert.deepEqual(calls[1].body, { sku_code: "CUSTOMDO-STD", estimated_cost_minor: 19900 });
  assert.deepEqual(calls[2].body, { domain: "cdn.example.com" });
  await client.cdn.getCustomDomain({ workspaceId: WS, distributionId: "d1", domain: " CDN.example.com " });
  assert.equal(calls[3].path, "/cdn/distributions/d1/custom-domains/cdn.example.com");
  await client.cdn.generateUrl({ workspaceId: WS, bucket_name: " assets ", object_key: "a.png", expires_in: 60 });
  assert.deepEqual(calls[4].body, { bucket_name: "assets", object_key: "a.png", expires_in: 60 });
  const policies = await client.cdn.listCachePolicies({ workspaceId: WS });
  assert.equal(policies.policies[0].id, "static-assets");
  await client.cdn.getDistributionMetrics({ workspaceId: WS, distributionId: "d1" });
  assert.equal(calls.at(-1).query.get("range"), "24h");
  await client.cdn.getDistributionMetrics({ workspaceId: WS, distributionId: "d1", range: "30d" });
  assert.equal(calls.at(-1).query.get("range"), "30d");
  const n = calls.length;
  await assert.rejects(client.cdn.getDistributionMetrics({ workspaceId: WS, distributionId: "d1", range: "1h" }), isValidation("invalid_range"));
  await assert.rejects(client.cdn.generateUrl({ workspaceId: WS, bucket_name: "a", object_key: "k", expires_in: 0 }), isValidation("invalid_expires_in"));
  await assert.rejects(client.cdn.generateUrl({ workspaceId: WS, bucket_name: "a", object_key: "k", disposition: "download" }), isValidation("invalid_disposition"));
  await assert.rejects(client.cdn.generateUrl({ workspaceId: WS, bucket_name: " ", object_key: "k" }), isValidation("invalid_bucket_name"));
  await assert.rejects(client.cdn.updateWebsiteConfig({ workspaceId: WS, distributionId: "d1", request: { index_document: "/x" } }), isValidation("invalid_index_document"));
  await assert.rejects(client.cdn.getDistribution({ workspaceId: WS, distributionId: " " }), isValidation("invalid_distribution_id"));
  assert.equal(calls.length, n);
});

test("waitForCustomDomain polls verify until active or failed and times out with the last status", async () => {
  const statuses = ["pending_validation", "pending_tls", "active"];
  const { calls, client } = router([
    ["POST", /\/verify$/, () => ({ domain: "cdn.example.com", status: statuses.shift() ?? "pending_tls", message: "DNS records not yet propagated." })],
  ]);
  const res = await client.cdn.waitForCustomDomain({ workspaceId: WS, distributionId: "d1", domain: "CDN.example.com", pollIntervalMs: 1 });
  assert.equal(res.status, "active");
  assert.equal(calls.length, 3);
  await assert.rejects(
    client.cdn.waitForCustomDomain({ workspaceId: WS, distributionId: "d1", domain: "cdn.example.com", pollIntervalMs: 5, timeoutMs: 12 }),
    (err) => err instanceof CdnDomainVerificationTimeoutError && err.lastStatus === "pending_tls" && err.domain === "cdn.example.com",
  );
});

test("storage 403 on the CDN routes is a ForbiddenError", async () => {
  const { client } = router([["GET", /^\/cdn\/distributions$/, { status: 403, json: { error: "insufficient_scope", required_scope: "cdn.read" } }]]);
  await assert.rejects(client.cdn.listDistributions({ workspaceId: WS }), ForbiddenError);
});

test("listAllVolumes rejects invalid input asynchronously", async () => {
  const { calls, client } = router([]);
  const p = client.blockStorage.listAllVolumes({ workspaceId: "abc" });
  assert.ok(p instanceof Promise);
  await assert.rejects(p, isValidation("invalid_workspace_id"));
  await assert.rejects(client.blockStorage.listAllVolumes({ workspaceId: WS, pageSize: 5000 }), isValidation("invalid_limit"));
  assert.equal(calls.length, 0);
});
