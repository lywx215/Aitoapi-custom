# DIAG-03 交付记录：待审核

此页保留初次提交 `827a37bd463d258663d31d60e0802a356197677c` 的实现和验证台账。R1 修订后的准确行为、意见处置及新增测试以 [DIAG-03-R1-disposition.zh-CN.md](DIAG-03-R1-disposition.zh-CN.md) 为准；下方双实例启动方式仍适用。

项目：Aitoapi-custom。worktree：`C:/Users/lywx2/.codex/worktrees/ca98/Aitoapi-custom`。分支：`codex/diag-03-aito-diagnostics`。基线：`daeab836eb194d4ff402bc3d645baeba4ccdc96f`。最终提交的完整 SHA 由本次交付消息提供（避免文档自引用提交哈希）。

冻结契约来源为只读 CLIProxyAPI worktree 的 `bb291667f7b6bd7a1dab6f9b7f906b5871d1306c`，制品 `1.0.0-rc.1`，schema `ai-proxy-diagnostics/1`。`SHA256SUMS` 原始字节 SHA-256：`ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4`。详见 [contract-source.json](contract-source.json)。72 个清单文件及清单本身逐字节纳入；LF 属性和格式化忽略规则防止改写。Python 仅用于离线 QA；服务运行时不导入契约 oracle 或其他仓库。

## 实现与接入点

| 文件                                                               | 接入点与目的                                                                                                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/diagnostics/Headers.js`、`Peers.js`、`Resource.js`            | 保留 Node rawHeaders 多值；严格解析 traceparent/tracestate/自定义 ID；配置 peer 的 origin/path 边界和重复配置校验；独立 instance/boot 身份。                                |
| `src/diagnostics/Diagnostics.js`、`Projection.js`、`Conversion.js` | WeakMap holder；每个 server/call 独立 span 与 logSeq；既有 attempt 结果的数值/枚举投影；单调时钟；入队前 JSON 快照；4096 字节上限；DEBUG/基础访问日志独立门控和完整性终局。 |
| `src/diagnostics/HttpBoundary.js`                                  | 显式单次 native ClientRequest 适配器，按最终已规范化请求参数判断 peer，维护本模块追踪头拥有权。真实 loopback HTTP 验证；目前没有生产调用方，不宣称生产 HTTP 出站覆盖。      |
| `src/core/ProxyServerSystem.js`                                    | Express 顶部入口、原鉴权成功观察点、关闭订阅。保留原鉴权结果；响应提交时覆盖本地 X-Diag IDs，不提前提交响应。                                                               |
| `src/core/RequestHandler.js`                                       | 绑定原有 requestId，自动头复制源过滤，实际 `_forwardRequest` 派发建立 call。holder 不写入 proxyRequest；不扩展 WS 协议。                                                    |
| `src/core/ConnectionRegistry.js`                                   | 在现有校验之后只读观察派发对应 socket/auth/request/attempt 回报；EOF、错误、有效 ACK、断连结算 call。旧连接/迟到回报不能向终局 span 追加。                                  |
| `src/core/GenerationPipeline.js`                                   | 原 guard/attempt 完成点观察结果、已解析输出分类和新单调时钟；不改 guard 判定、重试或队列策略。                                                                              |
| `src/core/GenerationResponseWriter.js`、`FormatConverter.js`       | 在原最终 usage 对象构造处观察四种协议的实际数值，区分上游和转换后 usage；保持原返回值和流发送路径。                                                                         |
| `src/utils/LoggingService.js`                                      | 复用有界队列，公共记录序列化后入队；DEBUG 清空保留基础终局；公共 sink 丢弃计数独立；不加入管理日志缓存、不改既有 seq/schema/deliveryOutcome。                               |
| `scripts/diagnostics/*`、`scripts/tests/diagnostics*.test.js`      | 隔离真实服务端流程、合成浏览器 WS 回报、契约字节及真实公共记录验证、并发和重启测试。                                                                                        |
| `.env.example`、`package.json`、忽略和属性文件                     | 声明配置和命令、保护冻结字节；无依赖或应用版本变更。package.json 按现有 ESLint 规则统一为四空格。                                                                           |

公共日志前缀为 `@diag `，一条 JSON 一行。基础 `diag.process/diag.server/diag.call` 默认随 `ACCESS_LOG_ENABLED=true`；细节随既有 `LOG_LEVEL=DEBUG`。动态关闭 DEBUG 后不继续捕获旧请求细节，重新打开不补造历史。进程配置更新有 configRevision；配置无效则整组 peers 失效。公共 usage 白名单只保留数值，缺失不是零；Gemini totalTokenCount 不当作输出总量，OpenAI completion/output 包含 reasoning 时不再相加。

## 出站头写入/复制清单

| 文件/函数                                                                                                                              | 参数来源与目标                                                                         | 最终顺序、重定向与覆盖                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RequestHandler.processOpenAIEmbeddingsRequest`、`processUploadRequest`、`_buildProxyRequest`（三个 `copiedObject(req.headers)` 调用） | 自动复制入站 req.headers 到浏览器 proxyRequest，目标为原 embedding/上传/通用代理地址。 | 在复制源去掉 traceparent/tracestate/X-Diag-*，其他业务头保留；原浏览器 `_sanitizeHeaders` 后 fetch。无可靠浏览器最终跳拥有权，不向浏览器注入公共追踪头。                                                                                                                             |
| RequestHandler 的 OpenAI/Claude/Responses 等显式构造路径                                                                               | 原代码显式构造 Content-Type 等业务头，没有自动入站追踪头复制。                         | 原构造能力保留；不因公共白名单删除显式业务头。                                                                                                                                                                                                                                       |
| `scripts/client/build.js` 的 `_buildRequestConfig` / `_sanitizeHeaders` / fetch                                                        | 消费既有 WS 请求、复制调用者提供的字段，删除原有传输/浏览器受控字段。                  | 未改浏览器脚本和 WS 协议；浏览器 fetch 内部重定向不可观察。call 仅表示服务端实际派发到浏览器，不声称浏览器 HTTP 子 span。                                                                                                                                                            |
| `RequestHandler._setResponseHeaders`                                                                                                   | 原浏览器响应头复制到本地响应。                                                         | Express 响应提交 wrapper 最后删除全部上游 X-Diag-*，写入本地 request/trace 两个 ID；未配置 peer 的浏览器响应 ID 不采集。                                                                                                                                                             |
| `FormatConverter.translateOpenAIToGoogle` / `translateClaudeToGoogle` / `translateOpenAIResponseToGoogle`                              | 三处 axios 远程图片下载，显式 `responseType: arraybuffer`，没有入站头复制。            | 未注入、未改 axios 默认重定向；最终跳无可靠追踪拥有权，列为未覆盖。                                                                                                                                                                                                                  |
| `VersionChecker` 的 axios head/get                                                                                                     | 后台版本/发布内容查询，显式版本查询或 GitHub 业务头。                                  | 无自动入站复制；未改写，未观测出站 span。                                                                                                                                                                                                                                            |
| `BrowserManager` 的页面 fetch ActiveTrigger                                                                                            | 浏览器后台保活请求。                                                                   | 没有请求级关联；未改写或注入。                                                                                                                                                                                                                                                       |
| `ProxyServerSystem` VNC upgrade                                                                                                        | localhost:6080 原显式 WebSocket 握手字段，不自动复制标准追踪头。                       | 未改写；upgrade 不经过 Express 中间件，不声明此入口覆盖。                                                                                                                                                                                                                            |
| 新 `HttpBoundary.request` / `redirectCopy`（仅隔离测试调用）                                                                           | 调用者提供已规范化的 native request 参数。                                             | 每次发送前按实际 origin/escaped path 重检；peer 替换标准追踪头并标记拥有权；下一跳先清模块拥有头，再允许新业务头构造，再重检。真实本地网络覆盖 peer→peer、peer→同源未允许路径、peer→不同 origin，以及清理后的新显式 traceparent。适配器本身不增加请求、重定向、重试、超时或读 body。 |

## 测试与结果

本机 Node v24.19.0；Python 3.12.10。npm 不在 PATH，实际用 `node tmp/npm/package/bin/npm-cli.js` 执行下列 npm 命令，包版本 10.9.2，仅位于忽略的 tmp 内。`npm ci --ignore-scripts --no-audit --no-fund` 退出 0；无 lockfile 修改。离线 Python 虚拟环境为 `tmp/diag-venv`，安装冻结 requirements。以下命令均在本 worktree 执行。

| 命令                                                                                                                                                                                                           | 结果 / 退出码                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:diagnostics`                                                                                                                                                                                     | 0：162 条直接针对 Node 运行时代码的共享向量；真实 HTTP 入口头/鉴权/错误/关闭访问日志；82 组运行时生命周期；双实例、重启和 12 次真实协议回复。 |
| `npm run test:generation`                                                                                                                                                                                      | 0：107 个 pipeline 场景、18 个 safety 分组。                                                                                                  |
| `npm run test:stream-integrity`                                                                                                                                                                                | 0。                                                                                                                                           |
| `npm run test:routing`                                                                                                                                                                                         | 0。                                                                                                                                           |
| `npm run test:management`                                                                                                                                                                                      | 0：完整管理回归及其路由、统计、验证、ACK、模型探测等依赖回归。原 LIVE-01 真实账号门槛跳过；不以合成测试替代真实账号认证结论。                 |
| `tmp/diag-venv/Scripts/python.exe contracts/diagnostics/v1/validate.py`                                                                                                                                        | 0：3 schema、53 fixture、9 example 行、242 个冻结向量。oracle 通过与运行时代码覆盖分开报告。                                                  |
| `tmp/diag-venv/Scripts/python.exe scripts/diagnostics/validateRecords.py tmp/diagnostics-runtime.jsonl tmp/diagnostics-ingress.jsonl tmp/diagnostics-processes.jsonl docs/diagnostics/synthetic-runtime.jsonl` | 0：364 + 5 + 51 + 5 条真实产生的公共记录，schema、跨字段语义及含前缀/LF 的 4096 字节限制。                                                    |
| `node scripts/diagnostics/verifyContract.js --index`                                                                                                                                                           | 0：72 个冻结文件以及清单本身，工作区和 Git 暂存字节一致。                                                                                     |
| `node node_modules/eslint/bin/eslint.js <全部变更 JS 与 package.json、contract-source.json>`                                                                                                                   | 0。                                                                                                                                           |
| `node node_modules/prettier/bin/prettier.cjs --check <全部变更 JS、JSON、交付文档>`                                                                                                                            | 0；冻结契约通过忽略规则排除，不改原字节。                                                                                                     |
| `git diff --check` / `git diff --cached --check`                                                                                                                                                               | 0。                                                                                                                                           |

初次多进程测试因合成驱动的短超时出现 504，已仅调大隔离驱动超时后重跑通过。生产超时没有变化。最终日志保留在忽略的 `tmp/*-final.log`；公共全量 JSONL 在上述 tmp 文件中。

运行时覆盖四种协议（Gemini、OpenAI Chat、OpenAI Responses、Claude）的真流、非流及伪流 usage；空、拦截、截断、思考、工具、缺失和显式零值；首轮空结果重试、并发同 caller ID、断连/取消、迟到 ACK、重连、动态 DEBUG、队列饱和/DEBUG 清空/截断、基础终局保留、worker/重启 boot 隔离。双边图冲突、缺父节点、离线证据闭环归属于 reader；本任务只消费冻结 oracle，不实现离线图判定器。

## DIAG-07 隔离启动

普通已安装 Node/npm 的环境先 `npm ci --ignore-scripts`。在本仓库开两个 PowerShell，分别设置不同 instance 和 port（端口仅为示例；默认 0 自动分配）。

```powershell
$env:DIAG_ENVIRONMENT='test'
$env:DIAG_DEPLOYMENT_ID='diag07-local'
$env:DIAG_INSTANCE_ID='aito-fixture-a' # 第二实例改为 aito-fixture-b
$env:DIAG_FIXTURE_PORT='18131' # 第二实例改为 18132，或都用 0
$env:LOG_LEVEL='DEBUG'
$env:ACCESS_LOG_ENABLED='true'
node scripts/diagnostics/isolatedServer.js
```

只监听 `127.0.0.1`；启动后 readiness JSON 给出实际 address 与临时 output 目录。每个实例的 `@diag` stdout 与临时 `diagnostics.jsonl` 应分别收集。示例请求：

```powershell
$body = @{model='diag-usage87'; messages=@(@{role='user'; content='synthetic'}); stream=$false} | ConvertTo-Json -Depth 6
Invoke-WebRequest http://127.0.0.1:18131/v1/chat/completions -Method Post -ContentType 'application/json' -Body $body
```

还可使用模型 `diag-empty`、`diag-blocked`、`diag-truncated`、`diag-retry`、`diag-slow`、`diag-thought`、`diag-tool`、`diag-missing`、`diag-zero`，伪流场景使用 `-fake` 后缀并设置 stream=true。原接口 `/v1/responses`、`/v1/messages`、`/v1beta/models/diag-usage87:generateContent` 和 `:streamGenerateContent?alt=sse` 也可用。健康接口 `/fixture/health`。Ctrl+C 关闭；使用同 instance 重启可验证 bootId 变化。

这是原 Express/RequestHandler/Registry/Pipeline/Converter 与真实本地 WS 的隔离驱动；浏览器回报为合成数据。驱动在构造服务前切到独立临时目录；账号索引为合成 0，真实浏览器/账号操作抛错，管理路由为空、驱动模型鉴权旁路，含 HTTP(S) URL 的请求体直接拒绝。统计仅写隔离临时目录。不可把此驱动当作生产启动入口或真实账号验证。

## 样例、缺口与风险

[synthetic-runtime.jsonl](synthetic-runtime.jsonl) 是专项运行输出原样截取的进程启动及一个完整 Gemini 请求（5 行），并非手写 oracle fixture；只有合成 caller/instance/trace/usage，未含正文、模型、URL、密钥、邮箱或原始错误。其重复 caller/trace 为测试故意设置，不用于认证身份。

- 生产 capabilities 只声明 `http_inbound`、`browser_dispatch`、`attempt_result`、`conversion`。不声明浏览器 HTTP、图片下载、版本检查、VNC、normalization 或 throttle 覆盖。未新增浏览器 span 或 WS 字段。
- callerAlias、credentialRef 无可靠非敏感映射，保持 null/unknown；不哈希 API Key。正则路由没有可靠低基数模板时 routeTemplate=null。
- 转换后输出正文/媒体计数仍为 null；实际已构造 usage 单独观察。流式 firstDownstreamEffectiveOutputMs 保持 null，不把普通 write/usage 心跳冒充有效输出。旧 wall-clock/browser 指标留在旧日志和统计。
- 冻结公共 schema 没有 code-execution 专用有效输出分类；仅此类输出的旧业务 success 在公共投影保守为 unknown，业务响应不变。
- 单进程有界队列可丢弃，计数和序号可见；崩溃或外部 stdout 导出丢失无法证明完整。两个进程各自收集成功，不承诺外部多 worker 混写管道具有全局原子性。
- 未使用真实账号、凭证、数据库或 Volume；未调用远程模型/部署 API；未修改其他仓库、浏览器脚本或生产配置；未执行部署、推送、合并、自行 Claude 审核或委派子任务。最终仅本地提交，等待协调方对准确 HEAD 审核。
