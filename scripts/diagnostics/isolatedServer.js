/* Isolated DIAG-07 fixture: real Express/RequestHandler/Registry/Pipeline, fake browser over real WS. */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const express = require("express");
const { WebSocket, WebSocketServer } = require("ws");
const LoggingService = require("../../src/utils/LoggingService");

async function start({ port = 0, env = process.env, onRecord = null, quiet = false } = {}) {
    const originalCwd = process.cwd();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aito-diag-fixture-"));
    process.chdir(root);
    // Constructors resolving paths only ever see this disposable directory.
    const RequestHandler = require("../../src/core/RequestHandler");
    const ConnectionRegistry = require("../../src/core/ConnectionRegistry");
    const ProxyServerSystem = require("../../src/core/ProxyServerSystem");
    const UsageStatsService = require("../../src/core/UsageStatsService");
    const Diagnostics = require("../../src/diagnostics/Diagnostics");
    class FixtureLogger extends LoggingService {
        info() {}
        debug() {}
        warn() {}
        error() {}
        _writeDiagnosticLine(line) {
            if (!line.startsWith("@diag ")) return;
            fs.appendFileSync(path.join(root, "diagnostics.jsonl"), `${line.slice(6)}\n`);
            onRecord?.(JSON.parse(line.slice(6)));
            if (!quiet) process.stdout.write(`${line}\n`);
        }
    }
    const logger = new FixtureLogger();
    LoggingService.setLevel(env.LOG_LEVEL || "DEBUG");
    const authSource = {
        accountNameMap: new Map([[0, "fixture"]]),
        availableIndices: [0],
        getCanonicalIndex: i => i,
        getRotationIndices: () => [0],
        isUnavailable: () => false,
    };
    const forbidden = () => {
        throw new Error("Real browser/account operations are disabled in this fixture");
    };
    const browserManager = {
        attemptLightweightReconnect: forbidden,
        contexts: new Map([[0, { page: { isClosed: () => false } }]]),
        currentAuthIndex: 0,
        ensureContextForAuth: forbidden,
        launchOrSwitchContext: forbidden,
        notifyUserActivity() {},
        rebalanceContextPool: async () => {},
    };
    const config = {
        autoDisableStatusCodes: [],
        failureThreshold: 1000000,
        fakeStreamTimeoutMs: 5000,
        generationEmptyRetries: 1,
        generationPreoutputTimeoutMs: 10000,
        host: "127.0.0.1",
        immediateSwitchStatusCodes: [],
        maxContexts: 1,
        maxRetries: 2,
        modelList: [],
        retryDelay: 0,
        safetySettingsThreshold: "OFF",
        streamingMode: "real",
        streamTimeoutMs: 5000,
        switchOnUses: 1000000,
    };
    const registry = new ConnectionRegistry(logger, null, () => 0, browserManager);
    const system = Object.create(ProxyServerSystem.prototype);
    Object.assign(system, {
        _createAuthMiddleware: () => (req, res, next) => next(),
        authSource,
        browserManager,
        config,
        connectionRegistry: registry,
        diagnostics: new Diagnostics(logger, env),
        logger,
        managementKeyRoutes: { createRouter: () => express.Router() },
        managementRoutes: { createRouter: () => express.Router() },
        webRoutes: {
            authRoutes: { getClientIP: () => "127.0.0.1" },
            setupRoutes(app) {
                app.use((req, res, next) => {
                    // The fixture supports inline synthetic inputs only. Production
                    // converter URL downloads must never run from this local driver.
                    if (/https?:\/\//i.test(JSON.stringify(req.body || {})))
                        return res.status(400).json({ error: "fixture_external_url_disabled" });
                    next();
                });
                app.get("/fixture/health", (req, res) => res.json({ ready: true }));
            },
            setupSession() {},
        },
    });
    system.usageStatsService = new UsageStatsService(authSource, logger, path.join(root, "data"));
    system.requestHandler = new RequestHandler(system, registry, logger, browserManager, config, authSource);
    const app = system._createExpressApp();
    const server = http.createServer(app);
    const wss = new WebSocketServer({ path: "/fixture/browser", server });
    wss.on("connection", socket => registry.addConnection(socket, { address: "127.0.0.1", authIndex: 0 }));
    await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${server.address().port}`;
    const dispatches = [];
    const timers = new Set();
    let browser;
    const later = (fn, ms) => {
        const timer = setTimeout(() => {
            timers.delete(timer);
            fn();
        }, ms);
        timers.add(timer);
    };
    async function connectBrowser() {
        const socket = new WebSocket(`${address.replace("http:", "ws:")}/fixture/browser`);
        socket.on("message", payload => {
            const message = JSON.parse(payload);
            if (message.event_type !== "proxy_request") return;
            dispatches.push(message);
            const model = /\/models\/([^:]+)/.exec(message.path)?.[1] || "";
            const scenario =
                [
                    "empty",
                    "blocked",
                    "truncated",
                    "retry",
                    "slow",
                    "thought",
                    "tool",
                    "missing",
                    "zero",
                    "usage87",
                ].find(s => model.includes(`diag-${s}`)) ||
                env.DIAG_FIXTURE_SCENARIO ||
                "usage87";
            const send = value => {
                if (socket.readyState === WebSocket.OPEN)
                    socket.send(
                        JSON.stringify({
                            request_attempt_id: message.request_attempt_id,
                            request_id: message.request_id,
                            ...value,
                        })
                    );
            };
            const frame =
                scenario === "blocked"
                    ? { promptFeedback: { blockReason: "SAFETY" } }
                    : {
                          candidates: [
                              {
                                  content: {
                                      parts:
                                          scenario === "empty" ||
                                          (scenario === "retry" && message.request_attempt_number === 1)
                                              ? []
                                              : scenario === "tool"
                                                ? [{ functionCall: { args: {}, name: "fixture_tool" } }]
                                                : [
                                                      {
                                                          text: "synthetic response",
                                                          ...(scenario === "thought" ? { thought: true } : {}),
                                                      },
                                                  ],
                                      role: "model",
                                  },
                                  finishReason: scenario === "truncated" ? "MAX_TOKENS" : "STOP",
                              },
                          ],
                      };
            if (scenario !== "missing")
                frame.usageMetadata = {
                    candidatesTokenCount: scenario === "zero" ? 0 : 87,
                    promptTokenCount: 3,
                    thoughtsTokenCount: 0,
                    totalTokenCount: scenario === "zero" ? 3 : 90,
                };
            const stream = message.streaming_mode === "real";
            const sse = message.query_params?.alt === "sse";
            send({
                event_type: "response_headers",
                headers: {
                    "content-type": stream && sse ? "text/event-stream" : "application/json",
                    "x-diag-request-id": "untrusted-browser",
                },
                status: 200,
            });
            later(
                () => {
                    send({
                        data: stream
                            ? sse
                                ? `data: ${JSON.stringify(frame)}\n\n`
                                : JSON.stringify([frame])
                            : JSON.stringify(frame),
                        event_type: "chunk",
                    });
                    send({ event_type: "stream_close" });
                    send({ event_type: "attempt_closed", protocol_version: 2, reason: "completed" });
                },
                scenario === "slow" ? 90 : 2
            );
        });
        await once(socket, "open");
        socket.send(JSON.stringify({ event_type: "generation_capabilities", protocol_version: 2 }));
        for (let i = 0; i < 100 && registry.getConnectionByAuth(0, false)?.generationProtocolVersion !== 2; i++)
            await new Promise(resolve => setTimeout(resolve, 2));
        browser = socket;
        return socket;
    }
    await connectBrowser();
    return {
        address,
        async close() {
            for (const timer of timers) clearTimeout(timer);
            system.diagnostics.close();
            // Avoid reconnect recovery scheduling during fixture teardown.
            browserManager.contexts.clear();
            for (const socket of wss.clients) socket.terminate();
            browser?.terminate();
            await new Promise(resolve => wss.close(resolve));
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            for (const entry of registry.generationAttempts.values()) clearTimeout(entry.timer);
            for (const timer of registry.reconnectGraceTimers.values()) clearTimeout(timer);
            await system.usageStatsService.appendPromise;
            await system.requestHandler.accountRouteStateWrite;
            logger._flushDiagnostics();
            process.chdir(originalCwd);
        },
        dispatches,
        logger,
        async reconnect() {
            const old = browser;
            old.close();
            await once(old, "close");
            await connectBrowser();
            return old;
        },
        registry,
        root,
        server,
        system,
    };
}

if (require.main === module) {
    start({ port: Number(process.env.DIAG_FIXTURE_PORT || 0) })
        .then(fixture => {
            console.log(
                JSON.stringify({ address: fixture.address, fixture: "aito-diagnostics", output: fixture.root })
            );
            for (const signal of ["SIGINT", "SIGTERM"])
                process.once(signal, async () => {
                    await fixture.close();
                    process.exit(0);
                });
        })
        .catch(error => {
            console.error(error);
            process.exitCode = 1;
        });
}
module.exports = { start };
