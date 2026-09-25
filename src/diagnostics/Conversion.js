const { usage, protocol } = require("./Projection");
const observers = new WeakMap();
function register(state, span, format) {
    if (!span?.debugActive) return;
    const observation = { protocol: protocol(format), span, value: null };
    observers.set(state, observation);
    return observation;
}
function observe(state, value) {
    const observation = observers.get(state);
    if (!observation?.span.debugActive) return;
    // Only the numeric allowlist is retained, never the converter's response object.
    const raw = usage(value, observation.protocol, "converted").raw;
    const reasoning =
        value?.completion_tokens_details?.reasoning_tokens ?? value?.output_tokens_details?.reasoning_tokens;
    if (observation.protocol.startsWith("openai_") && Number.isSafeInteger(reasoning) && reasoning >= 0)
        raw.reasoning_tokens = reasoning;
    observation.value = { ...observation.value, ...raw };
}
module.exports = { observe, register };
