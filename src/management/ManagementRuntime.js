// Account-local drain: no global system-busy flag and no credential lock
// while browser cleanup is awaited.
class ManagementRuntime {
    constructor(system) {
        this.system = system;
        this.holds = new Map();
    }

    isBlocked(index) {
        return (this.holds.get(index) || 0) > 0;
    }

    blockAccount(index) {
        if (!Number.isSafeInteger(index) || index < 0) throw this._error("INVALID_ACCOUNT", 400);
        this.holds.set(index, (this.holds.get(index) || 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const remaining = (this.holds.get(index) || 1) - 1;
            if (remaining) this.holds.set(index, remaining);
            else this.holds.delete(index);
        };
    }

    hasActiveRequests(index) {
        return (
            (this.system.requestHandler.accountRouteState.get(index)?.inFlight || 0) > 0 ||
            this.system.connectionRegistry.hasMessageQueueForAuth(index)
        );
    }

    async closeAccount(index, { force = false } = {}) {
        if (!this.isBlocked(index)) throw this._error("ACCOUNT_NOT_BLOCKED", 409);
        if (this.hasActiveRequests(index) && force !== true) throw this._error("ACCOUNT_DRAINING", 409);
        if (force === true) this.system.connectionRegistry.closeMessageQueuesForAuth(index, "management_force");
        await this.system.browserManager.closeContext(index);
        this.system.connectionRegistry.closeConnectionByAuth(index);
    }

    rebalance() {
        return this.system.browserManager.rebalanceContextPool();
    }

    _error(code, status) {
        return Object.assign(new Error("Account maintenance cannot proceed until requests are drained."), {
            code,
            status,
        });
    }
}

module.exports = ManagementRuntime;
