const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { once } = require("node:events");
const { WebSocket } = require("ws");
const { firefox } = require("playwright");
const accounts = require("./accounts.json");
const { validateHttp } = require("./openapi");

async function fullMount() {
    const previousCwd = process.cwd();
    const previousEnvironment = process.env;
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "management-full-mount-"));
    const connect = net.Socket.prototype.connect;
    const tlsConnect = tls.connect;
    const launch = firefox.launch;
    let system, server;
    const logs = [];
    const pages = [];
    const fetches = [];
    const productionCalls = [];
    const behaviors = new Map();
    let fetchHook;
    let modelCalls = 0;
    let forwardCalls = 0;
    let logging;
    const logMethods = {};
    try {
        process.chdir(rootDir);
        // Replace, never inspect, the caller's environment. Real ConfigLoader
        // reads only fixture variables and empty temporary configuration paths.
        process.env = {
            API_KEYS: "model_fixture_key",
            RATE_LIMIT_MAX_ATTEMPTS: "0",
            TEMP: path.dirname(rootDir),
            TMP: path.dirname(rootDir),
            WEB_CONSOLE_PASSWORD: "console_fixture_password",
        };
        net.Socket.prototype.connect = function (...args) {
            const options = Array.isArray(args[0]) ? args[0][0] : args[0];
            const host = typeof options === "object" ? options.host : args[1];
            assert.equal(host, "127.0.0.1", "Only fixture loopback sockets are permitted");
            return connect.apply(this, args);
        };
        tls.connect = () => {
            throw new Error("External TLS forbidden");
        };
        firefox.launch = async () => {
            const record = { closed: false, timers: new Set() };
            pages.push(record);
            const close = async () => {
                record.closed = true;
                record.socket?.terminate();
                for (const timer of record.timers) clearTimeout(timer);
            };
            const page = {
                addInitScript: async (fn, args) => {
                    record.index = args.index;
                    record.endpoint = args.endpoint;
                    vm.runInNewContext(`(${fn.toString()})(args)`, { ...record.sandbox, args });
                    record.sandbox.WebSocket = record.sandbox.window.WebSocket;
                },
                close,
                evaluate: async fn => vm.runInNewContext(`(${fn.toString()})()`, record.sandbox),
                getByRole: () => ({ first: () => ({ isVisible: async () => false }) }),
                goto: async url => {
                    record.entryUrl = url;
                    assert.equal(url, system.config.aiStudioAppUrl);
                    const source = fs.readFileSync(path.resolve(__dirname, "../../../client/build.js"), "utf8");
                    vm.runInNewContext(source, record.sandbox);
                    await once(record.socket, "open");
                },
                isClosed: () => record.closed,
            };
            return {
                close,
                newContext: async options => {
                    record.credentials = options.storageState;
                    const value = options.storageState.cookies[0]?.value;
                    const fixture = accounts.find(account => account.cookies[0].value === value);
                    assert.ok(fixture, "Browser mock accepts synthetic fixture credentials only");
                    record.email = fixture.accountName;
                    class FixtureSocket extends WebSocket {
                        constructor(url, protocols) {
                            super(url, protocols);
                            record.socket = this;
                            this.on("error", () => {});
                        }
                    }
                    const window = {
                        addEventListener() {},
                        WebSocket: FixtureSocket,
                        WIZ_global_data: { oPEP7c: fixture.accountName },
                    };
                    window.top = window;
                    record.sandbox = {
                        AbortController,
                        Blob,
                        clearTimeout,
                        console: { debug() {}, error() {}, log() {}, warn() {} },
                        CustomEvent,
                        document: { body: { appendChild() {} }, createElement: () => ({}), querySelectorAll: () => [] },
                        DOMException,
                        EventTarget,
                        fetch: async (url, config) => {
                            const entry = { config, email: record.email, index: record.index, url };
                            fetches.push(entry);
                            if (fetchHook) await fetchHook(entry);
                            const status = behaviors.get(record.email) || 200;
                            const model = /models\/([^:]+):/.exec(url)?.[1];
                            return new Response(
                                JSON.stringify(
                                    status === 200
                                        ? {
                                              candidates: [
                                                  {
                                                      content: { parts: [{ text: "OK" }], role: "model" },
                                                      finishReason: "STOP",
                                                  },
                                              ],
                                              modelVersion: model,
                                          }
                                        : { error: { message: "synthetic upstream secret" } }
                                ),
                                { status }
                            );
                        },
                        location: { href: "https://aistudio.google.com/apps/fixture" },
                        Response,
                        setTimeout(fn, ms) {
                            if (record.closed) return 0;
                            const timer = setTimeout(fn, ms);
                            record.timers.add(timer);
                            return timer;
                        },
                        TextDecoder,
                        URL,
                        URLSearchParams,
                        window,
                    };
                    return { close, newPage: async () => page, on() {} };
                },
            };
        };
        logging = require("../../../../src/utils/LoggingService");
        for (const method of ["info", "warn", "error", "debug"]) {
            logMethods[method] = logging.prototype[method];
            logging.prototype[method] = message => logs.push(String(message));
        }
        const ProxyServerSystem = require("../../../../src/core/ProxyServerSystem");
        system = new ProxyServerSystem();
        assert.match(system.config.aiStudioAppUrl, /^https:\/\/ai\.studio\/apps\//);
        system.managementDrainTimeoutMs = 20;
        system.managementVerifier.timeoutMs = 2000;
        system.managementVerifier.pollMs = 2;
        system.browserManager.rebalanceContextPool = async () => productionCalls.push(["rebalance"]);
        system.browserManager.closeContext = async index => productionCalls.push(["close", index]);
        system.browserManager.abortBackgroundPreload = async () => {};
        system.requestHandler.processOpenAIRequest = (req, res) => {
            modelCalls++;
            res.json({ fixtureModel: true });
        };
        system.requestHandler.processRequest = (req, res) => {
            forwardCalls++;
            res.status(418).json({ fixtureForward: true });
        };
        const app = system._createExpressApp();
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        system.managementTaskService.start();
        const request = (method, url, body, { token, cookie, headers = {}, raw = false } = {}) =>
            new Promise((resolve, reject) => {
                const requestBody = body === undefined ? undefined : raw ? body : JSON.stringify(body);
                const req = http.request(
                    {
                        agent: false,
                        headers: {
                            "Content-Type": "application/json",
                            ...(token ? { Authorization: `Bearer ${token}` } : {}),
                            ...(cookie ? { Cookie: cookie } : {}),
                            ...headers,
                        },
                        host: "127.0.0.1",
                        method,
                        path: url,
                        port: server.address().port,
                    },
                    res => {
                        let text = "";
                        res.setEncoding("utf8");
                        res.on("data", part => {
                            text += part;
                        });
                        res.on("end", () => {
                            try {
                                const response = {
                                    body:
                                        res.headers["content-type"]?.includes("application/json") && text
                                            ? JSON.parse(text)
                                            : null,
                                    headers: res.headers,
                                    status: res.statusCode,
                                    text,
                                };
                                validateHttp(method, url, response);
                                resolve(response);
                            } catch (error) {
                                reject(error);
                            }
                        });
                    }
                );
                req.on("error", reject);
                req.setTimeout(5000, () => req.destroy(new Error("Fixture HTTP timeout")));
                req.end(requestBody);
            });
        const login = async password => {
            const result = await request("POST", "/login", new URLSearchParams({ password }).toString(), {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                raw: true,
            });
            assert.equal(result.status, 302);
            return result.headers["set-cookie"][0].split(";")[0];
        };
        const poll = async (taskId, token) => {
            const deadline = Date.now() + 6000;
            while (Date.now() < deadline) {
                const result = await request("GET", `/api/manage/v1/tasks/${taskId}`, undefined, { token });
                assert.equal(result.status, 200);
                if (!["queued", "running"].includes(result.body.data.status)) return result.body.data;
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            throw new Error("Task did not reach terminal state");
        };
        const close = async () => {
            await system.managementTaskService.close();
            await system.managementVerifier.close();
            await system.usageStatsService.appendPromise;
            await system.requestHandler.accountRouteStateWrite;
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            restore();
        };
        return {
            accounts,
            behaviors,
            close,
            counters: () => ({ forwardCalls, modelCalls }),
            fetches,
            login,
            logs,
            pages,
            poll,
            productionCalls,
            request,
            rootDir,
            setFetchHook: fn => {
                fetchHook = fn;
            },
            system,
        };
    } catch (error) {
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        await system?.managementTaskService?.close();
        await system?.managementVerifier?.close();
        restore();
        throw error;
    }
    function restore() {
        firefox.launch = launch;
        net.Socket.prototype.connect = connect;
        tls.connect = tlsConnect;
        if (logging) for (const [method, value] of Object.entries(logMethods)) logging.prototype[method] = value;
        process.env = previousEnvironment;
        process.chdir(previousCwd);
        assert.equal(path.dirname(rootDir), path.resolve(os.tmpdir()));
        assert.ok(path.basename(rootDir).startsWith("management-full-mount-"));
        fs.rmSync(rootDir, { force: true, recursive: true });
    }
}

module.exports = { fullMount };
