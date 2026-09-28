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

/** Secret Store workspace IDs: 2..128 digits, no leading zero. */
export const SECRET_STORE_WORKSPACE_ID_PATTERN = /^[1-9][0-9]{1,127}$/;
export const SECRET_STORE_WORKSPACE_ID_ERROR =
  "workspace_id must be a numeric string of 2 to 128 digits without a leading zero for Secret Store requests.";

/**
 * Validate a workspace ID (`^[1-9][0-9]*$`, string only) and return it.
 * With `service: "secret-store"` the Secret Store rule applies as well
 * (2..128 digits; single-digit workspace IDs are refused by that service).
 */
export function validateWorkspaceId(workspaceId: unknown, service?: "secret-store"): string {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new IbeeValidationError(WORKSPACE_ID_ERROR, "invalid_workspace_id", "workspace_id");
  }
  if (service === "secret-store" && !SECRET_STORE_WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new IbeeValidationError(
      SECRET_STORE_WORKSPACE_ID_ERROR,
      "invalid_workspace_id",
      "workspace_id",
    );
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

/** True for any Secret Store path (all bodies are limited to 64 KiB). */
export function isSecretStorePath(path: string): boolean {
  return /^\/secret-store(\/|$)/.test(normalisePath(path));
}

/**
 * Enforce the 64 KiB edge limit on billable create bodies and on every
 * Secret Store request body (the gateway buffers at most 64 KiB there).
 */
export function assertBillableBodySize(method: string, path: string, serialized: string | undefined): void {
  if (serialized === undefined) return;
  const billable = isBillableCreate(method, path);
  if (!billable && !isSecretStorePath(path)) return;
  const size = new TextEncoder().encode(serialized).length;
  if (size > MAX_BILLABLE_BODY_BYTES) {
    throw new IbeeValidationError(
      billable
        ? `Request body is ${size} bytes; billable create requests are limited to ${MAX_BILLABLE_BODY_BYTES} bytes.`
        : `Request body is ${size} bytes; Secret Store requests are limited to ${MAX_BILLABLE_BODY_BYTES} bytes.`,
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

// ======================================================================
// Networking: VPCs, subnets, NAT, virtual IPs, Reserved IPs, firewalls
// and load balancers (portal parity). All throw IbeeValidationError.
// ======================================================================

/**
 * The IP/target has no VPC network allocation (the API answered 404 with
 * "require a VPC network allocation"). Attaching a held Reserved IP to a
 * non-VPC VM is not available through the public API yet.
 */
export class ReservedIpTargetUnsupportedError extends IbeeValidationError {
  readonly statusCode = 404;
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message, "reserved_ip_target_unsupported", "vm_id");
    this.name = "ReservedIpTargetUnsupportedError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** Marker used in JSDoc for routes/fields outside the published contract. */
export const UNCONTRACTED_NOTE = "Not yet part of the published API contract; behaviour may change.";

const trimStr = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Parse a dotted-quad IPv4 address (portal rules) into an integer, or null. */
export function parseIpv4(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

/** Format an integer as a dotted-quad IPv4 address. */
export function formatIpv4(n: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join(".");
}

export interface ParsedIpv4Cidr {
  /** Address exactly as written (may have host bits set). */
  address: number;
  prefix: number;
  size: number;
  /** Network start (host bits cleared). */
  start: number;
  end: number;
  /** True when the written address is the network address. */
  aligned: boolean;
}

/** Parse `A.B.C.D/P` (P 0..32), or return null when the format is invalid. */
export function parseIpv4Cidr(value: unknown): ParsedIpv4Cidr | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split("/");
  if (parts.length !== 2 || !/^\d{1,2}$/.test(parts[1].trim())) return null;
  const address = parseIpv4(parts[0]);
  const prefix = Number(parts[1].trim());
  if (address === null || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(address / size) * size;
  return { address, prefix, size, start, end: start + size - 1, aligned: start === address };
}

/** RFC1918 blocks as inclusive integer ranges. */
export const RFC1918_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [parseIpv4("10.0.0.0")!, parseIpv4("10.255.255.255")!],
  [parseIpv4("172.16.0.0")!, parseIpv4("172.31.255.255")!],
  [parseIpv4("192.168.0.0")!, parseIpv4("192.168.255.255")!],
];
export const RFC1918_MESSAGE =
  "Use private RFC1918 space: 10.0.0.0/8, 172.16.0.0/12, or 192.168.0.0/16.";

const inRfc1918 = (start: number, end: number) =>
  RFC1918_BLOCKS.some(([a, b]) => start >= a && end <= b);

/** Non-routable IPv4 ranges (what the API treats as a private address). */
const PRIVATE_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 29], ["192.0.0.170", 31], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["240.0.0.0", 4], ["255.255.255.255", 32],
];

/** True when an IPv4 address is private (non-globally-routable). */
export function isPrivateIpv4(value: unknown): boolean {
  const n = parseIpv4(value);
  if (n === null) return false;
  return PRIVATE_IPV4_RANGES.some(([base, prefix]) => {
    const size = 2 ** (32 - prefix);
    const start = parseIpv4(base)!;
    return n >= start && n < start + size;
  });
}

const cidrOrFail = (cidr: unknown, field: string): ParsedIpv4Cidr => {
  const p = parseIpv4Cidr(cidr);
  if (!p) vfail(`${field} must be an IPv4 CIDR like 10.20.0.0/24.`, "invalid_cidr", field);
  return p as ParsedIpv4Cidr;
};

/** True when `inner` lies entirely inside `outer` (both IPv4 CIDRs). */
export function cidrContains(outer: string, inner: string): boolean {
  const o = cidrOrFail(outer, "cidr");
  const i = cidrOrFail(inner, "cidr");
  return i.start >= o.start && i.end <= o.end;
}

/** True when two IPv4 CIDRs share any address. */
export function cidrOverlaps(a: string, b: string): boolean {
  const x = cidrOrFail(a, "cidr");
  const y = cidrOrFail(b, "cidr");
  return x.start <= y.end && y.start <= x.end;
}

/**
 * Validate a private IPv4 CIDR: format, prefix range, alignment (host bits
 * zero; the error suggests the aligned network) and RFC1918 containment.
 * Returns the trimmed CIDR.
 */
export function validatePrivateCidr(
  cidr: unknown,
  opts: { minPrefix: number; maxPrefix: number; field?: string; prefixMessage?: string },
): string {
  const field = opts.field ?? "cidr";
  const p = parseIpv4Cidr(cidr);
  if (!p) vfail("Enter a valid IPv4 network address (A.B.C.D/P).", "invalid_cidr", field);
  const c = p as ParsedIpv4Cidr;
  if (c.prefix < opts.minPrefix || c.prefix > opts.maxPrefix) {
    vfail(
      opts.prefixMessage ?? `Enter a valid private network range (/${opts.minPrefix} to /${opts.maxPrefix}).`,
      "invalid_cidr",
      field,
    );
  }
  if (!c.aligned) {
    const suggestion = `${formatIpv4(c.start)}/${c.prefix}`;
    vfail(
      `The address is not aligned to a /${c.prefix} boundary. Use ${suggestion}.`,
      "invalid_cidr",
      field,
      { suggestion },
    );
  }
  if (!inRfc1918(c.start, c.end)) vfail(RFC1918_MESSAGE, "invalid_cidr", field);
  return `${formatIpv4(c.start)}/${c.prefix}`;
}

/** VPC CIDR rule: RFC1918, aligned, /22../28. */
export const VPC_CIDR_PREFIX_RANGE = { min: 22, max: 28 } as const;
/** Subnets must leave room for the gateway and VMs (/29 or larger). */
export const SUBNET_MAX_PREFIX = 29;
/** Subnets per VPC. */
export const MAX_SUBNETS_PER_VPC = 10;

/** Validate a VPC CIDR (`/22`..`/28`, RFC1918, aligned). */
export function validateVpcCidr(cidr: unknown, field = "cidr"): string {
  return validatePrivateCidr(cidr, {
    minPrefix: VPC_CIDR_PREFIX_RANGE.min,
    maxPrefix: VPC_CIDR_PREFIX_RANGE.max,
    field,
  });
}

/**
 * Validate a usable host address inside a subnet (portal
 * `validateRequestedPrivateIp`): inside the CIDR, not the network/broadcast
 * address and not the subnet gateway. Returns the trimmed address.
 */
export function validateHostInSubnet(
  ip: unknown,
  subnetCidr: string,
  gateway?: string | null,
  field = "private_ip",
): string {
  const address = trimStr(ip);
  if (!address) vfail("Enter a private IPv4 address.", "invalid_private_ip", field);
  const n = parseIpv4(address);
  if (n === null) vfail("Enter a valid IPv4 address.", "invalid_private_ip", field);
  const c = parseIpv4Cidr(subnetCidr);
  if (!c) vfail("The selected subnet has an invalid CIDR.", "invalid_private_ip", field);
  const { start, end } = c as ParsedIpv4Cidr;
  if ((n as number) < start || (n as number) > end) {
    vfail(`Address must be inside ${subnetCidr}.`, "invalid_private_ip", field);
  }
  if (n === start || n === end) {
    vfail("Choose a usable host address, not the network or broadcast address.", "invalid_private_ip", field);
  }
  if (gateway && address === String(gateway).trim()) {
    vfail("This address is reserved for the subnet gateway.", "invalid_private_ip", field);
  }
  return address;
}

/** Trim a name and require 1..max characters. */
export function validateResourceName(value: unknown, field: string, max: number, label = field): string {
  const v = trimStr(value);
  if (!v) vfail(`${label} is required.`, `invalid_${field}`, field);
  if (v.length > max) vfail(`${label} must be ${max} characters or fewer.`, `invalid_${field}`, field);
  return v;
}

/** Trim optional text and require at most `max` characters. */
export function validateOptionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") vfail(`${field} must be a string.`, `invalid_${field}`, field);
  const v = (value as string).trim();
  if (v.length > max) vfail(`${field} must be ${max} characters or fewer.`, `invalid_${field}`, field);
  return v;
}

/** Trim an ID and require 1..max characters. */
export function validateBoundedId(value: unknown, field: string, max = 160): string {
  const v = trimStr(value);
  if (!v) vfail(`${field} is required.`, `invalid_${field}`, field);
  if (v.length > max) vfail(`${field} must be ${max} characters or fewer.`, `invalid_${field}`, field);
  return v;
}

/** Optional ID: undefined when absent, else trimmed and non-empty. */
function optionalId(value: unknown, field: string, max = 160): string | undefined {
  if (value === undefined || value === null) return undefined;
  return validateBoundedId(value, field, max);
}

/**
 * Normalise a VM ID list (announcers / VIP targets): trim, reject blanks,
 * de-duplicate (order kept), at most `maxItems`.
 */
export function normaliseVmIdList(values: unknown, field = "vm_ids", maxItems = 32): string[] {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) vfail(`${field} must be an array of strings.`, `invalid_${field}`, field);
  const out: string[] = [];
  for (const raw of values as unknown[]) {
    const v = String(raw ?? "").trim();
    if (!v) vfail(`${field} cannot contain blank IDs.`, `invalid_${field}`, field);
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > maxItems) vfail(`${field} accepts at most ${maxItems} IDs.`, `invalid_${field}`, field);
  return out;
}

export const PORT_MESSAGE = "Ports must be whole numbers from 1 to 65535.";

/** Validate a single TCP/UDP port (integer 1..65535; no ranges). */
export function validatePort(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    vfail(PORT_MESSAGE, "invalid_port", field);
  }
  return value as number;
}

/** Validate a DNS server list (at least one IPv4 address). */
export function validateDnsList(dns: unknown, field = "dns"): string[] {
  if (!Array.isArray(dns) || dns.length === 0) {
    vfail("At least one DNS server is required.", "invalid_dns", field);
  }
  return (dns as unknown[]).map((d) => {
    const v = trimStr(d);
    if (parseIpv4(v) === null) vfail(`DNS server '${String(d)}' is not a valid IPv4 address.`, "invalid_dns", field);
    return v;
  });
}

/** Require at least one defined field in a PATCH body. */
export function requireAtLeastOneField(body: Record<string, unknown>, message: string): void {
  if (!Object.values(body).some((v) => v !== undefined)) vfail(message, "no_changes");
}

// ------------------------------------------------------------ billing SKUs

/** Keys the portal sends in a network billing catalog. */
export const NETWORK_BILLING_CATALOG_KEYS = [
  "source", "product_id", "product_code", "sku_id", "sku_code", "display_name",
  "plan_id", "plan_version", "unit_price_minor", "price_currency", "billing_interval",
  "billing_period_hours",
] as const;

/** Portal network price entry (from the IBEE billing catalog). */
export interface NetworkCatalogPrice {
  source?: string;
  productId?: string;
  productCode?: string;
  skuId?: string | number;
  skuCode: string;
  displayName?: string;
  planId?: string;
  planVersion?: string | number | null;
  amountMinor?: number;
  currency?: string;
  billingInterval?: string;
  billingPeriodHours?: number;
}

/**
 * Build the NAT-GATEWAY / RESERVED-IP billing catalog the portal sends from a
 * price entry obtained from the IBEE billing catalog. Returns `{}` for null.
 */
export function networkBillingCatalog(price: NetworkCatalogPrice | null | undefined): Record<string, unknown> {
  if (!price) return {};
  return {
    source: price.source,
    product_id: price.productId,
    product_code: price.productCode,
    sku_id: price.skuId,
    sku_code: price.skuCode,
    display_name: price.displayName ?? price.skuCode,
    plan_id: price.planId,
    plan_version: price.planVersion,
    unit_price_minor: price.amountMinor,
    price_currency: price.currency,
    billing_interval: price.billingInterval,
    billing_period_hours: price.billingPeriodHours,
  };
}

/**
 * Validate a network billing catalog: an object with a non-empty `sku_code`
 * (or `code`). With `requireSkuId`, `sku_id` must be present too and only the
 * portal keys are kept. `unit_price_minor`, when present, is an integer >= 0.
 */
export function validateNetworkBillingCatalog(
  catalog: unknown,
  field = "billing_catalog",
  opts: { requireSkuId?: boolean; portalKeysOnly?: boolean } = {},
): Record<string, unknown> {
  if (!isRec(catalog)) vfail(`${field} must be an object.`, "invalid_billing_catalog", field);
  const c = catalog as Record<string, unknown>;
  const code = trimStr(c.sku_code) || trimStr(c.code);
  if (!code) vfail(`${field} needs a non-empty sku_code.`, "invalid_billing_catalog", field);
  if (opts.requireSkuId) {
    const id = c.sku_id;
    const ok = (typeof id === "string" && id.trim() !== "") || (typeof id === "number" && Number.isFinite(id));
    if (!ok) vfail(`${field} needs a non-empty sku_id.`, "invalid_billing_catalog", field);
  }
  if (c.unit_price_minor !== undefined && c.unit_price_minor !== null) {
    if (!isInt(c.unit_price_minor) || (c.unit_price_minor as number) < 0) {
      vfail(`${field}.unit_price_minor must be an integer >= 0.`, "invalid_billing_catalog", field);
    }
  }
  if (!opts.portalKeysOnly) return { ...c };
  const out: Record<string, unknown> = {};
  for (const key of NETWORK_BILLING_CATALOG_KEYS) if (c[key] !== undefined) out[key] = c[key];
  return out;
}

// -------------------------------------------------------------------- VPCs

export const VPC_CONNECTIVITY_TYPES = ["private", "nat_gateway", "public"] as const;
export type VpcConnectivityType = (typeof VPC_CONNECTIVITY_TYPES)[number];

export interface VpcCreateInput {
  name: string;
  siteId: string;
  description?: string;
  region?: string;
  cidr?: string;
  autoCidr?: boolean;
  createDefaultSubnet?: boolean;
  defaultSubnetCidr?: string;
  isDefault?: boolean;
  connectivityType?: VpcConnectivityType | (string & {});
  natBillingCatalog?: Record<string, unknown>;
}

/** Validate a VPC create request and build the API body (portal rules). */
export function buildVpcCreateBody(args: VpcCreateInput): Record<string, unknown> {
  const name = trimStr(args.name);
  const siteId = trimStr(args.siteId);
  if (!name || !siteId) vfail("Name and location are required.", "invalid_vpc", !name ? "name" : "site_id");
  if (name.length > 80) vfail("name must be 1-80 characters.", "invalid_name", "name");
  if (siteId.length > 120) vfail("site_id must be 120 characters or fewer.", "invalid_site_id", "site_id");
  const description = validateOptionalText(args.description, "description", 500);
  const region = validateOptionalText(args.region, "region", 120);

  let connectivity: string | undefined;
  if (args.connectivityType !== undefined && args.connectivityType !== null) {
    connectivity = trimStr(args.connectivityType).toLowerCase();
    if (!(VPC_CONNECTIVITY_TYPES as readonly string[]).includes(connectivity)) {
      vfail(
        `connectivityType must be one of ${VPC_CONNECTIVITY_TYPES.join(", ")}.`,
        "invalid_connectivity_type",
        "connectivity_type",
      );
    }
  }

  const cidrRaw = args.cidr === undefined || args.cidr === null ? "" : trimStr(args.cidr);
  let cidr: string | undefined;
  let autoCidr = args.autoCidr;
  if (cidrRaw) {
    if (autoCidr === true) vfail("cidr requires auto_cidr=false.", "invalid_cidr_mode", "auto_cidr");
    cidr = validateVpcCidr(cidrRaw, "cidr");
    autoCidr = false;
  } else if (autoCidr === false) {
    vfail("cidr is required when auto_cidr is false.", "invalid_cidr_mode", "cidr");
  }

  let defaultSubnetCidr: string | undefined;
  if (args.defaultSubnetCidr !== undefined && args.defaultSubnetCidr !== null && trimStr(args.defaultSubnetCidr)) {
    if (args.createDefaultSubnet === false) {
      vfail("default_subnet_cidr requires create_default_subnet=true.", "invalid_cidr_mode", "default_subnet_cidr");
    }
    defaultSubnetCidr = validateVpcCidr(args.defaultSubnetCidr, "default_subnet_cidr");
    if (cidr && !cidrContains(cidr, defaultSubnetCidr)) {
      vfail(`default_subnet_cidr must be inside ${cidr}.`, "invalid_cidr", "default_subnet_cidr");
    }
  }

  let natBillingCatalog: Record<string, unknown> | undefined;
  if (args.natBillingCatalog !== undefined && args.natBillingCatalog !== null) {
    if (connectivity !== "nat_gateway") {
      vfail(
        "nat_billing_catalog is only allowed with connectivity_type 'nat_gateway'.",
        "invalid_billing_catalog",
        "nat_billing_catalog",
      );
    }
    natBillingCatalog = validateNetworkBillingCatalog(args.natBillingCatalog, "nat_billing_catalog");
  }

  return {
    name,
    ...(description ? { description } : {}),
    site_id: siteId,
    ...(region ? { region } : {}),
    ...(connectivity ? { connectivity_type: connectivity } : {}),
    ...(natBillingCatalog ? { nat_billing_catalog: natBillingCatalog } : {}),
    ...(autoCidr === undefined ? {} : { auto_cidr: autoCidr }),
    ...(cidr ? { cidr } : {}),
    ...(args.createDefaultSubnet === undefined ? {} : { create_default_subnet: args.createDefaultSubnet }),
    ...(defaultSubnetCidr ? { default_subnet_cidr: defaultSubnetCidr } : {}),
    ...(args.isDefault === undefined ? {} : { is_default: args.isDefault }),
  };
}

/** Validate a VPC PATCH (name 1..80, description <= 500, at least one field). */
export function buildVpcUpdateBody(args: { name?: string; description?: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.name !== undefined && args.name !== null) body.name = validateResourceName(args.name, "name", 80, "name");
  if (args.description !== undefined && args.description !== null) {
    body.description = validateOptionalText(args.description, "description", 500);
  }
  requireAtLeastOneField(body, "At least one VPC field must be provided.");
  return body;
}

export interface SubnetCreateInput {
  name: string;
  cidr?: string;
  autoCidr?: boolean;
  prefixLength?: number;
  dns?: string[];
}

/**
 * Validate a subnet create and build the body. With `vpc` (the VPC detail),
 * also enforce containment in the VPC CIDR, no overlap with existing subnets,
 * the 10-subnet quota and `prefixLength >= ` the VPC prefix.
 */
export function buildSubnetCreateBody(
  args: SubnetCreateInput,
  vpc?: { cidr?: string; subnets?: Array<{ cidr?: string; name?: string }> } | null,
): Record<string, unknown> {
  const name = validateResourceName(args.name, "name", 80, "Subnet name");
  const cidrRaw = args.cidr === undefined || args.cidr === null ? "" : trimStr(args.cidr);
  let cidr: string | undefined;
  let autoCidr = args.autoCidr;
  if (cidrRaw) {
    cidr = validatePrivateCidr(cidrRaw, {
      minPrefix: 0,
      maxPrefix: SUBNET_MAX_PREFIX,
      field: "cidr",
      prefixMessage: "Subnet must contain room for gateway and VM addresses (/29 or larger).",
    });
    if (args.prefixLength !== undefined && args.prefixLength !== null) {
      vfail("prefix_length is only valid with automatic CIDR allocation.", "invalid_cidr_mode", "prefix_length");
    }
    autoCidr = false;
  } else if (autoCidr === false) {
    vfail("cidr is required when auto_cidr is false.", "invalid_cidr_mode", "cidr");
  }
  if (args.prefixLength !== undefined && args.prefixLength !== null) {
    validateIntRange(args.prefixLength, "prefix_length", 22, SUBNET_MAX_PREFIX);
  }
  const dns = args.dns === undefined || args.dns === null ? undefined : validateDnsList(args.dns);

  if (vpc) {
    const subnets = Array.isArray(vpc.subnets) ? vpc.subnets : [];
    if (subnets.length >= MAX_SUBNETS_PER_VPC) {
      vfail(`Subnet quota exceeded; limit is ${MAX_SUBNETS_PER_VPC} per VPC.`, "subnet_quota_exceeded");
    }
    const vpcCidr = parseIpv4Cidr(vpc.cidr);
    if (vpcCidr && cidr) {
      if (!cidrContains(String(vpc.cidr), cidr)) {
        vfail(
          `Must be a sub-range of ${vpc.cidr} that does not overlap other subnets.`,
          "invalid_cidr",
          "cidr",
        );
      }
      for (const s of subnets) {
        if (s.cidr && parseIpv4Cidr(s.cidr) && cidrOverlaps(s.cidr, cidr)) {
          vfail(
            `Must be a sub-range of ${vpc.cidr} that does not overlap other subnets (overlaps ${s.cidr}).`,
            "invalid_cidr",
            "cidr",
          );
        }
      }
    }
    if (vpcCidr && args.prefixLength !== undefined && args.prefixLength !== null && args.prefixLength < vpcCidr.prefix) {
      vfail(`prefix_length must be /${vpcCidr.prefix} or smaller for this VPC.`, "invalid_prefix_length", "prefix_length");
    }
  }

  return {
    name,
    ...(cidr ? { cidr } : {}),
    ...(autoCidr === undefined ? {} : { auto_cidr: autoCidr }),
    ...(args.prefixLength === undefined || args.prefixLength === null ? {} : { prefix_length: args.prefixLength }),
    ...(dns ? { dns } : {}),
  };
}

/** Validate a subnet PATCH (name 1..80, DNS list, at least one field). */
export function buildSubnetUpdateBody(args: { name?: string; dns?: string[] }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.name !== undefined && args.name !== null) body.name = validateResourceName(args.name, "name", 80, "Subnet name");
  if (args.dns !== undefined && args.dns !== null) body.dns = validateDnsList(args.dns);
  requireAtLeastOneField(body, "At least one subnet field must be provided.");
  return body;
}

// ------------------------------------------------------- node attachments

export type NodeConnectivity = (typeof NETWORK_CONNECTIVITY_MODES)[number];

/**
 * Portal default connectivity when attaching a VM: `nat` for a NAT Gateway
 * VPC with an available gateway when the VM has no primary network (or the
 * caller routes internet through the VPC), otherwise `private`.
 */
export function resolveNodeConnectivity(args: {
  vpcConnectivityType: unknown;
  natGatewayAvailable: boolean;
  hasPrimaryNetwork?: boolean;
  useVpcForInternet?: boolean;
}): "nat" | "private" {
  return normaliseVpcConnectivityType(args.vpcConnectivityType) === "nat_gateway" &&
    args.natGatewayAvailable &&
    (!args.hasPrimaryNetwork || Boolean(args.useVpcForInternet))
    ? "nat"
    : "private";
}

const isAvailable = (s: unknown) => String(s ?? "").trim().toLowerCase() === "available";

/**
 * Connectivity rules for a node attach against the VPC detail: `nat` needs a
 * NAT Gateway VPC with an available gateway; `public_ip` is not allowed in NAT
 * Gateway VPCs and needs a Reserved IP in private VPCs.
 */
export function validateNodeConnectivity(
  vpc: { connectivity_type?: unknown; nat_gateways?: Array<{ status?: unknown }> | null },
  connectivity: string | undefined,
  reservedPublicIpId?: string,
): void {
  if (!connectivity) return;
  const type = normaliseVpcConnectivityType(vpc.connectivity_type);
  if (connectivity === "nat") {
    if (type !== "nat_gateway") {
      vfail("NAT connectivity is available only in NAT Gateway VPCs.", "invalid_network", "connectivity");
    }
    if (!(vpc.nat_gateways ?? []).some((g) => isAvailable(g.status))) {
      vfail("This VPC has no available NAT gateway.", "invalid_network", "connectivity");
    }
  }
  if (connectivity === "public_ip") {
    if (type === "nat_gateway") {
      vfail("Dedicated public IPs are not available for nat_gateway VPCs.", "invalid_network", "connectivity");
    }
    if (type === "private" && !reservedPublicIpId) {
      vfail(
        "A public IP on a private VPC needs a Reserved IP (reservedPublicIpId).",
        "invalid_network",
        "reserved_public_ip_id",
      );
    }
  }
}

// --------------------------------------------------------------------- NAT

export const NAT_DELETE_IP_ACTIONS = ["reserve", "release"] as const;
export type NatDeleteIpAction = (typeof NAT_DELETE_IP_ACTIONS)[number];

/**
 * Portal default for `public_ip_action` on NAT delete: `reserve` when the
 * gateway uses a Reserved IP or a RESERVED-IP catalog is available, else
 * `release`.
 */
export function defaultNatDeleteIpAction(
  gateway: { public_ip_source?: unknown } | null | undefined,
  hasReservedIpCatalog = false,
): NatDeleteIpAction {
  return String(gateway?.public_ip_source ?? "") === "reserved" || hasReservedIpCatalog ? "reserve" : "release";
}

/**
 * Portal Reserved IP eligibility for a NAT gateway / VIP: same site (or no
 * site), unattached, status `reserved`, and customer-reserved.
 */
export function validateReservedIpEligibleForService(
  rip: Record<string, unknown>,
  siteId: string | undefined,
  field = "reserved_public_ip_id",
): void {
  const ripSite = trimStr(rip.site_id);
  if (siteId && ripSite && ripSite !== siteId) {
    vfail("The Reserved IP is in a different site from the VPC.", "reserved_ip_not_eligible", field);
  }
  if (trimStr(rip.attached_resource_id) || trimStr(rip.attached_resource_type)) {
    vfail("That Reserved IP is not available; choose an unattached address.", "reserved_ip_not_eligible", field);
  }
  const status = trimStr(rip.status).toLowerCase();
  if (status && status !== "reserved") {
    vfail(`The Reserved IP is ${status}; choose a reserved address.`, "reserved_ip_not_eligible", field);
  }
  const type = trimStr(rip.reservation_type).toLowerCase();
  if (type && type !== "user_reserved") {
    vfail("Only customer Reserved IPs can be used here.", "reserved_ip_not_eligible", field);
  }
}

// ---------------------------------------------------- port-forwarding rules

export const PF_PROTOCOLS = ["tcp", "udp"] as const;
export const PF_TARGET_TYPES = ["vm", "vip"] as const;

export interface PortForwardingRuleInput {
  name?: string;
  protocol?: string;
  externalPort?: number;
  internalIp?: string;
  internalPort?: number;
  targetType?: string;
  targetVmIds?: string[];
  note?: string;
  enabled?: boolean;
}

function pfProtocol(v: unknown): string {
  const p = trimStr(v).toLowerCase();
  if (!(PF_PROTOCOLS as readonly string[]).includes(p)) vfail("protocol must be tcp or udp.", "invalid_protocol", "protocol");
  return p;
}

function pfTargetType(v: unknown): string {
  const t = trimStr(v).toLowerCase();
  if (!(PF_TARGET_TYPES as readonly string[]).includes(t)) vfail("target_type must be vm or vip.", "invalid_target_type", "target_type");
  return t;
}

function pfInternalIp(v: unknown): string {
  const ip = trimStr(v);
  if (parseIpv4(ip) === null) vfail("internal_ip must be a valid IPv4 address.", "invalid_internal_ip", "internal_ip");
  if (!isPrivateIpv4(ip)) vfail("Internal IP must be a private IPv4 address.", "invalid_internal_ip", "internal_ip");
  return ip;
}

/** Validate a port-forwarding create and build the body (portal defaults). */
export function buildPortForwardingCreateBody(args: PortForwardingRuleInput): Record<string, unknown> {
  const name = trimStr(args.name);
  const internalIpRaw = trimStr(args.internalIp);
  if (!name || !internalIpRaw) vfail("Rule name and internal IP are required.", "invalid_port_forwarding_rule", !name ? "name" : "internal_ip");
  if (name.length > 80) vfail("name must be 80 characters or fewer.", "invalid_name", "name");
  const protocol = args.protocol === undefined || args.protocol === null ? "tcp" : pfProtocol(args.protocol);
  const externalPort = validatePort(args.externalPort, "external_port");
  const internalPort = validatePort(args.internalPort, "internal_port");
  const internalIp = pfInternalIp(internalIpRaw);
  const targetType = args.targetType === undefined || args.targetType === null ? "vm" : pfTargetType(args.targetType);
  const targetVmIds = normaliseVmIdList(args.targetVmIds, "target_vm_ids");
  if (targetType === "vm" && targetVmIds.length) {
    vfail("target_vm_ids is only supported for VIP targets.", "invalid_target_vm_ids", "target_vm_ids");
  }
  const note = validateOptionalText(args.note, "note", 500) ?? "";
  if (args.enabled !== undefined && typeof args.enabled !== "boolean") vfail("enabled must be a boolean.", "invalid_enabled", "enabled");
  return {
    name,
    protocol,
    external_port: externalPort,
    internal_ip: internalIp,
    internal_port: internalPort,
    target_type: targetType,
    target_vm_ids: targetVmIds,
    note,
    enabled: args.enabled ?? true,
  };
}

/** Validate a port-forwarding PATCH and build the body. */
export function buildPortForwardingUpdateBody(args: PortForwardingRuleInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.name !== undefined && args.name !== null) body.name = validateResourceName(args.name, "name", 80, "Rule name");
  if (args.protocol !== undefined && args.protocol !== null) body.protocol = pfProtocol(args.protocol);
  if (args.externalPort !== undefined && args.externalPort !== null) body.external_port = validatePort(args.externalPort, "external_port");
  if (args.internalIp !== undefined && args.internalIp !== null) body.internal_ip = pfInternalIp(args.internalIp);
  if (args.internalPort !== undefined && args.internalPort !== null) body.internal_port = validatePort(args.internalPort, "internal_port");
  if (args.targetVmIds !== undefined && args.targetVmIds !== null && (args.targetType === undefined || args.targetType === null)) {
    vfail("target_vm_ids requires target_type in the same update.", "invalid_target_vm_ids", "target_vm_ids");
  }
  if (args.targetType !== undefined && args.targetType !== null) {
    const t = pfTargetType(args.targetType);
    body.target_type = t;
    const ids = normaliseVmIdList(args.targetVmIds, "target_vm_ids");
    if (t === "vm" && ids.length) vfail("target_vm_ids is only supported for VIP targets.", "invalid_target_vm_ids", "target_vm_ids");
    if (t === "vip" && args.targetVmIds !== undefined && args.targetVmIds !== null && !ids.length) {
      vfail("Select at least one MetalLB announcer node.", "invalid_target_vm_ids", "target_vm_ids");
    }
    if (t === "vm") body.target_vm_ids = [];
    else if (args.targetVmIds !== undefined && args.targetVmIds !== null) body.target_vm_ids = ids;
  }
  if (args.note !== undefined && args.note !== null) body.note = validateOptionalText(args.note, "note", 500);
  if (args.enabled !== undefined && args.enabled !== null) {
    if (typeof args.enabled !== "boolean") vfail("enabled must be a boolean.", "invalid_enabled", "enabled");
    body.enabled = args.enabled;
  }
  requireAtLeastOneField(body, "At least one port forwarding field must be provided.");
  return body;
}

/** Reject a duplicate (protocol, external_port) on the same NAT gateway. */
export function assertNoDuplicateExternalPort(
  rules: Array<Record<string, unknown>>,
  protocol: string,
  externalPort: number,
  excludeRuleId?: string,
): void {
  for (const r of rules) {
    const id = String(r.port_forward_rule_id ?? r.port_forwarding_rule_id ?? r.rule_id ?? "");
    if (excludeRuleId && id === excludeRuleId) continue;
    if (String(r.protocol ?? "").toLowerCase() === protocol && Number(r.external_port) === externalPort) {
      vfail(
        `${protocol.toUpperCase()} external port ${externalPort} already exists on this NAT gateway.`,
        "duplicate_external_port",
        "external_port",
      );
    }
  }
}

// ------------------------------------------------------------ virtual IPs

export const VIRTUAL_IP_PURPOSES = ["metallb", "custom"] as const;
const UNUSABLE_NODE_STATES = new Set(["deleting", "deleted", "error", "failed"]);

/** True when a VPC node can announce a MetalLB VIP (NAT-connected, usable, same subnet). */
export function isEligibleVipAnnouncer(node: Record<string, unknown>, subnetId: string): boolean {
  return (
    String(node.connectivity ?? "") === "nat" &&
    String(node.subnet_id ?? "") === subnetId &&
    !UNUSABLE_NODE_STATES.has(String(node.status ?? "").trim().toLowerCase())
  );
}

// ------------------------------------------------------------ Reserved IPs

/** Validate a Reserved IP location (`site_id`, 1..120). */
export function validateReservedIpSiteId(siteId: unknown): string {
  const s = trimStr(siteId);
  if (!s) vfail("Choose a location for the Reserved IP.", "invalid_site_id", "site_id");
  if (s.length > 120) vfail("site_id must be 120 characters or fewer.", "invalid_site_id", "site_id");
  return s;
}

const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Validate reverse DNS (empty clears it; otherwise a hostname of at most 253
 * characters, optional trailing dot, LDH labels). Returns the trimmed value.
 */
export function validateReverseDns(value: unknown): string {
  if (typeof value !== "string") vfail("reverse_dns must be a string.", "invalid_reverse_dns", "reverse_dns");
  const v = (value as string).trim();
  if (!v) return "";
  const fail = () =>
    vfail(
      "Enter a valid FQDN for reverse DNS (for example, mail.example.com). Leave blank to clear.",
      "invalid_reverse_dns",
      "reverse_dns",
    );
  if (v.length > 253) fail();
  const host = v.endsWith(".") ? v.slice(0, -1) : v;
  if (!host || /[\s/?#@:\\[\]]/.test(host)) fail();
  let ascii = host;
  if (/[^\x00-\x7f]/.test(host)) {
    try {
      ascii = new URL(`http://${host}`).hostname;
    } catch {
      fail();
    }
  }
  if (ascii.length > 253 || ascii.split(".").some((label) => !HOST_LABEL.test(label))) fail();
  return v;
}

/** How a Reserved IP is attached, classified the way the portal does. */
export type ReservedIpAttachmentKind =
  | "none"
  | "nat_gateway"
  | "vpc_virtual_ip"
  | "direct"
  | "converted_active"
  | "vpc";

/** Classify a Reserved IP's current attachment. */
export function reservedIpAttachmentKind(ip: Record<string, unknown>): ReservedIpAttachmentKind {
  if (!trimStr(ip.attached_resource_id)) return "none";
  const type = trimStr(ip.attached_resource_type);
  if (type === "nat_gateway" || type === "vpc_virtual_ip") return type;
  const allocation = trimStr(ip.attached_allocation_id);
  const network = trimStr(ip.attached_network_id);
  if ((type === "vm" || !type) && network && !allocation && !trimStr(ip.attached_vpc_id)) return "direct";
  if (trimStr(ip.allocation_method) === "converted" && !allocation && !network) return "converted_active";
  return "vpc";
}

/** Message for releasing an attached Reserved IP (portal wording). */
export function reservedIpReleaseBlockMessage(ip: Record<string, unknown>): string | undefined {
  if (!trimStr(ip.attached_resource_id)) return undefined;
  return trimStr(ip.attached_resource_type) === "nat_gateway"
    ? "Change or delete the NAT Gateway before releasing this IP."
    : "Detach this IP before releasing it.";
}

export const RESERVED_IP_TARGET_UNSUPPORTED_MESSAGE =
  "This VM has no VPC attachment. Use reservedIps.convert to keep its current public IP; attaching a held Reserved IP to a non-VPC VM is not yet available in the public API.";

// --------------------------------------------------------------- firewalls

export const FIREWALL_PROTOCOLS = ["tcp", "udp", "icmp", "any"] as const;
export const FIREWALL_DIRECTIONS = ["ingress", "egress"] as const;
export const FIREWALL_ACTIONS = ["allow", "drop"] as const;
export const ANYWHERE_IPV4_CIDR = "0.0.0.0/0";

/**
 * Validate and normalise firewall remote targets: IPv4 address or CIDR
 * (host bits allowed), bare IPs become /32, CIDRs become their network,
 * duplicates are dropped. Empty input returns `["0.0.0.0/0"]`. A string is
 * split on commas (portal input).
 */
export function normaliseRemoteTargets(values: unknown): string[] {
  const list =
    typeof values === "string"
      ? values.split(",")
      : Array.isArray(values)
        ? (values as unknown[])
        : values === undefined || values === null
          ? []
          : vfail("remote_targets must be a list of IPv4 addresses or CIDRs.", "invalid_remote_targets", "remote_targets");
  const out: string[] = [];
  for (const raw of list as unknown[]) {
    const text = String(raw ?? "").trim();
    if (!text) {
      if (typeof values === "string") continue;
      vfail("Remote target cannot be empty.", "invalid_remote_targets", "remote_targets");
    }
    let normalised: string;
    if (text.includes(":")) {
      vfail("Only IPv4 remote targets are supported.", "invalid_remote_targets", "remote_targets");
    }
    if (text.includes("/")) {
      const c = parseIpv4Cidr(text);
      if (!c) vfail(`'${text}' is not a valid IPv4 CIDR.`, "invalid_remote_targets", "remote_targets");
      normalised = `${formatIpv4((c as ParsedIpv4Cidr).start)}/${(c as ParsedIpv4Cidr).prefix}`;
    } else {
      if (parseIpv4(text) === null) vfail(`'${text}' is not a valid IPv4 address.`, "invalid_remote_targets", "remote_targets");
      normalised = `${formatIpv4(parseIpv4(text) as number)}/32`;
    }
    if (!out.includes(normalised)) out.push(normalised);
  }
  if (!out.length) {
    if (typeof values === "string") {
      vfail("Enter at least one CIDR or IP address for the selected source.", "invalid_remote_targets", "remote_targets");
    }
    if (Array.isArray(values) && values.length === 0) {
      vfail("Enter at least one CIDR or IP address for the selected source.", "invalid_remote_targets", "remote_targets");
    }
    return [ANYWHERE_IPV4_CIDR];
  }
  return out;
}

/** Parse the portal port input: `22` or `8000-8080`. */
export function parsePortRange(value: string): { start: number; end: number } {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) vfail("Port is required for TCP and UDP rules.", "invalid_port", "port_start");
  if (!/^\s*\d{1,5}\s*(-\s*\d{1,5}\s*)?$/.test(trimmed)) {
    vfail("Use a single port like 22 or a range like 8000-8080.", "invalid_port", "port_start");
  }
  const [a, b] = trimmed.split("-").map((p) => Number(p.trim()));
  const end = b === undefined ? a : b;
  if (a < 1 || a > 65535 || end < 1 || end > 65535) vfail("Ports must be between 1 and 65535.", "invalid_port", "port_start");
  if (end < a) vfail("Port range end must be greater than or equal to the start.", "invalid_port", "port_end");
  return { start: a, end };
}

export interface FirewallRuleFields {
  description?: string;
  direction?: string;
  protocol?: string;
  portStart?: number;
  portEnd?: number;
  remoteTargets?: string[] | string;
  action?: string;
  priority?: number;
  enabled?: boolean;
}

const oneOf = (value: unknown, allowed: readonly string[], field: string): string => {
  const v = trimStr(value).toLowerCase();
  if (!allowed.includes(v)) vfail(`${field} must be one of ${allowed.join(", ")}.`, `invalid_${field}`, field);
  return v;
};

/**
 * Validate a firewall rule and build the create (or PATCH, `update: true`)
 * body. TCP/UDP need `portStart` (1..65535) and `portEnd` defaults to it;
 * ICMP/any take no ports; remote targets are normalised (create defaults to
 * `0.0.0.0/0`).
 */
export function buildFirewallRuleBody(args: FirewallRuleFields, opts: { update?: boolean } = {}): Record<string, unknown> {
  const update = Boolean(opts.update);
  const body: Record<string, unknown> = {};
  let protocol: string | undefined;
  if (args.protocol !== undefined && args.protocol !== null) {
    const p = trimStr(args.protocol).toLowerCase();
    if (p === "gre" || p === "esp" || p === "ah") {
      vfail("The current firewall API supports Any, TCP, UDP, and ICMP rules only.", "invalid_protocol", "protocol");
    }
    protocol = oneOf(p, FIREWALL_PROTOCOLS, "protocol");
    body.protocol = protocol;
  } else if (!update) {
    protocol = "tcp";
  }
  const hasStart = args.portStart !== undefined && args.portStart !== null;
  const hasEnd = args.portEnd !== undefined && args.portEnd !== null;
  const portOk = (v: unknown, field: string) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
      vfail("Port must be between 1 and 65535.", "invalid_port", field);
    }
    return v as number;
  };
  if (protocol === "icmp" || protocol === "any") {
    if (hasStart || hasEnd) vfail("Ports apply only to TCP and UDP rules.", "invalid_port", "port_start");
  } else {
    if ((protocol === "tcp" || protocol === "udp") && !hasStart) {
      vfail("Port is required for TCP and UDP rules.", "invalid_port", "port_start");
    }
    if (hasStart) body.port_start = portOk(args.portStart, "port_start");
    if (hasEnd) body.port_end = portOk(args.portEnd, "port_end");
    else if (hasStart && protocol) body.port_end = body.port_start;
    if (body.port_start !== undefined && body.port_end !== undefined && (body.port_end as number) < (body.port_start as number)) {
      vfail("Port range end must be greater than or equal to the start.", "invalid_port", "port_end");
    }
  }
  if (args.remoteTargets !== undefined && args.remoteTargets !== null) {
    body.remote_targets = normaliseRemoteTargets(args.remoteTargets);
  } else if (!update) {
    body.remote_targets = [ANYWHERE_IPV4_CIDR];
  }
  if (args.direction !== undefined && args.direction !== null) body.direction = oneOf(args.direction, FIREWALL_DIRECTIONS, "direction");
  else if (!update) body.direction = "ingress";
  if (args.action !== undefined && args.action !== null) body.action = oneOf(args.action, FIREWALL_ACTIONS, "action");
  else if (!update) body.action = "allow";
  if (args.description !== undefined && args.description !== null) {
    const d = validateOptionalText(args.description, "description", Number.MAX_SAFE_INTEGER);
    if (d) body.description = d;
  }
  if (args.priority !== undefined && args.priority !== null) {
    if (!isInt(args.priority)) vfail("priority must be an integer.", "invalid_priority", "priority");
    body.priority = args.priority;
  }
  if (update && args.enabled !== undefined && args.enabled !== null) {
    if (typeof args.enabled !== "boolean") vfail("enabled must be a boolean.", "invalid_enabled", "enabled");
    body.enabled = args.enabled;
  }
  if (!update) body.protocol = protocol;
  if (update) requireAtLeastOneField(body, "At least one firewall rule field must be provided.");
  return body;
}

// ---------------------------------------------------------- load balancers

export const LB_STATUSES = ["provisioning", "active", "failed", "deleting", "deleted"] as const;
export const LB_ALGORITHMS = ["round_robin", "least_request", "random", "consistent_hash"] as const;
export const LB_BACKEND_TYPES = ["service", "ip", "hostname"] as const;
export const LB_HEALTH_CHECK_TYPES = ["http", "https", "tcp"] as const;
export const LB_PROTOCOLS_BY_LAYER = {
  l4: ["tcp", "tls_passthrough"],
  l7: ["http", "https"],
} as const;
export const LB_DEFAULT_RETRY_ON = ["5xx", "reset", "connect-failure"] as const;

const isIpv6 = (v: string): boolean => {
  if (!v.includes(":")) return false;
  try {
    new URL(`http://[${v}]`);
    return true;
  } catch {
    return false;
  }
};

function intIn(value: unknown, field: string, min: number, max: number): number {
  if (!isInt(value) || (value as number) < min || (value as number) > max) {
    vfail(`${field} must be an integer between ${min} and ${max}.`, `invalid_${field.replace(/\W+/g, "_")}`, field);
  }
  return value as number;
}

/** Validate one load-balancer backend and return the normalised item. */
export function validateLbBackend(item: unknown, field = "backends"): Record<string, unknown> {
  if (!isRec(item)) vfail(`Each ${field} item must be an object.`, "invalid_backend", field);
  const b = item as Record<string, unknown>;
  const type = b.type === undefined || b.type === null ? "service" : oneOf(b.type, LB_BACKEND_TYPES, "type");
  const target = trimStr(b.target);
  if (!target) vfail("Each backend target is required.", "invalid_backend", `${field}.target`);
  if (type === "ip" && parseIpv4(target) === null && !isIpv6(target)) {
    vfail("IP backends must use a valid IPv4 or IPv6 address.", "invalid_backend", `${field}.target`);
  }
  if (type === "hostname" && (!target.includes(".") || target.startsWith(".") || target.endsWith("."))) {
    vfail("Hostname backends must use a valid fully qualified hostname.", "invalid_backend", `${field}.target`);
  }
  if (type === "service" && (target.includes("/") || target.includes(":"))) {
    vfail("Service backends must use a Kubernetes service name without a slash or port.", "invalid_backend", `${field}.target`);
  }
  const out: Record<string, unknown> = { ...(b.type === undefined ? {} : { type }), target, port: intIn(b.port, `${field}.port`, 1, 65535) };
  if (b.weight !== undefined && b.weight !== null) out.weight = intIn(b.weight, `${field}.weight`, 1, 1000);
  if (b.tls !== undefined && b.tls !== null) {
    if (typeof b.tls !== "boolean") vfail("backend tls must be a boolean.", "invalid_backend", `${field}.tls`);
    out.tls = b.tls;
  }
  return out;
}

function validateLbBackends(list: unknown, field = "backends"): Record<string, unknown>[] {
  if (!Array.isArray(list) || list.length === 0) vfail("Add at least one backend.", "invalid_backend", field);
  return (list as unknown[]).map((b) => validateLbBackend(b, field));
}

function validateLbRouting(routing: unknown, layer: "l4" | "l7"): Record<string, unknown> {
  if (!isRec(routing)) vfail("routing must be an object.", "invalid_routing", "routing");
  const r = routing as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (r.algorithm !== undefined && r.algorithm !== null) out.algorithm = oneOf(r.algorithm, LB_ALGORITHMS, "algorithm");
  if (r.sticky_header !== undefined && r.sticky_header !== null) {
    if (layer === "l4") vfail("Sticky sessions are only available for L7 load balancers.", "invalid_routing", "routing.sticky_header");
    const h = trimStr(r.sticky_header);
    if (!h) vfail("Sticky header name is required.", "invalid_routing", "routing.sticky_header");
    out.sticky_header = h;
  }
  return out;
}

function validateLbPolicy(policy: unknown): Record<string, unknown> {
  if (!isRec(policy)) vfail("policy must be an object.", "invalid_policy", "policy");
  const p = policy as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!["timeout_ms", "retries", "proxy_protocol_enabled"].includes(key)) {
      vfail(`policy.${key} is not supported.`, "invalid_policy", `policy.${key}`);
    }
  }
  const out: Record<string, unknown> = {};
  if (p.timeout_ms !== undefined && p.timeout_ms !== null) out.timeout_ms = intIn(p.timeout_ms, "policy.timeout_ms", 100, 300_000);
  if (p.proxy_protocol_enabled !== undefined && p.proxy_protocol_enabled !== null) {
    if (typeof p.proxy_protocol_enabled !== "boolean") vfail("policy.proxy_protocol_enabled must be a boolean.", "invalid_policy", "policy.proxy_protocol_enabled");
    out.proxy_protocol_enabled = p.proxy_protocol_enabled;
  }
  if (p.retries !== undefined && p.retries !== null) {
    if (!isRec(p.retries)) vfail("policy.retries must be an object.", "invalid_policy", "policy.retries");
    const r = p.retries as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (!["attempts", "on", "per_retry_timeout_ms"].includes(key)) {
        vfail(`policy.retries.${key} is not supported.`, "invalid_policy", `policy.retries.${key}`);
      }
    }
    const retries: Record<string, unknown> = {};
    if (r.attempts !== undefined && r.attempts !== null) retries.attempts = intIn(r.attempts, "policy.retries.attempts", 1, 10);
    if (r.per_retry_timeout_ms !== undefined && r.per_retry_timeout_ms !== null) {
      retries.per_retry_timeout_ms = intIn(r.per_retry_timeout_ms, "policy.retries.per_retry_timeout_ms", 100, 120_000);
    }
    if (r.on !== undefined && r.on !== null) {
      if (!Array.isArray(r.on) || r.on.length === 0 || r.on.some((x) => !trimStr(x))) {
        vfail("policy.retries.on must be a non-empty list of retry conditions.", "invalid_policy", "policy.retries.on");
      }
      retries.on = (r.on as unknown[]).map((x) => trimStr(x));
    }
    out.retries = retries;
  }
  return out;
}

function validateLbHealthCheck(hc: unknown): Record<string, unknown> {
  if (!isRec(hc)) vfail("health_check must be an object.", "invalid_health_check", "health_check");
  const h = hc as Record<string, unknown>;
  const out: Record<string, unknown> = { ...h };
  if (h.active !== undefined && h.active !== null) {
    if (!isRec(h.active)) vfail("health_check.active must be an object.", "invalid_health_check", "health_check.active");
    const a = { ...(h.active as Record<string, unknown>) };
    const type = a.type === undefined || a.type === null ? "http" : oneOf(a.type, LB_HEALTH_CHECK_TYPES, "type");
    if (a.type !== undefined && a.type !== null) a.type = type;
    if (a.path !== undefined && a.path !== null) {
      const path = trimStr(a.path);
      if (type === "tcp" && path) vfail("path is not supported for tcp active health checks.", "invalid_health_check", "health_check.active.path");
      if (path) a.path = path;
      else delete a.path;
    }
    if (a.interval_ms !== undefined && a.interval_ms !== null) intIn(a.interval_ms, "health_check.active.interval_ms", 100, 120_000);
    if (a.timeout_ms !== undefined && a.timeout_ms !== null) intIn(a.timeout_ms, "health_check.active.timeout_ms", 100, 120_000);
    if (a.healthy_threshold !== undefined && a.healthy_threshold !== null) intIn(a.healthy_threshold, "health_check.active.healthy_threshold", 1, 20);
    if (a.unhealthy_threshold !== undefined && a.unhealthy_threshold !== null) intIn(a.unhealthy_threshold, "health_check.active.unhealthy_threshold", 1, 20);
    out.active = a;
  }
  if (h.passive !== undefined && h.passive !== null) {
    if (!isRec(h.passive)) vfail("health_check.passive must be an object.", "invalid_health_check", "health_check.passive");
    const p = h.passive as Record<string, unknown>;
    if (p.enabled !== undefined && p.enabled !== null && typeof p.enabled !== "boolean") {
      vfail("health_check.passive.enabled must be a boolean.", "invalid_health_check", "health_check.passive.enabled");
    }
    if (p.consecutive_5xx !== undefined && p.consecutive_5xx !== null) intIn(p.consecutive_5xx, "health_check.passive.consecutive_5xx", 1, 100);
    if (p.interval_ms !== undefined && p.interval_ms !== null) intIn(p.interval_ms, "health_check.passive.interval_ms", 100, 120_000);
    if (p.base_ejection_time_ms !== undefined && p.base_ejection_time_ms !== null) {
      intIn(p.base_ejection_time_ms, "health_check.passive.base_ejection_time_ms", 1000, 600_000);
    }
  }
  return out;
}

function validateLbTls(tls: unknown, mode: "terminate" | "passthrough"): Record<string, unknown> {
  if (!isRec(tls)) vfail("tls must be an object.", "invalid_tls", "tls");
  const t = tls as Record<string, unknown>;
  if (t.cert_pem !== undefined || t.key_pem !== undefined ||
    (t.certificate_source !== undefined && t.certificate_source !== null && trimStr(t.certificate_source) !== "managed")) {
    vfail("Custom certificates are not supported; use certificate_source=managed.", "invalid_tls", "tls.certificate_source");
  }
  const m = trimStr(t.mode) || mode;
  if (m !== mode) vfail(`This load balancer requires tls.mode=${mode}.`, "invalid_tls", "tls.mode");
  return { mode, certificate_source: "managed" };
}

/** Default TLS block for a protocol (managed certificate), or undefined. */
export function defaultLbTls(protocol: string): { mode: "terminate" | "passthrough"; certificate_source: "managed" } | undefined {
  if (protocol === "https") return { mode: "terminate", certificate_source: "managed" };
  if (protocol === "tls_passthrough") return { mode: "passthrough", certificate_source: "managed" };
  return undefined;
}

/** Normalise an L7 custom domain hostname (lower-case, no trailing dot). */
export function normaliseCustomDomainHostname(hostname: unknown): string {
  const h = trimStr(hostname).toLowerCase().replace(/\.+$/, "");
  if (!h || h.length > 253 || !h.includes(".") || h.startsWith(".")) {
    vfail("custom_domain.hostname must be a valid fully qualified domain name.", "invalid_custom_domain", "custom_domain.hostname");
  }
  return h;
}

function validateLbRules(rules: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rules)) vfail("rules must be a list.", "invalid_rules", "rules");
  return (rules as unknown[]).map((rule) => {
    if (!isRec(rule)) vfail("Each rule must be an object.", "invalid_rules", "rules");
    const r = rule as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (r.priority !== undefined && r.priority !== null) {
      if (!isInt(r.priority) || (r.priority as number) < 1) {
        vfail("Each L7 rule priority must be a positive number.", "invalid_rules", "rules.priority");
      }
      out.priority = r.priority;
    }
    if (r.path_prefix !== undefined && r.path_prefix !== null) {
      const p = trimStr(r.path_prefix) || "/";
      if (!p.startsWith("/")) vfail("Each rule path_prefix must start with '/'.", "invalid_rules", "rules.path_prefix");
      out.path_prefix = p;
    }
    if (r.headers !== undefined && r.headers !== null) {
      if (!isRec(r.headers)) vfail("rule headers must be an object.", "invalid_rules", "rules.headers");
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
        const name = k.trim();
        const value = trimStr(v);
        if (!name || !value) vfail("Each rule header needs a name and a value.", "invalid_rules", "rules.headers");
        headers[name] = value;
      }
      out.headers = headers;
    }
    if (r.backends !== undefined && r.backends !== null) out.backends = validateLbBackends(r.backends, "rules.backends");
    return out;
  });
}

export interface LoadBalancerBodyInput {
  name?: string;
  protocol?: string;
  backends?: unknown[];
  routing?: object;
  policy?: object;
  healthCheck?: object;
  tls?: object;
  observability?: { logs_enabled?: boolean };
  customDomain?: { hostname: string } | null;
  rules?: unknown[];
}

/**
 * Validate and build an L4/L7 create or update body with the portal's
 * defaults (managed TLS for https/tls_passthrough). Health checks are never
 * injected.
 */
export function buildLoadBalancerBody(
  layer: "l4" | "l7",
  mode: "create" | "update",
  args: LoadBalancerBodyInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const create = mode === "create";
  if (create || (args.name !== undefined && args.name !== null)) {
    body.name = validateResourceName(args.name, "name", 128, "Name");
  }
  let protocol: string | undefined;
  if (create) {
    protocol = trimStr(args.protocol).toLowerCase();
    const allowed = LB_PROTOCOLS_BY_LAYER[layer] as readonly string[];
    if (!allowed.includes(protocol)) {
      vfail(`${layer.toUpperCase()} load balancers support ${allowed.join(" or ")}.`, "invalid_protocol", "protocol");
    }
    body.protocol = protocol;
  }
  if (create || (args.backends !== undefined && args.backends !== null)) body.backends = validateLbBackends(args.backends);
  if (args.routing !== undefined && args.routing !== null) body.routing = validateLbRouting(args.routing, layer);
  if (args.policy !== undefined && args.policy !== null) body.policy = validateLbPolicy(args.policy);
  if (args.healthCheck !== undefined && args.healthCheck !== null) body.health_check = validateLbHealthCheck(args.healthCheck);
  if (args.observability !== undefined && args.observability !== null) {
    if (!isRec(args.observability) || (args.observability.logs_enabled !== undefined && typeof args.observability.logs_enabled !== "boolean")) {
      vfail("observability.logs_enabled must be a boolean.", "invalid_observability", "observability");
    }
    body.observability = { ...(args.observability.logs_enabled === undefined ? {} : { logs_enabled: args.observability.logs_enabled }) };
  }
  const tlsMode = layer === "l4" ? "passthrough" : "terminate";
  if (create) {
    const needsTls = protocol === "https" || protocol === "tls_passthrough";
    if (!needsTls && args.tls !== undefined && args.tls !== null) {
      vfail(`tls is not supported for ${protocol} load balancers.`, "invalid_tls", "tls");
    }
    if (needsTls) body.tls = args.tls ? validateLbTls(args.tls, tlsMode) : defaultLbTls(protocol as string);
  } else if (args.tls !== undefined && args.tls !== null) {
    body.tls = validateLbTls(args.tls, tlsMode);
  }
  if (layer === "l4") {
    if (args.customDomain !== undefined || args.rules !== undefined) {
      vfail("custom_domain and rules are only supported for L7 load balancers.", "invalid_l4_field", args.rules !== undefined ? "rules" : "custom_domain");
    }
  } else {
    if (args.rules !== undefined && args.rules !== null) body.rules = validateLbRules(args.rules);
    if (args.customDomain === null && !create) body.custom_domain = null;
    else if (args.customDomain !== undefined && args.customDomain !== null) {
      if (create && protocol !== "https") {
        vfail("custom_domain is only supported for l7 https load balancers.", "invalid_custom_domain", "custom_domain");
      }
      if (!isRec(args.customDomain)) vfail("custom_domain must be an object with a hostname.", "invalid_custom_domain", "custom_domain");
      body.custom_domain = { hostname: normaliseCustomDomainHostname(args.customDomain.hostname) };
    }
  }
  if (!create) requireAtLeastOneField(body, "At least one load balancer field must be provided.");
  return body;
}

/** Validate load-balancer list filters and build the query. */
export function loadBalancerListQuery(args: {
  status?: string;
  layer?: string;
  protocol?: string;
  includeDeleted?: boolean;
  limit?: number;
  skip?: number;
}): Record<string, string | number | boolean | undefined> {
  const status = args.status === undefined || args.status === null ? undefined : oneOf(args.status, LB_STATUSES, "status");
  const layer = args.layer === undefined || args.layer === null ? undefined : oneOf(args.layer, ["l4", "l7"], "layer");
  const protocol =
    args.protocol === undefined || args.protocol === null
      ? undefined
      : oneOf(args.protocol, ["http", "https", "tcp", "tls_passthrough"], "protocol");
  if (layer && protocol && !(LB_PROTOCOLS_BY_LAYER[layer as "l4" | "l7"] as readonly string[]).includes(protocol)) {
    vfail(`protocol ${protocol} is not valid for layer ${layer}.`, "invalid_protocol", "protocol");
  }
  if (args.limit !== undefined) validateIntRange(args.limit, "limit", 1, 500);
  if (args.skip !== undefined && (!isInt(args.skip) || args.skip < 0)) vfail("skip must be an integer >= 0.", "invalid_skip", "skip");
  const includeDeleted = status === "deleted" ? true : args.includeDeleted;
  return { status, layer, protocol, include_deleted: includeDeleted, limit: args.limit, skip: args.skip };
}

// ======================================================================
// Storage: Block Storage volumes, Object Storage buckets and S3
// credentials, CDN distributions (portal parity). All throw
// IbeeValidationError.
// ======================================================================

/** Exact-case enum check (trims strings). */
const enumOf = <T extends string>(value: unknown, allowed: readonly T[], field: string, code = `invalid_${field}`): T => {
  const v = trimStr(value);
  if (!(allowed as readonly string[]).includes(v)) vfail(`${field} must be one of ${allowed.join(", ")}.`, code, field);
  return v as T;
};

const optionalBool = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") vfail(`${field} must be a boolean.`, `invalid_${field}`, field);
  return value as boolean;
};

/** Integer that is not a boolean (fractional values are rejected, never rounded). */
const requireInt = (value: unknown, field: string, min: number, max: number, message?: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    vfail(message ?? `${field} must be an integer between ${min} and ${max}.`, `invalid_${field}`, field);
  }
  return value as number;
};

// ----------------------------------------------------------- block storage

/** Block volume IDs are 24-character hex document IDs. */
export const BLOCK_VOLUME_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
/** Volume names: 3..255 lower-case letters, digits and hyphens (portal rule). */
export const BLOCK_VOLUME_NAME_PATTERN = /^[a-z0-9-]{3,255}$/;
/** Portal floor for a new volume (the backend allows 1). */
export const BLOCK_VOLUME_MIN_SIZE_GB = 10;
/** Backend ceiling for a volume. */
export const BLOCK_VOLUME_MAX_SIZE_GB = 10_000;
export const BLOCK_VOLUME_CLASSES = ["capacity", "balanced", "performance"] as const;
export const BLOCK_VOLUME_VM_TYPES = ["cloud", "gpu"] as const;
export const BLOCK_VOLUME_VM_STATES = ["running", "stopped", "suspended"] as const;
export const BLOCK_VOLUME_ATTACH_MODES = ["single-writer", "multi-writer"] as const;
/** States in which the backend refuses delete and resize. */
export const BLOCK_VOLUME_TRANSIENT_STATES: ReadonlySet<string> = new Set([
  "creating",
  "attaching",
  "detaching",
  "resizing",
  "deleting",
]);
/** Fields the public create must never carry (server-managed or internal). */
export const BLOCK_VOLUME_FORBIDDEN_CREATE_FIELDS = [
  "volume_kind",
  "attach_to_node",
  "attached_vm_id",
  "attached_vm_name",
  "attachment_mode",
  "is_block_storage",
  "billing_catalog",
  "storage_performance",
  "iops_limit",
  "throughput_mibps",
] as const;

export type BlockVolumeVmType = (typeof BLOCK_VOLUME_VM_TYPES)[number];

/** Validate a block volume ID (24 hex characters) and return it trimmed. */
export function validateBlockVolumeId(value: unknown, field = "volume_id"): string {
  const id = trimStr(value);
  if (!BLOCK_VOLUME_ID_PATTERN.test(id)) {
    vfail(`${field} must be a 24-character hexadecimal volume ID.`, "invalid_volume_id", field);
  }
  return id;
}

/**
 * Portal volume-name rule. Returns the trimmed name; never renames. The error
 * suggests the name the portal's input would have produced.
 */
export function validateBlockVolumeName(name: unknown): string {
  const s = trimStr(name);
  if (!s) vfail("Enter a volume name to continue", "invalid_volume_name", "name");
  if (s.length < 3) vfail("Volume name must be at least 3 characters", "invalid_volume_name", "name");
  if (!BLOCK_VOLUME_NAME_PATTERN.test(s)) {
    const suggestion = s.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    vfail(
      `Lowercase letters, numbers, and hyphens only (try '${suggestion.slice(0, 255)}')`,
      "invalid_volume_name",
      "name",
      { suggestion: suggestion.slice(0, 255) },
    );
  }
  return s;
}

/** Validate a new volume size: an integer from 10 to 10000 GB. */
export function validateBlockVolumeCreateSize(sizeGb: unknown): number {
  return requireInt(
    sizeGb,
    "size_gb",
    BLOCK_VOLUME_MIN_SIZE_GB,
    BLOCK_VOLUME_MAX_SIZE_GB,
    `size_gb must be a whole number from ${BLOCK_VOLUME_MIN_SIZE_GB} to ${BLOCK_VOLUME_MAX_SIZE_GB} GB.`,
  );
}

/** Validate an optional `vm_type` (`cloud` or `gpu`). */
export function validateVolumeVmType(value: unknown, field = "vm_type"): BlockVolumeVmType | undefined {
  if (value === undefined || value === null) return undefined;
  return enumOf(value, BLOCK_VOLUME_VM_TYPES, field, "invalid_vm_type");
}

/** Validate an optional `vm_state` (`running`, `stopped` or `suspended`). */
export function validateVolumeVmState(value: unknown, field = "vm_state"): string | undefined {
  if (value === undefined || value === null) return undefined;
  return enumOf(value, BLOCK_VOLUME_VM_STATES, field, "invalid_vm_state");
}

/** Validate an optional attach `mode` (default `single-writer`). */
export function validateAttachMode(value: unknown): (typeof BLOCK_VOLUME_ATTACH_MODES)[number] {
  if (value === undefined || value === null) return "single-writer";
  return enumOf(value, BLOCK_VOLUME_ATTACH_MODES, "mode", "invalid_mode");
}

/** Validate an optional SKU code: trimmed, non-empty, upper-cased, not ROOTDISK-*. */
export function validateVolumeSkuCode(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) vfail("sku_code cannot be blank.", "invalid_sku_code", "sku_code");
  const code = (value as string).trim().toUpperCase();
  if (code.startsWith("ROOTDISK-")) {
    vfail("VM root disk is included in the VM plan and must not have a separate SKU", "invalid_sku_code", "sku_code");
  }
  return code;
}

export interface BlockVolumeCreateInput {
  name: unknown;
  size_gb: unknown;
  site_id: unknown;
  site_name?: unknown;
  sku_code?: unknown;
  volume_class?: unknown;
  replica_count?: unknown;
  backup_enabled?: unknown;
  vm_type?: unknown;
  delete_on_termination?: unknown;
  [key: string]: unknown;
}

/**
 * Validate a volume create and build the public body (without the
 * idempotency key). Server-managed fields (volume_kind, billing_*, storage
 * performance, attachment fields) are refused.
 */
export function buildBlockVolumeCreateBody(input: BlockVolumeCreateInput): Record<string, unknown> {
  if (!isRec(input)) vfail("request must be an object.", "invalid_request");
  for (const key of Object.keys(input)) {
    if (
      input[key] !== undefined &&
      ((BLOCK_VOLUME_FORBIDDEN_CREATE_FIELDS as readonly string[]).includes(key) || key.startsWith("billing_"))
    ) {
      vfail(`${key} is set by the server and cannot be sent on a volume create.`, "forbidden_field", key);
    }
  }
  const body: Record<string, unknown> = {
    name: validateBlockVolumeName(input.name),
    size_gb: validateBlockVolumeCreateSize(input.size_gb),
  };
  const siteId = trimStr(input.site_id);
  if (!siteId) vfail("Please select a location", "invalid_site_id", "site_id");
  body.site_id = siteId;
  if (input.site_name !== undefined && input.site_name !== null) {
    const siteName = trimStr(input.site_name);
    if (siteName) body.site_name = siteName;
  }
  const sku = validateVolumeSkuCode(input.sku_code);
  if (sku !== undefined) body.sku_code = sku;
  if (input.volume_class !== undefined && input.volume_class !== null) {
    body.volume_class = enumOf(input.volume_class, BLOCK_VOLUME_CLASSES, "volume_class");
  }
  if (input.replica_count !== undefined && input.replica_count !== null) {
    body.replica_count = requireInt(input.replica_count, "replica_count", 1, 5);
  }
  const backup = optionalBool(input.backup_enabled, "backup_enabled");
  if (backup !== undefined) body.backup_enabled = backup;
  const vmType = validateVolumeVmType(input.vm_type);
  if (vmType !== undefined) body.vm_type = vmType;
  const dot = optionalBool(input.delete_on_termination, "delete_on_termination");
  if (dot !== undefined) body.delete_on_termination = dot;
  return body;
}

/** Validate block-volume list filters and build the query. */
export function blockVolumeListQuery(args: {
  siteId?: string;
  vmType?: string;
  limit?: number;
  offset?: number;
}): Record<string, string | number | undefined> {
  let siteId: string | undefined;
  if (args.siteId !== undefined && args.siteId !== null) {
    siteId = trimStr(args.siteId);
    if (!siteId) vfail("siteId cannot be blank.", "invalid_site_id", "site_id");
  }
  validateLimitOffset(args, 1000);
  return {
    site_id: siteId,
    vm_type: validateVolumeVmType(args.vmType),
    limit: args.limit,
    offset: args.offset,
  };
}

interface VolumeLike {
  id?: unknown;
  name?: unknown;
  state?: unknown;
  site_id?: unknown;
  site_name?: unknown;
  vm_type?: unknown;
  size_gb?: unknown;
  attachments?: unknown;
}

const attachmentsOf = (vol: VolumeLike | null | undefined): Array<Record<string, unknown>> =>
  Array.isArray(vol?.attachments) ? (vol!.attachments as unknown[]).filter(isRec) : [];

/** The volume's VM type (`cloud` for legacy rows without one). */
export function volumeVmType(vol: VolumeLike | null | undefined): BlockVolumeVmType {
  return String(vol?.vm_type ?? "").trim().toLowerCase() === "gpu" ? "gpu" : "cloud";
}

/** Refuse a delete/resize while the volume is in a transient state. */
export function assertVolumeNotTransient(vol: VolumeLike | null | undefined, action: "delete" | "resize"): void {
  const state = String(vol?.state ?? "").trim().toLowerCase();
  if (BLOCK_VOLUME_TRANSIENT_STATES.has(state)) {
    vfail(`Volume is currently '${state}'. Retry ${action} once workflow completes.`, "volume_busy", "volume_id");
  }
}

/**
 * Portal and backend attach guards: the volume is unattached, was created
 * for the target VM type, and (when the VM is known) is in the VM's site.
 */
export function assertVolumeAttachable(
  vol: VolumeLike,
  targetVmType: BlockVolumeVmType,
  vm?: { site_id?: unknown } | null,
): void {
  if (attachmentsOf(vol).length > 0) {
    vfail("Volume is already attached; detach it first", "volume_attached", "volume_id");
  }
  const volType = volumeVmType(vol);
  if (volType !== targetVmType) {
    vfail(
      `Volume was created for ${volType} VMs and cannot attach to a ${targetVmType} VM`,
      "vm_type_mismatch",
      "vm_type",
    );
  }
  const volSite = trimStr(vol.site_id);
  const vmSite = trimStr(vm?.site_id);
  if (vm && volSite && vmSite && volSite !== vmSite) {
    vfail(`Select a server in ${trimStr(vol.site_name) || volSite}`, "site_mismatch", "vm_id");
  }
}

/**
 * Pick the attachment for a detach. With `vmId`/`nodeName` the matching
 * attachment is required; otherwise the volume must have exactly one.
 * `forVm` also requires the attachment to carry a VM ID.
 */
export function resolveSingleAttachment(
  vol: VolumeLike,
  opts: { vmId?: string; nodeName?: string; forVm?: boolean } = {},
): Record<string, unknown> {
  const atts = attachmentsOf(vol);
  if (atts.length === 0) vfail("Volume is not attached to any server", "volume_not_attached", "volume_id");
  let chosen: Record<string, unknown> | undefined;
  if (opts.vmId) {
    chosen = atts.find((a) => String(a.vm_id ?? "") === opts.vmId);
    if (!chosen) vfail(`Volume is not attached to VM ${opts.vmId}`, "volume_not_attached", "vm_id");
  } else if (opts.nodeName) {
    chosen = atts.find((a) => String(a.node_name ?? "") === opts.nodeName);
    if (!chosen) vfail("Volume is not attached to the requested node", "volume_not_attached", "node_name");
  } else if (atts.length === 1) {
    chosen = atts[0];
  } else {
    vfail(
      opts.forVm ? "Volume is attached to several VMs; pass vmId" : "Volume is attached to several targets; pass vm_id/node_name",
      "ambiguous_attachment",
      opts.forVm ? "vm_id" : "node_name",
    );
  }
  if (opts.forVm && !trimStr(chosen!.vm_id)) {
    vfail(
      "This attachment has no VM ID; use detachVolume with node_name",
      "attachment_without_vm",
      "vm_id",
    );
  }
  return chosen!;
}

/** Node-level safe detach: force, confirm_unmounted, or a stopped/suspended VM. */
export function validateNodeSafeDetach(req: { force?: unknown; confirm_unmounted?: unknown; vm_state?: unknown }): void {
  const state = trimStr(req.vm_state);
  if (req.force !== true && req.confirm_unmounted !== true && state !== "stopped" && state !== "suspended") {
    vfail(
      "Safe detach requires VM state or explicit unmount confirmation.",
      "detach_not_confirmed",
      "confirm_unmounted",
    );
  }
}

/** Resize is increase-only; an attached volume needs a stopped VM or allow_online. */
export function validateVolumeResize(
  req: { new_size_gb?: unknown; vm_state?: unknown; allow_online?: unknown },
  vol?: VolumeLike | null,
): void {
  const size = requireInt(req.new_size_gb, "new_size_gb", 1, BLOCK_VOLUME_MAX_SIZE_GB);
  validateVolumeVmState(req.vm_state);
  optionalBool(req.allow_online, "allow_online");
  if (!vol) return;
  const current = Number(vol.size_gb);
  if (Number.isFinite(current) && size < current) {
    vfail("Shrink is not supported. Resize is increase-only.", "resize_shrink", "new_size_gb");
  }
  const state = trimStr(req.vm_state);
  if (attachmentsOf(vol).length > 0 && req.allow_online !== true && state !== "stopped" && state !== "suspended") {
    vfail(
      "Attached volume resize requires vm_state=stopped/suspended or allow_online=true.",
      "resize_attached",
      "allow_online",
    );
  }
}

// ----------------------------------------------------------- object storage

export const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const BUCKET_RETENTION_MODES = ["GOVERNANCE", "COMPLIANCE"] as const;
/** Region used when `region` is omitted, by API host (the portal's server default). */
export const OBJECT_STORAGE_DEFAULT_REGIONS: Readonly<Record<string, string>> = Object.freeze({
  "api.ibee.ai": "in-south-1",
  "api.ibee.co.in": "in-south-2",
});
export const S3_PERMISSION_TYPES = ["admin_rw", "admin_ro", "object_rw", "object_ro"] as const;
export const S3_BUCKET_SCOPES = ["all", "specific"] as const;
export type S3PermissionType = (typeof S3_PERMISSION_TYPES)[number];
export type S3BucketScope = (typeof S3_BUCKET_SCOPES)[number];

/** Portal bucket-name rule for create. Returns the trimmed name; uppercase is rejected. */
export function validateBucketName(name: unknown): string {
  const n = trimStr(name);
  if (n.length < 3) vfail("Bucket name must be at least 3 characters", "invalid_bucket_name", "name");
  if (n.length > 63) vfail("Bucket name must be less than 63 characters", "invalid_bucket_name", "name");
  if (!BUCKET_NAME_PATTERN.test(n)) {
    vfail(
      "Bucket name must start and end with a letter or number, and contain only lowercase letters, numbers, and hyphens",
      "invalid_bucket_name",
      "name",
    );
  }
  return n;
}

/** A bucket name used in a path: non-blank (legacy names are not re-checked). */
export function validateBucketPathName(name: unknown, field = "bucket_name"): string {
  const n = trimStr(name);
  if (!n) vfail(`${field} is required.`, "invalid_bucket_name", field);
  return n;
}

/**
 * The bucket region: an explicit value (trimmed) or the default for the
 * client's API host (production `in-south-1`, development `in-south-2`).
 */
export function resolveObjectStorageRegion(region: unknown, baseUrl: string): string {
  if (region !== undefined && region !== null) {
    const r = trimStr(region);
    if (!r) vfail("region cannot be blank.", "invalid_region", "region");
    return r;
  }
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const def = OBJECT_STORAGE_DEFAULT_REGIONS[host];
  if (!def) vfail("region is required for this base URL", "region_required", "region");
  return def;
}

export interface BucketCreateInput {
  name: unknown;
  region: string;
  isPublic?: unknown;
  objectLockEnabled?: unknown;
  defaultRetention?: unknown;
  tags?: unknown;
}

/**
 * Validate a bucket create (name, retention and object-lock combination) and
 * build the body. A default retention turns object lock on when it was not
 * set; an explicit `objectLockEnabled: false` with a retention is refused.
 */
export function buildBucketCreateBody(input: BucketCreateInput): Record<string, unknown> {
  const body: Record<string, unknown> = { name: validateBucketName(input.name), region: input.region };
  const isPublic = optionalBool(input.isPublic, "is_public");
  if (isPublic !== undefined) body.is_public = isPublic;
  let lock = optionalBool(input.objectLockEnabled, "object_lock_enabled");
  if (input.defaultRetention !== undefined && input.defaultRetention !== null) {
    const r = input.defaultRetention;
    if (!isRec(r)) vfail("default_retention must be an object.", "invalid_default_retention", "default_retention");
    const rec = r as Record<string, unknown>;
    const mode = enumOf(rec.mode, BUCKET_RETENTION_MODES, "default_retention.mode", "invalid_default_retention");
    const hasDays = rec.days !== undefined && rec.days !== null;
    const hasYears = rec.years !== undefined && rec.years !== null;
    if (hasDays === hasYears) {
      vfail("default_retention needs exactly one of days or years.", "invalid_default_retention", "default_retention");
    }
    const retention: Record<string, unknown> = { mode };
    if (hasDays) retention.days = requireInt(rec.days, "default_retention.days", 1, 36_500);
    else retention.years = requireInt(rec.years, "default_retention.years", 1, 100);
    if (lock === false) {
      vfail(
        "object_lock_enabled must be true when default_retention is specified",
        "invalid_default_retention",
        "object_lock_enabled",
      );
    }
    lock = true;
    body.default_retention = retention;
  }
  if (lock !== undefined) body.object_lock_enabled = lock;
  if (input.tags !== undefined && input.tags !== null) {
    if (!Array.isArray(input.tags) || input.tags.some((t) => typeof t !== "string")) {
      vfail("tags must be an array of strings.", "invalid_tags", "tags");
    }
    body.tags = input.tags;
  }
  return body;
}

/** Portal pre-checks before deleting a bucket. */
export function assertBucketDeletable(
  bucket: { bucket_lock_enabled?: unknown; object_lock_enabled?: unknown; object_count?: unknown } | null | undefined,
  opts: { skipPreflight?: boolean } = {},
): void {
  if (bucket?.bucket_lock_enabled === true || bucket?.object_lock_enabled === true) {
    vfail("Bucket cannot be deleted because Object Lock is enabled.", "bucket_object_lock", "bucket_name");
  }
  const count = Number(bucket?.object_count ?? 0);
  if (!opts.skipPreflight && Number.isFinite(count) && count > 0) {
    vfail(`Bucket is not empty (${count} objects). Delete all objects first.`, "bucket_not_empty", "bucket_name");
  }
}

/**
 * Portal S3 credential rules: name defaults to "Default Key" (1..100),
 * permission defaults to `admin_rw`, admin permissions cover all buckets,
 * and a `specific` scope needs at least one bucket.
 */
export function buildS3CredentialBody(input: {
  name?: unknown;
  permissionType?: unknown;
  bucketScope?: unknown;
  allowedBuckets?: unknown;
}): { name: string; permission_type: S3PermissionType; bucket_scope: S3BucketScope; allowed_buckets: string[] } {
  const name = input.name === undefined || input.name === null ? "Default Key" : trimStr(input.name);
  if (!name) vfail("Please enter a credential name", "invalid_name", "name");
  if (name.length > 100) vfail("Credential name must be 100 characters or fewer.", "invalid_name", "name");
  const permission =
    input.permissionType === undefined || input.permissionType === null
      ? "admin_rw"
      : enumOf(input.permissionType, S3_PERMISSION_TYPES, "permission_type");
  let buckets: string[] = [];
  if (input.allowedBuckets !== undefined && input.allowedBuckets !== null) {
    if (!Array.isArray(input.allowedBuckets)) {
      vfail("allowed_buckets must be an array of bucket names.", "invalid_allowed_buckets", "allowed_buckets");
    }
    for (const raw of input.allowedBuckets as unknown[]) {
      const b = typeof raw === "string" ? raw.trim() : "";
      if (b && !buckets.includes(b)) buckets.push(b);
    }
  }
  const scopeGiven = input.bucketScope !== undefined && input.bucketScope !== null;
  if (permission.startsWith("admin_")) {
    const scope = scopeGiven ? enumOf(input.bucketScope, S3_BUCKET_SCOPES, "bucket_scope") : "all";
    if (scope === "specific" || buckets.length > 0) {
      vfail("bucket_scope and allowed_buckets apply only to object_rw/object_ro", "invalid_bucket_scope", "bucket_scope");
    }
    return { name, permission_type: permission, bucket_scope: "all", allowed_buckets: [] };
  }
  const scope = scopeGiven ? enumOf(input.bucketScope, S3_BUCKET_SCOPES, "bucket_scope") : "all";
  if (scope === "specific" && buckets.length === 0) {
    vfail("Please select at least one bucket", "invalid_allowed_buckets", "allowed_buckets");
  }
  if (scope === "all" && buckets.length > 0) {
    vfail("allowed_buckets requires bucket_scope 'specific'.", "invalid_allowed_buckets", "allowed_buckets");
  }
  if (scope === "all") buckets = [];
  return { name, permission_type: permission, bucket_scope: scope, allowed_buckets: buckets };
}

/** Portal display rule for a workspace's S3 endpoint (display only). */
export function s3EndpointForWorkspace(workspaceId: string): string {
  return `https://${validateWorkspaceId(workspaceId)}.blob.ibeestorage.com`;
}

// ----------------------------------------------------------------------- CDN

/** Cache policies the portal offers (the API also lists `public-development`). */
export const CDN_CACHE_POLICIES = ["static-assets", "media", "short", "no-cache"] as const;
export const CDN_ORIGIN_TYPES = ["bucket", "custom"] as const;
export const CDN_PURGE_MODES = ["url", "hostname", "tag", "prefix", "all"] as const;
export const CDN_METRICS_RANGES = ["24h", "7d", "30d"] as const;
export const CDN_URL_DISPOSITIONS = ["inline", "attachment"] as const;
export type CdnCachePolicyId = (typeof CDN_CACHE_POLICIES)[number];
export type CdnPurgeMode = (typeof CDN_PURGE_MODES)[number];
const CDN_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const PURGE_SELECTOR: Record<CdnPurgeMode, string | undefined> = {
  url: "paths",
  hostname: "hostnames",
  tag: "tags",
  prefix: "prefixes",
  all: undefined,
};

/** Distribution name: trimmed, 1..128 characters. */
export function validateCdnDistributionName(name: unknown): string {
  const n = trimStr(name);
  if (!n) vfail("Please enter a name", "invalid_name", "name");
  if (n.length > 128) vfail("name must be 128 characters or fewer.", "invalid_name", "name");
  return n;
}

/** Validate distribution create/update fields and build the body. */
export function validateCdnDistributionFields(
  input: { name?: unknown; origin_id?: unknown; origin_type?: unknown; cache_policy?: unknown; enabled?: unknown },
  opts: { update?: boolean } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (!opts.update || (input.name !== undefined && input.name !== null)) body.name = validateCdnDistributionName(input.name);
  if (!opts.update) {
    const originId = trimStr(input.origin_id);
    if (!originId) vfail("Please select a bucket", "invalid_origin_id", "origin_id");
    body.origin_type =
      input.origin_type === undefined || input.origin_type === null
        ? "bucket"
        : enumOf(input.origin_type, CDN_ORIGIN_TYPES, "origin_type");
    body.origin_id = originId;
  }
  if (input.cache_policy !== undefined && input.cache_policy !== null) {
    body.cache_policy = enumOf(input.cache_policy, CDN_CACHE_POLICIES, "cache_policy");
  } else if (!opts.update) {
    body.cache_policy = "static-assets";
  }
  if (opts.update) {
    const enabled = optionalBool(input.enabled, "enabled");
    if (enabled !== undefined) body.enabled = enabled;
    if (Object.keys(body).length === 0) {
      vfail("Provide at least one of name, cache_policy, enabled", "no_changes");
    }
  }
  return body;
}

/** Validate a CDN URL request (bucket, key, expiry, disposition). */
export function validateCdnUrlRequest(input: {
  bucket_name?: unknown;
  object_key?: unknown;
  expires_in?: unknown;
  disposition?: unknown;
}): Record<string, unknown> {
  const bucket = trimStr(input.bucket_name);
  if (!bucket) vfail("bucket_name is required.", "invalid_bucket_name", "bucket_name");
  const key = typeof input.object_key === "string" ? input.object_key : "";
  if (!key.trim()) vfail("object_key is required.", "invalid_object_key", "object_key");
  const body: Record<string, unknown> = { bucket_name: bucket, object_key: key };
  if (input.expires_in !== undefined && input.expires_in !== null) {
    body.expires_in = requireInt(input.expires_in, "expires_in", 1, Number.MAX_SAFE_INTEGER, "expires_in must be an integer >= 1.");
  }
  if (input.disposition !== undefined && input.disposition !== null) {
    body.disposition = enumOf(input.disposition, CDN_URL_DISPOSITIONS, "disposition");
  }
  return body;
}

/** Validate a static-website index document (default `index.html`). */
export function validateCdnIndexDocument(value: unknown): string {
  const v = value === undefined || value === null ? "index.html" : trimStr(value);
  const bad = (why: string): never => vfail(`index_document ${why}.`, "invalid_index_document", "index_document");
  if (!v) bad("cannot be blank");
  if (new TextEncoder().encode(v).length > 1024) bad("must be at most 1024 bytes");
  if (v.startsWith("/")) bad("must not start with '/'");
  if (v.includes("\\")) bad("must not contain a backslash");
  for (const ch of v) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code > 0x7e) bad("must contain printable ASCII characters only");
  }
  if (v.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    bad("must not contain empty, '.' or '..' path segments");
  }
  return v;
}

/**
 * Normalise a CDN custom domain (trim, lower-case). `create` applies the
 * full hostname rule; path use only needs a non-blank value.
 */
export function normalizeCdnDomain(domain: unknown, opts: { create?: boolean } = {}): string {
  const d = trimStr(domain).toLowerCase();
  if (!d) vfail("domain is required.", "invalid_domain", "domain");
  if (!opts.create) return d;
  if (d.length < 3 || d.length > 253) vfail("domain must be 3-253 characters.", "invalid_domain", "domain");
  if (!CDN_DOMAIN_PATTERN.test(d)) vfail(`'${d}' is not a valid domain name.`, "invalid_domain", "domain");
  if (!d.includes(".")) {
    vfail("Domain must include a subdomain (e.g., cdn.example.com)", "invalid_domain", "domain");
  }
  return d;
}

const splitList = (value: unknown, field: string): string[] => {
  const items =
    typeof value === "string"
      ? value.split(/[,\n]/)
      : Array.isArray(value)
        ? value
        : vfail(`${field} must be an array of strings.`, "invalid_purge_request", field);
  return (items as unknown[]).map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
};

/**
 * Validate a cache purge and build the body. Only the selector matching the
 * mode may be given (`all` takes none): url -> paths (1..30, a leading `/`
 * is added to relative paths, absolute URLs must be https without
 * credentials or fragment), hostname -> hostnames (lower-cased), tag ->
 * tags, prefix -> prefixes (no query or fragment); 1..100 each. Selector
 * values may be arrays or comma/newline separated strings.
 */
export function buildCdnPurgeBody(input: {
  mode?: unknown;
  paths?: unknown;
  hostnames?: unknown;
  tags?: unknown;
  prefixes?: unknown;
}): Record<string, unknown> {
  if (!isRec(input)) vfail("request must be an object.", "invalid_purge_request");
  const mode = enumOf(input.mode, CDN_PURGE_MODES, "mode", "invalid_purge_request");
  const selector = PURGE_SELECTOR[mode];
  for (const key of ["paths", "hostnames", "tags", "prefixes"]) {
    if (key !== selector && input[key as keyof typeof input] !== undefined && input[key as keyof typeof input] !== null) {
      vfail(`${key} cannot be used with mode '${mode}'.`, "invalid_purge_request", key);
    }
  }
  if (!selector) return { mode };
  let values = splitList(input[selector as keyof typeof input], selector);
  const max = mode === "url" ? 30 : 100;
  if (values.length === 0) vfail(`mode '${mode}' requires at least one entry in ${selector}.`, "invalid_purge_request", selector);
  if (values.length > max) vfail(`${selector} accepts at most ${max} entries.`, "invalid_purge_request", selector);
  if (mode === "url") {
    values = values.map((p) => {
      if (!p.includes("://")) return p.startsWith("/") ? p : `/${p}`;
      if (!p.toLowerCase().startsWith("https://")) vfail("Absolute purge URLs must use https://.", "invalid_purge_request", "paths");
      if (p.includes("#")) vfail("Purge URLs must not contain a fragment (#).", "invalid_purge_request", "paths");
      const authority = p.slice(p.indexOf("://") + 3).split("/")[0];
      if (authority.includes("@")) vfail("Purge URLs must not contain credentials.", "invalid_purge_request", "paths");
      return p;
    });
  } else if (mode === "hostname") {
    values = values.map((h) => h.toLowerCase());
  } else if (mode === "prefix") {
    for (const p of values) {
      if (p.includes("?") || p.includes("#")) {
        vfail("Purge prefixes must not contain a query string or fragment.", "invalid_purge_request", "prefixes");
      }
    }
  }
  return { mode, [selector]: values };
}

/** Validate a CDN metrics range (default `24h`). */
export function validateCdnMetricsRange(range: unknown): string {
  if (range === undefined || range === null) return "24h";
  return enumOf(range, CDN_METRICS_RANGES, "range", "invalid_range");
}

// ======================================================================
// Secret Store (portal parity). All throw IbeeValidationError.
// ======================================================================

/** Secret names: lower-case letters, digits and `-`, 2..64 chars. */
export const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const SECRET_STORE_NAME_MAX_LENGTH = 128;
export const SECRET_IDENTITY_NAME_MAX_LENGTH = 128;
export const SECRET_SEARCH_QUERY_MAX_LENGTH = 128;
export const SECRET_STORE_MAX_PAGE_LIMIT = 200;
export const MAX_SECRET_BATCH_SIZE = 500;
export const MAX_SECRET_VERSIONS_PER_REQUEST = 100;
export const SECRET_IDENTITY_AUTH_METHODS = ["approle", "kubernetes"] as const;
export const SECRET_POLICY_MODES = ["read_only", "read_write"] as const;
/** Secret Store request bodies are limited to 64 KiB at the gateway. */
export const MAX_SECRET_STORE_BODY_BYTES = MAX_BILLABLE_BODY_BYTES;

export type SecretIdentityAuthMethodInput = (typeof SECRET_IDENTITY_AUTH_METHODS)[number];
export type SecretPolicyModeInput = (typeof SECRET_POLICY_MODES)[number];

// eslint-disable-next-line no-control-regex
const UNSAFE_ID_CHARS = /[/?#\u0000-\u001f\u007f]/;

/**
 * Validate a Secret Store path ID (store, secret, identity or scope ID):
 * non-blank after trimming, without `/`, `?`, `#` or control characters.
 * Returns the trimmed value (callers URL-encode it).
 */
export function validateResourceId(field: string, value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) vfail(`${field} is required.`, `invalid_${field}`, field);
  if (UNSAFE_ID_CHARS.test(id)) {
    vfail(`${field} must not contain '/', '?', '#' or control characters.`, `invalid_${field}`, field);
  }
  return id;
}

const isStrictInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Validate Secret Store paging: page >= 1, limit 1..200 (integers). */
export function validatePagination(args: { page?: unknown; limit?: unknown }): void {
  if (args.page !== undefined && args.page !== null && (!isStrictInt(args.page) || args.page < 1)) {
    vfail("page must be an integer >= 1.", "invalid_page", "page");
  }
  if (
    args.limit !== undefined &&
    args.limit !== null &&
    (!isStrictInt(args.limit) || args.limit < 1 || args.limit > SECRET_STORE_MAX_PAGE_LIMIT)
  ) {
    vfail(`limit must be an integer between 1 and ${SECRET_STORE_MAX_PAGE_LIMIT}.`, "invalid_limit", "limit");
  }
}

/** Trim a secret search query; `undefined` when blank; max 128 chars. */
export function normalizeSearchQuery(q: unknown): string | undefined {
  if (q === undefined || q === null) return undefined;
  if (typeof q !== "string") vfail("q must be a string.", "invalid_query", "q");
  const s = (q as string).trim();
  if (!s) return undefined;
  if (s.length > SECRET_SEARCH_QUERY_MAX_LENGTH) {
    vfail(`q must be at most ${SECRET_SEARCH_QUERY_MAX_LENGTH} characters.`, "invalid_query", "q");
  }
  return s;
}

/**
 * Trim and validate a store name (1..128). On create the name must also
 * contain a letter or digit, because the store key is generated from it.
 */
export function normalizeStoreName(name: unknown, options: { creating: boolean }): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) vfail("Store name is required.", "invalid_store_name", "name");
  if (n.length > SECRET_STORE_NAME_MAX_LENGTH) {
    vfail(`Store name must be at most ${SECRET_STORE_NAME_MAX_LENGTH} characters.`, "invalid_store_name", "name");
  }
  if (options.creating && !/[A-Za-z0-9]/.test(n)) {
    vfail(
      "Store name must contain at least one letter or number to generate a store key.",
      "invalid_store_name",
      "name",
    );
  }
  return n;
}

/** Trim an optional store description (no length limit). */
export function normalizeStoreDescription(description: unknown): string | undefined {
  if (description === undefined || description === null) return undefined;
  if (typeof description !== "string") {
    vfail("description must be a string.", "invalid_description", "description");
  }
  return (description as string).trim();
}

/**
 * Normalise a secret name the way the portal does (trim, lower-case) and
 * check it: 2..64 characters, starting with a letter or digit, then only
 * lower-case letters, digits or `-`.
 */
export function normalizeSecretName(name: unknown, field = "secret_name"): string {
  const n = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!n) vfail("Secret name is required.", "invalid_secret_name", field);
  if (!SECRET_NAME_PATTERN.test(n)) {
    vfail(
      "Secret name must be 2-64 characters: lower-case letters, digits and '-', starting with a letter or digit.",
      "invalid_secret_name",
      field,
    );
  }
  return n;
}

/**
 * Validate a secret value: a plain JSON object with at least one entry.
 * Keys are trimmed and must be non-blank and unique after trimming. String
 * values must not be blank (the portal never sends empty entries). Other
 * JSON types are allowed. With `allowNullValues` (patch), `null` deletes
 * that key.
 */
export function normalizeSecretValue(
  value: unknown,
  options: { allowNullValues?: boolean; field?: string } = {},
): Record<string, unknown> {
  const field = options.field ?? "value";
  const proto = isRec(value) ? Object.getPrototypeOf(value) : undefined;
  if (!isRec(value) || (proto !== Object.prototype && proto !== null)) {
    vfail("Secret value must be an object of key/value entries.", "invalid_secret_value", field);
  }
  const out: Record<string, unknown> = {};
  for (const [rawKey, v] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) vfail("Secret value keys must not be blank.", "invalid_secret_value", field);
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      vfail(`Secret value key '${key}' is duplicated after trimming.`, "invalid_secret_value", field);
    }
    if (v === undefined) {
      vfail(`Secret value for '${key}' is missing.`, "invalid_secret_value", field);
    }
    if (v === null && !options.allowNullValues) {
      vfail(`Secret value for '${key}' must not be null.`, "invalid_secret_value", field);
    }
    if (typeof v === "string" && v.trim() === "") {
      vfail(`Secret value for '${key}' must not be blank.`, "invalid_secret_value", field);
    }
    out[key] = v;
  }
  if (Object.keys(out).length === 0) {
    vfail("Secret value needs at least one key/value pair.", "invalid_secret_value", field);
  }
  return out;
}

/** Validate a secret version number (integer >= 1). */
export function validateVersion(version: unknown, field = "version"): number {
  if (!isStrictInt(version) || version < 1) {
    vfail(`${field} must be an integer >= 1.`, "invalid_version", field);
  }
  return version as number;
}

/** Validate a version list (1..100 integers >= 1), de-duplicated in order. */
export function validateVersions(versions: unknown): number[] {
  if (!Array.isArray(versions) || versions.length === 0) {
    vfail("versions must be a non-empty array of version numbers.", "invalid_versions", "versions");
  }
  const out: number[] = [];
  for (const v of versions as unknown[]) {
    if (!isStrictInt(v) || v < 1) vfail("Every version must be an integer >= 1.", "invalid_versions", "versions");
    if (!out.includes(v as number)) out.push(v as number);
  }
  if (out.length > MAX_SECRET_VERSIONS_PER_REQUEST) {
    vfail(
      `versions accepts at most ${MAX_SECRET_VERSIONS_PER_REQUEST} entries.`,
      "invalid_versions",
      "versions",
    );
  }
  return out;
}

/** Validate a check-and-set version: `undefined`/`null` or an integer >= 0. */
export function validateCas(cas: unknown): number | undefined {
  if (cas === undefined || cas === null) return undefined;
  if (!isStrictInt(cas) || cas < 0) vfail("cas must be an integer >= 0.", "invalid_cas", "cas");
  return cas as number;
}

function policyModeOf(value: unknown, field: string, fallback?: SecretPolicyModeInput): SecretPolicyModeInput {
  if ((value === undefined || value === null) && fallback) return fallback;
  if (typeof value !== "string" || !(SECRET_POLICY_MODES as readonly string[]).includes(value)) {
    vfail(`${field} must be one of ${SECRET_POLICY_MODES.join(", ")}.`, `invalid_${field}`, field);
  }
  return value as SecretPolicyModeInput;
}

/** Validate a token policy / scope access mode (`read_only` or `read_write`). */
export function validatePolicyMode(value: unknown, field = "token_policy_mode"): SecretPolicyModeInput {
  return policyModeOf(value, field);
}

/**
 * Validate an application identity create and build the request body.
 * `token_policy_mode` defaults to `read_only` and is always sent. Kubernetes
 * identities need a non-blank namespace and service account (sent trimmed);
 * AppRole identities never send the Kubernetes fields.
 */
export function validateIdentityCreate(input: {
  authMethod: unknown;
  name: unknown;
  tokenPolicyMode?: unknown;
  k8sNamespace?: unknown;
  k8sServiceAccount?: unknown;
}): Record<string, unknown> {
  const authMethod = input.authMethod;
  if (typeof authMethod !== "string" || !(SECRET_IDENTITY_AUTH_METHODS as readonly string[]).includes(authMethod)) {
    vfail(
      `auth_method must be one of ${SECRET_IDENTITY_AUTH_METHODS.join(", ")}.`,
      "invalid_auth_method",
      "auth_method",
    );
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) vfail("Identity name is required.", "invalid_identity_name", "name");
  if (name.length > SECRET_IDENTITY_NAME_MAX_LENGTH) {
    vfail(
      `Identity name must be at most ${SECRET_IDENTITY_NAME_MAX_LENGTH} characters.`,
      "invalid_identity_name",
      "name",
    );
  }
  const mode = policyModeOf(input.tokenPolicyMode, "token_policy_mode", "read_only");
  const body: Record<string, unknown> = { auth_method: authMethod, name, token_policy_mode: mode };
  const text = (v: unknown, field: string): string => {
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") vfail(`${field} must be a string.`, `invalid_${field}`, field);
    return (v as string).trim();
  };
  const ns = text(input.k8sNamespace, "k8s_namespace");
  const sa = text(input.k8sServiceAccount, "k8s_service_account");
  if (authMethod === "kubernetes") {
    if (!ns || !sa) {
      vfail(
        "Kubernetes namespace and service account are required for Kubernetes identities.",
        "invalid_kubernetes_identity",
        !ns ? "k8s_namespace" : "k8s_service_account",
      );
    }
    body.k8s_namespace = ns;
    body.k8s_service_account = sa;
  } else if (ns || sa) {
    vfail(
      "k8s_namespace and k8s_service_account are only used with auth_method 'kubernetes'.",
      "invalid_approle_identity",
      ns ? "k8s_namespace" : "k8s_service_account",
    );
  }
  return body;
}

/**
 * Check scope permissions sent in one call: a `read_only` scope cannot
 * grant rollback or destroy. When the identity's `token_policy_mode` is
 * known and `read_only`, the scope must be `read_only` without rollback or
 * destroy.
 */
export function validateScopePermissions(input: {
  accessMode?: unknown;
  allowRollback?: unknown;
  allowDestroy?: unknown;
  identityMode?: string | null;
}): void {
  const mode = input.accessMode === undefined || input.accessMode === null
    ? undefined
    : policyModeOf(input.accessMode, "access_mode");
  if (mode === "read_only" && (input.allowRollback === true || input.allowDestroy === true)) {
    vfail(
      "Read-only scopes cannot grant rollback or destroy permissions.",
      "invalid_scope_permissions",
      input.allowRollback === true ? "allow_rollback" : "allow_destroy",
    );
  }
  if (
    input.identityMode === "read_only" &&
    (mode === "read_write" || input.allowRollback === true || input.allowDestroy === true)
  ) {
    vfail(
      "Read-only identities cannot be granted write, rollback, or destroy permissions.",
      "invalid_scope_permissions",
      mode === "read_write" ? "access_mode" : "allow_rollback",
    );
  }
}

/** Validate an optional boolean flag. */
export function validateOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") vfail(`${field} must be a boolean.`, `invalid_${field}`, field);
  return value as boolean;
}

/** Throw when the compact UTF-8 JSON body exceeds `limit` bytes (default 64 KiB). */
export function assertBodySize(body: unknown, limit: number = MAX_SECRET_STORE_BODY_BYTES): void {
  const serialized = JSON.stringify(body);
  if (serialized === undefined) return;
  const size = new TextEncoder().encode(serialized).length;
  if (size > limit) {
    vfail(`Request body is ${size} bytes; the limit is ${limit} bytes.`, "request_body_too_large");
  }
}

/** Minimal shape of `listSecretVersions` used by the rollback check. */
export interface SecretVersionsLike {
  current_version?: number;
  versions?: Record<string, { destroyed?: boolean } | undefined>;
}

/**
 * Portal rollback rule: the target must exist, must not be the current
 * version and must not be destroyed.
 */
export function checkRollbackTarget(versions: SecretVersionsLike, version: number): void {
  if (versions?.current_version === version) {
    vfail(`Version ${version} is already the current version.`, "invalid_rollback_target", "version");
  }
  const entry = versions?.versions?.[String(version)];
  if (!entry) vfail(`Version ${version} does not exist for this secret.`, "invalid_rollback_target", "version");
  if (entry?.destroyed) {
    vfail(`Version ${version} was destroyed and cannot be restored.`, "invalid_rollback_target", "version");
  }
}

/** Portal rule for secret-ID rotation: AppRole and active only. */
export function assertRotateAllowed(identity: { auth_method?: unknown; status?: unknown }): void {
  if (String(identity?.auth_method ?? "") !== "approle") {
    vfail(
      "rotate-secret-id is only available for AppRole identities.",
      "invalid_auth_method",
      "auth_method",
    );
  }
  if (String(identity?.status ?? "") !== "active") {
    vfail("Identity is disabled; enable it before rotating its secret ID.", "identity_disabled", "status");
  }
}

/**
 * Portal rule for granting a store to an identity: the store must be
 * active and not already granted to the identity.
 */
export function checkScopeStoreEligibility(
  storeId: string,
  activeStoreIds: Iterable<string> | undefined,
  scopedStoreIds: Iterable<string> | undefined,
): void {
  if (scopedStoreIds && new Set(Array.from(scopedStoreIds, String)).has(storeId)) {
    vfail(`Store '${storeId}' is already granted to this identity.`, "scope_store_already_granted", "store_id");
  }
  if (activeStoreIds && !new Set(Array.from(activeStoreIds, String)).has(storeId)) {
    vfail(`Store '${storeId}' is not an active store in this workspace.`, "scope_store_not_active", "store_id");
  }
}
