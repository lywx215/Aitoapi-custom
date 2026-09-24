const GenerationError = require("./GenerationError");

class GenerationBudget {
    static total = 0;

    constructor(limit = 64 * 1024 * 1024, globalLimit = 256 * 1024 * 1024) {
        this.limit = Math.min(limit, globalLimit);
        this.globalLimit = globalLimit;
        this.entries = new Map();
        this.total = 0;
        this.peak = 0;
        this.closed = false;
    }

    set(key, bytes) {
        if (this.closed) throw new GenerationError("resource_scope_closed", 503);
        const next = Math.max(0, Math.ceil(bytes));
        const delta = next - (this.entries.get(key) || 0);
        if (
            !Number.isFinite(next) ||
            this.total + delta > this.limit ||
            GenerationBudget.total + delta > this.globalLimit
        ) {
            throw new GenerationError("resource_exhausted", 503);
        }
        this.entries.set(key, next);
        this.total += delta;
        GenerationBudget.total += delta;
        this.peak = Math.max(this.peak, this.total);
    }

    release(key) {
        if (!this.closed) this.set(key, 0);
    }

    close() {
        if (this.closed) return;
        GenerationBudget.total -= this.total;
        this.total = 0;
        this.entries.clear();
        this.closed = true;
    }
}

module.exports = GenerationBudget;
