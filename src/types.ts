/** Response and request shapes for the IBEE API. */

export interface SecretStore {
  id?: string;
  organization_id?: string;
  workspace_id?: string;
  name?: string;
  store_key?: string;
  description?: string;
  status?: "active" | "archived" | "deleting";
  created_at?: string;
  updated_at?: string;
}

export interface SecretStoreList {
  stores?: SecretStore[];
  total?: number;
  page?: number;
  limit?: number;
}

export interface Secret {
  id?: string;
  organization_id?: string;
  workspace_id?: string;
  store_id?: string;
  store_key?: string;
  secret_name?: string;
  status?: "active" | "soft_deleted";
  created_at?: string;
  updated_at?: string;
}

export interface SecretList {
  secrets?: Secret[];
  total?: number;
  page?: number;
  limit?: number;
}

export interface SecretValue {
  id?: string;
  secret_name?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface BatchCreateSecretItem {
  secret_name: string;
  value: Record<string, unknown>;
}

export interface BatchCreateSecretResult {
  secret_name: string;
  status: "created" | "skipped" | "failed";
  secret?: Secret | null;
  error?: string | null;
}

export interface BatchCreateSecretsResponse {
  results: BatchCreateSecretResult[];
  created_count: number;
  skipped_count: number;
  failed_count: number;
}

export interface SecretVersionSummary {
  version: number;
  created_time: string;
  deletion_time: string;
  destroyed: boolean;
}

export interface SecretVersions {
  secret_id: string;
  secret_name: string;
  current_version: number;
  oldest_version: number;
  versions: Record<string, SecretVersionSummary>;
}

export interface SecretVersion {
  secret_id: string;
  secret_name: string;
  version: number;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface SecretLifecycleStatus {
  status: "destroyed" | "permanently_deleted";
}

export type SecretIdentityAuthMethod = "approle" | "kubernetes";
export type SecretIdentityPolicyMode = "read_only" | "read_write";

export interface SecretIdentity {
  id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  auth_method: SecretIdentityAuthMethod;
  openbao_role_name: string;
  status: "active" | "disabled";
  token_policy_mode: SecretIdentityPolicyMode;
  k8s_namespace?: string | null;
  k8s_service_account?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SecretIdentityList {
  identities: SecretIdentity[];
  total: number;
}

export interface SecretIdentityAccess {
  identity_id: string;
  auth_method: SecretIdentityAuthMethod;
  role_id?: string | null;
  /** Fresh AppRole credential. Treat this value as sensitive. */
  secret_id?: string | null;
  secret_id_accessor?: string | null;
  openbao_role_name?: string | null;
  k8s_namespace?: string | null;
  k8s_service_account?: string | null;
}

export interface SecretIdentityScope {
  id: string;
  identity_id: string;
  scope_type: string;
  store_id: string;
  organization_id: string;
  workspace_id: string;
  access_mode: SecretIdentityPolicyMode;
  allow_version_read: boolean;
  allow_rollback: boolean;
  allow_destroy: boolean;
  created_at: string;
}

export interface SecretIdentityScopeList {
  scopes: SecretIdentityScope[];
  total: number;
}

export interface SecretIdentityActionStatus {
  status: "deleted" | "revoked";
}

export interface BucketSummary {
  name?: string;
  object_count?: number;
  total_size?: number;
}

export interface BucketList {
  buckets?: BucketSummary[];
  is_truncated?: boolean;
  next_continuation_token?: string;
}

export interface DefaultRetention {
  mode: "GOVERNANCE" | "COMPLIANCE";
  /** Retention period in days; provide either days or years. */
  days?: number;
  /** Retention period in years; provide either years or days. */
  years?: number;
}

export interface Bucket {
  bucket_name?: string;
  minio_id?: string;
  public?: boolean;
  region?: string;
  plan?: string;
  status?: string;
  site_id?: string;
  site?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  stats?: BucketStats;
  created_at?: string;
  last_modified?: string;
  /** @deprecated Legacy aliases retained for source compatibility. */
  name?: string;
  /** @deprecated Use `public`. */
  is_public?: boolean;
}

export interface BucketStats {
  object_count?: number;
  total_size?: number;
  bandwidth_usage?: number;
  last_updated?: string;
}

export interface S3Credential {
  access_key_id: string;
  project_id?: string;
  name: string;
  status: "active" | "revoked";
  created_at: string;
  last_used_at?: string;
}

export interface S3CredentialCreated extends S3Credential {
  /** Returned only once during credential creation. */
  secret_access_key: string;
}

export interface S3CredentialList {
  credentials: S3Credential[];
}

export interface S3CredentialRevoked {
  success: boolean;
  message: string;
}

export type VmLifecycleStatus =
  | "pending"
  | "creating"
  | "provisioning"
  | "configuring"
  | "running"
  | "starting"
  | "stopping"
  | "stopped"
  | "rebooting"
  | "resizing"
  | "attaching_volume"
  | "detaching_volume"
  | "resizing_plan"
  | "resizing_disk"
  | "deleting"
  | "deleted"
  | "error";

export interface CloudVm {
  /** VM ID. The SDK copies `_id` here when the API returns only `_id`. */
  id?: string;
  /** Raw document ID as returned by the API. */
  _id?: string;
  name?: string;
  status?: VmLifecycleStatus;
  cpu?: number;
  ram_mb?: number;
  disk_gb?: number;
  os_type?: string;
  os_distro?: string;
  site_id?: string;
  site_name?: string;
  plan_id?: string;
  plan_name?: string | null;
  public_ip?: string | null;
  private_ip?: string | null;
  tags?: string[];
  created_at?: string;
  updated_at?: string | null;
  /** Reserved IP attached to the VM (its public IP is then not auto-assigned). */
  reserved_public_ip_id?: string | null;
  admin_username?: string | null;
  ssh_password_auth_enabled?: boolean | null;
  ssh_keys?: string[];
  ssh_key_ids?: string[];
  ssh_key_secret_refs?: SshKeySecretRef[];
  billing_catalog?: BillingCatalogSelection | null;
  data_volumes?: Array<{ volume_id?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export type GpuVm = CloudVm & {
  gpu_count?: number;
  gpu_model?: string;
};

export interface VmMetrics {
  vm_id: string;
  vm_type: VmType;
  power_state: string;
  monitoring_status: "active" | "unavailable" | "stale";
  last_collected_at?: string | null;
  cpu_percent?: number | null;
  memory_used_bytes?: number | null;
  memory_used_percent?: number | null;
  storage_used_bytes?: number | null;
  storage_total_bytes?: number | null;
  storage_used_percent?: number | null;
  storage_provisioned_bytes?: number | null;
  disk_read_bps?: number | null;
  disk_write_bps?: number | null;
  disk_read_iops?: number | null;
  disk_write_iops?: number | null;
  net_rx_bps?: number | null;
  net_tx_bps?: number | null;
  month_rx_bytes: number;
  month_tx_bytes: number;
}

export type VmType = "cloud" | "gpu";
export type BillingInterval = "HOURLY" | "MONTHLY";
/** Billing term a VM can be bought on. */
export type BillingTerm = "HOURLY" | "MONTHLY" | "YEARLY";

/** One SKU reference inside a billing catalog selection. */
export interface BillingSkuReference {
  sku_id: string | number;
  sku_code: string;
  product_id?: string | number | null;
  product_code?: string | null;
  product_name?: string | null;
  display_name?: string | null;
  plan_id?: string | number | null;
  plan_version?: string | number | null;
  [key: string]: unknown;
}

/** A priced billing term offered by a SKU (`billing_catalog.billing_options[]`). */
export interface BillingOption {
  billing_interval: BillingTerm;
  unit_price_minor: number;
  committed?: boolean;
  commitment_period?: BillingTerm;
  commitment_months?: number;
  committed_hours?: number;
  discount_percent?: number | null;
  price_unit?: string | null;
  [key: string]: unknown;
}

/**
 * Billing catalog selection sent with billable VM, snapshot, backup and
 * volume-attach requests. Treat as opaque; the SDK only validates its shape.
 */
export interface BillingCatalogSelection extends BillingSkuReference {
  attached_skus?: Record<string, BillingSkuReference>;
  billing_options?: BillingOption[];
  billing_interval?: BillingTerm;
}

export interface ComputeSite {
  site_id: string;
  name: string;
  site_code?: string;
  location?: string;
  region_id?: string;
  country_id?: string;
  timezone?: string;
}

export interface ComputeSiteList {
  sites: ComputeSite[];
  count: number;
}

export interface ComputePlan {
  plan_id: string;
  vm_type: VmType;
  name: string;
  code: string;
  cpu: number;
  ram_mb: number;
  disk_gb: number;
  gpu_count: number;
  gpu_model?: string;
  gpu_memory_gb?: number;
  selectable: boolean;
  pricing_status: "priced" | "unpriced";
  currency: string;
  billing_interval: BillingInterval;
  hourly_price_minor?: number;
  monthly_price_minor?: number;
  site_id?: string;
  /** Plan SKU; pass it (priced for a term) as the create body's `billing_catalog`. */
  billing_catalog?: BillingCatalogSelection | null;
}

export interface ComputePlanList {
  plans: ComputePlan[];
  count: number;
  vm_type: VmType;
  site_id?: string;
  currency: string;
  billing_interval: BillingInterval;
}

export interface ComputeImage {
  template_id: string;
  name: string;
  description?: string;
  os_distro: string;
  os_type: "linux" | "windows";
  distro_version?: string;
  architecture: string;
  image_format?: string;
  size_bytes: number;
  gpu_compatible: boolean;
  compatible_vm_types: VmType[];
  site_ids: string[];
}

export interface ComputeImageList {
  images: ComputeImage[];
  count: number;
  vm_type: VmType;
  site_id?: string;
}

export interface OperationAccepted {
  operation_id: string;
  vm_id: string;
  status: ComputeOperationStatus;
  submitted_at: string;
}

export type ComputeOperationAction =
  | "create"
  | "start"
  | "stop"
  | "reboot"
  | "delete"
  | "resize"
  | "attach_volume"
  | "detach_volume"
  | "resize_plan"
  | "resize_root_disk"
  | "update_access"
  | "snapshot"
  | "restore"
  | "rebuild"
  | "rescue";

/**
 * Compute operation status. Open union: a future status value does not break
 * consumers. Terminal: succeeded | failed | cancelled | timed_out.
 */
export type ComputeOperationStatus =
  | "accepted"
  | "running"
  | "waiting"
  | "compensating"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | (string & {});

export interface OperationStatus {
  operation_id: string;
  vm_id: string;
  operation_name?: string | null;
  action: ComputeOperationAction;
  request_id?: string | null;
  status: ComputeOperationStatus;
  current_step?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  vm_type?: string | null;
  submitted_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * Billing enforcement operation evaluated by the eligibility check.
 * Not yet part of the published API contract; behaviour may change.
 */
export type EnforcementOperation =
  | "CREATE_RESOURCE"
  | "CREATE_CREDENTIAL"
  | "INCREASE_CAPACITY"
  | "MUTATE_RESOURCE"
  | "READ_RESOURCE"
  | "DELETE_RESOURCE"
  | "REVOKE_CREDENTIAL"
  | "SECURITY_RECOVERY";

/** Body of the explicit preflight for any billable resource creation. */
export interface BillingEligibilityRequest {
  sku_code?: string;
  estimated_cost_minor?: number;
  /** Not yet part of the published API contract; behaviour may change. */
  operation?: EnforcementOperation;
}

export type BillingMode = "PREPAID" | "POSTPAID" | (string & {});
export type BillingState =
  | "CURRENT"
  | "PAYMENT_DUE"
  | "PAST_DUE"
  | "SOFT_SUSPENDED"
  | "HARD_SUSPENDED"
  | (string & {});
export type ServiceEnforcementState =
  | "NONE"
  | "BLOCK_NEW_PURCHASES"
  | "SUSPEND_METERED_SERVICES"
  | "FULL_PROJECT_SUSPEND"
  | (string & {});
export type EnforcementSource =
  | "BILLING"
  | "MANUAL_ADMIN"
  | "BILLING_AND_MANUAL"
  | (string & {});

/**
 * Known billing reasons. Allowed: ok, usage_based_sku, status_only,
 * operation_allowed. Denied: initial_topup_required, insufficient_balance,
 * credit_limit_exceeded, unknown_sku, inactive_sku, billing_limit_exhausted,
 * overage_cap_exceeded, dunning_active, dunning_grace_expired, or a manual
 * admin reason code. The set is open.
 */
export type BillingReason =
  | "ok"
  | "usage_based_sku"
  | "status_only"
  | "operation_allowed"
  | "initial_topup_required"
  | "insufficient_balance"
  | "credit_limit_exceeded"
  | "unknown_sku"
  | "inactive_sku"
  | "billing_limit_exhausted"
  | "overage_cap_exceeded"
  | "dunning_active"
  | "dunning_grace_expired"
  | (string & {});

/**
 * Billing admission decision. Only `allowed === true` permits a create.
 * Fields after `evaluated_at` are returned by the API today but are not yet
 * part of the published contract.
 */
export interface BillingEligibility {
  organization_id: string;
  allowed: boolean;
  reason: BillingReason;
  billing_mode?: BillingMode;
  billing_state?: BillingState;
  currency?: string;
  /** Upper-cased by billing. */
  sku_code?: string | null;
  estimated_cost_minor?: number | null;
  /** PREPAID only. */
  effective_balance_minor?: number | null;
  /** POSTPAID only. */
  credit_headroom_minor?: number | null;
  evaluated_at?: string;
  service_enforcement_state?: ServiceEnforcementState;
  enforcement_revision?: number;
  enforcement_source?: EnforcementSource;
  enforcement_reason_code?: string | null;
  operation?: EnforcementOperation | (string & {});
  allowed_operations?: string[];
  /** Per resource type limits. A missing key or -1 means unlimited. */
  resource_limits?: Record<string, number>;
  [key: string]: unknown;
}

export interface DeleteResponse {
  deleted?: boolean;
  id?: string;
}

export type BlockVolumeClass = "capacity" | "balanced" | "performance";
export type BlockVolumeState =
  | "creating"
  | "ready"
  | "in-use"
  | "attaching"
  | "detaching"
  | "resizing"
  | "deleting"
  | "error";

export interface CreateBlockVolumeRequest {
  name: string;
  size_gb: number;
  site_id: string;
  site_name?: string | null;
  sku_code?: string | null;
  volume_class?: BlockVolumeClass;
  replica_count?: number;
  backup_enabled?: boolean;
  idempotency_key?: string | null;
}

export interface BlockVolumeAttachment {
  node_name: string;
  mode: "single-writer" | "multi-writer";
  device_path: string;
  vm_id?: string | null;
  vm_name?: string | null;
  attached_at: string;
}

export interface BlockVolume {
  id: string;
  organization_id?: string;
  workspace_id?: string;
  workspace_name?: string | null;
  site_id?: string | null;
  site_name?: string | null;
  name: string;
  size_gb: number;
  state: BlockVolumeState;
  volume_class: BlockVolumeClass;
  replica_count: number;
  attachments: BlockVolumeAttachment[];
  created_at: string;
  updated_at: string;
  billing_catalog?: BillingCatalogSelection | null;
  metadata?: { billing_catalog?: BillingCatalogSelection | null; [key: string]: unknown } | null;
}

export interface BlockVolumeOperation {
  id: string;
  volume_id: string;
  operation: "create" | "attach" | "detach" | "resize" | "delete";
  status: "in-progress" | "succeeded" | "failed";
  idempotency_key?: string | null;
  result?: Record<string, unknown>;
  error?: string | null;
  created_at: string;
  started_at: string;
  completed_at?: string | null;
}

export interface BlockVolumeAction {
  volume: BlockVolume;
  operation: BlockVolumeOperation;
}

export interface BlockVolumeDelete {
  status: "deleted";
  id: string;
  operation_id: string;
}

export interface AttachBlockVolumeRequest {
  node_name: string;
  mode?: "single-writer" | "multi-writer";
  vm_id?: string | null;
  vm_name?: string | null;
  vm_state?: "running" | "stopped" | "suspended" | null;
  vm_site_id?: string | null;
  vm_type?: VmType;
  idempotency_key?: string | null;
}

export interface DetachBlockVolumeRequest {
  node_name: string;
  force?: boolean;
  confirm_unmounted?: boolean;
  vm_state?: "running" | "stopped" | "suspended" | null;
  vm_type?: VmType;
  reason?: string | null;
  idempotency_key?: string | null;
}

export interface ResizeBlockVolumeRequest {
  new_size_gb: number;
  vm_state?: "running" | "stopped" | "suspended" | null;
  allow_online?: boolean;
  idempotency_key?: string | null;
}

export interface GenerateCdnUrlRequest {
  bucket_name: string;
  object_key: string;
  expires_in?: number | null;
  disposition?: "inline" | "attachment" | null;
}

export interface GeneratedCdnUrl {
  cdn_url: string;
  expires_at?: string | null;
}

export type CdnOriginType = "bucket" | "custom";

export interface CreateCdnDistributionRequest {
  name: string;
  origin_id: string;
  origin_type?: CdnOriginType;
  cache_policy?: "static-assets" | "media" | "short" | "no-cache";
}

export interface UpdateCdnDistributionRequest {
  name?: string;
  cache_policy?: "static-assets" | "media" | "short" | "no-cache";
  enabled?: boolean;
}

export interface CdnDistribution {
  id: string;
  name: string;
  origin_type: CdnOriginType;
  origin_id: string;
  cache_policy: string;
  enabled: boolean;
  status: "active" | "deploying" | "disabled" | "failed" | "deleted";
  default_domain: string;
  default_url: string;
  custom_domains: string[];
  created_at: string;
  updated_at?: string | null;
}

export interface CdnDistributionList {
  distributions: CdnDistribution[];
  count: number;
}

export interface UpdateCdnWebsiteConfigRequest {
  index_document?: string;
}

export interface CdnWebsiteConfig {
  distribution_id: string;
  enabled: boolean;
  index_document: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface CdnCustomDomain {
  domain: string;
  status: "pending_validation" | "pending_tls" | "active" | "failed";
  tls_status?: string | null;
  created_at: string;
  instructions?: string[] | null;
}

export interface CdnCustomDomainList {
  distribution_id: string;
  default_domain: string;
  custom_domains: CdnCustomDomain[];
}

export interface CdnCustomDomainVerification {
  domain: string;
  status: "pending_validation" | "pending_tls" | "active" | "failed";
  tls_status?: string | null;
  message: string;
}

export interface PurgeCdnCacheRequest {
  mode: "url" | "hostname" | "tag" | "prefix" | "all";
  paths?: string[];
  hostnames?: string[];
  tags?: string[];
  prefixes?: string[];
}

export interface CdnCachePurge {
  success: boolean;
  mode: "url" | "hostname" | "tag" | "prefix" | "all";
  purged?: string[] | null;
  message?: string | null;
}

/** VPC connectivity for a VM placed in a VPC. */
export type NetworkConnectivity = "private" | "nat" | "public_ip";

/**
 * Input of `cloudVms.create`. Only `name`, `site_id`, `plan_id` and
 * `template_id` are needed: the SDK reads the plan and image from the compute
 * catalog and fills `cpu`, `ram_mb`, `disk_gb`, `os_type`, `os_distro` and
 * `billing_catalog` the way the portal does. Values you pass must match.
 */
export interface CreateVmRequest {
  /** Hostname: letters, digits and `-` only. */
  name: string;
  /** Required: a `site_id` from `computeCatalog.listSites`. */
  site_id?: string;
  plan_id: string;
  template_id: string;
  os_distro?: string;
  os_type?: string;
  cpu?: number;
  ram_mb?: number;
  disk_gb?: number;
  /**
   * Plan SKU. Built from the plan and `billing_term` when omitted; a value
   * you pass is validated and sent as-is.
   */
  billing_catalog?: BillingCatalogSelection;
  /**
   * SDK-only (folded into `billing_catalog`, not sent). Cloud default: HOURLY,
   * or the plan's first term. GPU default: the plan SKU unmodified (hourly).
   */
  billing_term?: BillingTerm;
  /**
   * SDK-only. Windows licence SKU, required for Windows images (attached as
   * `billing_catalog.attached_skus.windows_license`, quantity = vCPUs). The
   * public API cannot list it yet.
   */
  windows_license?: BillingCatalogSelection;
  /**
   * SSH key IDs. Keys are resolved under the VM creator, so API-token creates
   * cannot use them yet: prefer `ssh_keys`.
   */
  ssh_key_ids?: string[];
  /** Inline public SSH keys (ssh-rsa, ssh-ed25519, ecdsa-sha2-nistp*, sk-*). */
  ssh_keys?: string[];
  /** At most one firewall group. */
  firewall_group_ids?: string[];
  /** VPC placement; `subnet_id` is required with it. */
  vpc_id?: string;
  subnet_id?: string;
  network_connectivity?: NetworkConnectivity;
  /** Reserved IP to attach (needs `network_connectivity: "public_ip"`). */
  reserved_public_ip_id?: string;
  tags?: string[];
  requested_by?: string;
}

/** Input of `gpuVms.create`; GPU fields default to the plan's values. */
export interface CreateGpuVmRequest extends CreateVmRequest {
  gpu_count?: number;
  gpu_model?: string;
}

/** Delete choice for a VM's auto-assigned public IP. */
export type PublicIpAction = "reserve" | "release";

/** Body of DELETE /compute/{cloud-vms|gpu-vms}/{vm_id}. */
export interface VmDeleteRequest {
  public_ip_action?: PublicIpAction;
  reserved_ip_label?: string;
  reserved_ip_billing_catalog?: BillingCatalogSelection;
  requested_by?: string;
}

/** An accepted async VM operation; `operation` is set when the call waited. */
export type OperationAcceptedResult = OperationAccepted & {
  /** Final operation status (only when `wait` was requested). */
  operation?: OperationStatus;
};

export interface SshKeySecretRef {
  ssh_key_id: string;
  store_key?: string;
  secret_name: string;
}

export type VmSshKeyMode = "add" | "remove";

export interface VmAccessUpdateRequest {
  requested_by?: string;
  admin_username?: string | null;
  ssh_key_mode?: VmSshKeyMode | null;
  ssh_keys?: string[];
  ssh_key_ids?: string[];
  ssh_key_secret_refs?: SshKeySecretRef[];
  new_password?: string | null;
  password_auth_enabled?: boolean | null;
  confirm_remove_last_ssh_key?: boolean;
}

export interface VmResizeRequest {
  cpu?: number;
  ram_mb?: number;
  disk_gb?: number;
  /**
   * SDK-only: resize to this plan (cpu/ram/disk and SKU come from the plan in
   * the VM's site). Not combinable with explicit cpu/ram_mb/disk_gb.
   */
  plan_id?: string;
  /** SDK-only: term for the target plan SKU (default HOURLY). Needs `plan_id`. */
  billing_term?: BillingTerm;
  /** Target SKU. Built from `plan_id` when omitted. */
  billing_catalog?: BillingCatalogSelection;
  requested_by?: string;
}

export interface VmResizeShape {
  cpu: number;
  ram_mb: number;
  disk_gb: number;
}

export type VmResizeDecision = "in_place" | "migration_required" | "blocked";

export interface VmResizePrecheck {
  decision: VmResizeDecision;
  mode?: VmResizeDecision | null;
  reasons: string[];
  warnings: string[];
  migration_checklist: string[];
  migration_steps: string[];
  requires_stop: boolean;
  downtime_expected: boolean;
  no_changes: boolean;
  current_state: string;
  live_state?: string | null;
  current: VmResizeShape;
  target: VmResizeShape;
}

export interface VmResizePlanRequest {
  cpu: number;
  ram_mb: number;
  allow_online?: boolean;
  /** Required when cpu or ram_mb is lower than the VM's current value. */
  confirm_downgrade?: boolean;
  billing_catalog?: BillingCatalogSelection;
  requested_by?: string;
}

export interface VmResizeRootDiskRequest {
  /** New size in GB; must be larger than the current root disk. */
  new_size_gb: number;
  allow_online?: boolean;
  billing_catalog?: BillingCatalogSelection;
  requested_by?: string;
}

export type VmVolumeMode = "single-writer" | "multi-writer";

export interface VmAttachVolumeRequest {
  volume_id: string;
  mode?: VmVolumeMode;
  /** Block Storage SKU of the volume. Read from the volume when omitted. */
  billing_catalog?: BillingCatalogSelection;
  requested_by?: string;
}

export interface VmDetachVolumeRequest {
  volume_id: string;
  force?: boolean;
  confirm_unmounted?: boolean;
  requested_by?: string;
}

export interface MountGuidanceAcknowledge {
  status: string;
  vm_id: string;
  volume_id: string;
  mount_state?: string | null;
  instructions_acknowledged_at?: string | null;
}

export interface VmEvent {
  organization_id: string;
  organization_name?: string | null;
  workspace_id: string;
  workspace_name?: string | null;
  vm_id: string;
  operation_id?: string | null;
  event_type: string;
  message: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export type VmMetricsRange = "30m" | "1h" | "6h" | "24h" | "7d";
export type VmMetricsResolution = "1m" | "5m" | "15m" | "2h";
export type VmMetricPoint = [timestamp: string, value: number | null];

export interface VmMetricsTimeseries {
  range: VmMetricsRange;
  resolution: VmMetricsResolution;
  from: string;
  to: string;
  series: Record<string, VmMetricPoint[]>;
}

export interface VmBandwidthSummary {
  month: string;
  rx_bytes: number;
  tx_bytes: number;
  last_updated_at?: string | null;
}

export type SnapshotCaptureMode = "root_only" | "all_attached" | "selective";
export type BackupStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface SnapshotCreateRequest {
  name: string;
  description?: string | null;
  mode?: SnapshotCaptureMode;
  selected_data_volume_ids?: string[];
  /**
   * Required by the API: the snapshot storage SKU (product `snapshot_storage`,
   * SKU code `SNAPSHOT-STD`). The public API cannot list it yet; reuse the
   * `billing_catalog` returned on an existing snapshot set.
   */
  billing_catalog?: BillingCatalogSelection;
  requested_by?: string;
}

export interface RecoveryVolumeManifestItem {
  source_volume_id: string;
  source_volume_name?: string | null;
  resource_name?: string | null;
  role?: "root" | "data";
  size_gb?: number | null;
  display_size_gb?: number | null;
  device_bus?: string | null;
  device_slot?: string | null;
  boot_index?: number | null;
  attachment_mode?: string | null;
  guest_device?: string | null;
  device_path?: string | null;
  filesystem_uuid?: string | null;
  filesystem_type?: string | null;
  mount_hint?: string | null;
  mount_state_at_capture?: string | null;
  mount_instructions?: string | null;
  delete_on_termination?: boolean | null;
  source_attachment_present?: boolean;
  artifact_type?: string | null;
  artifact_ref?: string | null;
  artifact_chain_id?: string | null;
  artifact_backup_type?: string | null;
  artifact_bytes?: number | null;
  billing_storage_bytes?: number | null;
  storage_usage?: Record<string, unknown> | null;
  restored_volume_id?: string | null;
  restored_resource_name?: string | null;
  restored_device_path?: string | null;
  restored_target_vm_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RecoveryPointSummary {
  root_only?: boolean;
  root_volume_name?: string | null;
  data_volume_names?: string[];
  summary_text?: string;
}

export interface LiveDriftSummary {
  drifted?: boolean;
  missing_from_live?: string[];
  new_live_only?: string[];
  message?: string | null;
}

export interface SnapshotSet {
  organization_id: string;
  organization_name?: string | null;
  workspace_id: string;
  workspace_name?: string | null;
  snapshot_set_id: string;
  vm_id: string;
  vm_name?: string | null;
  vm_type?: VmType;
  name: string;
  description?: string | null;
  recovery_point_id: string;
  recovery_point_type?: "snapshot";
  capture_scope?: SnapshotCaptureMode;
  status: BackupStatus;
  captured_volume_count?: number;
  root_only?: boolean;
  size_gb?: number | null;
  source_disk_size_gb?: number | null;
  display_size_gb?: number | null;
  display_storage_bytes?: number | null;
  backend_protected_storage_bytes?: number | null;
  protected_storage_bytes?: number | null;
  billing_storage_bytes?: number | null;
  billing_storage_source?: string;
  metering_status?: string;
  storage_backend?: string | null;
  captured_topology_hash?: string | null;
  root_volume_id?: string | null;
  root_volume_name?: string | null;
  volume_manifest?: RecoveryVolumeManifestItem[];
  volume_manifest_summary?: RecoveryPointSummary;
  live_drift_summary?: LiveDriftSummary;
  metadata?: Record<string, unknown>;
  /** SKU echoed by the API (not yet part of the published contract). */
  billing_catalog?: BillingCatalogSelection | null;
  sku_code?: string | null;
  sku_id?: string | number | null;
  created_at: string;
  updated_at: string;
}

export interface SnapshotSetList {
  snapshots: SnapshotSet[];
  total: number;
}

export interface SnapshotDeleteResult {
  status: "deleted";
  snapshot_set_id: string;
}

export type RecoveryTargetMode = "replace" | "new_vm" | "volume_only";

export interface RecoveryRestoreRequest {
  target_mode?: RecoveryTargetMode;
  target_vm_name?: string | null;
  target_cpu?: number | null;
  target_ram_mb?: number | null;
  target_disk_gb?: number | null;
  target_plan_id?: string | null;
  target_plan_name?: string | null;
  target_plan_code?: string | null;
  target_plan_type?: string | null;
  target_performance_category?: string | null;
  target_plan_monthly_rate?: number | null;
  target_plan_hourly_rate?: number | null;
  target_bandwidth_tb?: number | string | null;
  target_bandwidth_display?: string | null;
  target_network_bandwidth?: string | null;
  target_compute_node_id?: string | null;
  target_gpu_type?: string | null;
  target_gpu_model?: string | null;
  target_gpu_count?: number | null;
  target_gpu_memory_gb?: number | null;
  target_gpu_memory_display?: string | null;
  target_site_id?: string | null;
  target_site_name?: string | null;
  /** new_vm only: SKU of the target plan (resolved from the plan when omitted). */
  target_billing_catalog?: BillingCatalogSelection | null;
  /** new_vm only: names for the restored data volumes, keyed by source volume ID. */
  target_volume_names?: Record<string, string>;
  selected_volume_id?: string | null;
  requested_by?: string;
  auto_start?: boolean;
}

/** Body of a snapshot restore (adds new-VM network and SSH options). */
export interface SnapshotRestoreRequest extends RecoveryRestoreRequest {
  /** new_vm only; with `subnet_id`. */
  vpc_id?: string | null;
  subnet_id?: string | null;
  /** new_vm only; defaults to `private` when `vpc_id` is set. */
  network_connectivity?: NetworkConnectivity | null;
  /** new_vm only. */
  ssh_key_ids?: string[];
}

export interface RecoveryRestore {
  organization_id: string;
  organization_name?: string | null;
  workspace_id: string;
  workspace_name?: string | null;
  restore_id: string;
  source_vm_id: string;
  target_mode: RecoveryTargetMode;
  target_vm_id?: string | null;
  target_vm_name?: string | null;
  recovery_point_id: string;
  recovery_point_type?: "backup" | "snapshot";
  status: BackupStatus;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
  metadata?: Record<string, unknown>;
}

export type BackupFrequency = "hourly" | "daily" | "weekly";

export interface BackupPolicySchedule {
  frequency?: BackupFrequency;
  timezone?: string;
  hour?: number;
  minute?: number;
  day_of_week?: number | null;
  window_minutes?: number;
}

export interface BackupPolicy {
  organization_id: string;
  organization_name?: string | null;
  workspace_id: string;
  workspace_name?: string | null;
  policy_id: string;
  vm_id: string;
  vm_name?: string | null;
  os_type?: string | null;
  os_distro?: string | null;
  template_id?: string | null;
  enabled: boolean;
  schedule: BackupPolicySchedule;
  retention_days: number;
  full_backup_interval_days: number;
  incremental_enabled: boolean;
  storage_backend: string;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: BackupStatus;
  created_at: string;
  updated_at: string;
}

export interface BackupPolicyUpdateRequest {
  schedule?: BackupPolicySchedule;
  retention_days?: number | null;
  full_backup_interval_days?: number | null;
  incremental_enabled?: boolean | null;
  /** Optional replacement backup storage SKU. */
  billing_catalog?: BillingCatalogSelection;
  requested_by?: string;
}

export interface BackupPolicyEnableRequest {
  schedule?: BackupPolicySchedule;
  retention_days?: number;
  full_backup_interval_days?: number;
  incremental_enabled?: boolean;
  /**
   * Required by the API: the backup storage SKU (product `backup_storage`,
   * SKU code `BACKUP-STD`). The public API cannot list it yet; reuse the
   * `billing_catalog` returned on an existing backup run.
   */
  billing_catalog?: BillingCatalogSelection;
  requested_by?: string;
}

export interface BackupPolicyDisableRequest {
  requested_by?: string;
}

export interface BackupPolicyNextRunRequest {
  /** ISO-8601 timestamp with `Z` or an offset (or a Date). */
  next_run_at: string | Date;
  requested_by?: string;
}

export interface ManualBackupRunRequest {
  requested_by?: string;
  reason?: string | null;
  /** Required by the API: the backup storage SKU (see `BackupPolicyEnableRequest`). */
  billing_catalog?: BillingCatalogSelection;
}

export interface BackupRun {
  organization_id: string;
  organization_name?: string | null;
  workspace_id: string;
  workspace_name?: string | null;
  run_id: string;
  source_run_id?: string | null;
  vm_backup_id?: string | null;
  vm_id: string;
  vm_type?: string | null;
  vm_name?: string | null;
  os_type?: string | null;
  os_distro?: string | null;
  template_id?: string | null;
  policy_id?: string | null;
  chain_id?: string | null;
  recovery_point_id?: string | null;
  trigger: "scheduled" | "manual" | "api";
  backup_type: "full" | "incremental";
  status: BackupStatus;
  storage_backend?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  size_gb?: number | null;
  source_disk_size_gb?: number | null;
  bytes_transferred?: number | null;
  backup_stored_size_bytes?: number | null;
  backup_stored_size_gb?: number | null;
  protected_storage_bytes?: number | null;
  billing_storage_bytes?: number | null;
  billing_storage_source?: string;
  metering_status?: string;
  captured_volume_count?: number;
  root_only?: boolean;
  captured_topology_hash?: string | null;
  capture_scope?: SnapshotCaptureMode | null;
  recovery_point_type?: "backup";
  volume_manifest?: RecoveryVolumeManifestItem[];
  volume_manifest_summary?: RecoveryPointSummary;
  live_drift_summary?: LiveDriftSummary;
  error_message?: string | null;
  metadata?: Record<string, unknown>;
  /** SKU echoed by the API (not yet part of the published contract). */
  billing_catalog?: BillingCatalogSelection | null;
  sku_code?: string | null;
  sku_id?: string | number | null;
  created_at?: string | null;
}

export interface BackupRunList {
  runs: BackupRun[];
  total: number;
}

/** Result of deleting a backup run (not yet part of the published API contract). */
export interface BackupRunDeleteResult {
  status: "deleted" | (string & {});
  run_id?: string;
  recovery_point_id?: string | null;
  deleted_artifact_count?: number;
  verified_remote_absent_count?: number;
  deleted_run_count?: number;
  deleted_projection_count?: number;
  [key: string]: unknown;
}

export interface BackupRestoreRequest extends RecoveryRestoreRequest {
  recovery_point_id: string;
}

export type VmConsoleState = "issued" | "active" | "closed" | "failed" | "expired";

export interface VmConsoleSession {
  session_id: string;
  vm_id: string;
  organization_id?: string | null;
  workspace_id?: string | null;
  workspace_name?: string | null;
  vm_type: VmType;
  console_type: "graphical";
  /** Sensitive, short-lived URL. Do not log or persist it. */
  connect_url: string;
  token_expires_in_seconds: number;
  idle_timeout_seconds: number;
  max_duration_seconds: number;
  state: VmConsoleState;
}

export interface VmConsoleSessionStatus {
  session_id: string;
  vm_id: string;
  organization_id?: string | null;
  workspace_id?: string | null;
  workspace_name?: string | null;
  vm_type: VmType;
  console_type: "graphical";
  state: VmConsoleState;
  host_id: string;
  host_mgmt_ip: string;
  socket_path: string;
  created_at: string;
  connected_at?: string | null;
  closed_at?: string | null;
  close_reason?: string | null;
  token_expires_at?: string | null;
  idle_timeout_seconds: number;
  max_duration_seconds: number;
}

export interface VmConsoleClose {
  session_id: string;
  state: VmConsoleState;
  close_reason: string;
}

export interface NetworkingSite {
  site_id: string;
  site_name: string;
  available: boolean;
  message?: string;
}

export type VpcConnectivity = "public" | "private" | "nat_gateway";

export interface Vpc {
  vpc_id: string;
  organization_id: string;
  workspace_id: string;
  site_id: string;
  name: string;
  cidr: string;
  status: string;
  /** `private` is the portal default; `public` is legacy. */
  connectivity_type: VpcConnectivity | (string & {});
  account_id?: string;
  description?: string;
  region?: string;
  is_default?: boolean;
  error_message?: string;
  created_at?: string;
  updated_at?: string;
}

export interface VpcSummary extends Vpc {
  node_count?: number;
  /** Environment pricing metadata; not a billing quote. */
  nat_pricing?: NatPricing;
}

export interface VpcDetail extends VpcSummary {
  subnets?: Subnet[];
  nat_gateways?: NatGateway[];
  attached_nodes?: VpcAttachedNode[];
}

/** A VM attached to a VPC (as listed in the VPC detail). */
export interface VpcAttachedNode {
  allocation_id: string;
  vm_id: string;
  subnet_id: string;
  private_ip: string;
  connectivity: "private" | "public_ip" | "nat";
  public_ip?: string | null;
  nat_public_ip?: string | null;
  status: string;
  attached_at?: string;
  [key: string]: unknown;
}

export interface Subnet {
  subnet_id: string;
  vpc_id: string;
  name: string;
  cidr: string;
  status: string;
  site_id?: string;
  dns?: string[];
  /** First usable host, assigned by the server. */
  gateway?: string;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface NetworkAllocation {
  allocation_id?: string;
  vpc_id?: string;
  subnet_id?: string;
  vm_id?: string;
  private_ip?: string;
  prefix_length?: number;
  subnet_mask?: string;
  gateway?: string;
  dns?: string[];
  public_ip_id?: string | null;
  public_ip?: string | null;
  nat_gateway_id?: string | null;
  nat_public_ip?: string | null;
  connectivity?: "private" | "public_ip" | "nat";
  status?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * NAT pricing metadata returned with VPCs. It is an environment setting, not
 * a billing quote.
 */
export interface NatPricing {
  currency?: string;
  price_per_hour?: number;
  data_price_per_gb?: number;
  billing_enforced?: boolean;
  /** @deprecated Never returned by the API; use `price_per_hour`. */
  hourly?: number;
  /** @deprecated Never returned by the API. */
  monthly?: number;
}

export interface NatGateway {
  nat_gateway_id: string;
  vpc_id: string;
  subnet_id?: string | null;
  reserved_public_ip_id?: string;
  public_ip_id?: string;
  name?: string;
  public_ip?: string;
  /** `reserved` (customer Reserved IP), `automatic` (platform address) or null (legacy). */
  public_ip_source?: "reserved" | "automatic" | null | (string & {});
  status: string;
  pricing?: NatPricing;
  billing_catalog?: Record<string, unknown>;
  billing_started_at?: string | null;
  billing_ended_at?: string | null;
  deleted_at?: string | null;
  error_message?: string | null;
  account_id?: string;
  created_at?: string;
  updated_at?: string;
}

export type TransportProtocol = "tcp" | "udp";

export interface NatPortForwardingRule {
  /** Rule ID as returned by the API. */
  port_forward_rule_id?: string;
  /** @deprecated Use `port_forward_rule_id`. */
  rule_id?: string;
  /** @deprecated Use `port_forward_rule_id`. */
  port_forwarding_rule_id?: string;
  vpc_id?: string;
  nat_gateway_id?: string;
  name: string;
  protocol: TransportProtocol;
  external_port: number;
  internal_ip: string;
  internal_port: number;
  /** `vm` or `vip` (MetalLB virtual IP). */
  target_type?: "vm" | "vip";
  /** VIP announcer VMs (VIP targets only). */
  target_vm_ids?: string[];
  network_allocation_id?: string | null;
  vm_id?: string | null;
  note?: string;
  enabled?: boolean;
  status?: string;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * A private virtual IP reserved in a VPC subnet (MetalLB or custom).
 * Not yet part of the published API contract; behaviour may change.
 */
export interface VpcVirtualIp {
  virtual_ip_id: string;
  vpc_id: string;
  subnet_id: string;
  private_ip: string;
  purpose: "metallb" | "custom";
  announcer_vm_ids: string[];
  public_ip_id?: string | null;
  public_ip?: string | null;
  status: string;
  error_message?: string | null;
  account_id?: string;
  organization_id?: string;
  workspace_id?: string;
  site_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ReservedIp {
  public_ip_id: string;
  address: string;
  site_id: string;
  status: string;
  organization_id?: string;
  workspace_id?: string;
  label?: string;
  reverse_dns?: string;
  reservation_type?: string;
  attached_resource_type?: string;
  attached_resource_id?: string;
  attached_vpc_id?: string;
  attached_subnet_id?: string;
  created_at?: string;
  updated_at?: string;
  /** Reserved IP SKU (not yet part of the published contract). */
  billing_catalog?: BillingCatalogSelection | null;
  /** The fields below are not yet part of the published API contract. */
  allocation_method?: "provider_assigned" | "converted" | (string & {});
  attached_allocation_id?: string | null;
  attached_network_id?: string | null;
  provider_profile?: string | null;
  purpose?: string;
  billing_started_at?: string | null;
  billing_ended_at?: string | null;
  deleted_at?: string | null;
  [key: string]: unknown;
}

export type FirewallDirection = "ingress" | "egress";
export type FirewallProtocol = "tcp" | "udp" | "icmp" | "any";
export type FirewallAction = "allow" | "drop";

export interface FirewallRuleInput {
  description?: string;
  direction?: FirewallDirection;
  protocol?: FirewallProtocol;
  portStart?: number;
  portEnd?: number;
  /** IPv4 addresses or CIDRs (a comma-separated string is accepted too). */
  remoteTargets?: string[] | string;
  action?: FirewallAction;
  priority?: number;
}

export interface FirewallRule {
  rule_id: string;
  enabled?: boolean;
  description?: string;
  direction?: FirewallDirection;
  protocol?: FirewallProtocol;
  port_start?: number;
  port_end?: number;
  remote_targets?: string[];
  action?: FirewallAction;
  priority?: number;
  /** Platform baseline rule; cannot be updated or deleted. */
  system_managed?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface FirewallGroup {
  firewall_group_id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  is_default: boolean;
  status: string;
  rules: FirewallRule[];
  workspace_name?: string;
  description?: string;
  linked_instance_count?: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * Firewall group list row returned with `summary=true`.
 * Not yet part of the published API contract; behaviour may change.
 */
export interface FirewallGroupSummary {
  firewall_group_id: string;
  name: string;
  description?: string | null;
  status: string;
  is_default: boolean;
  linked_instance_count?: number;
  rule_count?: number;
  organization_id?: string;
  workspace_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface FirewallAttachment {
  vm_id: string;
  network_id?: string;
  attached_at?: string;
  vm_name?: string;
  vm_type?: string;
  private_ip?: string;
  public_ip?: string;
  status?: string;
  network_provider?: string;
  attached_firewall_group_ids?: string[];
  [key: string]: unknown;
}

export type LoadBalancerLayer = "l4" | "l7";
export type LoadBalancerProtocol = "tcp" | "tls_passthrough" | "http" | "https";

export interface LoadBalancerBackend {
  target: string;
  port: number;
  type?: "service" | "ip" | "hostname";
  weight?: number;
  tls?: boolean;
}

export interface LoadBalancerRouting {
  algorithm?: "round_robin" | "least_request" | "random" | "consistent_hash";
  sticky_header?: string;
}

export interface LoadBalancerTls {
  mode: "terminate" | "passthrough";
  /** Only `managed` is supported (custom certificates are rejected). */
  certificate_source?: "managed" | (string & {});
  /** @deprecated Custom certificates are not supported; the SDK rejects this. */
  cert_pem?: string;
  /** @deprecated Custom certificates are not supported; the SDK rejects this. */
  key_pem?: string;
}

/** Load-balancer request policy. Not yet part of the published API contract. */
export interface LoadBalancerPolicy {
  /** 100..300000 (default 30000). */
  timeout_ms?: number;
  retries?: {
    /** 1..10 (portal default 3). */
    attempts?: number;
    /** Default ["5xx", "reset", "connect-failure"]. */
    on?: string[];
    /** 100..120000 (portal default 5000). */
    per_retry_timeout_ms?: number;
  };
  proxy_protocol_enabled?: boolean;
}

/** Load-balancer health checks. Not yet part of the published API contract. */
export interface LoadBalancerHealthCheck {
  active?: {
    type?: "http" | "https" | "tcp";
    /** Not allowed for tcp; the server defaults http/https to /health. */
    path?: string;
    interval_ms?: number;
    timeout_ms?: number;
    healthy_threshold?: number;
    unhealthy_threshold?: number;
  };
  passive?: {
    enabled?: boolean;
    consecutive_5xx?: number;
    interval_ms?: number;
    base_ejection_time_ms?: number;
  };
}

/** Load-balancer observability. Not yet part of the published API contract. */
export interface LoadBalancerObservability {
  logs_enabled?: boolean;
}

export interface LoadBalancerRule {
  priority?: number;
  path_prefix?: string;
  headers?: Record<string, string>;
  backends?: LoadBalancerBackend[];
}

export interface LoadBalancer {
  lb_id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  layer: LoadBalancerLayer;
  protocol: LoadBalancerProtocol;
  status: string;
  endpoint?: Record<string, unknown>;
  url?: string;
  endpoint_url?: string;
  namespace?: string;
  backends: LoadBalancerBackend[];
  routing?: LoadBalancerRouting;
  tls?: LoadBalancerTls;
  rules?: LoadBalancerRule[];
  /** L7 https custom domain; `cname_target` is where the CNAME must point. */
  custom_domain?: { hostname: string; cname_target?: string } | null;
  activated_at?: string | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface LoadBalancerStatusResponse {
  lb_id: string;
  status: string;
  endpoint: { host: string; port: number };
  url: string;
  endpoint_url: string;
  conditions?: Record<string, unknown>[];
  error_message?: string;
  updated_at: string;
}
