/**
 * Client-side validation shared by every resource. All checks run before any
 * HTTP request and throw `IbeeValidationError`.
 */

import { IbeeEnvironment } from "./environments.js";
import { IbeeError } from "./errors.js";

/** A request was rejected on the client before it was sent. */
export class IbeeValidationError extends IbeeError {
  /** Name of the offending field, when there is one. */
  readonly field?: string;
  /** Extra context, e.g. the resize precheck that blocked a resize. */
  readonly details?: unknown;

  constructor(message: string, code: string, field?: string, details?: unknown) {
    super(message, code);
    this.name = "IbeeValidationError";
    this.field = field;
    if (details !== undefined) this.details = details;
  }
}

// ---------------------------------------------------------------- workspace

export const WORKSPACE_ID_PATTERN = /^[1-9][0-9]*$/;
export const WORKSPACE_ID_ERROR =
  "workspace_id must be a positive numeric string (for example, '710995').";

/** Validate a workspace ID (`^[1-9][0-9]*$`, string only) and return it. */
export function validateWorkspaceId(workspaceId: unknown): string {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new IbeeValidationError(WORKSPACE_ID_ERROR, "invalid_workspace_id", "workspace_id");
  }
  return workspaceId;
}

// ------------------------------------------------------ environment / token

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Resolve and normalise the API base URL. Explicit `baseUrl` wins over
 * `environment`; the default is production. The URL must be absolute https
 * (http only for localhost), with no credentials, query, fragment or dot
 * path segments. A trailing `/` is removed.
 */
export function resolveBaseUrl(
  baseUrl?: string | null,
  environment?: string | null,
): string {
  const raw = String(baseUrl ?? environment ?? IbeeEnvironment.DEFAULT).trim();
  const fail = (): never => {
    throw new IbeeValidationError(
      "The IBEE base URL must be an absolute https URL (http is allowed only for localhost) without credentials, query or fragment.",
      "invalid_base_url",
      "base_url",
    );
  };
  if (/[\r\n\s]/.test(raw)) fail();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail();
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") fail();
  if (!url.hostname) fail();
  if (url.username || url.password) fail();
  if (url.search || url.hash || raw.includes("?") || raw.includes("#")) fail();
  // URL() already collapsed dot segments; inspect the raw path instead.
  const afterHost = raw.replace(/^[a-z]+:\/\/[^/]*/i, "");
  if (afterHost.split("/").some((seg) => seg === "." || seg === "..")) fail();
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname.toLowerCase())) fail();
  return raw.replace(/\/+$/, "");
}

/** Validate a token's basic shape (non-empty, no CR/LF). */
export function validateToken(token: unknown): string {
  if (typeof token !== "string" || token.trim() === "") {
    throw new IbeeValidationError("An API token is required.", "invalid_token", "token");
  }
  if (/[\r\n]/.test(token)) {
    throw new IbeeValidationError(
      "The API token must not contain line breaks.",
      "invalid_token",
      "token",
    );
  }
  return token;
}

/**
 * Reject a development token against the production endpoint and vice versa.
 * Other hosts and tokens without an `ibee_dev_key_` / `ibee_prod_key_` prefix
 * are not checked.
 */
export function checkTokenEnvironment(token: string, baseUrl: string): void {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return;
  }
  const mismatch =
    (host === "api.ibee.ai" && token.startsWith("ibee_dev_key_")) ||
    (host === "api.ibee.co.in" && token.startsWith("ibee_prod_key_"));
  if (mismatch) {
    throw new IbeeValidationError(
      "The API token environment does not match the configured IBEE endpoint.",
      "token_environment_mismatch",
      "token",
    );
  }
}

// -------------------------------------------------------------- idempotency

export const IDEMPOTENCY_KEY_PATTERN = /^[!-~]{1,128}$/;

/** Validate a caller-supplied idempotency key (printable ASCII, 1..128). */
export function validateIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new IbeeValidationError(
      "idempotency key must be 1-128 printable ASCII characters without spaces.",
      "invalid_idempotency_key",
      "idempotency_key",
    );
  }
  return key;
}

// ----------------------------------------------------------- request bodies

/** Maximum JSON body size the edge accepts on billable creates. */
export const MAX_BILLABLE_BODY_BYTES = 65_536;

const BILLABLE_CREATE_PATHS: RegExp[] = [
  /^\/secret-store\/stores\/?$/,
  /^\/secret-store\/stores\/[^/]+\/secrets\/?$/,
  /^\/object-storage\/buckets\/?$/,
  /^\/object-storage\/credentials\/?$/,
  /^\/networking\/vpcs\/[^/]+\/nat-gateways\/?$/,
  /^\/networking\/reserved-ips\/?$/,
  /^\/networking\/load-balancers\/(l4|l7)\/?$/,
  /^\/compute\/(cloud-vms|gpu-vms)\/?$/,
  /^\/block-storage\/volumes\/?$/,
  /^\/cdn\/distributions\/?$/,
  /^\/cdn\/distributions\/[^/]+\/custom-domains\/?$/,
];

function normalisePath(path: string): string {
  const p = String(path).split("?")[0];
  const withSlash = p.startsWith("/") ? p : `/${p}`;
  return withSlash.replace(/^\/v1(?=\/)/, "");
}

/** True for POST paths the edge runs billing admission on. */
export function isBillableCreate(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const p = normalisePath(path);
  return BILLABLE_CREATE_PATHS.some((re) => re.test(p));
}

/** Enforce the 64 KiB edge limit on billable create bodies. */
export function assertBillableBodySize(method: string, path: string, serialized: string | undefined): void {
  if (!isBillableCreate(method, path) || serialized === undefined) return;
  const size = new TextEncoder().encode(serialized).length;
  if (size > MAX_BILLABLE_BODY_BYTES) {
    throw new IbeeValidationError(
      `Request body is ${size} bytes; billable create requests are limited to ${MAX_BILLABLE_BODY_BYTES} bytes.`,
      "request_body_too_large",
    );
  }
}

// ------------------------------------------------------ billing eligibility

export const ELIGIBILITY_OPERATIONS = [
  "CREATE_RESOURCE",
  "CREATE_CREDENTIAL",
  "INCREASE_CAPACITY",
  "MUTATE_RESOURCE",
  "READ_RESOURCE",
  "DELETE_RESOURCE",
  "REVOKE_CREDENTIAL",
  "SECURITY_RECOVERY",
] as const;

/** Trim a SKU code; `undefined` when blank; throws when longer than 64. */
export function normaliseSkuCode(skuCode: unknown): string | undefined {
  if (skuCode === undefined || skuCode === null) return undefined;
  if (typeof skuCode !== "string") {
    throw new IbeeValidationError("sku_code must be a string.", "invalid_sku_code", "sku_code");
  }
  const s = skuCode.trim();
  if (s === "") return undefined;
  if (s.length > 64) {
    throw new IbeeValidationError(
      "sku_code must be at most 64 characters.",
      "invalid_sku_code",
      "sku_code",
    );
  }
  return s;
}

/** Validate and round an estimated cost in minor units. */
export function normaliseEstimatedCostMinor(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    Math.round(value) > Number.MAX_SAFE_INTEGER
  ) {
    throw new IbeeValidationError(
      "estimated_cost_minor must be a finite number >= 0 (minor currency units).",
      "invalid_estimated_cost_minor",
      "estimated_cost_minor",
    );
  }
  return Math.round(value);
}

/** Normalise an eligibility operation (case-insensitive). */
export function normaliseEligibilityOperation(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const op = String(value).trim().toUpperCase();
  if (!(ELIGIBILITY_OPERATIONS as readonly string[]).includes(op)) {
    throw new IbeeValidationError(
      `operation must be one of ${ELIGIBILITY_OPERATIONS.join(", ")}.`,
      "invalid_operation",
      "operation",
    );
  }
  return op;
}

// --------------------------------------------------------------- operations

/** Compute operation IDs: `op_` followed by 24 lower-case hex characters. */
export const OPERATION_ID_PATTERN = /^op_[0-9a-f]{24}$/;

/** Validate a compute operation ID (`op_<24 hex>`) and return it trimmed. */
export function validateOperationId(operationId: unknown): string {
  const id = typeof operationId === "string" ? operationId.trim() : "";
  if (!id) {
    throw new IbeeValidationError(
      "operation_id must be a non-empty string.",
      "invalid_operation_id",
      "operation_id",
    );
  }
  if (!OPERATION_ID_PATTERN.test(id)) {
    throw new IbeeValidationError(
      "operation_id must look like 'op_' followed by 24 hex characters.",
      "invalid_operation_id",
      "operation_id",
    );
  }
  return id;
}

export const WAIT_DEFAULT_TIMEOUT_MS = 1_200_000;
export const WAIT_DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Validate wait bounds: timeout 1 s..2 h; poll interval 1..60 s and <= timeout. */
export function validateWaitOptions(
  timeoutMs: number = WAIT_DEFAULT_TIMEOUT_MS,
  pollIntervalMs: number = WAIT_DEFAULT_POLL_INTERVAL_MS,
): { timeoutMs: number; pollIntervalMs: number } {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 7_200_000) {
    throw new IbeeValidationError(
      "timeoutMs must be between 1000 and 7200000 (1 second to 2 hours).",
      "invalid_timeout",
      "timeout",
    );
  }
  if (
    typeof pollIntervalMs !== "number" ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 1_000 ||
    pollIntervalMs > 60_000 ||
    pollIntervalMs > timeoutMs
  ) {
    throw new IbeeValidationError(
      "pollIntervalMs must be between 1000 and 60000 and not exceed timeoutMs.",
      "invalid_poll_interval",
      "poll_interval",
    );
  }
  return { timeoutMs, pollIntervalMs };
}

// --------------------------------------------------------------- pagination

export interface ListPagingArgs {
  limit?: number;
  offset?: number;
  search?: string;
  sortBy?: string;
  sortDirection?: string;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Validate `limit` (1..maxLimit) and `offset` (>= 0). */
export function validateLimitOffset(
  args: { limit?: number; offset?: number },
  maxLimit: number,
): void {
  if (args.limit !== undefined && (!isInt(args.limit) || args.limit < 1 || args.limit > maxLimit)) {
    throw new IbeeValidationError(
      `limit must be an integer between 1 and ${maxLimit}.`,
      "invalid_limit",
      "limit",
    );
  }
  if (args.offset !== undefined && (!isInt(args.offset) || args.offset < 0)) {
    throw new IbeeValidationError("offset must be an integer >= 0.", "invalid_offset", "offset");
  }
}

export const VM_LIST_SORT_FIELDS = ["created_at", "name", "status", "os_type"] as const;

/**
 * Validate VM list paging parameters and return the query to send
 * (search trimmed and omitted when blank).
 */
export function vmListQuery(args: ListPagingArgs): Record<string, string | number | undefined> {
  validateLimitOffset(args, 100);
  let search: string | undefined;
  if (args.search !== undefined && args.search !== null) {
    search = String(args.search).trim() || undefined;
    if (search && search.length > 120) {
      throw new IbeeValidationError("search must be at most 120 characters.", "invalid_search", "search");
    }
  }
  if (args.sortBy !== undefined && !(VM_LIST_SORT_FIELDS as readonly string[]).includes(args.sortBy)) {
    throw new IbeeValidationError(
      `sortBy must be one of ${VM_LIST_SORT_FIELDS.join(", ")}.`,
      "invalid_sort_by",
      "sort_by",
    );
  }
  if (args.sortDirection !== undefined && args.sortDirection !== "asc" && args.sortDirection !== "desc") {
    throw new IbeeValidationError(
      "sortDirection must be 'asc' or 'desc'.",
      "invalid_sort_direction",
      "sort_direction",
    );
  }
  return {
    limit: args.limit,
    offset: args.offset,
    search,
    sort_by: args.sortBy,
    sort_direction: args.sortDirection,
  };
}

// ------------------------------------------------------------ environments

/**
 * Resolve an environment name the way the CLI reads `IBEE_ENV`:
 * `dev`/`development` -> DEVELOPMENT; empty, `prod`/`production` -> PRODUCTION
 * (trimmed, case-insensitive). Anything else throws `invalid_environment`.
 */
export function environmentFromName(name: string | null | undefined): string {
  const n = String(name ?? "").trim().toLowerCase();
  if (n === "dev" || n === "development") return IbeeEnvironment.DEVELOPMENT;
  if (n === "" || n === "prod" || n === "production") return IbeeEnvironment.PRODUCTION;
  throw new IbeeValidationError(
    "Invalid IBEE_ENV: use dev, development, prod or production",
    "invalid_environment",
    "environment",
  );
}

// ======================================================================
// Compute: VM rules (portal parity). All throw IbeeValidationError.
// ======================================================================

const vfail = (message: string, code: string, field?: string, details?: unknown): never => {
  throw new IbeeValidationError(message, code, field, details);
};

const isRec = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** VM IDs are 24-character hex document IDs. */
export const VM_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/** Validate a VM ID (24 hex characters) and return it trimmed. */
export function validateVmId(vmId: unknown, field = "vm_id"): string {
  const id = typeof vmId === "string" ? vmId.trim() : "";
  if (!VM_ID_PATTERN.test(id)) {
    vfail(`${field} must be a 24-character hexadecimal VM ID.`, "invalid_vm_id", field);
  }
  return id;
}

/** Require a non-blank string ID and return it trimmed. */
export function validateRequiredId(value: unknown, field: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) vfail(`${field} is required.`, `invalid_${field}`, field);
  return id;
}

/** VM hostnames: letters, digits and hyphens. */
export const VM_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
/** Largest batch the portal creates at once. */
export const MAX_VM_BATCH_SIZE = 5;

/** Validate a VM name (trimmed; letters, digits and `-` only). */
export function validateVmName(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) vfail("VM name is required.", "invalid_vm_name", "name");
  if (!VM_NAME_PATTERN.test(n)) {
    vfail("VM name may contain only letters, digits and hyphens.", "invalid_vm_name", "name");
  }
  return n;
}

/**
 * Names for a batch create: `base-1..base-N` (or `overrides`), 1..5 names,
 * unique case-insensitively. A single VM keeps `base` unchanged.
 */
export function expandBatchNames(base: string, count = 1, overrides?: string[]): string[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_VM_BATCH_SIZE) {
    vfail(`count must be between 1 and ${MAX_VM_BATCH_SIZE}.`, "invalid_count", "count");
  }
  let names: string[];
  if (overrides && overrides.length > 0) {
    if (overrides.length !== count) {
      vfail(`Provide exactly ${count} names.`, "invalid_vm_name", "name");
    }
    names = overrides.map(validateVmName);
  } else {
    const b = validateVmName(base);
    names = count === 1 ? [b] : Array.from({ length: count }, (_, i) => `${b}-${i + 1}`);
  }
  const seen = new Set<string>();
  for (const n of names) {
    const key = n.toLowerCase();
    if (seen.has(key)) vfail(`VM names must be unique: '${n}' is repeated.`, "duplicate_vm_name", "name");
    seen.add(key);
  }
  return names;
}

/** Trim, drop blanks and de-duplicate (order kept). */
export function normaliseIdList(values: unknown, field = "ids"): string[] {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) vfail(`${field} must be an array of strings.`, `invalid_${field}`, field);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values as unknown[]) {
    const s = String(v ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** SSH public key types the API accepts. */
export const SSH_KEY_TYPES = [
  "ssh-rsa",
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
] as const;

/** Validate one inline SSH public key and return it trimmed. */
export function validateSshPublicKey(key: unknown, field = "ssh_keys"): string {
  const k = typeof key === "string" ? key.trim() : "";
  if (!k) vfail("SSH public key must not be empty.", "invalid_ssh_key", field);
  if (/[\r\n]/.test(k)) vfail("SSH public key must be a single line.", "invalid_ssh_key", field);
  if (/PRIVATE KEY/i.test(k)) {
    vfail("That looks like a private key. Paste the public key (.pub) instead.", "invalid_ssh_key", field);
  }
  const [type, data] = k.split(/\s+/);
  if (!(SSH_KEY_TYPES as readonly string[]).includes(type) || !data || !/^[A-Za-z0-9+/=]+$/.test(data)) {
    vfail(
      `SSH public key must start with one of ${SSH_KEY_TYPES.join(", ")} followed by base64 key data.`,
      "invalid_ssh_key",
      field,
    );
  }
  return k;
}

/** Validate, trim and de-duplicate inline SSH public keys. */
export function normaliseSshKeys(keys: unknown, field = "ssh_keys"): string[] {
  return normaliseIdList(keys, field).map((k) => validateSshPublicKey(k, field));
}

export const NETWORK_CONNECTIVITY_MODES = ["private", "nat", "public_ip"] as const;

/**
 * Local (no-lookup) VPC placement rules: `vpc_id` and `subnet_id` together;
 * `network_connectivity` only with a VPC; `reserved_public_ip_id` needs a VPC
 * and `public_ip` connectivity.
 */
export function validateNetworkFields(args: {
  vpc_id?: string | null;
  subnet_id?: string | null;
  network_connectivity?: string | null;
  reserved_public_ip_id?: string | null;
}): {
  vpc_id?: string;
  subnet_id?: string;
  network_connectivity?: "private" | "nat" | "public_ip";
  reserved_public_ip_id?: string;
} {
  const vpc = String(args.vpc_id ?? "").trim() || undefined;
  const subnet = String(args.subnet_id ?? "").trim() || undefined;
  const conn = String(args.network_connectivity ?? "").trim().toLowerCase() || undefined;
  const rip = String(args.reserved_public_ip_id ?? "").trim() || undefined;
  if (vpc && !subnet) vfail("Select a subnet for this VPC (subnet_id).", "invalid_network", "subnet_id");
  if (subnet && !vpc) vfail("subnet_id requires vpc_id.", "invalid_network", "vpc_id");
  if (conn && !(NETWORK_CONNECTIVITY_MODES as readonly string[]).includes(conn)) {
    vfail(
      `network_connectivity must be one of ${NETWORK_CONNECTIVITY_MODES.join(", ")}.`,
      "invalid_network",
      "network_connectivity",
    );
  }
  if (conn && !vpc) vfail("network_connectivity requires vpc_id and subnet_id.", "invalid_network", "network_connectivity");
  if (rip && !vpc) vfail("reserved_public_ip_id requires vpc_id and subnet_id.", "invalid_network", "reserved_public_ip_id");
  if (rip && conn !== "public_ip") {
    vfail("reserved_public_ip_id requires network_connectivity 'public_ip'.", "invalid_network", "reserved_public_ip_id");
  }
  return {
    vpc_id: vpc,
    subnet_id: subnet,
    network_connectivity: conn as "private" | "nat" | "public_ip" | undefined,
    reserved_public_ip_id: rip,
  };
}

/** Portal normalisation of a VPC's connectivity type. */
export function normaliseVpcConnectivityType(value: unknown): "nat_gateway" | "private" | "public" {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "nat" || v === "nat_gateway") return "nat_gateway";
  if (v === "private") return "private";
  return "public";
}

const UNUSABLE_VPC_STATES = new Set(["deleting", "deleted", "error", "failed"]);

/**
 * Portal VPC / NAT / Reserved IP placement rules, checked against the looked-up
 * VPC, subnet and Reserved IP.
 */
export function validateVmNetworkPlacement(args: {
  siteId: string;
  vpc: Record<string, unknown>;
  subnet?: Record<string, unknown> | null;
  subnetId: string;
  connectivity: "private" | "nat" | "public_ip";
  reservedIp?: Record<string, unknown> | null;
}): void {
  const { vpc, siteId, connectivity } = args;
  const vpcSite = String(vpc.site_id ?? "").trim();
  if (vpcSite && vpcSite !== siteId) {
    vfail("The selected VPC is in a different site from the VM.", "invalid_network", "vpc_id");
  }
  const status = String(vpc.status ?? "").trim().toLowerCase();
  if (UNUSABLE_VPC_STATES.has(status)) {
    vfail(`The selected VPC is ${status} and cannot be used.`, "invalid_network", "vpc_id");
  }
  if (args.subnet) {
    const subnetVpc = String(args.subnet.vpc_id ?? "").trim();
    if (subnetVpc && subnetVpc !== String(vpc.vpc_id ?? "").trim()) {
      vfail("The selected subnet does not belong to this VPC.", "invalid_network", "subnet_id");
    }
  }
  const type = normaliseVpcConnectivityType(vpc.connectivity_type);
  if (connectivity === "nat" && type !== "nat_gateway") {
    vfail("NAT connectivity is available only in NAT Gateway VPCs.", "invalid_network", "network_connectivity");
  }
  if (connectivity === "public_ip") {
    if (type === "nat_gateway") {
      vfail("Dedicated public IPs are not available for NAT Gateway VPCs.", "invalid_network", "network_connectivity");
    }
    if (type === "private" && !args.reservedIp) {
      vfail(
        "Select an available Reserved IP (reserved_public_ip_id) for a public IP on a private VPC.",
        "invalid_network",
        "reserved_public_ip_id",
      );
    }
  }
  if (args.reservedIp) {
    const rip = args.reservedIp;
    const ripSite = String(rip.site_id ?? "").trim();
    if (ripSite && ripSite !== siteId) {
      vfail("The Reserved IP is in a different site from the VM.", "invalid_network", "reserved_public_ip_id");
    }
    for (const key of ["attached_resource_id", "attached_to", "nat_gateway_id", "vm_id"]) {
      if (String(rip[key] ?? "").trim()) {
        vfail("The Reserved IP is already attached.", "invalid_network", "reserved_public_ip_id");
      }
    }
  }
}

/** Firewall groups at create: at most one. */
export function normaliseFirewallGroupIds(ids: unknown): string[] {
  const list = normaliseIdList(ids, "firewall_group_ids");
  if (list.length > 1) {
    vfail("Select at most one firewall group.", "invalid_firewall_group_ids", "firewall_group_ids");
  }
  return list;
}

/** Actions gated by the portal's VM state matrix. */
export type VmStateAction =
  | "start"
  | "stop"
  | "reboot"
  | "delete"
  | "access"
  | "resize"
  | "resize-plan"
  | "resize-root-disk";

const RESIZE_STATES = new Set(["running", "stopped", "error"]);

/** Portal state matrix: throws `vm_state_conflict` when the action is not allowed now. */
export function assertVmActionAllowed(vm: Record<string, unknown> | null | undefined, action: VmStateAction): void {
  const status = String(vm?.status ?? "").trim().toLowerCase();
  const block = (why: string) =>
    vfail(`Cannot ${action.replace(/-/g, " ")} this VM while its status is '${status || "unknown"}'${why}.`, "vm_state_conflict", "status");
  switch (action) {
    case "start":
      if (status !== "stopped") block(" (the VM must be stopped)");
      break;
    case "stop":
    case "reboot":
      if (status !== "running") block(" (the VM must be running)");
      break;
    case "delete":
      if (status === "deleting" || status === "deleted") block("");
      break;
    case "access":
      if (isWindowsVm(vm)) {
        vfail("SSH key and password-login settings are supported for Linux VMs only.", "vm_os_unsupported", "os_type");
      }
      if (status !== "running") block(" (the VM must be running)");
      break;
    default:
      if (!RESIZE_STATES.has(status)) block(" (the VM must be running, stopped or in error)");
  }
}

/** True when the VM's OS type or distro says Windows. */
export function isWindowsVm(vm: Record<string, unknown> | null | undefined): boolean {
  return /windows/i.test(String(vm?.os_type ?? "")) || /windows/i.test(String(vm?.os_distro ?? ""));
}

/**
 * Decide the delete body for a VM's public IP (portal delete dialog). A VM
 * with an auto-assigned public IP needs `reserve` or `release` (default
 * `release`). Returns undefined when nothing needs to be sent.
 */
export function resolveDeletePublicIpAction(
  vm: Record<string, unknown>,
  args: {
    publicIpAction?: string;
    reservedIpLabel?: string;
    reservedIpBillingCatalog?: unknown;
  } = {},
): { public_ip_action: "reserve" | "release"; reserved_ip_label?: string; reserved_ip_billing_catalog?: Record<string, unknown> } | undefined {
  const action = args.publicIpAction;
  if (action !== undefined && action !== "reserve" && action !== "release") {
    vfail("publicIpAction must be 'reserve' or 'release'.", "invalid_public_ip_action", "public_ip_action");
  }
  const needs =
    String(vm.public_ip ?? "").trim() !== "" &&
    !String(vm.reserved_public_ip_id ?? vm.retained_reserved_public_ip_id ?? "").trim();
  if (action === "reserve") {
    if (!needs) {
      vfail("This VM does not have an auto-assigned public IP to reserve.", "invalid_public_ip_action", "public_ip_action");
    }
    if (!String(vm.site_id ?? "").trim()) {
      vfail(
        "The VM location is unavailable, so its public IP cannot be reserved yet.",
        "invalid_public_ip_action",
        "public_ip_action",
      );
    }
    const catalog = args.reservedIpBillingCatalog;
    if (!isRec(catalog) || !String(catalog.sku_id ?? "").trim()) {
      vfail(
        "reservedIpBillingCatalog with sku_id is required to reserve the public IP (copy the billing_catalog of an existing Reserved IP in the same site).",
        "invalid_reserved_ip_billing_catalog",
        "reserved_ip_billing_catalog",
      );
    }
    const label = String(args.reservedIpLabel ?? vm.name ?? "").trim();
    if (label.length > 120) vfail("reservedIpLabel must be at most 120 characters.", "invalid_reserved_ip_label", "reserved_ip_label");
    return {
      public_ip_action: "reserve",
      ...(label ? { reserved_ip_label: label } : {}),
      reserved_ip_billing_catalog: catalog as Record<string, unknown>,
    };
  }
  if (action === "release") return { public_ip_action: "release" };
  return needs ? { public_ip_action: "release" } : undefined;
}

/** Validate an access-update payload on its own (no VM lookup). Returns the cleaned body. */
export function validateAccessUpdate(payload: Record<string, unknown>): Record<string, unknown> {
  if (!isRec(payload)) vfail("request must be an object.", "invalid_access_update", "request");
  const body: Record<string, unknown> = { ...payload };
  const mode = body.ssh_key_mode === undefined || body.ssh_key_mode === null ? undefined : String(body.ssh_key_mode).trim().toLowerCase();
  if (mode !== undefined && mode !== "add" && mode !== "remove") {
    vfail("ssh_key_mode must be 'add' or 'remove'.", "invalid_access_update", "ssh_key_mode");
  }
  const keys = normaliseSshKeys(body.ssh_keys);
  const ids = normaliseIdList(body.ssh_key_ids, "ssh_key_ids");
  let refs: Record<string, unknown>[] = [];
  if (body.ssh_key_secret_refs !== undefined && body.ssh_key_secret_refs !== null) {
    if (!Array.isArray(body.ssh_key_secret_refs)) {
      vfail("ssh_key_secret_refs must be an array.", "invalid_access_update", "ssh_key_secret_refs");
    }
    refs = (body.ssh_key_secret_refs as unknown[]).map((r) => {
      if (!isRec(r) || !(String(r.ssh_key_id ?? "").trim() || String(r.secret_name ?? "").trim())) {
        vfail("Each ssh_key_secret_refs entry needs ssh_key_id or secret_name.", "invalid_access_update", "ssh_key_secret_refs");
      }
      return r as Record<string, unknown>;
    });
  }
  const hasKeys = keys.length + ids.length + refs.length > 0;
  if (mode && !hasKeys) {
    vfail("ssh_keys, ssh_key_ids or ssh_key_secret_refs are required when ssh_key_mode is set.", "invalid_access_update", "ssh_key_mode");
  }
  if (hasKeys && !mode) vfail("ssh_key_mode ('add' or 'remove') is required when SSH keys are given.", "invalid_access_update", "ssh_key_mode");
  let password: string | undefined;
  if (body.new_password !== undefined && body.new_password !== null) {
    if (typeof body.new_password !== "string") vfail("new_password must be a string.", "invalid_password", "new_password");
    const pw = (body.new_password as string).trim();
    if (pw) {
      if (/[\r\n]/.test(pw)) vfail("new_password must not contain line breaks.", "invalid_password", "new_password");
      if (pw.length < 8) vfail("new_password must be at least 8 characters.", "invalid_password", "new_password");
      password = pw;
    }
  }
  const pwAuth = body.password_auth_enabled;
  if (pwAuth !== undefined && pwAuth !== null && typeof pwAuth !== "boolean") {
    vfail("password_auth_enabled must be a boolean.", "invalid_access_update", "password_auth_enabled");
  }
  if (!mode && !password && (pwAuth === undefined || pwAuth === null)) {
    vfail("At least one access setting change is required.", "invalid_access_update", "request");
  }
  if (mode) body.ssh_key_mode = mode;
  else delete body.ssh_key_mode;
  if (keys.length) body.ssh_keys = keys;
  else delete body.ssh_keys;
  if (ids.length) body.ssh_key_ids = ids;
  else delete body.ssh_key_ids;
  if (refs.length) body.ssh_key_secret_refs = refs;
  else delete body.ssh_key_secret_refs;
  if (password) body.new_password = password;
  else delete body.new_password;
  for (const k of ["created_by", "created_by_name", "created_by_email", "organization_id", "workspace_id"]) delete body[k];
  return body;
}

const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : [];

/**
 * Access rules that need the VM: Linux only, running, and SSH-key/password
 * login safety (API rules for the last tracked key).
 */
export function validateAccessUpdateAgainstVm(vm: Record<string, unknown>, body: Record<string, unknown>): void {
  assertVmActionAllowed(vm, "access");
  let keys = listOf(vm.ssh_keys);
  let ids = listOf(vm.ssh_key_ids);
  let refs = Array.isArray(vm.ssh_key_secret_refs) ? (vm.ssh_key_secret_refs as unknown[]).filter(isRec) : [];
  const inKeys = listOf(body.ssh_keys);
  const inIds = listOf(body.ssh_key_ids);
  const inRefs = Array.isArray(body.ssh_key_secret_refs) ? (body.ssh_key_secret_refs as unknown[]).filter(isRec) : [];
  const refIds = (r: Record<string, unknown>) =>
    [String(r.ssh_key_id ?? "").trim(), String(r.secret_name ?? "").trim()].filter(Boolean);
  if (body.ssh_key_mode === "add") {
    keys = [...new Set([...keys, ...inKeys])];
    ids = [...new Set([...ids, ...inIds])];
    refs = [...refs, ...inRefs];
  } else if (body.ssh_key_mode === "remove") {
    const removeIds = new Set([...inIds, ...inRefs.flatMap(refIds)]);
    keys = keys.filter((k) => !inKeys.includes(k));
    ids = ids.filter((i) => !removeIds.has(i));
    refs = refs.filter((r) => !refIds(r).some((x) => removeIds.has(x)));
  }
  const remaining = keys.length + ids.length + refs.length > 0;
  const current = vm.ssh_password_auth_enabled;
  const requested = body.password_auth_enabled;
  if (requested === false && !remaining) {
    vfail("Cannot disable SSH password login without at least one tracked SSH key.", "invalid_access_update", "password_auth_enabled");
  }
  const finalPw = typeof requested === "boolean" ? requested : typeof current === "boolean" ? current : undefined;
  if (body.ssh_key_mode === "remove" && !remaining && finalPw === false && body.confirm_remove_last_ssh_key !== true) {
    vfail(
      "Removing the last tracked SSH key while password SSH login is disabled requires confirm_remove_last_ssh_key: true.",
      "invalid_access_update",
      "confirm_remove_last_ssh_key",
    );
  }
}

/** API ranges for resize targets. */
export const VM_RESIZE_LIMITS = {
  cpu: { min: 1, max: 256 },
  ram_mb: { min: 257, max: 2_097_152 },
  disk_gb: { min: 1, max: 10_000 },
} as const;

function checkRange(value: unknown, field: keyof typeof VM_RESIZE_LIMITS | "new_size_gb"): void {
  if (value === undefined || value === null) return;
  const lim = field === "new_size_gb" ? VM_RESIZE_LIMITS.disk_gb : VM_RESIZE_LIMITS[field];
  if (!isInt(value) || value < lim.min || value > lim.max) {
    vfail(`${field} must be an integer between ${lim.min} and ${lim.max}.`, "invalid_resize_target", field);
  }
}

/** Validate a resize target; at least one of cpu/ram_mb/disk_gb unless `requireOne` is false. */
export function validateResizeTarget(
  target: { cpu?: unknown; ram_mb?: unknown; disk_gb?: unknown },
  requireOne = true,
): void {
  checkRange(target.cpu, "cpu");
  checkRange(target.ram_mb, "ram_mb");
  checkRange(target.disk_gb, "disk_gb");
  if (
    requireOne &&
    (target.cpu === undefined || target.cpu === null) &&
    (target.ram_mb === undefined || target.ram_mb === null) &&
    (target.disk_gb === undefined || target.disk_gb === null)
  ) {
    vfail("At least one of cpu, ram_mb or disk_gb is required.", "invalid_resize_target", "request");
  }
}

/** Validate a root-disk grow request against the current size (grow only). */
export function validateRootDiskGrow(newSizeGb: unknown, currentGb?: unknown): void {
  checkRange(newSizeGb, "new_size_gb");
  if (newSizeGb === undefined || newSizeGb === null) {
    vfail("new_size_gb is required.", "invalid_resize_target", "new_size_gb");
  }
  const cur = Number(currentGb);
  if (Number.isFinite(cur) && cur > 0 && (newSizeGb as number) <= cur) {
    vfail(
      `new_size_gb must be larger than the current root disk (${cur} GB); shrinking is not supported.`,
      "invalid_resize_target",
      "new_size_gb",
    );
  }
}

/**
 * Validate a CPU/RAM shape change against the VM: identical shape is a no-op,
 * and a downgrade needs `confirm_downgrade: true`.
 */
export function validateResizePlanChange(
  vm: Record<string, unknown>,
  target: { cpu: number; ram_mb: number; confirm_downgrade?: boolean },
): void {
  const cpu = Number(vm.cpu);
  const ram = Number(vm.ram_mb);
  if (Number.isFinite(cpu) && Number.isFinite(ram) && cpu === target.cpu && ram === target.ram_mb) {
    vfail("The VM already has this CPU and RAM; there are no changes to apply.", "no_changes", "request");
  }
  const downgrade = (Number.isFinite(cpu) && target.cpu < cpu) || (Number.isFinite(ram) && target.ram_mb < ram);
  if (downgrade && target.confirm_downgrade !== true) {
    vfail("This is a downgrade; set confirm_downgrade: true to continue.", "downgrade_not_confirmed", "confirm_downgrade");
  }
}

export const VM_METRICS_RANGES = ["30m", "1h", "6h", "24h", "7d"] as const;
export const BANDWIDTH_MONTH_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export function validateMetricsRange(range: unknown): void {
  if (range === undefined || range === null) return;
  if (!(VM_METRICS_RANGES as readonly string[]).includes(String(range))) {
    vfail(`range must be one of ${VM_METRICS_RANGES.join(", ")}.`, "invalid_range", "range");
  }
}

export function validateBandwidthMonth(month: unknown): string {
  const m = typeof month === "string" ? month.trim() : "";
  if (!BANDWIDTH_MONTH_PATTERN.test(m)) vfail("month must look like YYYY-MM.", "invalid_month", "month");
  return m;
}

/** Validate an integer between min and max (inclusive) when present. */
export function validateIntRange(value: unknown, field: string, min: number, max: number): void {
  if (value === undefined || value === null) return;
  if (!isInt(value) || value < min || value > max) {
    vfail(`${field} must be an integer between ${min} and ${max}.`, `invalid_${field}`, field);
  }
}

/** Validate an optional `requested_by` (1..128 characters). */
export function validateRequestedBy(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    vfail("requested_by must be 1-128 characters.", "invalid_requested_by", "requested_by");
  }
}

// ======================================================================
// Recovery: snapshots, backups, restores, volumes.
// ======================================================================

export const SNAPSHOT_MODES = ["root_only", "all_attached", "selective"] as const;

/** Validate a snapshot create body; returns the body to send (without billing_catalog). */
export function validateSnapshotCreate(req: Record<string, unknown>): Record<string, unknown> {
  if (!isRec(req)) vfail("request must be an object.", "invalid_snapshot", "request");
  const name = typeof req.name === "string" ? req.name.trim() : "";
  if (!name) vfail("Snapshot name is required.", "invalid_snapshot_name", "name");
  if (name.length > 255) vfail("Snapshot name must be at most 255 characters.", "invalid_snapshot_name", "name");
  let description: string | undefined;
  if (req.description !== undefined && req.description !== null) {
    description = String(req.description).trim() || undefined;
    if (description && description.length > 1024) {
      vfail("description must be at most 1024 characters.", "invalid_description", "description");
    }
  }
  const mode = req.mode === undefined || req.mode === null ? "all_attached" : String(req.mode);
  if (!(SNAPSHOT_MODES as readonly string[]).includes(mode)) {
    vfail(`mode must be one of ${SNAPSHOT_MODES.join(", ")}.`, "invalid_snapshot_mode", "mode");
  }
  const ids = normaliseIdList(req.selected_data_volume_ids, "selected_data_volume_ids");
  if (mode === "selective" && ids.length === 0) {
    vfail(
      "Select at least one attached data volume for a selective snapshot.",
      "invalid_snapshot_volumes",
      "selected_data_volume_ids",
    );
  }
  if (mode !== "selective" && ids.length > 0) {
    vfail(
      "selected_data_volume_ids is only used with mode 'selective'.",
      "invalid_snapshot_volumes",
      "selected_data_volume_ids",
    );
  }
  validateRequestedBy(req.requested_by);
  return {
    name,
    ...(description ? { description } : {}),
    mode,
    selected_data_volume_ids: ids,
    ...(req.requested_by !== undefined ? { requested_by: req.requested_by } : {}),
  };
}

/** Recovery list paging: limit 1..200, offset >= 0, search trimmed. */
export function recoveryListQuery(args: { limit?: number; offset?: number; search?: string }): Record<string, string | number | undefined> {
  validateLimitOffset(args, 200);
  const search = args.search === undefined || args.search === null ? undefined : String(args.search).trim() || undefined;
  return { limit: args.limit, offset: args.offset, search };
}

export const BACKUP_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const BACKUP_FREQUENCIES = ["daily", "weekly"] as const;

/** True when `tz` is an IANA time zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a backup schedule (portal: daily or weekly only; weekly needs
 * `day_of_week` 0..6 with 0 = Monday). Returns the complete schedule with the
 * portal defaults filled: hour 12, minute 0, UTC, 30-minute window.
 */
export function validateBackupSchedule(
  schedule: Record<string, unknown> | undefined,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  if (schedule !== undefined && !isRec(schedule)) vfail("schedule must be an object.", "invalid_schedule", "schedule");
  const s = { ...base, ...(schedule ?? {}) } as Record<string, unknown>;
  const frequency = String(s.frequency ?? "daily").toLowerCase();
  if (!(BACKUP_FREQUENCIES as readonly string[]).includes(frequency)) {
    vfail("schedule.frequency must be 'daily' or 'weekly'.", "invalid_schedule", "schedule.frequency");
  }
  const hour = s.hour ?? 12;
  const minute = s.minute ?? 0;
  const windowMinutes = s.window_minutes ?? 30;
  validateIntRange(hour, "hour", 0, 23);
  validateIntRange(minute, "minute", 0, 59);
  validateIntRange(windowMinutes, "window_minutes", 5, 180);
  const timezone = String(s.timezone ?? "UTC").trim() || "UTC";
  if (timezone.length > 128 || !isValidTimeZone(timezone)) {
    vfail(`schedule.timezone '${timezone}' is not a valid IANA time zone.`, "invalid_schedule", "schedule.timezone");
  }
  const out: Record<string, unknown> = { frequency, hour, minute, timezone, window_minutes: windowMinutes };
  if (frequency === "weekly") {
    const dow = s.day_of_week;
    if (dow === undefined || dow === null) {
      vfail("schedule.day_of_week (0 = Monday .. 6 = Sunday) is required for weekly backups.", "invalid_schedule", "schedule.day_of_week");
    }
    validateIntRange(dow, "day_of_week", 0, 6);
    out.day_of_week = dow;
  } else if (schedule && schedule.day_of_week !== undefined && schedule.day_of_week !== null) {
    vfail("schedule.day_of_week is only used with weekly backups.", "invalid_schedule", "schedule.day_of_week");
  }
  return out;
}

/** Validate retention settings (retention 1..365, full interval 1..30). */
export function validateBackupRetention(req: Record<string, unknown>): void {
  validateIntRange(req.retention_days, "retention_days", 1, 365);
  validateIntRange(req.full_backup_interval_days, "full_backup_interval_days", 1, 30);
  if (req.incremental_enabled !== undefined && req.incremental_enabled !== null && typeof req.incremental_enabled !== "boolean") {
    vfail("incremental_enabled must be a boolean.", "invalid_incremental_enabled", "incremental_enabled");
  }
}

/** Require a timezone-aware timestamp; returns ISO-8601. */
export function validateNextRunAt(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) vfail("next_run_at is not a valid date.", "invalid_next_run_at", "next_run_at");
    return value.toISOString();
  }
  const s = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s) || Number.isNaN(Date.parse(s))) {
    vfail(
      "next_run_at must be an ISO-8601 timestamp with a time zone (Z or an offset).",
      "invalid_next_run_at",
      "next_run_at",
    );
  }
  return s;
}

/** Trim a manual backup reason; blank -> undefined; max 512. */
export function normaliseBackupReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  const r = String(reason).trim();
  if (r.length > 512) vfail("reason must be at most 512 characters.", "invalid_reason", "reason");
  return r || undefined;
}

/** Detach needs confirmation that the volume is unmounted in the guest, unless forced. */
export function validateDetachConfirmation(req: { confirm_unmounted?: boolean; force?: boolean }): void {
  if (req.confirm_unmounted !== true && req.force !== true) {
    vfail(
      "Confirm the volume is unmounted in the guest (confirm_unmounted: true) or pass force: true.",
      "detach_not_confirmed",
      "confirm_unmounted",
    );
  }
}

export const VM_VOLUME_MODES = ["single-writer", "multi-writer"] as const;
