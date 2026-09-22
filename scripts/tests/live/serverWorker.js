/* global window, location */
const fs = require("node:fs");
const path = require("node:path");
const { firefox } = require("playwright");
const { parseProxyFromEnv } = require("../../../src/utils/ProxyUtils");

// This is an owned subprocess, not a replacement server or browser. No upstream
// response is fulfilled/mocked. Network routing only enforces the run's budget.
const send = payload => process.send?.(payload);
for (const method of ["log", "info", "warn", "error", "debug"]) console[method] = () => {};
let system;
let stopping = false;
let attempts = 0;
let limit = 0;
let browserId = 0;
const ownedBrowsers = new Set();
const originalLaunch = firefox.launch.bind(firefox);

function generation(url) {
    try {
        return /(?:generatecontent|streamgeneratecontent)/i.test(decodeURI(url));
    } catch {
        return /(?:generatecontent|streamgeneratecontent)/i.test(url);
    }
}

async function observeBrowser(browser) {
    ownedBrowsers.add(browser);
    const id = ++browserId;
    browser.once("disconnected", () => ownedBrowsers.delete(browser));
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
        const context = await newContext(options);
        await context.route("**/*", async route => {
            const request = route.request();
            if (request.method() === "POST" && generation(request.url())) {
                if (attempts >= limit) {
                    send({ event: "budget_blocked" });
                    return route.abort("blockedbyclient");
                }
                attempts++;
                send({ attempt: attempts, browserId: id, event: "generation_attempt" });
            }
            await route.continue();
        });
        context.on("response", response => {
            if (response.request().method() === "POST" && generation(response.url()))
                send({ browserId: id, event: "generation_response", status: response.status() });
            else if (response.status() >= 400)
                send({
                    browserId: id,
                    event: "resource_http_error",
                    origin: new URL(response.url()).origin,
                    resourceType: response.request().resourceType(),
                    status: response.status(),
                });
        });
        context.on("requestfailed", request =>
            send({
                browserId: id,
                code: String(request.failure()?.errorText || "").match(/(?:NS_|ERR_)[A-Z_]+/)?.[0] || "NETWORK_ERROR",
                event: "resource_network_error",
                origin: new URL(request.url()).origin,
                resourceType: request.resourceType(),
            })
        );
        context.on("page", page => {
            page.on("domcontentloaded", async () => {
                try {
                    const facts = await page.evaluate(() => ({
                        identityFieldPresent: typeof window.WIZ_global_data?.oPEP7c === "string",
                        loginPage: location.hostname === "accounts.google.com",
                        origin: location.origin,
                    }));
                    // Origins only, never URL query, page text, email or cookie values.
                    send({ browserId: id, event: "page_facts", ...facts });
                } catch {
                    /* Navigation raced an observation. */
                }
            });
        });
        return context;
    };
    return browser;
}
firefox.launch = async options => observeBrowser(await originalLaunch(options));

async function preflight(executablePath) {
    const proxy = parseProxyFromEnv();
    // Current production browser supports an env proxy; the verifier does not.
    // Do not silently change either path for this live acceptance.
    if (proxy) throw Object.assign(new Error(), { code: "PROXY_PATH_MISMATCH" });
    for (const role of ["production", "verification"]) {
        const browser = await firefox.launch({
            executablePath,
            firefoxUserPrefs: { "network.trr.mode": 5, "network.trr.uri": "" },
            headless: true,
        });
        try {
            const context = await browser.newContext();
            const page = await context.newPage();
            const response = await page.goto("https://aistudio.google.com/", {
                timeout: 60000,
                waitUntil: "domcontentloaded",
            });
            const origin = new URL(page.url()).origin;
            const status = response?.status();
            send({ event: "network_preflight", origin, role, status });
            if (
                !status ||
                status >= 400 ||
                !["https://aistudio.google.com", "https://accounts.google.com"].includes(origin)
            )
                throw Object.assign(new Error(), { code: "NETWORK_PREFLIGHT_FAILED" });
        } finally {
            await browser.close();
        }
    }
}

async function stop() {
    if (stopping) return;
    stopping = true;
    try {
        if (system) await system.shutdown();
        await Promise.all([...ownedBrowsers].map(browser => browser.close()));
        send({ attempts, event: "stopped", ownedBrowsers: ownedBrowsers.size });
        process.disconnect();
    } catch (error) {
        send({ code: error.code || "CLEANUP_FAILED", errorType: error.name, event: "worker_error" });
        process.exitCode = 1;
        process.disconnect();
    }
}

process.on("message", async message => {
    try {
        if (message.command === "start") {
            limit = message.budget;
            if (!Number.isInteger(limit) || limit < 0 || limit > 12) throw new Error("Invalid budget");
            const root = path.resolve(message.root);
            if (fs.readdirSync(root).some(name => name === ".git")) throw new Error("Invalid runtime root");
            process.chdir(root);
            process.env.HOST = "127.0.0.1";
            process.env.API_KEYS = message.modelKey;
            process.env.WEB_CONSOLE_PASSWORD = message.password;
            delete process.env.WEB_CONSOLE_USERNAME;
            delete process.env.WS_PORT;
            process.env.CAMOUFOX_EXECUTABLE_PATH = message.executablePath;
            if (message.preflight) await preflight(message.executablePath);
            const ProxyServerSystem = require("../../../src/core/ProxyServerSystem");
            const Adapter = require("../../../src/management/VerifierBrowserAdapter");
            const inspect = Adapter.prototype.inspect;
            Adapter.prototype.inspect = async function () {
                const state = await inspect.call(this);
                const stage = state.stage || "identity_present";
                if (this.liveLastStage !== stage) {
                    this.liveLastStage = stage;
                    send({ event: "identity_observation", stage });
                }
                return state;
            };
            system = new ProxyServerSystem();
            if (system.config.host !== "127.0.0.1" || system.config.httpPort !== 7860 || system.config.wsPort !== 9998)
                throw Object.assign(new Error(), { code: "UNEXPECTED_BIND_CONFIGURATION" });
            // No adapterFactory seam, no stubbed registry or request handler.
            await system.start();
            send({ event: "started" });
        } else if (message.command === "snapshot") {
            send({
                activeRequests: system.requestHandler?.isSystemBusy === true,
                event: "snapshot",
                id: message.id,
                records: system.usageStatsService.getSnapshot().records.map(row => ({
                    attemptCount: row.attemptCount,
                    finalAuthIndex: row.finalAuthIndex,
                    initialAuthIndex: row.initialAuthIndex,
                    outcome: row.outcome,
                    requestId: row.requestId,
                })),
            });
        } else if (message.command === "stop") await stop();
    } catch (error) {
        send({ code: error.code || "WORKER_FAILED", errorType: error.name, event: "worker_error" });
        await stop();
    }
});
process.on("disconnect", () => {
    if (!stopping) stop();
});
module.exports = { generation };
