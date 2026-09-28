# Changelog

## 0.4.0

### Added

- Typed error classes for every status the API returns, all extending
  `ApiError`: `BadRequestError`, `InvalidWorkspaceError`, `UnauthorizedError`,
  `PaymentRequiredError`, `BillingDeniedError`, `ForbiddenError`,
  `InsufficientScopeError`, `WorkspaceNotAllowedError`, `ApiKeyInactiveError`,
  `RouteNotAvailableError`, `OrganizationRestrictedError`,
  `BillingForbiddenError`, `NotFoundError`, `ConflictError`,
  `PayloadTooLargeError`, `UnprocessableEntityError`,
  `OrganizationSuspendedError`, `TooManyRequestsError`, `InternalServerError`,
  `BadGatewayError`, `BillingAdmissionError`, `ServiceUnavailableError` and
  `GatewayTimeoutError`. `ApiError` gains `code`, `rawCode`, `reason`,
  `requiredScope`, `billingSkuCode`, `admissionContextId`, `details`,
  `headers`, `requestId`, `retryAfterSeconds`, `idempotencyKey` and
  `retryable`. `apiErrorFromResponse` and `parseErrorBody` are exported.
- `IbeeError` base class and `IbeeValidationError` (with `code` and `field`)
  for input rejected before any request is sent.
- `operations.wait` (and `waitForComputeOperation`) polls an async compute
  operation until it succeeds, fails (`OperationFailedError`) or the client
  deadline passes (`OperationTimeoutError`). Defaults: 20 min timeout, 5 s
  interval; tolerates 3 consecutive transient poll failures; supports
  `AbortSignal` and `onUpdate`.
- Automatic retries (`maxRetries`, default 2) for retry-safe requests on
  429/502/503/504 and network errors, honouring `Retry-After` (capped at 30 s).
- `cloudVms.iterate`, `gpuVms.iterate` and `firewalls.iterateGroups`; `limit`,
  `offset`, `search`, `sortBy` and `sortDirection` on VM lists and `limit`,
  `offset` on firewall-group lists.
- `billing.checkResourceEligibility` accepts `operation`; the
  `BillingEligibility` type now includes `service_enforcement_state`,
  `enforcement_*`, `operation`, `allowed_operations` and `resource_limits`.
- `billing.requireResourceEligibility` accepts `resourceType` for the denial
  message.
- Helpers: `billingBlockMessage`, `isBillingTopupAllowed`,
  `isPaymentBlockError`, `estimateEligibilityCostMinor`, `minimumTopupMinor`,
  `CREATE_TYPE_LABELS`, `buildIdempotencyKey`, `buildStableIdempotencyKey`,
  `isRetrySafe`, `retryDelayMs`, `paginateOffset`, `paginatePages`,
  `pollUntil`, `resolveBaseUrl`, `checkTokenEnvironment`,
  `environmentFromName` and the validators in `validation`.
- Block-volume writes accept `idempotencyKey`.
- `IbeeEnvironment.PRODUCTION` (same value as `DEFAULT`) and `VERSION`.

- **Compute (VMs), portal parity.** `cloudVms.create` / `gpuVms.create`
  resolve the plan and image from the compute catalog and fill `cpu`,
  `ram_mb`, `disk_gb` (always sent), `os_type`, `os_distro` and the GPU fields
  from them. They build `billing_catalog` for the new `billing_term`
  (`HOURLY` / `MONTHLY` / `YEARLY`) and accept `ssh_keys`,
  `firewall_group_ids` (at most one), `vpc_id` / `subnet_id` /
  `network_connectivity`, `reserved_public_ip_id` (its SKU is attached),
  `windows_license` (attached with quantity = vCPUs), `preflightBilling`,
  `resolveCatalog` and `wait`.
- `cloudVms.listAll` / `gpuVms.listAll`, and `pageSize` on `iterate`.
- `delete` accepts `publicIpAction` (`release` / `reserve`),
  `reservedIpLabel`, `reservedIpBillingCatalog` and `preflightBilling`.
- `resize` / `precheckResize` accept `plan_id` and `billing_term`, and
  `resize` accepts `skipPrecheck`. `resizePlan` / `resizeRootDisk` accept
  `billing_catalog`.
- `checkState` on power, access, resize and volume actions applies the
  portal's VM state rules. `wait` on every async VM action returns the final
  operation in `result.operation`.
- `operations.waitFor` (2 s / 2 min defaults used for volume attach and
  detach).
- **Recovery.** New methods:
  - `waitForSnapshotRestore`, `waitForBackupRestore` and `wait` on restores,
    snapshot creates and manual backup runs;
  - `getBackupPolicyOrNull`;
  - `listBackupRuns({ restorableOnly })`;
  - `listAllBackupRuns` and `deleteBackupRun`. These two are not yet part of
    the published API contract.

  Snapshot restores accept `vpc_id`, `subnet_id`, `network_connectivity` and
  `ssh_key_ids`. Both restore kinds accept `target_volume_names` and
  `target_billing_catalog`.
- `billing_catalog` on snapshot create, backup enable/update, manual backup
  run and VM attach-volume requests.
- Errors: `ResizeBlockedError` (409 with a precheck decision),
  `RecoveryFailedError` and `RecoveryRestoreFailedError`.
  `IbeeValidationError` now has `details`.
- Helpers:
  - billing catalog: `validateBillingCatalog`, `selectBillingOption`,
    `billingCatalogForTerm`, `withAttachedBillingSkus`,
    `buildVmCreateBillingCatalog`;
  - VMs: `normalizeVmRecord`, `resolveDeletePublicIpAction`,
    `assertVmActionAllowed`, `expandBatchNames`, `validateSshPublicKey`;
  - backups: `validateBackupSchedule`;
  - restores: `recoveryDefaultVmName`, `recoveryTargetVolumeNames`,
    `recoveryMinRootDiskGb`, `restoreTargetFromPlan`;
  - the VM and recovery validators in `validation`.

- **Networking, portal parity.** New methods:
  - `vpcs.replaceNatGatewayPublicIp`, `vpcs.waitForNatGatewayAbsent` (and
    `waitForNatGatewayAbsent`);
  - `vpcs.listVirtualIps`, `getVirtualIp`, `createVirtualIp` and
    `deleteVirtualIp`;
  - `reservedIps.convert` and `reservedIps.attachVirtualIp`;
  - `firewalls.listGroupSummaries`, `iterateGroupSummaries` and
    `listAllGroups`.

  Of these, the NAT public-IP swap, the virtual-IP methods, convert,
  attach-virtual-IP and group summaries are not yet part of the published
  API contract.
- New request fields (not yet in the published contract):
  - VPC create: `natBillingCatalog`, `connectivityType: "private"`,
    `checkSite`;
  - NAT create: `billingCatalog`, `validateVpc`, `preflightBilling`;
  - NAT delete: `publicIpAction`, `billingCatalog`, `checkDependencies`,
    `wait`;
  - port forwarding: `targetType`, `targetVmIds`;
  - node attach: `requestedPrivateIp`, `checkVpc`;
  - VPC delete: `checkDependencies`, `deleteNatGateway`, `natIpAction`;
  - `listSites({ availableOnly })`;
  - Reserved IP reserve: `billingCatalog`, `checkBilling`;
  - Reserved IP attach: `detachFromService`;
  - load-balancer create/update: `policy`, `healthCheck`, `observability`;
  - load-balancer create: `checkBilling`;
  - load-balancer list/get: `includeDeleted`.
- `ReservedIpTargetUnsupportedError` (an `IbeeValidationError`, status
  404): a Reserved IP attach or move targets a VM without a VPC attachment.
- Constants `NAT_GATEWAY_SKU_CODE`, `RESERVED_IP_SKU_CODE` and
  `LOAD_BALANCER_SKU_CODE`. A `nat_gateway` billing label is added, so NAT
  gateway billing denials read "NAT gateway".
- Networking helpers:
  - IP and CIDR parsing: `parseIpv4`, `parseIpv4Cidr`, `validateVpcCidr`,
    `validatePrivateCidr`, `cidrContains`, `cidrOverlaps`,
    `validateHostInSubnet`, `isPrivateIpv4`;
  - portal defaults: `resolveNodeConnectivity`, `defaultNatDeleteIpAction`,
    `networkBillingCatalog`, `validateNetworkBillingCatalog`;
  - Reserved IPs and firewalls: `reservedIpAttachmentKind`,
    `validateReverseDns`, `normaliseRemoteTargets`, `parsePortRange`;
  - request bodies: `buildFirewallRuleBody`, `buildLoadBalancerBody`,
    `buildVpcCreateBody`, `buildSubnetCreateBody`,
    `buildPortForwardingCreateBody` and the rest of the networking
    validators.
- Types:
  - new: `VpcVirtualIp`, `VpcAttachedNode`, `FirewallGroupSummary`,
    `LoadBalancerPolicy`, `LoadBalancerHealthCheck`,
    `LoadBalancerObservability`;
  - `NatGateway` gains `public_ip_source`, `billing_catalog`, `billing_*_at`
    and `deleted_at`;
  - `NatPortForwardingRule` gains `port_forward_rule_id`, `target_type`,
    `target_vm_ids`, `network_allocation_id` and `vm_id`;
  - `NetworkAllocation` gains `prefix_length`, `subnet_mask`, `gateway`,
    `dns` and the NAT/public-IP fields;
  - `ReservedIp` gains `allocation_method`, `attached_allocation_id`,
    `attached_network_id` and related fields;
  - `LoadBalancer` gains `custom_domain`, `activated_at`, `deleted_at` and
    `deleted_by`.

- Storage (Block Storage, Object Storage, CDN) follows the portal:
  - `blockStorage.attachToVm` / `blockStorage.detachFromVm`: attach a volume
    to (or detach it from) a cloud or GPU VM the way the portal does. The SDK
    reads the volume, picks the VM endpoint from its `vm_type`, uses its
    Block Storage SKU as `billing_catalog`, and with `wait` polls the
    operation (every 2 s, up to 2 min) and re-reads the volume;
  - `blockStorage.listAllVolumes` / `iterateVolumes`; `listVolumes` takes
    `siteId`, `vmType`, `limit` (1..1000) and `offset`;
  - `blockStorage.listVolumeOperations` takes `limit` (1..200);
  - `blockStorage.createVolume` accepts `vm_type` and
    `delete_on_termination`, and `resolveSiteName` (default true) fills
    `site_name` from the compute sites (not yet part of the published API
    contract; behaviour may change);
  - `objectStorage.listAllBuckets` / `iterateBuckets` follow continuation
    tokens;
  - `objectStorage.deleteS3Credential`, an alias of `revokeS3Credential`
    whose name matches what the API does (a permanent delete);
  - `createBucket`, `createS3Credential`, `cdn.createDistribution` and
    `cdn.createCustomDomain` accept `preflightBilling` (OBJECTST-STD,
    CDN without a SKU, CUSTOMDO-STD with 19 900 minor units, as the portal
    checks);
  - `cdn.createDistribution({ checkOriginPublic: true })` refuses a private
    origin bucket before creating;
  - `cdn.listCachePolicies` and `cdn.getDistributionMetrics({ range })`
    (`24h`, `7d`, `30d`). Not yet part of the published API contract;
    behaviour may change;
  - `cdn.waitForCustomDomain`: calls verify every 15 s until `active` or
    `failed` (up to 10 min), else `CdnDomainVerificationTimeoutError`;
  - `IbeeCdnPurgeError` (also exported as `CdnPurgeFailedError`) for a purge
    the CDN reported as `success: false`;
  - `cloudVms.attachVolume` / `gpuVms.attachVolume` accept `volume` (a
    volume you already read) to skip the volume GET;
  - constants `OBJECT_STORAGE_SKU_CODE`, `CDN_CUSTOM_DOMAIN_SKU_CODE`,
    `CDN_CUSTOM_DOMAIN_ESTIMATED_COST_MINOR`, `CDN_CACHE_POLICIES`,
    `CDN_PURGE_MODES`, `S3_PERMISSION_TYPES` and the other storage enums;
  - validators and builders: `validateBlockVolumeName`,
    `validateBlockVolumeCreateSize`, `validateBlockVolumeId`,
    `buildBlockVolumeCreateBody`, `assertVolumeAttachable`,
    `resolveSingleAttachment`, `validateVolumeResize`,
    `validateNodeSafeDetach`, `validateBucketName`,
    `resolveObjectStorageRegion`, `buildBucketCreateBody`,
    `assertBucketDeletable`, `buildS3CredentialBody`,
    `s3EndpointForWorkspace`, `validateCdnDistributionFields`,
    `validateCdnIndexDocument`, `normalizeCdnDomain`, `buildCdnPurgeBody`,
    `validateCdnUrlRequest`, `validateCdnMetricsRange`;
  - types: `CdnCachePolicy`, `CdnCachePolicyList`, `CdnDistributionMetrics`,
    `CdnDistributionDeleteResult`, `CdnCustomDomainDeleteResult`,
    `AttachVolumeToVmArgs`, `DetachVolumeFromVmArgs`,
    `VolumeVmActionResult`, `ListVolumesArgs`; `BlockVolume` gains
    `vm_type`, `volume_kind`, `volume_name`, `attached_vm_id`,
    `attached_vm_name` and metadata fields; `Bucket`/`BucketSummary` gain the
    fields the API returns (`is_public`, `bucket_lock_enabled`,
    `site_name`, `object_count`, `total_size`, `updated_at`, ...);
    `S3Credential` gains `permission_type`, `bucket_scope`,
    `allowed_buckets`, `organization_id`, `workspace_id`;
    `CdnDistribution` gains `bucket_name`, `project_id`, `deleted_at`;
    `CdnCustomDomain` gains `cf_custom_hostname_id` and `validation`.

- **Secret Store portal parity** (`client.secretStore`):
  - `listAllSecretStores` / `iterateSecretStores` and `listAllSecrets` /
    `iterateSecrets` page through every store or secret (200 per page).
  - `createSecretStore` and `createSecret` accept `billingPreflight`
    (SECRETMA-STD, as the portal checks before both); skipped with an
    `IbeeBillingWarning` when the token lacks `billing.read`.
  - `createSecretStore({ ifExists: "return" })` returns the existing store
    with that name or store key (archived included) instead of throwing
    `ConflictError`, as the portal does.
  - `rollbackSecret({ checkTarget })` (default true) refuses the current,
    destroyed or missing version after reading the versions.
  - `createSecretIdentityScope({ checkStore })` refuses stores that are not
    active or already granted, and write access for a read-only identity.
  - `rotateSecretIdentitySecretId({ checkAuthMethod })` refuses Kubernetes
    and disabled identities.
  - `undeleteSecret` without `versions` restores the current version.
  - Every method accepts `signal`.
  - Errors: `ResourceNotFoundError`, `OrganizationLifecycleError`,
    `StoreNotActiveError`, `IdentityDisabledError`,
    `AuthMethodMismatchError`, `ScopePermissionError` (all `ForbiddenError`),
    `StoreArchivedError`, `StoreDeletingError` (`ConflictError`),
    `CasConflictError` (`BadGatewayError`) and `DeletionIncompleteError`
    (`ServiceUnavailableError`, with `failedSteps`).
  - Validation helpers: `normalizeSecretName`, `normalizeSecretValue`,
    `normalizeStoreName`, `normalizeStoreDescription`,
    `normalizeSearchQuery`, `validateResourceId`, `validatePagination`,
    `validateVersion`, `validateVersions`, `validateCas`,
    `validateIdentityCreate`, `validatePolicyMode`,
    `validateScopePermissions`, `validateOptionalBoolean`, `assertBodySize`,
    `checkRollbackTarget`, `checkScopeStoreEligibility`,
    `assertRotateAllowed`, `isSecretStorePath` and the constants
    `SECRET_NAME_PATTERN`, `SECRET_STORE_WORKSPACE_ID_PATTERN`,
    `MAX_SECRET_BATCH_SIZE`, `MAX_SECRET_VERSIONS_PER_REQUEST`,
    `MAX_SECRET_STORE_BODY_BYTES`, `SECRET_STORE_MAX_PAGE_LIMIT`,
    `SECRET_IDENTITY_AUTH_METHODS`, `SECRET_POLICY_MODES` and
    `SECRET_MANAGER_SKU_CODE`. `validateWorkspaceId` accepts
    `"secret-store"` as a second argument.

### Changed

- **Lists auto-page.** `cloudVms.list`, `gpuVms.list` and
  `firewalls.listGroups` without `limit`/`offset` now return every item
  instead of the server's first 10.
- **Token/environment check.** An `ibee_dev_key_` token against production or
  an `ibee_prod_key_` token against development throws
  `IbeeValidationError` (`token_environment_mismatch`) at construction.
  Tokens containing line breaks are rejected (`invalid_token`), and the base
  URL must be `https` (plain `http` only for localhost) without credentials,
  query or fragment (`invalid_base_url`).
- **Billing denial.** `requireResourceEligibility` throws
  `BillingDeniedError` (402, code `billing_denied`, portal wording,
  `topupAllowed`) instead of an `ApiError` whose body code was
  `BILLING_CREATE_BLOCKED`. Malformed or SKU-mismatched decisions throw
  `BillingAdmissionError` (502, `invalid_billing_decision`). The SKU is now
  compared case-insensitively, since billing upper-cases it.
- `checkResourceEligibility` trims `skuCode` (blank is omitted, max 64),
  rounds `estimatedCostMinor` and rejects negative or non-finite values
  before sending.
- Generated VM idempotency keys now follow the portal format
  (`cloud-vm-start-<vm>-<hash>-<random>`) instead of a bare UUID. Caller keys
  must be 1-128 printable ASCII characters without spaces.
- Block-volume create/attach/detach/resize now always send a body
  `idempotency_key` and delete sends an `idempotency_key` query parameter,
  generated when not supplied.
- Workspace ID, idempotency key, operation ID and paging errors are
  `IbeeValidationError` (still an `Error`; messages unchanged for workspace
  IDs).
- `ApiError.message` now carries the server's message when there is one,
  instead of always `IBEE API error <status>`.
- `BillingState`, `BillingMode` and `ComputeOperationStatus` are open unions,
  so new server values do not break type checks.
- Billable creates larger than 64 KiB are rejected client-side
  (`request_body_too_large`), matching the gateway limit.

- **VM create sends what the API requires.** 0.3.0 creates always failed
  with 422, because `billing_catalog` was missing. `site_id` is now required
  (`site_required`) and `disk_gb` is always the plan's, instead of the
  server's 50/140 GB default. `cpu`, `ram_mb`, `os_type` and `os_distro` (and
  GPU `gpu_count`/`gpu_model`) are optional and must match the plan and
  image. VM creates are no longer retried automatically.
- **VM delete asks about the public IP.** When `publicIpAction` is omitted,
  the SDK reads the VM and sends `public_ip_action: "release"` for an
  auto-assigned public IP (the portal default). 0.3.0 deletes of such VMs
  failed with 400.
- **Resize runs the precheck first.** It submits only when the decision is
  `in_place`, and otherwise throws `IbeeValidationError`
  (`resize_not_in_place`, precheck in `details`). With `plan_id` it also
  sends the target plan's `billing_catalog`, so billing follows the new plan.
- **`resizePlan` and `resizeRootDisk` read the VM first.** They reject no-op
  changes, unconfirmed downgrades and root-disk shrinks.
- **ID validation.** VM IDs must be 24-character hex IDs and operation IDs
  must look like `op_<24 hex>`; anything else throws `invalid_vm_id` /
  `invalid_operation_id` before any request, so the old `vm/1` / `all`
  shapes no longer reach the API.
- **VM records.** List, listAll and get results carry `id` (copied from
  `_id`).
- **Access updates** are validated locally: key mode, SSH key format,
  password of 8+ characters with no line breaks, and at least one change.
- **Recovery requests are validated:**
  - snapshots: name 1-255, the selective-mode volume rule, a required
    `snapshot_storage` `billing_catalog`;
  - backups: daily/weekly schedules only, `day_of_week` required for weekly,
    IANA time zones, retention ranges, a required `backup_storage` SKU on
    enable and run;
  - timestamps: `next_run_at` must carry a time zone (a `Date` is accepted);
  - restores: mode combinations, and `new_vm` plan resolution with default
    names.
- **Backup changes:**
  - `enableBackups` re-sends the saved settings on re-enable, otherwise the
    portal defaults;
  - `updateBackupPolicy` merges into the saved schedule and refuses disabled
    policies;
  - backup restores no longer send `auto_start`, and snapshot restores send
    `auto_start: true` by default.
- **Metrics and events:** metrics `range`, bandwidth `month` (`YYYY-MM`,
  default the current UTC month) and events `limit` (1..500) are validated.
- **Recovery paging:** recovery lists allow `limit` 1..200.
- **Volumes:**
  - `attachVolume` reads the volume and uses its Block Storage SKU. It
    refuses attached or busy volumes and site mismatches.
  - `detachVolume` needs `confirm_unmounted: true` or `force: true`.
- **Console:** `vmConsole.createSession` rejects GPU VMs and sends `vm_type:
  "cloud"`, `console_type: "graphical"` and `requested_by: "api"` by default.

- **Networking requests are validated like the portal:**
  - names: VPC and subnet 1..80, NAT gateway 1..80, firewall group 1..120,
    load balancer 1..128, Reserved IP label <= 120;
  - VPC CIDRs: RFC1918, aligned, /22../28. An explicit `cidr` now sends
    `auto_cidr: false`;
  - subnet CIDRs: RFC1918, aligned, /29 or larger; `cidr` and
    `prefixLength` together are rejected;
  - DNS lists: IPv4 addresses;
  - ports: single integers 1..65535;
  - private IPs: must be private IPv4 addresses;
  - reverse DNS: must be a valid hostname;
  - PATCH calls need at least one field.
- **Subnet create reads the VPC first** (`checkVpc`, default true). It
  enforces containment in the VPC CIDR, no overlap with other subnets and the
  limit of 10 subnets.
- **NAT gateway create reads the VPC first** (`validateVpc`, default true).
  It refuses non-`nat_gateway` VPCs and ineligible Reserved IPs, and warns
  (`IbeeBillingWarning`) when no `billingCatalog` is sent.
- **Port-forwarding create/update run the portal checks** (`checkState`,
  default true): an available gateway, no duplicate protocol/external port,
  and a valid VM or VIP target. VIP announcers are filled in automatically.
  Setting `targetType: "vm"` on update sends `target_vm_ids: []`.
- **Reserved IP writes read the IP first** (`checkAttached` / `checkState`,
  default true):
  - release refuses an attached IP;
  - attach refuses an IP already on a VM (use move);
  - move refuses NAT, VIP, converted and provider-network IPs;
  - detach returns an already-detached IP without a request and refuses a
    converted IP that is still the VM's active address.
- **Firewall groups:** `createGroup` checks for case-insensitive duplicate
  names first (`checkDuplicateName`, default true). It rejects
  `isDefault: true` and never sends `is_default`, because such groups were
  hidden from lists.
- **Firewall rules:**
  - create sends the portal defaults (tcp, ingress, allow, `0.0.0.0/0`);
  - TCP/UDP rules need `portStart`;
  - remote targets are normalised and IPv6 is rejected;
  - update/delete refuse system-managed rules (`checkSystemManaged`, default
    true);
  - attach turns the server's "Only OVS/OVN-backed" 400 into
    `IbeeValidationError` (`firewall_attach_unsupported`).
- **Load balancers:**
  - `https` and `tls_passthrough` creates get managed TLS automatically;
    0.3.0 creates without `tls` failed with 422;
  - custom certificates (`certificate_source` other than `managed`,
    `cert_pem`/`key_pem`) are rejected;
  - sticky sessions are L7-only;
  - `customDomain` is L7 https-only;
  - backends are validated; at least one is required;
  - `list` rejects unknown statuses and layer/protocol mismatches, and
    `status: "deleted"` implies `include_deleted`.
- `Vpc.connectivity_type` includes `private`. `NatPricing` now describes
  `price_per_hour`, `data_price_per_gb` and `billing_enforced`, the fields
  the API returns; the old `hourly`/`monthly` fields are deprecated.
  `VpcDetail.attached_nodes` is typed `VpcAttachedNode[]`.

- **Block Storage checks run before sending:**
  - volume IDs must be 24-character hex IDs;
  - create: name 3..255 of lower-case letters, digits and hyphens (never
    renamed; the error suggests one), size a whole number of GB from 10 to
    10000, a non-blank `site_id`, `volume_class`, `replica_count` 1..5,
    `vm_type` `cloud`/`gpu`; `sku_code` is upper-cased and `ROOTDISK-*` is
    refused; server-managed fields (`volume_kind`, `billing_*`,
    `storage_performance`, attachment fields) are refused;
  - the create idempotency key is also sent as `X-Idempotency-Key`; generated
    block-volume keys use the `block-volume-<action>` scope shared with the
    Python SDK (`block-volume-create-`, `block-volume-attach-`,
    `block-volume-detach-`, `block-volume-resize-`, `block-volume-delete-`).
    VM volume actions (used by `attachToVm` / `detachFromVm`) keep the
    `<cloud|gpu>-vm-attach-volume-` / `-detach-volume-` scope;
  - `deleteVolume` reads the volume and refuses an attached ("Detach this
    volume from all servers before deleting.") or busy volume unless
    `force` (`checkAttachments: false` skips the read);
  - `resizeVolume` reads the volume (`checkState`, default true) and refuses
    a shrink, a busy volume, and an attached volume without `vm_state`
    stopped/suspended or `allow_online: true`;
  - node-level `detachVolume` needs `force`, `confirm_unmounted` or a
    stopped/suspended `vm_state`; `node_name` is now optional and read from
    the volume's single attachment;
  - node-level `attachVolume` checks `mode`, `vm_state`, `vm_type` and, with
    `vm_site_id`, the volume's site;
  - a 403 on the pre-check read (no `block-storage.read`) skips the check.
- **VM volume attach** (`cloudVms`/`gpuVms.attachVolume`) also refuses a
  volume created for the other VM type (it would fail later with "Volume
  not found"), and a 403 on the volume read asks for `billing_catalog`
  instead of failing.
- **Object Storage:**
  - `createBucket`: the name follows the portal rule (uppercase is refused,
    not lower-cased); `region` is now optional and defaults to `in-south-1`
    on production and `in-south-2` on development (required for other base
    URLs); a `defaultRetention` turns Object Lock on, needs exactly one of
    `days` (1..36500) or `years` (1..100), and cannot be combined with
    `objectLockEnabled: false`;
  - `deleteBucket` reads the bucket first and refuses an Object Lock bucket
    or one that still has objects (`skipPreflight` skips only the object
    count). The API never deletes objects: a non-empty bucket gets 409;
  - `updateBucket` requires a boolean `isPublic`. Making a bucket private
    also disables its public URL and deletes any CDN distribution using it;
  - `createS3Credential` always sends `permission_type` (default
    `admin_rw`), `bucket_scope` and `allowed_buckets`; `name` defaults to
    "Default Key" (1..100); admin permissions cannot be scoped to buckets;
    `bucketScope: "specific"` needs an `object_*` permission and at least one
    bucket;
  - `listBuckets` checks `limit` (1..1000) and `continuationToken`.
- **CDN:**
  - `createDistribution` sends `origin_type: "bucket"` and
    `cache_policy: "static-assets"` by default and checks the name
    (1..128), origin and cache policy (`static-assets`, `media`, `short`,
    `no-cache`);
  - `updateDistribution` needs at least one field;
  - `updateWebsiteConfig` sends `index_document` (default `index.html`) and
    checks it;
  - custom domains are trimmed and lower-cased; create requires a valid
    hostname with a subdomain;
  - `purgeCache` checks the mode and its selector (url 1..30 paths, https
    only for absolute URLs; hostname/tag/prefix 1..100) and now **throws
    `IbeeCdnPurgeError` when the API answers `success: false`**; pass
    `raiseOnFailure: false` for the 0.3.0 behaviour;
  - `generateUrl` checks `expires_in` (>= 1) and `disposition`;
  - `deleteDistribution` / `deleteCustomDomain` return the API's JSON
    result instead of `void`.

- **Secret Store input is checked before sending** (portal rules):
  - secret names are trimmed and lower-cased, then must match
    `^[a-z0-9][a-z0-9-]{1,63}$` (an upper-case name used to fail with 422);
  - secret values need at least one entry, with trimmed non-blank unique keys
    and non-blank string values (`patchSecretValue` allows `null`);
  - store names are trimmed (1..128, with a letter or digit on create);
    identity names are trimmed (1..128); descriptions are trimmed;
  - `workspaceId` must have 2..128 digits for Secret Store calls (single-digit
    workspace IDs were already refused by the service);
  - `page` >= 1, `limit` 1..200, `q` trimmed (omitted when blank, max 128);
    versions >= 1 and lists of 1..100 (de-duplicated); `cas` >= 0;
  - every Secret Store body is limited to 64 KiB (previously only store and
    secret creates);
  - `updateSecretStore` and `updateSecretIdentityScope` need at least one
    field; `updateSecretIdentity` requires `tokenPolicyMode`;
  - `createSecretIdentity` always sends `token_policy_mode` (default
    `read_only`), trims the Kubernetes fields, requires them for
    `kubernetes` and refuses them for `approle` (no more `null` fields);
  - `createSecretIdentityScope` sends the portal defaults explicitly
    (`read_only`, version reads allowed, no rollback or destroy) and refuses
    rollback or destroy on a `read_only` scope.
- Secret Store 403 answers "<Store|Secret|Identity|Scope> '…' does not belong
  to workspace '…'" now raise `ResourceNotFoundError` instead of
  `WorkspaceNotAllowedError` (the service answers 403 for missing resources).
- `OrganizationRestrictedError` also recognises lower-case lifecycle states
  (`… while organization is suspended`).
- `getSecretIdentityAccess` is never retried automatically: every call mints
  a new AppRole secret ID.
- Secret Store methods now return rejected promises for invalid input
  instead of sending the request.

- **Review fixes (parity with the Python SDK, CLI and portal):**
  - `cloudVms/gpuVms.updateAccess` reads the VM by default (running Linux VM,
    password-login and last-key rules, `admin_username` default);
    `checkState: false` opts out.
  - `attachVolume` checks the VM state (running, stopped or error) by default
    when the VM is readable, with an "attach a volume to" message
    (`VmStateAction` gains `attach-volume` / `detach-volume`); with a caller
    `billing_catalog` and `checkState: false` nothing is read.
  - `resizePlan` accepts `plan_id`, `billing_term` and `windows_license`
    (cpu/ram_mb and the SKU come from the plan; `cpu` / `ram_mb` are optional
    in `VmResizePlanRequest`). `resize` accepts `windows_license`.
  - `precheckResize({ plan_id })` resolves only the plan's shape, so Windows
    VMs without a licence on record can be prechecked.
  - `create` with `resolveCatalog: false` requires `disk_gb` (and `gpu_count`
    for GPU VMs).
  - New-VM restores accept a selectable plan without pricing; errors are
    `invalid_restore_plan` / `restore_disk_too_small`. Snapshot restores into
    a VPC apply the shared NAT / public-IP VPC rules before sending.
  - `restoreBackup` sends the run's `recovery_point_id` (a run ID is
    accepted as input) and refuses a run without one.
  - `deleteSnapshot` accepts `checkState` (refuses running/restoring
    snapshots, `snapshot_busy`); new `waitForSnapshot`; snapshot waits accept
    `available` and read the status from the VM's snapshot list while the
    snapshot is not yet readable by ID.
  - `vpcs.delete` reads the VPC by default (nodes / NAT gateway checks;
    `checkDependencies: false` skips it) and accepts `natBillingCatalog`.
  - `firewalls.iterateGroups` / `listAllGroups` accept `pageSize` (1..100) and
    de-duplicate by `firewall_group_id` or `id`.
  - Load balancer `policy.retries` gets the portal defaults (3 attempts,
    5000 ms, `5xx`/`reset`/`connect-failure`) for fields left out.
  - `listAllSecretStores` / `iterateSecretStores` include archived stores by
    default (`includeArchived: false` hides them), and Secret Store
    `listAll*` helpers no longer stop at 10,000 items.
  - Skipped Secret Store pre-checks emit an `IbeeSecretStoreWarning`.
  - New `chunkBatchSecrets` splits large batch imports (500 items / 64 KiB).
  - New `SecretValueNotFoundError` (404 on a value or version) and
    `ScopeValidationError` (422 read-only scope); `ResourceNotFoundError` now
    extends `WorkspaceNotAllowedError`; `ApiError.hint` carries suggestions.
  - `BILLING_ADMISSION_CODES`, `createTypeForPath`, `validatePathId`,
    `VOLUME_OPERATION_FAILED_MESSAGE` and `VOLUME_OPERATION_TIMEOUT_MESSAGE`
    are exported; `CdnPurgeFailedError` is also a type.
  - `IbeeValidationError.code` values now match the Python SDK and CLI:
    `invalid_name` (store / identity names), `invalid_secrets` (batch size),
    `rollback_to_current` / `unknown_version` / `version_destroyed`,
    `auth_method_mismatch` / `identity_disabled` (field `identity_id`),
    `scope_already_exists` / `store_not_active` / `store_not_found`,
    `scope_permission_denied` (field `access_mode`), `duplicate_name`,
    `nat_gateway_unavailable`, `subnet_outside_vpc` / `subnet_overlap`,
    `address_outside_subnet` / `address_not_usable` / `address_is_gateway`,
    `reserved_ip_attached_to_service`, `reserved_ip_site_mismatch` /
    `reserved_ip_attached` / `reserved_ip_unavailable` /
    `reserved_ip_not_user_reserved`, `virtual_ip_has_reserved_ip`,
    `reserved_ip_not_movable` and `invalid_auto_cidr`.
  - A NAT gateway still listed after `deleteNatGateway({ wait: true })`
    throws `IbeeError` with code `nat_gateway_deleting` (was an
    `IbeeValidationError` `nat_delete_pending`; the delete had been accepted).
  - Operation IDs accept upper-case hex (as in the Python SDK).
  - Secret Store `workspaceId` is trimmed before it is validated and sent.

### Fixed

- A token missing a scope (403 `insufficient_scope`) is no longer reported by
  `isPaymentBlockError` as a payment block.
- Deterministic billing admission failures (502 `invalid_billing_decision`,
  `block_storage_plan_unavailable`, ...) are no longer retried and report
  `retryable: false`.
- `billing.requireResourceEligibility` checks that the decision confirms the
  SKU before the `allowed` flag, so a malformed denied decision is a
  `BillingAdmissionError`, as at the edge and in the Python SDK.
- S3 credential billing denials read "S3 credential" (create type
  `s3_credential`), not "object storage bucket".
- `billingBlockMessage` matches the billing state and create type in any case.
- `idempotencyKey: null` on VM writes generates a key again (as in 0.3.0).
- Caller idempotency keys and backup schedules are validated before any
  request.
- VM delete without `vm.read` sends the portal default
  `public_ip_action: "release"` instead of failing on the pre-read.
- `.` and `..` are refused as path IDs (snapshot, restore, run, recovery
  point and networking IDs) instead of reaching a collection route.
- `blockStorage.attachToVm` / `detachFromVm` validate `vmId` before any
  request; `attachToVm` no longer reads the volume twice without
  `block-storage.read`; `detachFromVm` works without `block-storage.read`
  when `vmId` is given.
- Volume attach/detach waits use the portal wording ("Volume operation
  failed", "Operation timed out. Please refresh to check the latest state.").
- `createVolume` skips the optional `site_name` lookup on any lookup failure
  (5xx, network), not only 403/404.
- A subnet `cidr` with `autoCidr: true` is refused instead of silently
  overriding `autoCidr`.
- `createNatGateway` retries with the same Reserved IP are no longer refused
  when the VPC already has a NAT gateway.
- `updatePortForwardingRule({ targetType: "vip", checkState: false })`
  without announcers is refused locally instead of failing on the server.
- Secret Store body size is checked before the billing preflight; a
  `createSecretStore({ ifExists: "return" })` lookup the token cannot read
  keeps the original `ConflictError`.
- VM, GPU VM and firewall-group lists no longer silently stop at 10 items.
- VM create, snapshot create, backup enable, manual backup run and VM volume
  attach no longer always fail with 422 for a missing `billing_catalog`.
- Firewall groups created with `isDefault: true` no longer disappear from
  lists (the flag is refused).
- HTTPS / TLS-passthrough load balancers can be created without passing
  `tls`.

- Attaching a block volume to a VM no longer fails with 422 (the volume's
  Block Storage SKU is sent as `billing_catalog`).
- `createS3Credential` without `permissionType` no longer fails with 422.
- Block Storage idempotency keys now reach the backend (body/query), so
  retries of creates, attaches, detaches, resizes and deletes are
  de-duplicated.
- CDN cache purges that failed upstream are no longer reported as success.
- `Bucket` and `S3Credential` types now match the fields the API returns;
  the 0.3.0 field names are kept as deprecated optional fields.

- Secret names with upper-case letters or surrounding spaces no longer fail
  with 422; they are normalised as in the portal.
- Secret Store lifecycle, archived-store, disabled-identity and
  missing-resource errors are no longer untyped `ForbiddenError` /
  `ConflictError` / `WorkspaceNotAllowedError`.

### Notes

- Not available through the public API yet, so not in the SDK (Secret
  Store): the workload runtime (AppRole/Kubernetes login, runtime secret
  reads, batch get, whoami); machine-readable lifecycle codes (the SDK
  matches the service's message); billing admission for
  `batchCreateSecrets` (no preflight is offered for it); a non-minting
  identity access read; distinct CAS-conflict and not-found status codes.
- 408, 409 and 500 responses and writes without an idempotency key are never
  retried.
- Retries for networking, snapshot, backup and S3-credential creates are not
  performed because those backends do not deduplicate requests yet.
- Not available through the public API yet, so not in the SDK:
  - discovering SKUs (Windows licence, Reserved IP, snapshot and backup
    storage);
  - plan capacity checks;
  - VM-side public-network and VPC-attachment routes;
  - GPU monitoring;
  - admin password reveal;
  - SSH-key management;
  - ISO sources;
  - the workspace-wide snapshot list;
  - backup-to-snapshot conversion.
- Not available through the public API yet, so not in the SDK (networking):
  - NAT-GATEWAY / RESERVED-IP catalog discovery; pass the catalog yourself;
  - the VM-side VPC attach/detach the portal uses (`attachNode` only
    allocates the address);
  - network allocation get/delete by ID;
  - attaching a held Reserved IP to a non-VPC VM, or converting a VPC VM's
    address;
  - the load-balancer custom-domain CNAME target before create;
  - firewall attach eligibility checks;
  - custom TLS certificates.
- VPC create with `nat_gateway` is not billing-admitted at the edge, so NAT
  gateways created that way are only metered when `natBillingCatalog` is
  sent.
- Not available through the public API yet, so not in the SDK (storage):
  - Block Storage plan, SKU, allowed-size and price discovery; the server
    picks the SKU and enforces catalog sizes (400 when a size is not
    offered, 502 `ambiguous_block_storage_plan` when a site has several
    plans; `sku_code` cannot resolve that yet);
  - the catalog-derived storage performance profile the portal sends;
  - a replacement `billing_catalog` on volume resize;
  - emptying a bucket, bucket CORS/lifecycle/notifications/object-lock
    configuration, bucket metrics, usage, public dev URL and bucket custom
    domains, object operations (use the S3 endpoint with S3 credentials),
    Object Storage region discovery;
  - the portal's soft revoke of S3 credentials (`revokeS3Credential` is a
    permanent delete);
  - CDN custom origins (`origin_type: "custom"` needs an origin ID you
    cannot create through the public API) and custom-domain repair.
- Node-level `blockStorage.attachVolume` / `detachVolume` only record a
  storage-node attachment and do not attach the disk to a VM; use
  `attachToVm` / `detachFromVm`.
- `createBucket` and `createS3Credential` are never retried automatically
  (a replay could report a name conflict or lose the one-time secret).
