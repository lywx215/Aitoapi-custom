/* Production load test: client tooling only; does not change generation code. */
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { randomBytes } = require("node:crypto");

const ORIGIN = "https://aib.zeabur.app";
const MARKER = "__LOADTEST_COMPLETE__";
const LADDER = [1, 3, 10, 20, 50, 100, 150, 200, 250, 300];
const PROFILES = [10000, 30000, 50000].flatMap(inputTokens =>
    [2000, 4000].map(outputTokens => ({
        endMarker: MARKER,
        id: `in${inputTokens}-out${outputTokens}`,
        inputTokens,
        maxOutputTokens: outputTokens === 2000 ? 2400 : 4400,
        minOutputTokens: outputTokens === 2000 ? 2000 : 3600,
        outputTokens,
    }))
);
let activeStage = false;

function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function classify(result, profile) {
    const inputValid =
        Number.isInteger(result.promptTokens) &&
        result.promptTokens >= profile.inputTokens &&
        result.promptTokens <= Math.ceil(profile.inputTokens * 1.01) + 32;
    const outputValid =
        Number.isInteger(result.candidateTokens) &&
        result.candidateTokens >= profile.minOutputTokens &&
        result.candidateTokens <= profile.maxOutputTokens;
    const textPresent = typeof result.text === "string" && result.text.trim().length > 0;
    const markerPresent = textPresent && result.text.trimEnd().endsWith(profile.endMarker);
    const transportSuccess =
        result.httpStatus === 200 &&
        result.eof === true &&
        result.parseOk === true &&
        !result.streamError &&
        !result.errorCode;
    let classification = "qualified";
    if (result.errorCode) classification = result.errorCode;
    else if (result.httpStatus !== 200) classification = `http_${result.httpStatus || "missing"}`;
    else if (result.streamError) classification = "stream_error";
    else if (!result.parseOk) classification = "parse_error";
    else if (!result.eof) classification = "incomplete_transport";
    else if (!textPresent) classification = "empty_reply";
    else if (result.finishReason === "MAX_TOKENS") classification = "output_truncated";
    else if (result.finishReason !== "STOP") classification = "finish_reason_not_stop";
    else if (
        profile.successMetric !== "response" &&
        (!Number.isInteger(result.promptTokens) || !Number.isInteger(result.candidateTokens))
    )
        classification = "usage_missing";
    else if (profile.successMetric !== "response" && !inputValid) classification = "input_tokens_out_of_range";
    else if (profile.successMetric !== "response" && !outputValid) classification = "output_tokens_out_of_range";
    else if (!markerPresent) classification = "completion_marker_missing";
    return {
        classification,
        inputValid,
        markerPresent,
        outputValid,
        qualified: classification === "qualified",
        transportSuccess,
    };
}

/** All workers are admitted together; sent concurrency starts only after upload. */
async function runWave({
    concurrency,
    profile,
    mode = "sse",
    phase = "explore",
    stageId,
    request,
    signal,
    onResult = () => {},
    onTick = () => {},
}) {
    return runStage({
        concurrency,
        durationMs: 0,
        minimumCount: concurrency,
        mode,
        onResult,
        onTick,
        phase,
        profile,
        request,
        signal,
        stageId,
        sustain: false,
    });
}

async function runStage({
    concurrency,
    profile,
    mode,
    phase,
    stageId,
    request,
    signal,
    onResult,
    onTick,
    sustain = false,
    durationMs = 600000,
    minimumCount = Math.max(300, concurrency * 3),
}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 300) throw new Error("invalid_concurrency");
    if (activeStage) throw new Error("overlapping_model_stages");
    activeStage = true;
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let created = 0,
        sent = 0,
        completed = 0,
        qualified = 0,
        peakCreated = 0,
        peakSent = 0;
    let serial = 0;
    const latencies = [],
        firstText = [],
        classes = {};
    const interval = setInterval(
        () =>
            onTick({
                completed,
                createdInFlight: created,
                elapsedMs: performance.now() - started,
                qualified,
                sentInFlight: sent,
                stageId,
                time: new Date().toISOString(),
            }),
        1000
    );
    async function worker(slot) {
        do {
            if (signal?.aborted) break;
            const clientId = `${stageId}-${slot}-${++serial}`;
            created++;
            peakCreated = Math.max(peakCreated, created);
            let notified = false;
            const onSent = () => {
                if (!notified) {
                    notified = true;
                    sent++;
                    peakSent = Math.max(peakSent, sent);
                }
            };
            let result;
            try {
                result = await request(clientId, onSent);
            } catch {
                result = {
                    clientId,
                    errorCode: "client_exception",
                    httpStatus: null,
                    totalMs: performance.now() - started,
                };
            }
            if (notified) sent--;
            created--;
            completed++;
            const verdict = classify(result, profile);
            if (verdict.qualified) qualified++;
            classes[verdict.classification] = (classes[verdict.classification] || 0) + 1;
            if (Number.isFinite(result.totalMs)) latencies.push(result.totalMs);
            if (Number.isFinite(result.firstTextMs)) firstText.push(result.firstTextMs);
            await onResult({ ...result, ...verdict, concurrency, mode, phase, profileId: profile.id, stageId });
            if (!sustain) break;
        } while (!signal?.aborted && (performance.now() - started < durationMs || completed < minimumCount));
    }
    try {
        const results = await Promise.allSettled(Array.from({ length: concurrency }, (_, slot) => worker(slot)));
        if (results.some(result => result.status === "rejected")) throw new Error("stage_recording_failed");
    } finally {
        clearInterval(interval);
        activeStage = false;
    }
    const elapsed = performance.now() - started;
    const p95Ms = percentile(latencies, 0.95);
    const qualifiedRate = completed ? qualified / completed : 0;
    return {
        abortReason: signal?.aborted ? String(signal.reason || "aborted") : null,
        classes,
        concurrency,
        durationMs: elapsed,
        finishedAt: new Date().toISOString(),
        firstTextP95Ms: percentile(firstText, 0.95),
        mode,
        p95Ms,
        passed:
            !signal?.aborted &&
            completed > 0 &&
            qualifiedRate >= 0.99 &&
            p95Ms !== null &&
            p95Ms <= 180000 &&
            peakSent >= concurrency &&
            (!sustain || (elapsed >= durationMs && completed >= minimumCount)),
        peakCreatedInFlight: peakCreated,
        peakSentInFlight: peakSent,
        phase,
        profileId: profile.id,
        qualifiedCount: qualified,
        qualifiedRate,
        reachedTarget: peakSent >= concurrency,
        requestCount: completed,
        stageId,
        startedAt,
    };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function records(count, seed = 1) {
    let state = seed >>> 0;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    return Array.from({ length: count }, (_, i) => {
        const revenue = 10000 + (next() % 900000),
            cost = 1000 + (next() % 50000);
        return (
            `Record ${String(i + 1).padStart(4, "0")}: The synthetic regional service team reviewed ${10 + (next() % 900)} orders. ` +
            `Revenue was ${revenue} units and operating cost was ${cost} units. The manager compared delivery schedules, ` +
            `customer feedback, inventory movements and monthly forecasts. The recommended action is to inspect capacity ` +
            `weekly, preserve clear ownership, measure delays and record the results before changing resource allocations. ` +
            `This record contains invented operational data for a performance test and no personal information.`
        );
    }).join("\n");
}

function content(profile, clientId) {
    return [{ parts: [{ text: `Independent request ${clientId}.\n` + profile.inputText }], role: "user" }];
}

async function calibrateVerbatim({ requestGemini, modelKey, outputDir, signal }) {
    const count = async text => {
        const result = await requestGemini({
            body: {
                generateContentRequest: {
                    contents: [{ parts: [{ text }], role: "user" }],
                    model: "models/gemini-3.8-flash",
                },
            },
            clientId: `count-${randomBytes(6).toString("hex")}`,
            key: modelKey,
            mode: "count",
            origin: ORIGIN,
            signal,
            timeoutMs: 600000,
        });
        const { text: ignoredText, ...safeCountResult } = result;
        fs.appendFileSync(path.join(outputDir, "token-calibration.jsonl"), JSON.stringify(safeCountResult) + "\n");
        if (result.httpStatus !== 200 || !Number.isInteger(result.countTokens)) {
            console.log(
                JSON.stringify({
                    errorCode: result.errorCode,
                    event: "count_tokens_failed",
                    httpStatus: result.httpStatus,
                    parseOk: result.parseOk,
                    providerErrorMessage: result.providerErrorMessage,
                    providerErrorStatus: result.providerErrorStatus,
                    requestId: result.requestId,
                    responseBytes: result.responseBytes,
                })
            );
            throw new Error("count_tokens_unavailable");
        }
        return result.countTokens;
    };
    const corpus = records(1800, 173);
    const blueprints = {};
    for (const outputTokens of [2000, 4000]) {
        const target = outputTokens === 2000 ? 2200 : 4000;
        let length = target * 4;
        for (let round = 0; round < 12; round++) {
            const source = corpus.slice(0, Math.max(100, Math.floor(length)));
            const newline = source.lastIndexOf("\n");
            const blueprint = source.slice(0, newline > 100 ? newline : source.length) + "\n" + MARKER;
            const actual = await count(blueprint);
            if (actual >= (outputTokens === 2000 ? 2100 : 3850) && actual <= (outputTokens === 2000 ? 2300 : 4150)) {
                blueprints[outputTokens] = { measuredTokens: actual, text: blueprint };
                break;
            }
            length *= target / actual;
        }
        if (!blueprints[outputTokens]) throw new Error("output_blueprint_calibration_failed");
    }
    const profiles = [];
    for (const profile of PROFILES) {
        const prefix =
            "This is a synthetic text transport and capacity test. Read the dataset below. Then reproduce the " +
            "REFERENCE RESPONSE verbatim, including every record, without shortening, summarizing, introduction, code fences " +
            "or additional commentary. Finish with the exact final completion marker. Do not use tools.\nDATASET:\n";
        const suffix = "\nEND DATASET\nREFERENCE RESPONSE (copy all of it):\n" + blueprints[profile.outputTokens].text;
        let length = Math.max(100, (profile.inputTokens - blueprints[profile.outputTokens].measuredTokens - 100) * 4);
        let calibrated = null;
        for (let round = 0; round < 16; round++) {
            const inputText = prefix + corpus.slice(0, Math.floor(length)) + suffix;
            const measured = await count(
                `Independent request calibration-00000000000000000000000000000000.\n${inputText}`
            );
            const target = profile.inputTokens + 48;
            if (measured >= target && measured <= profile.inputTokens * 1.005 + 48) {
                calibrated = {
                    ...profile,
                    blueprintTokens: blueprints[profile.outputTokens].measuredTokens,
                    calibratedInputTokens: measured,
                    generationConfig: { candidateCount: 1, maxOutputTokens: 8192, temperature: 0.2 },
                    inputText,
                    workload: "verbatim",
                };
                break;
            }
            length += (target - measured) * 3.6;
            length = Math.max(100, Math.min(corpus.length, length));
        }
        if (!calibrated) throw new Error(`input_calibration_failed_${profile.id}`);
        profiles.push(calibrated);
        console.log(
            JSON.stringify({
                blueprintTokens: calibrated.blueprintTokens,
                event: "profile_token_calibrated",
                inputTokens: calibrated.calibratedInputTokens,
                profileId: profile.id,
            })
        );
    }
    fs.writeFileSync(path.join(outputDir, "profiles.json"), JSON.stringify(profiles, null, 2));
    return profiles;
}

async function calibrateAnalysisInput(profile, { requestGemini, modelKey, outputDir, signal }) {
    const { buildInput, DEFAULT_CORPUS, initialWordsPerSection } = require("./workloads");
    profile.wordsPerSection ||= initialWordsPerSection(profile.outputTokens);
    let characters = profile.datasetCharacters || profile.inputTokens * 4;
    for (let round = 0; round < 16; round++) {
        const inputText = buildInput({ ...profile, datasetCharacters: Math.floor(characters) });
        const result = await requestGemini({
            body: {
                generateContentRequest: {
                    contents: [
                        {
                            parts: [
                                {
                                    text: `Independent request calibration-00000000000000000000000000000000.\n${inputText}`,
                                },
                            ],
                            role: "user",
                        },
                    ],
                    model: "models/gemini-3.8-flash",
                },
            },
            clientId: `count-analysis-${randomBytes(6).toString("hex")}`,
            key: modelKey,
            mode: "count",
            origin: ORIGIN,
            signal,
            timeoutMs: 600000,
        });
        const { text: ignoredText, ...safe } = result;
        fs.appendFileSync(path.join(outputDir, "token-calibration.jsonl"), JSON.stringify(safe) + "\n");
        if (result.httpStatus !== 200 || !Number.isInteger(result.countTokens))
            throw new Error("count_tokens_unavailable");
        const target = profile.inputTokens + 48;
        if (result.countTokens >= target && result.countTokens <= profile.inputTokens * 1.005 + 48) {
            return Object.assign(profile, {
                calibratedInputTokens: result.countTokens,
                datasetCharacters: Math.floor(characters),
                generationConfig: {
                    candidateCount: 1,
                    maxOutputTokens: profile.generationConfig?.maxOutputTokens || 8192,
                    temperature: 0.2,
                },
                inputText,
                workload: "analysis",
            });
        }
        characters = Math.max(100, Math.min(DEFAULT_CORPUS.length, characters + (target - result.countTokens) * 3.6));
    }
    throw new Error("analysis_input_calibration_failed");
}

async function calibrate(options) {
    if (options.workload === "verbatim") return calibrateVerbatim(options);
    const profiles = [];
    for (const profile of PROFILES) {
        profiles.push(await calibrateAnalysisInput({ ...profile }, options));
        console.log(
            JSON.stringify({
                event: "profile_token_calibrated",
                inputTokens: profiles.at(-1).calibratedInputTokens,
                profileId: profile.id,
                workload: "analysis",
            })
        );
    }
    fs.writeFileSync(path.join(options.outputDir, "profiles.json"), JSON.stringify(profiles, null, 2));
    return profiles;
}

async function readSecretPipe() {
    let raw = "";
    for await (const chunk of process.stdin) {
        raw += chunk.toString("utf8");
        if (raw.length > 16384) throw new Error("invalid_secret_pipe");
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("invalid_secret_pipe");
    }
    if (typeof parsed.modelKey !== "string" || typeof parsed.managementKey !== "string")
        throw new Error("invalid_secret_pipe");
    return parsed;
}

function argumentsFrom(argv) {
    const values = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw new Error("invalid_arguments");
        values[argv[i].slice(2)] = argv[i + 1];
    }
    return values;
}

async function main() {
    const args = argumentsFrom(process.argv.slice(2));
    const outputDir = path.resolve(args["output-dir"] || "artifacts/loadtest/invalid");
    const allowedRoot = path.resolve(__dirname, "../../artifacts/loadtest") + path.sep;
    if (!outputDir.startsWith(allowedRoot)) throw new Error("output_directory_outside_artifacts");
    fs.mkdirSync(outputDir, { recursive: true });
    const append = (file, record) => fs.appendFileSync(path.join(outputDir, file), JSON.stringify(record) + "\n");
    const { modelKey, managementKey } = await readSecretPipe();
    const { requestGemini, closeTransport } = require("./transport");
    const { Monitor } = require("./monitor");
    const controller = new AbortController();
    const monitor = new Monitor({
        managementKey,
        onUnsafe: reason => {
            append("events.jsonl", { event: "unsafe_environment", reason, time: new Date().toISOString() });
            controller.abort(typeof reason === "string" ? reason : "unsafe_environment");
        },
        origin: ORIGIN,
        outputDir,
    });
    const stop = reason => {
        if (!controller.signal.aborted) controller.abort(reason);
    };
    process.on("SIGINT", () => stop("operator_interrupt"));
    process.on("SIGTERM", () => stop("operator_terminate"));
    let previousDebug = null;
    const action = args.action || "full";
    const stagesPath = path.join(outputDir, "stages.jsonl");
    const existingStages = fs.existsSync(stagesPath)
        ? fs.readFileSync(stagesPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
        : [];
    const print = data => console.log(JSON.stringify(data));
    try {
        if (action === "report") {
            require("./report").buildReport(outputDir);
            return;
        }
        const initial = await monitor.snapshot("before_test");
        if (!fs.existsSync(path.join(outputDir, "baseline.json"))) {
            fs.writeFileSync(
                path.join(outputDir, "baseline.json"),
                JSON.stringify(
                    {
                        contextPolicy: "set_3_and_keep",
                        date: new Date().toISOString(),
                        initial,
                        model: "gemini-3.8-flash",
                        origin: ORIGIN,
                        slo: { p95Ms: 180000, qualifiedRate: 0.99 },
                        standardDebug: false,
                        visibilityGaps: [
                            "management API has no server CPU/RAM metrics",
                            "Zeabur runtime log API initially returned zero entries",
                            "per-account live in-flight not exposed by management API",
                        ],
                    },
                    null,
                    2
                )
            );
        }
        print({
            contexts: initial.status?.activeContextsCount,
            debugMode: initial.settings?.values?.debugMode,
            event: "preflight",
            maxContexts: initial.settings?.values?.maxContexts,
            ready: initial.readiness?.ready,
        });
        if (action === "status") return;
        if (action === "recover") {
            // Read-only follow-up after a safety stop: no generation or settings mutations.
            monitor.start();
            const recoveryStart = performance.now();
            let healthySince = initial.readiness?.ready ? recoveryStart : null;
            let recovered = false;
            while (performance.now() - recoveryStart < 600000) {
                await pause(5000);
                if (monitor.latest?.readiness?.ready === true) healthySince ??= performance.now();
                else healthySince = null;
                if (
                    performance.now() - recoveryStart >= 120000 &&
                    healthySince !== null &&
                    performance.now() - healthySince >= 60000
                ) {
                    recovered = true;
                    break;
                }
            }
            const recovery = {
                consecutiveHealthyMs: healthySince === null ? 0 : performance.now() - healthySince,
                durationMs: performance.now() - recoveryStart,
                event: "recovery_observation_finished",
                generatedRequests: 0,
                recovered,
                time: new Date().toISOString(),
            };
            append("events.jsonl", recovery);
            print(recovery);
            return;
        }
        if (initial.settings?.values?.debugMode === true && action !== "debug-wave") {
            await monitor.patchSettings({ debugMode: false });
            append("events.jsonl", { event: "standard_debug_disabled", time: new Date().toISOString() });
        }
        if (initial.settings?.values?.maxContexts !== 3) await monitor.patchSettings({ maxContexts: 3 });
        const warmStart = performance.now();
        let contextsReady = false;
        while (!contextsReady) {
            const state = await monitor.snapshot("warming", { accounts: false, settings: false });
            contextsReady = state.status?.activeContextsCount === 3 && state.readiness?.ready === true;
            if (contextsReady) break;
            if (performance.now() - warmStart > 180000) throw new Error("three_contexts_not_ready");
            await pause(5000);
        }
        monitor.start();
        let profiles;
        const profilePath = path.join(outputDir, "profiles.json");
        if (fs.existsSync(profilePath)) profiles = JSON.parse(fs.readFileSync(profilePath, "utf8"));
        else
            profiles = await calibrate({
                modelKey,
                outputDir,
                requestGemini,
                signal: controller.signal,
                workload: args.workload || "analysis",
            });
        if (args.workload && profiles.some(profile => (profile.workload || "verbatim") !== args.workload))
            throw new Error("mixed_workload_use_separate_output_directory");
        if (args.profile) profiles = profiles.filter(p => p.id === args.profile);
        for (const profile of profiles) profile.successMetric = args["success-metric"] || "response";
        if (!profiles.length) throw new Error("unknown_profile");
        // An interrupted stage can have durable request/tick records without a final stage.
        // Resume with a new identity so its unknown requests cannot join a later wave.
        let stageSerial = existingStages.length;
        for (const filename of ["stages.jsonl", "requests.jsonl", "inflight.jsonl"]) {
            const recordPath = path.join(outputDir, filename);
            if (!fs.existsSync(recordPath)) continue;
            for (const line of fs.readFileSync(recordPath, "utf8").split("\n").filter(Boolean)) {
                const serial = /-(\d+)$/.exec(JSON.parse(line).stageId || "");
                if (serial) stageSerial = Math.max(stageSerial, Number(serial[1]));
            }
        }
        const sampleCounts = {};
        const cooldownObservations = new Map();
        const recover = async profile => {
            const observation = cooldownObservations.get("gemini-3.8-flash");
            if (!observation || observation.until <= Date.now()) return;
            const waitStart = performance.now();
            print({ event: "cooldown_recovery_wait", profileId: profile.id, waitMs: observation.until - Date.now() });
            while (Date.now() < observation.until && !controller.signal.aborted)
                await pause(Math.min(5000, observation.until - Date.now()));
            append("events.jsonl", {
                basis: "observed_retry_after_or_configured_base",
                event: "cooldown_recovery_wait_finished",
                profileId: profile.id,
                time: new Date().toISOString(),
                waitedMs: performance.now() - waitStart,
            });
        };
        const stage = async (profile, concurrency, mode, phase, sustain = false, validation = {}) => {
            if (controller.signal.aborted) return null;
            if (["refine", "confirm", "sustain", "nonstream"].includes(phase)) await recover(profile);
            if (controller.signal.aborted) return null;
            const stageId = `${phase}-${profile.id}-${mode}-c${concurrency}-${String(++stageSerial).padStart(4, "0")}`;
            const before = await monitor.snapshot(`before:${stageId}`);
            if (!before.readiness?.ready) {
                const recoverStart = performance.now();
                while (
                    !monitor.latest?.readiness?.ready &&
                    performance.now() - recoverStart < 60000 &&
                    !controller.signal.aborted
                )
                    await pause(5000);
                if (!monitor.latest?.readiness?.ready) {
                    stop("readiness_not_recovered");
                    return null;
                }
            }
            print({ concurrency, event: "stage_start", mode, phase, profileId: profile.id, stageId });
            let rateLimited = 0,
                retryAfterMs = 0;
            const observedCandidateTokens = [];
            const observedThoughtTokens = [];
            const stageResult = await runStage({
                concurrency,
                mode,
                onResult: result => {
                    if (Number.isInteger(result.candidateTokens)) observedCandidateTokens.push(result.candidateTokens);
                    if (Number.isInteger(result.thoughtTokens)) observedThoughtTokens.push(result.thoughtTokens);
                    if (result.httpStatus === 429 || result.providerErrorCode === 429) {
                        rateLimited++;
                        retryAfterMs = Math.max(
                            retryAfterMs,
                            result.retryAfterMs || before.settings?.values?.accountCooldownMs || 300000
                        );
                    }
                    const { text = "", ...safe } = result;
                    safe.textBytes = Buffer.byteLength(text);
                    safe.textCharacters = text.length;
                    safe.workload = profile.workload || "verbatim";
                    safe.requestedMaxOutputTokens = profile.generationConfig.maxOutputTokens;
                    safe.wordsPerSection = profile.wordsPerSection || null;
                    append("requests.jsonl", safe);
                    const sampleKey = `${profile.id}:${result.classification}`;
                    sampleCounts[sampleKey] = (sampleCounts[sampleKey] || 0) + 1;
                    if (sampleCounts[sampleKey] <= 2)
                        append("response-samples.jsonl", { ...safe, text: text.slice(0, 64000) });
                },
                onTick: tick => {
                    append("inflight.jsonl", tick);
                    if (Math.floor(tick.elapsedMs / 1000) % 30 === 0) print({ event: "stage_progress", ...tick });
                },
                phase,
                profile,
                request: (clientId, onSent) =>
                    requestGemini({
                        body: { contents: content(profile, clientId), generationConfig: profile.generationConfig },
                        clientId,
                        key: modelKey,
                        mode,
                        onSent,
                        origin: ORIGIN,
                        signal: controller.signal,
                        timeoutMs: 600000,
                    }),
                signal: controller.signal,
                stageId,
                sustain,
            });
            stageResult.rateLimitedCount = rateLimited;
            stageResult.candidateTokensP50 = percentile(observedCandidateTokens, 0.5);
            stageResult.thoughtTokensP50 = percentile(observedThoughtTokens, 0.5);
            if (validation.capacityValidation) {
                stageResult.capacityValidation = true;
                stageResult.confirmationWave = validation.confirmationWave || null;
            }
            stageResult.cooldownRecoveryWaitMs = retryAfterMs;
            stageResult.cooldownMeasurement =
                phase === "explore" ? "cumulative_hot_state" : "recovery_wait_applied_when_observed";
            if (rateLimited)
                cooldownObservations.set("gemini-3.8-flash", { until: Date.now() + Math.min(1800000, retryAfterMs) });
            append("stages.jsonl", stageResult);
            existingStages.push(stageResult);
            print({ event: "stage_complete", ...stageResult });
            await monitor.snapshot(`after:${stageId}`);
            if (typeof monitor.collectUsage === "function") await monitor.collectUsage(`after:${stageId}`);
            require("./report").buildReport(outputDir);
            return stageResult;
        };
        if (
            (action === "calibrate" || action === "full") &&
            profiles.some(profile => profile.successMetric !== "response")
        ) {
            const persistProfile = profile => {
                const saved = JSON.parse(fs.readFileSync(profilePath, "utf8"));
                Object.assign(
                    saved.find(item => item.id === profile.id),
                    profile
                );
                fs.writeFileSync(profilePath, JSON.stringify(saved, null, 2));
            };
            for (const profile of profiles) {
                if (profile.generationCalibrated) continue;
                if (profile.workload === "analysis") {
                    await calibrateAnalysisInput(profile, {
                        modelKey,
                        outputDir,
                        requestGemini,
                        signal: controller.signal,
                    });
                    persistProfile(profile);
                }
                let centeredPasses = 0;
                for (let attempt = 0; attempt < (profile.workload === "analysis" ? 12 : 3); attempt++) {
                    const result = await stage(profile, 1, "sse", "calibration");
                    const targetTokens = profile.outputTokens === 2000 ? 2200 : 4000;
                    const centered =
                        profile.workload !== "analysis" ||
                        (result?.candidateTokensP50 >= targetTokens * 0.95 &&
                            result?.candidateTokensP50 <= targetTokens * 1.05);
                    const canConfirm = centered || centeredPasses > 0;
                    centeredPasses = result?.passed && canConfirm ? centeredPasses + 1 : 0;
                    if (result?.passed && (profile.workload !== "analysis" || centeredPasses >= 3)) {
                        profile.generationCalibrated = true;
                        persistProfile(profile);
                        break;
                    }
                    if (controller.signal.aborted) break;
                    append("events.jsonl", {
                        classes: result?.classes,
                        event: result?.passed
                            ? "generation_calibration_pending_confirmation"
                            : "generation_calibration_failed",
                        profileId: profile.id,
                        time: new Date().toISOString(),
                    });
                    if (profile.workload === "analysis" && canConfirm && result?.passed) continue;
                    if (
                        profile.workload === "analysis" &&
                        result?.classes?.output_truncated &&
                        result.thoughtTokensP50 > 0
                    ) {
                        const previousBudget = profile.generationConfig.maxOutputTokens;
                        profile.generationConfig.maxOutputTokens = Math.min(32768, previousBudget * 2);
                        append("events.jsonl", {
                            event: "thought_budget_adjusted",
                            maxOutputTokens: profile.generationConfig.maxOutputTokens,
                            previousBudget,
                            profileId: profile.id,
                            time: new Date().toISOString(),
                        });
                        persistProfile(profile);
                        continue;
                    }
                    if (profile.workload === "analysis" && Number.isInteger(result?.candidateTokensP50)) {
                        const { adjustWordsPerSection } = require("./workloads");
                        profile.wordsPerSection = adjustWordsPerSection({
                            observedTokens: result.candidateTokensP50,
                            previousWords: profile.wordsPerSection,
                            targetTokens,
                        });
                        await calibrateAnalysisInput(profile, {
                            modelKey,
                            outputDir,
                            requestGemini,
                            signal: controller.signal,
                        });
                        persistProfile(profile);
                    }
                }
                if (!profile.generationCalibrated) throw new Error(`generation_calibration_failed_${profile.id}`);
            }
            const allProfiles = JSON.parse(fs.readFileSync(profilePath, "utf8"));
            for (const calibrated of profiles)
                Object.assign(
                    allProfiles.find(p => p.id === calibrated.id),
                    calibrated
                );
            fs.writeFileSync(profilePath, JSON.stringify(allProfiles, null, 2));
            if (action === "calibrate") return;
        }
        if (["wave", "sustain", "debug-wave"].includes(action)) {
            if (action === "debug-wave") {
                previousDebug = initial.settings?.values?.debugMode === true;
                await monitor.patchSettings({ debugMode: true });
            }
            await stage(
                profiles[0],
                Number(args.concurrency || 1),
                args.mode || "sse",
                action === "debug-wave" ? "debug" : action,
                action === "sustain"
            );
            return;
        }
        if (["full", "explore"].includes(action)) {
            for (const profile of profiles) {
                for (const concurrency of LADDER) {
                    if (
                        existingStages.some(
                            s =>
                                s.profileId === profile.id &&
                                s.mode === "sse" &&
                                s.phase === "explore" &&
                                s.concurrency === concurrency
                        )
                    )
                        continue;
                    if (!(await stage(profile, concurrency, "sse", "explore"))) break;
                }
                if (controller.signal.aborted) break;
            }
            if (action === "explore") return;
        }
        const { validateCapacity } = require("./capacity");
        for (const profile of profiles) {
            if (controller.signal.aborted) break;
            if (!profile.generationCalibrated && profile.successMetric !== "response")
                throw new Error("profile_generation_not_calibrated");
            const validate = async (mode, candidateConcurrencies) => {
                const result = await validateCapacity({
                    candidateConcurrencies,
                    existingStages,
                    isAborted: () => controller.signal.aborted,
                    mode,
                    profile,
                    runStage: options =>
                        stage(profile, options.concurrency, mode, options.phase, options.sustain, options),
                });
                const { newStages, ...safe } = result;
                append("capacity-validation.jsonl", { ...safe, time: new Date().toISOString() });
                if (result.status === "incomplete" && !controller.signal.aborted)
                    throw new Error("capacity_validation_incomplete");
                return result;
            };
            const streaming = await validate("sse");
            if (controller.signal.aborted) break;
            await validate("json", [1, streaming.stableConcurrency || 1, streaming.nextFailure || 300, 300]);
        }
    } finally {
        if (previousDebug !== null) {
            try {
                await monitor.patchSettings({ debugMode: previousDebug });
            } catch {
                append("events.jsonl", { event: "debug_restore_failed", time: new Date().toISOString() });
            }
        }
        await monitor.stop();
        await monitor.snapshot("test_finished").catch(() => {});
        append("events.jsonl", {
            abortReason: controller.signal.aborted ? String(controller.signal.reason) : null,
            action,
            event: "runner_finished",
            time: new Date().toISOString(),
        });
        try {
            require("./report").buildReport(outputDir);
        } catch {
            /* Raw records remain available. */
        }
        closeTransport();
        if (controller.signal.aborted) process.exitCode = 2;
    }
}

module.exports = { classify, LADDER, percentile, PROFILES, runStage, runWave };
if (require.main === module)
    main().catch(error => {
        const safeCode = /^[a-z0-9_-]{1,128}$/.test(error.message || "") ? error.message : "loadtest_failed";
        console.error(JSON.stringify({ code: safeCode, event: "runner_error" }));
        process.exitCode = 1;
    });
