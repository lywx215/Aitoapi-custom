const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const workspace = process.cwd();
const records = [];
async function worker(instance) {
    const child = spawn(process.execPath, ["scripts/diagnostics/isolatedServer.js"], {
        cwd: workspace,
        env: {
            ...process.env,
            DIAG_DEPLOYMENT_ID: "replica-pool",
            DIAG_ENVIRONMENT: "test",
            DIAG_FIXTURE_PORT: "0",
            DIAG_INSTANCE_ID: instance,
            LOG_LEVEL: "DEBUG",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    const own = [];
    let pending = "",
        errors = "";
    child.stderr.on("data", data => {
        errors += data;
    });
    const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("Fixture did not start"));
        }, 10000);
        child.on("error", reject);
        child.once("exit", code => {
            clearTimeout(timer);
            if (code) reject(new Error(`Fixture exit ${code}: ${errors}`));
        });
        child.stdout.on("data", bytes => {
            pending += bytes.toString();
            let offset;
            while ((offset = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, offset).trimEnd();
                pending = pending.slice(offset + 1);
                if (line.startsWith("@diag ")) {
                    assert(Buffer.byteLength(line) + 1 <= 4096);
                    const record = JSON.parse(line.slice(6));
                    own.push(record);
                    records.push(record);
                } else {
                    const value = JSON.parse(line);
                    if (value.fixture) {
                        clearTimeout(timer);
                        resolve(value);
                    }
                }
            }
        });
    });
    return {
        ...ready,
        async close() {
            child.kill();
            await once(child, "exit");
            assert.equal(pending, "");
        },
        records: own,
    };
}
async function exercise(w) {
    const requests = await Promise.all(
        Array.from({ length: 4 }, () =>
            fetch(w.address + "/v1/chat/completions", {
                body: JSON.stringify({
                    messages: [{ content: "synthetic", role: "user" }],
                    model: "diag-usage87",
                    stream: false,
                }),
                headers: {
                    "content-type": "application/json",
                    traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
                    "x-request-id": "same-alias",
                },
                method: "POST",
            }).then(async res => {
                assert.equal(res.status, 200);
                const body = await res.json();
                assert.equal(body.usage.completion_tokens, 87);
                return res.headers.get("x-diag-request-id");
            })
        )
    );
    for (let i = 0; i < 100 && w.records.filter(r => r.event === "diag.server").length < 4; i++)
        await new Promise(resolve => setTimeout(resolve, 5));
    const servers = w.records.filter(r => r.event === "diag.server");
    assert.equal(servers.length, 4);
    assert(servers.every(r => requests.includes(r.requestId) && r.callerRequestId === "same-alias"));
    return servers[0];
}
async function main() {
    const a = await worker("instance-a");
    const b = await worker("instance-b");
    let first;
    try {
        const results = await Promise.all([exercise(a), exercise(b)]);
        first = results[0];
        assert.notEqual(results[0].instanceId, results[1].instanceId);
        assert.notEqual(results[0].bootId, results[1].bootId);
        const spans = records.filter(r => r.spanId).map(r => `${r.instanceId}/${r.bootId}/${r.spanId}/${r.logSeq}`);
        assert.equal(new Set(spans).size, spans.length);
    } finally {
        await a.close();
        await b.close();
    }
    const restarted = await worker("instance-a");
    try {
        const after = await exercise(restarted);
        assert.equal(after.instanceId, first.instanceId);
        assert.notEqual(after.bootId, first.bootId);
    } finally {
        await restarted.close();
    }
    fs.mkdirSync(path.join(workspace, "tmp"), { recursive: true });
    fs.writeFileSync(
        path.join(workspace, "tmp/diagnostics-processes.jsonl"),
        records.map(r => JSON.stringify(r)).join("\n") + "\n"
    );
    console.log(
        `diagnostics multi-process: 2 instances, restart, 12 real protocol replies, ${records.length} independently collected valid JSON lines passed`
    );
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
