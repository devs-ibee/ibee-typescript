import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BillingDeniedError,
  ForbiddenError,
  Ibee,
  IbeeValidationError,
  NotFoundError,
  ReservedIpTargetUnsupportedError,
  NAT_GATEWAY_SKU_CODE,
  RESERVED_IP_SKU_CODE,
  LOAD_BALANCER_SKU_CODE,
  buildFirewallRuleBody,
  cidrOverlaps,
  defaultNatDeleteIpAction,
  isPrivateIpv4,
  networkBillingCatalog,
  normaliseRemoteTargets,
  parseIpv4Cidr,
  parsePortRange,
  reservedIpAttachmentKind,
  resolveNodeConnectivity,
  validateHostInSubnet,
  validateReverseDns,
  validateVpcCidr,
  waitForNatGatewayAbsent,
} from "../dist/index.js";

const WS = "710995";

/**
 * Routed fetch mock: routes are [method, RegExp, response]; response is JSON,
 * `{ status, json }`, or a function (call) => one of those. Unmatched: 404.
 */
function router(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const call = {
      url: String(url),
      path: u.pathname.replace(/^\/v1/, ""),
      query: u.searchParams,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    for (const [method, re, resp] of routes) {
      if (method === call.method && re.test(call.path)) {
        let r = typeof resp === "function" ? resp(call) : resp;
        if (!(r && typeof r === "object" && "status" in r && "json" in r)) r = { status: 200, json: r };
        if (r.status === 204) return new Response(null, { status: 204 });
        return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
  };
  return { calls, client: new Ibee({ token: "t", fetch: fetchImpl, maxRetries: 0 }) };
}

const isValidation = (code, pattern) => (err) => {
  assert.ok(err instanceof IbeeValidationError, `expected IbeeValidationError, got ${err?.name}: ${err?.message}`);
  if (code) assert.equal(err.code, code, err.message);
  if (pattern) assert.match(err.message, pattern);
  return true;
};
const sent = (calls) => calls.map((c) => `${c.method} ${c.path}`);
const NAT_CATALOG = { sku_id: "sku-nat", sku_code: "NAT-GATEWAY" };
const RIP_CATALOG = { sku_id: "sku-rip", sku_code: "RESERVED-IP", unit_price_minor: 250, extra: "dropped" };
const ALLOW = (sku) => ({ allowed: true, organization_id: "org-1", reason: "allowed", sku_code: sku });
const DENY = (sku) => ({ allowed: false, organization_id: "org-1", reason: "insufficient_balance", sku_code: sku });

// ------------------------------------------------------------ helpers

test("CIDR helpers follow the portal rules", () => {
  assert.deepEqual(parseIpv4Cidr("10.20.0.0/24").prefix, 24);
  assert.equal(parseIpv4Cidr("10.20.0.0/33"), null);
  assert.equal(parseIpv4Cidr("10.20.0/24"), null);
  assert.equal(validateVpcCidr(" 10.20.0.0/22 "), "10.20.0.0/22");
  assert.throws(() => validateVpcCidr("10.20.1.0/22"), (e) => isValidation("invalid_cidr", /Use 10\.20\.0\.0\/22/)(e) && e.details.suggestion === "10.20.0.0/22");
  assert.throws(() => validateVpcCidr("8.8.8.0/24"), isValidation("invalid_cidr", /RFC1918/));
  assert.throws(() => validateVpcCidr("10.0.0.0/16"), isValidation("invalid_cidr", /\/22 to \/28/));
  assert.throws(() => validateVpcCidr("172.31.255.0/22"), isValidation("invalid_cidr", /aligned/));
  assert.equal(cidrOverlaps("10.0.0.0/24", "10.0.0.128/25"), true);
  assert.equal(cidrOverlaps("10.0.0.0/24", "10.0.1.0/24"), false);
  assert.equal(isPrivateIpv4("10.1.2.3"), true);
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
});

test("validateHostInSubnet uses the portal messages", () => {
  assert.equal(validateHostInSubnet(" 10.0.0.5 ", "10.0.0.0/24", "10.0.0.1"), "10.0.0.5");
  assert.throws(() => validateHostInSubnet("10.0.1.5", "10.0.0.0/24"), isValidation(null, /inside 10\.0\.0\.0\/24/));
  assert.throws(() => validateHostInSubnet("10.0.0.0", "10.0.0.0/24"), isValidation(null, /network or broadcast/));
  assert.throws(() => validateHostInSubnet("10.0.0.255", "10.0.0.0/24"), isValidation(null, /network or broadcast/));
  assert.throws(() => validateHostInSubnet("10.0.0.1", "10.0.0.0/24", "10.0.0.1"), isValidation(null, /subnet gateway/));
  assert.throws(() => validateHostInSubnet("10.0.0.256", "10.0.0.0/24"), isValidation(null, /valid IPv4/));
});

test("connectivity, NAT delete and billing catalog helpers", () => {
  assert.equal(resolveNodeConnectivity({ vpcConnectivityType: "nat_gateway", natGatewayAvailable: true }), "nat");
  assert.equal(resolveNodeConnectivity({ vpcConnectivityType: "nat_gateway", natGatewayAvailable: true, hasPrimaryNetwork: true }), "private");
  assert.equal(
    resolveNodeConnectivity({ vpcConnectivityType: "nat_gateway", natGatewayAvailable: true, hasPrimaryNetwork: true, useVpcForInternet: true }),
    "nat",
  );
  assert.equal(resolveNodeConnectivity({ vpcConnectivityType: "private", natGatewayAvailable: true }), "private");
  assert.equal(defaultNatDeleteIpAction({ public_ip_source: "reserved" }), "reserve");
  assert.equal(defaultNatDeleteIpAction({ public_ip_source: "automatic" }), "release");
  assert.equal(defaultNatDeleteIpAction({ public_ip_source: "automatic" }, true), "reserve");
  assert.deepEqual(networkBillingCatalog(null), {});
  assert.deepEqual(
    networkBillingCatalog({ skuCode: "NAT-GATEWAY", skuId: "s1", amountMinor: 900, currency: "INR", billingInterval: "HOURLY", billingPeriodHours: 1 }),
    {
      source: undefined, product_id: undefined, product_code: undefined, sku_id: "s1", sku_code: "NAT-GATEWAY",
      display_name: "NAT-GATEWAY", plan_id: undefined, plan_version: undefined, unit_price_minor: 900,
      price_currency: "INR", billing_interval: "HOURLY", billing_period_hours: 1,
    },
  );
  assert.equal(NAT_GATEWAY_SKU_CODE, "NAT-GATEWAY");
  assert.equal(RESERVED_IP_SKU_CODE, "RESERVED-IP");
  assert.equal(LOAD_BALANCER_SKU_CODE, "LOADBALA-STD");
});

test("firewall helpers: ports, remote targets and rule bodies", () => {
  assert.deepEqual(parsePortRange(" 8000 - 8080 "), { start: 8000, end: 8080 });
  assert.deepEqual(parsePortRange("22"), { start: 22, end: 22 });
  assert.throws(() => parsePortRange("80-22"), isValidation("invalid_port", /greater than or equal/));
  assert.throws(() => parsePortRange("a"), isValidation("invalid_port", /single port/));
  assert.deepEqual(normaliseRemoteTargets(["10.0.0.5", " 10.0.0.9/24 ", "10.0.0.0/24"]), ["10.0.0.5/32", "10.0.0.0/24"]);
  assert.deepEqual(normaliseRemoteTargets("1.2.3.4, 5.6.7.0/24"), ["1.2.3.4/32", "5.6.7.0/24"]);
  assert.throws(() => normaliseRemoteTargets(["::1/128"]), isValidation("invalid_remote_targets", /IPv4/));
  assert.throws(() => normaliseRemoteTargets([]), isValidation("invalid_remote_targets", /at least one/));
  assert.deepEqual(buildFirewallRuleBody({ portStart: 22 }), {
    port_start: 22, port_end: 22, remote_targets: ["0.0.0.0/0"], direction: "ingress", action: "allow", protocol: "tcp",
  });
  assert.throws(() => buildFirewallRuleBody({ protocol: "udp" }), isValidation("invalid_port", /required for TCP and UDP/));
  assert.throws(() => buildFirewallRuleBody({ protocol: "icmp", portStart: 1 }), isValidation("invalid_port"));
  assert.throws(() => buildFirewallRuleBody({ protocol: "gre" }), isValidation("invalid_protocol", /Any, TCP, UDP, and ICMP/));
  assert.throws(() => buildFirewallRuleBody({ protocol: "tcp", portStart: 90, portEnd: 80 }), isValidation("invalid_port"));
  assert.deepEqual(buildFirewallRuleBody({ protocol: "icmp", description: "  " }), {
    protocol: "icmp", remote_targets: ["0.0.0.0/0"], direction: "ingress", action: "allow",
  });
  assert.throws(() => buildFirewallRuleBody({}, { update: true }), isValidation("no_changes"));
  assert.deepEqual(buildFirewallRuleBody({ enabled: false }, { update: true }), { enabled: false });
});

test("Reserved IP helpers: reverse DNS and attachment kinds", () => {
  assert.equal(validateReverseDns(" mail.example.com. "), "mail.example.com.");
  assert.equal(validateReverseDns("   "), "");
  assert.equal(validateReverseDns("bücher.example"), "bücher.example");
  assert.throws(() => validateReverseDns("bad_host.example.com"), isValidation("invalid_reverse_dns"));
  assert.throws(() => validateReverseDns("-bad.example.com"), isValidation("invalid_reverse_dns"));
  assert.throws(() => validateReverseDns(`${"a".repeat(64)}.com`), isValidation("invalid_reverse_dns"));
  assert.equal(reservedIpAttachmentKind({}), "none");
  assert.equal(reservedIpAttachmentKind({ attached_resource_id: "n1", attached_resource_type: "nat_gateway" }), "nat_gateway");
  assert.equal(reservedIpAttachmentKind({ attached_resource_id: "vm", attached_resource_type: "vm", attached_network_id: "net" }), "direct");
  assert.equal(
    reservedIpAttachmentKind({ attached_resource_id: "vm", attached_resource_type: "vm", allocation_method: "converted" }),
    "converted_active",
  );
  assert.equal(
    reservedIpAttachmentKind({ attached_resource_id: "vm", attached_resource_type: "vm", attached_allocation_id: "a1" }),
    "vpc",
  );
});

// -------------------------------------------------------------------- VPCs

test("VPC create sends the portal body (private, trimmed, no blank description)", async () => {
  const { calls, client } = router([["POST", /^\/networking\/vpcs$/, { vpc_id: "vpc-1" }]]);
  await client.vpcs.create({
    workspaceId: WS, name: "  prod  ", siteId: " site-1 ", description: "  ", connectivityType: "private",
    cidr: "10.20.0.0/24", createDefaultSubnet: true,
  });
  assert.deepEqual(calls[0].body, {
    name: "prod", site_id: "site-1", connectivity_type: "private", auto_cidr: false, cidr: "10.20.0.0/24",
    create_default_subnet: true,
  });
});

test("VPC create rejects bad CIDR modes and NAT catalog misuse before any request", async () => {
  const { calls, client } = router([]);
  const base = { workspaceId: WS, name: "prod", siteId: "site-1" };
  await assert.rejects(client.vpcs.create({ ...base, name: " " }), isValidation("invalid_name", /Name and location/));
  await assert.rejects(client.vpcs.create({ ...base, name: "x".repeat(81) }), isValidation("invalid_name"));
  await assert.rejects(client.vpcs.create({ ...base, cidr: "10.0.0.0/24", autoCidr: true }), isValidation("invalid_auto_cidr"));
  await assert.rejects(client.vpcs.create({ ...base, autoCidr: false }), isValidation("cidr_required"));
  await assert.rejects(client.vpcs.create({ ...base, cidr: "10.0.1.0/22" }), isValidation("invalid_cidr", /aligned/));
  await assert.rejects(
    client.vpcs.create({ ...base, cidr: "10.0.0.0/24", defaultSubnetCidr: "10.0.1.0/26" }),
    isValidation("invalid_cidr", /inside/),
  );
  await assert.rejects(
    client.vpcs.create({ ...base, defaultSubnetCidr: "10.0.1.0/26", createDefaultSubnet: false }),
    isValidation("invalid_default_subnet_cidr"),
  );
  await assert.rejects(
    client.vpcs.create({ ...base, connectivityType: "private", natBillingCatalog: NAT_CATALOG }),
    isValidation("invalid_billing_catalog"),
  );
  await assert.rejects(
    client.vpcs.create({ ...base, connectivityType: "nat_gateway", natBillingCatalog: { sku_id: "x" } }),
    isValidation("invalid_billing_catalog", /sku_code/),
  );
  await assert.rejects(client.vpcs.create({ ...base, connectivityType: "mesh" }), isValidation("invalid_connectivity_type"));
  assert.equal(calls.length, 0);
});

test("VPC create for nat_gateway sends the NAT catalog; without one it warns", async () => {
  const warnings = [];
  const onWarning = (w) => warnings.push(w);
  process.on("warning", onWarning);
  try {
    const { calls, client } = router([["POST", /^\/networking\/vpcs$/, { vpc_id: "vpc-1" }]]);
    await client.vpcs.create({ workspaceId: WS, name: "n", siteId: "s", connectivityType: "nat_gateway", natBillingCatalog: NAT_CATALOG });
    assert.deepEqual(calls[0].body.nat_billing_catalog, NAT_CATALOG);
    await client.vpcs.create({ workspaceId: WS, name: "n", siteId: "s", connectivityType: "nat_gateway" });
    await new Promise((r) => setImmediate(r));
    assert.ok(warnings.some((w) => w.name === "IbeeBillingWarning"));
  } finally {
    process.off("warning", onWarning);
  }
});

test("VPC create with checkSite refuses an unavailable site", async () => {
  const { calls, client } = router([
    ["GET", /^\/networking\/sites$/, [{ site_id: "s1", site_name: "A", available: false, message: "VPCs are not enabled" }]],
  ]);
  await assert.rejects(
    client.vpcs.create({ workspaceId: WS, name: "n", siteId: "s1", checkSite: true }),
    isValidation("site_unavailable", /not enabled/),
  );
  assert.deepEqual(sent(calls), ["GET /networking/sites"]);
  const sites = await client.vpcs.listSites({ workspaceId: WS, availableOnly: true });
  assert.deepEqual(sites, []);
});

test("VPC and subnet updates need at least one field", async () => {
  const { calls, client } = router([["PATCH", /./, {}]]);
  await assert.rejects(client.vpcs.update({ workspaceId: WS, vpcId: "v" }), isValidation("no_changes", /At least one VPC field/));
  await assert.rejects(client.vpcs.update({ workspaceId: WS, vpcId: "v", name: "  " }), isValidation("invalid_name"));
  await assert.rejects(client.vpcs.updateSubnet({ workspaceId: WS, vpcId: "v", subnetId: "s" }), isValidation("no_changes"));
  await assert.rejects(client.vpcs.updateSubnet({ workspaceId: WS, vpcId: "v", subnetId: "s", dns: ["x"] }), isValidation("invalid_dns"));
  await client.vpcs.update({ workspaceId: WS, vpcId: "v", description: "  d  " });
  assert.deepEqual(calls[0].body, { description: "d" });
});

test("VPC delete with dependency checks deletes the NAT gateway first and waits", async () => {
  let natGone = false;
  const { calls, client } = router([
    ["GET", /^\/networking\/vpcs\/vpc-1$/, () => ({
      vpc_id: "vpc-1", node_count: 0, attached_nodes: [],
      nat_gateways: natGone ? [] : [{ nat_gateway_id: "nat-1", status: "available" }],
    })],
    ["GET", /^\/networking\/vpcs\/vpc-1\/virtual-ips$/, []],
    ["DELETE", /^\/networking\/vpcs\/vpc-1\/nat-gateways\/nat-1$/, () => { natGone = true; return { status: 204, json: null }; }],
    ["DELETE", /^\/networking\/vpcs\/vpc-1$/, { status: 204, json: null }],
  ]);
  await assert.rejects(
    client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1", checkDependencies: true }),
    isValidation("vpc_has_nat_gateway"),
  );
  calls.length = 0;
  await client.vpcs.delete({ workspaceId: WS, vpcId: "vpc-1", checkDependencies: true, deleteNatGateway: true });
  assert.deepEqual(sent(calls), [
    "GET /networking/vpcs/vpc-1",
    "GET /networking/vpcs/vpc-1/virtual-ips",
    "DELETE /networking/vpcs/vpc-1/nat-gateways/nat-1",
    "GET /networking/vpcs/vpc-1",
    "DELETE /networking/vpcs/vpc-1",
  ]);
  assert.equal(calls[2].body, undefined, "list-page NAT delete sends no body");
});

test("VPC delete refuses while nodes are attached", async () => {
  const { client } = router([["GET", /^\/networking\/vpcs\/v$/, { vpc_id: "v", node_count: 2 }]]);
  await assert.rejects(
    client.vpcs.delete({ workspaceId: WS, vpcId: "v", checkDependencies: true }),
    isValidation("vpc_has_nodes", /Detach 2 attached node/),
  );
});

// ------------------------------------------------------------------ subnets

test("subnet create checks the VPC range, overlap and quota like the portal", async () => {
  const vpc = { vpc_id: "v", cidr: "10.0.0.0/22", subnets: [{ cidr: "10.0.0.0/24" }] };
  const { calls, client } = router([
    ["GET", /^\/networking\/vpcs\/v$/, vpc],
    ["POST", /^\/networking\/vpcs\/v\/subnets$/, { subnet_id: "s" }],
  ]);
  await assert.rejects(
    client.vpcs.createSubnet({ workspaceId: WS, vpcId: "v", name: "a", cidr: "10.0.8.0/24" }),
    isValidation("subnet_outside_vpc", /sub-range of 10\.0\.0\.0\/22/),
  );
  await assert.rejects(
    client.vpcs.createSubnet({ workspaceId: WS, vpcId: "v", name: "a", cidr: "10.0.0.128/25" }),
    isValidation("subnet_overlap", /overlaps/),
  );
  await assert.rejects(
    client.vpcs.createSubnet({ workspaceId: WS, vpcId: "v", name: "a", cidr: "10.0.1.0/24", prefixLength: 24 }),
    isValidation("invalid_prefix_length"),
  );
  await assert.rejects(
    client.vpcs.createSubnet({ workspaceId: WS, vpcId: "v", name: "a", cidr: "10.0.1.0/30" }),
    isValidation("invalid_cidr", /\/29 or larger/),
  );
  await client.vpcs.createSubnet({ workspaceId: WS, vpcId: "v", name: " app ", cidr: "10.0.1.0/24" });
  assert.deepEqual(calls.at(-1).body, { name: "app", cidr: "10.0.1.0/24", auto_cidr: false });

  const full = router([["GET", /^\/networking\/vpcs\/v$/, { ...vpc, subnets: Array.from({ length: 10 }, () => ({})) }]]);
  await assert.rejects(
    full.client.vpcs.createSubnet({ workspaceId: WS, vpcId: "v", name: "a" }),
    isValidation("subnet_quota_exceeded", /limit is 10/),
  );
});

// ------------------------------------------------------------------ nodes

test("attachNode validates a requested private IP against the subnet", async () => {
  const { calls, client } = router([
    ["GET", /^\/networking\/vpcs\/v\/subnets\/s$/, { subnet_id: "s", cidr: "10.0.0.0/24", gateway: "10.0.0.1" }],
    ["POST", /^\/networking\/vpcs\/v\/nodes$/, { allocation_id: "a" }],
  ]);
  const base = { workspaceId: WS, vpcId: "v", vmId: " vm-1 ", subnetId: "s" };
  await assert.rejects(client.vpcs.attachNode({ ...base, requestedPrivateIp: "10.0.0.1" }), isValidation(null, /gateway/));
  await assert.rejects(client.vpcs.attachNode({ ...base, requestedPrivateIp: "10.0.0.255" }), isValidation(null, /broadcast/));
  await assert.rejects(
    client.vpcs.attachNode({ ...base, connectivity: "private", reservedPublicIpId: "r" }),
    isValidation("invalid_reserved_public_ip_id"),
  );
  calls.length = 0;
  await client.vpcs.attachNode({ ...base, requestedPrivateIp: " 10.0.0.20 ", connectivity: "nat" });
  assert.deepEqual(sent(calls), ["GET /networking/vpcs/v/subnets/s", "POST /networking/vpcs/v/nodes"]);
  assert.deepEqual(calls[1].body, { vm_id: "vm-1", subnet_id: "s", connectivity: "nat", requested_private_ip: "10.0.0.20" });
});

test("attachNode with checkVpc applies the portal connectivity rules", async () => {
  const { client } = router([["GET", /^\/networking\/vpcs\/v$/, { connectivity_type: "nat_gateway", nat_gateways: [] }]]);
  const base = { workspaceId: WS, vpcId: "v", vmId: "vm", subnetId: "s", checkVpc: true };
  await assert.rejects(client.vpcs.attachNode({ ...base, connectivity: "public_ip" }), isValidation("invalid_connectivity", /nat_gateway VPCs/));
  await assert.rejects(client.vpcs.attachNode({ ...base, connectivity: "nat" }), isValidation("nat_gateway_unavailable", /no available NAT/));
});

// -------------------------------------------------------------------- NAT

test("NAT create requires a nat_gateway VPC and an eligible Reserved IP", async () => {
  const { calls, client } = router([
    ["GET", /^\/networking\/vpcs\/priv$/, { vpc_id: "priv", connectivity_type: "private", site_id: "s1" }],
    ["GET", /^\/networking\/vpcs\/natv$/, { vpc_id: "natv", connectivity_type: "nat_gateway", site_id: "s1" }],
    ["GET", /^\/networking\/reserved-ips\/rip-other$/, { public_ip_id: "rip-other", site_id: "s2", status: "reserved" }],
    ["GET", /^\/networking\/reserved-ips\/rip-ok$/, { public_ip_id: "rip-ok", site_id: "s1", status: "reserved", reservation_type: "user_reserved" }],
    ["POST", /^\/networking\/vpcs\/natv\/nat-gateways$/, { nat_gateway_id: "nat-1", public_ip_source: "reserved" }],
  ]);
  await assert.rejects(
    client.vpcs.createNatGateway({ workspaceId: WS, vpcId: "priv", billingCatalog: NAT_CATALOG }),
    isValidation("vpc_not_nat_gateway", /only be created for nat_gateway VPCs/),
  );
  await assert.rejects(
    client.vpcs.createNatGateway({ workspaceId: WS, vpcId: "natv", reservedPublicIpId: "rip-other", billingCatalog: NAT_CATALOG }),
    isValidation("reserved_ip_site_mismatch", /different site/),
  );
  await assert.rejects(
    client.vpcs.createNatGateway({ workspaceId: WS, vpcId: "natv", billingCatalog: { code: "" } }),
    isValidation("invalid_billing_catalog"),
  );
  calls.length = 0;
  const gw = await client.vpcs.createNatGateway({
    workspaceId: WS, vpcId: "natv", reservedPublicIpId: "rip-ok", name: " NAT Gateway ", billingCatalog: NAT_CATALOG,
  });
  assert.equal(gw.public_ip_source, "reserved");
  assert.deepEqual(calls.at(-1).body, { reserved_public_ip_id: "rip-ok", name: "NAT Gateway", billing_catalog: NAT_CATALOG });
});

test("NAT create preflight and edge denials become BillingDeniedError", async () => {
  const { calls, client } = router([
    ["POST", /^\/billing\/resource-eligibility$/, DENY("NAT-GATEWAY")],
  ]);
  await assert.rejects(
    client.vpcs.createNatGateway({ workspaceId: WS, vpcId: "v", validateVpc: false, preflightBilling: true, billingCatalog: NAT_CATALOG }),
    (e) => e instanceof BillingDeniedError && e.topupAllowed === true && /NAT gateway/.test(e.message),
  );
  assert.equal(calls[0].body.sku_code, "NAT-GATEWAY");
  assert.equal(calls.length, 1);

  const edge = router([
    ["POST", /nat-gateways$/, { status: 402, json: { error: "billing_denied", billing_reason: "initial_topup_required", billing_sku_code: "NAT-GATEWAY" } }],
  ]);
  await assert.rejects(
    edge.client.vpcs.createNatGateway({ workspaceId: WS, vpcId: "v", validateVpc: false, billingCatalog: NAT_CATALOG }),
    (e) => e instanceof BillingDeniedError && e.resourceType === "nat_gateway" && e.skuCode === "NAT-GATEWAY",
  );
});

test("NAT delete sends the public-IP action and enforces the reserve rule", async () => {
  const gateways = [
    { nat_gateway_id: "auto", public_ip_source: "automatic", status: "available" },
    { nat_gateway_id: "rsv", public_ip_source: "reserved", status: "available" },
  ];
  const { calls, client } = router([
    ["GET", /^\/networking\/vpcs\/v\/nat-gateways$/, gateways],
    ["DELETE", /nat-gateways\/(auto|rsv)$/, { status: 204, json: null }],
    ["GET", /^\/networking\/vpcs\/v$/, { vpc_id: "v", nat_gateways: [] }],
  ]);
  await assert.rejects(
    client.vpcs.deleteNatGateway({ workspaceId: WS, vpcId: "v", natGatewayId: "auto", publicIpAction: "reserve" }),
    isValidation("billing_catalog_required", /RESERVED-IP billing_catalog/),
  );
  await assert.rejects(
    client.vpcs.deleteNatGateway({ workspaceId: WS, vpcId: "v", natGatewayId: "auto", publicIpAction: "release", billingCatalog: RIP_CATALOG }),
    isValidation("invalid_billing_catalog"),
  );
  await assert.rejects(
    client.vpcs.deleteNatGateway({ workspaceId: WS, vpcId: "v", natGatewayId: "auto", publicIpAction: "keep" }),
    isValidation("invalid_public_ip_action"),
  );
  calls.length = 0;
  await client.vpcs.deleteNatGateway({ workspaceId: WS, vpcId: "v", natGatewayId: "rsv", publicIpAction: "reserve", wait: true });
  assert.deepEqual(sent(calls), [
    "GET /networking/vpcs/v/nat-gateways",
    "DELETE /networking/vpcs/v/nat-gateways/rsv",
    "GET /networking/vpcs/v",
  ]);
  assert.deepEqual(calls[1].body, { public_ip_action: "reserve" });
  calls.length = 0;
  await client.vpcs.deleteNatGateway({
    workspaceId: WS, vpcId: "v", natGatewayId: "auto", publicIpAction: "reserve", billingCatalog: RIP_CATALOG,
  });
  assert.deepEqual(calls[0].body, { public_ip_action: "reserve", billing_catalog: RIP_CATALOG });
});

test("waitForNatGatewayAbsent gives up after the attempts and treats 404 as gone", async () => {
  const { calls, client } = router([["GET", /^\/networking\/vpcs\/v$/, { nat_gateways: [{ nat_gateway_id: "n" }] }]]);
  assert.equal(await waitForNatGatewayAbsent(client, { workspaceId: WS, vpcId: "v", natGatewayId: "n", attempts: 3, intervalMs: 1 }), false);
  assert.equal(calls.length, 3);
  const gone = router([]);
  assert.equal(await gone.client.vpcs.waitForNatGatewayAbsent({ workspaceId: WS, vpcId: "v", natGatewayId: "n" }), true);
});

test("replaceNatGatewayPublicIp PUTs the Reserved IP (with optional state checks)", async () => {
  const { calls, client } = router([
    ["GET", /^\/networking\/vpcs\/v\/nat-gateways$/, [{ nat_gateway_id: "n", status: "provisioning" }]],
    ["PUT", /^\/networking\/vpcs\/v\/nat-gateways\/n\/public-ip$/, { nat_gateway_id: "n", public_ip_source: "reserved" }],
  ]);
  await client.vpcs.replaceNatGatewayPublicIp({ workspaceId: WS, vpcId: "v", natGatewayId: "n", reservedPublicIpId: " r1 " });
  assert.deepEqual(calls[0].body, { reserved_public_ip_id: "r1" });
  await assert.rejects(
    client.vpcs.replaceNatGatewayPublicIp({ workspaceId: WS, vpcId: "v", natGatewayId: "n", reservedPublicIpId: "r1", checkState: true }),
    isValidation("nat_gateway_unavailable"),
  );
  await assert.rejects(
    client.vpcs.replaceNatGatewayPublicIp({ workspaceId: WS, vpcId: "v", natGatewayId: "n", reservedPublicIpId: " " }),
    isValidation(),
  );
});

// ------------------------------------------------------- port forwarding

const pfRoutes = (extra = []) => [
  ["GET", /^\/networking\/vpcs\/v\/nat-gateways$/, [{ nat_gateway_id: "n", status: "available" }]],
  ["GET", /^\/networking\/vpcs\/v\/nat-gateways\/n\/port-forwarding-rules$/, [
    { port_forward_rule_id: "r1", protocol: "tcp", external_port: 2222, internal_ip: "10.0.0.10", target_type: "vm" },
  ]],
  ["GET", /^\/networking\/vpcs\/v\/nodes$/, [
    { vm_id: "vm-a", subnet_id: "s", private_ip: "10.0.0.10", connectivity: "nat", nat_gateway_id: "n", status: "active" },
  ]],
  ["GET", /^\/networking\/vpcs\/v\/virtual-ips$/, [
    { virtual_ip_id: "pvip-1", private_ip: "10.0.0.50", purpose: "metallb", status: "available", announcer_vm_ids: ["vm-a", "vm-b"] },
  ]],
  ...extra,
  ["POST", /port-forwarding-rules$/, (c) => c.body],
  ["PATCH", /port-forwarding-rules\/r1$/, (c) => c.body],
];

test("port-forward create applies the portal checks and fills VIP announcers", async () => {
  const { calls, client } = router(pfRoutes());
  const base = { workspaceId: WS, vpcId: "v", natGatewayId: "n", name: " ssh ", internalPort: 22 };
  await assert.rejects(
    client.vpcs.createPortForwardingRule({ ...base, externalPort: 2222, internalIp: "10.0.0.10" }),
    isValidation("duplicate_external_port", /TCP external port 2222 already exists/),
  );
  await assert.rejects(
    client.vpcs.createPortForwardingRule({ ...base, externalPort: 2223, internalIp: "10.0.0.99" }),
    isValidation("invalid_internal_ip", /NAT-connected VM/),
  );
  await assert.rejects(
    client.vpcs.createPortForwardingRule({ ...base, externalPort: 70000, internalIp: "10.0.0.10" }),
    isValidation("invalid_port", /1 to 65535/),
  );
  await assert.rejects(
    client.vpcs.createPortForwardingRule({ ...base, externalPort: 22.5, internalIp: "10.0.0.10" }),
    isValidation("invalid_port"),
  );
  await assert.rejects(
    client.vpcs.createPortForwardingRule({ ...base, externalPort: 80, internalIp: "8.8.8.8" }),
    isValidation("invalid_internal_ip", /private/),
  );
  await assert.rejects(
    client.vpcs.createPortForwardingRule({ ...base, externalPort: 80, internalIp: "10.0.0.10", targetVmIds: ["x"] }),
    isValidation("invalid_target_vm_ids"),
  );
  calls.length = 0;
  const vm = await client.vpcs.createPortForwardingRule({ ...base, externalPort: 2223, internalIp: " 10.0.0.10 ", protocol: "TCP" });
  assert.deepEqual(vm, {
    name: "ssh", protocol: "tcp", external_port: 2223, internal_ip: "10.0.0.10", internal_port: 22,
    target_type: "vm", target_vm_ids: [], note: "", enabled: true,
  });
  const vip = await client.vpcs.createPortForwardingRule({ ...base, externalPort: 443, internalIp: "10.0.0.50", targetType: "vip" });
  assert.deepEqual(vip.target_vm_ids, ["vm-a", "vm-b"]);
  await assert.rejects(
    client.vpcs.createPortForwardingRule({ ...base, externalPort: 444, internalIp: "10.0.0.50", targetType: "vip", targetVmIds: ["vm-a"] }),
    isValidation("invalid_target_vm_ids", /announcer/),
  );
});

test("port-forward create refuses a gateway that is not available", async () => {
  const { client } = router([["GET", /nat-gateways$/, [{ nat_gateway_id: "n", status: "provisioning" }]]]);
  await assert.rejects(
    client.vpcs.createPortForwardingRule({
      workspaceId: WS, vpcId: "v", natGatewayId: "n", name: "a", externalPort: 1, internalIp: "10.0.0.1", internalPort: 1,
    }),
    isValidation("nat_gateway_unavailable", /active NAT gateway is required/),
  );
});

test("port-forward update: toggles, target rules and duplicate check excluding itself", async () => {
  const { calls, client } = router(pfRoutes());
  const base = { workspaceId: WS, vpcId: "v", natGatewayId: "n", portForwardingRuleId: "r1" };
  await assert.rejects(client.vpcs.updatePortForwardingRule(base), isValidation("no_changes", /port forwarding field/));
  await assert.rejects(client.vpcs.updatePortForwardingRule({ ...base, targetVmIds: ["a"] }), isValidation("invalid_target_vm_ids", /target_type/));
  calls.length = 0;
  await client.vpcs.updatePortForwardingRule({ ...base, enabled: false });
  assert.deepEqual(sent(calls), ["PATCH /networking/vpcs/v/nat-gateways/n/port-forwarding-rules/r1"]);
  assert.deepEqual(calls[0].body, { enabled: false });
  calls.length = 0;
  await client.vpcs.updatePortForwardingRule({ ...base, externalPort: 2222, enabled: true });
  assert.deepEqual(calls.at(-1).body, { external_port: 2222, enabled: true });
  await client.vpcs.updatePortForwardingRule({ ...base, targetType: "vm", checkState: false });
  assert.deepEqual(calls.at(-1).body, { target_type: "vm", target_vm_ids: [] });
  await client.vpcs.updatePortForwardingRule({ ...base, targetType: "vip", internalIp: "10.0.0.50" });
  assert.deepEqual(calls.at(-1).body, { internal_ip: "10.0.0.50", target_type: "vip", target_vm_ids: ["vm-a", "vm-b"] });
});

// ------------------------------------------------------------- virtual IPs

test("virtual IPs: list, get (filtered), create checks and delete guard", async () => {
  const vips = [
    { virtual_ip_id: "pvip-1", private_ip: "10.0.0.50", purpose: "metallb", status: "available", announcer_vm_ids: ["vm-a"], public_ip_id: "rip-1" },
    { virtual_ip_id: "pvip-2", private_ip: "10.0.0.51", purpose: "metallb", status: "available", announcer_vm_ids: ["vm-a"] },
  ];
  const { calls, client } = router([
    ["GET", /^\/networking\/vpcs\/v\/virtual-ips$/, vips],
    ["GET", /^\/networking\/vpcs\/v\/subnets\/s$/, { subnet_id: "s", cidr: "10.0.0.0/24", gateway: "10.0.0.1" }],
    ["GET", /^\/networking\/vpcs\/v\/nodes$/, [
      { vm_id: "vm-a", subnet_id: "s", connectivity: "nat", status: "active" },
      { vm_id: "vm-p", subnet_id: "s", connectivity: "private", status: "active" },
    ]],
    ["GET", /^\/networking\/vpcs\/v\/nat-gateways$/, [{ nat_gateway_id: "n" }]],
    ["GET", /port-forwarding-rules$/, [{ internal_ip: "10.0.0.51" }]],
    ["POST", /^\/networking\/vpcs\/v\/virtual-ips$/, (c) => ({ virtual_ip_id: "pvip-3", ...c.body })],
    ["DELETE", /virtual-ips\/pvip-/, { status: 204, json: null }],
  ]);
  assert.equal((await client.vpcs.getVirtualIp({ workspaceId: WS, vpcId: "v", virtualIpId: "pvip-2" })).private_ip, "10.0.0.51");
  await assert.rejects(
    client.vpcs.getVirtualIp({ workspaceId: WS, vpcId: "v", virtualIpId: "pvip-9" }),
    (e) => e instanceof NotFoundError && /Virtual IP pvip-9 was not found/.test(e.message),
  );
  const base = { workspaceId: WS, vpcId: "v", subnetId: "s" };
  await assert.rejects(client.vpcs.createVirtualIp({ ...base, privateIp: "10.0.0.60" }), isValidation("invalid_announcer_vm_ids"));
  await assert.rejects(
    client.vpcs.createVirtualIp({ ...base, privateIp: "10.0.0.60", announcerVmIds: ["vm-p"] }),
    isValidation("invalid_announcer_vm_ids", /NAT-connected/),
  );
  await assert.rejects(
    client.vpcs.createVirtualIp({ ...base, privateIp: "10.0.0.1", announcerVmIds: ["vm-a"] }),
    isValidation("address_is_gateway", /gateway/),
  );
  await assert.rejects(
    client.vpcs.createVirtualIp({ ...base, privateIp: "10.0.0.60", announcerVmIds: ["vm-a", " "] }),
    isValidation("invalid_announcer_vm_ids", /blank/),
  );
  const created = await client.vpcs.createVirtualIp({ ...base, privateIp: " 10.0.0.60 ", announcerVmIds: ["vm-a", "vm-a"] });
  assert.deepEqual(calls.at(-1).body, { subnet_id: "s", private_ip: "10.0.0.60", purpose: "metallb", announcer_vm_ids: ["vm-a"] });
  assert.equal(created.virtual_ip_id, "pvip-3");
  await assert.rejects(
    client.vpcs.deleteVirtualIp({ workspaceId: WS, vpcId: "v", virtualIpId: "pvip-1" }),
    isValidation("virtual_ip_has_reserved_ip", /Detach the Reserved IP/),
  );
  await assert.rejects(
    client.vpcs.deleteVirtualIp({ workspaceId: WS, vpcId: "v", virtualIpId: "pvip-2" }),
    isValidation("virtual_ip_has_rules"),
  );
  calls.length = 0;
  await client.vpcs.deleteVirtualIp({ workspaceId: WS, vpcId: "v", virtualIpId: "pvip-2", checkState: false });
  assert.deepEqual(sent(calls), ["DELETE /networking/vpcs/v/virtual-ips/pvip-2"]);
});

// ------------------------------------------------------------ Reserved IPs

test("reserve validates site, label and billing catalog, with optional preflight", async () => {
  const { calls, client } = router([
    ["POST", /^\/billing\/resource-eligibility$/, ALLOW("RESERVED-IP")],
    ["POST", /^\/networking\/reserved-ips$/, { public_ip_id: "r" }],
  ]);
  await assert.rejects(client.reservedIps.reserve({ workspaceId: WS, siteId: " " }), isValidation("invalid_site_id", /Choose a location/));
  await assert.rejects(client.reservedIps.reserve({ workspaceId: WS, siteId: "s", label: "x".repeat(121) }), isValidation("invalid_label"));
  await assert.rejects(
    client.reservedIps.reserve({ workspaceId: WS, siteId: "s", billingCatalog: { sku_code: "RESERVED-IP" } }),
    isValidation("invalid_billing_catalog", /sku_id/),
  );
  assert.equal(calls.length, 0);
  await client.reservedIps.reserve({ workspaceId: WS, siteId: " s ", label: " web ", billingCatalog: RIP_CATALOG, checkBilling: true });
  assert.deepEqual(sent(calls), ["POST /billing/resource-eligibility", "POST /networking/reserved-ips"]);
  assert.equal(calls[0].body.sku_code, "RESERVED-IP");
  assert.deepEqual(calls[1].body, {
    site_id: "s", label: "web", billing_catalog: { sku_id: "sku-rip", sku_code: "RESERVED-IP", unit_price_minor: 250 },
  });
});

test("Reserved IP update validates reverse DNS and needs a field", async () => {
  const { calls, client } = router([["PATCH", /reserved-ips\/r$/, {}]]);
  await assert.rejects(client.reservedIps.update({ workspaceId: WS, reservedIpId: "r" }), isValidation("no_changes"));
  await assert.rejects(client.reservedIps.update({ workspaceId: WS, reservedIpId: "r", reverseDns: "not a host" }), isValidation("invalid_reverse_dns"));
  await client.reservedIps.update({ workspaceId: WS, reservedIpId: "r", reverseDns: " ", label: " a " });
  assert.deepEqual(calls[0].body, { label: "a", reverse_dns: "" });
});

test("release refuses attached IPs with the portal wording", async () => {
  const { calls, client } = router([
    ["GET", /reserved-ips\/nat$/, { public_ip_id: "nat", attached_resource_id: "n1", attached_resource_type: "nat_gateway" }],
    ["GET", /reserved-ips\/vm$/, { public_ip_id: "vm", attached_resource_id: "v1", attached_resource_type: "vm" }],
    ["GET", /reserved-ips\/free$/, { public_ip_id: "free" }],
    ["DELETE", /reserved-ips\/free$/, { status: 204, json: null }],
  ]);
  await assert.rejects(client.reservedIps.release({ workspaceId: WS, reservedIpId: "nat" }), isValidation("reserved_ip_attached", /NAT Gateway/));
  await assert.rejects(client.reservedIps.release({ workspaceId: WS, reservedIpId: "vm" }), isValidation("reserved_ip_attached", /Detach this IP/));
  calls.length = 0;
  await client.reservedIps.release({ workspaceId: WS, reservedIpId: "free" });
  assert.deepEqual(sent(calls), ["GET /networking/reserved-ips/free", "DELETE /networking/reserved-ips/free"]);
});

test("attach: state rules, detach-from-service and the non-VPC 404", async () => {
  const { calls, client } = router([
    ["GET", /reserved-ips\/onvm$/, { attached_resource_id: "v1", attached_resource_type: "vm", attached_allocation_id: "a" }],
    ["GET", /reserved-ips\/onnat$/, { attached_resource_id: "n1", attached_resource_type: "nat_gateway" }],
    ["GET", /reserved-ips\/free$/, {}],
    ["POST", /reserved-ips\/onnat\/detach$/, {}],
    ["POST", /reserved-ips\/onnat\/attach$/, { status: "attached" }],
    ["POST", /reserved-ips\/free\/attach$/, {
      status: 404, json: { detail: "Reserved IP attach and move require a VPC network allocation; use /public-ips/convert" },
    }],
  ]);
  await assert.rejects(client.reservedIps.attach({ workspaceId: WS, reservedIpId: "onvm", vmId: "vm2" }), isValidation(null, /use move/));
  await assert.rejects(client.reservedIps.attach({ workspaceId: WS, reservedIpId: "onnat", vmId: "vm2" }), isValidation(null, /detachFromService/));
  calls.length = 0;
  await client.reservedIps.attach({ workspaceId: WS, reservedIpId: "onnat", vmId: " vm2 ", detachFromService: true });
  assert.deepEqual(sent(calls), [
    "GET /networking/reserved-ips/onnat",
    "POST /networking/reserved-ips/onnat/detach",
    "POST /networking/reserved-ips/onnat/attach",
  ]);
  assert.deepEqual(calls[2].body, { vm_id: "vm2" });
  await assert.rejects(
    client.reservedIps.attach({ workspaceId: WS, reservedIpId: "free", vmId: "vm2" }),
    (e) => e instanceof ReservedIpTargetUnsupportedError && e instanceof IbeeValidationError && e.statusCode === 404 && /convert/.test(e.message),
  );
});

test("move and detach apply the portal state rules", async () => {
  const { calls, client } = router([
    ["GET", /reserved-ips\/free$/, { public_ip_id: "free" }],
    ["GET", /reserved-ips\/conv$/, { attached_resource_id: "v1", attached_resource_type: "vm", allocation_method: "converted" }],
    ["GET", /reserved-ips\/onvm$/, { attached_resource_id: "v1", attached_resource_type: "vm", attached_allocation_id: "a" }],
    ["POST", /reserved-ips\/onvm\/(move|detach)$/, {}],
  ]);
  await assert.rejects(client.reservedIps.move({ workspaceId: WS, reservedIpId: "free", vmId: "v2" }), isValidation("reserved_ip_not_attached"));
  await assert.rejects(client.reservedIps.move({ workspaceId: WS, reservedIpId: "conv", vmId: "v2" }), isValidation("reserved_ip_not_movable"));
  await assert.rejects(client.reservedIps.move({ workspaceId: WS, reservedIpId: "onvm", vmId: "v1" }), isValidation("reserved_ip_same_target"));
  await client.reservedIps.move({ workspaceId: WS, reservedIpId: "onvm", vmId: "v2", vpcId: "vpc", subnetId: "s" });
  assert.deepEqual(calls.at(-1).body, { vm_id: "v2", vpc_id: "vpc", subnet_id: "s" });
  calls.length = 0;
  const unchanged = await client.reservedIps.detach({ workspaceId: WS, reservedIpId: "free" });
  assert.equal(unchanged.public_ip_id, "free");
  assert.deepEqual(sent(calls), ["GET /networking/reserved-ips/free"]);
  await assert.rejects(client.reservedIps.detach({ workspaceId: WS, reservedIpId: "conv" }), isValidation("reserved_ip_converted_active"));
});

test("convert runs the RESERVED-IP preflight and posts to /convert", async () => {
  const { calls, client } = router([
    ["POST", /^\/billing\/resource-eligibility$/, ALLOW("RESERVED-IP")],
    ["POST", /^\/networking\/reserved-ips\/convert$/, { public_ip_id: "r", allocation_method: "converted" }],
  ]);
  await assert.rejects(client.reservedIps.convert({ workspaceId: WS, vmId: " ", siteId: "s" }), isValidation("invalid_vm_id", /existing VM public IPv4/));
  await assert.rejects(client.reservedIps.convert({ workspaceId: WS, vmId: "vm", siteId: "" }), isValidation("invalid_site_id", /valid location/));
  const rip = await client.reservedIps.convert({ workspaceId: WS, vmId: " vm ", siteId: "s", label: " keep " });
  assert.equal(rip.allocation_method, "converted");
  assert.deepEqual(sent(calls), ["POST /billing/resource-eligibility", "POST /networking/reserved-ips/convert"]);
  assert.deepEqual(calls[1].body, { vm_id: "vm", site_id: "s", label: "keep" });
  calls.length = 0;
  await client.reservedIps.convert({ workspaceId: WS, vmId: "vm", siteId: "s", billingCheck: false });
  assert.deepEqual(sent(calls), ["POST /networking/reserved-ips/convert"]);

  const denied = router([["POST", /resource-eligibility$/, { status: 403, json: { error: "insufficient_scope", required_scope: "billing.read" } }]]);
  await assert.rejects(
    denied.client.reservedIps.convert({ workspaceId: WS, vmId: "vm", siteId: "s" }),
    (e) => e instanceof ForbiddenError && /billingCheck: false/.test(e.message),
  );
});

test("attachVirtualIp posts the virtual IP and refuses attached addresses", async () => {
  const { calls, client } = router([
    ["GET", /reserved-ips\/busy$/, { attached_resource_id: "x" }],
    ["GET", /reserved-ips\/free$/, {}],
    ["POST", /reserved-ips\/free\/attach-virtual-ip$/, { attached_resource_type: "vpc_virtual_ip" }],
  ]);
  await assert.rejects(
    client.reservedIps.attachVirtualIp({ workspaceId: WS, reservedIpId: "busy", virtualIpId: "pvip-1" }),
    isValidation("reserved_ip_attached", /unattached address/),
  );
  await client.reservedIps.attachVirtualIp({ workspaceId: WS, reservedIpId: "free", virtualIpId: " pvip-1 " });
  assert.deepEqual(calls.at(-1).body, { virtual_ip_id: "pvip-1" });
});

// --------------------------------------------------------------- firewalls

test("firewall group create: trimmed name, case-insensitive duplicates, no is_default", async () => {
  const { calls, client } = router([
    ["GET", /^\/networking\/firewall-groups$/, [{ firewall_group_id: "g1", name: "Web " }]],
    ["POST", /^\/networking\/firewall-groups$/, { firewall_group_id: "g2" }],
  ]);
  await assert.rejects(client.firewalls.createGroup({ workspaceId: WS, name: " web" }), isValidation("duplicate_name"));
  assert.equal(calls[0].query.get("summary"), "true");
  assert.equal(calls[0].query.get("limit"), "100");
  await assert.rejects(client.firewalls.createGroup({ workspaceId: WS, name: "x", isDefault: true }), isValidation("invalid_is_default"));
  await assert.rejects(client.firewalls.createGroup({ workspaceId: WS, name: "x".repeat(121) }), isValidation("invalid_name", /120/));
  calls.length = 0;
  await client.firewalls.createGroup({ workspaceId: WS, name: " api ", description: " " });
  assert.deepEqual(calls.at(-1).body, { name: "api" });
  calls.length = 0;
  await client.firewalls.createGroup({ workspaceId: WS, name: "api", checkDuplicateName: false, isDefault: false });
  assert.deepEqual(sent(calls), ["POST /networking/firewall-groups"]);
});

test("firewall rule create/update/delete: portal defaults and system-managed guard", async () => {
  const group = { firewall_group_id: "g", rules: [{ rule_id: "sys", system_managed: true }, { rule_id: "r1" }] };
  const { calls, client } = router([
    ["GET", /^\/networking\/firewall-groups\/g$/, group],
    ["POST", /\/rules$/, group],
    ["PATCH", /\/rules\/\w+$/, group],
    ["DELETE", /\/rules\/\w+$/, group],
  ]);
  await client.firewalls.createRule({ workspaceId: WS, firewallGroupId: "g", protocol: "udp", portStart: 53, remoteTargets: "10.1.1.1" });
  assert.deepEqual(calls[0].body, {
    protocol: "udp", port_start: 53, port_end: 53, remote_targets: ["10.1.1.1/32"], direction: "ingress", action: "allow",
  });
  await assert.rejects(
    client.firewalls.updateRule({ workspaceId: WS, firewallGroupId: "g", firewallRuleId: "sys", enabled: false }),
    isValidation("system_managed_rule", /cannot be updated/),
  );
  await assert.rejects(
    client.firewalls.deleteRule({ workspaceId: WS, firewallGroupId: "g", firewallRuleId: "sys" }),
    isValidation("system_managed_rule", /cannot be removed/),
  );
  await assert.rejects(
    client.firewalls.updateRule({ workspaceId: WS, firewallGroupId: "g", firewallRuleId: "r1", protocol: "tcp" }),
    isValidation("invalid_port"),
  );
  calls.length = 0;
  await client.firewalls.updateRule({ workspaceId: WS, firewallGroupId: "g", firewallRuleId: "r1", protocol: "tcp", portStart: 8000, portEnd: 8080 });
  assert.deepEqual(sent(calls), ["GET /networking/firewall-groups/g", "PATCH /networking/firewall-groups/g/rules/r1"]);
  assert.deepEqual(calls[1].body, { protocol: "tcp", port_start: 8000, port_end: 8080 });
});

test("firewall summaries, attachments paging and attach eligibility error", async () => {
  const { calls, client } = router([
    ["GET", /^\/networking\/firewall-groups$/, [{ firewall_group_id: "g", rule_count: 2 }]],
    ["GET", /attachments$/, []],
    ["POST", /attachments$/, { status: 400, json: { detail: "Only OVS/OVN-backed VM networks can attach firewall groups" } }],
  ]);
  await client.firewalls.listGroupSummaries({ workspaceId: WS, limit: 11 });
  assert.equal(calls[0].query.get("summary"), "true");
  assert.equal(calls[0].query.get("limit"), "11");
  await assert.rejects(client.firewalls.listAttachments({ workspaceId: WS, firewallGroupId: "g", limit: 501 }), isValidation("invalid_limit"));
  await client.firewalls.listAttachments({ workspaceId: WS, firewallGroupId: "g", limit: 500, skip: 0 });
  await assert.rejects(
    client.firewalls.attach({ workspaceId: WS, firewallGroupId: "g", vmId: "vm" }),
    isValidation("firewall_attach_unsupported", /OVS\/OVN/),
  );
  assert.equal((await client.firewalls.listAllGroups({ workspaceId: WS })).length, 1);
});

// ---------------------------------------------------------- load balancers

test("L4 create supplies managed passthrough TLS and validates policy and health checks", async () => {
  const { calls, client } = router([["POST", /load-balancers\/l4$/, (c) => c.body]]);
  const base = { workspaceId: WS, name: " edge ", backends: [{ target: "10.0.0.5", port: 443, type: "ip" }] };
  await client.loadBalancers.createL4({
    ...base,
    protocol: "tls_passthrough",
    policy: { timeout_ms: 30000, retries: { attempts: 3, per_retry_timeout_ms: 5000, on: ["5xx"] }, proxy_protocol_enabled: false },
    healthCheck: { active: { type: "tcp", interval_ms: 10000, timeout_ms: 2000, healthy_threshold: 2, unhealthy_threshold: 3 } },
    observability: { logs_enabled: true },
  });
  assert.deepEqual(calls[0].body, {
    name: "edge",
    protocol: "tls_passthrough",
    backends: [{ type: "ip", target: "10.0.0.5", port: 443 }],
    policy: { timeout_ms: 30000, proxy_protocol_enabled: false, retries: { attempts: 3, per_retry_timeout_ms: 5000, on: ["5xx"] } },
    health_check: { active: { type: "tcp", interval_ms: 10000, timeout_ms: 2000, healthy_threshold: 2, unhealthy_threshold: 3 } },
    observability: { logs_enabled: true },
    tls: { mode: "passthrough", certificate_source: "managed" },
  });
  const bad = [
    [{ protocol: "http" }, "invalid_protocol"],
    [{ protocol: "tcp", tls: { mode: "passthrough" } }, "invalid_tls"],
    [{ protocol: "tls_passthrough", tls: { mode: "passthrough", certificate_source: "custom", cert_pem: "x" } }, "invalid_tls"],
    [{ protocol: "tcp", routing: { sticky_header: "X-User-ID" } }, "invalid_routing"],
    [{ protocol: "tcp", policy: { timeout_ms: 50 } }, "invalid_policy_timeout_ms"],
    [{ protocol: "tcp", policy: { foo: 1 } }, "invalid_policy"],
    [{ protocol: "tcp", healthCheck: { active: { type: "tcp", path: "/health" } } }, "invalid_health_check"],
    [{ protocol: "tcp", healthCheck: { passive: { base_ejection_time_ms: 10 } } }, "invalid_health_check_passive_base_ejection_time_ms"],
    [{ protocol: "tcp", backends: [] }, "invalid_backend"],
    [{ protocol: "tcp", backends: [{ target: "svc:80", port: 80 }] }, "invalid_backend"],
    [{ protocol: "tcp", backends: [{ target: "1.2.3", port: 80, type: "ip" }] }, "invalid_backend"],
    [{ protocol: "tcp", backends: [{ target: "host", port: 80, type: "hostname" }] }, "invalid_backend"],
    [{ protocol: "tcp", backends: [{ target: "svc", port: 80, weight: 0 }] }, "invalid_backends_weight"],
  ];
  for (const [extra, code] of bad) {
    await assert.rejects(client.loadBalancers.createL4({ ...base, ...extra }), isValidation(code), JSON.stringify(extra));
  }
  assert.equal(calls.length, 1);
});

test("L7 create: managed TLS for https, custom domain and rule normalisation", async () => {
  const { calls, client } = router([
    ["POST", /^\/billing\/resource-eligibility$/, ALLOW("LOADBALA-STD")],
    ["POST", /load-balancers\/l7$/, (c) => c.body],
  ]);
  const base = { workspaceId: WS, name: "web", backends: [{ target: "web-svc", port: 8080 }] };
  await client.loadBalancers.createL7({
    ...base,
    protocol: "https",
    routing: { algorithm: "round_robin", sticky_header: " X-User-ID " },
    customDomain: { hostname: " App.Example.COM. " },
    rules: [{ priority: 2, path_prefix: " ", headers: { " x-env ": " prod " } }],
    checkBilling: true,
  });
  assert.equal(calls[0].body.sku_code, "LOADBALA-STD");
  assert.deepEqual(calls[1].body, {
    name: "web",
    protocol: "https",
    backends: [{ target: "web-svc", port: 8080 }],
    routing: { algorithm: "round_robin", sticky_header: "X-User-ID" },
    tls: { mode: "terminate", certificate_source: "managed" },
    rules: [{ priority: 2, path_prefix: "/", headers: { "x-env": "prod" } }],
    custom_domain: { hostname: "app.example.com" },
  });
  await assert.rejects(
    client.loadBalancers.createL7({ ...base, protocol: "http", customDomain: { hostname: "a.example.com" } }),
    isValidation("invalid_custom_domain"),
  );
  await assert.rejects(client.loadBalancers.createL7({ ...base, protocol: "http", rules: [{ path_prefix: "api" }] }), isValidation("invalid_rules"));
  await assert.rejects(client.loadBalancers.createL7({ ...base, protocol: "http", rules: [{ priority: 0 }] }), isValidation("invalid_rules", /positive/));
  await assert.rejects(client.loadBalancers.createL7({ ...base, protocol: "https", tls: { mode: "passthrough" } }), isValidation("invalid_tls"));
  await assert.rejects(client.loadBalancers.createL7({ ...base, name: " ", protocol: "http" }), isValidation("invalid_name", /Name is required/));
});

test("LB updates: at least one field, L4 rejects L7 fields, customDomain null clears", async () => {
  const { calls, client } = router([["PATCH", /load-balancers\/l[47]\/lb1$/, (c) => c.body]]);
  await assert.rejects(client.loadBalancers.updateL4({ workspaceId: WS, loadBalancerId: "lb1" }), isValidation("no_changes"));
  await assert.rejects(
    client.loadBalancers.updateL4({ workspaceId: WS, loadBalancerId: "lb1", rules: [] }),
    isValidation("invalid_rules"),
  );
  await client.loadBalancers.updateL7({ workspaceId: WS, loadBalancerId: "lb1", customDomain: null });
  assert.deepEqual(calls.at(-1).body, { custom_domain: null });
  await client.loadBalancers.updateL4({ workspaceId: WS, loadBalancerId: "lb1", healthCheck: { active: { type: "http", path: " /ready " } } });
  assert.deepEqual(calls.at(-1).body, { health_check: { active: { type: "http", path: "/ready" } } });
  await assert.rejects(
    client.loadBalancers.updateL7({ workspaceId: WS, loadBalancerId: "lb1", tls: { mode: "terminate", key_pem: "k" } }),
    isValidation("invalid_tls", /Custom certificates/),
  );
});

test("LB list filters and include_deleted", async () => {
  const { calls, client } = router([["GET", /load-balancers(\/lb1)?$/, []]]);
  await client.loadBalancers.list({ workspaceId: WS, status: "deleted", layer: "l7", protocol: "https", limit: 500 });
  assert.equal(calls[0].query.get("include_deleted"), "true");
  assert.equal(calls[0].query.get("limit"), "500");
  await assert.rejects(client.loadBalancers.list({ workspaceId: WS, layer: "l4", protocol: "https" }), isValidation("invalid_protocol"));
  await assert.rejects(client.loadBalancers.list({ workspaceId: WS, status: "gone" }), isValidation("invalid_status"));
  await assert.rejects(client.loadBalancers.list({ workspaceId: WS, limit: 501 }), isValidation("invalid_limit"));
  await client.loadBalancers.get({ workspaceId: WS, loadBalancerId: "lb1", includeDeleted: true });
  assert.equal(calls.at(-1).query.get("include_deleted"), "true");
});

test("LB create edge billing denial is a BillingDeniedError for the load balancer", async () => {
  const { client } = router([
    ["POST", /load-balancers\/l4$/, { status: 402, json: { error: "billing_denied", billing_reason: "insufficient_balance", billing_sku_code: "LOADBALA-STD" } }],
  ]);
  await assert.rejects(
    client.loadBalancers.createL4({ workspaceId: WS, name: "e", protocol: "tcp", backends: [{ target: "s", port: 1 }] }),
    (e) => e instanceof BillingDeniedError && e.resourceType === "load_balancer" && e.topupAllowed === true,
  );
});

test("exposes the new networking methods", () => {
  const client = new Ibee({ token: "t" });
  for (const m of ["replaceNatGatewayPublicIp", "waitForNatGatewayAbsent", "listVirtualIps", "getVirtualIp", "createVirtualIp", "deleteVirtualIp"]) {
    assert.equal(typeof client.vpcs[m], "function", m);
  }
  for (const m of ["convert", "attachVirtualIp"]) assert.equal(typeof client.reservedIps[m], "function", m);
  for (const m of ["listGroupSummaries", "iterateGroupSummaries", "listAllGroups"]) assert.equal(typeof client.firewalls[m], "function", m);
});
