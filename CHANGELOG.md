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

### Fixed

- VM, GPU VM and firewall-group lists no longer silently stop at 10 items.

### Notes

- 408, 409 and 500 responses and writes without an idempotency key are never
  retried.
- Retries for networking, snapshot, backup and S3-credential creates are not
  performed because those backends do not deduplicate requests yet.
