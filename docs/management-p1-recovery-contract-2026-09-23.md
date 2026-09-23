# Management API P1 恢复契约（2026-09-23）

范围：本仓库当前 `ManagementRoutes`、`ManagementAccountService`、`ManagementTaskService` 的离线代码与路由测试。生产部署和真实模型未验收。本文供 Gemini Manager 的请求错误分类使用；只允许把**完整匹配的本服务错误包**分类，HTTP 状态码、代理响应或超时本身均不构成证明。

## 可识别的服务错误包

请求必须发往检查点中的同一 HTTPS origin、准确的 `/api/manage/v1` 路径与方法。服务错误响应为 `{ "error": { "code": "...", "message": "..." }, "requestId": "req_<UUID>" }`，`X-Request-Id` 与包内 `requestId` 一致。客户端应核对 JSON 对象结构、已知 code 与对应 HTTP 状态、请求 ID 形状及 header 一致性，再按下面**当前端点**分类。网关/代理拼装的相似 4xx、非标准包、网络错误、5xx 均不能分类为确定未受理。`requestId` 是单次 HTTP 请求标识，不是 taskId 或幂等身份；服务端审计记录它，但 GET task 不以其查找任务。

## 入队前拒绝矩阵

| 当前端点                         | 可证明没有为**本次请求**创建 task 的错误                                                                                                                           | 边界                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /accounts/import`          | `UNAUTHORIZED` 401、`FORBIDDEN` 403、`INVALID_REQUEST` 400、`INVALID_CREDENTIALS` 400、`PAYLOAD_TOO_LARGE` 413、`IDEMPOTENCY_KEY_REQUIRED` 400、`RATE_LIMITED` 429 | 认证、权限、JSON 解析、整批验证、幂等键检查和队列容量检查均在新 task 创建前。`RATE_LIMITED` 仅在没有同键历史任务时发生；同键历史任务先返回其 taskId。 |
| `PUT /accounts/{id}/credentials` | 同上                                                                                                                                                               | 双版本参数格式错误在入队前拒绝；**过期的合法版本**会先返回 202 taskId，再在任务项中报 `VERSION_CONFLICT`，不能按 HTTP 409 预期。                      |
| `POST /accounts/{id}/test`       | 同上，除 `INVALID_CREDENTIALS`                                                                                                                                     | 当前 test 请求体不带凭证；账号存在性和有效性在 task 执行时判断。                                                                                      |

`METHOD_NOT_ALLOWED` 405 与 `NOT_FOUND` 404 只用于不匹配的路由/方法；正确的三个任务端点不应出现，不能作为其恢复分类。账号不存在通常仍可入队并在任务内失败。`IDEMPOTENCY_CONFLICT` 409 **不是**未受理证明：它表明同一 Key ID + Idempotency-Key 已对应另一份规范化请求和既有任务。`INVALID_STATE` 409、`PERSISTENCE_ERROR` 500、`INTERNAL_ERROR` 500 均保留未知结果；尤其提交时写私有输入、任务索引或审计可能局部成功。`AUDIT_PERSISTENCE_FAILED` 500 表示同步变更已提交或应用，必须读当前状态。`ACCOUNT_BUSY` 409 不是任务入队前错误，也不能解释为未变更。

上表入队前错误的规范 `message` 固定为：`UNAUTHORIZED` → `A valid management bearer token is required.`；`FORBIDDEN` → `Required management permission is missing.`；`INVALID_REQUEST` → `Invalid management request.`；`INVALID_CREDENTIALS` → `Invalid credential storage state.`；`PAYLOAD_TOO_LARGE` → `Management payload exceeds its limit.`；`IDEMPOTENCY_KEY_REQUIRED` → `Idempotency-Key is required.`；`RATE_LIMITED` → `Management task queue is full.`。`IDEMPOTENCY_CONFLICT` 409 的消息为 `Idempotency key was used with different content.`。客户端应核对规范消息，不能接受任意文本。

上述“未受理”仅指**这一次服务端请求没有新 taskId**。如果本地检查点此前可能已发送过同一逻辑请求，必须先按其幂等身份/已知 taskId 处理；一次后来收到的前置拒绝不能抹掉此前未知提交。服务端同键重放成功返回 `{data:{status:"queued",taskId},requestId}`，即使任务已经终态；必须随后 GET task。

## 同步 `PATCH /accounts/{id}` 停用

`{enabled:false,expectedCredentialVersion,expectedStateVersion}` 的两个版本必须同时提供且均为正安全整数。`PATCH` 是同步操作，成功为 200 `{data:<当前安全账号元数据>,requestId}`；没有 taskId，也不使用 Idempotency-Key。明确 `VERSION_CONFLICT` 409 由 `CredentialStore` 在写状态前校验双版本，证明这次 PATCH 没有写入，应 GET 当前账号并比较原远端 accountId、启用状态和两版本。若已经 disabled，可据 GET 收敛；若仍 enabled，应结束这次确定冲突，由操作者下次重试，不能自动用新版本重发。

停用路径先 `updateState(disabled:true)`，随后 reload auth source、等待请求排空、close account、rebalance、GET 当前账号，最后写成功审计。故 `ACCOUNT_BUSY` 409（等待超时）发生于状态写入**之后**；`INVALID_STATE` 409、`PERSISTENCE_ERROR` 500、`AUDIT_PERSISTENCE_FAILED` 500 或网络响应丢失也不能证明未停用。对于这些错误先 GET；若同一真实账号已经 disabled，可完成停用后解绑。若仍 enabled 且无法确认写结果，保留控制检查点供只读核对，不盲目重发。`force` 会改变排空语义，三表自动停用不应设置。

## 终态、账号归属与版本

- 任务终态：`succeeded`、`partial`、`failed`、`cancelled`、`interrupted`。必须读取逐项 `status`、`clientRef`、`accountId`、`result` 和 `error`，不能只看总状态。`import` 的 `clientRef` 在创建 task 时复制到公开 item，服务端用 Key ID + 幂等键索引 task，但 `GET /tasks` 不暴露幂等键/请求指纹。
- **终态 item 没有 `accountId` 不足以证明未创建账号。** 当前 import 在 `store.create()` 返回后才 `item.identify(row)`；持久化成功而返回/后续任务状态保存失败时可以留下禁用账号但没有公开 ID。确定性校验/重复账号错误发生在 create 前；其他无 ID 失败须保守处理。已识别 ID 的失败仍可能已有禁用账号，应 GET 精确 ID。
- import/replace/test 的成功 `item.result` 带提交或复核时的 `credentialVersion`、`stateVersion`；旧任务缺字段不能补猜。当前 `GET /accounts/{id}` 两版本不同时，旧成功不能证明当前凭证或状态。`VERSION_CONFLICT` 的 task 项可能是验证后状态漂移，也可能是提交前版本不符；根据 kind、item ID、`result` 和当前 GET 收敛，不把旧模型成功标为当前 available。
- import 失去 POST 回执时，只有原 origin 上在有界时间窗口内以唯一 UUID `clientRef` 找到**唯一**同 kind task，并 GET task 核对，才有候选关联；同时检查已知 `createdByKeyId`。多候选、分页缺项、超保留期均保持未知。replace/test 不带 clientRef，失去 taskId 时不能凭同账号、模型或时间猜。

离线验证：`node --test scripts/tests/managementRoutes.test.js`，以及 `node scripts/tests/runManagementTests.js`。测试使用临时目录、回环 HTTP、假验证器，不接真实账号、模型或共享数据库。全管理脚本 2026-09-23 运行通过；LIVE-01 仍为 SKIP，不构成生产验收。
