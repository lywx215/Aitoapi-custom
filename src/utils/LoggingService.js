/**
 * File: src/utils/LoggingService.js
 * Description: Logging service that formats, buffers, and outputs system logs with different severity levels
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

/**
 * Logging Service Module
 * Responsible for formatting and recording system logs
 */
const { randomUUID } = require("crypto");
const DIAGNOSTIC_KEYS = new Set(
    "requestId attemptId attemptCount attemptOutcome deliveryOutcome attemptNo authIndex apiFormat mode model stage elapsedMs upstreamStatus wireStatus resultClass errorCode failureOrigin failureStage closeCause headersSent terminalSeen terminalSent eofSeen parserFinishOk observationComplete candidateCount convertedEffectivePartCount upstreamEffectivePartCount ordinaryTextNonWhitespaceChars thoughtChars mediaParts validToolCalls unknownPartCount toolRisk blockReason finishReasonsByCandidate serverDataUtf8Bytes serverWsChunks parserResidualBytes parseErrorCount queuePeakBytes bufferPeakBytes downstreamBodyBytesWritten writeBackpressureCount drainWaitMs firstUpstreamByteMs firstEffectiveMs responseCommitMs totalMs timeoutSource configuredTimeoutMs eligible denyReason attemptsUsed emptyRetriesUsed remainingDeadlineMs ackState ackWaitMs browserReadBytes browserReadChunks browserWsChunks browserDataUtf8Bytes browserProtocolVersion browserDurationMs dispatchState inputFormat eventCount recentEvents seq rawBytes eventKind partKinds errorCount taskId verificationAttemptId deadlineRemainingMs queueWaitMs browserReady wsReady maxOutputTokens thinkingBudget thinkingLevel includeThoughts candidatesTokenCount thoughtsTokenCount".split(
        " "
    )
);

class LoggingService {
    static bootId = randomUUID();
    static diagnosticLoggers = new Set();
    static levelListeners = new Set();
    // Log levels: DEBUG < INFO < WARN < ERROR
    static LEVELS = { DEBUG: 0, ERROR: 3, INFO: 1, WARN: 2 };
    static currentLevel =
        process.env.LOG_LEVEL?.toUpperCase() === "DEBUG" ? LoggingService.LEVELS.DEBUG : LoggingService.LEVELS.INFO;

    /**
     * Set the global log level
     * @param {string} level - 'DEBUG', 'INFO', 'WARN', or 'ERROR'
     */
    static setLevel(level) {
        const upperLevel = String(level).toUpperCase();
        if (LoggingService.LEVELS[upperLevel] !== undefined) {
            LoggingService.currentLevel = LoggingService.LEVELS[upperLevel];
            if (upperLevel !== "DEBUG") {
                for (const logger of LoggingService.diagnosticLoggers) {
                    clearImmediate(logger.diagnosticFlush);
                    logger.diagnosticFlush = null;
                    logger.diagnosticQueue = null;
                }
                LoggingService.diagnosticLoggers.clear();
            }
            for (const listener of LoggingService.levelListeners) {
                try {
                    listener(upperLevel);
                } catch {
                    /* Diagnostics must never affect requests. */
                }
            }
        }
    }

    /**
     * Get the current log level name
     * @returns {string} Current level name
     */
    static getLevel() {
        return Object.keys(LoggingService.LEVELS).find(
            key => LoggingService.LEVELS[key] === LoggingService.currentLevel
        );
    }

    /**
     * Check if debug mode is enabled
     * @returns {boolean}
     */
    static isDebugEnabled() {
        return LoggingService.currentLevel <= LoggingService.LEVELS.DEBUG;
    }

    static onLevelChange(listener) {
        LoggingService.levelListeners.add(listener);
        return () => LoggingService.levelListeners.delete(listener);
    }

    diagnostic(level, event, fieldsFactory) {
        if (!LoggingService.isDebugEnabled()) return false;
        try {
            const fields = fieldsFactory();
            const safe = {};
            for (const [key, value] of Object.entries(fields || {})) {
                if (!DIAGNOSTIC_KEYS.has(key)) continue;
                if (
                    value === null ||
                    typeof value === "boolean" ||
                    (typeof value === "number" && Number.isFinite(value))
                )
                    safe[key] = value;
                else if (typeof value === "string")
                    safe[key] = Array.from(value.slice(0, 160), char => (char.charCodeAt(0) < 32 ? " " : char)).join(
                        ""
                    );
                else if (key === "recentEvents" && Array.isArray(value))
                    safe[key] = value.slice(-12).map(v => ({
                        eventKind: ["data", "done", "control"].includes(v.eventKind) ? v.eventKind : "control",
                        rawBytes: Number(v.rawBytes) || 0,
                        seq: Number(v.seq) || 0,
                    }));
                else if (key === "finishReasonsByCandidate" && value && typeof value === "object") {
                    safe[key] = Object.fromEntries(
                        Object.entries(value)
                            .slice(0, 32)
                            .filter(([k]) => /^\d+$/.test(k))
                            .map(([k, v]) => [k, typeof v === "string" && /^[A-Z_]{1,64}$/.test(v) ? v : null])
                    );
                }
            }
            const record = {
                ...safe,
                bootId: LoggingService.bootId,
                buildCommit: /^[a-f0-9]{7,64}$/i.test(process.env.ZEABUR_GIT_COMMIT_SHA || process.env.GIT_COMMIT || "")
                    ? process.env.ZEABUR_GIT_COMMIT_SHA || process.env.GIT_COMMIT
                    : null,
                event: String(event).slice(0, 96),
                level,
                logsDropped: this.diagnosticDropped || 0,
                schemaVersion: 1,
                ts: new Date().toISOString(),
            };
            const line = JSON.stringify(record);
            if (Buffer.byteLength(line) > 8192 || !LoggingService.isDebugEnabled()) return false;
            // One bounded line; no raw model data or error object is ever serialized.
            this.logBuffer.push(line);
            if (this.logBuffer.length > this.maxBufferSize) this.logBuffer.shift();
            this.diagnosticQueue ||= [];
            const terminal = /\.(attempt_finished|request_finished|browser_closed)$/.test(record.event);
            if (this.diagnosticQueue.length >= (terminal ? 128 : 96)) {
                this.diagnosticDropped = (this.diagnosticDropped || 0) + 1;
                return false;
            }
            this.diagnosticQueue.push(line);
            LoggingService.diagnosticLoggers.add(this);
            if (!this.diagnosticFlush) this.diagnosticFlush = setImmediate(() => this._flushDiagnostics());
            return true;
        } catch {
            return false;
        }
    }

    _flushDiagnostics() {
        this.diagnosticFlush = null;
        if (!LoggingService.isDebugEnabled()) {
            this.diagnosticQueue = null;
            LoggingService.diagnosticLoggers.delete(this);
            return;
        }
        for (const line of (this.diagnosticQueue || []).splice(0, 32)) {
            try {
                console.debug(line);
            } catch {
                this.diagnosticDropped = (this.diagnosticDropped || 0) + 1;
            }
        }
        if (this.diagnosticQueue?.length) this.diagnosticFlush = setImmediate(() => this._flushDiagnostics());
        else {
            this.diagnosticQueue = null;
            LoggingService.diagnosticLoggers.delete(this);
        }
    }

    constructor(serviceName = "ProxyServer") {
        this.serviceName = serviceName;
        this.logBuffer = [];
        this.displayLimit = 100;
        this.maxBufferSize = 1000;
    }

    /**
     * Set the number of logs to display/return via API
     * @param {number} limit - New display limit
     */
    setDisplayLimit(limit) {
        const newLimit = parseInt(limit, 10);
        if (Number.isFinite(newLimit) && newLimit > 0) {
            this.displayLimit = newLimit;
        }
    }

    /**
     * Format timestamp with timezone support
     * Supports Docker TZ environment variable (e.g., TZ=Asia/Shanghai)
     * @returns {string} Formatted timestamp string
     */
    _getTimestamp() {
        const now = new Date();
        const timezone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

        try {
            // Format: YYYY-MM-DD HH:mm:ss.SSS [Timezone]
            return (
                now
                    .toLocaleString("zh-CN", {
                        day: "2-digit",
                        hour: "2-digit",
                        hour12: false,
                        minute: "2-digit",
                        month: "2-digit",
                        second: "2-digit",
                        timeZone: timezone,
                        year: "numeric",
                    })
                    .replace(/\//g, "-") + `.${now.getMilliseconds().toString().padStart(3, "0")} [${timezone}]`
            );
        } catch (err) {
            // Fallback to ISO format if timezone is invalid
            return now.toISOString();
        }
    }

    _formatMessage(level, message) {
        const timestamp = this._getTimestamp();
        const formatted = `[${level}] ${timestamp} [${this.serviceName}] - ${message}`;

        this.logBuffer.push(formatted);
        // Physical hard limit for memory safety
        if (this.logBuffer.length > this.maxBufferSize) {
            this.logBuffer.shift();
        }

        return formatted;
    }

    info(message) {
        console.log(this._formatMessage("INFO", message));
    }

    error(message) {
        console.error(this._formatMessage("ERROR", message));
    }

    warn(message) {
        console.warn(this._formatMessage("WARN", message));
    }

    debug(message) {
        if (LoggingService.currentLevel <= LoggingService.LEVELS.DEBUG) {
            console.debug(this._formatMessage("DEBUG", message));
        }
    }
}

module.exports = LoggingService;
