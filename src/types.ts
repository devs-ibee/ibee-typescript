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
  id?: string;
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

export type ComputeOperationStatus =
  | "accepted"
  | "running"
  | "waiting"
  | "compensating"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface OperationStatus {
  operation_id: string;
  vm_id: string;
  action: ComputeOperationAction;
  status: ComputeOperationStatus;
  current_step?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  submitted_at: string;
  updated_at: string;
}

/** Body of the explicit preflight for any billable resource creation. */
export interface BillingEligibilityRequest {
  sku_code?: string;
  estimated_cost_minor?: number;
}

/**
 * Billing admission decision. Billing amount fields can be omitted when the
 * caller can create resources but is not permitted to view billing details.
 */
export type BillingMode = "PREPAID" | "POSTPAID";
export type BillingState =
  | "CURRENT"
  | "PAYMENT_DUE"
  | "PAST_DUE"
  | "SOFT_SUSPENDED"
  | "HARD_SUSPENDED";

export interface BillingEligibility {
  organization_id: string;
  allowed: boolean;
  reason: string;
  billing_mode?: BillingMode;
  billing_state?: BillingState;
  currency?: string;
  sku_code?: string | null;
  estimated_cost_minor?: number | null;
  effective_balance_minor?: number | null;
  credit_headroom_minor?: number | null;
  evaluated_at?: string;
}

export interface DeleteResponse {
  deleted?: boolean;
  id?: string;
}

/** Body of POST /compute/cloud-vms. */
export interface CreateVmRequest {
  name: string;
  site_id?: string;
  os_distro: string;
  os_type: string;
  cpu: number;
  ram_mb: number;
  template_id: string;
  disk_gb?: number;
  plan_id: string;
  ssh_key_ids?: string[];
  tags?: string[];
}

/** Body of POST /compute/gpu-vms — adds the required GPU fields. */
export interface CreateGpuVmRequest extends CreateVmRequest {
  gpu_count: number;
  gpu_model: string;
}

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
  confirm_downgrade?: boolean;
  requested_by?: string;
}

export interface VmResizeRootDiskRequest {
  new_size_gb: number;
  allow_online?: boolean;
  requested_by?: string;
}

export type VmVolumeMode = "single-writer" | "multi-writer";

export interface VmAttachVolumeRequest {
  volume_id: string;
  mode?: VmVolumeMode;
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
  selected_volume_id?: string | null;
  requested_by?: string;
  auto_start?: boolean;
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
  requested_by?: string;
}

export interface BackupPolicyEnableRequest {
  schedule?: BackupPolicySchedule;
  retention_days?: number;
  full_backup_interval_days?: number;
  incremental_enabled?: boolean;
  requested_by?: string;
}

export interface BackupPolicyDisableRequest {
  requested_by?: string;
}

export interface BackupPolicyNextRunRequest {
  next_run_at: string;
  requested_by?: string;
}

export interface ManualBackupRunRequest {
  requested_by?: string;
  reason?: string | null;
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
}

export interface BackupRunList {
  runs: BackupRun[];
  total: number;
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

export interface Vpc {
  vpc_id: string;
  organization_id: string;
  workspace_id: string;
  site_id: string;
  name: string;
  cidr: string;
  status: string;
  connectivity_type: "public" | "nat_gateway";
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
  nat_pricing?: NatPricing;
}

export interface VpcDetail extends Vpc {
  subnets?: Subnet[];
  nat_gateways?: NatGateway[];
  attached_nodes?: NetworkAllocation[];
}

export interface Subnet {
  subnet_id: string;
  vpc_id: string;
  name: string;
  cidr: string;
  status: string;
  dns?: string[];
  gateway?: string;
  created_at?: string;
  updated_at?: string;
}

export interface NetworkAllocation {
  allocation_id?: string;
  vpc_id?: string;
  subnet_id?: string;
  vm_id?: string;
  private_ip?: string;
  public_ip?: string;
  connectivity?: "private" | "public_ip" | "nat";
  status?: string;
  created_at?: string;
  updated_at?: string;
}

export interface NatPricing {
  currency?: string;
  hourly?: number;
  monthly?: number;
}

export interface NatGateway {
  nat_gateway_id: string;
  vpc_id: string;
  subnet_id?: string;
  reserved_public_ip_id?: string;
  name?: string;
  public_ip?: string;
  status: string;
  created_at?: string;
  updated_at?: string;
}

export type TransportProtocol = "tcp" | "udp";

export interface NatPortForwardingRule {
  rule_id?: string;
  port_forwarding_rule_id?: string;
  nat_gateway_id?: string;
  name: string;
  protocol: TransportProtocol;
  external_port: number;
  internal_ip: string;
  internal_port: number;
  note?: string;
  enabled?: boolean;
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
  remoteTargets?: string[];
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

export interface FirewallAttachment {
  vm_id: string;
  network_id?: string;
  attached_at?: string;
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
  certificate_source?: string;
  cert_pem?: string;
  key_pem?: string;
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
