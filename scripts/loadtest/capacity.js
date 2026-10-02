"use strict";

/** Replayable boundary validation. This module never sends model or management requests. */
const MAX_CONCURRENCY = 300;
const QUALIFIED_RATE = 0.99;
const P95_MS = 180000;
const SUSTAIN_MS = 600000;

function completeWave(stage) {
    return (
        Number.isSafeInteger(stage?.concurrency) &&
        stage.concurrency > 0 &&
        stage.concurrency <= MAX_CONCURRENCY &&
        Number.isSafeInteger(stage.requestCount) &&
        stage.requestCount >= stage.concurrency &&
        Number.isFinite(stage.qualifiedRate) &&
        stage.qualifiedRate >= 0 &&
        stage.qualifiedRate <= 1 &&
        Number.isFinite(stage.p95Ms) &&
        stage.p95Ms >= 0 &&
        !stage.abortReason
    );
}

function passedWave(stage) {
    return (
        completeWave(stage) &&
        stage.passed === true &&
        stage.qualifiedRate >= QUALIFIED_RATE &&
        stage.p95Ms <= P95_MS &&
        stage.peakSentInFlight >= stage.concurrency
    );
}

function completeSustain(stage) {
    return (
        stage?.phase === "sustain" &&
        completeWave(stage) &&
        Number.isFinite(stage.durationMs) &&
        stage.durationMs >= SUSTAIN_MS &&
        stage.requestCount >= Math.max(300, 3 * stage.concurrency)
    );
}

function passedSustain(stage) {
    return completeSustain(stage) && passedWave(stage);
}

/**
 * runStage({ profile, mode, concurrency, phase, sustain, capacityValidation, confirmationWave })
 * must drain a single stage and return its real statistics. Call only after another runner exits.
 * existingStages must come from the same deployment, settings and workload as this validation.
 */
async function validateCapacity({
    profile,
    mode = "sse",
    existingStages = [],
    runStage,
    isAborted = () => false,
    candidateConcurrencies,
    maxNewStages = 48,
    precision = 5,
}) {
    if (
        !profile ||
        typeof profile.id !== "string" ||
        !["sse", "json"].includes(mode) ||
        !Array.isArray(existingStages) ||
        typeof runStage !== "function" ||
        typeof isAborted !== "function" ||
        !Number.isSafeInteger(maxNewStages) ||
        maxNewStages < 1 ||
        !Number.isSafeInteger(precision) ||
        precision < 1 ||
        precision > 5
    ) {
        throw new Error("invalid_capacity_options");
    }
    if (
        candidateConcurrencies !== undefined &&
        (!Array.isArray(candidateConcurrencies) ||
            candidateConcurrencies.some(value => !Number.isSafeInteger(value) || value < 1 || value > MAX_CONCURRENCY))
    ) {
        throw new Error("invalid_capacity_candidates");
    }
    const history = existingStages.filter(stage => stage.profileId === profile.id && stage.mode === mode);
    const originalStageIds = new Set(history.map(stage => stage.stageId).filter(Boolean));
    const newStages = [];
    const evaluated = new Set();
    const failed = new Set();
    let stopped = null;
    let stable = Math.max(0, ...history.filter(passedSustain).map(stage => stage.concurrency));

    function confirmations(concurrency) {
        return history.filter(
            stage =>
                stage.concurrency === concurrency && ["confirm", "refine"].includes(stage.phase) && completeWave(stage)
        );
    }

    for (const concurrency of new Set(history.map(stage => stage.concurrency))) {
        const records = confirmations(concurrency).slice(-3);
        if (
            (records.length === 3 && !records.every(passedWave)) ||
            history.some(stage => stage.concurrency === concurrency && completeSustain(stage) && !passedSustain(stage))
        ) {
            failed.add(concurrency);
        }
    }

    async function execute(concurrency, phase, confirmationWave) {
        if (isAborted()) {
            stopped = "aborted";
            return null;
        }
        if (newStages.length >= maxNewStages) {
            stopped = "stage_budget_exhausted";
            return null;
        }
        let result;
        try {
            result = await runStage({
                capacityValidation: true,
                concurrency,
                confirmationWave,
                mode,
                phase,
                profile,
                sustain: phase === "sustain",
            });
        } catch {
            stopped = "run_stage_failed";
            return null;
        }
        if (
            !result ||
            result.profileId !== profile.id ||
            result.mode !== mode ||
            result.concurrency !== concurrency ||
            result.phase !== phase
        ) {
            stopped = isAborted() ? "aborted" : "invalid_stage_result";
            return null;
        }
        history.push(result);
        newStages.push(result);
        if (isAborted() || result.abortReason) {
            stopped = "aborted";
            return null;
        }
        if (!completeWave(result) || (phase === "sustain" && !completeSustain(result))) {
            stopped = "incomplete_stage_evidence";
            return null;
        }
        return result;
    }

    async function assess(concurrency) {
        if (stopped || isAborted()) {
            stopped ||= "aborted";
            return;
        }
        evaluated.add(concurrency);
        if (history.some(stage => stage.concurrency === concurrency && passedSustain(stage))) {
            stable = Math.max(stable, concurrency);
            return;
        }
        if (failed.has(concurrency)) return;
        const previous = confirmations(concurrency);
        const confirmed = previous.slice(-3);
        while (confirmed.length < 3) {
            const result = await execute(concurrency, "confirm", confirmed.length + 1);
            if (!result) return;
            confirmed.push(result);
        }
        if (!confirmed.every(passedWave)) {
            failed.add(concurrency);
            return;
        }
        const result = await execute(concurrency, "sustain");
        if (!result) return;
        if (passedSustain(result)) stable = Math.max(stable, concurrency);
        else failed.add(concurrency);
    }

    const exploration = history
        .filter(stage => ["explore", "nonstream", "wave"].includes(stage.phase) && completeWave(stage))
        .sort((a, b) => a.concurrency - b.concurrency);
    const exploredPasses = exploration.filter(passedWave).map(stage => stage.concurrency);
    // A failed lower wave cannot discard an observed pass at a higher concurrency.
    // Validate every observed pass before using failed waves to bound refinement.
    const candidates =
        candidateConcurrencies === undefined
            ? [...new Set(exploredPasses.length ? exploredPasses : [stable || 1])].sort((a, b) => b - a)
            : [...new Set([...candidateConcurrencies, ...exploredPasses])].sort((a, b) => a - b);
    for (const concurrency of candidates) {
        if (stopped) break;
        await assess(concurrency);
    }

    // Retain lower failures as nonmonotonic evidence. Only failures above the highest
    // sustained pass bound refinement; explicit validation can recover an explored failure.
    for (const stage of exploration) {
        if (!passedWave(stage) && !evaluated.has(stage.concurrency)) failed.add(stage.concurrency);
    }
    function upperBound() {
        return Math.min(MAX_CONCURRENCY + 1, ...[...failed].filter(concurrency => concurrency > stable));
    }
    if (
        !stopped &&
        upperBound() === MAX_CONCURRENCY + 1 &&
        stable < MAX_CONCURRENCY &&
        !evaluated.has(MAX_CONCURRENCY)
    ) {
        await assess(MAX_CONCURRENCY);
    }
    while (!stopped && stable < MAX_CONCURRENCY) {
        const upper = upperBound();
        if (upper - stable <= precision && stable > 0) break;
        if (stable === 0 && upper <= 1) break;
        const candidate = Math.max(1, Math.floor((stable + upper) / 2));
        if (evaluated.has(candidate)) {
            stopped = "unresolved_nonmonotonic_evidence";
            break;
        }
        await assess(candidate);
    }
    const upper = upperBound();
    const reused = history.filter(stage => passedSustain(stage) && originalStageIds.has(stage.stageId));
    return {
        aborted: stopped === "aborted",
        evaluatedConcurrencies: [...evaluated].sort((a, b) => a - b),
        failedConcurrencies: [...failed].sort((a, b) => a - b),
        mode,
        newStages,
        nextFailure: upper <= MAX_CONCURRENCY ? upper : null,
        nonMonotonicEvidence: [...failed].filter(concurrency => concurrency <= stable).sort((a, b) => a - b),
        precision,
        profileId: profile.id,
        reusedSustainedStageIds: reused.map(stage => stage.stageId),
        stableConcurrency: stable || null,
        status: stopped ? "incomplete" : stable ? "verified" : "no_stable_capacity",
        stopReason: stopped,
        upperBoundExclusive: upper,
        verifiedTo300: stable === MAX_CONCURRENCY,
    };
}

module.exports = { completeSustain, passedSustain, passedWave, validateCapacity };
