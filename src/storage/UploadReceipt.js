// Non-secret evidence of one committed credential write. Never infer it from current metadata.
function invalidReceipt() {
    return Object.assign(new Error("Invalid credential upload receipt."), {
        code: "PERSISTENCE_ERROR",
        status: 500,
    });
}

function operationKey(operation) {
    if (
        !operation ||
        !/^task_[a-f0-9-]{36}$/.test(operation.taskId) ||
        !Number.isSafeInteger(operation.itemIndex) ||
        operation.itemIndex < 0 ||
        operation.itemIndex >= 100 ||
        !["import", "replace"].includes(operation.kind)
    )
        throw invalidReceipt();
    return `${operation.taskId}:${operation.itemIndex}`;
}

function publicReceipt(value) {
    if (
        !value ||
        value.status !== "committed" ||
        typeof value.accountId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(value.accountId) ||
        !Number.isSafeInteger(value.index) ||
        value.index < 0 ||
        !Number.isSafeInteger(value.credentialVersion) ||
        value.credentialVersion < 1 ||
        !Number.isSafeInteger(value.stateVersion) ||
        value.stateVersion < 1 ||
        typeof value.committedAt !== "string" ||
        !Number.isFinite(Date.parse(value.committedAt))
    )
        throw invalidReceipt();
    return {
        accountId: value.accountId,
        committedAt: value.committedAt,
        credentialVersion: value.credentialVersion,
        index: value.index,
        stateVersion: value.stateVersion,
        status: "committed",
    };
}

module.exports = { invalidReceipt, operationKey, publicReceipt };
