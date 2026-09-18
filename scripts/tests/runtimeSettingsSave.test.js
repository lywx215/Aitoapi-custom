
/**
 * runtimeSettingsSave.test.js
 * Verifies _saveRuntimeSettings survives single-file bind mount targets
 * (unlink => EBUSY) by falling back to in-place rewrite, and that the
 * normal rename path still works when the target is removable.
 * Extracts the real function body from src/routes/StatusRoutes.js so the
 * test fails if the implementation regresses.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const ROUTES = path.join(__dirname, "..", "..", "src", "routes", "StatusRoutes.js");

function extractSaveFn() {
    const src = fs.readFileSync(ROUTES, "utf8");
    const m = src.match(/async _saveRuntimeSettings\(\) \{[\s\S]*?\n    \}/);
    assert(m, "_saveRuntimeSettings not found in StatusRoutes.js");
    return m[0]
        .replace(/^async _saveRuntimeSettings\(\) \{/, "")
        .replace(/\n    \}$/, "");
}

function makeContext(target, codes) {
    return {
        config: {
            accountCooldownMaxMs: 1800000,
            accountCooldownMs: 300000,
            autoDisableStatusCodes: codes,
            maxContexts: 3,
            maxRetries: 3,
            retryDelay: 2000,
        },
        runtimeSettingsPath: target,
    };
}

function makeFs(rmBlocklist) {
    if (!rmBlocklist) return fs;
    return new Proxy(fs, {
        get(t, prop) {
            if (prop === "promises") {
                return new Proxy(t.promises, {
                    get(pt, p2) {
                        if (p2 === "rm") {
                            return async (p, opts) => {
                                if (rmBlocklist.includes(String(p))) {
                                    const e = new Error("resource busy or locked");
                                    e.code = "EBUSY";
                                    throw e;
                                }
                                return pt.rm(p, opts);
                            };
                        }
                        return pt[p2];
                    },
                });
            }
            return t[prop];
        },
    });
}

async function runScenario(name, rmBlocklist) {
    const fnBody = extractSaveFn();
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), `rtsave-${name}-`));
    const target = path.join(tmpdir, "runtime-settings.json");
    fs.writeFileSync(target, JSON.stringify({ stale: true }, null, 2) + "\n");
    const inoBefore = fs.statSync(target).ino;

    const ctx = makeContext(target, [401, 403, 503]);
    const fn = new AsyncFunction("fs", "path", fnBody);
    await fn.call(ctx, makeFs(rmBlocklist ? [target] : null), path);

    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.deepStrictEqual(parsed.autoDisableStatusCodes, [401, 403, 503], `${name}: content updated`);
    assert.strictEqual(parsed.maxContexts, 3, `${name}: other keys preserved`);
    if (rmBlocklist) {
        assert.strictEqual(fs.statSync(target).ino, inoBefore, `${name}: inode preserved (bind mount stays valid)`);
    }
    assert(!fs.existsSync(target + ".tmp"), `${name}: tmp cleaned`);
    console.log(`PASS ${name}`);
}

(async () => {
    // Scenario 1: single-file bind mount — unlink raises EBUSY -> in-place rewrite fallback
    await runScenario("bindmount-ebusy", true);

    // Scenario 2: normal removable file — rename path still works
    await runScenario("normal-rename", null);
    console.log("runtimeSettingsSave: all scenarios passed");
})().catch(e => {
    console.error(e);
    process.exit(1);
});
