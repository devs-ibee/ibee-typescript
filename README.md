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
// cpu, ram_mb, disk_gb, OS and billing_catalog come from the plan and image.
await client.cloudVms.create({
  workspaceId: "710995",
  name: "web-01",
  site_id: "site_blr_01",
  plan_id: "plan_standard_2c_4g",
  template_id: "tmpl_ubuntu_2204",
  ssh_keys: ["ssh-ed25519 AAAAC3Nza... user@laptop"],
  wait: true,
});

// VM lifecycle and recovery (VM IDs are 24-character hex IDs)
const vmId = "64b0c0ffee0000000000abcd";
await client.cloudVms.stop({ workspaceId: "710995", vmId, checkState: true });
await client.cloudVms.resize({
  workspaceId: "710995",
  vmId,
  request: { plan_id: "plan_standard_4c_8g", billing_term: "MONTHLY" },
});
// Snapshot/backup SKUs cannot be listed publicly yet: reuse the billing_catalog
// returned on an existing snapshot set or backup run.
const snapshotSku = { sku_id: "<snapshot sku id>", sku_code: "SNAPSHOT-STD" };
const backupSku = { sku_id: "<backup sku id>", sku_code: "BACKUP-STD" };
const snapshot = await client.cloudVms.createSnapshot({
  workspaceId: "710995",
  vmId,
  request: { name: "before-upgrade", mode: "all_attached", billing_catalog: snapshotSku },
});
await client.cloudVms.enableBackups({
  workspaceId: "710995",
  vmId,
  request: {
    schedule: { frequency: "daily", timezone: "Asia/Kolkata", hour: 20 },
    retention_days: 14,
    billing_catalog: backupSku,
  },
});

// Sensitive, short-lived graphical console URL — do not log or persist it.
const consoleSession = await client.vmConsole.createSession({
  workspaceId: "710995",
  vmId,
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

## Creating VMs

`cloudVms.create` and `gpuVms.create` follow the portal's deploy flow. You
pass `name`, `site_id`, `plan_id` and `template_id`; the SDK then:

- reads the plan (`GET /compute/plans?vm_type=…&site_id=…`) and requires it to
  be `selectable` and `priced`;
- reads the image (`GET /compute/images`) and takes `os_type`/`os_distro`
  from it;
- sends the plan's `cpu`, `ram_mb` and `disk_gb` (values you pass must
  match), and for GPU VMs the plan's `gpu_count` and `gpu_model`;
- builds `billing_catalog` from the plan SKU for `billing_term` (`HOURLY`
  default for cloud VMs, `MONTHLY` or `YEARLY` when the plan offers them; GPU
  VMs send the plan SKU unchanged unless you set a term).

Rules checked before anything is sent (`IbeeValidationError`):

- names use letters, digits and `-` only (`expandBatchNames` builds
  `web-1..web-5` for batches of up to 5);
- `ssh_keys` must be single-line public keys (`ssh-rsa`, `ssh-ed25519`,
  `ecdsa-sha2-nistp256/384/521`, `sk-…`); private keys are refused;
- at most one firewall group;
- `vpc_id` and `subnet_id` go together. `nat` works only in NAT Gateway VPCs,
  and a public IP on a private VPC needs `reserved_public_ip_id`, whose SKU is
  attached as `attached_skus.reserved_ip`.

Windows images need the Windows licence SKU as `windows_license`. It is
attached with `quantity` equal to the vCPU count. The public API cannot list
this SKU yet. `ssh_key_ids` are resolved under the VM creator, so creates made
with an API token should use inline `ssh_keys`.

Pass `preflightBilling: true` to run the billing eligibility check first. A
VM create is never retried automatically, because replaying it can surface as
"VM with this name already exists".

Other VM rules:

- **Delete:** a VM with an auto-assigned public IP must release it (the
  default) or reserve it. Reserving uses `publicIpAction: "reserve"` plus
  `reservedIpBillingCatalog`; copy that from an existing Reserved IP in the
  same site.
- **Resize:** `resize` runs the precheck and submits only when the decision is
  `in_place`. `request.plan_id` resolves the shape and the new SKU, carrying
  over the Windows licence.
- **`resizePlan`:** rejects a no-op change, and needs `confirm_downgrade` for a
  downgrade.
- **`resizeRootDisk`:** can only grow the disk.
- **`updateAccess`:** checks the key mode, keys and password rules
  (8+ characters, no line breaks).
- **`checkState: true`:** applies the portal's state matrix (start only when
  stopped, stop/reboot only when running, access only on running Linux VMs).
- **`attachVolume`:** reads the volume first and uses its Block Storage SKU.
- **`detachVolume`:** needs `confirm_unmounted: true` or `force: true`.

## Snapshots, backups and restores

The API requires a `billing_catalog` on snapshot creates, backup enables and
manual backup runs:

| Operation | Product | SKU |
|---|---|---|
| Snapshot create | `snapshot_storage` | `SNAPSHOT-STD` |
| Backup enable, manual backup run | `backup_storage` | `BACKUP-STD` |

The public API cannot list these SKUs yet. Reuse the `billing_catalog`
returned on an existing snapshot set or backup run.

- **Backup schedules** are `daily` or `weekly`; weekly needs `day_of_week`,
  where 0 is Monday. The timezone must be a valid IANA zone.
- **`enableBackups`** fills the portal defaults: 12:00 UTC, a 30-minute
  window, 7-day retention, a weekly full backup and incremental backups on.
- **`updateBackupPolicy`** merges your changes into the saved schedule.

```ts
const restore = await client.cloudVms.restoreSnapshot({
  workspaceId: "710995",
  vmId,
  snapshotSetId: "ss_123",
  request: { target_mode: "new_vm" },   // plan, names and SKU resolved like the portal
  wait: true,                           // polls every 5 s; RecoveryRestoreFailedError on failure
});
```

For `new_vm` restores the SDK fills in the rest:

- the target plan: your `target_plan_id`, or the VM's own plan. It sets the
  `target_*` fields and `target_billing_catalog`, and checks the plan disk
  against the recovery point's root disk.
- the default names, `<vm>-snapshot-restored-YYYYMMDD` for the VM and
  `<volume>-backup-restored-YYYYMMDD` for volumes, using the recovery point
  date in UTC.

`volume_only` needs `selected_volume_id`.

Two methods are not yet part of the published API contract:
`listAllBackupRuns` (workspace-wide) and `deleteBackupRun`.

## Networking

Networking calls apply the portal's rules before sending and throw
`IbeeValidationError` (with `code` and `field`) when a request would be
refused.

**VPCs and subnets**

- `vpcs.create` accepts `connectivityType: "private"` (the portal default) or
  `"nat_gateway"`. `"public"` still works but is deprecated.
- A custom `cidr` must be RFC1918, aligned and between /22 and /28.
  `auto_cidr: false` is then sent for you. A misaligned CIDR fails with the
  aligned network in `err.details.suggestion`.
- `checkSite: true` confirms the site is VPC-enabled first.
- `vpcs.createSubnet` reads the VPC (`checkVpc`, default true). The CIDR must
  be a sub-range of the VPC that does not overlap other subnets, and a VPC
  holds at most 10 subnets.
- `vpcs.delete({ checkDependencies: true, deleteNatGateway: true })` works
  like the portal's delete dialog. Attached nodes and virtual IPs block the
  delete. The NAT gateway is deleted first, and the SDK waits for it to go.

**NAT gateways and port forwarding**

- `createNatGateway` needs a `nat_gateway` VPC (`validateVpc`, default true).
  It accepts `billingCatalog` (NAT-GATEWAY SKU) and `preflightBilling`.
- `deleteNatGateway` accepts `publicIpAction` (`reserve`/`release`),
  `billingCatalog` and `wait`. Reserving a platform address needs the
  RESERVED-IP catalog. `defaultNatDeleteIpAction` returns the portal
  default.
- `replaceNatGatewayPublicIp` swaps the gateway's public IP to a Reserved IP.
- Port-forwarding rules take single ports (1..65535) and `targetType`
  `vm`/`vip`. With `checkState` (default true) the SDK checks four things:
  - the gateway is available;
  - no other rule uses the same protocol and external port;
  - a `vm` target is a NAT-connected VM on this gateway;
  - a `vip` target is an available MetalLB virtual IP. Its announcers fill
    `targetVmIds` when you omit them.

**Virtual IPs and nodes**

- `listVirtualIps`, `getVirtualIp`, `createVirtualIp` and `deleteVirtualIp`
  manage MetalLB virtual IPs.
- `reservedIps.attachVirtualIp` gives a virtual IP a public address.
- `attachNode` accepts `requestedPrivateIp`. It must be a usable host in the
  subnet: not the network, broadcast or gateway address.

```ts
const vpc = await client.vpcs.create({
  workspaceId: "710995",
  name: "app",
  siteId: "site-1",
  connectivityType: "nat_gateway",
  cidr: "10.20.0.0/24",
  natBillingCatalog,          // NAT-GATEWAY SKU; without it the NAT gateway is not metered
});
const nat = vpc.nat_gateways![0];
await client.vpcs.createPortForwardingRule({
  workspaceId: "710995", vpcId: vpc.vpc_id, natGatewayId: nat.nat_gateway_id,
  name: "ssh", externalPort: 2222, internalIp: "10.20.0.10", internalPort: 22,
});
```

The public API cannot list the NAT-GATEWAY / RESERVED-IP catalogs yet.
`networkBillingCatalog(price)` builds the portal's catalog object from a
price entry you already have. Without a catalog the SDK emits an
`IbeeBillingWarning`. The SKU codes are exported as `NAT_GATEWAY_SKU_CODE`,
`RESERVED_IP_SKU_CODE` and `LOAD_BALANCER_SKU_CODE`.

**Reserved IPs**

- `reserve` validates the site and label, and accepts `billingCatalog` and
  `checkBilling`.
- `update` validates reverse DNS. An empty string clears it.
- `release`, `attach`, `move` and `detach` read the IP first and refuse the
  cases the portal blocks. To attach an IP that sits on a NAT gateway or
  virtual IP, pass `detachFromService: true`.
- A VM without a VPC attachment raises `ReservedIpTargetUnsupportedError`.
  `reservedIps.convert` turns such a VM's current public IP into a Reserved
  IP. It runs the RESERVED-IP billing preflight by default (`billingCheck`).

**Firewalls**

- `createGroup` trims the name (1..120) and rejects duplicate names
  case-insensitively. It no longer sends `is_default`.
- Rules default to tcp, ingress, allow and `0.0.0.0/0`. TCP/UDP need
  `portStart`. Remote targets must be IPv4 and are normalised, so a bare IP
  becomes `/32`.
- System-managed rules are refused on update and delete.
- `listGroupSummaries` / `iterateGroupSummaries` return the portal list view.

**Load balancers**

- Create and update accept `policy`, `healthCheck` and `observability`.
- Managed TLS is filled in for `https` and `tls_passthrough`. Custom
  certificates, and sticky sessions on L4, are rejected.
- `customDomain` works on L7 https only; `updateL7({ customDomain: null })`
  removes it.
- `list`/`get` accept `includeDeleted`, and `checkBilling` runs the
  LOADBALA-STD preflight.

These are not yet part of the published API contract:

- **Methods:** `replaceNatGatewayPublicIp`, the virtual-IP methods,
  `reservedIps.convert`, `reservedIps.attachVirtualIp` and
  `firewalls.listGroupSummaries`.
- **Fields:** `natBillingCatalog`, NAT `billingCatalog`, `publicIpAction`,
  `targetType`, `targetVmIds`, `requestedPrivateIp`, and the load balancer's
  `policy`, `healthCheck`, `observability` and `includeDeleted`.

## Waiting for operations

VM creates, deletes, power actions, resizes and volume changes return an
`OperationAccepted`. Pass `wait: true` (or wait options) to any of
them, or wait for the result with `operations.wait`:

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
| `client.vpcs` | listSites, list, create, get, update, delete, subnet/node/NAT/port-forwarding lifecycle, replaceNatGatewayPublicIp, waitForNatGatewayAbsent, virtual IPs (list/get/create/delete) |
| `client.reservedIps` | list, reserve, get, update, release, attach, move, detach, convert, attachVirtualIp |
| `client.firewalls` | firewall group (auto-paged list, listAllGroups, iterateGroups, listGroupSummaries), rule, and VM attachment lifecycle |
| `client.loadBalancers` | list, createL4, createL7, get, updateL4, updateL7, delete, getStatus |
| `client.computeCatalog` | typed site, plan, and image discovery |
| `client.billing` | checkResourceEligibility, requireResourceEligibility (portal preflight) |
| `client.cloudVms` / `client.gpuVms` | auto-paged list, listAll and iterate; portal-style create; full lifecycle: power, access, resize/precheck, volumes, mount guidance, events, metrics, snapshots, backup policy/runs (listAllBackupRuns, deleteBackupRun), restores and restore waits |
| `client.vmConsole` | createSession (cloud VMs), getSession, closeSession |
| `client.operations` | get, wait, waitFor |

## Related

- [Python SDK](https://pypi.org/project/ibee/) — `pip install ibee`
- [CLI](https://pypi.org/project/ibee-cli/) — `pip install ibee-cli`
- [API documentation](https://ibee.ai/docs/api-reference)
