const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const ManagementVerifier = require("./ManagementVerifier");
const { atomicWrite, clone, failure, object } = require("./ManagementSupport");
const { VerificationError } = require("./VerifierSupport");

const MODEL = "gemini-3.8-flash";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const active = run => run?.status === "running";
const now = () => new Date().toISOString();
const email = value => typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const interruptRows = (run, errorCode) => {
    for (const row of run.results) {
        if (row.state === "pending" && run.stopRequested) {
            Object.assign(row, { errorCode: null, stage: "unexecuted", state: "unexecuted" });
        } else if (["pending", "running"].includes(row.state)) {
            Object.assign(row, { errorCode, stage: "interrupted", state: "interrupted" });
        }
    }
};

// Console jobs have their own verifier queue; management API jobs cannot consume
// their per-account deadline. Only public results, never credentials, are persisted.
class CredentialTestService {
    constructor(system, { rootDir = process.cwd(), verifier } = {}) {
        this.system = system;
        this.store = system.authSource.store;
        this.verifier = verifier || new ManagementVerifier(system);
        this.cleanupTimeoutMs = 5000;
        this.file = path.join(rootDir, "data", "account-credential-tests.json");
        const empty = () => ({ currentRun: null, lastCompleted: null, receipts: [], schemaVersion: 1 });
        this.state = empty();
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            if (!fs.existsSync(this.file)) return;
            const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
            const validRun = run =>
                run === null ||
                (run &&
                    typeof run.runId === "string" &&
                    ["running", "completed", "partial", "stopped", "interrupted"].includes(run.status) &&
                    Array.isArray(run.results) &&
                    run.results.length > 0 &&
                    run.results.length <= 1000 &&
                    run.results.every(
                        row =>
                            row &&
                            Number.isSafeInteger(row.index) &&
                            row.index >= 0 &&
                            [
                                "pending",
                                "running",
                                "success",
                                "failed",
                                "skipped",
                                "unexecuted",
                                "interrupted",
                            ].includes(row.state)
                    ));
            if (
                !saved ||
                saved.schemaVersion !== 1 ||
                !Array.isArray(saved.receipts) ||
                saved.receipts.length > 1000 ||
                !validRun(saved.currentRun) ||
                !validRun(saved.lastCompleted) ||
                saved.receipts.some(
                    item =>
                        !item ||
                        typeof item.clientRequestId !== "string" ||
                        typeof item.runId !== "string" ||
                        !Number.isFinite(Date.parse(item.createdAt)) ||
                        !Array.isArray(item.indices) ||
                        item.indices.some(index => !Number.isSafeInteger(index) || index < 0)
                )
            ) {
                throw failure("PERSISTENCE_ERROR");
            }
            this.state = saved;
            if (active(this.state.currentRun)) {
                const run = this.state.currentRun;
                interruptRows(run, "interrupted");
                run.status = "interrupted";
                run.finishedAt = now();
                this._persist();
            }
        } catch {
            // This optional console feature must not prevent proxy startup. Do
            // not overwrite unreadable state or forget its dedup receipts and
            // accidentally admit a previously submitted model call again.
            this.state = empty();
            this.poisoned = true;
            system.logger?.warn?.(
                "[CredentialTest] Persisted task state is unavailable; credential tests are disabled until storage is repaired and the service restarts."
            );
        }
    }

    _persist() {
        try {
            atomicWrite(this.file, this.state);
        } catch (error) {
            this.poisoned = true;
            throw error;
        }
    }

    snapshot(clientRequestId) {
        if (
            clientRequestId !== undefined &&
            (typeof clientRequestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(clientRequestId))
        ) {
            throw failure("INVALID_REQUEST");
        }
        const receipt =
            clientRequestId === undefined
                ? null
                : this.state.receipts.find(
                      item =>
                          item.clientRequestId === clientRequestId &&
                          Date.parse(item.createdAt) > Date.now() - RETENTION_MS
                  );
        return clone({
            ...(clientRequestId === undefined ? {} : { admission: receipt ? { runId: receipt.runId } : null }),
            cleanupBlocked: this.cleanupBlocked === true,
            currentRun: this.state.currentRun,
            lastCompleted: this.state.lastCompleted,
            persistenceError: this.poisoned === true,
        });
    }

    start(body) {
        object(body, ["indices", "clientRequestId"], ["indices", "clientRequestId"]);
        if (
            !Array.isArray(body.indices) ||
            !body.indices.length ||
            body.indices.some(index => !Number.isSafeInteger(index) || index < 0) ||
            typeof body.clientRequestId !== "string" ||
            !/^[a-zA-Z0-9_-]{8,128}$/.test(body.clientRequestId)
        ) {
            throw failure("INVALID_REQUEST");
        }
        if (body.indices.length > 1000) throw failure("PAYLOAD_TOO_LARGE");
        if (this.closing || this.poisoned || this.cleanupBlocked) throw failure("INVALID_STATE");
        const indices = [...new Set(body.indices)];
        const receipts = this.state.receipts.filter(item => Date.parse(item.createdAt) > Date.now() - RETENTION_MS);
        const previous = receipts.find(item => item.clientRequestId === body.clientRequestId);
        if (previous) {
            if (JSON.stringify(previous.indices) !== JSON.stringify(indices)) throw failure("IDEMPOTENCY_CONFLICT");
            return { reused: true, runId: previous.runId };
        }
        if (active(this.state.currentRun) || this.runPromise) throw failure("ACCOUNT_BUSY");
        if (receipts.length >= 1000) throw failure("RATE_LIMITED");
        this.system.authSource.reloadAuthSources();
        const run = {
            finishedAt: null,
            model: MODEL,
            results: indices.map(index => {
                const metadata = this.store.getMetadata(index);
                return {
                    accountId: metadata?.accountId || null,
                    errorCode: null,
                    index,
                    modelVerified: false,
                    name: metadata?.accountName || "",
                    stage: "queued",
                    state: "pending",
                };
            }),
            runId: `credential_${randomUUID()}`,
            startedAt: now(),
            status: "running",
            stopRequested: false,
        };
        this.state.currentRun = run;
        this.state.receipts = [
            ...receipts,
            { clientRequestId: body.clientRequestId, createdAt: now(), indices, runId: run.runId },
        ];
        this._persist(); // Never send model traffic before durable admission.
        this.controller = new AbortController();
        this.runPromise = Promise.resolve()
            .then(() => this._run(run, this.controller.signal))
            .catch(error => {
                run.status = "interrupted";
                run.finishedAt = now();
                run.errorCode = this.cleanupBlocked
                    ? "cleanup_failed"
                    : error.code === "PERSISTENCE_ERROR"
                      ? "persistence_failed"
                      : "interrupted";
                interruptRows(run, run.errorCode);
                try {
                    this._persist();
                } catch {
                    /* Fail closed until restart. */
                }
            })
            .finally(() => {
                this.runPromise = null;
                this.controller = null;
            });
        return { reused: false, runId: run.runId };
    }

    stop(runId) {
        const run = this.state.currentRun;
        if (!run || run.runId !== runId) throw failure("NOT_FOUND");
        if (active(run)) {
            run.stopRequested = true;
            this._persist();
        }
        return { runId: run.runId, status: run.status, stopRequested: run.stopRequested };
    }

    async _run(run, signal) {
        for (const row of run.results) {
            if (run.stopRequested) {
                Object.assign(row, { stage: "unexecuted", state: "unexecuted" });
                continue;
            }
            if (signal.aborted) throw failure("INTERRUPTED");
            await this._test(row, signal);
            this._persist();
        }
        run.status = run.stopRequested
            ? "stopped"
            : run.results.some(row => row.state === "failed")
              ? "partial"
              : "completed";
        run.finishedAt = now();
        this.state.lastCompleted = clone(run);
        this._persist();
    }

    async _test(row, signal) {
        const started = Date.now();
        let phase = "verification";
        try {
            this.system.authSource.reloadAuthSources();
            const metadata = this.store.getMetadata(row.index);
            const skip =
                !metadata || metadata.archived || metadata.accountId !== row.accountId
                    ? "missing"
                    : metadata.schemaValid === false
                      ? "invalid"
                      : this.system.authSource.duplicateIndices.includes(row.index)
                        ? "duplicate"
                        : null;
            if (skip) {
                Object.assign(row, { errorCode: skip, stage: "skipped", state: "skipped" });
                return;
            }
            const value = this.store.read(row.index);
            if (!value) throw new VerificationError("invalid_input");
            const expectedEmail = [value.accountName, metadata.accountName].find(email);
            if (!expectedEmail) {
                Object.assign(row, { errorCode: "identity_unverifiable", stage: "failed", state: "failed" });
                return;
            }
            Object.assign(row, {
                credentialVersion: metadata.credentialVersion,
                stage: "initializing",
                startedAt: now(),
                state: "running",
                stateVersion: metadata.stateVersion,
            });
            this._persist();
            const result = await this.verifier.verify({
                credentials: { accountName: expectedEmail.trim(), cookies: value.cookies, origins: value.origins },
                includeResponseText: true,
                index: row.index,
                mode: "model",
                model: MODEL,
                onProgress: event => {
                    row.stage = event.stage;
                    // A persistence failure must prevent the later enable even though
                    // ManagementVerifier deliberately ignores observer exceptions.
                    this._persist();
                },
                signal,
            });
            if (signal.aborted || this.closing) throw failure("INTERRUPTED");
            if (this.poisoned) throw failure("PERSISTENCE_ERROR");
            if (
                result.success !== true ||
                result.authIndex !== row.index ||
                result.model !== MODEL ||
                result.stage !== "model_verified" ||
                !Number.isInteger(result.upstreamStatus) ||
                result.upstreamStatus < 200 ||
                result.upstreamStatus >= 300 ||
                typeof result.requestId !== "string" ||
                !result.requestId ||
                typeof result.responseText !== "string" ||
                !result.responseText.trim()
            )
                throw new VerificationError("empty_response");
            Object.assign(row, {
                modelVerified: true,
                requestId: result.requestId,
                responseText: result.responseText.slice(0, 2000),
                stage: "enabling",
                upstreamStatus: result.upstreamStatus,
            });
            this._persist();
            phase = "enable";
            this.system.authSource.reloadAuthSources();
            const current = this.store.getMetadata(row.index);
            if (
                !current ||
                current.archived ||
                current.accountId !== metadata.accountId ||
                current.stateVersion !== metadata.stateVersion ||
                this.system.authSource.duplicateIndices.includes(row.index)
            )
                throw failure("VERSION_CONFLICT");
            if (metadata.disabled || metadata.expired) {
                await this.store.updateState(
                    row.index,
                    { disabled: null, disabledAt: null, disabledReason: null, disabledStatus: null, expired: null },
                    {
                        expectedCredentialVersion: metadata.credentialVersion,
                        expectedStateVersion: metadata.stateVersion,
                    }
                );
                row.enabled = true;
                phase = "refresh";
                this.system.authSource.reloadAuthSources();
                await this.system.browserManager.rebalanceContextPool();
            } else {
                if (current.disabled || current.expired) throw failure("VERSION_CONFLICT");
                row.enabled = true;
                row.snapshotChanged = current.credentialVersion !== metadata.credentialVersion;
            }
            Object.assign(row, { stage: "completed", state: "success" });
        } catch (error) {
            if (signal.aborted || this.closing || this.poisoned) throw error;
            const conflict = ["VERSION_CONFLICT", "ACCOUNT_NOT_FOUND"].includes(error.code);
            Object.assign(row, {
                errorCode: conflict
                    ? "version_conflict"
                    : phase === "refresh"
                      ? "refresh_failed"
                      : phase === "enable"
                        ? "enable_failed"
                        : error instanceof VerificationError
                          ? error.stage
                          : "verification_failed",
                stage: "failed",
                state: "failed",
                upstreamStatus:
                    error instanceof VerificationError ? error.upstreamStatus : (row.upstreamStatus ?? null),
            });
        } finally {
            row.durationMs = Date.now() - started;
            // verify() may reject on deadline before owned cleanup finishes. Do
            // not spend the next account's timeout waiting for that cleanup.
            await this._waitForCleanup();
        }
    }

    async _waitForCleanup() {
        let timer;
        const cleanup = this.verifier.tail;
        try {
            await Promise.race([
                cleanup,
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(new VerificationError("cleanup_failed")),
                        Math.max(this.cleanupTimeoutMs, this.verifier.closeTimeoutMs || 0)
                    );
                }),
            ]);
            if (this.verifier.cleanupFailed) throw new VerificationError("cleanup_failed");
        } catch (error) {
            // Never start more browsers while an earlier browser cannot close.
            this.cleanupBlocked = true;
            // A timeout is not proof of a leak: pending browser acquisition can
            // settle late. Resume admissions only after actual successful cleanup.
            Promise.resolve(cleanup).then(
                () => {
                    if (!this.verifier.cleanupFailed) this.cleanupBlocked = false;
                },
                () => {
                    /* A rejected cleanup keeps the feature blocked. */
                }
            );
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    async close() {
        this.closing = true;
        this.controller?.abort();
        await Promise.all([this.runPromise, this.verifier.close()]);
    }
}

module.exports = CredentialTestService;
