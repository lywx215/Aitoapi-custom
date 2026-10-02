const assert = require("node:assert/strict");
const { test } = require("node:test");
const { validateCapacity } = require("../loadtest/capacity");

const profile = { id: "fixture-10k-2k" };

function stage(concurrency, { phase = "explore", mode = "sse", passed = true, serial = 0, ...override } = {}) {
    return {
        concurrency,
        durationMs: phase === "sustain" ? 600000 : 1000,
        mode,
        p95Ms: 1000,
        passed,
        peakSentInFlight: concurrency,
        phase,
        profileId: profile.id,
        qualifiedRate: passed ? 1 : 0.9,
        requestCount: phase === "sustain" ? Math.max(300, 3 * concurrency) : concurrency,
        stageId: `${mode}-${phase}-${concurrency}-${serial}`,
        ...override,
    };
}

function fakeRunner({ waveLimit = 300, sustainLimit = 300, abortAfter = Infinity } = {}) {
    const calls = [];
    let aborted = false;
    return {
        calls,
        isAborted: () => aborted,
        runStage: async request => {
            calls.push(request);
            const result = stage(request.concurrency, {
                mode: request.mode,
                passed: request.concurrency <= (request.sustain ? sustainLimit : waveLimit),
                phase: request.phase,
                serial: calls.length,
            });
            if (calls.length >= abortAfter) {
                aborted = true;
                result.abortReason = "fixture_abort";
            }
            return result;
        },
    };
}

test("确认三波失败不会继续持续测试；已合格持续档复用", async () => {
    const existingStages = [
        stage(50, { phase: "sustain", serial: 1 }),
        stage(100),
        stage(150, { passed: false }),
        ...[true, false, true].map((passed, serial) => stage(100, { passed, phase: "confirm", serial })),
    ];
    const fixture = fakeRunner({ sustainLimit: 50, waveLimit: 50 });
    const result = await validateCapacity({ existingStages, profile, ...fixture, candidateConcurrencies: [50, 100] });
    assert.equal(result.status, "verified");
    assert.equal(result.stableConcurrency, 50);
    assert.ok(result.nextFailure - result.stableConcurrency <= 5);
    assert.equal(fixture.calls.filter(call => call.concurrency === 50 || call.concurrency === 100).length, 0);
    assert.deepEqual(result.reusedSustainedStageIds, ["sse-sustain-50-1"]);
    assert.equal(fixture.calls.filter(call => call.sustain).length, 0);
});

test("持续失败后在已通过持续与失败档之间细化到相差<=5，每候选三波", async () => {
    const fixture = fakeRunner({ sustainLimit: 60, waveLimit: 140 });
    const result = await validateCapacity({
        existingStages: [stage(100), stage(150, { passed: false })],
        profile,
        ...fixture,
    });
    assert.equal(result.status, "verified");
    assert.equal(result.stableConcurrency, 59);
    assert.equal(result.nextFailure, 62);
    assert.ok(result.nextFailure - result.stableConcurrency <= 5);
    assert.equal(fixture.calls.filter(call => call.concurrency === 100 && call.sustain).length, 1);
    for (const concurrency of result.evaluatedConcurrencies) {
        assert.equal(
            fixture.calls.filter(call => call.concurrency === concurrency && call.phase === "confirm").length,
            3
        );
    }
    assert.ok(fixture.calls.some(call => call.concurrency === 50 && call.sustain));
    assert.ok(fixture.calls.some(call => call.concurrency === 59 && call.sustain));
});

test("非流式每个确认通过的关键候选都持续测试，包括1/边界/失败候选/300", async () => {
    const fixture = fakeRunner();
    const result = await validateCapacity({
        mode: "json",
        profile,
        ...fixture,
        candidateConcurrencies: [1, 20, 100, 300],
    });
    assert.equal(result.status, "verified");
    assert.equal(result.stableConcurrency, 300);
    assert.equal(result.verifiedTo300, true);
    assert.deepEqual(
        fixture.calls.filter(call => call.sustain).map(call => call.concurrency),
        [1, 20, 100, 300]
    );
    const sustained = result.newStages.filter(record => record.phase === "sustain");
    assert.ok(
        sustained.every(
            record => record.durationMs >= 600000 && record.requestCount >= Math.max(300, 3 * record.concurrency)
        )
    );
    const resumed = fakeRunner();
    const resume = await validateCapacity({
        mode: "json",
        profile,
        ...resumed,
        candidateConcurrencies: [1, 20, 100, 300],
        existingStages: result.newStages,
    });
    assert.equal(resume.stableConcurrency, 300);
    assert.equal(resumed.calls.length, 0);
});

test("恢复两波确认时只补第三波，复用记录不会写入或改变原数组", async () => {
    const existingStages = [stage(300, { phase: "confirm", serial: 1 }), stage(300, { phase: "confirm", serial: 2 })];
    const serialized = JSON.stringify(existingStages);
    const fixture = fakeRunner();
    const result = await validateCapacity({ existingStages, profile, ...fixture, candidateConcurrencies: [300] });
    assert.equal(result.stableConcurrency, 300);
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls[0].phase, "confirm");
    assert.equal(fixture.calls[0].confirmationWave, 3);
    assert.equal(fixture.calls[1].phase, "sustain");
    assert.equal(JSON.stringify(existingStages), serialized);
});

test("新阶段预算与中止限制新增请求，不把未知结果认作容量", async () => {
    const budget = fakeRunner();
    const limited = await validateCapacity({ profile, ...budget, maxNewStages: 1 });
    assert.equal(budget.calls.length, 1);
    assert.equal(limited.status, "incomplete");
    assert.equal(limited.stopReason, "stage_budget_exhausted");
    assert.equal(limited.stableConcurrency, null);
    const interrupted = fakeRunner({ abortAfter: 2 });
    const aborted = await validateCapacity({ profile, ...interrupted });
    assert.equal(interrupted.calls.length, 2);
    assert.equal(aborted.aborted, true);
    assert.equal(aborted.stableConcurrency, null);
    const alreadyAborted = fakeRunner();
    const skipped = await validateCapacity({ profile, ...alreadyAborted, isAborted: () => true });
    assert.equal(skipped.aborted, true);
    assert.equal(alreadyAborted.calls.length, 0);
});

test("持续少于10分钟或样本不足不能证明容量，callback异常不重试", async () => {
    const calls = [];
    const result = await validateCapacity({
        candidateConcurrencies: [300],
        profile,
        runStage: async request => {
            calls.push(request);
            return stage(request.concurrency, {
                durationMs: request.sustain ? 599999 : 1000,
                phase: request.phase,
                serial: calls.length,
            });
        },
    });
    assert.equal(calls.length, 4);
    assert.equal(result.status, "incomplete");
    assert.equal(result.stopReason, "incomplete_stage_evidence");
    assert.equal(result.stableConcurrency, null);
    let failures = 0;
    const failed = await validateCapacity({
        profile,
        runStage: async () => {
            failures++;
            throw new Error("fixture_failure");
        },
    });
    assert.equal(failures, 1);
    assert.equal(failed.stopReason, "run_stage_failed");
});

test("1并发三波失败会终止，没有持续证据不宣称稳定容量", async () => {
    const fixture = fakeRunner({ sustainLimit: 0, waveLimit: 0 });
    const result = await validateCapacity({ profile, ...fixture });
    assert.equal(result.status, "no_stable_capacity");
    assert.equal(result.stableConcurrency, null);
    assert.equal(result.nextFailure, 1);
    assert.equal(fixture.calls.length, 3);
    assert.equal(fixture.calls.filter(call => call.sustain).length, 0);
});

test("1并发三波失败不会漏测已有10并发通过档，低档失败保留为非单调证据", async () => {
    const calls = [];
    const result = await validateCapacity({
        existingStages: [
            stage(1, { passed: false }),
            ...[1, 2, 3].map(serial => stage(1, { passed: false, phase: "confirm", serial })),
            stage(10),
            stage(20, { passed: false }),
            stage(300, { passed: false }),
        ],
        profile,
        runStage: async request => {
            calls.push(request);
            return stage(request.concurrency, {
                passed: request.concurrency === 10,
                phase: request.phase,
                serial: calls.length,
            });
        },
    });
    assert.equal(result.status, "verified");
    assert.equal(result.stableConcurrency, 10);
    assert.ok(result.nextFailure > 10 && result.nextFailure <= 15);
    assert.deepEqual(result.nonMonotonicEvidence, [1]);
    assert.equal(calls.filter(call => call.concurrency === 1).length, 0);
    assert.equal(calls.filter(call => call.concurrency === 10 && call.phase === "confirm").length, 3);
    assert.equal(calls.filter(call => call.concurrency === 10 && call.sustain).length, 1);
});

test("多个非单调探索通过档均先确认并持续，最高通过档决定后续边界", async () => {
    const calls = [];
    const result = await validateCapacity({
        existingStages: [
            stage(1, { passed: false }),
            stage(10),
            stage(20, { passed: false }),
            stage(50),
            stage(100, { passed: false }),
        ],
        profile,
        runStage: async request => {
            calls.push(request);
            return stage(request.concurrency, {
                passed: [10, 50].includes(request.concurrency),
                phase: request.phase,
                serial: calls.length,
            });
        },
    });
    assert.equal(result.stableConcurrency, 50);
    assert.ok(result.nextFailure > 50 && result.nextFailure <= 55);
    assert.deepEqual(result.nonMonotonicEvidence, [1, 20]);
    assert.deepEqual(
        calls.filter(call => call.sustain).map(call => call.concurrency),
        [50, 10]
    );
    for (const concurrency of [10, 50]) {
        assert.equal(calls.filter(call => call.concurrency === concurrency && call.phase === "confirm").length, 3);
    }
});

test("非流式低档确认失败仍完成高档候选；补充已有通过档不会减少关键档验证", async () => {
    const calls = [];
    const result = await validateCapacity({
        candidateConcurrencies: [1, 20, 100, 300],
        existingStages: [stage(10, { mode: "json", phase: "nonstream" })],
        mode: "json",
        profile,
        runStage: async request => {
            calls.push(request);
            return stage(request.concurrency, {
                mode: "json",
                passed: request.concurrency === 10,
                phase: request.phase,
                serial: calls.length,
            });
        },
    });
    assert.equal(result.stableConcurrency, 10);
    assert.ok(result.nextFailure > 10 && result.nextFailure <= 15);
    for (const concurrency of [1, 10, 20, 100, 300]) {
        assert.equal(calls.filter(call => call.concurrency === concurrency && call.phase === "confirm").length, 3);
    }
    assert.deepEqual(
        calls.filter(call => call.sustain).map(call => call.concurrency),
        [10]
    );
    const sustained = result.newStages.find(record => record.phase === "sustain");
    assert.ok(sustained.durationMs >= 600000 && sustained.requestCount >= Math.max(300, 3 * sustained.concurrency));
});

test("同一部署负载已有300持续验证时不重跑；其他负载与格式证据不混用", async () => {
    const fixture = fakeRunner();
    const result = await validateCapacity({
        profile,
        ...fixture,
        existingStages: [
            stage(300, { phase: "sustain" }),
            stage(300, { mode: "json", phase: "sustain", serial: 1 }),
            { ...stage(300, { phase: "sustain", serial: 2 }), profileId: "other-profile" },
        ],
    });
    assert.equal(result.stableConcurrency, 300);
    assert.equal(fixture.calls.length, 0);
    assert.equal(result.reusedSustainedStageIds.length, 1);
});
