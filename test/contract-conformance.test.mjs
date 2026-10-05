import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ApiError, Ibee } from "../dist/index.js";

const path = process.env.IBEE_CONFORMANCE_FIXTURES;
if (path === undefined) {
  test("shared policy transport conformance", { skip: "IBEE_CONFORMANCE_FIXTURES is unset" }, () => {});
} else {
  // Missing or malformed explicitly configured fixtures fail the suite.
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.version, 1);
  assert.ok(fixture.cases.length > 0, "conformance fixture must contain cases");
  for (const scenario of fixture.cases) {
    test(`shared policy: ${scenario.name}`, async () => {
      const calls = [];
      const responseHeaders = { "Content-Type": "application/json", "Retry-After": "0" };
      if (scenario.request_id !== undefined) responseHeaders["X-Request-ID"] = scenario.request_id;
      const client = new Ibee({ token: "fixture", baseUrl: "https://api.example.test/v1", maxRetries: 3,
        fetch: async (url, init) => {
          calls.push({ url: new URL(url), ...init });
          return new Response(JSON.stringify(scenario.response), { status: scenario.status, headers: responseHeaders });
        },
      });
      const idempotencyKey = Object.entries(scenario.headers ?? {})
        .find(([name]) => name.toLowerCase() === "x-idempotency-key")?.[1];
      // Exercise the real shared transport without adding a public raw-request API.
      await assert.rejects(client.objectStorage.http.request({
        method: scenario.method, path: scenario.path, workspaceId: "710995", idempotencyKey,
        body: scenario.method === "GET" ? undefined : {},
      }), error => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.statusCode, scenario.status);
        assert.deepEqual(error.body, scenario.response);
        assert.equal(error.requestId, scenario.request_id);
        if (typeof scenario.response.error === "string") {
          assert.equal(error.code, scenario.response.error.trim().toLowerCase());
          assert.equal(error.rawCode, scenario.response.error);
        }
        if ("billing_reason" in scenario.response) assert.equal(error.reason, scenario.response.billing_reason);
        if ("billing_sku_code" in scenario.response) assert.equal(error.billingSkuCode, scenario.response.billing_sku_code);
        if ("admission_context_id" in scenario.response) assert.equal(error.admissionContextId, scenario.response.admission_context_id);
        return true;
      });
      assert.equal(calls.length, scenario.attempts);
      for (const call of calls) {
        // No extra eligibility requests; retries keep the original request and key.
        assert.equal(call.method, scenario.method);
        assert.equal(call.url.pathname, "/v1" + scenario.path);
        assert.deepEqual([...call.url.searchParams], [["workspace_id", "710995"]]);
        for (const [name, value] of Object.entries(scenario.headers ?? {})) {
          assert.equal(new Headers(call.headers).get(name), value);
        }
        assert.equal(call.body, calls[0].body);
      }
    });
  }
}
