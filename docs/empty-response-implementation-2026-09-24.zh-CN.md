# 空回复、流完整性与 DEBUG 诊断实施记录

日期：2026-09-24。基线：`387a2fc0b48b6a5101dbc716f0292230d1c90067`。

## 交付状态

已按用户确认的“完整流优化与日志一起实施”落地代码、离线测试和 Claude 实现复审。用户随后授权将本轮流优化、日志增强及已有管理变更统一提交并推送到 origin/main；部署结果另行确认。本轮未调用生产模型、未读取部署 Key、未手动部署。

历史日志不能补出当时未记录的信息。本次修复确定的代码缺陷，**不将离线测试视为历史空回复或 25% 验证超时的线上根因证明**。

## 已实施

| 范围       | 当前行为                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一入口   | Gemini、OpenAI Chat、Responses、Claude 的真实流、伪流、非流均使用 GenerationPipeline；非生成接口保留原路径                                                                    |
| 输入适配   | SSE、JSON 数组、完整 JSON 分别解析；处理跨块 UTF-8、BOM、LF/CRLF/CR、多行 data、注释和 EOF 残片；浏览器 fatal UTF-8 并在 EOF flush                                            |
| 首次输出   | 普通文本、完整工具调用或受支持媒体出现前不提交 HTTP 200、不发送心跳；伪流先校验完整结果                                                                                       |
| 结束校验   | 正常终态等待 EOF；空、thought-only、无终止、非法 JSON、未知 finish 不再作为正常完成；原生数组失败不发送闭合括号，使用连接中断                                                 |
| 协议语义   | blocked 保留过滤/拒绝语义；有内容 MAX_TOKENS 保留 length/max_tokens/response.incomplete；错误后不再发送正常 DONE/message_stop/response.completed                              |
| 工具       | 按 id/index 聚合参数，支持完整对象与带标识的 JSON 字符串片段；完整校验后交付；保留上游 ID；blocked/非法 finish 不交付工具；MAX 的非法残片不冒充完整工具                       |
| 媒体       | Gemini 原生保留媒体；兼容协议支持非空内联图片；不支持的纯媒体返回 unsupported_output；混合文本中不把音频误标为图片                                                            |
| 重试       | 空重试最多一次，与默认总尝试数 3 共用预算；有输出、客户端断开、解析失败、MAX、资源不足等不重试；已投递的非 EOF 重试等待原 attempt 的清理确认                                  |
| 工具副作用 | 明确未投递可重试；已投递且声明 hosted/未知工具时保守禁止自动重放，包括 401/403/429。ack 只证明本地清理，不证明远端没执行工具                                                  |
| 浏览器协议 | protocol_version=2 握手，按原 socket/account/request/attempt 校验 attempt_closed；旧浏览器不接收新的严格生成请求；管理验证与模型探测兼容新控制消息                            |
| 超时与背压 | 首有效输出期限包含路由及重试；第一次 write 接受数据即停止该期限；上游空闲和下游 drain 单独计时；不暂停共享 WS，队列超限取消当前 attempt                                       |
| 统计与界面 | 新增 schemaVersion=2、resultClass、errorCode、attemptId、upstreamStatus、wireStatus、attemptOutcome、deliveryOutcome；同账号重试按 attemptId 归因；界面展示拦截/空/未完整结束 |

HTTP 200 在已开流后不能改为 502/504：客户端需要识别流内错误或连接异常。`deliveryOutcome=success` 表示本地响应 finish，不证明远端已阅读或展示。

旧 `outcome=success/error/aborted` 保留；blocked、empty、incomplete 进入旧 error 桶。新增分类计数单独维护，旧历史数据不推测 resultClass。账号健康恢复与内容结果分开：有效解析的上游 200 可以重置账号错误连续计数，仍会将空/拦截结果记为对应语义分类。

## DEBUG 日志

新增诊断一律先经过 DEBUG 总开关，事件自身标为 WARN/ERROR 也不能绕过。标准模式不输出新增诊断、不运行 generation progress 定时器、不维护诊断事件环、不上报浏览器字节摘要；业务保护和正常统计始终启用。

主要事件：

- `generation.accepted`、`request_started`、`configuration`、`attempt_started`、`dispatch`。
- `upstream_headers`、`first_upstream_byte`、`first_effective_output`、`response_committed`、`progress`。
- `cancel_requested`、`retry_decision`、`browser_closed`、`attempt_finished`、`request_finished`。
- `verification.stage`：queued、dequeued、initializing、transport_listening、browser_ready、checking_session、identity_pending/confirmed、generating、cleaning_up、failed/finished。

可按 requestId/attemptId、bootId 串联。记录实际 HTTP 状态、语义结果、finish reason、有效文本/工具/媒体计数、解析残片、队列/缓冲峰值、写等待和分阶段时间。浏览器和服务端的 data 字节均按 UTF-8 文本口径计数。若部署提供有效十六进制 `ZEABUR_GIT_COMMIT_SHA` 或 `GIT_COMMIT`，附带 buildCommit，否则为 null。

没有收集 prompt、回复正文、工具参数、签名、图片数据、Cookie 或 API Key。原有完整 body/chunk DEBUG 输出已从生成转换入口移除。错误使用稳定机器分类；本轮不回传任意上游错误正文，因此 400 的详细 provider message 暂不可见。

实际输出约束：单条 JSON 最多 8 KiB；事件环保留最近 12 条形状摘要；日志队列最多 128 条，普通阶段占用最多 96 条，为终局保留容量；`logsDropped` 表示累计丢弃数。过载仍可能丢日志，不宣称永不丢失。浏览器日志 DOM 最多 200 条，服务端界面缓存保持 1000 条。关闭 DEBUG 会清理 generation 诊断定时器、事件环和待输出诊断队列。

## 配置与上线准备

| 配置                            | 默认值    | 含义                                               |
| ------------------------------- | --------- | -------------------------------------------------- |
| GENERATION_PREOUTPUT_TIMEOUT_MS | 300000    | 路由、重试及首次有效输出的总等待期限               |
| GENERATION_EMPTY_RETRIES        | 1         | 仅允许 0/1；仍受 MAX_RETRIES 总次数限制            |
| GENERATION_BUFFER_BYTES         | 67108864  | 单请求逻辑缓冲预算                                 |
| GENERATION_GLOBAL_BUFFER_BYTES  | 268435456 | 当前 Node 进程共享生成缓冲预算                     |
| STREAM_TIMEOUT_MS               | 60000     | 真实流上游空闲及下游写等待保护                     |
| FAKE_STREAM_TIMEOUT_MS          | 300000    | 伪流/非流空闲保护，与首内容总期限取先到者          |
| LOG_LEVEL                       | INFO      | DEBUG 才开启详细诊断；也可通过现有管理界面动态切换 |

缓冲预算是保守逻辑计费，**不是进程 RSS 上限**。已消除解析对象的重复计费；400 万字符内联图片通过默认预算测试。并发大媒体可能触发全局 503，需要上线后结合实际峰值调整。主共享 WS 的连接级 maxPayload 没有降低，避免影响既有上传；正常响应由浏览器通用分片控制。

统一发布时必须一起更新服务端、浏览器 build.js 和管理界面，并让受管浏览器重新加载到协议 v2。未升级连接会收到 browser_upgrade_required。发布后以 DEBUG 的新请求确认日志关联、超时来源、资源峰值及网关行为，再切回标准模式。客户端/Zeabur 网关在无首字节期间能等待多久仍需线上确认；内部 300 秒配置不能覆盖外部网关超时。

## Claude 实现审核

实际调用本机 Claude CLI，返回模型均为 `claude-opus-5-5`；safe-mode、工具和 MCP 禁用；只提交相关代码/审查上下文，未提交凭证、生产日志正文或私人账户数据。

1. 第一轮指出 1 P0、2 P1：原生 fake 的多行 JSON SSE 编码、未投递的 hosted-tool 重试、重复预算计费。
2. 三项修正并补测试后复审，Claude 结论：**P0/P1 已闭环，无剩余 P0/P1**。
3. 复审的 P2 补充已处理：数组尾帧和 fake 完整 JSON 的终止门控；工具 id/index 关联、对象/字符串参数混用拒绝、后续签名接收、异常 finish 不交付工具；补充 tool_calls/tool_use 最终终态断言。上游错误正文与并发预算属于上述明确边界。

Claude 仅审阅提供的代码，未自行运行测试或做线上验证。最终 P2 修正由本地回归验证；未宣称 Claude 再次审核了这些后续微调。

原始审查存放在本机忽略目录：`tmp/empty-response-audit/claude-implementation-review.md` 和 `claude-implementation-review-round-2.md`。本文保留可随仓库提交的结论与处理记录。

## 验证

- `node scripts/tests/generationPipeline.test.js`：107 个主流程场景，加逐 UTF-8 字节边界拆包验证。
- `node scripts/tests/generationSafety.test.js`：18 组测试，含真实本地 HTTP、真实浏览器脚本 VM、DEBUG 门禁/脱敏/有界队列、ack 隔离、背压与取消、共享重试预算、原生数组中断、工具碎片、大媒体及 Claude 审查回归。
- 路由、原有 stream-integrity、quota、autoheal、model-probe、upstream-improvements 回归通过。
- 管理测试总入口通过，其中 ManagementVerifier 为 45/45；测试中的明确 TODO/线上门槛仍未执行。
- 定向 ESLint：0 error；StatusPage 既有 v-html warning 保留。Vite 生产构建通过，保留既有大包体积提示。

以上均为本地验证。没有将“25% 验证超时”标为已修复；已经补上阶段输出，待其他变更完成后统一上线定位。
