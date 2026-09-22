const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { selectArtifacts, request } = require("./managementLive");
const { sourceDigest, validateEvidence, validateEvidenceFile, MODEL } = require("./live/evidence");
const ROOT = path.resolve(__dirname, "../..");

test("artifact selection is newest per account, distinct, deterministic and read-only", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-harness-"));
    try {
        for (const [name, id, time] of [
            ["older", 1, 10],
            ["latest", 1, 40],
            ["second", 2, 30],
            ["third", 3, 20],
        ]) {
            const dir = path.join(root, "runtime/devices", name);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, "auth-state.enc.json");
            fs.writeFileSync(file, JSON.stringify({ algorithm: "AES-256-GCM", metadata: { account_id: id } }));
            fs.utimesSync(file, time, time);
        }
        const selected = selectArtifacts(root);
        assert.deepEqual(
            selected.map(row => [row.id, row.label]),
            [
                [1, "A"],
                [2, "B"],
            ]
        );
        assert.ok(selected[0].artifact.includes("latest"));
        assert.deepEqual(selectArtifacts(root), selected);
    } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith("live-harness-"));
        fs.rmSync(root, { force: true, recursive: true });
    }
});

test("HTTP helper rejects external and protocol-relative targets without a request", () => {
    assert.throws(() => request("GET", "https://example.com/"));
    assert.throws(() => request("GET", "//example.com/"));
});

test("live evidence gate rejects failure, simulation, stale source, incomplete/duplicate attribution and missing journal", () => {
    const proof = (index, requestId) => ({
        authIndex: index,
        model: MODEL,
        requestId,
        stage: "model_verified",
        success: true,
        upstreamStatus: 200,
    });
    // In-memory schema fixture only. Never emit a passing live report to disk.
    const report = {
        accounts: [0, 1].map(index => ({
            artifactSha256: String(index).repeat(64),
            autoEnabled: true,
            identityHash: String(index + 1).repeat(64),
            import: proof(index, `import-${index}`),
            importAccountId: `first-account-${index}`,
            importState: {
                accountId: `first-account-${index}`,
                credentialVersion: 1,
                enabled: true,
                index,
                stateVersion: 2,
            },
            importTaskId: `import-task-${index}`,
            modelApi: { attemptCount: 1, index, success: true },
            replay: proof(index, `replay-${index}`),
            replayAccountId: `second-account-${index}`,
            replayEnabled: true,
            replayState: {
                accountId: `second-account-${index}`,
                credentialVersion: 1,
                enabled: true,
                index,
                stateVersion: 2,
            },
            replayTaskId: `replay-task-${index}`,
            verify: proof(index, `verify-${index}`),
            verifyTaskId: `verify-task-${index}`,
        })),
        attempts: 9,
        baseUrl: "http://127.0.0.1:7860",
        checks: { auth: true, cleanup: true, isolation: true, management: true, restart: true },
        kind: "management-live",
        mocked: false,
        model: MODEL,
        schemaVersion: 1,
        sourceDigest: sourceDigest(ROOT),
        sourceFilesUnchanged: true,
        status: "passed",
    };
    assert.equal(validateEvidence(report, ROOT), true);
    const mutations = [
        value => {
            value.status = "partial_or_failed";
        },
        value => {
            value.mocked = true;
        },
        value => {
            value.sourceDigest = "stale";
        },
        value => {
            value.attempts = 13;
        },
        value => {
            value.checks.restart = false;
        },
        value => {
            value.accounts[1].identityHash = value.accounts[0].identityHash;
        },
        value => {
            value.accounts[0].replay.success = false;
        },
        value => {
            value.accounts[0].modelApi.index = 99;
        },
        value => {
            value.accounts[0].verify.requestId = value.accounts[0].import.requestId;
        },
        value => {
            value.accounts[0].replayState.credentialVersion = 0;
        },
        value => {
            value.accounts[1].importAccountId = value.accounts[0].importAccountId;
        },
        value => {
            value.accounts[0].verifyTaskId = value.accounts[0].importTaskId;
        },
    ];
    for (const mutate of mutations) {
        const copy = structuredClone(report);
        mutate(copy);
        assert.throws(() => validateEvidence(copy, ROOT));
    }
    assert.throws(() => validateEvidenceFile(path.join(ROOT, "nonexistent-live-evidence.json"), ROOT));
});
