const fs = require("fs");
const path = require("path");

function isManagedAppScript(request) {
    if (request.resourceType() !== "script") return false;
    const frame = request.frame();
    const parent = frame.parentFrame();
    if (!parent) return false;
    try {
        const page = new URL(parent.url());
        const app = new URL(frame.url());
        const asset = new URL(request.url());
        return (
            page.origin === "https://aistudio.google.com" &&
            page.pathname.startsWith("/apps/") &&
            app.protocol === "https:" &&
            /^ais-(?:pre|dev)-[a-z0-9-]+\.[a-z0-9-]+\.run\.app$/.test(app.hostname) &&
            asset.origin === app.origin &&
            /^\/assets\/index-[a-zA-Z0-9_-]+\.js$/.test(asset.pathname)
        );
    } catch {
        return false;
    }
}

async function installManagedClient(context, index, { endpoint, onUnsupported } = {}) {
    if (!Number.isInteger(index) || index < 0) throw new TypeError("Invalid managed account index");
    let source = fs.readFileSync(path.join(__dirname, "../../scripts/client/build.js"), "utf8");
    if (endpoint) {
        const target = new URL(endpoint);
        if (
            target.protocol !== "ws:" ||
            target.hostname !== "127.0.0.1" ||
            !/^\/verify\/[a-f0-9]{64}$/.test(target.pathname) ||
            target.searchParams.get("authIndex") !== String(index)
        ) {
            throw new TypeError("Invalid isolated verification endpoint");
        }
        target.search = "";
        if (!source.includes("new ProxySystem();")) throw new Error("Managed client initializer not found");
        source = source.replace("new ProxySystem();", `new ProxySystem(${JSON.stringify(target.href)});`);
    }
    const script = `console.info("[ProxyClient] Managed client protocol v2");
window.chrome = window.chrome || {};
if (window.chrome._contextId === undefined) window.chrome._contextId = ${index};
if (window.chrome._contextId !== ${index}) throw new Error("Managed account index mismatch");
window.__authIndexReady = Promise.resolve(${index});\n${source}`;
    await context.route("**/assets/index-*.js", async route => {
        if (!isManagedAppScript(route.request())) return route.continue();
        const response = await route.fetch();
        const original = await response.text();
        // Only replace the hosted proxy client, never unrelated AI Studio applications.
        if (
            response.status() !== 200 ||
            !["WebSocket", "127.0.0.1", "request_attempt_id", "generativelanguage.googleapis.com"].every(marker =>
                original.includes(marker)
            )
        ) {
            if (endpoint) {
                // Never execute a legacy production-pool client in an isolated verifier.
                onUnsupported?.();
                return route.fulfill({
                    body: 'throw new Error("Unsupported managed proxy client");',
                    contentType: "application/javascript; charset=utf-8",
                    response,
                });
            }
            return route.fulfill({ response });
        }
        await route.fulfill({ body: script, contentType: "application/javascript; charset=utf-8", response });
    });
}

module.exports = { installManagedClient, isManagedAppScript };
