const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const SCOPES = Object.freeze([
    "system:read",
    "accounts:read",
    "accounts:write",
    "accounts:test",
    "accounts:export",
    "accounts:archive",
    "settings:read",
    "settings:write",
    "usage:read",
    "audit:read",
    "tasks:read",
    "tasks:write",
]);
const TEMPLATES = Object.freeze({
    admin: SCOPES,
    operator: Object.freeze([
        "system:read",
        "accounts:read",
        "accounts:write",
        "accounts:test",
        "settings:read",
        "usage:read",
        "tasks:read",
        "tasks:write",
    ]),
    readonly: Object.freeze([
        "system:read",
        "accounts:read",
        "settings:read",
        "usage:read",
        "audit:read",
        "tasks:read",
    ]),
});

function failure(code, status, message) {
    return Object.assign(new Error(message), { code, status });
}

function validDate(value) {
    if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    )
        return false;
    const day = Number(value.slice(8, 10));
    const month = Number(value.slice(5, 7));
    const year = Number(value.slice(0, 4));
    const days = [
        31,
        year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    return (
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= days[month - 1] &&
        Number(value.slice(11, 13)) < 24 &&
        Number.isFinite(Date.parse(value))
    );
}

function validScopes(scopes) {
    return (
        Array.isArray(scopes) &&
        scopes.length > 0 &&
        scopes.length <= SCOPES.length &&
        new Set(scopes).size === scopes.length &&
        scopes.every(scope => SCOPES.includes(scope))
    );
}

function metadata(row) {
    return {
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        id: row.id,
        name: row.name,
        revokedAt: row.revokedAt,
        scopes: [...row.scopes],
    };
}

/** One instance per process. All mutations commit to disk before publication. */
class ManagementKeyStore extends EventEmitter {
    #rows = [];
    #writeQueue = Promise.resolve();

    constructor({ rootDir = process.cwd(), logger } = {}) {
        super();
        this.logger = logger;
        this.filePath = path.join(rootDir, "data", "management", "keys.json");
        let source;
        try {
            source = fs.readFileSync(this.filePath, "utf8");
        } catch (error) {
            if (error.code === "ENOENT") return;
            throw failure("PERSISTENCE_ERROR", 500, "Unable to load management keys.");
        }
        try {
            const state = JSON.parse(source);
            if (state.version !== 1 || !Array.isArray(state.keys)) throw new Error();
            const ids = new Set();
            const hashes = new Set();
            this.#rows = state.keys.map(row => {
                if (
                    !row ||
                    Object.keys(row).some(
                        key => !["id", "name", "scopes", "createdAt", "expiresAt", "revokedAt", "hash"].includes(key)
                    ) ||
                    typeof row.id !== "string" ||
                    !/^mkey_[a-f0-9-]{36}$/.test(row.id) ||
                    ids.has(row.id) ||
                    typeof row.hash !== "string" ||
                    !/^[a-f0-9]{64}$/.test(row.hash) ||
                    hashes.has(row.hash) ||
                    typeof row.name !== "string" ||
                    !row.name.trim() ||
                    !validScopes(row.scopes) ||
                    !validDate(row.createdAt) ||
                    (row.expiresAt !== null && !validDate(row.expiresAt)) ||
                    (row.revokedAt !== null && !validDate(row.revokedAt))
                )
                    throw new Error();
                ids.add(row.id);
                hashes.add(row.hash);
                return { ...metadata(row), hash: row.hash };
            });
        } catch {
            throw failure("PERSISTENCE_ERROR", 500, "Invalid management key storage.");
        }
    }

    list() {
        return this.#rows.map(metadata);
    }

    isActive(keyId) {
        const row = this.#rows.find(key => key.id === keyId);
        return !!row && row.revokedAt === null && (row.expiresAt === null || Date.parse(row.expiresAt) > Date.now());
    }

    authenticate(token) {
        if (typeof token !== "string" || !/^mgmt_[A-Za-z0-9_-]{43}$/.test(token)) {
            throw failure("UNAUTHORIZED", 401, "Invalid or inactive management token.");
        }
        const hash = crypto.createHash("sha256").update(token).digest();
        const row = this.#rows.find(key => crypto.timingSafeEqual(hash, Buffer.from(key.hash, "hex")));
        if (!row || !this.isActive(row.id)) throw failure("UNAUTHORIZED", 401, "Invalid or inactive management token.");
        return metadata(row);
    }

    async create(input) {
        if (
            !input ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            Object.keys(input).some(key => !["name", "scopes", "expiresAt"].includes(key)) ||
            typeof input.name !== "string" ||
            !input.name.trim() ||
            !validScopes(input.scopes) ||
            (input.expiresAt !== undefined &&
                (!validDate(input.expiresAt) || Date.parse(input.expiresAt) <= Date.now()))
        ) {
            throw failure(
                "INVALID_REQUEST",
                400,
                "Provide a name, unique allowed scopes and an optional future expiry date."
            );
        }
        const candidate = {
            expiresAt: input.expiresAt === undefined ? null : new Date(input.expiresAt).toISOString(),
            name: input.name.trim(),
            scopes: [...input.scopes],
        };
        return this.#serialize(async () => {
            if (candidate.expiresAt !== null && Date.parse(candidate.expiresAt) <= Date.now())
                throw failure("INVALID_REQUEST", 400, "Expiry date must be in the future.");
            const token = `mgmt_${crypto.randomBytes(32).toString("base64url")}`;
            const row = {
                ...candidate,
                createdAt: new Date().toISOString(),
                hash: crypto.createHash("sha256").update(token).digest("hex"),
                id: `mkey_${crypto.randomUUID()}`,
                revokedAt: null,
            };
            await this.#persist([...this.#rows, row]);
            return { key: metadata(row), token };
        });
    }

    async revoke(id) {
        return this.#serialize(async () => {
            const row = this.#rows.find(key => key.id === id);
            if (!row) throw failure("NOT_FOUND", 404, "Management key not found.");
            if (row.revokedAt !== null) return { id, revoked: true };
            await this.#persist(
                this.#rows.map(key => (key.id === id ? { ...key, revokedAt: new Date().toISOString() } : key))
            );
            // A subscriber failure cannot turn a committed revocation into a failed write.
            for (const listener of this.rawListeners("revoked")) {
                try {
                    Promise.resolve(listener.call(this, id)).catch(() => this.#listenerError());
                } catch {
                    this.#listenerError();
                }
            }
            return { id, revoked: true };
        });
    }

    #listenerError() {
        try {
            this.logger?.error?.("[ManagementKeys] Revocation subscriber failed.");
        } catch {
            /* Logging must not affect committed state. */
        }
    }

    #serialize(operation) {
        const pending = this.#writeQueue.then(operation);
        this.#writeQueue = pending.catch(() => {});
        return pending;
    }

    async #persist(rows) {
        const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
        let handle;
        try {
            await fs.promises.mkdir(path.dirname(this.filePath), { mode: 0o700, recursive: true });
            handle = await fs.promises.open(temporary, "wx", 0o600);
            await handle.writeFile(JSON.stringify({ keys: rows, version: 1 }), "utf8");
            await handle.sync();
            await handle.close();
            handle = null;
            await fs.promises.rename(temporary, this.filePath);
            this.#rows = rows;
        } catch {
            throw failure("PERSISTENCE_ERROR", 500, "Unable to persist management keys.");
        } finally {
            if (handle) await handle.close().catch(() => {});
            await fs.promises.unlink(temporary).catch(() => {});
        }
    }
}

ManagementKeyStore.SCOPES = SCOPES;
ManagementKeyStore.TEMPLATES = TEMPLATES;
module.exports = ManagementKeyStore;
