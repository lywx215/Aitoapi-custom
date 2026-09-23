<template>
    <div class="model-probe-panel">
        <header class="model-probe-header">
            <div>
                <h1>{{ t("modelProbeTitle") }}</h1>
                <p>{{ t("modelProbeDescription") }}</p>
            </div>
            <div class="model-probe-actions">
                <button v-if="isRunning" class="probe-button probe-button-danger" @click="cancelProbe">
                    {{ t("modelProbeCancel") }}
                </button>
                <button v-else class="probe-button" :disabled="loading || !availableAccountCount" @click="startProbe">
                    {{ t("modelProbeStart") }}
                </button>
            </div>
        </header>

        <div v-if="errorMessage" class="probe-alert probe-alert-error">{{ errorMessage }}</div>
        <div v-if="stale" class="probe-alert probe-alert-warning">{{ t("modelProbeStale") }}</div>
        <div v-if="!availableAccountCount" class="probe-alert probe-alert-warning">
            {{ t("modelProbeNoAccount") }}
        </div>

        <section v-if="currentRun" class="probe-progress-card">
            <div class="probe-progress-heading">
                <span>{{ runStatusText }}</span>
                <span
                    >{{ currentRun.completedModels || 0 }} /
                    {{ currentRun.totalModels || catalog.totalModels || 0 }}</span
                >
            </div>
            <el-progress :percentage="progressPercent" :status="progressStatus" />
            <div class="probe-progress-detail">
                <span v-if="currentRun.currentModel">
                    {{ t("modelProbeCurrentModel") }}：<code>{{ currentRun.currentModel }}</code>
                </span>
                <span v-if="currentRun.currentAccountIndex !== null && currentRun.currentAccountIndex !== undefined">
                    {{ t("modelProbeCurrentAccount") }}：#{{ currentRun.currentAccountIndex }}
                </span>
            </div>
        </section>

        <section class="probe-summary-grid">
            <div class="probe-summary-card">
                <span>{{ t("modelProbeTotal") }}</span>
                <strong>{{ summary.total }}</strong>
            </div>
            <div class="probe-summary-card probe-summary-success">
                <span>{{ t("modelProbeAvailable") }}</span>
                <strong>{{ summary.available }}</strong>
            </div>
            <div class="probe-summary-card probe-summary-error">
                <span>{{ t("modelProbeUnavailable") }}</span>
                <strong>{{ summary.unavailable }}</strong>
            </div>
            <div class="probe-summary-card probe-summary-warning">
                <span>{{ t("modelProbeIndeterminate") }}</span>
                <strong>{{ summary.indeterminate }}</strong>
            </div>
        </section>

        <div class="probe-meta">
            <span>{{ t("modelProbeAccounts") }}：{{ availableAccountCount }}</span>
            <span>{{ t("modelProbeTextModels") }}：{{ catalog.textModels || 0 }}</span>
            <span>{{ t("modelProbeImageModels") }}：{{ catalog.imageModels || 0 }}</span>
            <span v-if="lastCompleted?.finishedAt">
                {{ t("modelProbeLastCompleted") }}：{{ formatDate(lastCompleted.finishedAt) }}
            </span>
        </div>

        <section class="probe-results-card">
            <div class="probe-filters">
                <el-input v-model="search" clearable :placeholder="t('modelProbeSearch')" />
                <el-select v-model="typeFilter">
                    <el-option :label="t('modelProbeAllTypes')" value="all" />
                    <el-option :label="t('modelProbeText')" value="text" />
                    <el-option :label="t('modelProbeImage')" value="image" />
                </el-select>
                <el-select v-model="statusFilter">
                    <el-option :label="t('modelProbeAllStatuses')" value="all" />
                    <el-option :label="t('modelProbeAvailable')" value="available" />
                    <el-option :label="t('modelProbeUnavailable')" value="unavailable" />
                    <el-option :label="t('modelProbeIndeterminate')" value="indeterminate" />
                    <el-option :label="t('modelProbeNotTested')" value="not_tested" />
                </el-select>
            </div>

            <div class="probe-table-wrap">
                <table class="probe-table">
                    <thead>
                        <tr>
                            <th>{{ t("modelProbeModel") }}</th>
                            <th>{{ t("modelProbeType") }}</th>
                            <th>{{ t("modelProbeStatus") }}</th>
                            <th>{{ t("modelProbeSuccessfulAccount") }}</th>
                            <th>HTTP</th>
                            <th>{{ t("modelProbeDuration") }}</th>
                            <th>{{ t("modelProbeTestedAt") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="result in filteredResults" :key="result.model">
                            <td>
                                <strong>{{ result.displayName }}</strong>
                                <code>{{ result.model }}</code>
                            </td>
                            <td>{{ result.type === "image" ? t("modelProbeImage") : t("modelProbeText") }}</td>
                            <td>
                                <span class="probe-status" :class="`probe-status-${result.status}`">
                                    {{ statusText(result.status) }}
                                </span>
                                <small v-if="latestAttempt(result)?.errorCode">
                                    {{ errorCodeText(latestAttempt(result).errorCode) }}
                                </small>
                            </td>
                            <td>
                                <template v-if="result.successfulAccount?.accountIndex !== undefined">
                                    #{{ result.successfulAccount.accountIndex }}
                                    <small v-if="result.successfulAccount.accountId">
                                        {{ result.successfulAccount.accountId }}
                                    </small>
                                </template>
                                <template v-else>—</template>
                            </td>
                            <td>{{ latestAttempt(result)?.httpStatus ?? "—" }}</td>
                            <td>{{ formatDuration(latestAttempt(result)?.durationMs) }}</td>
                            <td>{{ formatDate(result.testedAt) }}</td>
                        </tr>
                        <tr v-if="filteredResults.length === 0">
                            <td colspan="7" class="probe-empty">{{ t("modelProbeNoResults") }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>
    </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import I18n from "../utils/i18n";

const loading = ref(false);
const state = ref({
    availableAccountCount: 0,
    catalog: { models: [] },
    currentRun: null,
    lastCompleted: null,
    stale: false,
});
const search = ref("");
const typeFilter = ref("all");
const statusFilter = ref("all");
const errorMessage = ref("");
const languageVersion = ref(0);
let pollTimer = null;
let active = true;
let unsubscribeLanguage = null;

const t = (key, options) => {
    languageVersion.value;
    return I18n.t(key, options);
};

const catalog = computed(() => state.value.catalog || { models: [] });
const currentRun = computed(() => state.value.currentRun);
const lastCompleted = computed(() => state.value.lastCompleted);
const stale = computed(() => state.value.stale === true);
const availableAccountCount = computed(() => state.value.availableAccountCount || 0);
const isRunning = computed(() => currentRun.value?.status === "running" || currentRun.value?.status === "queued");
const displayResults = computed(() => {
    if (isRunning.value && currentRun.value?.results?.length) return currentRun.value.results;
    if (lastCompleted.value?.results?.length) return lastCompleted.value.results;
    return (catalog.value.models || []).map(model => ({ ...model, attempts: [], status: "not_tested" }));
});
const filteredResults = computed(() => {
    const keyword = search.value.trim().toLowerCase();
    return displayResults.value.filter(result => {
        if (typeFilter.value !== "all" && result.type !== typeFilter.value) return false;
        if (statusFilter.value !== "all" && result.status !== statusFilter.value) return false;
        if (!keyword) return true;
        return `${result.model} ${result.displayName}`.toLowerCase().includes(keyword);
    });
});
const summary = computed(() => ({
    available: displayResults.value.filter(item => item.status === "available").length,
    indeterminate: displayResults.value.filter(item => item.status === "indeterminate").length,
    total: displayResults.value.length,
    unavailable: displayResults.value.filter(item => item.status === "unavailable").length,
}));
const progressPercent = computed(() => {
    const total = currentRun.value?.totalModels || 0;
    return total ? Math.round(((currentRun.value?.completedModels || 0) / total) * 100) : 0;
});
const progressStatus = computed(() => {
    if (currentRun.value?.status === "succeeded") return "success";
    if (["failed", "cancelled", "interrupted"].includes(currentRun.value?.status)) return "exception";
    return undefined;
});
const runStatusText = computed(() => t(`modelProbeRun_${currentRun.value?.status || "idle"}`));

const latestAttempt = result => result?.attempts?.[result.attempts.length - 1] || null;
const statusText = status => t(`modelProbeStatus_${status || "not_tested"}`);
const errorCodeText = code => t(`modelProbeError_${code}`, { fallback: code });
const formatDuration = value => (Number.isFinite(value) ? `${(value / 1000).toFixed(2)} s` : "—");
const formatDate = value => (value ? new Date(value).toLocaleString() : "—");

const schedulePoll = () => {
    clearTimeout(pollTimer);
    if (!active || !isRunning.value) return;
    pollTimer = setTimeout(fetchState, 1500);
};

const fetchState = async () => {
    try {
        const response = await fetch("/api/model-probes", { cache: "no-store" });
        if (response.status === 401 || response.redirected) {
            window.location.href = response.url || "/login";
            return;
        }
        const data = await response.json();
        if (!response.ok) throw new Error(t(data.message || "modelProbeStateUnavailable"));
        state.value = data;
        errorMessage.value = "";
    } catch (error) {
        errorMessage.value = error.message || t("modelProbeStateUnavailable");
    } finally {
        loading.value = false;
        schedulePoll();
    }
};

const startProbe = async () => {
    try {
        await ElMessageBox.confirm(
            t("modelProbeConfirm", { count: catalog.value.totalModels || displayResults.value.length }),
            t("modelProbeConfirmTitle"),
            {
                cancelButtonText: t("cancel"),
                confirmButtonText: t("ok"),
                lockScroll: false,
                type: "warning",
            }
        );
    } catch {
        return;
    }
    loading.value = true;
    try {
        const response = await fetch("/api/model-probes/runs", {
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        const data = await response.json();
        if (!response.ok) throw new Error(t(data.message || "modelProbeStartFailed"));
        ElMessage.success(t("modelProbeStarted"));
        await fetchState();
    } catch (error) {
        loading.value = false;
        ElMessage.error(error.message || t("modelProbeStartFailed"));
    }
};

const cancelProbe = async () => {
    if (!currentRun.value?.runId) return;
    try {
        const response = await fetch(`/api/model-probes/runs/${encodeURIComponent(currentRun.value.runId)}/cancel`, {
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        const data = await response.json();
        if (!response.ok) throw new Error(t(data.message || "modelProbeCancelFailed"));
        ElMessage.success(t("modelProbeCancelRequested"));
        await fetchState();
    } catch (error) {
        ElMessage.error(error.message || t("modelProbeCancelFailed"));
    }
};

onMounted(() => {
    unsubscribeLanguage = I18n.onChange(() => {
        languageVersion.value++;
    });
    loading.value = true;
    fetchState();
});

onBeforeUnmount(() => {
    active = false;
    clearTimeout(pollTimer);
    unsubscribeLanguage?.();
});
</script>

<style scoped lang="less">
@import "../styles/variables.less";

.model-probe-panel {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
}

.model-probe-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;

    h1 {
        margin: 0 0 0.4rem;
        color: @text-primary;
        font-size: 1.5rem;
    }

    p {
        margin: 0;
        color: @text-secondary;
    }
}

.model-probe-actions {
    flex-shrink: 0;
}

.probe-button {
    padding: 0.7rem 1.1rem;
    border: 0;
    border-radius: 9px;
    background: @primary-color;
    color: @text-on-primary;
    cursor: pointer;
    font-weight: 600;

    &:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }
}

.probe-button-danger {
    background: @error-color;
}

.probe-alert,
.probe-progress-card,
.probe-results-card,
.probe-summary-card {
    border: 1px solid @border-light;
    border-radius: 12px;
    background: @background-white;
}

.probe-alert {
    padding: 0.85rem 1rem;
}

.probe-alert-warning {
    border-color: rgba(var(--color-warning-rgb), 0.35);
    color: @warning-color;
}

.probe-alert-error {
    border-color: rgba(var(--color-error-rgb), 0.35);
    color: @error-color;
}

.probe-progress-card {
    padding: 1rem;
}

.probe-progress-heading,
.probe-progress-detail,
.probe-meta,
.probe-filters {
    display: flex;
    align-items: center;
    gap: 1rem;
}

.probe-progress-heading {
    justify-content: space-between;
    margin-bottom: 0.65rem;
    font-weight: 600;
}

.probe-progress-detail,
.probe-meta {
    flex-wrap: wrap;
    margin-top: 0.65rem;
    color: @text-secondary;
    font-size: 0.9rem;
}

.probe-summary-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1rem;
}

.probe-summary-card {
    padding: 1rem;

    span {
        display: block;
        color: @text-secondary;
        font-size: 0.9rem;
    }

    strong {
        display: block;
        margin-top: 0.35rem;
        color: @text-primary;
        font-size: 1.75rem;
    }
}

.probe-summary-success strong {
    color: @success-color;
}

.probe-summary-error strong {
    color: @error-color;
}

.probe-summary-warning strong {
    color: @warning-color;
}

.probe-results-card {
    overflow: hidden;
}

.probe-filters {
    padding: 1rem;
    border-bottom: 1px solid @border-light;

    .el-input {
        max-width: 360px;
    }

    .el-select {
        width: 180px;
    }
}

.probe-table-wrap {
    overflow-x: auto;
}

.probe-table {
    width: 100%;
    min-width: 960px;
    border-collapse: collapse;

    th,
    td {
        padding: 0.85rem 1rem;
        border-bottom: 1px solid @border-light;
        color: @text-primary;
        text-align: left;
        vertical-align: middle;
    }

    th {
        background: @background-light;
        color: @text-secondary;
        font-size: 0.82rem;
        font-weight: 600;
    }

    td:first-child {
        min-width: 250px;

        strong,
        code {
            display: block;
        }

        code {
            margin-top: 0.25rem;
            color: @text-secondary;
            font-size: 0.78rem;
        }
    }

    td small {
        display: block;
        margin-top: 0.3rem;
        color: @text-secondary;
    }
}

.probe-status {
    display: inline-flex;
    padding: 0.25rem 0.55rem;
    border-radius: 999px;
    background: @background-light;
    font-size: 0.78rem;
    font-weight: 600;
}

.probe-status-available {
    background: rgba(var(--color-success-rgb), 0.12);
    color: @success-color;
}

.probe-status-unavailable {
    background: rgba(var(--color-error-rgb), 0.12);
    color: @error-color;
}

.probe-status-indeterminate {
    background: rgba(var(--color-warning-rgb), 0.12);
    color: @warning-color;
}

.probe-empty {
    padding: 2rem !important;
    color: @text-secondary !important;
    text-align: center !important;
}

@media (max-width: 900px) {
    .probe-summary-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 640px) {
    .model-probe-header,
    .probe-filters {
        align-items: stretch;
        flex-direction: column;
    }

    .probe-button,
    .probe-filters .el-input,
    .probe-filters .el-select {
        width: 100%;
        max-width: none;
    }
}
</style>
