const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { test, before, after } = require("node:test");
const { requestGemini, closeTransport } = require("../loadtest/transport");
const { buildReport } = require("../loadtest/report");

const profile = {
    endMarker: "__LOADTEST_COMPLETE__",
    id: "10k-2k",
    inputTokens: 10000,
    maxOutputTokens: 2400,
    minOutputTokens: 2000,
};

let server;
let origin;
let redirectsFollowed = 0;
const sockets = new Set();
let monitorUptimes = [];
let monitorPatchApplied = true;
const monitorPatches = [];
const monitorActive = new Map();
const monitorPeaks = new Map();

function chunk(text, usage, finishReason) {
    return {
        candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }],
        ...(usage ? { usageMetadata: usage } : {}),
        modelVersion: "gemini-3.8-flash",
    };
}

const finalUsage = {
    cachedContentTokenCount: 25,
    candidatesTokenCount: 2100,
    promptTokenCount: 10001,
    thoughtsTokenCount: 900,
    totalTokenCount: 13001,
};

before(async () => {
    server = http.createServer(async (req, res) => {
        if (req.url === "/redirect-target") {
            redirectsFollowed++;
            res.end("should not be reached");
            return;
        }
        let raw = "";
        for await (const part of req) raw += part;
        const body = JSON.parse(raw || "{}");
        if (req.url.startsWith("/api/manage/v1/") || req.url === "/health") {
            const endpoint = req.url.split("?")[0];
            const active = (monitorActive.get(endpoint) || 0) + 1;
            monitorActive.set(endpoint, active);
            monitorPeaks.set(endpoint, Math.max(monitorPeaks.get(endpoint) || 0, active));
            await new Promise(resolve => setTimeout(resolve, 5));
            let data;
            if (endpoint.endsWith("/system/status"))
                data = {
                    accountCount: 90,
                    accountName: "private-account@example.com",
                    activeContextsCount: 3,
                    browserConnected: true,
                    credentials: "private-credential",
                    currentAccountId: "account-2",
                    enabledAccountCount: 90,
                    managementKey: "fixture-only-key",
                    ready: true,
                };
            else if (endpoint.endsWith("/system/readiness"))
                data = { checks: [{ credentials: "private-credential", name: "browser", ready: true }], ready: true };
            else if (endpoint.endsWith("/accounts"))
                data = {
                    items: [
                        {
                            accountId: "account-2",
                            accountName: "private-account@example.com",
                            credentials: "private-credential",
                            enabled: true,
                            index: 2,
                        },
                    ],
                    limit: 200,
                    offset: 0,
                    total: 90,
                };
            else if (endpoint.endsWith("/settings")) {
                if (req.method === "PATCH") monitorPatches.push(body);
                data = {
                    applied: monitorPatchApplied,
                    persisted: true,
                    values: { credentials: "private-credential", debugMode: false, maxContexts: 3 },
                };
            } else if (endpoint === "/health")
                data = {
                    browserConnected: true,
                    credentials: "private-credential",
                    status: "ok",
                    uptime: monitorUptimes.length ? monitorUptimes.shift() : 100,
                };
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(endpoint === "/health" ? data : { data }));
            monitorActive.set(endpoint, active - 1);
            return;
        }
        const fixtureCase = body.fixtureCase;
        res.setHeader("x-request-id", `fixture-${fixtureCase}`);
        if (fixtureCase === "redirect") {
            res.writeHead(302, { location: `${origin}/redirect-target` });
            res.end();
            return;
        }
        if (fixtureCase === "hang") return;
        if (fixtureCase === "reset") {
            req.socket.destroy();
            return;
        }
        if (fixtureCase === "count") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ totalTokens: 10001 }));
            return;
        }
        if (fixtureCase === "json") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(chunk("正文 __LOADTEST_COMPLETE__", finalUsage, "STOP")));
            return;
        }
        res.setHeader("content-type", "text/event-stream");
        if (fixtureCase === "thought-shapes") {
            const first = chunk("", null);
            first.candidates[0].index = 0;
            first.candidates[0].content.parts = [
                { text: "RAW_PRIVATE_THOUGHT_fixture-only-key", thought: true, thoughtSignature: "PRIVATE_SIGNATURE" },
                { text: "字符串false正文", thought: "false" },
            ];
            const last = chunk("尾部 __LOADTEST_COMPLETE__", finalUsage, "STOP");
            last.candidates[0].index = 0;
            last.candidates[0].content.parts.push({ text: "", thought: "UNRECOGNIZED_PRIVATE_THOUGHT_FLAG" });
            res.end(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\n`);
            return;
        }
        if (fixtureCase === "utf8") {
            const first = chunk("中文首段", {
                candidatesTokenCount: 10,
                promptTokenCount: 10001,
                totalTokenCount: 10011,
            });
            first.candidates[0].content.parts.push({ text: "隐含思考", thought: true });
            const last = chunk("😀末段 __LOADTEST_COMPLETE__", finalUsage, "STOP");
            const formatted = JSON.stringify(last).replace(',"usageMetadata"', ',\r\ndata: "usageMetadata"');
            const bytes = Buffer.from(
                `: comment\r\n\r\ndata: ${JSON.stringify(first)}\r\n\r\ndata: ${formatted}\r\n\r\n`,
                "utf8"
            );
            let index = 0;
            const next = () => {
                if (index >= bytes.length || res.destroyed) {
                    if (!res.destroyed) res.end();
                    return;
                }
                res.write(bytes.subarray(index, ++index));
                setImmediate(next);
            };
            next();
            return;
        }
        if (fixtureCase === "stream-error") {
            res.end(
                'event: error\ndata: {"error":{"code":429,"message":"fixture rate limit","status":"RESOURCE_EXHAUSTED"}}\n\n'
            );
            return;
        }
        if (fixtureCase === "bad-json") {
            res.end("data: not-json\n\n");
            return;
        }
        if (fixtureCase === "empty") {
            const data = chunk("", finalUsage, "STOP");
            data.candidates[0].content.parts = [{ text: "仅思考", thought: true }];
            res.end(`data: ${JSON.stringify(data)}\n\n`);
            return;
        }
        if (fixtureCase === "max-tokens") {
            res.end(`data: ${JSON.stringify(chunk("正文 __LOADTEST_COMPLETE__", finalUsage, "MAX_TOKENS"))}\n\n`);
            return;
        }
        if (fixtureCase === "missing-usage") {
            res.end(`data: ${JSON.stringify(chunk("正文 __LOADTEST_COMPLETE__", null, "STOP"))}\n\n`);
            return;
        }
        res.writeHead(500);
        res.end("unknown fixture");
    });
    server.on("connection", socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    closeTransport();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
});

function request(fixtureCase, options = {}) {
    return requestGemini({
        allowFixture: true,
        body: { fixtureCase },
        clientId: fixtureCase,
        key: "fixture-only-key",
        mode: "sse",
        origin,
        timeoutMs: 1000,
        ...options,
    });
}

test("SSE逐字节UTF8、CRLF及多行data正常解析，usage采用最后值且thought不进入正文", async () => {
    let sent = 0;
    const result = await request("utf8", { onSent: () => sent++ });
    assert.equal(result.httpStatus, 200);
    assert.equal(result.requestId, "fixture-utf8");
    assert.equal(result.text, "中文首段😀末段 __LOADTEST_COMPLETE__");
    assert.equal(result.promptTokens, 10001);
    assert.equal(result.candidateTokens, 2100);
    assert.equal(result.thoughtTokens, 900);
    assert.equal(result.totalTokens, 13001);
    assert.equal(result.cachedTokens, 25);
    assert.equal(result.finishReason, "STOP");
    assert.equal(result.eof, true);
    assert.equal(result.parseOk, true);
    assert.equal(result.streamError, false);
    assert.equal(sent, 1);
    assert.ok(result.firstTextMs >= result.ttfbMs);
});

test("两帧结构摘要保留thought类型及长度，true过滤而字符串false正文保留且摘要无原文", async () => {
    const result = await request("thought-shapes");
    assert.equal(result.text, "字符串false正文尾部 __LOADTEST_COMPLETE__");
    assert.doesNotMatch(result.text, /RAW_PRIVATE_THOUGHT|fixture-only-key/);
    assert.equal(result.firstEventShapes.length, 2);
    assert.equal(result.lastEventShapes.length, 2);
    const first = result.firstEventShapes[0];
    const last = result.lastEventShapes[1];
    assert.equal(first.eventIndex, 1);
    assert.equal(last.eventIndex, 2);
    assert.equal(first.candidates[0].index, 0);
    const [thought, ordinary] = first.candidates[0].parts;
    assert.equal(thought.thoughtType, "boolean");
    assert.equal(thought.thoughtValue, true);
    assert.equal(thought.textCharacters, "RAW_PRIVATE_THOUGHT_fixture-only-key".length);
    assert.ok(thought.types.includes("thoughtSignature"));
    assert.equal(ordinary.thoughtType, "string");
    assert.equal(ordinary.thoughtValue, "false");
    assert.equal(ordinary.textCharacters, "字符串false正文".length);
    assert.equal(last.candidates[0].finishReason, "STOP");
    assert.equal(last.candidates[0].parts[1].thoughtType, "string");
    assert.equal(last.candidates[0].parts[1].thoughtValue, null);
    const summary = JSON.stringify([result.firstEventShapes, result.lastEventShapes]);
    assert.doesNotMatch(
        summary,
        /RAW_PRIVATE_THOUGHT|fixture-only-key|PRIVATE_SIGNATURE|UNRECOGNIZED_PRIVATE_THOUGHT_FLAG|字符串false正文|尾部 __LOADTEST_COMPLETE__/
    );
});

test("HTTP200流内错误与坏JSON不能被误认为成功", async () => {
    const error = await request("stream-error");
    assert.equal(error.httpStatus, 200);
    assert.equal(error.streamError, true);
    assert.equal(error.providerErrorCode, 429);
    assert.ok(error.errorCode);
    const invalid = await request("bad-json");
    assert.equal(invalid.parseOk, false);
});

test("网络失败记录白名单错误码和连接阶段，不输出原始异常", async () => {
    const result = await request("reset");
    assert.equal(result.errorCode, "network_error");
    assert.equal(result.networkErrorCode, "ECONNRESET");
    assert.equal(result.networkErrorPhase, "awaiting_headers");
    assert.equal(result.httpStatus, null);
    assert.equal(result.providerErrorMessage, null);
});

test("JSON生成及countTokens支持原生Gemini响应", async () => {
    const json = await request("json", { mode: "json" });
    assert.equal(json.text, "正文 __LOADTEST_COMPLETE__");
    assert.equal(json.finishReason, "STOP");
    assert.equal(json.candidateTokens, 2100);
    assert.equal(json.eof, true);
    const count = await request("count", { mode: "count" });
    assert.equal(count.countTokens, 10001);
});

test("不跟随302，授权请求不会发送到重定向目标", async () => {
    const result = await request("redirect");
    assert.equal(result.httpStatus, 302);
    assert.equal(redirectsFollowed, 0);
    assert.ok(result.errorCode);
});

test("总超时和外部取消快速结束并释放连接，预取消不发送请求", async () => {
    const started = performance.now();
    const timeout = await request("hang", { timeoutMs: 30 });
    assert.ok(timeout.errorCode);
    assert.ok(performance.now() - started < 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    const aborted = await request("hang", { signal: controller.signal });
    clearTimeout(timer);
    assert.ok(aborted.errorCode);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let sent = 0;
    const skipped = await request("json", { onSent: () => sent++, signal: alreadyAborted.signal });
    assert.equal(skipped.sent, false);
    assert.equal(sent, 0);
});

test("实际token、空正文、MAX_TOKENS、缺少usage与结束标记参与合格分类", async () => {
    const { classify } = require("../loadtest/runner");
    const good = await request("utf8");
    assert.equal(classify(good, profile).qualified, true);
    const empty = await request("empty");
    assert.equal(empty.text, "");
    assert.equal(classify(empty, profile).qualified, false);
    assert.equal(classify(await request("max-tokens"), profile).qualified, false);
    assert.equal(classify(await request("missing-usage"), profile).qualified, false);
    assert.equal(classify({ ...good, text: "missing end marker" }, profile).qualified, false);
    assert.equal(classify({ ...good, promptTokens: 9999 }, profile).qualified, false);
    assert.equal(classify({ ...good, promptTokens: 10200 }, profile).qualified, false);
    assert.equal(classify({ ...good, candidateTokens: 1999 }, profile).qualified, false);
    assert.equal(classify({ ...good, candidateTokens: 2401 }, profile).qualified, false);
});

test("response成功口径保留正文完整性和错误校验，usage缺失或token偏差不判失败", async () => {
    const { classify } = require("../loadtest/runner");
    const responseProfile = { ...profile, successMetric: "response" };
    const missingUsage = await request("missing-usage");
    const missingVerdict = classify(missingUsage, responseProfile);
    assert.equal(missingVerdict.qualified, true);
    assert.equal(missingVerdict.inputValid, false);
    assert.equal(missingVerdict.outputValid, false);
    assert.equal(classify(missingUsage, profile).classification, "usage_missing", "严格token口径仍保留");
    const outOfRange = { ...missingUsage, candidateTokens: 10, promptTokens: 1 };
    assert.equal(classify(outOfRange, responseProfile).qualified, true);
    assert.equal(classify(outOfRange, profile).qualified, false);
    assert.equal(classify(await request("empty"), responseProfile).classification, "empty_reply");
    assert.equal(classify(await request("max-tokens"), responseProfile).classification, "output_truncated");
    assert.equal(classify(await request("stream-error"), responseProfile).classification, "stream_error");
    assert.equal(
        classify({ ...missingUsage, text: "正文没有结束标记" }, responseProfile).classification,
        "completion_marker_missing"
    );
    assert.equal(classify({ ...missingUsage, eof: false }, responseProfile).classification, "incomplete_transport");
    assert.equal(classify({ ...missingUsage, parseOk: false }, responseProfile).classification, "parse_error");
    assert.equal(classify({ ...missingUsage, httpStatus: 503 }, responseProfile).qualified, false);
});

function successfulResult(clientId, totalMs = 10) {
    return {
        candidateTokens: 2100,
        clientId,
        eof: true,
        errorCode: null,
        finishReason: "STOP",
        firstTextMs: 1,
        httpStatus: 200,
        parseOk: true,
        promptTokens: 10001,
        sent: true,
        streamError: false,
        text: "fixture body __LOADTEST_COMPLETE__",
        thoughtTokens: 900,
        totalMs,
        totalTokens: 13001,
    };
}

test("300请求同时调度且计量已发送峰值，301拒绝，未发送不能冒充目标并发", async () => {
    const { runWave } = require("../loadtest/runner");
    let active = 0;
    let peak = 0;
    const result = await runWave({
        concurrency: 300,
        profile,
        request: async (clientId, onSent) => {
            active++;
            peak = Math.max(peak, active);
            onSent();
            onSent(); // Repeated transport notification must not double count.
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
            return successfulResult(clientId);
        },
        stageId: "fixture-c300",
    });
    assert.equal(peak, 300);
    assert.equal(active, 0);
    assert.equal(result.peakSentInFlight, 300);
    assert.equal(result.requestCount, 300);
    assert.equal(result.passed, true);
    await assert.rejects(
        runWave({ concurrency: 301, profile, request: async () => successfulResult("bad"), stageId: "fixture-c301" }),
        /invalid_concurrency/
    );
    const unsent = await runWave({
        concurrency: 3,
        profile,
        request: async clientId => successfulResult(clientId),
        stageId: "fixture-unsent",
    });
    assert.equal(unsent.peakSentInFlight, 0);
    assert.equal(unsent.passed, false);
});

test("失败总耗时进入P95；监控取消后不新增请求且排空已启动请求", async () => {
    const { runWave, runStage } = require("../loadtest/runner");
    let number = 0;
    const wave = await runWave({
        concurrency: 3,
        profile,
        request: async (clientId, onSent) => {
            onSent();
            return ++number === 3
                ? { ...successfulResult(clientId, 600000), eof: false, errorCode: "timeout" }
                : successfulResult(clientId, 1000);
        },
        stageId: "fixture-timeout-p95",
    });
    assert.equal(wave.p95Ms, 600000);
    assert.equal(wave.passed, false);
    const controller = new AbortController();
    let admitted = 0;
    let active = 0;
    const records = [];
    const stage = await runStage({
        concurrency: 3,
        durationMs: 50,
        minimumCount: 10,
        mode: "sse",
        onResult: record => {
            records.push(record);
            controller.abort("readiness_failed_60s");
        },
        phase: "sustain",
        profile,
        request: async (clientId, onSent) => {
            admitted++;
            active++;
            onSent();
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
            return successfulResult(clientId);
        },
        signal: controller.signal,
        stageId: "fixture-safety-abort",
        sustain: true,
    });
    assert.equal(admitted, 3);
    assert.equal(active, 0);
    assert.equal(records.length, 3);
    assert.equal(stage.passed, false);
    assert.match(stage.abortReason, /readiness_failed_60s/);
    let unexpectedCalls = 0;
    const skipped = await runWave({
        concurrency: 3,
        profile,
        request: async () => {
            unexpectedCalls++;
            return successfulResult("unexpected");
        },
        signal: controller.signal,
        stageId: "fixture-preabort",
    });
    assert.equal(unexpectedCalls, 0);
    assert.equal(skipped.requestCount, 0);
});

test("持续调度维持固定并发并同时满足时间与完成数条件", async () => {
    const { runStage } = require("../loadtest/runner");
    let active = 0;
    let peak = 0;
    const result = await runStage({
        concurrency: 3,
        durationMs: 20,
        minimumCount: 15,
        mode: "sse",
        onResult: () => {},
        onTick: () => {},
        phase: "sustain",
        profile,
        request: async (clientId, onSent) => {
            active++;
            peak = Math.max(peak, active);
            onSent();
            await new Promise(resolve => setTimeout(resolve, 3));
            active--;
            return successfulResult(clientId);
        },
        stageId: "fixture-steady",
        sustain: true,
    });
    assert.equal(peak, 3);
    assert.equal(active, 0);
    assert.ok(result.durationMs >= 20);
    assert.ok(result.requestCount >= 15);
    assert.equal(result.passed, true);
});

test("模型阶段不允许并行重叠，记录失败也等待其余已发请求排空", async () => {
    const { runWave } = require("../loadtest/runner");
    const pending = [];
    let active = 0;
    const first = runWave({
        concurrency: 3,
        onResult: record => {
            if (record.clientId.includes("-0-")) throw new Error("fixture recording failure");
        },
        profile,
        request: async (clientId, onSent) => {
            active++;
            onSent();
            await new Promise(resolve => pending.push(resolve));
            active--;
            return successfulResult(clientId);
        },
        stageId: "fixture-overlap-first",
    });
    await assert.rejects(
        runWave({
            concurrency: 3,
            profile,
            request: async () => successfulResult("unexpected"),
            stageId: "fixture-overlap-second",
        }),
        /overlapping_model_stages/
    );
    pending.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(active, 2, "记录失败不能提前释放阶段互斥锁");
    await assert.rejects(
        runWave({
            concurrency: 1,
            profile,
            request: async () => successfulResult("unexpected"),
            stageId: "fixture-overlap-third",
        }),
        /overlapping_model_stages/
    );
    for (const resolve of pending) resolve();
    await assert.rejects(first, /stage_recording_failed/);
    assert.equal(active, 0);
    const next = await runWave({
        concurrency: 1,
        profile,
        request: async (clientId, onSent) => {
            onSent();
            return successfulResult(clientId);
        },
        stageId: "fixture-after-drain",
    });
    assert.equal(next.passed, true);
});

test("Monitor限制授权origin及设置修改字段，未应用设置返回错误", async () => {
    const { Monitor } = require("../loadtest/monitor");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aito-loadtest-monitor-settings-"));
    const options = { managementKey: "fixture-only-key", outputDir: directory };
    for (const target of [
        "https://example.com",
        "https://aib.zeabur.app/private",
        "https://aib.zeabur.app/?key=abc",
        "http://aib.zeabur.app",
        "http://localhost:1234",
    ]) {
        assert.throws(() => new Monitor({ ...options, allowFixture: true, origin: target }), /INVALID_ORIGIN/);
    }
    const monitor = new Monitor({ ...options, allowFixture: true, origin });
    try {
        const beforePatches = monitorPatches.length;
        for (const patch of [
            { maxRetries: 1 },
            { credentials: "fake" },
            { maxContexts: 1001 },
            { maxContexts: -1 },
            { debugMode: "true" },
            {},
        ]) {
            await assert.rejects(monitor.patchSettings(patch), /INVALID_SETTINGS_PATCH/);
        }
        assert.equal(monitorPatches.length, beforePatches);
        const applied = await monitor.patchSettings({ debugMode: true, maxContexts: 3 });
        assert.equal(applied.applied, true);
        assert.deepEqual(monitorPatches.at(-1), { debugMode: true, maxContexts: 3 });
        monitorPatchApplied = false;
        await assert.rejects(monitor.patchSettings({ maxContexts: 3 }), /SETTINGS_APPLICATION_FAILED/);
    } finally {
        monitorPatchApplied = true;
        await monitor.stop();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("Monitor快照串行且敏感字段不落盘，uptime下降通知环境重启", async () => {
    const { Monitor } = require("../loadtest/monitor");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aito-loadtest-monitor-snapshot-"));
    const alerts = [];
    monitorUptimes = [100, 1];
    monitorPeaks.clear();
    const monitor = new Monitor({
        allowFixture: true,
        managementKey: "fixture-only-key",
        onUnsafe: event => alerts.push(event),
        origin,
        outputDir: directory,
    });
    try {
        const [first, second] = await Promise.all([
            monitor.snapshot("fixture-only-key"),
            monitor.snapshot("after-restart"),
        ]);
        assert.equal(first.health.uptime, 100);
        assert.equal(second.health.uptime, 1);
        assert.equal(alerts.length, 1);
        assert.equal(alerts[0].reason, "restarted");
        for (const peak of monitorPeaks.values()) assert.equal(peak, 1, "同一endpoint的两轮采样不能重叠");
        const raw = fs.readFileSync(path.join(directory, "environment.jsonl"), "utf8");
        assert.doesNotMatch(raw, /private-account|private-credential|credentials|accountName|fixture-only-key/);
        assert.equal(raw.trim().split("\n").length, 2);
        assert.equal(first.label, "redacted-label");
        const latest = monitor.latest;
        latest.readiness.ready = false;
        assert.equal(monitor.latest.readiness.ready, true, "读取latest返回副本，调用者不能修改监控内部状态");
    } finally {
        monitorUptimes = [];
        await monitor.stop();
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("报告只有完整持续验收能证明稳定容量，缺失300和中止原因保留", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aito-loadtest-report-"));
    try {
        const requests = Array.from({ length: 300 }, (_, index) => ({
            ...finalUsage,
            candidateTokens: 2100,
            classification: "qualified",
            clientId: `client-${index}`,
            concurrency: 3,
            eof: true,
            finishReason: "STOP",
            firstTextMs: 100,
            httpStatus: 200,
            mode: "sse",
            parseOk: true,
            phase: "sustain",
            profileId: profile.id,
            promptTokens: 10001,
            qualified: true,
            requestId: `server-${index}`,
            stageId: "sustain-3",
            thoughtTokens: 900,
            totalMs: 1000,
        }));
        const stages = [
            {
                concurrency: 3,
                durationMs: 600001,
                mode: "sse",
                p95Ms: 1000,
                passed: true,
                peakCreatedInFlight: 3,
                peakSentInFlight: 3,
                phase: "sustain",
                profileId: profile.id,
                qualifiedRate: 1,
                requestCount: 300,
                stageId: "sustain-3",
            },
            {
                abortReason: "readiness continuously failed",
                concurrency: 300,
                durationMs: 61000,
                mode: "sse",
                p95Ms: 60000,
                passed: false,
                peakCreatedInFlight: 300,
                peakSentInFlight: 34,
                phase: "explore",
                profileId: profile.id,
                qualifiedRate: 0,
                requestCount: 34,
                stageId: "aborted-300",
            },
        ];
        fs.writeFileSync(
            path.join(directory, "requests.jsonl"),
            requests.map(row => JSON.stringify(row)).join("\n") + "\n"
        );
        fs.writeFileSync(
            path.join(directory, "stages.jsonl"),
            stages.map(row => JSON.stringify(row)).join("\n") + "\n"
        );
        fs.writeFileSync(
            path.join(directory, "deployment-before.json"),
            JSON.stringify({ deployment: { commit: "4cb7756b2c4454d5e3d8586478d65ed4dc74298a" } })
        );
        fs.writeFileSync(
            path.join(directory, "platform-metrics.json"),
            JSON.stringify({ cpu: { points: [] }, memory: { points: null } })
        );
        fs.writeFileSync(
            path.join(directory, "platform.jsonl"),
            JSON.stringify({
                logs: { rawEntryCount: 0 },
                metrics: { cpu: [], memory: [], network: [] },
                missing: ["cpu_metric_points_empty", "resourceLimit_incomplete"],
            }) + "\n"
        );
        fs.writeFileSync(
            path.join(directory, "server-usage.jsonl"),
            [
                { accountId: "account-two", index: 2, requestId: "server-0" },
                { accountId: null, index: null, requestId: "server-1" },
                { accountId: "unrelated-account", index: 99, requestId: "unrelated-request" },
            ]
                .map(row => JSON.stringify(row))
                .join("\n") + "\n"
        );
        const report = buildReport(directory);
        assert.equal(report.capacities[0].stable, 3);
        assert.equal(report.capacities[0].maxAchieved, 34);
        assert.equal(report.summaries.find(row => row.phase === "sustain").candidateTokens, 630000);
        const sustainSummary = report.summaries.find(row => row.phase === "sustain");
        assert.equal(sustainSummary.serverMatchedCount, 2);
        assert.equal(sustainSummary.serverUnmatchedCount, 298);
        assert.equal(sustainSummary.serverMatchedWithoutAccount, 1);
        assert.deepEqual(sustainSummary.accountDistribution, { "account-two": 1 });
        const markdown = fs.readFileSync(report.reportPath, "utf8");
        assert.match(markdown, /没有达到 300/);
        assert.match(markdown, /readiness continuously failed/);
        assert.match(markdown, /环境指标缺失/);
        assert.match(markdown, /4cb7756b2c4454d5e3d8586478d65ed4dc74298a/);
        assert.match(markdown, /平台 CPU\/内存指标缺失/);
        assert.match(markdown, /未验证服务器 CPU/);
        assert.match(markdown, /不评估模型的复杂推理能力/);
        assert.match(markdown, /resourceLimit_incomplete/);
        assert.match(markdown, /运行日志采样返回 0 条/);
        assert.match(markdown, /不能还原每次内部重试/);
        stages[0].durationMs = 599999;
        fs.writeFileSync(
            path.join(directory, "stages.jsonl"),
            stages.map(row => JSON.stringify(row)).join("\n") + "\n"
        );
        assert.equal(buildReport(directory).capacities[0].stable, null);
        stages[0].durationMs = 600001;
        fs.writeFileSync(
            path.join(directory, "stages.jsonl"),
            stages.map(row => JSON.stringify(row)).join("\n") + "\n"
        );
        fs.writeFileSync(
            path.join(directory, "requests.jsonl"),
            requests
                .slice(0, 299)
                .map(row => JSON.stringify(row))
                .join("\n") + "\n"
        );
        assert.equal(buildReport(directory).capacities[0].stable, null, "不完整原始样本不能只依靠stage.passed证明容量");
    } finally {
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

test("中断部分样本独立计量，恢复同档不混合正常波次分母或证明容量", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aito-loadtest-partial-report-"));
    try {
        const recorded = (stageId, index, { concurrency = 3, qualified = true } = {}) => ({
            ...successfulResult(`${stageId}-${index}`, 1000),
            classification: qualified ? "qualified" : "completion_marker_missing",
            concurrency,
            markerPresent: qualified,
            mode: "sse",
            phase: "explore",
            profileId: profile.id,
            qualified,
            stageId,
            textBytes: 40,
        });
        const requests = [
            recorded("interrupted-3", 0),
            recorded("interrupted-300", 0, { concurrency: 300 }),
            recorded("resumed-3", 0),
            recorded("resumed-3", 1),
            recorded("resumed-3", 2, { qualified: false }),
        ];
        const stages = [
            {
                concurrency: 3,
                durationMs: 1000,
                mode: "sse",
                p95Ms: 1000,
                passed: false,
                peakSentInFlight: 3,
                phase: "explore",
                profileId: profile.id,
                qualifiedRate: 2 / 3,
                requestCount: 3,
                stageId: "resumed-3",
            },
        ];
        for (const [file, rows] of [
            ["requests.jsonl", requests],
            ["stages.jsonl", stages],
        ])
            fs.writeFileSync(path.join(directory, file), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
        fs.writeFileSync(path.join(directory, "baseline.json"), JSON.stringify({ successMetric: "response" }));
        const report = buildReport(directory);
        assert.equal(report.requestCount, 5);
        assert.equal(report.completedStageSampleCount, 3);
        assert.equal(report.partialStageSampleCount, 2);
        assert.equal(report.partialStageCount, 2);
        assert.equal(report.summaries.length, 1);
        assert.equal(report.summaries[0].requestCount, 3);
        assert.equal(report.summaries[0].qualifiedRate, 2 / 3);
        assert.equal(report.summaries[0].responseSuccessRate, 2 / 3);
        assert.equal(report.capacities[0].maxTarget, 3, "中断300档不能冒充已完成最高目标档");
        assert.equal(report.capacities[0].wave, null);
        assert.equal(report.capacities[0].stable, null);
        assert.deepEqual(
            report.partialStageSamples.map(row => row.stageId),
            ["interrupted-3", "interrupted-300"]
        );
        assert.ok(
            report.partialStageSamples.every(
                row =>
                    row.phase === "partial" &&
                    row.originalPhase === "explore" &&
                    row.stageCount === 0 &&
                    row.durationMs === null &&
                    row.requestsPerSecond === null &&
                    row.unknownRequestCount === null
            )
        );
        const markdown = fs.readFileSync(report.reportPath, "utf8");
        assert.match(markdown, /已闭合阶段完整回复成功 2\/3/);
        assert.match(markdown, /不进入正常波次成功率分母/);
        assert.match(markdown, /未返回请求的数量和最终状态未知/);
        const csv = fs.readFileSync(report.summaryPath, "utf8");
        assert.match(csv, /partial/);
        assert.match(csv, /interrupted-300/);
    } finally {
        fs.rmSync(directory, { force: true, recursive: true });
    }
});
