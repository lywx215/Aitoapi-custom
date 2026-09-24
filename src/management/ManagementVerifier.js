const crypto = require("crypto");
const VerifierTransport = require("./VerifierTransport");
const VerifierBrowserAdapter = require("./VerifierBrowserAdapter");
const { VerificationError, abortable, abortError, delay } = require("./VerifierSupport");
const LoggingService = require("../utils/LoggingService");

const MAX_TIMEOUT_MS = 10 * 60 * 1000;

class ManagementVerifier {
    constructor(serverSystem) {
        const config = serverSystem?.config || {};
        const options = serverSystem?.managementVerifierOptions || {};
        this.logger = serverSystem?.logger;
        const staticConfig = {
            aiStudioAppUrl: config.aiStudioAppUrl,
            browserExecutablePath: config.browserExecutablePath,
        };
        // Trusted in-process test seam; never populated from API request data.
        this.adapterFactory = options.adapterFactory || (() => new VerifierBrowserAdapter(staticConfig));
        this.timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, options.timeoutMs || MAX_TIMEOUT_MS));
        this.pollMs = Math.max(1, options.pollMs || 250);
        this.closeTimeoutMs = Math.max(1, Math.min(5000, options.closeTimeoutMs || 5000));
        this.tail = Promise.resolve();
        this.jobs = new Set();
        this.cleanupFailed = false;
        this.closed = false;
    }

    async verify({ index, credentials, mode = "model", model = "gemini-3.8-flash", signal, onProgress } = {}) {
        const requestId = `verify_${crypto.randomUUID()}`;
        const attribution = { authIndex: index, model, requestId };
        const started = LoggingService.isDebugEnabled() ? Date.now() : null;
        let diagnosticActive = started !== null;
        const unsubscribe = diagnosticActive
            ? LoggingService.onLevelChange(level => {
                  if (level !== "DEBUG") diagnosticActive = false;
              })
            : null;
        const diagnostic = (stage, extra = {}) => {
            if (diagnosticActive && LoggingService.isDebugEnabled())
                this.logger?.diagnostic?.("INFO", "verification.stage", () => ({
                    ...attribution,
                    deadlineRemainingMs: Math.max(0, this.timeoutMs - (Date.now() - started)),
                    elapsedMs: Date.now() - started,
                    stage,
                    verificationAttemptId: requestId,
                    ...extra,
                }));
        };
        diagnostic("queued");
        let candidate;
        try {
            if (this.closed) throw new VerificationError("closed");
            if (
                !Number.isInteger(index) ||
                index < 0 ||
                !["connection", "model"].includes(mode) ||
                typeof model !== "string" ||
                !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)
            )
                throw new VerificationError("invalid_input");
            candidate =
                typeof credentials === "string" ? JSON.parse(credentials) : JSON.parse(JSON.stringify(credentials));
            if (
                !candidate ||
                !Array.isArray(candidate.cookies) ||
                !Array.isArray(candidate.origins) ||
                (candidate.accountName !== undefined && typeof candidate.accountName !== "string")
            )
                throw new VerificationError("invalid_input");
        } catch (error) {
            unsubscribe?.();
            throw Object.assign(
                error instanceof VerificationError ? error : new VerificationError("invalid_input"),
                attribution
            );
        }
        const controller = new AbortController();
        const cancel = () => controller.abort(new VerificationError("cancelled"));
        const timer = setTimeout(() => controller.abort(new VerificationError("timeout")), this.timeoutMs);
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
        const job = { controller };
        this.jobs.add(job);
        const run = this.tail.then(async () => {
            if (controller.signal.aborted) throw abortError(controller.signal);
            diagnostic("dequeued", { queueWaitMs: started === null ? undefined : Date.now() - started });
            return this.execute({
                credentials: candidate,
                diagnostic,
                index,
                mode,
                model,
                onProgress,
                requestId,
                signal: controller.signal,
            });
        });
        job.done = run.catch(() => {}).finally(() => this.jobs.delete(job));
        // One slot remains held until owned cleanup has actually finished, even after caller cancellation.
        this.tail = job.done;
        try {
            return await abortable(run, controller.signal);
        } catch (error) {
            diagnostic("failed", { errorCode: error.code || error.stage || "verification_failed" });
            throw Object.assign(
                error instanceof VerificationError ? error : new VerificationError("initialization_failed"),
                attribution
            );
        } finally {
            diagnostic("finished");
            diagnosticActive = false;
            unsubscribe?.();
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
        }
    }

    async execute({ index, credentials, mode, model, requestId, signal, onProgress, diagnostic = () => {} }) {
        let adapter;
        const transport = new VerifierTransport({ index, model, requestId });
        const progress = async (stage, value) => {
            diagnostic(stage);
            if (onProgress) {
                // Observers cannot replace a verification result or leak their own exceptions.
                await abortable(
                    Promise.resolve()
                        .then(() => onProgress({ progress: value, stage }))
                        .catch(() => {}),
                    signal
                );
            }
        };
        const checkIdentity = state => {
            if (state?.stage && state.stage !== "identity_unconfirmed") throw new VerificationError(state.stage);
            const identity = state?.identity;
            if (
                identity?.source !== "aistudio_session" ||
                identity?.origin !== "https://aistudio.google.com" ||
                typeof identity.email !== "string" ||
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email)
            )
                return null;
            const email = identity.email.trim().toLowerCase();
            if (credentials.accountName && email !== credentials.accountName.trim().toLowerCase())
                throw new VerificationError("identity_mismatch");
            return email;
        };
        let primaryError;
        let verificationResult;
        try {
            await progress("initializing", 10);
            const endpoint = await transport.listen(signal);
            diagnostic("transport_listening");
            adapter = this.adapterFactory();
            await abortable(adapter.start({ credentials, endpoint, index, signal }), signal);
            diagnostic("browser_ready", { browserReady: true });
            await progress("checking_session", 25);
            let connected = false;
            transport.connected.then(() => {
                connected = true;
            });
            let identity;
            let lastReadiness;
            while (!signal.aborted) {
                identity = checkIdentity(await abortable(adapter.inspect(), signal));
                const readiness = `${Boolean(identity)}:${connected}`;
                if (readiness !== lastReadiness) {
                    diagnostic(identity ? "identity_confirmed" : "identity_pending", { wsReady: connected });
                    lastReadiness = readiness;
                }
                if (connected) {
                    if (!identity) throw new VerificationError("identity_unconfirmed");
                    if (transport.socket?.readyState !== 1) throw new VerificationError("connection_closed");
                    break;
                }
                if (adapter.wake) await abortable(adapter.wake(), signal);
                await delay(this.pollMs, signal);
            }
            if (signal.aborted) throw abortError(signal);
            let upstreamStatus = null;
            if (mode === "model") {
                await progress("generating", 50);
                let finished = false;
                let responseError;
                const result = transport.generate(signal).then(
                    status => {
                        upstreamStatus = status;
                        finished = true;
                    },
                    error => {
                        responseError = error;
                        finished = true;
                    }
                );
                while (!finished) {
                    const current = checkIdentity(await abortable(adapter.inspect(), signal));
                    if (!current) throw new VerificationError("identity_unconfirmed");
                    if (current !== identity) throw new VerificationError("identity_mismatch");
                    await delay(this.pollMs, signal);
                }
                await result;
                if (responseError) throw responseError;
                const finalIdentity = checkIdentity(await abortable(adapter.inspect(), signal));
                if (!finalIdentity) throw new VerificationError("identity_unconfirmed");
                if (finalIdentity !== identity) throw new VerificationError("identity_mismatch");
            }
            await progress("cleaning_up", 90);
            verificationResult = {
                authIndex: index,
                model,
                requestId,
                stage: mode === "model" ? "model_verified" : "connection_ready",
                success: true,
                upstreamStatus,
            };
        } catch (error) {
            primaryError = error;
        } finally {
            const results = await Promise.allSettled([
                Promise.resolve().then(() => transport.close()),
                Promise.resolve().then(() => adapter?.close()),
            ]);
            if (results.some(result => result.status === "rejected")) {
                this.cleanupFailed = true;
                if (!primaryError) primaryError = new VerificationError("cleanup_failed");
            }
        }
        if (primaryError) throw primaryError;
        return verificationResult;
    }

    close() {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        for (const job of this.jobs) job.controller.abort(new VerificationError("cancelled"));
        this.closePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new VerificationError("cleanup_failed")), this.closeTimeoutMs);
            Promise.all(Array.from(this.jobs, job => job.done)).then(() => {
                clearTimeout(timer);
                if (this.cleanupFailed) reject(new VerificationError("cleanup_failed"));
                else resolve();
            });
        });
        return this.closePromise;
    }
}

module.exports = ManagementVerifier;
