const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { installManagedClient, isManagedAppScript } = require("../../src/utils/ManagedClientScript");
const Adapter = require("../../src/management/VerifierBrowserAdapter");

const appOrigin = "https://ais-pre-fixture-123.us-east5.run.app";
function request(parent = "https://aistudio.google.com/apps/fixture", origin = appOrigin) {
    return {
        frame: () => ({ parentFrame: () => ({ url: () => parent }), url: () => origin }),
        resourceType: () => "script",
        url: () => `${origin}/assets/index-old.js`,
    };
}

test("replace only the observed managed proxy bundle in its AI Studio preview frame", async () => {
    let handler;
    await installManagedClient(
        {
            route: async (_, callback) => {
                handler = callback;
            },
        },
        18
    );
    let replaced;
    await handler({
        fetch: async () => ({
            status: () => 200,
            text: async () => "WebSocket 127.0.0.1 request_attempt_id generativelanguage.googleapis.com",
        }),
        fulfill: async options => {
            replaced = options;
        },
        request,
    });
    assert.match(replaced.body, /generation_capabilities/);
    // The isolated adapter defines a read-only index. ESM scripts are strict:
    // replacing the hosted bundle must not assign an already-defined property.
    const bootstrap = replaced.body.slice(0, replaced.body.indexOf("/**"));
    const chrome = {};
    Object.defineProperty(chrome, "_contextId", { value: 18, writable: false });
    const sandbox = { Promise, window: { chrome } };
    vm.runInNewContext(`"use strict";${bootstrap}`, sandbox);
    assert.equal(await sandbox.window.__authIndexReady, 18);
    const wrong = { Promise, window: { chrome: { _contextId: 17 } } };
    assert.throws(() => vm.runInNewContext(bootstrap, wrong), /index mismatch/);
});

test("other origins, parent pages and unrelated application bundles are untouched", async () => {
    assert.equal(isManagedAppScript(request("https://evil.invalid/apps/fixture")), false);
    assert.equal(
        isManagedAppScript(request("https://aistudio.google.com/apps/fixture", "https://evil.invalid")),
        false
    );
    assert.equal(isManagedAppScript(request("https://aistudio.google.com/apps")), false);
    let handler;
    await installManagedClient(
        {
            route: async (_, cb) => {
                handler = cb;
            },
        },
        3
    );
    const response = { status: () => 200, text: async () => "unrelated application" };
    let result;
    await handler({
        fetch: async () => response,
        fulfill: async options => {
            result = options;
        },
        request,
    });
    assert.equal(result.response, response);
    assert.equal(result.body, undefined);
});

test("live-observed Google account switcher supplies identity, arbitrary email does not", () => {
    const read = (labels, origin = "https://aistudio.google.com", visible = true) =>
        vm.runInNewContext(`(${Adapter.inspectSessionPage.toString()})()`, {
            document: {
                querySelectorAll: selector =>
                    selector.startsWith("ms-account-switcher")
                        ? labels.map(label => ({
                              getAttribute: () => label,
                              getClientRects: () => (visible ? [1] : []),
                          }))
                        : [],
            },
            location: { href: origin + "/apps" },
            URL,
            window: {},
        });
    assert.equal(
        read(["Google Account: Alpha Enterprise (alpha@example.invalid)"]).identity.email,
        "alpha@example.invalid"
    );
    assert.equal(read(["alpha@example.invalid"]).stage, "identity_unconfirmed");
    assert.equal(
        read(["Google Account: Alpha (alpha@example.invalid)"], "https://evil.invalid").stage,
        "identity_unconfirmed"
    );
    assert.equal(
        read(["Google Account: Alpha (alpha@example.invalid)"], undefined, false).stage,
        "identity_unconfirmed"
    );
    assert.equal(
        read(["Google Account: Alpha (alpha@example.invalid)", "Google Account: Beta (beta@example.invalid)"]).stage,
        "identity_unconfirmed"
    );
});

test("an unsupported hosted bundle cannot connect an isolated verifier to the production pool", async () => {
    let handler,
        result,
        unsupported = false;
    await installManagedClient(
        {
            route: async (_, callback) => {
                handler = callback;
            },
        },
        18,
        {
            endpoint: `ws://127.0.0.1:45678/verify/${"a".repeat(64)}?authIndex=18`,
            onUnsupported: () => {
                unsupported = true;
            },
        }
    );
    await handler({
        fetch: async () => ({ status: () => 200, text: async () => "new WebSocket('ws://127.0.0.1:9998');" }),
        fulfill: async options => {
            result = options;
        },
        request,
    });
    assert.equal(unsupported, true);
    assert.throws(() => vm.runInNewContext(result.body), /Unsupported managed proxy client/);
    assert(!result.body.includes("9998"));
});

test("adapter closes its browser once without racing a second context close", async () => {
    const adapter = new Adapter();
    let closed = 0;
    adapter.context = {
        close() {
            throw new Error("concurrent context closure");
        },
    };
    adapter.browser = {
        async close() {
            closed++;
        },
    };
    await Promise.all([adapter.close(), adapter.close()]);
    assert.equal(closed, 1);
});

test("Google's generic Continue button is a terms gate when its accessible label says so", () => {
    const result = vm.runInNewContext(`(${Adapter.inspectSessionPage.toString()})()`, {
        document: {
            querySelectorAll: () => [
                {
                    getAttribute: name => (name === "aria-label" ? "Accept terms of service" : null),
                    getClientRects: () => [1],
                    innerText: "Continue",
                },
            ],
        },
        location: { href: "https://aistudio.google.com/apps/fixture" },
        URL,
        window: { WIZ_global_data: { oPEP7c: "fixture@example.invalid" } },
    });
    assert.equal(result.stage, "terms_required");
});

test("page-world bundled client connects to its isolated endpoint without an init-script WebSocket override", async () => {
    let handler, script;
    const endpoint = `ws://127.0.0.1:45678/verify/${"a".repeat(64)}?authIndex=18`;
    await installManagedClient(
        {
            route: async (_, cb) => {
                handler = cb;
            },
        },
        18,
        { endpoint }
    );
    await handler({
        fetch: async () => ({
            status: () => 200,
            text: async () => "WebSocket 127.0.0.1 request_attempt_id generativelanguage.googleapis.com",
        }),
        fulfill: async options => {
            script = options.body;
        },
        request,
    });
    const urls = [],
        packets = [];
    class Socket extends EventTarget {
        static OPEN = 1;
        constructor(url) {
            super();
            urls.push(url);
            this.readyState = 1;
            queueMicrotask(() => this.dispatchEvent(new Event("open")));
        }
        send(value) {
            packets.push(JSON.parse(value));
        }
    }
    vm.runInNewContext(script, {
        AbortController,
        clearTimeout() {},
        console: { debug() {}, error() {}, info() {}, log() {}, warn() {} },
        CustomEvent,
        document: { body: { appendChild() {} }, createElement: () => ({}) },
        EventTarget,
        setTimeout: () => 0,
        URL,
        URLSearchParams,
        WebSocket: Socket,
        window: {},
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(urls, [endpoint]);
    assert.equal(packets[0].event_type, "generation_capabilities");
    assert.equal(packets[0].protocol_version, 2);
});
