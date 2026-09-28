const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, after } = require("node:test");
const { once } = require("node:events");
const express = require("express");
const AuthSource = require("../../src/auth/AuthSource");
const CredentialTestService = require("../../src/management/CredentialTestService");
const ManagementVerifier = require("../../src/management/ManagementVerifier");
const RequestHandler = require("../../src/core/RequestHandler");
const StatusRoutes = require("../../src/routes/StatusRoutes");
const { VerificationError } = require("../../src/management/VerifierSupport");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const roots = [];
after(() => {
    for (const root of roots) {
        assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(root, { force: true, recursive: true });
    }
});
const credentials = name => ({ accountName: name, cookies: [], origins: [] });
const response = args => ({
    authIndex: args.index,
    model: args.model,
    requestId: "fixture-request",
    responseText: "OK",
    stage: "model_verified",
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
async function fixture(states = [{}], verify) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "aito-credential-test-"));
    roots.push(rootDir);
    const authSource = new AuthSource(logger, { rootDir });
    for (const [i, state] of states.entries()) {
        const row = await authSource.store.create(credentials(`account${i}@example.invalid`));
        await authSource.store.updateState(row.index, state);
    }
    authSource.reloadAuthSources();
    const indices = authSource.initialIndices;
    const calls = [];
    const system = {
        authSource,
        browserManager: { currentAuthIndex: 77, async rebalanceContextPool() {} },
        config: {},
        logger,
    };
    const verifier = {
        async close() {},
        tail: Promise.resolve(),
        async verify(args) {
            calls.push(args);
            return verify ? verify(args, system) : response(args);
        },
    };
    const service = new CredentialTestService(system, { rootDir, verifier });
    return { calls, indices, rootDir, service, system, verifier };
}
async function run(f, indices = f.indices, clientRequestId = "fixture-submit-1") {
    const accepted = f.service.start({ clientRequestId, indices });
    await f.service.runPromise;
    return { accepted, ...f.service.snapshot() };
}

test("selected accounts only, serial verification, disabled/expired/quota restored, no production switch", async () => {
    let active = 0;
    const f = await fixture(
        [{}, { disabled: true, expired: true }, { disabled: true, disabledReason: "quota_exhausted" }],
        async args => {
            assert.equal(++active, 1);
            assert.equal(args.model, "gemini-3.8-flash");
            assert.equal(args.includeResponseText, true);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
            return response(args);
        }
    );
    const state = await run(f, [f.indices[2], f.indices[1], f.indices[2]]);
    assert.deepEqual(
        f.calls.map(call => call.index),
        [f.indices[2], f.indices[1]]
    );
    assert(state.currentRun.results.every(row => row.state === "success" && row.responseText === "OK" && row.enabled));
    assert.equal(f.system.browserManager.currentAuthIndex, 77);
    for (const index of f.indices.slice(1)) {
        const metadata = f.system.authSource.store.getMetadata(index);
        assert(!metadata.disabled && !metadata.expired && !metadata.disabledReason);
    }
});

test("verification failures preserve disabled state and continue remaining accounts", async () => {
    const errors = [
        "login_required",
        "permission_denied",
        "quota_exceeded",
        "timeout",
        "empty_response",
        "cleanup_failed",
    ];
    let call = 0;
    const f = await fixture(
        Array.from({ length: 7 }, () => ({ disabled: true })),
        async args => {
            if (call < errors.length) throw new VerificationError(errors[call++]);
            return response(args);
        }
    );
    const { currentRun } = await run(f);
    assert.deepEqual(
        currentRun.results.slice(0, 6).map(row => row.errorCode),
        errors
    );
    for (const index of f.indices.slice(0, 6)) assert(f.system.authSource.store.getMetadata(index).disabled);
    assert.equal(currentRun.results[6].state, "success");
});

test("reject success without target attribution or actual nonempty model reply", async () => {
    for (const change of [
        { authIndex: 999 },
        { model: "fallback" },
        { responseText: " " },
        { upstreamStatus: 429 },
        { stage: "connection_ready" },
    ]) {
        const f = await fixture([{ disabled: true }], args => ({ ...response(args), ...change }));
        assert.equal((await run(f)).currentRun.results[0].state, "failed");
        assert(f.system.authSource.store.getMetadata(f.indices[0]).disabled);
    }
});

test("missing identity, invalid, duplicate and deleted accounts never call model", async () => {
    const f = await fixture([{}, {}, {}, {}]);
    const store = f.system.authSource.store;
    await store.replace(f.indices[0], { cookies: [], origins: [] });
    await store.replace(f.indices[1], credentials("duplicate@example.invalid"));
    await store.replace(f.indices[2], credentials("duplicate@example.invalid"));
    fs.writeFileSync(path.join(f.rootDir, "configs/auth", `auth-${f.indices[3]}.json`), "invalid json");
    const { currentRun } = await run(f, [...f.indices, 900]);
    assert.deepEqual(
        currentRun.results.map(row => row.errorCode),
        ["identity_unverifiable", "duplicate", null, "invalid", "missing"]
    );
    assert.deepEqual(
        f.calls.map(call => call.index),
        [f.indices[2]]
    );
});

test("cookie refresh on enabled account succeeds without state write; disabled account uses both versions", async () => {
    for (const disabled of [false, true]) {
        const f = await fixture([{ disabled }], async (args, system) => {
            await system.authSource.store.mergeStorageState(
                args.index,
                {
                    cookies: [
                        {
                            domain: ".example.invalid",
                            expires: -1,
                            httpOnly: true,
                            name: "refreshed",
                            path: "/",
                            sameSite: "Lax",
                            secure: true,
                            value: "private-cookie",
                        },
                    ],
                    origins: [],
                },
                {
                    expectedCredentialVersion: system.authSource.store.getMetadata(args.index).credentialVersion,
                }
            );
            return response(args);
        });
        const before = f.system.authSource.store.getMetadata(f.indices[0]);
        const row = (await run(f)).currentRun.results[0];
        assert.equal(row.state, disabled ? "failed" : "success");
        assert.equal(row.errorCode, disabled ? "version_conflict" : null);
        if (!disabled) assert.equal(row.snapshotChanged, true);
        assert.equal(f.system.authSource.store.getMetadata(f.indices[0]).stateVersion, before.stateVersion);
        assert(!fs.readFileSync(f.service.file, "utf8").includes("private-cookie"));
    }
});

test("manual disable and AutoHeal winning a state update cannot be overwritten", async () => {
    for (const disabled of [false, true]) {
        const f = await fixture([{ disabled }], async (args, system) => {
            const metadata = system.authSource.store.getMetadata(args.index);
            await system.authSource.store.updateState(
                args.index,
                { disabled: !disabled },
                {
                    expectedCredentialVersion: metadata.credentialVersion,
                    expectedStateVersion: metadata.stateVersion,
                }
            );
            return response(args);
        });
        assert.equal((await run(f)).currentRun.results[0].errorCode, "version_conflict");
        assert.equal(f.system.authSource.store.getMetadata(f.indices[0]).disabled, !disabled);
    }
});

test("console enable winning prevents stale AutoHeal update", async () => {
    const f = await fixture([{ disabled: true, disabledReason: "quota_exhausted" }]);
    const before = f.system.authSource.store.getMetadata(f.indices[0]);
    await run(f);
    await assert.rejects(
        f.system.authSource.store.updateState(
            f.indices[0],
            { disabled: true },
            {
                expectedCredentialVersion: before.credentialVersion,
                expectedStateVersion: before.stateVersion,
            }
        ),
        { code: "VERSION_CONFLICT" }
    );
});

test("model result retained on enable and runtime refresh errors", async () => {
    for (const phase of ["enable", "refresh"]) {
        const f = await fixture([{ disabled: true }]);
        if (phase === "enable")
            f.system.authSource.store.updateState = async () => {
                throw new Error("private storage detail");
            };
        else
            f.system.browserManager.rebalanceContextPool = async () => {
                throw new Error("private runtime detail");
            };
        const row = (await run(f)).currentRun.results[0];
        assert(row.modelVerified);
        assert.equal(row.errorCode, `${phase}_failed`);
        assert.equal(row.enabled, phase === "refresh" ? true : undefined);
        assert(!JSON.stringify(row).includes("private"));
    }
});

test("durable idempotency, busy conflict, stop only remaining, restart never replays", async () => {
    const gate = deferred();
    const began = deferred();
    const f = await fixture([{}, {}], async args => {
        began.resolve();
        await gate.promise;
        return response(args);
    });
    const body = { clientRequestId: "idempotent-submit", indices: f.indices };
    const first = f.service.start(body);
    await began.promise;
    assert.equal(f.service.start(body).runId, first.runId);
    assert.throws(() => f.service.start({ ...body, indices: [99] }), { code: "IDEMPOTENCY_CONFLICT" });
    assert.throws(() => f.service.start({ ...body, clientRequestId: "another-submit" }), { code: "ACCOUNT_BUSY" });
    f.service.stop(first.runId);
    gate.resolve();
    await f.service.runPromise;
    assert.deepEqual(
        f.service.snapshot().currentRun.results.map(row => row.state),
        ["success", "unexecuted"]
    );
    const recovered = new CredentialTestService(f.system, { rootDir: f.rootDir, verifier: f.verifier });
    assert.equal(recovered.start(body).runId, first.runId);
    assert.deepEqual(recovered.snapshot(body.clientRequestId).admission, { runId: first.runId });
    assert.equal(recovered.snapshot("unsubmitted-id").admission, null);
    assert.throws(() => recovered.snapshot([body.clientRequestId]), { code: "INVALID_REQUEST" });
    assert.equal(f.calls.length, 1);
    const data = JSON.parse(fs.readFileSync(f.service.file));
    data.currentRun.status = "running";
    data.currentRun.results[1].state = "running";
    fs.writeFileSync(f.service.file, JSON.stringify(data));
    const interrupted = new CredentialTestService(f.system, { rootDir: f.rootDir, verifier: f.verifier });
    assert.equal(interrupted.snapshot().currentRun.results[1].state, "interrupted");
    assert.equal(interrupted.snapshot().currentRun.results[0].state, "success");
    assert.equal(f.calls.length, 1);
});

test("retry includes verification failures/interrupted only and filters removed accounts", async () => {
    const code = fs.readFileSync(path.join(__dirname, "../../ui/app/utils/credentialTests.js"), "utf8");
    const { credentialRetryIndices } = await import(
        `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    );
    const results = [
        { errorCode: "quota_exceeded", state: "failed" },
        { state: "interrupted" },
        { errorCode: "version_conflict", state: "failed" },
        { state: "skipped" },
        { state: "unexecuted" },
        { errorCode: "enable_failed", modelVerified: true, state: "failed" },
        { errorCode: "refresh_failed", modelVerified: true, state: "failed" },
        { state: "success" },
        { modelVerified: true, state: "interrupted" },
        { state: "failed" },
    ].map((row, index) => ({ ...row, index }));
    assert.deepEqual(credentialRetryIndices({ results }, results.slice(0, 9)), [0, 1]);
});

test("batch and receipt limits reject before work; expired receipts are removed on admission", async () => {
    const f = await fixture();
    assert.throws(
        () =>
            f.service.start({
                clientRequestId: "oversized-submit",
                indices: Array.from({ length: 1001 }, (_, index) => index),
            }),
        { code: "PAYLOAD_TOO_LARGE" }
    );
    f.service.state.receipts = Array.from({ length: 1000 }, (_, index) => ({
        clientRequestId: `retained-${index}`,
        createdAt: new Date().toISOString(),
        indices: f.indices,
        runId: `old-${index}`,
    }));
    assert.throws(() => f.service.start({ clientRequestId: "full-receipts", indices: f.indices }), {
        code: "RATE_LIMITED",
    });
    assert.equal(f.calls.length, 0);
    f.service.state.receipts[0].createdAt = "2000-01-01T00:00:00.000Z";
    await run(f);
    assert.equal(f.service.state.receipts.length, 1000);
    assert(!f.service.state.receipts.some(item => item.clientRequestId === "retained-0"));
});

test("corrupt or incompatible persisted results disable only credential tests and preserve the file", async () => {
    for (const content of [
        "{truncated",
        "null",
        JSON.stringify({ schemaVersion: 2 }),
        JSON.stringify({ currentRun: {}, lastCompleted: null, receipts: [], schemaVersion: 1 }),
        JSON.stringify({ currentRun: null, lastCompleted: null, receipts: [null], schemaVersion: 1 }),
    ]) {
        const f = await fixture();
        fs.writeFileSync(f.service.file, content);
        const recovered = new CredentialTestService(f.system, { rootDir: f.rootDir, verifier: f.verifier });
        assert.equal(recovered.snapshot().persistenceError, true);
        assert.equal(recovered.snapshot().currentRun, null);
        assert.throws(() => recovered.start({ clientRequestId: "corrupt-recovery", indices: f.indices }), {
            code: "INVALID_STATE",
        });
        assert.equal(fs.readFileSync(f.service.file, "utf8"), content);
        assert.equal(f.calls.length, 0);
        await recovered.close();
    }
});

test("real AutoHeal and console verification compete using the same store versions", async () => {
    for (const first of ["console", "autoheal"]) {
        const consoleGate = deferred();
        const consoleBegan = deferred();
        const autoGate = deferred();
        const f = await fixture([{ disabled: true, disabledReason: "quota_exhausted" }], async args => {
            consoleBegan.resolve();
            await consoleGate.promise;
            return response(args);
        });
        const before = f.system.authSource.store.getMetadata(f.indices[0]);
        const handler = {
            _getAccountRouteState: () => ({}),
            _getAutoHealProbeTimeoutMs: () => 100,
            _persistAccountRouteState() {},
            authSource: f.system.authSource,
            authSwitcher: {},
            browserManager: { probeAccountIsolated: () => autoGate.promise },
            logger,
        };
        const automatic = RequestHandler.prototype._probeAndRestoreAccount.call(
            handler,
            f.indices[0],
            "quota_exhausted"
        );
        f.service.start({ clientRequestId: `race-${first}`, indices: f.indices });
        await consoleBegan.promise;
        let autoResult;
        if (first === "console") {
            consoleGate.resolve();
            await f.service.runPromise;
            autoGate.resolve(true);
            autoResult = await automatic;
            assert.equal(autoResult.reason, "account_changed");
            assert.equal(f.service.snapshot().currentRun.results[0].state, "success");
        } else {
            autoGate.resolve(true);
            autoResult = await automatic;
            consoleGate.resolve();
            await f.service.runPromise;
            assert.equal(autoResult.restored, true);
            assert.equal(f.service.snapshot().currentRun.results[0].errorCode, "version_conflict");
        }
        assert.equal(f.system.authSource.store.getMetadata(f.indices[0]).stateVersion, before.stateVersion + 1);
    }
});

test("credential replacement and deletion during verification do not activate stale credentials", async () => {
    for (const kind of ["replace", "remove"]) {
        const f = await fixture([{ disabled: true }], async (args, system) => {
            if (kind === "replace")
                await system.authSource.store.replace(args.index, credentials("replacement@example.invalid"));
            else await system.authSource.store.remove(args.index);
            return response(args);
        });
        const row = (await run(f)).currentRun.results[0];
        assert.equal(row.errorCode, "version_conflict");
        assert.equal(row.modelVerified, true);
    }
});

test("task persistence failure before enable halts subsequent work and preserves disabled state", async () => {
    const f = await fixture([{ disabled: true }, { disabled: true }], async args => {
        // A directory at the destination forces atomic rename to fail without touching credentials.
        fs.unlinkSync(f.service.file);
        fs.mkdirSync(f.service.file);
        return response(args);
    });
    const { currentRun, persistenceError } = await run(f);
    assert.equal(persistenceError, true);
    assert.equal(currentRun.status, "interrupted");
    assert.equal(f.calls.length, 1);
    assert(f.indices.every(index => f.system.authSource.store.getMetadata(index).disabled));
    assert.throws(() => f.service.start({ clientRequestId: "another-after-failure", indices: f.indices }), {
        code: "INVALID_STATE",
    });
});

test("hung owned cleanup stops the batch instead of occupying every later account deadline", async () => {
    const f = await fixture([{}, {}], async () => {
        f.verifier.tail = new Promise(() => {});
        throw new VerificationError("timeout");
    });
    f.service.cleanupTimeoutMs = 5;
    const state = await run(f);
    assert.equal(state.cleanupBlocked, true);
    assert.equal(state.currentRun.status, "interrupted");
    assert.equal(f.calls.length, 1);
    assert.throws(() => f.service.start({ clientRequestId: "another-after-cleanup", indices: f.indices }), {
        code: "INVALID_STATE",
    });
});

test("shutdown aborts verification, closes owned resources and marks remaining work interrupted", async () => {
    const began = deferred();
    const f = await fixture(
        [{}, {}],
        args =>
            new Promise((resolve, reject) => {
                args.signal.addEventListener("abort", () => reject(new VerificationError("cancelled")), { once: true });
                began.resolve();
            })
    );
    let closed = false;
    f.verifier.close = async () => {
        closed = true;
    };
    f.service.start({ clientRequestId: "shutdown-submit", indices: f.indices });
    await began.promise;
    await f.service.close();
    assert(closed);
    assert.equal(f.calls.length, 1);
    assert(f.service.snapshot().currentRun.results.every(row => row.state === "interrupted"));
});

test("stop followed by restart or shutdown preserves unexecuted accounts outside the retry set", async () => {
    const code = fs.readFileSync(path.join(__dirname, "../../ui/app/utils/credentialTests.js"), "utf8");
    const { credentialRetryIndices } = await import(
        `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    );
    for (const mode of ["restart", "shutdown", "cleanup", "persistence"]) {
        const began = deferred();
        const gate = deferred();
        const f = await fixture([{}, {}], async args => {
            began.resolve();
            await new Promise((resolve, reject) => {
                gate.promise.then(resolve);
                args.signal.addEventListener("abort", () => reject(new VerificationError("cancelled")), { once: true });
            });
            if (mode === "cleanup") {
                f.verifier.tail = new Promise(() => {});
                throw new VerificationError("timeout");
            }
            if (mode === "persistence") {
                fs.unlinkSync(f.service.file);
                fs.mkdirSync(f.service.file);
                throw new VerificationError("timeout");
            }
            return response(args);
        });
        f.service.cleanupTimeoutMs = 5;
        const { runId } = f.service.start({ clientRequestId: `stop-then-${mode}`, indices: f.indices });
        await began.promise;
        f.service.stop(runId);
        let result;
        if (mode === "restart") {
            const restored = new CredentialTestService(f.system, { rootDir: f.rootDir, verifier: f.verifier });
            result = restored.snapshot().currentRun;
            gate.resolve();
            await f.service.runPromise;
        } else if (mode === "shutdown") {
            await f.service.close();
            result = f.service.snapshot().currentRun;
        } else {
            gate.resolve();
            await f.service.runPromise;
            result = f.service.snapshot().currentRun;
        }
        assert.equal(result.results[0].state, ["restart", "shutdown"].includes(mode) ? "interrupted" : "failed");
        assert.equal(result.results[1].state, "unexecuted", mode);
        assert.equal(result.results[1].errorCode, null, mode);
        assert.deepEqual(
            credentialRetryIndices(
                result,
                f.indices.map(index => ({ index }))
            ),
            [f.indices[0]],
            mode
        );
        assert.equal(f.calls.length, 1, mode);
    }
    const queued = await fixture([{}, {}]);
    const { runId } = queued.service.start({ clientRequestId: "stop-before-start", indices: queued.indices });
    queued.service.stop(runId);
    await queued.service.close();
    const result = queued.service.snapshot().currentRun;
    assert(result.results.every(row => row.state === "unexecuted"));
    assert.deepEqual(
        credentialRetryIndices(
            result,
            queued.indices.map(index => ({ index }))
        ),
        []
    );
    assert.equal(queued.calls.length, 0);
});

test("late successful cleanup releases the admission block, actual cleanup failures retain it", async () => {
    for (const failed of [false, true]) {
        const cleanup = deferred();
        const f = await fixture([{}, {}], async args => {
            if (f.calls.length > 1) return response(args);
            f.verifier.tail = cleanup.promise;
            throw new VerificationError("timeout");
        });
        f.service.cleanupTimeoutMs = 5;
        await run(f);
        assert.equal(f.service.snapshot().cleanupBlocked, true);
        f.verifier.cleanupFailed = failed;
        cleanup.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.service.snapshot().cleanupBlocked, failed);
        if (!failed) {
            const next = await run(f, [f.indices[0]], "after-late-cleanup");
            assert.equal(next.currentRun.results[0].state, "success");
        } else {
            assert.throws(() => f.service.start({ clientRequestId: "after-failed-cleanup", indices: f.indices }), {
                code: "INVALID_STATE",
            });
        }
    }
});

test("cleanup wait respects the verifier close budget", async () => {
    const f = await fixture();
    f.service.cleanupTimeoutMs = 5;
    f.verifier.closeTimeoutMs = 100;
    f.verifier.tail = new Promise(resolve => setTimeout(resolve, 20));
    await f.service._waitForCleanup();
    assert.equal(f.service.snapshot().cleanupBlocked, false);
});

test("console owns a separate verifier queue while management verification is pending", async () => {
    const f = await fixture();
    const service = new CredentialTestService(
        { ...f.system, managementVerifier: { tail: new Promise(() => {}) } },
        { rootDir: f.rootDir }
    );
    assert(service.verifier instanceof ManagementVerifier);
    await service.verifier.tail;
    await service.close();
});

test("session-gated async routes: submit, read and stop; invalid input does not call verifier", async () => {
    const f = await fixture();
    const app = express();
    app.use(express.json());
    const system = { ...f.system, config: {}, credentialTestService: f.service };
    new StatusRoutes(system).setupRoutes(app, (req, res, next) =>
        req.headers["x-test-session"] === "valid" ? next() : res.status(401).json({})
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/api/account-credential-tests`;
    const headers = { "Content-Type": "application/json", "x-test-session": "valid" };
    try {
        for (const [suffix, method] of [
            ["", "GET"],
            ["/runs", "POST"],
            ["/runs/missing/stop", "POST"],
        ])
            assert.equal((await fetch(url + suffix, { method })).status, 401);
        assert.equal(
            (
                await fetch(url + "/runs", {
                    body: JSON.stringify({ clientRequestId: "invalid-request", indices: [-1] }),
                    headers,
                    method: "POST",
                })
            ).status,
            400
        );
        assert.equal(f.calls.length, 0);
        const accepted = await fetch(url + "/runs", {
            body: JSON.stringify({ clientRequestId: "route-submit", indices: f.indices }),
            headers,
            method: "POST",
        });
        assert.equal(accepted.status, 202);
        await f.service.runPromise;
        const state = await fetch(url, { headers });
        assert.equal(state.headers.get("cache-control"), "no-store");
        const snapshot = await state.json();
        assert.equal(snapshot.currentRun.results[0].state, "success");
        assert.equal(
            (await fetch(url + `/runs/${snapshot.currentRun.runId}/stop`, { headers, method: "POST" })).status,
            200
        );
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
