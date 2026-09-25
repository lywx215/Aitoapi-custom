const GenerationError = require("./GenerationError");

class GenerationResponseWriter {
    constructor({
        res,
        format,
        stream,
        array,
        model,
        converter,
        budget,
        signal,
        timeoutMs = 60000,
        diagnostics,
        publicSpan,
        onCommit = () => {},
        responseDefaults = {},
    }) {
        Object.assign(this, {
            array,
            budget,
            converter,
            diagnostics,
            format,
            model,
            onCommit,
            publicSpan,
            res,
            signal,
            stream,
            timeoutMs,
        });
        this.state = { responseDefaults };
        this.convertedObservation = require("../diagnostics/Conversion").register(this.state, publicSpan, format);
        this.pending = [];
        this.pendingSize = 0;
        this.bytes = 0;
        this.committed = false;
        this.finished = false;
        this.backpressure = 0;
        this.converterSize = 0;
    }

    convert(event) {
        let input = event;
        if (this.format === "response_api") {
            input = {
                ...event,
                candidates: event.candidates?.map(c => ({
                    ...c,
                    content: c.content
                        ? {
                              ...c.content,
                              parts: c.content.parts?.map(p =>
                                  p.inlineData
                                      ? {
                                            text: `![Generated Image](data:${p.inlineData.mimeType};base64,${p.inlineData.data})`,
                                        }
                                      : p
                              ),
                          }
                        : undefined,
                })),
            };
        }
        if (this.format === "openai")
            return this.converter.translateGoogleToOpenAIStream(input, this.model, this.state);
        if (this.format === "response_api")
            return this.converter.translateGoogleToResponseAPIStream(input, this.model, this.state);
        return this.converter.translateGoogleToClaudeStream(input, this.model, this.state);
    }

    async append(data, effective = false) {
        if (!data) return;
        if (this.signal.aborted) throw this.signal.reason;
        const size = data.length * 2;
        if (!this.committed) {
            this.budget.set("pending", this.pendingSize + size);
            this.pending.push(data);
            this.pendingSize += size;
            if (!effective) return;
            for (const item of this.pending) await this.write(item);
            this.pending = [];
            this.pendingSize = 0;
            this.budget.release("pending");
        } else await this.write(data);
    }

    async write(data) {
        if (this.res.destroyed || this.res.writableEnded || this.signal.aborted)
            throw this.signal.reason || new GenerationError("client_disconnect", 499, "aborted");
        const firstWrite = !this.committed;
        if (firstWrite) {
            this.res.statusCode = 200;
            this.res.setHeader(
                "Content-Type",
                this.array ? "application/json; charset=utf-8" : "text/event-stream; charset=utf-8"
            );
            this.res.setHeader("Cache-Control", "no-cache");
            this.res.removeHeader?.("Content-Length");
            this.res.removeHeader?.("Content-Encoding");
            this.committed = true;
        }
        this.budget.set("writing", data.length * 2);
        const accepted = this.res.write(data);
        if (firstWrite) this.onCommit();
        this.bytes += Buffer.byteLength(data);
        if (firstWrite)
            this.diagnostics?.emit("response_committed", { downstreamBodyBytesWritten: this.bytes, wireStatus: 200 });
        if (accepted === false) {
            this.backpressure++;
            const drainStarted = Date.now();
            await new Promise((resolve, reject) => {
                const cleanup = () => {
                    clearTimeout(timer);
                    this.res.off("drain", drain);
                    this.res.off("close", close);
                    this.signal.removeEventListener("abort", abort);
                };
                const drain = () => {
                    cleanup();
                    resolve();
                };
                const close = () => {
                    cleanup();
                    reject(new GenerationError("client_disconnect", 499, "aborted"));
                };
                const abort = () => {
                    cleanup();
                    reject(this.signal.reason);
                };
                const timer = setTimeout(() => {
                    cleanup();
                    reject(new GenerationError("downstream_timeout", 504));
                }, this.timeoutMs);
                this.res.once("drain", drain);
                this.res.once("close", close);
                this.signal.addEventListener("abort", abort, { once: true });
                if (this.signal.aborted) abort();
                else if (this.res.destroyed) close();
            });
            this.drainWaitMs = (this.drainWaitMs || 0) + Date.now() - drainStarted;
        }
        this.budget.release("writing");
    }

    async complete(result, guard, response = null) {
        if (this.finished) return;
        this.state.generationResult = result;
        if (!this.stream) {
            let body = response;
            const first = body.candidates?.[0];
            if (this.format !== "gemini" && !first)
                body = { ...body, candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] };
            if (this.format === "openai") body = this.converter.convertGoogleToOpenAINonStream(body, this.model);
            else if (this.format === "response_api") {
                // Reuse the same supported image representation as streaming.
                body = {
                    ...body,
                    candidates: body.candidates?.map(c => ({
                        ...c,
                        content: c.content
                            ? {
                                  ...c.content,
                                  parts: c.content.parts?.map(p =>
                                      p.inlineData
                                          ? {
                                                text: `![Generated Image](data:${p.inlineData.mimeType};base64,${p.inlineData.data})`,
                                            }
                                          : p
                                  ),
                              }
                            : undefined,
                    })),
                };
                body = this.converter.convertGoogleToResponseAPINonStream(
                    body,
                    this.model,
                    this.state.responseDefaults
                );
                if (result.resultClass !== "success") {
                    body.status = "incomplete";
                    body.incomplete_details = {
                        reason: result.resultClass === "blocked" ? "content_filter" : "max_output_tokens",
                    };
                }
            } else if (this.format === "claude") body = this.converter.convertGoogleToClaudeNonStream(body, this.model);
            if (result.resultClass === "blocked") {
                if (this.format === "openai") body.choices[0].finish_reason = "content_filter";
                if (this.format === "claude") {
                    body.stop_reason = "refusal";
                    body.content = body.content.filter(p => p.type !== "text" || p.text);
                }
            }
            const serialized = JSON.stringify(body);
            require("../diagnostics/Conversion").observe(
                this.state,
                this.format === "gemini" ? body.usageMetadata : body.usage
            );
            this.publicSpan?.converted({
                deliveredUsage: this.convertedObservation?.value,
                format: this.format,
                resultClass: result.resultClass,
                stream: false,
                upstreamStreaming: false,
            });
            this.budget.set("writing", serialized.length * 2);
            this.res.statusCode = 200;
            this.res.setHeader("Content-Type", "application/json; charset=utf-8");
            this.bytes = Buffer.byteLength(serialized);
            this.res.end(serialized);
            this.committed = true;
            this.onCommit();
        } else if (this.format !== "gemini") {
            const candidates = [...guard.candidates].map(([index, c]) => ({ finishReason: c.finish || "STOP", index }));
            if (!candidates.length && result.resultClass === "blocked")
                candidates.push({ finishReason: "SAFETY", index: 0 });
            await this.append(this.convert({ candidates, usageMetadata: guard.usage || undefined }), true);
            if (this.format === "openai") await this.write("data: [DONE]\n\n");
            this.publicSpan?.converted({
                deliveredUsage: this.convertedObservation?.value,
                format: this.format,
                resultClass: result.resultClass,
                stream: true,
                upstreamStreaming: this.upstreamStreaming,
            });
            this.res.end();
        } else {
            if (this.pending.length) await this.append("", true);
            for (const item of this.pending) await this.write(item);
            this.pending = [];
            this.publicSpan?.converted({
                deliveredUsage: guard.usage,
                format: this.format,
                resultClass: result.resultClass,
                stream: true,
                upstreamStreaming: this.upstreamStreaming,
            });
            this.res.end();
        }
        this.finished = true;
        this.budget.release("pending");
        this.budget.release("writing");
    }

    fail(error) {
        if (error.code === "downstream_timeout" && !this.res.writableFinished) {
            this.res.__generationDestroyed = true;
            this.res.destroy();
            return;
        }
        if (this.finished || this.res.destroyed || this.res.writableEnded) return;
        this.finished = true;
        const code = error.code || "internal_error";
        const status = error.status || 502;
        const message = code.replace(/_/g, " ");
        if (!this.res.headersSent) {
            this.res.statusCode = status;
            this.res.removeHeader?.("Content-Length");
            this.res.removeHeader?.("Content-Encoding");
            this.res.setHeader("Content-Type", "application/json; charset=utf-8");
            if (!error.upstreamHttp) this.res.setHeader("x-should-retry", "false");
            const body =
                this.format === "claude"
                    ? { error: { message, type: status === 503 ? "overloaded_error" : "api_error" }, type: "error" }
                    : this.format === "gemini"
                      ? {
                            error: {
                                code: status,
                                details: [{ reason: code }],
                                message,
                                status: status === 504 ? "DEADLINE_EXCEEDED" : "INTERNAL",
                            },
                        }
                      : { error: { code, message, type: "upstream_error" } };
            this.res.end(JSON.stringify(body));
        } else if (this.array) {
            this.res.__generationDestroyed = true;
            this.res.destroy();
        } else {
            const payload =
                this.format === "claude"
                    ? { error: { message, type: "api_error" }, type: "error" }
                    : this.format === "response_api"
                      ? {
                            response: {
                                error: { code, message },
                                id: this.state.id,
                                object: "response",
                                status: "failed",
                            },
                            sequence_number: (this.state.sequenceNumber || 0) + 1,
                            type: "response.failed",
                        }
                      : this.format === "gemini"
                        ? {
                              error: {
                                  code: status,
                                  details: [{ reason: code }],
                                  message,
                                  status: status === 504 ? "DEADLINE_EXCEEDED" : "INTERNAL",
                              },
                          }
                        : { error: { code, message, type: "upstream_error" } };
            const prefix =
                this.format === "claude"
                    ? "event: error\n"
                    : this.format === "response_api"
                      ? "event: response.failed\n"
                      : "";
            this.res.end(`${prefix}data: ${JSON.stringify(payload)}\n\n`);
        }
    }
}

module.exports = GenerationResponseWriter;
