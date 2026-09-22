<template>
    <section class="management-keys" aria-labelledby="management-keys-title">
        <header class="key-heading">
            <div>
                <h3 id="management-keys-title">外部管理密钥</h3>
                <p>为管理 API 单独授权。密钥明文只在创建成功时显示一次。</p>
            </div>
            <button type="button" :disabled="busy" @click="loadKeys">刷新</button>
        </header>
        <p v-if="error" class="key-error" role="alert">{{ error }}</p>
        <p v-if="notice" role="status">{{ notice }}</p>
        <div v-if="passwordRequired" class="key-help">
            请先退出当前会话，再使用控制台密码重新登录。模型 API Key 登录和旧会话无法管理密钥。
            未配置控制台密码时，可由管理员配置 WEB_CONSOLE_PASSWORD 后重新登录。
        </div>
        <template v-else>
            <form class="key-form" @submit.prevent="createKey">
                <label>名称 <input v-model="name" required placeholder="例如：账户维护工具" :disabled="busy" /></label>
                <label>
                    权限模板
                    <select v-model="template" :disabled="busy" @change="applyTemplate">
                        <option value="readonly">只读</option>
                        <option value="operator">操作员</option>
                        <option value="admin">管理员（全部权限）</option>
                    </select>
                </label>
                <label
                    >到期时间（本地时间，可留空） <input v-model="expiresAt" type="datetime-local" :disabled="busy"
                /></label>
                <fieldset :disabled="busy">
                    <legend>权限范围（可调整）</legend>
                    <label v-for="scope in scopes" :key="scope.value" class="scope-option">
                        <input v-model="selectedScopes" type="checkbox" :value="scope.value" />
                        {{ scope.label }} <code>{{ scope.value }}</code>
                    </label>
                </fieldset>
                <p class="key-help">操作员默认不含凭证导出、账户归档、修改设置和审计读取。轮询任务需勾选“读取任务”。</p>
                <button type="submit" :disabled="busy || !name.trim() || !selectedScopes.length || !!token">
                    创建密钥
                </button>
            </form>
            <div v-if="token" class="key-secret" role="status">
                <strong>请立即保存此密钥，关闭后无法再次查看。</strong>
                <textarea
                    :value="token"
                    readonly
                    rows="3"
                    aria-label="新建管理密钥（仅本次显示）"
                    spellcheck="false"
                ></textarea>
                <button type="button" @click="copyToken">复制密钥</button>
                <button type="button" @click="clearToken">已保存，关闭显示</button>
            </div>
            <div class="key-table-wrapper">
                <table>
                    <caption>
                        共
                        {{
                            total
                        }}
                        个密钥
                    </caption>
                    <thead>
                        <tr>
                            <th>名称 / ID</th>
                            <th>权限范围</th>
                            <th>创建 / 到期</th>
                            <th>状态</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="key in keys" :key="key.id">
                            <td>
                                {{ key.name }}<small>{{ key.id }}</small>
                            </td>
                            <td>
                                <span v-for="scope in key.scopes" :key="scope" class="scope-tag">{{ scope }}</span>
                            </td>
                            <td>
                                {{ formatDate(key.createdAt) }}<small>到期：{{ formatDate(key.expiresAt) }}</small>
                            </td>
                            <td>
                                {{ stateLabel(key) }}<small v-if="key.revokedAt">{{ formatDate(key.revokedAt) }}</small>
                            </td>
                            <td>
                                <button type="button" :disabled="busy || !!key.revokedAt" @click="revokeKey(key)">
                                    撤销
                                </button>
                            </td>
                        </tr>
                        <tr v-if="!keys.length">
                            <td colspan="5">{{ busy ? "正在加载…" : "暂无管理密钥" }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <nav class="key-pagination" aria-label="密钥分页">
                <button type="button" :disabled="busy || offset === 0" @click="changePage(-1)">上一页</button>
                <span>第 {{ Math.floor(offset / limit) + 1 }} 页</span>
                <button type="button" :disabled="busy || offset + limit >= total" @click="changePage(1)">下一页</button>
            </nav>
        </template>
    </section>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from "vue";

const scopes = [
    { label: "读取系统", value: "system:read" },
    { label: "读取账户", value: "accounts:read" },
    { label: "修改账户", value: "accounts:write" },
    { label: "测试账户", value: "accounts:test" },
    { label: "导出凭证", value: "accounts:export" },
    { label: "归档与恢复", value: "accounts:archive" },
    { label: "读取设置", value: "settings:read" },
    { label: "修改设置", value: "settings:write" },
    { label: "读取用量", value: "usage:read" },
    { label: "读取审计", value: "audit:read" },
    { label: "读取任务", value: "tasks:read" },
    { label: "取消任务", value: "tasks:write" },
];
const templates = {
    admin: scopes.map(scope => scope.value),
    operator: [
        "system:read",
        "accounts:read",
        "accounts:write",
        "accounts:test",
        "settings:read",
        "usage:read",
        "tasks:read",
        "tasks:write",
    ],
    readonly: ["system:read", "accounts:read", "settings:read", "usage:read", "audit:read", "tasks:read"],
};
const name = ref("");
const template = ref("readonly");
const selectedScopes = ref([...templates.readonly]);
const expiresAt = ref("");
const keys = ref([]);
const total = ref(0);
const offset = ref(0);
const limit = 20;
const token = ref("");
const tokenKeyId = ref("");
const busy = ref(false);
const error = ref("");
const notice = ref("");
const passwordRequired = ref(false);
const now = ref(Date.now());
let clockTimer;
let disposed = false;

function applyTemplate() {
    selectedScopes.value = [...templates[template.value]];
}
function clearToken() {
    token.value = "";
    tokenKeyId.value = "";
    notice.value = "";
}
function formatDate(value) {
    return value ? new Date(value).toLocaleString() : "永不过期";
}
function stateLabel(key) {
    return key.revokedAt ? "已撤销" : key.expiresAt && Date.parse(key.expiresAt) <= now.value ? "已到期" : "有效";
}

async function request(path = "", options = {}) {
    const response = await fetch(`/api/management-keys${path}`, {
        ...options,
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", ...options.headers },
    });
    const payload = await response.json();
    if (!response.ok) {
        const code = payload.error?.code;
        passwordRequired.value = code === "CONSOLE_PASSWORD_REQUIRED" || code === "UNAUTHORIZED";
        if (passwordRequired.value) clearToken();
        const messages = {
            CONSOLE_PASSWORD_REQUIRED: "请使用控制台密码重新登录。",
            FORBIDDEN: "请求来源校验失败，请从同一控制台页面重试。",
            INVALID_REQUEST: "名称、权限或到期时间无效，请检查输入。",
            PERSISTENCE_ERROR: "密钥保存失败，请检查服务存储。",
            UNAUTHORIZED: "会话已失效，请重新登录。",
        };
        throw new Error(
            `${messages[code] || "操作失败，请刷新后重试。"}${payload.requestId ? ` 请求编号：${payload.requestId}` : ""}`
        );
    }
    return payload.data;
}

async function refreshList() {
    const page = await request(`?offset=${offset.value}&limit=${limit}`);
    keys.value = page.items;
    total.value = page.total;
    passwordRequired.value = false;
}

async function run(operation) {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    notice.value = "";
    try {
        await operation();
    } catch (problem) {
        error.value = problem.message || "请求失败，请重试。";
    } finally {
        busy.value = false;
    }
}

async function loadKeys() {
    await run(refreshList);
}
async function changePage(direction) {
    offset.value = Math.max(0, offset.value + direction * limit);
    await loadKeys();
}
async function createKey() {
    await run(async () => {
        const body = { name: name.value.trim(), scopes: [...selectedScopes.value] };
        if (expiresAt.value) {
            const expiry = new Date(expiresAt.value);
            if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now())
                throw new Error("到期时间必须晚于当前时间。");
            body.expiresAt = expiry.toISOString();
        }
        const created = await request("", { body: JSON.stringify(body), method: "POST" });
        if (disposed) return;
        token.value = created.token;
        tokenKeyId.value = created.key.id;
        name.value = "";
        offset.value = 0;
        await refreshList();
    });
}
async function revokeKey(key) {
    if (!window.confirm(`撤销“${key.name}”？该密钥将立即失效，其排队写任务会取消。`)) return;
    await run(async () => {
        await request(`/${encodeURIComponent(key.id)}`, { method: "DELETE" });
        if (tokenKeyId.value === key.id) clearToken();
        notice.value = "密钥已撤销。";
        await refreshList();
    });
}
async function copyToken() {
    try {
        await navigator.clipboard.writeText(token.value);
        notice.value = "密钥已复制，请保存到安全位置。";
    } catch {
        error.value = "无法自动复制，请选中上方密钥手动复制。";
    }
}
onMounted(() => {
    loadKeys();
    clockTimer = setInterval(() => {
        now.value = Date.now();
    }, 1000);
});
onUnmounted(() => {
    disposed = true;
    clearInterval(clockTimer);
    clearToken();
});
</script>

<style scoped>
.management-keys {
    grid-column: 1 / -1;
    padding: 20px;
    border: 1px solid var(--el-border-color, #dcdfe6);
    border-radius: 12px;
    color: var(--el-text-color-primary, #303133);
}
.key-heading,
.key-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
}
h3 {
    margin: 0;
}
p,
.key-help {
    line-height: 1.6;
}
.key-help,
small {
    color: var(--el-text-color-secondary, #73767a);
}
.key-form {
    display: grid;
    gap: 14px;
    margin-top: 16px;
}
.key-form > label {
    display: grid;
    gap: 6px;
}
input:not([type="checkbox"]),
select,
textarea {
    box-sizing: border-box;
    width: 100%;
    padding: 8px;
    background: var(--el-bg-color, white);
    color: inherit;
    border: 1px solid var(--el-border-color, #dcdfe6);
    border-radius: 5px;
}
fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 20px;
    border: 1px solid var(--el-border-color, #dcdfe6);
}
.scope-option {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}
button {
    padding: 8px 14px;
    border: 1px solid var(--el-border-color, #dcdfe6);
    border-radius: 5px;
    background: var(--el-bg-color, white);
    color: inherit;
    cursor: pointer;
}
button:disabled {
    cursor: default;
    opacity: 0.5;
}
.key-error {
    color: var(--el-color-danger, #f56c6c);
}
.key-secret {
    padding: 16px;
    border: 1px solid var(--el-color-warning, #e6a23c);
    border-radius: 8px;
    margin: 20px 0;
}
.key-secret textarea {
    display: block;
    margin: 12px 0;
    font-family: monospace;
}
.key-secret button + button {
    margin-left: 8px;
}
.key-table-wrapper {
    overflow-x: auto;
    margin: 20px 0;
}
table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
    min-width: 580px;
}
caption {
    text-align: left;
    padding-bottom: 8px;
}
th,
td {
    padding: 10px;
    border-bottom: 1px solid var(--el-border-color, #dcdfe6);
    vertical-align: top;
}
small {
    display: block;
    margin-top: 6px;
    overflow-wrap: anywhere;
}
.scope-tag {
    display: inline-block;
    margin: 2px;
    font-size: 12px;
    padding: 3px 6px;
    background: var(--el-fill-color-light, #f5f7fa);
    border-radius: 4px;
}
@media (max-width: 600px) {
    .management-keys {
        padding: 12px;
    }
    .key-heading {
        align-items: flex-start;
    }
    .scope-option {
        width: 100%;
    }
}
</style>
