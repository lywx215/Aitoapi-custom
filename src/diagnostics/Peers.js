const { isIP } = require("net");
const { token } = require("./Resource");

function origin(value) {
    if (typeof value !== "string" || /[^\x21-\x7e]|[\\%@?#]/.test(value)) return null;
    const match = /^(https?):\/\/([^/]+)\/?$/.exec(value);
    if (!match) return null;
    const authority = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]+))?$/.exec(match[2]);
    if (!authority || (authority[2] && (+authority[2] < 1 || +authority[2] > 65535))) return null;
    const host = authority[1];
    if (host.endsWith(".")) return null;
    try {
        const url = new URL(value);
        if (isIP(url.hostname) === 4 && url.hostname !== host) return null;
        if (
            !host.startsWith("[") &&
            !isIP(host) &&
            !host.split(".").every(s => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(s))
        )
            return null;
        return url.origin;
    } catch {
        return null;
    }
}

function pathValid(path, target = false) {
    if (typeof path !== "string" || (!target && path.length > 256)) return false;
    const value = target && path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    return (
        /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/.test(value) &&
        !value.split("/").some(s => s === "." || s === "..")
    );
}
const contains = (prefix, path) => prefix === "/" || prefix === path || path.startsWith(`${prefix}/`);

function parse(config = "") {
    try {
        if (typeof config === "string") {
            // Token scan catches duplicate decoded JSON object keys before JSON.parse discards them.
            const stack = [];
            for (const match of config.matchAll(/"(?:\\.|[^"\\])*"\s*:|[{}]/g)) {
                if (match[0] === "{") stack.push(new Set());
                else if (match[0] === "}") stack.pop();
                else {
                    const key = JSON.parse(match[0].replace(/\s*:$/, ""));
                    const keys = stack[stack.length - 1];
                    if (!keys || keys.has(key)) throw new Error();
                    keys.add(key);
                }
            }
            config = config === "" ? [] : JSON.parse(config);
        }
        if (!Array.isArray(config) || config.length > 64) throw new Error();
        const entries = [];
        for (const entry of config) {
            if (!entry || Object.keys(entry).sort().join(",") !== "alias,deploymentId,origin,pathPrefix,service")
                throw new Error();
            const canonical = origin(entry.origin);
            if (
                !canonical ||
                entry.origin.length > 256 ||
                !token(entry.alias) ||
                !pathValid(entry.pathPrefix) ||
                !["aitoapi", "cliproxyapi", "gcli2api"].includes(entry.service) ||
                !(entry.deploymentId === null || token(entry.deploymentId))
            )
                throw new Error();
            if (
                entries.some(
                    e =>
                        e.alias === entry.alias ||
                        (e.origin === canonical &&
                            (contains(e.pathPrefix, entry.pathPrefix) || contains(entry.pathPrefix, e.pathPrefix)))
                )
            )
                throw new Error();
            entries.push(Object.freeze({ ...entry, origin: canonical }));
        }
        return { configStatus: "valid", entries: Object.freeze(entries) };
    } catch {
        return { configStatus: "config_invalid", entries: Object.freeze([]) };
    }
}

function match(snapshot, target) {
    if (typeof target !== "string" || /[^\x21-\x7e]|[\\#]/.test(target)) return null;
    const parts = /^(https?:\/\/[^/?#]+)([^?#]*)(?:\?[^#]*)?$/.exec(target);
    if (!parts) return null;
    const canonical = origin(parts[1]);
    const path = parts[2] || "/";
    if (!canonical || !pathValid(path, true)) return null;
    return snapshot.entries.find(e => e.origin === canonical && contains(e.pathPrefix, path)) || null;
}

module.exports = { match, parse };
