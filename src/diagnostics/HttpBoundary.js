const Headers = require("./Headers");
const Peers = require("./Peers");

const pairs = headers =>
    Object.entries(headers || {}).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).map(v => [key, v])
    );

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
    if (!call) return createRequest(options, callback);
    const prepared = Headers.outgoing({
        allowed: Boolean(peer),
        callSpanId: call.identity.spanId,
        diagnosticOwned: inherited?.diagnosticOwned || false,
        flags: span.context.outputFlags,
        headers,
        requestId: span.identity.requestId,
        traceId: span.identity.traceId,
        tracestate: span.context.tracestate,
    });
    let client;
    try {
        client = createRequest({ ...options, headers: prepared.headers }, response => {
            call.upstreamStatus = response.statusCode;
            call.peerIds = Headers.peerResponse({ headers: Headers.fields(response), peerConfigured: Boolean(peer) });
            response.once("end", () => call.finish("eof"));
            response.once("aborted", () => call.finish("closed_early"));
            response.once("error", () => call.finish("read_error"));
            response.once("close", () => call.finish(response.readableEnded ? "eof" : "closed_early"));
            callback?.(response);
        });
        client.once("error", () => call.finish(options.signal?.aborted ? "cancelled" : "transport_error"));
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
    return Headers.outgoing({ allowed: false, diagnosticOwned: owned.diagnosticOwned, headers: pairs(owned.headers) });
}

module.exports = { pairs, redirectCopy, request };
