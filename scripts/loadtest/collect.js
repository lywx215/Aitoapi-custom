const fs = require("node:fs");
const path = require("node:path");
const { Monitor } = require("./monitor");

async function main() {
    const index = process.argv.indexOf("--output-dir");
    const outputDir = path.resolve(process.argv[index + 1]);
    const allowed = path.resolve(__dirname, "../../artifacts/loadtest") + path.sep;
    if (!outputDir.startsWith(allowed)) throw new Error("invalid_directory");
    let raw = "";
    for await (const chunk of process.stdin) {
        raw += chunk.toString("utf8");
        if (raw.length > 16384) throw new Error("invalid_secret_pipe");
    }
    const secret = JSON.parse(raw);
    const monitor = new Monitor({ managementKey: secret.managementKey, origin: "https://aib.zeabur.app", outputDir });
    raw = "";
    secret.managementKey = null;
    secret.modelKey = null;
    try {
        while (!fs.existsSync(path.join(outputDir, "STOP-COLLECTORS"))) {
            const result = await monitor.collectUsage("periodic");
            console.log(
                JSON.stringify({
                    available: result.available,
                    event: "usage_collected",
                    missing: result.coverage?.missing,
                    recordsSaved: result.recordsSaved,
                })
            );
            for (let second = 0; second < 30 && !fs.existsSync(path.join(outputDir, "STOP-COLLECTORS")); second++)
                await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } finally {
        await monitor.stop();
    }
}
main().catch(() => {
    console.error("usage_collection_failed");
    process.exitCode = 1;
});
