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

### Fixed

- VM, GPU VM and firewall-group lists no longer silently stop at 10 items.
- VM create, snapshot create, backup enable, manual backup run and VM volume
  attach no longer always fail with 422 for a missing `billing_catalog`.

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
