export function credentialRequestId() {
    // getRandomValues also works on HTTP consoles outside secure contexts.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function credentialRetryIndices(run, accounts) {
    const existing = new Set(accounts.map(account => account.index));
    return (run?.results || [])
        .filter(
            row =>
                existing.has(row.index) &&
                !row.modelVerified &&
                row.errorCode !== 'version_conflict' &&
                ['failed', 'interrupted'].includes(row.state)
        )
        .map(row => row.index);
}
