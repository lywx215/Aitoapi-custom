const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const Diagnostics = require("../../src/diagnostics/Diagnostics");
const LoggingService = require("../../src/utils/LoggingService");
const ProxyServerSystem = require("../../src/core/ProxyServerSystem");

async function main() {
    const records = [];
    const logger = new LoggingService();
    logger._writeDiagnosticLine = line => records.push(JSON.parse(line.slice(6)));
    const diag = new Diagnostics(logger, {});
    const middleware = diag.middleware();
    const auth = ProxyServerSystem.prototype._createAuthMiddleware.call({
        config: { apiKeys: ["fixture-only"] },
        logger: { info() {}, warn() {} },
        webRoutes: { authRoutes: { getClientIP: () => "127.0.0.1" } },
    });
    const server = http.createServer((req, res) =>
        middleware(req, res, () => {
            req.query = {};
            req.path = req.url;
            res.status = value => {
                res.statusCode = value;
                return res;
            };
            res.json = value => res.end(JSON.stringify(value));
            auth(req, res, () => {
                res.setHeader("X-Diag-Untrusted", "FORBIDDEN");
                res.setHeader("X-Request-Id", "business-id");
                if (req.url === "/array")
                    res.writeHead(201, [
                        "X-Diag-Request-Id",
                        "FORBIDDEN",
                        "x-diag-trace-id",
                        "FORBIDDEN",
                        "Content-Type",
                        "text/plain",
                    ]);
                else res.writeHead(502, { "X-Diag-Request-Id": "FORBIDDEN", "X-Diag-Trace-Id": "FORBIDDEN" });
                res.end("unchanged");
            });
        })
    );
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
        for (const route of ["/array", "/object"]) {
            const response = await fetch(origin + route, {
                headers: { authorization: "Bearer fixture-only", "x-request-id": "caller" },
            });
            assert.equal(await response.text(), "unchanged");
            assert.equal(response.headers.get("x-request-id"), "business-id");
            assert.equal(response.headers.get("x-diag-untrusted"), null);
            assert.match(response.headers.get("x-diag-trace-id"), /^[0-9a-f]{32}$/);
            assert.notEqual(response.headers.get("x-diag-request-id"), "FORBIDDEN");
        }
        const denied = await fetch(origin + "/denied", { headers: { "x-request-id": "caller" } });
        assert.equal(denied.status, 401);
        assert(denied.headers.get("x-diag-request-id"));
        await denied.text();
        await new Promise(resolve => setImmediate(resolve));
        assert(
            records
                .filter(r => r.event === "diag.server" && r.data.wireStatus !== 401)
                .every(r => r.callerIdSource.trust === "authenticated")
        );
        assert.equal(
            records.find(r => r.event === "diag.server" && r.data.wireStatus === 401).callerIdSource.trust,
            "unverified"
        );
        diag.setAccessEnabled(false);
        const before = records.length;
        const disabled = await fetch(origin + "/disabled");
        await disabled.text();
        await new Promise(resolve => setImmediate(resolve));
        assert(disabled.headers.get("x-diag-trace-id"));
        assert.equal(records.length, before);
        // A broken diagnostics sink cannot replace the application response.
        diag.setAccessEnabled(true);
        logger.publicDiagnostic = () => {
            throw new Error("sink fault");
        };
        const failedSink = await fetch(origin + "/sink", { headers: { authorization: "Bearer fixture-only" } });
        assert.equal(await failedSink.text(), "unchanged");
        assert(logger.publicDiagnosticDropped > 0);
        assert(!JSON.stringify(records).includes("fixture-only"));
    } finally {
        diag.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    fs.mkdirSync(path.resolve("tmp"), { recursive: true });
    fs.writeFileSync(
        path.resolve("tmp/diagnostics-ingress.jsonl"),
        records.map(r => JSON.stringify(r)).join("\n") + "\n"
    );
    console.log("diagnostics ingress: raw commit object/array, auth/error, access-off IDs, throwing sink passed");
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
