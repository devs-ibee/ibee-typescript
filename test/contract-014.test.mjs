import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { IbeeError, LockedError, PaymentRequiredError } from "../dist/index.js";
import { stubClient } from "./helpers.mjs";

const S3 = "https://710995.blob.ibeestorage.com";
const DATA = new TextEncoder().encode("hello from the ibee sdk\n");
const SHA = createHash("sha256").update(DATA).digest("base64");

async function caught(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    assert.fail("expected an error");
}

/** The API answers the link; the S3 host answers the PUT (recorded with its raw body). */
function uploadStub(putStatus = 200, putBody = "") {
    const puts = [];
    const { client, calls } = stubClient((call) => ({
        json: {
            url: `${S3}/b1/docs/a.txt?X-Amz-Signature=sig`,
            method: "PUT",
            headers: {
                "Content-Length": String(call.body.size_bytes),
                "x-amz-checksum-sha256": call.body.checksum_sha256,
                ...(call.body.content_type ? { "Content-Type": call.body.content_type } : {}),
            },
            expires_in: 900,
            max_bytes: 80000000,
        },
    }));
    const apiFetch = client._options.fetch;
    client._options.fetch = async (url, init) => {
        if (new URL(String(url)).host.endsWith("ibeestorage.com")) {
            puts.push({ url: new URL(String(url)), method: init.method, headers: new Headers(init.headers), body: init.body });
            return new Response(putBody, { status: putStatus, headers: { etag: '"abc"' } });
        }
        return apiFetch(url, init);
    };
    return { client, calls, puts };
}

test("object link and metadata calls keep '/' between key segments", async () => {
    const { client, calls } = stubClient((call) => ({
        json: call.path.endsWith("/metadata") ? { name: "docs/a b.txt", bucket: "b1", size_bytes: 24 } : { url: `${S3}/x`, expires_in: 60 },
    }));
    await client.objectStorage.createObjectDownloadLink({ bucket_name: "b1", object_path: "docs/a b.txt", expires: 60, disposition: "attachment" });
    await client.objectStorage.getObjectMetadata({ bucket_name: "b1", object_path: "docs/a b.txt" });
    assert.deepEqual(
        calls.map((c) => [c.method, c.url.pathname]),
        [
            ["POST", "/v1/object-storage/buckets/b1/objects/docs/a%20b.txt/download-link"],
            ["GET", "/v1/object-storage/buckets/b1/objects/docs/a%20b.txt/metadata"],
        ],
    );
    assert.deepEqual(calls[0].body, { expires: 60, disposition: "attachment" });
    assert.ok(calls.every((c) => c.url.searchParams.get("workspace_id") === "710995"));
});

test("uploadFile sends size and SHA-256, then PUTs the bytes without the API token", async () => {
    const { client, calls, puts } = uploadStub();
    const result = await client.uploadFile({ bucket_name: "b1", object_path: "docs/a.txt", data: DATA, content_type: "text/plain" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, "/v1/object-storage/buckets/b1/objects/docs/a.txt/upload-link");
    assert.deepEqual(calls[0].body, { size_bytes: DATA.byteLength, checksum_sha256: SHA, content_type: "text/plain" });
    assert.equal(puts.length, 1);
    const put = puts[0];
    assert.equal(put.method, "PUT");
    assert.equal(put.url.host, "710995.blob.ibeestorage.com");
    assert.deepEqual(new Uint8Array(put.body), DATA);
    assert.equal(put.headers.get("x-amz-checksum-sha256"), SHA);
    assert.equal(put.headers.get("content-type"), "text/plain");
    assert.equal(put.headers.get("authorization"), null);
    assert.deepEqual(result, { bucket_name: "b1", object_path: "docs/a.txt", size_bytes: DATA.byteLength, checksum_sha256: SHA, etag: '"abc"' });
});

test("uploadFile takes text and Blobs", async () => {
    const { client, calls, puts } = uploadStub();
    await client.uploadFile({ bucket_name: "b1", object_path: "a.txt", data: "hello from the ibee sdk\n", expires: 60 });
    await client.uploadFile({ bucket_name: "b1", object_path: "a.txt", data: new Blob([DATA]) });
    assert.equal(calls[0].body.checksum_sha256, SHA);
    assert.equal(calls[0].body.expires, 60);
    assert.equal(calls[1].body.checksum_sha256, SHA);
    assert.equal(puts.length, 2);
});

test("a refused upload throws IbeeError with the S3 answer", async () => {
    const { client } = uploadStub(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>");
    const err = await caught(client.uploadFile({ bucket_name: "b1", object_path: "a.bin", data: DATA }));
    assert.ok(err instanceof IbeeError);
    assert.equal(err.statusCode, 403);
    assert.match(String(err.body), /SignatureDoesNotMatch/);
});

test("initial top-up refusal carries requiredTopupMinor and billingCurrency", async () => {
    const body = {
        error: "billing_denied",
        billing_reason: "initial_topup_required",
        message: "Add at least Rs 500 to your wallet.",
        required_topup_minor: 50000,
        billing_currency: "INR",
    };
    const { client } = stubClient(() => ({ status: 402, json: body }));
    const err = await caught(client.reservedIps.reserveIp({ site_id: "VGA" }));
    assert.ok(err instanceof PaymentRequiredError);
    assert.equal(err.billingReason, "initial_topup_required");
    assert.equal(err.requiredTopupMinor, 50000);
    assert.equal(err.billingCurrency, "INR");
});

test("Secret Manager enable declares 402 and load balancer delete declares 423", async () => {
    let s = stubClient(() => ({ status: 402, json: { error: "billing_denied", billing_reason: "insufficient_balance" } }));
    let err = await caught(s.client.secretManager.enableSecretManagerWorkspace({ namespace: "e2e" }));
    assert.ok(err instanceof PaymentRequiredError);
    assert.equal(err.requiredTopupMinor, undefined);
    s = stubClient(() => ({ status: 423, json: { error: "organization_restricted" } }));
    err = await caught(s.client.loadBalancers.deleteLoadBalancer({ load_balancer_id: "lb-1" }));
    assert.ok(err instanceof LockedError);
});

test("listLoadBalancers sends include_deleted", async () => {
    const { client, calls } = stubClient(() => ({ json: { items: [], total: 0, page: 1, page_size: 50 } }));
    await client.loadBalancers.listLoadBalancers({ include_deleted: true });
    assert.equal(calls[0].url.searchParams.get("include_deleted"), "true");
});

test("attach volume sends shared_access_confirmed", async () => {
    const { client, calls } = stubClient(() => ({ status: 202, json: { operation_id: "op", status: "accepted" } }));
    await client.cloudVms.attachCloudVmVolume({
        vm_id: "vm1",
        body: {
            volume_id: "vol-1",
            billing_catalog: { sku_code: "BS-100" },
            mode: "multi-writer",
            shared_access_confirmed: true,
        },
    });
    assert.equal(calls[0].body.mode, "multi-writer");
    assert.equal(calls[0].body.shared_access_confirmed, true);
});
