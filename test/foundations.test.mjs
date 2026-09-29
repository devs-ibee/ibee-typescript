import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiError,
  ApiKeyInactiveError,
  BadGatewayError,
  BillingAdmissionError,
  BillingDeniedError,
  BillingForbiddenError,
  ConflictError,
  ForbiddenError,
  GatewayTimeoutError,
  Ibee,
  IbeeEnvironment,
  IbeeError,
  IbeeValidationError,
  InsufficientScopeError,
  InvalidWorkspaceError,
  NotFoundError,
  OperationFailedError,
  OperationTimeoutError,
  OrganizationRestrictedError,
  OrganizationSuspendedError,
  PaymentRequiredError,
  RouteNotAvailableError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  UnprocessableEntityError,
  VERSION,
  WorkspaceNotAllowedError,
  apiErrorFromResponse,
  billingBlockMessage,
  buildIdempotencyKey,
  buildStableIdempotencyKey,
  environmentFromName,
  estimateEligibilityCostMinor,
  isBillingTopupAllowed,
  isPaymentBlockError,
  isRetrySafe,
  minimumTopupMinor,
  paginateOffset,
  paginatePages,
  collect,
  pollUntil,
  resolveBaseUrl,
  retryDelayMs,
  waitForComputeOperation,
} from "../dist/index.js";
import * as cjs from "../dist/index.cjs";

const WS = "710995";
const VM1 = "64b0000000000000000000a1";
const OP1 = "op_64b0000000000000000000f1";

/**
 * Fetch mock that answers from a queue of responses (the last one repeats).
 * Each entry: { status, json, text, headers, throws }.
 */
function scripted(...responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body,
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r.throws) throw r.throws;
    const body = r.text !== undefined ? r.text : JSON.stringify(r.json ?? {});
    return new Response(body, {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  };
  return { calls, fetchImpl };
}

const client = (fetchImpl, extra = {}) => new Ibee({ token: "t", fetch: fetchImpl, ...extra });

// ------------------------------------------------------------- packaging

test("version is 0.4.1 and CJS build exports the same surface", () => {
  assert.equal(VERSION, "0.4.1");
  assert.equal(cjs.VERSION, "0.4.1");
  assert.equal(typeof cjs.IbeeValidationError, "function");
  assert.equal(typeof cjs.BillingDeniedError, "function");
  assert.equal(IbeeEnvironment.PRODUCTION, IbeeEnvironment.DEFAULT);
});

// ------------------------------------------------------------ validation

test("invalid workspace IDs raise IbeeValidationError (still an Error) before transport", async () => {
  const { calls, fetchImpl } = scripted({ json: [] });
  const c = client(fetchImpl);
  for (const workspaceId of ["", "0", "01", "abc", 710995, undefined]) {
    await assert.rejects(c.cloudVms.list({ workspaceId }), (err) => {
      assert.ok(err instanceof IbeeValidationError);
      assert.ok(err instanceof IbeeError);
      assert.ok(err instanceof Error);
      assert.equal(err.code, "invalid_workspace_id");
      assert.equal(err.field, "workspace_id");
      assert.equal(err.message, "workspace_id must be a positive numeric string (for example, '710995').");
      return true;
    });
  }
  assert.equal(calls.length, 0);
});

test("token/environment mismatch is rejected at construction", () => {
  const check = (opts) =>
    assert.throws(() => new Ibee(opts), (err) => {
      assert.ok(err instanceof IbeeValidationError);
      assert.equal(err.code, "token_environment_mismatch");
      assert.equal(err.message, "The API token environment does not match the configured IBEE endpoint.");
      return true;
    });
  check({ token: "ibee_dev_key_abc.secret" });
  check({ token: "ibee_dev_key_abc.secret", baseUrl: "https://API.ibee.ai./v1" });
  check({ token: "ibee_prod_key_abc.secret", environment: IbeeEnvironment.DEVELOPMENT });
  // Matching and unknown combinations pass.
  new Ibee({ token: "ibee_prod_key_abc.secret" });
  new Ibee({ token: "ibee_dev_key_abc.secret", environment: IbeeEnvironment.DEVELOPMENT });
  new Ibee({ token: "ibee_dev_key_abc.secret", baseUrl: "http://localhost:8080/v1" });
  new Ibee({ token: "test-token" });
});

test("tokens must be non-empty and free of line breaks", () => {
  for (const token of ["", "   ", "abc\r\nX-Evil: 1", "abc\n"]) {
    assert.throws(() => new Ibee({ token }), (err) => err instanceof IbeeValidationError && err.code === "invalid_token");
  }
  assert.throws(() => new Ibee({ token: "" }), /token is required/i);
});

test("base URL safety rules", () => {
  assert.equal(resolveBaseUrl(), "https://api.ibee.ai/v1");
  assert.equal(resolveBaseUrl(undefined, IbeeEnvironment.DEVELOPMENT), "https://api.ibee.co.in/v1");
  assert.equal(resolveBaseUrl("https://gw.example.test/v1/", IbeeEnvironment.DEVELOPMENT), "https://gw.example.test/v1");
  assert.equal(resolveBaseUrl("http://localhost:8080/v1"), "http://localhost:8080/v1");
  assert.equal(resolveBaseUrl("http://127.0.0.1/v1"), "http://127.0.0.1/v1");
  for (const bad of [
    "api.ibee.ai/v1",
    "ftp://api.ibee.ai/v1",
    "http://api.ibee.ai/v1",
    "https://user:pw@api.ibee.ai/v1",
    "https://api.ibee.ai/v1?x=1",
    "https://api.ibee.ai/v1#frag",
    "https://api.ibee.ai/v1/../admin",
    "https://api.ibee.ai/./v1",
  ]) {
    assert.throws(() => resolveBaseUrl(bad), (err) => err instanceof IbeeValidationError && err.code === "invalid_base_url", bad);
  }
  assert.throws(() => new Ibee({ token: "t", baseUrl: "http://api.example.test/v1" }), IbeeValidationError);
});

test("environmentFromName mirrors IBEE_ENV resolution", () => {
  assert.equal(environmentFromName("DEV "), IbeeEnvironment.DEVELOPMENT);
  assert.equal(environmentFromName("development"), IbeeEnvironment.DEVELOPMENT);
  assert.equal(environmentFromName(""), IbeeEnvironment.PRODUCTION);
  assert.equal(environmentFromName(undefined), IbeeEnvironment.PRODUCTION);
  assert.equal(environmentFromName("Production"), IbeeEnvironment.PRODUCTION);
  assert.throws(() => environmentFromName("staging"), (err) => err.code === "invalid_environment");
});

test("billable create bodies over 64 KiB are rejected before sending", async () => {
  const { calls, fetchImpl } = scripted({ json: {} });
  const c = client(fetchImpl);
  await assert.rejects(
    c.secretStore.createSecretStore({ workspaceId: WS, name: "x", description: "é".repeat(40_000) }),
    (err) => err instanceof IbeeValidationError && err.code === "request_body_too_large",
  );
  assert.equal(calls.length, 0);
  // Every Secret Store body is limited (the gateway buffers at most 64 KiB).
  await assert.rejects(
    c.secretStore.updateSecretStore({ workspaceId: WS, storeId: "s", description: "é".repeat(40_000) }),
    (err) => err instanceof IbeeValidationError && err.code === "request_body_too_large",
  );
  assert.equal(calls.length, 0);
  await c.secretStore.updateSecretStore({ workspaceId: WS, storeId: "s", description: "é".repeat(30_000) });
  assert.equal(calls.length, 1);
});

// --------------------------------------------------------------- errors

test("error bodies of every backend shape map to typed errors with stable codes", () => {
  const cases = [
    [400, { error: "invalid_workspace_id" }, InvalidWorkspaceError, "invalid_workspace_id"],
    [401, { error: "invalid_api_key" }, UnauthorizedError, "invalid_api_key"],
    [403, { error: "insufficient_scope", required_scope: "billing.read" }, InsufficientScopeError, "insufficient_scope"],
    [403, { error: "workspace_not_allowed" }, WorkspaceNotAllowedError, "workspace_not_allowed"],
    [403, { detail: "Workspace does not match API token context" }, WorkspaceNotAllowedError, "forbidden"],
    [403, { error: "key_revoked" }, ApiKeyInactiveError, "key_revoked"],
    [403, { error: "unknown_route" }, RouteNotAvailableError, "unknown_route"],
    [403, { error: { code: "FORBIDDEN", message: "Operation 'CREATE_RESOURCE' is not allowed while organization is SUSPENDED" } }, OrganizationRestrictedError, "forbidden"],
    [403, { detail: "Storage namespace is not active" }, OrganizationRestrictedError, "forbidden"],
    [403, { error: { code: "forbidden", message: "insufficient_balance" } }, BillingForbiddenError, "forbidden"],
    [403, { detail: "nope" }, ForbiddenError, "forbidden"],
    [404, { detail: { code: "NOT_FOUND", message: "BillingProfile not found: org1" } }, NotFoundError, "not_found"],
    [409, { detail: "VM name already exists" }, ConflictError, "conflict"],
    [422, { detail: [{ loc: ["body", "sku_code"], msg: "too long" }, { loc: ["query", "limit"], msg: "bad" }] }, UnprocessableEntityError, "validation_error"],
    [423, { detail: { code: "ORG_BILLING_SUSPENDED", message: "Organization is suspended by billing.", billing_state: "HARD_SUSPENDED", allowed_operations: ["billing_topup"] } }, OrganizationSuspendedError, "org_billing_suspended"],
    [429, { detail: "slow down" }, TooManyRequestsError, "rate_limited"],
    [502, { error: "invalid_billing_decision" }, BillingAdmissionError, "invalid_billing_decision"],
    [502, "upstream failed", BadGatewayError, "bad_gateway"],
    [503, { error: "workspace_verification_unavailable" }, ServiceUnavailableError, "workspace_verification_unavailable"],
    [504, {}, GatewayTimeoutError, "gateway_timeout"],
    [418, { code: "TEAPOT", reason: "r", message: "short and stout" }, ApiError, "teapot"],
  ];
  for (const [status, body, cls, code] of cases) {
    const err = apiErrorFromResponse(status, body);
    assert.ok(err instanceof cls, `${status} ${JSON.stringify(body)} -> ${err.name}`);
    assert.ok(err instanceof ApiError);
    assert.equal(err.statusCode, status);
    assert.deepEqual(err.body, body);
    assert.equal(err.code, code, JSON.stringify(body));
  }
  const scope = apiErrorFromResponse(403, { error: "insufficient_scope", required_scope: "billing.read" });
  assert.equal(scope.requiredScope, "billing.read");
  assert.match(scope.message, /billing\.read/);
  assert.equal(apiErrorFromResponse(422, cases[13][1]).message, "sku_code: too long, limit: bad");
  const restricted = apiErrorFromResponse(403, cases[7][1]);
  assert.equal(restricted.state, "SUSPENDED");
  assert.equal(restricted.operation, "CREATE_RESOURCE");
  const suspended = apiErrorFromResponse(423, cases[14][1]);
  assert.equal(suspended.billingState, "HARD_SUSPENDED");
  assert.deepEqual(suspended.allowedOperations, ["billing_topup"]);
  assert.equal(apiErrorFromResponse(418, cases[20][1]).reason, "r");
  assert.equal(apiErrorFromResponse(500, undefined).message, "IBEE API error 500");
  assert.equal(apiErrorFromResponse(418, undefined).code, "http_418");
  assert.equal(apiErrorFromResponse(403, cases[9][1]).reason, "insufficient_balance");
});

test("edge 402 billing_denied becomes BillingDeniedError with portal copy and request metadata", async () => {
  const { fetchImpl } = scripted({
    status: 402,
    json: {
      error: "billing_denied",
      required_scope: null,
      billing_reason: "insufficient_balance",
      billing_sku_code: "STANDARD-2-8-50",
      admission_context_id: "adm-1",
    },
    headers: { "x-request-id": "req-9" },
  });
  const c = client(fetchImpl);
  await assert.rejects(
    c.cloudVms.create({
      workspaceId: WS, idempotencyKey: "my-key", name: "web", site_id: "s1", plan_id: "p", template_id: "i",
      os_distro: "ubuntu", os_type: "linux", cpu: 2, ram_mb: 4096, resolveCatalog: false, disk_gb: 50,
      billing_catalog: { sku_id: 1, sku_code: "STANDARD-2-8-50" },
    }),
    (err) => {
      assert.ok(err instanceof BillingDeniedError);
      assert.ok(err instanceof PaymentRequiredError);
      assert.equal(err.statusCode, 402);
      assert.equal(err.code, "billing_denied");
      assert.equal(err.reason, "insufficient_balance");
      assert.equal(err.skuCode, "STANDARD-2-8-50");
      assert.equal(err.admissionContextId, "adm-1");
      assert.equal(err.requestId, "req-9");
      assert.equal(err.idempotencyKey, "my-key");
      assert.equal(err.topupAllowed, true);
      assert.equal(err.message, "Your available wallet balance does not cover this cloud VM. Add credits and try again.");
      assert.ok(isPaymentBlockError(err));
      return true;
    },
  );
});

test("isPaymentBlockError follows the portal rules without the bare 'balance' match", () => {
  assert.equal(isPaymentBlockError(apiErrorFromResponse(402, {})), true);
  assert.equal(isPaymentBlockError({ code: "INSUFFICIENT_FUNDS" }), true);
  assert.equal(isPaymentBlockError(new Error("Please top up your wallet")), true);
  assert.equal(isPaymentBlockError(new Error("Add a payment method")), true);
  assert.equal(isPaymentBlockError(new Error("load balancer not found")), false);
  assert.equal(isPaymentBlockError(null), false);
});

// ---------------------------------------------------------------- retries

test("GET is retried on 503 honouring Retry-After and succeeds", async () => {
  const { calls, fetchImpl } = scripted(
    { status: 503, json: { detail: "busy" }, headers: { "retry-after": "0" } },
    { status: 429, json: {}, headers: { "retry-after-ms": "0" } },
    { json: { buckets: [] } },
  );
  const out = await client(fetchImpl).objectStorage.listBuckets({ workspaceId: WS });
  assert.deepEqual(out, { buckets: [] });
  assert.equal(calls.length, 3);
});

test("retries stop after maxRetries and surface the typed error", async () => {
  const { calls, fetchImpl } = scripted({ status: 502, json: {}, headers: { "retry-after": "0" } });
  await assert.rejects(
    client(fetchImpl, { maxRetries: 1 }).objectStorage.listBuckets({ workspaceId: WS }),
    BadGatewayError,
  );
  assert.equal(calls.length, 2);
});

test("500, 408 and 409 are never retried; maxRetries 0 disables retries", async () => {
  for (const status of [500, 408, 409]) {
    const { calls, fetchImpl } = scripted({ status, json: {}, headers: { "retry-after": "0" } });
    await assert.rejects(client(fetchImpl).objectStorage.listBuckets({ workspaceId: WS }), ApiError);
    assert.equal(calls.length, 1, String(status));
  }
  const { calls, fetchImpl } = scripted({ status: 503, json: {}, headers: { "retry-after": "0" } });
  await assert.rejects(client(fetchImpl, { maxRetries: 0 }).objectStorage.listBuckets({ workspaceId: WS }), ServiceUnavailableError);
  assert.equal(calls.length, 1);
});

test("unkeyed POST is not retried; keyed VM write is retried with the same key and body", async () => {
  {
    const { calls, fetchImpl } = scripted({ status: 503, json: {}, headers: { "retry-after": "0" } });
    await assert.rejects(client(fetchImpl).secretStore.createSecretStore({ workspaceId: WS, name: "a" }), ServiceUnavailableError);
    assert.equal(calls.length, 1);
  }
  {
    const { calls, fetchImpl } = scripted(
      { status: 504, json: {}, headers: { "retry-after": "0" } },
      { json: { operation_id: OP1 } },
    );
    await client(fetchImpl).cloudVms.start({ workspaceId: WS, vmId: VM1 });
    assert.equal(calls.length, 2);
    const k1 = calls[0].headers.get("x-idempotency-key");
    assert.match(k1, new RegExp(`^cloud-vm-start-${VM1}-[a-z0-9]+-[0-9a-f]{16}$`));
    assert.equal(calls[1].headers.get("x-idempotency-key"), k1);
  }
  {
    const { calls, fetchImpl } = scripted(
      { status: 503, json: {}, headers: { "retry-after": "0" } },
      { json: {} },
    );
    await client(fetchImpl).blockStorage.resizeVolume({ workspaceId: WS, volumeId: "64b0000000000000000000b1", request: { new_size_gb: 20 }, checkState: false });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body, calls[1].body);
  }
});

test("transport errors are retried only for retry-safe requests and carry the key", async () => {
  {
    const { calls, fetchImpl } = scripted({ throws: new TypeError("fetch failed") }, { json: [] });
    await client(fetchImpl).firewalls.listGroups({ workspaceId: WS, limit: 10 });
    assert.equal(calls.length, 2);
  }
  {
    const { calls, fetchImpl } = scripted({ throws: new TypeError("fetch failed") });
    await assert.rejects(
      client(fetchImpl).secretStore.createSecretStore({ workspaceId: WS, name: "a" }),
      TypeError,
    );
    assert.equal(calls.length, 1);
  }
  {
    const { calls, fetchImpl } = scripted({ throws: new TypeError("fetch failed") });
    await assert.rejects(
      client(fetchImpl, { maxRetries: 0 }).cloudVms.delete({ workspaceId: WS, vmId: VM1, idempotencyKey: "del-1", publicIpAction: "release" }),
      (err) => err instanceof TypeError && err.idempotencyKey === "del-1",
    );
    assert.equal(calls.length, 1);
  }
});

test("isRetrySafe and retryDelayMs follow the policy", () => {
  const key = { "X-Idempotency-Key": "k" };
  assert.equal(isRetrySafe("GET", "/anything"), true);
  // VM create is never retried: a keyed replay can surface as a name conflict.
  assert.equal(isRetrySafe("POST", "/compute/cloud-vms", key), false);
  assert.equal(isRetrySafe("POST", "/compute/gpu-vms", key), false);
  assert.equal(isRetrySafe("PATCH", "/compute/gpu-vms/vm1/actions/resize-plan", key), true);
  assert.equal(isRetrySafe("DELETE", "/compute/cloud-vms/vm1", key), true);
  assert.equal(isRetrySafe("POST", "/compute/cloud-vms/vm1/actions/resize/precheck", key), false);
  assert.equal(isRetrySafe("POST", "/compute/cloud-vms"), false);
  assert.equal(isRetrySafe("POST", "/networking/reserved-ips", key), false);
  assert.equal(isRetrySafe("POST", "/block-storage/volumes", {}, { idempotency_key: "k" }), true);
  assert.equal(isRetrySafe("POST", "/block-storage/volumes/v1/detach", {}, { idempotency_key: " " }), false);
  assert.equal(isRetrySafe("DELETE", "/block-storage/volumes/v1", {}, undefined, { idempotency_key: "k" }), true);
  assert.equal(isRetrySafe("DELETE", "/block-storage/volumes/v1"), false);

  assert.equal(retryDelayMs(0, { "Retry-After": "2" }), 2000);
  assert.equal(retryDelayMs(0, { "Retry-After": "600" }), 30_000);
  assert.equal(retryDelayMs(0, { "retry-after-ms": "150" }), 150);
  const date = new Date(Date.now() + 5_000).toUTCString();
  const fromDate = retryDelayMs(0, { "retry-after": date });
  assert.ok(fromDate > 3_000 && fromDate <= 5_000, String(fromDate));
  assert.equal(retryDelayMs(0, {}, () => 0.5), 1000);
  assert.equal(retryDelayMs(1, {}, () => 1), 2200);
  assert.equal(retryDelayMs(10, {}, () => 1), 30_000);
});

// ------------------------------------------------------------ idempotency

test("buildIdempotencyKey matches the portal algorithm", () => {
  const key = buildIdempotencyKey("cloud-vm-start", "vm_123");
  assert.match(key, /^cloud-vm-start-vm_123-[0-9a-z]+-[0-9a-f]{16}$/);
  assert.notEqual(key, buildIdempotencyKey("cloud-vm-start", "vm_123"));
  // Unsafe characters are removed; long parts are trimmed with a hash.
  const long = buildIdempotencyKey("scope with spaces!", "a".repeat(200), "b/c");
  assert.ok(long.length <= 128);
  assert.match(long, /^[A-Za-z0-9_-]+$/);
  assert.match(long, /^scopewithspaces-/);
  assert.match(buildIdempotencyKey("", null), /^request-[0-9a-f]{16}$/);
  // Stable keys are deterministic (FNV-1a 32-bit, base 36).
  assert.equal(buildStableIdempotencyKey("topup", "UTR1"), buildStableIdempotencyKey("topup", "UTR1"));
  assert.equal(buildStableIdempotencyKey("x"), "x-empty");
  assert.equal(buildStableIdempotencyKey("a", "a"), `a-a-${(0xe40c292c >>> 0).toString(36)}`);
});

test("caller-supplied idempotency keys are validated", async () => {
  const { calls, fetchImpl } = scripted({ json: {} });
  const c = client(fetchImpl);
  for (const bad of ["", "has space", "x".repeat(129), "line\nbreak", "ümlaut"]) {
    await assert.rejects(
      c.cloudVms.reboot({ workspaceId: WS, vmId: VM1, idempotencyKey: bad }),
      (err) => err instanceof IbeeValidationError && err.code === "invalid_idempotency_key",
    );
    await assert.rejects(
      c.blockStorage.deleteVolume({ workspaceId: WS, volumeId: "64b0000000000000000000b1", idempotencyKey: bad }),
      IbeeValidationError,
    );
  }
  assert.equal(calls.length, 0);
  await c.blockStorage.detachVolume({
    workspaceId: WS, volumeId: "64b0000000000000000000b1", request: { node_name: "n", confirm_unmounted: true, idempotency_key: "from-body" },
  });
  assert.equal(JSON.parse(calls[0].body).idempotency_key, "from-body");
  await c.blockStorage.detachVolume({
    workspaceId: WS, volumeId: "64b0000000000000000000b1", idempotencyKey: "explicit", request: { node_name: "n", confirm_unmounted: true, idempotency_key: "from-body" },
  });
  assert.equal(JSON.parse(calls[1].body).idempotency_key, "explicit");
});

test("every VM write auto-fills a scoped key", async () => {
  const { calls, fetchImpl } = scripted({ json: { decision: "in_place" } });
  const c = client(fetchImpl);
  const vm = { workspaceId: WS, vmId: VM1 };
  const sku = { sku_id: 1, sku_code: "GPU-A100-1" };
  await c.gpuVms.create({
    workspaceId: WS, name: "trainer", site_id: "s1", plan_id: "p", template_id: "i", os_distro: "u",
    os_type: "linux", cpu: 1, ram_mb: 1024, gpu_count: 1, gpu_model: "A100", resolveCatalog: false, disk_gb: 50, billing_catalog: sku,
  });
  await c.gpuVms.delete({ ...vm, publicIpAction: "release" });
  await c.gpuVms.stop(vm);
  await c.gpuVms.updateAccess({ ...vm, request: { password_auth_enabled: true }, checkState: false });
  await c.gpuVms.resize({ ...vm, request: { cpu: 2 } });
  await c.gpuVms.resizePlan({ ...vm, request: { cpu: 2, ram_mb: 4096 } });
  await c.gpuVms.resizeRootDisk({ ...vm, request: { new_size_gb: 20 } });
  await c.gpuVms.attachVolume({ ...vm, checkState: false, volume: { vm_type: "gpu", attachments: [] }, request: { volume_id: "64b0000000000000000000b1", billing_catalog: { sku_id: 2, sku_code: "BLOCK-STD" } } });
  await c.gpuVms.detachVolume({ ...vm, request: { volume_id: "64b0000000000000000000b1", confirm_unmounted: true } });
  const scopes = calls
    .map((call) => call.headers.get("x-idempotency-key"))
    .filter(Boolean)
    .map((key) => key.split("-").slice(0, -2).join("-"));
  assert.deepEqual(scopes, [
    "gpu-vm-create-trainer", `gpu-vm-delete-${VM1}`, `gpu-vm-stop-${VM1}`, `gpu-vm-access-${VM1}`,
    `gpu-vm-resize-${VM1}`, `gpu-vm-resize-plan-${VM1}`, `gpu-vm-resize-root-disk-${VM1}`,
    // Long parts are trimmed to 48 characters with a hash suffix.
    "gpu-vm-attach-volume-64b0000000000000000000b1-64b0000000000000-418jzp",
    "gpu-vm-detach-volume-64b0000000000000000000b1-64b0000000000000-418jzp",
  ]);
});

// ------------------------------------------------------------- pagination

function pagedFetch(total, { duplicateAt } = {}) {
  const calls = [];
  const items = Array.from({ length: total }, (_, i) => ({ _id: `vm${i}`, name: `vm${i}` }));
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    const limit = Number(u.searchParams.get("limit") ?? 10);
    const offset = Number(u.searchParams.get("offset") ?? 0);
    let page = items.slice(offset, offset + limit);
    if (duplicateAt !== undefined && offset > 0) page = [items[duplicateAt], ...page.slice(1)];
    return new Response(JSON.stringify(page), { status: 200 });
  };
  return { calls, fetchImpl };
}

test("cloudVms.list auto-pages past the server's 10-item cap", async () => {
  const { calls, fetchImpl } = pagedFetch(250);
  const vms = await client(fetchImpl).cloudVms.list({ workspaceId: WS, search: "  web ", sortBy: "name", sortDirection: "asc" });
  assert.equal(vms.length, 250);
  assert.deepEqual(calls.map((u) => [u.searchParams.get("limit"), u.searchParams.get("offset")]), [
    ["100", "0"], ["100", "100"], ["100", "200"],
  ]);
  assert.equal(calls[0].searchParams.get("search"), "web");
  assert.equal(calls[0].searchParams.get("sort_by"), "name");
  assert.equal(calls[0].searchParams.get("sort_direction"), "asc");
  assert.equal(calls[0].searchParams.getAll("workspace_id").length, 1);
});

test("an explicit limit or offset fetches a single page", async () => {
  const { calls, fetchImpl } = pagedFetch(250);
  const page = await client(fetchImpl).gpuVms.list({ workspaceId: WS, limit: 11 });
  assert.equal(page.length, 11);
  assert.equal(calls.length, 1);
  assert.match(calls[0].pathname, /\/compute\/gpu-vms$/);
  const page2 = await client(fetchImpl).cloudVms.list({ workspaceId: WS, offset: 245 });
  assert.equal(calls[1].searchParams.get("limit"), null);
  assert.equal(page2.length, 5);
});

test("auto-paged results are de-duplicated", async () => {
  const { fetchImpl } = pagedFetch(150, { duplicateAt: 3 });
  const vms = await client(fetchImpl).cloudVms.list({ workspaceId: WS });
  assert.equal(vms.length, 149);
  assert.equal(new Set(vms.map((v) => v._id)).size, 149);
});

test("iterate yields lazily and firewall groups page too", async () => {
  const { calls, fetchImpl } = pagedFetch(120);
  const c = client(fetchImpl);
  let n = 0;
  for await (const vm of c.cloudVms.iterate({ workspaceId: WS })) {
    n += 1;
    if (n === 5) break;
    assert.ok(vm._id);
  }
  assert.equal(calls.length, 1);
  const groups = await c.firewalls.listGroups({ workspaceId: WS });
  assert.equal(groups.length, 120);
  assert.match(calls[1].pathname, /\/networking\/firewall-groups$/);
  assert.equal(calls[1].searchParams.get("summary"), null);
  assert.equal((await collect(c.firewalls.iterateGroups({ workspaceId: WS }))).length, 120);
});

test("list paging parameters are validated", async () => {
  const { calls, fetchImpl } = pagedFetch(1);
  const c = client(fetchImpl);
  const bad = [
    [{ limit: 0 }, "invalid_limit"], [{ limit: 101 }, "invalid_limit"], [{ limit: 1.5 }, "invalid_limit"],
    [{ offset: -1 }, "invalid_offset"], [{ search: "x".repeat(121) }, "invalid_search"],
    [{ sortBy: "size" }, "invalid_sort_by"], [{ sortDirection: "up" }, "invalid_sort_direction"],
  ];
  for (const [args, code] of bad) {
    await assert.rejects(c.cloudVms.list({ workspaceId: WS, ...args }), (err) => err.code === code, code);
  }
  await assert.rejects(c.firewalls.listGroups({ workspaceId: WS, limit: 500 }), (err) => err.code === "invalid_limit");
  assert.equal(calls.length, 0);
});

test("paginatePages stops at total", async () => {
  const seen = [];
  const items = await collect(paginatePages(async (page, limit) => {
    seen.push([page, limit]);
    const all = Array.from({ length: 5 }, (_, i) => i);
    return { stores: all.slice((page - 1) * limit, page * limit), total: 5 };
  }, { limit: 2, itemsKey: "stores" }));
  assert.deepEqual(items, [0, 1, 2, 3, 4]);
  assert.deepEqual(seen, [[1, 2], [2, 2], [3, 2]]);
  const capped = await collect(paginateOffset(async () => [{ id: Math.random() }], { pageSize: 1, maxItems: 3 }));
  assert.equal(capped.length, 3);
});

// ---------------------------------------------------------- operation wait

const op = (status, extra = {}) => ({
  operation_id: OP1, vm_id: VM1, action: "start", status,
  submitted_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:01Z", ...extra,
});

test("operations.wait returns on success and calls onUpdate", async () => {
  const { calls, fetchImpl } = scripted({ json: op("succeeded") });
  const updates = [];
  const c = client(fetchImpl);
  const result = await c.operations.wait({ workspaceId: WS, operationId: ` ${OP1} `, onUpdate: (o) => updates.push(o.status) });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(updates, ["succeeded"]);
  assert.match(calls[0].url, new RegExp(`/compute/operations/${OP1}\\?workspace_id=710995$`));
  const legacy = await waitForComputeOperation(client(scripted({ json: op("COMPLETED") }).fetchImpl), { workspaceId: WS, operationId: OP1 });
  assert.equal(legacy.status, "COMPLETED");
});

test("operations.wait raises OperationFailedError for failed, cancelled and timed_out", async () => {
  for (const status of ["failed", "cancelled", "timed_out"]) {
    const { fetchImpl } = scripted({ json: op(status, { error_code: "E1", error_message: "boom" }) });
    await assert.rejects(client(fetchImpl).operations.wait({ workspaceId: WS, operationId: OP1 }), (err) => {
      assert.ok(err instanceof OperationFailedError);
      assert.ok(err instanceof IbeeError);
      assert.equal(err.code, "operation_failed");
      assert.equal(err.status, status);
      assert.equal(err.operationId, OP1);
      assert.equal(err.vmId, VM1);
      assert.equal(err.errorCode, "E1");
      assert.equal(err.errorMessage, "boom");
      assert.equal(err.operation.status, status);
      return true;
    });
  }
  const { fetchImpl } = scripted({ json: op("failed") });
  const res = await client(fetchImpl).operations.wait({ workspaceId: WS, operationId: OP1, raiseOnFailure: false });
  assert.equal(res.status, "failed");
});

test("operations.wait validates inputs before polling and re-raises 404 at once", async () => {
  const { calls, fetchImpl } = scripted({ status: 404, json: { detail: "Operation not found" } });
  const c = client(fetchImpl);
  const bad = [
    [{ operationId: "  " }, "invalid_operation_id"],
    [{ operationId: "op1" }, "invalid_operation_id"],
    [{ operationId: OP1, timeoutMs: 999 }, "invalid_timeout"],
    [{ operationId: OP1, timeoutMs: 7_200_001 }, "invalid_timeout"],
    [{ operationId: OP1, pollIntervalMs: 500 }, "invalid_poll_interval"],
    [{ operationId: OP1, pollIntervalMs: 61_000 }, "invalid_poll_interval"],
    [{ operationId: OP1, timeoutMs: 2_000, pollIntervalMs: 3_000 }, "invalid_poll_interval"],
  ];
  for (const [args, code] of bad) {
    await assert.rejects(c.operations.wait({ workspaceId: WS, ...args }), (err) => err instanceof IbeeValidationError && err.code === code, code);
  }
  await assert.rejects(c.operations.get({ workspaceId: WS, operationId: "" }), IbeeValidationError);
  assert.equal(calls.length, 0);
  await assert.rejects(c.operations.wait({ workspaceId: WS, operationId: OP1 }), NotFoundError);
  assert.equal(calls.length, 1);
});

function fakeClock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

test("pollUntil times out with OperationTimeoutError and truncates the last sleep", async () => {
  const clock = fakeClock();
  let polls = 0;
  await assert.rejects(
    pollUntil(async () => { polls += 1; return op("running"); }, (o) => o.status, {
      operationId: OP1, timeoutMs: 12_000, pollIntervalMs: 5_000, now: clock.now, sleep: clock.sleep,
    }),
    (err) => {
      assert.ok(err instanceof OperationTimeoutError);
      assert.equal(err.code, "operation_wait_timeout");
      assert.equal(err.lastStatus, "running");
      assert.equal(err.operationId, OP1);
      assert.equal(err.timeoutMs, 12_000);
      return true;
    },
  );
  assert.deepEqual(clock.sleeps, [5_000, 5_000, 2_000]);
  assert.equal(polls, 4);
});

test("pollUntil tolerates up to 2 consecutive transient failures and resets on success", async () => {
  const clock = fakeClock();
  const script = [
    () => { throw apiErrorFromResponse(503, {}); },
    () => { throw new TypeError("fetch failed"); },
    () => op("running"),
    () => { throw Object.assign(new Error("request timed out"), { name: "AbortError" }); },
    () => op("running"),
    () => { throw apiErrorFromResponse(429, {}); },
    () => { throw apiErrorFromResponse(502, {}); },
    () => op("succeeded"),
  ];
  let i = 0;
  const res = await pollUntil(async () => script[i++](), (o) => o.status, {
    operationId: OP1, timeoutMs: 600_000, pollIntervalMs: 1_000, now: clock.now, sleep: clock.sleep,
  });
  assert.equal(res.status, "succeeded");

  let j = 0;
  await assert.rejects(
    pollUntil(async () => { j += 1; throw apiErrorFromResponse(504, {}); }, (o) => o.status, {
      operationId: OP1, timeoutMs: 600_000, pollIntervalMs: 1_000, now: clock.now, sleep: clock.sleep,
    }),
    GatewayTimeoutError,
  );
  assert.equal(j, 3);

  let k = 0;
  await assert.rejects(
    pollUntil(async () => { k += 1; throw apiErrorFromResponse(403, {}); }, (o) => o.status, {
      operationId: OP1, timeoutMs: 600_000, pollIntervalMs: 1_000, now: clock.now, sleep: clock.sleep,
    }),
    ForbiddenError,
  );
  assert.equal(k, 1);
});

test("operations.wait honours an AbortSignal", async () => {
  const { fetchImpl } = scripted({ json: op("running") });
  const controller = new AbortController();
  const reason = new Error("stop waiting");
  const pending = client(fetchImpl).operations.wait({
    workspaceId: WS, operationId: OP1, pollIntervalMs: 60_000, timeoutMs: 600_000, signal: controller.signal,
  });
  setTimeout(() => controller.abort(reason), 20);
  await assert.rejects(pending, (err) => err === reason);
});

// ------------------------------------------------------------------ billing

const decision = (extra = {}) => ({
  organization_id: "org1",
  allowed: true,
  reason: "ok",
  billing_mode: "PREPAID",
  billing_state: "CURRENT",
  currency: "INR",
  sku_code: "STANDARD-2-8-50",
  evaluated_at: "2026-09-28T00:00:00Z",
  service_enforcement_state: "NONE",
  allowed_operations: ["CREATE_RESOURCE"],
  resource_limits: { vm: -1 },
  ...extra,
});

test("checkResourceEligibility normalises and validates inputs", async () => {
  const { calls, fetchImpl } = scripted({ json: decision({ allowed: false, reason: "insufficient_balance" }) });
  const c = client(fetchImpl);
  const result = await c.billing.checkResourceEligibility({
    workspaceId: WS, skuCode: "  standard-2-8-50 ", estimatedCostMinor: 1234.5, operation: " create_credential ",
  });
  assert.equal(result.allowed, false, "the query form never throws on denial");
  assert.deepEqual(result.resource_limits, { vm: -1 });
  assert.deepEqual(JSON.parse(calls[0].body), {
    sku_code: "standard-2-8-50", estimated_cost_minor: 1235, operation: "CREATE_CREDENTIAL",
  });
  await c.billing.checkResourceEligibility({ workspaceId: WS, skuCode: "   ", estimatedCostMinor: 0 });
  assert.deepEqual(JSON.parse(calls[1].body), { estimated_cost_minor: 0 });

  const bad = [
    [{ skuCode: "S".repeat(65) }, "invalid_sku_code"],
    [{ estimatedCostMinor: -1 }, "invalid_estimated_cost_minor"],
    [{ estimatedCostMinor: Number.NaN }, "invalid_estimated_cost_minor"],
    [{ estimatedCostMinor: Infinity }, "invalid_estimated_cost_minor"],
    [{ estimatedCostMinor: true }, "invalid_estimated_cost_minor"],
    [{ estimatedCostMinor: Number.MAX_SAFE_INTEGER * 2 }, "invalid_estimated_cost_minor"],
    [{ operation: "BUY_STUFF" }, "invalid_operation"],
  ];
  for (const [args, code] of bad) {
    await assert.rejects(c.billing.checkResourceEligibility({ workspaceId: WS, ...args }), (err) => err instanceof IbeeValidationError && err.code === code, code);
  }
  assert.equal(calls.length, 2);
});

test("requireResourceEligibility passes only on allowed === true, comparing SKU case-insensitively", async () => {
  const { fetchImpl } = scripted({ json: decision() });
  const ok = await client(fetchImpl).billing.requireResourceEligibility({ workspaceId: WS, skuCode: "standard-2-8-50" });
  assert.equal(ok.allowed, true);
});

test("requireResourceEligibility denial raises BillingDeniedError with portal copy", async () => {
  const denied = decision({ allowed: false, reason: "initial_topup_required" });
  const { fetchImpl } = scripted({ json: denied });
  await assert.rejects(
    client(fetchImpl).billing.requireResourceEligibility({ workspaceId: WS, skuCode: "STANDARD-2-8-50", resourceType: "gpu_vm" }),
    (err) => {
      assert.ok(err instanceof BillingDeniedError);
      assert.ok(err instanceof PaymentRequiredError);
      assert.ok(err instanceof ApiError);
      assert.equal(err.statusCode, 402);
      assert.equal(err.code, "billing_denied");
      assert.equal(err.reason, "initial_topup_required");
      assert.equal(err.skuCode, "STANDARD-2-8-50");
      assert.equal(err.topupAllowed, true);
      assert.deepEqual(err.decision, denied);
      assert.equal(err.message, "Add at least ₹2,000 to your wallet before creating your first GPU VM.");
      return true;
    },
  );
});

test("requireResourceEligibility rejects malformed or mismatched decisions as BillingAdmissionError", async () => {
  const bad = [
    { organization_id: "org1", reason: "ok" },
    { organization_id: "org1", allowed: "true", reason: "ok" },
    { allowed: true, reason: "ok" },
    { organization_id: "org1", allowed: true },
    decision({ sku_code: "OTHER" }),
  ];
  for (const body of bad) {
    const { fetchImpl } = scripted({ json: body });
    await assert.rejects(
      client(fetchImpl).billing.requireResourceEligibility({ workspaceId: WS, skuCode: "STANDARD-2-8-50" }),
      (err) => {
        assert.ok(err instanceof BillingAdmissionError, JSON.stringify(body));
        assert.ok(err instanceof BadGatewayError);
        assert.equal(err.statusCode, 502);
        assert.equal(err.code, "invalid_billing_decision");
        return true;
      },
    );
  }
});

test("billingBlockMessage covers every portal branch", () => {
  const m = (reason, type = "vm", extra = {}) => billingBlockMessage({ reason, ...extra }, type);
  assert.equal(m("initial_topup_required", "block_storage"), "Add at least ₹2,000 to your wallet before creating your first block storage volume.");
  assert.equal(m("initial_topup_required", "vm", { currency: "USD" }), "Add funds to your wallet before creating your first cloud VM.");
  assert.equal(m("credit_limit_exceeded", "cdn"), "Creating this CDN distribution would exceed this organization's credit limit.");
  assert.equal(m("x", "reserved_ip", { billing_state: "PAST_DUE" }), "Billing needs attention before creating a Reserved IP. Add credits or settle the outstanding usage, then try again.");
  assert.equal(m("overage_cap_exceeded", "secret"), "This organization is billing-suspended, so new secret creation is blocked. Please resolve billing before trying again.");
  assert.equal(m("x", "vm", { billing_state: "HARD_SUSPENDED" }), "This organization is billing-suspended, so new cloud VM creation is blocked. Please resolve billing before trying again.");
  assert.equal(m("dunning_grace_expired", "backup"), "An overdue billing case must be resolved before creating this backup policy.");
  assert.equal(m("unknown_sku", "load_balancer"), "Pricing for this load balancer could not be verified. Check the plan or SKU and try again.");
  assert.equal(m("manual_hold", "nonsense"), "Billing did not approve creating this resource. Please review billing and try again.");
  assert.equal(billingBlockMessage("insufficient_balance", "custom_domain"), "Your available wallet balance does not cover this custom domain. Add credits and try again.");
});

test("top-up and estimate helpers follow the portal", () => {
  assert.equal(isBillingTopupAllowed({ reason: " Insufficient_Balance " }), true);
  assert.equal(isBillingTopupAllowed({ reason: "billing_limit_exhausted" }), true);
  assert.equal(isBillingTopupAllowed({ reason: "credit_limit_exceeded" }), false);
  assert.equal(isBillingTopupAllowed({ reason: "x", allowed_operations: ["billing_topup"] }), true);
  assert.equal(isBillingTopupAllowed(null), false);
  assert.equal(minimumTopupMinor("inr"), 200_000);
  assert.equal(minimumTopupMinor("USD"), 0);
  assert.equal(estimateEligibilityCostMinor("HOURLY", 250, 2), 250 * 731 * 2);
  assert.equal(estimateEligibilityCostMinor("MONTHLY", 120_000, 1), 120_000);
  assert.equal(estimateEligibilityCostMinor("YEARLY", 1_000_000, 1.9), 1_000_000);
  assert.equal(estimateEligibilityCostMinor("HOURLY", -5, 3), 0);
  assert.equal(estimateEligibilityCostMinor("HOURLY", Number.NaN, 3), 0);
  assert.equal(estimateEligibilityCostMinor("HOURLY", 1.5, 1, Number.NaN), Math.round(1.5 * 731));
});
