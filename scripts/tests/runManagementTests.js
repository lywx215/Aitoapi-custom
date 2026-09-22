const { spawnSync } = require("node:child_process");
const path = require("node:path");

const tests = [
    "credentialStore",
    "runtimeSettingsStore",
    "runtimeSettingsSave",
    "managementStorageIntegration",
    "managementRuntime",
    "managementKeys",
    "managementTasks",
    "managementRoutes",
    "managementVerifier",
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
        { stdio: "inherit" }
    );
    if (result.error || result.status !== 0) {
        console.error(`FAILED: ${name}`);
        process.exit(result.status || 1);
    }
}
console.log("Local test scripts completed. Explicit TODO/live gates are not acceptance evidence.");
