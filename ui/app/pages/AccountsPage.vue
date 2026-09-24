<template>
    <section class="accounts-page" :aria-label="t('accountManagement')">
        <header class="accounts-header">
            <div>
                <h1>{{ t("accountManagement") }}</h1>
                <p>{{ t("amSubtitle") }}</p>
            </div>
            <div class="toolbar">
                <el-button :disabled="locked" @click="addAccount">{{ t("btnAddUser") }}</el-button>
                <el-button :disabled="locked" @click="fileInput.click()">{{ t("amImport") }}</el-button>
                <el-button :disabled="locked" @click="deduplicate">{{ t("btnDeduplicateAuth") }}</el-button>
                <el-button :disabled="working || loading" @click="refresh">{{ t("amRefresh") }}</el-button>
                <input ref="fileInput" type="file" accept=".json,.zip" multiple hidden @change="importFiles" />
            </div>
        </header>

        <div class="accounts-panel">
            <div class="toolbar filters">
                <el-input
                    v-model="query"
                    :disabled="working"
                    clearable
                    :placeholder="t('amSearch')"
                    :aria-label="t('amSearch')"
                />
                <el-select v-model="status" :disabled="working" :aria-label="t('amFilter')">
                    <el-option v-for="value in statuses" :key="value" :value="value" :label="t(`amFilter_${value}`)" />
                </el-select>
                <span class="muted">{{ t("amTotal", { count: filtered.length, total: accounts.length }) }}</span>
            </div>
            <div class="toolbar selection-toolbar">
                <el-checkbox
                    :model-value="pageSelected"
                    :indeterminate="pageSomeSelected && !pageSelected"
                    :disabled="working || !pageRows.length"
                    @change="selectPage"
                    >{{ t("amSelectPage") }}</el-checkbox
                >
                <el-button text :disabled="working || !filtered.length" @click="selectFiltered">{{
                    t("amSelectFiltered", { count: filtered.length })
                }}</el-button>
                <el-button text :disabled="working || !selected.size" @click="selected.clear()">{{
                    t("amClearSelection")
                }}</el-button>
                <strong>{{ t("selectedCount", { count: selected.size }) }}</strong>
            </div>
            <div class="toolbar batch-toolbar" :aria-label="t('amBatchActions')">
                <el-button
                    v-for="action in actions"
                    :key="action"
                    :type="action === 'delete' ? 'danger' : 'default'"
                    plain
                    :disabled="locked || !selected.size"
                    @click="start(action)"
                    >{{ t(`amAction_${action}`) }}</el-button
                >
            </div>
            <div v-if="working" class="progress-panel" role="status" aria-live="polite">
                <div class="toolbar">
                    <span>{{ t("amProgress", { done: completed, total: results.length }) }}</span
                    ><el-button v-if="queueRunning" :disabled="stopRequested" @click="stopRequested = true">{{
                        t(stopRequested ? "amStopping" : "amStop")
                    }}</el-button>
                </div>
                <el-progress :percentage="results.length ? Math.round((completed / results.length) * 100) : 0" />
            </div>
            <el-alert v-if="loadError" :title="t('amLoadFailed')" type="error" :closable="false" show-icon>
                <a href="/login">{{ t("amLoginAgain") }}</a>
            </el-alert>
            <p v-if="loading && !accounts.length" class="empty-state">{{ t("loading") }}</p>
            <p v-else-if="!filtered.length" class="empty-state">
                {{ t(accounts.length ? "amNoMatches" : "amNoAccounts") }}
            </p>
            <div v-else class="table-scroll" role="region" :aria-label="t('amAccountTable')" tabindex="0">
                <p class="mobile-table-hint">{{ t("amScrollHint") }}</p>
                <table class="accounts-table">
                    <thead>
                        <tr>
                            <th>{{ t("amSelect") }}</th>
                            <th>{{ t("amAccount") }}</th>
                            <th>{{ t("amStatus") }}</th>
                            <th>{{ t("accountCooldown") }}</th>
                            <th>{{ t("todayStats") }}</th>
                            <th>{{ t("amOperations") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="account in pageRows"
                            :key="account.index"
                            :class="{ selected: selected.has(account.index) }"
                        >
                            <td>
                                <el-checkbox
                                    :model-value="selected.has(account.index)"
                                    :disabled="working"
                                    :aria-label="t('amSelectAccount', { index: account.index })"
                                    @change="value => selectOne(account.index, value)"
                                />
                            </td>
                            <td class="identity">
                                <span class="muted">#{{ account.index }}</span
                                ><strong>{{ account.name || t("unnamedAccount") }}</strong
                                ><el-tag v-if="account.index === currentIndex" size="small">{{
                                    t("tagCurrent")
                                }}</el-tag>
                            </td>
                            <td>
                                <div class="status-tags">
                                    <el-tag
                                        v-for="tag in accountTags(account)"
                                        :key="tag"
                                        :type="tag === 'enabled' ? 'success' : 'warning'"
                                        size="small"
                                        >{{ t(`amFilter_${tag}`) }}</el-tag
                                    >
                                </div>
                                <small v-if="account.disabledReason || account.disabledStatus"
                                    >{{ account.disabledReason }} {{ account.disabledStatus }}</small
                                ><small v-if="account.isDuplicate">{{
                                    t("duplicateAuthHint", { index: account.canonicalIndex })
                                }}</small>
                            </td>
                            <td>
                                <span v-if="!hasCooldown(account, now)" class="muted">—</span>
                                <div v-if="new Date(account.route?.cooldownUntil || 0).getTime() > now">
                                    {{ remaining(account.route.cooldownUntil) }}
                                </div>
                                <small
                                    v-for="cooldown in (account.route?.cooldownModels || []).filter(
                                        item => new Date(item.until).getTime() > now
                                    )"
                                    :key="cooldown.model"
                                    >{{ cooldown.model }} · {{ remaining(cooldown.until) }}</small
                                ><small v-if="account.route?.inFlight"
                                    >{{ t("accountInFlight") }}: {{ account.route.inFlight }}</small
                                >
                            </td>
                            <td>
                                <div class="today-counts">
                                    <span class="success">✓ {{ account.todayStats?.successCount || 0 }}</span
                                    ><span class="failure">✗ {{ account.todayStats?.failureCount || 0 }}</span>
                                </div>
                                <details v-if="account.todayStats?.models?.length">
                                    <summary>{{ t("amModelDetails") }}</summary>
                                    <small v-for="model in account.todayStats.models" :key="model.model"
                                        >{{ model.model }}: {{ model.successCount }}/{{ model.failureCount }}</small
                                    >
                                </details>
                            </td>
                            <td>
                                <div class="row-actions">
                                    <el-button
                                        size="small"
                                        :disabled="locked"
                                        @click="start(account.isDisabled ? 'enable' : 'disable', [account.index])"
                                        >{{ t(account.isDisabled ? "enableAccount" : "disableAccount") }}</el-button
                                    >
                                    <el-button
                                        size="small"
                                        :disabled="locked"
                                        @click="start('test', [account.index])"
                                        >{{ t("testAccount") }}</el-button
                                    >
                                    <el-button
                                        size="small"
                                        :disabled="
                                            locked || account.index === currentIndex || !!testSkipReason(account)
                                        "
                                        @click="switchAccount(account)"
                                        >{{ t("btnSwitchAccount") }}</el-button
                                    >
                                    <el-button size="small" :disabled="locked" @click="downloadOne(account)">{{
                                        t("download")
                                    }}</el-button>
                                    <el-button
                                        size="small"
                                        type="danger"
                                        plain
                                        :disabled="locked"
                                        @click="start('delete', [account.index])"
                                        >{{ t("amDelete") }}</el-button
                                    >
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div class="pagination">
                <el-pagination
                    v-model:current-page="page"
                    v-model:page-size="pageSize"
                    :page-sizes="[20, 50, 100]"
                    :total="filtered.length"
                    :disabled="working"
                    layout="total, sizes, prev, pager, next"
                    :pager-count="5"
                />
            </div>
        </div>

        <section v-if="results.length" class="accounts-panel results-panel" :aria-label="t('amResults')">
            <div class="toolbar">
                <h2>{{ t("amResults") }}</h2>
                <el-button :disabled="locked || !retryIndices.length" @click="start(lastAction, retryIndices)">{{
                    t("amRetryFailed", { count: retryIndices.length })
                }}</el-button
                ><a v-if="sessionExpired" href="/login">{{ t("amLoginAgain") }}</a>
            </div>
            <div class="result-summary">
                <span v-for="entry in resultCounts" :key="entry.state"
                    >{{ t(`amResult_${entry.state}`) }}: {{ entry.count }}</span
                >
            </div>
            <p v-if="results.some(row => row.state === 'unknown')" class="muted">{{ t("amUnknownHint") }}</p>
            <div class="result-list">
                <div v-for="(row, i) in results" :key="`${row.index}-${i}`" class="result-row">
                    <span>{{ row.name || `#${row.index}` }}</span
                    ><el-tag :type="resultType(row.state)" size="small">{{ t(`amResult_${row.state}`) }}</el-tag
                    ><span>{{ t(row.message || "") }}</span>
                </div>
            </div>
        </section>
    </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import JSZip from "jszip";
import I18n from "../utils/i18n";
import {
    classifyAccountResult,
    classifyDeletedAccount,
    filterAccounts,
    hasCooldown,
    requestAccountJson,
    runAccountQueue,
    testSkipReason,
} from "../utils/accountManagement";

const props = defineProps({
    accounts: { default: () => [], type: Array },
    currentIndex: { default: -1, type: Number },
    loadError: Boolean,
    loading: Boolean,
    refresh: { required: true, type: Function },
    systemBusy: Boolean,
});
const router = useRouter();
const language = ref(0);
const unsubscribe = I18n.onChange(() => language.value++);
const t = (key, options) => {
    language.value;
    return key ? I18n.t(key, options) : "";
};
const statuses = ["all", "enabled", "disabled", "expired", "invalid", "duplicate", "cooldown"];
const actions = ["enable", "disable", "test", "delete", "export"];
const query = ref("");
const status = ref("all");
const page = ref(1);
const pageSize = ref(20);
const selected = reactive(new Set());
const now = ref(Date.now());
const timer = setInterval(() => {
    now.value = Date.now();
}, 1000);
const filtered = computed(() => filterAccounts(props.accounts, query.value, status.value, now.value));
const pageRows = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
const pageSelected = computed(() => pageRows.value.length > 0 && pageRows.value.every(row => selected.has(row.index)));
const pageSomeSelected = computed(() => pageRows.value.some(row => selected.has(row.index)));
const working = ref(false);
const locked = computed(() => working.value || props.systemBusy || props.loadError || props.loading);
const queueRunning = ref(false);
const stopRequested = ref(false);
const results = ref([]);
const lastAction = ref("");
const sessionExpired = ref(false);
const fileInput = ref(null);
let operation = Promise.resolve();
const completed = computed(() => results.value.filter(row => !["pending", "running"].includes(row.state)).length);
const retryIndices = computed(() =>
    ["enable", "disable", "test", "delete", "export"].includes(lastAction.value)
        ? results.value
              .filter(row => row.state === "failed" && props.accounts.some(account => account.index === row.index))
              .map(row => row.index)
        : []
);
const resultCounts = computed(() =>
    [...new Set(results.value.map(row => row.state))].map(value => ({
        count: results.value.filter(row => row.state === value).length,
        state: value,
    }))
);
watch([query, status], () => {
    selected.clear();
    page.value = 1;
});
watch(pageSize, () => {
    page.value = 1;
});
watch(
    () => props.accounts,
    accounts => {
        const valid = new Set(accounts.map(account => account.index));
        for (const index of selected) if (!valid.has(index)) selected.delete(index);
    }
);
watch(
    () => filtered.value.length,
    count => {
        page.value = Math.min(page.value, Math.max(1, Math.ceil(count / pageSize.value)));
    }
);
const selectOne = (index, value) => (value ? selected.add(index) : selected.delete(index));
const selectPage = value => pageRows.value.forEach(row => selectOne(row.index, value));
const selectFiltered = () => filtered.value.forEach(row => selected.add(row.index));
const accountTags = account => {
    const tags = ["disabled", "expired", "invalid", "duplicate"].filter(
        tag => account[`is${tag[0].toUpperCase()}${tag.slice(1)}`]
    );
    return tags.length ? tags : ["enabled"];
};
const remaining = until => `${Math.max(1, Math.ceil((new Date(until).getTime() - now.value) / 60000))}m`;
const resultType = value =>
    value === "success"
        ? "success"
        : value === "failed"
          ? "danger"
          : ["cleanup", "unknown"].includes(value)
            ? "warning"
            : "info";
const confirm = async message => {
    try {
        await ElMessageBox.confirm(message, t("warningTitle"), {
            cancelButtonText: t("cancel"),
            confirmButtonText: t("ok"),
            type: "warning",
        });
        return true;
    } catch {
        return false;
    }
};
const request = async (...args) => {
    try {
        return await requestAccountJson(...args);
    } catch (error) {
        if (error.halt) sessionExpired.value = true;
        throw error;
    }
};
const makeRows = indices =>
    [...new Set(indices)].map(index => ({
        index,
        message: "",
        name: `#${index} ${props.accounts.find(account => account.index === index)?.name || ""}`,
        state: "pending",
    }));
const markError = (rows, error) =>
    rows.forEach(row => Object.assign(row, { message: error.message, state: error.unknown ? "unknown" : "failed" }));

const start = async (action, indices = [...selected]) => {
    if (locked.value || !indices.length) return;
    working.value = true; // Lock before confirmation, including double clicks.
    try {
        if (["enable", "disable", "delete"].includes(action)) {
            let message = t("amConfirm", { action: t(`amAction_${action}`), count: indices.length });
            if (indices.includes(props.currentIndex)) message += `\n${t("amIncludesCurrent")}`;
            const enabled = props.accounts.filter(
                account => !account.isDisabled && !account.isExpired && !account.isInvalid && !account.isDuplicate
            );
            if (action === "disable" && enabled.length && enabled.every(account => indices.includes(account.index)))
                message += `\n${t("amDisableAllWarning")}`;
            if (!(await confirm(message))) return;
        }
        results.value = makeRows(indices);
        lastAction.value = action;
        sessionExpired.value = false;
        stopRequested.value = false;
        operation = execute(action);
        await operation;
    } finally {
        working.value = false;
        queueRunning.value = false;
        await props.refresh();
    }
};

const execute = async action => {
    if (["enable", "disable", "test"].includes(action)) {
        queueRunning.value = true;
        await runAccountQueue({
            action,
            getAccount: index => props.accounts.find(account => account.index === index),
            request,
            rows: results.value,
            stopped: () => stopRequested.value,
        });
        return;
    }
    const rows = results.value;
    rows.forEach(row => {
        row.state = "running";
    });
    try {
        if (action === "delete") {
            const indices = rows.map(row => row.index);
            let response = await request("/api/accounts/batch", "DELETE", { indices });
            if (response.status === 409 && response.data.requiresConfirmation) {
                if (!(await confirm(t("warningDeleteCurrentAccount")))) {
                    rows.forEach(row => Object.assign(row, { message: "amNotExecutedHint", state: "unexecuted" }));
                    return;
                }
                response = await request("/api/accounts/batch", "DELETE", { force: true, indices });
            }
            rows.forEach(row => Object.assign(row, classifyDeletedAccount(row.index, response)));
        } else if (action === "export") {
            const blob = await fetchDownload("/api/accounts/batch/download", { indices: rows.map(row => row.index) });
            const zip = await JSZip.loadAsync(blob);
            rows.forEach(row =>
                Object.assign(row, {
                    message: zip.file(`auth-${row.index}.json`) ? "" : "amExportMissing",
                    state: zip.file(`auth-${row.index}.json`) ? "success" : "failed",
                })
            );
            saveBlob(blob, "auth_batch.zip");
        }
    } catch (error) {
        markError(rows, error);
    }
};

const fetchDownload = async (url, body) => {
    let response;
    try {
        response = await fetch(url, {
            body: body ? JSON.stringify(body) : undefined,
            headers: { "Content-Type": "application/json" },
            method: body ? "POST" : "GET",
            redirect: "error",
        });
    } catch {
        sessionExpired.value = true;
        throw new Error("amConnectionLost");
    }
    if (response.status === 401 || response.status === 403) {
        sessionExpired.value = true;
        throw new Error("amSessionExpired");
    }
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || `HTTP ${response.status}`);
    }
    return response.blob();
};
const saveBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const downloadOne = async account => {
    if (locked.value) return;
    working.value = true;
    operation = (async () => {
        try {
            saveBlob(await fetchDownload(`/api/files/auth-${account.index}.json`), `auth-${account.index}.json`);
        } catch (error) {
            ElMessage.error(t(error.message));
        } finally {
            working.value = false;
        }
    })();
    await operation;
};
const addAccount = () => router.push({ path: "/auth", query: { returnTo: "/accounts" } });
const simpleAction = async (message, url, method, body) => {
    if (locked.value) return;
    working.value = true;
    try {
        if (!(await confirm(message))) return;
        operation = (async () => {
            try {
                const response = await request(url, method, body);
                const result = classifyAccountResult(response);
                const data = response.data;
                const message = t(result.message, {
                    ...data,
                    failed: JSON.stringify(data.failed || []),
                    removedIndices: (data.removedIndices || []).join(", "),
                });
                if (result.state === "success" && !data.failed?.length) ElMessage.success(message);
                else ElMessage.warning(message);
            } catch (error) {
                ElMessage.error(t(error.message));
            }
        })();
        await operation;
    } finally {
        working.value = false;
        await props.refresh();
    }
};
const deduplicate = () => simpleAction(t("accountDedupConfirm"), "/api/accounts/deduplicate", "POST");
const switchAccount = account =>
    simpleAction(`${t("confirmSwitch")} #${account.index} ${account.name || ""}?`, "/api/accounts/current", "PUT", {
        targetIndex: account.index,
    });

const importFiles = async event => {
    const files = [...event.target.files];
    event.target.value = "";
    if (locked.value || !files.length) return;
    working.value = true;
    lastAction.value = "import";
    results.value = [];
    operation = (async () => {
        const parsed = [];
        const addFile = (name, text) => {
            const row = { message: "", name, state: "pending" };
            results.value.push(row);
            try {
                parsed.push({ content: JSON.parse(text), row: results.value[results.value.length - 1] });
            } catch {
                Object.assign(results.value[results.value.length - 1], { message: "invalidJson", state: "failed" });
            }
        };
        for (const file of files) {
            try {
                if (file.name.toLowerCase().endsWith(".zip")) {
                    const zip = await JSZip.loadAsync(await file.arrayBuffer());
                    const entries = Object.values(zip.files).filter(
                        entry => !entry.dir && entry.name.toLowerCase().endsWith(".json")
                    );
                    if (!entries.length) throw new Error("zipNoJsonFiles");
                    for (const entry of entries) addFile(`${file.name}/${entry.name}`, await entry.async("string"));
                } else if (file.name.toLowerCase().endsWith(".json")) addFile(file.name, await file.text());
                else throw new Error("noSupportedFiles");
            } catch (error) {
                results.value.push({ message: error.message, name: file.name, state: "failed" });
            }
        }
        if (!parsed.length) return;
        parsed.forEach(item => {
            item.row.state = "running";
        });
        try {
            const response = await request("/api/files/batch", "POST", { files: parsed.map(item => item.content) });
            parsed.forEach((item, index) => {
                const result = response.data.results?.find(row => row.index === index);
                Object.assign(
                    item.row,
                    result
                        ? {
                              message: result.success ? result.filename : result.error,
                              state: result.success ? "success" : "failed",
                          }
                        : response.ok
                          ? { message: "amUnknownResult", state: "unknown" }
                          : classifyAccountResult(response)
                );
            });
        } catch (error) {
            markError(
                parsed.map(item => item.row),
                error
            );
        }
    })();
    try {
        await operation;
    } finally {
        working.value = false;
        await props.refresh();
    }
};

const canLeave = async () => {
    if (!working.value) return true;
    if (!(await confirm(t("amLeaveWarning")))) return false;
    stopRequested.value = true;
    await operation;
    return true;
};
const beforeUnload = event => {
    if (working.value) {
        event.preventDefault();
        event.returnValue = "";
    }
};
window.addEventListener("beforeunload", beforeUnload);
onBeforeUnmount(() => {
    stopRequested.value = true;
    clearInterval(timer);
    unsubscribe();
    window.removeEventListener("beforeunload", beforeUnload);
});
defineExpose({ canLeave });
</script>

<style scoped lang="less">
.accounts-page {
    color: var(--text-primary);
}
.accounts-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 24px;
    flex-wrap: wrap;
}
h1 {
    font-size: 26px;
    margin: 0 0 8px;
}
h2 {
    font-size: 18px;
    margin: 0;
}
p {
    margin: 0;
    color: var(--text-secondary);
}
.accounts-panel {
    background: var(--bg-card);
    border: 1px solid var(--border-light);
    border-radius: 14px;
    padding: 20px;
    margin-bottom: 20px;
}
.toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}
.toolbar :deep(.el-button),
.row-actions :deep(.el-button) {
    margin-left: 0;
}
.filters {
    margin-bottom: 16px;
}
.filters :deep(.el-input) {
    width: 280px;
}
.filters :deep(.el-select) {
    width: 170px;
}
.selection-toolbar {
    border-top: 1px solid var(--border-light);
    padding-top: 12px;
}
.batch-toolbar {
    padding: 12px 0 18px;
}
.table-scroll {
    overflow-x: auto;
}
.accounts-table {
    width: 100%;
    min-width: 1040px;
    border-collapse: collapse;
    text-align: left;
    font-size: 13px;
}
th {
    background: var(--bg-body);
    color: var(--text-secondary);
    white-space: nowrap;
    font-weight: 500;
}
td,
th {
    padding: 12px 10px;
    border-bottom: 1px solid var(--border-light);
    vertical-align: top;
}
tr.selected {
    background: rgba(var(--color-primary-rgb), 0.06);
}
.identity {
    min-width: 220px;
    overflow-wrap: anywhere;
}
.identity strong {
    display: block;
    margin: 4px 0;
}
.status-tags {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}
small {
    display: block;
    min-width: 100px;
    overflow-wrap: anywhere;
    margin-top: 5px;
    color: var(--text-secondary);
}
.row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 185px;
    max-width: 260px;
}
.today-counts {
    display: flex;
    gap: 12px;
    white-space: nowrap;
}
.success {
    color: var(--el-color-success);
}
.failure {
    color: var(--el-color-danger);
}
.muted {
    color: var(--text-secondary);
    font-size: 13px;
}
summary {
    cursor: pointer;
    margin-top: 5px;
    white-space: nowrap;
}
.pagination {
    display: flex;
    justify-content: flex-end;
    margin-top: 18px;
    overflow-x: auto;
}
.empty-state {
    text-align: center;
    padding: 48px 16px;
}
.progress-panel {
    padding: 12px 0;
}
.result-summary {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    margin: 14px 0;
    font-size: 13px;
}
.result-list {
    max-height: 350px;
    overflow: auto;
    margin-top: 12px;
}
.result-row {
    display: grid;
    grid-template-columns: minmax(150px, 1fr) 130px minmax(180px, 2fr);
    gap: 12px;
    padding: 10px 0;
    border-top: 1px solid var(--border-light);
    font-size: 13px;
    overflow-wrap: anywhere;
}
.result-row :deep(.el-tag) {
    justify-self: start;
}
.mobile-table-hint {
    display: none;
}
@media (max-width: 600px) {
    .mobile-table-hint {
        display: block;
        margin-bottom: 12px;
        font-size: 12px;
    }
    .accounts-panel {
        padding: 12px;
    }
    .filters :deep(.el-input),
    .filters :deep(.el-select) {
        width: 100%;
    }
    .pagination {
        justify-content: flex-start;
    }
    .result-row {
        grid-template-columns: 1fr;
        gap: 6px;
    }
}
</style>
