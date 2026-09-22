const crypto = require("node:crypto");
const express = require("express");

const ERRORS = {
    CONSOLE_PASSWORD_REQUIRED: [403, "Log in again with the console password to manage keys."],
    FORBIDDEN: [403, "Same-origin console request required."],
    INTERNAL_ERROR: [500, "Management key operation failed."],
    INVALID_REQUEST: [400, "Invalid request."],
    METHOD_NOT_ALLOWED: [405, "Method not allowed."],
    NOT_FOUND: [404, "Management key or route not found."],
    PAYLOAD_TOO_LARGE: [413, "JSON body exceeds 10 MiB."],
    PERSISTENCE_ERROR: [500, "Unable to persist management keys."],
    UNAUTHORIZED: [401, "Console login required."],
};

class ManagementKeyRoutes {
    constructor(system, { keyStore }) {
        this.keyStore = keyStore;
    }

    createRouter() {
        const router = express.Router();
        const fail = (res, code) => {
            const [status, message] = ERRORS[code];
            return res.status(status).json({ error: { code, message }, requestId: res.locals.managementKeyRequestId });
        };
        const send = (res, data, status = 200) =>
            res.status(status).json({ data, requestId: res.locals.managementKeyRequestId });
        router.use((req, res, next) => {
            res.locals.managementKeyRequestId = `req_${crypto.randomUUID()}`;
            res.set("Cache-Control", "no-store");
            res.set("X-Content-Type-Options", "nosniff");
            if (!req.session?.isAuthenticated) return fail(res, "UNAUTHORIZED");
            if (req.session.authMethod !== "console_password") return fail(res, "CONSOLE_PASSWORD_REQUIRED");
            next();
        });
        router.use((req, res, next) => {
            const root = req.path === "/";
            const keyPath = /^\/[^/]+\/?$/.test(req.path);
            const methods = root ? ["GET", "POST"] : keyPath ? ["DELETE"] : [];
            if (!methods.length) return fail(res, "NOT_FOUND");
            if (!methods.includes(req.method)) {
                res.set("Allow", methods.join(", "));
                return fail(res, "METHOD_NOT_ALLOWED");
            }
            if (req.method !== "GET") {
                if (
                    req.get("X-Requested-With") !== "XMLHttpRequest" ||
                    ["cross-site", "same-site"].includes(req.get("Sec-Fetch-Site"))
                )
                    return fail(res, "FORBIDDEN");
                const origin = req.get("Origin");
                if (origin) {
                    try {
                        if (
                            new URL(origin).origin !== origin ||
                            origin !== new URL(`${req.protocol}://${req.get("host")}`).origin
                        )
                            return fail(res, "FORBIDDEN");
                    } catch {
                        return fail(res, "FORBIDDEN");
                    }
                }
            }
            next();
        });
        router.use(express.json({ limit: 10 * 1024 * 1024, strict: true }));
        router.get("/", (req, res, next) => {
            try {
                const parse = (value, fallback, min, max) => {
                    if (value === undefined) return fallback;
                    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error();
                    const number = Number(value);
                    if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error();
                    return number;
                };
                let offset, limit;
                try {
                    offset = parse(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
                    limit = parse(req.query.limit, 50, 1, 200);
                } catch {
                    return fail(res, "INVALID_REQUEST");
                }
                const rows = this.keyStore.list();
                return send(res, { items: rows.slice(offset, offset + limit), limit, offset, total: rows.length });
            } catch (error) {
                next(error);
            }
        });
        router.post("/", async (req, res, next) => {
            try {
                if (!req.is("application/json")) return fail(res, "INVALID_REQUEST");
                return send(res, await this.keyStore.create(req.body), 201);
            } catch (error) {
                next(error);
            }
        });
        router.delete("/:id", async (req, res, next) => {
            try {
                if (!/^mkey_[a-f0-9-]{36}$/.test(req.params.id)) return fail(res, "INVALID_REQUEST");
                return send(res, await this.keyStore.revoke(req.params.id));
            } catch (error) {
                next(error);
            }
        });
        router.use((req, res) => fail(res, "NOT_FOUND"));
        router.use((error, req, res, next) => {
            if (res.headersSent) return next(error);
            const code =
                error.type === "entity.too.large"
                    ? "PAYLOAD_TOO_LARGE"
                    : error.type === "entity.parse.failed" || error.status === 400 || error.status === 415
                      ? "INVALID_REQUEST"
                      : Object.hasOwn(ERRORS, error.code)
                        ? error.code
                        : "INTERNAL_ERROR";
            return fail(res, code);
        });
        return router;
    }
}

module.exports = ManagementKeyRoutes;
