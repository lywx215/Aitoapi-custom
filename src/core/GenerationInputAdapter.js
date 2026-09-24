const GenerationError = require("./GenerationError");

function parseObject(data) {
    let object;
    try {
        object = JSON.parse(data);
    } catch {
        throw new GenerationError("invalid_upstream_response");
    }
    if (!object || typeof object !== "object" || Array.isArray(object)) {
        throw new GenerationError("invalid_upstream_response");
    }
    const stack = [[object, 0]];
    let nodes = 0;
    while (stack.length) {
        const [value, depth] = stack.pop();
        if (++nodes > 100000 || depth > 64) throw new GenerationError("resource_exhausted", 503);
        if (value && typeof value === "object") {
            for (const child of Object.values(value)) stack.push([child, depth + 1]);
        }
    }
    return object;
}

/** One adapter per attempt. Network read boundaries never become JSON boundaries. */
class GenerationInputAdapter {
    constructor(format, budget) {
        this.format = format;
        this.budget = budget;
        this.buffer = "";
        this.raw = "";
        this.data = [];
        this.started = false;
        this.closed = false;
        this.doneSeen = false;
        this.events = 0;
        this.decodedBytes = 0;
        this.arrayState = "start";
        this.position = 0;
        this.depth = 0;
        this.inString = false;
        this.escape = false;
        this.elementStart = -1;
        this.decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    }

    static select(proxyRequest, headers = {}) {
        const contentType = String(
            Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] || ""
        ).toLowerCase();
        const stream = proxyRequest.path.includes(":streamGenerateContent") && proxyRequest.streaming_mode === "real";
        const sse = stream && String(proxyRequest.query_params?.alt || "") === "sse";
        if (contentType.includes("text/event-stream")) {
            if (!stream) throw new GenerationError("invalid_upstream_response");
            return "sse";
        }
        if (contentType && !contentType.includes("json")) throw new GenerationError("invalid_upstream_response");
        if (contentType.includes("json") && sse) throw new GenerationError("invalid_upstream_response");
        return stream ? (sse ? "sse" : "json_array") : "json";
    }

    _account(extra = 0) {
        this.budget?.set(
            "parser",
            (this.buffer.length + this.raw.length + this.data.reduce((n, s) => n + s.length, 0) + extra) * 2
        );
    }

    push(chunk) {
        if (this.closed) throw new GenerationError("invalid_upstream_response");
        this.decodedBytes = 0;
        this.budget?.release("decoded");
        let text;
        try {
            text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
        } catch {
            throw new GenerationError("invalid_utf8");
        }
        this._account(text.length);
        this.buffer += text;
        if (!this.started && this.buffer.length) {
            this.started = true;
            if (this.buffer[0] === "\uFEFF") {
                this.raw = "\uFEFF";
                this.buffer = this.buffer.slice(1);
            }
        }
        const result = this.format === "sse" ? this._sse(false) : this.format === "json_array" ? this._array() : [];
        this._account();
        return result;
    }

    _sse(eof) {
        const frames = [];
        while (this.buffer.length) {
            const match = /[\r\n]/.exec(this.buffer);
            if (!match) break;
            const end = match.index;
            if (!eof && this.buffer[end] === "\r" && end === this.buffer.length - 1) break;
            const length = this.buffer[end] === "\r" && this.buffer[end + 1] === "\n" ? 2 : 1;
            const line = this.buffer.slice(0, end);
            this.raw += this.buffer.slice(0, end + length);
            this.buffer = this.buffer.slice(end + length);
            if (!line) {
                const data = this.data.join("\n");
                if (this.doneSeen && data.trim()) throw new GenerationError("content_after_terminal");
                if (data.trim() === "[DONE]") this.doneSeen = true;
                const parsed = data.trim() && data.trim() !== "[DONE]" ? this._parse(data) : null;
                frames.push({ done: data.trim() === "[DONE]", parsed, raw: this.raw });
                if (parsed) this.events++;
                this.raw = "";
                this.data = [];
            } else if (line[0] !== ":") {
                const colon = line.indexOf(":");
                const field = colon < 0 ? line : line.slice(0, colon);
                let value = colon < 0 ? "" : line.slice(colon + 1);
                if (value.startsWith(" ")) value = value.slice(1);
                if (field === "data") this.data.push(value);
            }
        }
        return frames;
    }

    _array() {
        const frames = [];
        while (this.position < this.buffer.length) {
            const char = this.buffer[this.position];
            if (this.elementStart >= 0) {
                if (this.inString) {
                    if (this.escape) this.escape = false;
                    else if (char === "\\") this.escape = true;
                    else if (char === '"') this.inString = false;
                } else if (char === '"') this.inString = true;
                else if (char === "{" || char === "[") this.depth++;
                else if (char === "}" || char === "]") this.depth--;
                this.position++;
                if (this.depth === 0 && !this.inString) {
                    const raw = this.raw + this.buffer.slice(0, this.position);
                    const parsed = this._parse(this.buffer.slice(this.elementStart, this.position));
                    frames.push({ parsed, raw });
                    this.events++;
                    this.buffer = this.buffer.slice(this.position);
                    this.raw = "";
                    this.position = 0;
                    this.elementStart = -1;
                    this.arrayState = "separator";
                }
                continue;
            }
            if (/\s/.test(char)) {
                this.position++;
                continue;
            }
            if (this.arrayState === "start" && char === "[") this.arrayState = "first";
            else if ((this.arrayState === "first" || this.arrayState === "element") && char === "{") {
                this.elementStart = this.position;
                this.depth = 1;
            } else if (this.arrayState === "separator" && char === ",") this.arrayState = "element";
            else if ((this.arrayState === "first" || this.arrayState === "separator") && char === "]")
                this.arrayState = "end";
            else throw new GenerationError("invalid_upstream_response");
            this.position++;
        }
        return frames;
    }

    finish() {
        this.decodedBytes = 0;
        this.budget?.release("decoded");
        let tail;
        try {
            tail = this.decoder.decode();
        } catch {
            throw new GenerationError("invalid_utf8");
        }
        const frames = tail ? this.push(tail) : [];
        if (this.format === "sse") {
            frames.push(...this._sse(true));
            if (this.data.length || (this.buffer.trim() && !this.buffer.startsWith(":"))) {
                throw new GenerationError("incomplete_stream", 502, "incomplete");
            }
            if (this.raw || this.buffer) frames.push({ parsed: null, raw: this.raw + this.buffer });
        } else if (this.format === "json_array") {
            frames.push(...this._array());
            if (this.arrayState !== "end") throw new GenerationError("incomplete_stream", 502, "incomplete");
            frames.push({ parsed: null, raw: this.raw + this.buffer });
        } else if (this.buffer.trim()) {
            frames.push({ parsed: this._parse(this.buffer), raw: this.raw + this.buffer });
            this.events++;
        }
        this.closed = true;
        this.buffer = this.raw = "";
        this.data = [];
        this._account();
        return frames;
    }

    _parse(data) {
        // Reserve conservative parsed-object/serialization space before JSON.parse.
        this.decodedBytes += data.length * 8 + 1024;
        this.budget?.set("decoded", this.decodedBytes);
        return parseObject(data);
    }
}

GenerationInputAdapter.parseObject = parseObject;
module.exports = GenerationInputAdapter;
