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
  name?: string;
  is_public?: boolean;
  region?: string;
  created_at?: string;
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

export interface NetworkInterface {
  id?: string;
  network_id?: string;
  ip_address?: string;
  status?: string;
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
  os_distro: string;
  os_type: string;
  cpu: number;
  ram_mb: number;
  template_id?: string;
  disk_gb?: number;
  plan_id?: string;
  ssh_key_ids?: string[];
  tags?: string[];
}

/** Body of POST /compute/gpu-vms — adds the required GPU fields. */
export interface CreateGpuVmRequest extends CreateVmRequest {
  gpu_count: number;
  gpu_model: string;
}
