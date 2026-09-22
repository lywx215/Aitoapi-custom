const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fullMount } = require("./fullMount");
const spec = require("../../../../docs/management-api-openapi.json");
const KeyStore = require("../../../../src/management/ManagementKeyStore");

const gateIds = Array.from({ length: 9 }, (_, index) => `W2-${String(index + 1).padStart(2, "0")}`);
function supportingSuite(name) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "management-supporting-suite-"));
    try {
        const result = spawnSync(
            process.execPath,
            ["--test-reporter=tap", path.resolve(__dirname, `../../${name}.test.js`)],
            {
                cwd: scratch,
                encoding: "utf8",
                maxBuffer: 2 * 1024 * 1024,
                timeout: 45000,
            }
        );
        assert.equal(result.status, 0, `${name}: ${result.error || ""}\n${result.stdout}\n${result.stderr}`);
        assert.ok(!/^# (?:todo|fail) [1-9]/m.test(result.stdout), `${name} has incomplete evidence`);
        return result.stdout;
    } finally {
        assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
        assert.ok(path.basename(scratch).startsWith("management-supporting-suite-"));
        fs.rmSync(scratch, { force: true, recursive: true });
    }
}

function registerLocalAcceptance(test) {
    test("real mounted management API local acceptance", async t => {
        const h = await fullMount();
        const base = "/api/manage/v1";
        let cookie, admin, imported, alpha, beta;
        const mint = async scopes => {
            const response = await h.request(
                "POST",
                "/api/management-keys",
                { name: "fixture", scopes },
                {
                    cookie,
                    headers: { "X-Requested-With": "XMLHttpRequest" },
                }
            );
            assert.equal(response.status, 201, response.text);
            return response.body.data;
        };
        const call = (method, endpoint, body, options = {}) =>
            h.request(method, base + endpoint, body, { token: admin?.token, ...options });
        let submission = 0;
        const submit = async (endpoint, body = {}, method = "POST", token = admin.token) => {
            const response = await call(method, endpoint, body, {
                headers: { "Idempotency-Key": `local-${++submission}` },
                token,
            });
            assert.equal(response.status, 202, response.text);
            return response.body.data.taskId;
        };
        const account = async id => (await call("GET", `/accounts/${id}`)).body.data;
        const error = (response, status, code) => {
            assert.equal(response.status, status, response.text);
            assert.equal(response.body.error.code, code);
            assert.equal(typeof response.body.requestId, "string");
            assert.equal(response.headers.location, undefined);
        };
        try {
            cookie = await h.login("console_fixture_password");
            admin = await mint(KeyStore.SCOPES);
            await t.test(
                "W2-01 real session/key lifecycle, every declared scope, model/session separation",
                async () => {
                    for (const options of [{}, { token: "model_fixture_key" }, { cookie }]) {
                        error(
                            await call("GET", "/accounts", undefined, { token: undefined, ...options }),
                            401,
                            "UNAUTHORIZED"
                        );
                    }
                    error(
                        await h.request("GET", "/api/management-keys", undefined, { token: admin.token }),
                        401,
                        "UNAUTHORIZED"
                    );
                    delete process.env.WEB_CONSOLE_PASSWORD;
                    const modelCookie = await h.login("model_fixture_key");
                    process.env.WEB_CONSOLE_PASSWORD = "console_fixture_password";
                    error(
                        await h.request("GET", "/api/management-keys", undefined, { cookie: modelCookie }),
                        403,
                        "CONSOLE_PASSWORD_REQUIRED"
                    );
                    error(
                        await call("GET", "/accounts", undefined, { cookie: modelCookie, token: undefined }),
                        401,
                        "UNAUTHORIZED"
                    );
                    for (const missing of KeyStore.SCOPES) {
                        const key = await mint(KeyStore.SCOPES.filter(scope => scope !== missing));
                        const entry = Object.entries(spec.paths)
                            .flatMap(([url, methods]) =>
                                Object.entries(methods).map(([method, operation]) => ({ method, operation, url }))
                            )
                            .find(row => row.operation["x-required-scopes"].includes(missing));
                        assert.ok(entry, `Scope ${missing} must have a real route`);
                        error(
                            await h.request(
                                entry.method.toUpperCase(),
                                entry.url.replace("{id}", "fixture-id"),
                                entry.method === "get" ? undefined : {},
                                { headers: { "Idempotency-Key": `scope-${missing}` }, token: key.token }
                            ),
                            403,
                            "FORBIDDEN"
                        );
                    }
                    const operator = await mint(KeyStore.TEMPLATES.operator);
                    error(
                        await call(
                            "POST",
                            "/accounts/batch",
                            { accountIds: ["fixture-id"], action: "archive" },
                            { headers: { "Idempotency-Key": "archive-scope" }, token: operator.token }
                        ),
                        403,
                        "FORBIDDEN"
                    );
                    assert.equal((await h.request("GET", "/v1/models", undefined, { token: admin.token })).status, 401);
                    assert.equal(
                        (await h.request("POST", "/v1/chat/completions", {}, { token: "model_fixture_key" })).status,
                        200
                    );
                    assert.equal(h.counters().modelCalls, 1);
                    assert.equal(h.counters().forwardCalls, 0);
                    const disposable = await mint(["system:read"]);
                    assert.equal(
                        (
                            await h.request("DELETE", `/api/management-keys/${disposable.key.id}`, undefined, {
                                cookie,
                                headers: { "X-Requested-With": "XMLHttpRequest" },
                            })
                        ).status,
                        200
                    );
                    error(
                        await call("GET", "/system/status", undefined, { token: disposable.token }),
                        401,
                        "UNAUTHORIZED"
                    );
                    assert.ok(!fs.readFileSync(h.system.managementKeyStore.filePath, "utf8").includes(admin.token));
                }
            );
            await t.test(
                "W2-02 real mount reserves malformed/unknown management and legacy paths before model fallback",
                async () => {
                    const before = h.counters();
                    for (const [method, endpoint, status, code] of [
                        ["GET", "/api/manage/v1/unknown", 404, "NOT_FOUND"],
                        ["POST", "/api/manage/v1/system/status", 405, "METHOD_NOT_ALLOWED"],
                        ["GET", "/api/manage/v9/system/status", 404, "NOT_FOUND"],
                        ["GET", "/api/%6danage/v1/accounts", 400, "INVALID_REQUEST"],
                        ["GET", "/api/manage%2Fv1/accounts", 400, "INVALID_REQUEST"],
                        ["GET", "/api//manage/v1/accounts", 400, "INVALID_REQUEST"],
                        ["GET", "/api/manage/v1/../v1/accounts", 400, "INVALID_REQUEST"],
                        ["GET", "/api/management-keys/a/b", 404, "NOT_FOUND"],
                        ["GET", "/api%2fmanage/v1/%zz", 400, "INVALID_REQUEST"],
                        ["GET", "/api%2fmanage/../../escape-model", 400, "INVALID_REQUEST"],
                        ["GET", "/api%2fmanagement-keys/%zz", 400, "INVALID_REQUEST"],
                    ])
                        error(
                            await h.request(method, endpoint, method === "POST" ? {} : undefined, {
                                cookie,
                                token: admin.token,
                            }),
                            status,
                            code
                        );
                    for (const endpoint of [
                        "/api/accounts/nope/typo",
                        "/api/settings/nope",
                        "/api/auth/nope",
                        "/api/files/nope/typo",
                        "/api/status/nope",
                        "/api/usage-stats/nope",
                        "/login/nope",
                        "/logout/nope",
                    ]) {
                        assert.equal(
                            (await h.request("PATCH", endpoint, {}, { token: "model_fixture_key" })).status,
                            404
                        );
                    }
                    error(
                        await call("POST", "/accounts/import", '{"secret":"fixture malformed"', { raw: true }),
                        400,
                        "INVALID_REQUEST"
                    );
                    const response = await call("GET", "/system/status", undefined, {
                        headers: { "X-Request-Id": "forged-id" },
                    });
                    assert.notEqual(response.body.requestId, "forged-id");
                    assert.equal(response.headers["cache-control"], "no-store");
                    assert.deepEqual(h.counters(), before);
                }
            );
            await t.test(
                "W2-03 two real task imports traverse real verifier/browser adapter/client script over loopback",
                async () => {
                    assert.equal((await call("GET", "/system/readiness")).body.data.ready, false);
                    const body = {
                        items: h.accounts.map((credentials, index) => ({ clientRef: `fixture-${index}`, credentials })),
                    };
                    const response = await call("POST", "/accounts/import", body, {
                        headers: { "Idempotency-Key": "two-accounts" },
                    });
                    assert.equal(response.status, 202);
                    imported = await h.poll(response.body.data.taskId, admin.token);
                    assert.equal(imported.status, "succeeded", JSON.stringify(imported));
                    assert.equal(imported.createdByKeyId, admin.key.id);
                    assert.equal(imported.counts.succeeded, 2);
                    assert.deepEqual(
                        imported.items.map(item => item.clientRef),
                        ["fixture-0", "fixture-1"]
                    );
                    assert.equal(new Set(imported.items.map(item => item.accountId)).size, 2);
                    assert.equal(new Set(imported.items.map(item => item.result.requestId)).size, 2);
                    for (const item of imported.items) {
                        assert.equal(item.result.authIndex, item.index);
                        assert.equal(item.result.stage, "model_verified");
                        assert.equal(item.result.upstreamStatus, 200);
                        assert.equal((await account(item.accountId)).enabled, true);
                    }
                    [alpha, beta] = imported.items;
                    assert.deepEqual(
                        h.fetches.map(row => row.email),
                        h.accounts.map(row => row.accountName)
                    );
                    assert.ok(h.pages.every(page => page.closed && page.entryUrl === h.system.config.aiStudioAppUrl));
                    assert.equal(h.system.browserManager.currentAuthIndex, -1);
                    assert.equal(h.system.browserManager.contexts.size, 0);
                    assert.equal(h.system.connectionRegistry.getAllConnections().size, 0);
                    for (const entry of h.fetches)
                        assert.equal(JSON.parse(entry.config.body).generationConfig.maxOutputTokens, 64);
                    // Readiness needs an actual ready production connection, not just verified credentials.
                    h.system.browserManager.browser = { isConnected: () => true };
                    assert.equal((await call("GET", "/system/readiness")).body.data.ready, false);
                    const original = h.system.connectionRegistry.getConnectionByAuth;
                    h.system.connectionRegistry.getConnectionByAuth = index =>
                        index === alpha.index ? { readyState: 1 } : null;
                    assert.equal((await call("GET", "/system/readiness")).body.data.ready, true);
                    const release = h.system.managementRuntime.blockAccount(alpha.index);
                    assert.equal((await call("GET", "/system/readiness")).body.data.ready, false);
                    release();
                    h.system.connectionRegistry.getConnectionByAuth = original;
                    h.system.browserManager.browser = null;
                }
            );
            await t.test(
                "W2-04 failed beta stays attributed to beta; connection/model tests do not enable or alter flags",
                async () => {
                    await call("PATCH", `/accounts/${beta.accountId}`, { enabled: false });
                    const before = await account(beta.accountId);
                    h.behaviors.set(h.accounts[1].accountName, 401);
                    const failures = await h.poll(await submit(`/accounts/${beta.accountId}/test`), admin.token);
                    assert.equal(failures.status, "failed");
                    assert.equal(failures.items[0].result.authIndex, beta.index);
                    assert.equal(failures.items[0].result.upstreamStatus, 401);
                    assert.equal(h.fetches.at(-1).email, h.accounts[1].accountName);
                    assert.deepEqual(await account(beta.accountId), before);
                    h.behaviors.delete(h.accounts[1].accountName);
                    for (const mode of ["connection", "model"]) {
                        const tested = await h.poll(
                            await submit(`/accounts/${beta.accountId}/test`, { mode }),
                            admin.token
                        );
                        assert.equal(tested.status, "succeeded");
                        assert.equal(tested.result.changed, false);
                        assert.deepEqual(await account(beta.accountId), before);
                    }
                    const failedImport = await h.poll(
                        await submit("/accounts/import", {
                            items: [
                                {
                                    clientRef: "failed-candidate",
                                    credentials: { ...h.accounts[0], accountName: "failed-target@example.invalid" },
                                },
                            ],
                        }),
                        admin.token
                    );
                    assert.equal(failedImport.status, "failed");
                    const pending = await account(failedImport.items[0].accountId);
                    assert.equal(pending.enabled, false);
                    assert.equal(pending.disabledReason, "pending_verification");
                    assert.equal(failedImport.items[0].result.stage, "identity_mismatch");
                    // Explicit human enable is permitted but is not verification evidence.
                    assert.equal(
                        (await call("PATCH", `/accounts/${pending.accountId}`, { enabled: true })).body.data.enabled,
                        true
                    );
                    await call("PATCH", `/accounts/${pending.accountId}`, { enabled: false });
                    supportingSuite("managementVerifier");
                }
            );
            await t.test(
                "W2-05 canonical replay, conflicting content, key isolation, persistence/restart/retention",
                async () => {
                    const body = {
                        items: h.accounts.map((credentials, index) => ({ clientRef: `fixture-${index}`, credentials })),
                    };
                    const before = h.system.managementTaskService.state.tasks.length;
                    const response = await call("POST", "/accounts/import", body, {
                        headers: { "Idempotency-Key": "two-accounts" },
                    });
                    assert.equal(response.body.data.taskId, imported.taskId);
                    assert.equal(h.system.managementTaskService.state.tasks.length, before);
                    error(
                        await call(
                            "POST",
                            "/accounts/import",
                            { ...body, model: "other" },
                            { headers: { "Idempotency-Key": "two-accounts" } }
                        ),
                        409,
                        "IDEMPOTENCY_CONFLICT"
                    );
                    const second = await mint(KeyStore.TEMPLATES.operator);
                    const separate = await call("POST", "/accounts/import", body, {
                        headers: { "Idempotency-Key": "two-accounts" },
                        token: second.token,
                    });
                    assert.equal(separate.status, 202);
                    assert.notEqual(separate.body.data.taskId, imported.taskId);
                    const duplicate = await h.poll(separate.body.data.taskId, admin.token);
                    assert.equal(duplicate.status, "failed");
                    assert.equal(duplicate.error.code, "DUPLICATE_ACCOUNT");
                    supportingSuite("managementTasks");
                }
            );
            await t.test(
                "W2-06 replacement preserves flags, archive/restore identity, manual action wins verification race",
                async () => {
                    const original = await account(beta.accountId);
                    const replaced = await h.poll(
                        await submit(`/accounts/${beta.accountId}/credentials`, h.accounts[1], "PUT"),
                        admin.token
                    );
                    assert.equal(replaced.status, "succeeded");
                    const replacement = await account(beta.accountId);
                    assert.equal(replacement.enabled, false);
                    assert.equal(replacement.disabledReason, original.disabledReason);
                    assert.ok(replacement.credentialVersion > original.credentialVersion);
                    const archived = await h.poll(await submit(`/accounts/${beta.accountId}/archive`), admin.token);
                    assert.equal(archived.status, "succeeded");
                    const restored = await h.poll(await submit(`/accounts/${beta.accountId}/restore`), admin.token);
                    assert.equal(restored.status, "succeeded");
                    assert.equal((await account(beta.accountId)).index, beta.index);
                    assert.equal((await account(beta.accountId)).disabledReason, "manual");
                    let changed = false;
                    h.setFetchHook(async entry => {
                        if (entry.index === alpha.index && !changed) {
                            changed = true;
                            assert.equal(
                                (await call("PATCH", `/accounts/${alpha.accountId}`, { enabled: false })).status,
                                200
                            );
                        }
                    });
                    const race = await h.poll(
                        await submit(`/accounts/${alpha.accountId}/credentials`, h.accounts[0], "PUT"),
                        admin.token
                    );
                    h.setFetchHook(undefined);
                    assert.equal(race.status, "failed");
                    assert.equal(race.items[0].error.code, "VERSION_CONFLICT");
                    assert.equal((await account(alpha.accountId)).enabled, false);
                    supportingSuite("credentialStore");
                }
            );
            await t.test(
                "W2-07 cooperative cancellation/revocation, persisted commits, account drain and explicit force",
                async () => {
                    const index = alpha.index;
                    await call("PATCH", `/accounts/${alpha.accountId}`, { enabled: true });
                    h.system.requestHandler._getAccountRouteState(index).inFlight = 1;
                    const before = h.productionCalls.filter(row => row[0] === "close").length;
                    error(await call("PATCH", `/accounts/${alpha.accountId}`, { enabled: false }), 409, "ACCOUNT_BUSY");
                    assert.equal(h.productionCalls.filter(row => row[0] === "close").length, before);
                    assert.equal((await account(alpha.accountId)).enabled, false);
                    assert.equal(
                        (await call("PATCH", `/accounts/${alpha.accountId}`, { enabled: false, force: true })).status,
                        200
                    );
                    assert.equal(h.productionCalls.filter(row => row[0] === "close").length, before + 1);
                    h.system.requestHandler._getAccountRouteState(index).inFlight = 0;
                    supportingSuite("managementRuntime");
                    // managementTasks above exercises real durable cancel/revoke, running
                    // attribution, committed-item preservation and restart interruption.
                }
            );
            await t.test(
                "W2-08 settings HTTP/store persistence and apply failures, shared writer, audit-after-commit",
                async () => {
                    const snapshot = (await call("GET", "/settings")).body.data;
                    assert.equal(snapshot.values.enableUsageStats, undefined);
                    error(await call("PATCH", "/settings", { enableUsageStats: false }), 400, "INVALID_REQUEST");
                    const transient = await call("PATCH", "/settings", { debugMode: true, logMaxCount: 25 });
                    assert.equal(transient.body.data.persisted, false);
                    assert.equal(transient.body.data.values.logMaxCount, 25);
                    const previous = h.system.config.maxRetries;
                    const rename = fs.promises.rename;
                    fs.promises.rename = async () => {
                        throw Object.assign(Error("fixture disk secret"), { code: "EIO" });
                    };
                    try {
                        error(await call("PATCH", "/settings", { maxRetries: 4 }), 500, "PERSISTENCE_ERROR");
                        assert.equal(h.system.config.maxRetries, previous);
                    } finally {
                        fs.promises.rename = rename;
                    }
                    const hook = h.system.runtimeSettingsStore.onApplied;
                    h.system.runtimeSettingsStore.onApplied = async () => {
                        throw Error("fixture hook secret");
                    };
                    const applied = await call("PATCH", "/settings", { maxRetries: 4 });
                    h.system.runtimeSettingsStore.onApplied = hook;
                    assert.equal(applied.status, 200);
                    assert.equal(applied.body.data.persisted, true);
                    assert.equal(applied.body.data.applied, false);
                    assert.equal(applied.body.data.applicationError.code, "SETTINGS_APPLICATION_FAILED");
                    const audit = h.system.managementTaskService.audit;
                    h.system.managementTaskService.audit = () => {
                        throw Error("fixture audit secret");
                    };
                    try {
                        const failedAudit = await call("PATCH", "/settings", { maxRetries: 5 });
                        error(failedAudit, 500, "AUDIT_PERSISTENCE_FAILED");
                        assert.match(failedAudit.body.error.message, /committed.*Read current state/);
                        assert.equal(h.system.config.maxRetries, 5);
                    } finally {
                        h.system.managementTaskService.audit = audit;
                    }
                    supportingSuite("runtimeSettingsStore");
                }
            );
            await t.test(
                "W2-09 admission limits have no side effects; pagination/export and public redaction",
                async () => {
                    const beforeTasks = JSON.stringify(h.system.managementTaskService.state);
                    const beforeAccounts = JSON.stringify(h.system.authSource.store.listMetadata());
                    const good = { clientRef: "valid", credentials: h.accounts[0] };
                    const bodies = [
                        { items: [{ ...good, clientRef: "" }] },
                        { items: [{ ...good, clientRef: " " }] },
                        { items: [{ ...good, clientRef: "x".repeat(129) }] },
                        { items: [good, good] },
                        ...["", "-model", "model/path", "m".repeat(129), 123, null].map(model => ({
                            items: [good],
                            model,
                        })),
                    ];
                    for (const body of bodies)
                        error(
                            await call("POST", "/accounts/import", body, {
                                headers: { "Idempotency-Key": "invalid-admission" },
                            }),
                            400,
                            "INVALID_REQUEST"
                        );
                    for (const model of ["", "-model", "model/path", "m".repeat(129), 123, null])
                        error(
                            await call(
                                "POST",
                                `/accounts/${alpha.accountId}/test`,
                                { model },
                                { headers: { "Idempotency-Key": "invalid-test" } }
                            ),
                            400,
                            "INVALID_REQUEST"
                        );
                    assert.equal(JSON.stringify(h.system.managementTaskService.state), beforeTasks);
                    assert.equal(JSON.stringify(h.system.authSource.store.listMetadata()), beforeAccounts);
                    for (const body of [
                        { items: Array.from({ length: 101 }, (_, i) => ({ ...good, clientRef: String(i) })) },
                        { items: [{ ...good, credentials: { ...h.accounts[0], accountName: "x".repeat(1048576) } }] },
                        { padding: "x".repeat(10 * 1024 * 1024) },
                    ])
                        error(
                            await call("POST", "/accounts/import", body, {
                                headers: { "Idempotency-Key": "oversize" },
                            }),
                            413,
                            "PAYLOAD_TOO_LARGE"
                        );
                    assert.equal(JSON.stringify(h.system.managementTaskService.state), beforeTasks);
                    assert.equal(JSON.stringify(h.system.authSource.store.listMetadata()), beforeAccounts);
                    for (const endpoint of ["/accounts", "/tasks", "/usage", "/audit"]) {
                        assert.equal((await call("GET", endpoint)).body.data.limit, 50);
                        error(await call("GET", `${endpoint}?limit=201`), 400, "INVALID_REQUEST");
                        const result = await call("GET", `${endpoint}?limit=200`);
                        assert.equal(result.status, 200);
                        for (const fixture of h.accounts) assert.ok(!result.text.includes(fixture.cookies[0].value));
                        assert.ok(!result.text.includes(admin.token));
                        assert.ok(!result.text.includes("credentialState"));
                    }
                    const exported = await call("POST", "/accounts/export", {
                        accountIds: [alpha.accountId, beta.accountId],
                    });
                    assert.equal(exported.status, 200);
                    assert.equal(exported.body.data.items.length, 2);
                    assert.equal(
                        exported.body.data.items[0].credentials.cookies[0].value,
                        h.accounts[0].cookies[0].value
                    );
                    assert.ok(!h.logs.join("\n").includes(admin.token));
                    for (const fixture of h.accounts) assert.ok(!h.logs.join("\n").includes(fixture.cookies[0].value));
                    supportingSuite("managementRoutes");
                    supportingSuite("managementKeys");
                }
            );
        } finally {
            await h.close();
        }
    });
}

module.exports = { gateIds, registerLocalAcceptance };
