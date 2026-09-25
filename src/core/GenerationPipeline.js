const GenerationBudget = require("./GenerationBudget");
const GenerationDiagnostics = require("./GenerationDiagnostics");
const GenerationError = require("./GenerationError");
const GenerationInputAdapter = require("./GenerationInputAdapter");
const GenerationResponseWriter = require("./GenerationResponseWriter");
const GenerationResultGuard = require("./GenerationResultGuard");
const Diagnostics = require("../diagnostics/Diagnostics");

function normalizeError(error, guard) {
    if (error instanceof GenerationError) return error;
    if (error?.code === "QUEUE_TIMEOUT")
        return new GenerationError(
            guard?.terminalSeen ? "terminal_without_eof" : "upstream_idle_timeout",
            504,
            guard?.terminalSeen ? "incomplete" : "error"
        );
    if (error?.code === "QUEUE_CLOSED")
        return new GenerationError(
            error.reason === "resource_exhausted"
                ? "resource_exhausted"
                : error.reason === "client_disconnect"
                  ? "client_disconnect"
                  : "transport_error",
            error.reason === "resource_exhausted" ? 503 : error.reason === "client_disconnect" ? 499 : 502,
            error.reason === "client_disconnect" ? "aborted" : "incomplete"
        );
    return new GenerationError(
        error?.code === "resource_exhausted" ? "resource_exhausted" : "internal_error",
        error?.status || 500
    );
}

async function run(handler, proxyRequest, initialQueue, req, res, options) {
    const { format, model, stream, responseDefaults = {} } = options;
    const config = handler.config;
    const registry = handler.connectionRegistry;
    const requestId = proxyRequest.request_id;
    const publicSpan = Diagnostics.get(req);
    const started = req.__generationStartedAt || Date.now();
    const timeout = config.generationPreoutputTimeoutMs || 300000;
    const deadline = started + timeout;
    const controller = new AbortController();
    const signal = controller.signal;
    const diagnostics = GenerationDiagnostics.create(handler.logger, {
        apiFormat: format,
        mode: stream ? proxyRequest.streaming_mode : "nonstream",
        model,
        requestId,
    });
    let timer = setTimeout(
        () => controller.abort(new GenerationError("preoutput_timeout", 504)),
        Math.max(1, deadline - Date.now())
    );
    let queue = initialQueue;
    let writer;
    let budget;
    let finalResult;
    let attemptsUsed = 0;
    let emptyRetries = 0;
    let authIndex = handler._getRequestAuthIndex(requestId);
    let attemptId;
    const close = () => {
        if (!res.writableFinished && !res.__generationDestroyed && !signal.aborted)
            controller.abort(new GenerationError("client_disconnect", 499, "aborted"));
    };
    res.on("close", close);
    res.__guardedGeneration = true;
    res.setHeader("X-Request-ID", requestId);
    const array =
        format === "gemini" && stream && String(req.query?.alt || proxyRequest.query_params?.alt || "") !== "sse";
    const cancel = () => {
        try {
            handler._cancelBrowserRequest(requestId, authIndex, attemptId);
        } catch {
            /* Cleanup cannot replace the original outcome. */
        }
        queue?.close(signal.reason?.code || "generation_cancelled");
    };
    signal.addEventListener("abort", cancel);
    let body;
    try {
        body = JSON.parse(proxyRequest.body);
        diagnostics?.emit("configuration", {
            browserProtocolVersion: 2,
            configuredTimeoutMs: timeout,
            includeThoughts: body.generationConfig?.thinkingConfig?.includeThoughts ?? null,
            maxOutputTokens: body.generationConfig?.maxOutputTokens ?? null,
            thinkingBudget: body.generationConfig?.thinkingConfig?.thinkingBudget ?? null,
            thinkingLevel: body.generationConfig?.thinkingConfig?.thinkingLevel ?? null,
        });
        if (
            format !== "gemini" &&
            (Number(req.body?.n || 1) > 1 || Number(body.generationConfig?.candidateCount || 1) > 1)
        )
            throw new GenerationError("unsupported_candidates", 400);
        // Do not assume that lack of output proves hosted tools did not execute.
        const unsafeTools =
            (body.tools || []).some(tool =>
                Object.keys(tool).some(key => !["functionDeclarations", "function_declarations"].includes(key))
            ) ||
            (format !== "gemini" &&
                (req.body?.tools || []).some(tool => tool.type && !["function", "custom"].includes(tool.type)));
        if (!stream) proxyRequest.streaming_mode = "fake";
        if (proxyRequest.streaming_mode === "fake") {
            proxyRequest.path = proxyRequest.path.replace(":streamGenerateContent", ":generateContent");
            proxyRequest.query_params = { ...proxyRequest.query_params };
            delete proxyRequest.query_params.alt;
        }
        const tracker = handler._createImmediateSwitchTracker(authIndex, model);
        for (let attempt = 1; attempt <= Math.max(1, config.maxRetries || 3); attempt++) {
            if (signal.aborted) throw signal.reason;
            let connection = registry.getConnectionByAuth(authIndex, false);
            if (connection?.generationProtocolVersion !== 2) {
                const excluded = (handler.authSource?.availableIndices || []).filter(
                    index => registry.getConnectionByAuth(index, false)?.generationProtocolVersion !== 2
                );
                const replacement = handler._selectRequestAuthIndex(excluded, model);
                const replacementConnection = registry.getConnectionByAuth(replacement, false);
                if (replacementConnection?.generationProtocolVersion !== 2)
                    throw new GenerationError("browser_upgrade_required", 503);
                authIndex = replacement;
                handler._bindRequestAuthIndex(requestId, authIndex);
                connection = replacementConnection;
                queue = registry.createMessageQueue(requestId, authIndex, proxyRequest.request_attempt_id);
            }
            attemptId = proxyRequest.request_attempt_id;
            publicSpan?.startAttempt(attemptId);
            attemptsUsed++;
            budget = new GenerationBudget(config.generationBufferBytes, config.generationGlobalBufferBytes);
            const attemptQueue = queue;
            queue.configureBudget(budget);
            const guard = new GenerationResultGuard(format, budget);
            let parser;
            let inputFormat;
            let headerStatus = null;
            let eof = false;
            let parserFinished = false;
            let sent = false;
            let wireBytes = 0;
            let chunks = 0;
            let retainedBytes = 0;
            let terminalBuffered = false;
            const terminalFrames = [];
            let fullResponse;
            let responseResult;
            let attemptRecorded = false;
            const startedAttempt = Date.now();
            writer = new GenerationResponseWriter({
                array,
                budget,
                converter: handler.formatConverter,
                diagnostics,
                format,
                model,
                onCommit: () => {
                    clearTimeout(timer);
                    timer = null;
                },
                publicSpan,
                res,
                responseDefaults,
                signal,
                stream,
                timeoutMs: config.streamTimeoutMs || 60000,
            });
            writer.upstreamStreaming = proxyRequest.streaming_mode === "real";
            diagnostics?.emit("attempt_started", { attemptId, attemptNo: attempt, authIndex });
            if (diagnostics)
                diagnostics.snapshot = () => ({
                    ...guard.summary(),
                    attemptId,
                    bufferPeakBytes: budget.peak,
                    inputFormat,
                    queuePeakBytes: queue.peakBytes,
                    serverDataUtf8Bytes: wireBytes,
                    serverWsChunks: chunks,
                });
            handler
                ._getUsageStatsService()
                ?.recordAttempt(requestId, authIndex, handler._getAccountNameForIndex(authIndex), attemptId);
            registry.registerGenerationAttempt(requestId, attemptId, authIndex);
            const recordAttempt = result => {
                if (attemptRecorded) return;
                attemptRecorded = true;
                handler._getUsageStatsService()?.recordAttemptResult(requestId, authIndex, {
                    attemptId,
                    errorCode: result.code,
                    outcome:
                        result.resultClass === "success"
                            ? "success"
                            : result.resultClass === "aborted"
                              ? "aborted"
                              : "error",
                    resultClass: result.resultClass,
                    statusCode: headerStatus,
                    upstreamStatus: headerStatus,
                });
                if (publicSpan?.debugActive)
                    publicSpan.attemptFinished(
                        {
                            ...guard.summary(),
                            attemptId,
                            attemptNo: attempt,
                            eofSeen: eof,
                            errorCode: result.code,
                            parserFinishOk: parserFinished,
                            resultClass: result.resultClass,
                            upstreamStatus: headerStatus,
                        },
                        guard.usage
                    );
                diagnostics?.emit(
                    "attempt_finished",
                    {
                        ...guard.summary(),
                        attemptId,
                        attemptNo: attempt,
                        authIndex,
                        bufferPeakBytes: budget.peak,
                        downstreamBodyBytesWritten: writer.bytes,
                        drainWaitMs: writer.drainWaitMs || 0,
                        eofSeen: eof,
                        errorCode: result.code,
                        eventCount: parser?.events || 0,
                        inputFormat,
                        observationComplete: eof && parserFinished,
                        parserFinishOk: parserFinished,
                        parserResidualBytes: parser ? (parser.buffer.length + parser.raw.length) * 2 : 0,
                        queuePeakBytes: queue.peakBytes,
                        resultClass: result.resultClass,
                        serverDataUtf8Bytes: wireBytes,
                        serverWsChunks: chunks,
                        totalMs: Date.now() - startedAttempt,
                        upstreamStatus: headerStatus,
                        wireStatus: res.headersSent ? res.statusCode : null,
                        writeBackpressureCount: writer.backpressure,
                    },
                    result.resultClass === "success" ? "INFO" : "WARN"
                );
            };
            const processFrames = async frames => {
                for (const frame of frames) {
                    diagnostics?.observeFrame(frame);
                    if (signal.aborted) throw signal.reason;
                    if (frame.parsed) {
                        const previousEffective = guard.effective;
                        guard.observe(frame.parsed);
                        publicSpan?.observeFrame(attemptId, frame.parsed);
                        if (!previousEffective && guard.effective)
                            publicSpan?.observeTime("firstEffectiveOutputMs", attemptId);
                        if (!previousEffective && guard.effective)
                            diagnostics?.emit("first_effective_output", {
                                attemptId,
                                firstEffectiveMs: Date.now() - started,
                            });
                        if (inputFormat === "json") {
                            fullResponse = frame.parsed;
                            handler._markAccountSuccess(authIndex, model);
                            // A fake stream has the whole response: validate before emitting any bytes.
                            responseResult = guard.finish();
                        }
                    }
                    if (!stream) continue;
                    if (format === "gemini") {
                        let data = frame.raw;
                        if (inputFormat === "json") {
                            const json = JSON.stringify(frame.parsed);
                            data = array ? `[${json}]` : `data: ${json}\n\n`;
                        }
                        const terminal = Boolean(
                            inputFormat === "json" ||
                            (inputFormat === "json_array" && !frame.parsed) ||
                            frame.done ||
                            frame.parsed?.promptFeedback?.blockReason ||
                            frame.parsed?.candidates?.some(c => c.finishReason)
                        );
                        terminalBuffered ||= terminal;
                        if (terminalBuffered) {
                            retainedBytes += data.length * 2;
                            budget.set("terminal", retainedBytes);
                            terminalFrames.push(data);
                        } else await writer.append(data, guard.effective);
                    } else if (frame.parsed) {
                        const event = {
                            ...frame.parsed,
                            candidates: frame.parsed.candidates?.map(c => ({ ...c, finishReason: undefined })),
                            promptFeedback: undefined,
                        };
                        if (format === "response_api") {
                            writer.converterSize += frame.raw.length * 2;
                            budget.set("converter", writer.converterSize);
                        }
                        const converted = writer.convert(event);
                        await writer.append(converted, guard.effective);
                    }
                    if (writer.committed) {
                        clearTimeout(timer);
                        timer = null;
                    }
                }
            };
            const overflow = () => {
                try {
                    handler._cancelBrowserRequest(requestId, authIndex, attemptId);
                } catch {
                    /* best effort */
                }
            };
            queue.on("overflow", overflow);
            try {
                proxyRequest.diagnostic_enabled = Boolean(diagnostics?.active);
                proxyRequest.stream_idle_timeout_ms =
                    proxyRequest.streaming_mode === "real"
                        ? config.streamTimeoutMs || 60000
                        : config.fakeStreamTimeoutMs || 300000;
                if (connection.readyState !== 1) throw new GenerationError("not_dispatched", 503);
                sent = true; // send exceptions are conservatively treated as possibly delivered.
                handler._forwardRequest(proxyRequest, authIndex);
                diagnostics?.emit("dispatch", { attemptId, dispatchState: "sent" });
                while (!eof) {
                    const idle = proxyRequest.stream_idle_timeout_ms;
                    const message = await queue.dequeue(
                        Math.max(1, idle - (Date.now() - queue.lastActivityAt)),
                        signal
                    );
                    if (message.event_type === "error") {
                        const browserCode = message.error_code;
                        const code =
                            browserCode === "invalid_utf8"
                                ? "invalid_utf8"
                                : browserCode === "resource_exhausted"
                                  ? "resource_exhausted"
                                  : browserCode === "read_timeout"
                                    ? "upstream_idle_timeout"
                                    : ["network_error", "aborted"].includes(browserCode)
                                      ? "transport_error"
                                      : "upstream_http_error";
                        const error = new GenerationError(
                            code,
                            Number(message.status) >= 400 ? Number(message.status) : 502
                        );
                        error.upstreamHttp =
                            (!browserCode || browserCode === "http_error") && Number(message.status) >= 400;
                        if (error.upstreamHttp) headerStatus = error.status;
                        throw error;
                    }
                    if (message.event_type === "response_headers") {
                        if (parser) throw new GenerationError("invalid_upstream_response");
                        headerStatus = Number(message.status);
                        diagnostics?.emit("upstream_headers", { attemptId, upstreamStatus: headerStatus });
                        if (headerStatus < 200 || headerStatus >= 300 || !Number.isFinite(headerStatus)) {
                            const error = new GenerationError(
                                "upstream_http_error",
                                Number.isFinite(headerStatus) && headerStatus >= 400 ? headerStatus : 502
                            );
                            error.upstreamHttp = true;
                            throw error;
                        }
                        inputFormat = GenerationInputAdapter.select(proxyRequest, message.headers);
                        parser = new GenerationInputAdapter(inputFormat, budget);
                    } else if (message.type === "STREAM_END") {
                        eof = true;
                        if (!parser) throw new GenerationError("invalid_upstream_response");
                        const finalFrames = parser.finish();
                        parserFinished = true;
                        await processFrames(finalFrames);
                        if (inputFormat !== "json") handler._markAccountSuccess(authIndex, model);
                        responseResult = guard.finish();
                        break;
                    } else if (message.event_type === "chunk") {
                        publicSpan?.observeTime("firstUpstreamByteMs", attemptId);
                        if (!parser || typeof message.data !== "string")
                            throw new GenerationError("invalid_upstream_response");
                        if (diagnostics?.active) {
                            wireBytes += Buffer.byteLength(message.data);
                            chunks++;
                        }
                        if (chunks === 1)
                            diagnostics?.emit("first_upstream_byte", {
                                attemptId,
                                firstUpstreamByteMs: Date.now() - started,
                            });
                        await processFrames(parser.push(message.data));
                    }
                }
                recordAttempt(responseResult);
                if (format === "gemini" && stream) {
                    for (const frame of terminalFrames) await writer.append(frame, true);
                }
                await writer.complete(responseResult, guard, fullResponse);
                clearTimeout(timer);
                timer = null;
                await waitForDelivery(res, signal, config.streamTimeoutMs || 60000);
                finalResult = {
                    ...responseResult,
                    attemptOutcome: responseResult.resultClass,
                    deliveryOutcome: "success",
                    upstreamStatus: headerStatus,
                };
            } catch (rawError) {
                const error = signal.aborted ? signal.reason : normalizeError(rawError, guard);
                if (!error.code) error.code = "internal_error";
                if (!error.resultClass) error.resultClass = "error";
                recordAttempt({ code: error.code, resultClass: error.resultClass });
                try {
                    handler._cancelBrowserRequest(requestId, authIndex, attemptId);
                } catch {
                    /* preserve failure */
                }
                diagnostics?.emit("cancel_requested", { attemptId, errorCode: error.code });
                const empty = ["empty_response", "thought_only"].includes(error.code) && eof && parserFinished;
                const transient = error.upstreamHttp && [401, 403, 429, 500, 502, 503, 504].includes(error.status);
                const remaining = deadline - Date.now();
                let eligible =
                    !res.headersSent &&
                    !res.destroyed &&
                    !signal.aborted &&
                    ((!sent && error.code === "not_dispatched") || (!unsafeTools && !guard.toolRisk)) &&
                    attempt < Math.max(1, config.maxRetries || 3) &&
                    remaining > 0 &&
                    ((empty && emptyRetries < (config.generationEmptyRetries ?? 1)) ||
                        transient ||
                        (!sent && error.code === "not_dispatched"));
                if (eligible && sent && !eof)
                    eligible = await registry.waitForGenerationAttempt(attemptId, Math.min(2000, remaining), signal);
                diagnostics?.emit(
                    "retry_decision",
                    {
                        attemptId,
                        attemptsUsed,
                        eligible,
                        emptyRetriesUsed: emptyRetries,
                        errorCode: error.code,
                        remainingDeadlineMs: Math.max(0, deadline - Date.now()),
                        toolRisk: unsafeTools || guard.toolRisk,
                    },
                    "WARN"
                );
                if (error.upstreamHttp) {
                    const details = { message: "Upstream HTTP error", modelName: model, status: error.status };
                    handler._autoDisableAccountForStatus(authIndex, details);
                    if (error.status === 429) handler._markAccount429ForModel(authIndex, model, details);
                    if (eligible && handler._shouldSwitchImmediatelyForStatus(error.status)) {
                        eligible = await abortable(
                            handler._prepareImmediateStatusRetry(details, requestId, tracker, authIndex),
                            signal
                        );
                    }
                }
                if (error.upstreamHttp && !eligible && !signal.aborted && handler._handleRequestFailureScoped) {
                    await abortable(
                        handler._handleRequestFailureScoped(
                            { message: "Upstream HTTP error", modelName: model, status: error.status },
                            requestId,
                            authIndex
                        ),
                        signal
                    );
                }
                if (eligible && !signal.aborted) {
                    await retryDelay(config.retryDelay ?? 2000, signal);
                    if (empty) emptyRetries++;
                    queue.close("attempt_superseded");
                    handler._advanceProxyRequestAttempt(proxyRequest);
                    authIndex = handler._getRequestAuthIndex(requestId, authIndex);
                    queue = registry.createMessageQueue(requestId, authIndex, proxyRequest.request_attempt_id);
                    continue;
                }
                finalResult = {
                    attemptOutcome: responseResult?.resultClass || error.resultClass,
                    code: error.code,
                    deliveryOutcome: error.resultClass === "aborted" ? "aborted" : "error",
                    resultClass: error.resultClass,
                    upstreamStatus: headerStatus,
                };
                writer.fail(error);
            } finally {
                attemptQueue.off("overflow", overflow);
                attemptQueue.close("attempt_finished");
                registry.releaseGenerationAttempt(attemptId);
                budget.close();
            }
            if (finalResult) break;
        }
    } catch (rawError) {
        const error = signal.aborted ? signal.reason : normalizeError(rawError);
        finalResult = {
            code: error.code,
            deliveryOutcome: error.resultClass === "aborted" ? "aborted" : "error",
            resultClass: error.resultClass,
        };
        if (!writer) {
            budget = new GenerationBudget(config.generationBufferBytes, config.generationGlobalBufferBytes);
            writer = new GenerationResponseWriter({
                array,
                budget,
                converter: handler.formatConverter,
                format,
                model,
                res,
                signal,
                stream,
            });
        }
        writer.fail(error);
    } finally {
        clearTimeout(timer);
        res.off("close", close);
        signal.removeEventListener("abort", cancel);
        budget?.close();
        finalResult ||= { code: "unclassified_outcome", deliveryOutcome: "error", resultClass: "error" };
        res.__generationResult = {
            ...finalResult,
            attemptCount: attemptsUsed,
            attemptId,
            wireStatus: res.headersSent ? res.statusCode : null,
        };
        res.__usageTrackingOutcome =
            finalResult.resultClass === "success"
                ? "success"
                : finalResult.resultClass === "aborted"
                  ? "aborted"
                  : "error";
        diagnostics?.emit(
            "request_finished",
            {
                ...res.__generationResult,
                downstreamBodyBytesWritten: writer?.bytes || 0,
                errorCode: finalResult.code,
                totalMs: Date.now() - started,
            },
            finalResult.resultClass === "success" ? "INFO" : "WARN"
        );
        diagnostics?.close();
    }
}

function abortable(operation, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(operation)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
    });
}

function retryDelay(ms, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(signal.reason);
        };
        const timer = setTimeout(
            () => {
                signal.removeEventListener("abort", abort);
                resolve();
            },
            Math.max(0, ms)
        );
        signal.addEventListener("abort", abort, { once: true });
    });
}

function waitForDelivery(res, signal, timeout) {
    if (res.writableFinished) return Promise.resolve();
    if (res.destroyed || signal.aborted)
        return Promise.reject(signal.reason || new GenerationError("client_disconnect", 499, "aborted"));
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            res.off("finish", finish);
            res.off("close", close);
            signal.removeEventListener("abort", abort);
        };
        const finish = () => {
            cleanup();
            resolve();
        };
        const close = () => {
            cleanup();
            reject(new GenerationError("client_disconnect", 499, "aborted"));
        };
        const abort = () => {
            cleanup();
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new GenerationError("downstream_timeout", 504));
        }, timeout);
        res.once("finish", finish);
        res.once("close", close);
        signal.addEventListener("abort", abort, { once: true });
    });
}

module.exports = { run };
