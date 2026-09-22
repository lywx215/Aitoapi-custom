const assert = require("node:assert/strict");
const ManagementRuntime = require("../../src/management/ManagementRuntime");
const RequestHandler = require("../../src/core/RequestHandler");

(async () => {
    const closed = [];
    const connections = new Map([
        [0, { readyState: 1 }],
        [1, { readyState: 1 }],
    ]);
    const handler = Object.create(RequestHandler.prototype);
    const system = {
        browserManager: {
            closeContext: async index => closed.push(["context", index]),
            rebalanceContextPool: async () => {},
        },
        connectionRegistry: {
            closeConnectionByAuth: index => closed.push(["connection", index]),
            closeMessageQueuesForAuth: index => closed.push(["force", index]),
            getAllConnections: () => connections,
            getConnectionByAuth: index => connections.get(index),
            hasMessageQueueForAuth: () => false,
        },
        requestHandler: handler,
    };
    const runtime = new ManagementRuntime(system);
    Object.assign(handler, {
        accountRouteState: new Map(),
        authSource: { availableIndices: [0, 1] },
        config: {},
        connectionRegistry: system.connectionRegistry,
        requestAuthBindings: new Map(),
        requestModelBindings: new Map(),
        requestRouteCursor: 0,
        serverSystem: { managementRuntime: runtime },
    });
    handler._isInWsCrashLoop = () => false;
    handler._isPerAccountUsageRoutingEnabled = () => false;
    handler._isAuthUnavailable = () => false;
    handler._bindRequestAuthIndex("existing", 0);
    const releaseA = runtime.blockAccount(0);
    const releaseB = runtime.blockAccount(0);
    assert.equal(handler._selectRequestAuthIndex(), 1);
    assert.throws(() => handler._bindRequestAuthIndex("new", 0), { code: "ACCOUNT_DRAINING" });
    handler._bindRequestAuthIndex("existing", 0);
    assert.equal(handler.accountRouteState.get(0).inFlight, 1);
    await assert.rejects(runtime.closeAccount(0), { code: "ACCOUNT_DRAINING" });
    assert.deepEqual(closed, []);
    releaseA();
    releaseA();
    assert.equal(runtime.isBlocked(0), true);
    handler._releaseRequestAuthIndex("existing");
    assert.equal(runtime.hasActiveRequests(0), false);
    await runtime.closeAccount(0);
    assert.deepEqual(closed, [
        ["context", 0],
        ["connection", 0],
    ]);
    releaseB();
    assert.equal(runtime.isBlocked(0), false);
    await assert.rejects(runtime.closeAccount(1), { code: "ACCOUNT_NOT_BLOCKED" });
    assert.equal(connections.get(1).readyState, 1);
    console.log(
        "managementRuntime: account-local drain, overlapping holds, existing requests and no forced close passed"
    );
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
