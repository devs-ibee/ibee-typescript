/** Response and request shapes for the IBEE API. */

export interface SecretStore {
  id?: string;
  organization_id?: string;
  workspace_id?: string;
  name?: string;
  store_key?: string;
  description?: string;
  status?: string;
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
  name?: string;
  status?: string;
  updated_at?: string;
}

export interface SecretList {
  secrets?: Secret[];
  total?: number;
}

export interface SecretValue {
  version?: number;
  value?: Record<string, string>;
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

export interface CloudVm {
  id?: string;
  name?: string;
  status?: string;
  cpu?: number;
  ram_mb?: number;
  disk_gb?: number;
  os_type?: string;
  os_distro?: string;
  plan_name?: string;
  public_ip?: string;
  private_ip?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export type GpuVm = CloudVm & {
  gpu_count?: number;
  gpu_model?: string;
};

export interface VmMetrics {
  vm_id: string;
  vm_type: "cloud" | "gpu" | string;
  power_state: string;
  monitoring_status: "available" | "unavailable" | "stale" | string;
  last_collected_at?: string;
  cpu_percent?: number;
  memory_used_bytes?: number;
  memory_used_percent?: number;
  storage_used_bytes?: number;
  storage_total_bytes?: number;
  storage_used_percent?: number;
  storage_provisioned_bytes?: number;
  disk_read_bps?: number;
  disk_write_bps?: number;
  disk_read_iops?: number;
  disk_write_iops?: number;
  net_rx_bps?: number;
  net_tx_bps?: number;
  month_rx_bytes: number;
  month_tx_bytes: number;
}

export type VmType = "cloud" | "gpu";
export type BillingInterval = "HOURLY" | "MONTHLY";

export type BillingMode = "PREPAID" | "POSTPAID";
export type BillingState =
  | "CURRENT"
  | "PAYMENT_DUE"
  | "PAST_DUE"
  | "SOFT_SUSPENDED"
  | "HARD_SUSPENDED";

/** Body of POST /billing/resource-eligibility. */
export interface BillingEligibilityRequest {
  sku_code?: string;
  estimated_cost_minor?: number;
}

/** Point-in-time decision returned by POST /billing/resource-eligibility. */
export interface BillingEligibility {
  organization_id: string;
  allowed: boolean;
  reason: string;
  billing_mode: BillingMode;
  billing_state: BillingState;
  currency: string;
  sku_code?: string | null;
  estimated_cost_minor?: number | null;
  effective_balance_minor?: number | null;
  credit_headroom_minor?: number | null;
  evaluated_at: string;
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
  operation_id?: string;
  id?: string;
  status?: string;
}

export interface OperationStatus {
  operation_id?: string;
  status?: string;
  action?: string;
}

export interface DeleteResponse {
  deleted?: boolean;
  id?: string;
}

/** Body of POST /compute/cloud-vms. */
export interface CreateVmRequest {
  name: string;
  site_id: string;
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
