import { Ibee } from "../dist/index.js";

/**
 * A client on a stub fetch. `route(call)` returns `{ status, json, headers }`
 * (default 200 `{}`); every request is recorded in `calls`.
 */
export function stubClient(route = () => ({}), options = {}) {
    const calls = [];
    const fetch = async (url, init) => {
        const u = new URL(String(url));
        const call = {
            url: u,
            path: u.pathname.replace(/^\/v1/, ""),
            method: init.method,
            headers: new Headers(init.headers),
            body: init.body ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        const { status = 200, json = {}, headers = {} } = route(call, calls.length) ?? {};
        return new Response(JSON.stringify(json), {
            status,
            headers: { "content-type": "application/json", ...headers },
        });
    };
    const client = new Ibee({ token: "ibee_prod_key_test", workspaceId: "710995", fetch, ...options });
    return { client, calls };
}
