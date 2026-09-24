/* global document, window, localStorage */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");

const root = path.resolve(__dirname, "../..");
const rowsFor = indices => indices.map(index => ({ index, state: "pending" }));
const ok = data => ({ data, ok: true, status: 200 });

async function logicTests() {
    const source = fs.readFileSync(path.join(root, "ui/app/utils/accountManagement.js"), "utf8");
    const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const accounts = [
        { index: 0, name: "Alpha@example.test" },
        { index: 1, isDisabled: true, name: "Beta@example.test" },
        { index: 2, isExpired: true },
        { index: 3, isInvalid: true },
        { index: 4, isDuplicate: true },
        { index: 5, route: { cooldownModels: [{ until: 3000 }] } },
    ];
    assert.deepEqual(
        api.filterAccounts(accounts, "ALPHA", "all").map(row => row.index),
        [0]
    );
    assert.deepEqual(
        api.filterAccounts(accounts, "#1", "disabled").map(row => row.index),
        [1]
    );
    assert.deepEqual(
        api.filterAccounts(accounts, "", "enabled").map(row => row.index),
        [0, 5]
    );
    assert.deepEqual(
        api.filterAccounts(accounts, "", "cooldown", 2000).map(row => row.index),
        [5]
    );
    assert.equal(api.filterAccounts(accounts, "", "cooldown", 4000).length, 0);
    for (const [index, reason] of [
        [1, "amSkipDisabled"],
        [2, "amSkipExpired"],
        [3, "amSkipInvalid"],
        [4, "amSkipDuplicate"],
    ]) {
        assert.equal(api.testSkipReason(accounts[index]), reason);
    }
    assert.equal(api.classifyAccountResult(ok({ success: false })).state, "failed");
    assert.equal(
        api.classifyAccountResult(ok({ cleanupComplete: false, persisted: true, success: false })).state,
        "cleanup"
    );
    assert.equal(api.classifyAccountResult({ data: {}, ok: false, status: 500 }).state, "unknown");
    const deletion = {
        data: { cleanupPendingIndices: [0], failedIndices: [{ error: "disk", index: 2 }], successIndices: [0, 1] },
        ok: true,
        status: 207,
    };
    assert.equal(api.classifyDeletedAccount(0, deletion).state, "cleanup");
    assert.equal(api.classifyDeletedAccount(1, deletion).state, "success");
    assert.equal(api.classifyDeletedAccount(2, deletion).state, "failed");
    assert.equal(api.classifyDeletedAccount(3, deletion).state, "unknown");

    let calls = [];
    const getAccount = index => accounts.find(account => account.index === index);
    const rows = rowsFor([0, 1, 2, 3, 4, 5, 99]);
    await api.runAccountQueue({
        action: "test",
        getAccount,
        request: async url => {
            calls.push(url);
            return ok({ success: true });
        },
        rows,
        stopped: () => false,
    });
    assert.deepEqual(calls, ["/api/accounts/0/test", "/api/accounts/5/test"]);
    assert.deepEqual(
        rows.map(row => row.state),
        ["success", "skipped", "skipped", "skipped", "skipped", "success", "skipped"]
    );

    calls = [];
    let active = 0;
    const mixedRows = rowsFor([0, 1, 2]);
    await api.runAccountQueue({
        action: "disable",
        getAccount,
        request: async (url, method, body) => {
            assert.equal(++active, 1, "Mutations must be serial");
            assert.equal(method, "PUT");
            assert.deepEqual(body, { enabled: false });
            calls.push(url);
            await Promise.resolve();
            active--;
            return calls.length === 1
                ? ok({ cleanupComplete: false, persisted: true, success: false })
                : calls.length === 2
                  ? { data: { success: false }, ok: false, status: 409 }
                  : ok({ success: true });
        },
        rows: mixedRows,
        stopped: () => false,
    });
    assert.deepEqual(
        mixedRows.map(row => row.state),
        ["cleanup", "failed", "success"]
    );

    let stop = false;
    const stoppedRows = rowsFor([0, 1, 5]);
    await api.runAccountQueue({
        action: "enable",
        getAccount,
        request: async () => {
            stop = true;
            return ok({ success: true });
        },
        rows: stoppedRows,
        stopped: () => stop,
    });
    assert.deepEqual(
        stoppedRows.map(row => row.state),
        ["success", "unexecuted", "unexecuted"]
    );

    for (const unknown of [true, false]) {
        const disconnectedRows = rowsFor([0, 1]);
        await api.runAccountQueue({
            action: "enable",
            getAccount,
            request: async () => {
                throw Object.assign(new Error("disconnected"), { halt: true, unknown });
            },
            rows: disconnectedRows,
            stopped: () => false,
        });
        assert.deepEqual(
            disconnectedRows.map(row => row.state),
            [unknown ? "unknown" : "failed", "unexecuted"]
        );
    }
    await assert.rejects(
        api.requestAccountJson("/fixture", "PUT", {}, async () => {
            throw new Error("offline");
        }),
        error => error.halt && error.unknown
    );
    await assert.rejects(
        api.requestAccountJson("/fixture", "PUT", {}, async () => ({ status: 401 })),
        error => error.halt && !error.unknown
    );
    await assert.rejects(
        api.requestAccountJson("/fixture", "PUT", {}, async () => ({
            json: async () => {
                throw new Error("html");
            },
            status: 200,
        })),
        error => error.halt && error.unknown
    );
    const upstream = await api.requestAccountJson("/api/accounts/0/test", "POST", undefined, async () => ({
        json: async () => ({ authIndex: 0, success: false }),
        ok: false,
        status: 403,
    }));
    assert.equal(api.classifyAccountResult(upstream).state, "failed");
    await assert.rejects(
        api.requestAccountJson("/fixture", "PUT", {}, async () => ({ json: async () => null, status: 200 })),
        error => error.halt && error.unknown
    );
    assert.equal(api.classifyAccountResult(ok({})).state, "unknown");
    console.log(
        "Account logic: filters, cooldowns, skips, partial results, serial execution, stop, and session/network failures passed."
    );
}

async function browserTests() {
    const express = require("express");
    const JSZip = require("jszip");
    const { chromium } = require("playwright");
    const StatusRoutes = require("../../src/routes/StatusRoutes");
    const app = express();
    app.use(express.json());
    let authorized = true;
    let accounts;
    const reset = () => {
        accounts = Array.from({ length: 45 }, (_, index) => ({
            index,
            name: `account${String(index).padStart(2, "0")}@example.test`,
            todayStats: {
                failureCount: index,
                models: [{ failureCount: 1, model: "gemini-fixture", successCount: 2 }],
                successCount: index * 2,
            },
        }));
    };
    reset();
    let changes = [];
    const tests = [];
    let delay = 0;
    let mode = "success";
    let deleteCalls = 0;
    let failStatus = false;
    app.get("/api/status", (req, res) =>
        !failStatus && authorized
            ? res.json({ logs: "", status: { accountDetails: accounts, currentAuthIndex: 0 } })
            : res.status(401).json({})
    );
    app.get("/api/usage-stats", (req, res) =>
        failStatus ? res.redirect(303, "/login") : res.json({ accounts: [], records: [], summary: {} })
    );
    app.get("/api/version/check", (req, res) => res.json({ hasUpdate: false }));
    app.get("/api/auth/config", (req, res) => res.json({}));
    app.get("/api/vnc/status", (req, res) => res.json({}));
    app.post("/api/vnc/sessions", (req, res) => res.json({}));
    app.delete("/api/vnc/sessions", (req, res) => res.json({}));
    app.post("/api/vnc/auth", (req, res) => res.json({ accountName: "fixture", message: "vncAuthSaveSuccess" }));
    app.put("/api/accounts/:index/enabled", async (req, res) => {
        const index = Number(req.params.index);
        changes.push(index);
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (mode === "network") {
            req.socket.destroy();
            return;
        }
        if (mode === "session") {
            res.status(401).json({});
            return;
        }
        if (mode === "mixed" && index === 1) {
            res.status(409).json({ message: "fixture failure", success: false });
            return;
        }
        accounts.find(row => row.index === index).isDisabled = !req.body.enabled;
        res.json(
            mode === "mixed" && index === 0
                ? { cleanupComplete: false, persisted: true, success: false }
                : { success: true }
        );
    });
    app.post("/api/accounts/:index/test", (req, res) => {
        tests.push(Number(req.params.index));
        res.json({ success: true });
    });
    app.put("/api/accounts/current", (req, res) => res.json({ message: "fixture switched", success: true }));
    app.post("/api/accounts/deduplicate", (req, res) =>
        res.json({ message: "fixture deduplicated", removedIndices: [], success: true })
    );
    app.delete("/api/accounts/batch", (req, res) => {
        deleteCalls++;
        if (req.body.indices.includes(0) && !req.body.force) {
            res.status(409).json({ requiresConfirmation: true });
            return;
        }
        const successIndices = req.body.indices.filter(index => index !== 2);
        accounts = accounts.filter(account => !successIndices.includes(account.index));
        res.status(207).json({
            cleanupPendingIndices: successIndices.includes(0) ? [0] : [],
            failedIndices: req.body.indices.includes(2) ? [{ error: "fixture disk error", index: 2 }] : [],
            successIndices,
        });
    });
    app.post("/api/accounts/batch/download", async (req, res) => {
        const zip = new JSZip();
        for (const index of req.body.indices.filter(index => index !== 2)) zip.file(`auth-${index}.json`, "{}");
        res.type("application/zip").send(await zip.generateAsync({ type: "nodebuffer" }));
    });
    app.get("/api/files/:filename", (req, res) => res.type("application/json").send("{}"));
    app.post("/api/files/batch", (req, res) =>
        res.json({
            results: req.body.files.map((_, index) => ({ filename: `auth-${100 + index}.json`, index, success: true })),
        })
    );
    app.use("/locales", express.static(path.join(root, "ui/locales")));
    app.use(express.static(path.join(root, "ui/dist"), { index: false }));
    app.get("/login", (req, res) => res.sendFile(path.join(root, "ui/dist/index.html")));
    // Exercise the production page route registration and its authentication middleware.
    StatusRoutes.prototype.setupRoutes.call(
        { distIndexPath: path.join(root, "ui/dist/index.html") },
        app,
        (req, res, next) => (authorized ? next() : res.redirect(303, "/login"))
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        authorized = false;
        const denied = await fetch(`${origin}/accounts`, { redirect: "manual" });
        assert.equal(denied.status, 303);
        assert.equal(denied.headers.get("location"), "/login");
        authorized = true;
        assert.equal((await fetch(`${origin}/accounts`)).status, 200);
        browser = await chromium.launch({
            channel: fs.existsSync(chromium.executablePath()) ? undefined : "chrome",
            headless: true,
        });
        const context = await browser.newContext({
            acceptDownloads: true,
            locale: "zh-CN",
            viewport: { height: 1000, width: 1440 },
        });
        // No request from the fixture browser may reach a production or external origin.
        await context.route("**/*", route => {
            if (route.request().url() === "https://esm.sh/@novnc/novnc@1.4.0/lib/rfb.js")
                return route.fulfill({
                    body: "export default class RFB { addEventListener(event, callback) { if(event === 'connect') setTimeout(callback, 0); } disconnect() {} }",
                    contentType: "application/javascript",
                });
            return route.request().url().startsWith(origin) ? route.continue() : route.abort();
        });
        await context.addInitScript(() => {
            localStorage.setItem("lang", "zh");
            localStorage.setItem("theme", "light");
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const check = async (condition, message) => {
            const deadline = Date.now() + 8000;
            while (!(await condition())) {
                if (Date.now() > deadline) throw new Error(message);
                await new Promise(resolve => setTimeout(resolve, 30));
            }
        };
        const button = name => page.getByRole("button", { exact: true, name });
        const confirm = () =>
            page.locator(".el-message-box").last().getByRole("button", { exact: true, name: "确定" }).click();
        const select = index =>
            page
                .getByRole("checkbox", { exact: true, name: `选择账号 #${index}` })
                .locator("..")
                .click();
        const search = page.getByPlaceholder("搜索编号或账号名称");
        const resultStates = () => page.locator(".result-row .el-tag").allTextContents();
        const resultText = () => page.locator(".results-panel").innerText();
        await page.goto(`${origin}/accounts`);
        await check(async () => (await page.locator("tbody tr").count()) === 20, "first page should show 20 accounts");
        await select(0);
        await page.locator(".el-pagination .btn-next").click();
        await select(20);
        assert.match(await page.locator(".selection-toolbar").innerText(), /2/);
        await page.locator(".el-pagination .btn-prev").click();
        assert.equal(await page.getByRole("checkbox", { exact: true, name: "选择账号 #0" }).isChecked(), true);
        await button("刷新").click();
        assert.equal(await page.getByRole("checkbox", { exact: true, name: "选择账号 #0" }).isChecked(), true);
        await search.fill("account0");
        await check(async () => (await page.locator("tbody tr").count()) === 10, "search should filter and reset page");
        assert.match(await page.locator(".selection-toolbar").innerText(), /0/);
        await button("选择全部筛选结果（10）").click();
        assert.match(await page.locator(".selection-toolbar").innerText(), /10/);
        await search.fill("");
        accounts[1].isDisabled = true;
        accounts[2].isExpired = true;
        accounts[3].isInvalid = true;
        accounts[4].isDuplicate = true;
        accounts[4].canonicalIndex = 6;
        await button("刷新").click();
        await check(
            async () => (await page.locator("tbody tr").nth(1).innerText()).includes("已禁用"),
            "refresh account states"
        );
        for (const index of [0, 1, 2, 3, 4]) await select(index);
        await button("批量检测").click();
        await check(
            async () => (await resultStates()).filter(value => value === "已跳过").length === 4,
            "disabled/expired/invalid/duplicate must be skipped"
        );
        assert.deepEqual(tests, [0]);
        await button("清空选择").click();
        await page.locator(".filters .el-select").click();
        await page.getByRole("option", { exact: true, name: "已禁用" }).click();
        await check(async () => (await page.locator("tbody tr").count()) === 1, "status filter");
        await page.locator(".filters .el-select").click();
        await page.getByRole("option", { exact: true, name: "全部状态" }).click();
        await page.locator(".el-pagination .el-select").click();
        await page.getByRole("option", { exact: true, name: "50条/页" }).click();
        await check(async () => (await page.locator("tbody tr").count()) === 45, "page size 50");
        await page.locator(".el-pagination .el-select").click();
        await page.getByRole("option", { exact: true, name: "20条/页" }).click();
        for (const index of [0, 1, 2]) await select(index);
        mode = "mixed";
        await button("批量禁用").click();
        await confirm();
        await check(
            async () => (await resultStates()).join() === "清理待完成,失败,成功",
            "partial results must be classified"
        );
        mode = "success";
        changes = [];
        await button("仅重试失败项（1）").click();
        await confirm();
        await check(async () => (await resultStates()).join() === "成功", "failed retry must finish");
        assert.deepEqual(changes, [1]);
        delay = 700;
        changes = [];
        await button("批量启用").click();
        await confirm();
        await check(() => changes.length === 1, "first serial mutation starts");
        await button("停止后续执行").click();
        await check(
            async () => (await resultStates()).join() === "成功,未执行,未执行",
            "stop waits for current request"
        );
        assert.deepEqual(changes, [0]);
        delay = 0;
        mode = "network";
        changes = [];
        await button("批量禁用").click();
        await confirm();
        await check(
            async () => (await resultStates()).join() === "状态未知,未执行,未执行",
            "network failure must stop without retrying unknown"
        );
        assert.equal(await button("仅重试失败项（0）").isDisabled(), true);
        mode = "success";
        const download = page.waitForEvent("download");
        await button("导出 ZIP").click();
        await download;
        await check(async () => (await resultStates()).join() === "成功,成功,失败", "ZIP missing account classified");
        await button("批量删除").click();
        await confirm();
        await check(
            async () => (await page.locator(".el-message-box").last().innerText()).includes("当前"),
            "current-account extra confirmation"
        );
        await confirm();
        await check(
            async () => (await resultStates()).join() === "清理待完成,成功,失败",
            "207 deletion classification"
        );
        assert.equal(deleteCalls, 2);
        await check(
            async () => (await page.locator(".selection-toolbar").innerText()).includes("1"),
            "deleted selections removed"
        );
        await page.locator('input[type="file"]').setInputFiles([
            { buffer: Buffer.from('{"cookies":[]}'), mimeType: "application/json", name: "valid.json" },
            { buffer: Buffer.from("broken"), mimeType: "application/json", name: "invalid.json" },
        ]);
        await check(async () => (await resultStates()).join() === "成功,失败", "import preserves per-file failures");
        const zip = new JSZip();
        zip.file("nested/credential.json", "{}");
        await page.locator('input[type="file"]').setInputFiles({
            buffer: await zip.generateAsync({ type: "nodebuffer" }),
            mimeType: "application/zip",
            name: "credentials.zip",
        });
        await check(async () => (await resultText()).includes("auth-100.json"), "ZIP import works");
        await button("清空选择").click();
        await select(5);
        await select(6);
        mode = "session";
        changes = [];
        await button("批量禁用").click();
        await confirm();
        await check(async () => (await resultStates()).join() === "失败,未执行", "session failure stops queue");
        assert.deepEqual(changes, [5]);
        mode = "success";
        delay = 1500;
        changes = [];
        await button("批量禁用").click();
        await confirm();
        await check(() => changes.length === 1, "leave test current request starts");
        assert.equal(await button("批量启用").isDisabled(), true, "conflicting operations disabled");
        await page.locator(".sidebar-menu button").first().click();
        await page.locator(".el-message-box").last().getByRole("button", { exact: true, name: "取消" }).click();
        assert.equal(new URL(page.url()).pathname, "/accounts");
        await page.locator(".sidebar-menu button").first().click();
        await confirm();
        await check(async () => new URL(page.url()).pathname === "/", "confirm leave waits for current request");
        assert.deepEqual(changes, [5]);
        delay = 0;
        await button("打开账号管理").click();
        await check(async () => (await page.locator("tbody tr").count()) === 20, "return after stopped work");
        await button("选择全部筛选结果（43）").click();
        await button("批量禁用").click();
        assert.match(await page.locator(".el-message-box").last().innerText(), /全部已启用账号/);
        await page.locator(".el-message-box").last().getByRole("button", { exact: true, name: "取消" }).click();
        const row = page.locator("tbody tr").filter({ hasText: "account07@example.test" });
        const [singleDownload] = await Promise.all([
            page.waitForEvent("download"),
            row.getByRole("button", { exact: true, name: "下载 Auth" }).click(),
        ]);
        assert.equal(singleDownload.suggestedFilename(), "auth-7.json");
        await row.getByRole("button", { exact: true, name: "切换账号" }).click();
        await confirm();
        await button("去重清理").click();
        await confirm();
        await page.locator(".sidebar-menu button").first().click();
        await check(async () => new URL(page.url()).pathname === "/", "home navigation");
        assert.equal(await page.locator(".accounts-table").count(), 0);
        await button("打开账号管理").click();
        await check(async () => new URL(page.url()).pathname === "/accounts", "account entry navigation");
        await page.goBack();
        await page.goForward();
        await page.reload();
        await check(
            async () => (await page.locator("tbody tr").count()) === 20,
            "direct reload and history navigation"
        );
        await button("添加账号").click();
        await check(
            async () => page.url().includes("returnTo=/accounts") || page.url().includes("returnTo=%2Faccounts"),
            "auth return path"
        );
        // AuthPage's existing intro cancellation invokes its return handler.
        await page.locator(".el-dialog").getByRole("button", { exact: true, name: "取消" }).click();
        await check(
            async () => new URL(page.url()).pathname === "/accounts",
            "cancel add account returns to management"
        );
        await check(async () => (await page.locator("tbody tr").count()) === 20, "account list loaded after cancel");
        await button("添加账号").click();
        await page.locator(".el-dialog").getByRole("button", { exact: true, name: "我知道了" }).click();
        await page.locator(".is-save").click();
        await check(async () => new URL(page.url()).pathname === "/accounts", "saved account returns to management");
        await check(async () => (await page.locator("tbody tr").count()) === 20, "account list loaded after save");
        await search.fill("no-matching-fixture");
        await check(
            async () => (await page.locator(".empty-state").innerText()).includes("没有匹配"),
            "no matches state"
        );
        await search.fill("");
        const statsExpired = page.waitForResponse(
            response => response.url().includes("/api/usage-stats") && response.status() === 303
        );
        failStatus = true;
        await button("刷新").click();
        await check(async () => (await page.locator(".el-alert--error").count()) === 1, "load error state");
        await statsExpired;
        assert.equal(
            new URL(page.url()).pathname,
            "/accounts",
            "background polling must preserve account results after session expiry"
        );
        failStatus = false;
        await button("刷新").click();
        await check(async () => (await page.locator(".el-alert--error").count()) === 0, "load error recovery");
        const saved = accounts;
        accounts = [];
        await button("刷新").click();
        await check(
            async () => (await page.locator(".empty-state").innerText()).includes("暂无账号"),
            "empty account state"
        );
        accounts = saved;
        await button("刷新").click();
        await check(async () => (await page.locator("tbody tr").count()) === 20, "loaded before screenshot");
        const output = path.join(root, "tmp/account-management");
        fs.mkdirSync(output, { recursive: true });
        await page.screenshot({
            animations: "disabled",
            fullPage: false,
            path: path.join(output, "desktop-zh-light.png"),
        });
        await page.evaluate(() => {
            localStorage.setItem("lang", "en");
            localStorage.setItem("theme", "dark");
        });
        // Set values after the initial init script for the next navigation.
        await context.addInitScript(() => {
            localStorage.setItem("lang", "en");
            localStorage.setItem("theme", "dark");
        });
        await page.setViewportSize({ height: 844, width: 390 });
        await page.reload();
        await check(async () => (await page.locator("h1").innerText()) === "Account Management", "English locale");
        assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
        assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            true,
            "mobile page must not overflow horizontally"
        );
        await page.screenshot({
            animations: "disabled",
            fullPage: false,
            path: path.join(output, "mobile-en-dark.png"),
        });
        assert.deepEqual(errors, []);
        console.log(`Account browser checks passed. Screenshots: ${output}`);
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
}

(async () => {
    await logicTests();
    if (process.argv.includes("--ui")) await browserTests();
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
