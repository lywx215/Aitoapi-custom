"use strict";

const http = require("node:http");
const https = require("node:https");
const { performance } = require("node:perf_hooks");
const { StringDecoder } = require("node:string_decoder");

const PRODUCTION_ORIGIN = "https://aib.zeabur.app";
const MODEL = "gemini-3.8-flash";
const httpsAgent = new https.Agent({ keepAlive: true, maxFreeSockets: 300, maxSockets: 330, maxTotalSockets: 330 });
const fixtureAgent = new http.Agent({ keepAlive: true, maxFreeSockets: 300, maxSockets: 330, maxTotalSockets: 330 });

function permittedOrigin(origin, allowFixture) {
    const url = new URL(origin);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
        throw new Error("invalid_origin");
    if (url.origin === PRODUCTION_ORIGIN) return url;
    if (allowFixture && url.protocol === "http:" && url.hostname === "127.0.0.1") return url;
    throw new Error("invalid_origin");
}

function safeCallback(callback, value) {
    if (typeof callback !== "function") return;
    try {
        callback(value);
    } catch {
        // Observation callbacks must not interrupt an in-flight request.
    }
}

/** Native Gemini transport. Keys stay in memory and are never included in results. */
async function requestGemini({
    origin = PRODUCTION_ORIGIN,
    key,
    body,
    mode = "sse",
    timeoutMs = 600000,
    clientId,
    signal,
    onSent,
    onEvent,
    allowFixture = false,
}) {
    const started = performance.now();
    const result = {
        bodyBytes: 0,
        cachedTokens: null,
        candidateTokens: null,
        clientId: clientId || null,
        connectMs: null,
        eof: false,
        errorCode: null,
        eventCount: 0,
        finishedAt: null,
        finishReason: null,
        firstTextMs: null,
        httpStatus: null,
        maxChunkGapMs: 0,
        modelVersion: null,
        parseOk: true,
        promptTokens: null,
        providerErrorMessage: null,
        providerErrorStatus: null,
        queueMs: null,
        requestId: null,
        requestIdSource: null,
        responseBytes: 0,
        responseId: null,
        retryAfterMs: null,
        sent: false,
        startedAt: new Date().toISOString(),
        streamError: false,
        text: "",
        thoughtTokens: null,
        tlsMs: null,
        totalMs: null,
        totalTokens: null,
        ttfbMs: null,
        uploadMs: null,
    };
    let url;
    let payload;
    try {
        url = permittedOrigin(origin, allowFixture);
        if (!["sse", "json", "count"].includes(mode)) throw new Error("invalid_request");
        if (!(timeoutMs > 0 && Number.isFinite(timeoutMs))) throw new Error("invalid_request");
        if (url.protocol === "https:" && (typeof key !== "string" || !key)) throw new Error("invalid_request");
        payload = Buffer.from(JSON.stringify(body));
        result.bodyBytes = payload.length;
    } catch (error) {
        result.errorCode = error.message === "invalid_origin" ? "invalid_origin" : "invalid_request";
        result.parseOk = false;
        result.finishedAt = new Date().toISOString();
        result.totalMs = performance.now() - started;
        return result;
    }
    if (signal?.aborted) {
        result.errorCode = "aborted";
        result.parseOk = false;
        result.finishedAt = new Date().toISOString();
        result.totalMs = performance.now() - started;
        return result;
    }

    return new Promise(resolve => {
        let settled = false;
        let request;
        let response;
        let timer = null;
        let socketAt = null;
        let connectedAt = null;
        let uploadStartedAt = null;
        let lastChunkAt = null;
        let responseText = "";
        let lineBuffer = "";
        let dataLines = [];
        const decoder = new StringDecoder("utf8");
        const socketListeners = [];
        const nowMs = () => performance.now() - started;
        const networkFailure = error => {
            if (settled) return;
            const permitted = new Set([
                "ECONNRESET",
                "ECONNREFUSED",
                "ETIMEDOUT",
                "ENOTFOUND",
                "EAI_AGAIN",
                "EHOSTUNREACH",
                "ENETUNREACH",
                "ENOBUFS",
                "EADDRNOTAVAIL",
                "EPIPE",
                "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
                "ERR_TLS_CERT_ALTNAME_INVALID",
                "CERT_HAS_EXPIRED",
                "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            ]);
            result.networkErrorCode = permitted.has(error?.code) ? error.code : "OTHER_NETWORK_ERROR";
            result.networkErrorPhase =
                result.ttfbMs !== null
                    ? "response"
                    : result.sent
                      ? "awaiting_headers"
                      : result.tlsMs !== null
                        ? "upload"
                        : connectedAt !== null
                          ? "tls"
                          : "connect";
            finish("network_error");
        };

        function finish(errorCode) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            for (const [socket, event, handler] of socketListeners) socket.removeListener(event, handler);
            if (errorCode) result.errorCode = errorCode;
            result.totalMs = nowMs();
            result.finishedAt = new Date().toISOString();
            if (result.eventCount === 0) result.parseOk = false;
            resolve(result);
        }

        function abort() {
            finish("aborted");
            response?.destroy();
            request?.destroy();
        }

        function applyPacket(packet) {
            if (Array.isArray(packet)) {
                for (const entry of packet) applyPacket(entry);
                return;
            }
            if (!packet || typeof packet !== "object") {
                result.parseOk = false;
                result.errorCode ||= "invalid_json";
                return;
            }
            result.eventCount++;
            const shape = {
                candidates: Array.isArray(packet.candidates)
                    ? packet.candidates.map(candidate => ({
                          finishReason:
                              typeof candidate?.finishReason === "string" &&
                              /^[A-Z_]{1,64}$/.test(candidate.finishReason)
                                  ? candidate.finishReason
                                  : null,
                          index: Number.isSafeInteger(candidate?.index) ? candidate.index : null,
                          parts: Array.isArray(candidate?.content?.parts)
                              ? candidate.content.parts.map(part => ({
                                    textCharacters: typeof part?.text === "string" ? part.text.length : 0,
                                    thoughtType: typeof part?.thought,
                                    thoughtValue:
                                        typeof part?.thought === "boolean"
                                            ? part.thought
                                            : ["true", "false", 0, 1].includes(part?.thought)
                                              ? part.thought
                                              : null,
                                    types: Object.keys(part || {}).filter(type => /^[a-zA-Z]{1,48}$/.test(type)),
                                }))
                              : [],
                      }))
                    : [],
                eventIndex: result.eventCount,
                hasError: Boolean(packet.error),
            };
            result.firstEventShapes ||= [];
            result.lastEventShapes ||= [];
            if (result.firstEventShapes.length < 4) result.firstEventShapes.push(shape);
            result.lastEventShapes.push(shape);
            if (result.lastEventShapes.length > 8) result.lastEventShapes.shift();
            if (packet.error) {
                result.streamError = result.httpStatus === 200;
                result.errorCode ||= result.httpStatus === 200 ? "stream_error" : "http_error";
                if (Number.isInteger(packet.error.code) && packet.error.code >= 100 && packet.error.code <= 599)
                    result.providerErrorCode = packet.error.code;
                if (typeof packet.error.status === "string" && /^[A-Z_]{1,64}$/.test(packet.error.status))
                    result.providerErrorStatus = packet.error.status;
                if (typeof packet.error.message === "string") {
                    let safeMessage = packet.error.message;
                    if (typeof key === "string" && key.length) safeMessage = safeMessage.split(key).join("[REDACTED]");
                    result.providerErrorMessage = safeMessage.replace(/[\r\n]/g, " ").slice(0, 600);
                }
            }
            if (typeof packet.responseId === "string") {
                result.responseId = packet.responseId;
                if (!result.requestId) {
                    result.requestId = packet.responseId;
                    result.requestIdSource = "gemini_response_id";
                }
            }
            if (typeof packet.modelVersion === "string") result.modelVersion = packet.modelVersion;
            if (mode === "count" && Number.isFinite(packet.totalTokens)) result.countTokens = packet.totalTokens;
            const usage = packet.usageMetadata;
            if (usage && typeof usage === "object") {
                const fields = {
                    cachedContentTokenCount: "cachedTokens",
                    candidatesTokenCount: "candidateTokens",
                    promptTokenCount: "promptTokens",
                    thoughtsTokenCount: "thoughtTokens",
                    totalTokenCount: "totalTokens",
                };
                for (const [source, target] of Object.entries(fields)) {
                    if (Number.isFinite(usage[source])) result[target] = usage[source];
                }
            }
            const candidate = packet.candidates?.[0];
            if (typeof candidate?.finishReason === "string") result.finishReason = candidate.finishReason;
            const parts = candidate?.content?.parts;
            if (Array.isArray(parts)) {
                for (const part of parts) {
                    if (part.thought === true || typeof part.text !== "string" || !part.text) continue;
                    if (result.firstTextMs === null) result.firstTextMs = nowMs();
                    result.text += part.text;
                    safeCallback(onEvent, { clientId: result.clientId, elapsedMs: nowMs(), text: part.text });
                }
            }
        }

        function parsePacket(text) {
            if (!text.trim() || text.trim() === "[DONE]") return;
            try {
                applyPacket(JSON.parse(text));
            } catch {
                result.parseOk = false;
                result.errorCode ||= "invalid_json";
            }
        }

        function dispatchEvent() {
            if (dataLines.length) parsePacket(dataLines.join("\n"));
            dataLines = [];
        }

        function consumeLine(line) {
            if (line === "") return dispatchEvent();
            if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }

        function consumeSse(text, final = false) {
            lineBuffer += text;
            for (;;) {
                const match = /[\r\n]/.exec(lineBuffer);
                if (!match) break;
                const index = match.index;
                if (lineBuffer[index] === "\r" && index === lineBuffer.length - 1 && !final) break;
                const width = lineBuffer[index] === "\r" && lineBuffer[index + 1] === "\n" ? 2 : 1;
                consumeLine(lineBuffer.slice(0, index));
                lineBuffer = lineBuffer.slice(index + width);
            }
            if (final) {
                if (lineBuffer) consumeLine(lineBuffer);
                lineBuffer = "";
                dispatchEvent();
            }
        }

        const endpoint =
            mode === "sse" ? "streamGenerateContent?alt=sse" : mode === "count" ? "countTokens" : "generateContent";
        const path = `/v1beta/models/${MODEL}:${endpoint}`;
        const headers = {
            accept: mode === "sse" ? "text/event-stream" : "application/json",
            "content-length": payload.length,
            "content-type": "application/json",
        };
        if (key) headers["x-goog-api-key"] = key;
        if (clientId) headers["x-request-id"] = clientId;
        const transport = url.protocol === "https:" ? https : http;
        try {
            request = transport.request(url, {
                agent: url.protocol === "https:" ? httpsAgent : fixtureAgent,
                headers,
                method: "POST",
                path,
            });
        } catch {
            finish("invalid_request");
            return;
        }
        timer = setTimeout(() => {
            finish("timeout");
            response?.destroy();
            request.destroy();
        }, timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        // Close the race between the initial signal check and listener attachment.
        if (signal?.aborted) {
            abort();
            return;
        }
        request.on("socket", socket => {
            socketAt = nowMs();
            result.queueMs = socketAt;
            if (!socket.connecting) {
                result.connectMs = 0;
                result.tlsMs = 0;
                uploadStartedAt = socketAt;
                return;
            }
            const connected = () => {
                connectedAt = nowMs();
                result.connectMs = connectedAt - socketAt;
                if (url.protocol === "http:") {
                    result.tlsMs = 0;
                    uploadStartedAt = connectedAt;
                }
            };
            const secure = () => {
                uploadStartedAt = nowMs();
                result.tlsMs = uploadStartedAt - (connectedAt ?? socketAt);
            };
            socket.once("connect", connected);
            socketListeners.push([socket, "connect", connected]);
            if (url.protocol === "https:") {
                socket.once("secureConnect", secure);
                socketListeners.push([socket, "secureConnect", secure]);
            }
        });
        request.on("finish", () => {
            if (settled || result.sent) return;
            result.sent = true;
            result.uploadMs = nowMs() - (uploadStartedAt ?? socketAt ?? 0);
            safeCallback(onSent, { clientId: result.clientId, elapsedMs: nowMs() });
        });
        request.on("error", networkFailure);
        request.on("response", incoming => {
            if (settled) {
                incoming.destroy();
                return;
            }
            response = incoming;
            result.httpStatus = incoming.statusCode;
            const retryAfter = incoming.headers["retry-after"];
            if (typeof retryAfter === "string") {
                const delay = /^\d+$/.test(retryAfter)
                    ? Number(retryAfter) * 1000
                    : Date.parse(retryAfter) - Date.now();
                if (Number.isFinite(delay) && delay >= 0) result.retryAfterMs = Math.min(delay, 1800000);
            }
            result.ttfbMs = nowMs();
            result.requestId = incoming.headers["x-request-id"] || incoming.headers["x-aitoapi-request-id"] || null;
            if (result.requestId) result.requestIdSource = "response_header";
            if (result.httpStatus >= 300 && result.httpStatus < 400) {
                finish("redirect_rejected");
                incoming.destroy();
                return;
            }
            if (result.httpStatus < 200 || result.httpStatus >= 300) result.errorCode = "http_error";
            const isSse = mode === "sse" && (incoming.headers["content-type"] || "").includes("text/event-stream");
            incoming.on("data", chunk => {
                if (settled) return;
                const at = nowMs();
                if (lastChunkAt !== null) result.maxChunkGapMs = Math.max(result.maxChunkGapMs, at - lastChunkAt);
                lastChunkAt = at;
                result.responseBytes += chunk.length;
                const decoded = decoder.write(chunk);
                if (isSse) consumeSse(decoded);
                else responseText += decoded;
            });
            incoming.on("end", () => {
                if (settled) return;
                result.eof = incoming.complete;
                if (isSse) consumeSse(decoder.end(), true);
                else parsePacket(responseText + decoder.end());
                finish(result.eof ? undefined : "incomplete_response");
            });
            incoming.on("aborted", () => finish("incomplete_response"));
            incoming.on("error", networkFailure);
        });
        request.end(payload);
    });
}

function closeTransport() {
    httpsAgent.destroy();
    fixtureAgent.destroy();
}

module.exports = { closeTransport, MODEL, PRODUCTION_ORIGIN, requestGemini };
