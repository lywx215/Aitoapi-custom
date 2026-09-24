const assert = require("assert");
const http = require("http");
const { once } = require("events");
const Adapter = require("../../src/core/GenerationInputAdapter");
const Budget = require("../../src/core/GenerationBudget");
const Guard = require("../../src/core/GenerationResultGuard");
const Pipeline = require("../../src/core/GenerationPipeline");
const FormatConverter = require("../../src/core/FormatConverter");
const MessageQueue = require("../../src/utils/MessageQueue");
const LoggingService = require("../../src/utils/LoggingService");

const logger = { debug() {}, error() {}, info() {}, warn() {} };
const candidate = (parts, finishReason) => ({
    candidates: [{ content: { parts, role: "model" }, ...(finishReason ? { finishReason } : {}) }],
});
let count = 0;

function parsers() {
    const object = candidate([{ text: '中文🙂 ] } \\"' }], "STOP");
    for (const [format, data] of [
        ["sse", `\uFEFF: ping\r\ndata: ${JSON.stringify(object)}\r\n\r\n`],
        ["json_array", ` [ ${JSON.stringify(object)} , ${JSON.stringify({ usageMetadata: {} })} ] `],
        ["json", JSON.stringify(object)],
    ]) {
        const bytes = Buffer.from(data);
        for (let split = 0; split <= bytes.length; split++) {
            const parser = new Adapter(format);
            const events = [
                ...parser.push(bytes.subarray(0, split)),
                ...parser.push(bytes.subarray(split)),
                ...parser.finish(),
            ];
            assert.deepStrictEqual(events.filter(e => e.parsed)[0].parsed, object);
            assert.strictEqual(events.map(e => e.raw).join(""), data);
        }
        count++;
    }
    for (const format of ["sse", "json_array", "json"]) {
        const parser = new Adapter(format);
        assert.throws(() => {
            parser.push(format === "sse" ? 'data: {"a":' : '[{"a":');
            parser.finish();
        }, /incomplete|invalid/);
    }
    const parser = new Adapter("sse");
    assert.throws(() => {
        parser.push(Buffer.from([0xf0, 0x9f]));
        parser.finish();
    }, /invalid utf8/);
    const multiline = new Adapter("sse");
    assert.deepStrictEqual(multiline.push('data: {"usageMetadata":\ndata: {}}\n\n')[0].parsed, { usageMetadata: {} });
}

async function request({
    format,
    mode = "real",
    events = [],
    chunks = null,
    attempts = null,
    maxRetries = 1,
    tools = [],
    config = {},
    query = { alt: "sse" },
    close = true,
    dispatch = null,
    ack = true,
    protocolVersion = 2,
    connectionState = 1,
    clientAbortMs = null,
    acceptReadError = false,
}) {
    let currentQueue;
    let attemptNo = 0;
    let cancelled = 0;
    let result;
    const connection = { generationProtocolVersion: protocolVersion, readyState: connectionState };
    const registry = {
        createMessageQueue() {
            currentQueue?.close("retry_replaced");
            currentQueue = new MessageQueue();
            return currentQueue;
        },
        getConnectionByAuth() {
            return connection;
        },
        registerGenerationAttempt() {},
        releaseGenerationAttempt() {},
        waitForGenerationAttempt: async () => ack,
    };
    const records = [];
    const handler = {
        _advanceProxyRequestAttempt(p) {
            p.request_attempt_id += "r";
        },
        _autoDisableAccountForStatus() {},
        _bindRequestAuthIndex() {},
        _cancelBrowserRequest() {
            cancelled++;
        },
        _createImmediateSwitchTracker: () => ({}),
        _forwardRequest(p) {
            const list = attempts ? attempts[attemptNo] : events;
            attemptNo++;
            if (dispatch) {
                dispatch(currentQueue, p, attemptNo);
                return;
            }
            const data =
                mode === "real"
                    ? query.alt === "sse"
                        ? list.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")
                        : JSON.stringify(list)
                    : JSON.stringify(list[0] ?? {});
            const source = chunks || Array.from(data);
            currentQueue.enqueue({
                event_type: "response_headers",
                headers: {
                    "content-type": mode === "real" && query.alt === "sse" ? "text/event-stream" : "application/json",
                },
                status: 200,
            });
            for (const text of source)
                currentQueue.enqueue({ data: text, event_type: "chunk", request_attempt_id: p.request_attempt_id });
            if (close) currentQueue.enqueue({ type: "STREAM_END" });
        },
        _getAccountNameForIndex: () => null,
        _getRequestAuthIndex: () => 0,
        _getUsageStatsService: () => ({
            recordAttempt() {},
            recordAttemptResult(id, auth, value) {
                records.push(value);
            },
        }),
        _markAccount429ForModel() {},
        _markAccountSuccess() {},
        _prepareImmediateStatusRetry: async () => true,
        _selectRequestAuthIndex: () => 0,
        _shouldSwitchImmediatelyForStatus: () => false,
        authSource: { availableIndices: [0] },
        config: { generationPreoutputTimeoutMs: 5000, maxRetries, retryDelay: 0, streamTimeoutMs: 100, ...config },
        connectionRegistry: registry,
        formatConverter: new FormatConverter(logger, { config: { safetySettingsThreshold: "OFF" } }),
        logger,
    };
    const server = http.createServer(async (req, res) => {
        const proxy = {
            body: JSON.stringify({ tools }),
            is_generative: true,
            path: `/v1beta/models/test:${mode === "real" ? "streamGenerateContent" : "generateContent"}`,
            query_params: query,
            request_attempt_id: "a1",
            request_id: "r1",
            streaming_mode: mode === "real" ? "real" : "fake",
        };
        try {
            await Pipeline.run(handler, proxy, registry.createMessageQueue(), { body: {}, query }, res, {
                format,
                model: "test",
                stream: mode !== "nonstream",
            });
            result = res.__generationResult;
        } catch (error) {
            result = error;
            res.destroy();
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const clientController = new AbortController();
    const clientTimer = clientAbortMs == null ? null : setTimeout(() => clientController.abort(), clientAbortMs);
    let partialText = "";
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal: clientController.signal });
        let text;
        if (acceptReadError) {
            const decoder = new TextDecoder();
            for await (const bytes of response.body) partialText += decoder.decode(bytes, { stream: true });
            text = partialText + decoder.decode();
        } else text = await response.text();
        await new Promise(resolve => setImmediate(resolve));
        return {
            attemptNo,
            cancelled,
            records,
            result,
            status: response.status,
            text,
            type: response.headers.get("content-type"),
        };
    } catch (error) {
        if (clientAbortMs == null && !acceptReadError) throw error;
        await new Promise(resolve => setTimeout(resolve, 15));
        return { attemptNo, cancelled, readError: error.name, records, result, text: partialText };
    } finally {
        clearTimeout(clientTimer);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        assert.strictEqual(Budget.total, 0, "all request budgets released");
    }
}

async function main() {
    LoggingService.setLevel("INFO");
    parsers();
    for (const format of ["gemini", "openai", "response_api", "claude"]) {
        for (const mode of ["real", "fake", "nonstream"]) {
            const normal = await request({ events: [candidate([{ text: "hello" }], "STOP")], format, mode });
            assert.strictEqual(normal.status, 200, `${format}/${mode}: ${normal.text}`);
            assert(normal.text.includes("hello"));
            assert.strictEqual(normal.result.resultClass, "success");
            for (const event of [
                candidate([], "STOP"),
                { usageMetadata: { totalTokenCount: 1 } },
                candidate([{ text: "private thinking", thought: true }], "STOP"),
                candidate([], "MAX_TOKENS"),
            ]) {
                const empty = await request({ events: [event], format, mode });
                assert.strictEqual(empty.status, 502, `${format}/${mode}: ${empty.text}`);
                assert(!empty.text.includes("private thinking"));
                assert(empty.type.startsWith("application/json"));
            }
            const blocked = await request({ events: [{ promptFeedback: { blockReason: "SAFETY" } }], format, mode });
            assert.strictEqual(blocked.status, 200, `${format}/${mode} blocked: ${blocked.text}`);
            assert.strictEqual(blocked.result.resultClass, "blocked");
            const truncated = await request({ events: [candidate([{ text: "partial" }], "MAX_TOKENS")], format, mode });
            assert.strictEqual(truncated.status, 200);
            assert.strictEqual(truncated.result.resultClass, "incomplete");
            const tool = await request({
                events: [candidate([{ functionCall: { args: {}, name: "test_tool" } }], "STOP")],
                format,
                mode,
            });
            assert.strictEqual(tool.status, 200);
            assert(tool.text.includes("test_tool"));
            count += 8;
        }
    }
    const retry = await request({
        attempts: [[], [candidate([{ text: "recovered" }], "STOP")]],
        format: "openai",
        maxRetries: 3,
    });
    assert.strictEqual(retry.attemptNo, 2);
    assert.strictEqual(retry.status, 200);
    assert.deepStrictEqual(
        retry.records.map(r => r.resultClass),
        ["empty", "success"]
    );
    const unsafe = await request({ events: [], format: "openai", maxRetries: 3, tools: [{ codeExecution: {} }] });
    assert.strictEqual(unsafe.attemptNo, 1);
    const partial = await request({ events: [candidate([{ text: "partial" }])], format: "openai" });
    assert.strictEqual(partial.status, 200);
    assert(partial.text.includes("incomplete_stream"));
    assert(!partial.text.includes("[DONE]"));
    const bad = await request({ chunks: ["data: {bad}\n\n"], format: "openai" });
    assert.strictEqual(bad.status, 502);
    const nativeArray = await request({
        events: [candidate([{ text: "array" }], "STOP")],
        format: "gemini",
        query: {},
    });
    assert.strictEqual(JSON.parse(nativeArray.text)[0].candidates[0].content.parts[0].text, "array");
    const timeout = await request({
        close: false,
        config: { generationPreoutputTimeoutMs: 15 },
        events: [],
        format: "openai",
    });
    assert.strictEqual(timeout.status, 504);
    const limited = await request({
        config: { generationBufferBytes: 64 },
        events: [candidate([{ text: "large" }], "STOP")],
        format: "openai",
    });
    assert.strictEqual(limited.status, 503);
    const guard = new Guard();
    guard.observe(candidate([{ text: "text" }], "OTHER"));
    assert.throws(() => guard.finish(), /upstream finish error/);
    console.log(`PASS generation pipeline: ${count + 8} scenarios plus byte-boundary parser cases`);
}

if (require.main === module)
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
module.exports = { candidate, request };
