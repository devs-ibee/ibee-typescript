# IBEE Solutions TypeScript SDK

Official TypeScript / JavaScript SDK for the IBEE Solutions cloud API. Manage
compute, VPC networking, Reserved IPs, firewalls, load balancers, object and
block storage, CDN, and secrets from Node 18+ or modern browsers.

## Installation

```bash
npm install ibee-sdk
```

## Usage

```ts
import { Ibee } from "ibee-sdk";

const client = new Ibee({ token: "ibee_live_xxxxxxxxxxxx" });

// Object storage
const buckets = await client.objectStorage.listBuckets({ workspaceId: "710995" });
await client.objectStorage.createBucket({
  workspaceId: "710995",
  name: "my-bucket",
  region: "in-south-1",
});
const s3Key = await client.objectStorage.createS3Credential({
  workspaceId: "710995",
  name: "application-key",
  bucketScope: "specific",
  allowedBuckets: ["my-bucket"],
});

// Secret Store
const stores = await client.secretStore.listSecretStores({ workspaceId: "710995" });

// Cloud VMs
const vms = await client.cloudVms.list({ workspaceId: "710995" });
const plans = await client.computeCatalog.listPlans({
  workspaceId: "710995",
  vmType: "cloud",
  siteId: "site_blr_01",
  currency: "INR",
  billingInterval: "MONTHLY",
});
await client.cloudVms.create({
  workspaceId: "710995",
  name: "web-01",
  site_id: "site_blr_01",
  os_distro: "ubuntu",
  os_type: "linux",
  cpu: 2,
  ram_mb: 4096,
  plan_id: "plan_standard_2c_4g",
  template_id: "tmpl_ubuntu_2204",
  ssh_key_ids: ["ssh_key_123"],
});

// VM lifecycle and recovery
await client.cloudVms.stop({
  workspaceId: "710995",
  vmId: "vm_123",
});
await client.cloudVms.resize({
  workspaceId: "710995",
  vmId: "vm_123",
  request: { cpu: 4, ram_mb: 8192 },
});
const snapshot = await client.cloudVms.createSnapshot({
  workspaceId: "710995",
  vmId: "vm_123",
  request: { name: "before-upgrade", mode: "all_attached" },
});
await client.cloudVms.enableBackups({
  workspaceId: "710995",
  vmId: "vm_123",
  request: {
    schedule: { frequency: "daily", timezone: "Asia/Kolkata", hour: 20 },
    retention_days: 14,
  },
});

// Sensitive, short-lived graphical console URL — do not log or persist it.
const consoleSession = await client.vmConsole.createSession({
  workspaceId: "710995",
  vmId: "vm_123",
  vmType: "cloud",
});

// VPC networking
const vpc = await client.vpcs.create({
  workspaceId: "710995",
  name: "production",
  siteId: "site_blr_01",
  cidr: "10.20.0.0/24",
});
await client.vpcs.createSubnet({
  workspaceId: "710995",
  vpcId: vpc.vpc_id,
  name: "applications",
  cidr: "10.20.0.0/25",
});

// Public IPs, firewalls, and load balancers
const reservedIp = await client.reservedIps.reserve({
  workspaceId: "710995",
  siteId: "site_blr_01",
  label: "production-ingress",
});
const firewallGroups = await client.firewalls.listGroups({ workspaceId: "710995" });
const loadBalancers = await client.loadBalancers.list({ workspaceId: "710995" });

// Block Storage
const volume = await client.blockStorage.createVolume({
  workspaceId: "710995",
  name: "database",
  size_gb: 100,
  site_id: "site_blr_01",
  volume_class: "balanced",
});

// CDN
const distribution = await client.cdn.createDistribution({
  workspaceId: "710995",
  name: "assets",
  origin_type: "bucket",
  origin_id: "my-bucket",
});
```

## Environments and tokens

The client targets **production** (`https://api.ibee.ai/v1`) by default. Use the
development gateway for testing:

```ts
import { Ibee, IbeeEnvironment } from "ibee-sdk";

const dev = new Ibee({
  token: "ibee_dev_key_xxx",
  environment: IbeeEnvironment.DEVELOPMENT, // https://api.ibee.co.in/v1
});
```

An explicit `baseUrl` takes precedence over `environment`. The base URL must be
an absolute `https` URL (plain `http` only for `localhost`) with no
credentials, query or fragment.

The client refuses a token for the other environment: an `ibee_dev_key_` token
against production, or an `ibee_prod_key_` token against development, throws
`IbeeValidationError` with code `token_environment_mismatch` when the client is
constructed. `environmentFromName("dev" | "development" | "prod" | "production")`
resolves a name the same way the CLI reads `IBEE_ENV`.

Every request sends exactly one `workspace_id` query parameter. Workspace IDs
must match `^[1-9][0-9]*$`; anything else throws `IbeeValidationError`
(code `invalid_workspace_id`) before a request is made.

## Billing preflight

Every create helper sends exactly one product request. The public edge performs
the authoritative billing check before it forwards a billable request to the
product service. When billing refuses, the create throws `BillingDeniedError`
(HTTP 402) with the same message the IBEE portal shows.

To check billing before collecting a create form (as the portal does), call the
preflight explicitly:

```ts
import { BillingDeniedError, estimateEligibilityCostMinor } from "ibee-sdk";

try {
  await client.billing.requireResourceEligibility({
    workspaceId: "710995",
    skuCode: plan.billing_catalog.sku_code,
    // Hourly rates are estimated over 731 hours; MONTHLY/YEARLY use the period price.
    estimatedCostMinor: estimateEligibilityCostMinor("MONTHLY", 120_000, 1),
    resourceType: "vm",
  });
} catch (err) {
  if (err instanceof BillingDeniedError) {
    console.error(err.message); // e.g. "Your available wallet balance does not cover this cloud VM. ..."
    if (err.topupAllowed) console.error("Add credits in the IBEE portal (Billing > Add Credits), then retry.");
  }
}
```

`requireResourceEligibility` continues only when `allowed` is exactly `true`.
It throws `BillingAdmissionError` (502, `invalid_billing_decision`) when the
decision is malformed or does not confirm the requested SKU (compared
case-insensitively). `checkResourceEligibility` returns the decision without
throwing, including `billing_state`, `service_enforcement_state`,
`allowed_operations` and `resource_limits`. The preflight does not reserve
funds. `billingBlockMessage`, `isBillingTopupAllowed` and `minimumTopupMinor`
are exported for applications that render their own UI.

## Secret Store lifecycle

Secret Store exposes the complete store, secret-version, application-identity,
and identity-scope lifecycle. Every request requires the owning `workspaceId`.
Value and identity-access responses may contain sensitive credentials and must
not be logged.

```ts
await client.secretStore.patchSecretValue({
  workspaceId: "710995",
  secretId: secret.id!,
  value: { username: "payments-v2" },
});
const versions = await client.secretStore.listSecretVersions({
  workspaceId: "710995",
  secretId: secret.id!,
});
await client.secretStore.rollbackSecret({
  workspaceId: "710995",
  secretId: secret.id!,
  version: versions.oldest_version,
});
```

Stores support archive, unarchive, and explicit permanent deletion. Secrets
support batch creation, soft deletion, undelete, version destruction, rollback,
and permanent deletion. Workload identities support AppRole or Kubernetes
authentication, credential rotation, session revocation, and per-store scopes.
Permanent-delete and version-destroy operations are irreversible.

## Errors

Non-2xx responses throw an `ApiError` subclass. Every error has `statusCode`,
the parsed `body`, a stable lower-case `code`, and where available `reason`,
`requiredScope`, `requestId`, `retryAfterSeconds`, `admissionContextId` and
`idempotencyKey`.

```ts
import { ApiError, InsufficientScopeError, NotFoundError } from "ibee-sdk";

try {
  await client.secretStore.listSecretStores({ workspaceId: "710995" });
} catch (err) {
  if (err instanceof InsufficientScopeError) console.error(`token needs ${err.requiredScope}`);
  else if (err instanceof NotFoundError) console.error("not found");
  else if (err instanceof ApiError) console.error(err.statusCode, err.code, err.message);
}
```

| Status | Class (all extend `ApiError`) |
|---|---|
| 400 | `BadRequestError` (`InvalidWorkspaceError`) |
| 401 | `UnauthorizedError` |
| 402 | `PaymentRequiredError` (`BillingDeniedError`) |
| 403 | `ForbiddenError` (`InsufficientScopeError`, `WorkspaceNotAllowedError`, `ApiKeyInactiveError`, `RouteNotAvailableError`, `OrganizationRestrictedError`, `BillingForbiddenError`) |
| 404 | `NotFoundError` |
| 409 | `ConflictError` |
| 413 | `PayloadTooLargeError` |
| 422 | `UnprocessableEntityError` (message lists the invalid fields) |
| 423 | `OrganizationSuspendedError` |
| 429 | `TooManyRequestsError` |
| 500 | `InternalServerError` |
| 502 | `BadGatewayError` (`BillingAdmissionError`) |
| 503 | `ServiceUnavailableError` |
| 504 | `GatewayTimeoutError` |

Errors raised by the SDK itself extend `IbeeError`: `IbeeValidationError`
(input rejected before sending; has `code` and `field`),
`OperationFailedError` and `OperationTimeoutError`. `isPaymentBlockError(err)`
tells whether an error means a payment or wallet problem.

## Retries and idempotency

The client retries a request (default `maxRetries: 2`, `0` disables) only when
repeating it cannot duplicate a side effect:

- `GET`, `HEAD` and `OPTIONS` requests, and
- Cloud/GPU VM writes and block-volume writes, which carry an idempotency key.

Only 429, 502, 503 and 504 responses and network errors are retried. 408, 409,
500 and other errors are never retried. `Retry-After` is honoured (capped at
30 s); otherwise the delay is 1 s, 2 s, 4 s ... with ±10% jitter.

VM writes send `X-Idempotency-Key`; block-volume create/attach/detach/resize
send `idempotency_key` in the body and delete sends it as a query parameter.
When you omit `idempotencyKey`, the SDK generates one the way the portal does
(`buildIdempotencyKey("cloud-vm-start", vmId)`), and every automatic retry
reuses it. A failed call reports the key in `err.idempotencyKey`; pass it back
as `idempotencyKey` to retry safely. Your own keys must be 1-128 printable
ASCII characters with no spaces.

Other creates (networking, snapshots, backups, S3 credentials) are never
retried automatically because their backends do not deduplicate requests yet.

In browsers, the API gateway does not yet allow the `X-Idempotency-Key` header
in CORS preflight, so VM writes currently need a server-side (Node) runtime.

## Waiting for operations

VM creates, deletes, power actions, resizes and volume changes return an
`OperationAccepted`. Wait for the result with `operations.wait`:

```ts
import { OperationFailedError, OperationTimeoutError } from "ibee-sdk";

const accepted = await client.cloudVms.start({ workspaceId: "710995", vmId: "vm_123" });
try {
  const op = await client.operations.wait({
    workspaceId: "710995",
    operationId: accepted.operation_id,
    timeoutMs: 1_200_000,   // default 20 min (1 s .. 2 h)
    pollIntervalMs: 5_000,  // default 5 s (1 .. 60 s)
    onUpdate: (o) => console.log(o.status),
  });
} catch (err) {
  if (err instanceof OperationFailedError) console.error(err.status, err.errorCode, err.errorMessage);
  if (err instanceof OperationTimeoutError) console.error("still running; wait again later");
}
```

`succeeded` resolves (`completed` is accepted as a legacy alias); `failed`,
`cancelled` and `timed_out` throw `OperationFailedError` unless
`raiseOnFailure: false`. Three consecutive transient poll failures abort the
wait; a 404 aborts at once. Pass `signal` to cancel.

## Pagination

Cloud VM, GPU VM and firewall-group lists return at most 10 items per request
on the server. With no `limit`/`offset`, `cloudVms.list`, `gpuVms.list` and
`firewalls.listGroups` fetch every page (100 per request) and remove
duplicates. Pass `limit` (1..100) or `offset` for a single page, or iterate
lazily:

```ts
for await (const vm of client.cloudVms.iterate({ workspaceId: "710995", sortBy: "name", sortDirection: "asc" })) {
  console.log(vm.name);
}
```

VM lists also accept `search` (max 120 characters), `sortBy`
(`created_at`, `name`, `status`, `os_type`) and `sortDirection` (`asc`,
`desc`). These paging parameters are not yet part of the published API
contract; behaviour may change.

## Resources

| Resource | Methods |
|---|---|
| `client.secretStore` | listSecretStores, createSecretStore, getSecretStore, updateSecretStore, archiveSecretStore, listSecrets, createSecret, getSecret, deleteSecret, getSecretValue, updateSecretValue |
| `client.objectStorage` | bucket list/create/get/update/delete and S3 credential list/create/get/revoke |
| `client.blockStorage` | volume list/create/get, operations, attach/detach, resize, and delete |
| `client.cdn` | distributions, static website configuration, custom domains, URL generation, and cache purge |
| `client.vpcs` | listSites, list, create, get, update, delete, subnet/node/NAT/port-forwarding lifecycle |
| `client.reservedIps` | list, reserve, get, update, release, attach, move, detach |
| `client.firewalls` | firewall group (auto-paged list, iterateGroups), rule, and VM attachment lifecycle |
| `client.loadBalancers` | list, createL4, createL7, get, updateL4, updateL7, delete, getStatus |
| `client.computeCatalog` | typed site, plan, and image discovery |
| `client.billing` | checkResourceEligibility, requireResourceEligibility (portal preflight) |
| `client.cloudVms` / `client.gpuVms` | auto-paged list and iterate; full lifecycle: power, access, resize/precheck, volumes, mount guidance, events, metrics, snapshots, backup policy/runs, and restore |
| `client.vmConsole` | createSession, getSession, closeSession |
| `client.operations` | get, wait |

## Related

- [Python SDK](https://pypi.org/project/ibee/) — `pip install ibee`
- [CLI](https://pypi.org/project/ibee-cli/) — `pip install ibee-cli`
- [API documentation](https://ibee.ai/docs/api-reference)
