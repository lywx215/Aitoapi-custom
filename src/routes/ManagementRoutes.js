const express = require("express");
const { randomUUID } = require("crypto");
const { failure, safeError, pagination, object } = require("../management/ManagementSupport");

/** Mount before the legacy raw-body collector and model-key fallback. */
class ManagementRoutes {
    constructor(system, { keyStore, taskService, accountService }) {
        this.system = system;
        this.keys = keyStore;
        this.tasks = taskService;
        this.accounts = accountService;
    }
    createRouter() {
        const router = express.Router({ caseSensitive: true, strict: true });
        const routes = [];
        const asyncHandler = handler => (req, res, next) =>
            Promise.resolve()
                .then(() => handler(req, res))
                .catch(next);
        router.use((req, res, next) => {
            req.managementRequestId = `req_${randomUUID()}`;
            res.set("X-Request-Id", req.managementRequestId);
            res.set("Cache-Control", "no-store");
            next();
        });
        router.use((req, res, next) => {
            Promise.resolve()
                .then(() => {
                    const header = req.headers.authorization;
                    const match = typeof header === "string" && /^Bearer ([^\s,]+)$/i.exec(header);
                    if (!match) throw failure("UNAUTHORIZED");
                    return this.keys.authenticate(match[1]);
                })
                .then(key => {
                    req.managementKey = key;
                    next();
                }, next);
        });
        router.use(
            express.json({
                inflate: false,
                limit: "10mb",
                strict: false,
                type: ["application/json", "application/*+json"],
            })
        );
        router.use((req, res, next) => {
            if (
                (Number(req.headers["content-length"]) > 0 || req.headers["transfer-encoding"]) &&
                !req.is(["application/json", "application/*+json"])
            )
                return next(failure("INVALID_REQUEST"));
            next();
        });
        router.use((req, res, next) => {
            // Reserve literal collection endpoints before /accounts/:id can match them.
            const literals = routes.filter(route => route.path === req.path);
            const matches = literals.length ? literals : routes.filter(route => route.pattern.test(req.path));
            if (matches.length && !matches.some(route => route.method === req.method))
                return next(failure("METHOD_NOT_ALLOWED"));
            next();
        });
        const route = (method, path, scopes, handler, status = 200) => {
            const pattern = new RegExp(`^${path.replace(/:[^/]+/g, "[^/]+")}$`);
            routes.push({ method: method.toUpperCase(), path, pattern });
            router[method](
                path,
                asyncHandler(async (req, res) => {
                    // Express implicitly dispatches HEAD through GET; the contract does not.
                    if (req.method !== method.toUpperCase()) throw failure("METHOD_NOT_ALLOWED");
                    const requiredScopes = typeof scopes === "function" ? scopes(req) : scopes;
                    if (!requiredScopes.every(scope => req.managementKey.scopes.includes(scope)))
                        throw failure("FORBIDDEN");
                    if (!this.keys.isActive(req.managementKey.id)) throw failure("UNAUTHORIZED");
                    const data = await handler(req);
                    res.status(status).json({ data, requestId: req.managementRequestId });
                })
            );
        };
        const actor = (req, scopes = []) => ({
            idempotencyKey: req.get("Idempotency-Key"),
            keyId: req.managementKey.id,
            method: req.method,
            path: `/api/manage/v1${req.path}`,
            requestId: req.managementRequestId,
            scopes,
        });
        const audit = (req, action, outcome, error) =>
            this.tasks.audit({
                action,
                createdByKeyId: req.managementKey.id,
                outcome,
                requestId: req.managementRequestId,
                ...(req.params.id
                    ? action === "cancel-task"
                        ? { taskId: req.params.id }
                        : { accountId: req.params.id }
                    : {}),
                error,
            });
        const mutate = async (req, action, operation) => {
            let result;
            try {
                result = await operation();
            } catch (error) {
                try {
                    audit(req, action, "failed", error);
                } catch {
                    // Preserve the original operation error if recording that failure also fails.
                }
                throw error;
            }
            try {
                audit(req, action, result?.applied === false ? "partial" : "succeeded");
            } catch {
                throw failure("AUDIT_PERSISTENCE_FAILED");
            }
            return result;
        };
        const task = (kind, scopes) => req =>
            this.accounts.submit(
                kind,
                req.body ?? {},
                req.params.id,
                actor(req, typeof scopes === "function" ? scopes(req) : scopes)
            );
        const taskRoute = (method, path, scopes, kind) => route(method, path, scopes, task(kind, scopes), 202);
        const uploadScopes = req =>
            req.body?.verify === false ? ["accounts:write"] : ["accounts:write", "accounts:test"];

        route("get", "/system/status", ["system:read"], () => this.accounts.status());
        route("get", "/system/readiness", ["system:read"], () => this.accounts.readiness());
        route("get", "/accounts", ["accounts:read"], req => this.accounts.list(pagination(req.query)));
        route("post", "/accounts/export", ["accounts:export"], req =>
            mutate(req, "export", () => this.accounts.export(req.body))
        );
        taskRoute("post", "/accounts/import", uploadScopes, "import");
        route(
            "post",
            "/accounts/batch",
            ["accounts:write"],
            req => {
                const scopes = ["accounts:write"];
                if (req.body?.action === "archive") {
                    if (!req.managementKey.scopes.includes("accounts:archive")) throw failure("FORBIDDEN");
                    scopes.push("accounts:archive");
                }
                return task("batch", scopes)(req);
            },
            202
        );
        route("get", "/accounts/:id", ["accounts:read"], req => this.accounts.get(req.params.id));
        route("patch", "/accounts/:id", ["accounts:write"], req =>
            mutate(req, "patch-account", () => this.accounts.patch(req.params.id, req.body, actor(req)))
        );
        taskRoute("post", "/accounts/:id/test", ["accounts:test"], "test");
        taskRoute("put", "/accounts/:id/credentials", uploadScopes, "replace");
        taskRoute("post", "/accounts/:id/archive", ["accounts:archive"], "archive");
        taskRoute("post", "/accounts/:id/restore", ["accounts:archive"], "restore");
        taskRoute("post", "/accounts/:id/reload", ["accounts:write"], "reload");
        taskRoute("post", "/system/reload-auth", ["accounts:write"], "reload-auth");
        route("get", "/settings", ["settings:read"], () => this.accounts.settings());
        route("patch", "/settings", ["settings:write"], req =>
            mutate(req, "patch-settings", () => this.accounts.updateSettings(req.body))
        );
        route("get", "/usage", ["usage:read"], req => this.accounts.usage(pagination(req.query)));
        route("get", "/audit", ["audit:read"], req => this.tasks.listAudit(pagination(req.query)));
        route("get", "/tasks", ["tasks:read"], req => this.tasks.list(pagination(req.query)));
        route("get", "/tasks/:id", ["tasks:read"], req => this.tasks.get(req.params.id));
        route("post", "/tasks/:id/cancel", ["tasks:write"], req => {
            object(req.body ?? {}, []);
            return mutate(req, "cancel-task", () => this.tasks.cancel(req.params.id));
        });
        router.use((req, res, next) => {
            const known = routes.some(route => route.pattern.test(req.path));
            next(failure(known ? "METHOD_NOT_ALLOWED" : "NOT_FOUND"));
        });
        router.use((error, req, res, next) => {
            if (res.headersSent) return next(error);
            const parserCode =
                error.type === "entity.too.large"
                    ? "PAYLOAD_TOO_LARGE"
                    : error.type?.startsWith("entity.") ||
                        error.type === "encoding.unsupported" ||
                        error.type === "charset.unsupported" ||
                        error instanceof URIError
                      ? "INVALID_REQUEST"
                      : null;
            const safe = safeError(parserCode ? failure(parserCode) : error);
            res.status(failure(safe.code).status).json({ error: safe, requestId: req.managementRequestId });
        });
        return router;
    }
}
module.exports = ManagementRoutes;
