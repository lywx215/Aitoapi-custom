const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const { once } = require("node:events");
const express = require("express");
const { WebSocket } = require("ws");
const ModelProbeService = require("../../src/model-probe/ModelProbeService");
const ModelProbeTransport = require("../../src/model-probe/ModelProbeTransport");
const StatusRoutes = require("../../src/routes/StatusRoutes");
const { VerificationError, abortable, upstreamError } = require("../../src/management/VerifierSupport");

const temporaryDirectories = [];
const temporaryDirectory = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aitoapi-model-probe-"));
    temporaryDirectories.push(directory);
    return directory;
};

after(() => {
    for (const directory of temporaryDirectories) fs.rmSync(directory, { force: true, recursive: true });
});

const textPayload = { candidates: [{ content: { parts: [{ text: "OK" }] } }] };
const geminiImagePayload = {
    candidates: [{ content: { parts: [{ inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } }] } }],
};
const imagenPayload = {
    predictions: [{ bytesBase64Encoded: "aW1hZ2U=", mimeType: "image/png" }],
};

async function transportFixture(respond) {
    const transport = new ModelProbeTransport({ index: 3 });
    const endpoint = await transport.listen(new AbortController().signal);
    const socket = new WebSocket(endpoint);
    socket.on("error", () => {});
    socket.on("message", raw => {
        const request = JSON.parse(raw.toString());
        if (request.event_type === "proxy_request") respond(socket, request);
    });
    await once(socket, "open");
    return { socket, transport };
}

function send(socket, request, payload, status = 200) {
    const binding = {
        authIndex: 3,
        model: request.path.match(/models\/([^:]+):/)[1],
        request_attempt_id: request.request_attempt_id,
        request_id: request.request_id,
    };
    socket.send(JSON.stringify({ ...binding, event_type: "response_headers", status }));
    socket.send(JSON.stringify({ ...binding, data: JSON.stringify(payload), event_type: "chunk" }));
    socket.send(JSON.stringify({ ...binding, event_type: "stream_close" }));
}

test("offline transport validates text, Gemini image, and Imagen responses", async () => {
    for (const [model, payload, expectedPath] of [
        [{ id: "text-model", kind: "text" }, textPayload, ":generateContent"],
        [{ id: "image-model", kind: "gemini_image" }, geminiImagePayload, ":generateContent"],
        [{ id: "imagen-model", kind: "imagen" }, imagenPayload, ":predict"],
    ]) {
        let observedRequest;
        const fixture = await transportFixture((socket, request) => {
            observedRequest = request;
            send(socket, request, payload);
        });
        try {
            const result = await fixture.transport.probe(model, new AbortController().signal, 500);
            assert.equal(result.status, 200);
            assert.match(observedRequest.path, new RegExp(`${expectedPath}$`));
            assert.equal(observedRequest.method, "POST");
        } finally {
            fixture.socket.terminate();
            await fixture.transport.close();
        }
    }
});

test("offline transport enforces packet binding, response limit, timeout, and cancellation", async () => {
    const mismatch = await transportFixture((socket, request) => {
        send(socket, { ...request, request_id: "wrong-request" }, textPayload);
    });
    await assert.rejects(
        mismatch.transport.probe({ id: "text-model", kind: "text" }, new AbortController().signal, 500),
        { stage: "protocol_mismatch" }
    );
    mismatch.socket.terminate();
    await mismatch.transport.close();

    const oversized = await transportFixture((socket, request) => {
        const binding = {
            request_attempt_id: request.request_attempt_id,
            request_id: request.request_id,
        };
        socket.send(JSON.stringify({ ...binding, event_type: "response_headers", status: 200 }));
        const data = "x".repeat(800 * 1024);
        for (let index = 0; index < 22; index++) {
            socket.send(JSON.stringify({ ...binding, data, event_type: "chunk" }));
        }
    });
    await assert.rejects(
        oversized.transport.probe({ id: "text-model", kind: "text" }, new AbortController().signal, 1000),
        { stage: "protocol_mismatch" }
    );
    oversized.socket.terminate();
    await oversized.transport.close();

    const silent = await transportFixture(() => {});
    await assert.rejects(silent.transport.probe({ id: "text-model", kind: "text" }, new AbortController().signal, 20), {
        stage: "timeout",
    });
    silent.socket.terminate();
    await silent.transport.close();

    const cancelled = await transportFixture(() => {});
    const controller = new AbortController();
    const pending = cancelled.transport.probe({ id: "text-model", kind: "text" }, controller.signal, 500);
    controller.abort(new VerificationError("cancelled"));
    await assert.rejects(pending, { stage: "cancelled" });
    cancelled.socket.terminate();
    await cancelled.transport.close();
});

const model = (name, methods = ["generateContent"], displayName = name) => ({
    displayName,
    name: `models/${name}`,
    supportedGenerationMethods: methods,
    version: "fixture-v1",
});

const baseModels = [
    model("alpha-text"),
    model("beta-text"),
    model("gamma-image"),
    model("imagen-fixture", ["predict"]),
    model("excluded-tts"),
    model("embedding-fixture", ["embedContent"]),
];

function serviceHarness(options = {}) {
    const rootDir = options.rootDir || temporaryDirectory();
    const calls = [];
    const metadata = options.metadata || [
        { accountId: "account-a", credentialVersion: 1, stateVersion: 1 },
        { accountId: "account-b", credentialVersion: 1, stateVersion: 1 },
    ];
    const credentials = [
        { accountName: "alpha@example.invalid", cookies: [{ value: "alpha-secret" }] },
        { accountName: "beta@example.invalid", cookies: [{ value: "beta-secret" }] },
    ];
    const productionState = {
        contexts: new Map([[99, "production-context"]]),
        currentAuthIndex: 99,
        enabled: [true, true],
        statistics: { requests: 44 },
    };
    const system = {
        authSource: {
            getAuth: index => credentials[index],
            getRotationIndices: () => options.indices || [0, 1],
            store: { getMetadata: index => metadata[index] },
        },
        browserManager: productionState,
        config: { aiStudioAppUrl: "https://aistudio.google.com", modelList: options.models || baseModels },
        logger: { error() {}, warn() {} },
        requestStatistics: productionState.statistics,
    };
    const responseFor =
        options.responseFor ||
        ((index, id) => {
            if (id === "alpha-text") return index === 0 ? { durationMs: 7, status: 200 } : upstreamError(500);
            if (id === "beta-text") return index === 0 ? upstreamError(403) : { durationMs: 8, status: 200 };
            if (id === "gamma-image") return index === 0 ? upstreamError(429) : upstreamError(500);
            return index === 0 ? upstreamError(404) : upstreamError(403, "not supported in this region");
        });
    const service = new ModelProbeService(system, {
        adapterFactory: () => {
            let accountName;
            return {
                async close() {},
                async inspect() {
                    return {
                        identity: {
                            email: accountName,
                            origin: "https://aistudio.google.com",
                            source: "aistudio_session",
                        },
                    };
                },
                async start({ credentials: value }) {
                    accountName = value.accountName;
                },
            };
        },
        modelTimeoutMs: 100,
        rootDir,
        runTimeoutMs: 1000,
        transportFactory: ({ index }) => ({
            close: async () => {},
            connected: Promise.resolve(),
            listen: async () => "ws://127.0.0.1/fixture",
            probe: async requestedModel => {
                calls.push([index, requestedModel.id]);
                const response = responseFor(index, requestedModel.id);
                if (response instanceof Error) throw response;
                return response;
            },
        }),
    });
    return { calls, metadata, productionState, rootDir, service, system };
}

test("service stops after success, falls back across accounts, classifies results, and preserves production state", async () => {
    const harness = serviceHarness();
    const productionBefore = {
        contexts: [...harness.productionState.contexts],
        currentAuthIndex: harness.productionState.currentAuthIndex,
        enabled: [...harness.productionState.enabled],
        statistics: { ...harness.productionState.statistics },
    };
    harness.service.start();
    await harness.service.runPromise;
    const snapshot = harness.service.snapshot();
    const results = Object.fromEntries(snapshot.lastCompleted.results.map(result => [result.model, result]));

    assert.equal(results["alpha-text"].status, "available");
    assert.equal(results["alpha-text"].successfulAccount.accountIndex, 0);
    assert.equal(results["beta-text"].status, "available");
    assert.equal(results["beta-text"].successfulAccount.accountIndex, 1);
    assert.equal(results["gamma-image"].status, "indeterminate");
    assert.equal(results["imagen-fixture"].status, "unavailable");
    assert.deepEqual(
        results["gamma-image"].attempts.map(attempt => [attempt.httpStatus, attempt.errorCode]),
        [
            [429, "quota_exceeded"],
            [500, "upstream_error"],
        ]
    );
    assert(!harness.calls.some(([index, id]) => index === 1 && id === "alpha-text"));
    assert.deepEqual(
        {
            contexts: [...harness.productionState.contexts],
            currentAuthIndex: harness.productionState.currentAuthIndex,
            enabled: harness.productionState.enabled,
            statistics: harness.productionState.statistics,
        },
        productionBefore
    );

    const persisted = fs.readFileSync(path.join(harness.rootDir, "data", "model-probes.json"), "utf8");
    assert(!persisted.includes("alpha-secret"));
    assert(!persisted.includes("beta-secret"));
    assert(!persisted.includes("aW1hZ2U="));
    assert(!persisted.includes("sensitive upstream body"));
});

test("catalog contains only the 24 configured base models", () => {
    const models = require("../../configs/models.json").models;
    const harness = serviceHarness({ indices: [], models });
    const catalog = harness.service.snapshot().catalog;
    assert.equal(catalog.totalModels, 24);
    assert.equal(catalog.textModels, 17);
    assert.equal(catalog.imageModels, 7);
    assert(!catalog.models.some(item => /tts|embedding|robotics|computer-use/i.test(item.model)));
});

test("completed results persist, become stale on account version change, and interrupted runs recover safely", async () => {
    const harness = serviceHarness();
    harness.service.start();
    await harness.service.runPromise;
    const previousRunId = harness.service.snapshot().lastCompleted.runId;

    const restored = serviceHarness({ metadata: harness.metadata, rootDir: harness.rootDir });
    assert.equal(restored.service.snapshot().lastCompleted.runId, previousRunId);
    assert.equal(restored.service.snapshot().stale, false);
    harness.metadata[0].credentialVersion++;
    assert.equal(restored.service.snapshot().stale, true);

    const file = path.join(harness.rootDir, "data", "model-probes.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.currentRun = { currentModel: "alpha-text", runId: "interrupted-run", status: "running" };
    fs.writeFileSync(file, JSON.stringify(saved));
    const restarted = serviceHarness({ metadata: harness.metadata, rootDir: harness.rootDir });
    const snapshot = restarted.service.snapshot();
    assert.equal(snapshot.currentRun.status, "interrupted");
    assert.equal(snapshot.currentRun.errorCode, "interrupted");
    assert.equal(snapshot.lastCompleted.runId, previousRunId);
});

test("concurrent starts conflict and cancellation does not replace the last completed result", async () => {
    const rootDir = temporaryDirectory();
    const completed = serviceHarness({ rootDir });
    completed.service.start();
    await completed.service.runPromise;
    const previousRunId = completed.service.snapshot().lastCompleted.runId;

    const pending = serviceHarness({
        responseFor: () => null,
        rootDir,
    });
    pending.service.transportFactory = () => ({
        close: async () => {},
        connected: Promise.resolve(),
        listen: async () => "ws://127.0.0.1/fixture",
        probe: (_model, signal) => abortable(new Promise(() => {}), signal),
    });
    const run = pending.service.start();
    assert.throws(
        () => pending.service.start(),
        error => error.code === "PROBE_RUNNING" && error.status === 409
    );
    pending.service.cancel(run.runId);
    await pending.service.runPromise;
    const snapshot = pending.service.snapshot();
    assert.equal(snapshot.currentRun.status, "cancelled");
    assert.equal(snapshot.lastCompleted.runId, previousRunId);
});

test("start rejects when no enabled account is available", () => {
    const harness = serviceHarness({ indices: [] });
    assert.throws(
        () => harness.service.start(),
        error => error.code === "NO_PROBE_ACCOUNT" && error.status === 409
    );
});

test("session-protected routes expose state, 202/409 start semantics, and cancellation", async () => {
    let started = false;
    const modelProbeService = {
        cancel(runId) {
            if (runId !== "probe-route") {
                throw Object.assign(new Error("missing"), { code: "PROBE_NOT_FOUND", status: 404 });
            }
            return { runId, status: "running" };
        },
        snapshot: () => ({ currentRun: null, lastCompleted: null, schemaVersion: 1 }),
        start() {
            if (started) throw Object.assign(new Error("running"), { code: "PROBE_RUNNING", status: 409 });
            started = true;
            return { runId: "probe-route", status: "running" };
        },
    };
    const serverSystem = {
        config: {},
        distIndexPath: path.join(__dirname, "missing-index.html"),
        logger: { error() {}, info() {}, setDisplayLimit() {}, warn() {} },
        modelProbeService,
        runtimeSettingsStore: { save: async () => {}, toggle: async () => {}, update: async () => {} },
    };
    const app = express();
    app.use(express.json());
    new StatusRoutes(serverSystem).setupRoutes(app, (request, response, next) => {
        if (request.headers["x-test-session"] === "valid") next();
        else response.status(401).json({ error: "UNAUTHORIZED" });
    });
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = { "x-test-session": "valid" };
    try {
        assert.equal((await fetch(`${origin}/api/model-probes`)).status, 401);
        const stateResponse = await fetch(`${origin}/api/model-probes`, { headers });
        assert.equal(stateResponse.status, 200);
        assert.equal(stateResponse.headers.get("cache-control"), "no-store");
        assert.equal((await stateResponse.json()).schemaVersion, 1);
        assert.equal((await fetch(`${origin}/api/model-probes/runs`, { headers, method: "POST" })).status, 202);
        assert.equal((await fetch(`${origin}/api/model-probes/runs`, { headers, method: "POST" })).status, 409);
        assert.equal(
            (
                await fetch(`${origin}/api/model-probes/runs/probe-route/cancel`, {
                    headers,
                    method: "POST",
                })
            ).status,
            200
        );
        assert.equal(
            (
                await fetch(`${origin}/api/model-probes/runs/missing/cancel`, {
                    headers,
                    method: "POST",
                })
            ).status,
            404
        );
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
