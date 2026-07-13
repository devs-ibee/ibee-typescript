# IBEE Solutions TypeScript SDK

Official TypeScript / JavaScript SDK for the IBEE Solutions cloud API. Works in Node 18+ and modern browsers.

## Installation

```bash
npm install @ibee/sdk
```

## Usage

```ts
import { Ibee } from "@ibee/sdk";

const client = new Ibee({ token: "ibee_live_xxxxxxxxxxxx" });

// Object storage
const buckets = await client.objectStorage.listBuckets({ workspaceId: "710995" });
await client.objectStorage.createBucket({
  workspaceId: "710995",
  name: "my-bucket",
  region: "in-south-1",
});

// Secret Store
const stores = await client.secretStore.listSecretStores({ workspaceId: "710995" });

// Cloud VMs
const vms = await client.cloudVms.list({ workspaceId: "710995" });
await client.cloudVms.create({
  workspaceId: "710995",
  name: "web-01",
  os_distro: "ubuntu",
  os_type: "linux",
  cpu: 2,
  ram_mb: 4096,
  plan_id: "plan_standard_2c_4g",
  template_id: "tmpl_ubuntu_2204",
  ssh_key_ids: ["ssh_key_123"],
});
```

## Environments

The client targets **production** (`https://api.ibee.ai/v1`) by default. Use the
development gateway for testing:

```ts
import { Ibee, IbeeEnvironment } from "@ibee/sdk";

const dev = new Ibee({
  token: "ibee_dev_key_xxx",
  environment: IbeeEnvironment.DEVELOPMENT, // https://api.ibee.co.in/v1
});
```

Or override the base URL entirely with `baseUrl`.

## Error handling

Non-2xx responses throw an `ApiError` with the HTTP status and parsed body:

```ts
import { ApiError } from "@ibee/sdk";

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
| `client.objectStorage` | listBuckets, createBucket, deleteBucket |
| `client.cloudVms` / `client.gpuVms` | list, create, get, update, delete, start, stop, reboot, getMetrics, listNetworkInterfaces, attachNetworkInterface, detachNetworkInterface |
| `client.operations` | get |

## Related

- [Python SDK](https://pypi.org/project/ibee/) — `pip install ibee`
- [CLI](https://pypi.org/project/ibee-cli/) — `pip install ibee-cli`
- [API documentation](https://ibee.ai/docs/api-reference)
