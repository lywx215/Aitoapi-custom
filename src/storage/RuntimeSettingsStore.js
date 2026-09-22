const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const INTEGER_RANGES = Object.freeze({
    accountCooldownMaxMs: [1000, 604800000],
    accountCooldownMs: [1000, 86400000],
    autoHealProbeIntervalMs: [60000, 604800000],
    autoHealProbeTimeoutMs: [30000, 3600000],
    maxContexts: [0, 1000],
    maxRetries: [1, 20],
    retryDelay: [50, 600000],
});
const PERSISTENT_KEYS = Object.freeze([...Object.keys(INTEGER_RANGES), "autoDisableStatusCodes"].sort());
const BOOLEAN_KEYS = Object.freeze([
    "checkUpdate",
    "debugMode",
    "enableAuthUpdate",
    "forceCodeExecution",
    "forceThinking",
    "forceUrlContext",
    "forceWebSearch",
]);
const SAFETY_THRESHOLDS = new Set([
    "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
    "BLOCK_LOW_AND_ABOVE",
    "BLOCK_MEDIUM_AND_ABOVE",
    "BLOCK_ONLY_HIGH",
    "BLOCK_NONE",
    "OFF",
]);
const SETTING_KEYS = Object.freeze([
    ...PERSISTENT_KEYS,
    ...BOOLEAN_KEYS,
    "logMaxCount",
    "streamingMode",
    "safetySettingsThreshold",
]);
const FALLBACK_ERRORS = new Set(["EBUSY", "EPERM", "EACCES", "EEXIST"]);

// UI and management callers must share the live config. Multiple wrappers for
// the same file still share this process-local queue; rejected writes cannot
// poison subsequent work. This does not coordinate separate server processes.
const writers = new Map();

function copyValue(value) {
    return Array.isArray(value) ? [...value] : value;
}

function pickValues(config, keys = SETTING_KEYS) {
    const values = {};
    for (const key of keys) {
        if (Object.hasOwn(config, key) && config[key] !== undefined) values[key] = copyValue(config[key]);
    }
    return values;
}

function settingsError(code, message, status, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    Object.assign(error, { applied: false, code, persisted: false, status });
    return error;
}

/**
 * One writer for runtime settings. ConfigLoader remains the sole startup
 * loader, including its existing environment/runtime-file precedence.
 *
 * snapshot(): flat settings plus persistentKeys (no credentials).
 * update(patch), toggle(key): {values, persisted, applied, applicationError?}.
 * persisted means this operation wrote the persistent subset; memory-only
 * patches return false. Invalid input/persistence failures reject with typed
 * errors, without changing config or invoking onApplied.
 *
 * onApplied({values, previous, changedKeys, persisted}) runs after commit and
 * is awaited inside the queue. changedKeys includes explicitly reapplied keys
 * so a caller can retry an application failure with the same patch. Callback
 * inputs are detached snapshots. It must not await a write to this same store.
 * An application failure returns applied:false and does not roll back a commit.
 */
class RuntimeSettingsStore {
    constructor({
        config,
        logger,
        filePath = path.join(process.cwd(), "configs", "runtime-settings.json"),
        onApplied,
    }) {
        if (!config || typeof config !== "object" || Array.isArray(config)) {
            throw new TypeError("RuntimeSettingsStore requires a shared config object.");
        }
        if (onApplied !== undefined && typeof onApplied !== "function") {
            throw new TypeError("onApplied must be a function.");
        }
        this.config = config;
        this.logger = logger;
        this.filePath = path.resolve(filePath);
        this.onApplied = onApplied;
        this._writerKey = process.platform === "win32" ? this.filePath.toLowerCase() : this.filePath;
    }

    snapshot() {
        return { debugMode: false, ...pickValues(this.config), persistentKeys: [...PERSISTENT_KEYS] };
    }

    async update(patch) {
        // Capture/validate before enqueueing so callers cannot mutate pending input.
        const validated = this._validatePatch(patch);
        return this._enqueue(() => this._update(validated));
    }

    async toggle(key) {
        if (!BOOLEAN_KEYS.includes(key)) {
            throw settingsError("INVALID_SETTINGS", "Only boolean runtime settings can be toggled.", 400);
        }
        // Compute the toggle at execution time, never from a stale snapshot.
        return this._enqueue(() => this._update({ [key]: !this.config[key] }));
    }

    // Compatibility helper for saving the current persistent subset. New
    // updates must use update(patch), never mutate config before calling save().
    async save() {
        return this._enqueue(async () => {
            const values = pickValues(this.config);
            this._validatePatch(pickValues(values, PERSISTENT_KEYS));
            this._checkCooldown(values, {});
            await this._persist(values);
            return { applied: true, persisted: true, values };
        });
    }

    _enqueue(operation) {
        const previous = writers.get(this._writerKey) || Promise.resolve();
        const result = previous.then(operation);
        const tail = result.catch(() => {});
        writers.set(this._writerKey, tail);
        void tail.then(() => {
            if (writers.get(this._writerKey) === tail) writers.delete(this._writerKey);
        });
        return result;
    }

    _validatePatch(patch) {
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
            throw settingsError("INVALID_SETTINGS", "Settings patch must be an object.", 400);
        }
        const validated = {};
        for (const key of Reflect.ownKeys(patch)) {
            if (!SETTING_KEYS.includes(key)) {
                throw settingsError("INVALID_SETTINGS", "Settings patch contains an unsupported key.", 400);
            }
            const value = patch[key];
            let valid;
            if (Object.hasOwn(INTEGER_RANGES, key)) {
                const [min, max] = INTEGER_RANGES[key];
                valid = Number.isInteger(value) && value >= min && value <= max;
            } else if (key === "logMaxCount") {
                valid = Number.isSafeInteger(value) && value > 0;
            } else if (BOOLEAN_KEYS.includes(key)) {
                valid = typeof value === "boolean";
            } else if (key === "streamingMode") {
                valid = value === "real" || value === "fake";
            } else if (key === "safetySettingsThreshold") {
                valid = SAFETY_THRESHOLDS.has(value);
            } else {
                valid =
                    Array.isArray(value) &&
                    Array.from(value).every(code => Number.isInteger(code) && code >= 400 && code <= 599);
            }
            if (!valid) throw settingsError("INVALID_SETTINGS", `Invalid value for ${key}.`, 400);
            validated[key] = Array.isArray(value) ? [...new Set(value)] : value;
        }
        return validated;
    }

    _checkCooldown(candidate, patch) {
        if (candidate.accountCooldownMs > candidate.accountCooldownMaxMs) {
            // Preserve the old UI behavior when raising only the base cooldown.
            if (Object.hasOwn(patch, "accountCooldownMs") && !Object.hasOwn(patch, "accountCooldownMaxMs")) {
                candidate.accountCooldownMaxMs = candidate.accountCooldownMs;
                patch.accountCooldownMaxMs = candidate.accountCooldownMs;
            } else {
                throw settingsError(
                    "INVALID_SETTINGS",
                    "Maximum account cooldown must be at least the base cooldown.",
                    400
                );
            }
        }
    }

    async _update(validated) {
        const previous = pickValues(this.config);
        const patch = pickValues(validated);
        const candidate = { ...previous, ...patch };
        this._checkCooldown(candidate, patch);
        const changedKeys = Object.keys(patch);
        const persisted = changedKeys.some(key => PERSISTENT_KEYS.includes(key));
        if (persisted) await this._persist(candidate);

        for (const key of changedKeys) this.config[key] = copyValue(candidate[key]);
        const result = { applied: true, persisted, values: pickValues(candidate) };
        if (changedKeys.length && this.onApplied) {
            try {
                await this.onApplied({
                    changedKeys: [...changedKeys],
                    persisted,
                    previous,
                    values: pickValues(candidate),
                });
            } catch {
                // Callback errors may contain URLs/tokens. Public error details
                // deliberately describe the stage, rather than echoing them.
                result.applied = false;
                result.applicationError = {
                    code: "SETTINGS_APPLICATION_FAILED",
                    message: "Settings were committed, but applying runtime side effects failed. Reapply to retry.",
                };
                this._warn("[RuntimeSettings] Settings committed; runtime side effects failed.");
            }
        }
        return result;
    }

    async _persist(candidate) {
        const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        const content = Buffer.from(`${JSON.stringify(pickValues(candidate, PERSISTENT_KEYS), null, 2)}\n`, "utf8");
        try {
            await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
            const handle = await fs.promises.open(temporaryPath, "wx", 0o600);
            try {
                await handle.writeFile(content);
                await handle.sync();
            } finally {
                await handle.close();
            }
            try {
                // Never unlink the destination: rename failure must leave the
                // last good file available, including Windows/bind mounts.
                await fs.promises.rename(temporaryPath, this.filePath);
            } catch (error) {
                if (!FALLBACK_ERRORS.has(error.code)) throw error;
                await this._rewriteMountedFile(content);
            }
        } catch (cause) {
            if (cause.code === "SETTINGS_PERSISTENCE_RECOVERY_FAILED") throw cause;
            throw settingsError("SETTINGS_PERSISTENCE_FAILED", "Failed to persist runtime settings.", 500, cause);
        } finally {
            await fs.promises.rm(temporaryPath, { force: true }).catch(() => {
                this._warn("[RuntimeSettings] Could not remove a temporary settings file.");
            });
        }
    }

    async _rewriteMountedFile(content) {
        // In-place writes preserve the bind-mounted inode. They cannot be
        // crash-atomic; on ordinary I/O failure restore exact original bytes.
        const handle = await fs.promises.open(this.filePath, "r+");
        try {
            const original = await handle.readFile();
            try {
                await this._writeBuffer(handle, content);
            } catch (cause) {
                try {
                    await this._writeBuffer(handle, original);
                } catch {
                    const error = settingsError(
                        "SETTINGS_PERSISTENCE_RECOVERY_FAILED",
                        "Settings persistence and recovery failed; the on-disk settings require inspection.",
                        500,
                        cause
                    );
                    error.diskStateUncertain = true;
                    throw error;
                }
                throw cause;
            }
        } finally {
            // sync() defines write success; a close error must not misreport a
            // committed write as uncommitted and leave live config behind disk.
            await handle.close().catch(() => this._warn("[RuntimeSettings] Could not close the settings file."));
        }
    }

    async _writeBuffer(handle, content) {
        let offset = 0;
        while (offset < content.length) {
            const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset);
            if (bytesWritten <= 0) throw new Error("Settings write made no progress.");
            offset += bytesWritten;
        }
        await handle.truncate(content.length);
        await handle.sync();
    }

    _warn(message) {
        // Logging must not turn an already committed write into a failed one.
        try {
            this.logger?.warn?.(message);
        } catch {
            // Optional logger failure does not affect settings state.
        }
    }
}

module.exports = RuntimeSettingsStore;
