const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { once } = require("node:events");
const net = require("node:net");
const tls = require("node:tls");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocket } = require("ws");
const ManagementVerifier = require("../../src/management/ManagementVerifier");
const Transport = require("../../src/management/VerifierTransport");
const BrowserAdapter = require("../../src/management/VerifierBrowserAdapter");

function defaultConfig() {
    // Run the real loader with an empty environment and a read-blocked filesystem;
    // this exercises its default entry URL without reading machine configuration.
    const sandbox = {
        module: { exports: {} },
        process: { cwd: () => "/fixture", env: {} },
        require(name) {
            if (name === "fs")
                return {
                    existsSync: () => false,
                    readFileSync() {
                        throw new Error("No config reads");
                    },
                };
            if (name === "path") return path;
            if (name === "./ProxyUtils") return { getProxySummaryFromEnv: () => "fixture" };
            throw new Error("Unexpected loader dependency");
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../src/utils/ConfigLoader.js"), "utf8"), sandbox);
    return new sandbox.module.exports({ debug() {}, error() {}, info() {}, warn() {} }).loadConfiguration();
}

// Hard network boundary: every executed test is offline except ephemeral loopback WS.
const originalConnect = net.Socket.prototype.connect;
const originalTLS = tls.connect;
net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    assert.equal(options.host, "127.0.0.1", "Tests may connect only to loopback fixtures");
    return originalConnect.apply(this, args);
};
tls.connect = () => {
    throw new Error("No TLS or production connections in verifier tests");
};
after(() => {
    net.Socket.prototype.connect = originalConnect;
    tls.connect = originalTLS;
});

const fixture = name => ({
    accountName: `${name}@example.invalid`,
    cookies: [
        {
            domain: "example.invalid",
            expires: -1,
            httpOnly: true,
            name: "fixture",
            path: "/",
            sameSite: "Lax",
            secure: true,
            value: `${name}-secret`,
        },
    ],
    origins: [],
});
const alpha = fixture("alpha");
const beta = fixture("beta");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const never = () => new Promise(() => {});
const identity = email => ({ identity: { email, origin: "https://aistudio.google.com", source: "aistudio_session" } });
const payload = model => ({
    candidates: [{ content: { parts: [{ text: "OK" }], role: "model" }, finishReason: "STOP" }],
    modelVersion: model,
});

function sendResponse(socket, request, options = {}) {
    const model = request.path.match(/models\/([^:]+):/)[1];
    const base = { request_attempt_id: request.request_attempt_id, request_id: request.request_id, ...options.packet };
    if (options.status) {
        socket.send(
            JSON.stringify({
                ...base,
                event_type: "error",
                message: options.detail || "sensitive upstream body",
                status: options.status,
            })
        );
        return;
    }
    socket.send(JSON.stringify({ ...base, event_type: "response_headers", status: 200 }));
    socket.send(JSON.stringify({ ...base, data: JSON.stringify(options.body || payload(model)), event_type: "chunk" }));
    if (!options.incomplete) socket.send(JSON.stringify({ ...base, event_type: "stream_close" }));
}

function harness(options = {}) {
    const records = [];
    let active = 0;
    let maxActive = 0;
    const system = {
        authSource: {
            getAuth() {
                throw new Error("Must not read production credentials");
            },
        },
        browserManager: Object.freeze({ contexts: new Map([[77, "production"]]), currentAuthIndex: 77 }),
        config: {},
        connectionRegistry: new Map([[77, "production-websocket"]]),
        managementVerifierOptions: {
            adapterFactory: () => {
                const record = { closed: false };
                records.push(record);
                return {
                    async close() {
                        record.socket?.terminate();
                        record.closed = true;
                        active--;
                        if (options.cleanup) await options.cleanup(record);
                    },
                    async inspect() {
                        return options.inspect
                            ? options.inspect(record)
                            : identity(record.args.credentials.accountName);
                    },
                    async start(args) {
                        record.args = args;
                        active++;
                        maxActive = Math.max(maxActive, active);
                        if (options.start) return options.start(args, record);
                        record.socket = new WebSocket(args.endpoint);
                        record.socket.on("error", () => {});
                        record.socket.on("message", data => {
                            const request = JSON.parse(data);
                            if (request.event_type !== "proxy_request") return;
                            record.request = request;
                            if (options.respond) options.respond(record.socket, request, args, record);
                            else sendResponse(record.socket, request);
                        });
                        await once(record.socket, "open");
                    },
                };
            },
            closeTimeoutMs: 100,
            pollMs: 2,
            timeoutMs: options.timeoutMs || 1000,
        },
    };
    const verifier = new ManagementVerifier(system);
    return {
        get maxActive() {
            return maxActive;
        },
        records,
        system,
        verifier,
    };
}

test("two different candidates receive attributed model results; production state stays unchanged", async () => {
    const h = harness();
    const results = await Promise.all([
        h.verifier.verify({ credentials: alpha, index: 3 }),
        h.verifier.verify({ credentials: beta, index: 8 }),
    ]);
    assert.deepEqual(
        results.map(x => [x.authIndex, x.success, x.stage, x.upstreamStatus]),
        [
            [3, true, "model_verified", 200],
            [8, true, "model_verified", 200],
        ]
    );
    assert.notEqual(results[0].requestId, results[1].requestId);
    assert.notEqual(h.records[0].args.endpoint, h.records[1].args.endpoint);
    assert.equal(h.records[0].args.credentials.cookies[0].value, "alpha-secret");
    assert.equal(h.records[1].args.credentials.cookies[0].value, "beta-secret");
    assert.equal(h.maxActive, 1);
    assert.equal(h.system.browserManager.currentAuthIndex, 77);
    assert.deepEqual([...h.system.connectionRegistry], [[77, "production-websocket"]]);
    assert.deepEqual([...h.system.browserManager.contexts], [[77, "production"]]);
    assert(h.records.every(record => record.closed));
    assert(!JSON.stringify(results).includes("secret"));
    assert(!JSON.stringify(results).includes("credentialState"));
    await h.verifier.close();
});

test("failed beta is never replaced by successful alpha", async () => {
    const h = harness({
        respond(socket, request, args) {
            sendResponse(socket, request, args.index === 8 ? { status: 401 } : {});
        },
    });
    assert.equal((await h.verifier.verify({ credentials: alpha, index: 3 })).success, true);
    await assert.rejects(
        h.verifier.verify({ credentials: beta, index: 8 }),
        error => error.authIndex === 8 && error.stage === "login_required" && error.upstreamStatus === 401
    );
    assert.equal(h.records.length, 2);
    await h.verifier.close();
});

for (const [label, packet] of Object.entries({
    attempt: { request_attempt_id: "other" },
    index: { authIndex: 9 },
    model: { model: "other" },
    requestId: { request_id: "other" },
})) {
    test(`reject wrong ${label}, even if followed by an otherwise valid success`, async () => {
        const h = harness({
            respond(socket, request) {
                sendResponse(socket, request, { packet });
                sendResponse(socket, request);
            },
        });
        await assert.rejects(h.verifier.verify({ credentials: alpha, index: 3 }), { stage: "protocol_mismatch" });
        assert(h.records[0].closed);
        await h.verifier.close();
    });
}

for (const [status, stage] of [
    [401, "login_required"],
    [403, "permission_denied"],
    [404, "model_not_found"],
    [429, "quota_exceeded"],
    [500, "upstream_error"],
]) {
    test(`classify ${status} without leaking upstream body`, async () => {
        const h = harness({
            respond(socket, request) {
                sendResponse(socket, request, { status });
            },
        });
        await assert.rejects(
            h.verifier.verify({ credentials: alpha, index: 3 }),
            error =>
                error.stage === stage && error.upstreamStatus === status && !JSON.stringify(error).includes("sensitive")
        );
        await h.verifier.close();
    });
}

for (const [name, body] of Object.entries({
    empty: {},
    truncated: { candidates: [{ content: { parts: [{ text: "OK" }], role: "model" }, finishReason: "MAX_TOKENS" }] },
    whitespace: { candidates: [{ content: { parts: [{ text: " " }], role: "model" }, finishReason: "STOP" }] },
    wrongModel: { ...payload("wrong-model") },
})) {
    test(`reject ${name} model result`, async () => {
        const h = harness({
            respond(socket, request) {
                sendResponse(socket, request, { body });
            },
        });
        await assert.rejects(h.verifier.verify({ credentials: alpha, index: 3 }), {
            stage: name === "wrongModel" ? "protocol_mismatch" : "empty_response",
        });
        await h.verifier.close();
    });
}

for (const [stage, state] of Object.entries({
    identity_mismatch: identity(beta.accountName),
    identity_unconfirmed: {},
    login_required: { stage: "login_required" },
    region_restricted: { stage: "region_restricted" },
    terms_required: { stage: "terms_required" },
})) {
    test(`session gate: ${stage}`, async () => {
        const h = harness({ inspect: () => state });
        await assert.rejects(h.verifier.verify({ credentials: alpha, index: 3 }), { stage });
        assert.equal(h.records[0].request, undefined);
        await h.verifier.close();
    });
}

test("identity is rechecked after generation, including candidates without accountName", async () => {
    const h = harness({ inspect: record => identity(record.request ? beta.accountName : alpha.accountName) });
    await assert.rejects(h.verifier.verify({ credentials: { cookies: alpha.cookies, origins: [] }, index: 3 }), {
        stage: "identity_mismatch",
    });
    await h.verifier.close();
});

test("connection mode is explicit and never issues a model request", async () => {
    const h = harness();
    const result = await h.verifier.verify({ credentials: alpha, index: 3, mode: "connection" });
    assert.equal(result.stage, "connection_ready");
    assert.equal(result.upstreamStatus, null);
    assert.equal(h.records[0].request, undefined);
    await h.verifier.close();
});

for (const phase of ["initialization", "connection", "generation", "cleanup"]) {
    test(`deadline cancels ${phase} and closes acquired resources`, async () => {
        let finishCleanup;
        const h = harness({
            timeoutMs: 50,
            ...(phase === "initialization" ? { start: never } : {}),
            ...(phase === "connection" ? { start: async () => {} } : {}),
            ...(phase === "generation" ? { respond: () => {} } : {}),
            ...(phase === "cleanup"
                ? {
                      cleanup: () =>
                          new Promise(resolve => {
                              finishCleanup = resolve;
                          }),
                  }
                : {}),
        });
        await assert.rejects(h.verifier.verify({ credentials: alpha, index: 3 }), { code: "VERIFICATION_TIMEOUT" });
        await pause(5);
        assert(h.records[0].closed);
        finishCleanup?.();
        await h.verifier.close();
    });
}

test("abort queued work promptly; it never starts or borrows another context", async () => {
    const h = harness({ respond: () => {} });
    const firstAbort = new AbortController();
    const first = h.verifier.verify({ credentials: alpha, index: 3, signal: firstAbort.signal });
    const firstRejected = assert.rejects(first, { code: "CANCELLED" });
    const secondAbort = new AbortController();
    const second = h.verifier.verify({ credentials: beta, index: 8, signal: secondAbort.signal });
    secondAbort.abort();
    await assert.rejects(second, { authIndex: 8, code: "CANCELLED" });
    await pause(10);
    assert.equal(h.records.length, 1);
    firstAbort.abort();
    await firstRejected;
    await h.verifier.close();
    assert.equal(h.records.length, 1);
});

test("close aborts active and queued work, is idempotent and rejects new calls", async () => {
    const h = harness({ respond: () => {} });
    const jobs = [3, 8].map(index =>
        assert.rejects(h.verifier.verify({ credentials: alpha, index }), { code: "CANCELLED" })
    );
    await pause(10);
    const closing = h.verifier.close();
    assert.equal(h.verifier.close(), closing);
    await closing;
    await Promise.all(jobs);
    assert(h.records.every(record => record.closed));
    await assert.rejects(h.verifier.verify({ credentials: alpha, index: 3 }), { stage: "closed" });
});

test("cleanup failure never returns success", async () => {
    const h = harness({
        cleanup: async () => {
            throw new Error("secret");
        },
    });
    await assert.rejects(h.verifier.verify({ credentials: alpha, index: 3 }), { stage: "cleanup_failed" });
    await assert.rejects(h.verifier.close(), { stage: "cleanup_failed" });
});

test("missing/invalid target does not read production storage or create a browser", async () => {
    const h = harness();
    for (const args of [
        {},
        { credentials: alpha, index: -1 },
        { index: 3 },
        { credentials: alpha, index: 3, model: "a/../b" },
    ]) {
        await assert.rejects(h.verifier.verify(args), { stage: "invalid_input" });
    }
    assert.equal(h.records.length, 0);
    await h.verifier.close();
});

test("transport only admits the one target nonce and index; socket port closes", async () => {
    const transport = new Transport({ index: 3, model: "gemini-3.8-flash", requestId: "test" });
    const endpoint = await transport.listen(new AbortController().signal);
    for (const url of [
        endpoint.replace(/verify\/[^?]+/, "verify/wrong"),
        endpoint.replace("authIndex=3", "authIndex=8"),
    ]) {
        const bad = new WebSocket(url);
        await assert.rejects(once(bad, "open"));
    }
    const good = new WebSocket(endpoint);
    await once(good, "open");
    const duplicate = new WebSocket(endpoint);
    await assert.rejects(once(duplicate, "open"));
    const idle = net.connect({ host: "127.0.0.1", port: Number(new URL(endpoint).port) });
    await once(idle, "connect");
    const idleClosed = once(idle, "close");
    await transport.close();
    await idleClosed;
    const afterClose = new WebSocket(endpoint);
    await assert.rejects(once(afterClose, "open"));
});

for (const phase of ["initialization", "connection", "generation", "cleanup"]) {
    test(`external AbortSignal cancels ${phase}`, async () => {
        let finishCleanup;
        const h = harness({
            ...(phase === "initialization" ? { start: never } : {}),
            ...(phase === "connection" ? { start: async () => {} } : {}),
            ...(phase === "generation" ? { respond: () => {} } : {}),
            ...(phase === "cleanup"
                ? {
                      cleanup: () =>
                          new Promise(resolve => {
                              finishCleanup = resolve;
                          }),
                  }
                : {}),
        });
        const controller = new AbortController();
        const result = h.verifier.verify({ credentials: alpha, index: 3, signal: controller.signal });
        const rejected = assert.rejects(result, { code: "CANCELLED" });
        await pause(35);
        controller.abort();
        await rejected;
        await pause(5);
        assert(h.records[0].closed);
        finishCleanup?.();
        await h.verifier.close();
    });
}

test("current-session metadata reader ignores arbitrary page emails and untrusted origins", () => {
    const inspect = BrowserAdapter.inspectSessionPage.toString();
    const read = (url, email, text = "") =>
        vm.runInNewContext(`(${inspect})()`, {
            document: { querySelectorAll: () => [{ getClientRects: () => [1], innerText: text }] },
            location: { href: url },
            URL,
            window: { WIZ_global_data: { oPEP7c: email } },
        });
    assert.equal(
        read("https://aistudio.google.com/apps/test", undefined, alpha.accountName).stage,
        "identity_unconfirmed"
    );
    assert.equal(read("https://evil.invalid/", alpha.accountName).stage, "identity_unconfirmed");
    assert.equal(read("https://accounts.google.com/challenge", alpha.accountName).stage, "login_required");
    assert.equal(
        read("https://aistudio.google.com/", alpha.accountName, "Continue to the app").identity.email,
        alpha.accountName
    );
    assert.equal(read("https://aistudio.google.com/", alpha.accountName, "Terms of Service").stage, "terms_required");
    assert.equal(read("https://aistudio.google.com/", alpha.accountName).identity.email, alpha.accountName);
});

test("an iframe email cannot identify the top-level AI Studio session", () => {
    const top = { WIZ_global_data: undefined };
    top.frames = [{ WIZ_global_data: { oPEP7c: alpha.accountName } }];
    const result = vm.runInNewContext(`(${BrowserAdapter.inspectSessionPage.toString()})()`, {
        document: { querySelectorAll: () => [] },
        location: { href: "https://aistudio.google.com/apps/test" },
        URL,
        window: top,
    });
    assert.equal(result.stage, "identity_unconfirmed");
});

test("init script redirects only its own context's production endpoint and rejects wrong index", () => {
    const urls = [];
    class Native {
        constructor(url) {
            urls.push(url);
        }
    }
    const isolated = { addEventListener() {}, WebSocket: Native };
    isolated.top = isolated;
    vm.runInNewContext(
        `(${BrowserAdapter.installIsolation.toString()})({index:3,endpoint:'ws://127.0.0.1:45678/nonce'})`,
        { location: { href: "https://aistudio.google.com/" }, URL, window: isolated }
    );
    new isolated.WebSocket("ws://127.0.0.1:9998?authIndex=3");
    assert.equal(urls[0], "ws://127.0.0.1:45678/nonce");
    assert.throws(() => new isolated.WebSocket("ws://127.0.0.1:9998?authIndex=4"));
    assert.throws(() => new isolated.WebSocket("ws://localhost:9998"));
    assert.equal(isolated.chrome._contextId, 3);
    assert.equal(Native.prototype.constructor, Native);
});

test("real browser adapter closes browser acquired after cancellation", async () => {
    const adapter = new BrowserAdapter({});
    let resolveLaunch;
    const launch = new Promise(resolve => {
        resolveLaunch = resolve;
    });
    const controller = new AbortController();
    const acquired = adapter.acquire(launch, "browser", controller.signal);
    controller.abort();
    await assert.rejects(acquired, { code: "CANCELLED" });
    const closed = adapter.close();
    let closedLate = false;
    resolveLaunch({
        async close() {
            closedLate = true;
        },
    });
    await closed;
    assert.equal(closedLate, true);
    assert.equal(adapter.browser, undefined);
});

test("real adapter accepts ConfigLoader default ai.studio entry and follows the browser redirect", async () => {
    const { firefox } = require("playwright");
    const originalLaunch = firefox.launch;
    const previousProxy = process.env.HTTPS_PROXY;
    const previousBypass = process.env.NO_PROXY;
    process.env.HTTPS_PROXY = "http://fixture-user:fixture-pass@proxy.example.invalid:8080";
    process.env.NO_PROXY = "fixture.internal";
    const calls = {};
    const config = defaultConfig();
    assert.match(config.aiStudioAppUrl, /^https:\/\/ai\.studio\/apps\//);
    const adapter = new BrowserAdapter({ ...config, browserExecutablePath: "fixture-browser" });
    const page = {
        async addInitScript(fn, args) {
            calls.script = fn;
            calls.scriptArgs = args;
        },
        async close() {
            calls.pageClosed = true;
        },
        async evaluate(fn) {
            return vm.runInNewContext(`(${fn.toString()})()`, {
                document: { querySelectorAll: () => [] },
                location: { href: calls.finalUrl },
                URL,
                window: { WIZ_global_data: { oPEP7c: beta.accountName } },
            });
        },
        async goto(url) {
            calls.url = url;
            calls.finalUrl = "https://aistudio.google.com/apps/test";
        },
        isClosed: () => false,
    };
    const context = {
        async close() {
            calls.contextClosed = true;
        },
        async newPage() {
            return page;
        },
        on() {},
    };
    firefox.launch = async options => {
        calls.launch = options;
        return {
            async close() {
                calls.browserClosed = true;
            },
            async newContext(options) {
                calls.context = options;
                return context;
            },
        };
    };
    try {
        await adapter.start({
            credentials: { ...beta, disabled: true },
            endpoint: "ws://127.0.0.1:12345/fixture",
            index: 8,
            signal: new AbortController().signal,
        });
        assert.equal(calls.launch.headless, true);
        assert.equal(calls.launch.executablePath, "fixture-browser");
        assert.deepEqual(calls.launch.proxy, {
            bypass: "localhost,127.0.0.1,::,::1,0.0.0.0,fixture.internal",
            password: "fixture-pass",
            server: "http://proxy.example.invalid:8080",
            username: "fixture-user",
        });
        assert.deepEqual(calls.context.proxy, calls.launch.proxy);
        assert.deepEqual(calls.context.storageState, { cookies: beta.cookies, origins: beta.origins });
        assert.equal(calls.script, BrowserAdapter.installIsolation);
        assert.equal(calls.scriptArgs.index, 8);
        assert.equal(calls.url, config.aiStudioAppUrl);
        assert.equal((await adapter.inspect()).identity.email, beta.accountName);
        await adapter.close();
        assert(calls.contextClosed && calls.browserClosed);
    } finally {
        firefox.launch = originalLaunch;
        if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = previousProxy;
        if (previousBypass === undefined) delete process.env.NO_PROXY;
        else process.env.NO_PROXY = previousBypass;
        await adapter.close();
    }
});

test("real adapter rejects unsafe app entry URLs before launching", async () => {
    for (const aiStudioAppUrl of [
        "https://user:pass@ai.studio/apps/test",
        "https://evil.invalid/apps/test",
        "http://ai.studio/apps/test",
        "https://ai.studio:444/apps/test",
        "https://ai.studio/not-an-app",
        "https://ai.studio/apps/test?redirect=evil.invalid",
        "https://user@aistudio.google.com/apps/test",
        "https://ai.studio/apps/test#fragment",
    ]) {
        const adapter = new BrowserAdapter({ aiStudioAppUrl });
        await assert.rejects(adapter.start({ credentials: alpha, index: 3, signal: new AbortController().signal }), {
            stage: "initialization_failed",
        });
        assert.equal(adapter.browser, undefined);
        await adapter.close();
    }
});

test("app entry controls use exact names; no generic Continue/consent click", async () => {
    for (const target of ["Continue to the app", "Skip", "Launch", "rocket_launch", "Continue", "Accept terms"]) {
        const adapter = new BrowserAdapter();
        const clicked = [];
        adapter.page = {
            getByRole(role, options) {
                assert.equal(role, "button");
                assert.equal(options.exact, true);
                return {
                    first: () => ({
                        click: async () => clicked.push(options.name),
                        isVisible: async () => options.name === target,
                    }),
                };
            },
        };
        await adapter.wake();
        assert.deepEqual(clicked, ["Continue", "Accept terms"].includes(target) ? [] : [target]);
    }
});

test("deadline includes queue wait and queued timeout never creates a context", async () => {
    const h = harness({ respond: () => {}, timeoutMs: 60 });
    const outcomes = [3, 8].map(index =>
        assert.rejects(h.verifier.verify({ credentials: alpha, index }), { code: "VERIFICATION_TIMEOUT" })
    );
    await Promise.all(outcomes);
    await h.verifier.close();
    // A request queued right at another deadline may briefly acquire the slot, but must
    // not gain a fresh ten-minute budget. Neither call may complete from the other.
    assert(h.records.every(record => record.closed));
});

test("a connected page without completed model response cannot pass", async () => {
    const h = harness({
        respond: (socket, request) => sendResponse(socket, request, { incomplete: true }),
        timeoutMs: 50,
    });
    await assert.rejects(h.verifier.verify({ credentials: alpha, index: 3 }), { code: "VERIFICATION_TIMEOUT" });
    await h.verifier.close();
});

test("existing real client script speaks the verifier protocol with a mocked upstream fetch", async () => {
    let socket;
    const timers = new Set();
    let stopped = false;
    const requests = [];
    const verifier = new ManagementVerifier({
        managementVerifierOptions: {
            adapterFactory: () => ({
                async close() {
                    stopped = true;
                    socket?.terminate();
                    for (const timer of timers) clearTimeout(timer);
                },
                async inspect() {
                    return identity(alpha.accountName);
                },
                async start({ endpoint, index }) {
                    class ClientSocket extends WebSocket {
                        constructor() {
                            super(endpoint);
                            socket = this;
                        }
                    }
                    const sandbox = {
                        AbortController,
                        Blob,
                        clearTimeout,
                        console: { debug() {}, error() {}, log() {}, warn() {} },
                        CustomEvent,
                        document: { body: { appendChild() {} }, createElement: () => ({}) },
                        DOMException,
                        EventTarget,
                        fetch: async (url, config) => {
                            requests.push({ config, url });
                            return new Response(JSON.stringify(payload("gemini-3.8-flash")), { status: 200 });
                        },
                        Response,
                        setTimeout(fn, ms) {
                            if (stopped) return 0;
                            const timer = setTimeout(fn, ms);
                            timers.add(timer);
                            return timer;
                        },
                        TextDecoder,
                        URL,
                        URLSearchParams,
                        WebSocket: ClientSocket,
                        window: { chrome: { _contextId: index } },
                    };
                    vm.runInNewContext(
                        fs.readFileSync(path.join(__dirname, "../../scripts/client/build.js"), "utf8"),
                        sandbox
                    );
                    await once(socket, "open");
                },
            }),
            pollMs: 2,
            timeoutMs: 2000,
        },
    });
    const result = await verifier.verify({ credentials: alpha, index: 3 });
    assert.equal(result.stage, "model_verified");
    assert.equal(requests.length, 1);
    assert.equal(
        requests[0].url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"
    );
    assert.equal(JSON.parse(requests[0].config.body).generationConfig.maxOutputTokens, 64);
    await verifier.close();
});
