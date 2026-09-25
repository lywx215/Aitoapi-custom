const { performance } = require("perf_hooks");
const Headers = require("./Headers");
const Resource = require("./Resource");
const Peers = require("./Peers");
const Projection = require("./Projection");
const LoggingService = require("../utils/LoggingService");

const holders = new WeakMap();
const emptyIdentity = {
    attemptId: null,
    attemptNo: null,
    callerAlias: null,
    callerAliasScope: "unknown",
    callerIdSource: { header: null, rejected: "none", trust: "none" },
    callerRequestId: null,
    callNo: null,
    contextSource: null,
    parentSpanId: null,
    requestId: null,
    retryScope: null,
    serverSpanId: null,
    spanId: null,
    traceId: null,
};

class Span {
    constructor(diagnostics, identity, parent = null) {
        this.diagnostics = diagnostics;
        this.identity = Object.freeze({ ...identity });
        this.started = performance.now();
        this.logSeq = 0;
        this.dropped = 0;
        this.truncated = 0;
        this.sealed = false;
        this.debugCapture =
            LoggingService.isDebugEnabled() && (!parent || parent.debugActive) ? "enabled_throughout" : "none";
        this.accessCapture = diagnostics.accessEnabled ? "enabled_throughout" : "none";
        this.debugEpoch = diagnostics.debugEpoch;
        this.accessEpoch = diagnostics.accessEpoch;
    }

    captures() {
        if (this.debugCapture === "enabled_throughout" && this.debugEpoch !== this.diagnostics.debugEpoch)
            this.debugCapture = "interrupted";
        if (this.accessEpoch !== this.diagnostics.accessEpoch) this.accessCapture = "interrupted";
        return { accessCapture: this.accessCapture, debugCapture: this.debugCapture };
    }

    get debugActive() {
        return !this.sealed && this.captures().debugCapture === "enabled_throughout" && LoggingService.isDebugEnabled();
    }

    emit(event, data, { terminal = false, attempt = {} } = {}) {
        if (this.sealed) return false;
        const basic = event.startsWith("diag.");
        if (basic ? !this.diagnostics.accessEnabled : !this.debugActive) {
            if (terminal) this.sealed = true;
            return false;
        }
        const logSeq = ++this.logSeq;
        const coverage = terminal
            ? {
                  droppedForSpan: this.dropped,
                  expectedLastLogSeq: logSeq,
                  sinkDroppedTotal: this.diagnostics.logger.publicDiagnosticDropped || 0,
                  truncatedEvents: this.truncated,
                  ...this.captures(),
              }
            : null;
        const record = {
            diagnosticSchema: "ai-proxy-diagnostics/1",
            event,
            level: basic ? "INFO" : "DEBUG",
            recordKind: basic ? "basic" : "debug",
            ts: new Date().toISOString(),
            ...this.diagnostics.resource,
            ...this.identity,
            attemptId: attempt.attemptId ?? this.identity.attemptId,
            attemptNo: attempt.attemptNo ?? this.identity.attemptNo,
            data: { ...data, ...(coverage ? { coverage } : {}) },
            logSeq,
            retryScope: attempt.retryScope ?? this.identity.retryScope,
        };
        // Serialization happens here, never in the shared asynchronous flush.
        let line;
        try {
            line = `@diag ${JSON.stringify(record)}`;
        } catch {
            line = null;
        }
        if (!line || Buffer.byteLength(line) + 1 > 4096) {
            const reason = line ? "line_limit" : "serialization_failure";
            this.truncated++;
            record.event = "diag.truncated";
            record.data = { originalEvent: event, originalRecordKind: record.recordKind, reason };
            line = `@diag ${JSON.stringify(record)}`;
        }
        if (terminal) this.sealed = true;
        if (Buffer.byteLength(line) + 1 > 4096) {
            this.dropped++;
            this.diagnostics.logger.publicDiagnosticDropped =
                (this.diagnostics.logger.publicDiagnosticDropped || 0) + 1;
            return false;
        }
        if (typeof this.diagnostics.logger.publicDiagnostic !== "function") {
            this.dropped++;
            return false;
        }
        try {
            return this.diagnostics.logger.publicDiagnostic(line, basic, () => {
                this.dropped++;
            });
        } catch {
            this.dropped++;
            this.diagnostics.logger.publicDiagnosticDropped =
                (this.diagnostics.logger.publicDiagnosticDropped || 0) + 1;
            return false;
        }
    }
}

class ServerSpan extends Span {
    constructor(diagnostics, context) {
        const spanId = Headers.randomId(8);
        super(diagnostics, {
            ...emptyIdentity,
            callerIdSource: { header: context.callerHeader, rejected: context.rejected, trust: context.callerTrust },
            callerRequestId: context.callerRequestId,
            contextSource: context.contextSource,
            parentSpanId: context.parentSpanId,
            requestId: `req_${Date.now()}_${Headers.randomId(5)}`,
            serverSpanId: spanId,
            spanId,
            spanKind: "server",
            traceId: context.traceId,
        });
        this.context = context;
        this.calls = new Set();
        this.callCount = 0;
        this.measurements = {};
        this.attempts = new Map();
    }

    bind(requestId) {
        if (!this.sealed && Headers.validId(requestId) && this.logSeq === 0 && this.callCount === 0)
            this.identity = Object.freeze({ ...this.identity, requestId });
    }

    authenticated() {
        if (this.sealed || this.logSeq || this.callCount || !this.identity.callerRequestId) return;
        this.identity = Object.freeze({
            ...this.identity,
            callerIdSource: { ...this.identity.callerIdSource, trust: "authenticated" },
        });
    }

    observeTime(key, attemptId) {
        if (!this.debugActive) return;
        // All timings use server-span start as their origin. Upstream observations
        // belong only to the named attempt; retries must never inherit an earlier value.
        const measurements = attemptId ? this.attempts.get(attemptId)?.measurements : this.measurements;
        if (measurements && measurements[key] === undefined) measurements[key] = performance.now() - this.started;
    }

    startCall(attempt = {}, callKind = "browser_dispatch", peer = null) {
        if (this.sealed) return null;
        const call = new Span(
            this.diagnostics,
            {
                ...this.identity,
                ...attempt,
                callNo: ++this.callCount,
                parentSpanId: this.identity.spanId,
                spanId: Headers.randomId(8),
                spanKind: "call",
            },
            this
        );
        call.peer = peer;
        call.callKind = callKind;
        call.upstreamStatus = null;
        call.peerIds = Headers.peerResponse({ headers: [], peerConfigured: false });
        call.finish = endReason => {
            if (call.sealed) return;
            call.emit(
                "diag.call",
                {
                    callKind,
                    endReason,
                    peerConfigured: Boolean(peer),
                    peerDeploymentId: peer?.deploymentId || null,
                    peerService: peer?.service || null,
                    targetAlias: peer?.alias || (callKind === "browser_dispatch" ? "browser" : null),
                    totalMs: performance.now() - call.started,
                    upstreamStatus: call.upstreamStatus,
                    ...call.peerIds,
                    providerRequestId: null,
                },
                { terminal: true }
            );
            this.calls.delete(call);
            call.onSettled?.();
        };
        this.calls.add(call);
        return call;
    }

    startAttempt(attemptId) {
        if (this.debugActive)
            this.attempts.set(attemptId, {
                measurements: {},
                ordinaryTextUtf8Bytes: 0,
                started: performance.now(),
                thoughtUtf8Bytes: 0,
            });
    }

    observeFrame(attemptId, parsed) {
        if (!this.debugActive) return;
        const attempt = this.attempts.get(attemptId);
        if (!attempt || attempt.ordinaryTextUtf8Bytes === null) return;
        try {
            if (!Array.isArray(parsed?.candidates)) return;
            for (const candidate of parsed.candidates) {
                if (!candidate || !Array.isArray(candidate.content?.parts)) continue;
                for (const part of candidate.content.parts) {
                    if (part && typeof part.text === "string")
                        attempt[part.thought === true ? "thoughtUtf8Bytes" : "ordinaryTextUtf8Bytes"] +=
                            Buffer.byteLength(part.text);
                }
            }
        } catch {
            // Observation must not change guard/transport behavior, even for a hostile accessor.
            attempt.ordinaryTextUtf8Bytes = null;
            attempt.thoughtUtf8Bytes = null;
        }
    }

    attemptFinished(fields, rawUsage) {
        if (!this.debugActive) return;
        const observed = this.attempts.get(fields.attemptId);
        this.attempts.delete(fields.attemptId);
        const data = {
            ...Projection.failure(fields),
            credentialRef: null,
            credentialRefScope: "unknown",
            eofSeen: fields.eofSeen ?? null,
            legacyEvent: "generation.attempt_finished",
            output: Projection.output(fields, observed),
            parserFinishOk: fields.parserFinishOk ?? null,
            terminalSeen: fields.terminalSeen ?? null,
            timing: Projection.timing({ ...this.measurements, ...observed?.measurements }),
            totalMs: observed ? performance.now() - observed.started : null,
            usage: Projection.usage(rawUsage),
        };
        // Some legacy effective parts (for example code-execution results) have no
        // v1 output category. Preserve the business result, but do not assert
        // public success without the contract's independently observable evidence.
        if (
            data.resultClass === "success" &&
            !(
                data.terminalSeen &&
                data.eofSeen &&
                data.parserFinishOk &&
                (data.output.ordinaryTextNonWhitespaceChars > 0 ||
                    data.output.validToolCalls > 0 ||
                    data.output.mediaParts > 0)
            )
        ) {
            data.resultClass = "unknown";
            data.failureOrigin = "unknown";
            data.failureStage = "unknown";
            data.errorClass = "unknown";
        }
        // Sealed snapshots are also the source for conversion observations; never retain model objects.
        this.lastAttempt = { attemptId: fields.attemptId, attemptNo: fields.attemptNo, retryScope: "generation" };
        this.lastSummary = data;
        this.emit("upstream.attempt_finished", data, { attempt: this.lastAttempt });
    }

    converted({ format, stream, upstreamStreaming, deliveredUsage, output = null, resultClass }) {
        if (!this.debugActive || !this.lastSummary) return;
        this.emit(
            "response.converted",
            {
                clientStreaming: stream,
                deliveredUsage: Projection.usage(deliveredUsage, Projection.protocol(format), "converted"),
                deliveryMode: !stream ? "nonstream" : upstreamStreaming ? "stream" : "pseudo_stream",
                inputProtocol: "gemini",
                output: output || Projection.output(),
                outputProtocol: Projection.protocol(format),
                resultClass: Projection.resultClass(resultClass),
                upstreamStreaming,
                upstreamUsage: this.lastSummary.usage,
            },
            { attempt: this.lastAttempt }
        );
    }

    finish(res, routeTemplate, endReason) {
        if (this.sealed) return;
        for (const call of this.calls) call.finish(endReason === "client_cancel" ? "cancelled" : "closed_early");
        this.emit(
            "diag.server",
            {
                callCount: this.callCount,
                deliveryState: Projection.aito({
                    legacy: {},
                    localCancelObserved: endReason === "client_cancel",
                    localFailureObserved: endReason === "error",
                    localFinishObserved: endReason === "finished",
                }).deliveryState,
                endReason,
                headersCommitted: res.headersSent,
                routeTemplate,
                totalMs: performance.now() - this.started,
                wireStatus: res.headersSent ? res.statusCode : null,
            },
            { terminal: true }
        );
        this.attempts.clear();
        this.lastSummary = null;
    }
}

class Diagnostics {
    constructor(logger, env = process.env) {
        this.logger = logger;
        const identity = Resource.fromEnvironment(env);
        this.resource = identity.resource;
        this.configInvalid = identity.configInvalid;
        this.peers = Peers.parse(env.DIAG_PEERS);
        this.accessEnabled = env.ACCESS_LOG_ENABLED !== "false";
        this.debugEpoch = 0;
        this.accessEpoch = 0;
        this.processSequence = 0;
        this.configRevision = 1;
        this.unsubscribe = LoggingService.onLevelChange(level => {
            if (level !== "DEBUG") this.debugEpoch++;
            this.configRevision++;
            this.process("config_changed");
        });
        this.process("startup");
    }

    process(reason) {
        const span = new Span(this, { ...emptyIdentity, spanKind: "process" });
        span.logSeq = this.processSequence;
        span.emit("diag.process", {
            accessEnabled: this.accessEnabled,
            capabilities: ["http_inbound", "browser_dispatch", "attempt_result", "conversion"],
            configRevision: String(this.configRevision),
            configStatus:
                this.configInvalid || this.peers.configStatus === "config_invalid" ? "config_invalid" : "valid",
            contractVersion: "1.0.0-rc.1",
            debugEnabled: LoggingService.isDebugEnabled(),
            pid: process.pid,
            reason,
            sinkDroppedTotal: this.logger.publicDiagnosticDropped || 0,
        });
        this.processSequence = span.logSeq;
    }

    setAccessEnabled(enabled) {
        if (this.accessEnabled !== Boolean(enabled)) this.accessEpoch++;
        this.accessEnabled = Boolean(enabled);
        this.configRevision++;
        this.process("config_changed");
    }

    reloadPeers(value) {
        this.peers = Peers.parse(value);
        this.configRevision++;
        this.process("config_changed");
    }

    middleware() {
        return (req, res, next) => {
            const span = new ServerSpan(this, Headers.extract({ headers: Headers.fields(req) }));
            holders.set(req, span);
            holders.set(res, span);
            // Per-response commit hook, preserving native writer/stream/backpressure behavior.
            const writeHead = res.writeHead;
            res.writeHead = function (...args) {
                const position = typeof args[1] === "string" ? 2 : 1;
                const provided = args[position];
                if (provided) {
                    if (Array.isArray(provided)) {
                        const clean = [];
                        const flat = Array.isArray(provided[0]) ? provided.flat() : provided;
                        for (let i = 0; i < flat.length; i += 2)
                            if (!/^x-diag-/i.test(flat[i])) clean.push(flat[i], flat[i + 1]);
                        args[position] = clean;
                    } else
                        args[position] = Object.fromEntries(
                            Object.entries(provided).filter(([k]) => !/^x-diag-/i.test(k))
                        );
                }
                for (const name of this.getHeaderNames()) if (/^x-diag-/i.test(name)) this.removeHeader(name);
                this.setHeader("X-Diag-Request-Id", span.identity.requestId);
                this.setHeader("X-Diag-Trace-Id", span.identity.traceId);
                span.observeTime("responseCommitMs");
                return writeHead.apply(this, args);
            };
            // Templates come from local route declarations, never the request URL/model.
            const route = () =>
                typeof req.route?.path === "string" && /^\/[A-Za-z0-9_:/{}.*-]{0,127}$/.test(req.route.path)
                    ? req.route.path
                    : null;
            res.once("finish", () => span.finish(res, route(), "finished"));
            res.once("close", () =>
                span.finish(
                    res,
                    route(),
                    res.writableFinished ? "finished" : res.__generationDestroyed ? "error" : "unknown"
                )
            );
            next();
        };
    }

    close() {
        this.unsubscribe();
    }
}

Diagnostics.get = object => holders.get(object);
Diagnostics.Span = Span;
Diagnostics.ServerSpan = ServerSpan;
module.exports = Diagnostics;
