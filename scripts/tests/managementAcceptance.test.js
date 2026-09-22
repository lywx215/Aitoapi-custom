// Wave 1: real legacy service construction + HTTP boundary mocks, never a live
// management API/model acceptance claim. Run standalone because legacy uses cwd.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createHarness } = require("./fixtures/management/harness");
const { registerKeyPanelTests } = require("./fixtures/management/keyPanel");
const spec = require("../../docs/management-api-openapi.json");

const expectedRoutes = {
    "/accounts": ["get"],
    "/accounts/{id}": ["get", "patch"],
    "/accounts/{id}/archive": ["post"],
    "/accounts/{id}/credentials": ["put"],
    "/accounts/{id}/reload": ["post"],
    "/accounts/{id}/restore": ["post"],
    "/accounts/{id}/test": ["post"],
    "/accounts/batch": ["post"],
    "/accounts/export": ["post"],
    "/accounts/import": ["post"],
    "/audit": ["get"],
    "/settings": ["get", "patch"],
    "/system/readiness": ["get"],
    "/system/reload-auth": ["post"],
    "/system/status": ["get"],
    "/tasks": ["get"],
    "/tasks/{id}": ["get"],
    "/tasks/{id}/cancel": ["post"],
    "/usage": ["get"],
};
const pendingGates = [
    "W2-01 real management authentication: bearer only, scope matrix, session/model-key rejection, key lifecycle",
    "W2-02 real router mounting: JSON parser errors, server request IDs, namespace 404/405 and unchanged model fallback",
    "W2-03 two distinct fixture candidates through real import/task/account/verifier orchestration, attribution and autoenable",
    "W2-04 failed target cannot succeed through another account; isolated model result and no production registry/context mutation",
    "W2-05 idempotency canonical content/key isolation/concurrent retries; restart replay and 30-day retention",
    "W2-06 credential replacement/state races, version conflicts, duplicate email and archive/restore stable identity",
    "W2-07 cooperative cancel/revoke queued writes, committed work preserved, active account drain and explicit force",
    "W2-08 real settings store concurrent writers, disk failure, apply failure, restart semantics and bind-mount fallback",
    "W2-09 size limits, pagination, export permission and credential/token redaction in status/tasks/audit/errors",
];
const deferredLive = "LIVE-01 deferred by user: real two-account model evidence is outside this local-only round";

function resolveRef(value) {
    assert.ok(value.startsWith("#/"), `Only local references are allowed: ${value}`);
    return value
        .slice(2)
        .split("/")
        .reduce((item, key) => {
            assert.ok(item && Object.hasOwn(item, key), `Unresolved reference ${value}`);
            return item[key];
        }, spec);
}

function walk(value, visit) {
    if (!value || typeof value !== "object") return;
    visit(value);
    Object.values(value).forEach(child => walk(child, visit));
}

test("C01 OpenAPI route inventory, refs and per-route auth/task contracts", () => {
    assert.equal(spec.openapi, "3.0.3");
    assert.match(spec["x-implementation-status"], /wave-2 and live gates pending/);
    const expected = Object.fromEntries(
        Object.entries(expectedRoutes).map(([url, methods]) => ["/api/manage/v1" + url, methods])
    );
    expected["/api/management-keys"] = ["get", "post"];
    expected["/api/management-keys/{id}"] = ["delete"];
    assert.deepEqual(Object.keys(spec.paths).sort(), Object.keys(expected).sort());
    walk(spec, value => {
        if (value.$ref) resolveRef(value.$ref);
    });
    const identifiers = new Set();
    for (const [url, methods] of Object.entries(expected)) {
        assert.deepEqual(Object.keys(spec.paths[url]).sort(), methods.sort(), url);
        for (const method of methods) {
            const operation = spec.paths[url][method];
            assert.ok(!identifiers.has(operation.operationId), "Unique operationId");
            identifiers.add(operation.operationId);
            const isKey = url.startsWith("/api/management-keys");
            assert.deepEqual(operation.security, isKey ? [{ ConsoleSession: [] }] : [{ ManagementBearer: [] }]);
            assert.equal(operation["x-required-scopes"].length > 0, !isKey);
            operation["x-required-scopes"].forEach(scope =>
                assert.ok(spec.components.schemas.Scope.enum.includes(scope))
            );
            if (isKey) assert.equal(operation["x-required-session-auth-method"], "console_password");
            const parameters = operation.parameters.map(parameter => resolveRef(parameter.$ref));
            if (url.includes("{id}"))
                assert.ok(parameters.some(parameter => parameter.name === "id" && parameter.required));
            const idempotency = parameters.find(parameter => parameter.name === "Idempotency-Key");
            if (operation["x-response-mode"] === "task") {
                assert.ok(operation.responses[202]);
                assert.equal(idempotency.required, true);
                assert.deepEqual(operation.responses[202].content["application/json"].schema, {
                    $ref: "#/components/schemas/TaskAcceptedEnvelope",
                });
            } else assert.equal(idempotency, undefined);
            for (const status of [400, 401, 403, 404, 405, 409, 413, 429, 500]) {
                const response = resolveRef(operation.responses[status].$ref);
                assert.deepEqual(response.content["application/json"].schema, {
                    $ref: "#/components/schemas/ErrorEnvelope",
                });
            }
        }
    }
    assert.equal(identifiers.size, 24);
});

test("C02 OpenAPI limits, schemas, errors and token scope templates", () => {
    const schemas = spec.components.schemas;
    for (const [name, schema] of Object.entries(schemas)) {
        if (schema.required)
            schema.required.forEach(key => assert.ok(Object.hasOwn(schema.properties, key), `${name}.${key}`));
    }
    assert.deepEqual(schemas.TaskState.enum, [
        "queued",
        "running",
        "succeeded",
        "partial",
        "failed",
        "cancelled",
        "interrupted",
    ]);
    assert.equal(spec.components.parameters.Limit.schema.default, 50);
    assert.equal(spec.components.parameters.Limit.schema.maximum, 200);
    assert.equal(spec["x-limits"].bodyBytes, 10 * 1024 * 1024);
    assert.equal(schemas.Credentials["x-max-json-bytes"], 1024 * 1024);
    assert.equal(schemas.ImportRequest.properties.items.maxItems, 100);
    assert.equal(schemas.BatchRequest.properties.accountIds.maxItems, 100);
    assert.equal(schemas.TestRequest.properties.mode.default, "model");
    assert.equal(schemas.TestRequest.properties.model.default, "gemini-3.8-flash");
    for (const name of ["ImportRequest", "TestRequest"]) {
        const model = schemas[name].properties.model;
        assert.equal(model.minLength, 1);
        assert.equal(model.maxLength, 128);
        assert.equal(model.pattern, "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$");
    }
    const importItems = schemas.ImportRequest.properties.items;
    assert.equal(importItems.items.properties.clientRef.minLength, 1);
    assert.equal(importItems.items.properties.clientRef.maxLength, 128);
    assert.equal(importItems["x-unique-by"], "clientRef");
    assert.equal(schemas.Credentials.additionalProperties, false);
    assert.deepEqual(Object.keys(schemas.Credentials.properties).sort(), ["accountName", "cookies", "origins"]);
    for (const name of [
        "Account",
        "Task",
        "TaskItem",
        "AuditEntry",
        "ManagementKey",
        "SystemStatus",
        "VerificationResult",
    ]) {
        for (const secret of ["credentials", "cookies", "origins", "token", "tokenHash", "credentialState"]) {
            assert.ok(!Object.hasOwn(schemas[name].properties, secret), `${name} exposes ${secret}`);
        }
    }
    for (const code of schemas.ErrorCode.enum) {
        assert.match(code, /^[A-Z][A-Z0-9_]*$/);
        assert.ok(Object.hasOwn(spec["x-error-catalog"], code));
    }
    assert.equal(spec["x-error-catalog"].IDEMPOTENCY_CONFLICT.httpStatus, 409);
    assert.equal(spec["x-error-catalog"].VERIFICATION_FAILED.httpStatus, null);
    assert.deepEqual(spec["x-scope-templates"].admin, schemas.Scope.enum);
    for (const scope of ["accounts:export", "accounts:archive", "settings:write", "audit:read"]) {
        assert.ok(!spec["x-scope-templates"].operator.includes(scope));
    }
});

test("legacy real-service baseline with isolated fixtures (not wave-2 acceptance)", async t => {
    const originalCwd = process.cwd();
    const h = await createHarness();
    try {
        await t.test("B01 real AuthSource loads two different synthetic accounts from temporary files", () => {
            assert.deepEqual(h.system.authSource.availableIndices, [0, 1]);
            assert.notEqual(h.accounts[0].accountName, h.accounts[1].accountName);
            assert.notEqual(h.accounts[0].cookies[0].value, h.accounts[1].cookies[0].value);
            assert.equal(process.cwd(), h.rootDir);
            assert.deepEqual(h.system.authSource.getRotationIndices(), [0, 1]);
        });
        await t.test("B02 legacy routes preserve their authentication boundary and status metadata", async () => {
            assert.equal((await h.request("GET", "/api/status", undefined, false)).status, 401);
            const response = await h.request("GET", "/api/status");
            assert.equal(response.status, 200);
            assert.deepEqual(
                response.body.status.accountDetails.map(account => account.name),
                h.accounts.map(account => account.accountName)
            );
            const text = JSON.stringify(response.body);
            for (const account of h.accounts) assert.ok(!text.includes(account.cookies[0].value));
            assert.ok(!text.includes('"cookies"'));
        });
        await t.test("B03 real legacy testAccount checks both targets without moving current account", async () => {
            for (const index of [0, 1]) {
                const response = await h.request("POST", `/api/accounts/${index}/test`, {});
                assert.equal(response.status, 200);
                assert.equal(response.body.authIndex, index);
                assert.equal(response.body.success, true);
            }
            assert.deepEqual(
                h.calls.filter(call => call[0] === "pageCheck"),
                [
                    ["pageCheck", 0],
                    ["pageCheck", 1],
                ]
            );
            assert.equal(h.system.browserManager.currentAuthIndex, 0);
        });
        await t.test("B04 target without WebSocket fails even while the other account is connected", async () => {
            h.connections.delete(1);
            const before = h.calls.length;
            const response = await h.request("POST", "/api/accounts/1/test", {});
            assert.equal(response.status, 503);
            assert.equal(response.body.success, false);
            assert.equal(h.calls.length, before, "No other account page check or warming");
            assert.equal(h.connections.get(0).readyState, 1);
            assert.equal(h.system.browserManager.currentAuthIndex, 0);
            h.connections.set(1, { readyState: 1 });
        });
        await t.test(
            "B05 invalid/missing index fails before browser work; active cooldown survives connection success",
            async () => {
                assert.equal((await h.request("POST", "/api/accounts/nope/test", {})).status, 400);
                assert.equal((await h.request("POST", "/api/accounts/99/test", {})).status, 404);
                const state = h.system.requestHandler._getAccountRouteState(1);
                const until = Date.now() + 60000;
                state.cooldownUntil = until;
                const response = await h.request("POST", "/api/accounts/1/test", {});
                assert.equal(response.body.cooldownPreserved, true);
                assert.equal(state.cooldownUntil, until);
            }
        );
        await t.test(
            "B06 legacy disable persists and excludes target from rotation; busy mutation is rejected",
            async () => {
                h.system.requestHandler.authSwitcher.isSystemBusy = true;
                const blocked = await h.request("PUT", "/api/accounts/1/enabled", { enabled: false });
                assert.equal(blocked.status, 409);
                assert.equal(h.system.authSource.isDisabled(1), false);
                h.system.requestHandler.authSwitcher.isSystemBusy = false;
                const response = await h.request("PUT", "/api/accounts/1/enabled", { enabled: false });
                assert.equal(response.status, 200);
                assert.equal(h.system.authSource.isDisabled(1), true);
                assert.deepEqual(h.system.authSource.getRotationIndices(), [0]);
                const saved = JSON.parse(fs.readFileSync(path.join(h.rootDir, "configs/auth/auth-1.json"), "utf8"));
                assert.equal(saved.disabled, true);
                assert.equal(saved.disabledReason, "manual");
                assert.equal((await h.request("POST", "/api/accounts/1/test", {})).status, 409);
                assert.equal(h.system.browserManager.currentAuthIndex, 0);
                assert.ok(h.calls.some(call => call[0] === "closeQueues" && call[1] === 1));
            }
        );
        await t.test(
            "B07 real settings route validates and persists only runtime allowlist in temporary directory",
            async () => {
                const before = h.system.config.maxRetries;
                assert.equal((await h.request("PUT", "/api/settings/max-retries", { value: 0 })).status, 400);
                assert.equal(h.system.config.maxRetries, before);
                assert.equal((await h.request("PUT", "/api/settings/max-retries", { value: 4 })).status, 200);
                const saved = JSON.parse(fs.readFileSync(h.routes.runtimeSettingsPath, "utf8"));
                assert.equal(saved.maxRetries, 4);
                assert.deepEqual(
                    Object.keys(saved).sort(),
                    spec.components.schemas.SettingsSnapshot.properties.persistentKeys.items.enum.slice().sort()
                );
            }
        );
        await t.test("B08 real usage service preserves distinct account attribution and bounded history", async () => {
            const usage = h.system.usageStatsService;
            for (const index of [0, 1]) {
                const requestId = `synthetic-usage-${index}`;
                usage.startRequest(requestId, { initialAuthIndex: index, model: "fixture-model" });
                usage.recordAttempt(requestId, index);
                usage.finishRequest(requestId, {
                    finalAuthIndex: index,
                    outcome: index ? "error" : "success",
                    statusCode: index ? 503 : 200,
                });
            }
            await usage.appendPromise;
            const response = await h.request("GET", "/api/usage-stats?limit=1");
            assert.equal(response.status, 200);
            assert.equal(response.body.summary.totalRequests, 2);
            assert.equal(response.body.records.length, 1);
            assert.equal(response.body.records[0].finalAuthIndex, 1);
            assert.equal(response.body.records[0].outcome, "error");
            assert.deepEqual(response.body.accounts.map(account => account.authIndex).sort(), [0, 1]);
        });
    } finally {
        await h.close();
    }
    assert.equal(process.cwd(), originalCwd);
    assert.equal(fs.existsSync(h.rootDir), false);
});

registerKeyPanelTests(test);
for (const gate of pendingGates) test.todo(gate);
test.skip(deferredLive);
if (process.argv.includes("--require-local")) {
    test("local management acceptance gate", () => {
        assert.equal(pendingGates.length, 0, "LOCAL NOT ACCEPTED: real wave-2 integration gates remain pending.");
    });
}
if (process.argv.includes("--require-full")) {
    test("full management acceptance gate", () => {
        assert.equal(pendingGates.length, 0, "NOT ACCEPTED: real wave-2 integration gates remain pending.");
        assert.fail(deferredLive);
    });
}
