# Aitoapi 三表客户端接口交接（2026-09-23）

给 Gemini Manager 任务 C 的离线代码契约。本文件基于当前 Aitoapi-custom 路由、任务服务、账号服务和验证器及其离线测试；LIVE-01 双真实账号模型验收尚未通过，以下不代表生产可用。

## D1 身份诊断与 D2 修复边界

- LIVE-01 两个固定账号都在 `identity_unconfirmed` 停止，模型生成尝试为 0，`upstreamStatus` 为 `null`。观察到的 401/403 来自页面后台 XHR，不是指定模型的响应。后续只读诊断中，应用页及 `/apps` 首页均没有当前验证器使用的第一方 `WIZ_global_data.oPEP7c`。首页普通按钮内的邮箱文本不能证明当前登录身份。
- 验证器目前只读取顶层最终 `https://aistudio.google.com` 页面的该字段，不从 iframe、正文、Cookie、账号名或预览内容推断身份。`accounts.google.com` 导航或可见登录挑战会拒绝；条款、地区、权限提示也会拒绝。即使 WebSocket 已连接，身份未知也不会发模型请求；请求期间和返回后继续复核身份。邮箱与凭证 `accountName` 不同会报 `identity_mismatch`。
- 代码核对发现生产 `BrowserManager` 在环境代理模式下给浏览器启动及账号上下文都传入 `parseProxyFromEnv()`，隔离验证器原先未传。现已对隔离验证器补齐同一环境代理与本地地址 bypass，离线测试用假代理确认。生产若启用按账号 sticky proxy，现有隔离验证器仍不能取得对应账号的代理；没有该部署模式和实际代理归属证据，本轮不猜配。代理差异是代码事实，不能据此断定它造成 LIVE-01 的 401/403。
- 未更换身份字段。需要受控测试账号的当前有效登录会话、可信第一方身份来源（含页面/iframe origin、字段语义）及代理模式和会话实际出站路径的脱敏证据。若出现登录/授权挑战，应由正常登录流程处理并重新导出凭证；不能把按钮邮箱映射成已验证身份。

## D3 HTTP 与任务契约

所有路径以 `/api/manage/v1` 为前缀，Bearer 必须是具有相应 scope 的**管理 Key**。成功响应包裹为 `{data,requestId}`，失败为 `{error:{code,message},requestId}`。模型 Key 不能替代管理 Key。

| 操作                             | Scope                             | 请求与要点                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /accounts/import`          | `accounts:write`、`accounts:test` | `{items:[{clientRef,credentials}],model?}`，202 `{data:{status:"queued",taskId}}`。1–100 项；`clientRef` 非空、至多 128 字符、同批唯一。`credentials` 是 storageState 对象或 JSON 字符串，含 `cookies`、`origins`。API 当前允许省略 `accountName`，但三表客户端必须提供准确邮箱，使验证器能与当前页面身份比较。账号先以禁用状态建立；只有目标模型验证成功且凭证/状态双版本未变才自动启用。 |
| `GET /tasks?limit=N&offset=M`    | `tasks:read`                      | `data:{items,limit,offset,total}`；`limit` 默认 50、范围 1–200，`offset` 默认 0、非负。当前实现按任务存储的逆序分页；没有服务端 `kind`、`clientRef`、Key ID 或时间过滤，也没有游标。                                                                                                                                                                                                       |
| `GET /tasks/{id}`                | `tasks:read`                      | `data` 为任务本身。任务含 `taskId`、`kind`、`createdByKeyId`、`createdAt/startedAt/updatedAt/finishedAt`、`status`、`counts`、`items`、`result`，可能有 `error`。import item 保留 `clientRef`，执行后可有 `accountId/index`，并有 `status/progress/stage/error/result`。                                                                                                                   |
| `GET /accounts/{id}`             | `accounts:read`                   | 返回 `accountId/index/accountName/enabled/archived/expired/credentialVersion/stateVersion` 等安全元数据，无 Cookie。可用于后续条件写入前重新获取版本。                                                                                                                                                                                                                                     |
| `PUT /accounts/{id}/credentials` | `accounts:write`、`accounts:test` | 202 任务。旧格式为直接 storageState；新客户端宜用 `{credentials,expectedCredentialVersion,expectedStateVersion}`。两个版本必须成对且为正整数；过期为 409 `VERSION_CONFLICT`。替换候选先做**默认** `gemini-3.8-flash` 模型验证，成功后保留原手动启用状态；此端点不能指定 Pro 目标模型。                                                                                                     |
| `POST /accounts/{id}/test`       | `accounts:test`                   | 202 任务，`{mode:"model",model:"<目标模型>"}` 指定模型只读验证；`connection` 只证明连接，不生成模型响应、不改变启用状态。                                                                                                                                                                                                                                                                  |
| `PATCH /accounts/{id}`           | `accounts:write`                  | 同步 200；`{enabled:boolean,force?:boolean,expectedCredentialVersion?,expectedStateVersion?}`。版本成对，冲突为 409 `VERSION_CONFLICT`。显式 enable 是管理动作，不能当作模型验证结果。                                                                                                                                                                                                     |

`model` 省略时默认为 `gemini-3.8-flash`；显式名称必须匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`。验证器使用请求路径 `/v1beta/models/{model}:generateContent`，按目标账号隔离执行；只有目标账号、请求 ID、模型归属正确且获得非空模型响应才报 `model_verified`。若上游响应带 `modelVersion`，必须与请求模型精确相同；`connection_ready` 不等于 `model_verified`。Pro 的 replace 之后仍应单独 `test` Pro 目标模型，Flash import 应显式传 Flash 目标模型。

成功的 import/replace/test 任务项在 `item.result` 中额外返回 `credentialVersion` 与 `stateVersion`，与 `stage/model/success` 同层。import/replace 记录实际写入返回的提交后版本；test 记录验证后复核通过时的账号版本。客户端只有在 item 成功、`result.success=true`、`stage=model_verified`、模型和账号归属均匹配，并且这两个版本**都存在且与当前 `GET /accounts/{id}` 完全相同**时，才能把该验证用于当前凭证。后续 replace、disable 或 re-enable 会改变版本，历史任务成功不再证明当前状态。旧任务没有版本字段，必须保持待核对或重新对当前账号执行指定模型 test；不能用当前版本补填历史结果。

## 未知提交与幂等

- 每个逻辑提交持久保存唯一 `Idempotency-Key`，最长 256 字符。服务端以**管理 Key ID + 幂等键**定位历史任务，再比较规范化的 HTTP 方法、路径、payload。相同内容返回原 `taskId` 和 admission 形态的 `status:"queued"`，该状态不反映任务当前状态；不同内容返回 409 `IDEMPOTENCY_CONFLICT`。记录跟随任务保留约 30 天。
- 每个逻辑导入请求为各 item 生成唯一 UUID `clientRef`；同一逻辑请求的网络重试必须保持原 `clientRef`、幂等键及请求正文。本地检查点记录目标 origin、任务 kind、提交时间、目标模型、幂等键、请求指纹和**本地 Key 指纹**；本地指纹不能当作远端 `createdByKeyId`。远端管理 Key ID 可以为空，不要求用户额外设置，取得明确 task 后从其 `createdByKeyId` 学习。服务端列表不公开幂等键或请求指纹；只靠列表无法证明两个任务请求正文相同。
- **仅 import** 的 POST 无 `taskId` 时，可在原目标 origin 上有界分页读 `GET /tasks`，在本地提交时间窗口内按 `kind=import` 和唯一 UUID `clientRef` 寻找**唯一**候选，再读 `GET /tasks/{id}` 核实 item，并记录其远端 `createdByKeyId`；若先前已学到远端 ID，还须与其一致。列表总数与 offset 会因新任务变化，缺项不是未送达证明；多候选、超出保留期或分页失败都保持待核对。replace/test 没有 `clientRef`，丢失 `taskId` 后保持待核对，不能凭同账号、模型或时间从列表猜任务。重新发送 POST 是写操作，只有同一 Key/同一幂等键/同一规范化请求且仍在保留期内才可能得到原任务；不要凭列表空结果生成新键重发。
- `queued/running` 未完成；终态为 `succeeded/partial/failed/cancelled/interrupted`。逐项读取 `status` 与验证结果，`partial` 不是全体成功。失败导入可能已经留下禁用账号，应先用 item `accountId` 与账号读取核实，再决定后续 replace/验证/显式启用。

## 离线证据与真实验收缺项

`node --test scripts/tests/managementVerifier.test.js scripts/tests/managementTasks.test.js`：63 pass、0 fail（2026-09-23）。测试使用假浏览器/假上游、回环 WebSocket，不调用真实账号、真实模型或管理部署。仍需受控双账号 LIVE-01：确认可信当前身份、完整真实模型响应、指定模型复验、启用/失败保持禁用、幂等/丢响应找回、重启和并发隔离，并记录脱敏证据。当前两份凭证的既有 401/403 不足以判定模型或账号状态。
