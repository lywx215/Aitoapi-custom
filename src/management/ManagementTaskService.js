const fs = require("fs");
const path = require("path");
const { createHash, randomUUID } = require("crypto");
const { failure, safeError, clone, canonical, atomicWrite, page } = require("./ManagementSupport");
const { invalidReceipt, publicReceipt } = require("../storage/UploadReceipt");

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled", "interrupted"]);
const STATES = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"];
const now = () => new Date().toISOString();
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");

/** Single process durable queue. Register every handler before start().
 * submit({kind,keyId,idempotencyKey,method,path,payload,items,requestId,scopes})
 * register(kind, async (privatePayload, context) => void)
 * context: signal, check(), item(index, async itemContext => result).
 * itemContext: check(), progress(stage,percent), identify(metadata), committed(result?).
 * All public errors use fixed messages; private input is never part of snapshots.
 */
class ManagementTaskService {
    constructor({ rootDir = process.cwd(), logger, keyStore } = {}) {
        this.logger = logger;
        this.keyStore = keyStore;
        this.dir = path.join(rootDir, "data", "management");
        this.privateDir = path.join(this.dir, "task-inputs");
        this.file = path.join(this.dir, "tasks.json");
        this.handlers = new Map();
        this.controllers = new Map();
        this.started = false;
        this.closing = false;
        fs.mkdirSync(this.privateDir, { mode: 0o700, recursive: true });
        try {
            this.state = fs.existsSync(this.file)
                ? JSON.parse(fs.readFileSync(this.file, "utf8"))
                : { audit: [], idempotency: {}, tasks: [], version: 1 };
            if (
                this.state.version !== 1 ||
                !Array.isArray(this.state.tasks) ||
                !Array.isArray(this.state.audit) ||
                !this.state.idempotency
            )
                throw failure("PERSISTENCE_ERROR");
            for (const task of this.state.tasks) {
                if (!/^task_[a-f0-9-]{36}$/.test(task.taskId)) throw failure("PERSISTENCE_ERROR");
                if (task.status === "running") this._stop(task, "interrupted");
            }
            this.prune();
            this._persist();
            this._cleanPrivate();
        } catch {
            throw failure("PERSISTENCE_ERROR");
        }
        this.onRevoked = keyId => {
            try {
                this.cancelForKey(keyId);
            } catch {
                this.poisoned = true;
            }
        };
        keyStore?.on?.("revoked", this.onRevoked);
    }

    register(kind, handler) {
        if (this.started || this.handlers.has(kind)) throw failure("INVALID_STATE");
        this.handlers.set(kind, handler);
    }
    attachUploadStore(store) {
        if (this.started || this.uploadStore || typeof store?.getUploadReceipt !== "function")
            throw failure("INVALID_STATE");
        this.uploadStore = store;
        // Credential journal recovery precedes this attachment. Task construction may already
        // have discarded interrupted private inputs; the durable task/item identity is sufficient.
        let changed = false;
        for (const task of this.state.tasks) {
            let recovered = false;
            for (let index = 0; index < task.items.length; index++) {
                recovered = this._recoverUpload(task, index) || recovered;
            }
            if (recovered) {
                // Never replay credentials/model calls if a stale task snapshot still says queued.
                if (task.status === "queued") this._stop(task, "interrupted");
                task.result = {
                    ...task.result,
                    accountIds: [...new Set(task.items.filter(item => item.accountId).map(item => item.accountId))],
                    changed: true,
                };
                changed = true;
            }
        }
        if (changed) this._persist();
    }
    _recoverUpload(task, index, required = false) {
        if (!["import", "replace"].includes(task.kind) || !this.uploadStore) {
            if (required) throw failure("INVALID_STATE");
            return false;
        }
        const value = this.uploadStore.getUploadReceipt({ itemIndex: index, kind: task.kind, taskId: task.taskId });
        if (!value) {
            if (required) throw invalidReceipt();
            return false;
        }
        const receipt = publicReceipt(value);
        const item = task.items[index];
        if (
            (item.accountId !== undefined && item.accountId !== receipt.accountId) ||
            (item.index !== undefined && item.index !== receipt.index) ||
            (item.upload && canonical(publicReceipt(item.upload)) !== canonical(receipt))
        )
            throw invalidReceipt();
        Object.assign(item, { accountId: receipt.accountId, index: receipt.index, upload: receipt });
        task.result.changed = true;
        return true;
    }
    start() {
        if (this.closing) throw failure("INVALID_STATE");
        for (const task of this.state.tasks)
            if (task.status === "queued" && !this.handlers.has(task.kind)) throw failure("INVALID_STATE");
        this.started = true;
        if (!this.retentionTimer) {
            this.retentionTimer = setInterval(
                () => {
                    try {
                        this.prune();
                        this._persist();
                        this._cleanPrivate();
                    } catch {
                        this.poisoned = true;
                    }
                },
                60 * 60 * 1000
            );
            this.retentionTimer.unref?.();
        }
        this._schedule();
    }
    _persist() {
        try {
            atomicWrite(this.file, this.state);
        } catch (error) {
            this.poisoned = true;
            throw error;
        }
    }
    _inputPath(id) {
        return path.join(this.privateDir, `${id}.json`);
    }
    _cleanPrivate() {
        const keep = new Set(this.state.tasks.filter(t => !TERMINAL.has(t.status)).map(t => `${t.taskId}.json`));
        for (const file of fs.readdirSync(this.privateDir)) {
            if (/^task_[a-f0-9-]{36}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(file) && !keep.has(file))
                fs.unlinkSync(path.join(this.privateDir, file));
        }
    }
    prune() {
        const cutoff = Date.now() - RETENTION_MS;
        this.state.tasks = this.state.tasks.filter(t => {
            if (t.status === "queued") return Date.parse(t.createdAt) >= cutoff;
            return !TERMINAL.has(t.status) || Date.parse(t.finishedAt || t.updatedAt) >= cutoff;
        });
        const ids = new Set(this.state.tasks.map(t => t.taskId));
        this.state.idempotency = Object.fromEntries(
            Object.entries(this.state.idempotency).filter(([, v]) => ids.has(v.taskId))
        );
        this.state.audit = this.state.audit.filter(a => Date.parse(a.timestamp) >= cutoff);
    }
    _check(keyId, signal) {
        if (this.poisoned) throw failure("PERSISTENCE_ERROR");
        if (this.closing) throw failure("INTERRUPTED");
        if (signal?.aborted) throw failure("CANCELLED");
        if (!this.keyStore?.isActive(keyId)) throw failure("UNAUTHORIZED");
    }
    submit({ kind, keyId, idempotencyKey, method, path: endpoint, payload, items, requestId, scopes = [] }) {
        this._check(keyId);
        if (!this.handlers.has(kind)) throw failure("INVALID_STATE");
        if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 256)
            throw failure("IDEMPOTENCY_KEY_REQUIRED");
        this.prune();
        const key = digest([keyId, idempotencyKey]);
        const content = digest({ method, path: endpoint, payload });
        const previous = this.state.idempotency[key];
        if (previous) {
            if (previous.content !== content) throw failure("IDEMPOTENCY_CONFLICT");
            return { status: "queued", taskId: previous.taskId };
        }
        if (this.state.tasks.filter(t => !TERMINAL.has(t.status)).length >= 1000) throw failure("RATE_LIMITED");
        const taskId = `task_${randomUUID()}`;
        const time = now();
        const task = {
            createdAt: time,
            createdByKeyId: keyId,
            finishedAt: null,
            items: items.map(item => ({ ...this._identity(item), progress: 0, stage: "queued", status: "queued" })),
            kind,
            result: { accountIds: [], changed: false },
            startedAt: null,
            status: "queued",
            taskId,
            updatedAt: time,
        };
        this._count(task);
        atomicWrite(this._inputPath(taskId), { payload: clone(payload), requestId, scopes });
        this.state.tasks.push(task);
        this.state.idempotency[key] = { content, taskId };
        this._audit({ action: kind, createdByKeyId: keyId, outcome: "queued", requestId, taskId });
        this._persist();
        this._schedule();
        return { status: "queued", taskId };
    }
    _identity(value) {
        const output = {};
        if (typeof value?.accountId === "string") output.accountId = value.accountId;
        if (Number.isSafeInteger(value?.index) && value.index >= 0) output.index = value.index;
        if (typeof value?.clientRef === "string") output.clientRef = value.clientRef;
        return output;
    }
    _count(task) {
        task.counts = Object.fromEntries(STATES.map(s => [s, task.items.filter(i => i.status === s).length]));
        task.counts.total = task.items.length;
    }
    _touch(task) {
        task.updatedAt = now();
        this._count(task);
        this._persist();
    }
    _audit(entry) {
        const row = { auditId: `audit_${randomUUID()}`, timestamp: now() };
        for (const k of ["requestId", "createdByKeyId", "action", "outcome", "taskId", "accountId"])
            if (typeof entry[k] === "string") row[k] = entry[k];
        if (entry.error) row.error = safeError(entry.error);
        this.state.audit.push(row);
    }
    audit(entry) {
        this.prune();
        this._audit(entry);
        this._persist();
    }
    listAudit(options) {
        this.prune();
        return page(clone(this.state.audit).reverse(), options);
    }
    list(options) {
        this.prune();
        return page(clone(this.state.tasks).reverse(), options);
    }
    get(id) {
        this.prune();
        const task = this.state.tasks.find(t => t.taskId === id);
        if (!task) throw failure("NOT_FOUND");
        return clone(task);
    }
    _stop(task, status) {
        for (const item of task.items)
            if (!TERMINAL.has(item.status))
                Object.assign(item, { error: safeError(failure(status.toUpperCase())), stage: status, status });
        task.status = status;
        task.finishedAt = task.updatedAt = now();
        this._count(task);
        this._audit({
            action: task.kind,
            createdByKeyId: task.createdByKeyId,
            outcome: status,
            requestId: `req_${randomUUID()}`,
            taskId: task.taskId,
        });
    }
    cancel(id) {
        const task = this.state.tasks.find(t => t.taskId === id);
        if (!task) throw failure("NOT_FOUND");
        if (task.status === "queued") {
            this._stop(task, "cancelled");
            this._persist();
            this._cleanPrivate();
        } else if (task.status === "running") this.controllers.get(id)?.abort();
        return clone(task);
    }
    cancelForKey(keyId) {
        for (const task of this.state.tasks)
            if (task.createdByKeyId === keyId && task.status === "queued") this._stop(task, "cancelled");
        this._persist();
        this._cleanPrivate();
    }
    _schedule() {
        if (!this.started || this.closing || this.worker || this.poisoned) return;
        this.worker = new Promise(resolve => setImmediate(resolve))
            .then(async () => {
                for (;;) {
                    if (this.closing || this.poisoned) break;
                    const task = this.state.tasks.find(t => t.status === "queued");
                    if (!task) break;
                    await this._run(task);
                }
            })
            .catch(() => {
                this.poisoned = true;
            })
            .finally(() => {
                this.worker = null;
                if (this.state.tasks.some(task => task.status === "queued")) this._schedule();
            });
    }
    async _run(task) {
        const controller = new AbortController();
        this.controllers.set(task.taskId, controller);
        let input;
        const check = () => this._check(task.createdByKeyId, controller.signal);
        try {
            check();
            input = JSON.parse(fs.readFileSync(this._inputPath(task.taskId), "utf8"));
            const key = this.keyStore.list?.().find(k => k.id === task.createdByKeyId);
            if (key && !input.scopes.every(s => key.scopes.includes(s))) throw failure("FORBIDDEN");
            task.status = "running";
            task.startedAt = now();
            this._touch(task);
            await this.handlers.get(task.kind)(input.payload, {
                check,
                item: async (index, operation) => {
                    const item = task.items[index];
                    try {
                        check();
                        Object.assign(item, { progress: 0, stage: "starting", status: "running" });
                        this._touch(task);
                        const context = {
                            check,
                            committed: result => {
                                if (this.closing || this.poisoned) throw failure("INTERRUPTED");
                                Object.assign(item, { progress: 100, stage: "completed", status: "succeeded" });
                                if (result) item.result = this._verification(result);
                                this._touch(task);
                            },
                            identify: metadata => {
                                Object.assign(item, this._identity(metadata));
                                this._touch(task);
                            },
                            mutated: () => {
                                task.result.changed = true;
                                this._touch(task);
                            },
                            progress: (stage, progress) => {
                                check();
                                // Never propagate browser/page messages as public progress text.
                                item.stage = [
                                    "starting",
                                    "verifying",
                                    "connecting",
                                    "model",
                                    "draining",
                                    "committing",
                                ].includes(stage)
                                    ? stage
                                    : "verifying";
                                if (Number.isFinite(progress))
                                    item.progress = Math.max(0, Math.min(99, Math.floor(progress)));
                                this._touch(task);
                            },
                            signal: controller.signal,
                            uploaded: () => {
                                // Record a completed write even if cancellation arrived during that write.
                                // This is independent of committed(), which marks the entire item successful.
                                this._recoverUpload(task, index, true);
                                this._touch(task);
                            },
                            uploadOperation: { itemIndex: index, kind: task.kind, taskId: task.taskId },
                            verification: result => {
                                item.result = this._verification(result);
                                this._touch(task);
                            },
                        };
                        await operation(context);
                        if (item.status !== "succeeded") {
                            check();
                            context.committed();
                        }
                    } catch (error) {
                        // Also handle a failure between the store commit and the normal upload callback.
                        // Read immutable commit evidence, never the account's current versions.
                        this._recoverUpload(task, index);
                        // A committed item survives cancellation and later application failure.
                        if (item.status !== "succeeded") {
                            const safe = safeError(error);
                            const status = this.closing
                                ? "interrupted"
                                : controller.signal.aborted ||
                                    ["CANCELLED", "UNAUTHORIZED", "FORBIDDEN"].includes(safe.code)
                                  ? "cancelled"
                                  : "failed";
                            Object.assign(item, { error: safe, stage: item.result?.stage || status, status });
                            this._touch(task);
                        } else if (!controller.signal.aborted && !this.closing) {
                            task.error = safeError(error);
                        }
                    }
                },
                signal: controller.signal,
            });
        } catch (error) {
            task.error = safeError(error);
            const status = this.closing
                ? "interrupted"
                : ["UNAUTHORIZED", "FORBIDDEN", "CANCELLED"].includes(task.error.code)
                  ? "cancelled"
                  : "failed";
            for (const item of task.items)
                if (!TERMINAL.has(item.status)) Object.assign(item, { error: task.error, stage: status, status });
        } finally {
            this.controllers.delete(task.taskId);
            this._count(task);
            const c = task.counts;
            task.status =
                c.succeeded === c.total && !task.error
                    ? "succeeded"
                    : c.succeeded > 0
                      ? "partial"
                      : c.interrupted
                        ? "interrupted"
                        : c.cancelled
                          ? "cancelled"
                          : "failed";
            task.result = {
                accountIds: [...new Set(task.items.filter(i => i.accountId).map(i => i.accountId))],
                changed: task.result?.changed === true,
            };
            task.finishedAt = now();
            this._audit({
                action: task.kind,
                createdByKeyId: task.createdByKeyId,
                error: task.error,
                outcome: task.status,
                requestId: input?.requestId || `req_${randomUUID()}`,
                taskId: task.taskId,
            });
            this._touch(task);
            this._cleanPrivate();
        }
    }
    _verification(value) {
        // Callers validate attribution; no credentialState or arbitrary error strings leave this boundary.
        if (
            value.stage === "uploaded" &&
            value.success === true &&
            Number.isSafeInteger(value.credentialVersion) &&
            value.credentialVersion > 0 &&
            Number.isSafeInteger(value.stateVersion) &&
            value.stateVersion > 0
        )
            return {
                credentialVersion: value.credentialVersion,
                stage: "uploaded",
                stateVersion: value.stateVersion,
                success: true,
            };
        return {
            authIndex: value.authIndex,
            ...(value.success === true &&
            Number.isSafeInteger(value.credentialVersion) &&
            value.credentialVersion > 0 &&
            Number.isSafeInteger(value.stateVersion) &&
            value.stateVersion > 0
                ? { credentialVersion: value.credentialVersion, stateVersion: value.stateVersion }
                : {}),
            model: value.model,
            requestId: value.requestId,
            stage: [
                "model_verified",
                "connection_ready",
                "identity_unconfirmed",
                "identity_mismatch",
                "login_required",
                "permission_denied",
                "model_not_found",
                "quota_exceeded",
                "timeout",
                "cancelled",
            ].includes(value.stage)
                ? value.stage
                : "failed",
            success: value.success === true,
            upstreamStatus: value.upstreamStatus ?? null,
        };
    }
    async close() {
        this.closing = true;
        clearInterval(this.retentionTimer);
        this.keyStore?.off?.("revoked", this.onRevoked);
        for (const controller of this.controllers.values()) controller.abort();
        for (const task of this.state.tasks) if (task.status === "running") this._stop(task, "interrupted");
        this._persist();
        if (this.worker) await this.worker;
        this._cleanPrivate();
    }
}
module.exports = ManagementTaskService;
