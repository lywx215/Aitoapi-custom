const fs = require("fs");
const { randomUUID } = require("crypto");

const ERRORS = {
    ACCOUNT_BUSY: [409, "Account drain is pending; active requests were not interrupted."],
    AUDIT_PERSISTENCE_FAILED: [
        500,
        "The operation was committed but its audit record could not be persisted. Read current state before retrying.",
    ],
    CANCELLED: [409, "Uncommitted work was cancelled."],
    DUPLICATE_ACCOUNT: [409, "Account already exists."],
    FORBIDDEN: [403, "Required management permission is missing."],
    IDEMPOTENCY_CONFLICT: [409, "Idempotency key was used with different content."],
    IDEMPOTENCY_KEY_REQUIRED: [400, "Idempotency-Key is required."],
    INTERNAL_ERROR: [500, "Management operation failed."],
    INTERRUPTED: [409, "Work was interrupted and will not be replayed."],
    INVALID_CREDENTIALS: [400, "Invalid credential storage state."],
    INVALID_REQUEST: [400, "Invalid management request."],
    INVALID_STATE: [409, "Operation is unavailable in the current state."],
    METHOD_NOT_ALLOWED: [405, "Method not allowed."],
    NOT_FOUND: [404, "Management resource not found."],
    PAYLOAD_TOO_LARGE: [413, "Management payload exceeds its limit."],
    PERSISTENCE_ERROR: [
        500,
        "Management persistence failed. The operation may already be committed; read current state before retrying.",
    ],
    RATE_LIMITED: [429, "Management task queue is full."],
    UNAUTHORIZED: [401, "A valid management bearer token is required."],
    VERIFICATION_FAILED: [500, "Target account verification failed."],
    VERIFICATION_TIMEOUT: [500, "Target account verification timed out."],
    VERSION_CONFLICT: [409, "Account changed while this operation was running."],
};
function failure(code) {
    const [status, message] = ERRORS[code] || ERRORS.INTERNAL_ERROR;
    return Object.assign(new Error(message), { code: ERRORS[code] ? code : "INTERNAL_ERROR", status });
}
function safeError(error) {
    const aliases = {
        ACCOUNT_NOT_FOUND: "NOT_FOUND",
        INVALID_INDEX: "INVALID_REQUEST",
        INVALID_SETTINGS: "INVALID_REQUEST",
        SETTINGS_PERSISTENCE_FAILED: "PERSISTENCE_ERROR",
        SETTINGS_PERSISTENCE_RECOVERY_FAILED: "PERSISTENCE_ERROR",
    };
    const err = failure(aliases[error?.code] || error?.code);
    return { code: err.code, message: err.message };
}
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.keys(value)
            .sort()
            .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`)
            .join(",")}}`;
    return JSON.stringify(value);
}
function atomicWrite(file, value) {
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temp, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify(value));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temp, file);
    } catch {
        throw failure("PERSISTENCE_ERROR");
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
}
function object(value, allowed, required = []) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some(k => !allowed.includes(k)) ||
        required.some(k => !Object.hasOwn(value, k))
    )
        throw failure("INVALID_REQUEST");
    return value;
}
function pagination(query = {}) {
    const integer = (value, fallback, min, max) => {
        if (value === undefined) return fallback;
        if (typeof value !== "string" || !/^\d+$/.test(value)) throw failure("INVALID_REQUEST");
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw failure("INVALID_REQUEST");
        return parsed;
    };
    return { limit: integer(query.limit, 50, 1, 200), offset: integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER) };
}
const page = (items, { offset = 0, limit = 50 } = {}) => ({
    items: items.slice(offset, offset + limit),
    limit,
    offset,
    total: items.length,
});
module.exports = { atomicWrite, canonical, clone, failure, object, page, pagination, safeError };
