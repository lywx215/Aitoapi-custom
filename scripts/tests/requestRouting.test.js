const assert = require("assert");
const { EventEmitter } = require("events");
const BrowserManager = require("../../src/core/BrowserManager");
const RequestHandler = require("../../src/core/RequestHandler");
const UsageStatsService = require("../../src/core/UsageStatsService");
const { request, candidate } = require("./generationPipeline.test");

const makeHandler = () => {
    const connections = new Map([
        [
            0,
            {
                readyState: 1,
                send(payload) {
                    this.sent.push(payload);
                },
                sent: [],
            },
        ],
        [
            1,
            {
                readyState: 1,
                send(payload) {
                    this.sent.push(payload);
                },
                sent: [],
            },
        ],
    ]);

    const handler = Object.create(RequestHandler.prototype);
    handler.connectionRegistry = {
        getAllConnections: () => connections,
        getConnectionByAuth: authIndex => connections.get(authIndex),
    };
    handler.logger = { debug() {}, info() {}, warn() {} };
    handler.requestAuthBindings = new Map();
    handler.requestModelBindings = new Map();
    handler.requestRouteCursor = 0;
    handler.requestFailureCounts = new Map();
    handler.accountRouteState = new Map();
    handler.pendingUsageRotations = new Set();
    handler.usageRotationPromise = null;
    handler.accountDisableCleanup = new Map();
    handler.config = {
        accountCooldownMaxMs: 30000,
        accountCooldownMs: 1000,
        autoDisableStatusCodes: [401, 403],
        failureThreshold: 1,
        immediateSwitchStatusCodes: [429, 503],
    };
    handler.authSwitcher = {
        called: false,
        currentAuthIndex: 0,
        handleRequestFailureAndSwitch() {
            this.called = true;
            return { success: false };
        },
    };
    return { connections, handler };
};

const testRoundRobinAndBinding = () => {
    const { handler } = makeHandler();
    assert.deepStrictEqual([handler._selectRequestAuthIndex(), handler._selectRequestAuthIndex()], [0, 1]);

    handler._bindRequestAuthIndex("request-1", 0);
    handler.authSwitcher.currentAuthIndex = 1;
    assert.strictEqual(handler._getRequestAuthIndex("request-1"), 0);
    handler._releaseRequestAuthIndex("request-1");
    assert.strictEqual(handler._getRequestAuthIndex("request-1"), 1);
};

const testFailureDoesNotGloballySwitch = async () => {
    const { handler } = makeHandler();
    handler._bindRequestAuthIndex("request-2", 0);
    const result = await handler._handleRequestFailureScoped({ message: "busy", status: 429 }, "request-2");

    assert.strictEqual(result.success, true);
    assert.strictEqual(handler._getRequestAuthIndex("request-2"), 1);
    assert.strictEqual(handler.authSwitcher.called, false);
    assert.ok(handler.getAccountRouteStatus(0).cooldownUntil);
    assert.strictEqual(handler._selectRequestAuthIndex(), 1);
};

const testLeastLoadedTieBreak = () => {
    const { handler } = makeHandler();
    handler._bindRequestAuthIndex("long-stream", 0);
    assert.strictEqual(handler._selectRequestAuthIndex(), 1);
};

const test429QuarantinesAccount = () => {
    const { handler } = makeHandler();
    handler._markAccount429(0, { message: "rate limited", status: 429 });
    handler._markAccount429(1, { message: "rate limited", status: 429 });
    assert.strictEqual(handler._selectRequestAuthIndex(), -1);
    assert.ok(handler.getNextCooldownMs() > 0);
    return handler._handleRequestFailureScoped({ message: "rate limited", status: 429 }, "request-4").then(result => {
        assert.strictEqual(result.rateLimited, true);
        assert.strictEqual(handler.authSwitcher.called, false);
    });
};

const test429IsScopedToModel = () => {
    const { handler } = makeHandler();
    handler._markAccount429ForModel(0, "gemini-3.8-flash", { message: "flash quota", status: 429 });

    assert.strictEqual(handler._selectRequestAuthIndex([1], "gemini-3.8-flash"), -1);
    assert.strictEqual(handler._selectRequestAuthIndex([1], "gemini-3.7-flash"), 0);
    assert.ok(handler.getAccountRouteStatus(0).modelCooldowns["gemini-3.8-flash"]);
    assert.strictEqual(handler.getAccountRouteStatus(0).modelCooldowns["gemini-3.7-flash"], undefined);
};

const testModelNormalization = () => {
    const { handler } = makeHandler();
    assert.strictEqual(handler._normalizeRouteModel("models/gemini-3.8-flash-minimal-fake-search"), "gemini-3.8-flash");
    assert.strictEqual(handler._normalizeRouteModel("/gemini-3.7-flash(high)"), "gemini-3.7-flash");
};

const testModel429HelperQuarantinesOnlyModel = () => {
    const { handler } = makeHandler();
    handler._markImmediateRateLimitIfNeeded(0, "gemini-3.8-flash", { message: "quota", status: 429 });
    assert.strictEqual(handler._selectRequestAuthIndex([1], "gemini-3.8-flash"), -1);
    // v1.2.3+: a single upstream 429 also triggers the quota circuit breaker,
    // which disables the credential for every model until the quota window passes.
    assert.strictEqual(handler._selectRequestAuthIndex([1], "gemini-3.7-flash"), -1);
};

const testSuccessResetsTransientFailureState = () => {
    const { handler } = makeHandler();
    handler.requestFailureCounts.set(0, 2);
    handler.authSwitcher.failureCount = 2;
    handler._markAccountSuccess(0, "gemini-3.8-flash");
    assert.strictEqual(handler.requestFailureCounts.has(0), false);
    assert.strictEqual(handler.authSwitcher.failureCount, 0);
};

const testExpiredAndRemovedAccountsAreNotRouted = () => {
    const { handler } = makeHandler();
    handler.authSource = {
        availableIndices: [0, 1],
        isExpired: index => index === 1,
        isUnavailable: index => index === 1,
    };
    assert.strictEqual(handler._selectRequestAuthIndex(), 0);
    handler.authSource.availableIndices = [1];
    assert.strictEqual(handler._selectRequestAuthIndex(), -1);
};

const testConfiguredStatusAutoDisablesAccount = async () => {
    const { handler } = makeHandler();
    let disabled = null;
    handler.authSource = {
        availableIndices: [0, 1],
        disableAuth: async (index, metadata) => {
            disabled = { index, metadata };
            return true;
        },
        disabledIndices: [],
        isDisabled: () => false,
        isUnavailable: () => false,
    };
    handler.browserManager = { closeContext: async () => {} };
    handler.connectionRegistry.closeMessageQueuesForAuth = () => {};
    handler._autoDisableAccountForStatus(0, { status: 403 });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(disabled.index, 0);
    assert.strictEqual(disabled.metadata.status, 403);
};

const testModelScopedForbiddenDoesNotDisableAccount = async () => {
    const { handler } = makeHandler();
    let disableCount = 0;
    handler.authSource = {
        availableIndices: [0, 1],
        disableAuth: async () => {
            disableCount += 1;
            return true;
        },
        isDisabled: () => false,
        isUnavailable: () => false,
    };
    handler._autoDisableAccountForStatus(0, {
        message: "PERMISSION_DENIED: model is not available for this account",
        modelName: "gemini-3.5-flash",
        status: 403,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(disableCount, 0);
};

const testAutoDisableCleanupIsSingleFlight = async () => {
    const { handler } = makeHandler();
    let closeCount = 0;
    let disableCount = 0;
    handler.authSource = {
        availableIndices: [0, 1],
        disableAuth: async index => {
            disableCount += 1;
            handler.authSource.disabledIndices.push(index);
            return true;
        },
        disabledIndices: [],
        isDisabled: index => handler.authSource.disabledIndices.includes(index),
        isUnavailable: index => handler.authSource.disabledIndices.includes(index),
    };
    handler.browserManager = {
        async _withContextPoolMutation(task) {
            return task();
        },
        async closeContext() {
            closeCount += 1;
        },
        async launchOrSwitchContext() {},
        async rebalanceContextPool() {},
    };
    handler.connectionRegistry.closeMessageQueuesForAuth = () => {};
    handler.connectionRegistry.closeConnectionByAuth = () => {};
    handler._selectRequestAuthIndex = () => -1;

    handler._autoDisableAccountForStatus(0, { status: 403 });
    handler._autoDisableAccountForStatus(0, { status: 403 });
    await handler.accountDisableCleanup.get(0);

    assert.strictEqual(disableCount, 1);
    assert.strictEqual(closeCount, 1);
};

const testAlreadyDisabledAccountStillGetsCleanup = async () => {
    const { handler } = makeHandler();
    let closeCount = 0;
    handler.authSource = {
        availableIndices: [0, 1],
        disableAuth: async () => {
            throw new Error("should not rewrite an already disabled credential");
        },
        isDisabled: () => true,
        isUnavailable: () => true,
    };
    handler.browserManager = {
        async _withContextPoolMutation(task) {
            return task();
        },
        async closeContext() {
            closeCount += 1;
        },
        async rebalanceContextPool() {},
    };
    handler.connectionRegistry.closeMessageQueuesForAuth = () => {};
    handler.connectionRegistry.closeConnectionByAuth = () => {};
    handler._selectRequestAuthIndex = () => -1;

    handler._autoDisableAccountForStatus(0, { status: 403 });
    await handler.accountDisableCleanup.get(0);
    assert.strictEqual(closeCount, 1);
};

const testTodayAccountModelStats = () => {
    const service = Object.create(UsageStatsService.prototype);
    service.enabled = true;
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    service.records = [
        { finalAuthIndex: 7, finishedAt: now.toISOString(), model: "gemini-a", outcome: "success" },
        { finalAuthIndex: 7, finishedAt: now.toISOString(), model: "gemini-a", outcome: "error" },
        { finalAuthIndex: 7, finishedAt: now.toISOString(), model: "gemini-b", outcome: "success" },
        { finalAuthIndex: 7, finishedAt: yesterday.toISOString(), model: "gemini-a", outcome: "error" },
    ];
    const stats = service.getTodayAccountStats(now)["7"];
    assert.strictEqual(stats.successCount, 2);
    assert.strictEqual(stats.failureCount, 1);
    assert.deepStrictEqual(
        stats.models.find(item => item.model === "gemini-a"),
        {
            failureCount: 1,
            model: "gemini-a",
            successCount: 1,
            totalCount: 2,
        }
    );
};

const testForwardUsesSelectedAccount = () => {
    const { handler, connections } = makeHandler();
    handler._forwardRequest({ request_attempt_id: "attempt-1", request_id: "request-3" }, 1);
    assert.strictEqual(connections.get(0).sent.length, 0);
    assert.strictEqual(connections.get(1).sent.length, 1);
    assert.strictEqual(JSON.parse(connections.get(1).sent[0]).request_id, "request-3");
};

const testAccountTestPreservesActiveCooldown = async () => {
    const { handler } = makeHandler();
    const page = {
        isClosed: () => false,
    };
    handler.authSource = { availableIndices: [0] };
    handler.browserManager = {
        async _checkPageStatusAndErrors() {},
        contexts: new Map([[0, { page }]]),
        launchCalls: 0,
        async launchOrSwitchContext() {
            this.launchCalls += 1;
        },
    };
    handler._markAccount429(0, { message: "rate limited", status: 429 });
    const before = handler.getAccountRouteStatus(0);

    const result = await handler.testAccount(0);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.cooldownPreserved, true);
    assert.strictEqual(handler.browserManager.launchCalls, 0);
    assert.strictEqual(handler.getAccountRouteStatus(0).cooldownUntil, before.cooldownUntil);
};

const testReadyCheckMovesQueuedRequestOffCooldownAccount = async () => {
    const { handler } = makeHandler();
    handler.browserManager = { notifyUserActivity() {} };
    handler._markTrackedEarlyExitIfNeeded = () => {};
    handler._sendErrorResponse = () => {
        throw new Error("unexpected error response");
    };
    handler._bindRequestAuthIndex("request-5", 0);
    handler._markAccount429(0, { message: "rate limited", status: 429 });

    const response = {
        setHeader() {},
    };
    const ready = await handler._ensureBrowserBackedRequestReady(response, {
        authIndex: 0,
        requestId: "request-5",
    });

    assert.strictEqual(ready, true);
    assert.strictEqual(handler._getRequestAuthIndex("request-5"), 1);
};

const makeFullRateLimitedPool = () => {
    const { handler, connections } = makeHandler();
    handler.config.maxContexts = 2;
    handler.authSource = { availableIndices: [0, 1, 2], getRotationIndices: () => [0, 1, 2] };
    handler.browserManager = Object.create(BrowserManager.prototype);
    Object.assign(handler.browserManager, {
        async _closeContextForPoolIfPossible(index) {
            this.contexts.delete(index);
            connections.delete(index);
        },
        _contextInitPromises: new Map(),
        async _initializeContext(index) {
            this.initializingContexts.delete(index);
            this.contexts.set(index, {});
            connections.set(index, { readyState: 1 });
        },
        authSource: handler.authSource,
        browser: {},
        config: handler.config,
        contexts: new Map([
            [0, {}],
            [1, {}],
        ]),
        initializingContexts: new Set(),
        logger: handler.logger,
        notifyUserActivity() {},
    });
    for (const index of [0, 1]) handler._markAccount429ForModel(index, "gemini-test", { status: 429 });
    handler._sendErrorResponse = (res, status) => {
        res.statusCode = status;
    };
    handler._markTrackedEarlyExitIfNeeded = () => {};
    return { connections, handler };
};

const testFullCooldownPoolWarmsStandbyForNewRequest = async () => {
    const { handler } = makeFullRateLimitedPool();
    handler.requestModelBindings.set("new-request", "gemini-test");
    const res = { setHeader() {} };
    assert.strictEqual(
        await handler._ensureBrowserBackedRequestReady(res, {
            authIndex: -1,
            requestId: "new-request",
        }),
        true,
        "A full cooled pool must replace a context before admitting a new request"
    );
    assert.strictEqual(handler._getRequestAuthIndex("new-request"), 2);
    assert.strictEqual(handler.browserManager.contexts.size, 2);
};

const test429RetryWarmsStandbyForBoundRequest = async () => {
    const { handler } = makeFullRateLimitedPool();
    handler._bindRequestAuthIndex("retry-request", 1);
    const tracker = handler._createImmediateSwitchTracker(1, "gemini-test");
    tracker.attemptedAuthIndices.add(0);
    assert.strictEqual(
        await handler._prepareImmediateStatusRetry({ status: 429 }, "retry-request", tracker, 1),
        true,
        "The ordinary bound-account retry must warm a standby after a 429"
    );
    assert.strictEqual(handler._getRequestAuthIndex("retry-request"), 2);
    assert.strictEqual(tracker.attemptedAuthIndices.has(2), true);
};

const testUnlimitedCooldownPoolKeepsExistingContexts = async () => {
    const { handler } = makeFullRateLimitedPool();
    handler.config.maxContexts = 0;
    assert.strictEqual(await handler._warmStandbyForModel("gemini-test"), true);
    assert.strictEqual(handler.browserManager.contexts.size, 3);
    assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-test"), 2);
    assert.strictEqual(handler._selectRequestAuthIndex([2], "another-model") >= 0, true);
};

const testConcurrentRetryAndNewRequestShareStandby = async () => {
    const { handler } = makeFullRateLimitedPool();
    handler._bindRequestAuthIndex("retry", 1);
    handler.requestModelBindings.set("new", "gemini-test");
    const outcomes = await Promise.all([
        handler._prepareImmediateStatusRetry(
            { status: 429 },
            "retry",
            handler._createImmediateSwitchTracker(1, "gemini-test"),
            1
        ),
        handler._ensureBrowserBackedRequestReady({ setHeader() {} }, { authIndex: -1, requestId: "new" }),
    ]);
    assert.deepStrictEqual(outcomes, [true, true]);
    assert.strictEqual(handler._getRequestAuthIndex("retry"), 2);
    assert.strictEqual(handler._getRequestAuthIndex("new"), 2);
    assert.strictEqual(handler.browserManager.contexts.size, 2);
};

const testCurrentBusySourceDrainsAfterStandbyReplacement = async () => {
    const { handler, connections } = makeFullRateLimitedPool();
    const manager = handler.browserManager;
    manager.currentAuthIndex = 1;
    manager.pendingContextClosures = new Map();
    let busy = true;
    manager._hasActiveQueueForAuth = index => index === 1 && busy;
    manager._closeContextForPoolIfPossible = BrowserManager.prototype._closeContextForPoolIfPossible;
    manager._activateContext = (_context, _page, index) => {
        manager.currentAuthIndex = index;
    };
    manager.closeContext = async index => {
        manager.contexts.delete(index);
        connections.delete(index);
    };
    manager._isSystemBusy = () => true;
    assert.strictEqual(await handler._warmStandbyForModel("gemini-test", [1]), true);
    assert.strictEqual(manager.currentAuthIndex, 2);
    assert.strictEqual(manager.contexts.has(1), true, "Do not interrupt the old queue");
    busy = false;
    assert.strictEqual(await manager._closePendingContextIfIdle(1), true);
    assert.strictEqual(manager.contexts.size, 2);
};

const testBreakerCleanupAndStandbyRouting = async () => {
    for (const retry of [false, true]) {
        const { handler, connections } = makeFullRateLimitedPool();
        const disabled = new Set();
        handler.authSource.isUnavailable = index => disabled.has(index);
        handler.authSource.disableAuth = async index => {
            disabled.add(index);
            return true;
        };
        handler.browserManager.closeContext = async index => {
            handler.browserManager.contexts.delete(index);
            connections.delete(index);
        };
        handler.browserManager.rebalanceContextPool = async () => {};
        handler.browserManager.launchOrSwitchContext = async () => {};
        handler._bindRequestAuthIndex("race", 1);
        handler.requestModelBindings.set("race", "gemini-test");
        const cleanup = handler._quotaExhaustDisableAccount(1, { status: 429 });
        const routing = retry
            ? handler._prepareImmediateStatusRetry(
                  { status: 429 },
                  "race",
                  handler._createImmediateSwitchTracker(1, "gemini-test"),
                  1
              )
            : handler._ensureBrowserBackedRequestReady({ setHeader() {} }, { authIndex: 1, requestId: "race" });
        const [, ready] = await Promise.all([cleanup, routing]);
        assert.strictEqual(ready, true);
        assert.strictEqual(handler._getRequestAuthIndex("race"), 2);
        assert.strictEqual(handler.browserManager.contexts.size, 2);
        assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-test"), 2);
    }
};

const testGeneration429AlwaysReroutesWithoutLegacyBreaker = async () => {
    for (const spareAvailable of [true, false]) {
        const { handler } = makeFullRateLimitedPool();
        handler.serverSystem = {};
        handler.config.immediateSwitchStatusCodes = [];
        handler._bindRequestAuthIndex("r1", 1);
        for (const index of [0, 1, ...(spareAvailable ? [] : [2])])
            handler._markAccount429ForModel(index, "test", { status: 429 });
        let disables = 0;
        handler.authSource.disableAuth = async () => {
            disables++;
            return true;
        };
        const dispatched = [];
        const response = await request({
            configureHandler(pipelineHandler) {
                for (const method of [
                    "_getRequestAuthIndex",
                    "_createImmediateSwitchTracker",
                    "_markAccount429ForModel",
                    "_prepareImmediateStatusRetry",
                    "_shouldSwitchImmediatelyForStatus",
                    "_autoDisableAccountForStatus",
                    "_handleRequestFailureScoped",
                ])
                    pipelineHandler[method] = handler[method].bind(handler);
            },
            dispatch(queue, _proxy, attempt) {
                dispatched.push(handler._getRequestAuthIndex("r1"));
                if (attempt === 1) {
                    queue.enqueue({ error_code: "http_error", event_type: "error", status: 429 });
                } else {
                    queue.enqueue({
                        event_type: "response_headers",
                        headers: { "content-type": "text/event-stream" },
                        status: 200,
                    });
                    queue.enqueue({
                        data: `data: ${JSON.stringify(candidate([{ text: "ok" }], "STOP"))}\n\n`,
                        event_type: "chunk",
                    });
                    queue.enqueue({ type: "STREAM_END" });
                }
            },
            format: "gemini",
            maxRetries: 3,
        });
        assert.deepStrictEqual(dispatched, spareAvailable ? [1, 2] : [1]);
        assert.strictEqual(response.status, spareAvailable ? 200 : 429);
        assert.strictEqual(disables, 0, "Generation model cooldown must not call the legacy quota breaker");
    }
};

const testExhaustedStandbysDoNotReuseCooledCredentials = async () => {
    const { handler } = makeFullRateLimitedPool();
    handler._markAccount429ForModel(2, "gemini-test", { status: 429 });
    handler._bindRequestAuthIndex("exhausted", 1);
    const tracker = handler._createImmediateSwitchTracker(1, "gemini-test");
    assert.strictEqual(await handler._prepareImmediateStatusRetry({ status: 429 }, "exhausted", tracker, 1), false);
    assert.strictEqual(handler.browserManager.contexts.size, 2);
    assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-test"), -1);
    assert.strictEqual(handler.authSwitcher.called, false);
};

const testRoutingRejectionTracksModelWithoutGlobalAccountFallback = () => {
    const { handler } = makeHandler();
    let meta;
    handler._getUsageStatsService = () => ({
        startRequest: (_id, value) => {
            meta = value;
        },
    });
    handler._getAccountNameForIndex = () => null;
    handler._getClientIp = () => null;
    handler._startTrackedRequest(
        "rejected",
        {
            headers: {},
            method: "POST",
            path: "/v1beta/models/gemini-test:generateContent",
        },
        { apiFormat: "gemini" }
    );
    assert.strictEqual(meta.model, "gemini-test");
    assert.strictEqual(meta.initialAuthIndex, -1);
};

const testAtomicContextReplacementOrdersReadyBeforeClose = async () => {
    const events = [];
    const manager = Object.create(BrowserManager.prototype);
    manager.contexts = new Map([[0, {}]]);
    manager.ensureContextForAuth = async authIndex => {
        events.push(`ready:${authIndex}`);
        manager.contexts.set(authIndex, { context: {}, page: {} });
        return true;
    };
    manager._closeContextForPoolIfPossible = async authIndex => {
        events.push(`close:${authIndex}`);
        manager.contexts.delete(authIndex);
        return true;
    };
    manager.logger = { info() {} };
    manager._activateContext = () => {};

    const replaced = await manager.replaceContextForAuth(0, 5, { reason: "test" });
    assert.strictEqual(replaced, true);
    assert.deepStrictEqual(events, ["ready:5", "close:0"]);
    assert.strictEqual(manager.contexts.has(5), true);
};

const testRecoveryReselectsForModelAndChecksNewConnection = async () => {
    for (const healthy of [false, true]) {
        const { handler, connections } = makeHandler();
        connections.clear();
        handler.browserManager = { contexts: new Map([[0, {}]]), notifyUserActivity() {} };
        handler._bindRequestAuthIndex("recover", 0);
        handler.requestModelBindings.set("recover", "test");
        handler._handleBrowserRecovery = async () => {
            connections.set(1, { readyState: 1 });
            handler.authSwitcher.currentAuthIndex = 1;
            if (!healthy) handler._markAccount429ForModel(1, "test", { status: 429 });
            return true;
        };
        handler._sendErrorResponse = (res, status) => {
            res.statusCode = status;
        };
        handler._waitForSystemAndConnectionIfBusy = () => {
            throw new Error("Must check the new ready connection");
        };
        const res = {};
        assert.strictEqual(
            await handler._ensureBrowserBackedRequestReady(res, { authIndex: 0, requestId: "recover" }),
            healthy
        );
        assert.strictEqual(handler._getRequestAuthIndex("recover"), healthy ? 1 : 0);
        if (!healthy) assert.strictEqual(res.statusCode, 503);
    }
};

const testReplacementRechecksInsidePoolLock = async () => {
    for (const scenario of ["vacancy", "existing", "pointer", "failure"]) {
        const { handler } = makeFullRateLimitedPool();
        const manager = handler.browserManager;
        let unlock;
        manager._contextPoolMutationTail = new Promise(resolve => {
            unlock = resolve;
        });
        manager.currentAuthIndex = 0;
        manager._activateContext = (_ctx, _page, index) => {
            manager.currentAuthIndex = index;
        };
        const result = manager.replaceContextForAuth(0, 2, {
            activateIfSourceCurrent: true,
            replaceOnlyWhenFull: true,
        });
        if (scenario === "vacancy" || scenario === "existing") manager.contexts.delete(1);
        if (scenario === "existing") manager.contexts.set(2, {});
        if (scenario === "pointer") manager.currentAuthIndex = 1;
        if (scenario === "failure") manager.ensureContextForAuth = async () => false;
        unlock();
        assert.strictEqual(await result, scenario !== "failure");
        assert.strictEqual(manager.contexts.has(0), scenario !== "pointer");
        assert.strictEqual(manager.currentAuthIndex, scenario === "pointer" ? 1 : 0);
        assert.strictEqual(manager.contexts.size, 2);
    }
};

const testStandbyWaitCancellationDoesNotRunAbandonedWork = async () => {
    for (const abort of [false, true]) {
        const { handler } = makeFullRateLimitedPool();
        handler._selectRequestAuthIndex = () => -1;
        const calls = [];
        let unblock;
        handler._warmStandbyForModelUnlocked = async model => {
            calls.push(model);
            await new Promise(resolve => {
                unblock = resolve;
            });
            return true;
        };
        const first = handler._warmStandbyForModel("slow-model");
        await new Promise(setImmediate);
        handler.requestModelBindings.set("waiting", "other-model");
        const res = new EventEmitter();
        res.__generationDeadline = Date.now() + (abort ? 10000 : 25);
        handler._sendErrorResponse = (response, status) => {
            response.statusCode = status;
            response.writableEnded = true;
        };
        const waiting = handler._ensureBrowserBackedRequestReady(res, { authIndex: -1, requestId: "waiting" });
        if (abort) {
            res.destroyed = true;
            res.emit("close");
        }
        try {
            assert.strictEqual(await waiting, false);
            assert.strictEqual(res.__generationResult.code, abort ? "client_disconnect" : "preoutput_timeout");
            if (!abort) assert.strictEqual(res.statusCode, 504);
        } finally {
            unblock();
        }
        await first;
        await handler.standbyWarmupTail;
        assert.deepStrictEqual(calls, ["slow-model"]);
        assert.strictEqual(handler.requestAuthBindings.has("waiting"), false);
    }
};

const testGeneration429StandbyTimeoutIs504 = async () => {
    const { handler } = makeFullRateLimitedPool();
    handler.serverSystem = {};
    handler._bindRequestAuthIndex("r1", 1);
    for (const index of [0, 1]) handler._markAccount429ForModel(index, "test", { status: 429 });
    let unlock;
    handler.standbyWarmupTail = new Promise(resolve => {
        unlock = resolve;
    });
    let warmups = 0;
    handler._warmStandbyForModelUnlocked = async () => {
        warmups++;
        return true;
    };
    try {
        const result = await request({
            config: { generationPreoutputTimeoutMs: 30 },
            configureHandler(pipelineHandler) {
                for (const method of [
                    "_getRequestAuthIndex",
                    "_createImmediateSwitchTracker",
                    "_markAccount429ForModel",
                    "_prepareImmediateStatusRetry",
                    "_shouldSwitchImmediatelyForStatus",
                    "_autoDisableAccountForStatus",
                    "_handleRequestFailureScoped",
                ])
                    pipelineHandler[method] = handler[method].bind(handler);
            },
            dispatch(queue) {
                queue.enqueue({ error_code: "http_error", event_type: "error", status: 429 });
            },
            format: "gemini",
            maxRetries: 3,
        });
        assert.strictEqual(result.status, 504);
        assert.strictEqual(result.attemptNo, 1);
    } finally {
        unlock();
    }
    await handler.standbyWarmupTail;
    assert.strictEqual(warmups, 0);
    assert.strictEqual(handler._getRequestAuthIndex("r1"), 1);
};

const testNonCurrentStandbySurvivesRealDrainRebalance = async () => {
    for (const poolSize of [2, 3]) {
        const { handler, connections } = makeFullRateLimitedPool();
        const manager = handler.browserManager;
        handler.config.maxContexts = poolSize;
        handler.authSource.availableIndices = Array.from({ length: poolSize + 1 }, (_, index) => index);
        handler.authSource.getRotationIndices = () => handler.authSource.availableIndices;
        if (poolSize === 3) {
            manager.contexts.set(2, {});
            connections.set(2, { readyState: 1 });
            handler._markAccount429ForModel(2, "gemini-test", { status: 429 });
        }
        manager.currentAuthIndex = 0;
        manager.pendingContextClosures = new Map();
        manager.authSource.getCanonicalIndex = index => index;
        manager.abortBackgroundPreload = async () => {};
        manager._preloadBackgroundContexts = async () => {
            throw new Error("Should not reload the cooled window");
        };
        let busy = true;
        manager._hasActiveQueueForAuth = index => index === 1 && busy;
        manager._closeContextForPoolIfPossible = BrowserManager.prototype._closeContextForPoolIfPossible;
        manager.closeContext = async index => {
            manager.contexts.delete(index);
            connections.delete(index);
            manager.modelStandbyContexts?.delete(index);
        };
        manager._isSystemBusy = () => false;
        assert.strictEqual(await handler._warmStandbyForModel("gemini-test", [1]), true);
        assert.strictEqual(manager.currentAuthIndex, 0);
        assert.strictEqual(manager.contexts.size, poolSize + 1);
        busy = false;
        await manager._closePendingContextIfIdle(1);
        await manager._rebalancePromise;
        await manager.rebalanceContextPool();
        assert.deepStrictEqual([...manager.contexts.keys()].sort(), poolSize === 3 ? [0, 2, 3] : [0, 2]);
        assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-test"), poolSize);
    }
};

const testExistingInitializationIsReusedWithoutReplacement = async () => {
    const { handler } = makeFullRateLimitedPool();
    const manager = handler.browserManager;
    manager.contexts.delete(1);
    manager.currentAuthIndex = 0;
    manager.initializingContexts.add(2);
    manager._initializeContext = async () => {
        throw new Error("Duplicate initialization");
    };
    let activations = 0;
    manager._activateContext = () => {
        activations++;
    };
    const replacement = manager.replaceContextForAuth(0, 2, {
        activateIfSourceCurrent: true,
        preserveAsStandby: true,
        replaceOnlyWhenFull: true,
    });
    setImmediate(() => {
        manager.contexts.set(2, {});
        manager.initializingContexts.delete(2);
    });
    assert.strictEqual(await replacement, true);
    assert.deepStrictEqual([...manager.contexts.keys()].sort(), [0, 2]);
    assert.strictEqual(activations, 0);
    assert.strictEqual(manager.currentAuthIndex, 0);

    const next = makeFullRateLimitedPool();
    next.handler.config.maxContexts = 3;
    next.handler.browserManager.initializingContexts.add(2);
    next.handler.browserManager._initializeContext = async () => {
        throw new Error("Must reuse initialization");
    };
    const reuse = next.handler._warmStandbyForModel("gemini-test");
    setImmediate(() => {
        next.handler.browserManager.contexts.set(2, {});
        next.connections.set(2, { readyState: 1 });
        next.handler.browserManager.initializingContexts.delete(2);
    });
    assert.strictEqual(await reuse, true);
    assert.strictEqual(next.handler.browserManager.contexts.size, 3);
    assert.strictEqual(next.handler._selectRequestAuthIndex([], "gemini-test"), 2);
    assert.strictEqual(next.handler.browserManager._contextInitPromises.size, 0);
};

const testFailedStandbyAdvancesAndBacksOff = async () => {
    const { handler } = makeFullRateLimitedPool();
    const manager = handler.browserManager;
    handler.authSource.availableIndices = [0, 1, 2, 3];
    handler.authSource.getRotationIndices = () => [0, 1, 2, 3];
    const initialize = manager._initializeContext.bind(manager);
    const calls = [];
    manager._initializeContext = async index => {
        calls.push(index);
        if (index === 2) throw new Error("Transient initialization failure");
        return initialize(index);
    };
    assert.strictEqual(await handler._warmStandbyForModel("gemini-test", [], { deadline: Date.now() + 1000 }), true);
    assert.deepStrictEqual(calls, [2, 3]);
    assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-test"), 3);
    assert(handler.standbyWarmupFailures.get(2) > Date.now());
    assert.strictEqual(await handler._warmStandbyForModel("gemini-test", [3]), false);
    assert.deepStrictEqual(calls, [2, 3]);
};

const testLegacyStandbyFailureDoesNotWalkEntirePool = async () => {
    const { handler } = makeFullRateLimitedPool();
    handler.authSource.availableIndices = [0, 1, 2, 3];
    handler.authSource.getRotationIndices = () => [0, 1, 2, 3];
    const initialize = handler.browserManager._initializeContext.bind(handler.browserManager);
    const calls = [];
    handler.browserManager._initializeContext = async index => {
        calls.push(index);
        if (index === 2) throw new Error("First standby fails");
        return initialize(index);
    };
    assert.strictEqual(await handler._warmStandbyForModel("gemini-test"), false);
    assert.deepStrictEqual(calls, [2], "Unbounded legacy call may attempt only one candidate");
    assert.strictEqual(await handler._warmStandbyForModel("gemini-test"), true);
    assert.deepStrictEqual(calls, [2, 3], "Later request skips the backed-off failure");
};

const testPendingSourceCannotFundAnotherReplacement = async () => {
    const { handler } = makeFullRateLimitedPool();
    handler.authSource.availableIndices = [0, 1, 2, 3];
    handler.authSource.getRotationIndices = () => [0, 1, 2, 3];
    const manager = handler.browserManager;
    manager.pendingContextClosures = new Map();
    manager._hasActiveQueueForAuth = index => index === 1;
    manager._closeContextForPoolIfPossible = BrowserManager.prototype._closeContextForPoolIfPossible;
    handler._markAccount429ForModel(1, "another-model", { status: 429 });
    assert.strictEqual(await handler._warmStandbyForModel("gemini-test", [1]), true);
    assert.strictEqual(manager.pendingContextClosures.has(1), true);
    assert.strictEqual(manager.contexts.size, 3);
    assert.strictEqual(await handler._warmStandbyForModel("another-model", [0, 2]), false);
    assert.strictEqual(manager.contexts.size, 3);
    assert.strictEqual(manager.contexts.has(3), false);
    assert.strictEqual(handler.standbyWarmupFailures?.has(3) || false, false);
    assert.strictEqual(await manager.replaceContextForAuth(1, 3, { replaceOnlyWhenFull: true }), false);
    assert.strictEqual(manager.contexts.size, 3);
};

const testAbortedForeignInitializationDoesNotPenalizeCredential = async () => {
    const { handler } = makeFullRateLimitedPool();
    const manager = handler.browserManager;
    manager.initializingContexts.add(2);
    manager._waitForContextInit = async index => {
        manager.initializingContexts.delete(index);
    };
    assert.strictEqual(await handler._warmStandbyForModel("gemini-test"), false);
    assert.strictEqual(handler.standbyWarmupFailures?.has(2) || false, false);
    assert.strictEqual(await handler._warmStandbyForModel("gemini-test"), true);
    assert.strictEqual(handler._selectRequestAuthIndex([], "gemini-test"), 2);
};

const testPerAccountUsageRotation = async () => {
    const { handler, connections } = makeHandler();
    handler.config.maxContexts = 5;
    handler.config.switchOnUses = 2;
    handler.authSource = {
        availableIndices: [0, 1, 2, 3, 4, 5],
        getRotationIndices: () => [0, 1, 2, 3, 4, 5],
        isExpired: () => false,
        isUnavailable: () => false,
    };
    handler.browserManager = {
        async closeContext(authIndex) {
            this.contexts.delete(authIndex);
            connections.delete(authIndex);
        },
        contexts: new Map([
            [0, {}],
            [1, {}],
            [2, {}],
            [3, {}],
            [4, {}],
        ]),
        async ensureContextForAuth(authIndex) {
            this.contexts.set(authIndex, {});
            connections.set(authIndex, { readyState: 1, send() {} });
            return true;
        },
        async replaceContextForAuth(sourceAuthIndex, targetAuthIndex) {
            await this.ensureContextForAuth(targetAuthIndex);
            await this.closeContext(sourceAuthIndex);
            return true;
        },
    };

    handler._bindRequestAuthIndex("pool-request", 0);
    handler._incrementGenerationUsage("pool-request", 0, "test generation");
    const beforeThreshold = handler.getAccountRouteStatus(0);
    assert.strictEqual(beforeThreshold.usageCount, 1);
    assert.strictEqual(beforeThreshold.usageExhausted, false);

    handler._incrementGenerationUsage("pool-request", 0, "test generation");
    assert.strictEqual(handler.getAccountRouteStatus(0).usageExhausted, true);
    handler._releaseRequestAuthIndex("pool-request");
    await handler.usageRotationPromise;

    assert.strictEqual(handler.browserManager.contexts.has(0), false);
    assert.strictEqual(handler.browserManager.contexts.has(5), true);
    assert.strictEqual(handler._selectRequestAuthIndex([], null), 1);
};

const testUsageThresholdFallsBackToHealthySingleAccount = async () => {
    const { handler, connections } = makeHandler();
    handler.config.maxContexts = 5;
    handler.config.switchOnUses = 1;
    handler.authSource = {
        availableIndices: [0],
        getRotationIndices: () => [0],
        isUnavailable: () => false,
    };
    handler.browserManager = { contexts: new Map([[0, {}]]) };
    handler._bindRequestAuthIndex("single-account", 0);
    handler._incrementGenerationUsage("single-account", 0, "test generation");
    handler._releaseRequestAuthIndex("single-account");
    await handler._flushPendingUsageRotations();

    assert.strictEqual(handler.getAccountRouteStatus(0).usageCount, 0);
    assert.strictEqual(handler.getAccountRouteStatus(0).usageExhausted, false);
    assert.strictEqual(connections.get(0).readyState, 1);
};

(async () => {
    testRoundRobinAndBinding();
    await testFailureDoesNotGloballySwitch();
    testLeastLoadedTieBreak();
    await test429QuarantinesAccount();
    test429IsScopedToModel();
    testModel429HelperQuarantinesOnlyModel();
    testSuccessResetsTransientFailureState();
    testExpiredAndRemovedAccountsAreNotRouted();
    testModelNormalization();
    await testConfiguredStatusAutoDisablesAccount();
    await testModelScopedForbiddenDoesNotDisableAccount();
    await testAutoDisableCleanupIsSingleFlight();
    await testAlreadyDisabledAccountStillGetsCleanup();
    testTodayAccountModelStats();
    testForwardUsesSelectedAccount();
    await testAccountTestPreservesActiveCooldown();
    await testReadyCheckMovesQueuedRequestOffCooldownAccount();
    await testFullCooldownPoolWarmsStandbyForNewRequest();
    await test429RetryWarmsStandbyForBoundRequest();
    await testUnlimitedCooldownPoolKeepsExistingContexts();
    await testConcurrentRetryAndNewRequestShareStandby();
    await testCurrentBusySourceDrainsAfterStandbyReplacement();
    await testBreakerCleanupAndStandbyRouting();
    await testGeneration429AlwaysReroutesWithoutLegacyBreaker();
    await testExhaustedStandbysDoNotReuseCooledCredentials();
    testRoutingRejectionTracksModelWithoutGlobalAccountFallback();
    await testAtomicContextReplacementOrdersReadyBeforeClose();
    await testRecoveryReselectsForModelAndChecksNewConnection();
    await testReplacementRechecksInsidePoolLock();
    await testStandbyWaitCancellationDoesNotRunAbandonedWork();
    await testGeneration429StandbyTimeoutIs504();
    await testNonCurrentStandbySurvivesRealDrainRebalance();
    await testExistingInitializationIsReusedWithoutReplacement();
    await testFailedStandbyAdvancesAndBacksOff();
    await testLegacyStandbyFailureDoesNotWalkEntirePool();
    await testPendingSourceCannotFundAnotherReplacement();
    await testAbortedForeignInitializationDoesNotPenalizeCredential();
    await testPerAccountUsageRotation();
    await testUsageThresholdFallsBackToHealthySingleAccount();
    console.log("request routing tests: PASS");
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
