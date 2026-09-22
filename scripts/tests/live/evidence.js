const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MODEL = "gemini-3.8-flash";
const REQUIRED = ["auth", "management", "isolation", "restart", "cleanup"];
function sourceDigest(root) {
    const hash = crypto.createHash("sha256");
    const visit = directory => {
        for (const name of fs.readdirSync(directory).sort()) {
            const file = path.join(directory, name);
            if (fs.statSync(file).isDirectory()) visit(file);
            else if (file.endsWith(".js")) {
                hash.update(path.relative(root, file).replace(/\\/g, "/"));
                hash.update(fs.readFileSync(file));
            }
        }
    };
    visit(path.join(root, "src"));
    hash.update(fs.readFileSync(path.join(root, "scripts/client/build.js")));
    return hash.digest("hex");
}
function validateEvidence(report, root) {
    const fail = message => {
        throw new Error(`LIVE NOT ACCEPTED: ${message}`);
    };
    if (report?.schemaVersion !== 1 || report.kind !== "management-live" || report.mocked !== false)
        fail("not a live report");
    if (report.status !== "passed") fail("run did not pass");
    if (report.sourceDigest !== sourceDigest(root)) fail("source mismatch");
    if (report.baseUrl !== "http://127.0.0.1:7860" || report.model !== MODEL) fail("wrong target");
    if (!Number.isInteger(report.attempts) || report.attempts < 9 || report.attempts > 12)
        fail("invalid attempt count");
    if (!REQUIRED.every(name => report.checks?.[name] === true)) fail("missing required checks");
    if (report.sourceFilesUnchanged !== true) fail("source artifact immutability not verified");
    if (report.accounts?.length !== 2 || new Set(report.accounts.map(a => a.identityHash)).size !== 2)
        fail("two distinct identities required");
    for (const field of ["artifactSha256", "importAccountId", "replayAccountId"])
        if (new Set(report.accounts.map(a => a[field])).size !== 2) fail(`duplicate ${field}`);
    const ids = [];
    const taskIds = [];
    for (const account of report.accounts) {
        if (!/^[a-f0-9]{64}$/.test(account.artifactSha256) || !/^[a-f0-9]{64}$/.test(account.identityHash))
            fail("invalid artifact identity");
        for (const stage of ["import", "verify", "replay"]) {
            const proof = account[stage];
            if (
                !proof?.success ||
                proof.stage !== "model_verified" ||
                proof.model !== MODEL ||
                !(proof.upstreamStatus >= 200 && proof.upstreamStatus < 300) ||
                !Number.isInteger(proof.authIndex) ||
                typeof proof.requestId !== "string" ||
                !proof.requestId ||
                typeof account[`${stage}TaskId`] !== "string" ||
                !account[`${stage}TaskId`]
            )
                fail(`missing ${stage}`);
            ids.push(proof.requestId);
            taskIds.push(account[`${stage}TaskId`]);
        }
        for (const stage of ["import", "replay"]) {
            const state = account[`${stage}State`];
            if (
                !state ||
                typeof state.accountId !== "string" ||
                !state.accountId ||
                state.accountId !== account[`${stage}AccountId`] ||
                state.index !== account[stage].authIndex ||
                state.enabled !== true ||
                !Number.isInteger(state.credentialVersion) ||
                state.credentialVersion < 1 ||
                !Number.isInteger(state.stateVersion) ||
                state.stateVersion < 1
            )
                fail(`missing ${stage} identity/version state`);
        }
        if (
            account.import.authIndex !== account.verify.authIndex ||
            !account.autoEnabled ||
            !account.replayEnabled ||
            !account.modelApi?.success ||
            account.modelApi.index !== account.import.authIndex ||
            account.modelApi.attemptCount !== 1
        )
            fail("account attribution/enablement missing");
    }
    if (new Set(ids).size !== ids.length) fail("reused verification request IDs");
    if (new Set(taskIds).size !== taskIds.length) fail("reused task IDs");
    return true;
}
function validateEvidenceFile(file, root) {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    validateEvidence(report, root);
    const bytes = fs.readFileSync(path.join(path.dirname(path.resolve(file)), "events.jsonl"));
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== report.eventsSha256)
        throw new Error("LIVE NOT ACCEPTED: event journal digest mismatch");
    const events = bytes
        .toString("utf8")
        .trim()
        .split(/\r?\n/)
        .map(line => JSON.parse(line));
    if (events.filter(item => item.event === "generation_attempt").length !== report.attempts)
        throw new Error("LIVE NOT ACCEPTED: attempt journal mismatch");
    for (const account of report.accounts) {
        for (const stage of ["import", "verify", "replay"]) {
            const proof = account[stage];
            if (
                !events.some(
                    event =>
                        event.event === "task_progress" &&
                        event.taskId === account[`${stage}TaskId`] &&
                        event.items.some(
                            item =>
                                item.accountId ===
                                    account[stage === "replay" ? "replayAccountId" : "importAccountId"] &&
                                item.verification?.requestId === proof.requestId &&
                                item.verification.success === true &&
                                item.verification.stage === "model_verified" &&
                                item.verification.model === MODEL &&
                                item.verification.authIndex === proof.authIndex
                        )
                )
            )
                throw new Error("LIVE NOT ACCEPTED: missing attributed task event");
        }
        if (
            !events.some(
                event =>
                    event.event === "model_api" &&
                    event.label === account.label &&
                    event.requestId === account.modelApi.requestId &&
                    event.index === account.import.authIndex
            )
        )
            throw new Error("LIVE NOT ACCEPTED: missing model API event");
    }
    return report;
}
module.exports = { MODEL, sourceDigest, validateEvidence, validateEvidenceFile };
