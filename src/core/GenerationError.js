class GenerationError extends Error {
    constructor(code, status = 502, resultClass = "error") {
        super(code.replace(/_/g, " "));
        this.name = "GenerationError";
        this.code = code;
        this.status = status;
        this.resultClass = resultClass;
    }
}

module.exports = GenerationError;
