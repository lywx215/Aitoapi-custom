// Legacy adapter delegates to the common store. Filesystem failure and bind
// mount scenarios are covered against the real store in runtimeSettingsStore.test.js.
const assert = require("assert");
const StatusRoutes = require("../../src/routes/StatusRoutes");

(async () => {
    const expected = { applied: true, persisted: true, values: { maxContexts: 3 } };
    let calls = 0;
    const context = {
        runtimeSettingsStore: {
            save: async () => {
                calls++;
                return expected;
            },
        },
    };
    assert.strictEqual(await StatusRoutes.prototype._saveRuntimeSettings.call(context), expected);
    assert.strictEqual(calls, 1);
    const failure = Object.assign(new Error("disk unavailable"), { code: "SETTINGS_PERSISTENCE_FAILED" });
    context.runtimeSettingsStore.save = async () => {
        throw failure;
    };
    await assert.rejects(StatusRoutes.prototype._saveRuntimeSettings.call(context), error => error === failure);
    console.log("runtimeSettingsSave: delegation and persistence failure propagation passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
