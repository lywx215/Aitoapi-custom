/**
 * usageStatsLimit.test.js
 *
 * Verifies UsageStatsService.applyRecordsLimit: the dashboard records bound
 * that prevents the web UI from downloading the entire usage history.
 */
const assert = require("assert");
const UsageStatsService = require("../../src/core/UsageStatsService");

const upTo = n =>
    Array.from({ length: n }, (_, i) => ({ sequence: i + 1, requestId: `req_${i}` }));

const cases = [];
const check = (name, fn) => {
    try {
        fn();
        cases.push(`PASS ${name}`);
    } catch (error) {
        cases.push(`FAIL ${name}: ${error.message}`);
        process.exitCode = 1;
    }
};

check("empty snapshot stays empty", () => {
    const snap = UsageStatsService.createEmptySnapshot();
    const out = UsageStatsService.applyRecordsLimit(snap, 500);
    assert.strictEqual(out.records.length, 0);
    assert.strictEqual(out.totalRecords, 0);
    assert.strictEqual(out.recordsTruncated, false);
});

check("record count at limit is not truncated", () => {
    const snap = { records: upTo(500) };
    const out = UsageStatsService.applyRecordsLimit(snap, 500);
    assert.strictEqual(out.records.length, 500);
    assert.strictEqual(out.totalRecords, 500);
    assert.strictEqual(out.recordsTruncated, false);
});

check("records beyond limit are truncated newest-first", () => {
    const snap = { records: upTo(2000).reverse() }; // newest-first: seq 2000 is first
    const out = UsageStatsService.applyRecordsLimit(snap, 500);
    assert.strictEqual(out.records.length, 500);
    assert.strictEqual(out.totalRecords, 2000);
    assert.strictEqual(out.recordsTruncated, true);
    assert.strictEqual(out.records[0].sequence, 2000);
    assert.strictEqual(out.records[499].sequence, 1501);
});

check("explicit limit overrides default", () => {
    const snap = { records: upTo(1200) };
    const out = UsageStatsService.applyRecordsLimit(snap, 100);
    assert.strictEqual(out.records.length, 100);
    assert.strictEqual(out.recordsTruncated, true);
});

check("invalid/absent limit falls back to 500", () => {
    for (const bad of [undefined, null, "", "abc", "-3", "0"]) {
        const snap = { records: upTo(700) };
        const out = UsageStatsService.applyRecordsLimit(snap, bad);
        assert.strictEqual(out.records.length, 500, `limit=${bad}`);
        assert.strictEqual(out.recordsTruncated, true);
    }
});

check("null snapshot is tolerated", () => {
    assert.strictEqual(UsageStatsService.applyRecordsLimit(null, 500), null);
});

console.log(cases.join("\n"));
console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");