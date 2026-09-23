const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { EventEmitter } = require("events");
const express = require("express");
const CredentialStore = require("../../src/storage/CredentialStore");
const RuntimeSettingsStore = require("../../src/storage/RuntimeSettingsStore");
const Tasks = require("../../src/management/ManagementTaskService");
const Accounts = require("../../src/management/ManagementAccountService");
const Routes = require("../../src/routes/ManagementRoutes");
const { failure } = require("../../src/management/ManagementSupport");
const spec = require("../../docs/management-api-openapi.json");
const credentials = name => ({
    accountName: `${name}@example.invalid`,
    cookies: [
        {
            domain: ".example.invalid",
            expires: -1,
            httpOnly: true,
            name: "synthetic",
            path: "/",
            sameSite: "None",
            secure: true,
            value: `SECRET-${name}`,
        },
    ],
    origins: [],
});

async function fixture(t) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "management-routes-"));
    const keys = new EventEmitter();
    let scopes = spec["x-scope-templates"].admin;
    let active = true;
    keys.authenticate = token => {
        if (!active || token !== "mgmt_fixture") throw failure("UNAUTHORIZED");
        return { id: "key-fixture", scopes };
    };
    keys.isActive = () => active;
    const store = new CredentialStore({ rootDir });
    const row = await store.create(credentials("alpha"));
    const calls = { balance: 0, model: 0, reload: 0 };
    const system = {
        authSource: {
            reloadAuthSources() {
                calls.reload++;
            },
            store,
        },
        browserManager: { browser: { isConnected: () => true }, contexts: new Map([[0, {}]]), currentAuthIndex: 0 },
        managementRuntime: {
            blockAccount: () => () => {},
            closeAccount: async () => {},
            hasActiveRequests: () => false,
            rebalance: async () => {
                calls.balance++;
            },
        },
        requestHandler: { isSystemBusy: false },
        runtimeSettingsStore: new RuntimeSettingsStore({
            config: { maxContexts: 2, maxRetries: 3 },
            filePath: path.join(rootDir, "runtime.json"),
            onApplied: async () => {
                if (system.failApply) throw new Error("SECRET-config");
            },
        }),
        usageStatsService: {
            getSnapshot: () => ({
                records: [
                    {
                        durationMs: 12,
                        errorMessage: "SECRET-usage",
                        finalAuthIndex: 0,
                        finishedAt: "2026-01-01T00:00:00.012Z",
                        model: "gemini-3.8-flash",
                        outcome: "success",
                        requestId: "usage-one",
                        startedAt: "2026-01-01T00:00:00.000Z",
                        statusCode: 200,
                    },
                ],
            }),
        },
    };
    const tasks = new Tasks({ keyStore: keys, rootDir });
    const accounts = new Accounts(system, {
        keyStore: keys,
        taskService: tasks,
        verifier: {
            verify: async input => ({
                authIndex: input.index,
                model: input.model,
                requestId: "verified",
                stage: input.mode === "connection" ? "connection_ready" : "model_verified",
                success: true,
                upstreamStatus: 200,
            }),
        },
    });
    const app = express();
    app.use((req, res, next) => {
        req.session = { authenticated: true, authMethod: "console_password" };
        next();
    });
    app.use(
        "/api/manage/v1",
        new Routes(system, { accountService: accounts, keyStore: keys, taskService: tasks }).createRouter()
    );
    app.use((req, res) => {
        calls.model++;
        res.status(218).send("legacy model route");
    });
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        await tasks.close();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(rootDir, { force: true, recursive: true });
    });
    const request = (method, url, body, headers = {}) =>
        new Promise((resolve, reject) => {
            const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
            const req = http.request(
                {
                    headers: {
                        Authorization: "Bearer mgmt_fixture",
                        "Content-Type": "application/json",
                        ...(payload !== undefined ? { "Content-Length": Buffer.byteLength(payload) } : {}),
                        ...headers,
                    },
                    hostname: "127.0.0.1",
                    method,
                    path: url.startsWith("/api/") || url.startsWith("/v1/") ? url : `/api/manage/v1${url}`,
                    port: server.address().port,
                },
                res => {
                    const chunks = [];
                    res.on("data", chunk => chunks.push(chunk));
                    res.on("end", () => {
                        const text = Buffer.concat(chunks).toString();
                        let json;
                        try {
                            json = JSON.parse(text);
                        } catch {
                            // HEAD and the legacy sentinel deliberately have no JSON envelope.
                        }
                        resolve({ headers: res.headers, json, status: res.statusCode, text });
                    });
                }
            );
            req.on("error", reject);
            req.end(payload);
        });
    return {
        accounts,
        calls,
        keys,
        request,
        revoke: () => {
            active = false;
            keys.emit("revoked", "key-fixture");
        },
        rootDir,
        row,
        setScopes: value => {
            scopes = value;
        },
        store,
        system,
        tasks,
    };
}

test("Bearer-only auth rejects session/model keys; per-operation scopes enforce all 21 operations", async t => {
    const f = await fixture(t);
    for (const authorization of ["", "Bearer model-key", "Basic mgmt_fixture", "Bearer mgmt_fixture,extra"]) {
        assert.equal((await f.request("GET", "/accounts", undefined, { Authorization: authorization })).status, 401);
    }
    f.setScopes([]);
    let operations = 0;
    for (const [url, methods] of Object.entries(spec.paths)) {
        if (!url.startsWith("/api/manage/v1/")) continue;
        for (const method of Object.keys(methods)) {
            const result = await f.request(method.toUpperCase(), url.replace("{id}", f.row.accountId));
            assert.equal(result.status, 403, `${method} ${url}: ${result.text}`);
            operations++;
        }
    }
    assert.equal(operations, 21);
    assert.equal(f.calls.model, 0);
});

test("terminal path/method boundaries, server request IDs, bounded JSON parser, and unaffected legacy mount", async t => {
    const f = await fixture(t);
    for (const [method, path, status] of [
        ["GET", "/unknown", 404],
        ["DELETE", "/accounts", 405],
        ["GET", "/accounts/import", 405],
        ["OPTIONS", "/settings", 405],
        ["HEAD", "/accounts", 405],
        ["GET", "/accounts/%XX", 400],
        ["POST", "/accounts/unused/nope", 404],
    ]) {
        const response = await f.request(method, path);
        assert.equal(response.status, status, `${method} ${path}: ${response.text}`);
    }
    const malformed = await f.request("POST", "/accounts/import", '{"cookies":"SECRET-parser",bad');
    assert.equal(malformed.status, 400);
    assert(!malformed.text.includes("SECRET"));
    assert.equal((await f.request("POST", "/accounts/import", "{}", { "Content-Type": "text/plain" })).status, 400);
    assert.equal(
        (await f.request("POST", "/accounts/import", JSON.stringify({ huge: "x".repeat(10 * 1024 * 1024) }))).status,
        413
    );
    const success = await f.request("GET", "/accounts", undefined, { "X-Request-Id": "attacker" });
    assert.notEqual(success.json.requestId, "attacker");
    assert.equal(success.headers["x-request-id"], success.json.requestId);
    assert.equal(success.headers["cache-control"], "no-store");
    assert.equal(f.calls.model, 0);
    assert.equal((await f.request("POST", "/v1/chat/completions", { model: "fixture" })).status, 218);
    assert.equal(f.calls.model, 1);
});

test("read endpoints do not reload/rebalance; pagination, export scope, safe usage and settings snapshot", async t => {
    const f = await fixture(t);
    for (const url of [
        "/accounts",
        `/accounts/${f.row.accountId}`,
        "/system/status",
        "/system/readiness",
        "/settings",
        "/usage",
        "/audit",
        "/tasks",
    ]) {
        const response = await f.request("GET", url);
        assert.equal(response.status, 200, response.text);
        assert(!response.text.includes("SECRET"));
        assert(!response.text.includes('"cookies"'));
    }
    assert.equal(f.calls.reload, 0);
    assert.equal(f.calls.balance, 0);
    const accounts = (await f.request("GET", "/accounts")).json.data;
    assert.equal(accounts.limit, 50);
    for (const query of ["limit=201", "limit=0", "offset=-1", "offset=1.1", "limit=1&limit=2"])
        assert.equal((await f.request("GET", `/accounts?${query}`)).status, 400);
    const usage = (await f.request("GET", "/usage")).json.data.items[0];
    assert.equal(usage.accountId, f.row.accountId);
    assert.equal(usage.index, 0);
    const settings = (await f.request("GET", "/settings")).json.data;
    assert.equal(settings.values.maxRetries, 3);
    assert.equal(settings.persistentKeys.length, 8);
    f.setScopes(spec["x-scope-templates"].operator);
    assert.equal((await f.request("POST", "/accounts/export", { accountIds: [f.row.accountId] })).status, 403);
    assert.equal(
        (
            await f.request(
                "POST",
                "/accounts/batch",
                { accountIds: [f.row.accountId], action: "archive" },
                { "Idempotency-Key": "archive" }
            )
        ).status,
        403
    );
    f.setScopes(["accounts:export"]);
    const exported = await f.request("POST", "/accounts/export", { accountIds: [f.row.accountId] });
    assert.equal(exported.status, 200);
    assert(exported.text.includes("SECRET-alpha"));
    assert(!JSON.stringify(f.tasks.listAudit()).includes("SECRET"));
});

test("task admission boundaries, canonical replay, queue revoke and safe 429/500", async t => {
    const f = await fixture(t);
    const body = { items: [{ clientRef: "beta", credentials: credentials("beta") }] };
    assert.equal((await f.request("POST", "/accounts/import", body)).status, 400);
    const accepted = await f.request("POST", "/accounts/import", body, { "Idempotency-Key": "same" });
    assert.equal(accepted.status, 202);
    assert.deepEqual(
        (await f.request("POST", "/accounts/import", body, { "Idempotency-Key": "same" })).json.data,
        accepted.json.data
    );
    assert.equal(
        (await f.request("POST", "/accounts/import", { ...body, model: "other" }, { "Idempotency-Key": "same" }))
            .status,
        409
    );
    const many = { items: Array.from({ length: 101 }, () => body.items[0]) };
    assert.equal((await f.request("POST", "/accounts/import", many, { "Idempotency-Key": "many" })).status, 413);
    const huge = credentials("huge");
    huge.cookies[0].value = "x".repeat(1024 * 1024);
    assert.equal(
        (
            await f.request(
                "POST",
                "/accounts/import",
                { items: [{ clientRef: "huge", credentials: huge }] },
                { "Idempotency-Key": "huge" }
            )
        ).status,
        413
    );
    assert.equal(
        (
            await f.request(
                "PUT",
                `/accounts/${f.row.accountId}/credentials`,
                JSON.stringify(JSON.stringify(credentials("replacement"))),
                { "Idempotency-Key": "legacy-string" }
            )
        ).status,
        202
    );
    const realSubmit = f.accounts.submit;
    f.accounts.submit = () => {
        throw failure("RATE_LIMITED");
    };
    assert.equal((await f.request("POST", "/accounts/import", body, { "Idempotency-Key": "rate" })).status, 429);
    f.accounts.submit = realSubmit;
    f.accounts.status = () => {
        throw new Error("SECRET-error");
    };
    const error = await f.request("GET", "/system/status");
    assert.equal(error.status, 500);
    assert(!error.text.includes("SECRET"));
    f.revoke();
    assert.equal(f.tasks.get(accepted.json.data.taskId).status, "cancelled");
    assert.equal((await f.request("GET", "/tasks")).status, 401);
});

test("settings application failure preserves durable response and safe object; invalid patches fail", async t => {
    const f = await fixture(t);
    for (const body of [{}, { unknown: true }, { maxRetries: 0 }, { enableUsageStats: true }])
        assert.equal((await f.request("PATCH", "/settings", body)).status, 400);
    f.system.failApply = true;
    const response = await f.request("PATCH", "/settings", { maxRetries: 4 });
    assert.equal(response.status, 200);
    assert.equal(response.json.data.applied, false);
    assert.equal(response.json.data.persisted, true);
    assert.equal(typeof response.json.data.applicationError, "object");
    assert(!response.text.includes("SECRET"));
    assert.equal(f.system.runtimeSettingsStore.snapshot().maxRetries, 4);
    assert.equal(f.tasks.listAudit().items[0].outcome, "partial");
});

test("audit failure after account/settings commit is explicit; failed operation keeps its original error", async t => {
    const f = await fixture(t);
    f.tasks.audit = () => {
        throw failure("PERSISTENCE_ERROR");
    };
    const settings = await f.request("PATCH", "/settings", { maxRetries: 4 });
    assert.equal(settings.status, 500);
    assert.equal(settings.json.error.code, "AUDIT_PERSISTENCE_FAILED");
    assert.equal(f.system.runtimeSettingsStore.snapshot().maxRetries, 4);
    const account = await f.request("PATCH", `/accounts/${f.row.accountId}`, { enabled: false });
    assert.equal(account.status, 500);
    assert.equal(account.json.error.code, "AUDIT_PERSISTENCE_FAILED");
    assert.equal(f.accounts.get(f.row.accountId).enabled, false);
    const invalid = await f.request("PATCH", "/settings", { maxRetries: 0 });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, "INVALID_REQUEST");
});

test("P1 admission errors use the management envelope and leave no new task", async t => {
    const f = await fixture(t);
    const item = { clientRef: "p1", credentials: credentials("p1") };
    const cases = [
        ["POST", "/accounts/import", { items: [item] }, {}, "IDEMPOTENCY_KEY_REQUIRED", 400],
        [
            "POST",
            "/accounts/import",
            { items: [{ ...item, clientRef: "" }] },
            { "Idempotency-Key": "invalid-ref" },
            "INVALID_REQUEST",
            400,
        ],
        [
            "POST",
            "/accounts/import",
            { items: [{ ...item, credentials: {} }] },
            { "Idempotency-Key": "invalid-credential" },
            "INVALID_CREDENTIALS",
            400,
        ],
        [
            "PUT",
            `/accounts/${f.row.accountId}/credentials`,
            { credentials: credentials("p1"), expectedCredentialVersion: 1 },
            { "Idempotency-Key": "invalid-version-pair" },
            "INVALID_REQUEST",
            400,
        ],
        [
            "POST",
            `/accounts/${f.row.accountId}/test`,
            { model: "bad/name" },
            { "Idempotency-Key": "invalid-model" },
            "INVALID_REQUEST",
            400,
        ],
    ];
    for (const [method, url, body, headers, code, status] of cases) {
        const before = f.tasks.list().total;
        const response = await f.request(method, url, body, headers);
        assert.equal(response.status, status, response.text);
        assert.equal(response.json.error.code, code);
        assert.equal(response.json.error.message, failure(code).message);
        assert.match(response.json.requestId, /^req_[a-f0-9-]{36}$/);
        assert.equal(response.headers["x-request-id"], response.json.requestId);
        assert.equal(f.tasks.list().total, before);
    }
    const endpoints = [
        ["POST", "/accounts/import", { items: [item] }],
        ["PUT", `/accounts/${f.row.accountId}/credentials`, { credentials: credentials("replacement") }],
        ["POST", `/accounts/${f.row.accountId}/test`, { mode: "model" }],
    ];
    for (const [method, url, body] of endpoints) {
        const unauthorized = await f.request(method, url, body, { Authorization: "Bearer wrong" });
        assert.equal(unauthorized.status, 401);
        assert.deepEqual(unauthorized.json.error, {
            code: "UNAUTHORIZED",
            message: failure("UNAUTHORIZED").message,
        });
        assert.equal(unauthorized.headers["x-request-id"], unauthorized.json.requestId);
        f.setScopes([]);
        const forbidden = await f.request(method, url, body, { "Idempotency-Key": `forbidden-${url}` });
        assert.equal(forbidden.status, 403);
        assert.equal(forbidden.json.error.code, "FORBIDDEN");
        f.setScopes(spec["x-scope-templates"].admin);
        const missingKey = await f.request(method, url, body);
        assert.equal(missingKey.status, 400);
        assert.equal(missingKey.json.error.code, "IDEMPOTENCY_KEY_REQUIRED");
        assert.equal(f.tasks.list().total, 0);
    }
    const first = await f.request("POST", "/accounts/import", { items: [item] }, { "Idempotency-Key": "p1-accepted" });
    assert.equal(first.status, 202);
    const conflict = await f.request(
        "POST",
        "/accounts/import",
        { items: [{ ...item, clientRef: "other" }] },
        { "Idempotency-Key": "p1-accepted" }
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(f.tasks.list().total, 1);
    const old = f.tasks.state.tasks;
    f.tasks.state.tasks = Array.from({ length: 1000 }, () => old[0]);
    try {
        const limited = await f.request(
            "POST",
            "/accounts/import",
            { items: [item] },
            { "Idempotency-Key": "p1-full" }
        );
        assert.equal(limited.status, 429);
        assert.equal(limited.json.error.code, "RATE_LIMITED");
        assert.equal(f.tasks.state.tasks.length, 1000);
        const replay = await f.request(
            "POST",
            "/accounts/import",
            { items: [item] },
            { "Idempotency-Key": "p1-accepted" }
        );
        assert.equal(replay.status, 202);
        assert.equal(replay.json.data.taskId, first.json.data.taskId);
    } finally {
        f.tasks.state.tasks = old;
    }
});

test("P1 disable conflict is pre-write, while ACCOUNT_BUSY and audit failure can follow a committed disable", async t => {
    const f = await fixture(t);
    const url = `/accounts/${f.row.accountId}`;
    const before = f.accounts.get(f.row.accountId);
    const stale = await f.request("PATCH", url, {
        enabled: false,
        expectedCredentialVersion: before.credentialVersion,
        expectedStateVersion: before.stateVersion + 1,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "VERSION_CONFLICT");
    assert.equal(f.accounts.get(f.row.accountId).stateVersion, before.stateVersion);
    assert.equal(f.accounts.get(f.row.accountId).enabled, true);

    f.system.managementDrainTimeoutMs = 0;
    f.system.managementRuntime.hasActiveRequests = () => true;
    const busy = await f.request("PATCH", url, {
        enabled: false,
        expectedCredentialVersion: before.credentialVersion,
        expectedStateVersion: before.stateVersion,
    });
    assert.equal(busy.status, 409);
    assert.equal(busy.json.error.code, "ACCOUNT_BUSY");
    const disabled = (await f.request("GET", url)).json.data;
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.credentialVersion, before.credentialVersion);
    assert.notEqual(disabled.stateVersion, before.stateVersion);

    f.system.managementRuntime.hasActiveRequests = () => false;
    f.tasks.audit = () => {
        throw failure("PERSISTENCE_ERROR");
    };
    const audit = await f.request("PATCH", url, {
        enabled: false,
        expectedCredentialVersion: disabled.credentialVersion,
        expectedStateVersion: disabled.stateVersion,
    });
    assert.equal(audit.status, 500);
    assert.equal(audit.json.error.code, "AUDIT_PERSISTENCE_FAILED");
    assert.equal((await f.request("GET", url)).json.data.enabled, false);
});

test("P1 terminal import item without accountId does not prove account creation was absent", async t => {
    const f = await fixture(t);
    const create = f.store.create.bind(f.store);
    f.store.create = async (...args) => {
        await create(...args);
        throw new Error("synthetic post-commit response loss");
    };
    const accepted = await f.request(
        "POST",
        "/accounts/import",
        {
            items: [{ clientRef: "post-commit", credentials: credentials("post-commit") }],
        },
        { "Idempotency-Key": "post-commit" }
    );
    assert.equal(accepted.status, 202);
    f.tasks.start();
    await f.tasks.worker;
    const task = (await f.request("GET", `/tasks/${accepted.json.data.taskId}`)).json.data;
    assert.equal(task.status, "failed");
    assert.equal(task.items[0].clientRef, "post-commit");
    assert.equal(task.items[0].accountId, undefined);
    assert.equal(task.items[0].status, "failed");
    assert.equal(task.result.changed, false);
    assert.equal(f.store.listMetadata().length, 2);
    assert.equal(f.store.listMetadata()[1].disabled, true);
});

test("P1 completed verification versions become stale after a later account state change", async t => {
    const f = await fixture(t);
    const accepted = await f.request(
        "POST",
        "/accounts/import",
        {
            items: [{ clientRef: "version-drift", credentials: credentials("version-drift") }],
        },
        { "Idempotency-Key": "version-drift" }
    );
    assert.equal(accepted.status, 202);
    f.tasks.start();
    await f.tasks.worker;
    const task = (await f.request("GET", `/tasks/${accepted.json.data.taskId}`)).json.data;
    const item = task.items[0];
    assert.equal(task.status, "succeeded");
    assert.equal(item.result.stage, "model_verified");
    const before = (await f.request("GET", `/accounts/${item.accountId}`)).json.data;
    assert.equal(item.result.credentialVersion, before.credentialVersion);
    assert.equal(item.result.stateVersion, before.stateVersion);
    const patch = await f.request("PATCH", `/accounts/${item.accountId}`, {
        enabled: false,
        expectedCredentialVersion: before.credentialVersion,
        expectedStateVersion: before.stateVersion,
    });
    assert.equal(patch.status, 200);
    const current = (await f.request("GET", `/accounts/${item.accountId}`)).json.data;
    assert.equal(current.enabled, false);
    assert.equal(current.credentialVersion, item.result.credentialVersion);
    assert.notEqual(current.stateVersion, item.result.stateVersion);
    assert.equal(
        (await f.request("GET", `/tasks/${accepted.json.data.taskId}`)).json.data.items[0].result.stateVersion,
        item.result.stateVersion
    );
});
