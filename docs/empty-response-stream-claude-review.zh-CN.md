# 空回复与流完整性方案：Claude 审核记录

日期：2026-09-24。评审对象：[优化方案](./empty-response-stream-optimization-plan.zh-CN.md)。方案审核结论：**方案可实施**。以下为方案阶段的历史记录；随后已实施并完成两轮 Claude 代码审核，结果见[实施记录](./empty-response-implementation-2026-09-24.zh-CN.md)。尚未部署。

## 审核方式与边界

- 实际调用本机 Claude CLI，模型由返回的 modelUsage 确认为 `claude-opus-5-5`。
- 使用 safe-mode、禁用工具/MCP、自定义会话不持久化；通过标准输入发送方案、现有审计和选定代码片段。
- Claude 审查给定材料；未自行访问完整仓库、运行测试或验证线上实例。本文记录方案审核，不代表代码已经实现或通过验收。
- 没有读取/传递部署 API Key，没有调用生产模型接口。Claude 审核调用本身是本次用户明确要求的外部模型调用。
- 本次没有改动业务代码、合并其他管理变更、提交、推送或部署。

## 第一轮：v3.0

- 结论：**需修改后可实施**。
- 问题：2 项 P0、7 项 P1，以及 11 项 P2 建议。
- 送审方案 SHA-256：`1ed79f6cbcf565914f1f1a4f11b779b57026b312ec8e24b74520a632e1708f75`。
- 原始意见：[第一轮 Claude 输出](../tmp/empty-response-audit/claude-plan-review-round-1.md)。

| 编号 | 审核问题                                     | v3.1 的处理                                                                                 |
| ---- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| P0-1 | SSE 解析不能覆盖完整 JSON / 原生 JSON 数组流 | §4.0 增加三类 adapter，统一语义事件；保留原生输出格式                                       |
| P0-2 | 现有浏览器取消没有确认通道                   | §7 使用 STREAM_END 确认干净空结果；其他失败新增 attempt_closed，等待至多 2 秒，无确认不重试 |
| P1-1 | 漏结算仍可能按 HTTP 200 成功；健康标记过早   | §9 缺分类即 unclassified_outcome；传输健康与内容成功拆分；语义错误不惩罚账号                |
| P1-2 | 上游队列关闭被误当下游取消                   | §5 按原因区分；客户端取消由响应连接状态判断                                                 |
| P1-3 | 暂存 SSE/压缩/长度头污染开流前 JSON 错误     | §6.1 writer 提交时才应用头；未提交 wireStatus=null                                          |
| P1-4 | ws.maxPayload 超限会断共享连接               | §8.2 浏览器应用层分片、单请求预算、队列局部失败；连接级限额仅作兜底                         |
| P1-5 | 浏览器版本偏差、错误码及 UTF-8 flush 缺失    | §8.3 版本/能力检查及滚动升级；固定错误码，fatal 解码和 flush                                |
| P1-6 | finish/block 映射不明确                      | §5/§6.2 增加枚举表、开流前后 blocked 映射，并核对官方文档                                   |
| P1-7 | 统计细分破坏旧版本回退                       | §9 保留 outcome 和旧汇总，只增 resultClass/细分计数；新旧记录双向读取测试                   |

## 对建议作出的明确取舍

- 保留 EOF 校验，未采用“终止事件之后等 5 秒就自动记成功”。需要先证明提供方允许在无 EOF 时结束，避免漏掉尾部错误。
- 多候选混合成功/过滤仍交付合法原生响应，统计为 incomplete + partialCandidates，避免用一个候选掩盖其他未完成结果。
- 取消确认只证明本地 fetch 收尾，不证明远端工具无副作用；工具风险始终独立阻止重试。
- 缺少取消确认时选择停止重试，即使无工具也不并行重放，避免重复计费。
- 严格模式上线前须确认浏览器能力；旧脚本支持在途收尾，但不将其视作具备新资源保护。
- 旧 failureCount/errorCount 保持兼容，细分类别使用新增字段；不覆盖并行管理变更的统计契约。
- SDK 自动重试属于额外一层，列入客户端验收；不承诺服务端重试上限就是端到端请求上限。

## 第二轮：v3.1

- 实际模型：`claude-opus-5-5`。
- 结论：**可实施（仅指方案层面）**。上一轮 2 项 P0、7 项 P1 均关闭，没有新的 P0/P1。
- 另给出 10 项 P2 实施细节，明确无需再次送审；已并入最终 v3.2。第二轮直接审查的是 v3.1，下文记录后续细化，不能把它表述为实现代码已经获审。
- 送审方案 SHA-256：`208472ad84e6f2f6f084471ad8f3474175bced7814247adc4251988f6248c454`。
- 送审快照：[v3.1](../tmp/empty-response-audit/claude-plan-review-round-2.plan.md)。
- 原始意见：[第二轮 Claude 输出](../tmp/empty-response-audit/claude-plan-review-round-2.md)。

## v3.2 收敛的实施细节

1. 数组已提交后使用 destroy 表达传输失败，不能 end 假装正常结束；本地主动销毁不误记用户取消。
2. attempt_closed 在队列查找及当前账号过滤前路由；使用原始 attempt 的认证绑定，确认记录独立存储，支持先到 ack、TTL 和容量上限。
3. 明确未投递才免确认；交付状态不明的 send 异常按已投递保守处理。
4. HTTP 错误仍等待浏览器 finally 的确认；干净 STREAM_END + finish 成功可以直接重试。
5. terminal_without_eof 分类为 incomplete；首部未发时 504，开流后错误，绝不超时转成功。
6. 用固定表定义传输健康，与内容成功及账号惩罚分开。
7. 多候选混合结果按明确优先级统计；全部候选满足空白名单才允许空重试。
8. 缺 Content-Type 时由请求契约选择输入 adapter，并校验语法。
9. 调度先筛选具备能力的连接；不能因一个旧连接让所有新请求失败。
10. attempts[] 同样保留新增字段，recordAttemptResult 按 attemptId 匹配，汇总从记录重建。

另外将原生伪流的“上游完整 JSON 输入”和“客户端 SSE/数组输出”明确分离，更新阶段表为三类输入 adapter。

## 后续执行边界

可以按方案进入实现。合并后的代码仍需重新审查并执行方案测试矩阵，随后与其他变更统一上线；本次方案通过不代表线上空回复或账号验证超时已经修复。

审核原始输入、输出及模型元数据保存在本地 `tmp/empty-response-audit/claude-plan-review-round-*`。该目录被 Git 忽略；本文件与方案是后续统一提交的可追踪文档。

## 附：第二轮 Claude 原文

## 结论：可实施（仅指方案层面）

v3.1 已关闭上一轮的 2 项 P0 和 7 项 P1。修订没有引入新的 P0/P1。

下列 P2 都是措辞精确化或默认值补充，可以在实施时直接按默认值执行，不必再送审。“通过”只针对方案本身；§10 的测试与§11 的发布门槛仍是未来的实施条件。离线 17 场景仍只作为缺陷基线，本结论不依赖它推断线上根因。

## 原 P0/P1 闭环核对

| 项                                | v3.1 位置                                                                             | 状态                    |
| --------------------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| P0-1 成帧只覆盖 SSE               | §4.0 三类 adapter；按方法、alt、Content-Type 选择；数组括号/转义/尾随；原生保留原格式 | 关闭                    |
| P0-2 取消无确认                   | §7：空重试以 STREAM_END + finish 为前提；新增 attempt_closed；缺 ack 即不重试         | 关闭（路由细节见 P2-2） |
| P1-1 缺省计 success、提前标记成功 | §9 unclassified_outcome；§7 末条跳过惩罚；迁移 `_markAccountSuccess`                  | 关闭                    |
| P1-2 断开来源混淆                 | §5 末段 reason 映射；以 `res.close && !writableFinished` 判 aborted                   | 关闭                    |
| P1-3 暂存头污染错误响应           | §6.1 提交时才应用头；§6.2 wireStatus=null；§10.13                                     | 关闭                    |
| P1-4 maxPayload 断开共享连接      | §8.2 1 MiB 分片、应用层预算、16 MiB 兜底，版本确认前不降低上限                        | 关闭                    |
| P1-5 版本偏差、错误码、解码 flush | §8.3、§4.1 fatal 解码与 flush                                                         | 关闭                    |
| P1-6 枚举与 blocked 表达          | §5 枚举表；§6.2 两张协议表                                                            | 关闭                    |
| P1-7 统计兼容                     | §9 双字段、分桶求和、schemaVersion                                                    | 关闭                    |

## 五项产品取舍：均自洽

1. **坚持 EOF 校验、不采用 5 秒宽限**：与“不追加假成功终态”一致。代价是终止帧后迟迟不 EOF 的请求会在 60 秒后变成错误。需补全分类（P2-5）。
2. **缺 ack 即不重试、ack 不解除工具风险**：安全方向正确。代价是已投递后 WS 断开的请求不再重试，需要把“未投递”区分出来（P2-3）。
3. **统计只增字段**：公式可对账。新口径 success+blocked+incomplete+empty+classifiedError+aborted = total；旧 errorCount = total − success − aborted；账号维度旧 failureCount = total − success。三者互不重复计数。
4. **JSON 数组适配**：自洽。“直接中止响应”需指定具体方式（P2-1）。
5. **官方枚举**：按要求不复核。表中未知值不回退为 STOP，与原则一致。

## P2（精确默认值 + 验证方式）

**P2-1 数组已提交后的中断方式（§4.0）**

- 修正：用 `res.destroy()` 中止，不用 `res.end()`。后者会写出正常的 chunked 结束块，客户端只能看到“JSON 不完整”，而看不到传输中断。
- 验证：在 localhost 用原始 socket 断言没有 `0\r\n\r\n`，客户端报读取错误。

**P2-2 attempt_closed 的路由位置（§7）**

- 修正：必须在 `ConnectionRegistry.js:254` 的队列查找之前分流。要同时绕过三处丢弃：`:257` 的 authIndex 过滤（账号切换后 ack 来自旧账号）、`:265` 的 attempt 过滤、`:274` 的 unknown ID（`removeMessageQueue` 已删除条目）。
- 确认表独立于 messageQueues，按 attemptId 在 `_forwardRequest` 时创建。ack 早于等待方到达时先记录状态；请求结算后保留约 60 秒 TTL 再清除。
- 验证：分别测试账号切换后到达的 ack、队列移除后到达的 ack、ack 先于 waiter 注册。

**P2-3 “未投递”不需要 ack（§5 末段与 §7 的措辞冲突）**

- 修正：`_forwardRequest` 同步失败（WS 非 OPEN 或 send 抛错）视为 attempt 未开始，可按现有策略重试，并计入总次数。已投递后出现 ws_closed、browser_reconnect 时，开流前返回 502 transport_error，不重试。
- §5 中“按安全条件执行既有连接重试”改为引用 §7 的这条规则。
- 验证：重连窗口内转发失败会重试；已投递后断开不会重试。

**P2-4 哪些失败免等 ack（§7）**

- 修正：新脚本下，除“STREAM_END + finish 成功”外，其余结束一律等待 attempt_closed。该消息在浏览器 finally 中发送，正常情况下毫秒级到达，因此不必再单独识别“原始 HTTP 错误”，也不需要新增错误码。
- 验证：429 → 重试路径的新增延迟小于 50 ms。

**P2-5 terminal_without_eof 的结果定义（§4.2）**

- 修正：resultClass=incomplete，errorCode=terminal_without_eof。
  - 开流后：发流内错误；数组流按 P2-1 destroy；不发成功终态，不重试。
  - fake/非流：按 504 处理。
- 验证：伪上游在终止帧后挂起，检查以上行为。

**P2-6 传输健康口径（§9）**

- 修正：把“可包含”改为明确定义：完整 2xx 且 parser.finish 成功即视为传输健康，包括 upstream_finish_error、unsupported_output 和多候选 incomplete。invalid_upstream_response、incomplete_stream、resource_exhausted、transport_error、aborted 不算。
- 验证：429 连续计数的重置表驱动测试。

**P2-7 多候选的优先级与重试（§5）**

- 修正：error > 混合含成功（incomplete）> blocked > empty。只有全部候选都落在空回复白名单内，才允许空重试。
- 验证：candidateCount=2 的各种组合。

**P2-8 缺少 Content-Type（§4.0）**

- 修正：浏览器转发的头缺失时，按 alt 参数判定，并用首个非空白字节（`[`、`{`、`d`/`:`）校验。不一致时判 invalid_upstream_response。

**P2-9 严格模式与旧连接（§8.3）**

- 修正：调度时先排除不具备该 capability 的连接；只有没有可用连接时才返回 503 browser_upgrade_required。这个 503 不计入凭证失败。

**P2-10 attempt 级统计（§9）**

- 修正：
  - `attempts[]` 元素（`UsageStatsService.js:185-190`）同样增加 resultClass、errorCode、attemptId、upstreamStatus。
  - `recordAttemptResult` 改为按 attemptId 匹配。目前 `:134-137` 按 authIndex 倒序匹配，同账号重试时会串位。
  - 新的汇总计数在加载时由记录重建。
- 验证：同账号两次 attempt 分别结算；新版本写入、旧版本读取后计数对账。
