const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { atomicWrite, canonical, clone } = require("../management/ManagementSupport");
const VerifierBrowserAdapter = require("../management/VerifierBrowserAdapter");
const { VerificationError, abortable, abortError, delay } = require("../management/VerifierSupport");
const ModelProbeTransport = require("./ModelProbeTransport");

const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const MODEL_TIMEOUT_MS = 120000;
const TERMINAL = new Set(["succeeded", "cancelled", "failed", "interrupted"]);
const DEFINITIVE_UNAVAILABLE_STATUS = new Set([403, 404]);

const isoNow = () => new Date().toISOString();
const digest = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");

class ModelProbeService {
    constructor(
        system,
        { rootDir = process.cwd(), adapterFactory, transportFactory, modelTimeoutMs, runTimeoutMs } = {}
    ) {
        this.system = system;
        this.logger = system.logger;
        this.file = path.join(rootDir, "data", "model-probes.json");
        this.adapterFactory =
            adapterFactory ||
            (() =>
                new VerifierBrowserAdapter({
                    aiStudioAppUrl: system.config.aiStudioAppUrl,
                    browserExecutablePath: system.config.browserExecutablePath,
                }));
        this.transportFactory = transportFactory || (options => new ModelProbeTransport(options));
        this.modelTimeoutMs = modelTimeoutMs || MODEL_TIMEOUT_MS;
        this.runTimeoutMs = runTimeoutMs || RUN_TIMEOUT_MS;
        this.controller = null;
        this.runPromise = null;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.state = this._load();
    }

    _load() {
        let state = { currentRun: null, lastCompleted: null, schemaVersion: 1 };
        if (fs.existsSync(this.file)) {
            try {
                const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
                if (saved?.schemaVersion === 1) state = saved;
            } catch {
                this.logger.warn("[ModelProbe] Ignoring unreadable persisted probe state.");
            }
        }
        if (state.currentRun?.status === "running" || state.currentRun?.status === "queued") {
            state.currentRun.status = "interrupted";
            state.currentRun.finishedAt = isoNow();
            state.currentRun.currentModel = null;
            state.currentRun.errorCode = "interrupted";
            atomicWrite(this.file, state);
        }
        return state;
    }

    _models() {
        return (this.system.config.modelList || [])
            .map(model => {
                const id = String(model.name || "").replace(/^models\//, "");
                const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
                let kind = null;
                if (methods.includes("predict") && /^imagen-/i.test(id)) kind = "imagen";
                else if (methods.includes("generateContent") && /(?:^|-)image(?:-|$)/i.test(id)) {
                    kind = "gemini_image";
                } else if (
                    methods.includes("generateContent") &&
                    !/(?:tts|embedding|robotics|computer-use)/i.test(id)
                ) {
                    kind = "text";
                }
                if (!kind) return null;
                return {
                    displayName: model.displayName || id,
                    id,
                    kind,
                    type: kind === "text" ? "text" : "image",
                    version: model.version || null,
                };
            })
            .filter(Boolean);
    }

    _accounts() {
        const store = this.system.authSource.store;
        return this.system.authSource.getRotationIndices().map(index => {
            const metadata = store.getMetadata(index);
            return {
                accountId: metadata?.accountId || null,
                credentialVersion: metadata?.credentialVersion || null,
                index,
                stateVersion: metadata?.stateVersion || null,
            };
        });
    }

    _fingerprint(models = this._models(), accounts = this._accounts()) {
        return digest({
            accounts: accounts.map(({ accountId, credentialVersion, index, stateVersion }) => ({
                accountId,
                credentialVersion,
                index,
                stateVersion,
            })),
            models: models.map(({ id, kind, version }) => ({ id, kind, version })),
        });
    }

    _persist() {
        atomicWrite(this.file, this.state);
    }

    snapshot() {
        const snapshot = clone(this.state);
        const models = this._models();
        snapshot.catalog = {
            imageModels: models.filter(model => model.type === "image").length,
            models: models.map(model => ({
                displayName: model.displayName,
                kind: model.kind,
                model: model.id,
                type: model.type,
            })),
            textModels: models.filter(model => model.type === "text").length,
            totalModels: models.length,
        };
        snapshot.availableAccountCount = this._accounts().length;
        snapshot.stale = Boolean(
            snapshot.lastCompleted && snapshot.lastCompleted.fingerprint !== this._fingerprint(models)
        );
        return snapshot;
    }

    start() {
        if (this.state.currentRun && !TERMINAL.has(this.state.currentRun.status)) {
            const error = new Error("A model probe is already running.");
            error.code = "PROBE_RUNNING";
            error.status = 409;
            throw error;
        }
        const models = this._models();
        const accounts = this._accounts();
        if (accounts.length === 0) {
            const error = new Error("No enabled account is available for model probing.");
            error.code = "NO_PROBE_ACCOUNT";
            error.status = 409;
            throw error;
        }
        const run = {
            completedModels: 0,
            currentAccountIndex: null,
            currentModel: null,
            errorCode: null,
            fingerprint: this._fingerprint(models, accounts),
            finishedAt: null,
            results: models.map(model => ({
                attempts: [],
                displayName: model.displayName,
                kind: model.kind,
                model: model.id,
                status: "not_tested",
                successfulAccount: null,
                testedAt: null,
                type: model.type,
            })),
            runId: `probe_${crypto.randomUUID()}`,
            startedAt: isoNow(),
            status: "running",
            totalModels: models.length,
        };
        this.state.currentRun = run;
        this._persist();
        this.controller = new AbortController();
        const timer = setTimeout(() => this.controller?.abort(new VerificationError("timeout")), this.runTimeoutMs);
        this.runPromise = this._run(run, models, accounts, this.controller.signal)
            .catch(error => this._finishFailed(run, error))
            .finally(() => {
                clearTimeout(timer);
                this.controller = null;
                this.runPromise = null;
            });
        return clone(run);
    }

    cancel(runId) {
        const run = this.state.currentRun;
        if (!run || run.runId !== runId) {
            const error = new Error("Model probe run not found.");
            error.code = "PROBE_NOT_FOUND";
            error.status = 404;
            throw error;
        }
        if (!TERMINAL.has(run.status)) this.controller?.abort(new VerificationError("cancelled"));
        return clone(run);
    }

    _credential(index) {
        const value = this.system.authSource.getAuth(index);
        if (!value) throw new VerificationError("invalid_input");
        return value;
    }

    _identity(credentials, state) {
        if (state?.stage) throw new VerificationError(state.stage);
        const identity = state?.identity;
        if (
            identity?.source !== "aistudio_session" ||
            identity?.origin !== "https://aistudio.google.com" ||
            typeof identity.email !== "string"
        ) {
            throw new VerificationError("identity_unconfirmed");
        }
        const email = identity.email.trim().toLowerCase();
        if (credentials.accountName && email !== credentials.accountName.trim().toLowerCase()) {
            throw new VerificationError("identity_mismatch");
        }
        return email;
    }

    async _waitReady(adapter, transport, credentials, signal) {
        let connected = false;
        transport.connected.then(() => {
            connected = true;
        });
        while (!signal.aborted) {
            this._identity(credentials, await abortable(adapter.inspect(), signal));
            if (connected) return;
            if (adapter.wake) await abortable(adapter.wake(), signal);
            await delay(250, signal);
        }
        throw abortError(signal);
    }

    _safeAttempt(error, account, durationMs) {
        const stage = error instanceof VerificationError ? error.stage : "upstream_error";
        return {
            accountId: account.accountId,
            accountIndex: account.index,
            durationMs: Math.max(0, Math.floor(durationMs || 0)),
            errorCode: stage,
            httpStatus: error instanceof VerificationError ? error.upstreamStatus : null,
            outcome: "error",
            testedAt: isoNow(),
        };
    }

    _persistProgress(run) {
        run.completedModels = run.results.filter(result => result.status !== "not_tested").length;
        this._persist();
    }

    async _run(run, models, accounts, signal) {
        for (const account of accounts) {
            if (signal.aborted) throw abortError(signal);
            const unresolved = run.results.filter(result => result.status === "not_tested");
            if (unresolved.length === 0) break;
            run.currentAccountIndex = account.index;
            this._persist();
            let adapter;
            let transport;
            let credentials;
            let accountError = null;
            const accountStarted = Date.now();
            try {
                credentials = this._credential(account.index);
                transport = this.transportFactory({ index: account.index });
                const endpoint = await transport.listen(signal);
                adapter = this.adapterFactory();
                await abortable(adapter.start({ credentials, endpoint, index: account.index, signal }), signal);
                await this._waitReady(adapter, transport, credentials, signal);
                for (const result of unresolved) {
                    if (signal.aborted) throw abortError(signal);
                    const model = models.find(item => item.id === result.model);
                    run.currentModel = result.model;
                    this._persist();
                    const startedAt = Date.now();
                    try {
                        this._identity(credentials, await abortable(adapter.inspect(), signal));
                        const probe = await transport.probe(model, signal, this.modelTimeoutMs);
                        this._identity(credentials, await abortable(adapter.inspect(), signal));
                        result.attempts.push({
                            accountId: account.accountId,
                            accountIndex: account.index,
                            durationMs: probe.durationMs,
                            errorCode: null,
                            httpStatus: probe.status,
                            outcome: "success",
                            testedAt: isoNow(),
                        });
                        result.status = "available";
                        result.successfulAccount = {
                            accountId: account.accountId,
                            accountIndex: account.index,
                        };
                        result.testedAt = isoNow();
                    } catch (error) {
                        if (signal.aborted) throw error;
                        result.attempts.push(this._safeAttempt(error, account, Date.now() - startedAt));
                    }
                    this._persistProgress(run);
                }
            } catch (error) {
                if (signal.aborted) throw error;
                accountError = error;
            } finally {
                const cleanup = await Promise.allSettled([
                    Promise.resolve().then(() => transport?.close()),
                    Promise.resolve().then(() => adapter?.close()),
                ]);
                if (cleanup.some(item => item.status === "rejected") && !accountError) {
                    accountError = new VerificationError("cleanup_failed");
                }
            }
            if (accountError) {
                for (const result of run.results.filter(item => item.status === "not_tested")) {
                    result.attempts.push(this._safeAttempt(accountError, account, Date.now() - accountStarted));
                }
                this._persistProgress(run);
            }
        }
        for (const result of run.results.filter(item => item.status === "not_tested")) {
            result.status =
                result.attempts.length > 0 &&
                result.attempts.every(attempt => DEFINITIVE_UNAVAILABLE_STATUS.has(attempt.httpStatus))
                    ? "unavailable"
                    : "indeterminate";
            result.testedAt = isoNow();
        }
        run.completedModels = run.results.length;
        run.currentAccountIndex = null;
        run.currentModel = null;
        run.finishedAt = isoNow();
        run.status = "succeeded";
        this.state.lastCompleted = clone(run);
        this._persist();
    }

    _finishFailed(run, error) {
        const cancelled = error instanceof VerificationError && error.stage === "cancelled";
        run.status = cancelled ? "cancelled" : "failed";
        run.errorCode = error instanceof VerificationError ? error.stage : "upstream_error";
        run.finishedAt = isoNow();
        run.currentAccountIndex = null;
        run.currentModel = null;
        try {
            this._persist();
        } catch (persistError) {
            this.logger.error(`[ModelProbe] Failed to persist terminal state: ${persistError.code || "error"}`);
        }
    }

    async close() {
        if (this.controller && !this.controller.signal.aborted) {
            this.controller.abort(new VerificationError("cancelled"));
        }
        await this.runPromise?.catch(() => {});
    }
}

module.exports = ModelProbeService;
module.exports.MODEL_TIMEOUT_MS = MODEL_TIMEOUT_MS;
module.exports.RUN_TIMEOUT_MS = RUN_TIMEOUT_MS;
