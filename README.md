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

const client = new Ibee({ token: "ibee_prod_key_xxxxxxxxxxxx" });

// Object storage
const buckets = await client.objectStorage.listBuckets({ workspaceId: "710995" });
await client.objectStorage.createBucket({
  workspaceId: "710995",
  name: "my-bucket",
  siteId: "site_blr_01",
  region: "in-south-1",
});
const s3Key = await client.objectStorage.createS3Credential({
  workspaceId: "710995",
  name: "application-key",
  bucketScope: "specific",
  allowedBuckets: ["my-bucket"],
});

// Secret Store
const store = await client.secretStore.createSecretStore({
  workspaceId: "710995",
  name: "production-secrets",
});
const secret = await client.secretStore.createSecret({
  workspaceId: "710995",
  storeId: store.id!,
  name: "database-url",
  value: { url: "postgres://user:password@host:5432/app" },
});
const current = await client.secretStore.getSecretValue({
  workspaceId: "710995",
  secretId: secret.id!,
});

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

Use a development token with the development gateway and a production token
with the production gateway. Do not mix tokens or resource IDs between the two
environments.

## Secret Store lifecycle

Every store, secret, application identity, and identity scope belongs to the
workspace supplied as `workspaceId`. Keep the same workspace ID for subsequent
operations on an ID returned by create or list calls. If an ID belongs to a
different workspace, the API intentionally returns `403 FORBIDDEN`; list the
resource in the intended workspace instead of retrying the ID under another
workspace.

Metadata calls such as `getSecret` and `listSecretVersions` do not return secret
values. Value calls such as `getSecretValue` and `getSecretVersion` do. Avoid
logging their responses. AppRole access calls can also return a fresh
`secret_id`, which must be handled as a credential.

```ts
// Create additional versions, inspect metadata, and roll back if required.
await client.secretStore.updateSecretValue({
  workspaceId: "710995",
  secretId: secret.id!,
  value: { url: "postgres://user:new-password@host:5432/app" },
  cas: 1,
});
await client.secretStore.patchSecretValue({
  workspaceId: "710995",
  secretId: secret.id!,
  value: { pool_size: 20 },
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

// Soft delete is recoverable. Permanent deletion is not.
await client.secretStore.deleteSecret({ workspaceId: "710995", secretId: secret.id! });
await client.secretStore.undeleteSecret({
  workspaceId: "710995",
  secretId: secret.id!,
  versions: [versions.current_version],
});
await client.secretStore.permanentlyDeleteSecret({
  workspaceId: "710995",
  secretId: secret.id!,
});
await client.secretStore.permanentlyDeleteSecretStore({
  workspaceId: "710995",
  storeId: store.id!,
});
```

The permanent-delete and version-destroy methods are irreversible. Use them
only after confirming the resource ID and workspace.

Secret Store method coverage:

| Area | Methods |
|---|---|
| Stores | `listSecretStores`, `createSecretStore`, `getSecretStore`, `updateSecretStore`, `archiveSecretStore`, `unarchiveSecretStore`, `permanentlyDeleteSecretStore` |
| Secrets and versions | `listSecrets`, `createSecret`, `batchCreateSecrets`, `getSecret`, `deleteSecret`, `getSecretValue`, `updateSecretValue`, `patchSecretValue`, `undeleteSecret`, `destroySecretVersions`, `permanentlyDeleteSecret`, `listSecretVersions`, `getSecretVersion`, `rollbackSecret` |
| Application identities | `listSecretIdentities`, `createSecretIdentity`, `getSecretIdentity`, `updateSecretIdentity`, `disableSecretIdentity`, `enableSecretIdentity`, `getSecretIdentityAccess`, `rotateSecretIdentitySecretId`, `revokeSecretIdentitySessions`, `deleteSecretIdentity` |
| Identity scopes | `listSecretIdentityScopes`, `createSecretIdentityScope`, `updateSecretIdentityScope`, `deleteSecretIdentityScope` |

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
| `client.secretStore` | 35 operations covering store lifecycle, secret CRUD/batch creation, values and versions, soft-delete/restore/permanent cleanup, and application identity/scope lifecycle |
| `client.objectStorage` | bucket list/create/get/update/delete and S3 credential list/create/get/revoke |
| `client.vpcs` | listSites, list, create, get, update, delete, subnet/node/NAT/port-forwarding lifecycle |
| `client.reservedIps` | list, reserve, get, update, release, attach, move, detach |
| `client.firewalls` | firewall group, rule, and VM attachment lifecycle |
| `client.loadBalancers` | list, createL4, createL7, get, updateL4, updateL7, delete, getStatus |
| `client.computeCatalog` | typed site, plan, and image discovery |
| `client.cloudVms` / `client.gpuVms` | list, create, get, delete, start, stop, reboot, getMetrics |
| `client.operations` | get |

## Related

- [Python SDK](https://pypi.org/project/ibee/) — `pip install ibee`
- [CLI](https://pypi.org/project/ibee-cli/) — `pip install ibee-cli`
- [API documentation](https://ibee.ai/docs/api-reference)
