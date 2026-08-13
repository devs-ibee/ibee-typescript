# IBEE Solutions TypeScript SDK

Official TypeScript / JavaScript SDK for the IBEE Solutions cloud API. Manage
compute, VPC networking, Reserved IPs, firewalls, load balancers, object
storage, and secrets from Node 18+ or modern browsers.

## Installation

```bash
npm install ibee-sdk
```

## Usage

```ts
import { Ibee } from "ibee-sdk";

const client = new Ibee({ token: "ibee_live_xxxxxxxxxxxx" });

// Object storage
const buckets = await client.objectStorage.listBuckets({ workspaceId: "710995" });
await client.objectStorage.createBucket({
  workspaceId: "710995",
  name: "my-bucket",
  region: "in-south-1",
});
const s3Key = await client.objectStorage.createS3Credential({
  workspaceId: "710995",
  name: "application-key",
  bucketScope: "specific",
  allowedBuckets: ["my-bucket"],
});

// Secret Store
const stores = await client.secretStore.listSecretStores({ workspaceId: "710995" });

// Cloud VMs
const vms = await client.cloudVms.list({ workspaceId: "710995" });
const plans = await client.computeCatalog.listPlans({
  workspaceId: "710995",
  vmType: "cloud",
  siteId: "site_blr_01",
  currency: "INR",
  billingInterval: "MONTHLY",
});
await client.cloudVms.create({
  workspaceId: "710995",
  name: "web-01",
  site_id: "site_blr_01",
  os_distro: "ubuntu",
  os_type: "linux",
  cpu: 2,
  ram_mb: 4096,
  plan_id: "plan_standard_2c_4g",
  template_id: "tmpl_ubuntu_2204",
  ssh_key_ids: ["ssh_key_123"],
});

// VM lifecycle and recovery
await client.cloudVms.stop({
  workspaceId: "710995",
  vmId: "vm_123",
});
await client.cloudVms.resize({
  workspaceId: "710995",
  vmId: "vm_123",
  request: { cpu: 4, ram_mb: 8192 },
});
const snapshot = await client.cloudVms.createSnapshot({
  workspaceId: "710995",
  vmId: "vm_123",
  request: { name: "before-upgrade", mode: "all_attached" },
});
await client.cloudVms.enableBackups({
  workspaceId: "710995",
  vmId: "vm_123",
  request: {
    schedule: { frequency: "daily", timezone: "Asia/Kolkata", hour: 20 },
    retention_days: 14,
  },
});

// Sensitive, short-lived graphical console URL — do not log or persist it.
const consoleSession = await client.vmConsole.createSession({
  workspaceId: "710995",
  vmId: "vm_123",
  vmType: "cloud",
});

// VPC networking
const vpc = await client.vpcs.create({
  workspaceId: "710995",
  name: "production",
  siteId: "site_blr_01",
  cidr: "10.20.0.0/24",
});
await client.vpcs.createSubnet({
  workspaceId: "710995",
  vpcId: vpc.vpc_id,
  name: "applications",
  cidr: "10.20.0.0/25",
});

// Public IPs, firewalls, and load balancers
const reservedIp = await client.reservedIps.reserve({
  workspaceId: "710995",
  siteId: "site_blr_01",
  label: "production-ingress",
});
const firewallGroups = await client.firewalls.listGroups({ workspaceId: "710995" });
const loadBalancers = await client.loadBalancers.list({ workspaceId: "710995" });
```

## Environments

The client targets **production** (`https://api.ibee.ai/v1`) by default. Use the
development gateway for testing:

```ts
import { Ibee, IbeeEnvironment } from "ibee-sdk";

const dev = new Ibee({
  token: "ibee_dev_key_xxx",
  environment: IbeeEnvironment.DEVELOPMENT, // https://api.ibee.co.in/v1
});
```

Or override the base URL entirely with `baseUrl`.

## Billing preflight

Every billable SDK create method automatically checks
`client.billing.checkResourceEligibility(...)` before it sends the product
POST. Fixed-price products use their canonical SKU; VM creates resolve the
selected plan through the compute catalog and check its returned SKU. If the
catalog, billing service, SKU binding, or admission decision is unavailable or
invalid, creation fails closed and the product POST is not sent.

You can still call `client.billing.checkResourceEligibility(...)` directly to
show billing readiness before collecting a create form. A successful preflight
is not a reservation: the product service repeats the authoritative billing
check during creation.

## Secret Store lifecycle

Secret Store exposes the complete store, secret-version, application-identity,
and identity-scope lifecycle. Every request requires the owning `workspaceId`.
Value and identity-access responses may contain sensitive credentials and must
not be logged.

```ts
await client.secretStore.patchSecretValue({
  workspaceId: "710995",
  secretId: secret.id!,
  value: { username: "payments-v2" },
});
const versions = await client.secretStore.listSecretVersions({
  workspaceId: "710995",
  secretId: secret.id!,
});
await client.secretStore.rollbackSecret({
  workspaceId: "710995",
  secretId: secret.id!,
  version: versions.oldest_version,
});
```

Stores support archive, unarchive, and explicit permanent deletion. Secrets
support batch creation, soft deletion, undelete, version destruction, rollback,
and permanent deletion. Workload identities support AppRole or Kubernetes
authentication, credential rotation, session revocation, and per-store scopes.
Permanent-delete and version-destroy operations are irreversible.

## Error handling

Non-2xx responses throw an `ApiError` with the HTTP status and parsed body:

```ts
import { ApiError } from "ibee-sdk";

try {
  await client.secretStore.listSecretStores({ workspaceId: "710995" });
} catch (err) {
  if (err instanceof ApiError) {
    console.error(err.statusCode, err.body);
  }
}
```

## Resources

| Resource | Methods |
|---|---|
| `client.secretStore` | listSecretStores, createSecretStore, getSecretStore, updateSecretStore, archiveSecretStore, listSecrets, createSecret, getSecret, deleteSecret, getSecretValue, updateSecretValue |
| `client.objectStorage` | bucket list/create/get/update/delete and S3 credential list/create/get/revoke |
| `client.vpcs` | listSites, list, create, get, update, delete, subnet/node/NAT/port-forwarding lifecycle |
| `client.reservedIps` | list, reserve, get, update, release, attach, move, detach |
| `client.firewalls` | firewall group, rule, and VM attachment lifecycle |
| `client.loadBalancers` | list, createL4, createL7, get, updateL4, updateL7, delete, getStatus |
| `client.computeCatalog` | typed site, plan, and image discovery |
| `client.billing` | automatic and explicit billing resource-eligibility preflight for billable creates |
| `client.cloudVms` / `client.gpuVms` | full lifecycle: power, access, resize/precheck, volumes, mount guidance, events, metrics, snapshots, backup policy/runs, and restore |
| `client.vmConsole` | createSession, getSession, closeSession |
| `client.operations` | get |

## Related

- [Python SDK](https://pypi.org/project/ibee/) — `pip install ibee`
- [CLI](https://pypi.org/project/ibee-cli/) — `pip install ibee-cli`
- [API documentation](https://ibee.ai/docs/api-reference)
