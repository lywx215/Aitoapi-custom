# Aitoapi 空回复与流完整性优化方案

日期：2026-09-24。版本：v3.2（v3.1 复审通过，补齐复审 P2 实施细节）。状态：已实施共享流处理与 DEBUG 诊断，未部署。下文保留方案编写时的基线分析；当前代码、测试与实现审查结果见[实施记录](./empty-response-implementation-2026-09-24.zh-CN.md)。

## 1. 范围、基线与目标

- Aitoapi 代码基线：`387a2fc0b48b6a5101dbc716f0292230d1c90067`。本轮核对的生成处理、转换、队列和统计代码仍包含下述问题；工作区另有管理功能变更，实施时必须重新核对合并后的版本。
- 对比基线：gcli2api `101e9cb`、CLIProxyAPI `5a08fbee`。本文引用的是本地版本的行为，不代表所有版本或所有提供方。
- 覆盖生成接口：Gemini 原生、OpenAI Chat Completions、Responses、Claude Messages；每个接口覆盖真实流、伪流和非流式。
- embedding、countTokens、模型列表和其他非生成代理接口不应用生成内容校验。
- 目标：消除解析丢内容和空结果假成功；首个有效输出前发现错误时返回真实非 200；开流后错误用协议事件表达，并准确统计。
- 不承诺上游每次产生答案，也不承诺已提交的 HTTP 200 可以追改。明确拒绝/安全拦截允许按协议返回 200，但记录 blocked，不计正常回答成功。
- 用户随后明确授权完整流优化与日志一起实施。代码和离线验证已经完成；统一提交及部署按其他变更进度执行。账号验证进度 25% 超时属于独立链路，不由本方案宣称修复。

此前已确认的产品选择继续有效：首次有效内容后开流；至多一次安全的空回复重试；保留协议拒绝/拦截语义。

## 2. 证据与对比结论

### 2.1 当前 Aitoapi 的确定缺陷

- `src/core/RequestHandler.js` 的原生流将 STREAM_END 视为完成；原生非流解析失败也可原样返回 200。
- `src/core/FormatConverter.js` 的 OpenAI/Claude 流按网络 chunk 解析 JSON；Responses 也缺少跨 chunk 的残片缓冲。拆包/合包可以丢失正文。
- finishReason 存在并不保证有有效回答；空 STOP、只有 usage、只有 thought 都可能被包装为完成。
- `_executeRequestWithRetries` 收到初始非错误消息即标记成功并退出重试范围，正文语义不参与判定。
- 多个伪流路径有提前写 keep-alive 的行为；`_finalizeTrackedRequest` 仍可能根据 HTTP 状态推导 success。
- 浏览器 fetch → WebSocket → MessageQueue → HTTP 的多层缓冲，使只限制解析器内存不足以控制积压。

已有离线审计：`tmp/empty-response-audit/analysis-2026-09-24.md`、`reproduce.cjs`、`results.json`。17 个场景复现了当前行为，属于缺陷基线，不是修复通过证明。历史日志缺少正文和结束语义，不能确定某次线上空回复的根因；其中约 25/31 秒断开不能直接归因于模型或服务端超时。

### 2.2 借鉴与不采用的行为

| 来源                                                      | 借鉴                                                       | 适用边界 / Aitoapi 调整                                                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| gcli2api HTTPX、CLIProxyAPI Gemini Scanner                | 先重组行再解析，不将网络分片视为 JSON                      | Aitoapi 实现完整增量 SSE 事件解析，包括多行 data、跨块 UTF-8 和事件边界                                                  |
| CLIProxyAPI Responses framer / ForwardStream / CloseError | 共享分帧、取消传播、关闭时检查错误和终止状态、终态只发一次 | 推广至 Aitoapi 四种生成协议，语义校验独立于分帧与转发                                                                    |
| 两项目的首项 / 首 payload 预取                            | 提交响应前拦截错误                                         | 强化为目标协议可交付的有效内容；非空字节、角色、usage、reasoning 不足以开流                                              |
| CLIProxyAPI Codex 启动缓冲                                | 识别 HTTP 200 内的失败，尝试之间隔离                       | 该功能默认关闭；48 扫描行/1 MiB 到限会放行，reasoning/工具活动会放行。Aitoapi 不照搬，到限明确失败；工具活动影响重试资格 |
| gcli2api 伪流占位文字                                     | 不采用                                                     | 不生成“响应为空，请重试”作为模型答案，不把失败改成普通成功文本                                                           |
| gcli2api 抗截断续写                                       | 不纳入基础修复                                             | 不自动修改提示词、追加 [done] 或进行续写；避免额外成本、重复内容和工具副作用                                             |
| CLIProxyAPI 的连接后超时策略                              | 不照搬                                                     | Aitoapi 保留可配置空闲超时，并增加首个有效输出的独立总等待期限                                                           |

对比依据：gcli2api `src/httpx_client.py`、`src/router/stream_passthrough.py`、`src/api/utils.py`、`src/converter/fake_stream.py`、`src/converter/anti_truncation.py`；CLIProxyAPI `sdk/cliproxy/auth/conductor_stream.go`、`sdk/api/handlers/stream_forwarder.go`、`sdk/api/handlers/openai/openai_responses_handlers.go`、`internal/runtime/executor/codex_executor_stream.go`、`codex_executor_terminal.go`。已运行对比项目的相关测试：gcli2api 6 项、CLIProxyAPI 5 项通过，只证明所测路径。

## 3. 总体结构与不可破坏的约束

建议拆分为以下模块（名称为拟定实施接口）：

1. `GenerationInputAdapter`：按输入形态选择 SSE 分帧器、增量 JSON 数组分帧器或完整 JSON 收集器，统一输出 `{raw, parsed, byteLength}`；提供 `push()`、`finish()`、残片和字节计数。
2. `GenerationResultGuard`：解析后的上游事件 → 每候选语义状态和最终结果；不自行写 HTTP。
3. `GenerationAttemptRunner`：一个 attempt 的收头、读取、转换、语义校验、错误和清理；只有此层返回终局 attempt 结果。
4. `GenerationResponseWriter`：首个有效输出门控、目标协议输出、背压、唯一终态和 delivery 结果。
5. 请求级协调器：共享总尝试次数、首个有效输出截止时间、内存配额与客户端取消状态，决定能否重试。

必要约束：

- 原始流仅由一套解析器解释，完整性检查和转换器使用同一份事件，不能分别再猜测 chunk 边界。
- `upstreamStatus`、`wireStatus`、`attemptOutcome`、`deliveryOutcome` 独立；200、非空 payload、STREAM_END 均不等同语义成功。
- 每个 attempt 和每个下游请求均有幂等 finalizer。error/timeout/EOF/close 并发时只有一次结算、一次资源释放。
- 已交付任何流字节、已执行或不能排除执行过有副作用的工具、客户端已断开，均不可自动重试。
- 将“是否提交 HTTP”与“是否观察到工具执行风险”分别存储，不能用 headersSent=false 推导安全重试。
- 所有错误分类保留稳定 code；不把本地解析/缓冲错误当作账号 401/403/429，不因此禁用或惩罚账号。

## 4. 输入成帧、UTF-8 与转换器改造

### 4.0 输入形态与选择契约

- 以请求生成方法、alt 参数和上游 Content-Type 联合选择；不按 real/fake 标签猜测 SSE。兼容接口真实流当前显式传 `alt=sse`（RequestHandler.js:2616），原生路径未统一强制 SSE（:2337）；浏览器 fake 会改成 generateContent 并移除 alt=sse（build.js:310—320）。
- `text/event-stream` 使用 SseEventParser；原生 streamGenerateContent 的 `application/json` 数组使用增量 JSON 数组 adapter；generateContent / 非流 / 伪流通常使用完整 JSON adapter，在 EOF 后整体解析。协议类型不匹配不能静默当作另一类成功结果。
- 缺 Content-Type 时按实际上游请求回退：alt=sse → SSE；streamGenerateContent 且无 alt=sse → JSON 数组；generateContent → 单 JSON。通过对应语法校验首部及完整输入；不能仅凭一个非空字符认定类型或成功，不一致归 invalid_upstream_response。
- 数组 adapter 跟踪字符串、转义、括号深度、元素间逗号和顶层结束，输出完整元素，验证顶层数组关闭及尾部只有空白；空数组为空结果，半个数组为 incomplete_stream。单 JSON adapter 拒绝尾随垃圾或多个拼接对象。
- 三种输入共享 GenerationResultGuard；非流/fake 的完整 JSON 相当于一个结构化事件。错误响应按 HTTP 错误及相应 body 解析，不把上游非 2xx 错误对象套生成 schema。
- 原生真实流/非流成功结果保持原传输格式：SSE 原始帧、JSON 数组的括号/逗号/原始元素、单 JSON 原文。原生伪流的上游虽为单 JSON，下游仍按原客户端请求的 alt/接口输出 SSE 或 JSON 数组，不能用上游输入格式代替下游输出契约。不得将 JSON 数组客户端强制改成 SSE。
- 开流前错误返回 JSON 错误对象；原生数组已开始输出后不能插入 SSE 或将 error 混作候选元素，使用 res.destroy() 中止而非 res.end()，记录流失败。HTTP/1.1 fixture 验证没有正常 chunked 结束块，客户端必须识别读取/解析失败；不将内部 Node 请求清理误计为用户主动取消。
- 生成校验仅作用于规范化后 POST generateContent / streamGenerateContent（含由兼容接口转换而来）的请求。不要仅凭路径子串或 Content-Type 对其他接口启用。

### 4.1 输入规范

- 处理 LF、CRLF、单独 CR、跨块 CRLF、首次 BOM、注释、空行、多个事件同块和多行 data（按换行连接）。event/id/retry 字段不作为模型内容。
- 无 data 的注释/心跳仅更新传输活动；空 data 不算有效回答。提供方明确的 `[DONE]` 属于终止信息，不算正文。
- 完整 data 事件 JSON 非法即失败，不继续吞错并输出正常完成。未知字段透传/忽略可扩展字段，未知事件只有明确属于元数据时才能忽略，否则保留未知状态并在终局判定。
- EOF 调用 `finish()`：仅有空白/注释残留可结束；未闭合 data 事件或 JSON 残片归类 incomplete_stream / invalid_upstream_response。不得对半个 JSON 猜测补全。若实际提供方存在无空行结尾的兼容格式，必须有真实脱敏样例和专门 adapter 测试后才允许，不能全局放宽。
- 浏览器端使用 `new TextDecoder('utf-8', {fatal:true})` 流式解码，并在 EOF 调用 decode() flush；异常作为 invalid_utf8 映射 invalid_upstream_response，避免静默替换或丢字。节点端收到的是已解码文本时不得重复错误解码。

### 4.2 转换与原生输出

- 转换器消费结构化事件，并返回“目标协议可表达内容”的摘要；同时统计上游有效内容与下游可交付内容，防止转换器丢失工具或媒体后仍开流。
- 原生 Gemini 保存完整事件对应的原始数据用于输出，不添加模型正文，不因观察器重新序列化而损失字段；在完整帧边界输出。
- 开流前暂存 thought、签名、usage、角色等有序事件；出现有效内容后按原顺序释放，保留 thoughtSignature、工具 ID、媒体及 grounding 元数据。
- 开流后即时输出非终态有效事件；正常终止帧先暂存，直到 EOF 和 parser.finish 校验通过再发。终止后只允许该提供方明确允许的 usage/元数据；新的内容或冲突终止原因视为异常。
- 不在 EOF 无条件合成 `[DONE]`、message_stop、response.completed。所有成功终态由统一 finalizer 根据校验结果产生。
- 如同一原生事件同时含正文与 finishReason，可整帧延迟至 EOF 后输出，以保留原文且不提前暴露成功终态；兼容输出可拆为正文事件和暂存终态。不能仅因缓冲里已有有效内容，就先释放该原生终态帧。
- 暂不采用“终止后等 5 秒即按成功结算”的建议：当前目标包含 EOF 残片/后续错误检测，缺少该提供方可提前结束的证据。保留空闲超时，单独记录 terminal_without_eof；存在合法终止但不关闭的提供方需以 fixture 扩展终止契约，不将超时直接计 success。
- terminal_without_eof 的 resultClass=incomplete；开流前（含伪流/非流）返回 504，开流后发送协议错误，数组流 destroy；不重试、不发送成功终态。主动 destroy 前固定 delivery 失败原因，后续 close 事件不得覆盖为用户 aborted。

## 5. 有效性、完整性和结果分类

有效内容必须能够在目标协议交付：普通文本存在非空白字符；合法、可完整表达的客户端工具调用；受支持的非空媒体。thought、usage、角色、空 parts、空 candidates、空白正文、结束标记本身均不算。

工具调用须有合法名称、正确参数类型和必要 ID，允许参数为空对象；流式参数按调用 ID/index 聚合并验证。不得将空参数对象误判为无效，也不能用半个 arguments 字符串触发“完整工具结果”。媒体须有合法类型及非空数据/可用引用；不下载任意媒体来判断有效性。

按 candidate index 跟踪内容和 finishReason；开始前校验目标协议实际支持且会转发的候选数。当前不支持的 n/候选模式提前返回参数错误，不能悄悄取第一个而丢其余。原生支持多候选时按候选原样交付：混合成功与过滤是合法协议响应，不整次返回 502；总体 resultClass=incomplete、partialCandidates=true，并记录各候选分类。仅所有候选都有效且正常完成才记整体 success；全 blocked 记 blocked；全空记 empty；缺终止或 malformed 优先错误。该严格统计口径不改变合法原生候选结构。

多候选聚合优先级：error > 混合含有效结果或任一截断（incomplete）> blocked > empty；所有候选正常成功才 success。仅所有候选都落在空重试白名单才允许空重试；空与 blocked 混合不重试。

未知字段允许扩展。未知 part 原生可透传，但不单独视作有效内容；兼容转换若丢弃唯一未知内容，归 unsupported_output；存在其他可交付有效内容时保留结果并计 unknownPartCount。executableCode 等服务端工具执行指令只记工具活动，不单独作为最终回答；codeExecutionResult 只有请求/输出契约接受且非空、能够交付时才算有效结果。无论是否有效，工具活动都立即更新副作用风险，不能等最终答案才标记。

| 输入 / 终局                                         | semanticOutcome / code            | 行为                                                          |
| --------------------------------------------------- | --------------------------------- | ------------------------------------------------------------- |
| 有有效内容且合法 STOP / 工具结束                    | success                           | 正常结束                                                      |
| 干净结束但零字节、空候选、空 STOP、纯空白或仅 usage | empty / empty_response            | 开流前 502；符合条件时至多安全重试一次                        |
| 仅 thought，未给出最终正文/工具/媒体                | empty / thought_only              | 开流前 502；仅普通 STOP 且满足安全条件才可使用空回复重试      |
| MAX_TOKENS 且有有效内容                             | incomplete / output_limit         | 保留内容和 length / incomplete 语义，不计正常完成，不自动续写 |
| MAX_TOKENS 且无有效内容                             | empty / output_budget_exhausted   | 502，指出输出预算耗尽；不以相同参数自动重试                   |
| 明确 prompt/candidate 拦截或拒绝                    | blocked                           | 保留原因和协议表达，可 200；不计正常回答成功，不重试          |
| 完整事件 JSON 非法 / 数据类型不符                   | error / invalid_upstream_response | 502 或流内错误，不自动掩盖                                    |
| 已有正文但无合法终止 / EOF 残片                     | incomplete / incomplete_stream    | 502 或流内错误，不输出成功终态                                |
| 空 EOF 且没有候选/终止事件                          | empty / empty_response            | 带 terminalMissing=true；仅满足安全条件可重试                 |
| 上游有内容但目标协议丢失/不支持                     | error / unsupported_output        | 502 或流内错误，不算空模型回答，不重试                        |
| 未识别 finishReason / OTHER 等不能确认完成的原因    | error / upstream_finish_error     | 保留原始原因，不回退为 stop，不重试                           |
| 下游断开                                            | aborted                           | 立即取消，不重试，不发送新终态                                |

优先级：客户端断开决定 deliveryOutcome=aborted；明确上游失败、解析错误、残片或传输错误优先于 success/empty；合法拦截优先于“无正文”的 empty 分类。若模型完成后客户端发送失败，attemptOutcome 可 success 而 deliveryOutcome=aborted/error。

结束原因使用显式表，保留原值。以下是本方案的分类策略，枚举含义依据 [Google GenerateContent 参考](https://ai.google.dev/api/generate-content#FinishReason)；未知新增值不回退到 STOP：

| 字段/值                                                                                                                                                                                      | 分类                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| promptFeedback.blockReason 非空且不是 BLOCK_REASON_UNSPECIFIED                                                                                                                               | blocked；包含明确 OTHER 拦截                              |
| prompt blockReason 缺失/空/UNSPECIFIED                                                                                                                                                       | 不是已确认拒绝，继续检查候选                              |
| STOP                                                                                                                                                                                         | 按内容判 success / empty / thought_only                   |
| MAX_TOKENS                                                                                                                                                                                   | output_limit / output_budget_exhausted                    |
| SAFETY、RECITATION、BLOCKLIST、PROHIBITED_CONTENT、SPII、IMAGE_SAFETY、IMAGE_PROHIBITED_CONTENT、IMAGE_RECITATION、ESCALATION、PUP_LIMITED_DISABLED                                          | blocked；保留已有内容及具体原因；不自动绕过限制或禁用账号 |
| LANGUAGE、OTHER、IMAGE_OTHER、NO_IMAGE、MALFORMED_FUNCTION_CALL、UNEXPECTED_TOOL_CALL、TOO_MANY_TOOL_CALLS、MISSING_THOUGHT_SIGNATURE、MALFORMED_RESPONSE、FINISH_REASON_UNSPECIFIED、未知值 | upstream_finish_error，不重试，保留原值                   |
| 同候选重复同一终止原因                                                                                                                                                                       | 可接受，终态只发一次；终止后新正文或冲突原因仍为错误      |

队列关闭不等同客户端取消。统一 reason 映射：client_disconnect 为下游取消；ws_closed/browser_reconnect/account_switch 等为上游 transport_error；preoutput_timeout/resource_exhausted/attempt_superseded 为本地原因。只有非本地主动销毁造成的 `res.close` 且 `!res.writableFinished` 或等价明确取消信号决定 deliveryOutcome=aborted；不能使用请求体读完的 req.close 推断。上游中断按 §7 的“是否已经投递/是否有确认”决定重试，开流后表达错误。

## 6. 开流与协议终态

### 6.1 首次有效内容门控

- 状态：WAITING → BUFFERING → STREAMING → FINALIZED；开流前失败可进入 RETRYING，再创建全新的 attempt 状态。
- writer 提交前不调用 res.status/set/_setResponseHeaders；预备头和状态仅存内部对象，提交时一次性应用。不允许提前 write/flushHeaders/end 或发送 role、thinking、ping/keep-alive。开流前错误一次性设置正确 JSON 错误头，转换/浏览器已解压响应不继承上游 Content-Length、Content-Encoding、Transfer-Encoding。
- 覆盖四协议全部真实流与伪流分支。伪流完整收集并校验后才按原有格式分块输出；不能让现有 12—18 秒心跳绕过门控。
- blocked 是显式例外：已确认完整拒绝结果时可以直接输出合法拒绝响应，无需伪造有效正文。
- 有效内容出现只允许开始交付，不代表最终成功；EOF、结束原因和客户端交付仍须校验。

### 6.2 错误映射

开流前：空/非法/不完整上游结果 502；真实超时 504；本地缓冲资源预算不足 503；上游 429 和明确客户端参数错误维持相应状态，不将所有问题归为 502。

开流前即使请求 stream=true 也返回协议 JSON 错误：OpenAI/Responses 使用 error 对象的 message/type/code；Claude 使用 type=error 与 error.type/message；Gemini 使用 error.code（HTTP 数字）/message/status，稳定机器分类另用协议允许的 details.reason。不得把机器字符串塞入 Gemini 的数字 code。writer 从未提交且客户端已断开时，wireStatus=null。

开流后（HTTP 200 无法修改）：

| 协议            | 错误 / 截断表达                                                                   | 正常结束约束                                                                              |
| --------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Gemini          | SSE data 中明确 error 对象并关闭，客户端须支持错误识别；若断线只能记录异常        | 保留真实候选 finishReason；不能伪造 STOP                                                  |
| OpenAI Chat     | SSE error 对象并关闭；MAX_TOKENS 有正文使用 finish_reason=length，可按协议发 DONE | error 后不再发 stop 或作为正常完成的 DONE；length 属于已知截断而非传输错误                |
| Responses       | failed 对应 response.failed；预算耗尽且有内容对应 response.incomplete             | 失败/截断后不再 response.completed                                                        |
| Claude Messages | event:error 并关闭；有正文的预算耗尽保留 max_tokens stop_reason                   | error 后不再 message_stop；合法 max_tokens 的协议结束允许 message_stop，统计仍 incomplete |

blocked（包括开流后才过滤）使用下表，不转换为空 content + stop。需要的初始化事件、块关闭及 usage 依目标协议补全，终态由统一 writer 产生：

| 协议            | blocked 结果                                                                          |
| --------------- | ------------------------------------------------------------------------------------- |
| Gemini          | 原样保留 promptFeedback / candidate finishReason；JSON 数组正常闭合                   |
| OpenAI Chat     | finish_reason=content_filter；流式可随后 DONE；不是 stop，统计仍 blocked              |
| Responses       | status=incomplete，incomplete_details.reason=content_filter；流式 response.incomplete |
| Claude Messages | stop_reason=refusal；流式 message_delta 后 message_stop；不伪造拒绝正文               |

Responses 的 content_filter 用法核对自 [OpenAI 官方 Structured Outputs 文档](https://developers.openai.com/api/docs/guides/structured-outputs)；Claude refusal 核对自 [Anthropic stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)。这是代理的跨协议映射决策，具体字段/空 content 的 SDK 兼容仍须 fixture 验证。若已声明支持的旧 Claude 客户端不能识别 refusal，明确启用兼容错误适配器返回合法 API error（开流前 JSON / 开流后 event:error），不得悄悄改成 end_turn 或虚构模型文字。

终止事件只由 writer 发送一次。若下游写失败或已断开，不再尝试写错误事件；仍清理与统计。`finish` 表示本地写出完成，不宣称远端客户端已阅读答案。

## 7. 安全重试与账号策略

- 将尝试范围从“等到上游响应头”扩大到“读取、校验并确定本次结果”。收头不调用生成成功标记。
- 保持现有 `maxRetries` 的实际语义：总尝试次数，默认 3；不要改成初次之外再 3 次。配置 1 时不重试。
- 新增 emptyRetryLimit 默认 1，允许 0/1；空回复重试和现有 429/连接失败等共享 maxRetries，不嵌套独立循环扩张请求量。
- 请求级首次有效输出期限覆盖所有尝试、账号等待和退避；重试不能重新开始这项期限。
- 空回复重试白名单：干净空 EOF、空 STOP、普通 STOP 的 thought-only；不得包含 MAX_TOKENS、blocked、非法解析、资源超限、未知 finish、转换器不支持、客户端断开。
- 重试必须同时满足：下游连接有效且未写出字节；请求可重放；总次数及时间预算尚有余量；没有执行过/可能执行过有副作用的服务端工具；旧 attempt 已取消并隔离。
- 仅声明客户端 function 工具且从未交付调用、从未服务端执行，可允许重试。code execution、浏览器/执行/有状态工具以及未知 hosted tool 默认禁止语义重试；只读检索工具也需显式分类允许，否则保守禁止。无正文不能证明没有工具执行。
- 不增加隐式“续写”、调整温度/预算或修改用户提示词。空回复可按既有调度选择合适账号，但不制造凭证故障、禁用或冷却惩罚；上游真实 401/403/429 继续走原策略。
- 新 attempt 使用新的 request_attempt_id、队列、解析器、转换器、缓冲、候选及工具状态。旧 attempt 迟到消息/取消消息不能影响新 attempt。
- 空回复重试只在收到本 attempt 的 STREAM_END、decoder/parser.finish 均成功后进行；空 STOP 本身不足以重试。此时读取已完成，无需等待额外取消确认；清理旧队列后才能开始新 attempt。
- 其他已投递请求的连接/读取/HTTP 错误需要新增浏览器 → 服务端 `attempt_closed` 控制消息（request_id、request_attempt_id、reason=completed/aborted/error），在浏览器 finally 完成读取清理后发送。Registry 在队列查找、当前账号及 attempt 过滤之前单独分流；确认表独立于 messageQueues，在发送前按 attemptId 建立，绑定该 attempt 原始账号和认证连接。账号切换后仍接受合法旧账号 ack，但不接受其他账号伪造，不转投新队列；重复确认幂等。
- ack 先到时记录状态供后续 waiter 消费；移除数据队列不移除待确认记录。请求结算后确认记录保留约 60 秒 TTL，并有条目数上限；此期间迟到数据降为 debug，不无限积累记录。
- 取消确认等待默认 2000 ms，受剩余请求期限限制；无法确认时不启动新 attempt，返回原错误。除了 STREAM_END + finish 成功的结束外，HTTP 429 等也等待 finally 的 attempt_closed，不以响应头代表 fetch 已收尾。不得把 ack 等待时间算作重试次数。
- 明确未投递（例如发送前检查 WS 非 OPEN）不需要 ack，可按既有策略重试并计入总次数；只有能证明发送失败发生在数据交付之前才算未投递。send 抛错/回调错误但交付状态不明时按已投递处理。已投递后 WS 断开且无法收到合法 ack，则开流前返回 502 transport_error，不重试。
- attempt_closed 只证明本地 fetch 清理，不证明远端工具没有执行；已知/未知服务端副作用仍禁止自动重试，不能用收到 ack 绕过工具策略。不得并行重放。
- 对语义/本地错误（empty、thought_only、output_budget_exhausted、invalid_upstream_response、incomplete_stream、unsupported_output、resource_exhausted、upstream_finish_error、blocked）跳过 `_handleRequestFailureScoped` 等凭证惩罚路径；真实上游 HTTP 401/403/429/5xx 继续按原策略分类。

## 8. 超时、内存和背压

### 8.1 超时

- 新增 `GENERATION_PREOUTPUT_TIMEOUT_MS` 默认 300000：从请求进入生成协调器开始，到首次有效内容准备交付；覆盖重试和排队。独立计时器触发取消，不能仅在下一次读到数据时检查。
- 开流后取消此预输出计时器，不设置新的 300 秒总生成硬上限，避免截断持续输出的长答案。
- 保留 `STREAM_TIMEOUT_MS` 默认 60000，定义为上游传输读取空闲间隔；浏览器读取保护与服务端不得相互冲突。有效 SSE 注释可刷新传输空闲，但不能延长预输出总期限。
- 伪流/非流在完整结果校验前均处于预输出阶段，300 秒期限不因连续 thought 或碎片重置；保留现有 FAKE_STREAM_TIMEOUT_MS 配置兼容，文档说明它与预输出总期限取更早到期者。
- 下游 write 返回 false 时等待 drain，并设置独立的慢客户端写等待上限（默认 60000）；暂停上游读取期间不把本地主动等待误报为上游空闲超时。断开、截止和 drain 必须可竞争退出。
- `dequeue(timeoutMs, signal)` 必须能由 AbortSignal 立即唤醒；空闲时间使用最后一次真实 enqueue/上游活动时间，不能每次 dequeue 重置。首版尚未实现跨 WS 的按请求暂停，等待 drain 时仍接收上游并受队列上限约束；只在确实存在主动暂停读取的实现中才暂停相应空闲计时。
- 首内容前不发心跳会延长客户端静默等待。发布前验证客户端/SDK 与 `https://aib.zeabur.app` 网关等待能力；若网关先超时，这套严格门控不能靠内部 300 秒配置解决，需调整网关/客户端或明确模式取舍，不能悄悄恢复早发 200。

### 8.2 资源预算

- 拟定默认：请求内存缓冲预算 64 MiB，进程所有生成缓冲共享预算 256 MiB；可配置并校验请求上限不超过全局上限。这里是代理缓冲配额，不是进程 RSS 上限。
- 同时计入解析器残片、开流前原始事件、转换结果、工具聚合、队列积压、非流全文和等待 drain 的数据；不能只计一个副本。字符串按 length×2 保守计费，Buffer 按 byteLength，结构化对象额外预留并限制深度/元素数；复制/序列化前申请预算，释放后归还，避免多份大媒体副本。
- 单事件也受请求剩余预算限制。应用层单请求预算在浏览器构造消息和服务端入队之前检查；不能指望 ws.maxPayload 精确取消单请求，它超限会关闭整个共享连接。浏览器 fullBody、解码残片和 socket.bufferedAmount 分别有本地上限；多浏览器上下文/多 Node 进程各有预算，不宣称跨进程 RSS 上限。
- 新浏览器 `_transmitChunk` 将数据按序拆为单条序列化 WS 消息不超过 1 MiB（包含 JSON 转义和 envelope 开销，避免切开代理对）；真实流和 fake/nonstream 的完整 body 均使用，服务端按 attempt 重组语义。fake 超出本地预算时停止读取并发送稳定 resource_exhausted 错误，不能先生成超大消息后才检测。
- 主生成连接的 ws.maxPayload 拟设 16 MiB 作为异常连接兜底；触发它可能中断该连接其他请求，必须明确这一边界。降低全局限制前需验证本连接上传/非生成响应也经通用分片且响应头等控制消息兼容；未通过则保留原传输上限，不能用更小兜底破坏既有上传接口。正常新协议超限由应用层提前仅取消该 attempt，不能到达连接级兜底。
- MessageQueue 必须有字节高水位和硬上限。HTTP drain 暂停消费时，浏览器仍可能通过共享 WS 推送，因此仅暂停 dequeue 不足以背压。
- 首版采用有界队列 + 超限取消该 attempt，浏览器发送前检查 bufferedAmount 并有界等待/取消；不暂停整个共享 WebSocket，以免阻塞其他请求。完整按 attempt 的窗口/ACK 可后续优化，不作为首版隐含能力。
- 超预算立即取消并清理：开流前 503 resource_exhausted，开流后流内错误；不重试，不像 Codex 启动缓冲那样到限后直接放行不确定结果。
- 中止、超时、重试、异常、正常结束均释放配额及监听器；资源预算失败不得让取消/错误控制消息排在无法排空的数据之后。
- Queue.enqueue 超限返回明确结果，关闭该队列、发送 cancel 并通知协调器；不抛出未捕获错误到共享 Registry 消息回调。浏览器 bufferedAmount 有界，给小控制消息预留预算；它们不能越过已发的 WS 字节，若连接拥堵/断开而无法送达确认，则按取消未确认终止重试。

### 8.3 浏览器协议版本与滚动升级

- 握手增加 protocol_version 和 capabilities，错误消息增加可选 error_code（invalid_utf8/resource_exhausted/aborted/network_error/read_timeout）；使用固定类别和脱敏 message，旧 status 保留。
- 新服务端能解读缺字段的旧消息：按旧 status 分类，不伪造精确错误原因；缺 attempt_closed 不视为已确认取消。已有旧请求沿旧协议收尾，不能在半途切换解码或分帧策略。
- 启用本方案严格模式前，先刷新/重新注入受管浏览器并确认支持分片、fatal UTF-8、attempt_closed；旧连接仍可识别，但不接收新的严格生成请求，明确返回 503 browser_upgrade_required，并走现有重建流程。等待所有生成连接就绪后统一启用，不能把旧脚本的无界 fullBody 当成已修复。
- 调度先从合格账号中选择满足能力要求的连接；只有旧连接导致没有可用路由时才返回 browser_upgrade_required，其他不可用原因保留原分类。此 503 不计凭证故障，不能因为一个旧连接拒绝所有可服务的新连接。
- 避免用降低 maxPayload 强迫旧脚本断线升级；版本确认前不降低连接上限。非生成请求的兼容性另有回归门槛。
- 新服务端×新脚本验证所有保证；新服务端×旧脚本验证在途收尾、无确认不重试及新请求的清晰错误；旧服务端×新脚本如需回退则同步回退脚本，不能假定未知控制消息被安全忽略。

## 9. 统计、可观测性和兼容迁移

- 每个 attempt 记录 upstreamStatus、semanticOutcome、errorCode、finishReason、blockReason、重试资格/拒绝原因；只在合法完成后更新生成成功状态。
- 请求记录 wireStatus、attemptOutcome、deliveryOutcome、attemptCount、是否已提交、首个有效内容耗时、总耗时。已发 200 后失败应显示“HTTP 200 / 流内失败”，不能伪造为实际发出 502。
- 账号健康与内容成功分离：blocked、empty、客户端取消、本地解析/资源错误不触发凭证禁用；真实传输/限流状态按原策略更新。
- 生成请求缺少显式 resultClass 时，finalizer 记 error/unclassified_outcome 并告警，禁止 HTTP 200 自动兜底 success；非生成请求保留原状态码兜底。逐一接入所有入口，同时迁移所有提前 `_markAccountSuccess` / failureCount 重置位置。
- 传输健康仅在完整 2xx、输入语法/传输收尾正确后更新：success、blocked、干净 empty、output_limit、合法上游对象表达的 upstream_finish_error、unsupported_output、多候选 incomplete 均属传输健康；invalid_upstream_response、incomplete_stream、terminal_without_eof、resource_exhausted、transport_error、aborted 不算。只有前一组重置真实 429 连续计数，生成内容成功仍仅 success；健康判断不放宽结果语义。
- `UsageStatsService` 保留旧 outcome={success,error,aborted}：resultClass=success/aborted 对应同值，其余映射 error。新增 resultClass={success,blocked,empty,incomplete,error,aborted}、errorCode、upstreamStatus、wireStatus、attemptId；序列化/加载白名单须保留新字段，不能由旧归一化覆盖。
- 新界面使用 resultClass 分桶：successCount、blockedCount、incompleteCount、emptyCount、classifiedErrorCount、abortedCount 之和等于总量。旧 errorCount 继续为 blocked+incomplete+empty+classifiedErrorCount，不能把兼容 errorCount 再加入新分桶求和。成功率仍 success/total。
- 账号×模型旧 failureCount 保持旧映射以免破坏管理契约；另增 classifiedFailureCount=error+empty+incomplete、blockedCount、abortedCount 供新展示。展示计数与账号调度惩罚完全独立，调度只按错误来源白名单。
- 新记录 statusCode 等于 wireStatus（未提交为 null）；旧记录 statusCode 可能是合成值，保持原值且 wireStatus=null，标记 schemaVersion。旧记录缺 resultClass 时仅从旧 outcome 推导，不根据历史 200 猜测语义；新字段默认 null/0。旧版本读取新记录使用兼容 outcome，不报错，回退后无法展示细分类别属于已知限制。
- requestId / attemptId 精确关联，attempt 结果按 ID 结算，避免同账号重试时按账号索引误归属。成功重试不抹去前次失败；客户端在上游完成后断开不反向改写上游 attempt 结果。
- attempts[] 也持久化 resultClass/errorCode/attemptId/upstreamStatus，recordAttemptResult 必须按 attemptId 匹配，不按 authIndex 倒序猜测。加载时从记录重建新汇总计数；账号传输健康表、新旧统计口径分别用表驱动测试验证。
- 汇总诊断日志：接口、模型、模式、构建版本、上下游状态、内容类型计数、普通文本/thought 字符数、解析事件/残片大小、队列峰值、预算峰值、终止原因、重试次数、时间及断开阶段。按后续用户确认，这些新增诊断输出仅在 DEBUG 模式启用，标准模式不输出；业务校验、取消协议和正常统计始终运行。门控覆盖所有日志出口及浏览器，具体见 [日志增强设计](./empty-response-diagnostic-logging-plan.zh-CN.md)；此输出约束为 Claude 审核后的用户补充。
- 默认不记录提示词、完整回答、工具参数、媒体数据、Key 或解密信息；错误信息截断且脱敏。
- 管理统计与其他任务重叠时，由统一集成合并新增字段并执行管理契约回归；不能直接覆盖正在修改的管理文件。

## 10. 实施拆分与验证门槛

| 阶段                   | 主要文件 / 工作                                                                    | 完成条件                                                |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| P0-A                   | 新增三类 GenerationInputAdapter / GenerationResultGuard；调整 FormatConverter 接口 | 拆合包不变性；输出/结束分类准确；原生及兼容转换共享事件 |
| P0-B                   | RequestHandler 各分支接入统一 attempt/writer/finalizer；移除门控前心跳             | 四协议 × 三种模式不再空成功；错误前后 HTTP / 终态正确   |
| P0-C                   | UsageStatsService、管理契约/展示兼容新分类                                         | wireStatus 与语义分离；旧记录可读；统计可对账           |
| P1-A（统一发布前完成） | 重试总预算、attempt 隔离、工具风险与取消屏障                                       | 至多一次安全空重试；无重复交付/工具执行                 |
| P1-B（统一发布前完成） | MessageQueue / ConnectionRegistry / 浏览器读取与发送 / ConfigLoader                | 超时真正可中断；端到端有界缓冲、慢客户端和取消无泄漏    |

P1 是实现顺序，不是可跳过的上线保护。共享工具可先合并，只有所有生产入口接入并通过下列门槛才视为完成。

必要测试：

1. SSE 同一事件每个字节/字符位置拆分、随机拆合、多个事件同块、CR/LF/CRLF、BOM、注释、多行 data、中文/emoji UTF-8 跨块及无效 UTF-8；结果与单块输入相同。
2. 四协议 × 真实流/伪流/非流：零字节、空 candidates、空 STOP、空白、usage-only、thought-only、MAX_TOKENS 有/无内容、拦截/拒绝、未知 finish、完整 JSON 错误、EOF 残片、缺终止。
3. 正常文本、客户端工具调用（空参数合法）、流式工具参数、媒体、thoughtSignature、grounding、多候选、终止后 usage、重复/冲突终止、终止后的额外内容。
4. localhost 真实 HTTP 验证首内容前无 headers/body/heartbeat；空结果返回非 200；首内容后真实流错误保留 200 并仅一个错误终态；绝不追加假成功终态。
5. 有正文但 MAX_TOKENS 的合法协议截断与传输错误区分；blocked 可以 200 但不计 success；embedding/countTokens 等不受影响。
6. maxRetries=1/2/3；空→成功、429→空→成功、空→空、thought-only→成功；跨原因共享次数/期限；blocked/MAX/工具风险/客户端断开/已输出不重试。
7. 旧 attempt 迟到 chunk/STREAM_END/取消/错误；新 attempt 不受污染；两次同账号 attempt 统计按 ID 区分；取消确认缺失时不并行重放。
8. 无数据停滞、无限 heartbeats/thought、缓慢碎片、等待账号、重试退避、持续输出超过 300 秒、慢客户端 drain；可控时钟验证真实计时器，避免耗时睡眠。
9. 单请求/并发全局资源边界、大媒体/单事件、浏览器 fullBody/socket 积压、HTTP 慢读、取消与超限竞争；配额归零，队列/定时器/监听器释放，其他 WS 请求不受阻。
10. 上游完成但下游失败、error 与 EOF 同时到达、重复 close；attempt 与 delivery 结算恰好一次；旧统计记录加载和管理 API 契约回归。
11. SSE/JSON 数组/完整 JSON 相同语义的判定一致；数组括号/逗号、转义及字符串内括号、尾随垃圾；原生无 alt=sse 成功原文保持，数组流中错误必须读取/解析失败。
12. 取消 ack 缺失/重复/迟到/错误账号；空重试收到 STREAM_END 后不等 ack；故意漏结算生成分支得到 unclassified_outcome；上游 WS 中断不误记客户端 aborted。
13. 开流前 502 JSON 无残留压缩/长度/SSE 头；提交前断开 wireStatus=null；经过生产中间件栈验证。
14. finish/block 枚举×协议×开流前后，混合候选、未知 part、服务端工具活动；新旧浏览器/服务端协议组合；大响应和普通请求共享同一 WS 隔离；上传/非生成仍兼容。
15. 新版本写入→旧版本读取、旧记录→新版本读取、schemaVersion/兼容计数/细分计数对账；客户端 SDK 自身重试次数另外核对，不能将服务端 maxRetries 误当端到端总调用上限。可用 x-should-retry:false 作为经过目标 SDK fixture 验证后的提示，但不依赖它保证无重复执行。
16. 原生伪流单 JSON 输入到下游 SSE/数组的正确适配；数组流本地主动 destroy 保留原始失败分类；ack 在账号切换/队列移除之后到达或先于 waiter；未投递与交付不明的发送失败；缺 Content-Type 与 capabilities 混合路由。

测试以离线伪上游、fake browser/WS 和真实 localhost HTTP 为主；新增生产模型调用不作为默认验证步骤。现有 routing、stream-integrity、quota、upstream-improvements 及被影响管理测试需通过，避免空结果分类改变账号调度。

## 11. 发布与验收

1. 在另一项管理变更完成后核对合并基线，统一代码审查、回归、提交及推送；推送前确认是否会触发自动部署，遵循用户统一上线安排。
2. 发布前核对首响应超时、缓冲预算与部署内存、客户端对流内错误/blocked/length 的兼容性。部署配置与版本摘要一并记录。
3. 有控制地验证非流/真实流/伪流及四协议，记录脱敏请求摘要；上线模型调用数量和部署动作按当前授权另行执行。
4. 验收指标：空/非法结果假成功为 0（已覆盖输入）；解析结果不随分片方式改变；无错误后成功终态；安全重试不超预算；无已交付请求重放；错误与取消无资源泄漏；历史管理数据仍可读取。
5. 线上观察首有效输出延迟、aborted/empty/incomplete/blocked 分布、重试挽回率、队列/预算峰值。若客户端/网关等待不足，先处理明确的兼容限制，不以伪造正文或提前无条件 200 降低错误率。
6. 回退以本次生成改动的独立提交/功能开关为单位，保留其他已合并管理变更，并同步处理浏览器脚本版本。资源保护与日志可独立保留；旧版本按兼容 outcome 显示新记录并忽略细分类别。回退门控前必须明确旧行为会再次允许空 200，不宣称问题已经解决。

## 12. Claude 审核记录

实际模型：claude-opus-5-5。第一轮“需修改后可实施”，2 项 P0、7 项 P1；v3.1 已对应修订。第二轮结论为“可实施（仅指方案层面）”，确认全部关闭、无新增 P0/P1。v3.2 按复审建议补齐 10 项 P2 实施细节；Claude 明确这些细节不要求再次送审。另明确原生伪流输入/输出格式分离及主动 destroy 不误记用户取消。

详见 [Claude 审核记录](./empty-response-stream-claude-review.zh-CN.md)。审核通过不等于实现完成，§10 测试和 §11 发布门槛仍必须落实。
