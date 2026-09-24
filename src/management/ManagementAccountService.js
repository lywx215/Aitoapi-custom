const CredentialStore = require("../storage/CredentialStore");
const { failure, object, clone, page } = require("./ManagementSupport");

const MODEL = "gemini-3.8-flash";
const SETTINGS = [
    "maxContexts",
    "maxRetries",
    "retryDelay",
    "autoDisableStatusCodes",
    "accountCooldownMs",
    "accountCooldownMaxMs",
    "autoHealProbeIntervalMs",
    "autoHealProbeTimeoutMs",
    "checkUpdate",
    "debugMode",
    "enableAuthUpdate",
    "forceCodeExecution",
    "forceThinking",
    "forceUrlContext",
    "forceWebSearch",
    "safetySettingsThreshold",
    "streamingMode",
    "logMaxCount",
];
const versions = row => ({ expectedCredentialVersion: row.credentialVersion, expectedStateVersion: row.stateVersion });
const email = row => row.accountName?.trim().toLowerCase();

class ManagementAccountService {
    constructor(system, { taskService, verifier, keyStore }) {
        this.system = system;
        this.store = system.authSource.store;
        this.tasks = taskService;
        this.verifier = verifier;
        this.keyStore = keyStore;
        this.queues = new Map();
        taskService.attachUploadStore(this.store);
        for (const kind of ["import", "batch", "test", "replace", "archive", "restore", "reload", "reload-auth"])
            taskService.register(kind, (payload, context) => this._execute(kind, payload, context));
    }
    static credentials(input) {
        if (Buffer.byteLength(typeof input === "string" ? input : JSON.stringify(input) || "", "utf8") > 1048576)
            throw failure("PAYLOAD_TOO_LARGE");
        let value;
        try {
            value = typeof input === "string" ? JSON.parse(input) : clone(input);
            object(value, ["accountName", "cookies", "origins"], ["cookies", "origins"]);
            CredentialStore.validate(value);
            for (const cookie of value.cookies)
                object(cookie, ["name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite"]);
            for (const origin of value.origins) {
                object(origin, ["origin", "localStorage"]);
                for (const entry of origin.localStorage) object(entry, ["name", "value"]);
            }
        } catch {
            throw failure("INVALID_CREDENTIALS");
        }
        if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1048576) throw failure("PAYLOAD_TOO_LARGE");
        return value;
    }
    _model(body) {
        if (
            body.model !== undefined &&
            (typeof body.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(body.model))
        )
            throw failure("INVALID_REQUEST");
        return body.model || MODEL;
    }
    _ids(ids) {
        if (!Array.isArray(ids) || !ids.length) throw failure("INVALID_REQUEST");
        if (ids.length > 100) throw failure("PAYLOAD_TOO_LARGE");
        if (ids.some(id => typeof id !== "string" || !id.length || id.length > 256) || new Set(ids).size !== ids.length)
            throw failure("INVALID_REQUEST");
        return ids;
    }
    _force(body) {
        if (body.force !== undefined && typeof body.force !== "boolean") throw failure("INVALID_REQUEST");
        return body.force === true;
    }
    _find(id, allowArchived = false) {
        const row = this.store.listMetadata().find(row => row.accountId === id);
        if (!row || (row.archived && !allowArchived)) throw failure("NOT_FOUND");
        return row;
    }
    _account(row) {
        return {
            accountId: row.accountId,
            accountName: row.accountName ?? null,
            archived: !!row.archived,
            credentialVersion: row.credentialVersion,
            disabledAt: row.disabledAt ?? null,
            disabledReason: row.disabledReason ?? null,
            disabledStatus: row.disabledStatus ?? null,
            enabled: !row.disabled && !row.expired && !row.archived && row.schemaValid !== false,
            expired: !!row.expired,
            index: row.index,
            stateVersion: row.stateVersion,
        };
    }
    list(options) {
        return page(
            this.store.listMetadata().map(row => this._account(row)),
            options
        );
    }
    get(id) {
        return this._account(this._find(id, true));
    }
    _duplicates(items, exceptId) {
        const seen = new Set(
            this.store
                .listMetadata()
                .filter(r => r.accountId !== exceptId)
                .map(email)
                .filter(Boolean)
        );
        for (const item of items) {
            const name = email(item.credentials);
            if (name && seen.has(name)) throw failure("DUPLICATE_ACCOUNT");
            if (name) seen.add(name);
        }
    }
    validate(kind, body = {}, id) {
        if (kind === "import") {
            object(body, ["items", "model", "verify"], ["items"]);
            if (body.verify !== undefined && typeof body.verify !== "boolean") throw failure("INVALID_REQUEST");
            if (!Array.isArray(body.items) || !body.items.length) throw failure("INVALID_REQUEST");
            if (body.items.length > 100) throw failure("PAYLOAD_TOO_LARGE");
            const references = new Set();
            const items = body.items.map(item => {
                object(item, ["clientRef", "credentials"], ["clientRef", "credentials"]);
                if (
                    typeof item.clientRef !== "string" ||
                    !item.clientRef.trim() ||
                    item.clientRef.length > 128 ||
                    references.has(item.clientRef)
                )
                    throw failure("INVALID_REQUEST");
                references.add(item.clientRef);
                return {
                    clientRef: item.clientRef,
                    credentials: ManagementAccountService.credentials(item.credentials),
                };
            });
            // Validate the entire batch before admission or any credential write.
            return { items, model: this._model(body), verify: body.verify !== false };
        }
        if (kind === "replace") {
            if (body && Object.hasOwn(body, "credentials")) {
                object(
                    body,
                    ["credentials", "expectedCredentialVersion", "expectedStateVersion", "verify"],
                    ["credentials"]
                );
                if (body.verify !== undefined && typeof body.verify !== "boolean") throw failure("INVALID_REQUEST");
                const hasCredential = body.expectedCredentialVersion !== undefined;
                const hasState = body.expectedStateVersion !== undefined;
                if (
                    (body.verify === false && !hasCredential) ||
                    hasCredential !== hasState ||
                    (hasCredential &&
                        (!Number.isSafeInteger(body.expectedCredentialVersion) ||
                            body.expectedCredentialVersion < 1 ||
                            !Number.isSafeInteger(body.expectedStateVersion) ||
                            body.expectedStateVersion < 1))
                )
                    throw failure("INVALID_REQUEST");
                return {
                    credentials: ManagementAccountService.credentials(body.credentials),
                    id,
                    model: MODEL,
                    verify: body.verify !== false,
                    ...(hasCredential
                        ? {
                              expectedCredentialVersion: body.expectedCredentialVersion,
                              expectedStateVersion: body.expectedStateVersion,
                          }
                        : {}),
                };
            }
            return { credentials: ManagementAccountService.credentials(body), id, model: MODEL, verify: true };
        }
        if (kind === "batch") {
            object(body, ["action", "accountIds", "force"], ["action", "accountIds"]);
            if (!["enable", "disable", "archive"].includes(body.action)) throw failure("INVALID_REQUEST");
            return { accountIds: this._ids(body.accountIds), action: body.action, force: this._force(body) };
        }
        if (kind === "test") {
            object(body, ["mode", "model"]);
            if (body.mode !== undefined && !["model", "connection"].includes(body.mode))
                throw failure("INVALID_REQUEST");
            return { id, mode: body.mode || "model", model: this._model(body) };
        }
        object(body, ["archive", "reload"].includes(kind) ? ["force"] : []);
        return { ...(id ? { id } : {}), ...(["archive", "reload"].includes(kind) ? { force: this._force(body) } : {}) };
    }
    submit(kind, body, id, actor) {
        const payload = this.validate(kind, body, id);
        const items =
            kind === "import"
                ? payload.items
                : kind === "batch"
                  ? payload.accountIds.map(accountId => ({ accountId }))
                  : [{ ...(id ? { accountId: id } : {}) }];
        // Existence/duplicate checks execute in the task, preserving original admission on replay.
        return this.tasks.submit({ ...actor, items, kind, payload });
    }
    _checkActor(actor) {
        if (!this.keyStore.isActive(actor.keyId)) throw failure("UNAUTHORIZED");
    }
    async _serialized(index, operation) {
        const previous = this.queues.get(index) || Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        this.queues.set(index, next);
        try {
            return await next;
        } finally {
            if (this.queues.get(index) === next) this.queues.delete(index);
        }
    }
    _runtime() {
        const runtime = this.system.managementRuntime;
        if (
            !["blockAccount", "hasActiveRequests", "closeAccount", "rebalance"].every(
                name => typeof runtime?.[name] === "function"
            )
        )
            throw failure("INVALID_STATE");
        return runtime;
    }
    async _refreshPool() {
        this.system.authSource.reloadAuthSources();
        if (this.system.managementRuntime) await this.system.managementRuntime.rebalance();
        else if (this.system.browserManager?.rebalanceContextPool)
            await this.system.browserManager.rebalanceContextPool();
    }
    async _drain(index, force, context, operation) {
        const runtime = this._runtime();
        context.check();
        const release = runtime.blockAccount(index);
        if (typeof release !== "function") throw failure("INVALID_STATE");
        try {
            context.progress?.("draining", 80);
            const timeout = Math.min(60000, Math.max(0, this.system.managementDrainTimeoutMs ?? 60000));
            const deadline = Date.now() + timeout;
            while (!force && runtime.hasActiveRequests(index)) {
                context.check();
                if (Date.now() >= deadline) throw failure("ACCOUNT_BUSY");
                await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
            }
            context.check();
            return await operation(runtime);
        } finally {
            release();
        }
    }
    async patch(id, body, actor) {
        object(body, ["enabled", "force", "expectedCredentialVersion", "expectedStateVersion"], ["enabled"]);
        if (typeof body.enabled !== "boolean") throw failure("INVALID_REQUEST");
        const hasCredentialVersion = body.expectedCredentialVersion !== undefined;
        const hasStateVersion = body.expectedStateVersion !== undefined;
        if (
            hasCredentialVersion !== hasStateVersion ||
            (hasCredentialVersion &&
                (!Number.isSafeInteger(body.expectedCredentialVersion) ||
                    body.expectedCredentialVersion < 1 ||
                    !Number.isSafeInteger(body.expectedStateVersion) ||
                    body.expectedStateVersion < 1))
        )
            throw failure("INVALID_REQUEST");
        const expectedVersions = hasCredentialVersion
            ? {
                  expectedCredentialVersion: body.expectedCredentialVersion,
                  expectedStateVersion: body.expectedStateVersion,
              }
            : {};
        const force = this._force(body);
        const row = this._find(id);
        return this._serialized(row.index, async () => {
            this._checkActor(actor);
            this._find(id);
            if (body.enabled) {
                // Explicit operator enable is distinct from automatic verification evidence.
                await this.store.updateState(
                    row.index,
                    {
                        disabled: null,
                        disabledAt: null,
                        disabledReason: null,
                        disabledStatus: null,
                        expired: null,
                    },
                    expectedVersions
                );
            } else {
                this._runtime();
                await this.store.updateState(
                    row.index,
                    {
                        disabled: true,
                        disabledAt: new Date().toISOString(),
                        disabledReason: "manual",
                    },
                    expectedVersions
                );
                this.system.authSource.reloadAuthSources();
                await this._drain(row.index, force, { check: () => this._checkActor(actor) }, async runtime =>
                    runtime.closeAccount(row.index, { force })
                );
            }
            await this._refreshPool();
            return this.get(id);
        });
    }
    async _verify(row, credentials, mode, model, context) {
        context.check();
        context.progress("verifying", 10);
        let result;
        try {
            result = await this.verifier.verify({
                credentials,
                index: row.index,
                mode,
                model,
                onProgress: event => context.progress(event.stage, event.progress),
                signal: context.signal,
            });
        } catch (error) {
            if (
                error.authIndex === row.index &&
                error.model === model &&
                typeof error.requestId === "string" &&
                error.requestId
            ) {
                context.verification({
                    authIndex: row.index,
                    model,
                    requestId: error.requestId,
                    stage: error.stage,
                    success: false,
                    upstreamStatus:
                        Number.isInteger(error.upstreamStatus) &&
                        error.upstreamStatus >= 100 &&
                        error.upstreamStatus <= 599
                            ? error.upstreamStatus
                            : null,
                });
            }
            throw error;
        }
        context.check();
        if (
            !result ||
            result.success !== true ||
            result.authIndex !== row.index ||
            result.model !== model ||
            typeof result.requestId !== "string" ||
            !result.requestId ||
            result.stage !== (mode === "model" ? "model_verified" : "connection_ready") ||
            (mode === "model" &&
                (!Number.isInteger(result.upstreamStatus) ||
                    result.upstreamStatus < 200 ||
                    result.upstreamStatus >= 300))
        )
            throw failure("VERIFICATION_FAILED");
        return result;
    }
    _assertVersion(row) {
        const current = this.store.getMetadata(row.index);
        if (
            !current ||
            current.archived ||
            current.accountId !== row.accountId ||
            current.credentialVersion !== row.credentialVersion ||
            current.stateVersion !== row.stateVersion
        )
            throw failure("VERSION_CONFLICT");
        return current;
    }
    _verifiedResult(row, result, metadata) {
        if (
            !metadata ||
            metadata.accountId !== row.accountId ||
            metadata.index !== row.index ||
            !Number.isSafeInteger(metadata.credentialVersion) ||
            metadata.credentialVersion < 1 ||
            !Number.isSafeInteger(metadata.stateVersion) ||
            metadata.stateVersion < 1
        )
            throw failure("VERSION_CONFLICT");
        return {
            ...result,
            credentialVersion: metadata.credentialVersion,
            stateVersion: metadata.stateVersion,
        };
    }
    async _execute(kind, payload, context) {
        if (kind === "import") {
            this._duplicates(payload.items);
            for (let i = 0; i < payload.items.length; i++)
                await context.item(i, async item => {
                    const source = payload.items[i];
                    item.check();
                    this._duplicates([source]);
                    const row = await this.store.create(source.credentials, {
                        disabled: false,
                        uploadOperation: item.uploadOperation,
                    });
                    item.uploaded();
                    // Upload enables the new account independently of model verification.
                    await this._refreshPool();
                    if (payload.verify === false) {
                        item.check();
                        item.committed({
                            credentialVersion: row.credentialVersion,
                            stage: "uploaded",
                            stateVersion: row.stateVersion,
                            success: true,
                        });
                        return;
                    }
                    const result = await this._verify(row, source.credentials, "model", payload.model, item);
                    await this._serialized(row.index, async () => {
                        item.check();
                        // Verification must not undo a later manual/quota disable.
                        const current = this._assertVersion(row);
                        item.committed(this._verifiedResult(row, result, current));
                    });
                });
            return;
        }
        if (kind === "batch") {
            for (let i = 0; i < payload.accountIds.length; i++)
                await context.item(i, item => this._change(payload.action, payload.accountIds[i], payload.force, item));
            return;
        }
        await context.item(0, async item => {
            if (kind === "reload-auth") {
                item.check();
                await this.store.refresh();
                item.mutated();
                item.committed();
                await this._refreshPool();
                return;
            }
            const row = this._find(payload.id, kind === "restore");
            item.identify(row);
            if (kind === "test") {
                const result = await this._verify(
                    row,
                    this._credentialOnly(this.store.read(row.index)),
                    payload.mode,
                    payload.model,
                    item
                );
                const current = this._assertVersion(row);
                item.committed(this._verifiedResult(row, result, current));
            } else if (kind === "replace") {
                if (
                    payload.expectedCredentialVersion !== undefined &&
                    (row.credentialVersion !== payload.expectedCredentialVersion ||
                        row.stateVersion !== payload.expectedStateVersion)
                )
                    throw failure("VERSION_CONFLICT");
                this._duplicates([{ credentials: payload.credentials }], row.accountId);
                const result =
                    payload.verify === false
                        ? null
                        : await this._verify(row, payload.credentials, "model", payload.model, item);
                await this._serialized(row.index, async () => {
                    this._assertVersion(row);
                    await this._drain(row.index, false, item, async runtime => {
                        item.check();
                        this._assertVersion(row);
                        this._duplicates([{ credentials: payload.credentials }], row.accountId);
                        // Close only after drain; upload-only replacement uses the same CAS and receipt transaction.
                        await runtime.closeAccount(row.index, { force: false });
                        item.check();
                        const committed = await this.store.replace(row.index, payload.credentials, {
                            ...versions(row),
                            enable: payload.verify === false,
                            uploadOperation: item.uploadOperation,
                        });
                        item.uploaded();
                        item.committed(
                            result
                                ? this._verifiedResult(row, result, committed)
                                : {
                                      credentialVersion: committed.credentialVersion,
                                      stage: "uploaded",
                                      stateVersion: committed.stateVersion,
                                      success: true,
                                  }
                        );
                        this.system.authSource.reloadAuthSources();
                    });
                });
                await this._refreshPool();
            } else if (kind === "restore") {
                item.check();
                await this.store.restore(payload.id);
                item.mutated();
                item.committed();
                await this._refreshPool();
            } else await this._change(kind, payload.id, payload.force, item);
        });
    }
    async _change(action, id, force, item) {
        const row = this._find(id);
        item.identify(row);
        await this._serialized(row.index, async () => {
            item.check();
            if (action === "enable") {
                await this.store.updateState(row.index, {
                    disabled: null,
                    disabledAt: null,
                    disabledReason: null,
                    disabledStatus: null,
                    expired: null,
                });
                item.mutated();
                item.committed();
            } else {
                this._runtime();
                if (["disable", "archive"].includes(action)) {
                    await this.store.updateState(row.index, {
                        disabled: true,
                        disabledAt: new Date().toISOString(),
                        disabledReason: "manual",
                    });
                    item.mutated();
                    this.system.authSource.reloadAuthSources();
                }
                await this._drain(row.index, force, item, async runtime => {
                    await runtime.closeAccount(row.index, { force });
                    item.check();
                    if (action === "archive") await this.store.archive(row.index);
                    else if (action === "reload") await this.store.refresh();
                    item.mutated();
                    item.committed();
                    this.system.authSource.reloadAuthSources();
                });
            }
        });
        await this._refreshPool();
    }
    _credentialOnly(value) {
        if (!value) throw failure("INVALID_CREDENTIALS");
        return {
            ...(typeof value.accountName === "string" ? { accountName: value.accountName } : {}),
            cookies: value.cookies,
            origins: value.origins,
        };
    }
    export(body) {
        object(body, ["accountIds"], ["accountIds"]);
        return {
            items: this._ids(body.accountIds).map(id => {
                const row = this._find(id);
                return {
                    accountId: row.accountId,
                    credentials: this._credentialOnly(this.store.read(row.index)),
                    index: row.index,
                };
            }),
        };
    }
    settings() {
        const { persistentKeys, ...values } = this.system.runtimeSettingsStore.snapshot();
        return {
            persistentKeys,
            values: Object.fromEntries(Object.entries(values).filter(([k]) => SETTINGS.includes(k))),
        };
    }
    async updateSettings(body) {
        object(body, SETTINGS);
        if (!Object.keys(body).length) throw failure("INVALID_REQUEST");
        const updated = await this.system.runtimeSettingsStore.update(body);
        return {
            applied: updated.applied,
            persisted: updated.persisted,
            values: Object.fromEntries(Object.entries(updated.values).filter(([k]) => SETTINGS.includes(k))),
            ...(updated.applicationError
                ? {
                      applicationError: {
                          code: "SETTINGS_APPLICATION_FAILED",
                          message: "Settings were committed but runtime application failed.",
                      },
                  }
                : {}),
        };
    }
    status() {
        const accounts = this.store.listMetadata();
        const browser = this.system.browserManager;
        const browserConnected = !!browser?.browser?.isConnected?.();
        const isSystemBusy = !!this.system.requestHandler?.isSystemBusy;
        const enabledAccountCount = accounts.filter(r => this._account(r).enabled).length;
        const hasReadyAccount = accounts.some(
            row =>
                this._account(row).enabled &&
                !this.system.managementRuntime?.isBlocked?.(row.index) &&
                this.system.connectionRegistry?.getConnectionByAuth?.(row.index, false)?.readyState === 1
        );
        return {
            accountCount: accounts.filter(r => !r.archived).length,
            activeContextsCount: browser?.contexts?.size || 0,
            browserConnected,
            currentAccountId:
                accounts.find(r => r.index === browser?.currentAuthIndex && !r.archived)?.accountId || null,
            enabledAccountCount,
            isSystemBusy,
            ready: browserConnected && !isSystemBusy && hasReadyAccount,
        };
    }
    readiness() {
        const status = this.status();
        return {
            checks: [
                { name: "browser", ready: status.browserConnected },
                { name: "accounts", ready: status.enabledAccountCount > 0 },
                { name: "system", ready: !status.isSystemBusy },
                { name: "model_connection", ready: status.ready },
            ],
            ready: status.ready,
        };
    }
    usage(options) {
        const records = this.system.usageStatsService?.getSnapshot?.().records || [];
        const accounts = this.store.listMetadata();
        return page(
            records.map(row => {
                const index = Number.isSafeInteger(row.finalAuthIndex)
                    ? row.finalAuthIndex
                    : Number.isSafeInteger(row.initialAuthIndex)
                      ? row.initialAuthIndex
                      : null;
                return {
                    accountId: accounts.find(a => a.index === index)?.accountId || null,
                    durationMs: Math.max(0, Math.floor(row.durationMs || 0)),
                    finishedAt: row.finishedAt,
                    index,
                    model: row.model || null,
                    outcome: ["success", "error", "aborted"].includes(row.outcome) ? row.outcome : "error",
                    requestId: String(row.requestId),
                    startedAt: row.startedAt,
                    statusCode: Number.isInteger(row.statusCode) ? row.statusCode : null,
                };
            }),
            options
        );
    }
}
module.exports = ManagementAccountService;
