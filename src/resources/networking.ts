import type { HttpClient } from "../core.js";
import type {
  FirewallAttachment,
  FirewallGroup,
  FirewallRuleInput,
  LoadBalancer,
  LoadBalancerBackend,
  LoadBalancerLayer,
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
} from "../types.js";

const pathId = (value: string) => encodeURIComponent(value);

export class VpcsResource {
  constructor(private readonly http: HttpClient) {}

  listSites(args: { workspaceId: string }): Promise<NetworkingSite[]> {
    return this.http.request({
      method: "GET",
      path: "/networking/sites",
      workspaceId: args.workspaceId,
    });
  }

  list(args: { workspaceId: string; siteId?: string }): Promise<VpcSummary[]> {
    return this.http.request({
      method: "GET",
      path: "/networking/vpcs",
      workspaceId: args.workspaceId,
      query: { site_id: args.siteId },
    });
  }

  create(args: {
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
    connectivityType?: "public" | "nat_gateway";
  }): Promise<VpcDetail> {
    const { workspaceId, siteId, autoCidr, createDefaultSubnet, defaultSubnetCidr, isDefault, connectivityType, ...rest } =
      args;
    return this.http.request({
      method: "POST",
      path: "/networking/vpcs",
      workspaceId,
      body: {
        ...rest,
        site_id: siteId,
        auto_cidr: autoCidr,
        create_default_subnet: createDefaultSubnet,
        default_subnet_cidr: defaultSubnetCidr,
        is_default: isDefault,
        connectivity_type: connectivityType,
      },
    });
  }

  get(args: { workspaceId: string; vpcId: string }): Promise<VpcDetail> {
    return this.http.request({
      method: "GET",
      path: `/networking/vpcs/${pathId(args.vpcId)}`,
      workspaceId: args.workspaceId,
    });
  }

  update(args: {
    workspaceId: string;
    vpcId: string;
    name?: string;
    description?: string;
  }): Promise<VpcDetail> {
    const { workspaceId, vpcId, ...body } = args;
    return this.http.request({
      method: "PATCH",
      path: `/networking/vpcs/${pathId(vpcId)}`,
      workspaceId,
      body,
    });
  }

  delete(args: { workspaceId: string; vpcId: string }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/networking/vpcs/${pathId(args.vpcId)}`,
      workspaceId: args.workspaceId,
    });
  }

  listSubnets(args: { workspaceId: string; vpcId: string }): Promise<Subnet[]> {
    return this.http.request({
      method: "GET",
      path: `/networking/vpcs/${pathId(args.vpcId)}/subnets`,
      workspaceId: args.workspaceId,
    });
  }

  createSubnet(args: {
    workspaceId: string;
    vpcId: string;
    name: string;
    cidr?: string;
    autoCidr?: boolean;
    prefixLength?: number;
    dns?: string[];
  }): Promise<Subnet> {
    const { workspaceId, vpcId, autoCidr, prefixLength, ...rest } = args;
    return this.http.request({
      method: "POST",
      path: `/networking/vpcs/${pathId(vpcId)}/subnets`,
      workspaceId,
      body: { ...rest, auto_cidr: autoCidr, prefix_length: prefixLength },
    });
  }

  getSubnet(args: {
    workspaceId: string;
    vpcId: string;
    subnetId: string;
  }): Promise<Subnet> {
    return this.http.request({
      method: "GET",
      path: `/networking/vpcs/${pathId(args.vpcId)}/subnets/${pathId(args.subnetId)}`,
      workspaceId: args.workspaceId,
    });
  }

  updateSubnet(args: {
    workspaceId: string;
    vpcId: string;
    subnetId: string;
    name?: string;
    dns?: string[];
  }): Promise<Subnet> {
    const { workspaceId, vpcId, subnetId, ...body } = args;
    return this.http.request({
      method: "PATCH",
      path: `/networking/vpcs/${pathId(vpcId)}/subnets/${pathId(subnetId)}`,
      workspaceId,
      body,
    });
  }

  deleteSubnet(args: {
    workspaceId: string;
    vpcId: string;
    subnetId: string;
  }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/networking/vpcs/${pathId(args.vpcId)}/subnets/${pathId(args.subnetId)}`,
      workspaceId: args.workspaceId,
    });
  }

  listNodes(args: {
    workspaceId: string;
    vpcId: string;
  }): Promise<NetworkAllocation[]> {
    return this.http.request({
      method: "GET",
      path: `/networking/vpcs/${pathId(args.vpcId)}/nodes`,
      workspaceId: args.workspaceId,
    });
  }

  attachNode(args: {
    workspaceId: string;
    vpcId: string;
    vmId: string;
    subnetId: string;
    connectivity?: "private" | "public_ip" | "nat";
    reservedPublicIpId?: string;
  }): Promise<NetworkAllocation> {
    const { workspaceId, vpcId, vmId, subnetId, connectivity, reservedPublicIpId } = args;
    return this.http.request({
      method: "POST",
      path: `/networking/vpcs/${pathId(vpcId)}/nodes`,
      workspaceId,
      body: {
        vm_id: vmId,
        subnet_id: subnetId,
        connectivity,
        reserved_public_ip_id: reservedPublicIpId,
      },
    });
  }

  detachNode(args: {
    workspaceId: string;
    vpcId: string;
    vmId: string;
  }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/networking/vpcs/${pathId(args.vpcId)}/nodes/${pathId(args.vmId)}`,
      workspaceId: args.workspaceId,
    });
  }

  listNatGateways(args: {
    workspaceId: string;
    vpcId: string;
  }): Promise<NatGateway[]> {
    return this.http.request({
      method: "GET",
      path: `/networking/vpcs/${pathId(args.vpcId)}/nat-gateways`,
      workspaceId: args.workspaceId,
    });
  }

  createNatGateway(args: {
    workspaceId: string;
    vpcId: string;
    subnetId?: string;
    reservedPublicIpId?: string;
    name?: string;
  }): Promise<NatGateway> {
    const { workspaceId, vpcId, subnetId, reservedPublicIpId, name } = args;
    return this.http.request({
      method: "POST",
      path: `/networking/vpcs/${pathId(vpcId)}/nat-gateways`,
      workspaceId,
      body: {
        subnet_id: subnetId,
        reserved_public_ip_id: reservedPublicIpId,
        name,
      },
    });
  }

  deleteNatGateway(args: {
    workspaceId: string;
    vpcId: string;
    natGatewayId: string;
  }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/networking/vpcs/${pathId(args.vpcId)}/nat-gateways/${pathId(args.natGatewayId)}`,
      workspaceId: args.workspaceId,
    });
  }

  listPortForwardingRules(args: {
    workspaceId: string;
    vpcId: string;
    natGatewayId: string;
  }): Promise<NatPortForwardingRule[]> {
    return this.http.request({
      method: "GET",
      path: `/networking/vpcs/${pathId(args.vpcId)}/nat-gateways/${pathId(args.natGatewayId)}/port-forwarding-rules`,
      workspaceId: args.workspaceId,
    });
  }

  createPortForwardingRule(args: {
    workspaceId: string;
    vpcId: string;
    natGatewayId: string;
    name: string;
    externalPort: number;
    internalIp: string;
    internalPort: number;
    protocol?: TransportProtocol;
    note?: string;
    enabled?: boolean;
  }): Promise<NatPortForwardingRule> {
    const {
      workspaceId,
      vpcId,
      natGatewayId,
      externalPort,
      internalIp,
      internalPort,
      ...rest
    } = args;
    return this.http.request({
      method: "POST",
      path: `/networking/vpcs/${pathId(vpcId)}/nat-gateways/${pathId(natGatewayId)}/port-forwarding-rules`,
      workspaceId,
      body: {
        ...rest,
        external_port: externalPort,
        internal_ip: internalIp,
        internal_port: internalPort,
      },
    });
  }

  updatePortForwardingRule(args: {
    workspaceId: string;
    vpcId: string;
    natGatewayId: string;
    portForwardingRuleId: string;
    name?: string;
    protocol?: TransportProtocol;
    externalPort?: number;
    internalIp?: string;
    internalPort?: number;
    note?: string;
    enabled?: boolean;
  }): Promise<NatPortForwardingRule> {
    const {
      workspaceId,
      vpcId,
      natGatewayId,
      portForwardingRuleId,
      externalPort,
      internalIp,
      internalPort,
      ...rest
    } = args;
    return this.http.request({
      method: "PATCH",
      path: `/networking/vpcs/${pathId(vpcId)}/nat-gateways/${pathId(natGatewayId)}/port-forwarding-rules/${pathId(portForwardingRuleId)}`,
      workspaceId,
      body: {
        ...rest,
        external_port: externalPort,
        internal_ip: internalIp,
        internal_port: internalPort,
      },
    });
  }

  deletePortForwardingRule(args: {
    workspaceId: string;
    vpcId: string;
    natGatewayId: string;
    portForwardingRuleId: string;
  }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/networking/vpcs/${pathId(args.vpcId)}/nat-gateways/${pathId(args.natGatewayId)}/port-forwarding-rules/${pathId(args.portForwardingRuleId)}`,
      workspaceId: args.workspaceId,
    });
  }
}

export class ReservedIpsResource {
  constructor(private readonly http: HttpClient) {}

  list(args: { workspaceId: string; siteId?: string }): Promise<ReservedIp[]> {
    return this.http.request({
      method: "GET",
      path: "/networking/reserved-ips",
      workspaceId: args.workspaceId,
      query: { site_id: args.siteId },
    });
  }

  reserve(args: {
    workspaceId: string;
    siteId: string;
    label?: string;
  }): Promise<ReservedIp> {
    return this.http.request({
      method: "POST",
      path: "/networking/reserved-ips",
      workspaceId: args.workspaceId,
      body: { site_id: args.siteId, label: args.label },
    });
  }

  get(args: { workspaceId: string; reservedIpId: string }): Promise<ReservedIp> {
    return this.http.request({
      method: "GET",
      path: `/networking/reserved-ips/${pathId(args.reservedIpId)}`,
      workspaceId: args.workspaceId,
    });
  }

  update(args: {
    workspaceId: string;
    reservedIpId: string;
    label?: string;
    reverseDns?: string;
  }): Promise<ReservedIp> {
    const { workspaceId, reservedIpId, label, reverseDns } = args;
    return this.http.request({
      method: "PATCH",
      path: `/networking/reserved-ips/${pathId(reservedIpId)}`,
      workspaceId,
      body: { label, reverse_dns: reverseDns },
    });
  }

  release(args: { workspaceId: string; reservedIpId: string }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/networking/reserved-ips/${pathId(args.reservedIpId)}`,
      workspaceId: args.workspaceId,
    });
  }

  attach(args: {
    workspaceId: string;
    reservedIpId: string;
    vmId: string;
    vpcId?: string;
    subnetId?: string;
  }): Promise<ReservedIp> {
    const { workspaceId, reservedIpId, vmId, vpcId, subnetId } = args;
    return this.http.request({
      method: "POST",
      path: `/networking/reserved-ips/${pathId(reservedIpId)}/attach`,
      workspaceId,
      body: { vm_id: vmId, vpc_id: vpcId, subnet_id: subnetId },
    });
  }

  move(args: {
    workspaceId: string;
    reservedIpId: string;
    vmId: string;
    vpcId?: string;
    subnetId?: string;
  }): Promise<ReservedIp> {
    const { workspaceId, reservedIpId, vmId, vpcId, subnetId } = args;
    return this.http.request({
      method: "POST",
      path: `/networking/reserved-ips/${pathId(reservedIpId)}/move`,
      workspaceId,
      body: { vm_id: vmId, vpc_id: vpcId, subnet_id: subnetId },
    });
  }

  detach(args: { workspaceId: string; reservedIpId: string }): Promise<ReservedIp> {
    return this.http.request({
      method: "POST",
      path: `/networking/reserved-ips/${pathId(args.reservedIpId)}/detach`,
      workspaceId: args.workspaceId,
    });
  }
}

export class FirewallsResource {
  constructor(private readonly http: HttpClient) {}

  listGroups(args: { workspaceId: string }): Promise<FirewallGroup[]> {
    return this.http.request({
      method: "GET",
      path: "/networking/firewall-groups",
      workspaceId: args.workspaceId,
    });
  }

  createGroup(args: {
    workspaceId: string;
    name: string;
    description?: string;
    isDefault?: boolean;
  }): Promise<FirewallGroup> {
    const { workspaceId, isDefault, ...rest } = args;
    return this.http.request({
      method: "POST",
      path: "/networking/firewall-groups",
      workspaceId,
      body: { ...rest, is_default: isDefault },
    });
  }

  getGroup(args: {
    workspaceId: string;
    firewallGroupId: string;
  }): Promise<FirewallGroup> {
    return this.http.request({
      method: "GET",
      path: `/networking/firewall-groups/${pathId(args.firewallGroupId)}`,
      workspaceId: args.workspaceId,
    });
  }

  deleteGroup(args: {
    workspaceId: string;
    firewallGroupId: string;
  }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/networking/firewall-groups/${pathId(args.firewallGroupId)}`,
      workspaceId: args.workspaceId,
    });
  }

  createRule(
    args: { workspaceId: string; firewallGroupId: string } & FirewallRuleInput,
  ): Promise<FirewallGroup> {
    const {
      workspaceId,
      firewallGroupId,
      portStart,
      portEnd,
      remoteTargets,
      ...rest
    } = args;
    return this.http.request({
      method: "POST",
      path: `/networking/firewall-groups/${pathId(firewallGroupId)}/rules`,
      workspaceId,
      body: {
        ...rest,
        port_start: portStart,
        port_end: portEnd,
        remote_targets: remoteTargets,
      },
    });
  }

  updateRule(
    args: {
      workspaceId: string;
      firewallGroupId: string;
      firewallRuleId: string;
      enabled?: boolean;
    } & FirewallRuleInput,
  ): Promise<FirewallGroup> {
    const {
      workspaceId,
      firewallGroupId,
      firewallRuleId,
      portStart,
      portEnd,
      remoteTargets,
      ...rest
    } = args;
    return this.http.request({
      method: "PATCH",
      path: `/networking/firewall-groups/${pathId(firewallGroupId)}/rules/${pathId(firewallRuleId)}`,
      workspaceId,
      body: {
        ...rest,
        port_start: portStart,
        port_end: portEnd,
        remote_targets: remoteTargets,
      },
    });
  }

  deleteRule(args: {
    workspaceId: string;
    firewallGroupId: string;
    firewallRuleId: string;
  }): Promise<FirewallGroup> {
    return this.http.request({
      method: "DELETE",
      path: `/networking/firewall-groups/${pathId(args.firewallGroupId)}/rules/${pathId(args.firewallRuleId)}`,
      workspaceId: args.workspaceId,
    });
  }

  listAttachments(args: {
    workspaceId: string;
    firewallGroupId: string;
    limit?: number;
    skip?: number;
  }): Promise<FirewallAttachment[]> {
    return this.http.request({
      method: "GET",
      path: `/networking/firewall-groups/${pathId(args.firewallGroupId)}/attachments`,
      workspaceId: args.workspaceId,
      query: { limit: args.limit, skip: args.skip },
    });
  }

  attach(args: {
    workspaceId: string;
    firewallGroupId: string;
    vmId: string;
  }): Promise<FirewallGroup> {
    return this.http.request({
      method: "POST",
      path: `/networking/firewall-groups/${pathId(args.firewallGroupId)}/attachments`,
      workspaceId: args.workspaceId,
      body: { vm_id: args.vmId },
    });
  }

  detach(args: {
    workspaceId: string;
    firewallGroupId: string;
    vmId: string;
  }): Promise<FirewallGroup> {
    return this.http.request({
      method: "DELETE",
      path: `/networking/firewall-groups/${pathId(args.firewallGroupId)}/attachments/${pathId(args.vmId)}`,
      workspaceId: args.workspaceId,
    });
  }
}

interface CreateLoadBalancerArgs {
  workspaceId: string;
  name: string;
  protocol: LoadBalancerProtocol;
  backends: LoadBalancerBackend[];
  routing?: LoadBalancerRouting;
  tls?: LoadBalancerTls;
}

export class LoadBalancersResource {
  constructor(private readonly http: HttpClient) {}

  list(args: {
    workspaceId: string;
    status?: string;
    layer?: LoadBalancerLayer;
    protocol?: LoadBalancerProtocol;
    limit?: number;
    skip?: number;
  }): Promise<LoadBalancer[]> {
    return this.http.request({
      method: "GET",
      path: "/networking/load-balancers",
      workspaceId: args.workspaceId,
      query: {
        status: args.status,
        layer: args.layer,
        protocol: args.protocol,
        limit: args.limit,
        skip: args.skip,
      },
    });
  }

  createL4(args: CreateLoadBalancerArgs): Promise<LoadBalancer> {
    const { workspaceId, ...body } = args;
    return this.http.request({
      method: "POST",
      path: "/networking/load-balancers/l4",
      workspaceId,
      body,
    });
  }

  createL7(
    args: CreateLoadBalancerArgs & {
      customDomain?: { hostname: string };
      rules?: LoadBalancerRule[];
    },
  ): Promise<LoadBalancer> {
    const { workspaceId, customDomain, ...rest } = args;
    return this.http.request({
      method: "POST",
      path: "/networking/load-balancers/l7",
      workspaceId,
      body: { ...rest, custom_domain: customDomain },
    });
  }

  get(args: {
    workspaceId: string;
    loadBalancerId: string;
  }): Promise<LoadBalancer> {
    return this.http.request({
      method: "GET",
      path: `/networking/load-balancers/${pathId(args.loadBalancerId)}`,
      workspaceId: args.workspaceId,
    });
  }

  delete(args: {
    workspaceId: string;
    loadBalancerId: string;
  }): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/networking/load-balancers/${pathId(args.loadBalancerId)}`,
      workspaceId: args.workspaceId,
    });
  }

  updateL4(args: {
    workspaceId: string;
    loadBalancerId: string;
    name?: string;
    backends?: LoadBalancerBackend[];
    routing?: LoadBalancerRouting;
    tls?: LoadBalancerTls;
  }): Promise<LoadBalancer> {
    const { workspaceId, loadBalancerId, ...body } = args;
    return this.http.request({
      method: "PATCH",
      path: `/networking/load-balancers/l4/${pathId(loadBalancerId)}`,
      workspaceId,
      body,
    });
  }

  updateL7(args: {
    workspaceId: string;
    loadBalancerId: string;
    name?: string;
    backends?: LoadBalancerBackend[];
    routing?: LoadBalancerRouting;
    tls?: LoadBalancerTls;
    customDomain?: { hostname: string };
    rules?: LoadBalancerRule[];
  }): Promise<LoadBalancer> {
    const { workspaceId, loadBalancerId, customDomain, ...rest } = args;
    return this.http.request({
      method: "PATCH",
      path: `/networking/load-balancers/l7/${pathId(loadBalancerId)}`,
      workspaceId,
      body: { ...rest, custom_domain: customDomain },
    });
  }

  getStatus(args: {
    workspaceId: string;
    loadBalancerId: string;
  }): Promise<LoadBalancerStatusResponse> {
    return this.http.request({
      method: "GET",
      path: `/networking/load-balancers/${pathId(args.loadBalancerId)}/status`,
      workspaceId: args.workspaceId,
    });
  }
}
