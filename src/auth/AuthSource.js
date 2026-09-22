/**
 * File: src/auth/AuthSource.js
 * Description: Authentication source manager that loads and validates authentication data from config files
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

const fs = require("fs");
const CredentialStore = require("../storage/CredentialStore");
const path = require("path");

/**
 * Authentication Source Management Module
 * Responsible for loading and managing authentication information from the file system
 */
class AuthSource {
    constructor(logger, { rootDir = process.cwd() } = {}) {
        this.logger = logger;
        this.rootDir = rootDir;
        this.store = new CredentialStore({ logger, rootDir });
        this.authMode = "file";
        this.availableIndices = [];
        // Indices used for rotation/switching (deduplicated by email, keeping the latest index per account)
        this.rotationIndices = [];
        // Duplicate auth indices detected (valid JSON but skipped from rotation due to same email)
        this.duplicateIndices = [];
        // Expired auth indices (valid JSON but marked as expired, excluded from rotation)
        this.expiredIndices = [];
        // Disabled auth indices (manual or automatic status-code quarantine)
        this.disabledIndices = [];
        this.initialIndices = [];
        this.accountNameMap = new Map();
        this.accountStatusMap = new Map();
        // Map any valid index -> canonical (latest) index for the same account email
        this.canonicalIndexMap = new Map();
        // Duplicate groups (email -> kept + duplicates)
        this.duplicateGroups = [];
        this.lastScannedIndices = "[]"; // Cache to track changes
        this.lastScannedSignature = "[]";
        this.currentScanSignature = "[]";

        this.logger.info('[Auth] Using files in "configs/auth/" directory for authentication.');

        this.reloadAuthSources(true); // Initial load

        if (this.availableIndices.length === 0) {
            this.logger.warn(
                `[Auth] No valid authentication sources found in 'file' mode. The server will start in account binding mode.`
            );
        }
    }

    reloadAuthSources(isInitialLoad = false) {
        const metadataChanged = this.store.refreshSync();
        const oldSignature = this.lastScannedSignature;
        this._discoverAvailableIndices();
        const newIndices = JSON.stringify(this.initialIndices);
        const newSignature = this.currentScanSignature;

        // Reload when a file is added/removed or replaced in place.
        if (isInitialLoad || metadataChanged || oldSignature !== newSignature) {
            this.logger.info(`[Auth] Auth file scan detected changes. Reloading and re-validating...`);
            this._preValidateAndFilter();
            this.logger.info(
                `[Auth] Reload complete. ${this.availableIndices.length} valid sources available: [${this.availableIndices.join(", ")}]`
            );
            this.lastScannedIndices = newIndices;
            this.lastScannedSignature = newSignature;
            return true; // Changes detected
        }
        return false; // No changes
    }

    async createAuth(content, options) {
        const result = await this.store.create(content, options);
        this.reloadAuthSources(true);
        return result;
    }

    async replaceAuth(index, content, options) {
        const result = await this.store.replace(index, content, options);
        this.reloadAuthSources(true);
        return result;
    }

    async archiveAuth(index) {
        const result = await this.store.archive(index);
        this.reloadAuthSources(true);
        return result;
    }

    async restoreAuth(accountId) {
        const result = await this.store.restore(accountId);
        this.reloadAuthSources(true);
        return result;
    }

    async removeAuth(index, options = {}) {
        const result = await this.store.remove(index, options);
        this.reloadAuthSources(true);
        return { ...result, remainingAccounts: this.availableIndices.length, removedIndex: index };
    }

    _discoverAvailableIndices() {
        let indices = [];
        const configDir = path.join(this.rootDir, "configs", "auth");
        if (!fs.existsSync(configDir)) {
            this.availableIndices = [];
            this.initialIndices = [];
            this.currentScanSignature = "[]";
            return;
        }
        try {
            const files = fs.readdirSync(configDir);
            const authFiles = files
                .filter(file => {
                    if (!/^auth-\d+\.json$/.test(file)) return false;
                    const metadata = this.store.getMetadata(Number(file.match(/^auth-(\d+)\.json$/)[1]));
                    return metadata && !metadata.archived;
                })
                .sort();
            indices = authFiles.map(file => parseInt(file.match(/^auth-(\d+)\.json$/)[1], 10));
            this.currentScanSignature = JSON.stringify(
                authFiles.map(file => {
                    const stat = fs.statSync(path.join(configDir, file));
                    const metadata = this.store.getMetadata(Number(file.match(/^auth-(\d+)\.json$/)[1]));
                    return [
                        file,
                        stat.size,
                        Math.trunc(stat.mtimeMs),
                        metadata.credentialVersion,
                        metadata.stateVersion,
                    ];
                })
            );
        } catch (error) {
            this.logger.error(`[Auth] Failed to scan "configs/auth/" directory: ${error.message}`);
            this.availableIndices = [];
            this.initialIndices = [];
            this.currentScanSignature = "[]";
            return;
        }

        this.initialIndices = [...new Set(indices)].sort((a, b) => a - b);
    }

    _preValidateAndFilter() {
        if (this.initialIndices.length === 0) {
            this.availableIndices = [];
            this.rotationIndices = [];
            this.duplicateIndices = [];
            this.expiredIndices = [];
            this.disabledIndices = [];
            this.accountNameMap.clear();
            this.accountStatusMap.clear();
            this.canonicalIndexMap.clear();
            this.duplicateGroups = [];
            return;
        }

        const validIndices = [];
        const invalidSourceDescriptions = [];
        this.accountNameMap.clear(); // Clear old names before re-validating
        this.accountStatusMap.clear();
        this.canonicalIndexMap.clear();
        this.duplicateGroups = [];
        this.expiredIndices = [];
        this.disabledIndices = [];

        for (const index of this.initialIndices) {
            // Iterate over initial to check all, not just previously available
            const authContent = this._getAuthContent(index);
            if (authContent) {
                try {
                    const authData = CredentialStore.validate(authContent);
                    validIndices.push(index);
                    this.accountNameMap.set(index, authData.accountName || null);
                    this.accountStatusMap.set(index, {
                        disabledAt: authData.disabledAt || null,
                        disabledReason: authData.disabledReason || null,
                        disabledStatus: Number.isFinite(Number(authData.disabledStatus))
                            ? Number(authData.disabledStatus)
                            : null,
                    });
                    // Track expired status from auth file
                    if (authData.expired === true) {
                        this.expiredIndices.push(index);
                    }
                    if (authData.disabled === true) {
                        this.disabledIndices.push(index);
                    }
                } catch (e) {
                    invalidSourceDescriptions.push(`auth-${index} (parse error)`);
                }
            } else {
                invalidSourceDescriptions.push(`auth-${index} (unreadable)`);
            }
        }

        if (invalidSourceDescriptions.length > 0) {
            this.logger.warn(
                `⚠️ [Auth] Pre-validation found ${
                    invalidSourceDescriptions.length
                } authentication sources with format errors or unreadable: [${invalidSourceDescriptions.join(
                    ", "
                )}], will be removed from available list.`
            );
        }

        this.availableIndices = validIndices.sort((a, b) => a - b);
        this._buildRotationIndices();
    }

    _normalizeEmailKey(accountName) {
        if (typeof accountName !== "string") return null;
        const trimmed = accountName.trim();
        if (!trimmed) return null;
        // Conservative: only deduplicate when the name looks like an email address.
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(trimmed)) return null;
        return trimmed.toLowerCase();
    }

    _buildRotationIndices() {
        this.rotationIndices = [];
        this.duplicateIndices = [];
        this.duplicateGroups = [];
        this.canonicalIndexMap.clear();

        const emailKeyToIndices = new Map();

        // Only process usable accounts for rotation and deduplication
        const nonExpiredIndices = this.availableIndices.filter(
            idx => !this.expiredIndices.includes(idx) && !this.disabledIndices.includes(idx)
        );

        for (const index of nonExpiredIndices) {
            const accountName = this.accountNameMap.get(index);
            const emailKey = this._normalizeEmailKey(accountName);

            if (!emailKey) {
                this.rotationIndices.push(index);
                this.canonicalIndexMap.set(index, index);
                continue;
            }

            const list = emailKeyToIndices.get(emailKey) || [];
            list.push(index);
            emailKeyToIndices.set(emailKey, list);
        }

        for (const [emailKey, indices] of emailKeyToIndices.entries()) {
            indices.sort((a, b) => a - b);
            const keptIndex = indices[indices.length - 1];
            this.rotationIndices.push(keptIndex);

            const duplicateIndices = [];
            for (const index of indices) {
                this.canonicalIndexMap.set(index, keptIndex);
                if (index !== keptIndex) {
                    duplicateIndices.push(index);
                }
            }

            if (duplicateIndices.length > 0) {
                this.duplicateIndices.push(...duplicateIndices);
                this.duplicateGroups.push({
                    email: emailKey,
                    keptIndex,
                    removedIndices: duplicateIndices,
                });
            }
        }

        this.rotationIndices = [...new Set(this.rotationIndices)].sort((a, b) => a - b);
        this.duplicateIndices = [...new Set(this.duplicateIndices)].sort((a, b) => a - b);

        if (this.duplicateIndices.length > 0) {
            this.logger.warn(
                `[Auth] Detected ${this.duplicateIndices.length} duplicate auth files (same email). ` +
                    `Rotation will only use latest index per account: [${this.rotationIndices.join(", ")}].`
            );
        }

        if (this.expiredIndices.length > 0) {
            this.logger.warn(
                `[Auth] Detected ${this.expiredIndices.length} expired auth files: [${this.expiredIndices.join(", ")}]. ` +
                    `These accounts are excluded from automatic rotation.`
            );
        }
        if (this.disabledIndices.length > 0) {
            this.logger.warn(
                `[Auth] Detected ${this.disabledIndices.length} disabled auth files: [${this.disabledIndices.join(", ")}]. ` +
                    `These accounts are excluded from automatic rotation.`
            );
        }
    }

    _getAuthContent(index) {
        const data = this.store.read(index);
        return data ? JSON.stringify(data) : null;
    }

    getAuth(index) {
        if (!this.availableIndices.includes(index)) {
            this.logger.error(`[Auth] Requested invalid or non-existent authentication index: ${index}`);
            return null;
        }

        const jsonString = this._getAuthContent(index);
        if (!jsonString) {
            this.logger.error(`[Auth] Unable to retrieve content for authentication source #${index} during read.`);
            return null;
        }

        try {
            return JSON.parse(jsonString);
        } catch (e) {
            this.logger.error(`[Auth] Failed to parse JSON content from authentication source #${index}: ${e.message}`);
            return null;
        }
    }

    getStatusMetadata(index) {
        return this.accountStatusMap.get(index) || { disabledAt: null, disabledReason: null, disabledStatus: null };
    }

    getRotationIndices() {
        return this.rotationIndices;
    }

    getCanonicalIndex(index) {
        if (!Number.isInteger(index)) return null;
        if (!this.availableIndices.includes(index)) return null;
        return this.canonicalIndexMap.get(index) ?? index;
    }

    getDuplicateGroups() {
        return this.duplicateGroups;
    }

    /** Persist before changing the rotation view. Missing accounts retain boolean semantics;
     * storage errors reject so callers cannot mistake a failed save for a no-op.
     */
    async markAsExpired(index, options = {}) {
        if (!this.availableIndices.includes(index)) return false;
        const metadata = this.store.getMetadata(index);
        if (!metadata) return false;
        if (metadata.expired && metadata.disabled) return false;
        const result = await this.store.updateState(
            index,
            {
                disabled: true,
                disabledAt: metadata.disabledAt || new Date().toISOString(),
                disabledReason: metadata.disabledReason || "expired",
                expired: true,
            },
            { expectedStateVersion: metadata.stateVersion, ...options }
        );
        this.reloadAuthSources(true);
        return result.changed;
    }

    async unmarkAsExpired(index, options = {}) {
        if (!this.availableIndices.includes(index)) return false;
        const metadata = this.store.getMetadata(index);
        if (!metadata?.expired) return false;
        const patch = { expired: null };
        if (metadata.disabledReason === "expired") {
            Object.assign(patch, { disabled: null, disabledAt: null, disabledReason: null, disabledStatus: null });
        }
        const result = await this.store.updateState(index, patch, {
            expectedStateVersion: metadata.stateVersion,
            ...options,
        });
        this.reloadAuthSources(true);
        return result.changed;
    }

    async disableAuth(index, metadata = {}, options = {}) {
        if (!this.availableIndices.includes(index)) return false;
        const current = this.store.getMetadata(index);
        if (!current) return false;
        const reason = String(metadata.reason || current.disabledReason || "manual");
        const patch = { disabled: true, disabledAt: new Date().toISOString(), disabledReason: reason };
        if (reason === "expired") patch.expired = true;
        if (metadata.status !== undefined) patch.disabledStatus = Number(metadata.status);
        await this.store.updateState(index, patch, options);
        this.reloadAuthSources(true);
        return true;
    }

    async enableAuth(index, options = {}) {
        if (!this.availableIndices.includes(index)) return false;
        await this.store.updateState(
            index,
            { disabled: null, disabledAt: null, disabledReason: null, disabledStatus: null, expired: null },
            options
        );
        this.reloadAuthSources(true);
        return true;
    }

    isDisabled(index) {
        return this.disabledIndices.includes(index);
    }

    isUnavailable(index) {
        return this.isExpired(index) || this.isDisabled(index);
    }

    /**
     * Check if an auth is expired
     * @param {number} index - Auth index to check
     * @returns {boolean}
     */
    isExpired(index) {
        return this.expiredIndices.includes(index);
    }
}

module.exports = AuthSource;
