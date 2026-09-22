const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const LoggingService = require("../../src/utils/LoggingService");

(async () => {
    const originalCwd = process.cwd();
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "management-startup-"));
    const previousKey = process.env.API_KEYS;
    const previousLogLevel = LoggingService.getLevel();
    let system;
    try {
        process.chdir(rootDir);
        process.env.API_KEYS = "fixture-model-key";
        LoggingService.setLevel("ERROR");
        const ProxyServerSystem = require("../../src/core/ProxyServerSystem");
        system = new ProxyServerSystem();
        system.config.host = "127.0.0.1";
        system.config.httpPort = 0;
        system.config.wsPort = 0;
        system.config.checkUpdate = false;
        system.browserManager._ensureBrowser = async () => {
            throw new Error("No browser permitted in startup smoke test");
        };
        await system.start();
        const { token } = await system.managementKeyStore.create({
            name: "fixture-readonly",
            scopes: ["system:read", "accounts:read"],
        });
        const request = (url, key) =>
            new Promise((resolve, reject) => {
                const req = http.get(
                    {
                        agent: false,
                        headers: key ? { Authorization: `Bearer ${key}` } : {},
                        host: "127.0.0.1",
                        path: url,
                        port: system.httpServer.address().port,
                    },
                    res => {
                        let body = "";
                        res.on("data", chunk => {
                            body += chunk;
                        });
                        res.on("end", () => resolve({ body: JSON.parse(body), status: res.statusCode }));
                    }
                );
                req.on("error", reject);
            });
        assert.equal((await request("/health")).status, 200);
        const accounts = await request("/api/manage/v1/accounts", token);
        assert.equal(accounts.status, 200);
        assert.equal(accounts.body.data.total, 0);
        assert.equal((await request("/api/manage/v1/system/readiness", token)).body.data.ready, false);
        assert.equal((await request("/v1/models", "fixture-model-key")).status, 200);
        assert.equal((await request("/v1/models", token)).status, 401);
        assert.equal((await request("/api/manage/v1/accounts", "fixture-model-key")).status, 401);
        assert.equal(system.browserManager.browser, null);
        console.log("managementStartup: real empty-instance HTTP/WS startup, key separation and shutdown passed");
    } finally {
        if (system) await system.shutdown();
        LoggingService.setLevel(previousLogLevel);
        if (previousKey === undefined) delete process.env.API_KEYS;
        else process.env.API_KEYS = previousKey;
        process.chdir(originalCwd);
        assert.equal(path.dirname(rootDir), path.resolve(os.tmpdir()));
        assert.ok(path.basename(rootDir).startsWith("management-startup-"));
        fs.rmSync(rootDir, { force: true, recursive: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
