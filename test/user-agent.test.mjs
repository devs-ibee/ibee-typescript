import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { Ibee, VERSION } from "../dist/index.js";
import { stubClient } from "./helpers.mjs";

const USER_AGENT = `ibee-sdk/${VERSION}`;

test("every request sends User-Agent ibee-sdk/<version> and keeps the X-Fern headers", async () => {
    const { client, calls } = stubClient(() => ({ json: [] }));
    await client.cloudVms.listCloudVms({ limit: 1 });
    await client.fetch("/compute/sites");
    assert.equal(USER_AGENT, "ibee-sdk/0.6.0");
    for (const call of calls) {
        assert.equal(call.headers.get("user-agent"), USER_AGENT);
        assert.equal(call.headers.get("x-fern-language"), "JavaScript");
        assert.equal(call.headers.get("x-fern-runtime"), "node");
        assert.equal(call.headers.get("authorization"), "Bearer ibee_prod_key_test");
    }
});

test("a User-Agent passed in headers wins", async () => {
    const { client, calls } = stubClient(() => ({ json: [] }), { headers: { "user-agent": "my-app/1.0" } });
    await client.cloudVms.listCloudVms({ limit: 1 });
    assert.equal(calls[0].headers.get("user-agent"), "my-app/1.0");
});

test("Node's own fetch puts it on the wire", async () => {
    const received = [];
    const server = createServer((req, res) => {
        received.push(req.headers);
        res.writeHead(200, { "content-type": "application/json" }).end("[]");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const { port } = server.address();
        const client = new Ibee({ token: "t", workspaceId: "1", baseUrl: `http://127.0.0.1:${port}/v1`, maxRetries: 0 });
        await client.cloudVms.listCloudVms({ limit: 1 });
    } finally {
        server.close();
    }
    assert.equal(received.length, 1);
    assert.equal(received[0]["user-agent"], USER_AGENT);
    assert.equal(received[0]["x-fern-language"], "JavaScript");
});

test("in a browser no User-Agent is set (the browser's own is used)", () => {
    // A fresh process where the SDK loads with `window.document` present, so it detects a browser.
    const script = `
        globalThis.window = { document: {}, navigator: { userAgent: "Mozilla/5.0 (test)" } };
        const { Ibee } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
        let headers;
        const fetch = async (url, init) => {
            headers = Object.fromEntries(new Headers(init.headers));
            return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        };
        await new Ibee({ token: "t", workspaceId: "1", fetch }).cloudVms.listCloudVms({ limit: 1 });
        console.log(JSON.stringify(headers));
    `;
    const headers = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
    assert.equal(headers["x-fern-runtime"], "browser");
    assert.equal(headers["x-fern-language"], "JavaScript");
    assert.equal(headers["user-agent"], undefined);
    assert.equal(headers.authorization, "Bearer t");
});
