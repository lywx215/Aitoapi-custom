const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const Logging = require("../../src/utils/LoggingService");
const Diagnostics = require("../../src/core/GenerationDiagnostics");
const Registry = require("../../src/core/ConnectionRegistry");
const Usage = require("../../src/core/UsageStatsService");
const Budget = require("../../src/core/GenerationBudget");
const Writer = require("../../src/core/GenerationResponseWriter");
const { candidate, request } = require("./generationPipeline.test");
const silent = { debug() {}, error() {}, info() {}, warn() {} };

test("diagnostics: standard modes do no work; DEBUG is bounded, redacted and stops immediately", async () => {
    const logger = new Logging("test");
    let evaluated = 0;
    const output = [];
    const debug = console.debug;
    console.debug = line => output.push(line);
    try {
        for (const level of ["INFO", "WARN", "ERROR"]) {
            Logging.setLevel(level);
            assert.equal(Diagnostics.create(logger, {}), null);
            logger.diagnostic("ERROR", "generation.failure", () => {
                evaluated++;
                return {};
            });
        }
        assert.equal(evaluated, 0);
        assert.equal(logger.logBuffer.length, 0);
        Logging.setLevel("DEBUG");
        const diagnostic = Diagnostics.create(logger, { requestId: "r1" });
        for (let i = 0; i < 100; i++) diagnostic.observeFrame({ parsed: {}, raw: "PRIVATE_CONTENT" });
        assert.equal(diagnostic.recentEvents.length, 12);
        diagnostic.emit(
            "attempt_finished",
            { body: "SECRET_KEY", prompt: "PRIVATE_CONTENT", resultClass: "empty" },
            "WARN"
        );
        await new Promise(setImmediate);
        assert(output.some(line => JSON.parse(line).resultClass === "empty"));
        assert(!output.join("").includes("SECRET_KEY"));
        assert(!output.join("").includes("PRIVATE_CONTENT"));
        for (let i = 0; i < 2000; i++) logger.diagnostic("INFO", "generation.test", () => ({}));
        assert(logger.diagnosticQueue.length <= 128);
        assert(logger.logBuffer.length <= 1000);
        const before = output.length;
        Logging.setLevel("INFO");
        assert.equal(diagnostic.active, false);
        assert.equal(diagnostic.recentEvents.length, 0);
        assert.equal(Logging.levelListeners.size, 0);
        await new Promise(setImmediate);
        assert.equal(output.length, before);
    } finally {
        Logging.setLevel("INFO");
        console.debug = debug;
    }
});

test("attempt closure is bound to request, attempt, account and original socket", async () => {
    const registry = new Registry(silent);
    const socket = { send() {} };
    registry.connectionsByAuth.set(1, socket);
    registry.registerGenerationAttempt("r", "a", 1);
    const message = {
        event_type: "attempt_closed",
        protocol_version: 2,
        reason: "aborted",
        request_attempt_id: "a",
        request_id: "r",
    };
    registry._handleIncomingMessage(JSON.stringify(message), 2, socket);
    registry._handleIncomingMessage(JSON.stringify(message), 1, {});
    registry._handleIncomingMessage(JSON.stringify({ ...message, request_id: "other" }), 1, socket);
    assert.equal(await registry.waitForGenerationAttempt("a", 5), false);
    const pending = registry.waitForGenerationAttempt("a", 100);
    registry._handleIncomingMessage(JSON.stringify(message), 1, socket);
    assert.equal(await pending, true);
    const q = registry.createMessageQueue("r", 1, "new");
    registry._handleIncomingMessage(
        JSON.stringify({ data: "stale", event_type: "chunk", request_attempt_id: "a", request_id: "r" }),
        1,
        socket
    );
    assert.equal(q.messages.length, 0);
    registry.releaseGenerationAttempt("a");
    clearTimeout(registry.generationAttempts.get("a").timer);
    registry.removeMessageQueue("r");
});

test("statistics distinguish retries on the same account and preserve historical wire status", () => {
    const service = new Usage(null, silent, null, false);
    service.enabled = true;
    service._appendRecord = () => {};
    service.startRequest("r", { requestCategory: "generation" });
    service.recordAttempt("r", 1, "account", "a1");
    service.recordAttempt("r", 1, "account", "a2");
    service.recordAttemptResult("r", 1, {
        attemptId: "a1",
        outcome: "error",
        resultClass: "empty",
        upstreamStatus: 200,
    });
    service.recordAttemptResult("r", 1, {
        attemptId: "a2",
        outcome: "success",
        resultClass: "success",
        upstreamStatus: 200,
    });
    const record = service.finishRequest("r", {
        attemptId: "a2",
        attemptOutcome: "success",
        deliveryOutcome: "aborted",
        outcome: "aborted",
        resultClass: "aborted",
        statusCode: 200,
        wireStatus: 200,
    });
    assert.deepEqual(
        record.attempts.map(a => [a.attemptId, a.resultClass]),
        [
            ["a1", "empty"],
            ["a2", "success"],
        ]
    );
    assert.equal(record.wireStatus, 200);
    assert.equal(record.attemptOutcome, "success");
    assert.equal(service.summary.classifiedAbortedCount, 1);
    const old = service._normalizeLoadedRecord({ outcome: "success", statusCode: 200 });
    assert.equal(old.resultClass, undefined);
    assert.equal(service._normalizeLoadedRecord({ statusCode: null }).statusCode, null);
});

function browser(bytes, level = "INFO") {
    const source = fs
        .readFileSync(require.resolve("../client/build.js"), "utf8")
        .replace(/initializeProxySystem\(\);\s*$/, "globalThis.exports = { ProxySystem, Logger };");
    const context = {
        AbortController,
        Blob,
        clearTimeout,
        console: silent,
        CustomEvent,
        Date,
        document: { body: { appendChild() {} }, createElement: () => ({}) },
        DOMException,
        EventTarget,
        fetch: async () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        for (const b of bytes) controller.enqueue(b);
                        controller.close();
                    },
                })
            ),
        performance,
        setTimeout,
        TextDecoder,
        TextEncoder,
        URL,
        URLSearchParams,
        window: {},
    };
    context.console = { ...silent, log() {} };
    vm.runInNewContext(source, context);
    const proxy = new context.exports.ProxySystem();
    context.exports.Logger.currentLevel = context.exports.Logger.LEVELS[level];
    const messages = [];
    proxy.connectionManager = {
        isConnected: true,
        socket: { bufferedAmount: 0 },
        transmit: message => messages.push(message),
    };
    return { messages, proxy };
}
const spec = {
    body: "{}",
    diagnostic_enabled: true,
    is_generative: true,
    method: "POST",
    path: "/v1beta/models/test:streamGenerateContent",
    request_attempt_id: "a",
    request_id: "r",
    streaming_mode: "real",
};

test("real browser script flushes UTF-8, bounds chunks and emits cleanup ack without standard-mode diagnostics", async () => {
    const text = "中文🙂".repeat(50000);
    const bytes = new TextEncoder().encode(text);
    const { proxy, messages } = browser([bytes.subarray(0, 5), bytes.subarray(5)]);
    await proxy._processProxyRequest(spec);
    const chunks = messages.filter(m => m.event_type === "chunk");
    assert.equal(chunks.map(c => c.data).join(""), text);
    assert(chunks.every(c => Buffer.byteLength(JSON.stringify(c)) < 1024 * 1024));
    assert.equal(messages.at(-2).event_type, "stream_close");
    assert.equal(messages.at(-1).event_type, "attempt_closed");
    assert.equal(messages.at(-1).diagnostic, undefined);
    assert.equal(proxy.requestProcessor.activeOperations.size, 0);
});

test("browser truncated UTF-8 produces error and cleanup ack, never successful EOF", async () => {
    const { proxy, messages } = browser([new Uint8Array([0xf0, 0x9f])], "DEBUG");
    await proxy._processProxyRequest(spec);
    assert.equal(messages.find(m => m.event_type === "error").error_code, "invalid_utf8");
    assert(!messages.some(m => m.event_type === "stream_close"));
    assert.equal(messages.at(-1).reason, "error");
    assert.equal(messages.at(-1).diagnostic.browserReadBytes, 2);
});

test("downstream backpressure waits for drain and abort removes waiters", async () => {
    const res = new EventEmitter();
    Object.assign(res, { end() {}, removeHeader() {}, setHeader() {}, write: () => false });
    const controller = new AbortController();
    const budget = new Budget();
    const writer = new Writer({
        budget,
        format: "openai",
        res,
        signal: controller.signal,
        stream: true,
        timeoutMs: 100,
    });
    let done = false;
    const write = writer.append("data: hello\n\n", true).then(() => {
        done = true;
    });
    await new Promise(setImmediate);
    assert.equal(done, false);
    res.emit("drain");
    await write;
    const second = writer.write("data: next\n\n");
    controller.abort(new Error("cancelled"));
    await assert.rejects(second, /cancelled/);
    assert.equal(res.listenerCount("drain"), 0);
    assert.equal(res.listenerCount("close"), 0);
    budget.close();
});

test("client protocols retain MAX_TOKENS and refusal, with no false success terminator after truncation", async () => {
    for (const format of ["openai", "response_api", "claude"]) {
        for (const mode of ["real", "fake", "nonstream"]) {
            const limited = await request({
                events: [candidate([{ functionCall: { args: {}, name: "tool" } }], "MAX_TOKENS")],
                format,
                mode,
            });
            assert(
                limited.text.includes(
                    format === "openai"
                        ? '"finish_reason":"length"'
                        : format === "claude"
                          ? '"stop_reason":"max_tokens"'
                          : '"status":"incomplete"'
                ),
                limited.text
            );
            const blocked = await request({ events: [candidate([], "SAFETY")], format, mode });
            assert(
                blocked.text.includes(
                    format === "openai" ? "content_filter" : format === "claude" ? "refusal" : "content_filter"
                )
            );
        }
        const partial = await request({ events: [candidate([{ text: "partial" }])], format });
        assert.equal(partial.result.resultClass, "incomplete");
        assert(
            !partial.text.includes(
                format === "openai"
                    ? "[DONE]"
                    : format === "claude"
                      ? "event: message_stop"
                      : "event: response.completed"
            )
        );
    }
});

test("HTTP retries require cleanup acknowledgement and share the total attempt budget with empty retries", async () => {
    const headers = queue =>
        queue.enqueue({
            event_type: "response_headers",
            headers: { "content-type": "text/event-stream" },
            status: 200,
        });
    for (const ack of [false, true]) {
        const result = await request({
            ack,
            dispatch(queue, proxy, attempt) {
                if (attempt === 1) queue.enqueue({ error_code: "http_error", event_type: "error", status: 503 });
                else if (attempt === 2) {
                    headers(queue);
                    queue.enqueue({ type: "STREAM_END" });
                } else {
                    headers(queue);
                    queue.enqueue({
                        data: `data: ${JSON.stringify(candidate([{ text: "ok" }], "STOP"))}\n\n`,
                        event_type: "chunk",
                    });
                    queue.enqueue({ type: "STREAM_END" });
                }
            },
            format: "openai",
            maxRetries: 3,
        });
        assert.equal(result.attemptNo, ack ? 3 : 1);
        assert.equal(result.status, ack ? 200 : 503);
    }
    const empty = await request({ format: "openai", maxRetries: 5 });
    assert.equal(empty.attemptNo, 2);
    const old = await request({ format: "openai", protocolVersion: 1 });
    assert.equal(old.status, 503);
    assert.equal(old.attemptNo, 0);
    assert(old.text.includes("browser_upgrade_required"));
});

test("continuous content outlives the preoutput deadline; terminal without EOF fails without a normal terminator", async () => {
    const live = await request({
        config: { generationPreoutputTimeoutMs: 20, streamTimeoutMs: 200 },
        dispatch(queue) {
            queue.enqueue({
                event_type: "response_headers",
                headers: { "content-type": "text/event-stream" },
                status: 200,
            });
            queue.enqueue({ data: `data: ${JSON.stringify(candidate([{ text: "first" }]))}\n\n`, event_type: "chunk" });
            setTimeout(() => {
                queue.enqueue({
                    data: `data: ${JSON.stringify(candidate([{ text: "last" }], "STOP"))}\n\n`,
                    event_type: "chunk",
                });
                queue.enqueue({ type: "STREAM_END" });
            }, 50);
        },
        format: "openai",
    });
    assert.equal(live.result.resultClass, "success");
    for (const format of ["gemini", "openai"]) {
        const hanging = await request({
            close: false,
            config: { streamTimeoutMs: 10 },
            events: [candidate([{ text: "text" }], "STOP")],
            format,
        });
        assert.equal(hanging.status, format === "gemini" ? 504 : 200);
        assert.equal(hanging.result.code, "terminal_without_eof");
        assert(!hanging.text.includes("[DONE]"));
    }
});

test("native multi-candidate mixed completion preserves candidates and reports incomplete", async () => {
    const first = candidate([{ text: "answer" }], "STOP").candidates[0];
    const second = { ...candidate([], "MAX_TOKENS").candidates[0], index: 1 };
    const mixed = await request({ events: [{ candidates: [first, second] }], format: "gemini", mode: "nonstream" });
    assert.equal(mixed.status, 200);
    assert.equal(JSON.parse(mixed.text).candidates.length, 2);
    assert.equal(mixed.result.resultClass, "incomplete");
});

test("Claude audit: pretty-printed/BOM native fake output is a valid SSE JSON event", async () => {
    const payload = candidate([{ text: "pretty" }], "STOP");
    const result = await request({
        chunks: ["\uFEFF" + JSON.stringify(payload, null, 2)],
        format: "gemini",
        mode: "fake",
    });
    assert.equal(result.status, 200);
    const Adapter = require("../../src/core/GenerationInputAdapter");
    const parser = new Adapter("sse");
    const frames = [...parser.push(result.text), ...parser.finish()];
    assert.deepEqual(
        frames.filter(frame => frame.parsed).map(frame => frame.parsed),
        [payload]
    );
});

test("Claude audit: 4,000,000-character image fits the default logical budget", async () => {
    const payload = candidate([{ inlineData: { data: "a".repeat(4000000), mimeType: "image/png" } }], "STOP");
    for (const [format, mode] of [
        ["gemini", "real"],
        ["response_api", "real"],
        ["openai", "nonstream"],
        ["claude", "nonstream"],
    ]) {
        const data = mode === "real" ? `data: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload);
        const chunks = [];
        for (let i = 0; i < data.length; i += 65536) chunks.push(data.slice(i, i + 65536));
        const result = await request({ chunks, format, mode });
        assert.equal(result.status, 200, `${format}: ${result.text.slice(0, 180)}`);
        assert.equal(result.result.resultClass, "success");
    }
});

test("Claude audit: definitely unsent requests may retry even with hosted tools", async () => {
    const result = await request({
        connectionState: 3,
        format: "openai",
        maxRetries: 3,
        tools: [{ codeExecution: {} }],
    });
    assert.equal(result.attemptNo, 0);
    assert.equal(result.result.attemptCount, 3);
});

test("tool fragments aggregate by ID, preserve that ID and never deliver incomplete arguments", async () => {
    const first = candidate([{ functionCall: { args: '{"query":', id: "stable_tool_id", name: "search" } }]);
    const last = candidate([{ functionCall: { args: '"hello"}', id: "stable_tool_id" } }], "STOP");
    for (const format of ["openai", "response_api", "claude"]) {
        const result = await request({ events: [first, last], format });
        assert.equal(result.result.resultClass, "success");
        assert(result.text.includes("stable_tool_id"));
        assert(result.text.includes('\\"query\\":\\"hello\\"'));
        if (format === "openai") assert(result.text.includes('"finish_reason":"tool_calls"'));
        if (format === "claude") assert(result.text.includes('"stop_reason":"tool_use"'));
        const partial = await request({ events: [first], format, maxRetries: 3 });
        assert.equal(partial.status, 502);
        assert.equal(partial.attemptNo, 1);
        assert(!partial.text.includes("stable_tool_id"));
    }
});

test("unsupported media is not mislabeled as an image alongside valid text", async () => {
    const mixed = await request({
        events: [candidate([{ text: "valid" }, { inlineData: { data: "YWJj", mimeType: "audio/wav" } }], "STOP")],
        format: "openai",
    });
    assert.equal(mixed.result.resultClass, "success");
    assert(!mixed.text.includes("audio/wav"));
    const only = await request({
        events: [candidate([{ inlineData: { data: "YWJj", mimeType: "audio/wav" } }], "STOP")],
        format: "openai",
    });
    assert.equal(only.status, 502);
    assert(only.text.includes("unsupported_output"));
});

test("real HTTP client cancellation is attributed before and after response commitment without retry", async () => {
    for (const content of [false, true]) {
        const result = await request({
            clientAbortMs: 35,
            close: false,
            config: { streamTimeoutMs: 500 },
            events: content ? [candidate([{ text: "started" }])] : [],
            format: "openai",
            maxRetries: 3,
        });
        assert.equal(result.result.resultClass, "aborted");
        assert.equal(result.result.deliveryOutcome, "aborted");
        assert.equal(result.result.wireStatus, content ? 200 : null);
        assert.equal(result.attemptNo, 1);
        assert(result.cancelled > 0);
    }
});

test("native array without candidate finish never delivers a closing bracket or clean HTTP end", async () => {
    const result = await request({
        acceptReadError: true,
        dispatch(queue) {
            queue.enqueue({
                event_type: "response_headers",
                headers: { "content-type": "application/json" },
                status: 200,
            });
            queue.enqueue({ data: `[${JSON.stringify(candidate([{ text: "partial" }]))}`, event_type: "chunk" });
            setTimeout(() => {
                queue.enqueue({ data: "]", event_type: "chunk" });
                queue.enqueue({ type: "STREAM_END" });
            }, 10);
        },
        format: "gemini",
        query: {},
    });
    assert(result.readError);
    assert(result.text.startsWith("["));
    assert(!result.text.endsWith("]"));
    assert.equal(result.result.code, "incomplete_stream");
    assert.equal(result.result.resultClass, "incomplete");
});

test("Claude follow-up: id/index aliases, blocked tools, truncated args and fake validation", async () => {
    const first = candidate([{ functionCall: { args: '{"x":', id: "original", index: 0, name: "tool" } }]);
    const last = candidate([{ functionCall: { args: "1}", index: 0 }, thoughtSignature: "signature" }], "STOP");
    const combined = await request({ events: [first, last], format: "openai" });
    assert.equal(combined.result.resultClass, "success");
    assert(combined.text.includes('"id":"original"'));
    for (const finish of ["SAFETY", "MALFORMED_FUNCTION_CALL"]) {
        const refused = await request({
            events: [candidate([{ functionCall: { args: {}, name: "must_not_run" } }], finish)],
            format: "openai",
        });
        assert(!refused.text.includes("must_not_run"));
    }
    const truncated = await request({
        events: [
            candidate(
                [{ text: "partial answer" }, { functionCall: { args: "{", id: "a", name: "tool" } }],
                "MAX_TOKENS"
            ),
        ],
        format: "openai",
    });
    assert.equal(truncated.result.resultClass, "incomplete");
    assert(!truncated.text.includes('"tool_calls"'));
    for (const format of ["gemini", "openai", "response_api", "claude"]) {
        const fake = await request({ events: [candidate([{ text: "unfinished" }])], format, mode: "fake" });
        assert.equal(fake.status, 502);
        const retried = await request({
            attempts: [[], [candidate([{ text: "ok" }], "STOP")]],
            format,
            maxRetries: 3,
            mode: "fake",
        });
        assert.equal(retried.status, 200);
        assert.equal(retried.attemptNo, 2);
    }
});
