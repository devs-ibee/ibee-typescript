import type { HttpClient } from "../core.js";
import type {
  DeleteResponse,
  Secret,
  SecretList,
  SecretStore,
  SecretStoreList,
  SecretValue,
} from "../types.js";

export class SecretStoreResource {
  constructor(private readonly http: HttpClient) {}

  listSecretStores(args: { workspaceId: string }): Promise<SecretStoreList> {
    return this.http.request({
      method: "GET",
      path: "/secret-store/stores",
      workspaceId: args.workspaceId,
    });
  }

  createSecretStore(args: {
    workspaceId: string;
    name: string;
    description?: string;
  }): Promise<SecretStore> {
    return this.http.request({
      method: "POST",
      path: "/secret-store/stores",
      workspaceId: args.workspaceId,
      body: { name: args.name, description: args.description },
    });
  }

  getSecretStore(args: {
    workspaceId: string;
    storeId: string;
  }): Promise<SecretStore> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}`,
      workspaceId: args.workspaceId,
    });
  }

  updateSecretStore(args: {
    workspaceId: string;
    storeId: string;
    name?: string;
    description?: string;
  }): Promise<SecretStore> {
    return this.http.request({
      method: "PATCH",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}`,
      workspaceId: args.workspaceId,
      body: { name: args.name, description: args.description },
    });
  }

  archiveSecretStore(args: {
    workspaceId: string;
    storeId: string;
  }): Promise<SecretStore> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}/archive`,
      workspaceId: args.workspaceId,
    });
  }

  listSecrets(args: {
    workspaceId: string;
    storeId: string;
  }): Promise<SecretList> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}/secrets`,
      workspaceId: args.workspaceId,
    });
  }

  createSecret(args: {
    workspaceId: string;
    storeId: string;
    name: string;
    data: Record<string, string>;
  }): Promise<Secret> {
    return this.http.request({
      method: "POST",
      path: `/secret-store/stores/${encodeURIComponent(args.storeId)}/secrets`,
      workspaceId: args.workspaceId,
      body: { name: args.name, data: args.data },
    });
  }

  getSecret(args: {
    workspaceId: string;
    secretId: string;
  }): Promise<Secret> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}`,
      workspaceId: args.workspaceId,
    });
  }

  deleteSecret(args: {
    workspaceId: string;
    secretId: string;
  }): Promise<DeleteResponse> {
    return this.http.request({
      method: "DELETE",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}`,
      workspaceId: args.workspaceId,
    });
  }

  getSecretValue(args: {
    workspaceId: string;
    secretId: string;
  }): Promise<SecretValue> {
    return this.http.request({
      method: "GET",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}/value`,
      workspaceId: args.workspaceId,
    });
  }

  updateSecretValue(args: {
    workspaceId: string;
    secretId: string;
    data: Record<string, string>;
  }): Promise<SecretValue> {
    return this.http.request({
      method: "PUT",
      path: `/secret-store/secrets/${encodeURIComponent(args.secretId)}/value`,
      workspaceId: args.workspaceId,
      body: { data: args.data },
    });
  }
}
