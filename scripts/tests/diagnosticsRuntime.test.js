const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { start } = require("../diagnostics/isolatedServer");
const LoggingService = require("../../src/utils/LoggingService");
const Diagnostics = require("../../src/diagnostics/Diagnostics");
const Headers = require("../../src/diagnostics/Headers");
const Boundary = require("../../src/diagnostics/HttpBoundary");

const tick = () => new Promise(resolve => setImmediate(resolve));
const records = [];
let checks = 0;
const workspace = process.cwd();
const output = path.join(workspace, "tmp/diagnostics-runtime.jsonl");
const trace = "1".repeat(32);
const parent = "2".repeat(16);
function complete(records) {
    const groups = new Map();
    for (const record of records.filter(r => r.spanId)) {
        const key = `${record.bootId}/${record.spanId}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    }
    for (const list of groups.values()) {
        const terminal = list.filter(r => ["diag.server", "diag.call"].includes(r.event));
        assert.equal(terminal.length, 1);
        assert.equal(list[list.length - 1], terminal[0], "no late public records after terminal");
        assert.deepEqual(
            list.map(r => r.logSeq),
            list.map((_, i) => i + 1)
        );
        assert.equal(terminal[0].data.coverage.expectedLastLogSeq, terminal[0].logSeq);
    }
}

async function pipeline() {
    const f = await start({
        env: {
            DIAG_DEPLOYMENT_ID: "fixture-pool",
            DIAG_ENVIRONMENT: "test",
            DIAG_INSTANCE_ID: "fixture-one",
            LOG_LEVEL: "DEBUG",
        },
        onRecord: r => records.push(r),
        quiet: true,
    });
    async function request(format, scenario, stream, headers = {}) {
        const model = `diag-${scenario}`;
        const route =
            format === "gemini"
                ? `/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`
                : format === "openai"
                  ? "/v1/chat/completions"
                  : format === "response_api"
                    ? "/v1/responses"
                    : "/v1/messages";
        const body =
            format === "gemini"
                ? { contents: [{ parts: [{ text: "FORBIDDEN_INPUT" }], role: "user" }] }
                : format === "response_api"
                  ? { input: "FORBIDDEN_INPUT", model, stream }
                  : { max_tokens: 128, messages: [{ content: "FORBIDDEN_INPUT", role: "user" }], model, stream };
        const r = await fetch(f.address + route, {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json", ...headers },
            method: "POST",
        });
        const text = await r.text();
        await tick();
        const requestId = r.headers.get("x-diag-request-id");
        assert.equal(r.headers.get("x-request-id"), requestId);
        const own = records.filter(e => e.requestId === requestId);
        return { own, requestId, response: r, text };
    }
    try {
        for (const format of ["gemini", "openai", "response_api", "claude"])
            for (const stream of [true, false]) {
                for (const scenario of [
                    "usage87",
                    "empty",
                    "blocked",
                    "truncated",
                    "tool",
                    "missing",
                    "zero",
                    "retry",
                ]) {
                    const r = await request(format, scenario, stream, {
                        traceparent: `00-${trace}-${parent}-01`,
                        "x-request-id": "shared-caller",
                    });
                    assert.equal(
                        r.response.status,
                        scenario === "empty" ? 502 : 200,
                        `${format}/${scenario}/${stream}: ${r.text}`
                    );
                    assert(r.own.length >= 3);
                    assert(r.own.every(e => e.traceId === trace));
                    const terminal = r.own.find(e => e.event === "diag.server");
                    assert.equal(terminal.parentSpanId, parent);
                    assert.equal(terminal.data.deliveryState, "local_finished");
                    assert.equal(terminal.data.callCount, ["empty", "retry"].includes(scenario) ? 2 : 1);
                    const attempts = r.own.filter(e => e.event === "upstream.attempt_finished");
                    assert.equal(
                        attempts.at(-1).data.resultClass,
                        scenario === "empty"
                            ? "empty"
                            : scenario === "blocked"
                              ? "blocked"
                              : scenario === "truncated"
                                ? "incomplete"
                                : "success"
                    );
                    if (scenario === "usage87") assert.equal(attempts[0].data.usage.candidate.value, 87);
                    if (scenario === "zero") assert.equal(attempts[0].data.usage.candidate.value, 0);
                    if (scenario === "missing")
                        assert.deepEqual(attempts[0].data.usage.candidate, {
                            present: false,
                            source: "unknown",
                            value: null,
                        });
                    complete(r.own);
                    checks++;
                }
            }
        for (const format of ["gemini", "openai", "response_api", "claude"]) {
            const pseudo = await request(format, "usage87-fake", true);
            assert.equal(pseudo.response.status, 200);
            assert.equal(pseudo.own.find(e => e.event === "response.converted").data.deliveryMode, "pseudo_stream");
            complete(pseudo.own);
            checks++;
        }
        const concurrent = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                request("openai", i % 2 ? "slow" : "usage87", false, { "x-request-id": "repeated" })
            )
        );
        assert.equal(new Set(concurrent.map(r => r.requestId)).size, 8);
        assert.equal(new Set(concurrent.map(r => r.response.headers.get("x-diag-trace-id"))).size, 8);
        for (const r of concurrent) {
            complete(r.own);
            assert(r.own.every(e => e.requestId === r.requestId));
        }
        checks++;
        const beforeLate = records.length;
        const old = f.dispatches.at(-1);
        f.registry._handleIncomingMessage(
            JSON.stringify({
                event_type: "attempt_closed",
                protocol_version: 2,
                reason: "completed",
                request_attempt_id: old.request_attempt_id,
                request_id: old.request_id,
            }),
            0,
            f.registry.getConnectionByAuth(0)
        );
        await tick();
        assert.equal(records.length, beforeLate);
        await f.reconnect();
        const reconnected = await request("openai", "usage87", false);
        assert.equal(reconnected.response.status, 200);
        complete(reconnected.own);
        checks++;

        const active = request("openai", "slow", false);
        await new Promise(resolve => setTimeout(resolve, 20));
        LoggingService.setLevel("INFO");
        const interrupted = await active;
        assert.equal(interrupted.own.find(e => e.event === "diag.server").data.coverage.debugCapture, "interrupted");
        assert(interrupted.own.every(e => e.recordKind === "basic"));
        const disabled = await request("openai", "usage87", false);
        assert(disabled.own.every(e => e.recordKind === "basic"));
        assert.equal(disabled.own.find(e => e.event === "diag.server").data.coverage.debugCapture, "none");
        const notOptedIn = request("openai", "slow", false);
        await new Promise(resolve => setTimeout(resolve, 20));
        LoggingService.setLevel("DEBUG");
        const notOpted = await notOptedIn;
        assert(notOpted.own.every(e => e.recordKind === "basic"));
        checks++;
        // Real disconnect settles once; the delayed browser callback retains the old IDs.
        const pending = http.request(f.address + "/v1/chat/completions", {
            headers: { "content-type": "application/json" },
            method: "POST",
        });
        pending.on("error", () => {});
        pending.end(
            JSON.stringify({ messages: [{ content: "fixture", role: "user" }], model: "diag-slow", stream: true })
        );
        await new Promise(resolve => setTimeout(resolve, 15));
        pending.destroy();
        await new Promise(resolve => setTimeout(resolve, 110));
        assert(records.some(r => r.event === "diag.server" && r.data.deliveryState === "cancelled"));
        checks++;
        assert(!JSON.stringify(records).includes("FORBIDDEN_INPUT"));
        assert(f.dispatches.every(p => !Object.hasOwn(p, "traceId") && !Object.hasOwn(p, "publicSpan")));
        assert(
            f.dispatches.every(p =>
                Object.keys(p.headers || {}).every(k => !/^(traceparent|tracestate)$|^x-diag-/i.test(k))
            )
        );
        const original = { traceparent: "bad", tracestate: "bad", "X-Diag-Forged": "bad", "x-request-id": "business" };
        assert.deepEqual(Headers.copiedObject(original), { "x-request-id": "business" });
    } finally {
        await f.close();
    }
}

async function sink() {
    const saved = [];
    const logger = new LoggingService();
    logger._writeDiagnosticLine = line => {
        if (line.startsWith("@diag ")) saved.push(JSON.parse(line.slice(6)));
    };
    const diag = new Diagnostics(logger, {});
    LoggingService.setLevel("DEBUG");
    const span = new Diagnostics.ServerSpan(diag, Headers.extract({ headers: [] }));
    span.startAttempt("a");
    for (let i = 0; i < 110; i++) span.attemptFinished({ attemptId: "a", attemptNo: 1, resultClass: "empty" }, null);
    assert(logger.diagnosticQueue.length <= 96);
    LoggingService.setLevel("INFO");
    span.finish({ headersSent: true, statusCode: 502 }, null, "finished");
    logger._flushDiagnostics();
    const terminal = saved.find(e => e.event === "diag.server");
    assert.equal(terminal.data.coverage.debugCapture, "interrupted");
    assert(terminal.data.coverage.droppedForSpan >= 110);
    assert(saved.every(e => e.recordKind === "basic"));
    // Already queued basic terminal survives the next DEBUG disablement too.
    LoggingService.setLevel("DEBUG");
    const second = new Diagnostics.ServerSpan(diag, Headers.extract({ headers: [] }));
    second.finish({ headersSent: true, statusCode: 200 }, null, "finished");
    LoggingService.setLevel("INFO");
    logger._flushDiagnostics();
    assert(saved.some(e => e.spanId === second.identity.spanId));
    LoggingService.setLevel("DEBUG");
    const truncated = new Diagnostics.ServerSpan(diag, Headers.extract({ headers: [] }));
    truncated.emit("request.normalized", { before: "FORBIDDEN".repeat(1000) });
    truncated.finish({ headersSent: false }, null, "error");
    logger._flushDiagnostics();
    assert(saved.some(e => e.event === "diag.truncated" && e.logSeq === 1));
    assert.equal(
        saved.find(e => e.spanId === truncated.identity.spanId && e.event === "diag.server").data.coverage
            .truncatedEvents,
        1
    );
    assert(!JSON.stringify(saved).includes("FORBIDDEN"));
    const access = new Diagnostics.ServerSpan(diag, Headers.extract({ headers: [] }));
    diag.setAccessEnabled(false);
    diag.setAccessEnabled(true);
    access.finish({ headersSent: true, statusCode: 200 }, null, "finished");
    logger._flushDiagnostics();
    assert.equal(saved.find(e => e.spanId === access.identity.spanId).data.coverage.accessCapture, "interrupted");
    diag.close();
    records.push(...saved);
    checks += 4;
}

async function httpBoundary() {
    const received = [];
    const server = http.createServer((req, res) => {
        received.push({ headers: req.headers, path: req.url });
        res.setHeader("X-Diag-Request-Id", "peer");
        res.setHeader("X-Diag-Trace-Id", trace);
        setTimeout(() => res.end("fixture"), 10);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const thirdPartyReceived = [];
    const thirdParty = http.createServer((req, res) => {
        thirdPartyReceived.push(req.headers);
        res.setHeader("X-Diag-Request-Id", "untrusted-peer");
        res.end("third-party fixture");
    });
    await new Promise(resolve => thirdParty.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const logger = new LoggingService();
    logger._writeDiagnosticLine = line => records.push(JSON.parse(line.slice(6)));
    const diag = new Diagnostics(logger, {
        DIAG_PEERS: JSON.stringify([
            { alias: "fixture", deploymentId: null, origin, pathPrefix: "/v1", service: "aitoapi" },
        ]),
    });
    const span = new Diagnostics.ServerSpan(diag, Headers.extract({ headers: [] }));
    let client;
    async function send(route, headers, inherited, destination = server) {
        await new Promise((resolve, reject) => {
            client = Boundary.request(
                span,
                http.request,
                { headers, hostname: "127.0.0.1", path: route, port: destination.address().port, protocol: "http:" },
                res => {
                    assert(span.calls.size > 0, "call must remain open at headers");
                    res.resume();
                    res.once("end", resolve);
                },
                { callKind: inherited ? "redirect" : "model", inherited }
            );
            client.on("error", reject);
            client.end();
        });
    }
    try {
        await send("/v1/start", { "x-request-id": "business" });
        const firstParent = received[0].headers.traceparent;
        const copy = Boundary.redirectCopy(client);
        await send("/private", { ...copy.headers, traceparent: "provider-new-hop" }, copy);
        assert.equal(received[1].headers.traceparent, "provider-new-hop");
        assert(!received[1].headers["x-diag-request-id"]);
        await send("/v1/next", { "x-request-id": "business" });
        assert.notEqual(received[2].headers.traceparent, firstParent);
        const thirdPartyCopy = Boundary.redirectCopy(client);
        await send("/v1/next", thirdPartyCopy.headers, thirdPartyCopy, thirdParty);
        assert(!thirdPartyReceived[0].traceparent);
        assert(!thirdPartyReceived[0]["x-diag-request-id"]);
        assert.equal(thirdPartyReceived[0]["x-request-id"], "business");
        await send("/v1/return", { "x-request-id": "business" });
        diag.reloadPeers("invalid");
        await send("/v1/start", Boundary.redirectCopy(client).headers);
        assert(!received[4].headers.traceparent);
        span.finish({ headersSent: true, statusCode: 200 }, null, "finished");
        logger._flushDiagnostics();
        checks += 5;
    } finally {
        diag.close();
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => thirdParty.close(resolve));
    }
}

async function main() {
    await pipeline();
    await sink();
    await httpBoundary();
    const worker =
        "const r=require('./src/diagnostics/Resource').fromEnvironment({DIAG_INSTANCE_ID:'same'});console.log(JSON.stringify(r.resource))";
    const boots = Array.from({ length: 3 }, () =>
        JSON.parse(spawnSync(process.execPath, ["-e", worker], { cwd: workspace, encoding: "utf8" }).stdout)
    );
    assert.equal(new Set(boots.map(r => r.bootId)).size, 3);
    assert(boots.every(r => r.instanceId === "same"));
    checks++;
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, records.map(r => JSON.stringify(r)).join("\n") + "\n");
    console.log(`diagnostics runtime: ${checks} groups passed; ${records.length} records: ${output}`);
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
