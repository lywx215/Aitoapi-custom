const number = v => (Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : null);
const count = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const metric = (value, source) => ({
    present: count(value) !== null,
    source: count(value) === null ? "unknown" : source,
    value: count(value),
});
const protocol = format =>
    ({ claude: "claude", gemini: "gemini", openai: "openai_chat", response_api: "openai_responses" })[format] ||
    "unknown";

function timing(measurements = {}) {
    return Object.fromEntries([
        ...[
            "firstUpstreamByteMs",
            "firstEffectiveOutputMs",
            "responseCommitMs",
            "firstDownstreamEffectiveOutputMs",
        ].map(key => [key, number(measurements[key])]),
        ["timingSource", "server_monotonic"],
    ]);
}

function aito({
    legacy,
    allocatedLogSeq,
    localFinishObserved,
    localCancelObserved,
    localFailureObserved,
    monotonicMeasurements,
}) {
    return {
        attemptId: legacy.attemptId ?? legacy.request_attempt_id ?? null,
        deliveryState: localFinishObserved
            ? "local_finished"
            : localCancelObserved
              ? "cancelled"
              : localFailureObserved
                ? "failed"
                : "unknown",
        droppedForSpan: null,
        legacyPreserved: { ...legacy },
        logSeq: allocatedLogSeq,
        requestId: legacy.requestId ?? legacy.request_id ?? null,
        sinkDroppedTotal: legacy.logsDropped ?? null,
        timing: timing(monotonicMeasurements),
    };
}

function usage(rawUsage, wireProtocol = "gemini", source = "upstream") {
    const fields = {
        claude: ["input_tokens", "output_tokens"],
        gemini: [
            "promptTokenCount",
            "candidatesTokenCount",
            "thoughtsTokenCount",
            "totalTokenCount",
            "cachedContentTokenCount",
        ],
        openai_chat: ["prompt_tokens", "completion_tokens", "total_tokens", "reasoning_tokens"],
        openai_responses: ["input_tokens", "output_tokens", "total_tokens", "reasoning_tokens"],
        unknown: [],
    };
    const raw = {};
    for (const key of fields[wireProtocol])
        if (rawUsage && Object.hasOwn(rawUsage, key)) raw[key] = count(rawUsage[key]);
    // Gemini totalTokenCount includes input; it is not normalized outputTotal.
    return {
        basis: Object.keys(raw).length ? (source === "converted" ? "converted" : "provider_cumulative") : "unknown",
        candidate: metric(raw.candidatesTokenCount, source),
        input: metric(raw.promptTokenCount ?? raw.prompt_tokens ?? raw.input_tokens, source),
        outputTotal: metric(raw.completion_tokens ?? raw.output_tokens, source),
        protocol: wireProtocol,
        raw,
        reasoning: metric(raw.thoughtsTokenCount ?? raw.reasoning_tokens, source),
        // This producer's OpenAI usage comes from FormatConverter._parseUsage:
        // completion/output = candidatesTokenCount + thoughtsTokenCount (87 + 13 = 100).
        // The flag does not authorize this inference for arbitrary remote OpenAI providers.
        reasoningIncludedInOutput:
            wireProtocol.startsWith("openai_") && count(raw.completion_tokens ?? raw.output_tokens) !== null
                ? true
                : null,
    };
}

function output(summary = {}, bytes = {}) {
    return {
        candidateCount: count(summary.candidateCount),
        mediaParts: count(summary.mediaParts),
        ordinaryTextNonWhitespaceChars: count(summary.ordinaryTextNonWhitespaceChars),
        ordinaryTextUtf8Bytes: count(bytes.ordinaryTextUtf8Bytes),
        thoughtUtf8Bytes: count(bytes.thoughtUtf8Bytes),
        validToolCalls: count(summary.validToolCalls),
    };
}

function resultClass(value) {
    return value === "aborted"
        ? "cancelled"
        : ["success", "blocked", "empty", "incomplete", "error", "cancelled"].includes(value)
          ? value
          : "unknown";
}

function failure(fields) {
    const result = resultClass(fields.resultClass);
    const code = fields.errorCode;
    if (result === "success")
        return { errorClass: "none", failureOrigin: "none", failureStage: "none", resultClass: result };
    let errorClass = ["blocked", "empty", "incomplete", "cancelled"].includes(result) ? result : "other";
    let failureOrigin = "unknown",
        failureStage = "unknown";
    if (result === "cancelled") {
        failureOrigin = "client";
        failureStage = "delivery";
    } else if (["blocked", "empty", "incomplete"].includes(result)) {
        failureOrigin = "upstream";
        failureStage = "read";
    }
    if (["invalid_utf8", "invalid_upstream_response", "invalid_tool_call", "invalid_media"].includes(code)) {
        errorClass = "parse_error";
        failureStage = "parse";
        failureOrigin = "upstream";
    }
    if (["transport_error", "not_dispatched"].includes(code)) {
        errorClass = "transport_error";
        failureOrigin = "browser";
        failureStage = "dispatch";
    }
    if (code === "resource_exhausted") {
        errorClass = "resource_exhausted_unknown";
        failureOrigin = "local";
    }
    if (code === "upstream_http_error") {
        failureOrigin = "upstream";
        failureStage = "read";
        if (fields.upstreamStatus === 429) errorClass = "resource_exhausted_unknown";
    }
    return { errorClass, failureOrigin, failureStage, resultClass: result };
}

module.exports = { aito, count, failure, number, output, protocol, resultClass, timing, usage };
