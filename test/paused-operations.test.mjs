import assert from "node:assert/strict";
import { test } from "node:test";
import { Ibee, IbeeError } from "../dist/index.js";

for (const family of ["objectStorage", "containerRegistry"]) {
    test(`${family} empty 404 explains the public pause and preserves the body`, async () => {
        const client = new Ibee({ token: "test", workspaceId: "ws-1", fetch: async () => new Response("", { status: 404 }) });
        const call = family === "objectStorage" ? () => client.objectStorage.listBuckets() : () => client.containerRegistry.listContainerRegistries();
        await assert.rejects(call, (error) => {
            assert.ok(error instanceof IbeeError);
            assert.equal(error.statusCode, 404);
            assert.match(error.message, /temporarily paused/);
            assert.equal(error.body, "");
            return true;
        });
    });
}

test("a real resource-not-found body is preserved", async () => {
    const body = { detail: "Bucket not found" };
    const client = new Ibee({ token: "test", workspaceId: "ws-1", fetch: async () => new Response(JSON.stringify(body), { status: 404, headers: { "content-type": "application/json" } }) });
    await assert.rejects(() => client.objectStorage.listBuckets(), (error) => {
        assert.doesNotMatch(error.message, /temporarily paused/);
        assert.deepEqual(error.body, body);
        return true;
    });
});
