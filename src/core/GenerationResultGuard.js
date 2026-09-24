const GenerationError = require("./GenerationError");
const { parseObject } = require("./GenerationInputAdapter");

const BLOCKED = new Set([
    "SAFETY",
    "RECITATION",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "IMAGE_SAFETY",
    "IMAGE_PROHIBITED_CONTENT",
    "IMAGE_RECITATION",
    "ESCALATION",
    "PUP_LIMITED_DISABLED",
]);
const object = value => value && typeof value === "object" && !Array.isArray(value);

class GenerationResultGuard {
    constructor(format = "gemini", budget = null) {
        this.format = format;
        this.budget = budget;
        this.toolBytes = 0;
        this.candidates = new Map();
        this.blockReason = null;
        this.usage = null;
        this.events = 0;
        this.toolRisk = false;
        this.upstreamEffectiveParts = 0;
        this.convertedEffectiveParts = 0;
        this.unknownParts = 0;
    }

    observe(response) {
        if (!object(response)) throw new GenerationError("invalid_upstream_response");
        if (response.error) throw new GenerationError("upstream_response_error");
        this.events++;
        if (object(response.usageMetadata)) this.usage = response.usageMetadata;
        const block = response.promptFeedback?.blockReason;
        if (block && block !== "BLOCK_REASON_UNSPECIFIED") this.blockReason = String(block);
        if (response.candidates !== undefined && !Array.isArray(response.candidates))
            throw new GenerationError("invalid_upstream_response");
        const candidates = response.candidates || [];
        if (candidates.some(candidate => !object(candidate))) throw new GenerationError("invalid_upstream_response");
        if (candidates.length > 32) throw new GenerationError("resource_exhausted", 503);
        if (this.format !== "gemini" && (candidates.length > 1 || candidates.some(c => (c.index ?? 0) !== 0))) {
            throw new GenerationError("unsupported_candidates");
        }
        for (const [position, candidate] of candidates.entries()) {
            if (!object(candidate)) throw new GenerationError("invalid_upstream_response");
            const index = candidate.index ?? position;
            if (!Number.isInteger(index) || index < 0 || index > 31)
                throw new GenerationError("invalid_upstream_response");
            const state = this.candidates.get(index) || {
                effective: 0,
                finish: null,
                media: 0,
                text: 0,
                thought: 0,
                toolAliases: new Map(),
                toolCalls: new Map(),
                tools: 0,
                unknown: 0,
                unsupported: 0,
            };
            this.candidates.set(index, state);
            const parts = candidate.content?.parts ?? [];
            if (!Array.isArray(parts)) throw new GenerationError("invalid_upstream_response");
            if (state.finish && parts.length) throw new GenerationError("content_after_terminal");
            const convertedParts = [];
            for (const part of parts) {
                if (!object(part)) throw new GenerationError("invalid_upstream_response");
                let effective = false;
                let supported = true;
                if (part.executableCode || part.codeExecutionResult || part.toolCall || part.toolResponse)
                    this.toolRisk = true;
                if (part.text !== undefined) {
                    if (typeof part.text !== "string") throw new GenerationError("invalid_upstream_response");
                    if (part.thought === true) state.thought += part.text.length;
                    else {
                        state.text += part.text.replace(/\s/g, "").length;
                        effective = Boolean(part.text.trim());
                    }
                } else if (part.functionCall) {
                    const call = part.functionCall;
                    if (!object(call) || call.partialArgs !== undefined) throw new GenerationError("invalid_tool_call");
                    const id = call.id ?? call.index;
                    if (call.id !== undefined && typeof call.id !== "string")
                        throw new GenerationError("invalid_tool_call");
                    if (
                        call.index !== undefined &&
                        (!Number.isInteger(call.index) || call.index < 0 || call.index > 1024)
                    )
                        throw new GenerationError("invalid_tool_call");
                    if (
                        id !== undefined &&
                        !(
                            (typeof id === "string" && id.length > 0 && id.length <= 160) ||
                            (Number.isInteger(id) && id >= 0 && id <= 1024)
                        )
                    )
                        throw new GenerationError("invalid_tool_call");
                    const key =
                        call.index !== undefined
                            ? `index:${call.index}`
                            : call.id !== undefined
                              ? state.toolAliases.get(call.id) || `id:${call.id}`
                              : Symbol();
                    if (call.index !== undefined && call.id !== undefined) state.toolAliases.set(call.id, key);
                    const tool = state.toolCalls.get(key) || {
                        args: {},
                        argumentText: null,
                        id: typeof call.id === "string" ? call.id : undefined,
                        name: call.name,
                        signature: part.thoughtSignature,
                    };
                    if (tool.id && call.id && tool.id !== call.id) throw new GenerationError("invalid_tool_call");
                    tool.id ||= call.id;
                    tool.signature ||= part.thoughtSignature;
                    if (typeof tool.name !== "string" || !tool.name.trim() || (call.name && call.name !== tool.name))
                        throw new GenerationError("invalid_tool_call");
                    const serialized = JSON.stringify(call.args ?? {});
                    this.toolBytes +=
                        (serialized.length + (call.name?.length || 0) + (part.thoughtSignature?.length || 0)) * 2 + 256;
                    this.budget?.set("tools", this.toolBytes);
                    if (typeof call.args === "string" && id !== undefined) {
                        if (Object.keys(tool.args).length) throw new GenerationError("invalid_tool_call");
                        tool.argumentText = (tool.argumentText || "") + call.args;
                    } else if (call.args === undefined || object(call.args)) {
                        if (tool.argumentText !== null) throw new GenerationError("invalid_tool_call");
                        for (const [name, value] of Object.entries(call.args || {})) {
                            if (
                                Object.hasOwn(tool.args, name) &&
                                JSON.stringify(tool.args[name]) !== JSON.stringify(value)
                            )
                                throw new GenerationError("invalid_tool_call");
                            Object.defineProperty(tool.args, name, {
                                configurable: true,
                                enumerable: true,
                                value,
                                writable: true,
                            });
                        }
                    } else throw new GenerationError("invalid_tool_call");
                    state.toolCalls.set(key, tool);
                    if (state.toolCalls.size > 1024) throw new GenerationError("resource_exhausted", 503);
                    continue;
                } else if (part.inlineData || part.fileData) {
                    const media = part.inlineData || part.fileData;
                    const data = media.data ?? media.fileUri;
                    if (
                        !object(media) ||
                        typeof media.mimeType !== "string" ||
                        !media.mimeType.includes("/") ||
                        typeof data !== "string" ||
                        !data.trim()
                    ) {
                        throw new GenerationError("invalid_media");
                    }
                    state.media++;
                    effective = true;
                    supported =
                        this.format === "gemini" || Boolean(part.inlineData && media.mimeType.startsWith("image/"));
                } else if (part.codeExecutionResult) {
                    effective =
                        typeof part.codeExecutionResult.output === "string" &&
                        Boolean(part.codeExecutionResult.output.trim());
                    supported = this.format === "gemini";
                } else if (!part.thoughtSignature && !part.executableCode) {
                    state.unknown++;
                    this.unknownParts++;
                }
                if (effective) {
                    this.upstreamEffectiveParts++;
                    if (supported) {
                        state.effective++;
                        this.convertedEffectiveParts++;
                    } else state.unsupported++;
                }
                if (supported) convertedParts.push(part);
            }
            if (this.format !== "gemini" && candidate.content)
                candidate.content = { ...candidate.content, parts: convertedParts };
            if (candidate.finishReason) {
                if (
                    typeof candidate.finishReason !== "string" ||
                    (state.finish && state.finish !== candidate.finishReason)
                ) {
                    throw new GenerationError("conflicting_terminal");
                }
                state.finish = candidate.finishReason;
                if (state.toolCalls.size && !state.tools && ["STOP", "MAX_TOKENS"].includes(state.finish)) {
                    const completed = [];
                    for (const tool of state.toolCalls.values()) {
                        let args = tool.args;
                        if (tool.argumentText !== null) {
                            try {
                                args = parseObject(tool.argumentText);
                            } catch (error) {
                                if (error.code === "resource_exhausted") throw error;
                                if (state.finish === "MAX_TOKENS") continue;
                                throw new GenerationError("invalid_tool_call");
                            }
                            if (!object(args)) throw new GenerationError("invalid_tool_call");
                        }
                        completed.push({
                            functionCall: { args, ...(tool.id ? { id: tool.id } : {}), name: tool.name },
                            ...(tool.signature ? { thoughtSignature: tool.signature } : {}),
                        });
                    }
                    state.tools = completed.length;
                    state.effective += completed.length;
                    this.upstreamEffectiveParts += completed.length;
                    this.convertedEffectiveParts += completed.length;
                    if (this.format !== "gemini")
                        candidate.content = {
                            ...candidate.content,
                            parts: [...convertedParts, ...completed],
                            role: "model",
                        };
                }
            }
        }
    }

    get effective() {
        return this.convertedEffectiveParts > 0;
    }
    get terminalSeen() {
        return (
            Boolean(this.blockReason) ||
            (this.candidates.size > 0 && [...this.candidates.values()].every(c => c.finish))
        );
    }

    finish() {
        if (this.blockReason) return { code: "content_blocked", resultClass: "blocked" };
        const results = [...this.candidates.values()].map(c => {
            if (BLOCKED.has(c.finish)) return { code: "content_blocked", resultClass: "blocked" };
            if (c.finish && c.finish !== "STOP" && c.finish !== "MAX_TOKENS")
                throw new GenerationError("upstream_finish_error");
            if (c.finish === "MAX_TOKENS") {
                if (!c.effective) return { code: "output_budget_exhausted", resultClass: "empty" };
                return { code: "output_limit", resultClass: "incomplete" };
            }
            if (!c.effective && (c.unsupported || (c.unknown && this.format !== "gemini")))
                throw new GenerationError("unsupported_output");
            if (!c.finish && (c.effective || c.thought || c.toolCalls.size))
                throw new GenerationError("incomplete_stream", 502, "incomplete");
            if (!c.effective) return { code: c.thought ? "thought_only" : "empty_response", resultClass: "empty" };
            return { code: null, resultClass: "success" };
        });
        if (!results.length || results.every(r => r.resultClass === "empty")) {
            throw new GenerationError(
                results.some(r => r.code === "output_budget_exhausted")
                    ? "output_budget_exhausted"
                    : results.some(r => r.code === "thought_only")
                      ? "thought_only"
                      : "empty_response",
                502,
                "empty"
            );
        }
        if (results.every(r => r.resultClass === "success")) return results[0];
        if (results.some(r => ["success", "incomplete"].includes(r.resultClass)))
            return { code: results.length > 1 ? "partial_candidates" : "output_limit", resultClass: "incomplete" };
        return { code: "content_blocked", resultClass: "blocked" };
    }

    summary() {
        return {
            blockReason: this.blockReason,
            candidateCount: this.candidates.size,
            candidatesTokenCount: this.usage?.candidatesTokenCount ?? null,
            convertedEffectivePartCount: this.convertedEffectiveParts,
            finishReasonsByCandidate: Object.fromEntries([...this.candidates].map(([i, c]) => [i, c.finish])),
            mediaParts: [...this.candidates.values()].reduce((n, c) => n + c.media, 0),
            ordinaryTextNonWhitespaceChars: [...this.candidates.values()].reduce((n, c) => n + c.text, 0),
            terminalSeen: this.terminalSeen,
            thoughtChars: [...this.candidates.values()].reduce((n, c) => n + c.thought, 0),
            thoughtsTokenCount: this.usage?.thoughtsTokenCount ?? null,
            toolRisk: this.toolRisk,
            unknownPartCount: this.unknownParts,
            upstreamEffectivePartCount: this.upstreamEffectiveParts,
            validToolCalls: [...this.candidates.values()].reduce((n, c) => n + c.tools, 0),
        };
    }
}

GenerationResultGuard.BLOCKED = BLOCKED;
module.exports = GenerationResultGuard;
