const fs = require("fs");
const path = require("path");
const { createHash, randomUUID } = require("crypto");
const { invalidReceipt, operationKey, publicReceipt } = require("./UploadReceipt");

const STATE_FIELDS = ["disabled", "expired", "disabledReason", "disabledStatus", "disabledAt"];
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const error = (code, status, message, cause) => Object.assign(new Error(message), { cause, code, status });

/** Single-process store. Each queued operation commits synchronously so legacy synchronous
 * reloads cannot observe half a transaction. Browser work must happen outside these queues.
 * The rollback journal also recovers transactions interrupted between two file renames.
 */
class CredentialStore {
    constructor({ rootDir = process.cwd(), logger } = {}) {
        this.rootDir = path.resolve(rootDir);
        this.logger = logger;
        this.authDir = path.join(this.rootDir, "configs", "auth");
        this.managementDir = path.join(this.rootDir, "data", "management");
        this.archiveDir = path.join(this.managementDir, "credential-archives");
        this.metadataPath = path.join(this.managementDir, "credentials.json");
        this.journalPath = path.join(this.managementDir, "credentials-journal.json");
        this.queues = new Map();
        try {
            fs.mkdirSync(this.authDir, { recursive: true });
            fs.mkdirSync(this.archiveDir, { mode: 0o700, recursive: true });
            this._recover();
            const saved = this._readText(this.metadataPath);
            this.state = saved !== null ? JSON.parse(saved) : { accounts: {}, highWater: -1, schemaVersion: 1 };
            if (
                !this.state ||
                this.state.schemaVersion !== 1 ||
                !Number.isSafeInteger(this.state.highWater) ||
                this.state.highWater < -1 ||
                !this.state.accounts ||
                typeof this.state.accounts !== "object" ||
                Array.isArray(this.state.accounts)
            ) {
                throw new Error("Invalid credential metadata");
            }
            for (const [index, record] of Object.entries(this.state.accounts)) {
                if (
                    !record ||
                    String(record.index) !== index ||
                    !Number.isSafeInteger(record.index) ||
                    record.index < 0 ||
                    record.index > this.state.highWater ||
                    !Number.isSafeInteger(record.credentialVersion) ||
                    record.credentialVersion < 1 ||
                    !Number.isSafeInteger(record.stateVersion) ||
                    record.stateVersion < 1 ||
                    !/^[a-f0-9-]{36}$/.test(record.accountId) ||
                    !/^auth-\d+\.json$/.test(record.fileName)
                ) {
                    throw new Error("Invalid credential account metadata");
                }
            }
            if (this.state.uploadReceipts !== undefined) {
                if (
                    !this.state.uploadReceipts ||
                    typeof this.state.uploadReceipts !== "object" ||
                    Array.isArray(this.state.uploadReceipts)
                )
                    throw invalidReceipt();
                for (const [key, receipt] of Object.entries(this.state.uploadReceipts)) {
                    const [taskId, itemIndex] = key.split(":");
                    if (operationKey({ itemIndex: Number(itemIndex), kind: receipt?.kind, taskId }) !== key)
                        throw invalidReceipt();
                    publicReceipt(receipt);
                }
            }
            this.refreshSync();
        } catch (cause) {
            throw error("PERSISTENCE_ERROR", 500, "Unable to initialize credential storage", cause);
        }
    }

    static validate(content) {
        let data;
        try {
            data = typeof content === "string" ? JSON.parse(content) : clone(content);
        } catch {
            throw error("INVALID_CREDENTIALS", 400, "Credentials must be a JSON object");
        }
        const object = value => value && typeof value === "object" && !Array.isArray(value);
        const invalid = () => {
            throw error("INVALID_CREDENTIALS", 400, "Invalid Playwright cookies/origins storage state");
        };
        if (!object(data) || !Array.isArray(data.cookies) || !Array.isArray(data.origins)) invalid();
        if (data.accountName !== undefined && typeof data.accountName !== "string") invalid();
        for (const cookie of data.cookies) {
            if (
                !object(cookie) ||
                !["name", "value", "domain", "path"].every(key => typeof cookie[key] === "string") ||
                !Number.isFinite(cookie.expires) ||
                typeof cookie.httpOnly !== "boolean" ||
                typeof cookie.secure !== "boolean" ||
                !["Strict", "Lax", "None"].includes(cookie.sameSite)
            )
                invalid();
        }
        for (const origin of data.origins) {
            if (!object(origin) || typeof origin.origin !== "string" || !Array.isArray(origin.localStorage)) invalid();
            try {
                const url = new URL(origin.origin);
                if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin.origin) invalid();
            } catch {
                invalid();
            }
            if (
                !origin.localStorage.every(
                    item => object(item) && typeof item.name === "string" && typeof item.value === "string"
                )
            )
                invalid();
            if (origin.indexedDB !== undefined && !Array.isArray(origin.indexedDB)) invalid();
        }
        return data;
    }

    _index(index) {
        if (!Number.isSafeInteger(index) || index < 0) throw error("INVALID_INDEX", 400, "Invalid account index");
        return index;
    }

    _enqueue(key, fn) {
        const previous = this.queues.get(key) || Promise.resolve();
        const next = previous
            .catch(() => {})
            .then(() => {
                try {
                    return fn();
                } catch (cause) {
                    if (cause.status) throw cause;
                    throw error("PERSISTENCE_ERROR", 500, "Credential storage operation failed", cause);
                }
            });
        this.queues.set(key, next);
        const cleanup = () => {
            if (this.queues.get(key) === next) this.queues.delete(key);
        };
        next.then(cleanup, cleanup);
        return next;
    }

    _readText(file) {
        try {
            return fs.readFileSync(file, "utf8");
        } catch (cause) {
            if (cause.code === "ENOENT") return null;
            throw error("PERSISTENCE_ERROR", 500, "Failed to read credential storage", cause);
        }
    }

    _atomicWrite(file, text) {
        const temporary = `${file}.${randomUUID()}.tmp`;
        let fd;
        try {
            fd = fs.openSync(temporary, "wx", 0o600);
            fs.writeFileSync(fd, text, "utf8");
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            fs.renameSync(temporary, file);
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
    }

    _writeOrRemove(file, text) {
        if (text !== null) this._atomicWrite(file, text);
        else if (fs.existsSync(file)) fs.unlinkSync(file);
    }

    _journalFile(relative) {
        const file = path.resolve(this.rootDir, relative);
        const rel = path.relative(this.rootDir, file);
        if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Invalid journal path");
        return file;
    }

    _recover() {
        const saved = this._readText(this.journalPath);
        if (saved === null) return;
        const journal = JSON.parse(saved);
        for (const entry of journal.files) this._writeOrRemove(this._journalFile(entry.path), entry.before);
        this._writeOrRemove(this.metadataPath, journal.metadata);
        fs.unlinkSync(this.journalPath);
    }

    _commit(candidate, writes = []) {
        if (this.poisoned) throw error("PERSISTENCE_ERROR", 500, "Credential storage requires restart recovery");
        let journalWritten = false;
        try {
            const journal = {
                files: writes.map(entry => ({
                    before: this._readText(entry.path),
                    path: path.relative(this.rootDir, entry.path),
                })),
                metadata: this._readText(this.metadataPath),
            };
            this._atomicWrite(this.journalPath, JSON.stringify(journal));
            journalWritten = true;
            for (const entry of writes) this._writeOrRemove(entry.path, entry.text);
            this._atomicWrite(this.metadataPath, JSON.stringify(candidate, null, 2));
            fs.unlinkSync(this.journalPath);
            this.state = candidate;
        } catch (cause) {
            if (journalWritten) {
                try {
                    this._recover();
                } catch (rollbackError) {
                    this.poisoned = true;
                    cause.rollbackError = rollbackError;
                }
            }
            throw error("PERSISTENCE_ERROR", 500, "Failed to persist credentials", cause);
        }
    }

    _authPath(record) {
        return path.join(this.authDir, record.fileName || `auth-${record.index}.json`);
    }

    _archivePath(record) {
        return path.join(this.archiveDir, `${record.accountId}.json`);
    }

    _stateFields(data) {
        return Object.fromEntries(STATE_FIELDS.filter(key => data[key] !== undefined).map(key => [key, data[key]]));
    }

    _describe(data, raw) {
        let schemaValid = true;
        try {
            CredentialStore.validate(data);
        } catch {
            schemaValid = false;
        }
        const credentials = { ...data };
        for (const key of STATE_FIELDS) delete credentials[key];
        return {
            accountName: typeof data?.accountName === "string" ? data.accountName : null,
            ...this._stateFields(data || {}),
            credentialHash: hash(schemaValid ? credentials : raw),
            schemaValid,
            stateHash: hash(this._stateFields(data || {})),
        };
    }

    _public(record) {
        if (!record) return null;
        const { credentialHash, stateHash, fileName, ...metadata } = record;
        return clone(metadata);
    }

    getMetadata(index) {
        const record = this.state.accounts[this._index(index)];
        return record && !record.deleted ? this._public(record) : null;
    }

    listMetadata() {
        return Object.values(this.state.accounts)
            .filter(row => !row.deleted)
            .sort((a, b) => a.index - b.index)
            .map(row => this._public(row));
    }

    getUploadReceipt(operation) {
        if (this.poisoned) throw error("PERSISTENCE_ERROR", 500, "Credential storage requires restart recovery");
        const receipt = this.state.uploadReceipts?.[operationKey(operation)];
        if (!receipt) return null;
        if (receipt.kind !== operation.kind) throw invalidReceipt();
        return publicReceipt(receipt);
    }

    _recordUpload(candidate, record, operation) {
        if (!operation) return;
        const key = operationKey(operation);
        // Replaying a task must never overwrite its evidence or create another account/version.
        if (candidate.uploadReceipts?.[key]) throw invalidReceipt();
        candidate.uploadReceipts ||= {};
        candidate.uploadReceipts[key] = {
            ...publicReceipt({
                ...record,
                committedAt: new Date().toISOString(),
                status: "committed",
            }),
            kind: operation.kind,
        };
    }

    read(index) {
        const record = this.state.accounts[this._index(index)];
        if (!record || record.deleted || record.archived || this.poisoned) return null;
        try {
            return CredentialStore.validate(this._readText(this._authPath(record)));
        } catch (cause) {
            if (cause.code === "INVALID_CREDENTIALS") return null;
            throw cause;
        }
    }

    /** Synchronous compatibility entrypoint used by AuthSource.reloadAuthSources. */
    refreshSync() {
        if (this.poisoned) throw error("PERSISTENCE_ERROR", 500, "Credential storage requires restart recovery");
        const candidate = clone(this.state);
        const present = new Set();
        for (const file of fs.readdirSync(this.authDir).sort()) {
            const numbered = /^auth-(\d+)(?:\.|$)/.exec(file);
            if (!numbered) continue;
            const index = Number(numbered[1]);
            if (!Number.isSafeInteger(index))
                throw error("INVALID_INDEX", 400, "Auth filename exceeds supported index range");
            candidate.highWater = Math.max(candidate.highWater, index);
            if (!/^auth-\d+\.json$/.test(file) || !fs.statSync(path.join(this.authDir, file)).isFile()) continue;
            const previous = candidate.accounts[index];
            // Tombstones are authoritative: external stale files cannot resurrect an account.
            if (previous?.deleted || previous?.archived || (previous && previous.fileName !== file)) continue;
            const raw = this._readText(path.join(this.authDir, file));
            let data;
            try {
                data = JSON.parse(raw);
            } catch {
                data = null;
            }
            const details = this._describe(data, raw);
            const now = new Date().toISOString();
            const record = previous || {
                accountId: randomUUID(),
                archived: false,
                createdAt: now,
                credentialVersion: 1,
                deleted: false,
                fileName: file,
                index,
                stateVersion: 1,
                updatedAt: now,
            };
            if (previous && details.credentialHash !== previous.credentialHash) record.credentialVersion++;
            if (previous && details.stateHash !== previous.stateHash) record.stateVersion++;
            if (
                previous &&
                (details.credentialHash !== previous.credentialHash || details.stateHash !== previous.stateHash)
            )
                record.updatedAt = now;
            for (const key of STATE_FIELDS) delete record[key];
            Object.assign(record, details);
            candidate.accounts[index] = record;
            present.add(index);
        }
        for (const record of Object.values(candidate.accounts)) {
            if (!record.deleted && !record.archived && !present.has(record.index)) {
                record.deleted = true;
                record.deletedAt = new Date().toISOString();
                record.credentialVersion++;
                record.stateVersion++;
            }
        }
        const changed = JSON.stringify(candidate) !== JSON.stringify(this.state);
        if (changed) this._commit(candidate);
        return changed;
    }

    async refresh() {
        return this._enqueue("allocation", () => this.refreshSync());
    }

    _active(index, options = {}) {
        this._index(index);
        this.refreshSync();
        const record = this.state.accounts[index];
        if (!record || record.deleted || record.archived) {
            throw error(
                options.expectedCredentialVersion !== undefined ? "VERSION_CONFLICT" : "ACCOUNT_NOT_FOUND",
                options.expectedCredentialVersion !== undefined ? 409 : 404,
                "Account is no longer active"
            );
        }
        this._checkVersions(record, options);
        return record;
    }

    _checkVersions(record, options) {
        for (const key of ["Credential", "State"]) {
            const expected = options[`expected${key}Version`];
            if (expected !== undefined && expected !== record[`${key.toLowerCase()}Version`]) {
                throw error("VERSION_CONFLICT", 409, "Account changed since the operation started");
            }
        }
    }

    _save(record, data, { credential = false, state = false, uploadOperation } = {}) {
        const candidate = clone(this.state);
        const raw = JSON.stringify(data, null, 2);
        const updated = candidate.accounts[record.index];
        for (const key of STATE_FIELDS) delete updated[key];
        Object.assign(updated, this._describe(data, raw), { updatedAt: new Date().toISOString() });
        if (credential) updated.credentialVersion++;
        if (state) updated.stateVersion++;
        this._recordUpload(candidate, updated, uploadOperation);
        this._commit(candidate, [{ path: this._authPath(record), text: raw }]);
        return { ...this._public(updated), changed: true };
    }

    async create(content, { disabled = false, reason = "pending_verification", uploadOperation } = {}) {
        const data = CredentialStore.validate(content);
        if (uploadOperation && uploadOperation.kind !== "import") throw invalidReceipt();
        if (typeof disabled !== "boolean" || typeof reason !== "string")
            throw error("INVALID_STATE", 400, "Invalid initial account state");
        for (const key of STATE_FIELDS) delete data[key];
        if (disabled)
            Object.assign(data, { disabled: true, disabledAt: new Date().toISOString(), disabledReason: reason });
        return this._enqueue("allocation", () => {
            this.refreshSync();
            if (uploadOperation && this.getUploadReceipt(uploadOperation)) throw invalidReceipt();
            const reservation = clone(this.state);
            const index = reservation.highWater + 1;
            this._index(index);
            reservation.highWater = index;
            // Persist the reservation separately: even an unsuccessful creation never reuses its number.
            this._commit(reservation);
            const candidate = clone(this.state);
            const now = new Date().toISOString();
            const raw = JSON.stringify(data, null, 2);
            const record = {
                accountId: randomUUID(),
                archived: false,
                createdAt: now,
                credentialVersion: 1,
                deleted: false,
                fileName: `auth-${index}.json`,
                index,
                stateVersion: 1,
                updatedAt: now,
                ...this._describe(data, raw),
            };
            candidate.accounts[index] = record;
            this._recordUpload(candidate, record, uploadOperation);
            this._commit(candidate, [{ path: this._authPath(record), text: raw }]);
            return { ...this._public(record), changed: true };
        });
    }

    async replace(index, content, options = {}) {
        this._index(index);
        if (options.uploadOperation && options.uploadOperation.kind !== "replace") throw invalidReceipt();
        const data = CredentialStore.validate(content);
        return this._enqueue(index, () => {
            const record = this._active(index, options);
            for (const key of STATE_FIELDS) delete data[key];
            Object.assign(data, this._stateFields(record));
            return this._save(record, data, { credential: true, uploadOperation: options.uploadOperation });
        });
    }

    async updateState(index, patch, options = {}) {
        this._index(index);
        if (!patch || typeof patch !== "object" || Array.isArray(patch))
            throw error("INVALID_STATE", 400, "Invalid account state patch");
        for (const [key, value] of Object.entries(patch)) {
            if (
                !STATE_FIELDS.includes(key) ||
                (value !== null &&
                    (["disabled", "expired"].includes(key)
                        ? typeof value !== "boolean"
                        : key === "disabledStatus"
                          ? !Number.isFinite(value)
                          : typeof value !== "string"))
            ) {
                throw error("INVALID_STATE", 400, "Unsupported account state field or value");
            }
        }
        patch = clone(patch);
        return this._enqueue(index, () => {
            const record = this._active(index, options);
            const data = this.read(index);
            if (!data) throw error("INVALID_CREDENTIALS", 400, "Account credentials are invalid");
            for (const [key, value] of Object.entries(patch)) {
                if (value === null) delete data[key];
                else data[key] = value;
            }
            if (hash(this._stateFields(data)) === record.stateHash) return { ...this._public(record), changed: false };
            return this._save(record, data, { state: true });
        });
    }

    async mergeStorageState(index, state, { expectedCredentialVersion } = {}) {
        this._index(index);
        if (!Number.isSafeInteger(expectedCredentialVersion) || expectedCredentialVersion < 1) {
            throw error("VERSION_REQUIRED", 400, "expectedCredentialVersion is required for storage state refresh");
        }
        const data = CredentialStore.validate({ cookies: state?.cookies, origins: state?.origins });
        return this._enqueue(index, () => {
            const record = this._active(index, { expectedCredentialVersion });
            const current = this.read(index);
            if (!current) throw error("INVALID_CREDENTIALS", 400, "Account credentials are invalid");
            return this._save(
                record,
                { ...current, cookies: data.cookies, origins: data.origins },
                { credential: true }
            );
        });
    }

    async remove(index, options = {}) {
        this._index(index);
        return this._enqueue(index, () => {
            this.refreshSync();
            const record = this.state.accounts[index];
            if (!record || record.deleted) throw error("ACCOUNT_NOT_FOUND", 404, "Account does not exist");
            this._checkVersions(record, options);
            const candidate = clone(this.state);
            const updated = candidate.accounts[index];
            Object.assign(updated, {
                credentialVersion: record.credentialVersion + 1,
                deleted: true,
                deletedAt: new Date().toISOString(),
                stateVersion: record.stateVersion + 1,
                updatedAt: new Date().toISOString(),
            });
            this._commit(candidate, [
                { path: this._authPath(record), text: null },
                { path: this._archivePath(record), text: null },
            ]);
            return { ...this._public(updated), changed: true, removedIndex: index };
        });
    }

    async archive(index) {
        this._index(index);
        return this._enqueue(index, () => {
            const record = this._active(index);
            const candidate = clone(this.state);
            const updated = candidate.accounts[index];
            Object.assign(updated, {
                archived: true,
                archivedAt: new Date().toISOString(),
                credentialVersion: record.credentialVersion + 1,
                stateVersion: record.stateVersion + 1,
                updatedAt: new Date().toISOString(),
            });
            this._commit(candidate, [
                { path: this._archivePath(record), text: this._readText(this._authPath(record)) },
                { path: this._authPath(record), text: null },
            ]);
            return { ...this._public(updated), changed: true };
        });
    }

    async restore(accountId) {
        const found = Object.values(this.state.accounts).find(row => row.accountId === accountId && !row.deleted);
        if (!found) throw error("ACCOUNT_NOT_FOUND", 404, "Archived account does not exist");
        return this._enqueue(found.index, () => {
            this.refreshSync();
            const record = this.state.accounts[found.index];
            if (record.deleted || !record.archived)
                throw error("VERSION_CONFLICT", 409, "Account is no longer archived");
            if (fs.existsSync(this._authPath(record)))
                throw error("VERSION_CONFLICT", 409, "Account path was occupied outside the store");
            const data = CredentialStore.validate(this._readText(this._archivePath(record)));
            Object.assign(data, { disabled: true, disabledAt: new Date().toISOString(), disabledReason: "manual" });
            delete data.disabledStatus;
            const candidate = clone(this.state);
            const updated = candidate.accounts[record.index];
            for (const key of STATE_FIELDS) delete updated[key];
            const raw = JSON.stringify(data, null, 2);
            Object.assign(updated, this._describe(data, raw), {
                archived: false,
                credentialVersion: record.credentialVersion + 1,
                restoredAt: new Date().toISOString(),
                stateVersion: record.stateVersion + 1,
                updatedAt: new Date().toISOString(),
            });
            this._commit(candidate, [
                { path: this._authPath(record), text: raw },
                { path: this._archivePath(record), text: null },
            ]);
            return { ...this._public(updated), changed: true };
        });
    }
}

module.exports = CredentialStore;
