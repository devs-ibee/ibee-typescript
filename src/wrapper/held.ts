// TEMPORARY until the server resolves its own SKU (and the other held
// upstream questions are answered). These are the only client-side request
// decisions left in the SDK; each goes away once the server does it:
// - VM create (cloud and GPU): billing_catalog is the contract's
//   ComputeBillingSelection. When it is left out, the plan's billing_catalog
//   (GET /compute/plans) is copied and the billing_options entry for
//   billing_term (HOURLY when omitted) is merged into the copy as a whole
//   (billing_interval, committed, commitment_period, commitment_months,
//   committed_hours, price_unit, unit_price_minor, ...); price_currency stays.
//   A given billing_catalog without billing_interval is merged the same way;
//   one with billing_interval is sent as given unless billing_term is set.
//   Nothing is invented: a term the plan does not offer leaves the copy
//   unchanged and the server answers. Plus the Windows licence and the
//   Reserved IP SKU in attached_skus.
// - VM delete: the body may be left out (the contract makes it optional).
//   public_ip_action has no default: the server answers 400 for a VM with an
//   automatically assigned public IP until the caller chooses.
// - billing_catalog on attach-volume (the volume's metadata.billing_catalog;
//   left out when the volume has none, so the server answers). NAT:
//   nat_billing_catalog on VPC create and billing_catalog on NAT gateway
//   create are passed through.
// - backups/disable (cloud and GPU VMs) is sent with the JSON body {}: the
//   contract declares none, and the server answers 422 without one.
// - VM and firewall-group lists read every page when no limit/offset is set
//   (the server returns 10 by default).
// - The token-environment check and keeping the token out of the client's
//   enumerable state.

import type * as Ibee from "../api/index.js";
import { BlockStorageClient } from "../api/resources/blockStorage/client/Client.js";
import { CloudVmsClient } from "../api/resources/cloudVms/client/Client.js";
import { ComputeCatalogClient } from "../api/resources/computeCatalog/client/Client.js";
import { FirewallsClient } from "../api/resources/firewalls/client/Client.js";
import { GpuVmsClient } from "../api/resources/gpuVms/client/Client.js";
import { ReservedIpsClient } from "../api/resources/reservedIps/client/Client.js";
import { VpcsClient } from "../api/resources/vpcs/client/Client.js";
import type { BaseClientOptions } from "../BaseClient.js";
import * as core from "../core/index.js";
import { IbeeError } from "../errors/index.js";

type Rec = Record<string, any>;
type Options = BaseClientOptions;
type RequestOptions = CloudVmsClient.RequestOptions;
type Pending<T> = core.HttpResponsePromise<T>;

/** A billing_options term: HOURLY (pay as you go) or MONTHLY (a one-month commitment). */
export type HeldBillingTerm = "HOURLY" | "MONTHLY";
/** Fields the held VM create accepts on top of the contract request. */
export interface HeldVmCreateFields {
    /** The billing_options entry merged into billing_catalog. Default: HOURLY. */
    billing_term?: HeldBillingTerm;
    /** Windows licence SKU; attached per vCPU. */
    windows_license?: Rec;
}
/**
 * VM create whose billing_catalog may be omitted (taken from the plan) or be the
 * plan's billing_catalog as listed by GET /compute/plans (the billing_term entry
 * is merged into it).
 */
export type HeldVmCreate<T extends { billing_catalog: unknown }> = Omit<T, "billing_catalog"> &
    HeldVmCreateFields & { billing_catalog?: T["billing_catalog"] | Record<string, unknown> };
/** VM delete with an optional body; nothing is added to it (no public_ip_action default). */
export type HeldVmDelete<T extends { body: unknown }> = Omit<T, "body"> & { body?: T["body"] };
/** Attach-volume whose billing_catalog may be omitted (read from the volume's metadata.billing_catalog). */
export type HeldVmAttach<T extends { body: Ibee.VmAttachVolumeRequest }> = Omit<T, "body"> & {
    body: Omit<Ibee.VmAttachVolumeRequest, "billing_catalog"> & { billing_catalog?: Ibee.BillingCatalogSelection };
};

type VmType = "cloud" | "gpu";

export class HeldCloudVms extends CloudVmsClient {
    public override createCloudVm(
        request: HeldVmCreate<Ibee.CreateCloudVmRequest>,
        requestOptions?: RequestOptions,
    ): Pending<Ibee.OperationAccepted> {
        return later(async () =>
            super.createCloudVm(await vmCreate(this._options, "cloud", request), requestOptions).withRawResponse(),
        );
    }

    public override deleteCloudVm(
        request: HeldVmDelete<Ibee.DeleteCloudVmRequest>,
        requestOptions?: RequestOptions,
    ): Pending<Ibee.OperationAccepted> {
        return super.deleteCloudVm(vmDelete(request), requestOptions);
    }

    public override attachCloudVmVolume(
        request: HeldVmAttach<Ibee.AttachCloudVmVolumeRequest>,
        requestOptions?: RequestOptions,
    ): Pending<Ibee.OperationAccepted> {
        return later(async () =>
            super.attachCloudVmVolume(await vmAttach(this._options, request), requestOptions).withRawResponse(),
        );
    }

    public override listCloudVms(
        request: Ibee.ListCloudVmsRequest = {},
        requestOptions?: RequestOptions,
    ): Pending<Ibee.CloudVm[]> {
        if (request.limit != null || request.offset != null) return super.listCloudVms(request, requestOptions);
        return allPages((limit, offset) => super.listCloudVms({ ...request, limit, offset }, requestOptions));
    }
}

export class HeldGpuVms extends GpuVmsClient {
    public override createGpuVm(
        request: HeldVmCreate<Ibee.CreateGpuVmRequest>,
        requestOptions?: RequestOptions,
    ): Pending<Ibee.OperationAccepted> {
        return later(async () =>
            super.createGpuVm(await vmCreate(this._options, "gpu", request), requestOptions).withRawResponse(),
        );
    }

    public override deleteGpuVm(
        request: HeldVmDelete<Ibee.DeleteGpuVmRequest>,
        requestOptions?: RequestOptions,
    ): Pending<Ibee.OperationAccepted> {
        return super.deleteGpuVm(vmDelete(request), requestOptions);
    }

    public override attachGpuVmVolume(
        request: HeldVmAttach<Ibee.AttachGpuVmVolumeRequest>,
        requestOptions?: RequestOptions,
    ): Pending<Ibee.OperationAccepted> {
        return later(async () =>
            super.attachGpuVmVolume(await vmAttach(this._options, request), requestOptions).withRawResponse(),
        );
    }

    public override listGpuVms(
        request: Ibee.ListGpuVmsRequest = {},
        requestOptions?: RequestOptions,
    ): Pending<Ibee.GpuVm[]> {
        if (request.limit != null || request.offset != null) return super.listGpuVms(request, requestOptions);
        return allPages((limit, offset) => super.listGpuVms({ ...request, limit, offset }, requestOptions));
    }
}

export class HeldVpcs extends VpcsClient {
    /** `nat_billing_catalog` (NAT-GATEWAY SKU) is sent as given, so the managed NAT is metered. */
    public override createVpc(
        request: Ibee.CreateVpcRequest & { nat_billing_catalog?: Rec },
        requestOptions?: RequestOptions,
    ): Pending<Ibee.VpcDetail> {
        return super.createVpc(request, requestOptions);
    }

    /** `billing_catalog` (NAT-GATEWAY SKU) is sent as given, so the gateway is metered. */
    public override createNatGateway(
        request: Ibee.CreateNatGatewayRequest & { billing_catalog?: Rec },
        requestOptions?: RequestOptions,
    ): Pending<Ibee.NatGateway> {
        return super.createNatGateway(request, requestOptions);
    }
}

export class HeldFirewalls extends FirewallsClient {
    public override listFirewallGroups(
        request: Ibee.ListFirewallGroupsRequest = {},
        requestOptions?: RequestOptions,
    ): Pending<Ibee.FirewallGroup[]> {
        if (request.limit != null || request.offset != null) return super.listFirewallGroups(request, requestOptions);
        return allPages((limit, offset) => super.listFirewallGroups({ ...request, limit, offset }, requestOptions));
    }
}

/** Reject a development token on the production gateway and the reverse. */
export function checkTokenEnvironment(token: string, baseUrl: string): void {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
    if (
        (host === "api.ibee.ai" && token.startsWith("ibee_dev_key_")) ||
        (host === "api.ibee.co.in" && token.startsWith("ibee_prod_key_"))
    ) {
        throw new IbeeError({ message: "The API token environment does not match the configured IBEE endpoint." });
    }
}

/** A supplier, so the token is not an enumerable string on the client (JSON.stringify, console.log). */
export function hiddenToken(token: string): () => string {
    return () => token;
}

// backups/disable takes no body in the contract; the server answers 422 without one.
const EMPTY_BODY_ROUTE = /(^|\/)compute\/(cloud-vms|gpu-vms)\/[^/]+\/backups\/disable\/?$/;

/** A POST to backups/disable (cloud or GPU VM) without a body is sent with the JSON body {}. */
export function withEmptyJsonBody(args: core.Fetcher.Args, method: string, path: string): core.Fetcher.Args {
    if (method !== "POST" || args.body !== undefined || !EMPTY_BODY_ROUTE.test(path)) return args;
    return { ...args, body: {}, contentType: "application/json", requestType: "json" };
}

// ---------------------------------------------------------------- helpers

const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);

function later<T>(make: () => Promise<core.WithRawResponse<T>>): Pending<T> {
    return core.HttpResponsePromise.fromPromise(make());
}

async function findPlan(
    options: Options,
    vmType: VmType,
    workspaceId: string | undefined,
    siteId: unknown,
    planId: unknown,
) {
    const list = await new ComputeCatalogClient(options).listComputePlans({
        workspace_id: workspaceId,
        vm_type: vmType,
        site_id: siteId == null ? undefined : String(siteId),
    });
    return (list.plans ?? []).find((p) => String(p.plan_id) === String(planId));
}

/** Fields a billing_options entry sets; dropped from the copy before the entry is merged in. */
const TERM_FIELDS = [
    "billing_interval",
    "committed",
    "commitment_period",
    "commitment_months",
    "committed_hours",
    "price_unit",
    "unit_price_minor",
    "discount_percent",
];

/**
 * A copy of `catalog` with its billing_options entry for `term` (HOURLY when
 * omitted) merged in as a whole. Unchanged when the catalog has no such entry.
 */
function selectTerm(catalog: Rec | undefined, term: string | undefined): Rec | undefined {
    const options: Rec[] = Array.isArray(catalog?.billing_options) ? catalog.billing_options.filter(rec) : [];
    const wanted = (term ?? "HOURLY").toUpperCase();
    const option = options.find((o) => String(o.billing_interval).toUpperCase() === wanted);
    if (!catalog || !option) return catalog;
    const copy: Rec = { ...catalog };
    for (const key of TERM_FIELDS) delete copy[key];
    return { ...copy, ...option };
}

function windowsLicense(license: Rec, term: string | undefined, cpu: unknown): Rec {
    return {
        ...selectTerm(license, term),
        component_key: "windows_license",
        os_type: "windows",
        os_family: "windows",
        quantity_basis: "VCPU",
        quantity: Math.max(1, Math.trunc(Number(cpu) || 1)),
    };
}

function withAttached(catalog: Rec | undefined, attached: Rec): Rec | undefined {
    const extra = Object.fromEntries(Object.entries(attached).filter(([, sku]) => sku != null));
    if (!catalog || Object.keys(extra).length === 0) return catalog;
    return { ...catalog, attached_skus: { ...rec(catalog.attached_skus), ...extra } };
}

async function vmCreate<T extends Rec>(options: Options, vmType: VmType, request: T): Promise<any> {
    const { billing_term: term, windows_license: license, billing_catalog: given, ...body } = request;
    let catalog = rec(given);
    if (!catalog) {
        const plan = await findPlan(options, vmType, body.workspace_id, body.site_id, body.plan_id);
        catalog = rec(plan?.billing_catalog);
    }
    if (catalog && (term || catalog.billing_interval == null)) catalog = selectTerm(catalog, term);
    let reservedIp: unknown;
    if (body.reserved_public_ip_id && !rec(catalog?.attached_skus)?.reserved_ip) {
        const ip = await new ReservedIpsClient(options).getReservedIp({
            reserved_ip_id: body.reserved_public_ip_id,
            workspace_id: body.workspace_id,
        });
        reservedIp = rec(ip)?.billing_catalog;
    }
    const windows = license ? windowsLicense(license, term ?? catalog?.billing_interval, body.cpu) : undefined;
    return { ...body, billing_catalog: withAttached(catalog, { windows_license: windows, reserved_ip: reservedIp }) };
}

function vmDelete<T extends { body?: Rec }>(request: T): any {
    // Sent as given: no public_ip_action default. An omitted body is sent as {}.
    return { ...request, body: { ...request.body } };
}

async function vmAttach<T extends { workspace_id?: string; body: Rec }>(options: Options, request: T): Promise<any> {
    if (request.body.billing_catalog) return request;
    const volume = rec(
        await new BlockStorageClient(options).getBlockVolume({
            volume_id: request.body.volume_id,
            workspace_id: request.workspace_id,
        }),
    );
    const billing_catalog = rec(rec(volume?.metadata)?.billing_catalog);
    const { billing_catalog: _none, ...body } = request.body;
    return { ...request, body: billing_catalog ? { ...body, billing_catalog } : body };
}

const PAGE_SIZE = 100;
const MAX_ITEMS = 10_000;

/** Read pages of 100 until a short page, skipping items already seen (by `_id` / `id`). */
function allPages<T>(page: (limit: number, offset: number) => Pending<T[]>): Pending<T[]> {
    return core.HttpResponsePromise.fromPromise(
        (async () => {
            const seen = new Set<string>();
            const data: T[] = [];
            for (let offset = 0; ; ) {
                const { data: items, rawResponse } = await page(PAGE_SIZE, offset).withRawResponse();
                const list = Array.isArray(items) ? items : [];
                for (const item of list) {
                    const id = rec(item)?._id ?? rec(item)?.id;
                    if (id != null && seen.has(String(id))) continue;
                    if (id != null) seen.add(String(id));
                    data.push(item);
                }
                if (list.length < PAGE_SIZE || data.length >= MAX_ITEMS) {
                    return { data: data.slice(0, MAX_ITEMS), rawResponse };
                }
                offset += list.length;
            }
        })(),
    );
}
