const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const CredentialStore = require("../../src/storage/CredentialStore");
const RuntimeSettingsStore = require("../../src/storage/RuntimeSettingsStore");
const ManagementTaskService = require("../../src/management/ManagementTaskService");
const ManagementAccountService = require("../../src/management/ManagementAccountService");
const { failure } = require("../../src/management/ManagementSupport");

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
const verified = input => ({
    authIndex: input.index,
    credentialState: { cookies: [{ value: "DO-NOT-LEAK" }] },
    model: input.model,
    requestId: `verify-${input.index}`,
    stage: input.mode === "connection" ? "connection_ready" : "model_verified",
    success: true,
    upstreamStatus: 200,
});
const deferred = () => {
    let resolve;
    const promise = new Promise(r => {
        resolve = r;
    });
    return { promise, resolve };
};
async function done(tasks, id) {
    const deadline = Date.now() + 3000;
    while (["queued", "running"].includes(tasks.get(id).status)) {
        if (Date.now() > deadline) throw new Error("Task did not finish");
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    return tasks.get(id);
}
function fixture(t, verify = async input => verified(input)) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "management-tasks-"));
    const keys = new EventEmitter();
    const active = new Set(["key-a", "key-b"]);
    keys.isActive = id => active.has(id);
    const store = new CredentialStore({ rootDir });
    const calls = { balance: 0, close: [], holds: new Set(), reload: 0 };
    const system = {
        authSource: {
            reloadAuthSources() {
                calls.reload++;
            },
            store,
        },
        managementDrainTimeoutMs: 5,
        managementRuntime: {
            blockAccount(index) {
                calls.holds.add(index);
                return () => calls.holds.delete(index);
            },
            async closeAccount(index, options) {
                assert(calls.holds.has(index));
                calls.close.push({ index, ...options });
            },
            hasActiveRequests() {
                return false;
            },
            async rebalance() {
                calls.balance++;
            },
        },
        runtimeSettingsStore: new RuntimeSettingsStore({
            config: { maxRetries: 3 },
            filePath: path.join(rootDir, "settings.json"),
        }),
    };
    const tasks = new ManagementTaskService({ keyStore: keys, rootDir });
    const accounts = new ManagementAccountService(system, { keyStore: keys, taskService: tasks, verifier: { verify } });
    t.after(async () => {
        await tasks.close();
        fs.rmSync(rootDir, { force: true, recursive: true });
    });
    const submit = (kind, body, id, key = Math.random().toString(), keyId = "key-a") =>
        accounts.submit(kind, body, id, {
            idempotencyKey: key,
            keyId,
            method: "POST",
            path: `/accounts/${id || kind}`,
            requestId: "req-fixture",
        });
    return { accounts, active, calls, keys, rootDir, store, submit, system, tasks };
}

test("two isolated fixture imports enable only after matching model verification and keep public files secret-free", async t => {
    const inputs = [];
    const f = fixture(t, async input => {
        inputs.push(input);
        assert.equal(f.store.getMetadata(input.index).disabledReason, "pending_verification");
        return verified(input);
    });
    const body = { items: ["alpha", "beta"].map(name => ({ clientRef: name, credentials: credentials(name) })) };
    const accepted = f.submit("import", body, undefined, "same");
    const privateFiles = fs.readdirSync(path.join(f.rootDir, "data/management/task-inputs"));
    assert.equal(privateFiles.length, 1);
    assert(
        fs
            .readFileSync(path.join(f.rootDir, "data/management/task-inputs", privateFiles[0]), "utf8")
            .includes("SECRET-alpha")
    );
    assert.deepEqual(f.submit("import", { items: body.items }, undefined, "same"), accepted);
    f.tasks.start();
    const task = await done(f.tasks, accepted.taskId);
    assert.equal(task.status, "succeeded");
    assert.equal(task.counts.succeeded, 2);
    assert.deepEqual(
        task.items.map(i => i.clientRef),
        ["alpha", "beta"]
    );
    assert.deepEqual(
        inputs.map(i => i.index),
        [0, 1]
    );
    assert(f.accounts.list().items.every(a => a.enabled));
    const publicText =
        JSON.stringify([task, f.tasks.listAudit(), f.accounts.list()]) +
        fs.readFileSync(path.join(f.rootDir, "data/management/tasks.json"));
    assert(!/SECRET|DO-NOT-LEAK|credentialState|"cookies"/.test(publicText));
    assert.equal(fs.readdirSync(path.join(f.rootDir, "data/management/task-inputs")).length, 0);
    assert.equal(
        f.accounts.export({ accountIds: task.result.accountIds }).items[0].credentials.cookies[0].value,
        "SECRET-alpha"
    );
});

test("whole import structure is rejected before admission; duplicate email never replaces", async t => {
    const f = fixture(t);
    assert.throws(
        () =>
            f.submit("import", {
                items: [
                    { clientRef: "ok", credentials: credentials("alpha") },
                    { clientRef: "bad", credentials: { ...credentials("beta"), disabled: false } },
                ],
            }),
        { code: "INVALID_CREDENTIALS" }
    );
    assert.equal(f.store.listMetadata().length, 0);
    assert.equal(f.tasks.list().total, 0);
    await f.store.create(credentials("alpha"));
    const accepted = f.submit("import", { items: [{ clientRef: "dup", credentials: credentials("ALPHA") }] });
    f.tasks.start();
    const task = await done(f.tasks, accepted.taskId);
    assert.equal(task.error.code, "DUPLICATE_ACCOUNT");
    assert.equal(f.store.listMetadata().length, 1);
});

test("target failure and mismatched attribution never fall back or autoenable", async t => {
    for (const mode of ["fail", "index", "model", "stage", "requestId"]) {
        const f = fixture(t, async input => {
            if (input.index === 0) return verified(input);
            if (mode === "fail") throw Object.assign(new Error("cookie SECRET-beta"), { code: "VERIFICATION_FAILED" });
            return {
                ...verified(input),
                ...(mode === "index"
                    ? { authIndex: 0 }
                    : mode === "model"
                      ? { model: "wrong" }
                      : mode === "stage"
                        ? { stage: "connection_ready" }
                        : { requestId: "" }),
            };
        });
        const accepted = f.submit("import", {
            items: ["alpha", "beta"].map(clientRef => ({ clientRef, credentials: credentials(clientRef) })),
        });
        f.tasks.start();
        const task = await done(f.tasks, accepted.taskId);
        assert.equal(task.status, "partial");
        assert.equal(task.items[1].error.code, "VERIFICATION_FAILED");
        assert.equal(f.accounts.list().items[1].enabled, false);
        assert(!JSON.stringify(task).includes("SECRET"));
    }
});

test("manual disable and credential replacement win the double-version CAS", async t => {
    for (const mutation of ["state", "credentials"]) {
        const entered = deferred(),
            release = deferred();
        const f = fixture(t, async input => {
            entered.resolve();
            await release.promise;
            return verified(input);
        });
        const accepted = f.submit("import", { items: [{ clientRef: "alpha", credentials: credentials("alpha") }] });
        f.tasks.start();
        await entered.promise;
        if (mutation === "state") await f.store.updateState(0, { disabled: true, disabledReason: "manual" });
        else await f.store.replace(0, credentials("new"));
        release.resolve();
        const task = await done(f.tasks, accepted.taskId);
        assert.equal(task.items[0].error.code, "VERSION_CONFLICT");
        assert.equal(f.store.getMetadata(0).disabled, true);
    }
});

test("candidate replacement failure preserves original enabled credentials; success has CAS and drain", async t => {
    let fail = true;
    const f = fixture(t, async input => {
        if (fail) throw failure("VERIFICATION_FAILED");
        return verified(input);
    });
    const row = await f.store.create(credentials("alpha"));
    const first = f.submit("replace", credentials("alpha-new"), row.accountId);
    f.tasks.start();
    assert.equal((await done(f.tasks, first.taskId)).status, "failed");
    assert.equal(f.store.read(row.index).cookies[0].value, "SECRET-alpha");
    assert.equal(f.accounts.get(row.accountId).enabled, true);
    assert.equal(f.calls.close.length, 0);
    fail = false;
    const second = f.submit("replace", credentials("alpha-new"), row.accountId);
    assert.equal((await done(f.tasks, second.taskId)).status, "succeeded");
    assert.equal(f.store.read(row.index).cookies[0].value, "SECRET-alpha-new");
    assert.equal(f.accounts.get(row.accountId).enabled, true);
    assert.equal(f.calls.holds.size, 0);
    assert.equal(f.calls.close.length, 1);
});

test("connection test is read-only; explicit manual enable is distinct from model verification", async t => {
    const f = fixture(t);
    const row = await f.store.create(credentials("alpha"), { disabled: true });
    const accepted = f.submit("test", { mode: "connection" }, row.accountId);
    f.tasks.start();
    assert.equal((await done(f.tasks, accepted.taskId)).status, "succeeded");
    assert.deepEqual(f.store.getMetadata(0), rowWithoutChanged(row));
    await f.accounts.patch(row.accountId, { enabled: true }, { keyId: "key-a" });
    assert.equal(f.accounts.get(row.accountId).enabled, true);
});
function rowWithoutChanged(row) {
    const { changed, ...rest } = row;
    return rest;
}

test("durable canonical idempotency includes endpoint and key identity", async t => {
    const f = fixture(t);
    const body = { items: [{ clientRef: "alpha", credentials: credentials("alpha") }] };
    const accepted = f.submit("import", body, undefined, "idem");
    assert.deepEqual(f.submit("import", body, undefined, "idem"), accepted);
    assert.throws(() => f.submit("import", { ...body, model: "different" }, undefined, "idem"), {
        code: "IDEMPOTENCY_CONFLICT",
    });
    assert.notEqual(f.submit("import", body, undefined, "idem", "key-b").taskId, accepted.taskId);
    const restart = new ManagementTaskService({ keyStore: f.keys, rootDir: f.rootDir });
    restart.register("import", async () => {});
    assert.deepEqual(
        restart.submit({
            idempotencyKey: "idem",
            items: [{}],
            keyId: "key-a",
            kind: "import",
            method: "POST",
            path: "/accounts/import",
            payload: f.accounts.validate("import", body),
            requestId: "restart",
        }),
        accepted
    );
    assert.throws(
        () =>
            restart.submit({
                idempotencyKey: "idem",
                items: [{}],
                keyId: "key-a",
                kind: "import",
                method: "POST",
                path: "/accounts/other",
                payload: f.accounts.validate("import", body),
                requestId: "restart",
            }),
        { code: "IDEMPOTENCY_CONFLICT" }
    );
    await restart.close();
});

test("cancel, revoke and expiry stop uncommitted writes while preserving committed items", async t => {
    for (const stop of ["cancel", "revoke", "expire"]) {
        const entered = deferred(),
            release = deferred();
        const f = fixture(t, async input => {
            if (input.index === 1) {
                entered.resolve();
                await release.promise;
            }
            return verified(input);
        });
        const accepted = f.submit("import", {
            items: ["alpha", "beta"].map(clientRef => ({ clientRef, credentials: credentials(clientRef) })),
        });
        const queued = f.submit("import", { items: [{ clientRef: "gamma", credentials: credentials("gamma") }] });
        f.tasks.start();
        await entered.promise;
        if (stop === "cancel") {
            f.tasks.cancel(accepted.taskId);
            f.tasks.cancel(queued.taskId);
        } else {
            f.active.delete("key-a");
            if (stop === "revoke") f.keys.emit("revoked", "key-a");
        }
        release.resolve();
        const task = await done(f.tasks, accepted.taskId);
        assert.equal(task.status, "partial");
        assert.equal(task.items[0].status, "succeeded");
        assert.equal(task.items[1].status, "cancelled");
        assert.equal((await done(f.tasks, queued.taskId)).status, "cancelled");
        assert.equal(f.store.listMetadata().length, 2);
        assert.equal(f.accounts.list().items[0].enabled, true);
        assert.equal(f.accounts.list().items[1].enabled, false);
    }
});

test("startup resumes queued only, interrupts running, prunes 30-day records and private orphans", async t => {
    const f = fixture(t);
    const a = f.submit("import", { items: [{ clientRef: "alpha", credentials: credentials("alpha") }] });
    const b = f.submit("import", { items: [{ clientRef: "beta", credentials: credentials("beta") }] });
    const file = path.join(f.rootDir, "data/management/tasks.json");
    const state = JSON.parse(fs.readFileSync(file));
    state.tasks[1].status = "running";
    state.tasks[1].items[0].status = "running";
    fs.writeFileSync(file, JSON.stringify(state));
    const restart = new ManagementTaskService({ keyStore: f.keys, rootDir: f.rootDir });
    new ManagementAccountService(f.system, {
        keyStore: f.keys,
        taskService: restart,
        verifier: { verify: async input => verified(input) },
    });
    assert.equal(restart.get(b.taskId).status, "interrupted");
    restart.start();
    assert.equal((await done(restart, a.taskId)).status, "succeeded");
    assert.equal(f.store.listMetadata().length, 1);
    const expired = restart.state.tasks.find(x => x.taskId === a.taskId);
    expired.finishedAt = expired.updatedAt = "2000-01-01T00:00:00.000Z";
    restart.prune();
    assert.throws(() => restart.get(a.taskId), { code: "NOT_FOUND" });
    await restart.close();
});

test("drain timeout never closes an active connection; force is explicit; archive/restore stable identity", async t => {
    const f = fixture(t);
    const row = await f.store.create(credentials("alpha"));
    f.system.managementRuntime.hasActiveRequests = () => true;
    await assert.rejects(f.accounts.patch(row.accountId, { enabled: false }, { keyId: "key-a" }), {
        code: "ACCOUNT_BUSY",
    });
    assert.equal(f.calls.close.length, 0);
    assert.equal(f.accounts.get(row.accountId).enabled, false);
    await f.accounts.patch(row.accountId, { enabled: false, force: true }, { keyId: "key-a" });
    assert.equal(f.calls.close[0].force, true);
    const archive = f.submit("archive", { force: true }, row.accountId);
    f.tasks.start();
    assert.equal((await done(f.tasks, archive.taskId)).status, "succeeded");
    const restore = f.submit("restore", {}, row.accountId);
    assert.equal((await done(f.tasks, restore.taskId)).status, "succeeded");
    assert.equal(f.accounts.get(row.accountId).index, row.index);
    assert.equal(f.accounts.get(row.accountId).enabled, false);
});

test("failed import can be replaced and manually enabled; manual disable wins replacement verification", async t => {
    let fail = true;
    let hold = false;
    const entered = deferred(),
        release = deferred();
    const f = fixture(t, async input => {
        if (fail) throw failure("VERIFICATION_FAILED");
        if (hold) {
            entered.resolve();
            await release.promise;
        }
        return verified(input);
    });
    const imported = f.submit("import", { items: [{ clientRef: "alpha", credentials: credentials("alpha") }] });
    f.tasks.start();
    assert.equal((await done(f.tasks, imported.taskId)).status, "failed");
    const row = f.store.getMetadata(0);
    assert.equal(f.tasks.get(imported.taskId).result.changed, true);
    fail = false;
    const replaced = f.submit("replace", credentials("alpha"), row.accountId);
    assert.equal((await done(f.tasks, replaced.taskId)).status, "succeeded");
    assert.equal(f.accounts.get(row.accountId).enabled, false);
    await f.accounts.patch(row.accountId, { enabled: true }, { keyId: "key-a" });
    assert.equal(f.accounts.get(row.accountId).enabled, true);
    hold = true;
    const racing = f.submit("replace", credentials("new-alpha"), row.accountId);
    await entered.promise;
    await f.accounts.patch(row.accountId, { enabled: false }, { keyId: "key-a" });
    release.resolve();
    const task = await done(f.tasks, racing.taskId);
    assert.equal(task.items[0].error.code, "VERSION_CONFLICT");
    assert.equal(f.store.read(0).accountName, "alpha@example.invalid");
    assert.equal(f.accounts.get(row.accountId).enabled, false);
});

test("shutdown interrupts active verification without replay and preserves queued inputs", async t => {
    const entered = deferred();
    const f = fixture(
        t,
        input =>
            new Promise((resolve, reject) => {
                entered.resolve();
                input.signal.addEventListener("abort", () => reject(failure("CANCELLED")), { once: true });
            })
    );
    const running = f.submit("import", { items: [{ clientRef: "alpha", credentials: credentials("alpha") }] });
    const queued = f.submit("import", { items: [{ clientRef: "beta", credentials: credentials("beta") }] });
    f.tasks.start();
    await entered.promise;
    await f.tasks.close();
    assert.equal(f.tasks.get(running.taskId).status, "interrupted");
    assert.equal(f.tasks.get(queued.taskId).status, "queued");
    assert.equal(f.store.getMetadata(0).disabled, true);
    assert.deepEqual(fs.readdirSync(path.join(f.rootDir, "data/management/task-inputs")), [`${queued.taskId}.json`]);
});

test("queue capacity rejects new admissions but preserves idempotent replay", async t => {
    const f = fixture(t);
    const body = { items: [{ clientRef: "alpha", credentials: credentials("alpha") }] };
    const accepted = f.submit("import", body, undefined, "original");
    const first = f.tasks.state.tasks[0];
    const previous = f.tasks.state.tasks;
    f.tasks.state.tasks = Array.from({ length: 1000 }, () => first);
    assert.throws(() => f.submit("import", body, undefined, "new"), { code: "RATE_LIMITED" });
    assert.deepEqual(f.submit("import", body, undefined, "original"), accepted);
    f.tasks.state.tasks = previous;
});

test("invalid or duplicate client references and invalid model names fail before task or credential writes", t => {
    const f = fixture(t);
    const valid = { clientRef: "alpha", credentials: credentials("alpha") };
    const tasksFile = path.join(f.rootDir, "data/management/tasks.json");
    const before = fs.readFileSync(tasksFile, "utf8");
    for (const clientRef of ["", "x".repeat(129), 123]) {
        assert.throws(() => f.submit("import", { items: [{ ...valid, clientRef }] }), { code: "INVALID_REQUEST" });
    }
    assert.throws(() => f.submit("import", { items: [valid, { ...valid, credentials: credentials("beta") }] }), {
        code: "INVALID_REQUEST",
    });
    for (const model of ["", "contains space", "path/model", "_prefix", "x".repeat(129), 123]) {
        assert.throws(() => f.submit("import", { items: [valid], model }), { code: "INVALID_REQUEST" });
        assert.throws(() => f.submit("test", { model }, "fixture-id"), { code: "INVALID_REQUEST" });
    }
    assert.equal(fs.readFileSync(tasksFile, "utf8"), before);
    assert.equal(fs.readdirSync(path.join(f.rootDir, "data/management/task-inputs")).length, 0);
    assert.equal(f.store.listMetadata().length, 0);
    assert.equal(f.tasks.list().total, 0);
});

// Explicit integration mode uses the real T6 verifier with loopback transport and a synthetic page adapter.
// In an integrated checkout: node scripts/tests/managementTasks.test.js --verifier-integration
// During independent worktree development an optional following module path is read-only.
const verifierIntegration = process.argv.indexOf("--verifier-integration");
if (verifierIntegration >= 0 || fs.existsSync(path.join(__dirname, "../../src/management/ManagementVerifier.js"))) {
    const Verifier = require(
        (verifierIntegration >= 0 && process.argv[verifierIntegration + 1]) || "../../src/management/ManagementVerifier"
    );
    const { WebSocket } = require("ws");
    const { once } = require("events");
    test("real task/account/verifier orchestration verifies two fixtures and never falls back for a failed target", async t => {
        const net = require("net");
        const tls = require("tls");
        const originalConnect = net.Socket.prototype.connect;
        const originalTLS = tls.connect;
        net.Socket.prototype.connect = function (...args) {
            const options = Array.isArray(args[0]) ? args[0][0] : args[0];
            assert.equal(options.host, "127.0.0.1");
            return originalConnect.apply(this, args);
        };
        tls.connect = () => {
            throw new Error("Only loopback fixture connections are allowed");
        };
        t.after(() => {
            net.Socket.prototype.connect = originalConnect;
            tls.connect = originalTLS;
        });
        for (const rejectBeta of [false, true]) {
            const records = [];
            const f = fixture(t, input => verifier.verify(input));
            f.system.browserManager = { contexts: new Map([[77, "production sentinel"]]), currentAuthIndex: 77 };
            f.system.connectionRegistry = new Map([[77, "production sentinel"]]);
            f.system.managementVerifierOptions = {
                adapterFactory: () => {
                    const record = { closed: false };
                    records.push(record);
                    return {
                        async close() {
                            record.socket?.terminate();
                            record.closed = true;
                        },
                        async inspect() {
                            return {
                                identity: {
                                    email: record.args.credentials.accountName,
                                    origin: "https://aistudio.google.com",
                                    source: "aistudio_session",
                                },
                            };
                        },
                        async start(args) {
                            record.args = args;
                            record.socket = new WebSocket(args.endpoint);
                            record.socket.on("error", () => {});
                            record.socket.on("message", raw => {
                                const request = JSON.parse(raw);
                                if (request.event_type !== "proxy_request") return;
                                const base = {
                                    request_attempt_id: request.request_attempt_id,
                                    request_id: request.request_id,
                                };
                                if (rejectBeta && args.credentials.accountName.startsWith("beta")) {
                                    record.socket.send(
                                        JSON.stringify({
                                            ...base,
                                            event_type: "error",
                                            message: "SECRET-beta failure",
                                            status: 403,
                                        })
                                    );
                                    return;
                                }
                                record.socket.send(
                                    JSON.stringify({ ...base, event_type: "response_headers", status: 200 })
                                );
                                record.socket.send(
                                    JSON.stringify({
                                        ...base,
                                        data: JSON.stringify({
                                            candidates: [
                                                {
                                                    content: { parts: [{ text: "OK" }], role: "model" },
                                                    finishReason: "STOP",
                                                },
                                            ],
                                            modelVersion: "gemini-3.8-flash",
                                        }),
                                        event_type: "chunk",
                                    })
                                );
                                record.socket.send(JSON.stringify({ ...base, event_type: "stream_close" }));
                            });
                            await once(record.socket, "open");
                        },
                    };
                },
                closeTimeoutMs: 100,
                pollMs: 2,
                timeoutMs: 1000,
            };
            const verifier = new Verifier(f.system);
            const accepted = f.submit("import", {
                items: ["alpha", "beta"].map(clientRef => ({ clientRef, credentials: credentials(clientRef) })),
            });
            f.tasks.start();
            const task = await done(f.tasks, accepted.taskId);
            assert.equal(task.status, rejectBeta ? "partial" : "succeeded");
            assert.equal(task.items[0].result.authIndex, 0);
            assert.equal(task.items[1].result.authIndex, 1);
            assert.notEqual(task.items[0].result.requestId, task.items[1].result.requestId);
            assert.equal(task.items[1].result.upstreamStatus, rejectBeta ? 403 : 200);
            assert.equal(f.accounts.list().items[1].enabled, !rejectBeta);
            assert.equal(records.length, 2);
            assert(records.every(record => record.closed));
            assert.notEqual(records[0].args.endpoint, records[1].args.endpoint);
            assert.equal(f.system.browserManager.currentAuthIndex, 77);
            assert.deepEqual([...f.system.connectionRegistry], [[77, "production sentinel"]]);
            assert(!JSON.stringify([task, f.tasks.listAudit()]).includes("SECRET"));
            await verifier.close();
        }
    });
}
