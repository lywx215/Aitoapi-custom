const crypto = require("crypto");
const http = require("http");
const { WebSocketServer } = require("ws");
const { VerificationError, abortable, upstreamError } = require("./VerifierSupport");

// This registry belongs to exactly one verify call. It never imports ConnectionRegistry.
class VerifierTransport {
    constructor({ index, model, requestId }) {
        this.index = index;
        this.model = model;
        this.requestId = requestId;
        this.attemptId = crypto.randomUUID();
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
                    url.pathname === `/verify/${this.nonce}` &&
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
        this.httpServer.on("listening", () => {
            if (this.closed) this.httpServer.close(() => {});
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
        return `ws://127.0.0.1:${this.httpServer.address().port}/verify/${this.nonce}?authIndex=${this.index}`;
    }

    async generate(signal) {
        const socket = await abortable(this.connected, signal);
        if (socket.readyState !== 1) throw new VerificationError("connection_closed");
        let body = "";
        let status = null;
        const response = new Promise((resolve, reject) => {
            this.rejectResponse = reject;
            this.onMessage = raw => {
                try {
                    const packet = JSON.parse(raw.toString());
                    if (
                        packet.request_id !== this.requestId ||
                        packet.request_attempt_id !== this.attemptId ||
                        (packet.authIndex !== undefined && packet.authIndex !== this.index) ||
                        (packet.model !== undefined && packet.model !== this.model)
                    ) {
                        throw new VerificationError("protocol_mismatch");
                    }
                    if (packet.event_type === "error") throw upstreamError(packet.status, packet.message);
                    if (packet.event_type === "response_headers") {
                        if (status !== null || !Number.isInteger(packet.status))
                            throw new VerificationError("protocol_mismatch");
                        status = packet.status;
                        if (status < 200 || status >= 300) throw upstreamError(status);
                    } else if (packet.event_type === "chunk") {
                        if (status === null || typeof packet.data !== "string")
                            throw new VerificationError("protocol_mismatch");
                        body += packet.data;
                        if (Buffer.byteLength(body) > 1024 * 1024) throw new VerificationError("protocol_mismatch");
                    } else if (packet.event_type === "stream_close") {
                        if (status === null) throw new VerificationError("empty_response");
                        let payload;
                        try {
                            payload = JSON.parse(body);
                        } catch {
                            throw new VerificationError("empty_response", status);
                        }
                        if (payload?.error) throw upstreamError(payload.error.code || status);
                        // The request path and attempt bind legacy frames that do not echo model.
                        // When upstream reports its model, require an exact match; never accept a fallback.
                        if (payload?.modelVersion !== undefined && payload.modelVersion !== this.model)
                            throw new VerificationError("protocol_mismatch", status);
                        const candidate = payload?.candidates?.find(
                            item =>
                                item?.finishReason === "STOP" &&
                                item.content?.role === "model" &&
                                item.content.parts?.some(
                                    part => !part.thought && typeof part.text === "string" && part.text.trim()
                                )
                        );
                        if (!candidate) throw new VerificationError("empty_response", status);
                        resolve(status);
                    } else if (packet.event_type !== "response_headers") {
                        throw new VerificationError("protocol_mismatch");
                    }
                } catch (error) {
                    reject(error instanceof VerificationError ? error : new VerificationError("protocol_mismatch"));
                }
            };
        });
        socket.send(
            JSON.stringify({
                body: JSON.stringify({
                    contents: [{ parts: [{ text: "Reply with exactly OK." }], role: "user" }],
                    generationConfig: { maxOutputTokens: 64, temperature: 0 },
                }),
                event_type: "proxy_request",
                headers: { "Content-Type": "application/json" },
                method: "POST",
                path: `/v1beta/models/${this.model}:generateContent`,
                query_params: {},
                request_attempt_id: this.attemptId,
                request_id: this.requestId,
                streaming_mode: "fake",
            })
        );
        try {
            return await abortable(response, signal);
        } finally {
            this.onMessage = null;
            this.rejectResponse = null;
        }
    }

    close() {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        try {
            if (this.socket?.readyState === 1)
                this.socket.send(
                    JSON.stringify({
                        event_type: "cancel_request",
                        request_attempt_id: this.attemptId,
                        request_id: this.requestId,
                    })
                );
        } catch {
            /* Termination below is authoritative even if cancel cannot be sent. */
        }
        for (const socket of this.server?.clients || []) socket.terminate();
        // Also close unauthenticated TCP peers that never finished a WebSocket upgrade.
        for (const socket of this.tcpSockets || []) socket.destroy();
        this.rejectResponse?.(new VerificationError("cancelled"));
        this.closePromise = Promise.all([
            this.server ? new Promise(resolve => this.server.close(() => resolve())) : undefined,
            this.httpServer ? new Promise(resolve => this.httpServer.close(() => resolve())) : undefined,
        ]);
        return this.closePromise;
    }
}

module.exports = VerifierTransport;
