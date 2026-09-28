<template>
    <section v-if="run || error || actionError" class="credential-tests accounts-panel" :aria-label="t('ctTitle')">
        <div class="ct-toolbar">
            <h2>{{ t("ctTitle") }}</h2>
            <span v-if="run"
                >{{ run.model }} · {{ t(`ctRun_${run.status}`) }} · {{ done }}/{{ run.results.length }}</span
            >
            <el-button v-if="running" :disabled="submitting || run.stopRequested" @click="stop">
                {{ t(run.stopRequested ? "amStopping" : "ctStop") }}
            </el-button>
            <el-button
                v-else-if="run"
                :disabled="disabled || submitting || !retryIndices.length"
                @click="start(retryIndices)"
            >
                {{ t("ctRetry", { count: retryIndices.length }) }}
            </el-button>
            <el-button :disabled="submitting" @click="fetchState">{{ t("ctRefresh") }}</el-button>
        </div>
        <p v-if="running">{{ t("ctBackground") }}</p>
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <el-alert v-if="actionError" :title="actionError" type="error" :closable="false" />
        <el-alert v-if="actionNotice" :title="actionNotice" type="info" :closable="false" />
        <el-progress v-if="run" :percentage="Math.round((done / run.results.length) * 100)" />
        <div v-for="row in run?.results || []" :key="row.index" class="ct-result">
            <div class="ct-toolbar">
                <strong>#{{ row.index }} {{ row.name }}</strong>
                <el-tag :type="row.state === 'success' ? 'success' : row.state === 'failed' ? 'danger' : 'info'">
                    {{ t(`ctStage_${row.state === "running" ? row.stage : row.state}`) }}
                </el-tag>
                <span v-if="row.durationMs !== undefined">{{ (row.durationMs / 1000).toFixed(1) }} s</span>
                <span v-if="row.upstreamStatus">HTTP {{ row.upstreamStatus }}</span>
            </div>
            <p v-if="row.modelVerified">{{ t(row.enabled ? "ctVerifiedEnabled" : "ctVerified") }}</p>
            <p v-if="row.errorCode">{{ t(`ctError_${row.errorCode}`) }}</p>
            <p v-if="row.snapshotChanged">{{ t("ctSnapshotChanged") }}</p>
            <pre v-if="row.responseText">{{ row.responseText }}</pre>
        </div>
    </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import I18n from "../utils/i18n";
import { requestAccountJson } from "../utils/accountManagement";
import { credentialRequestId, credentialRetryIndices } from "../utils/credentialTests";

const props = defineProps({ accounts: { default: () => [], type: Array }, disabled: Boolean });
const emit = defineEmits(["busy", "completed"]);
const language = ref(0);
const unsubscribe = I18n.onChange(() => language.value++);
const t = (key, options) => {
    language.value;
    return I18n.t(key, options);
};
const run = ref(null);
const error = ref("");
const actionError = ref("");
const actionNotice = ref("");
const initializing = ref(true);
const submitting = ref(false);
const running = computed(() => run.value?.status === "running");
const done = computed(
    () => (run.value?.results || []).filter(row => !["pending", "running"].includes(row.state)).length
);
const retryIndices = computed(() => credentialRetryIndices(run.value, props.accounts));
watch(
    () => initializing.value || submitting.value || running.value,
    value => emit("busy", value),
    { immediate: true }
);
let alive = true;
let timer;
let reading = null;
let completedRun = null;
const pendingKey = "aitoapi-credential-test-submission";
const readPending = () => {
    try {
        const pending = JSON.parse(sessionStorage.getItem(pendingKey));
        if (typeof pending?.clientRequestId === "string" && Array.isArray(pending.indices)) return pending;
    } catch {
        /* Optional recovery cache. */
    }
    return null;
};
const retirePending = clientRequestId => {
    try {
        if (readPending()?.clientRequestId === clientRequestId) sessionStorage.removeItem(pendingKey);
    } catch {
        /* Optional recovery cache. */
    }
};
const stateUrl = pending =>
    "/api/account-credential-tests" +
    (pending ? `?clientRequestId=${encodeURIComponent(pending.clientRequestId)}` : "");
const api = async (url, method = "GET", body) => {
    const response = await requestAccountJson(url, method, body);
    if (!response.ok) throw new Error(`ctApi_${response.data.code || "INTERNAL_ERROR"}`);
    return response.data;
};
const fetchState = () => {
    if (!alive || submitting.value) return Promise.resolve();
    if (reading) return reading;
    clearTimeout(timer);
    reading = (async () => {
        try {
            const pending = readPending();
            const state = await api(stateUrl(pending));
            if (!alive) return;
            if (pending && state.admission) {
                retirePending(pending.clientRequestId);
                actionError.value = "";
                actionNotice.value = t("ctSubmissionRecovered");
            }
            run.value = state.currentRun || state.lastCompleted;
            error.value = state.persistenceError
                ? t("ctError_persistence_failed")
                : state.cleanupBlocked
                  ? t("ctError_cleanup_failed")
                  : "";
            if (run.value && !running.value && completedRun !== run.value.runId) {
                completedRun = run.value.runId;
                emit("completed");
            }
        } catch (cause) {
            if (alive) error.value = t(cause.message);
        } finally {
            initializing.value = false;
            reading = null;
            if (alive) timer = setTimeout(fetchState, 2000);
        }
    })();
    return reading;
};

const start = async indices => {
    if (props.disabled || submitting.value || running.value || !indices.length) return;
    submitting.value = true;
    clearTimeout(timer);
    try {
        await reading;
        if (running.value) return;
        const unique = [...new Set(indices)];
        let pending = readPending();
        if (pending && JSON.stringify(pending.indices) === JSON.stringify(unique)) {
            const state = await api(stateUrl(pending));
            if (state.admission) {
                retirePending(pending.clientRequestId);
                pending = null;
            }
        }
        if (!pending || JSON.stringify(pending.indices) !== JSON.stringify(unique)) {
            pending = { clientRequestId: credentialRequestId(), indices: unique };
        }
        try {
            sessionStorage.setItem(pendingKey, JSON.stringify(pending));
        } catch {
            /* Storage may be disabled. */
        }
        const accepted = await api("/api/account-credential-tests/runs", "POST", pending);
        retirePending(pending.clientRequestId);
        actionNotice.value = accepted.reused ? t("ctSubmissionReused") : "";
        actionError.value = "";
    } catch (cause) {
        actionError.value = t(cause.message);
    } finally {
        submitting.value = false;
        await fetchState();
    }
};
const stop = async () => {
    submitting.value = true;
    try {
        await api(`/api/account-credential-tests/runs/${run.value.runId}/stop`, "POST");
        actionError.value = "";
    } catch (cause) {
        actionError.value = t(cause.message);
    } finally {
        submitting.value = false;
        await fetchState();
    }
};
onMounted(fetchState);
onBeforeUnmount(() => {
    alive = false;
    clearTimeout(timer);
    unsubscribe();
});
defineExpose({ start });
</script>

<style scoped lang="less">
.credential-tests {
    background: var(--bg-card);
    border: 1px solid var(--border-light);
    border-radius: 14px;
    padding: 20px;
    margin-bottom: 20px;
}
.ct-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 10px;
}
h2 {
    font-size: 18px;
    margin: 0;
}
p {
    color: var(--text-secondary);
    margin: 8px 0;
}
.ct-result {
    border-top: 1px solid var(--border-light);
    padding-top: 12px;
    margin-top: 12px;
    overflow-wrap: anywhere;
}
pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--bg-body);
    padding: 10px;
}
</style>
