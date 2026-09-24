const { performance } = require("perf_hooks");
const LoggingService = require("../utils/LoggingService");

class GenerationDiagnostics {
    static create(logger, context) {
        return LoggingService.isDebugEnabled() && typeof logger?.diagnostic === "function"
            ? new GenerationDiagnostics(logger, context)
            : null;
    }

    constructor(logger, context) {
        this.logger = logger;
        this.context = context;
        this.started = performance.now();
        this.active = true;
        this.recentEvents = [];
        this.sequence = 0;
        this.snapshot = () => ({});
        this.unsubscribe = LoggingService.onLevelChange(level => {
            if (level !== "DEBUG") this.close();
        });
        this.timer = setInterval(() => this.emit("progress", this.snapshot()), 30000);
        this.timer.unref?.();
        this.emit("request_started");
    }

    emit(event, fields = {}, level = "INFO") {
        if (!this.active || !LoggingService.isDebugEnabled()) return;
        try {
            this.logger.diagnostic(level, `generation.${event}`, () => ({
                ...this.context,
                elapsedMs: Math.round(performance.now() - this.started),
                ...fields,
                ...(event === "attempt_finished" ? { recentEvents: this.recentEvents } : {}),
            }));
        } catch {
            /* Diagnostic sinks must not change generation outcomes. */
        }
    }

    observeFrame(frame) {
        if (!this.active || !LoggingService.isDebugEnabled()) return;
        this.recentEvents.push({
            eventKind: frame.done ? "done" : frame.parsed ? "data" : "control",
            rawBytes: Buffer.byteLength(frame.raw),
            seq: ++this.sequence,
        });
        if (this.recentEvents.length > 12) this.recentEvents.shift();
    }

    close() {
        if (!this.active) return;
        this.active = false;
        clearInterval(this.timer);
        this.unsubscribe?.();
        this.snapshot = () => ({});
        this.recentEvents = [];
    }
}

module.exports = GenerationDiagnostics;
