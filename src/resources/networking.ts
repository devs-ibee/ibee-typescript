import type { HttpClient } from "../core.js";
import { BadRequestError, ForbiddenError, IbeeError, NotFoundError } from "../errors.js";
import { collect, paginateOffset } from "../pagination.js";
import { sleepMs } from "../polling.js";
import {
  BillingResource,
  LOAD_BALANCER_SKU_CODE,
  NAT_GATEWAY_SKU_CODE,
  RESERVED_IP_SKU_CODE,
} from "./billing.js";
import {
  IbeeValidationError,
  NAT_DELETE_IP_ACTIONS,
  NETWORK_CONNECTIVITY_MODES,
  RESERVED_IP_TARGET_UNSUPPORTED_MESSAGE,
  ReservedIpTargetUnsupportedError,
  VIRTUAL_IP_PURPOSES,
  assertNoDuplicateExternalPort,
  buildFirewallRuleBody,
  buildLoadBalancerBody,
  buildPortForwardingCreateBody,
  buildPortForwardingUpdateBody,
  buildSubnetCreateBody,
  buildSubnetUpdateBody,
  buildVpcCreateBody,
  buildVpcUpdateBody,
  isEligibleVipAnnouncer,
  isPrivateIpv4,
  loadBalancerListQuery,
  normaliseVmIdList,
  parseIpv4,
  reservedIpAttachmentKind,
  reservedIpReleaseBlockMessage,
  validateBoundedId,
  validateHostInSubnet,
  validateIntRange,
  validateLimitOffset,
  validateNetworkBillingCatalog,
  validateNodeConnectivity,
  validateOptionalText,
  validatePathId,
  validateRequiredId,
  validateReservedIpEligibleForService,
  validateReservedIpSiteId,
  validateResourceName,
  validateReverseDns,
  validateWorkspaceId,
  type LoadBalancerBodyInput,
  type NatDeleteIpAction,
  type VpcConnectivityType,
} from "../validation.js";
import type {
  FirewallAttachment,
  FirewallGroup,
  FirewallGroupSummary,
  FirewallRuleInput,
  LoadBalancer,
  LoadBalancerBackend,
  LoadBalancerHealthCheck,
  LoadBalancerLayer,
  LoadBalancerObservability,
  LoadBalancerPolicy,
  LoadBalancerProtocol,
  LoadBalancerRouting,
  LoadBalancerRule,
  LoadBalancerStatusResponse,
  LoadBalancerTls,
  NatGateway,
  NatPortForwardingRule,
  NetworkAllocation,
  NetworkingSite,
  ReservedIp,
  Subnet,
  TransportProtocol,
  VpcDetail,
  VpcSummary,
  VpcVirtualIp,
} from "../types.js";

const pathId = (value: string) => encodeURIComponent(value);
const vpcPath = (vpcId: string) => `/networking/vpcs/${pathId(validatePathId(vpcId, "vpc_id"))}`;
const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
const fail = (message: string, code: string, field?: string, details?: unknown): never => {
  throw new IbeeValidationError(message, code, field, details);
};

/** Emit a non-fatal billing warning (Node `process.emitWarning`, else console). */
function emitBillingWarning(message: string): void {
  const proc = (globalThis as { process?: { emitWarning?: (m: string, t?: string) => void } }).process;
  if (proc && typeof proc.emitWarning === "function") proc.emitWarning(message, "IbeeBillingWarning");
  else if (typeof console !== "undefined") console.warn(`IbeeBillingWarning: ${message}`);
}

export interface WaitForNatGatewayAbsentArgs {
  workspaceId: string;
  vpcId: string;
  natGatewayId: string;
  /** Polls (default 20). */
  attempts?: number;
  /** Delay between polls in ms (default 500). */
  intervalMs?: number;
  signal?: AbortSignal;
}

export class VpcsResource {
  private readonly billing: BillingResource;

  constructor(private readonly http: HttpClient) {
    this.billing = new BillingResource(http);
  }

  /**
   * List sites where VPCs can be created. With `availableOnly`, only sites
   * whose `available` is true are returned (pass their `site_id` to create).
   */
  async listSites(args: { workspaceId: string; availableOnly?: boolean }): Promise<NetworkingSite[]> {
    const sites = await this.http.request<NetworkingSite[]>({
      method: "GET",
      path: "/networking/sites",
      workspaceId: args.workspaceId,
    });
    return args.availableOnly && Array.isArray(sites) ? sites.filter((s) => s.available === true) : sites;
  }

  async list(args: { workspaceId: string; siteId?: string }): Promise<VpcSummary[]> {
    const siteId = args.siteId === undefined ? undefined : validateRequiredId(args.siteId, "site_id");
    return this.http.request({
      method: "GET",
      path: "/networking/vpcs",
      workspaceId: args.workspaceId,
      query: { site_id: siteId },
    });
  }

  /**
   * Create a VPC. Validated like the portal: name 1..80, description <= 500
   * (omitted when blank), site_id, a custom `cidr` must be RFC1918, aligned
   * and /22../28 (then `auto_cidr` is sent as false), `defaultSubnetCidr`
   * must sit inside `cidr`.
   *
   * `connectivityType`: `private` (portal default) or `nat_gateway` (managed
   * NAT). Omitted, the API default (`public`) applies. `public` is
   * @deprecated — the portal no longer creates public VPCs.
   *
   * `natBillingCatalog` (NAT-GATEWAY SKU from the IBEE billing catalog; build
   * it with `networkBillingCatalog`) is only allowed for `nat_gateway`. It is
   * not yet part of the published API contract; behaviour may change. Without
   * it a NAT VPC is created but its NAT gateway is not metered, and an
   * `IbeeBillingWarning` is emitted. VPC create is not billing-admitted at
   * the edge.
   *
   * `checkSite: true` first lists networking sites and requires the site to
   * be available.
   */
  async create(args: {
    workspaceId: string;
    name: string;
    siteId: string;
    description?: string;
    region?: string;
    cidr?: string;
    autoCidr?: boolean;
    createDefaultSubnet?: boolean;
    defaultSubnetCidr?: string;
    isDefault?: boolean;
    connectivityType?: VpcConnectivityType;
    natBillingCatalog?: Record<string, unknown>;
    checkSite?: boolean;
  }): Promise<VpcDetail> {
    validateWorkspaceId(args.workspaceId);
    const { workspaceId, checkSite, ...input } = args;
    const body = buildVpcCreateBody(input);
    if (checkSite) {
      const sites = await this.listSites({ workspaceId });
      const site = (Array.isArray(sites) ? sites : []).find((s) => s.site_id === body.site_id);
      if (!site) fail(`Site ${String(body.site_id)} does not support VPCs.`, "site_unavailable", "site_id");
      if (site && site.available !== true) {
        fail(site.message || `Site ${String(body.site_id)} is not available for VPCs.`, "site_unavailable", "site_id");
      }
    }
    if (body.connectivity_type === "nat_gateway" && !body.nat_billing_catalog) {
      emitBillingWarning(
        "The managed NAT gateway will be created without a billing catalog (natBillingCatalog), so it is not metered.",
      );
    }
    return this.http.request({ method: "POST", path: "/networking/vpcs", workspaceId, body });
  }

  get(args: { workspaceId: string; vpcId: string }): Promise<VpcDetail> {
    return this.http.request({ method: "GET", path: vpcPath(args.vpcId), workspaceId: args.workspaceId });
  }

  /** Update a VPC's name (1..80) and/or description (<= 500). At least one is required. */
  async update(args: { workspaceId: string; vpcId: string; name?: string; description?: string }): Promise<VpcDetail> {
    const { workspaceId, vpcId, ...input } = args;
    const body = buildVpcUpdateBody(input);
    return this.http.request({ method: "PATCH", path: vpcPath(vpcId), workspaceId, body });
  }

  /**
   * Delete a VPC (its subnets go with it).
   *
   * Like the portal (and the Python SDK) the VPC is read first by default:
   * attached nodes block the delete, and a NAT gateway blocks it unless
   * `deleteNatGateway: true`, in which case the gateway is deleted first
   * (with `natIpAction` and, to reserve a platform NAT IP,
   * `natBillingCatalog` = the RESERVED-IP SKU) and the SDK waits until it is
   * gone. `checkDependencies: true` also refuses while virtual IPs exist;
   * `checkDependencies: false` skips the read (unless `deleteNatGateway`).
   */
  async delete(args: {
    workspaceId: string;
    vpcId: string;
    checkDependencies?: boolean;
    deleteNatGateway?: boolean;
    natIpAction?: NatDeleteIpAction;
    /** RESERVED-IP billing catalog, needed to reserve a platform NAT IP (`natIpAction: "reserve"`). */
    natBillingCatalog?: Record<string, unknown>;
  }): Promise<void> {
    validateWorkspaceId(args.workspaceId);
    const path = vpcPath(args.vpcId);
    if (args.natBillingCatalog !== undefined && args.natBillingCatalog !== null) {
      if (lower(args.natIpAction) !== "reserve") {
        fail("natBillingCatalog is only allowed with natIpAction 'reserve'.", "invalid_billing_catalog", "nat_billing_catalog");
      }
      validateNetworkBillingCatalog(args.natBillingCatalog, "nat_billing_catalog");
    }
    if (args.checkDependencies !== false || args.deleteNatGateway) {
      const vpc = await this.get(args);
      const nodes = Math.max(Number(vpc.node_count ?? 0) || 0, (vpc.attached_nodes ?? []).length);
      if (nodes > 0) {
        fail(`Detach ${nodes} attached node(s) before deleting this VPC.`, "vpc_has_nodes", "vpc_id");
      }
      if (args.checkDependencies) {
        const vips = await this.listVirtualIps(args);
        if (Array.isArray(vips) && vips.length > 0) {
          fail("Delete all virtual IP reservations before deleting the VPC.", "vpc_has_virtual_ips", "vpc_id");
        }
      }
      const gateways = vpc.nat_gateways ?? [];
      if (gateways.length > 0) {
        if (!args.deleteNatGateway) {
          fail("Delete the NAT gateway first (or pass deleteNatGateway: true).", "vpc_has_nat_gateway", "vpc_id");
        }
        for (const gw of gateways) {
          await this.deleteNatGateway({
            workspaceId: args.workspaceId,
            vpcId: args.vpcId,
            natGatewayId: gw.nat_gateway_id,
            publicIpAction: args.natIpAction,
            billingCatalog: args.natBillingCatalog,
            wait: true,
          });
        }
      }
    }
    return this.http.request({ method: "DELETE", path, workspaceId: args.workspaceId });
  }

  listSubnets(args: { workspaceId: string; vpcId: string }): Promise<Subnet[]> {
    return this.http.request({ method: "GET", path: `${vpcPath(args.vpcId)}/subnets`, workspaceId: args.workspaceId });
  }

  /**
   * Create a subnet. Name 1..80; `cidr` must be RFC1918, aligned and /29 or
   * larger (then `auto_cidr` is sent as false); `prefixLength` (22..29) only
   * with automatic allocation; `dns` needs at least one IPv4 address.
   *
   * With `checkVpc` (default true) the SDK reads the VPC first, like the
   * portal: the CIDR must be a sub-range of the VPC CIDR that does not
   * overlap other subnets, `prefixLength` must not be shorter than the VPC
   * prefix, and at most 10 subnets exist per VPC.
   */
  async createSubnet(args: {
    workspaceId: string;
    vpcId: string;
    name: string;
    cidr?: string;
    autoCidr?: boolean;
    prefixLength?: number;
    dns?: string[];
    checkVpc?: boolean;
  }): Promise<Subnet> {
    validateWorkspaceId(args.workspaceId);
    const { workspaceId, vpcId, checkVpc, ...input } = args;
    const path = `${vpcPath(vpcId)}/subnets`;
    buildSubnetCreateBody(input);
    const vpc = checkVpc === false ? undefined : await this.get({ workspaceId, vpcId });
    const body = buildSubnetCreateBody(input, vpc);
    return this.http.request({ method: "POST", path, workspaceId, body });
  }

  getSubnet(args: { workspaceId: string; vpcId: string; subnetId: string }): Promise<Subnet> {
    return this.http.request({
      method: "GET",
      path: `${vpcPath(args.vpcId)}/subnets/${pathId(validatePathId(args.subnetId, "subnet_id"))}`,
      workspaceId: args.workspaceId,
    });
  }

  /** Update a subnet's name (1..80) and/or DNS servers (IPv4). At least one is required. */
  async updateSubnet(args: {
    workspaceId: string;
    vpcId: string;
    subnetId: string;
    name?: string;
    dns?: string[];
  }): Promise<Subnet> {
    const { workspaceId, vpcId, subnetId, ...input } = args;
    const body = buildSubnetUpdateBody(input);
    return this.http.request({
      method: "PATCH",
      path: `${vpcPath(vpcId)}/subnets/${pathId(validatePathId(subnetId, "subnet_id"))}`,
      workspaceId,
      body,
    });
  }

  deleteSubnet(args: { workspaceId: string; vpcId: string; subnetId: string }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `${vpcPath(args.vpcId)}/subnets/${pathId(validatePathId(args.subnetId, "subnet_id"))}`,
      workspaceId: args.workspaceId,
    });
  }

  listNodes(args: { workspaceId: string; vpcId: string }): Promise<NetworkAllocation[]> {
    return this.http.request({ method: "GET", path: `${vpcPath(args.vpcId)}/nodes`, workspaceId: args.workspaceId });
  }

  /**
   * Create a VPC network allocation for a VM.
   *
   * `connectivity` omitted lets the API pick `nat` for NAT Gateway VPCs and
   * `private` otherwise. `reservedPublicIpId` only with `public_ip`.
   * `requestedPrivateIp` claims a specific host address (not yet part of the
   * published API contract; behaviour may change): the SDK reads the subnet
   * and requires a usable host that is not the gateway.
   *
   * `checkVpc: true` also reads the VPC and applies the portal connectivity
   * rules. This call allocates the address only; it does not plug a NIC into
   * the VM (the portal's VM-side attach is not public yet).
   */
  async attachNode(args: {
    workspaceId: string;
    vpcId: string;
    vmId: string;
    subnetId: string;
    connectivity?: "private" | "public_ip" | "nat";
    reservedPublicIpId?: string;
    requestedPrivateIp?: string;
    checkVpc?: boolean;
  }): Promise<NetworkAllocation> {
    validateWorkspaceId(args.workspaceId);
    const path = `${vpcPath(args.vpcId)}/nodes`;
    const vmId = validateBoundedId(args.vmId, "vm_id");
    if (!String(args.subnetId ?? "").trim()) fail("Choose a node and subnet.", "invalid_subnet_id", "subnet_id");
    const subnetId = validateBoundedId(args.subnetId, "subnet_id");
    let connectivity: string | undefined;
    if (args.connectivity !== undefined && args.connectivity !== null) {
      connectivity = lower(args.connectivity);
      if (!(NETWORK_CONNECTIVITY_MODES as readonly string[]).includes(connectivity)) {
        fail(`connectivity must be one of ${NETWORK_CONNECTIVITY_MODES.join(", ")}.`, "invalid_connectivity", "connectivity");
      }
    }
    let reservedPublicIpId: string | undefined;
    if (args.reservedPublicIpId !== undefined && args.reservedPublicIpId !== null) {
      reservedPublicIpId = validateRequiredId(args.reservedPublicIpId, "reserved_public_ip_id");
      if (connectivity !== "public_ip") {
        fail("reserved_public_ip_id is only valid with public_ip connectivity.", "invalid_network", "reserved_public_ip_id");
      }
    }
    const requested = String(args.requestedPrivateIp ?? "").trim() || undefined;
    if (requested && parseIpv4(requested) === null) {
      fail("Enter a valid IPv4 address.", "invalid_private_ip", "requested_private_ip");
    }
    if (args.checkVpc) {
      const vpc = await this.get(args);
      validateNodeConnectivity(vpc, connectivity, reservedPublicIpId);
    }
    if (requested) {
      const subnet = await this.getSubnet({ workspaceId: args.workspaceId, vpcId: args.vpcId, subnetId });
      validateHostInSubnet(requested, subnet.cidr, subnet.gateway, "requested_private_ip");
    }
    return this.http.request({
      method: "POST",
      path,
      workspaceId: args.workspaceId,
      body: {
        vm_id: vmId,
        subnet_id: subnetId,
        connectivity,
        reserved_public_ip_id: reservedPublicIpId,
        ...(requested ? { requested_private_ip: requested } : {}),
      },
    });
  }

  /**
   * Release a VM's VPC allocation. A VM whose NIC is plugged in answers 409
   * until its VM-side networking is removed (that VM-side detach is not
   * public yet).
   */
  detachNode(args: { workspaceId: string; vpcId: string; vmId: string }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `${vpcPath(args.vpcId)}/nodes/${pathId(validatePathId(args.vmId, "vm_id"))}`,
      workspaceId: args.workspaceId,
    });
  }

  listNatGateways(args: { workspaceId: string; vpcId: string }): Promise<NatGateway[]> {
    return this.http.request({
      method: "GET",
      path: `${vpcPath(args.vpcId)}/nat-gateways`,
      workspaceId: args.workspaceId,
    });
  }

  private async findNatGateway(workspaceId: string, vpcId: string, natGatewayId: string): Promise<NatGateway> {
    const gateways = await this.listNatGateways({ workspaceId, vpcId });
    const gw = (Array.isArray(gateways) ? gateways : []).find((g) => g.nat_gateway_id === natGatewayId);
    if (!gw) {
      throw new NotFoundError(404, { detail: `NAT gateway ${natGatewayId} was not found` });
    }
    return gw;
  }

  /**
   * Create (or restore) the VPC's managed NAT gateway. The edge runs billing
   * admission (SKU NAT-GATEWAY).
   *
   * - `validateVpc` (default true) reads the VPC and requires a
   *   `nat_gateway` VPC; with `reservedPublicIpId` it also checks the Reserved
   *   IP is in the VPC's site, unattached and reserved (skipped when the VPC
   *   already has a NAT gateway, so an idempotent retry is not refused).
   * - `billingCatalog` (NAT-GATEWAY SKU; not yet part of the published API
   *   contract) makes the gateway metered. Without it an
   *   `IbeeBillingWarning` is emitted.
   * - `preflightBilling: true` runs the portal eligibility check first.
   *
   * The call is idempotent: an existing gateway is returned (or repaired).
   */
  async createNatGateway(args: {
    workspaceId: string;
    vpcId: string;
    subnetId?: string;
    reservedPublicIpId?: string;
    name?: string;
    billingCatalog?: Record<string, unknown>;
    validateVpc?: boolean;
    preflightBilling?: boolean;
  }): Promise<NatGateway> {
    validateWorkspaceId(args.workspaceId);
    const path = `${vpcPath(args.vpcId)}/nat-gateways`;
    const name = args.name === undefined || args.name === null ? undefined : validateResourceName(args.name, "name", 80, "name");
    const subnetId = args.subnetId === undefined || args.subnetId === null ? undefined : validateRequiredId(args.subnetId, "subnet_id");
    const reservedPublicIpId =
      args.reservedPublicIpId === undefined || args.reservedPublicIpId === null
        ? undefined
        : validateRequiredId(args.reservedPublicIpId, "reserved_public_ip_id");
    const billingCatalog =
      args.billingCatalog === undefined || args.billingCatalog === null
        ? undefined
        : validateNetworkBillingCatalog(args.billingCatalog, "billing_catalog");
    if (args.validateVpc !== false) {
      const vpc = await this.get(args);
      if (lower(vpc.connectivity_type) !== "nat_gateway") {
        fail("NAT gateways can only be created for nat_gateway VPCs.", "vpc_not_nat_gateway", "vpc_id");
      }
      if (reservedPublicIpId && (vpc.nat_gateways ?? []).length === 0) {
        const rip = await this.http.request<ReservedIp>({
          method: "GET",
          path: `/networking/reserved-ips/${pathId(reservedPublicIpId)}`,
          workspaceId: args.workspaceId,
        });
        validateReservedIpEligibleForService(rip, vpc.site_id);
      }
    }
    if (args.preflightBilling) {
      await this.billing.requireResourceEligibility({
        workspaceId: args.workspaceId,
        skuCode: NAT_GATEWAY_SKU_CODE,
        resourceType: "nat_gateway",
      });
    }
    if (!billingCatalog) {
      emitBillingWarning("The NAT gateway will be created without a billing catalog (billingCatalog), so it is not metered.");
    }
    return this.http.request({
      method: "POST",
      path,
      workspaceId: args.workspaceId,
      body: {
        subnet_id: subnetId,
        reserved_public_ip_id: reservedPublicIpId,
        name,
        ...(billingCatalog ? { billing_catalog: billingCatalog } : {}),
      },
    });
  }

  /**
   * Delete a NAT gateway. Its port-forwarding rules are deleted and NAT
   * nodes fall back to private connectivity.
   *
   * `publicIpAction` (not yet part of the published API contract):
   * `reserve` keeps the address as a Reserved IP, `release` returns it.
   * Omitted, a platform address is released and a customer Reserved IP goes
   * back to reserved. Reserving a platform address needs `billingCatalog`
   * (RESERVED-IP SKU); the SDK reads the gateway to check this. Use
   * `defaultNatDeleteIpAction` for the portal default.
   *
   * `checkDependencies: true` refuses while a virtual IP still has a Reserved
   * IP. `wait: true` polls until the gateway is gone (20 x 0.5 s) and throws
   * `IbeeError` (code `nat_gateway_deleting`, not a validation error: the
   * DELETE was already accepted) if it is still there.
   */
  async deleteNatGateway(args: {
    workspaceId: string;
    vpcId: string;
    natGatewayId: string;
    publicIpAction?: NatDeleteIpAction;
    billingCatalog?: Record<string, unknown>;
    checkDependencies?: boolean;
    wait?: boolean;
  }): Promise<void> {
    validateWorkspaceId(args.workspaceId);
    const natGatewayId = validateRequiredId(args.natGatewayId, "nat_gateway_id");
    const path = `${vpcPath(args.vpcId)}/nat-gateways/${pathId(natGatewayId)}`;
    let action: string | undefined;
    if (args.publicIpAction !== undefined && args.publicIpAction !== null) {
      action = lower(args.publicIpAction);
      if (!(NAT_DELETE_IP_ACTIONS as readonly string[]).includes(action)) {
        fail("public_ip_action must be reserve or release.", "invalid_public_ip_action", "public_ip_action");
      }
    }
    let billingCatalog: Record<string, unknown> | undefined;
    if (args.billingCatalog !== undefined && args.billingCatalog !== null) {
      if (action !== "reserve") {
        fail("billing_catalog is only allowed with public_ip_action 'reserve'.", "invalid_billing_catalog", "billing_catalog");
      }
      billingCatalog = validateNetworkBillingCatalog(args.billingCatalog, "billing_catalog");
    }
    if (action === "reserve" && !billingCatalog) {
      const gw = await this.findNatGateway(args.workspaceId, args.vpcId, natGatewayId);
      if (String(gw.public_ip_source ?? "") !== "reserved") {
        fail(
          "Reserving a platform NAT IP requires the RESERVED-IP billing_catalog.",
          "billing_catalog_required",
          "billing_catalog",
        );
      }
    }
    if (args.checkDependencies) {
      const vips = await this.listVirtualIps(args);
      if ((Array.isArray(vips) ? vips : []).some((v) => String(v.public_ip_id ?? "").trim())) {
        fail(
          "Detach virtual-IP Reserved Public IPs before deleting the NAT gateway.",
          "virtual_ip_has_reserved_ip",
          "nat_gateway_id",
        );
      }
    }
    const body =
      action || billingCatalog
        ? { ...(action ? { public_ip_action: action } : {}), ...(billingCatalog ? { billing_catalog: billingCatalog } : {}) }
        : undefined;
    await this.http.request({ method: "DELETE", path, workspaceId: args.workspaceId, body });
    if (args.wait) {
      const gone = await this.waitForNatGatewayAbsent({
        workspaceId: args.workspaceId,
        vpcId: args.vpcId,
        natGatewayId,
      });
      if (!gone) {
        throw new IbeeError("NAT gateway deletion is still reconciling; check again shortly.", "nat_gateway_deleting");
      }
    }
  }

  /**
   * Poll the VPC until the NAT gateway is no longer listed (a 404 for the
   * VPC counts as gone). Returns false after the last attempt.
   */
  async waitForNatGatewayAbsent(args: WaitForNatGatewayAbsentArgs): Promise<boolean> {
    const attempts = args.attempts ?? 20;
    const intervalMs = args.intervalMs ?? 500;
    validateIntRange(attempts, "attempts", 1, 10_000);
    for (let i = 0; i < attempts; i += 1) {
      try {
        const vpc = await this.get(args);
        if (!(vpc.nat_gateways ?? []).some((g) => g.nat_gateway_id === args.natGatewayId)) return true;
      } catch (err) {
        if (err instanceof NotFoundError) return true;
        throw err;
      }
      if (i < attempts - 1) await sleepMs(intervalMs, args.signal);
    }
    return false;
  }

  /**
   * Swap the NAT gateway's public IP to a customer Reserved IP. Forwarding
   * rules are kept; a previous platform IP is released and a previous
   * Reserved IP goes back to reserved.
   *
   * Not yet part of the published API contract; behaviour may change.
   *
   * `checkState: true` first requires the gateway to be available and the
   * Reserved IP to be reserved, unattached and in the VPC's site.
   */
  async replaceNatGatewayPublicIp(args: {
    workspaceId: string;
    vpcId: string;
    natGatewayId: string;
    reservedPublicIpId: string;
    checkState?: boolean;
  }): Promise<NatGateway> {
    validateWorkspaceId(args.workspaceId);
    const natGatewayId = validateRequiredId(args.natGatewayId, "nat_gateway_id");
    const path = `${vpcPath(args.vpcId)}/nat-gateways/${pathId(natGatewayId)}/public-ip`;
    const reservedPublicIpId = validateRequiredId(args.reservedPublicIpId, "reserved_public_ip_id");
    if (args.checkState) {
      const gw = await this.findNatGateway(args.workspaceId, args.vpcId, natGatewayId);
      if (lower(gw.status) !== "available") {
        fail("An active NAT gateway is required.", "nat_gateway_unavailable", "nat_gateway_id");
      }
      const vpc = await this.get(args);
      const rip = await this.http.request<ReservedIp>({
        method: "GET",
        path: `/networking/reserved-ips/${pathId(reservedPublicIpId)}`,
        workspaceId: args.workspaceId,
      });
      validateReservedIpEligibleForService(rip, vpc.site_id);
    }
    return this.http.request({
      method: "PUT",
      path,
      workspaceId: args.workspaceId,
      body: { reserved_public_ip_id: reservedPublicIpId },
    });
  }

  listPortForwardingRules(args: {
    workspaceId: string;
    vpcId: string;
    natGatewayId: string;
  }): Promise<NatPortForwardingRule[]> {
    return this.http.request({
      method: "GET",
      path: `${vpcPath(args.vpcId)}/nat-gateways/${pathId(validatePathId(args.natGatewayId, "nat_gateway_id"))}/port-forwarding-rules`,
      workspaceId: args.workspaceId,
    });
  }

  private async requireAvailableGateway(workspaceId: string, vpcId: string, natGatewayId: string): Promise<void> {
    const gw = await this.findNatGateway(workspaceId, vpcId, natGatewayId);
    if (lower(gw.status) !== "available") {
      fail("An active NAT gateway is required.", "nat_gateway_unavailable", "nat_gateway_id");
    }
  }

  private async checkPortForwardTarget(
    workspaceId: string,
    vpcId: string,
    natGatewayId: string,
    body: Record<string, unknown>,
    fillTargets: boolean,
  ): Promise<void> {
    const internalIp = String(body.internal_ip);
    if (body.target_type === "vm") {
      const nodes = await this.listNodes({ workspaceId, vpcId });
      const ok = (Array.isArray(nodes) ? nodes : []).some(
        (n) =>
          n.connectivity === "nat" &&
          n.private_ip === internalIp &&
          (!n.nat_gateway_id || n.nat_gateway_id === natGatewayId),
      );
      if (!ok) {
        fail(
          "internal_ip must be the private IP of a NAT-connected VM on this gateway.",
          "invalid_internal_ip",
          "internal_ip",
        );
      }
      return;
    }
    const vips = await this.listVirtualIps({ workspaceId, vpcId });
    const vip = (Array.isArray(vips) ? vips : []).find(
      (v) =>
        v.private_ip === internalIp &&
        v.purpose === "metallb" &&
        lower(v.status) === "available" &&
        (v.announcer_vm_ids ?? []).length > 0,
    );
    if (!vip) {
      fail("internal_ip must match an available MetalLB virtual IP in this VPC.", "invalid_internal_ip", "internal_ip");
    }
    const announcers = (vip as VpcVirtualIp).announcer_vm_ids;
    const targets = body.target_vm_ids as string[] | undefined;
    if (fillTargets && (!targets || targets.length === 0)) {
      body.target_vm_ids = [...announcers];
      return;
    }
    if (!targets || targets.length === 0) {
      fail("Select at least one MetalLB announcer node.", "invalid_target_vm_ids", "target_vm_ids");
    }
    const same = (targets as string[]).length === announcers.length && (targets as string[]).every((t) => announcers.includes(t));
    if (!same) {
      fail("target_vm_ids must match the virtual IP's announcer VMs.", "invalid_target_vm_ids", "target_vm_ids");
    }
  }

  /**
   * Create a NAT port-forwarding rule (single ports only; defaults: tcp,
   * target `vm`, enabled). `targetType`/`targetVmIds` are not yet part of the
   * published API contract; behaviour may change.
   *
   * With `checkState` (default true) the SDK applies the portal checks: the
   * gateway must be available, (protocol, external port) must be unused on
   * it, a `vm` target must be a NAT-connected VM on this gateway, and a
   * `vip` target must be an available MetalLB virtual IP (its announcers
   * fill `targetVmIds` when omitted).
   */
  async createPortForwardingRule(args: {
    workspaceId: string;
    vpcId: string;
    natGatewayId: string;
    name: string;
    externalPort: number;
    internalIp: string;
    internalPort: number;
    protocol?: TransportProtocol;
    targetType?: "vm" | "vip";
    targetVmIds?: string[];
    note?: string;
    enabled?: boolean;
    checkState?: boolean;
  }): Promise<NatPortForwardingRule> {
    validateWorkspaceId(args.workspaceId);
    const natGatewayId = validateRequiredId(args.natGatewayId, "nat_gateway_id");
    const path = `${vpcPath(args.vpcId)}/nat-gateways/${pathId(natGatewayId)}/port-forwarding-rules`;
    const { workspaceId, vpcId, checkState } = args;
    const body = buildPortForwardingCreateBody(args);
    if (checkState !== false) {
      await this.requireAvailableGateway(workspaceId, vpcId, natGatewayId);
      const rules = await this.listPortForwardingRules({ workspaceId, vpcId, natGatewayId });
      assertNoDuplicateExternalPort(
        (Array.isArray(rules) ? rules : []) as unknown as Array<Record<string, unknown>>,
        String(body.protocol),
        body.external_port as number,
      );
      await this.checkPortForwardTarget(workspaceId, vpcId, natGatewayId, body, true);
    } else if (body.target_type === "vip" && (body.target_vm_ids as string[]).length === 0) {
      fail("Select at least one MetalLB announcer node.", "invalid_target_vm_ids", "target_vm_ids");
    }
    return this.http.request({ method: "POST", path, workspaceId, body });
  }

  /**
   * Update, enable or disable a port-forwarding rule. Setting `targetType:
   * "vm"` sends `target_vm_ids: []`; `targetVmIds` needs `targetType`.
   *
   * With `checkState` (default true): a changed protocol or external port is
   * checked for duplicates on the gateway, enabling needs an available
   * gateway, and a changed target is checked like create.
   */
  async updatePortForwardingRule(args: {
    workspaceId: string;
    vpcId: string;
    natGatewayId: string;
    portForwardingRuleId: string;
    name?: string;
    protocol?: TransportProtocol;
    externalPort?: number;
    internalIp?: string;
    internalPort?: number;
    targetType?: "vm" | "vip";
    targetVmIds?: string[];
    note?: string;
    enabled?: boolean;
    checkState?: boolean;
  }): Promise<NatPortForwardingRule> {
    validateWorkspaceId(args.workspaceId);
    const natGatewayId = validateRequiredId(args.natGatewayId, "nat_gateway_id");
    const ruleId = validateRequiredId(args.portForwardingRuleId, "port_forwarding_rule_id");
    const path = `${vpcPath(args.vpcId)}/nat-gateways/${pathId(natGatewayId)}/port-forwarding-rules/${pathId(ruleId)}`;
    const { workspaceId, vpcId, checkState } = args;
    const body = buildPortForwardingUpdateBody(args);
    if (checkState !== false) {
      if (body.enabled === true) await this.requireAvailableGateway(workspaceId, vpcId, natGatewayId);
      const needsRules =
        body.protocol !== undefined || body.external_port !== undefined ||
        body.target_type !== undefined || body.internal_ip !== undefined;
      if (needsRules) {
        const rules = ((await this.listPortForwardingRules({ workspaceId, vpcId, natGatewayId })) ?? []) as unknown as Array<
          Record<string, unknown>
        >;
        const current = rules.find(
          (r) => String(r.port_forward_rule_id ?? r.port_forwarding_rule_id ?? r.rule_id ?? "") === ruleId,
        );
        if (!current) throw new NotFoundError(404, { detail: `Port forwarding rule ${ruleId} was not found` });
        if (body.protocol !== undefined || body.external_port !== undefined) {
          assertNoDuplicateExternalPort(
            rules,
            String(body.protocol ?? current.protocol ?? "tcp").toLowerCase(),
            Number(body.external_port ?? current.external_port),
            ruleId,
          );
        }
        if (body.target_type !== undefined || body.internal_ip !== undefined) {
          const merged: Record<string, unknown> = {
            target_type: body.target_type ?? current.target_type ?? "vm",
            internal_ip: body.internal_ip ?? current.internal_ip,
            target_vm_ids: body.target_vm_ids ?? (body.target_type === undefined ? current.target_vm_ids : undefined),
          };
          await this.checkPortForwardTarget(workspaceId, vpcId, natGatewayId, merged, body.target_type === "vip");
          if (body.target_type === "vip" && body.target_vm_ids === undefined) body.target_vm_ids = merged.target_vm_ids;
        }
      }
    } else if (body.target_type === "vip" && !((body.target_vm_ids as string[] | undefined) ?? []).length) {
      // Without the read the announcers cannot be filled in; the API would
      // fail the merged rule.
      fail("Select at least one MetalLB announcer node.", "invalid_target_vm_ids", "target_vm_ids");
    }
    return this.http.request({ method: "PATCH", path, workspaceId, body });
  }

  deletePortForwardingRule(args: {
    workspaceId: string;
    vpcId: string;
    natGatewayId: string;
    portForwardingRuleId: string;
  }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `${vpcPath(args.vpcId)}/nat-gateways/${pathId(validatePathId(args.natGatewayId, "nat_gateway_id"))}/port-forwarding-rules/${pathId(validatePathId(args.portForwardingRuleId, "port_forwarding_rule_id"))}`,
      workspaceId: args.workspaceId,
    });
  }

  /**
   * List the VPC's virtual IPs (MetalLB / custom).
   * Not yet part of the published API contract; behaviour may change.
   */
  listVirtualIps(args: { workspaceId: string; vpcId: string }): Promise<VpcVirtualIp[]> {
    return this.http.request({ method: "GET", path: `${vpcPath(args.vpcId)}/virtual-ips`, workspaceId: args.workspaceId });
  }

  /**
   * Get one virtual IP (read from the list; there is no single-item route).
   * Throws NotFoundError when it does not exist.
   * Not yet part of the published API contract; behaviour may change.
   */
  async getVirtualIp(args: { workspaceId: string; vpcId: string; virtualIpId: string }): Promise<VpcVirtualIp> {
    const id = validateRequiredId(args.virtualIpId, "virtual_ip_id");
    const vips = await this.listVirtualIps(args);
    const vip = (Array.isArray(vips) ? vips : []).find((v) => v.virtual_ip_id === id);
    if (!vip) throw new NotFoundError(404, { detail: `Virtual IP ${id} was not found` });
    return vip;
  }

  /**
   * Reserve a private virtual IP in a VPC subnet (portal: MetalLB).
   *
   * `privateIp` must be a usable private host in the subnet (not the network,
   * broadcast or gateway address). `purpose` defaults to `metallb`, which
   * needs at least one `announcerVmIds` (at most 32).
   *
   * With `checkState` (default true) the SDK reads the subnet and the VPC
   * nodes: every announcer must be a NAT-connected, usable node in the same
   * subnet.
   *
   * Not yet part of the published API contract; behaviour may change.
   */
  async createVirtualIp(args: {
    workspaceId: string;
    vpcId: string;
    subnetId: string;
    privateIp: string;
    purpose?: "metallb" | "custom";
    announcerVmIds?: string[];
    checkState?: boolean;
  }): Promise<VpcVirtualIp> {
    validateWorkspaceId(args.workspaceId);
    const path = `${vpcPath(args.vpcId)}/virtual-ips`;
    const subnetId = validateBoundedId(args.subnetId, "subnet_id");
    const privateIp = String(args.privateIp ?? "").trim();
    if (!privateIp) fail("Enter a private IPv4 address.", "invalid_private_ip", "private_ip");
    if (parseIpv4(privateIp) === null || !isPrivateIpv4(privateIp)) {
      fail("Virtual IP must be a private IPv4 address.", "invalid_private_ip", "private_ip");
    }
    const purpose = args.purpose === undefined || args.purpose === null ? "metallb" : lower(args.purpose);
    if (!(VIRTUAL_IP_PURPOSES as readonly string[]).includes(purpose)) {
      fail("purpose must be metallb or custom.", "invalid_purpose", "purpose");
    }
    const announcers = normaliseVmIdList(args.announcerVmIds, "announcer_vm_ids");
    if (purpose === "metallb" && announcers.length === 0) {
      fail("Select at least one NAT-connected announcer node.", "invalid_announcer_vm_ids", "announcer_vm_ids");
    }
    if (args.checkState !== false) {
      const subnet = await this.getSubnet({ workspaceId: args.workspaceId, vpcId: args.vpcId, subnetId });
      validateHostInSubnet(privateIp, subnet.cidr, subnet.gateway, "private_ip");
      if (announcers.length) {
        const nodes = (await this.listNodes(args)) ?? [];
        for (const id of announcers) {
          const node = nodes.find((n) => n.vm_id === id && isEligibleVipAnnouncer(n as Record<string, unknown>, subnetId));
          if (!node) {
            fail(
              `Announcer ${id} must be a NAT-connected node in subnet ${subnetId}.`,
              "invalid_announcer_vm_ids",
              "announcer_vm_ids",
            );
          }
        }
      }
    }
    return this.http.request({
      method: "POST",
      path,
      workspaceId: args.workspaceId,
      body: { subnet_id: subnetId, private_ip: privateIp, purpose, announcer_vm_ids: announcers },
    });
  }

  /**
   * Release a virtual IP reservation.
   *
   * With `checkState` (default true) the SDK refuses while a Reserved IP is
   * attached to it or a port-forwarding rule targets it.
   *
   * Not yet part of the published API contract; behaviour may change.
   */
  async deleteVirtualIp(args: {
    workspaceId: string;
    vpcId: string;
    virtualIpId: string;
    checkState?: boolean;
  }): Promise<void> {
    validateWorkspaceId(args.workspaceId);
    const id = validateRequiredId(args.virtualIpId, "virtual_ip_id");
    const path = `${vpcPath(args.vpcId)}/virtual-ips/${pathId(id)}`;
    if (args.checkState !== false) {
      const vip = await this.getVirtualIp(args);
      if (String(vip.public_ip_id ?? "").trim()) {
        fail("Detach the Reserved IP before deleting this reservation.", "virtual_ip_has_reserved_ip", "virtual_ip_id");
      }
      const gateways = (await this.listNatGateways(args)) ?? [];
      for (const gw of gateways) {
        const rules = (await this.listPortForwardingRules({ ...args, natGatewayId: gw.nat_gateway_id })) ?? [];
        if (rules.some((r) => r.internal_ip === vip.private_ip)) {
          fail(
            "Delete port-forwarding rules that target this virtual IP first.",
            "virtual_ip_has_rules",
            "virtual_ip_id",
          );
        }
      }
    }
    return this.http.request({ method: "DELETE", path, workspaceId: args.workspaceId });
  }
}

/**
 * Poll until a NAT gateway is gone (same as
 * `client.vpcs.waitForNatGatewayAbsent(args)`).
 */
export function waitForNatGatewayAbsent(
  client: { vpcs: VpcsResource },
  args: WaitForNatGatewayAbsentArgs,
): Promise<boolean> {
  return client.vpcs.waitForNatGatewayAbsent(args);
}

const ripPath = (id: string) => `/networking/reserved-ips/${pathId(validatePathId(id, "reserved_ip_id"))}`;

function mapReservedIpTargetError(err: unknown): never {
  if (err instanceof NotFoundError && /require a VPC network allocation/i.test(err.message)) {
    throw new ReservedIpTargetUnsupportedError(RESERVED_IP_TARGET_UNSUPPORTED_MESSAGE, err);
  }
  throw err;
}

function reservedIpBillingCatalog(catalog: unknown): Record<string, unknown> | undefined {
  if (catalog === undefined || catalog === null) return undefined;
  return validateNetworkBillingCatalog(catalog, "billing_catalog", { requireSkuId: true, portalKeysOnly: true });
}

function targetBody(args: { vmId: string; vpcId?: string; subnetId?: string }): Record<string, unknown> {
  const vmId = validateBoundedId(args.vmId, "vm_id");
  const vpcId = args.vpcId === undefined || args.vpcId === null ? undefined : validateRequiredId(args.vpcId, "vpc_id");
  const subnetId = args.subnetId === undefined || args.subnetId === null ? undefined : validateRequiredId(args.subnetId, "subnet_id");
  return { vm_id: vmId, vpc_id: vpcId, subnet_id: subnetId };
}

export class ReservedIpsResource {
  private readonly billing: BillingResource;

  constructor(private readonly http: HttpClient) {
    this.billing = new BillingResource(http);
  }

  async list(args: { workspaceId: string; siteId?: string }): Promise<ReservedIp[]> {
    const siteId = args.siteId === undefined || args.siteId === null ? undefined : validateBoundedId(args.siteId, "site_id", 120);
    return this.http.request({
      method: "GET",
      path: "/networking/reserved-ips",
      workspaceId: args.workspaceId,
      query: { site_id: siteId },
    });
  }

  /**
   * Reserve a new public IPv4 address in a site. The edge runs billing
   * admission (SKU RESERVED-IP) and answers 402 (`BillingDeniedError`) when
   * billing does not approve.
   *
   * `label` is trimmed (max 120). `billingCatalog` (RESERVED-IP SKU from the
   * IBEE billing catalog, which is not yet public; build it with
   * `networkBillingCatalog`) needs `sku_code` and `sku_id`; the field is not
   * yet part of the published API contract. `checkBilling: true` runs the
   * portal's eligibility preflight first.
   */
  async reserve(args: {
    workspaceId: string;
    siteId: string;
    label?: string;
    billingCatalog?: Record<string, unknown>;
    checkBilling?: boolean;
  }): Promise<ReservedIp> {
    validateWorkspaceId(args.workspaceId);
    const siteId = validateReservedIpSiteId(args.siteId);
    const label = validateOptionalText(args.label, "label", 120);
    const billingCatalog = reservedIpBillingCatalog(args.billingCatalog);
    if (args.checkBilling) {
      await this.billing.requireResourceEligibility({
        workspaceId: args.workspaceId,
        skuCode: RESERVED_IP_SKU_CODE,
        resourceType: "reserved_ip",
      });
    }
    return this.http.request({
      method: "POST",
      path: "/networking/reserved-ips",
      workspaceId: args.workspaceId,
      body: { site_id: siteId, label, ...(billingCatalog ? { billing_catalog: billingCatalog } : {}) },
    });
  }

  get(args: { workspaceId: string; reservedIpId: string }): Promise<ReservedIp> {
    return this.http.request({ method: "GET", path: ripPath(args.reservedIpId), workspaceId: args.workspaceId });
  }

  /**
   * Edit the label (max 120) and/or reverse DNS (a valid hostname; an empty
   * string clears it). At least one is required.
   */
  async update(args: {
    workspaceId: string;
    reservedIpId: string;
    label?: string;
    reverseDns?: string;
  }): Promise<ReservedIp> {
    const { workspaceId, reservedIpId } = args;
    const body: Record<string, unknown> = {};
    if (args.label !== undefined && args.label !== null) body.label = validateOptionalText(args.label, "label", 120);
    if (args.reverseDns !== undefined && args.reverseDns !== null) body.reverse_dns = validateReverseDns(args.reverseDns);
    if (Object.keys(body).length === 0) {
      fail("At least one Reserved IP field must be provided.", "no_changes");
    }
    return this.http.request({ method: "PATCH", path: ripPath(reservedIpId), workspaceId, body });
  }

  /**
   * Release a Reserved IP. With `checkAttached` (default true) the SDK reads
   * it first and refuses while it is attached, like the portal.
   */
  async release(args: { workspaceId: string; reservedIpId: string; checkAttached?: boolean }): Promise<void> {
    validateWorkspaceId(args.workspaceId);
    const path = ripPath(args.reservedIpId);
    if (args.checkAttached !== false) {
      const ip = await this.get(args);
      const message = reservedIpReleaseBlockMessage(ip);
      if (message) fail(message, "reserved_ip_attached", "reserved_ip_id");
    }
    return this.http.request({ method: "DELETE", path, workspaceId: args.workspaceId });
  }

  /**
   * Attach a Reserved IP to a VPC-attached VM (`vpcId` and `subnetId` are
   * required when the VM has several VPC attachments).
   *
   * With `checkState` (default true) the SDK reads the IP first: an IP on a
   * VM must be moved instead, and an IP on a NAT gateway or virtual IP needs
   * `detachFromService: true` (the SDK detaches it first, as the portal
   * does). A VM without a VPC attachment raises
   * `ReservedIpTargetUnsupportedError`.
   */
  async attach(args: {
    workspaceId: string;
    reservedIpId: string;
    vmId: string;
    vpcId?: string;
    subnetId?: string;
    detachFromService?: boolean;
    checkState?: boolean;
  }): Promise<ReservedIp> {
    validateWorkspaceId(args.workspaceId);
    const path = `${ripPath(args.reservedIpId)}/attach`;
    const body = targetBody(args);
    if (args.checkState !== false) {
      const ip = await this.get(args);
      const kind = reservedIpAttachmentKind(ip);
      if (kind === "nat_gateway" || kind === "vpc_virtual_ip") {
        if (!args.detachFromService) {
          fail(
            `Reserved IP is attached to a ${kind === "nat_gateway" ? "NAT gateway" : "virtual IP"}; pass detachFromService: true to move it.`,
            "reserved_ip_attached_to_service",
            "reserved_ip_id",
          );
        }
        await this.http.request({ method: "POST", path: `${ripPath(args.reservedIpId)}/detach`, workspaceId: args.workspaceId });
      } else if (kind !== "none") {
        fail("Reserved IP is already attached; use move.", "reserved_ip_attached", "reserved_ip_id");
      }
    }
    try {
      return await this.http.request({ method: "POST", path, workspaceId: args.workspaceId, body });
    } catch (err) {
      return mapReservedIpTargetError(err);
    }
  }

  /**
   * Move an attached Reserved IP to another VPC-attached VM.
   *
   * With `checkState` (default true) the SDK reads the IP first: it must be
   * attached to a VM through a VPC allocation (NAT gateway / virtual IP,
   * converted and provider-network addresses cannot be moved), and the
   * target must differ from the current VM.
   */
  async move(args: {
    workspaceId: string;
    reservedIpId: string;
    vmId: string;
    vpcId?: string;
    subnetId?: string;
    checkState?: boolean;
  }): Promise<ReservedIp> {
    validateWorkspaceId(args.workspaceId);
    const path = `${ripPath(args.reservedIpId)}/move`;
    const body = targetBody(args);
    if (args.checkState !== false) {
      const ip = await this.get(args);
      const kind = reservedIpAttachmentKind(ip);
      if (kind === "none") fail("Reserved IP is not attached; use attach.", "reserved_ip_not_attached", "reserved_ip_id");
      if (kind === "nat_gateway" || kind === "vpc_virtual_ip") {
        fail(
          "Detach from the NAT gateway/VIP first or use attach with detachFromService: true.",
          "reserved_ip_attached_to_service",
          "reserved_ip_id",
        );
      }
      if (kind === "direct" || kind === "converted_active") {
        fail(
          "Moving a converted or provider-network Reserved IP is not supported; detach first.",
          "reserved_ip_not_movable",
          "reserved_ip_id",
        );
      }
      if (String(ip.attached_resource_id ?? "") === body.vm_id) {
        fail("The Reserved IP is already attached to that VM.", "reserved_ip_same_target", "vm_id");
      }
    }
    try {
      return await this.http.request({ method: "POST", path, workspaceId: args.workspaceId, body });
    } catch (err) {
      return mapReservedIpTargetError(err);
    }
  }

  /**
   * Detach a Reserved IP and keep it reserved. With `checkState` (default
   * true) an unattached IP is returned unchanged without a request, and a
   * converted address that is still the VM's active public IP is refused.
   */
  async detach(args: { workspaceId: string; reservedIpId: string; checkState?: boolean }): Promise<ReservedIp> {
    validateWorkspaceId(args.workspaceId);
    const path = `${ripPath(args.reservedIpId)}/detach`;
    if (args.checkState !== false) {
      const ip = await this.get(args);
      const kind = reservedIpAttachmentKind(ip);
      if (kind === "none") return ip;
      if (kind === "converted_active") {
        fail(
          "This converted address is still the VM's active public IP; delete or re-network the VM before detaching.",
          "reserved_ip_converted_active",
          "reserved_ip_id",
        );
      }
    }
    return this.http.request({ method: "POST", path, workspaceId: args.workspaceId });
  }

  /**
   * Convert a standalone (non-VPC) VM's current public IPv4 into a Reserved
   * IP, keeping the address. `siteId` must be the VM's site.
   *
   * The edge does not run billing admission on this route, so
   * `billingCheck` (default true) runs the RESERVED-IP eligibility preflight
   * first (needs the `billing.read` scope; pass `billingCheck: false` to
   * skip). `billingCatalog` follows the `reserve` rules.
   *
   * Not yet part of the published API contract; behaviour may change.
   */
  async convert(args: {
    workspaceId: string;
    vmId: string;
    siteId: string;
    label?: string;
    billingCatalog?: Record<string, unknown>;
    billingCheck?: boolean;
  }): Promise<ReservedIp> {
    validateWorkspaceId(args.workspaceId);
    if (!String(args.vmId ?? "").trim()) {
      fail("Choose an existing VM public IPv4 address to convert.", "invalid_vm_id", "vm_id");
    }
    const vmId = validateBoundedId(args.vmId, "vm_id");
    if (!String(args.siteId ?? "").trim()) {
      fail("The selected resource does not have a valid location.", "invalid_site_id", "site_id");
    }
    const siteId = validateReservedIpSiteId(args.siteId);
    const label = validateOptionalText(args.label, "label", 120);
    const billingCatalog = reservedIpBillingCatalog(args.billingCatalog);
    if (args.billingCheck !== false) {
      try {
        await this.billing.requireResourceEligibility({
          workspaceId: args.workspaceId,
          skuCode: RESERVED_IP_SKU_CODE,
          resourceType: "reserved_ip",
        });
      } catch (err) {
        if (err instanceof ForbiddenError) {
          throw new ForbiddenError(
            err.statusCode,
            err.body,
            "This check needs the billing.read scope; grant it or pass billingCheck: false to skip.",
            { headers: err.headers, code: err.code },
          );
        }
        throw err;
      }
    }
    return this.http.request({
      method: "POST",
      path: "/networking/reserved-ips/convert",
      workspaceId: args.workspaceId,
      body: {
        vm_id: vmId,
        site_id: siteId,
        ...(label !== undefined ? { label } : {}),
        ...(billingCatalog ? { billing_catalog: billingCatalog } : {}),
      },
    });
  }

  /**
   * Attach a customer Reserved IP to a VPC virtual IP (1:1 NAT). With
   * `checkState` (default true) the SDK first requires the IP to be
   * unattached.
   *
   * Not yet part of the published API contract; behaviour may change.
   */
  async attachVirtualIp(args: {
    workspaceId: string;
    reservedIpId: string;
    virtualIpId: string;
    checkState?: boolean;
  }): Promise<ReservedIp> {
    validateWorkspaceId(args.workspaceId);
    const path = `${ripPath(args.reservedIpId)}/attach-virtual-ip`;
    const virtualIpId = validateBoundedId(args.virtualIpId, "virtual_ip_id");
    if (args.checkState !== false) {
      const ip = await this.get(args);
      if (String(ip.attached_resource_id ?? "").trim()) {
        fail("That Reserved IP is not available; choose an unattached address.", "reserved_ip_attached", "reserved_ip_id");
      }
    }
    return this.http.request({
      method: "POST",
      path,
      workspaceId: args.workspaceId,
      body: { virtual_ip_id: virtualIpId },
    });
  }
}

const fwPath = (id: string) => `/networking/firewall-groups/${pathId(validatePathId(id, "firewall_group_id"))}`;

export class FirewallsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * List firewall groups. With no `limit`/`offset` every page is fetched
   * (100 per request) and de-duplicated; otherwise exactly one page is
   * returned. `limit` (1..100) and `offset` (>= 0) are not yet part of the
   * published API contract; behaviour may change.
   */
  async listGroups(args: {
    workspaceId: string;
    limit?: number;
    offset?: number;
  }): Promise<FirewallGroup[]> {
    validateWorkspaceId(args.workspaceId);
    validateLimitOffset(args, 100);
    if (args.limit === undefined && args.offset === undefined) {
      return collect(this.iterateGroups({ workspaceId: args.workspaceId }));
    }
    return this.http.request({
      method: "GET",
      path: "/networking/firewall-groups",
      workspaceId: args.workspaceId,
      query: { limit: args.limit, offset: args.offset },
    });
  }

  /** Every firewall group (all pages of `pageSize`, 1..100, default 100). */
  listAllGroups(args: { workspaceId: string; pageSize?: number }): Promise<FirewallGroup[]> {
    return collect(this.iterateGroups(args));
  }

  /** Iterate every firewall group, fetching pages of `pageSize` (1..100, default 100) on demand. */
  iterateGroups(args: { workspaceId: string; pageSize?: number }): AsyncIterable<FirewallGroup> {
    validateWorkspaceId(args.workspaceId);
    const pageSize = args.pageSize ?? 100;
    validateLimitOffset({ limit: pageSize }, 100);
    return paginateOffset<FirewallGroup>(
      (limit, offset) =>
        this.http.request<FirewallGroup[]>({
          method: "GET",
          path: "/networking/firewall-groups",
          workspaceId: args.workspaceId,
          query: { limit, offset },
        }),
      { pageSize, idKeys: ["firewall_group_id", "id"] },
    );
  }

  /**
   * One page of firewall group summaries (the portal list view: rule and VM
   * counts, no rules). The server default page size is 10.
   * Not yet part of the published API contract; behaviour may change.
   */
  async listGroupSummaries(args: { workspaceId: string; limit?: number; offset?: number }): Promise<FirewallGroupSummary[]> {
    validateWorkspaceId(args.workspaceId);
    validateLimitOffset(args, 100);
    return this.http.request({
      method: "GET",
      path: "/networking/firewall-groups",
      workspaceId: args.workspaceId,
      query: { summary: true, limit: args.limit, offset: args.offset },
    });
  }

  /**
   * Iterate every firewall group summary (pages of 100).
   * Not yet part of the published API contract; behaviour may change.
   */
  iterateGroupSummaries(args: { workspaceId: string }): AsyncIterable<FirewallGroupSummary> {
    validateWorkspaceId(args.workspaceId);
    return paginateOffset<FirewallGroupSummary>(
      (limit, offset) => this.listGroupSummaries({ workspaceId: args.workspaceId, limit, offset }),
      { pageSize: 100, idKeys: ["firewall_group_id"] },
    );
  }

  /**
   * Create a firewall group. The name is trimmed (1..120) and, with
   * `checkDuplicateName` (default true), must not match an existing group
   * name case-insensitively. `description` is sent only when non-blank.
   * `isDefault: true` is rejected: default groups are platform-managed.
   */
  async createGroup(args: {
    workspaceId: string;
    name: string;
    description?: string;
    /** @deprecated Must be false or omitted; never sent. */
    isDefault?: boolean;
    checkDuplicateName?: boolean;
  }): Promise<FirewallGroup> {
    validateWorkspaceId(args.workspaceId);
    const name = validateResourceName(args.name, "name", 120, "Firewall name");
    if (args.isDefault === true) {
      fail("is_default groups are platform-managed and cannot be created by customers.", "invalid_is_default", "is_default");
    }
    const description = validateOptionalText(args.description, "description", Number.MAX_SAFE_INTEGER);
    if (args.checkDuplicateName !== false) {
      const wanted = name.toLowerCase();
      for await (const group of this.iterateGroupSummaries(args)) {
        if (String(group.name ?? "").trim().toLowerCase() === wanted) {
          fail("A firewall group with this name already exists.", "duplicate_name", "name");
        }
      }
    }
    return this.http.request({
      method: "POST",
      path: "/networking/firewall-groups",
      workspaceId: args.workspaceId,
      body: { name, ...(description ? { description } : {}) },
    });
  }

  getGroup(args: { workspaceId: string; firewallGroupId: string }): Promise<FirewallGroup> {
    return this.http.request({ method: "GET", path: fwPath(args.firewallGroupId), workspaceId: args.workspaceId });
  }

  /**
   * Delete a firewall group. Attached VMs are detached automatically and get
   * the platform default group back.
   */
  deleteGroup(args: { workspaceId: string; firewallGroupId: string }): Promise<void> {
    return this.http.request({ method: "DELETE", path: fwPath(args.firewallGroupId), workspaceId: args.workspaceId });
  }

  /**
   * Add a rule. Defaults (portal): protocol tcp, direction ingress, action
   * allow, source `0.0.0.0/0`. TCP/UDP need `portStart` (1..65535;
   * `portEnd` defaults to it); ICMP/any take no ports. Remote targets must be
   * IPv4 addresses or CIDRs (bare IPs become /32). The portal manages
   * ingress rules only; egress is kept for API compatibility.
   */
  async createRule(args: { workspaceId: string; firewallGroupId: string } & FirewallRuleInput): Promise<FirewallGroup> {
    const { workspaceId, firewallGroupId, ...input } = args;
    const body = buildFirewallRuleBody(input);
    return this.http.request({ method: "POST", path: `${fwPath(firewallGroupId)}/rules`, workspaceId, body });
  }

  private async assertNotSystemManaged(
    workspaceId: string,
    firewallGroupId: string,
    firewallRuleId: string,
    verb: "updated" | "removed",
  ): Promise<void> {
    const group = await this.getGroup({ workspaceId, firewallGroupId });
    const rule = (group.rules ?? []).find((r) => r.rule_id === firewallRuleId);
    if (rule?.system_managed) {
      fail(
        verb === "updated" ? "System-managed firewall rules cannot be updated." : "System-managed rules cannot be removed.",
        "system_managed_rule",
        "firewall_rule_id",
      );
    }
  }

  /**
   * Update a rule (at least one field). A protocol change to tcp/udp needs
   * `portStart`; icmp/any take no ports. With `checkSystemManaged` (default
   * true) platform baseline rules are refused before the request.
   */
  async updateRule(
    args: {
      workspaceId: string;
      firewallGroupId: string;
      firewallRuleId: string;
      enabled?: boolean;
      checkSystemManaged?: boolean;
    } & FirewallRuleInput,
  ): Promise<FirewallGroup> {
    const { workspaceId, firewallGroupId, firewallRuleId, checkSystemManaged, ...input } = args;
    validateWorkspaceId(workspaceId);
    const ruleId = validateRequiredId(firewallRuleId, "firewall_rule_id");
    const path = `${fwPath(firewallGroupId)}/rules/${pathId(ruleId)}`;
    const body = buildFirewallRuleBody(input, { update: true });
    if (checkSystemManaged !== false) await this.assertNotSystemManaged(workspaceId, firewallGroupId, ruleId, "updated");
    return this.http.request({ method: "PATCH", path, workspaceId, body });
  }

  /** Delete a rule. With `checkSystemManaged` (default true) baseline rules are refused. */
  async deleteRule(args: {
    workspaceId: string;
    firewallGroupId: string;
    firewallRuleId: string;
    checkSystemManaged?: boolean;
  }): Promise<FirewallGroup> {
    validateWorkspaceId(args.workspaceId);
    const ruleId = validateRequiredId(args.firewallRuleId, "firewall_rule_id");
    const path = `${fwPath(args.firewallGroupId)}/rules/${pathId(ruleId)}`;
    if (args.checkSystemManaged !== false) {
      await this.assertNotSystemManaged(args.workspaceId, args.firewallGroupId, ruleId, "removed");
    }
    return this.http.request({ method: "DELETE", path, workspaceId: args.workspaceId });
  }

  /** VMs attached to a group. `limit` 1..500, `skip` >= 0. */
  async listAttachments(args: {
    workspaceId: string;
    firewallGroupId: string;
    limit?: number;
    skip?: number;
  }): Promise<FirewallAttachment[]> {
    if (args.limit !== undefined) validateIntRange(args.limit, "limit", 1, 500);
    if (args.skip !== undefined && (!Number.isInteger(args.skip) || args.skip < 0)) {
      fail("skip must be an integer >= 0.", "invalid_skip", "skip");
    }
    return this.http.request({
      method: "GET",
      path: `${fwPath(args.firewallGroupId)}/attachments`,
      workspaceId: args.workspaceId,
      query: { limit: args.limit, skip: args.skip },
    });
  }

  /**
   * Attach a group to a VM. This REPLACES any other custom group on the VM.
   * Only VMs on an active OVS/OVN network can take firewall groups; the SDK
   * reports that server refusal as `IbeeValidationError`
   * (`firewall_attach_unsupported`).
   */
  async attach(args: { workspaceId: string; firewallGroupId: string; vmId: string }): Promise<FirewallGroup> {
    const vmId = validateRequiredId(args.vmId, "vm_id");
    try {
      return await this.http.request({
        method: "POST",
        path: `${fwPath(args.firewallGroupId)}/attachments`,
        workspaceId: args.workspaceId,
        body: { vm_id: vmId },
      });
    } catch (err) {
      if (err instanceof BadRequestError && /OVS\/OVN/i.test(err.message)) {
        throw new IbeeValidationError(
          "This VM's network cannot take firewall groups: only VMs on an active OVS/OVN network are eligible.",
          "firewall_attach_unsupported",
          "vm_id",
          err,
        );
      }
      throw err;
    }
  }

  /** Detach a group from a VM; the VM gets the platform default group back. */
  detach(args: { workspaceId: string; firewallGroupId: string; vmId: string }): Promise<FirewallGroup> {
    return this.http.request({
      method: "DELETE",
      path: `${fwPath(args.firewallGroupId)}/attachments/${pathId(validatePathId(args.vmId, "vm_id"))}`,
      workspaceId: args.workspaceId,
    });
  }
}

interface LoadBalancerExtras {
  /** Not yet part of the published API contract; behaviour may change. */
  policy?: LoadBalancerPolicy;
  /** Not yet part of the published API contract; behaviour may change. */
  healthCheck?: LoadBalancerHealthCheck;
  /** Not yet part of the published API contract; behaviour may change. */
  observability?: LoadBalancerObservability;
}

interface CreateLoadBalancerArgs extends LoadBalancerExtras {
  workspaceId: string;
  name: string;
  protocol: LoadBalancerProtocol;
  backends: LoadBalancerBackend[];
  routing?: LoadBalancerRouting;
  /** Supplied automatically (managed certificate) for https / tls_passthrough. */
  tls?: LoadBalancerTls;
  /** Run the LOADBALA-STD billing eligibility preflight first (not sent). */
  checkBilling?: boolean;
}

const lbPath = (id: string) => pathId(validatePathId(id, "load_balancer_id"));

export class LoadBalancersResource {
  private readonly billing: BillingResource;

  constructor(private readonly http: HttpClient) {
    this.billing = new BillingResource(http);
  }

  /**
   * List load balancers. `status: "deleted"` implies `includeDeleted`
   * (not yet part of the published API contract). `limit` 1..500.
   */
  async list(args: {
    workspaceId: string;
    status?: string;
    layer?: LoadBalancerLayer;
    protocol?: LoadBalancerProtocol;
    includeDeleted?: boolean;
    limit?: number;
    skip?: number;
  }): Promise<LoadBalancer[]> {
    const query = loadBalancerListQuery(args);
    return this.http.request({ method: "GET", path: "/networking/load-balancers", workspaceId: args.workspaceId, query });
  }

  private async create(
    layer: "l4" | "l7",
    args: CreateLoadBalancerArgs & { customDomain?: { hostname: string } | null; rules?: LoadBalancerRule[] },
  ): Promise<LoadBalancer> {
    validateWorkspaceId(args.workspaceId);
    const { workspaceId, checkBilling, ...input } = args;
    const body = buildLoadBalancerBody(layer, "create", input as LoadBalancerBodyInput);
    if (checkBilling) {
      await this.billing.requireResourceEligibility({
        workspaceId,
        skuCode: LOAD_BALANCER_SKU_CODE,
        resourceType: "load_balancer",
      });
    }
    return this.http.request({ method: "POST", path: `/networking/load-balancers/${layer}`, workspaceId, body });
  }

  /**
   * Create an L4 (tcp / tls_passthrough) load balancer. Name 1..128, at
   * least one backend; managed passthrough TLS is supplied for
   * tls_passthrough; sticky sessions and custom certificates are not
   * supported. The edge runs billing admission (LOADBALA-STD).
   */
  createL4(args: CreateLoadBalancerArgs): Promise<LoadBalancer> {
    return this.create("l4", args);
  }

  /**
   * Create an L7 (http / https) load balancer. Managed TLS termination is
   * supplied for https. `customDomain` is https-only and its DNS CNAME must
   * already point at the IBEE target. `rules` path prefixes must start with
   * `/`.
   */
  createL7(
    args: CreateLoadBalancerArgs & {
      customDomain?: { hostname: string };
      rules?: LoadBalancerRule[];
    },
  ): Promise<LoadBalancer> {
    return this.create("l7", args);
  }

  /** Get a load balancer. `includeDeleted` is not yet part of the published API contract. */
  get(args: { workspaceId: string; loadBalancerId: string; includeDeleted?: boolean }): Promise<LoadBalancer> {
    return this.http.request({
      method: "GET",
      path: `/networking/load-balancers/${lbPath(args.loadBalancerId)}`,
      workspaceId: args.workspaceId,
      query: { include_deleted: args.includeDeleted },
    });
  }

  delete(args: { workspaceId: string; loadBalancerId: string }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/networking/load-balancers/${lbPath(args.loadBalancerId)}`,
      workspaceId: args.workspaceId,
    });
  }

  /** Update an L4 load balancer (at least one field; no rules or custom domain). */
  async updateL4(
    args: {
      workspaceId: string;
      loadBalancerId: string;
      name?: string;
      backends?: LoadBalancerBackend[];
      routing?: LoadBalancerRouting;
      tls?: LoadBalancerTls;
    } & LoadBalancerExtras,
  ): Promise<LoadBalancer> {
    const { workspaceId, loadBalancerId, ...input } = args;
    const body = buildLoadBalancerBody("l4", "update", input as LoadBalancerBodyInput);
    return this.http.request({
      method: "PATCH",
      path: `/networking/load-balancers/l4/${lbPath(loadBalancerId)}`,
      workspaceId,
      body,
    });
  }

  /**
   * Update an L7 load balancer (at least one field). `customDomain: null`
   * removes the custom domain.
   */
  async updateL7(
    args: {
      workspaceId: string;
      loadBalancerId: string;
      name?: string;
      backends?: LoadBalancerBackend[];
      routing?: LoadBalancerRouting;
      tls?: LoadBalancerTls;
      customDomain?: { hostname: string } | null;
      rules?: LoadBalancerRule[];
    } & LoadBalancerExtras,
  ): Promise<LoadBalancer> {
    const { workspaceId, loadBalancerId, ...input } = args;
    const body = buildLoadBalancerBody("l7", "update", input as LoadBalancerBodyInput);
    return this.http.request({
      method: "PATCH",
      path: `/networking/load-balancers/l7/${lbPath(loadBalancerId)}`,
      workspaceId,
      body,
    });
  }

  getStatus(args: { workspaceId: string; loadBalancerId: string }): Promise<LoadBalancerStatusResponse> {
    return this.http.request({
      method: "GET",
      path: `/networking/load-balancers/${lbPath(args.loadBalancerId)}/status`,
      workspaceId: args.workspaceId,
    });
  }
}
