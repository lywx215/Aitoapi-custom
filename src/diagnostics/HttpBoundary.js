const Headers = require("./Headers");
const Peers = require("./Peers");
const { errorMonitor } = require("node:events");

const pairs = headers => {
    if (Array.isArray(headers)) {
        if (headers.every(entry => Array.isArray(entry) && entry.length === 2)) return headers;
        if (headers.length % 2 || headers.some(Array.isArray)) throw new TypeError("Invalid native header pairs");
        return Array.from({ length: headers.length / 2 }, (_, i) => [headers[i * 2], headers[i * 2 + 1]]);
    }
    return Object.entries(headers || {}).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).map(v => [key, v])
    );
};

// Explicit adapter for a native ClientRequest at its final, synchronous send boundary.
// The owner supplies already-normalized options and the existing transport function.
// No global hooks, redirect policy, timers, body reads, retries or network calls are added.
function request(span, createRequest, options, callback, { attempt = {}, callKind = "model", inherited = null } = {}) {
    const headers = pairs(options.headers);
    const hostname = options.hostname || options.host || "localhost";
    const authority = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
    const port = options.port ?? options.defaultPort ?? options.agent?.defaultPort;
    const target = `${options.protocol}//${authority}${port ? `:${port}` : ""}${options.path || "/"}`;
    // Ambiguous transport options have no propagation permission. In particular,
    // do not guess http when a caller supplies https.request without a protocol.
    const peer =
        !options.socketPath && !options.createConnection && ["http:", "https:"].includes(options.protocol)
            ? Peers.match(span.diagnostics.peers, target)
            : null;
    const call = span.startCall(attempt, callKind, peer);
    const prepared = Headers.outgoing({
        allowed: Boolean(call && peer),
        callSpanId: call?.identity.spanId,
        diagnosticOwned: inherited?.diagnosticOwned || false,
        flags: span.context.outputFlags,
        headers,
        preserveCase: true,
        requestId: span.identity.requestId,
        traceId: span.identity.traceId,
        tracestate: span.context.tracestate,
    });
    const sendOptions = {
        ...options,
        headers: Array.isArray(options.headers) ? pairs(prepared.headers).flat() : prepared.headers,
    };
    if (!call) {
        const client = createRequest(sendOptions, callback);
        ownership.set(client, prepared);
        return client;
    }
    let client;
    try {
        client = createRequest(sendOptions, response => {
            call.upstreamStatus = response.statusCode;
            call.peerIds = Headers.peerResponse({ headers: Headers.fields(response), peerConfigured: Boolean(peer) });
            response.once("end", () => call.finish("eof"));
            response.once("aborted", () => call.finish("closed_early"));
            response.once(errorMonitor, () => call.finish("read_error"));
            response.once("close", () => call.finish(response.readableEnded ? "eof" : "closed_early"));
            callback?.(response);
        });
        client.once(errorMonitor, () => call.finish(options.signal?.aborted ? "cancelled" : "transport_error"));
        client.once("abort", () => call.finish("cancelled"));
        client.once("close", () => {
            if (!client.res) call.finish(options.signal?.aborted ? "cancelled" : "transport_error");
        });
        ownership.set(client, prepared);
        return client;
    } catch (error) {
        call.finish("transport_error");
        throw error;
    }
}

const ownership = new WeakMap();
function redirectCopy(client) {
    const owned = ownership.get(client);
    if (!owned) return { diagnosticOwned: false, headers: {} };
    // Clean before the existing caller constructs new-hop business headers.
    return Headers.outgoing({
        allowed: false,
        diagnosticOwned: owned.diagnosticOwned,
        headers: pairs(owned.headers),
        preserveCase: true,
    });
}

module.exports = { pairs, redirectCopy, request };
