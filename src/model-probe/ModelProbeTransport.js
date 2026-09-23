const crypto = require("crypto");
const http = require("http");
const { WebSocketServer } = require("ws");
const { VerificationError, abortable, abortError, upstreamError } = require("../management/VerifierSupport");

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const hasDecodedPayload = value => {
    if (typeof value !== "string" || value.length < 4) return false;
    try {
        return Buffer.from(value, "base64").length > 0;
    } catch {
        return false;
    }
};

class ModelProbeTransport {
    constructor({ index }) {
        this.index = index;
        this.nonce = crypto.randomBytes(32).toString("hex");
        this.closed = false;
        this.connected = new Promise(resolve => {
            this.onConnected = resolve;
        });
    }

    async listen(signal) {
        this.tcpSockets = new Set();
        this.httpServer = http.createServer((_request, response) => {
            response.writeHead(404);
            response.end();
        });
        this.httpServer.on("connection", socket => {
            this.tcpSockets.add(socket);
            socket.once("close", () => this.tcpSockets.delete(socket));
        });
        this.server = new WebSocketServer({
            maxPayload: 1024 * 1024,
            server: this.httpServer,
            verifyClient: info => {
                const url = new URL(info.req.url, "http://127.0.0.1");
                return (
                    !this.closed &&
                    !this.socket &&
                    info.req.socket.remoteAddress === "127.0.0.1" &&
                    url.pathname === `/probe/${this.nonce}` &&
                    url.searchParams.get("authIndex") === String(this.index)
                );
            },
        });
        this.server.on("connection", socket => {
            if (this.closed || this.socket) {
                socket.terminate();
                return;
            }
            this.socket = socket;
            socket.on("message", data => this.onMessage?.(data));
            socket.on("error", () => this.rejectResponse?.(new VerificationError("connection_closed")));
            socket.on("close", () => this.rejectResponse?.(new VerificationError("connection_closed")));
            this.onConnected(socket);
        });
        this.server.on("error", () => this.rejectResponse?.(new VerificationError("connection_closed")));
        this.httpServer.on("error", () => this.rejectResponse?.(new VerificationError("connection_closed")));
        await abortable(
            new Promise((resolve, reject) => {
                this.httpServer.once("listening", resolve);
                this.httpServer.once("error", reject);
                this.httpServer.listen(0, "127.0.0.1");
            }),
            signal
        );
        return `ws://127.0.0.1:${this.httpServer.address().port}/probe/${this.nonce}?authIndex=${this.index}`;
    }

    _request(model) {
        if (model.kind === "imagen") {
            return {
                body: JSON.stringify({
                    instances: [{ prompt: "A simple blue circle centered on a plain white background. No text." }],
                    parameters: { sampleCount: 1 },
                }),
                path: `/v1beta/models/${model.id}:predict`,
            };
        }
        if (model.kind === "gemini_image") {
            return {
                body: JSON.stringify({
                    contents: [
                        {
                            parts: [
                                {
                                    text: "Generate a simple blue circle centered on a plain white background. No text.",
                                },
                            ],
                            role: "user",
                        },
                    ],
                    generationConfig: { responseModalities: ["IMAGE"] },
                }),
                path: `/v1beta/models/${model.id}:generateContent`,
            };
        }
        return {
            body: JSON.stringify({
                contents: [{ parts: [{ text: "Reply with exactly OK." }], role: "user" }],
                generationConfig: { maxOutputTokens: 64, temperature: 0 },
            }),
            path: `/v1beta/models/${model.id}:generateContent`,
        };
    }

    _validate(model, payload) {
        if (payload?.error) throw upstreamError(payload.error.code);
        if (model.kind === "imagen") {
            const prediction = payload?.predictions?.find(item =>
                hasDecodedPayload(item?.bytesBase64Encoded || item?.bytesBase64encoded)
            );
            if (!prediction || (prediction.mimeType && !String(prediction.mimeType).startsWith("image/"))) {
                throw new VerificationError("empty_response");
            }
            return;
        }
        if (model.kind === "gemini_image") {
            const image = payload?.candidates
                ?.flatMap(candidate => candidate?.content?.parts || [])
                .find(
                    part =>
                        String(part?.inlineData?.mimeType || "").startsWith("image/") &&
                        hasDecodedPayload(part?.inlineData?.data)
                );
            if (!image) throw new VerificationError("empty_response");
            return;
        }
        const candidate = payload?.candidates?.find(item =>
            item?.content?.parts?.some(part => !part.thought && typeof part.text === "string" && part.text.trim())
        );
        if (!candidate) throw new VerificationError("empty_response");
    }

    async probe(model, signal, timeoutMs = 120000) {
        const socket = await abortable(this.connected, signal);
        if (this.currentRequest || socket.readyState !== 1) throw new VerificationError("connection_closed");
        const requestId = `model_probe_${crypto.randomUUID()}`;
        const attemptId = crypto.randomUUID();
        const controller = new AbortController();
        const cancel = () => controller.abort(abortError(signal));
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(() => controller.abort(new VerificationError("timeout")), timeoutMs);
        const startedAt = Date.now();
        let body = "";
        let status = null;
        this.currentRequest = { attemptId, requestId };
        const response = new Promise((resolve, reject) => {
            this.rejectResponse = reject;
            this.onMessage = raw => {
                try {
                    const packet = JSON.parse(raw.toString());
                    if (
                        packet.request_id !== requestId ||
                        packet.request_attempt_id !== attemptId ||
                        (packet.authIndex !== undefined && packet.authIndex !== this.index) ||
                        (packet.model !== undefined && packet.model !== model.id)
                    ) {
                        throw new VerificationError("protocol_mismatch");
                    }
                    if (packet.event_type === "error") throw upstreamError(packet.status, packet.message);
                    if (packet.event_type === "response_headers") {
                        if (status !== null || !Number.isInteger(packet.status)) {
                            throw new VerificationError("protocol_mismatch");
                        }
                        status = packet.status;
                        if (status < 200 || status >= 300) throw upstreamError(status);
                    } else if (packet.event_type === "chunk") {
                        if (status === null || typeof packet.data !== "string") {
                            throw new VerificationError("protocol_mismatch");
                        }
                        body += packet.data;
                        if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
                            throw new VerificationError("protocol_mismatch", status);
                        }
                    } else if (packet.event_type === "stream_close") {
                        if (status === null) throw new VerificationError("empty_response");
                        let payload;
                        try {
                            payload = JSON.parse(body);
                        } catch {
                            throw new VerificationError("empty_response", status);
                        }
                        this._validate(model, payload);
                        resolve({ durationMs: Date.now() - startedAt, status });
                    } else if (packet.event_type !== "response_headers") {
                        throw new VerificationError("protocol_mismatch");
                    }
                } catch (error) {
                    reject(error instanceof VerificationError ? error : new VerificationError("protocol_mismatch"));
                }
            };
        });
        const request = this._request(model);
        socket.send(
            JSON.stringify({
                ...request,
                event_type: "proxy_request",
                headers: { "Content-Type": "application/json" },
                method: "POST",
                query_params: {},
                request_attempt_id: attemptId,
                request_id: requestId,
                streaming_mode: "fake",
            })
        );
        try {
            return await abortable(response, controller.signal);
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            if (controller.signal.aborted && socket.readyState === 1) {
                try {
                    socket.send(
                        JSON.stringify({
                            event_type: "cancel_request",
                            request_attempt_id: attemptId,
                            request_id: requestId,
                        })
                    );
                } catch {
                    /* Connection cleanup below is authoritative. */
                }
            }
            this.currentRequest = null;
            this.onMessage = null;
            this.rejectResponse = null;
        }
    }

    close() {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        for (const socket of this.server?.clients || []) socket.terminate();
        for (const socket of this.tcpSockets || []) socket.destroy();
        this.rejectResponse?.(new VerificationError("cancelled"));
        this.closePromise = Promise.all([
            this.server ? new Promise(resolve => this.server.close(() => resolve())) : undefined,
            this.httpServer ? new Promise(resolve => this.httpServer.close(() => resolve())) : undefined,
        ]);
        return this.closePromise;
    }
}

module.exports = ModelProbeTransport;
module.exports.MAX_RESPONSE_BYTES = MAX_RESPONSE_BYTES;
