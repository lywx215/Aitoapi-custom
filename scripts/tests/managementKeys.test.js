const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const os = require("node:os");
const path = require("node:path");
const { test, after } = require("node:test");
const express = require("express");
const session = require("express-session");
const KeyStore = require("../../src/management/ManagementKeyStore");
const KeyRoutes = require("../../src/routes/ManagementKeyRoutes");
const AuthRoutes = require("../../src/routes/AuthRoutes");
const contract = require("../../docs/management-api-openapi.json");

const sockets = new Set();
const connect = net.Socket.prototype.connect;
const tlsConnect = tls.connect;
net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof options === "object" ? options.host : args[1];
    const port = typeof options === "object" ? options.port : options;
    assert.ok(
        host === "127.0.0.1" && sockets.has(Number(port)),
        "Tests may only connect to their loopback fixture server"
    );
    return connect.apply(this, args);
};
tls.connect = () => {
    throw new Error("External TLS forbidden in management key tests");
};
after(() => {
    net.Socket.prototype.connect = connect;
    tls.connect = tlsConnect;
});

function fixture(t) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "management-keys-"));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(rootDir)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(rootDir).startsWith("management-keys-"));
        fs.rmSync(rootDir, { force: true, recursive: true });
    });
    const logs = [];
    const logger = Object.fromEntries(
        ["debug", "info", "warn", "error"].map(level => [level, message => logs.push(message)])
    );
    return { logger, logs, rootDir, store: new KeyStore({ logger, rootDir }) };
}
const requestBody = { name: "fixture key", scopes: ["system:read"] };
const denied = error => error.code === "UNAUTHORIZED" && error.status === 401;

async function serverFixture(t) {
    const fixtureState = fixture(t);
    const system = { config: { apiKeys: ["model_fixture_key"] }, logger: fixtureState.logger };
    const app = express();
    app.use(session({ resave: false, saveUninitialized: false, secret: "fixture-only-session-secret" }));
    const routes = new KeyRoutes(system, { keyStore: fixtureState.store });
    app.use("/api/management-keys", routes.createRouter());
    app.use(express.urlencoded({ extended: false }));
    const auth = new AuthRoutes(system);
    auth.setupRoutes(app);
    app.get("/fixture/session", auth.isAuthenticated.bind(auth), (req, res) =>
        res.json({ authMethod: req.session.authMethod })
    );
    app.post("/fixture/legacy", (req, res) => {
        req.session.isAuthenticated = true;
        delete req.session.authMethod;
        res.json({ ok: true });
    });
    let fallbacks = 0;
    app.use((req, res) => {
        fallbacks++;
        res.status(418).json({ fallback: true });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const port = server.address().port;
    sockets.add(port);
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        sockets.delete(port);
    });
    function call(route, { method = "GET", cookie, headers = {}, body } = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request(
                {
                    headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
                    host: "127.0.0.1",
                    method,
                    path: route,
                    port,
                },
                res => {
                    let text = "";
                    res.setEncoding("utf8");
                    res.on("data", chunk => {
                        text += chunk;
                    });
                    res.on("end", () =>
                        resolve({
                            data: res.headers["content-type"]?.includes("application/json") ? JSON.parse(text) : null,
                            headers: res.headers,
                            status: res.statusCode,
                            text,
                        })
                    );
                }
            );
            req.on("error", reject);
            req.end(body);
        });
    }
    async function login(password = "console_fixture_password", username) {
        const result = await call("/login", {
            body: new URLSearchParams({ password, ...(username ? { username } : {}) }).toString(),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            method: "POST",
        });
        assert.equal(result.status, 302);
        assert.equal(result.headers.location, "/");
        return result.headers["set-cookie"][0].split(";")[0];
    }
    process.env.WEB_CONSOLE_PASSWORD = "console_fixture_password";
    delete process.env.WEB_CONSOLE_USERNAME;
    return { ...fixtureState, call, fallbacks: () => fallbacks, login, origin: `http://127.0.0.1:${port}`, routes };
}
const jsonHeaders = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
const endpoint = "/api/management-keys";

test("store matches scope templates, stores only hash, returns defensive metadata and survives restart", async t => {
    const { rootDir, store, logs } = fixture(t);
    assert.deepEqual(KeyStore.SCOPES, contract.components.schemas.Scope.enum);
    assert.deepEqual(KeyStore.TEMPLATES, contract["x-scope-templates"]);
    const created = await store.create({ ...requestBody, expiresAt: "2099-01-01T00:00:00Z" });
    assert.match(created.token, /^mgmt_[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(created.token.slice(5), "base64url").length, 32);
    assert.deepEqual(
        Object.keys(created.key).sort(),
        contract.components.schemas.ManagementKey.required.slice().sort()
    );
    const disk = fs.readFileSync(store.filePath, "utf8");
    assert.ok(!disk.includes(created.token));
    assert.equal(JSON.parse(disk).keys[0].hash, crypto.createHash("sha256").update(created.token).digest("hex"));
    const restarted = new KeyStore({ rootDir });
    assert.deepEqual(restarted.authenticate(created.token), created.key);
    created.key.scopes.push("settings:write");
    restarted.list()[0].scopes.push("accounts:export");
    assert.deepEqual(store.authenticate(created.token).scopes, ["system:read"]);
    assert.deepEqual(restarted.authenticate(created.token).scopes, ["system:read"]);
    for (const invalid of [
        "model_fixture_key",
        "session_fixture",
        undefined,
        {},
        `Bearer ${created.token}`,
        `mgmt_${"x".repeat(43)}`,
    ])
        assert.throws(() => restarted.authenticate(invalid), denied);
    assert.ok(!JSON.stringify(logs).includes(created.token));
    assert.ok(!JSON.stringify(restarted.list()).includes("hash"));
});

test("create validates scopes, names, strict expiry and fields before persistence", async t => {
    const { store } = fixture(t);
    for (const input of [
        null,
        [],
        {},
        { ...requestBody, name: " " },
        { ...requestBody, scopes: [] },
        { ...requestBody, scopes: ["*"] },
        { ...requestBody, scopes: ["system:read", "system:read"] },
        { ...requestBody, template: "admin" },
        ...[null, "tomorrow", "2099-02-30T00:00:00Z", "2099-01-01", "2000-01-01T00:00:00Z"].map(expiresAt => ({
            ...requestBody,
            expiresAt,
        })),
    ]) {
        await assert.rejects(store.create(input), error => error.code === "INVALID_REQUEST" && error.status === 400);
    }
    assert.deepEqual(store.list(), []);
    assert.equal(fs.existsSync(store.filePath), false);
});

test("expiry and revocation immediately deny authentication and queue activity; durable event once", async t => {
    const { store, rootDir } = fixture(t);
    const created = await store.create({ ...requestBody, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const originalNow = Date.now;
    try {
        Date.now = () => Date.parse(created.key.expiresAt);
        assert.equal(store.isActive(created.key.id), false);
        assert.throws(() => store.authenticate(created.token), denied);
    } finally {
        Date.now = originalNow;
    }
    let events = 0;
    store.on("revoked", id => {
        events++;
        assert.equal(id, created.key.id);
        assert.equal(store.isActive(id), false);
        assert.equal(new KeyStore({ rootDir }).isActive(id), false);
    });
    assert.deepEqual(await store.revoke(created.key.id), { id: created.key.id, revoked: true });
    await store.revoke(created.key.id);
    assert.equal(events, 1);
    assert.throws(() => store.authenticate(created.token), denied);
    await assert.rejects(store.revoke("missing"), error => error.code === "NOT_FOUND");
});

test("concurrent creates/revokes serialize without losing rows", async t => {
    const { store, rootDir } = fixture(t);
    const keys = await Promise.all(
        Array.from({ length: 12 }, (_, index) => store.create({ ...requestBody, name: `key ${index}` }))
    );
    await Promise.all(keys.slice(0, 6).map(({ key }) => store.revoke(key.id)));
    const restarted = new KeyStore({ rootDir });
    assert.equal(restarted.list().length, 12);
    assert.equal(new Set(keys.map(row => row.token)).size, 12);
    assert.equal(restarted.list().filter(row => row.revokedAt).length, 6);
});

test("rename failure preserves previous disk and memory; write queue recovers; listener errors are redacted", async t => {
    const { store, logs } = fixture(t);
    const created = await store.create(requestBody);
    const before = fs.readFileSync(store.filePath, "utf8");
    const rename = fs.promises.rename;
    let events = 0;
    store.on("revoked", () => {
        events++;
    });
    try {
        fs.promises.rename = async () => {
            throw new Error(created.token);
        };
        await assert.rejects(
            store.create(requestBody),
            error => error.code === "PERSISTENCE_ERROR" && !error.message.includes(created.token)
        );
        await assert.rejects(store.revoke(created.key.id), error => error.code === "PERSISTENCE_ERROR");
        assert.equal(events, 0);
        assert.equal(store.isActive(created.key.id), true);
        assert.equal(store.list().length, 1);
        assert.equal(fs.readFileSync(store.filePath, "utf8"), before);
        assert.deepEqual(fs.readdirSync(path.dirname(store.filePath)), ["keys.json"]);
    } finally {
        fs.promises.rename = rename;
    }
    store.on("revoked", () => {
        throw new Error(created.token);
    });
    store.on("revoked", async () => {
        throw new Error(created.token);
    });
    await store.revoke(created.key.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events, 1);
    assert.equal(store.isActive(created.key.id), false);
    assert.ok(!JSON.stringify(logs).includes(created.token));
    assert.equal((await store.create(requestBody)).key.name, requestBody.name);
});

test("open, partial-write and sync failures preserve active keys and remove temporary files", async t => {
    const { store } = fixture(t);
    const created = await store.create(requestBody);
    const before = fs.readFileSync(store.filePath, "utf8");
    const originalOpen = fs.promises.open;
    try {
        for (const stage of ["open", "write", "sync"]) {
            fs.promises.open = async (...args) => {
                if (stage === "open") throw new Error("fixture failure");
                const handle = await originalOpen(...args);
                return {
                    close: () => handle.close(),
                    sync: async () => {
                        if (stage === "sync") throw new Error("fixture failure");
                        await handle.sync();
                    },
                    writeFile: async data => {
                        if (stage === "write") {
                            await handle.writeFile(data.slice(0, 10));
                            throw new Error("fixture failure");
                        }
                        await handle.writeFile(data);
                    },
                };
            };
            await assert.rejects(store.revoke(created.key.id), error => error.code === "PERSISTENCE_ERROR");
            assert.equal(store.isActive(created.key.id), true);
            assert.equal(fs.readFileSync(store.filePath, "utf8"), before);
            assert.deepEqual(fs.readdirSync(path.dirname(store.filePath)), ["keys.json"]);
        }
    } finally {
        fs.promises.open = originalOpen;
    }
    await store.revoke(created.key.id);
    assert.equal(store.isActive(created.key.id), false);
});

test("corrupt storage fails closed without overwriting stored evidence", async t => {
    const { store, rootDir } = fixture(t);
    await store.create(requestBody);
    const broken = '{"token":"fixture-secret"';
    fs.writeFileSync(store.filePath, broken);
    assert.throws(
        () => new KeyStore({ rootDir }),
        error => error.code === "PERSISTENCE_ERROR" && !error.message.includes("fixture-secret")
    );
    assert.equal(fs.readFileSync(store.filePath, "utf8"), broken);
});

test("real console/model/legacy session permission matrix and Bearer cannot administer keys", async t => {
    const f = await serverFixture(t);
    const management = await f.store.create(requestBody);
    for (const token of ["model_fixture_key", management.token]) {
        for (const method of ["GET", "POST", "DELETE"]) {
            const response = await f.call(method === "DELETE" ? `${endpoint}/${management.key.id}` : endpoint, {
                body: method === "POST" ? JSON.stringify(requestBody) : undefined,
                headers: { ...jsonHeaders, Authorization: `Bearer ${token}` },
                method,
            });
            assert.equal(response.status, 401);
            assert.equal(response.data.error.code, "UNAUTHORIZED");
            assert.equal(response.headers.location, undefined);
        }
    }
    const consoleCookie = await f.login();
    assert.equal((await f.call("/fixture/session", { cookie: consoleCookie })).data.authMethod, "console_password");
    assert.equal((await f.call(endpoint, { cookie: consoleCookie })).status, 200);
    delete process.env.WEB_CONSOLE_PASSWORD;
    const modelCookie = await f.login("model_fixture_key");
    assert.equal((await f.call("/fixture/session", { cookie: modelCookie })).data.authMethod, "model_key");
    const legacy = await f.call("/fixture/legacy", { method: "POST" });
    const legacyCookie = legacy.headers["set-cookie"][0].split(";")[0];
    for (const cookie of [modelCookie, legacyCookie]) {
        for (const method of ["GET", "POST", "DELETE"]) {
            const response = await f.call(method === "DELETE" ? `${endpoint}/${management.key.id}` : endpoint, {
                body: method === "POST" ? JSON.stringify(requestBody) : undefined,
                cookie,
                headers: jsonHeaders,
                method,
            });
            assert.equal(response.status, 403);
            assert.equal(response.data.error.code, "CONSOLE_PASSWORD_REQUIRED");
        }
    }
    process.env.WEB_CONSOLE_PASSWORD = "console_fixture_password";
    process.env.WEB_CONSOLE_USERNAME = "fixture_admin";
    const namedCookie = await f.login("console_fixture_password", "fixture_admin");
    assert.equal((await f.call("/fixture/session", { cookie: namedCookie })).data.authMethod, "console_password");
    assert.equal(f.fallbacks(), 0);
});

test("key routes create once, paginate, revoke, reject CSRF and return local JSON errors", async t => {
    const f = await serverFixture(t);
    const cookie = await f.login();
    const post = headers => f.call(endpoint, { body: JSON.stringify(requestBody), cookie, headers, method: "POST" });
    for (const headers of [
        { "Content-Type": "application/json" },
        { ...jsonHeaders, Origin: "https://cross-site.invalid" },
        { ...jsonHeaders, Origin: "null" },
        { ...jsonHeaders, "Sec-Fetch-Site": "cross-site" },
        { ...jsonHeaders, "Sec-Fetch-Site": "same-site" },
    ]) {
        const response = await post(headers);
        assert.equal(response.status, 403);
        assert.equal(response.data.error.code, "FORBIDDEN");
    }
    assert.equal(f.store.list().length, 0);
    const created = await post({ ...jsonHeaders, Origin: f.origin, "X-Request-Id": "untrusted-fixture" });
    assert.equal(created.status, 201);
    assert.notEqual(created.data.requestId, "untrusted-fixture");
    assert.match(created.data.requestId, /^req_/);
    assert.equal(created.headers["cache-control"], "no-store");
    const { key, token } = created.data.data;
    const list = await f.call(`${endpoint}?offset=0&limit=1`, { cookie });
    assert.deepEqual(list.data.data, { items: [key], limit: 1, offset: 0, total: 1 });
    assert.ok(!list.text.includes(token) && !list.text.includes("hash"));
    assert.equal((await f.call(endpoint, { cookie })).data.data.limit, 50);
    for (const query of [
        "limit=201",
        "limit=0",
        "offset=-1",
        "limit=1&limit=2",
        "offset=1.2",
        "offset=9007199254740992",
        "limit[x]=1",
    ]) {
        assert.equal((await f.call(`${endpoint}?${query}`, { cookie })).data.error.code, "INVALID_REQUEST");
    }
    for (const [method, route, status, code] of [
        ["PATCH", endpoint, 405, "METHOD_NOT_ALLOWED"],
        ["OPTIONS", endpoint, 405, "METHOD_NOT_ALLOWED"],
        ["GET", `${endpoint}/a/b`, 404, "NOT_FOUND"],
        ["GET", `${endpoint}/${key.id}`, 405, "METHOD_NOT_ALLOWED"],
        ["DELETE", `${endpoint}/invalid`, 400, "INVALID_REQUEST"],
        ["DELETE", `${endpoint}/mkey_${crypto.randomUUID()}`, 404, "NOT_FOUND"],
        ["DELETE", `${endpoint}/%ZZ`, 400, "INVALID_REQUEST"],
    ]) {
        const response = await f.call(route, { cookie, headers: jsonHeaders, method });
        assert.equal(response.status, status, route);
        assert.equal(response.data.error.code, code);
    }
    assert.equal((await f.call(`${endpoint}/${key.id}`, { cookie, method: "DELETE" })).status, 403);
    const revoked = await f.call(`${endpoint}/${key.id}`, { cookie, headers: jsonHeaders, method: "DELETE" });
    assert.deepEqual(revoked.data.data, { id: key.id, revoked: true });
    assert.ok(!revoked.text.includes(token));
    assert.equal(f.store.isActive(key.id), false);
    assert.equal(f.fallbacks(), 0);
});

test("JSON parser errors, size limits and all route failures are sanitized", async t => {
    const f = await serverFixture(t);
    const cookie = await f.login();
    for (const body of [
        '{"secret":"fixture-secret",',
        "[]",
        "null",
        JSON.stringify({ ...requestBody, unknown: "fixture-secret" }),
    ]) {
        const response = await f.call(endpoint, { body, cookie, headers: jsonHeaders, method: "POST" });
        assert.equal(response.status, 400);
        assert.equal(response.data.error.code, "INVALID_REQUEST");
        assert.ok(!response.text.includes("fixture-secret"));
    }
    const tooLarge = await f.call(endpoint, {
        body: JSON.stringify({ ...requestBody, name: "x".repeat(10 * 1024 * 1024) }),
        cookie,
        headers: jsonHeaders,
        method: "POST",
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.data.error.code, "PAYLOAD_TOO_LARGE");
    const wrongType = await f.call(endpoint, {
        body: JSON.stringify(requestBody),
        cookie,
        headers: { ...jsonHeaders, "Content-Type": "text/plain" },
        method: "POST",
    });
    assert.equal(wrongType.status, 400);
    for (const [method, route, storeMethod] of [
        ["GET", endpoint, "list"],
        ["POST", endpoint, "create"],
        ["DELETE", `${endpoint}/mkey_${crypto.randomUUID()}`, "revoke"],
    ]) {
        const original = f.store[storeMethod];
        f.store[storeMethod] = () => {
            throw new Error("fixture-secret");
        };
        const response = await f.call(route, {
            body: method === "POST" ? JSON.stringify(requestBody) : undefined,
            cookie,
            headers: jsonHeaders,
            method,
        });
        assert.equal(response.status, 500);
        assert.equal(response.data.error.code, "INTERNAL_ERROR");
        assert.ok(!response.text.includes("fixture-secret"));
        f.store[storeMethod] = original;
    }
    const rename = fs.promises.rename;
    try {
        fs.promises.rename = async () => {
            throw new Error("fixture-secret");
        };
        const response = await f.call(endpoint, {
            body: JSON.stringify(requestBody),
            cookie,
            headers: jsonHeaders,
            method: "POST",
        });
        assert.equal(response.data.error.code, "PERSISTENCE_ERROR");
        assert.ok(!response.text.includes("fixture-secret"));
    } finally {
        fs.promises.rename = rename;
    }
});

test("standalone ManagementKeys component builds through Vite without parent mounting", async t => {
    const { rootDir } = fixture(t);
    const { build } = require("vite");
    const vue = require("@vitejs/plugin-vue");
    const entry = path.resolve(__dirname, "../../ui/app/components/ManagementKeys.vue");
    await build({
        build: {
            emptyOutDir: true,
            lib: { entry, fileName: "management-keys", formats: ["es"] },
            outDir: path.join(rootDir, "build"),
            rollupOptions: { external: ["vue"] },
        },
        configFile: false,
        logLevel: "error",
        plugins: [vue()],
        publicDir: false,
    });
    assert.ok(fs.readdirSync(path.join(rootDir, "build")).some(file => file.endsWith(".mjs") || file.endsWith(".js")));
});
