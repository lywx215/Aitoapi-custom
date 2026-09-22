const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vue = require("vue");
const compiler = require(
    require.resolve("@vue/compiler-sfc", { paths: [path.dirname(require.resolve("vue/package.json"))] })
);

// Compile the real SFC script and mount it with Vue's non-DOM renderer. No GUI,
// network, extracted method copies, localStorage, or fake component implementation.
function mountPanel() {
    const sourcePath = path.resolve(__dirname, "../../../../ui/app/components/ManagementKeys.vue");
    const { descriptor, errors } = compiler.parse(fs.readFileSync(sourcePath, "utf8"));
    assert.deepEqual(errors, []);
    const compiled = compiler.compileScript(descriptor, { id: "management-key-panel-acceptance" });
    const script = compiled.content
        .replace(/import\s*\{([^}]+)\}\s*from\s*["']vue["'];?/, "const {$1} = vue;")
        .replace("export default", "return");
    const requests = [];
    const replies = [];
    const copied = [];
    const timers = new Set();
    let confirm = true;
    const fetch = async (url, options) => {
        requests.push({ options, url });
        assert.ok(url.startsWith("/api/management-keys"));
        const reply = replies.shift();
        assert.ok(reply, `Unexpected panel request ${options.method || "GET"} ${url}`);
        return typeof reply === "function" ? reply() : reply;
    };
    const component = new Function("vue", "fetch", "window", "navigator", "setInterval", "clearInterval", script)(
        vue,
        fetch,
        { confirm: () => confirm },
        { clipboard: { writeText: async value => copied.push(value) } },
        callback => {
            timers.add(callback);
            return callback;
        },
        callback => timers.delete(callback)
    );
    component.render = () => null;
    const renderer = vue.createRenderer({
        createComment: text => ({ text }),
        createElement: type => ({ type }),
        createText: text => ({ text }),
        insert() {},
        nextSibling: () => null,
        parentNode: () => null,
        patchProp() {},
        remove() {},
        setElementText() {},
        setText() {},
    });
    const app = renderer.createApp(component);
    const page = { items: [], limit: 20, offset: 0, total: 0 };
    const respond = (data, status = 200) => replies.push({ json: async () => data, ok: status < 400, status });
    respond({ data: page, requestId: "req_panel_initial" });
    const instance = app.mount({});
    const state = instance.$.setupState;
    return {
        app,
        copied,
        flush: () => new Promise(resolve => setImmediate(resolve)),
        page,
        replies,
        requests,
        respond,
        setConfirm: value => {
            confirm = value;
        },
        state,
        timers,
    };
}

function registerKeyPanelTests(test) {
    test("UI03 real key panel ignores token returned after component unmount", async () => {
        const h = mountPanel();
        await h.flush();
        let release;
        h.state.name = "late fixture";
        h.replies.push(
            () =>
                new Promise(resolve => {
                    release = resolve;
                })
        );
        const pending = h.state.createKey();
        await h.flush();
        h.app.unmount();
        release({
            json: async () => ({ data: { key: { id: "mkey_late" }, token: "mgmt_late_fixture" } }),
            ok: true,
            status: 201,
        });
        await pending;
        assert.equal(h.state.token, "");
        assert.equal(h.state.tokenKeyId, "");
        assert.equal(h.requests.length, 2);
        assert.equal(h.timers.size, 0);
    });
    test("UI01 real key panel script: scope templates, same-origin requests, one-time token, revoke and cleanup", async () => {
        const h = mountPanel();
        try {
            await h.flush();
            assert.equal(h.state.busy, false);
            h.state.template = "operator";
            h.state.applyTemplate();
            for (const excluded of ["accounts:export", "accounts:archive", "settings:write", "audit:read"]) {
                assert.ok(!h.state.selectedScopes.includes(excluded));
            }
            h.state.name = " panel fixture ";
            const key = {
                id: "mkey_fixture",
                name: "panel fixture",
                revokedAt: null,
                scopes: [...h.state.selectedScopes],
            };
            h.respond({ data: { key, token: "mgmt_synthetic_panel_only" }, requestId: "req_panel_create" }, 201);
            h.respond({ data: { ...h.page, items: [key], total: 1 }, requestId: "req_panel_list" });
            await h.state.createKey();
            const post = h.requests.find(row => row.options.method === "POST");
            assert.equal(JSON.parse(post.options.body).name, "panel fixture");
            assert.equal(h.state.token, "mgmt_synthetic_panel_only");
            await h.state.copyToken();
            assert.deepEqual(h.copied, ["mgmt_synthetic_panel_only"]);
            for (const { options } of h.requests) {
                assert.equal(options.credentials, "same-origin");
                assert.equal(options.cache, "no-store");
                assert.equal(options.headers["X-Requested-With"], "XMLHttpRequest");
                assert.equal(options.headers.Authorization, undefined);
            }
            h.setConfirm(false);
            const count = h.requests.length;
            await h.state.revokeKey(key);
            assert.equal(h.requests.length, count);
            h.setConfirm(true);
            h.respond({ data: { id: key.id, revoked: true }, requestId: "req_panel_revoke" });
            h.respond({ data: { ...h.page, items: [{ ...key, revokedAt: "2026-01-01T00:00:00Z" }], total: 1 } });
            await h.state.revokeKey(key);
            assert.equal(h.state.token, "");
            assert.equal(h.state.tokenKeyId, "");
            assert.equal(h.state.stateLabel({ revokedAt: "2026-01-01T00:00:00Z" }), "已撤销");
        } finally {
            h.app.unmount();
            assert.equal(h.state.token, "");
            assert.equal(h.timers.size, 0);
        }
    });
    test("UI02 real key panel script rejects expired input and clears token on session downgrade", async () => {
        const h = mountPanel();
        try {
            await h.flush();
            const count = h.requests.length;
            h.state.name = "fixture";
            h.state.expiresAt = "2000-01-01T00:00";
            await h.state.createKey();
            assert.equal(h.requests.length, count);
            assert.match(h.state.error, /到期时间/);
            h.state.token = "mgmt_synthetic_discard";
            h.respond(
                {
                    error: { code: "CONSOLE_PASSWORD_REQUIRED", message: "untrusted server text" },
                    requestId: "req_downgrade",
                },
                403
            );
            await h.state.loadKeys();
            assert.equal(h.state.passwordRequired, true);
            assert.equal(h.state.token, "");
            assert.ok(!h.state.error.includes("untrusted server text"));
            assert.ok(h.state.error.includes("req_downgrade"));
        } finally {
            h.app.unmount();
        }
    });
}

module.exports = { registerKeyPanelTests };
