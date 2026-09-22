const { spawnSync } = require("node:child_process");
const path = require("node:path");

const tests = [
    "credentialStore",
    "runtimeSettingsStore",
    "runtimeSettingsSave",
    "managementStorageIntegration",
    "managementRuntime",
    "managementStartup",
    "managementKeys",
    "managementTasks",
    "managementRoutes",
    "managementVerifier",
    "managementLiveHarness",
    "managementAcceptance",
    "requestRouting",
    "backgroundWakeup",
    "streamIntegrity",
    "modelSuffix",
    "quotaCircuitBreaker",
    "crashLoopQuarantine",
    "crashLoopAutoHeal",
    "autoHealIsolatedProbe",
    "upstreamImprovements",
    "usageStatsLimit",
];
for (const name of tests) {
    const result = spawnSync(
        process.execPath,
        [path.join(__dirname, `${name}.test.js`), ...(name === "managementAcceptance" ? ["--require-local"] : [])],
        name === "managementAcceptance" ? { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 } : { stdio: "inherit" }
    );
    if (name === "managementAcceptance") {
        process.stdout.write(result.stdout || "");
        process.stderr.write(result.stderr || "");
    }
    const pendingAcceptance = name === "managementAcceptance" && /# TODO|\btodo [1-9]/.test(result.stdout || "");
    if (result.error || result.status !== 0 || pendingAcceptance) {
        console.error(`FAILED: ${name}`);
        process.exit(result.status || 1);
    }
}
console.log("Local test scripts completed. Explicit TODO/live gates are not acceptance evidence.");
