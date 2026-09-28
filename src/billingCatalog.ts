/**
 * Billing catalog (SKU) helpers used by VM create, resize and recovery.
 * Ports of the portal's plan-term and attached-SKU rules.
 */

import { IbeeValidationError } from "./validation.js";
import type {
  BillingCatalogSelection,
  BillingOption,
  BillingSkuReference,
  BillingTerm,
} from "./types.js";

/** Billing terms a VM plan can be bought on. */
export const BILLING_TERMS: readonly BillingTerm[] = ["HOURLY", "MONTHLY", "YEARLY"];

/** Attached-SKU components that are part of the VM plan and never billed separately. */
export const ROOT_DISK_COMPONENTS: ReadonlySet<string> = new Set([
  "rootdisk",
  "root_disk",
  "root_disk_storage",
  "rootvolume",
  "root_volume",
  "root_storage",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

const fail = (message: string, field = "billing_catalog", code = "invalid_billing_catalog"): never => {
  throw new IbeeValidationError(message, code, field);
};

/** Normalise an attached-SKU component key (lower-case, `-` -> `_`). */
export function normaliseSkuComponent(component: string): string {
  return String(component).trim().toLowerCase().replace(/-/g, "_");
}

/**
 * Validate one SKU reference: an object with a non-blank `sku_id` and a
 * `sku_code` (upper-cased; `ROOTDISK-*` is rejected). Returns a copy with the
 * normalised `sku_id`/`sku_code`.
 */
export function requireBillingSku(
  value: unknown,
  context = "billing_catalog",
  field = "billing_catalog",
): BillingSkuReference {
  if (!isRecord(value)) fail(`${context} is missing Billing catalog data`, field);
  const record = value as Record<string, unknown>;
  const skuId = record.sku_id ?? record.skuId ?? record.id;
  if (skuId === undefined || skuId === null || String(skuId).trim() === "") {
    fail(`${context} is missing Billing catalog sku_id`, field);
  }
  const rawCode = record.sku_code ?? record.skuCode ?? record.code;
  const skuCode = String(rawCode ?? "").trim().toUpperCase();
  if (!skuCode) fail(`${context} is missing Billing catalog sku_code`, field);
  if (skuCode.startsWith("ROOTDISK-")) {
    fail("VM root disk is included in the VM plan and must not have a separate SKU", field);
  }
  return { ...record, sku_id: skuId as string | number, sku_code: skuCode };
}

export interface ValidateBillingCatalogOptions {
  /** Used in error messages, e.g. "Snapshot billing_catalog". */
  context?: string;
  /** Request field the value came from (default `billing_catalog`). */
  field?: string;
  /** When set and the catalog has `product_code`, it must equal this value. */
  expectedProduct?: string;
}

/**
 * Validate a billing catalog selection the way the portal does before sending
 * it: primary SKU rules, then every `attached_skus` entry (keys normalised;
 * root-disk components rejected). `expectedProduct` checks `product_code`
 * when it is present.
 */
export function validateBillingCatalog(
  value: unknown,
  options: ValidateBillingCatalogOptions = {},
): BillingCatalogSelection {
  const context = options.context ?? "billing_catalog";
  const field = options.field ?? "billing_catalog";
  const primary = requireBillingSku(value, context, field);
  const record = value as Record<string, unknown>;
  const rawAttached = record.attached_skus ?? record.attachedSkus;
  const out: BillingCatalogSelection = { ...primary };
  delete (out as Record<string, unknown>).attachedSkus;
  if (rawAttached !== undefined && rawAttached !== null) {
    if (!isRecord(rawAttached)) fail(`${context} attached_skus must be an object`, field);
    const attached: Record<string, BillingSkuReference> = {};
    for (const [rawComponent, sku] of Object.entries(rawAttached as Record<string, unknown>)) {
      const component = normaliseSkuComponent(rawComponent);
      if (ROOT_DISK_COMPONENTS.has(component)) {
        fail("VM root disk is included in the VM plan and must not be sent as an attached SKU", field);
      }
      attached[component] = requireBillingSku(sku, `${context} ${component}`, field);
    }
    out.attached_skus = attached;
  }
  if (options.expectedProduct !== undefined) {
    const product = record.product_code;
    if (
      product !== undefined &&
      product !== null &&
      String(product).trim() !== "" &&
      String(product).trim().toLowerCase() !== options.expectedProduct.toLowerCase()
    ) {
      fail(
        `${context} must be a ${options.expectedProduct} SKU (got product_code '${String(product)}').`,
        field,
      );
    }
  }
  return out;
}

/**
 * Merge extra SKUs into `catalog.attached_skus` (portal
 * `withAttachedBillingSkus`). `undefined`/`null` attachments are skipped.
 */
export function withAttachedBillingSkus(
  catalog: unknown,
  attachments: Record<string, unknown>,
  context = "billing_catalog",
): BillingCatalogSelection {
  const primary = validateBillingCatalog(catalog, { context });
  const attached: Record<string, BillingSkuReference> = { ...(primary.attached_skus ?? {}) };
  for (const [rawComponent, sku] of Object.entries(attachments)) {
    if (sku === undefined || sku === null) continue;
    const component = normaliseSkuComponent(rawComponent);
    if (ROOT_DISK_COMPONENTS.has(component)) {
      fail("VM root disk is included in the VM plan and must not be sent as an attached SKU");
    }
    attached[component] = requireBillingSku(sku, `${context} ${component}`);
  }
  return { ...primary, attached_skus: attached };
}

/** Billing options on a catalog, keeping only priced HOURLY/MONTHLY/YEARLY entries. */
export function billingOptionsOf(catalog: unknown): BillingOption[] {
  if (!isRecord(catalog) || !Array.isArray(catalog.billing_options)) return [];
  return (catalog.billing_options as unknown[])
    .filter(isRecord)
    .filter(
      (o) =>
        (BILLING_TERMS as readonly string[]).includes(String(o.billing_interval)) &&
        o.unit_price_minor !== null &&
        o.unit_price_minor !== "" &&
        Number.isFinite(Number(o.unit_price_minor)),
    )
    .map((o) => ({
      ...o,
      billing_interval: o.billing_interval as BillingTerm,
      committed: Boolean(o.committed),
      commitment_period: (BILLING_TERMS as readonly string[]).includes(String(o.commitment_period))
        ? (o.commitment_period as BillingTerm)
        : (o.billing_interval as BillingTerm),
      commitment_months: o.commitment_months ? Number(o.commitment_months) : undefined,
      committed_hours: o.committed_hours ? Number(o.committed_hours) : undefined,
      unit_price_minor: Number(o.unit_price_minor),
    })) as BillingOption[];
}

/** Validate a billing term (case-insensitive) and return it upper-cased. */
export function normaliseBillingTerm(term: unknown, field = "billing_term"): BillingTerm {
  const t = String(term ?? "").trim().toUpperCase();
  if (!(BILLING_TERMS as readonly string[]).includes(t)) {
    fail(`${field} must be one of ${BILLING_TERMS.join(", ")}.`, field, "invalid_billing_term");
  }
  return t as BillingTerm;
}

/**
 * Pick the billing option for `term` from a catalog's `billing_options`
 * (portal `billingOptionForInterval`). Without a term: HOURLY when offered,
 * else the first option. Throws when the term is not offered.
 */
export function selectBillingOption(
  catalog: unknown,
  term?: BillingTerm | string,
  subject = "Selected plan",
): BillingOption {
  const options = billingOptionsOf(catalog);
  const wanted =
    term === undefined || term === null
      ? (options.find((o) => o.billing_interval === "HOURLY") ?? options[0])?.billing_interval ?? "HOURLY"
      : normaliseBillingTerm(term);
  const option = options.find((o) => o.billing_interval === wanted);
  if (!option) {
    fail(`${subject} does not support ${wanted.toLowerCase()} billing`, "billing_term", "unsupported_billing_term");
  }
  return option as BillingOption;
}

/** Exact port of the portal's `billingCatalogForTerm`. */
export function billingCatalogForTerm(
  catalog: BillingCatalogSelection,
  option: BillingOption,
): BillingCatalogSelection {
  return {
    ...catalog,
    billing_interval: option.billing_interval,
    committed: option.committed,
    commitment_period: option.commitment_period,
    ...(option.commitment_months ? { commitment_months: option.commitment_months } : {}),
    ...(option.committed_hours ? { committed_hours: option.committed_hours } : {}),
    ...(option.discount_percent !== undefined && option.discount_percent !== null
      ? { discount_percent: option.discount_percent }
      : {}),
    ...(option.price_unit ? { price_unit: option.price_unit } : {}),
    unit_price_minor: option.unit_price_minor,
  };
}

/**
 * Apply a term to a catalog. With no explicit term and no billing options the
 * catalog is returned unchanged (the API then bills hourly).
 */
export function applyBillingTerm(
  catalog: BillingCatalogSelection,
  term: BillingTerm | string | undefined,
  subject = "Selected plan",
): { catalog: BillingCatalogSelection; option?: BillingOption } {
  if (term === undefined && billingOptionsOf(catalog).length === 0) return { catalog };
  const option = selectBillingOption(catalog, term, subject);
  return { catalog: billingCatalogForTerm(catalog, option), option };
}

/**
 * Build the Windows licence attachment for a VM: the licence SKU priced for
 * the VM's term, with quantity = vCPU count (portal rule).
 */
export function windowsLicenseAttachment(
  license: unknown,
  term: BillingTerm | undefined,
  cpu: number,
): BillingCatalogSelection {
  const sku = validateBillingCatalog(license, { context: "windows_license", field: "windows_license" });
  for (const key of ["os_type", "os_family"] as const) {
    const v = (sku as Record<string, unknown>)[key];
    if (v !== undefined && v !== null && String(v).trim() !== "" && String(v).trim().toLowerCase() !== "windows") {
      fail(`windows_license.${key} must be 'windows'.`, "windows_license");
    }
  }
  let priced: BillingCatalogSelection = sku;
  if (billingOptionsOf(sku).length > 0) {
    priced = billingCatalogForTerm(sku, selectBillingOption(sku, term ?? "HOURLY", "Windows licence"));
  } else if (
    term !== undefined &&
    sku.billing_interval !== undefined &&
    String(sku.billing_interval).toUpperCase() !== term
  ) {
    fail(`Windows licence does not support ${term.toLowerCase()} billing`, "windows_license");
  }
  return {
    ...priced,
    component_key: "windows_license",
    os_type: "windows",
    os_family: "windows",
    quantity_basis: "VCPU",
    quantity: Math.max(1, Math.trunc(cpu)),
  };
}

export interface BuildVmBillingCatalogArgs {
  /** The plan's `billing_catalog` (or a caller-supplied catalog). */
  catalog: unknown;
  /** Billing term; undefined = HOURLY (or the first option). */
  term?: BillingTerm;
  /** When false the catalog is sent without applying a term (GPU default). */
  applyTerm?: boolean;
  osType?: string;
  cpu: number;
  windowsLicense?: unknown;
  reservedIpBillingCatalog?: unknown;
}

/**
 * Build the create body's `billing_catalog` like the portal: plan SKU priced
 * for the term, plus `attached_skus.windows_license` (Windows only, required)
 * and `attached_skus.reserved_ip` when a Reserved IP is attached at launch.
 */
export function buildVmCreateBillingCatalog(args: BuildVmBillingCatalogArgs): {
  catalog: BillingCatalogSelection;
  option?: BillingOption;
} {
  const base = validateBillingCatalog(args.catalog, { context: "Selected plan" });
  const { catalog, option } =
    args.applyTerm === false && args.term === undefined
      ? { catalog: base, option: undefined }
      : applyBillingTerm(base, args.term);
  const windows = String(args.osType ?? "").trim().toLowerCase() === "windows";
  const existingLicense = catalog.attached_skus?.windows_license;
  let license: BillingCatalogSelection | undefined;
  if (windows) {
    if (args.windowsLicense !== undefined && args.windowsLicense !== null) {
      license = windowsLicenseAttachment(args.windowsLicense, option?.billing_interval ?? args.term, args.cpu);
    } else if (!existingLicense) {
      fail(
        "Windows VMs require a Windows licence SKU (windows_license). The public API does not list it yet; pass the licence SKU you were given.",
        "windows_license",
        "windows_license_required",
      );
    }
  } else if (
    (args.windowsLicense !== undefined && args.windowsLicense !== null) ||
    existingLicense
  ) {
    fail("windows_license is only allowed for Windows VMs.", "windows_license");
  }
  return {
    catalog: withAttachedBillingSkus(
      catalog,
      { windows_license: license, reserved_ip: args.reservedIpBillingCatalog },
      "Selected plan",
    ),
    option,
  };
}
