const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { fork, spawn } = require("node:child_process");
const { MODEL, sourceDigest, validateEvidence } = require("./live/evidence");

const ROOT = path.resolve(__dirname, "../..");
const BASE = "http://127.0.0.1:7860";
const API = "/api/manage/v1";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const token = () => crypto.randomBytes(32).toString("base64url");

function selectArtifacts(managerRoot) {
    const candidates = [];
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.name === "auth-state.enc.json") {
                const bytes = fs.readFileSync(file);
                const envelope = JSON.parse(bytes);
                assert.equal(envelope.algorithm, "AES-256-GCM");
                const id = envelope.metadata?.account_id;
                assert.ok(Number.isSafeInteger(id));
                candidates.push({ artifact: file, id, mtime: fs.statSync(file).mtimeMs, sha256: digest(bytes) });
            }
        }
    };
    walk(path.join(managerRoot, "runtime/devices"));
    const seen = new Set();
    return candidates
        .sort((a, b) => b.mtime - a.mtime || a.artifact.localeCompare(b.artifact))
        .filter(row => {
            if (seen.has(row.id)) return false;
            seen.add(row.id);
            return true;
        })
        .slice(0, 2)
        .map((row, index) => ({ ...row, label: index ? "B" : "A" }));
}

function request(method, endpoint, { body, key, cookie, headers = {}, onChunk } = {}) {
    assert.ok(endpoint.startsWith("/") && !endpoint.startsWith("//"));
    const raw = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                agent: false,
                headers: {
                    ...(raw ? { "Content-Length": Buffer.byteLength(raw), "Content-Type": "application/json" } : {}),
                    ...(key ? { Authorization: `Bearer ${key}` } : {}),
                    ...(cookie ? { Cookie: cookie } : {}),
                    ...headers,
                },
                host: "127.0.0.1",
                method,
                path: endpoint,
                port: 7860,
            },
            res => {
                // Never follow redirects, even after login.
                let text = "";
                res.setEncoding("utf8");
                res.on("data", chunk => {
                    text += chunk;
                    onChunk?.(chunk);
                    if (text.length > 4 * 1024 * 1024) req.destroy(new Error("RESPONSE_TOO_LARGE"));
                });
                res.on("error", reject);
                res.on("end", () => {
                    let data;
                    try {
                        data = JSON.parse(text);
                    } catch {
                        /* Login and SSE are not JSON. */
                    }
                    resolve({ body: data, headers: res.headers, status: res.statusCode, text });
                });
            }
        );
        req.setTimeout(650000, () => req.destroy(new Error("LOCAL_HTTP_TIMEOUT")));
        req.on("error", reject);
        req.end(raw);
    });
}

function bridge(python, managerRoot, row, action, extra = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(python, [path.join(__dirname, "live/credentialBridge.py")], {
            cwd: managerRoot,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        let output = "";
        const timer = setTimeout(() => child.kill(), action === "diagnose" ? 150000 : 60000);
        child.stdout.on("data", data => {
            output += data;
        });
        child.stderr.resume(); // Library output is not trusted to be credential-free.
        child.on("error", reject);
        child.on("exit", code => {
            clearTimeout(timer);
            try {
                const result = JSON.parse(output);
                if (code !== 0 || !result.ok)
                    throw Object.assign(new Error("CREDENTIAL_BRIDGE_FAILED"), { code: result.errorType });
                resolve(result.result);
            } catch (error) {
                reject(error);
            }
        });
        child.stdin.end(
            JSON.stringify({
                action,
                artifact: row.artifact,
                baseUrl: BASE,
                label: row.label,
                managerRoot,
                sha256: row.sha256,
                ...extra,
            })
        );
    });
}

async function freePort(port) {
    await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on("error", () => reject(new Error(`PORT_${port}_OCCUPIED`)));
        server.listen(port, "127.0.0.1", () => server.close(resolve));
    });
}

async function run(options) {
    assert.equal(options["base-url"], BASE, "Explicit --base-url must be http://127.0.0.1:7860");
    const managerRoot = path.resolve(options["manager-root"]);
    const python = path.resolve(options.python || path.join(managerRoot, ".venv/Scripts/python.exe"));
    const executablePath = path.resolve(options.browser || path.join(ROOT, "camoufox/camoufox.exe"));
    const taskTimeoutMs = Number(options["task-timeout-ms"] || 600000);
    assert.ok(Number.isInteger(taskTimeoutMs) && taskTimeoutMs >= 30000 && taskTimeoutMs <= 600000);
    const parent = path.join(ROOT, "data/management-live");
    fs.mkdirSync(parent, { recursive: true });
    const runRoot = fs.mkdtempSync(path.join(parent, "run-"));
    const evidencePath = path.join(runRoot, "events.jsonl");
    const report = {
        accounts: [],
        attempts: 0,
        baseUrl: BASE,
        checks: {},
        kind: "management-live",
        mocked: false,
        model: MODEL,
        runId: path.basename(runRoot),
        schemaVersion: 1,
        sourceDigest: sourceDigest(ROOT),
        startedAt: new Date().toISOString(),
        status: "running",
    };
    const event = (name, data = {}) => {
        const entry = { at: new Date().toISOString(), event: name, ...data };
        fs.appendFileSync(evidencePath, JSON.stringify(entry) + "\n", { mode: 0o600 });
        console.log(JSON.stringify(entry));
    };
    let selected = [];
    let worker,
        workerStopped = true,
        workerFatal,
        cookie,
        admin,
        readonly;
    const ownedRoots = [];
    const password = token(),
        modelKey = token();
    const createdKeys = [];
    const waiters = new Map();
    const start = async (directory, preflight = false) => {
        await freePort(7860);
        await freePort(9998);
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(path.join(directory, "configs"), { recursive: true });
            fs.copyFileSync(path.join(ROOT, "configs/models.json"), path.join(directory, "configs/models.json"));
            ownedRoots.push(directory);
        }
        workerFatal = null;
        workerStopped = false;
        worker = fork(path.join(__dirname, "live/serverWorker.js"), [], { silent: true, windowsHide: true });
        worker.stdout.resume();
        worker.stderr.resume();
        const started = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("STARTUP_TIMEOUT")), 180000);
            worker.on("error", reject);
            worker.on("message", message => {
                if (message.event === "generation_attempt") report.attempts++;
                if (message.event === "worker_error") {
                    workerFatal = message.code;
                    clearTimeout(timer);
                    reject(new Error(message.code));
                }
                if (message.event === "started") {
                    clearTimeout(timer);
                    resolve();
                }
                if (message.event === "snapshot") {
                    waiters.get(message.id)?.(message);
                    waiters.delete(message.id);
                    return;
                }
                if (message.event === "stopped") workerStopped = true;
                event(message.event, Object.fromEntries(Object.entries(message).filter(([key]) => key !== "event")));
            });
            worker.on("exit", () => {
                clearTimeout(timer);
                if (!workerStopped) {
                    workerFatal = "WORKER_EXIT";
                    reject(new Error(workerFatal));
                }
            });
        });
        worker.send({
            budget: 12 - report.attempts,
            command: "start",
            executablePath,
            modelKey,
            password,
            preflight,
            root: directory,
        });
        await started;
    };
    const stop = async () => {
        if (!worker || worker.exitCode !== null) return;
        const exited = new Promise(resolve => worker.once("exit", resolve));
        worker.send({ command: "stop" });
        let timer;
        try {
            await Promise.race([
                exited,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error("CLEANUP_TIMEOUT")), 60000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
        assert.ok(workerStopped, "Owned resources did not confirm cleanup");
    };
    const call = (method, endpoint, body, extra = {}) =>
        request(method, API + endpoint, { body, key: admin?.token, ...extra });
    const expect = (response, status) => {
        assert.equal(
            response.status,
            status,
            `Unexpected local HTTP ${response.status}, code=${response.body?.error?.code}`
        );
        return response.body?.data;
    };
    const login = async () => {
        const response = await request("POST", "/login", { body: { password } });
        assert.equal(response.status, 302);
        cookie = response.headers["set-cookie"].map(value => value.split(";")[0]).join("; ");
    };
    const mint = async scopes => {
        const result = expect(
            await request("POST", "/api/management-keys", {
                body: { name: "local-live", scopes },
                cookie,
                headers: { Origin: BASE, "X-Requested-With": "XMLHttpRequest" },
            }),
            201
        );
        createdKeys.push(result.key.id);
        return result;
    };
    const setupKeys = async () => {
        await login();
        admin = await mint(require("../../src/management/ManagementKeyStore").SCOPES);
        readonly = await mint(["accounts:read"]);
    };
    const account = async id => expect(await call("GET", `/accounts/${id}`), 200);
    const waitTask = async (id, label) => {
        const deadline = Date.now() + taskTimeoutMs;
        let previous;
        while (Date.now() < deadline) {
            if (workerFatal) throw new Error(workerFatal);
            const task = expect(await call("GET", `/tasks/${id}`), 200);
            const safe = {
                items: task.items.map(item => ({
                    accountId: item.accountId,
                    errorCode: item.error?.code,
                    index: item.index,
                    stage: item.stage,
                    status: item.status,
                    verification: item.result,
                })),
                label,
                status: task.status,
                taskId: id,
            };
            const signature = JSON.stringify(safe);
            if (signature !== previous) {
                event("task_progress", safe);
                previous = signature;
            }
            if (["succeeded", "failed", "partial", "cancelled", "interrupted"].includes(task.status)) return task;
            await pause(2000);
        }
        // The verifier's deadline can expire between the last poll and ours.
        // Read the final result before cancellation; one failed account must not
        // prevent the second fixed account from receiving its independent test.
        const final = expect(await call("GET", `/tasks/${id}`), 200);
        if (["succeeded", "failed", "partial", "cancelled", "interrupted"].includes(final.status)) {
            event("task_progress", {
                items: final.items.map(item => ({
                    accountId: item.accountId,
                    errorCode: item.error?.code,
                    index: item.index,
                    stage: item.stage,
                    status: item.status,
                    verification: item.result,
                })),
                label,
                status: final.status,
                taskId: id,
            });
            return final;
        }
        expect(await call("POST", `/tasks/${id}/cancel`, {}), 200);
        event("task_deadline_cancel", { label, taskId: id, taskTimeoutMs });
        // Cancellation is cooperative: let the server finish its owned cleanup.
        for (let i = 0; i < 10; i++) {
            await pause(1000);
            const cancelled = expect(await call("GET", `/tasks/${id}`), 200);
            if (["failed", "cancelled", "interrupted"].includes(cancelled.status)) {
                event("task_progress", {
                    items: cancelled.items.map(item => ({
                        accountId: item.accountId,
                        errorCode: item.error?.code,
                        index: item.index,
                        stage: item.stage,
                        status: item.status,
                        verification: item.result,
                    })),
                    label,
                    status: cancelled.status,
                    taskId: id,
                });
                return cancelled;
            }
        }
        throw new Error("TASK_CLEANUP_TIMEOUT");
    };
    const submit = async (endpoint, body, label) => {
        const accepted = expect(await call("POST", endpoint, body, { headers: { "Idempotency-Key": token() } }), 202);
        return waitTask(accepted.taskId, label);
    };
    const importRow = async (row, stage) => {
        const key = `${report.runId}-${stage}-${row.label}`;
        const admission = await bridge(python, managerRoot, row, "import", { idempotencyKey: key, token: admin.token });
        assert.equal(admission.httpStatus, 202, admission.errorCode);
        const task = await waitTask(admission.taskId, row.label);
        const item = task.items[0];
        const record = report.accounts.find(value => value.label === row.label);
        record[`${stage}TaskId`] = task.taskId;
        record[stage] = item.result || { stage: item.stage, success: false };
        record[`${stage}AccountId`] = item.accountId;
        const state = item.accountId ? await account(item.accountId) : null;
        if (state)
            record[`${stage}State`] = {
                accountId: state.accountId,
                credentialVersion: state.credentialVersion,
                enabled: state.enabled,
                index: state.index,
                stateVersion: state.stateVersion,
            };
        record[stage === "import" ? "autoEnabled" : "replayEnabled"] = state?.enabled === true;
        if (task.status === "succeeded") {
            assert.equal(item.result?.stage, "model_verified");
            assert.equal(item.result.authIndex, state.index);
            assert.equal(state.enabled, true);
        } else {
            assert.notEqual(state?.enabled, true, "Failed import must not enable account");
        }
        if (stage === "import") {
            const before = report.attempts;
            const replay = await bridge(python, managerRoot, row, "import", {
                idempotencyKey: key,
                token: admin.token,
            });
            assert.equal(replay.taskId, task.taskId);
            assert.equal(report.attempts, before);
            const conflict = await bridge(python, managerRoot, row, "import", {
                idempotencyKey: key,
                label: `${row.label}-different-payload`,
                token: admin.token,
            });
            assert.equal(conflict.httpStatus, 409);
            assert.equal(conflict.errorCode, "IDEMPOTENCY_CONFLICT");
            assert.equal(report.attempts, before);
        }
        return task.status === "succeeded";
    };
    const setEnabled = async (record, enabled) =>
        expect(await call("PATCH", `/accounts/${record.importAccountId}`, { enabled }), 200);
    const snapshot = () =>
        new Promise((resolve, reject) => {
            const id = token();
            const timer = setTimeout(() => {
                waiters.delete(id);
                reject(new Error("SNAPSHOT_TIMEOUT"));
            }, 10000);
            waiters.set(id, message => {
                clearTimeout(timer);
                resolve(message);
            });
            worker.send({ command: "snapshot", id }, error => {
                if (!error) return;
                clearTimeout(timer);
                waiters.delete(id);
                reject(new Error("SNAPSHOT_FAILED"));
            });
        });
    const modelCall = async (record, stream, during) => {
        for (const other of report.accounts.filter(row => row.importAccountId)) await setEnabled(other, false);
        await setEnabled(record, true);
        const startAttempts = report.attempts;
        const before = await snapshot();
        const known = new Set(before.records.map(row => row.requestId));
        let firstChunkResolve;
        const firstChunk = new Promise(resolve => {
            firstChunkResolve = resolve;
        });
        let completed = false;
        const responsePromise = request("POST", "/v1/chat/completions", {
            body: {
                max_tokens: during ? 512 : 64,
                messages: [
                    {
                        content: during ? "Write the numbers 1 through 150 separated by spaces." : "Reply exactly OK.",
                        role: "user",
                    },
                ],
                model: MODEL,
                stream,
            },
            key: modelKey,
            onChunk: () => firstChunkResolve(),
        }).finally(() => {
            completed = true;
            firstChunkResolve();
        });
        // Attach a rejection handler before a concurrent management operation.
        // Its failure must not leave an unobserved model request behind.
        let responseError;
        const settledResponse = responsePromise.catch(error => {
            responseError = error;
        });
        try {
            if (during) {
                await firstChunk;
                if (completed) throw new Error("ISOLATION_NO_OVERLAP");
                await during(() => completed);
            }
        } catch (error) {
            await settledResponse;
            throw error;
        }
        const response = await settledResponse;
        if (responseError) throw responseError;
        assert.equal(response.status, 200);
        let content;
        if (stream) {
            assert.ok(response.text.includes("[DONE]"));
            content = response.text
                .split(/\r?\n/)
                .filter(line => line.startsWith("data: ") && !line.includes("[DONE]"))
                .map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || "")
                .join("");
        } else content = response.body?.choices?.[0]?.message?.content;
        assert.ok(typeof content === "string" && content.trim());
        await pause(300);
        const records = (await snapshot()).records.filter(row => !known.has(row.requestId));
        assert.equal(records.length, 1);
        assert.equal(records[0].finalAuthIndex, record.import.authIndex);
        assert.equal(records[0].initialAuthIndex, record.import.authIndex);
        assert.equal(records[0].attemptCount, 1);
        assert.equal(report.attempts - startAttempts, 1);
        const result = {
            attemptCount: 1,
            index: records[0].finalAuthIndex,
            requestId: records[0].requestId,
            responseChars: content.length,
            stream,
            success: true,
        };
        event("model_api", { label: record.label, ...result });
        return result;
    };
    try {
        assert.ok(fs.existsSync(executablePath), "CAMOUFOX_MISSING");
        selected = selectArtifacts(managerRoot);
        assert.equal(selected.length, 2);
        for (const row of selected) {
            const info = await bridge(python, managerRoot, row, "preflight");
            report.accounts.push({ artifactSha256: row.sha256, identityHash: info.identityHash, label: row.label });
            event("credential_preflight", { label: row.label, ...info });
        }
        assert.notEqual(report.accounts[0].identityHash, report.accounts[1].identityHash);
        const firstRoot = path.join(runRoot, "instance-1");
        await start(firstRoot, true);
        await setupKeys();
        const beforeAuth = report.attempts;
        expect(await call("GET", "/accounts", undefined, { key: modelKey }), 401);
        expect(await request("GET", "/v1/models", { key: admin.token }), 401);
        expect(await request("GET", API + "/accounts"), 401);
        expect(await call("POST", "/accounts/import", { items: [] }, { key: readonly.token }), 403);
        assert.equal(report.attempts, beforeAuth);
        report.checks.auth = true;
        // Keep retry cost and background polling bounded through supported settings.
        expect(await call("PATCH", "/settings", { checkUpdate: false, maxRetries: 1 }), 200);
        for (const row of selected) {
            if (!(await importRow(row, "import"))) continue;
            const record = report.accounts.find(value => value.label === row.label);
            const test = await submit(
                `/accounts/${record.importAccountId}/test`,
                { mode: "model", model: MODEL },
                row.label
            );
            record.verify = test.items[0].result;
            record.verifyTaskId = test.taskId;
            if (test.status !== "succeeded") {
                record.halted = true;
                continue;
            }
            assert.equal(record.verify.authIndex, record.import.authIndex);
            record.modelApi = await modelCall(record, row.label === "B");
        }
        const allPassed = report.accounts.every(row => row.modelApi?.success);
        expect(await call("GET", "/accounts?limit=1"), 200);
        const conflict = await call(
            "POST",
            "/accounts/import",
            { items: [], model: MODEL },
            {
                headers: { "Idempotency-Key": `${report.runId}-import-A` },
            }
        );
        // Invalid payload is rejected before idempotency lookup, and cannot mutate state.
        assert.equal(conflict.status, 400);
        report.checks.management = true;
        if (allPassed) {
            const [a, b] = report.accounts;
            await modelCall(a, true, async done => {
                const admission = expect(
                    await call(
                        "POST",
                        `/accounts/${b.importAccountId}/test`,
                        { mode: "connection" },
                        { headers: { "Idempotency-Key": token() } }
                    ),
                    202
                );
                assert.ok(!done(), "ISOLATION_NO_OVERLAP");
                await setEnabled(b, false);
                const connection = await waitTask(admission.taskId, "B-connection");
                assert.equal(connection.status, "succeeded");
                assert.equal(connection.items[0].result?.authIndex, b.import.authIndex);
                // A must still be running after B actually finished validation,
                // not merely when B's queued task received its HTTP 202.
                assert.ok(!done(), "ISOLATION_NO_OVERLAP");
                event("isolation_overlap", { targetIndex: b.import.authIndex, taskId: admission.taskId });
            });
            report.checks.isolation = true;
        }
        const beforeRestart = expect(await call("GET", "/accounts"), 200).items;
        const tasksBefore = [];
        for (const record of report.accounts)
            for (const taskId of [record.importTaskId, record.verifyTaskId].filter(Boolean))
                tasksBefore.push(expect(await call("GET", `/tasks/${taskId}`), 200));
        expect(await call("PATCH", "/settings", { maxRetries: 2 }), 200);
        await stop();
        await start(firstRoot);
        const restored = expect(await call("GET", "/accounts"), 200).items;
        assert.deepEqual(
            restored.map(a => [a.accountId, a.enabled, a.credentialVersion, a.stateVersion]),
            beforeRestart.map(a => [a.accountId, a.enabled, a.credentialVersion, a.stateVersion])
        );
        for (const task of tasksBefore) assert.deepEqual(expect(await call("GET", `/tasks/${task.taskId}`), 200), task);
        assert.equal(expect(await call("GET", "/settings"), 200).values.maxRetries, 2);
        report.checks.restart = true;
        await login();
        for (const id of createdKeys.splice(0))
            expect(
                await request("DELETE", `/api/management-keys/${id}`, {
                    cookie,
                    headers: { Origin: BASE, "X-Requested-With": "XMLHttpRequest" },
                }),
                200
            );
        await stop();
        if (allPassed) {
            await start(path.join(runRoot, "instance-2"));
            await setupKeys();
            for (const row of selected) await importRow(row, "replay");
        }
        report.status = allPassed && report.accounts.every(row => row.replay?.success) ? "passed" : "partial_or_failed";
    } catch (error) {
        report.status = "blocked_or_failed";
        report.failure = {
            code: error.code || error.message?.match(/^[A-Z_0-9]+$/)?.[0] || "ASSERTION_OR_RUNTIME_FAILURE",
            errorType: error.name,
        };
        event("run_failure", report.failure);
    } finally {
        let revokeFailed = false;
        try {
            if (worker && worker.exitCode === null && !workerFatal) {
                await login();
                for (const id of createdKeys.splice(0))
                    expect(
                        await request("DELETE", `/api/management-keys/${id}`, {
                            cookie,
                            headers: { Origin: BASE, "X-Requested-With": "XMLHttpRequest" },
                        }),
                        200
                    );
            }
        } catch (error) {
            revokeFailed = true;
            event("key_revoke_failed", { errorType: error.name });
        }
        try {
            // Always close owned processes, including after a revocation error.
            await stop();
            // Delete only the exact directories created by this run after owned processes exit.
            for (const directory of ownedRoots) {
                assert.equal(path.dirname(path.resolve(directory)), path.resolve(runRoot));
                assert.ok(/^instance-[12]$/.test(path.basename(directory)));
                assert.equal(fs.realpathSync(directory), path.resolve(directory));
                fs.rmSync(directory, { force: true, recursive: true });
            }
            report.checks.cleanup = true;
            if (revokeFailed) {
                report.checks.cleanup = false;
                report.status = "cleanup_failed";
            }
        } catch (error) {
            report.status = "cleanup_failed";
            event("cleanup_failed", { errorType: error.name });
        }
        report.finishedAt = new Date().toISOString();
        report.sourceFilesUnchanged =
            selected.length === 2 && selected.every(row => digest(fs.readFileSync(row.artifact)) === row.sha256);
        if (!report.sourceFilesUnchanged) report.status = "source_artifact_changed";
        if (report.status === "passed") {
            try {
                validateEvidence(report, ROOT);
            } catch {
                report.status = "incomplete_evidence";
            }
        }
        report.eventsSha256 = digest(fs.readFileSync(evidencePath));
        fs.writeFileSync(path.join(runRoot, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
        console.log(
            JSON.stringify({
                attempts: report.attempts,
                report: path.join(runRoot, "result.json"),
                status: report.status,
            })
        );
    }
    return report.status === "passed" ? 0 : 1;
}

if (require.main === module) {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
        assert.ok(process.argv[i].startsWith("--") && process.argv[i + 1], "Use --name value arguments");
        options[process.argv[i].slice(2)] = process.argv[i + 1];
    }
    if (options.diagnose === "true") {
        const managerRoot = path.resolve(options["manager-root"]);
        assert.equal(options["base-url"], BASE);
        const python = path.resolve(options.python || path.join(managerRoot, ".venv/Scripts/python.exe"));
        const browser = path.resolve(options.browser || path.join(ROOT, "camoufox/camoufox.exe"));
        (async () => {
            await freePort(7860);
            await freePort(9998);
            const diagnoses = [];
            for (const row of selectArtifacts(managerRoot)) {
                const facts = await bridge(python, managerRoot, row, "diagnose", {
                    advanceEntry: options["advance-entry"] === "true",
                    browser,
                    ...(options.screenshot === "true"
                        ? { screenshot: path.join(ROOT, "data/management-live", `diagnosis-${row.label}.png`) }
                        : {}),
                });
                const diagnosis = { event: "page_diagnosis", label: row.label, ...facts };
                diagnoses.push(diagnosis);
                console.log(JSON.stringify(diagnosis));
            }
            const directory = path.join(ROOT, "data/management-live");
            fs.mkdirSync(directory, { recursive: true });
            const file = path.join(directory, `diagnosis-${Date.now()}.json`);
            fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), diagnoses }, null, 2), {
                mode: 0o600,
            });
            console.log(JSON.stringify({ diagnosticReport: file }));
        })().catch(error => {
            console.error(JSON.stringify({ code: error.code, errorType: error.name, event: "diagnosis_failed" }));
            process.exitCode = 1;
        });
    } else
        run(options)
            .then(code => {
                process.exitCode = code;
            })
            .catch(error => {
                console.error(JSON.stringify({ errorType: error.name, event: "entry_failed" }));
                process.exitCode = 1;
            });
}
module.exports = { request, selectArtifacts };
