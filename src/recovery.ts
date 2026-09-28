/**
 * Snapshot / backup restore helpers (portal naming, plan mapping and restore
 * mode rules).
 */

import { validateBillingCatalog } from "./billingCatalog.js";
import { IbeeValidationError, normaliseIdList, validateNetworkFields } from "./validation.js";
import type { ComputePlan, RecoveryVolumeManifestItem } from "./types.js";

export type RecoveryKind = "snapshot" | "backup";

const fail = (message: string, code: string, field?: string): never => {
  throw new IbeeValidationError(message, code, field);
};

/** `YYYYMMDD` of a timestamp in UTC (today when missing or invalid). */
export function recoveryDateStamp(createdAt?: string | null): string {
  const d = createdAt ? new Date(createdAt) : new Date();
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

/** Portal default name for a new VM restored from a recovery point. */
export function recoveryDefaultVmName(
  vmName: string | null | undefined,
  kind: RecoveryKind,
  createdAt?: string | null,
): string {
  return `${String(vmName ?? "").trim() || "vm"}-${kind}-restored-${recoveryDateStamp(createdAt)}`;
}

/** Captured data volumes of a manifest (role `data`, or index > 0 without a role). */
export function recoveryCapturedDataVolumes(
  manifest: RecoveryVolumeManifestItem[] | null | undefined,
): RecoveryVolumeManifestItem[] {
  return (manifest ?? []).filter((m, i) =>
    m && m.role ? String(m.role).toLowerCase() === "data" : i > 0,
  );
}

const firstNonBlank = (...values: unknown[]): string =>
  values.map((v) => String(v ?? "").trim()).find(Boolean) ?? "";

/**
 * Names for restored data volumes. Without `provided` the portal defaults are
 * returned (`<volume>-<kind>-restored-YYYYMMDD`). With `provided`, keys must be
 * exactly the captured data volume IDs and values 1..255 characters.
 */
export function recoveryTargetVolumeNames(
  manifest: RecoveryVolumeManifestItem[] | null | undefined,
  kind: RecoveryKind,
  createdAt?: string | null,
  provided?: Record<string, string> | null,
): Record<string, string> {
  const captured = recoveryCapturedDataVolumes(manifest);
  const ids = captured.map((m) => String(m.source_volume_id ?? "").trim()).filter(Boolean);
  if (provided === undefined || provided === null) {
    const stamp = recoveryDateStamp(createdAt);
    const out: Record<string, string> = {};
    for (const m of captured) {
      const id = String(m.source_volume_id ?? "").trim();
      if (!id) continue;
      const base = firstNonBlank(
        m.source_volume_name,
        (m as unknown as Record<string, unknown>).display_name,
        m.resource_name,
        (m as unknown as Record<string, unknown>).volume_name,
        id,
      );
      out[id] = `${base}-${kind}-restored-${stamp}`;
    }
    return out;
  }
  if (typeof provided !== "object" || Array.isArray(provided)) {
    fail("target_volume_names must be an object keyed by source volume ID.", "invalid_target_volume_names", "target_volume_names");
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(provided)) {
    const key = rawKey.trim();
    if (!ids.includes(key)) {
      fail(`target_volume_names has '${key}', which is not a captured data volume.`, "invalid_target_volume_names", "target_volume_names");
    }
    const value = String(rawValue ?? "").trim();
    if (!value || value.length > 255) {
      fail(`target_volume_names['${key}'] must be 1-255 characters.`, "invalid_target_volume_names", "target_volume_names");
    }
    out[key] = value;
  }
  const missing = ids.filter((id) => !(id in out));
  if (missing.length > 0) {
    fail(`target_volume_names is missing a name for: ${missing.join(", ")}.`, "invalid_target_volume_names", "target_volume_names");
  }
  return out;
}

/**
 * Smallest plan disk (GB) that can hold the recovery point's root volume, on
 * the plan display scale (1 GB of headroom is trimmed: 51 -> 50).
 */
export function recoveryMinRootDiskGb(manifest: RecoveryVolumeManifestItem[] | null | undefined): number {
  const items = manifest ?? [];
  const root = items.find((m) => String(m?.role ?? "").toLowerCase() === "root") ?? items[0];
  if (!root) return 0;
  const display = Number(root.display_size_gb);
  const x = Number.isFinite(display) && display > 0 ? display : Number(root.size_gb) || 0;
  const c = Math.ceil(x);
  return c > 1 && c % 10 === 1 ? c - 1 : x;
}

/** Map a compute plan to the `target_*` fields of a new-VM restore. */
export function restoreTargetFromPlan(
  plan: ComputePlan,
  vm: { site_id?: string | null } = {},
): Record<string, unknown> {
  if (!plan.billing_catalog) {
    fail("Selected plan is missing Billing catalog data", "invalid_target_plan", "target_plan_id");
  }
  const out: Record<string, unknown> = {
    target_plan_id: plan.plan_id,
    target_plan_name: plan.name,
    target_plan_code: plan.code,
    target_cpu: plan.cpu,
    target_ram_mb: plan.ram_mb,
    target_disk_gb: plan.disk_gb,
    target_billing_catalog: validateBillingCatalog(plan.billing_catalog, {
      context: "Selected plan",
      field: "target_billing_catalog",
    }),
  };
  if (plan.gpu_count !== undefined && plan.gpu_count !== null) out.target_gpu_count = plan.gpu_count;
  if (plan.gpu_model) out.target_gpu_model = plan.gpu_model;
  if (plan.gpu_memory_gb !== undefined && plan.gpu_memory_gb !== null) out.target_gpu_memory_gb = plan.gpu_memory_gb;
  if (typeof plan.monthly_price_minor === "number") out.target_plan_monthly_rate = plan.monthly_price_minor / 100;
  if (typeof plan.hourly_price_minor === "number") out.target_plan_hourly_rate = plan.hourly_price_minor / 100;
  const site = String(plan.site_id ?? vm.site_id ?? "").trim();
  if (site) out.target_site_id = site;
  return out;
}

const TARGET_FIELDS = [
  "target_vm_name", "target_cpu", "target_ram_mb", "target_disk_gb", "target_plan_id",
  "target_plan_name", "target_plan_code", "target_plan_type", "target_performance_category",
  "target_plan_monthly_rate", "target_plan_hourly_rate", "target_bandwidth_tb",
  "target_bandwidth_display", "target_network_bandwidth", "target_compute_node_id",
  "target_gpu_type", "target_gpu_model", "target_gpu_count", "target_gpu_memory_gb",
  "target_gpu_memory_display", "target_site_id", "target_site_name", "target_billing_catalog",
  "target_volume_names",
];
const NETWORK_FIELDS = ["vpc_id", "subnet_id", "network_connectivity", "ssh_key_ids"];

const present = (v: unknown) =>
  v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "") &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/**
 * Validate the restore mode combination (portal and API rules) and return a
 * cleaned copy of the request. `kind` = backup rejects VPC/SSH fields.
 */
export function validateRestoreRequest(
  req: Record<string, unknown>,
  kind: RecoveryKind,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req };
  const mode = String(body.target_mode ?? "replace");
  if (!["replace", "new_vm", "volume_only"].includes(mode)) {
    fail("target_mode must be replace, new_vm or volume_only.", "invalid_restore", "target_mode");
  }
  body.target_mode = mode;
  if (kind === "backup") {
    for (const f of NETWORK_FIELDS) {
      if (present(body[f])) fail(`${f} is not supported when restoring a backup.`, "invalid_restore", f);
      delete body[f];
    }
  }
  const selected = String(body.selected_volume_id ?? "").trim();
  if (mode === "volume_only") {
    if (!selected) fail("selected_volume_id is required for a volume_only restore.", "invalid_restore", "selected_volume_id");
    body.selected_volume_id = selected;
  } else if (present(body.selected_volume_id)) {
    fail("selected_volume_id is only used with target_mode 'volume_only'.", "invalid_restore", "selected_volume_id");
  }
  if (mode !== "new_vm") {
    for (const f of [...TARGET_FIELDS, ...(kind === "snapshot" ? NETWORK_FIELDS : [])]) {
      if (present(body[f])) fail(`${f} is only used with target_mode 'new_vm'.`, "invalid_restore", f);
      delete body[f];
    }
    return body;
  }
  if (body.target_vm_name !== undefined && body.target_vm_name !== null) {
    const name = String(body.target_vm_name).trim();
    if (!name) fail("Enter a name for the restored VM", "invalid_restore", "target_vm_name");
    if (name.length > 255) fail("target_vm_name must be at most 255 characters.", "invalid_restore", "target_vm_name");
    body.target_vm_name = name;
  }
  if (kind === "snapshot") {
    const net = validateNetworkFields({
      vpc_id: body.vpc_id as string | undefined,
      subnet_id: body.subnet_id as string | undefined,
      network_connectivity: body.network_connectivity as string | undefined,
    });
    for (const f of ["vpc_id", "subnet_id", "network_connectivity"]) delete body[f];
    if (net.vpc_id) {
      body.vpc_id = net.vpc_id;
      body.subnet_id = net.subnet_id;
      body.network_connectivity = net.network_connectivity ?? "private";
    }
    const keys = normaliseIdList(body.ssh_key_ids, "ssh_key_ids");
    if (keys.length) body.ssh_key_ids = keys;
    else delete body.ssh_key_ids;
  }
  return body;
}

/** Check the resolved new-VM target (shape ranges, SKU, minimum root disk). */
export function validateNewVmTarget(body: Record<string, unknown>, minRootGb: number): void {
  const range = (f: string, min: number, max: number) => {
    const v = body[f];
    if (v === undefined || v === null) return;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      fail(`${f} must be an integer between ${min} and ${max}.`, "invalid_restore", f);
    }
  };
  if (!String(body.target_vm_name ?? "").trim()) fail("Enter a name for the restored VM", "invalid_restore", "target_vm_name");
  if (body.target_cpu === undefined || body.target_ram_mb === undefined || body.target_disk_gb === undefined) {
    fail("Select a valid compute plan for the restored VM", "invalid_restore", "target_plan_id");
  }
  range("target_cpu", 1, 256);
  range("target_ram_mb", 512, 2_097_152);
  range("target_disk_gb", 10, 10_000);
  range("target_gpu_count", 0, 16);
  if (!body.target_billing_catalog) fail("Selected plan is missing Billing catalog data", "invalid_restore", "target_billing_catalog");
  if (minRootGb > 0 && Number(body.target_disk_gb) < minRootGb) {
    fail(`Root disk must be at least ${minRootGb} GB.`, "invalid_restore", "target_disk_gb");
  }
}
