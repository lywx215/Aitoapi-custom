const { randomBytes } = require("crypto");

const randomId = bytes => randomBytes(bytes).toString("hex");
const values = (headers, name) => headers.filter(([key]) => key.toLowerCase() === name).map(([, v]) => v);
const isDiagnostic = name => /^(traceparent|tracestate)$|^x-diag-/i.test(name);
const validId = value => typeof value === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(value) && !/[\r\n]/.test(value);

function fields(message) {
    // rawHeaders is the HTTP parser's per-field output, not raw socket bytes.
    if (Array.isArray(message.rawHeaders)) {
        const pairs = [];
        for (let i = 0; i < message.rawHeaders.length; i += 2)
            pairs.push([message.rawHeaders[i], message.rawHeaders[i + 1]]);
        return pairs;
    }
    return Object.entries(message.headersDistinct || {}).flatMap(([k, vs]) => vs.map(v => [k, v]));
}

function customId(list, trace = false) {
    if (!list.length) return { rejected: "none", value: null };
    if (list.length !== 1) return { rejected: "duplicate", value: null };
    const value = list[0];
    if (value.includes(",")) return { rejected: "duplicate", value: null };
    if (Buffer.byteLength(value) > 128) return { rejected: "too_long", value: null };
    if (!validId(value) || (trace && (!/^[0-9a-f]{32}$/.test(value) || /^0+$/.test(value))))
        return { rejected: "invalid", value: null };
    return { rejected: "none", value };
}

function state(list) {
    const joined = list.join(",");
    if (Buffer.byteLength(joined) > 512 || /[^\x20-\x7e\t]/.test(joined)) return null;
    const members = joined
        .split(",")
        .map(v => v.replace(/^[ \t]+|[ \t]+$/g, ""))
        .filter(Boolean);
    if (!members.length || members.length > 32) return null;
    const keys = new Set();
    for (const member of members) {
        const [key, value, extra] = member.split("=");
        if (extra !== undefined || !value || value.length > 256 || /[^\x20-\x7e]|[,=]/.test(value)) return null;
        if (!/^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/.test(key))
            return null;
        if (keys.has(key)) return null;
        keys.add(key);
    }
    return members.join(",");
}

function extract({ headers = [], authenticated = false, configuredInboundAdapter = false }) {
    const parents = values(headers, "traceparent");
    const value = parents[0] || "";
    const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})/.exec(value);
    const accepted =
        parents.length === 1 &&
        value.length <= 512 &&
        !/[^\x20-\x7e]|,/.test(value) &&
        match &&
        match[1] !== "ff" &&
        !/^0+$/.test(match[2]) &&
        !/^0+$/.test(match[3]) &&
        (match[1] === "00" ? value.length === 55 : value.length === 55 || value[55] === "-");
    const result = {
        callerHeader: null,
        callerRequestId: null,
        callerTrust: "none",
        contextSource: accepted ? "accepted" : parents.length ? "invalid_replaced" : "generated",
        outputFlags: accepted && parseInt(match[4], 16) & 1 ? "01" : "00",
        parentSpanId: accepted ? match[3] : null,
        rejected: "none",
        traceId: accepted ? match[2] : randomId(16),
        tracestate: accepted ? state(values(headers, "tracestate")) : null,
    };
    const names = authenticated && configuredInboundAdapter ? ["x-diag-request-id", "x-request-id"] : ["x-request-id"];
    for (const name of names) {
        const id = customId(values(headers, name));
        if (result.rejected === "none") result.rejected = id.rejected;
        if (id.value !== null) {
            result.callerRequestId = id.value;
            result.callerHeader = name;
            result.callerTrust =
                name === "x-diag-request-id" ? "configured_peer" : authenticated ? "authenticated" : "unverified";
            break;
        }
    }
    return result;
}

function filterCopied(headers) {
    return headers.filter(([name]) => !isDiagnostic(name));
}

function copiedObject(headers) {
    return Object.fromEntries(filterCopied(Object.entries(headers || {})));
}

function outgoing({
    headers,
    allowed,
    diagnosticOwned = false,
    response = false,
    requestId,
    traceId,
    callSpanId,
    flags,
    tracestate,
    preserveCase = false,
}) {
    const output = Object.create(null);
    for (const [name, value] of headers) {
        const key = name.toLowerCase();
        if (key.startsWith("x-diag-")) continue;
        if (!response && (allowed || diagnosticOwned) && /^(traceparent|tracestate)$/.test(key)) continue;
        (output[preserveCase ? name : key] ||= []).push(value);
    }
    if (response) {
        output["x-diag-request-id"] = [requestId];
        output["x-diag-trace-id"] = [traceId];
    } else if (allowed) {
        output.traceparent = [`00-${traceId}-${callSpanId}-${flags}`];
        if (tracestate) output.tracestate = [tracestate];
        output["x-diag-request-id"] = [requestId];
    }
    return { diagnosticOwned: !response && Boolean(allowed), headers: { ...output } };
}

function peerResponse({ headers, peerConfigured }) {
    if (!peerConfigured) return { peerIdRejected: "none", peerRequestId: null, peerTraceId: null };
    const request = customId(values(headers, "x-diag-request-id"));
    const trace = customId(values(headers, "x-diag-trace-id"), true);
    return {
        peerIdRejected: request.rejected !== "none" ? request.rejected : trace.rejected,
        peerRequestId: request.value,
        peerTraceId: trace.value,
    };
}

module.exports = { copiedObject, customId, extract, fields, filterCopied, outgoing, peerResponse, randomId, validId };
