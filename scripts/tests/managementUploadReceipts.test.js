const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const CredentialStore = require("../../src/storage/CredentialStore");
const Tasks = require("../../src/management/ManagementTaskService");
const Accounts = require("../../src/management/ManagementAccountService");
const { VerificationError } = require("../../src/management/VerifierSupport");

const credentials = name => ({
    accountName: `${name}@example.invalid`,
    cookies: [
        {
            domain: ".example.invalid",
            expires: -1,
            httpOnly: true,
            name: "fixture",
            path: "/",
            sameSite: "None",
            secure: true,
            value: `SECRET-${name}`,
        },
    ],
    origins: [],
});
const success = input => ({
    authIndex: input.index,
    model: input.model,
    requestId: `verify-${input.index}`,
    stage: "model_verified",
    success: true,
    upstreamStatus: 200,
});
const verificationError = (input, stage) =>
    Object.assign(new VerificationError(stage), {
        authIndex: input.index,
        model: input.model,
        requestId: `verify-${input.index}`,
    });
const deferred = () => {
    let resolve;
    const promise = new Promise(done => {
        resolve = done;
    });
    return { promise, resolve };
};
async function finished(tasks, id) {
    const deadline = Date.now() + 3000;
    while (["queued", "running"].includes(tasks.get(id).status)) {
        if (Date.now() > deadline) throw new Error("Fixture task did not finish");
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    return tasks.get(id);
}
function fixture(t, verify = async input => success(input)) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "management-upload-"));
    const keys = new EventEmitter();
    keys.isActive = () => true;
    const env = { calls: 0, keys, rootDir };
    env.mount = () => {
        env.store = new CredentialStore({ rootDir });
        env.tasks = new Tasks({ keyStore: keys, rootDir });
        env.accounts = new Accounts(
            {
                authSource: { reloadAuthSources() {}, store: env.store },
                managementRuntime: {
                    blockAccount: () => () => {},
                    closeAccount: async () => {},
                    hasActiveRequests: () => false,
                    rebalance: async () => {},
                },
            },
            {
                keyStore: keys,
                taskService: env.tasks,
                verifier: {
                    verify: async input => {
                        env.calls++;
                        return verify(input);
                    },
                },
            }
        );
    };
    env.mount();
    env.submit = (kind, body, id) =>
        env.accounts.submit(kind, body, id, {
            idempotencyKey: `fixture-${Math.random()}`,
            keyId: "key-fixture",
            method: "POST",
            path: `/accounts/${id || kind}`,
            requestId: "req-fixture",
        });
    t.after(async () => {
        await env.tasks.close();
        assert.equal(path.dirname(rootDir), path.resolve(os.tmpdir()));
        assert(path.basename(rootDir).startsWith("management-upload-"));
        fs.rmSync(rootDir, { force: true, recursive: true });
    });
    return env;
}
const imported = (env, name = "alpha") =>
    env.submit("import", {
        items: [{ clientRef: name, credentials: credentials(name) }],
    });
const operation = (taskId, kind) => ({ itemIndex: 0, kind, taskId });

test("upload-only import commits enabled credentials without invoking verifier; test stays read-only", async t => {
    const env = fixture(t);
    const { taskId } = env.submit("import", {
        items: [{ clientRef: "alpha", credentials: credentials("alpha") }],
        verify: false,
    });
    env.tasks.start();
    const task = await finished(env.tasks, taskId);
    const item = task.items[0];
    assert.equal(task.status, "succeeded");
    assert.equal(env.calls, 0);
    assert.equal(item.upload.status, "committed");
    assert.deepEqual(item.result, {
        credentialVersion: item.upload.credentialVersion,
        stage: "uploaded",
        stateVersion: item.upload.stateVersion,
        success: true,
    });
    assert.equal(env.accounts.get(item.accountId).enabled, true);
    const tested = await finished(env.tasks, env.submit("test", {}, item.accountId).taskId);
    assert.equal(env.calls, 1);
    assert.equal(tested.items[0].result.stage, "model_verified");
    assert.equal(tested.items[0].upload, undefined);
    assert.equal(env.accounts.get(item.accountId).stateVersion, item.upload.stateVersion);
});

test("upload-only replace atomically enables a disabled account and keeps receipt and CAS", async t => {
    const env = fixture(t);
    const row = await env.store.create(credentials("alpha"), { disabled: true });
    assert.throws(() => env.submit("replace", { credentials: credentials("beta"), verify: false }, row.accountId), {
        code: "INVALID_REQUEST",
    });
    assert.equal(env.tasks.list().total, 0);
    const conflict = env.submit(
        "replace",
        {
            credentials: credentials("beta"),
            expectedCredentialVersion: row.credentialVersion,
            expectedStateVersion: row.stateVersion + 1,
            verify: false,
        },
        row.accountId
    );
    env.tasks.start();
    const failed = await finished(env.tasks, conflict.taskId);
    assert.equal(failed.items[0].error.code, "VERSION_CONFLICT");
    assert.equal(failed.items[0].upload, undefined);
    assert.equal(env.calls, 0);
    assert.equal(env.store.read(row.index).accountName, "alpha@example.invalid");
    const accepted = env.submit(
        "replace",
        {
            credentials: credentials("beta"),
            expectedCredentialVersion: row.credentialVersion,
            expectedStateVersion: row.stateVersion,
            verify: false,
        },
        row.accountId
    );
    const task = await finished(env.tasks, accepted.taskId);
    const item = task.items[0];
    assert.equal(task.status, "succeeded");
    assert.equal(env.calls, 0);
    assert.equal(item.upload.credentialVersion, row.credentialVersion + 1);
    assert.equal(item.upload.stateVersion, row.stateVersion + 1);
    assert.deepEqual(item.result, {
        credentialVersion: item.upload.credentialVersion,
        stage: "uploaded",
        stateVersion: item.upload.stateVersion,
        success: true,
    });
    assert.equal(env.accounts.get(row.accountId).enabled, true);
    assert.equal(env.store.read(row.index).accountName, "beta@example.invalid");
    assert.deepEqual(env.store.getUploadReceipt(operation(accepted.taskId, "replace")), item.upload);
});

test("queued pre-upgrade payloads without verify still run the legacy verifier path after restart", async t => {
    const env = fixture(t);
    const existing = await env.store.create(credentials("alpha"), { disabled: true });
    const importedTask = env.submit("import", {
        items: [{ clientRef: "beta", credentials: credentials("beta") }],
    });
    const replacedTask = env.submit("replace", credentials("gamma"), existing.accountId);
    for (const taskId of [importedTask.taskId, replacedTask.taskId]) {
        const inputPath = env.tasks._inputPath(taskId);
        const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
        delete input.payload.verify;
        fs.writeFileSync(inputPath, JSON.stringify(input));
    }
    await env.tasks.close();
    env.mount();
    env.tasks.start();
    const importedResult = await finished(env.tasks, importedTask.taskId);
    const replacedResult = await finished(env.tasks, replacedTask.taskId);
    assert.equal(importedResult.status, "succeeded");
    assert.equal(replacedResult.status, "succeeded");
    assert.equal(importedResult.items[0].result.stage, "model_verified");
    assert.equal(replacedResult.items[0].result.stage, "model_verified");
    assert.equal(env.calls, 2);
    assert.equal(env.accounts.get(importedResult.items[0].accountId).enabled, true);
    assert.equal(env.accounts.get(existing.accountId).enabled, false);
    assert.equal(env.store.read(existing.index).accountName, "gamma@example.invalid");
});

test("import publishes its committed upload while verification is running and preserves it on timeout", async t => {
    const entered = deferred(),
        release = deferred();
    const env = fixture(t, async input => {
        entered.resolve();
        await release.promise;
        throw verificationError(input, "timeout");
    });
    const { taskId } = imported(env);
    env.tasks.start();
    await entered.promise;
    const pending = env.tasks.get(taskId).items[0];
    assert.equal(pending.status, "running");
    assert.equal(pending.result, undefined);
    assert.equal(pending.upload.status, "committed");
    assert.equal(pending.upload.credentialVersion, 1);
    assert.equal(pending.upload.stateVersion, 1);
    assert.equal(env.accounts.get(pending.accountId).enabled, true);
    release.resolve();
    const task = await finished(env.tasks, taskId);
    assert.equal(task.status, "failed");
    assert.equal(task.items[0].error.code, "VERIFICATION_TIMEOUT");
    assert.equal(env.accounts.get(pending.accountId).enabled, true);
    assert.equal(task.items[0].result.success, false);
    assert.deepEqual(task.items[0].upload, pending.upload);
    assert.equal(task.result.changed, true);
    assert.deepEqual(task.result.accountIds, [pending.accountId]);
    assert.equal(env.store.listMetadata().length, 1);
    assert(!/SECRET|cookies|origins|credentialHash|operationId/.test(JSON.stringify(task)));
});

test("cancelled import retains the committed upload and its enabled state", async t => {
    const entered = deferred();
    const env = fixture(
        t,
        input =>
            new Promise((resolve, reject) => {
                input.signal.addEventListener("abort", () => reject(verificationError(input, "cancelled")), {
                    once: true,
                });
                entered.resolve();
            })
    );
    const { taskId } = imported(env);
    env.tasks.start();
    await entered.promise;
    const receipt = env.tasks.get(taskId).items[0].upload;
    env.tasks.cancel(taskId);
    const task = await finished(env.tasks, taskId);
    assert.equal(task.status, "cancelled");
    assert.deepEqual(task.items[0].upload, receipt);
    assert.equal(env.accounts.get(receipt.accountId).enabled, true);
});

test("replace failure has no new receipt; successful replacement records only its own committed version", async t => {
    let rejectCandidate = true;
    const env = fixture(t, async input => {
        if (rejectCandidate) throw verificationError(input, "timeout");
        return success(input);
    });
    const row = await env.store.create(credentials("alpha"), { disabled: true });
    const failed = env.submit("replace", credentials("beta"), row.accountId);
    env.tasks.start();
    const task = await finished(env.tasks, failed.taskId);
    assert.equal(task.status, "failed");
    assert.equal(task.items[0].upload, undefined);
    assert.equal(env.store.getUploadReceipt(operation(failed.taskId, "replace")), null);
    assert.equal(env.store.read(row.index).accountName, "alpha@example.invalid");
    assert.equal(env.accounts.get(row.accountId).credentialVersion, 1);
    rejectCandidate = false;
    const replaced = env.submit("replace", credentials("beta"), row.accountId);
    const replacement = await finished(env.tasks, replaced.taskId);
    assert.equal(replacement.status, "succeeded");
    assert.equal(replacement.items[0].upload.credentialVersion, 2);
    assert.equal(replacement.items[0].upload.stateVersion, row.stateVersion);
    assert.equal(replacement.items[0].result.success, true);
    assert.equal(env.accounts.get(row.accountId).enabled, false);
    await env.store.replace(row.index, credentials("gamma"));
    assert.equal(env.store.getUploadReceipt(operation(replaced.taskId, "replace")).credentialVersion, 2);
});

test("upload, verification and subsequent quota disable have independent immutable evidence", async t => {
    const env = fixture(t);
    const { taskId } = imported(env);
    env.tasks.start();
    const task = await finished(env.tasks, taskId);
    const item = task.items[0];
    assert.equal(item.upload.stateVersion, 1);
    assert.equal(item.result.stateVersion, 1);
    assert.equal(item.result.success, true);
    await env.store.updateState(item.index, { disabled: true, disabledReason: "quota_exhausted", disabledStatus: 429 });
    assert.deepEqual(env.tasks.get(taskId).items[0], item);
    assert.equal(env.accounts.get(item.accountId).disabledStatus, 429);
    const testTask = env.submit("test", {}, item.accountId);
    const tested = await finished(env.tasks, testTask.taskId);
    assert.equal(tested.items[0].upload, undefined);
    assert.equal(tested.items[0].result.success, true);
    assert.equal(env.accounts.get(item.accountId).enabled, false);
});

test("manual state change during candidate verification prevents replacement and its upload receipt", async t => {
    const env = fixture(t, async input => {
        await env.store.updateState(input.index, { disabled: true, disabledReason: "manual" });
        return success(input);
    });
    const row = await env.store.create(credentials("alpha"));
    const { taskId } = env.submit("replace", credentials("beta"), row.accountId);
    env.tasks.start();
    const task = await finished(env.tasks, taskId);
    assert.equal(task.items[0].error.code, "VERSION_CONFLICT");
    assert.equal(task.items[0].upload, undefined);
    assert.equal(env.store.getUploadReceipt(operation(taskId, "replace")), null);
    assert.equal(env.store.read(row.index).accountName, "alpha@example.invalid");
    assert.equal(env.accounts.get(row.accountId).disabledReason, "manual");
});

test("the same operation cannot overwrite its receipt or commit another credential version", async t => {
    const env = fixture(t);
    const { taskId } = imported(env);
    const uploadOperation = operation(taskId, "import");
    const row = await env.store.create(credentials("alpha"), { uploadOperation });
    const original = env.store.getUploadReceipt(uploadOperation);
    await assert.rejects(env.store.create(credentials("beta"), { uploadOperation }), { code: "PERSISTENCE_ERROR" });
    await assert.rejects(
        env.store.replace(row.index, credentials("beta"), {
            uploadOperation: { ...uploadOperation, kind: "replace" },
        }),
        { code: "PERSISTENCE_ERROR" }
    );
    assert.deepEqual(env.store.getUploadReceipt(uploadOperation), original);
    assert.equal(env.store.listMetadata().length, 1);
    assert.equal(env.store.getMetadata(row.index).credentialVersion, 1);
    assert.equal(env.store.read(row.index).accountName, "alpha@example.invalid");
});

for (const kind of ["import", "replace"]) {
    test(`${kind}: restart recovers the commit-to-task gap without using later versions or invoking the model`, async t => {
        const env = fixture(t);
        const row = kind === "replace" ? await env.store.create(credentials("alpha")) : null;
        const { taskId } = kind === "import" ? imported(env) : env.submit(kind, credentials("beta"), row.accountId);
        const snapshot = env.tasks.state.tasks.find(task => task.taskId === taskId);
        snapshot.status = "running";
        snapshot.items[0].status = "running";
        env.tasks._persist();
        const uploadOperation = operation(taskId, kind);
        const committed =
            kind === "import"
                ? await env.store.create(credentials("alpha"), { disabled: true, uploadOperation })
                : await env.store.replace(row.index, credentials("beta"), { uploadOperation });
        const receipt = env.store.getUploadReceipt(uploadOperation);
        await env.store.replace(committed.index, credentials("later"));
        // Simulated process restart: the disk task has no account identity for import and no upload field.
        env.mount();
        const recovered = env.tasks.get(taskId);
        assert.equal(recovered.status, "interrupted");
        assert.equal(recovered.items[0].status, "interrupted");
        assert.deepEqual(recovered.items[0].upload, receipt);
        assert.deepEqual(recovered.result.accountIds, [committed.accountId]);
        assert.equal(recovered.result.changed, true);
        assert.equal(recovered.items[0].result, undefined);
        assert.equal(env.store.getMetadata(committed.index).credentialVersion, receipt.credentialVersion + 1);
        assert.equal(env.calls, 0);
        assert.equal(fs.readdirSync(env.tasks.privateDir).length, 0);
        env.mount();
        assert.deepEqual(env.tasks.get(taskId).items[0].upload, receipt);
        assert.equal(env.store.listMetadata().length, 1);
    });
}

test("stale queued snapshot with a commit is interrupted rather than replayed", async t => {
    const env = fixture(t);
    const { taskId } = imported(env);
    await env.store.create(credentials("alpha"), { uploadOperation: operation(taskId, "import") });
    env.mount();
    env.tasks.start();
    const task = await finished(env.tasks, taskId);
    assert.equal(task.status, "interrupted");
    assert.equal(task.items[0].upload.status, "committed");
    assert.equal(env.calls, 0);
    assert.equal(env.store.listMetadata().length, 1);
});

test("legacy task with only an account binding cannot acquire a fabricated upload receipt", async t => {
    const env = fixture(t);
    const row = await env.store.create(credentials("alpha"));
    const { taskId } = env.submit("replace", credentials("beta"), row.accountId);
    const task = env.tasks.state.tasks.find(item => item.taskId === taskId);
    task.status = "failed";
    task.items[0].status = "failed";
    env.tasks._persist();
    await env.store.replace(row.index, credentials("beta"));
    env.mount();
    assert.equal(env.tasks.get(taskId).items[0].upload, undefined);
    assert.equal(env.calls, 0);
});

test("task retention does not delete committed credential evidence", async t => {
    const env = fixture(t);
    const { taskId } = imported(env);
    env.tasks.start();
    const completed = await finished(env.tasks, taskId);
    const receipt = completed.items[0].upload;
    await env.tasks.close();
    const task = env.tasks.state.tasks.find(item => item.taskId === taskId);
    task.finishedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    env.tasks._persist();
    env.mount();
    assert.throws(() => env.tasks.get(taskId), { code: "NOT_FOUND" });
    assert.deepEqual(env.store.getUploadReceipt(operation(taskId, "import")), receipt);
    assert.equal(env.calls, 1);
});

for (const kind of ["import", "replace"]) {
    test(`${kind}: restart rolls back credential bytes and upload evidence together after an unfinished journal`, async t => {
        const env = fixture(t);
        const row = kind === "replace" ? await env.store.create(credentials("alpha")) : null;
        const { taskId } = kind === "import" ? imported(env) : env.submit(kind, credentials("beta"), row.accountId);
        const uploadOperation = operation(taskId, kind);
        const write = env.store._atomicWrite.bind(env.store);
        env.store._atomicWrite = (file, text) => {
            write(file, text);
            if (file === env.store.metadataPath && JSON.parse(text).uploadReceipts?.[`${taskId}:0`]) {
                throw new Error("fixture crash after metadata write, before journal removal");
            }
        };
        env.store._recover = () => {
            throw new Error("fixture process stopped");
        };
        await assert.rejects(
            kind === "import"
                ? env.store.create(credentials("alpha"), { uploadOperation })
                : env.store.replace(row.index, credentials("beta"), { uploadOperation }),
            { code: "PERSISTENCE_ERROR" }
        );
        assert.equal(fs.existsSync(env.store.journalPath), true);
        env.mount();
        assert.equal(env.store.getUploadReceipt(uploadOperation), null);
        assert.equal(env.tasks.get(taskId).items[0].upload, undefined);
        assert.equal(fs.existsSync(env.store.journalPath), false);
        if (row) {
            assert.equal(env.store.read(row.index).accountName, "alpha@example.invalid");
            assert.equal(env.store.getMetadata(row.index).credentialVersion, 1);
        } else assert.equal(env.store.listMetadata().length, 0);
    });
}

test("a failure immediately after committed create is still reported with upload evidence", async t => {
    const env = fixture(t);
    const create = env.store.create.bind(env.store);
    env.store.create = async (...args) => {
        await create(...args);
        throw new Error("fixture failure between commit and callback");
    };
    const { taskId } = imported(env);
    env.tasks.start();
    const task = await finished(env.tasks, taskId);
    assert.equal(task.status, "failed");
    assert.equal(task.items[0].upload.status, "committed");
    assert.equal(task.result.changed, true);
    assert.equal(env.calls, 0);
    assert.equal(env.accounts.get(task.items[0].accountId).enabled, true);
});

test("quota disable during import verification is not undone by a successful model response", async t => {
    const env = fixture(t, async input => {
        assert.equal(env.accounts.get(env.store.getMetadata(input.index).accountId).enabled, true);
        await env.store.updateState(input.index, {
            disabled: true,
            disabledReason: "quota_exhausted",
            disabledStatus: 429,
        });
        return success(input);
    });
    const { taskId } = imported(env);
    env.tasks.start();
    const task = await finished(env.tasks, taskId);
    const item = task.items[0];
    assert.equal(item.upload.status, "committed");
    assert.equal(item.error.code, "VERSION_CONFLICT");
    assert.equal(env.accounts.get(item.accountId).enabled, false);
    assert.equal(env.accounts.get(item.accountId).disabledStatus, 429);
});
