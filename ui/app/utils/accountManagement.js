export const hasCooldown = (account, now = Date.now()) =>
    new Date(account.route?.cooldownUntil || 0).getTime() > now ||
    (account.route?.cooldownModels || []).some(item => new Date(item.until).getTime() > now);

export function filterAccounts(accounts, query, status, now = Date.now()) {
    const needle = query.trim().toLowerCase();
    return accounts.filter(account => {
        if (needle && !`${account.index} #${account.index} ${account.name || ''}`.toLowerCase().includes(needle))
            return false;
        switch (status) {
            case 'enabled':
                return !account.isDisabled && !account.isExpired && !account.isInvalid && !account.isDuplicate;
            case 'disabled':
                return account.isDisabled;
            case 'expired':
                return account.isExpired;
            case 'invalid':
                return account.isInvalid;
            case 'duplicate':
                return account.isDuplicate;
            case 'cooldown':
                return hasCooldown(account, now);
            default:
                return true;
        }
    });
}

export function testSkipReason(account) {
    if (account.isInvalid) return 'amSkipInvalid';
    if (account.isDuplicate) return 'amSkipDuplicate';
    if (account.isExpired) return 'amSkipExpired';
    if (account.isDisabled) return 'amSkipDisabled';
    return '';
}

// A disconnected mutation may already have been committed. Never label it retryable.
export async function requestAccountJson(url, method, body, fetcher = fetch) {
    let response;
    try {
        response = await fetcher(url, {
            body: body === undefined ? undefined : JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
            method,
            redirect: 'error',
        });
    } catch {
        throw Object.assign(new Error('amConnectionLost'), { halt: true, unknown: true });
    }
    if (response.redirected) {
        throw Object.assign(new Error('amSessionExpired'), { halt: true, unknown: false });
    }
    let data;
    try {
        data = await response.json();
    } catch {
        if (response.status === 401 || response.status === 403) {
            throw Object.assign(new Error('amSessionExpired'), { halt: true, unknown: false });
        }
        throw Object.assign(new Error('amUnknownResult'), { halt: true, unknown: true });
    }
    // The test endpoint can return upstream 401/403 for an individual account.
    // These are account failures, not expiration of the console session.
    const accountTestFailure = url.endsWith('/test') && Number.isInteger(data?.authIndex) && data?.success === false;
    if ((response.status === 401 || response.status === 403) && !accountTestFailure) {
        throw Object.assign(new Error('amSessionExpired'), { halt: true, unknown: false });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw Object.assign(new Error('amUnknownResult'), { halt: true, unknown: true });
    }
    return { data, ok: response.ok, status: response.status };
}

export function classifyAccountResult({ data, ok, status }) {
    const message = data.message || data.error || `HTTP ${status}`;
    if (data.persisted === true && (data.cleanupComplete === false || data.success === false)) {
        return { message: data.message || data.error || 'amCleanupHint', state: 'cleanup' };
    }
    if (ok && data.success !== false) {
        return data.success === true || data.message || data.persisted === true
            ? { message: data.message || '', state: 'success' }
            : { message: 'amUnknownResult', state: 'unknown' };
    }
    if (status >= 500 && data.persisted !== false && data.success !== false) {
        return { message, state: 'unknown' };
    }
    return { message, state: 'failed' };
}

export function classifyDeletedAccount(index, { data, ok, status }) {
    if (data.cleanupPendingIndices?.some(item => (item.index ?? item) === index)) {
        return { message: 'amCleanupHint', state: 'cleanup' };
    }
    if (data.successIndices?.includes(index)) return { message: '', state: 'success' };
    const failed = data.failedIndices?.find(item => item.index === index);
    if (failed) return { message: failed.error, state: 'failed' };
    if (!ok) return classifyAccountResult({ data, ok, status });
    return { message: 'amUnknownResult', state: 'unknown' };
}

export async function runAccountQueue({ action, rows, getAccount, request = requestAccountJson, stopped, onProgress }) {
    for (const row of rows) {
        if (stopped()) break;
        const account = getAccount(row.index);
        const reason = !account ? 'amSkipMissing' : action === 'test' ? testSkipReason(account) : '';
        if (reason) {
            Object.assign(row, { message: reason, state: 'skipped' });
            onProgress?.();
            continue;
        }
        row.state = 'running';
        try {
            const result = await request(
                `/api/accounts/${row.index}/${action === 'test' ? 'test' : 'enabled'}`,
                action === 'test' ? 'POST' : 'PUT',
                action === 'test' ? undefined : { enabled: action === 'enable' }
            );
            Object.assign(row, classifyAccountResult(result));
        } catch (error) {
            Object.assign(row, { message: error.message, state: error.unknown ? 'unknown' : 'failed' });
            if (error.halt) break;
        } finally {
            onProgress?.();
        }
    }
    for (const row of rows) {
        if (row.state === 'pending') Object.assign(row, { message: 'amNotExecutedHint', state: 'unexecuted' });
    }
}
