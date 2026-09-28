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

### Fixed

- VM, GPU VM and firewall-group lists no longer silently stop at 10 items.
- VM create, snapshot create, backup enable, manual backup run and VM volume
  attach no longer always fail with 422 for a missing `billing_catalog`.
- Firewall groups created with `isDefault: true` no longer disappear from
  lists (the flag is refused).
- HTTPS / TLS-passthrough load balancers can be created without passing
  `tls`.

### Notes

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
