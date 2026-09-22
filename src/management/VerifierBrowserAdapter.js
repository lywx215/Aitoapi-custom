/* global window, document, location */
const path = require("path");
const { VerificationError, abortable } = require("./VerifierSupport");

// Executed before scripts in every frame of this owned verification page only.
function installIsolation({ index, endpoint }) {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
        constructor(url, protocols) {
            const parsed = new URL(String(url), location.href);
            if (parsed.protocol === "ws:" && parsed.hostname === "127.0.0.1" && parsed.port === "9998") {
                if (parsed.searchParams.get("authIndex") !== String(index)) throw new Error("Wrong verification index");
                url = endpoint;
            } else if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
                throw new Error("Unexpected local WebSocket");
            }
            super(url, protocols);
        }
    };
    if (!window.chrome) window.chrome = {};
    Object.defineProperty(window.chrome, "_contextId", { configurable: false, value: index, writable: false });
    if (window === window.top) {
        window.addEventListener("message", event => {
            if (event.data?.type === "requestAuthIndex" && event.source && event.source !== window) {
                event.source.postMessage({ authIndex: index, type: "authIndexResponse" }, "*");
            }
        });
    }
}

// Do not search body text, aria labels, arbitrary email strings or cookies for identity.
// Adapter assumption: WIZ_global_data.oPEP7c is the first-party bootstrap session email.
// This mapping has NOT been live-validated by the offline test suite. Missing/changed
// metadata is intentionally a closed gate requiring adapter maintenance/live evidence.
function inspectSessionPage() {
    const url = new URL(location.href);
    if (url.hostname === "accounts.google.com") return { stage: "login_required" };
    if (url.origin !== "https://aistudio.google.com") return { stage: "identity_unconfirmed" };
    const visible = node => Boolean(node.getClientRects().length);
    const labels = Array.from(document.querySelectorAll('button, [role="button"], h1, h2, [role="dialog"]'))
        .filter(visible)
        .map(node => (node.innerText || "").trim())
        .join("\n")
        .slice(0, 16000);
    if (/sign in|verify (?:it.s you|your identity)|登录|验证您的身份/i.test(labels)) return { stage: "login_required" };
    if (/terms of service|accept (?:the )?terms|agree and continue|同意并继续|服务条款/i.test(labels))
        return { stage: "terms_required" };
    if (/not available in your (?:country|region)|unsupported (?:country|region)|所在地区/i.test(labels))
        return { stage: "region_restricted" };
    if (/permission denied|access denied|forbidden|无权访问/i.test(labels)) return { stage: "permission_denied" };
    const email = window.WIZ_global_data?.oPEP7c;
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return { stage: "identity_unconfirmed" };
    return { identity: { email, origin: url.origin, source: "aistudio_session" } };
}

class VerifierBrowserAdapter {
    constructor(config = {}) {
        // Copy only static configuration. Never keep a reference to the production system.
        this.targetUrl = config.aiStudioAppUrl;
        this.executablePath = config.browserExecutablePath;
        this.pending = new Set();
        this.closed = false;
    }

    async acquire(promise, key, signal) {
        const owned = Promise.resolve(promise).then(async resource => {
            if (this.closed || signal.aborted) {
                await resource.close();
                throw new VerificationError("cancelled");
            }
            this[key] = resource;
            return resource;
        });
        this.pending.add(owned);
        owned.then(
            () => this.pending.delete(owned),
            () => this.pending.delete(owned)
        );
        return abortable(owned, signal);
    }

    async start({ index, credentials, endpoint, signal }) {
        let target;
        try {
            target = new URL(this.targetUrl);
        } catch {
            throw new VerificationError("initialization_failed");
        }
        // ConfigLoader uses Google's short app entry URL. The browser follows its
        // official redirect; inspectSessionPage still trusts only the final Google page.
        if (
            !["https://ai.studio", "https://aistudio.google.com"].includes(target.origin) ||
            target.username ||
            target.password ||
            target.search ||
            target.hash ||
            !/^\/apps\/[a-zA-Z0-9_-]+\/?$/.test(target.pathname)
        )
            throw new VerificationError("initialization_failed");
        const executablePath =
            this.executablePath ||
            path.join(
                process.cwd(),
                ...(process.platform === "win32"
                    ? ["camoufox", "camoufox.exe"]
                    : process.platform === "darwin"
                      ? ["camoufox-macos", "Camoufox.app", "Contents", "MacOS", "camoufox"]
                      : ["camoufox-linux", "camoufox"])
            );
        const browser = await this.acquire(
            require("playwright").firefox.launch({
                executablePath,
                firefoxUserPrefs: { "network.trr.mode": 5, "network.trr.uri": "" },
                headless: true,
                timeout: 30000,
            }),
            "browser",
            signal
        );
        const context = await this.acquire(
            browser.newContext({
                storageState: { cookies: credentials.cookies, origins: credentials.origins },
                viewport: { height: 900, width: 1440 },
            }),
            "context",
            signal
        );
        const page = await this.acquire(context.newPage(), "page", signal);
        await abortable(page.addInitScript(installIsolation, { endpoint, index }), signal);
        // Extra windows are not part of verification. They cannot supply its result.
        context.on("page", other => {
            if (other !== page) other.close().catch(() => {});
        });
        await abortable(page.goto(target.href, { timeout: 60000, waitUntil: "domcontentloaded" }), signal);
    }

    async inspect() {
        if (!this.page || this.page.isClosed()) throw new VerificationError("connection_closed");
        return this.page.evaluate(inspectSessionPage);
    }

    async wake() {
        // inspectSessionPage gates legal consent and login challenges before this runs.
        // These exact controls only open/run the already-authorized AI Studio app.
        for (const name of ["Continue to the app", "Skip", "Launch", "rocket_launch"]) {
            const button = this.page.getByRole("button", { exact: true, name }).first();
            if (await button.isVisible()) {
                await button.click({ timeout: 1000 });
                return;
            }
        }
    }

    close() {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        this.closePromise = (async () => {
            // Start independent closes together so a stuck page close cannot prevent browser shutdown.
            const results = await Promise.allSettled([
                ...this.pending,
                Promise.resolve().then(() => this.context?.close()),
                Promise.resolve().then(() => this.browser?.close()),
            ]);
            if (results.some(result => result.status === "rejected" && !(result.reason instanceof VerificationError))) {
                throw new VerificationError("cleanup_failed");
            }
        })();
        return this.closePromise;
    }
}

module.exports = VerifierBrowserAdapter;
module.exports.installIsolation = installIsolation;
module.exports.inspectSessionPage = inspectSessionPage;
