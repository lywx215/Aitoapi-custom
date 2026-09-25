const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const { errorMonitor } = require("node:events");
const Diagnostics = require("../../src/diagnostics/Diagnostics");
const Headers = require("../../src/diagnostics/Headers");
const Peers = require("../../src/diagnostics/Peers");
const Boundary = require("../../src/diagnostics/HttpBoundary");
const LoggingService = require("../../src/utils/LoggingService");
const RequestHandler = require("../../src/core/RequestHandler");
const records = [];
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
    const logger = new LoggingService();
    logger._writeDiagnosticLine = line => {
        if (line.startsWith("@diag ")) records.push(JSON.parse(line.slice(6)));
    };
    const diag = new Diagnostics(logger, {});
    return { diag, logger, span: () => new Diagnostics.ServerSpan(diag, Headers.extract({ headers: [] })) };
}
function flush(logger) {
    while (logger.diagnosticQueue?.length) logger._flushDiagnostics();
}
function stress() {
    LoggingService.setLevel("DEBUG");
    for (const publicFirst of [false, true]) {
        const f = setup();
        flush(f.logger);
        const before = records.length;
        const legacy = () => {
            for (let i = 0; i < 96; i++) assert(f.logger.diagnostic("DEBUG", "generation.frame", () => ({ seq: i })));
            assert(!f.logger.diagnostic("DEBUG", "generation.frame", () => ({})));
            for (let i = 0; i < 32; i++)
                assert(f.logger.diagnostic("DEBUG", "generation.attempt_finished", () => ({ seq: i })));
            assert(!f.logger.diagnostic("DEBUG", "generation.attempt_finished", () => ({})));
        };
        const publicRecords = () => {
            const span = f.span();
            for (let i = 0; i < 96; i++)
                span.attemptFinished({ attemptId: "stress", attemptNo: 1, resultClass: "empty" }, null);
            assert.equal(f.logger.debugQueued, 96);
            span.attemptFinished({ attemptId: "stress", attemptNo: 1, resultClass: "empty" }, null);
            for (let i = 0; i < 128; i++) f.span().finish({ headersSent: true, statusCode: 200 }, null, "finished");
            f.span().finish({ headersSent: true, statusCode: 200 }, null, "finished");
        };
        if (publicFirst) {
            publicRecords();
            legacy();
        } else {
            legacy();
            publicRecords();
        }
        assert.equal(f.logger.diagnosticQueue.length, 352);
        assert.equal(f.logger.legacyQueued, 128);
        assert.equal(f.logger.basicQueued, 128);
        assert.equal(f.logger.diagnosticDropped, 2);
        assert.equal(f.logger.publicDiagnosticDropped, 2);
        if (publicFirst) LoggingService.setLevel("INFO");
        flush(f.logger);
        assert.equal(records.slice(before).filter(r => r.event === "diag.server").length, 128);
        assert.equal(f.logger.legacyQueued, 0);
        assert.equal(f.logger.debugQueued, 0);
        assert.equal(f.logger.basicQueued, 0);
        f.diag.close();
        LoggingService.setLevel("DEBUG");
    }
}
async function observers() {
    const f = setup();
    const span = f.span();
    span.startAttempt("one");
    for (const frame of [{ candidates: [null] }, { candidates: {} }, { candidates: [{ content: { parts: {} } }] }])
        assert.doesNotThrow(() => span.observeFrame("one", frame));
    assert.doesNotThrow(() =>
        span.observeFrame("one", {
            get candidates() {
                throw new Error("observer fault");
            },
        })
    );
    span.observeTime("firstUpstreamByteMs", "one");
    span.observeTime("firstEffectiveOutputMs", "one");
    span.attemptFinished({ attemptId: "one", attemptNo: 1, resultClass: "empty" }, null);
    await new Promise(resolve => setTimeout(resolve, 15));
    span.startAttempt("two");
    span.attemptFinished({ attemptId: "two", attemptNo: 2, resultClass: "empty" }, null);
    span.finish({ headersSent: true, statusCode: 200 }, null, "finished");
    flush(f.logger);
    const attempts = records.filter(r => r.spanId === span.identity.spanId && r.event === "upstream.attempt_finished");
    assert(attempts[0].data.timing.firstEffectiveOutputMs >= 0);
    assert.equal(attempts[1].data.timing.firstEffectiveOutputMs, null);
    assert.equal(attempts[1].data.timing.firstUpstreamByteMs, null);
    f.diag.close();
}
async function ingress() {
    const f = setup();
    const middleware = f.diag.middleware();
    const handler = { _getRequestedModel: () => null, _getUsageStatsService: () => null };
    const observed = [];
    const server = http.createServer((req, res) =>
        middleware(req, res, () => {
            observed.push({ id: Diagnostics.get(req).identity.requestId, route: req.url });
            assert.equal(res.listenerCount("error"), 0);
            if (req.url === "/nested") {
                res.writeHead(201, [
                    ["X-Diag-Request-Id", "forged"],
                    ["X-Custom", "original"],
                    ["Set-Cookie", "one=1"],
                    ["Set-Cookie", "two=2"],
                ]);
                res.end("body");
            } else if (req.url === "/shutdown") server.closeAllConnections();
            else {
                if (req.url === "/known") res.__generationDestroyed = true;
                res.destroy();
                req.res = res;
                RequestHandler.prototype._startTrackedRequest.call(handler, "late", req);
                assert.equal(handler.diagnosticRequests, undefined);
            }
        })
    );
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const r = await fetch(origin + "/nested");
        assert.equal(r.status, 201);
        assert.equal(await r.text(), "body");
        assert.equal(r.headers.get("x-custom"), "original");
        assert.deepEqual(r.headers.getSetCookie(), ["one=1", "two=2"]);
        assert.notEqual(r.headers.get("x-diag-request-id"), "forged");
        for (const route of ["/destroy", "/known", "/shutdown"]) {
            await assert.rejects(fetch(origin + route));
            await tick();
            flush(f.logger);
            const id = observed.find(item => item.route === route).id;
            const terminal = records.find(item => item.requestId === id && item.event === "diag.server");
            assert.equal(terminal.data.endReason, route === "/known" ? "error" : "unknown");
            assert.equal(terminal.data.deliveryState, route === "/known" ? "failed" : "unknown");
        }
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        f.diag.close();
    }
}
async function boundary() {
    const f = setup();
    const received = [];
    const server = http.createServer((req, res) => {
        received.push({ headers: req.headers, raw: req.rawHeaders });
        res.end("ok");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    f.diag.reloadPeers([
        { alias: "peer", deploymentId: null, origin, pathPrefix: "/antigravity", service: "cliproxyapi" },
    ]);
    const route = "/antigravity/v1beta/models/gemini-3.7-flash:generateContent";
    assert(Peers.match(f.diag.peers, origin + route));
    for (const path of [
        "/antigravity/%3a",
        "/antigravity/../bad",
        "/antigravity/./bad",
        "/antigravity//bad",
        "/antigravity/\\bad",
        "/antigravity-other/x",
    ])
        assert.equal(Peers.match(f.diag.peers, origin + path), null);
    assert.equal(
        Peers.parse([{ alias: "peer", deploymentId: null, origin, pathPrefix: route, service: "cliproxyapi" }])
            .configStatus,
        "config_invalid"
    );
    const span = f.span();
    async function send(headers, inherited) {
        await new Promise((resolve, reject) => {
            const request = Boundary.request(
                span,
                http.request,
                { headers, hostname: "127.0.0.1", path: route, port: server.address().port, protocol: "http:" },
                response => {
                    assert.equal(response.listenerCount("error"), 0);
                    assert.equal(response.listenerCount(errorMonitor), span.sealed ? 0 : 1);
                    response.resume();
                    response.once("end", resolve);
                },
                { inherited }
            );
            assert.equal(request.listenerCount("error"), 0);
            request.on("error", reject);
            request.end();
        });
    }
    try {
        for (const headers of [
            { "X-Business": ["one", "two"] },
            ["X-Business", "one", "X-Business", "two"],
            [
                ["X-Business", "one"],
                ["X-Business", "two"],
            ],
        ]) {
            await send(headers);
            assert.match(received.at(-1).headers.traceparent, /^00-/);
            assert.equal(received.at(-1).headers["x-business"], "one, two");
            assert(received.at(-1).raw.includes("X-Business"));
        }
        span.finish({ headersSent: true, statusCode: 200 }, null, "finished");
        await send(
            { traceparent: "old-module", "X-Business": "kept", "X-Diag-Request-Id": "forged" },
            { diagnosticOwned: true }
        );
        assert.equal(received.at(-1).headers.traceparent, undefined);
        assert.equal(received.at(-1).headers["x-diag-request-id"], undefined);
        await send({ traceparent: "explicit-business", "X-Diag-Trace-Id": "forged" });
        assert.equal(received.at(-1).headers.traceparent, "explicit-business");
        assert.equal(received.at(-1).headers["x-diag-trace-id"], undefined);
    } finally {
        await new Promise(resolve => server.close(resolve));
        flush(f.logger);
        f.diag.close();
    }
}
async function main() {
    stress();
    await observers();
    await ingress();
    await boundary();
    fs.writeFileSync("tmp/diagnostics-revision.jsonl", records.map(r => JSON.stringify(r)).join("\n") + "\n");
    console.log(
        `diagnostics R1: queue pressure both orders, fail-open, attempt isolation, destroy/shutdown, nested headers, peer target/native headers/sealed span passed; ${records.length} records`
    );
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
