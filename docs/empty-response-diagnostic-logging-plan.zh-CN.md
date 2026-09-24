# 空回复、流中断及超时的日志增强设计

日期：2026-09-24。状态：核心诊断随完整流处理实施并参加 Claude 代码审核，未部署。下文是设计目标；当前字段、实际边界与验证结果见[实施记录](./empty-response-implementation-2026-09-24.zh-CN.md)。关联：[流优化方案](./empty-response-stream-optimization-plan.zh-CN.md)。

## 0. 用户确认的输出约束

**本文件新增的所有详细诊断输出仅在 `LOG_LEVEL=DEBUG`（或现有运行时日志级别已切换为 DEBUG）时启用。正常标准模式不输出。** 这项门控高于后文的 INFO/WARN/ERROR 事件严重级别：诊断事件即使分类为 ERROR，也必须先通过 DEBUG 开关，不能通过 logger.error 绕过。

- 门控覆盖服务端 stdout/stderr、管理界面日志缓存/导出、浏览器 console/DOM，以及浏览器诊断摘要上报；标准模式不把这些事件发送给其他日志出口。
- 现有基础运行日志遵循现有策略；本次新增长摘要不混入基础错误消息。业务空回复校验、稳定错误码、超时/资源保护、attempt_closed 及正常统计不依赖 DEBUG，标准模式同样有效。
- 在门控判断后才构造诊断字段与序列化内容。仅供诊断的事件环、计时器、详细计数和浏览器日志 DOM 在标准模式不分配；业务必要的状态/计数照常维护。
- 请求开始时记录是否启用诊断；已在运行的普通请求不追溯补采。运行中关闭 DEBUG 后，立即停止新诊断输出，清理诊断 progress 定时器和事件环。运行中开启 DEBUG 时，对之后新请求启用，保证记录完整。
- 服务端是最终输出门控；浏览器收到本 attempt 的诊断标记且本地级别允许时才生成诊断摘要，服务端切回标准模式后拒绝写出迟到的诊断事件。现有浏览器脚本若只在注入时读取级别，需在实施中补充运行时关闭同步，不能依赖重新加载才停止浏览器 console/DOM 输出。

## 1. 当前缺口

- LoggingService 当前只接收 message 字符串，console 与管理界面内存日志共用格式；直接调用 info(message, fields) 会丢失额外字段。
- 日志内存环最多 1000 条，界面默认 100 条，不是持久化历史。并发逐 chunk 日志会快速挤掉事故前的信息。
- RequestHandler 收到 STREAM_END 就打印 Response completed，未区分传输结束、内容有效、协议完成和下游写出。
- 原生 DEBUG 日志包含完整请求/响应/chunk；它们不能替代计数与事件边界证据。
- 部分浏览器开始/结束日志没有 requestId/attemptId。现有 request_attempt_id 可沿用，不必新建另一套不兼容标识。
- 浏览器 Logger 每条消息都会追加 DOM 元素；高频诊断日志会增加页面负担，必须限制展示条数。
- LoggingService 环境变量初始化当前只有 DEBUG / 非 DEBUG 两档；info/warn/error 没有统一阈值检查。若增强可配置级别，应统一过滤语义，而非假设 WARN 已能关闭 INFO。

## 2. 输出结构与关联

新增 `logger.diagnostic(level, event, fieldsFactory)`，先检查当前 DEBUG 门控和该请求诊断资格，再调用惰性 fieldsFactory 构造字段并输出单行 JSON；保留旧字符串 API 给既有管理/运维日志。输出模式为拟议配置（尚不存在）：DIAGNOSTIC_LOG_FORMAT=json|text，该格式配置不能独立打开诊断。JSON 模式的 console 不再附非 JSON 前缀；管理界面从同一结构化对象生成可读摘要，不二次输出一份重复日志。

建议调用形态（拟议接口，尚未实现）：`logger.diagnostic("WARN", "generation.attempt_finished", () => summary)`。标准模式直接返回，不调用 fieldsFactory、不进入 logBuffer、不写任何输出流。

固定公共字段：

| 字段                                         | 规则                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| schemaVersion / ts / level / event           | 固定 schema；ts 使用 UTC ISO 时间；一事件一行                                              |
| requestId / attemptId / attemptNo            | 服务端生成；每次重试独立 attemptId，requestId 保持不变                                     |
| instanceId / bootId / buildCommit            | 多副本、进程重启和版本关联；字段不可用填 null                                              |
| browserConnectionId / browserProtocolVersion | 区分页面重建和旧脚本                                                                       |
| accountRef / authIndex                       | 使用已有稳定内部账号标识（如可用）；索引只作当次定位，不能当永久账号身份；不记录邮箱或凭证 |
| apiFormat / mode / upstreamFormat / model    | gemini/openai/responses/claude；real/fake/nonstream；sse/json_array/json                   |
| stage / elapsedMs                            | 当前阶段；同进程使用单调时钟计算耗时                                                       |

浏览器测量 fetch/读取耗时使用自己的单调时钟，并以 browserTimingsMs 单独上报。服务端耗时独立记录；不能直接相减浏览器与服务器墙钟来推导网络延迟。

可在响应中暴露服务端 request ID，方便用户报告问题。外部传入的关联 ID 单独保存为长度受限的 clientRequestId，不覆盖内部 ID，不把任意原始头当作日志字段。

字段白名单、字符串长度限制和 JSON 序列化统一处理；禁止把任意 request/response/error 对象直接展开到日志。语义尚未观测到时填 null/unknown，并记录 observationComplete=false；绝不能把未知误填为 0 或 success。

## 3. 应记录哪些事件

| 事件                                         | 触发点                             | 最低字段                                                                                                 |
| -------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| generation.request_started                   | 接收生成请求                       | 请求关联、模式、模型、有效参数摘要、超时/预算配置版本                                                    |
| generation.attempt_started                   | 为该 attempt 分配路由并准备发送    | attemptNo、账号、连接、dispatchState                                                                     |
| generation.upstream_headers                  | 浏览器 fetch 收到头并传回          | upstreamStatus、Content-Type、upstreamHeadersMs                                                          |
| generation.first_effective_output            | Guard 首次确认目标协议可交付内容   | contentKind、candidateIndex、firstEffectiveMs、bufferedBytes                                             |
| generation.response_committed                | writer 首次提交响应                | wireStatus、commitTrigger、firstWriteKind、headersSent                                                   |
| generation.retry_decision                    | 决定重试或拒绝重试                 | errorCode、eligible、denyReason、attemptsUsed、emptyRetriesUsed、remainingDeadlineMs、toolRisk、ackState |
| generation.cancel_requested / attempt_closed | 请求取消及浏览器确认               | cancelCause、sendState、ackState、ackWaitMs；未收到不能写 confirmed                                      |
| generation.progress                          | 长时间等待/慢流                    | stage、idleMs、计数摘要、queueBytes、lastEventType                                                       |
| generation.attempt_finished                  | 每次尝试结算一次                   | 完整上游/解析/转换摘要、resultClass、errorCode、终止证据                                                 |
| generation.request_finished                  | 请求本地发送完成、失败或中断时一次 | 最终 attempt、wireStatus、deliveryOutcome、attemptCount、总耗时、错误摘要                                |

仅在 DEBUG 已启用时，以上事件按内容附带严重级别：正常关键事件为 INFO，empty/incomplete/blocked/客户端提前断开与重试决定通常 WARN，解析缺陷/内部不变量/资源耗尽为 ERROR；blocked 不等同系统故障。该严重级别用于筛选和阅读，不影响 DEBUG 总门控；event/errorCode 保持稳定。

仅对启用 DEBUG 诊断的请求，在超过 30 秒且仍未完成时发低频 progress（每请求最多每 30 秒一次）；终局或关闭 DEBUG 时清除定时器。记录的是服务端日志，不能为诊断往客户端额外发心跳或提交响应头。

## 4. 每个 attempt 的核心摘要

### 状态与终止证据

- upstreamStatus、wireStatus、resultClass、errorCode、failureOrigin、failureStage。
- finishReasonsByCandidate、blockReason、terminalSeen、eofSeen、parserFinishOk、terminalSent、outputStarted。
- failureOrigin 枚举：upstream_http、upstream_content、browser_fetch、ws_transport、parser、converter、resource_guard、downstream、internal。
- closeCause 区分客户端断开、上游 WS 断开、账号切换、代理主动 destroy、超时及资源保护。
- wireStatus 仅在 headersSent=true 时取实际 res.statusCode，否则为 null；semanticErrorStatus 可单列，但不能覆盖实际 wireStatus。

### 内容与转换摘要

- candidateCount；每候选 ordinaryTextNonWhitespaceChars、thoughtChars、validToolCalls、mediaParts。
- upstreamEffectivePartCount、convertedEffectivePartCount、unknownPartCount、unsupportedPartCount。
- 按调用 ID/index 去重后计工具数；流式参数碎片不是多个工具；签名/usage 不计有效答案。
- maxOutputTokens、thinkingBudget/thinkingLevel/includeThoughts、requestedModalities 等已生效的白名单配置摘要；同时记录上游 usage 中 candidatesTokenCount/thoughtsTokenCount 等（缺失为 null）。不记录原始 prompt 或工具参数。

### 传输、队列与写出

- browserReadBytes：fetch reader 返回的 Uint8Array 字节数；是浏览器解压后的 body，不是 TLS 或压缩包大小。
- browserDataUtf8Bytes / serverDataUtf8Bytes：同一规范化 data 字符串的 UTF-8 长度（不含 WS JSON envelope）；允许在边界口径一致且摘要齐全时比较。
- browserReadChunks、browserWsChunks、serverWsChunks、sseEventCount（或 jsonElementCount）。网络 chunk 数与拆分后的 WS chunk 数不可直接要求相等。
- chunkSeq / lastSeq / droppedStaleMessages：序号仅在同 attempt 内递增；WS 保序可靠，异常通常来自进程/路由/应用丢弃，不能把序号异常直接叫网络丢包。
- decodedBytes、parserResidualBytes、parseErrorCount、queuePeakBytes、bufferPeakBytes、wsBufferedPeakBytes。
- downstreamBodyBytesWritten、downstreamEffectivePartsWritten、writeBackpressureCount、drainWaitMs。
- res.write 返回 false 代表已接受数据但需要等待 drain，不是写失败；该数据只计一次。以上都是本地写出证据，不证明客户端已收到、解析或展示。

### 时间

routeWaitMs、upstreamHeadersMs、firstUpstreamByteMs、firstParsedEventMs、firstEffectiveMs、responseCommitMs、lastUpstreamActivityAgeMs、totalMs、timeoutSource、configuredTimeoutMs。

没有发生的时点记 null。各阶段起点在 schema 固定；请求级与 attempt 级耗时不能混用。代理只能确认下游连接何时关闭，不能仅凭 25/31 秒时长区分用户取消、客户端超时或网关超时。

## 5. 异常前的少量事件摘要

仅为启用 DEBUG 诊断的 attempt 内存保存最近 16 条结构化事件摘要，最多 8 KiB；异常时且 DEBUG 仍开启才随 attempt_finished 输出（超过单条上限则拆为带相同 ID 的诊断事件）。建议单条日志上限 16 KiB。标准模式不分配该事件环，关闭 DEBUG 立即释放。

记录示例：`seq=8, eventKind=candidate, partKinds=[thought], finishReason=null, rawBytes=214`。禁止保存 raw data、文本片段、签名、工具参数和媒体数据；解析错误记录序号、偏移、长度、parser 状态、稳定错误类别，不把 JSON.parse 原始异常中可能附带的输入片段直接打出。

平时不逐 token/逐 chunk 打 INFO。诊断摘要采用有界缓存，不能成为新的无界缓冲。

## 6. 怎样从日志定位

| 观察到的证据                                                 | 分类 / 下一步                                                                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 上游 200；普通文本/工具/媒体都为 0；干净 EOF                 | 上游空结果；结合 STOP/usage/thought 区分 empty/thought_only；按安全条件决定重试                                |
| 上游有效部分 >0；目标协议可交付部分为 0                      | converter / unsupported_output；查对应 part 类型和转换器，无需先怀疑模型没生成                                 |
| parserFinishOk=false；残片 >0                                | 不完整输入；结合浏览器 EOF、WS、取消及序号定位断在哪一层                                                       |
| 正文 >0；没有终止事件；连接或读取失败                        | incomplete_stream / transport_error；不应正常 DONE                                                             |
| 只有 thought；MAX_TOKENS；输出预算耗尽                       | output_budget_exhausted；检查实际预算/usage，不能只调重试次数                                                  |
| SAFETY 或明确 prompt blockReason                             | blocked；保留原因，不记空成功，不自动绕过拒绝                                                                  |
| firstEffectiveMs=null；downstream close；阶段 waiting_output | 有效回答前下游断开；进一步对照网关访问日志或客户端超时设置                                                     |
| wireStatus=200；resultClass=error/incomplete                 | 已开流后的失败，实际 HTTP 无法追改；检查 terminalSent 和客户端错误处理                                         |
| 写出有内容、协议完成、res.finish；用户仍报告空白             | 服务端已完成本地交付；进一步核对客户端支持的 content/reasoning/tool/media 和渲染逻辑，不能直接断言是客户端 bug |
| serverDataUtf8Bytes 与浏览器摘要不符                         | 先核对摘要完整性、计数口径、取消和 stale 丢弃，再定位路由；不是仅凭不相等认定链路丢包                          |

### 示例：有正文被转换丢弃（假设数据，非历史日志）

```json
{
  "schemaVersion": 1,
  "level": "ERROR",
  "event": "generation.attempt_finished",
  "requestId": "req_demo",
  "attemptId": "req_demo:1",
  "apiFormat": "openai",
  "mode": "real",
  "upstreamStatus": 200,
  "wireStatus": null,
  "resultClass": "error",
  "errorCode": "unsupported_output",
  "failureOrigin": "converter",
  "upstreamEffectivePartCount": 2,
  "convertedEffectivePartCount": 0,
  "terminalSeen": true,
  "eofSeen": true,
  "parserFinishOk": true,
  "finishReasonsByCandidate": { "0": "STOP" },
  "observationComplete": true
}
```

随后 request_finished 记录最终错误响应的 wireStatus=502（若成功发出）。attempt_finished 时尚未提交，wireStatus=null 是合法的时间点差异。

## 7. 日志性能、保存及查询

- 日志异常不得改变响应/重试结果；序列化采用白名单，处理循环对象/超长字符串，不在最终清理中抛错。
- DEBUG 诊断已启用且未在中途关闭时，请求/attempt 终局尽力全量输出，不做终局随机采样；可采样的是更细的阶段信息。标准模式不输出这些诊断终局。进程崩溃、stdout 故障、日志队列过载仍可能缺失，因此不能宣称物理上绝对不丢日志。
- 日志输出队列有界，积压时优先丢 DEBUG/progress，保留终局专用容量并输出 logsDropped 计数；超过极限也必须计数而非无限占内存。浏览器日志 DOM 限制条数；高频摘要不写 DOM。
- stdout JSON 由部署平台收集；管理界面的 100/1000 条环形记录仅供实时查看。发布前验证实际平台保留周期和导出能力，不能把内存日志当作事故档案。
- 按 requestId 查询整次请求，按 attemptId 查询重试；buildCommit/bootId 定位运行版本。指标标签仅使用有限 apiFormat/mode/resultClass/errorCode，不把 requestId 作为指标标签。
- 仅在启动时处于 DEBUG 或运行时开启 DEBUG 时记录白名单诊断配置快照，说明实际生效的超时、缓冲、日志级别和脚本协议版本。环境变量全量转储不允许。
- 原有完整 body/chunk DEBUG 改为形状与计数摘要；若未来确有需要抓取正文，应另做明确的限时定向诊断设计，本次默认不收集。

## 8. 与“25% 验证超时”分开追踪

管理验证链路复用同一 DEBUG 门控日志封装，独立使用 taskId、verificationAttemptId、accountRef、stage、stageStartedAt、elapsedMs、deadlineRemainingMs、queueWaitMs、browserReady、wsReady、cancelCause、errorCode。标准模式也不输出这些新增阶段诊断。

记录每次实际阶段切换（排队、浏览器准备、WS 就绪、探测、保存验证结果等，以当前任务状态机为准），进度百分比只作展示字段。25% 不是错误原因，需要看该阶段的开始/结束、超时来源及取消状态。该补充与正在执行的管理变更合并时核对实际 stage 名称，不重写对方流程。

## 9. 实施顺序与验收

1. 基础关联与传输日志：LoggingService、RequestHandler、ConnectionRegistry、MessageQueue、浏览器脚本。可以先准备，并随统一版本发布；此时未接 Guard 的语义字段明确为 unknown。
2. 完整语义日志随共享 InputAdapter / Guard / Writer 落地；复用同一解析结果，不额外添加另一套按 chunk JSON.parse 的“日志专用解析器”。
3. attempt/request finalizer 和 UsageStatsService 使用同一结果快照，日志与管理统计一致；两者独立发送故障不能影响业务结算。
4. 用本地合成输入验证空 EOF、分片/合包、thought-only、过滤、MAX_TOKENS、工具/媒体、浏览器断开、客户端断开、重复 EOF/close、重试旧消息、慢客户端；要求仅凭日志可以区分它们。
5. 对全程 DEBUG 的请求断言一 attempt 一条诊断终局、一请求一条诊断终局，重复 finally 不重复计数；kill 进程等不可结算场景用缺少终局检测而非伪造完成。关闭 DEBUG 后没有诊断终局是预期行为，不误报业务漏结算。
6. 注入模拟敏感字符串、异常 JSON、多字节字符、超长错误和日志输出故障，验证无正文/Key 泄露、输出仍为单行 JSON、缓存有界、业务不受日志异常影响。
7. 统一上线后以新摘要定位真实请求；历史缺失字段无法补回。本设计增强诊断能力，不单独修复空回复和超时。
8. 日志门控回归：标准模式下所有诊断事件（含 WARN/ERROR）在 stdout/stderr、UI 缓存、浏览器 console/DOM 和诊断上报均为 0；fieldsFactory 未被调用，无诊断定时器/事件环。DEBUG 模式可按 ID 串联；运行中关闭立即停止并释放；重新开启仅新请求采集。两种模式的响应、校验结果和业务统计一致。
