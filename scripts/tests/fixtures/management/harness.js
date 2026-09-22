const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const express = require("express");
const accounts = require("./accounts.json");

// A single standalone process owns cwd. Never run this harness concurrently in
// one process: legacy constructors resolve config/data relative to cwd.
async function createHarness() {
    const originalCwd = process.cwd();
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "management-baseline-"));
    const originalConnect = net.Socket.prototype.connect;
    const originalTlsConnect = tls.connect;
    let server;
    let system;
    const calls = [];
    const logger = { debug() {}, error() {}, info() {}, warn() {} };
    const blocked = () => {
        throw new Error("External network/browser operation is forbidden in management baseline tests");
    };
    async function close() {
        try {
            if (server) {
                server.closeAllConnections?.();
                await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
            }
            await system?.usageStatsService?.appendPromise;
            await system?.requestHandler?.accountRouteStateWrite;
        } finally {
            process.chdir(originalCwd);
            net.Socket.prototype.connect = originalConnect;
            tls.connect = originalTlsConnect;
            const resolved = path.resolve(rootDir);
            assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
            assert.ok(path.basename(resolved).startsWith("management-baseline-"));
            fs.rmSync(resolved, { force: true, recursive: true });
        }
    }
    try {
        process.chdir(rootDir);
        fs.mkdirSync(path.join(rootDir, "configs", "auth"), { recursive: true });
        accounts.forEach((account, index) => {
            fs.writeFileSync(path.join(rootDir, "configs", "auth", `auth-${index}.json`), JSON.stringify(account));
        });
        // Guard sockets, including connections made by accidentally invoked HTTP,
        // HTTPS, fetch or WebSocket clients. Only this fixture server is reachable.
        net.Socket.prototype.connect = function (...args) {
            const first = Array.isArray(args[0]) ? args[0][0] : args[0];
            const host = typeof first === "object" ? first.host : args[1];
            const port = typeof first === "object" ? first.port : first;
            if (host !== "127.0.0.1" || Number(port) !== server?.address()?.port) blocked();
            return originalConnect.apply(this, args);
        };
        tls.connect = blocked;
        // Load real constructors after moving to the disposable directory.
        const AuthSource = require("../../../../src/auth/AuthSource");
        const RequestHandler = require("../../../../src/core/RequestHandler");
        const StatusRoutes = require("../../../../src/routes/StatusRoutes");
        const UsageStatsService = require("../../../../src/core/UsageStatsService");
        const authSource = new AuthSource(logger);
        const connections = new Map(accounts.map((_, index) => [index, { readyState: 1 }]));
        const browserManager = {
            _checkPageStatusAndErrors: async (page, label, index) => calls.push(["pageCheck", index]),
            _withContextPoolMutation: async task => task(),
            browser: null,
            closeContext: async index => {
                calls.push(["closeContext", index]);
                browserManager.contexts.delete(index);
            },
            contexts: new Map(accounts.map((_, index) => [index, { page: { isClosed: () => false } }])),
            currentAuthIndex: 0,
            ensureContextForAuth: async index => {
                calls.push(["warm", index]);
                return false;
            },
            launchOrSwitchContext: blocked,
            rebalanceContextPool: async () => calls.push(["rebalance"]),
        };
        const connectionRegistry = {
            closeConnectionByAuth: index => {
                calls.push(["closeConnection", index]);
                connections.delete(index);
            },
            closeMessageQueuesForAuth: (index, reason) => calls.push(["closeQueues", index, reason]),
            getConnectionByAuth: index => connections.get(index),
        };
        const config = {
            accountCooldownMaxMs: 1800000,
            accountCooldownMs: 300000,
            autoDisableStatusCodes: [],
            autoHealProbeIntervalMs: 18000000,
            autoHealProbeTimeoutMs: 600000,
            checkUpdate: false,
            failureThreshold: 3,
            immediateSwitchStatusCodes: [],
            maxContexts: 2,
            maxRetries: 3,
            retryDelay: 2000,
            switchOnUses: 20,
        };
        system = { authSource, browserManager, config, connectionRegistry, logger };
        system.usageStatsService = new UsageStatsService(authSource, logger, path.join(rootDir, "data"));
        system.requestHandler = new RequestHandler(
            system,
            connectionRegistry,
            logger,
            browserManager,
            config,
            authSource
        );
        const routes = new StatusRoutes(system);
        routes.versionChecker.checkForUpdates = blocked;
        const app = express();
        app.use(express.json());
        // Authentication is deliberately a boundary mock, not a key/session test.
        routes.setupRoutes(app, (req, res, next) => {
            if (req.headers["x-fixture-console"] === "allowed") return next();
            return res.status(401).json({ fixtureBoundary: "denied" });
        });
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const request = async (method, url, body, authenticated = true) => {
            const encoded = body === undefined ? undefined : JSON.stringify(body);
            return new Promise((resolve, reject) => {
                const req = http.request(
                    {
                        agent: false,
                        headers: {
                            "content-type": "application/json",
                            ...(authenticated ? { "x-fixture-console": "allowed" } : {}),
                        },
                        host: "127.0.0.1",
                        method,
                        path: url,
                        port: server.address().port,
                    },
                    res => {
                        let text = "";
                        res.setEncoding("utf8");
                        res.on("data", chunk => {
                            text += chunk;
                        });
                        res.on("end", () => {
                            try {
                                resolve({ body: JSON.parse(text), status: res.statusCode });
                            } catch (error) {
                                reject(error);
                            }
                        });
                    }
                );
                req.on("error", reject);
                req.setTimeout(5000, () => req.destroy(new Error("Fixture HTTP timeout")));
                req.end(encoded);
            });
        };
        return { accounts, calls, close, connections, request, rootDir, routes, system };
    } catch (error) {
        await close();
        throw error;
    }
}

module.exports = { createHarness };
