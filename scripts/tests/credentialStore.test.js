const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const CredentialStore = require("../../src/storage/CredentialStore");
const AuthSource = require("../../src/auth/AuthSource");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const fixture = (name = "one@example.invalid", value = "fixture-only") => ({
    accountName: name,
    cookies: [
        {
            domain: ".example.invalid",
            expires: -1,
            httpOnly: true,
            name: "session",
            path: "/",
            sameSite: "None",
            secure: true,
            value,
        },
    ],
    origins: [{ localStorage: [{ name: "fixture", value }], origin: "https://example.invalid" }],
});
const roots = [];
function setup() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-store-test-"));
    roots.push(rootDir);
    const authDir = path.join(rootDir, "configs", "auth");
    fs.mkdirSync(authDir, { recursive: true });
    return { authDir, rootDir, store: () => new CredentialStore({ logger, rootDir }) };
}
function write(authDir, index, content) {
    fs.writeFileSync(
        path.join(authDir, `auth-${index}.json`),
        typeof content === "string" ? content : JSON.stringify(content)
    );
}
function failWrite(store, predicate, count = 1) {
    const original = store._atomicWrite;
    store._atomicWrite = function (file, text) {
        if (count > 0 && predicate(file, text)) {
            count--;
            throw Object.assign(new Error("injected write failure"), { code: "ENOSPC" });
        }
        return original.call(this, file, text);
    };
    return () => {
        store._atomicWrite = original;
    };
}
const tests = [];
const test = (name, fn) => tests.push({ fn, name });

test("legacy identity is durable; schema-invalid files and backup numbers are preserved", async () => {
    const env = setup();
    const original = JSON.stringify(fixture(), null, 4);
    write(env.authDir, 2, original);
    write(env.authDir, 9, "{broken");
    write(env.authDir, 10, { accountName: "bad@example.invalid", cookies: {} });
    fs.writeFileSync(path.join(env.authDir, "auth-42.json.bak"), "backup");
    const store = env.store();
    assert.equal(store.getMetadata(9).schemaValid, false);
    assert.equal(store.getMetadata(10).schemaValid, false);
    assert.equal(store.read(9), null);
    assert.equal(fs.readFileSync(path.join(env.authDir, "auth-2.json"), "utf8"), original);
    assert.equal(env.store().getMetadata(2).accountId, store.getMetadata(2).accountId);
    assert.equal((await store.create(fixture("two@example.invalid"))).index, 43);
    assert.equal(fs.readFileSync(path.join(env.authDir, "auth-9.json"), "utf8"), "{broken");
});

test("parallel allocations and restart never reuse deleted or invalid account numbers", async () => {
    const env = setup();
    const store = env.store();
    const rows = await Promise.all(Array.from({ length: 12 }, (_, i) => store.create(fixture(`${i}@example.invalid`))));
    assert.deepEqual(
        rows.map(row => row.index),
        Array.from({ length: 12 }, (_, i) => i)
    );
    const deleted = rows.at(-1);
    await store.remove(deleted.index);
    assert.equal(store.getMetadata(deleted.index), null);
    assert.equal((await env.store().create(fixture())).index, 12);
    const persisted = JSON.parse(fs.readFileSync(store.metadataPath, "utf8"));
    assert.equal(persisted.accounts[deleted.index].accountId, deleted.accountId);
    assert.equal(persisted.accounts[deleted.index].deleted, true);
});

test("replacement preserves latest control flags and rejects stale credential/state versions", async () => {
    const store = setup().store();
    const created = await store.create(fixture());
    const disabled = store.updateState(created.index, {
        disabled: true,
        disabledReason: "manual",
        disabledStatus: 403,
    });
    const replaced = store.replace(created.index, {
        ...fixture("new@example.invalid"),
        disabled: false,
        expired: false,
    });
    await disabled;
    const result = await replaced;
    assert.equal(result.credentialVersion, 2);
    assert.equal(result.stateVersion, 2);
    assert.equal(store.read(created.index).disabled, true);
    assert.equal(store.read(created.index).disabledReason, "manual");
    assert.equal(store.read(created.index).expired, undefined);
    await assert.rejects(store.replace(created.index, fixture(), { expectedCredentialVersion: 1 }), {
        code: "VERSION_CONFLICT",
        status: 409,
    });
    await assert.rejects(store.updateState(created.index, { disabled: null }, { expectedStateVersion: 1 }), {
        code: "VERSION_CONFLICT",
        status: 409,
    });
    const noOp = await store.updateState(created.index, { disabled: true });
    assert.equal(noOp.changed, false);
    assert.equal(noOp.stateVersion, 2);
});

test("enabled replacement commits credentials and state together or rolls both back", async () => {
    const env = setup();
    const store = env.store();
    const created = await store.create(fixture(), { disabled: true, reason: "manual" });
    const before = fs.readFileSync(path.join(env.authDir, "auth-0.json"), "utf8");
    const undo = failWrite(store, file => file === store.metadataPath);
    await assert.rejects(
        store.replace(created.index, fixture("new@example.invalid"), {
            enable: true,
            expectedCredentialVersion: created.credentialVersion,
            expectedStateVersion: created.stateVersion,
        }),
        { code: "PERSISTENCE_ERROR" }
    );
    undo();
    assert.equal(fs.readFileSync(path.join(env.authDir, "auth-0.json"), "utf8"), before);
    assert.equal(env.store().getMetadata(created.index).disabled, true);
    const result = await store.replace(created.index, fixture("new@example.invalid"), {
        enable: true,
        expectedCredentialVersion: created.credentialVersion,
        expectedStateVersion: created.stateVersion,
    });
    assert.equal(result.credentialVersion, created.credentialVersion + 1);
    assert.equal(result.stateVersion, created.stateVersion + 1);
    assert.equal(store.read(created.index).disabled, undefined);
    assert.equal(env.store().getMetadata(created.index).disabled, undefined);
});

test("refresh discards stale snapshots after replacement while preserving manual flags", async () => {
    const store = setup().store();
    const created = await store.create(fixture());
    const snapshot = store.getMetadata(created.index);
    await store.updateState(created.index, { disabled: true, disabledReason: "manual" });
    const refreshed = await store.mergeStorageState(created.index, fixture("ignored@example.invalid", "new-cookie"), {
        expectedCredentialVersion: snapshot.credentialVersion,
    });
    assert.equal(refreshed.disabled, true);
    assert.equal(store.read(created.index).accountName, fixture().accountName);
    assert.equal(store.read(created.index).cookies[0].value, "new-cookie");
    const oldVersion = refreshed.credentialVersion;
    await store.replace(created.index, fixture("replacement@example.invalid"));
    await assert.rejects(store.mergeStorageState(created.index, fixture(), { expectedCredentialVersion: oldVersion }), {
        code: "VERSION_CONFLICT",
    });
    await assert.rejects(store.mergeStorageState(created.index, fixture()), { code: "VERSION_REQUIRED" });
    assert.equal(store.read(created.index).accountName, "replacement@example.invalid");
});

test("deletion wins over queued refresh and external stale files do not resurrect tombstones", async () => {
    const env = setup();
    const store = env.store();
    const created = await store.create(fixture());
    const removed = store.remove(created.index);
    const stale = store.mergeStorageState(created.index, fixture(), {
        expectedCredentialVersion: created.credentialVersion,
    });
    await removed;
    await assert.rejects(stale, { code: "VERSION_CONFLICT" });
    assert.equal(fs.existsSync(path.join(env.authDir, `auth-${created.index}.json`)), false);
    write(env.authDir, created.index, fixture());
    await store.refresh();
    assert.equal(store.read(created.index), null);
    assert.equal(store.listMetadata().length, 0);
    const source = new AuthSource(logger, { rootDir: env.rootDir });
    assert.deepEqual(source.availableIndices, []);
    assert.equal((await source.createAuth(fixture())).index, 1);
});

test("external replacement, state edits, additions, and removal reconcile durable versions", async () => {
    const env = setup();
    const store = env.store();
    const created = await store.create(fixture());
    write(env.authDir, created.index, { ...fixture(), disabled: true });
    await store.refresh();
    assert.equal(store.getMetadata(created.index).stateVersion, 2);
    assert.equal(store.getMetadata(created.index).credentialVersion, 1);
    write(env.authDir, created.index, fixture("changed@example.invalid"));
    await assert.rejects(store.mergeStorageState(created.index, fixture(), { expectedCredentialVersion: 1 }), {
        code: "VERSION_CONFLICT",
    });
    assert.equal(store.getMetadata(created.index).credentialVersion, 2);
    fs.unlinkSync(path.join(env.authDir, `auth-${created.index}.json`));
    write(env.authDir, 50, fixture("external@example.invalid"));
    await store.refresh();
    assert.equal(store.getMetadata(created.index), null);
    assert.equal(env.store().getMetadata(50).accountId, store.getMetadata(50).accountId);
    assert.equal((await store.create(fixture())).index, 51);
});

test("archive backs up exact bytes, restores stable identity disabled, and invalidates old snapshots", async () => {
    const env = setup();
    const store = env.store();
    const created = await store.create(fixture());
    const original = fs.readFileSync(path.join(env.authDir, "auth-0.json"), "utf8");
    const archived = await store.archive(created.index);
    assert.equal(archived.archived, true);
    assert.equal(store.read(created.index), null);
    assert.equal(store.listMetadata()[0].archived, true);
    assert.equal(fs.readFileSync(path.join(store.archiveDir, `${created.accountId}.json`), "utf8"), original);
    const restarted = env.store();
    const restored = await restarted.restore(created.accountId);
    assert.equal(restored.accountId, created.accountId);
    assert.equal(restored.index, created.index);
    assert.equal(restored.archived, false);
    assert.equal(restored.disabled, true);
    assert.equal(restored.disabledReason, "manual");
    assert.equal(restored.credentialVersion, 3);
    await assert.rejects(restarted.mergeStorageState(created.index, fixture(), { expectedCredentialVersion: 1 }), {
        code: "VERSION_CONFLICT",
    });
    await restarted.archive(created.index);
    await restarted.remove(created.index);
    await assert.rejects(restarted.restore(created.accountId), { code: "ACCOUNT_NOT_FOUND" });
});

test("failed metadata save rolls credential bytes and versions back; queue remains usable", async () => {
    const env = setup();
    const store = env.store();
    const created = await store.create(fixture());
    const before = fs.readFileSync(path.join(env.authDir, "auth-0.json"), "utf8");
    const undo = failWrite(store, file => file === store.metadataPath);
    await assert.rejects(store.replace(created.index, fixture("failed@example.invalid")), {
        code: "PERSISTENCE_ERROR",
        status: 500,
    });
    undo();
    assert.equal(fs.readFileSync(path.join(env.authDir, "auth-0.json"), "utf8"), before);
    assert.equal(store.getMetadata(created.index).credentialVersion, 1);
    assert.equal(env.store().getMetadata(created.index).credentialVersion, 1);
    assert.equal(fs.existsSync(store.journalPath), false);
    await store.updateState(created.index, { disabled: true });
    assert.equal(store.read(created.index).disabled, true);
});

test("failed auth write and failed allocation leave no false success or reused reservation", async () => {
    const env = setup();
    const store = env.store();
    const undo = failWrite(store, file => file.startsWith(env.authDir));
    await assert.rejects(store.create(fixture()), { code: "PERSISTENCE_ERROR" });
    undo();
    assert.deepEqual(store.listMetadata(), []);
    assert.equal((await env.store().create(fixture())).index, 1);
});

test("archive, restore, and delete failures roll all affected files back", async () => {
    const env = setup();
    const store = env.store();
    const created = await store.create(fixture());
    let undo = failWrite(store, file => file === store.metadataPath);
    await assert.rejects(store.archive(created.index), { code: "PERSISTENCE_ERROR" });
    undo();
    assert.equal(store.getMetadata(created.index).archived, false);
    assert.ok(store.read(created.index));
    assert.deepEqual(fs.readdirSync(store.archiveDir), []);
    await store.archive(created.index);
    undo = failWrite(store, file => file === store.metadataPath);
    await assert.rejects(store.restore(created.accountId), { code: "PERSISTENCE_ERROR" });
    undo();
    assert.equal(store.getMetadata(created.index).archived, true);
    assert.equal(fs.existsSync(path.join(env.authDir, "auth-0.json")), false);
    assert.equal(fs.readdirSync(store.archiveDir).length, 1);
    await store.restore(created.accountId);
    undo = failWrite(store, file => file === store.metadataPath);
    await assert.rejects(store.remove(created.index), { code: "PERSISTENCE_ERROR" });
    undo();
    assert.ok(store.read(created.index));
    assert.ok(env.store().read(created.index));
});

test("restart recovers a failed rollback from durable journal, never adopting uncommitted bytes", async () => {
    const env = setup();
    const store = env.store();
    const created = await store.create(fixture());
    const original = store._atomicWrite;
    let metadataFailed = false;
    store._atomicWrite = function (file, text) {
        if (file === store.metadataPath || (metadataFailed && file.startsWith(env.authDir))) {
            metadataFailed = true;
            throw new Error("persistent device error");
        }
        return original.call(this, file, text);
    };
    await assert.rejects(store.replace(created.index, fixture("uncommitted@example.invalid")), {
        code: "PERSISTENCE_ERROR",
    });
    assert.equal(store.poisoned, true);
    assert.equal(store.read(created.index), null);
    assert.equal(fs.existsSync(store.journalPath), true);
    const restarted = env.store();
    assert.equal(restarted.read(created.index).accountName, fixture().accountName);
    assert.equal(restarted.getMetadata(created.index).credentialVersion, 1);
    assert.equal(fs.existsSync(store.journalPath), false);
});

test("invalid state patches and malformed credentials cannot change files", async () => {
    const store = setup().store();
    const created = await store.create(fixture());
    for (const invalid of [
        null,
        "not json",
        {},
        { cookies: [{}], origins: [] },
        { cookies: [], origins: [{ localStorage: [], origin: "invalid" }] },
    ]) {
        await assert.rejects(store.create(invalid), { code: "INVALID_CREDENTIALS", status: 400 });
    }
    for (const patch of [
        { accountName: "bad" },
        { disabled: "yes" },
        { disabledStatus: "403" },
        { expired: 1 },
        { disabledStatus: NaN },
        { disabledStatus: Infinity },
        { disabled: undefined },
    ]) {
        await assert.rejects(store.updateState(created.index, patch), { code: "INVALID_STATE" });
    }
    const result = await store.create({ ...fixture(), disabled: false, expired: true }, { disabled: true });
    assert.equal(result.disabledReason, "pending_verification");
    assert.equal(store.read(result.index).expired, undefined);
    assert.equal(store.getMetadata(created.index).stateVersion, 1);
});

test("AuthSource synchronous reload retains dedup/rotation and invalid files, wrappers await persistence", async () => {
    const env = setup();
    write(env.authDir, 0, fixture());
    write(env.authDir, 1, fixture());
    write(env.authDir, 7, { bad: true });
    const source = new AuthSource(logger, { rootDir: env.rootDir });
    assert.deepEqual(source.availableIndices, [0, 1]);
    assert.deepEqual(source.getRotationIndices(), [1]);
    assert.deepEqual(source.duplicateIndices, [0]);
    assert.equal(fs.existsSync(path.join(env.authDir, "auth-7.json")), true);
    await source.disableAuth(1, { reason: "manual" });
    assert.deepEqual(source.getRotationIndices(), [0]);
    await source.markAsExpired(1);
    await source.unmarkAsExpired(1);
    assert.equal(source.isDisabled(1), true, "manual disable survives clearing expired");
    await source.enableAuth(1);
    assert.deepEqual(source.getRotationIndices(), [1]);
    const undo = failWrite(source.store, file => file === source.store.metadataPath);
    await assert.rejects(source.disableAuth(1), { code: "PERSISTENCE_ERROR" });
    undo();
    assert.equal(source.isDisabled(1), false);
    assert.equal(source.store.read(1).disabled, undefined);
    await source.markAsExpired(1);
    assert.equal(source.isExpired(1), true);
    assert.equal(source.isDisabled(1), true);
    await source.unmarkAsExpired(1);
    assert.equal(source.isUnavailable(1), false);
    const added = await source.createAuth(fixture("other@example.invalid"));
    assert.equal(added.index, 8);
    await source.replaceAuth(added.index, fixture("replaced@example.invalid"));
    await source.archiveAuth(added.index);
    assert.equal(source.availableIndices.includes(added.index), false);
    await source.restoreAuth(added.accountId);
    assert.equal(source.isDisabled(added.index), true);
    const removed = await source.removeAuth(added.index);
    assert.equal(removed.remainingAccounts, 2);
    assert.equal(source.reloadAuthSources(), false);
    assert.equal(await source.enableAuth(999), false);
});

test("synchronous reload detects same-size same-mtime external credential changes", async () => {
    const env = setup();
    write(env.authDir, 0, fixture("old@example.invalid"));
    const source = new AuthSource(logger, { rootDir: env.rootDir });
    const file = path.join(env.authDir, "auth-0.json");
    const stat = fs.statSync(file);
    write(env.authDir, 0, fixture("new@example.invalid"));
    fs.utimesSync(file, stat.atime, stat.mtime);
    assert.equal(source.reloadAuthSources(), true);
    assert.equal(source.accountNameMap.get(0), "new@example.invalid");
    assert.equal(source.store.getMetadata(0).credentialVersion, 2);
});

test("guarded AuthSource enable, disable, and removal cannot override a newer manual action", async () => {
    const env = setup();
    const source = new AuthSource(logger, { rootDir: env.rootDir });
    const created = await source.createAuth(fixture());
    const options = {
        expectedCredentialVersion: created.credentialVersion,
        expectedStateVersion: created.stateVersion,
    };
    await source.disableAuth(created.index, { reason: "manual" });
    await assert.rejects(source.enableAuth(created.index, options), { code: "VERSION_CONFLICT" });
    await assert.rejects(source.disableAuth(created.index, { reason: "probe_failed" }, options), {
        code: "VERSION_CONFLICT",
    });
    await assert.rejects(source.removeAuth(created.index, options), { code: "VERSION_CONFLICT" });
    assert.equal(source.store.read(created.index).disabledReason, "manual");
    const current = source.store.getMetadata(created.index);
    await source.enableAuth(created.index, { expectedStateVersion: current.stateVersion });
    const beforeReplacement = source.store.getMetadata(created.index);
    await source.replaceAuth(created.index, fixture("replacement@example.invalid"));
    await assert.rejects(
        source.removeAuth(created.index, { expectedCredentialVersion: beforeReplacement.credentialVersion }),
        { code: "VERSION_CONFLICT" }
    );
    assert.equal(source.store.read(created.index).accountName, "replacement@example.invalid");
});

test("metadata corruption fails closed rather than resetting durable identities and numbers", async () => {
    const env = setup();
    const store = env.store();
    await store.create(fixture());
    for (const corrupt of ["", "null", "{}", JSON.stringify({ accounts: [], highWater: -1, schemaVersion: 1 })]) {
        fs.writeFileSync(store.metadataPath, corrupt);
        assert.throws(() => env.store(), { code: "PERSISTENCE_ERROR" });
    }
});

(async () => {
    try {
        for (const { name, fn } of tests) {
            await fn();
            console.log(`PASS ${name}`);
        }
        console.log(`credentialStore: ${tests.length} scenarios passed (temporary fixtures only)`);
    } finally {
        for (const root of roots) fs.rmSync(root, { force: true, recursive: true });
    }
})().catch(cause => {
    console.error(cause);
    process.exitCode = 1;
});
