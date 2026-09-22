const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const AuthSource = require("../../src/auth/AuthSource");
const BrowserManager = require("../../src/core/BrowserManager");
const logger = { debug() {}, error() {}, info() {}, warn() {} };

(async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "management-integration-"));
    try {
        const authSource = new AuthSource(logger, { rootDir });
        const credentials = { accountName: "fixture@example.invalid", cookies: [], origins: [] };
        const created = await authSource.createAuth(credentials);
        let duringExport = async () => {};
        let exports = 0;
        const contextData = {
            context: {
                storageState: async () => {
                    exports++;
                    await duringExport();
                    return credentials;
                },
            },
            credentialVersion: created.credentialVersion,
        };
        const manager = {
            authSource,
            config: { enableAuthUpdate: true },
            contexts: new Map([[created.index, contextData]]),
            logger,
        };
        duringExport = () => authSource.disableAuth(created.index, { reason: "manual" });
        await BrowserManager.prototype._updateAuthFile.call(manager, created.index);
        assert.equal(authSource.store.read(created.index).disabled, true);
        assert.equal(contextData.credentialVersion, authSource.store.getMetadata(created.index).credentialVersion);
        // A context created from old credentials may not capture a newer version
        // and overwrite a replacement, even when replacement predates export.
        await authSource.replaceAuth(created.index, { ...credentials, accountName: "replacement@example.invalid" });
        const replacementVersion = authSource.store.getMetadata(created.index).credentialVersion;
        await BrowserManager.prototype._updateAuthFile.call(manager, created.index);
        assert.equal(exports, 1);
        assert.equal(authSource.store.getMetadata(created.index).credentialVersion, replacementVersion);
        assert.equal(authSource.store.read(created.index).accountName, "replacement@example.invalid");
        contextData.credentialVersion = replacementVersion;
        duringExport = () => authSource.removeAuth(created.index);
        await BrowserManager.prototype._updateAuthFile.call(manager, created.index);
        assert.equal(authSource.store.getMetadata(created.index), null);
        assert.equal(fs.existsSync(path.join(rootDir, "configs", "auth", `auth-${created.index}.json`)), false);
        console.log(
            "managementStorageIntegration: actual browser refresh adapter preserves disable, replacement and deletion"
        );
    } finally {
        assert.equal(path.dirname(rootDir), path.resolve(os.tmpdir()));
        assert.ok(path.basename(rootDir).startsWith("management-integration-"));
        fs.rmSync(rootDir, { force: true, recursive: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
