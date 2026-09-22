const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const RuntimeSettingsStore = require("../../src/storage/RuntimeSettingsStore");
const ConfigLoader = require("../../src/utils/ConfigLoader");

const persistentKeys = [
    "accountCooldownMaxMs",
    "accountCooldownMs",
    "autoDisableStatusCodes",
    "autoHealProbeIntervalMs",
    "autoHealProbeTimeoutMs",
    "maxContexts",
    "maxRetries",
    "retryDelay",
];

function defaults() {
    return {
        accountCooldownMaxMs: 1800000,
        accountCooldownMs: 300000,
        apiKeys: ["fixture-secret-do-not-expose"],
        autoDisableStatusCodes: [401, 403],
        autoHealProbeIntervalMs: 18000000,
        autoHealProbeTimeoutMs: 600000,
        checkUpdate: true,
        enableAuthUpdate: true,
        enableUsageStats: true,
        forceCodeExecution: false,
        forceThinking: false,
        forceUrlContext: false,
        forceWebSearch: false,
        maxContexts: 1,
        maxRetries: 3,
        retryDelay: 2000,
        safetySettingsThreshold: "OFF",
        streamingMode: "real",
    };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => {
        resolve = done;
    });
    return { promise, resolve };
}

function ioError(code) {
    return Object.assign(new Error(`fixture ${code}`), { code });
}

async function withFixture(run) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "runtime-settings-store-"));
    const filePath = path.join(root, "configs", "runtime-settings.json");
    const config = defaults();
    let applications = 0;
    const store = new RuntimeSettingsStore({
        config,
        filePath,
        onApplied: () => {
            applications++;
        },
    });
    try {
        await run({ applications: () => applications, config, filePath, root, store });
    } finally {
        await fs.promises.rm(root, { force: true, recursive: true });
    }
}

// All mocks are scoped to sequential, temporary-directory tests and restored.
async function mockFs(overrides, run) {
    const originals = {};
    for (const [key, replacement] of Object.entries(overrides)) {
        originals[key] = fs.promises[key];
        fs.promises[key] = replacement;
    }
    try {
        await run();
    } finally {
        Object.assign(fs.promises, originals);
    }
}

function wrapHandle(handle, overrides) {
    return new Proxy(handle, {
        get(target, key) {
            if (Object.hasOwn(overrides, key)) return overrides[key];
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

async function read(filePath) {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
}

async function assertNoTemps(filePath) {
    const files = await fs.promises.readdir(path.dirname(filePath));
    assert.deepEqual(files, ["runtime-settings.json"]);
}

const tests = [];
function test(name, run) {
    tests.push({ name, run });
}

test("snapshot/result/callback are detached and never expose credentials", () =>
    withFixture(async ({ config, filePath, store }) => {
        const snapshot = store.snapshot();
        assert.deepEqual(snapshot.persistentKeys, persistentKeys);
        assert.equal(snapshot.debugMode, false);
        assert(!JSON.stringify(snapshot).includes(config.apiKeys[0]));
        snapshot.persistentKeys.push("apiKeys");
        snapshot.autoDisableStatusCodes.push(599);
        assert.deepEqual(store.snapshot().autoDisableStatusCodes, [401, 403]);
        store.onApplied = ({ values, previous, changedKeys }) => {
            assert(!JSON.stringify({ previous, values }).includes(config.apiKeys[0]));
            assert.deepEqual(changedKeys, ["autoDisableStatusCodes"]);
            values.autoDisableStatusCodes.push(500);
            previous.autoDisableStatusCodes.length = 0;
        };
        const result = await store.update({ autoDisableStatusCodes: [401, 503, 401] });
        assert.deepEqual(result.values.autoDisableStatusCodes, [401, 503]);
        result.values.autoDisableStatusCodes.push(599);
        assert.deepEqual(config.autoDisableStatusCodes, [401, 503]);
        const saved = await read(filePath);
        assert.deepEqual(Object.keys(saved), persistentKeys);
        assert(!JSON.stringify(saved).includes("secret"));
        await assertNoTemps(filePath);
    }));

test("invalid patches never write, mutate config, or call application hooks", () =>
    withFixture(async ({ applications, config, filePath, store }) => {
        const before = structuredClone(config);
        const invalid = [
            null,
            [],
            "bad",
            { apiKeys: [] },
            JSON.parse('{"__proto__": {"polluted": true}}'),
            { [Symbol("hidden")]: true },
            { maxRetries: "4" },
            { maxContexts: -1 },
            { maxContexts: 1001 },
            { maxRetries: 0 },
            { maxRetries: 21 },
            { retryDelay: 49 },
            { retryDelay: 600001 },
            { accountCooldownMs: 999 },
            { accountCooldownMs: 86400001 },
            { accountCooldownMaxMs: 604800001 },
            { autoHealProbeIntervalMs: 59999 },
            { autoHealProbeIntervalMs: 604800001 },
            { autoHealProbeTimeoutMs: 29999 },
            { autoHealProbeTimeoutMs: 3600001 },
            { forceThinking: "false" },
            { streamingMode: "other" },
            { safetySettingsThreshold: "bad" },
            { autoDisableStatusCodes: "401,403" },
            { autoDisableStatusCodes: [399] },
            { autoDisableStatusCodes: [600] },
            { autoDisableStatusCodes: ["401"] },
            { autoDisableStatusCodes: new Array(1) },
            { maxRetries: NaN },
            { retryDelay: Infinity },
            { maxRetries: 1.5 },
            { maxRetries: undefined },
            { debugMode: 1 },
            { logMaxCount: 0 },
            { logMaxCount: Number.MAX_SAFE_INTEGER + 1 },
            { forceThinking: true, retryDelay: 0 },
        ];
        for (const patch of invalid) {
            await assert.rejects(store.update(patch), {
                applied: false,
                code: "INVALID_SETTINGS",
                persisted: false,
                status: 400,
            });
        }
        await assert.rejects(store.toggle("maxRetries"), { code: "INVALID_SETTINGS" });
        assert.deepEqual(config, before);
        assert.equal(applications(), 0);
        assert(!fs.existsSync(filePath));
        assert.equal({}.polluted, undefined);
    }));

test("persistence completes before config mutation and side effects", () =>
    withFixture(async ({ config, filePath, store }) => {
        await store.save();
        const entered = deferred();
        const release = deferred();
        const rename = fs.promises.rename;
        let applied = false;
        store.onApplied = async ({ previous, values, changedKeys, persisted }) => {
            assert.equal(previous.maxRetries, 3);
            assert.equal(values.maxRetries, 7);
            assert.equal(config.maxRetries, 7);
            assert.equal((await read(filePath)).maxRetries, 7);
            assert.deepEqual(changedKeys, ["maxRetries", "forceThinking"]);
            assert.equal(persisted, true);
            applied = true;
        };
        await mockFs(
            {
                rename: async (...args) => {
                    entered.resolve();
                    await release.promise;
                    return rename(...args);
                },
            },
            async () => {
                const pending = store.update({ forceThinking: true, maxRetries: 7 });
                await entered.promise;
                try {
                    assert.equal(config.maxRetries, 3);
                    assert.equal(config.forceThinking, false);
                    assert.equal((await read(filePath)).maxRetries, 3);
                    assert.equal(applied, false);
                } finally {
                    release.resolve();
                }
                const result = await pending;
                assert.equal(result.applied, true);
                assert.equal(result.persisted, true);
            }
        );
        assert.equal(applied, true);
    }));

test("concurrent writers, input capture, toggles and hooks are serialized", () =>
    withFixture(async ({ config, filePath, store }) => {
        const entered = deferred();
        const release = deferred();
        const order = [];
        store.onApplied = async ({ values }) => {
            order.push(values.maxRetries);
            if (values.maxRetries === 4) {
                entered.resolve();
                await release.promise;
            }
        };
        const first = store.update({ maxRetries: 4 });
        await entered.promise;
        const secondStore = new RuntimeSettingsStore({ config, filePath });
        const patch = { autoDisableStatusCodes: [401, 503], maxRetries: 5 };
        const second = secondStore.update(patch);
        patch.maxRetries = 99;
        patch.autoDisableStatusCodes.push(123);
        const toggles = Array.from({ length: 10 }, () => secondStore.toggle("forceThinking"));
        try {
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(config.maxRetries, 4);
            assert.equal(config.forceThinking, false);
        } finally {
            release.resolve();
        }
        await Promise.all([first, second]);
        const results = await Promise.all(toggles);
        assert.deepEqual(
            results.map(result => result.values.forceThinking),
            [true, false, true, false, true, false, true, false, true, false]
        );
        assert.equal(config.maxRetries, 5);
        assert.deepEqual(config.autoDisableStatusCodes, [401, 503]);
        assert.deepEqual(order, [4]);
        assert.equal((await read(filePath)).maxRetries, 5);
        await assertNoTemps(filePath);
    }));

test("cooldown invariant uses queued state and retains UI base-increase semantics", () =>
    withFixture(async ({ config, filePath, store }) => {
        const raised = await store.update({ accountCooldownMs: 2000000 });
        assert.equal(raised.values.accountCooldownMaxMs, 2000000);
        assert.equal((await read(filePath)).accountCooldownMaxMs, 2000000);
        await assert.rejects(store.update({ accountCooldownMaxMs: 1999999 }), { code: "INVALID_SETTINGS" });
        await assert.rejects(store.update({ accountCooldownMaxMs: 2000000, accountCooldownMs: 2000001 }), {
            code: "INVALID_SETTINGS",
        });
        const outcomes = await Promise.allSettled([
            store.update({ accountCooldownMs: 3000000 }),
            store.update({ accountCooldownMaxMs: 2500000 }),
            store.update({ accountCooldownMaxMs: 4000000 }),
        ]);
        assert.deepEqual(
            outcomes.map(result => result.status),
            ["fulfilled", "rejected", "fulfilled"]
        );
        assert.equal(config.accountCooldownMaxMs, 4000000);
    }));

test("temporary flags never change persisted content or restart semantics", () =>
    withFixture(async ({ config, filePath, root, store }) => {
        await store.update({ debugMode: true, forceThinking: true, logMaxCount: 500, streamingMode: "fake" });
        assert(!fs.existsSync(filePath));
        await store.update({ autoDisableStatusCodes: [], maxContexts: 0 });
        const before = await fs.promises.readFile(filePath, "utf8");
        const result = await store.update({ enableAuthUpdate: false, safetySettingsThreshold: "BLOCK_NONE" });
        assert.equal(result.persisted, false);
        assert.equal(result.applied, true);
        assert.equal(await fs.promises.readFile(filePath, "utf8"), before);
        const saved = await store.save();
        assert.equal(saved.persisted, true);
        assert.equal(await fs.promises.readFile(filePath, "utf8"), before);
        const reloaded = defaults();
        const originalCwd = process.cwd;
        process.cwd = () => root;
        try {
            new ConfigLoader({ info() {}, warn() {} })._applyRuntimeSettings(reloaded);
        } finally {
            process.cwd = originalCwd;
        }
        assert.equal(reloaded.forceThinking, false);
        assert.equal(reloaded.streamingMode, "real");
        assert.equal(reloaded.safetySettingsThreshold, "OFF");
        assert.equal(reloaded.enableAuthUpdate, true);
        assert.equal(reloaded.maxContexts, 0);
        assert.deepEqual(reloaded.autoDisableStatusCodes, []);
        assert.equal(config.forceThinking, true);
    }));

test("application failure is distinguishable, redacted, committed, and retryable", () =>
    withFixture(async ({ config, filePath, store }) => {
        store.logger = {
            warn() {
                throw new Error("logger failure");
            },
        };
        store.onApplied = () => {
            throw new Error(config.apiKeys[0]);
        };
        const result = await store.update({ maxContexts: 4 });
        assert.equal(result.persisted, true);
        assert.equal(result.applied, false);
        assert.equal(result.applicationError.code, "SETTINGS_APPLICATION_FAILED");
        assert(!JSON.stringify(result).includes(config.apiKeys[0]));
        assert.equal(config.maxContexts, 4);
        assert.equal((await read(filePath)).maxContexts, 4);
        store.onApplied = ({ changedKeys }) => {
            assert.deepEqual(changedKeys, ["maxContexts"]);
        };
        assert.equal((await store.update({ maxContexts: 4 })).applied, true);
        store.onApplied = () => {
            throw new Error("temporary hook failure");
        };
        const temporary = await store.toggle("debugMode");
        assert.equal(temporary.persisted, false);
        assert.equal(temporary.applied, false);
        assert.equal(config.debugMode, true);
    }));

for (const phase of ["temp-open", "temp-sync", "rename", "fallback-open"]) {
    test(`${phase} persistence failure preserves disk/config and queue recovers`, () =>
        withFixture(async ({ applications, config, filePath, store }) => {
            await store.save();
            const before = await fs.promises.readFile(filePath);
            const beforeConfig = structuredClone(config);
            const open = fs.promises.open;
            const overrides = {
                open: async (target, flags, ...args) => {
                    if (phase === "temp-open" && flags === "wx") throw ioError("ENOSPC");
                    if (phase === "fallback-open" && target === filePath) throw ioError("EACCES");
                    const handle = await open(target, flags, ...args);
                    if (phase === "temp-sync" && flags === "wx") {
                        return wrapHandle(handle, {
                            sync: async () => {
                                throw ioError("EIO");
                            },
                        });
                    }
                    return handle;
                },
            };
            if (phase === "rename" || phase === "fallback-open") {
                overrides.rename = async () => {
                    throw ioError(phase === "rename" ? "EIO" : "EBUSY");
                };
            }
            await mockFs(overrides, async () => {
                await assert.rejects(store.update({ forceThinking: true, maxRetries: 6 }), {
                    applied: false,
                    code: "SETTINGS_PERSISTENCE_FAILED",
                    persisted: false,
                    status: 500,
                });
            });
            assert.deepEqual(await fs.promises.readFile(filePath), before);
            assert.deepEqual(config, beforeConfig);
            assert.equal(applications(), 0);
            await assertNoTemps(filePath);
            assert.equal((await store.update({ maxRetries: 7 })).applied, true);
        }));
}

for (const code of ["EBUSY", "EPERM", "EACCES", "EEXIST"]) {
    test(`${code} replacement fallback preserves inode and truncates old trailing bytes`, () =>
        withFixture(async ({ config, filePath, store }) => {
            await store.save();
            await fs.promises.appendFile(filePath, " ".repeat(1000));
            const inode = (await fs.promises.stat(filePath)).ino;
            const open = fs.promises.open;
            await mockFs(
                {
                    open: async (...args) => {
                        const handle = await open(...args);
                        if (args[0] !== filePath) return handle;
                        // Force partial writes to exercise positional write progress.
                        return wrapHandle(handle, {
                            write: (buffer, offset, length, position) =>
                                handle.write(buffer, offset, Math.min(13, length), position),
                        });
                    },
                    rename: async () => {
                        throw ioError(code);
                    },
                },
                async () => {
                    assert.equal((await store.update({ maxRetries: 9 })).persisted, true);
                }
            );
            assert.equal((await fs.promises.stat(filePath)).ino, inode);
            assert.equal((await read(filePath)).maxRetries, 9);
            assert.equal(config.maxRetries, 9);
            assert((await fs.promises.stat(filePath)).size < 1000);
            await assertNoTemps(filePath);
        }));
}

for (const phase of ["write", "truncate", "sync", "no-progress", "recovery"]) {
    test(`bind mount ${phase} failure reports recovery outcome and preserves live config`, () =>
        withFixture(async ({ applications, config, filePath, store }) => {
            await store.save();
            // Preserve exact original formatting too, not just equivalent JSON.
            await fs.promises.appendFile(filePath, "\n   \n");
            const before = await fs.promises.readFile(filePath);
            const beforeConfig = structuredClone(config);
            const inode = (await fs.promises.stat(filePath)).ino;
            const open = fs.promises.open;
            let failed = false;
            await mockFs(
                {
                    open: async (...args) => {
                        const handle = await open(...args);
                        if (args[0] !== filePath) return handle;
                        return wrapHandle(handle, {
                            sync: async () => {
                                if (!failed && phase === "sync") {
                                    failed = true;
                                    throw ioError("EIO");
                                }
                                return handle.sync();
                            },
                            truncate: async length => {
                                if (!failed && phase === "truncate") {
                                    failed = true;
                                    await handle.truncate(1);
                                    throw ioError("EIO");
                                }
                                return handle.truncate(length);
                            },
                            write: async (...writeArgs) => {
                                if (phase === "recovery" || (!failed && phase === "write")) {
                                    failed = true;
                                    await handle.write(Buffer.from("partial failure"), 0, 15, 0);
                                    throw ioError("ENOSPC");
                                }
                                if (!failed && phase === "no-progress") {
                                    failed = true;
                                    return { bytesWritten: 0 };
                                }
                                return handle.write(...writeArgs);
                            },
                        });
                    },
                    rename: async () => {
                        throw ioError("EBUSY");
                    },
                },
                async () => {
                    const expected = {
                        applied: false,
                        code:
                            phase === "recovery"
                                ? "SETTINGS_PERSISTENCE_RECOVERY_FAILED"
                                : "SETTINGS_PERSISTENCE_FAILED",
                        persisted: false,
                        status: 500,
                    };
                    if (phase === "recovery") expected.diskStateUncertain = true;
                    await assert.rejects(store.update({ forceThinking: true, maxRetries: 6 }), expected);
                }
            );
            assert.deepEqual(config, beforeConfig);
            assert.equal(applications(), 0);
            assert.equal((await fs.promises.stat(filePath)).ino, inode);
            if (phase !== "recovery") assert.deepEqual(await fs.promises.readFile(filePath), before);
            await assertNoTemps(filePath);
            assert.equal((await store.update({ maxRetries: 8 })).persisted, true);
            assert.equal((await read(filePath)).maxRetries, 8);
        }));
}

test("cleanup/close failure after sync does not misreport committed settings", () =>
    withFixture(async ({ config, filePath, store }) => {
        await store.save();
        const open = fs.promises.open;
        await mockFs(
            {
                open: async (...args) => {
                    const handle = await open(...args);
                    if (args[0] !== filePath) return handle;
                    return wrapHandle(handle, {
                        close: async () => {
                            await handle.close();
                            throw ioError("EIO");
                        },
                    });
                },
                rename: async () => {
                    throw ioError("EBUSY");
                },
                rm: async () => {
                    throw ioError("EACCES");
                },
            },
            async () => {
                const result = await store.update({ maxRetries: 10 });
                assert.equal(result.applied, true);
                assert.equal(result.persisted, true);
            }
        );
        assert.equal(config.maxRetries, 10);
        assert.equal((await read(filePath)).maxRetries, 10);
    }));

(async () => {
    for (const { name, run } of tests) {
        await run();
        console.log(`PASS ${name}`);
    }
    console.log(`runtimeSettingsStore: ${tests.length} scenarios passed (temporary files and simulated I/O only).`);
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
