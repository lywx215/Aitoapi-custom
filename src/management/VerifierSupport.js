const messages = {
    cancelled: "Verification cancelled.",
    cleanup_failed: "Isolated verification resources could not be closed.",
    closed: "The verifier is closed.",
    connection_closed: "The isolated verification connection closed.",
    empty_response: "The target model did not return a completed nonempty response.",
    identity_mismatch: "Current session identity does not match the candidate.",
    identity_unconfirmed: "Current session identity could not be confirmed.",
    initialization_failed: "The isolated verification browser could not initialize.",
    invalid_input: "Invalid verification target or credentials.",
    login_required: "The target session requires login or a login challenge.",
    model_not_found: "The requested model is unavailable.",
    permission_denied: "The target session lacks permission.",
    protocol_mismatch: "The verification response does not match the target request.",
    quota_exceeded: "The target session has exceeded its quota.",
    region_restricted: "The target session is unavailable in this region.",
    terms_required: "The target session requires consent or terms acceptance.",
    timeout: "Verification deadline exceeded.",
    upstream_error: "The target model request failed.",
};

class VerificationError extends Error {
    constructor(stage, upstreamStatus = null) {
        super(messages[stage] || "Target verification failed.");
        this.name = "VerificationError";
        this.code =
            stage === "cancelled" ? "CANCELLED" : stage === "timeout" ? "VERIFICATION_TIMEOUT" : "VERIFICATION_FAILED";
        this.stage = stage;
        this.upstreamStatus =
            Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599 ? upstreamStatus : null;
    }
}

function upstreamError(status, detail = "") {
    let stage =
        { 401: "login_required", 403: "permission_denied", 404: "model_not_found", 429: "quota_exceeded" }[status] ||
        "upstream_error";
    // Classify only; never retain or log the upstream body (it may contain secrets).
    if (status === 403 && /location|region|country|not supported/i.test(detail)) stage = "region_restricted";
    return new VerificationError(stage, status);
}

function abortError(signal) {
    return signal.reason instanceof VerificationError ? signal.reason : new VerificationError("cancelled");
}

function abortable(promise, signal) {
    if (signal.aborted) {
        Promise.resolve(promise).catch(() => {});
        return Promise.reject(abortError(signal));
    }
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener("abort", abort);
            reject(abortError(signal));
        };
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(promise)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
    });
}

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(abortError(signal));
        const abort = () => {
            clearTimeout(timer);
            reject(abortError(signal));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
    });
}

module.exports = { abortable, abortError, delay, upstreamError, VerificationError };
