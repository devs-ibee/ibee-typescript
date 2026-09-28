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
  permissionType: "object_rw",
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

### Portal rules applied before sending

Every Secret Store method checks its input the way the portal does and throws
`IbeeValidationError` before any request:

- `workspaceId` must have 2 to 128 digits (Secret Store refuses single-digit
  workspace IDs). Store, secret, identity and scope IDs must be non-blank and
  contain no `/`, `?`, `#` or control characters.
- Store names are trimmed, 1..128 characters, and on create must contain a
  letter or digit (the store key is generated from it). `updateSecretStore`
  needs `name` or `description`.
- Secret names are trimmed and **lower-cased** (as the portal does), then must
  be 2..64 characters of `a-z`, `0-9` and `-`, starting with a letter or
  digit. `createSecret({ name: " DB-Url " })` sends `secret_name: "db-url"`.
- Secret values must be an object with at least one entry. Keys are trimmed
  and must be non-blank and unique; string values must not be blank.
  `patchSecretValue` also accepts `null`, which deletes that key.
- `batchCreateSecrets`: 1..500 items, each checked like `createSecret`;
  repeated names emit an `IbeeSecretStoreWarning` (the API skips them).
  `chunkBatchSecrets(items)` splits a larger import into requests of at most
  500 items and 64 KiB.
- Versions are integers >= 1; version lists hold 1..100 entries and are
  de-duplicated. `cas` is an integer >= 0. `page` >= 1, `limit` 1..200,
  search `q` is trimmed and at most 128 characters.
- Every Secret Store request body is limited to 64 KiB (checked before the
  billing preflight). `workspaceId` is trimmed.

```ts
// Portal-style create: billing check, then reuse an existing store on conflict.
const store = await client.secretStore.createSecretStore({
  workspaceId: "710995",
  name: "Payments",
  billingPreflight: true, // SECRETMA-STD; BillingDeniedError when not allowed
  ifExists: "return",     // return the existing "Payments" store instead of ConflictError
});
await client.secretStore.createSecret({
  workspaceId: "710995",
  storeId: store.id!,
  name: "db-url",
  value: { url: "postgres://..." },
  billingPreflight: true,
});

// listAll* pages for you (no item cap). Archived stores are included by
// default, as in the portal; pass includeArchived: false to hide them.
const stores = await client.secretStore.listAllSecretStores({
  workspaceId: "710995",
});
const secrets = await client.secretStore.listAllSecrets({
  workspaceId: "710995",
  storeId: store.id!,
  q: "db",
});
```

Pre-checks the portal runs:

- `rollbackSecret` reads the versions first (`checkTarget`, default true) and
  refuses the current version and destroyed or missing versions.
- `createSecretIdentityScope({ checkStore: true })` reads the identity, its
  scopes and the active stores, and refuses a store that is not active or
  already granted, or write access for a read-only identity. Scopes default
  to `read_only` with version reads allowed; rollback and destroy need
  `read_write`.
- `rotateSecretIdentitySecretId({ checkAuthMethod: true })` refuses
  Kubernetes and disabled identities.
- `undeleteSecret` without `versions` restores the current version.

A pre-check that the token cannot perform (403 `insufficient_scope`, for
example a token without `billing.read` or `secret-store.read`) is skipped with
an `IbeeSecretStoreWarning` (`IbeeBillingWarning` for billing) and the request
is sent; the API enforces the same rule. With `ifExists: "return"` (or its
alias `"reuse"`) a store lookup the token cannot perform keeps the original
`ConflictError`.

`createSecretIdentity` always sends `token_policy_mode` (default `read_only`)
and sends the Kubernetes fields only for `kubernetes` identities.
`updateSecretIdentity` requires `tokenPolicyMode`.

`getSecretIdentityAccess` and `rotateSecretIdentitySecretId` mint a new AppRole
secret ID on every call (the previous one is not revoked), so they are never
retried automatically. Store and secret creates and value writes are not
retried either.

Secret Store errors are typed:

| Error | When |
|---|---|
| `ResourceNotFoundError` (403) | the store, secret, identity or scope does not exist in the workspace (`kind`, `resourceId`) |
| `OrganizationLifecycleError` (403) | the organization is restricted, suspended, deleting or deleted (`state`, `operation`) |
| `StoreNotActiveError` (403) | an identity or scope needs an active store |
| `IdentityDisabledError` (403) | login details or rotation for a disabled identity |
| `AuthMethodMismatchError` (403) | rotation of a Kubernetes identity |
| `ScopePermissionError` (403) | write/rollback/destroy for a read-only identity |
| `StoreArchivedError`, `StoreDeletingError` (409) | the store is archived (restore it first) or being deleted |
| `SecretValueNotFoundError` (404) | reading a value or version that is soft-deleted, destroyed or missing |
| `ScopeValidationError` (422) | an updated scope would be `read_only` with rollback or destroy |
| `CasConflictError` (502) | `updateSecretValue` with `cas` failed, most likely a version mismatch |
| `DeletionIncompleteError` (503) | a permanent store delete did not finish (`failedSteps`); call it again |

All 403 classes extend `ForbiddenError` (`ResourceNotFoundError` also extends
`WorkspaceNotAllowedError`, as in the Python SDK) and the 409 classes extend
`ConflictError`, so 0.3.0 `instanceof` checks keep working. Where the SDK has
a suggestion, `err.hint` carries it.

Client-side validation codes match the Python SDK (and the CLI):

| Rule | `IbeeValidationError.code` (`field`) |
|---|---|
| Store or identity name | `invalid_name` |
| Batch size | `invalid_secrets` |
| Rollback target | `rollback_to_current`, `unknown_version`, `version_destroyed` |
| Secret-ID rotation | `auth_method_mismatch`, `identity_disabled` (`identity_id`) |
| Scope store | `scope_already_exists`, `store_not_active`, `store_not_found` |
| Write access for a read-only identity | `scope_permission_denied` (`access_mode`) |

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
`OperationFailedError` and `OperationTimeoutError`.

`isPaymentBlockError(err)` tells whether an error is a payment or wallet
wall. It checks, in order: the billing error classes; a missing scope (never a
payment wall); HTTP 402; a structured code or billing reason
(`billing_denied`, `payment_required`, `insufficient_balance`,
`insufficient_funds` or a billing denial reason such as
`initial_topup_required`); and only when the error carries no code of its own,
whole phrases in the server message ("insufficient balance", "payment
required", "add a payment method", "top up"). The lists are exported as
`PAYMENT_BLOCK_CODES` and `PAYMENT_BLOCK_PHRASES`.

### Error codes

Errors raised by the SDK itself extend `IbeeError` and carry a stable `code`.
The Python and TypeScript SDKs raise the same codes for the same conditions.
Unless the class column says otherwise the class is `IbeeValidationError`,
raised before the request is sent, with `field` naming the argument.

A code of the form `invalid_<field>` means the argument `<field>` (its
snake_case API name) is missing, malformed, out of range, or not allowed with
the other arguments, for example `invalid_workspace_id`, `invalid_limit`,
`invalid_cidr`, `invalid_prefix_length`, `invalid_ssh_key_mode`,
`invalid_target_mode`, `invalid_rules`. Other codes:

| Code | Class | Meaning |
| --- | --- | --- |
| `ibee_error` | `IbeeError` | Base code; not raised on its own |
| `operation_failed` | `OperationFailedError` | An awaited operation ended `failed`, `cancelled` or `timed_out` |
| `operation_wait_timeout` | `OperationTimeoutError` | A wait (operation, volume, CDN custom domain) ran out of time |
| `recovery_failed` | `RecoveryFailedError` | An awaited snapshot or backup run failed |
| `recovery_restore_failed` | `RecoveryRestoreFailedError` | An awaited snapshot or backup restore failed |
| `cdn_purge_failed` | `CdnPurgeFailedError` (TypeScript: `IbeeCdnPurgeError`) | The API accepted a CDN purge but reported it failed |
| `nat_gateway_deleting` | `IbeeError` | The NAT gateway delete was accepted but the gateway is still listed; retry the VPC delete shortly |
| `reserved_ip_target_unsupported` | `ReservedIpTargetUnsupportedError` | Reserved IP attach/move to a VM without a VPC attachment (404) |
| `no_changes` | | An update carries no field, or the requested value equals the current one |
| `confirmation_required` | | A confirmation flag is needed (`confirm_unmounted`/`force` on detach, `confirm_downgrade` on resize) |
| `request_body_too_large` | | The request body exceeds the API limit |
| `token_environment_mismatch` | | The token belongs to the other environment |
| `invalid_base_url`, `invalid_environment`, `invalid_token` | | Client configuration is invalid |
| `forbidden_field` | | A server-managed field was passed in a request object (TypeScript only) |
| `invalid_request` | | The request argument is not an object (TypeScript only) |
| `billing_catalog_required` | | A billing SKU object is required and cannot be resolved |
| `invalid_billing_term`, `unsupported_billing_term` | | The billing term is unknown, or the plan does not offer it |
| `windows_license_required`, `windows_license_not_allowed` | | Windows VMs need a licence SKU; other VMs must not send one |
| `plan_not_found`, `plan_not_selectable`, `invalid_plan` | | The plan is not offered in the site, not selectable or unpriced, or incomplete |
| `image_not_found`, `image_not_compatible` | | The image is not offered in the site, or not for this VM type |
| `shape_mismatch` | | An explicit cpu, ram_mb, os or GPU value differs from the plan or image |
| `duplicate_vm_names` | | VM names in one batch are not unique |
| `invalid_vm_state` | | The VM's status does not allow the action |
| `vm_not_linux` | | SSH key and password-login changes need a Linux VM |
| `ssh_key_required` | | Password login cannot be turned off without an SSH key |
| `console_not_supported` | | Console sessions are for cloud VMs only |
| `invalid_resize_target` | | Pass either `plan_id` or explicit cpu/ram_mb/disk_gb |
| `resize_not_in_place` | | The resize precheck did not return `in_place` |
| `root_disk_grow_only` | | A root disk can only grow |
| `vpc_required`, `subnet_required` | | The network choice needs a VPC or a subnet |
| `vpc_unavailable`, `vpc_site_mismatch`, `subnet_mismatch`, `vpc_connectivity_mismatch` | | The VPC is not available, is in another site, does not own the subnet, or has the wrong connectivity type |
| `reserved_ip_required` | | Public IP connectivity in a private VPC needs a Reserved IP |
| `reserved_ip_billing_catalog_required`, `vm_site_unavailable` | | Keeping a VM's public IP needs the RESERVED-IP SKU and a known VM site |
| `recovery_point_not_ready` | | The snapshot or backup has not succeeded, or the backup has no recovery point ID |
| `backups_disabled` | | Backups are not enabled for the VM |
| `backup_not_completed` | | Only a completed backup can be deleted |
| `snapshot_busy` | | The snapshot is being restored |
| `restore_disk_too_small` | | The restore target disk is smaller than the captured root disk |
| `invalid_restore_plan` | | The restore target plan is not eligible |
| `invalid_restore_request` | | A restore field is not used with the chosen `target_mode` |
| `volume_not_in_recovery_point` | | `selected_volume_id` is not part of the snapshot or backup |
| `volume_not_attached`, `volume_attached`, `volume_busy` | | The volume is not attached here, is already attached, or is busy |
| `volume_unreadable` | | The volume could not be read to take its billing SKU |
| `ambiguous_attachment`, `attachment_without_vm` | | The attachment to detach cannot be identified; pass `vm_id` or `node_name` |
| `vm_type_mismatch`, `site_mismatch` | | The volume belongs to another VM type or site |
| `resize_shrink_not_supported`, `resize_requires_offline` | | Volumes only grow; an attached volume needs a stopped VM or `allow_online` |
| `unknown_site_id`, `site_unavailable` | | The site is unknown or not available |
| `cidr_required` | | `auto_cidr=False` needs `cidr` |
| `subnet_outside_vpc`, `subnet_overlap`, `subnet_quota_exceeded` | | The subnet is outside the VPC CIDR, overlaps another subnet, or exceeds 10 per VPC |
| `address_outside_subnet`, `address_not_usable`, `address_is_gateway` | | The requested private IP is outside the subnet, a network/broadcast address, or the gateway |
| `vpc_has_nodes`, `vpc_has_nat_gateway`, `vpc_has_virtual_ips` | | The VPC still has attached nodes, a NAT gateway, or virtual IPs |
| `vpc_not_nat_gateway`, `nat_gateway_unavailable`, `nat_gateway_not_found` | | NAT needs a `nat_gateway` VPC with an available gateway; the gateway is not in the VPC |
| `duplicate_external_port` | | The protocol and external port are already forwarded |
| `virtual_ip_has_rules`, `virtual_ip_has_reserved_ip` | | Port-forwarding rules or a Reserved IP still use the virtual IP |
| `reserved_ip_attached`, `reserved_ip_attached_to_service`, `reserved_ip_not_attached`, `reserved_ip_same_target` | | The Reserved IP is attached (to a NAT gateway or virtual IP), is not attached, or is already on that target |
| `reserved_ip_not_movable`, `reserved_ip_converted_active`, `reserved_ip_not_user_reserved`, `reserved_ip_unavailable`, `reserved_ip_site_mismatch` | | The Reserved IP cannot be used this way |
| `duplicate_name` | | A firewall group with this name exists |
| `system_managed_rule` | | System-managed firewall rules cannot be changed |
| `firewall_attach_unsupported` | | The VM's network cannot take firewall groups |
| `bucket_not_empty`, `bucket_object_lock` | | Delete the objects first; Object Lock buckets cannot be deleted |
| `origin_not_public` | | Only public buckets can be CDN origins |
| `auth_method_mismatch`, `identity_disabled` | | Secret-ID rotation needs an enabled AppRole identity |
| `scope_already_exists`, `scope_permission_denied`, `store_not_active`, `store_not_found` | | The identity scope cannot be granted |
| `rollback_to_current`, `unknown_version`, `version_destroyed` | | The rollback target is not a restorable older version |

## Retries and idempotency

The client retries a request (default `maxRetries: 2`, `0` disables) only when
repeating it cannot duplicate a side effect:

- `GET`, `HEAD` and `OPTIONS` requests, and
- Cloud/GPU VM writes and block-volume writes, which carry an idempotency key.

Only 429, 502, 503 and 504 responses and network errors are retried. 408, 409,
500 and other errors are never retried, nor are deterministic billing
admission failures (502 with a code in `BILLING_ADMISSION_CODES`, such as
`invalid_billing_decision`; their `retryable` is false). `Retry-After` is honoured (capped at
30 s); otherwise the delay is 1 s, 2 s, 4 s ... with ±10% jitter.

VM writes send `X-Idempotency-Key`; block-volume create/attach/detach/resize
send `idempotency_key` in the body and delete sends it as a query parameter.
When you omit `idempotencyKey`, the SDK generates one the way the portal does
(`buildIdempotencyKey("cloud-vm-start", vmId)`; block-volume keys are scoped
`block-volume-<action>`, and VM volume actions `<cloud|gpu>-vm-attach-volume` /
`-detach-volume`, as in the Python SDK), and every automatic retry reuses it. A failed call reports the key in `err.idempotencyKey`; pass it back
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
  downgrade. `request.plan_id` (with optional `billing_term` and
  `windows_license`) takes cpu/ram_mb from the plan and builds the new SKU.
- **`precheckResize`:** with `plan_id` only the plan's shape is used (no SKU or
  Windows licence is needed).
- **`resizeRootDisk`:** can only grow the disk.
- **`updateAccess`:** checks the key mode, keys and password rules
  (8+ characters, no line breaks). Like the portal and the Python SDK it reads
  the VM by default: the VM must be a running Linux VM, password login can be
  disabled only while a key remains, removing the last key needs
  `confirm_remove_last_ssh_key`, and `admin_username` defaults to the VM's.
  `checkState: false` skips the read (a 403 on it is not skipped).
  `ssh_key_secret_refs` entries need `ssh_key_id` or `secret_name` (the API
  fills the other); `store_key` defaults to `ssh-keys`.
- **`checkState: true`:** applies the portal's state matrix (start only when
  stopped, stop/reboot only when running).
- **`attachVolume`:** reads the volume first and uses its Block Storage SKU.
  The VM must be running, stopped or in error (checked by default when the
  token can read the VM; `checkState: false` skips it).
- **Idempotency keys** you pass are validated before any request; `null` is
  treated like an omitted key.
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
- **`updateBackupPolicy`** merges your changes into the saved schedule
  (the schedule's shape and ranges are checked before any request).
- **`deleteSnapshot({ checkState: true })`** refuses a running or restoring
  snapshot. `createSnapshot({ wait })` and `waitForSnapshot` accept
  `succeeded` or `available` and fail fast with `RecoveryFailedError`.
- **`restoreBackup`** accepts a run ID or a recovery point ID. It always reads
  the run (also with `checkState: false`), requires it to have succeeded, and
  sends the recovery point ID resolved like the portal: the run's
  `recovery_point_id`, then `metadata.recovery_point_id` /
  `metadata.recoveryPointId`, then the `/recovery-points/<id>` segment of
  `r2_prefix`, `metadata.r2_manifest_key` or `metadata.r2_prefix`
  (`resolveBackupRecoveryPointId`).

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

- the target plan: your `target_plan_id`, or the VM's own plan. It must be
  selectable (pricing is not required) with a disk at least the recovery
  point's root disk. It sets the `target_*` fields and `target_billing_catalog`.
- for snapshot restores into a VPC, the shared VPC rules: `nat` only in a NAT
  Gateway VPC, no dedicated public IP in a NAT Gateway VPC.
- the default names, `<vm>-snapshot-restored-YYYYMMDD` for the VM and
  `<volume>-backup-restored-YYYYMMDD` for volumes, using the recovery point
  date in UTC.

`volume_only` needs `selected_volume_id`.

Two methods, `listAllBackupRuns` (workspace-wide) and `deleteBackupRun`, need
the backend release that provides them: currently available on the
development environment; production returns 404/405 until then. They are not
yet part of the published API contract; behaviour may change.

## Networking

Networking calls apply the portal's rules before sending and throw
`IbeeValidationError` (with `code` and `field`) when a request would be
refused. The codes match the Python SDK and the CLI, for example
`subnet_outside_vpc`, `subnet_overlap`, `address_outside_subnet`,
`address_not_usable`, `address_is_gateway`, `nat_gateway_unavailable`,
`reserved_ip_site_mismatch`, `reserved_ip_attached`,
`reserved_ip_unavailable`, `reserved_ip_attached_to_service`,
`reserved_ip_not_movable`, `virtual_ip_has_reserved_ip`, `duplicate_name`
and `invalid_auto_cidr`.

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
- `vpcs.delete` runs the dependency checks the API also enforces, by default
  and whenever `deleteNatGateway` is set: attached nodes (`vpc_has_nodes`), a
  NAT gateway unless `deleteNatGateway: true` (`vpc_has_nat_gateway`), then
  virtual IPs (`vpc_has_virtual_ips`). Only then is the NAT gateway deleted
  (`natIpAction` and `natBillingCatalog` are passed to it) and the SDK waits
  for it to go; if it is still listed, `IbeeError` with code
  `nat_gateway_deleting` is thrown (retry shortly). Without `network.read`
  (403) the default checks are skipped; `checkDependencies: true` re-throws
  the 403, and `checkDependencies: false` without `deleteNatGateway` sends a
  plain DELETE.
- An explicit subnet `cidr` with `autoCidr: true` is refused
  (`invalid_auto_cidr`), as for VPCs.

**NAT gateways and port forwarding**

- `createNatGateway` needs a `nat_gateway` VPC (`validateVpc`, default true).
  It accepts `billingCatalog` (NAT-GATEWAY SKU) and `preflightBilling`.
- `deleteNatGateway` accepts `publicIpAction` (`reserve`/`release`),
  `billingCatalog` and `wait`. Reserving a platform address needs the
  RESERVED-IP catalog. `defaultNatDeleteIpAction` returns the portal
  default. A gateway still listed after the wait throws `IbeeError`
  (`nat_gateway_deleting`), not a validation error: the delete was accepted.
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
- `listGroupSummaries` returns the portal list view (rule and VM counts);
  without `limit`/`offset` it fetches every page, like `listGroups`.
  `iterateGroupSummaries` and `listAllGroupSummaries` page through all of
  them (`pageSize` 1..100, default 100).

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

## Storage

Block Storage, Object Storage and CDN calls apply the portal's rules before
sending and throw `IbeeValidationError` (with `code` and `field`) when a
request would be refused.

**Block Storage**

```ts
const { volume } = await client.blockStorage.createVolume({
  workspaceId: "710995",
  name: "data-01",        // 3..255 of a-z, 0-9 and "-"
  size_gb: 100,           // whole GB, 10..10000
  site_id: "site_blr_01", // site_name is filled from the compute sites
});

// Attach to a VM like the portal: the SDK reads the volume, checks it is
// free, in the VM's site and for the VM's type, and sends its SKU.
await client.blockStorage.attachToVm({
  workspaceId: "710995",
  volumeId: volume.id,
  vmId: "64b0c0ffee0000000000abcd",
  wait: true, // poll every 2 s, up to 2 min, then re-read the volume
});

// Unmount it inside the server first.
await client.blockStorage.detachFromVm({
  workspaceId: "710995",
  volumeId: volume.id,
  confirmUnmounted: true,
  wait: true,
});
```

- A GPU VM can attach only a volume created with `vm_type: "gpu"`.
- Attaching needs the volume's Block Storage SKU, which the SDK reads from
  the volume (`block-storage.read`). Without that scope pass
  `billingCatalog`.
- `deleteVolume` refuses an attached or busy volume unless `force: true`
  (which detaches it from every server and erases its data).
- `resizeVolume` only grows. An attached volume needs `vm_state: "stopped"`
  (or `"suspended"`) or `allow_online: true`. Grow the filesystem inside the
  server afterwards.
- `listVolumes` returns one page; `listAllVolumes` / `iterateVolumes` read
  every volume.
- `attachVolume` / `detachVolume` on `client.blockStorage` are advanced
  node-level calls that do not attach the disk to a VM.

**Object Storage**

- Bucket names: 3..63 lower-case letters, digits and hyphens, starting and
  ending with a letter or digit.
- `region` defaults to `in-south-1` on production and `in-south-2` on
  development.
- `defaultRetention: { mode: "GOVERNANCE" | "COMPLIANCE", days | years }`
  turns Object Lock on. Object Lock buckets cannot be deleted.
- `deleteBucket` deletes only an empty bucket; the SDK checks first.
- `updateBucket({ isPublic: false })` also disables the public URL and
  deletes any CDN distribution that uses the bucket.
- `createS3Credential` defaults to `permissionType: "admin_rw"` (all
  buckets). To limit a key to some buckets use an object permission:

```ts
const key = await client.objectStorage.createS3Credential({
  workspaceId: "710995",
  name: "uploader",
  permissionType: "object_rw",
  bucketScope: "specific",
  allowedBuckets: ["my-bucket"],
});
// key.secret_access_key is returned only once. S3 endpoint:
// s3EndpointForWorkspace("710995") -> https://710995.blob.ibeestorage.com
```

- `revokeS3Credential` / `deleteS3Credential` permanently delete the
  credential.

**CDN**

- `createDistribution` needs a public origin bucket
  (`checkOriginPublic: true` checks it first; the check is skipped when the
  bucket cannot be read by that name, 404, or by this token, 403). Creating again for the same
  bucket returns the existing distribution.
- `purgeCache` throws `IbeeCdnPurgeError` when the CDN reports
  `success: false`:

```ts
import { IbeeCdnPurgeError } from "ibee-sdk";

try {
  await client.cdn.purgeCache({
    workspaceId: "710995",
    distributionId: "dist_123",
    request: { mode: "url", paths: ["/index.html", "assets/app.js"] },
  });
} catch (err) {
  if (err instanceof IbeeCdnPurgeError) console.error(err.mode, err.message);
}
```

- `createCustomDomain` returns the CNAME record to add at your DNS
  provider; `waitForCustomDomain` then verifies every 15 s until it is
  `active` or `failed`.

These are not yet part of the published API contract: `cdn.listCachePolicies`,
`cdn.getDistributionMetrics`, the volume `vm_type` / `delete_on_termination`
fields and the volume delete `idempotency_key` query parameter.

## Waiting for operations

VM creates, deletes, power actions, resizes and volume changes return an
`OperationAccepted`. Pass `wait: true` (or wait options) to any of
them, or wait for the result with `operations.wait`:

```ts
import { OperationFailedError, OperationTimeoutError } from "ibee-sdk";

const accepted = await client.cloudVms.start({ workspaceId: "710995", vmId: "64b0c0ffee0000000000abcd" });
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
| `client.secretStore` | stores (list, listAll, iterate, create, get, update, archive, unarchive, permanently delete), secrets (list, listAll, iterate, create, batch create, get, delete, value get/update/patch, undelete, destroy versions, permanently delete, versions, rollback), identities (list, create, get, update, enable, disable, access, rotate secret ID, revoke sessions, delete) and identity scopes (list, create, update, delete) |
| `client.objectStorage` | bucket list/listAllBuckets/iterateBuckets/create/get/update/delete and S3 credential list/create/get/revoke/delete |
| `client.blockStorage` | volume list/listAllVolumes/iterateVolumes/create/get, operations, attachToVm/detachFromVm, node-level attach/detach, resize, and delete |
| `client.cdn` | distributions, cache policies, metrics, static website configuration, custom domains (waitForCustomDomain), URL generation, and cache purge |
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
