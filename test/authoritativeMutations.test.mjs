import assert from "node:assert/strict";
import { test } from "node:test";
import { Ibee, ELIGIBILITY_OPERATIONS } from "../dist/index.js";

const workspaceId = "710995";
const base = { workspaceId };
const mutations = [
  ["bucket", (c, flag) => c.objectStorage.createBucket({ ...base, name: "assets", preflightBilling: flag })],
  ["credential", (c, flag) => c.objectStorage.createS3Credential({ ...base, preflightBilling: flag })],
  ["store", (c, flag) => c.secretStore.createSecretStore({ ...base, name: "app", billingPreflight: flag })],
  ["secret", (c, flag) => c.secretStore.createSecret({ ...base, storeId: "store", name: "key", value: { key: "value" }, billingPreflight: flag })],
  ["archive", c => c.secretStore.archiveSecretStore({ ...base, storeId: "store" })],
  ["undelete", c => c.secretStore.undeleteSecret({ ...base, secretId: "secret", versions: [1] })],
  ["rollback", c => c.secretStore.rollbackSecret({ ...base, secretId: "secret", version: 1, checkTarget: false })],
  ["block-volume", c => c.blockStorage.createVolume({ ...base, name: "data", size_gb: 10, site_id: "site", resolveSiteName: false })],
  ...["cloudVms", "gpuVms"].flatMap(family => [
    [family + "-snapshot", (c, flag) => c[family].createSnapshot({ ...base, vmId: "0123456789abcdef01234567", request: { name: "snap", billing_catalog: { sku_id: 1, sku_code: "SNAPSHOT-STD", product_code: "snapshot_storage" } }, preflightBilling: flag })],
    [family + "-backup", (c, flag) => c[family].createBackupRun({ ...base, vmId: "0123456789abcdef01234567", request: { billing_catalog: { sku_id: 2, sku_code: "BACKUP-STD", product_code: "backup_storage" } }, preflightBilling: flag })],
  ]),
  ["unarchive", c => c.secretStore.unarchiveSecretStore({ ...base, storeId: "store" })],
  ["cdn", (c, flag) => c.cdn.createDistribution({ ...base, name: "assets", origin_id: "bucket", preflightBilling: flag })],
  ["domain", (c, flag) => c.cdn.createCustomDomain({ ...base, distributionId: "dist", domain: "cdn.example.com", preflightBilling: flag })],
  ["reserved-ip", (c, flag) => c.reservedIps.reserve({ ...base, siteId: "site", checkBilling: flag })],
  ["convert-ip", (c, flag) => c.reservedIps.convert({ ...base, vmId: "vm", siteId: "site", billingCheck: flag })],
  ["nat", (c, flag) => c.vpcs.createNatGateway({ ...base, vpcId: "vpc", validateVpc: false, billingCatalog: { sku_id: 1, sku_code: "NAT-GATEWAY" }, preflightBilling: flag })],
  ["firewall", c => c.firewalls.createGroup({ ...base, name: "web" })],
  ["vpc-update", c => c.vpcs.update({ ...base, vpcId: "vpc", name: "renamed" })],
];

for (const [name, mutate] of mutations) {
  for (const flag of [undefined, false, true]) {
    for (const [status, code] of [[200, null], [402, "billing_denied"], [403, "organization_restricted"],
      [423, "organization_suspended"], [403, "key_revoked"], [403, "workspace_not_allowed"], [403, "insufficient_scope"]]) {
      test(`${name}: flag=${flag}, upstream=${code ?? "success"}`, async () => {
        const calls = [];
        const client = new Ibee({ token: "fixture", maxRetries: 0, fetch: async (url, init) => {
          calls.push({ url: String(url), init });
          assert.ok(!String(url).includes("billing/resource-eligibility"));
          assert.ok(!String(init.body).includes("estimated_cost_minor"));
          assert.equal(new URL(url).searchParams.get("workspace_id"), workspaceId);
          if (init.method === "GET") return new Response(JSON.stringify({ items: [] }));
          return new Response(JSON.stringify(code ? {
            error: code, message: "upstream decision", billing_reason: "insufficient_balance",
            admission_context_id: "adm_upstream", required_scope: "product.write",
          } : { id: "created", name: "app" }), { status, headers: { "content-type": "application/json" } });
        } });
        if (code) await assert.rejects(mutate(client, flag), e =>
          e.statusCode === status && e.code === code && e.admissionContextId === "adm_upstream");
        else await mutate(client, flag);
        assert.equal(calls.filter(c => !["GET", "HEAD", "OPTIONS"].includes(c.init.method)).length, 1);
      });
    }
  }
}

for (const operation of ELIGIBILITY_OPERATIONS) {
  test(`explicit ${operation} denial is data`, async () => {
    const client = new Ibee({ token: "fixture", fetch: async (url, init) => {
      assert.ok(String(url).includes("/billing/resource-eligibility"));
      assert.deepEqual(JSON.parse(init.body), { operation });
      return new Response(JSON.stringify({ organization_id: "org", allowed: false, reason: "upstream", operation }));
    } });
    assert.equal((await client.billing.checkResourceEligibility({ workspaceId, operation })).allowed, false);
  });
}
