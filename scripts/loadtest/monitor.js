const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");

const PRODUCTION_ORIGIN = "https://aib.zeabur.app";
const MANAGEMENT_PREFIX = "/api/manage/v1";
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const SETTINGS = new Set([
    "accountCooldownMaxMs",
    "accountCooldownMs",
    "autoDisableStatusCodes",
    "autoHealProbeIntervalMs",
    "autoHealProbeTimeoutMs",
    "checkUpdate",
    "debugMode",
    "enableAuthUpdate",
    "forceCodeExecution",
    "forceThinking",
    "forceUrlContext",
    "forceWebSearch",
    "logMaxCount",
    "maxContexts",
    "maxRetries",
    "retryDelay",
    "safetySettingsThreshold",
    "streamingMode",
]);
const ERROR_CODES = new Set([
    "AUDIT_PERSISTENCE_FAILED",
    "FORBIDDEN",
    "INTERNAL_ERROR",
    "INVALID_REQUEST",
    "INVALID_STATE",
    "METHOD_NOT_ALLOWED",
    "NOT_FOUND",
    "PAYLOAD_TOO_LARGE",
    "PERSISTENCE_ERROR",
    "RATE_LIMITED",
    "SETTINGS_APPLICATION_FAILED",
    "UNAUTHORIZED",
]);

function failure(code, status = null) {
    return Object.assign(new Error(code), { code, status });
}

function finite(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boolean(value) {
    return typeof value === "boolean" ? value : null;
}

function cpuTicks() {
    const totals = { idle: 0, total: 0 };
    for (const cpu of os.cpus()) {
        totals.idle += cpu.times.idle;
        totals.total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    }
    return totals;
}

/**
 * Read-only monitoring plus the two explicitly authorized load-test settings.
 * Response objects are reduced to a field whitelist before returning or writing.
 */
class Monitor {
    #managementKey;
    #origin;
    #agent;
    #transport;
    #outputDir;
    #intervalMs;
    #onUnsafe;
    #tail = Promise.resolve();
    #timer = null;
    #running = false;
    #latest = null;
    #startTime = performance.now();
    #lastLocalTime = performance.now();
    #lastCpuUsage = process.cpuUsage();
    #lastSystemCpu = cpuTicks();
    #eventLoop = monitorEventLoopDelay({ resolution: 20 });
    #readinessFailedSince = null;
    #readinessAlerted = false;
    #previousUptime = null;
    #previousHealthTime = null;
    #usageSeen = new Set();
    #usageForbidden = false;

    constructor({
        origin = PRODUCTION_ORIGIN,
        managementKey,
        outputDir,
        intervalMs = 5000,
        onUnsafe,
        allowFixture = false,
    }) {
        let parsed;
        try {
            parsed = new URL(origin);
        } catch {
            throw failure("INVALID_ORIGIN");
        }
        const fixture = allowFixture === true && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
        if (
            (!fixture && parsed.origin !== PRODUCTION_ORIGIN) ||
            parsed.username ||
            parsed.password ||
            parsed.pathname !== "/" ||
            parsed.search ||
            parsed.hash
        ) {
            throw failure("INVALID_ORIGIN");
        }
        if (typeof managementKey !== "string" || !managementKey.length || /[\s,]/.test(managementKey)) {
            throw failure("INVALID_MANAGEMENT_KEY");
        }
        if (typeof outputDir !== "string" || !outputDir.length) throw failure("INVALID_OUTPUT_DIRECTORY");
        if (!Number.isFinite(intervalMs) || intervalMs < 1) throw failure("INVALID_INTERVAL");
        if (onUnsafe !== undefined && typeof onUnsafe !== "function") throw failure("INVALID_UNSAFE_HANDLER");
        this.#origin = parsed.origin;
        this.#managementKey = managementKey;
        this.#outputDir = path.resolve(outputDir);
        this.#intervalMs = intervalMs;
        this.#onUnsafe = onUnsafe;
        this.#transport = fixture ? http : https;
        this.#agent = new this.#transport.Agent({ keepAlive: true, maxSockets: 8 });
        this.#eventLoop.enable();
    }

    get latest() {
        return this.#latest ? structuredClone(this.#latest) : null;
    }

    #identifier(value, max = 256) {
        return typeof value === "string" &&
            value.length <= max &&
            /^[a-zA-Z0-9_-]+$/.test(value) &&
            !value.includes(this.#managementKey)
            ? value
            : null;
    }

    #safeLabel(value) {
        if (typeof value !== "string") return "snapshot";
        return value.includes(this.#managementKey) ? "redacted-label" : value.slice(0, 200).replace(/[\r\n\0]/g, "_");
    }

    #serialize(operation) {
        const next = this.#tail.then(operation);
        this.#tail = next.catch(() => undefined);
        return next;
    }

    #request(endpoint, { method = "GET", body, authenticated = true } = {}) {
        return new Promise(resolve => {
            const started = performance.now();
            const target = new URL(endpoint, this.#origin);
            if (target.origin !== this.#origin) {
                resolve({ errorCode: "INVALID_ORIGIN", httpStatus: null, ok: false });
                return;
            }
            let settled = false;
            let deadline;
            let req;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                resolve({ durationMs: Number((performance.now() - started).toFixed(3)), ...value });
            };
            const serialized = body === undefined ? undefined : JSON.stringify(body);
            const headers = { Accept: "application/json" };
            if (authenticated) headers.Authorization = `Bearer ${this.#managementKey}`;
            if (serialized !== undefined) {
                headers["Content-Type"] = "application/json";
                headers["Content-Length"] = Buffer.byteLength(serialized);
            }
            try {
                req = this.#transport.request(target, { agent: this.#agent, headers, method }, response => {
                    const httpStatus = count(response.statusCode);
                    const requestId = this.#identifier(response.headers["x-request-id"], 128);
                    if (httpStatus >= 300 && httpStatus < 400) {
                        finish({ errorCode: "REDIRECT_REFUSED", httpStatus, ok: false, requestId });
                        response.destroy();
                        return;
                    }
                    const chunks = [];
                    let length = 0;
                    response.on("data", chunk => {
                        length += chunk.length;
                        if (length > RESPONSE_LIMIT) {
                            finish({ errorCode: "RESPONSE_TOO_LARGE", httpStatus, ok: false, requestId });
                            response.destroy();
                            return;
                        }
                        chunks.push(chunk);
                    });
                    response.on("aborted", () =>
                        finish({ errorCode: "RESPONSE_ABORTED", httpStatus, ok: false, requestId })
                    );
                    response.on("error", () =>
                        finish({ errorCode: "NETWORK_ERROR", httpStatus, ok: false, requestId })
                    );
                    response.on("end", () => {
                        let parsed;
                        try {
                            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                        } catch {
                            finish({ errorCode: "INVALID_JSON", httpStatus, ok: false, requestId });
                            return;
                        }
                        if (httpStatus < 200 || httpStatus >= 300) {
                            finish({
                                errorCode: ERROR_CODES.has(parsed?.error?.code) ? parsed.error.code : "HTTP_ERROR",
                                httpStatus,
                                ok: false,
                                requestId,
                            });
                            return;
                        }
                        const data = authenticated ? parsed?.data : parsed;
                        if (!data || typeof data !== "object" || Array.isArray(data)) {
                            finish({ errorCode: "MISSING_DATA", httpStatus, ok: false, requestId });
                            return;
                        }
                        finish({ data, httpStatus, ok: true, requestId });
                    });
                });
                req.on("error", () => finish({ errorCode: "NETWORK_ERROR", httpStatus: null, ok: false }));
                deadline = setTimeout(() => {
                    finish({ errorCode: "TIMEOUT", httpStatus: null, ok: false });
                    req.destroy();
                }, 10000);
                req.end(serialized);
            } catch {
                finish({ errorCode: "NETWORK_ERROR", httpStatus: null, ok: false });
                req?.destroy();
            }
        });
    }

    #metadata(response) {
        return {
            durationMs: finite(response.durationMs),
            ...(response.errorCode ? { errorCode: response.errorCode } : {}),
            httpStatus: count(response.httpStatus),
            ok: response.ok === true,
            requestId: response.requestId || null,
        };
    }

    #settings(response) {
        const data = response.data || {};
        const values = {};
        for (const key of SETTINGS) {
            const value = data.values?.[key];
            if (typeof value === "boolean" || finite(value) !== null) values[key] = value;
            else if (Array.isArray(value)) values[key] = value.filter(item => Number.isSafeInteger(item)).slice(0, 20);
            else if (
                typeof value === "string" &&
                /^[a-zA-Z0-9_-]{1,64}$/.test(value) &&
                !value.includes(this.#managementKey)
            ) {
                values[key] = value;
            }
        }
        return {
            ...this.#metadata(response),
            persistentKeys: Array.isArray(data.persistentKeys)
                ? data.persistentKeys.filter(key => SETTINGS.has(key))
                : [],
            values,
        };
    }

    async #local() {
        const sampled = performance.now();
        const intervalMs = Math.max(1, sampled - this.#lastLocalTime);
        const usage = process.cpuUsage();
        const systemCpu = cpuTicks();
        const totalCpuDelta = systemCpu.total - this.#lastSystemCpu.total;
        const idleCpuDelta = systemCpu.idle - this.#lastSystemCpu.idle;
        const memory = process.memoryUsage();
        let disk;
        try {
            const stats = await fs.statfs(this.#outputDir);
            disk = { availableBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
        } catch {
            disk = { available: false, errorCode: "LOCAL_DISK_METRICS_UNAVAILABLE" };
        }
        const local = {
            cpu: {
                logicalCores: os.availableParallelism(),
                processPercent: Number(
                    (
                        ((usage.user - this.#lastCpuUsage.user + usage.system - this.#lastCpuUsage.system) /
                            (intervalMs * 1000)) *
                        100
                    ).toFixed(3)
                ),
                systemPercent: totalCpuDelta > 0 ? Number(((1 - idleCpuDelta / totalCpuDelta) * 100).toFixed(3)) : null,
            },
            disk,
            eventLoopDelayMs: {
                max: finite(this.#eventLoop.max / 1e6),
                mean: finite(this.#eventLoop.mean / 1e6),
                p95: finite(this.#eventLoop.percentile(95) / 1e6),
                p99: finite(this.#eventLoop.percentile(99) / 1e6),
            },
            memory: {
                arrayBuffersBytes: memory.arrayBuffers,
                externalBytes: memory.external,
                heapTotalBytes: memory.heapTotal,
                heapUsedBytes: memory.heapUsed,
                rssBytes: memory.rss,
                systemFreeBytes: os.freemem(),
                systemTotalBytes: os.totalmem(),
            },
            network: { available: false, errorCode: "NODE_NATIVE_COUNTER_UNAVAILABLE" },
        };
        this.#lastLocalTime = sampled;
        this.#lastCpuUsage = usage;
        this.#lastSystemCpu = systemCpu;
        this.#eventLoop.reset();
        return local;
    }

    #safety(snapshot, sampled) {
        const unsafe = [];
        if (snapshot.readiness.ok && snapshot.readiness.ready === true) {
            this.#readinessFailedSince = null;
            this.#readinessAlerted = false;
        } else {
            this.#readinessFailedSince ??= sampled;
            if (!this.#readinessAlerted && sampled - this.#readinessFailedSince >= 60000) {
                this.#readinessAlerted = true;
                unsafe.push({ durationMs: sampled - this.#readinessFailedSince, reason: "readiness_failed" });
            }
        }
        const uptime = snapshot.health.uptime;
        if (snapshot.health.ok && uptime !== null) {
            if (
                this.#previousHealthTime !== null &&
                sampled > this.#previousHealthTime &&
                uptime < this.#previousUptime
            ) {
                unsafe.push({ previousUptime: this.#previousUptime, reason: "restarted", uptime });
            }
            this.#previousUptime = uptime;
            this.#previousHealthTime = sampled;
        }
        return unsafe;
    }

    async #snapshot(label, { settings, accounts }) {
        await fs.mkdir(this.#outputDir, { recursive: true });
        const pending = [
            this.#request(`${MANAGEMENT_PREFIX}/system/status`),
            this.#request(`${MANAGEMENT_PREFIX}/system/readiness`),
            this.#request("/health", { authenticated: false }),
        ];
        if (settings) pending.push(this.#request(`${MANAGEMENT_PREFIX}/settings`));
        if (accounts) pending.push(this.#request(`${MANAGEMENT_PREFIX}/accounts?limit=200`));
        const [status, readiness, health, ...additional] = await Promise.all(pending);
        const sampled = performance.now();
        const snapshot = {
            elapsedMs: Number((sampled - this.#startTime).toFixed(3)),
            health: {
                ...this.#metadata(health),
                browserConnected: boolean(health.data?.browserConnected),
                status: health.data?.status === "ok" ? "ok" : null,
                uptime: finite(health.data?.uptime),
            },
            label: this.#safeLabel(label),
            local: await this.#local(),
            readiness: {
                ...this.#metadata(readiness),
                checks: Array.isArray(readiness.data?.checks)
                    ? readiness.data.checks.map(check => ({
                          name: ["browser", "accounts", "system", "model_connection"].includes(check?.name)
                              ? check.name
                              : "unknown",
                          ready: boolean(check?.ready),
                      }))
                    : [],
                ready: boolean(readiness.data?.ready),
            },
            status: {
                ...this.#metadata(status),
                accountCount: count(status.data?.accountCount),
                activeContextsCount: count(status.data?.activeContextsCount),
                browserConnected: boolean(status.data?.browserConnected),
                currentAccountId: this.#identifier(status.data?.currentAccountId),
                enabledAccountCount: count(status.data?.enabledAccountCount),
                isSystemBusy: boolean(status.data?.isSystemBusy),
                ready: boolean(status.data?.ready),
            },
            time: new Date().toISOString(),
        };
        if (settings) snapshot.settings = this.#settings(additional.shift());
        if (accounts) {
            const response = additional.shift();
            snapshot.accounts = {
                ...this.#metadata(response),
                items: Array.isArray(response.data?.items)
                    ? response.data.items.slice(0, 200).map(account => ({
                          accountId: this.#identifier(account?.accountId),
                          disabledStatus: count(account?.disabledStatus),
                          enabled: boolean(account?.enabled),
                          index: count(account?.index),
                      }))
                    : [],
                limit: count(response.data?.limit),
                offset: count(response.data?.offset),
                total: count(response.data?.total),
            };
        }
        const unsafe = this.#safety(snapshot, sampled);
        if (unsafe.length) snapshot.unsafe = unsafe;
        try {
            await fs.appendFile(path.join(this.#outputDir, "environment.jsonl"), `${JSON.stringify(snapshot)}\n`, {
                mode: 0o600,
            });
        } catch {
            throw failure("ENVIRONMENT_WRITE_FAILED");
        }
        this.#latest = snapshot;
        for (const event of unsafe) {
            try {
                Promise.resolve(
                    this.#onUnsafe?.({ elapsedMs: snapshot.elapsedMs, time: snapshot.time, ...event })
                ).catch(() => undefined);
            } catch {
                // A caller's alert handler must not expose errors or break monitoring.
            }
        }
        return structuredClone(snapshot);
    }

    snapshot(label, { settings = true, accounts = true } = {}) {
        return this.#serialize(() => this.#snapshot(label, { accounts, settings }));
    }

    #timestamp(value) {
        if (
            typeof value !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
            !Number.isFinite(Date.parse(value))
        ) {
            return null;
        }
        return new Date(value).toISOString();
    }

    #usageRecord(row) {
        const requestId = this.#identifier(row?.requestId, 256);
        if (!requestId) return null;
        const model = row?.model;
        return {
            accountId: this.#identifier(row?.accountId),
            durationMs: count(row?.durationMs),
            finishedAt: this.#timestamp(row?.finishedAt),
            index: count(row?.index),
            model:
                typeof model === "string" &&
                /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model) &&
                !model.includes(this.#managementKey)
                    ? model
                    : null,
            outcome: ["success", "error", "aborted"].includes(row?.outcome) ? row.outcome : null,
            requestId,
            startedAt: this.#timestamp(row?.startedAt),
            statusCode: count(row?.statusCode),
        };
    }

    collectUsage(label, { pages = 3 } = {}) {
        if (!Number.isSafeInteger(pages) || pages < 1 || pages > 100) {
            return Promise.reject(failure("INVALID_USAGE_PAGES"));
        }
        return this.#serialize(async () => {
            const summary = {
                available: false,
                coverage: {
                    completedOffsets: [],
                    limit: 200,
                    missing: [],
                    moreAvailable: null,
                    pagesRequested: pages,
                    permissionDenied: this.#usageForbidden,
                    requestedOffsets: [],
                    // Live offset pages can shift when unrelated requests finish.
                    snapshotConsistent: false,
                    sourceOrder: "newest-first",
                    total: null,
                },
                duplicateCount: 0,
                invalidCount: 0,
                label: this.#safeLabel(label),
                recordsFetched: 0,
                recordsSaved: 0,
                time: new Date().toISOString(),
            };
            const coverage = summary.coverage;
            if (this.#usageForbidden) {
                coverage.missing.push({ errorCode: "FORBIDDEN", httpStatus: 403, offset: 0 });
                return summary;
            }
            const records = [];
            const pendingIds = new Set();
            const fetchPage = async offset => {
                coverage.requestedOffsets.push(offset);
                const response = await this.#request(`${MANAGEMENT_PREFIX}/usage?limit=200&offset=${offset}`);
                if (!response.ok) {
                    coverage.missing.push({ errorCode: response.errorCode, httpStatus: response.httpStatus, offset });
                    if (response.httpStatus === 403) {
                        this.#usageForbidden = true;
                        coverage.permissionDenied = true;
                    }
                    return;
                }
                if (!Array.isArray(response.data?.items)) {
                    coverage.missing.push({
                        errorCode: "MISSING_USAGE_ITEMS",
                        httpStatus: response.httpStatus,
                        offset,
                    });
                    return;
                }
                summary.available = true;
                coverage.completedOffsets.push(offset);
                const total = count(response.data.total);
                if (total !== null) coverage.total = Math.max(coverage.total ?? 0, total);
                const items = response.data.items.slice(0, 200);
                summary.recordsFetched += items.length;
                for (const row of items) {
                    const record = this.#usageRecord(row);
                    if (!record) {
                        summary.invalidCount++;
                    } else if (this.#usageSeen.has(record.requestId) || pendingIds.has(record.requestId)) {
                        summary.duplicateCount++;
                    } else {
                        pendingIds.add(record.requestId);
                        records.push(record);
                    }
                }
            };
            // Check permission on the first page before scheduling other pages.
            await fetchPage(0);
            if (summary.available && !this.#usageForbidden) {
                const remaining = [];
                for (let page = 1; page < pages; page++) {
                    const offset = page * 200;
                    if (coverage.total !== null && offset >= coverage.total) break;
                    remaining.push(fetchPage(offset));
                }
                await Promise.all(remaining);
            }
            coverage.completedOffsets.sort((a, b) => a - b);
            coverage.requestedOffsets.sort((a, b) => a - b);
            coverage.moreAvailable = coverage.total === null ? null : coverage.total > pages * 200;
            if (records.length) {
                try {
                    await fs.mkdir(this.#outputDir, { recursive: true });
                    await fs.appendFile(
                        path.join(this.#outputDir, "server-usage.jsonl"),
                        records.map(row => JSON.stringify(row)).join("\n") + "\n",
                        { mode: 0o600 }
                    );
                } catch {
                    throw failure("USAGE_WRITE_FAILED");
                }
                for (const requestId of pendingIds) this.#usageSeen.add(requestId);
                summary.recordsSaved = records.length;
            }
            return summary;
        });
    }

    patchSettings(patch) {
        if (
            !patch ||
            typeof patch !== "object" ||
            Array.isArray(patch) ||
            !Object.keys(patch).length ||
            Object.keys(patch).some(key => !["maxContexts", "debugMode"].includes(key)) ||
            (Object.hasOwn(patch, "maxContexts") &&
                (!Number.isSafeInteger(patch.maxContexts) || patch.maxContexts < 0 || patch.maxContexts > 1000)) ||
            (Object.hasOwn(patch, "debugMode") && typeof patch.debugMode !== "boolean")
        ) {
            return Promise.reject(failure("INVALID_SETTINGS_PATCH"));
        }
        const body = { ...patch };
        return this.#serialize(async () => {
            const response = await this.#request(`${MANAGEMENT_PREFIX}/settings`, { body, method: "PATCH" });
            if (!response.ok) throw failure(response.errorCode, response.httpStatus);
            const data = response.data;
            if (data.applied !== true) throw failure("SETTINGS_APPLICATION_FAILED", response.httpStatus);
            const safe = this.#settings(response);
            return { applied: true, persisted: data.persisted === true, values: safe.values };
        });
    }

    start() {
        if (this.#running) return;
        this.#running = true;
        this.#eventLoop.enable();
        const poll = async () => {
            if (!this.#running) return;
            const started = performance.now();
            try {
                await this.snapshot("poll", { accounts: false, settings: false });
            } catch {
                const event = {
                    elapsedMs: performance.now() - this.#startTime,
                    reason: "monitor_write_failed",
                    time: new Date().toISOString(),
                };
                try {
                    Promise.resolve(this.#onUnsafe?.(event)).catch(() => undefined);
                } catch {
                    // Alert handling is best effort; no raw error is persisted.
                }
            }
            if (this.#running)
                this.#timer = setTimeout(poll, Math.max(1, this.#intervalMs - (performance.now() - started)));
        };
        this.#timer = setTimeout(poll, 0);
    }

    async stop() {
        this.#running = false;
        clearTimeout(this.#timer);
        this.#timer = null;
        await this.#tail;
        this.#eventLoop.disable();
        this.#agent.destroy();
    }
}

module.exports = { Monitor };
