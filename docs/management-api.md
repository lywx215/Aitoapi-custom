# 外部管理 API 接入与验收

本文件与 [OpenAPI 3.0.3](management-api-openapi.json) 描述 `/api/manage/v1` 和 `/api/management-keys`。共享约束以 [management-api-contract.md](management-api-contract.md) 为准。资源统一命名为 **task / taskId / tasks**；旧的 operations 命名不作为公开 API。

**交付阶段：波次 1 契约和旧行为基线，尚未完成新管理 API 整体验收。** 基线提交为 `55e72484741a0e3cfec074d0526c3a4f6e4aa157`。本轮未启动生产实例、读取真实凭证或调用真实模型。OpenAPI 的完整字段、每路由权限映射和错误码是给 T4/T5 对齐的实施细化，不能当作服务已提供这些能力的证据。总控已确认大写下划线错误码、单账户/设置 PATCH 可同步 200、批量和浏览器耗时操作走 202/task；其余细化需在集成提交上核对。

## 认证与密钥

外部管理请求仅接受 `Authorization: Bearer mgmt_…`，不接受模型 API key，也不能用控制台 session 替代。`mgmt_` 后的内容来自 32 字节安全随机数；服务只持久化 SHA-256 摘要，创建时返回一次明文。不要假定编码为 hex 或固定总长度。

密钥管理 `/api/management-keys` 仅接受控制台密码登录的会话：`session.authMethod === 'console_password'`。`model_key` 登录和缺少来源标记的历史 session 需要重新用控制台密码登录。无新增强制环境变量。列表和撤销结果不包含 token 或 hash；撤销会取消该密钥尚在排队的写任务，运行中的任务继续保留创建者归属。

| 模板     | scopes                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| readonly | `system:read`, `accounts:read`, `settings:read`, `usage:read`, `audit:read`, `tasks:read`                                     |
| operator | `system:read`, `accounts:read`, `accounts:write`, `accounts:test`, `settings:read`, `usage:read`, `tasks:read`, `tasks:write` |
| admin    | 全部 12 个 scope，额外含 `accounts:export`, `accounts:archive`, `settings:write`, `audit:read`                                |

模板由 UI 展开成显式 `scopes` 数组提交；创建请求是 `{name,scopes,expiresAt?}`，没有 `template` 字段。权限按具体路由检查；能提交任务不自动获得读取任务权限，轮询调用方还需要 `tasks:read`。

## 通用格式与限制

成功返回 `{ "data": ..., "requestId": "..." }`；失败返回 `{ "error": { "code": "INVALID_REQUEST", "message": "..." }, "requestId": "..." }`。`requestId` 由服务端生成，不可信任调用方传入值。新命名空间的错误保持 JSON，不重定向登录页；本地 404/405 不落入模型转发。路由必须在 raw-body collector 和模型 fallback 之前挂载。旧控制台接口继续保留自己的响应格式。

列表统一为 `data: {items,total,offset,limit}`；`offset` 默认 0，`limit` 默认 50、最大 200。账户路径中的 `id` 是稳定 `accountId`，不是 `auth-7.json` 中的 `7`；响应仍带 `index` 用于诊断。

请求体最大 10 MiB，每份凭证序列化后最大 1 MiB，批量最多 100 项。凭证只允许 `accountName`、`cookies`、`origins`；支持对象或旧 JSON 字符串，解析后执行相同校验。此 OpenAPI 选择拒绝 `disabled`、`expired`、`accountId`、版本等控制字段。数组/JSON 字符串的字节限制需要运行时校验，OpenAPI 的 `x-max-json-bytes` 不是普通 JSON Schema 关键字。

## 路由与权限

以下路径均相对 `/api/manage/v1`。`202` 表示持久化任务提交，必须带 `Idempotency-Key`。`200` 表示同步结果。

| 方法与路径                       | 必需 scope                                    | 成功 | 输入/结果                                                       |
| -------------------------------- | --------------------------------------------- | ---- | --------------------------------------------------------------- |
| GET `/system/status`             | system:read                                   | 200  | 安全运行计数及状态，无控制台日志                                |
| GET `/system/readiness`          | system:read                                   | 200  | `{ready,checks}`；未就绪时 `ready:false`                        |
| GET `/accounts`                  | accounts:read                                 | 200  | Account 分页                                                    |
| GET `/accounts/{id}`             | accounts:read                                 | 200  | Account 元数据                                                  |
| POST `/accounts/import`          | accounts:write + accounts:test                | 202  | `{items:[{clientRef,credentials}],model?}`                      |
| POST `/accounts/batch`           | accounts:write；archive 还需 accounts:archive | 202  | `{action,accountIds,force?}`                                    |
| POST `/accounts/{id}/test`       | accounts:test                                 | 202  | `{mode?,model?}`；默认 model                                    |
| POST `/accounts/export`          | accounts:export                               | 200  | `{accountIds}` → `{items:[{accountId,index,credentials}]}`      |
| POST `/accounts/{id}/archive`    | accounts:archive                              | 202  | 可选 `{force}`                                                  |
| POST `/accounts/{id}/restore`    | accounts:archive                              | 202  | 恢复同一 identity，保持手动禁用                                 |
| POST `/accounts/{id}/reload`     | accounts:write                                | 202  | 可选 `{force}`                                                  |
| PUT `/accounts/{id}/credentials` | accounts:write + accounts:test                | 202  | body 直接为凭证对象或 JSON 字符串                               |
| PATCH `/accounts/{id}`           | accounts:write                                | 200  | `{enabled:boolean,force?:boolean}`                              |
| GET `/settings`                  | settings:read                                 | 200  | `{values,persistentKeys}`                                       |
| PATCH `/settings`                | settings:write                                | 200  | 显式设置 patch → `{values,persisted,applied,applicationError?}` |
| GET `/usage`                     | usage:read                                    | 200  | 安全用量记录分页                                                |
| GET `/audit`                     | audit:read                                    | 200  | 审计分页                                                        |
| POST `/system/reload-auth`       | accounts:write                                | 202  | 外部文件与元数据协调、再平衡                                    |
| GET `/tasks`                     | tasks:read                                    | 200  | Task 分页                                                       |
| GET `/tasks/{id}`                | tasks:read                                    | 200  | 单个 Task                                                       |
| POST `/tasks/{id}/cancel`        | tasks:write                                   | 200  | 请求合作取消，返回当前 Task                                     |

密钥路由另有 `GET /api/management-keys`（分页，200）、`POST /api/management-keys`（201，`data:{key,token}`）、`DELETE /api/management-keys/{id}`（200，`data:{id,revoked}`）。它们使用上述控制台密码 session，不使用管理 Bearer。

## 任务、重试与账户安全

任务提交返回 HTTP 202：

```json
{
  "data": { "taskId": "task_example", "status": "queued" },
  "requestId": "req_example"
}
```

每次逻辑提交生成一个 `Idempotency-Key`。同一管理 key ID、同一幂等键、相同规范化方法/路径/内容返回原 admission 和 taskId；不同内容返回 409 `IDEMPOTENCY_CONFLICT`。不要在网络超时后换幂等键盲目重试。原 admission 的 `status:queued` 不代表当前状态，请 GET task。幂等记录随任务保留 30 天，过期后不可依赖旧键去重。

Task 包含 `taskId`、`kind`、`createdByKeyId`、时间戳、`counts`、`items`、`result` 和可选 `error`。item 保留 `clientRef`、目标 `accountId/index`、`status/progress/stage/error`。状态为 `queued/running/succeeded/partial/failed/cancelled/interrupted`；前两者非终态。批量应逐项检查，`partial` 不代表所有账户成功。

重启后 queued 恢复排队，running 标为 interrupted，禁止自动重放。取消是合作式的：200 取消响应中的状态可能仍为 running，后续轮询直到终态；已经写入的状态不回滚。任务和审计保留 30 天，不能把它们作为无限期账本。

导入默认使用 `gemini-3.8-flash` 测试候选凭证后自动启用；重复邮箱报错，不替换已有账户。替换凭证先隔离验证候选，再按读取时的 credentialVersion/stateVersion 校验提交。手动状态更改优先，旧验证快照不得覆盖较新的禁用/过期状态。账户列表、任务、审计和错误不返回 cookie/localStorage/credentialState，只有有 export 权限的导出接口可以返回凭证。

验证器默认并发 1、总超时 10 分钟、固定且有界的 OK 提示。`connection` 仅说明连接可用；`model` 必须有目标账户真实模型响应，不能用页面控制台成功信号代替，不能失败后切到别的账户。验证不得使用生产 ConnectionRegistry、改变生产 currentAuthIndex 或占用生产上下文；候选 storage state 只能由调用方在版本校验通过后提交。

禁用/归档等操作先等待当前账户请求排空，最多 60 秒；超时显式报告待处理/失败，此细化选用 `ACCOUNT_BUSY`。只有调用方显式 `force:true` 才可中断。store 锁内不执行浏览器操作，生产池在提交后再平衡。

## 设置持久化

PATCH 使用显式值，例如 `{ "maxRetries": 4 }`，不使用 toggle。只有 `maxContexts/maxRetries/retryDelay/autoDisableStatusCodes/accountCooldownMs/accountCooldownMaxMs/autoHealProbeIntervalMs/autoHealProbeTimeoutMs` 持久化；其余 allowlist 运行时开关沿用旧重启语义，不改变环境变量优先级。数值范围见 OpenAPI，`accountCooldownMaxMs >= accountCooldownMs`。

所有字段先验证，候选配置成功落盘后才应用到内存。`persisted:true,applied:false` 表示磁盘已更新但应用回调失败，读取当前值并诊断 `applicationError`，不要把它理解为完全未发生。文件写失败返回 `PERSISTENCE_ERROR`；单文件 bind mount 回退路径需尽力恢复失败前内容。控制台和外部管理共享同一 writer，以避免并发覆盖。

## 错误码

HTTP 错误用 envelope；验证/取消/重启等异步结果位于 task/item.error，获取失败任务本身仍可返回 HTTP 200。上游状态放在验证结果 `upstreamStatus`，不要与管理路由 HTTP 状态混淆。

| code                      | HTTP      | 调用方处理                                  |
| ------------------------- | --------- | ------------------------------------------- |
| INVALID_REQUEST           | 400       | 修正 JSON、字段、ID、分页或设置             |
| INVALID_CREDENTIALS       | 400       | 修正 Playwright storage state，去除控制字段 |
| IDEMPOTENCY_KEY_REQUIRED  | 400       | 为 task 提交补充幂等键                      |
| UNAUTHORIZED              | 401       | 检查 Bearer；失效、过期、撤销均拒绝         |
| FORBIDDEN                 | 403       | 补足该操作所需 scope                        |
| CONSOLE_PASSWORD_REQUIRED | 403       | 用控制台密码重新登录后管理密钥              |
| NOT_FOUND                 | 404       | 检查资源、路径、保留期                      |
| METHOD_NOT_ALLOWED        | 405       | 使用文档指定方法；不转发模型                |
| IDEMPOTENCY_CONFLICT      | 409       | 同一逻辑提交保留原内容，新操作使用新键      |
| DUPLICATE_ACCOUNT         | 409       | 显式选择替换流程，导入不覆盖                |
| VERSION_CONFLICT          | 409       | 重新读取状态，重新验证；不覆盖手动操作      |
| ACCOUNT_BUSY              | 409       | 等待排空；强制中断必须显式选择              |
| INVALID_STATE             | 409       | 检查当前账户/任务状态                       |
| PAYLOAD_TOO_LARGE         | 413       | 分批；缩减 JSON/凭证体积                    |
| RATE_LIMITED              | 429       | 延迟重试，同一 task 提交保持幂等键          |
| PERSISTENCE_ERROR         | 500       | 检查磁盘/挂载；读取任务状态后决定重试       |
| INTERNAL_ERROR            | 500       | 保留 requestId 定位；错误消息不含秘密       |
| VERIFICATION_FAILED       | task/item | 目标验证失败；不以别的账户结果替代          |
| VERIFICATION_TIMEOUT      | task/item | 达到 10 分钟上限                            |
| CANCELLED                 | task/item | 停止未提交部分，保留已提交状态              |
| INTERRUPTED               | task/item | 重启中断，需要调用方判断后续操作            |

重复邮箱、版本冲突、落盘失败等若在任务接收后才发现，会记录到 task/item.error，而不是修改原有 202 响应。OpenAPI 的 `x-error-catalog` 给出同一映射。此阶段尚未用真实新路由验证错误拼写和响应字段。

## 调用示例（集成后使用）

以下 Node.js 示例仅展示调用方逻辑；本轮没有执行。`MANAGEMENT_TOKEN` 是调用方进程变量，不是服务端新增强制配置。示例 `example.invalid` 凭证是虚构的，不能通过真实模型验证。

```js
const base = "http://127.0.0.1:3000/api/manage/v1";
const headers = {
  Authorization: `Bearer ${process.env.MANAGEMENT_TOKEN}`,
  "Content-Type": "application/json",
};
async function call(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${payload.error.code}: ${payload.error.message} (${payload.requestId})`);
  }
  return payload.data;
}

const page = await call("/accounts?offset=0&limit=50");
const account = page.items[0];
if (!account) throw new Error("No account is available");
const submissionKey = crypto.randomUUID(); // Persist before retrying this logical submission.
const admission = await call(`/accounts/${encodeURIComponent(account.accountId)}/test`, {
  method: "POST",
  headers: { "Idempotency-Key": submissionKey },
  body: JSON.stringify({ mode: "model", model: "gemini-3.8-flash" }),
});
const deadline = Date.now() + 12 * 60 * 1000;
let task;
do {
  if (Date.now() > deadline) {
    throw new Error(`Polling timed out; keep taskId ${admission.taskId} for later lookup`);
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  task = await call(`/tasks/${encodeURIComponent(admission.taskId)}`);
} while (["queued", "running"].includes(task.status));
console.log({ taskId: task.taskId, status: task.status, items: task.items });

// Separate explicit settings mutation requires settings:write.
const updated = await call("/settings", {
  method: "PATCH",
  body: JSON.stringify({ maxRetries: 4 }),
});
if (!updated.applied) throw new Error(updated.applicationError || "Settings application failed");
```

批量导入 body 结构示例：

```json
{
  "items": [
    {
      "clientRef": "alpha",
      "credentials": { "accountName": "fixture-alpha@example.invalid", "cookies": [], "origins": [] }
    },
    {
      "clientRef": "beta",
      "credentials": { "accountName": "fixture-beta@example.invalid", "cookies": [], "origins": [] }
    }
  ],
  "model": "gemini-3.8-flash"
}
```

这类空 cookies 仅演示 JSON 结构，不是有效登录。基线 fixture 使用两份带不同虚构 cookie 的 `.invalid` 账户；仍然不能当成真实认证材料。

## 验证命令与证据边界

```sh
node scripts/tests/managementAcceptance.test.js
node scripts/tests/managementAcceptance.test.js --require-full
```

第一条验证 OpenAPI 路由清单、引用、权限声明、错误码、limits、schema 安全字段，并运行真实 `new StatusRoutes`、`new AuthSource`、`new RequestHandler`、`new UsageStatsService`。路由通过真实 Express 在 `127.0.0.1` 随机端口访问，浏览器/连接/认证边界用 mocks，绝不构造或启动生产 `ProxyServerSystem`。全部账户和状态文件位于 `os.tmpdir()` 下新建的目录，退出时恢复 cwd 并清理；socket guard 仅允许 fixture 本地端口，TLS 出站被拒绝。

第一条的 10 项 TODO **不计作通过**。Node test runner 可能在 TODO 行显示对勾，但结果汇总单列 `todo`。第二条是严格门禁：当前必须非零退出，说明没有完成整体验收，不能凭基线绿灯宣称 API 或真实模型已通过。整合新服务后需要替换 TODO 为真实集成检查，并保留独立 live 证据门禁。结构检查不是第三方完整 OpenAPI 元规范验证器，也没有声称运行时已符合 schema。

## 验收矩阵

| 编号    | 本轮证据/后续条件                                                                             | 当前状态                             |
| ------- | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| C01     | 24 个 HTTP 操作、完整路径/方法、局部 refs、逐路由认证和 task 幂等要求                         | 已验证文档                           |
| C02     | limits、task 状态、uppercase codes、模板排除项、公开 schema 无凭证字段                        | 已验证文档                           |
| B01     | 真实 AuthSource 从临时文件加载两份不同虚构账户                                                | 已验证基线                           |
| B02     | 旧 StatusRoutes 保留认证边界调用，返回账户元数据，无 cookie 值                                | 已验证基线；认证本身为 mock          |
| B03     | 真实 RequestHandler 的 connection 测试分别检查两个目标，不切换当前账户                        | 已验证基线；非模型测试               |
| B04     | beta 缺失 WebSocket 时失败，alpha 可用也不替代 beta                                           | 已验证基线                           |
| B05     | 无效/不存在 index 被拒绝，connection 成功保留活跃冷却                                         | 已验证基线                           |
| B06     | 系统 busy 拒绝变更，禁用持久化并排除轮转、关闭目标连接                                        | 已验证基线                           |
| B07     | 真实旧设置路由的合法/非法数值和 8 个持久化键                                                  | 已验证基线；不等于新 writer 竞态验证 |
| B08     | 真实用量服务记录两个账户各自成功/失败，limit 仅截取历史                                       | 已验证基线                           |
| W2-01   | 新密钥服务/真实认证中间件：登录来源、Bearer、scope、过期/撤销、明文仅一次、hash 落盘          | pending                              |
| W2-02   | 总控真实挂载：JSON 错误 envelope、服务端 requestId、local404/405、模型转发不回归              | pending                              |
| W2-03   | 两份 fixture 经真实 import → task → account → verifier 编排，clientRef/目标归属、提交后启用   | pending；不得用伪实现冒充            |
| W2-04   | 失败目标不能 failover 成功，真实 verifier 隔离资源、模型结果判定、deadline/cancel、close 清理 | pending                              |
| W2-05   | 同 key/content 重放、不同 key 隔离、并发幂等、重启 queued/running、30 天清理                  | pending                              |
| W2-06   | 重复邮箱、替换期间手动禁用、删除/刷新快照竞态、版本冲突、归档恢复 ID/禁用状态                 | pending                              |
| W2-07   | 取消/撤销 queued、运行归属、已提交不回滚、60 秒 drain 和 force                                | pending                              |
| W2-08   | 共享 writer、设置并发/失败不改内存、applied:false、重启与 bind mount                          | pending；T2 单测需集成复验           |
| W2-09   | 10MiB/1MiB/100 项边界、limit 默认/上限、export scope、所有响应/日志/audit 无秘密              | pending                              |
| LIVE-01 | 单独授权的两真实账户 model 模式验证；保存去敏 taskId/requestId/账户归属/上游状态/时间证据     | pending；本轮禁止执行                |

下一轮必须在总控提供的集成提交上加载真实波次 2 服务，并用 mock 浏览器边界完成模拟 E2E。真实两账户 gate 是独立证据，不得用模拟 E2E 或旧连接测试替代。
