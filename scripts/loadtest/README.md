# Aitoapi 生产容量测试

此目录是本地客户端工具，不修改线上生成实现。固定目标为 `https://aib.zeabur.app`，模型为 `gemini-3.8-flash`。实际调用会消耗模型用量并影响线上负载。

## 启动

在 PowerShell 中使用本机 DPAPI helper，密钥只经匿名进程管道进入 Node：

```powershell
./scripts/loadtest/run.ps1 -Action calibrate -OutputDir ./artifacts/loadtest/<运行编号>
./scripts/loadtest/run.ps1 -Action full -OutputDir ./artifacts/loadtest/<运行编号>
```

`full` 将上下文数设为 3 并保留，关闭 DEBUG 完成标准容量测试，复用同一目录的 token 校准与已完成探索档位。不同模型阶段互斥，总请求并发最多 300；连接池预留 330 个连接。每次请求不自动重试，服务端内部重试保持当前配置。

可单独运行一个档位或持续验证：

```powershell
./scripts/loadtest/run.ps1 -Action wave -Profile in50000-out4000 -Concurrency 300 -Mode sse -OutputDir ./artifacts/loadtest/<运行编号>
./scripts/loadtest/run.ps1 -Action sustain -Profile in50000-out4000 -Concurrency 100 -Mode json -OutputDir ./artifacts/loadtest/<运行编号>
./scripts/loadtest/run.ps1 -Action report -OutputDir ./artifacts/loadtest/<运行编号>
./scripts/loadtest/run.ps1 -Action recover -OutputDir ./artifacts/loadtest/<运行编号>
```

`recover` 在安全停止后只读采集 readiness、状态、健康与配置，不发模型请求、不改设置。观察至少 120 秒且末尾至少连续 60 秒正常，最多观察 10 分钟；首次采到正常的时刻不能代替采样空档中的实际恢复时刻。

完整探索使用六种大输入/长输出规格。默认 `-Workload analysis -SuccessMetric response`：按用户最新要求，以完整回复成功率和请求错误为主，不再反复校准精确输出 token。输出是依据合成业务记录生成的英文长篇业务分析；输入保持已 countTokens 校准的大文本规模，响应 usage 仅辅助记录。请求 nonce 放在正文开头；缓存 token 按上游返回值记录。

`-SuccessMetric tokens` 保留原先严格 token 验收模式：输出长度先居中再连续验证三次；思考占满初始 8192 生成预算而导致 MAX_TOKENS 时扩大预算，正文目标仍保持 2k/4k。当前正式分析运行对 4k 档使用 16384 总生成预算，以避免已观察到的思考预算挤占，默认思考行为保持不变。

`-Workload verbatim` 保留长文本复现负载用于传输诊断。两种负载必须使用独立产物目录，复现结果不能替代分析容量结论。

`-Action capacity` 可在六组探索已经完成后继续边界验证，复用同部署、配置、负载下的已完成三波与持续记录。先验证所有已通过探索的档位；低并发失败不能覆盖较高并发的通过证据。每个候选复测三波，均通过后持续验证。较低档位的失败单列为非单调证据，在最高已持续通过档和其上方失败档之间细化到不超过 5 并发。非流式的所有关键候选及已有探索通过档均按同样要求验证。新阶段达到单轮保护上限会明确报告 incomplete，可继续同目录验证，不能据此宣称已完成。

## 并行采集

```powershell
./scripts/loadtest/run.ps1 -Action collect -OutputDir ./artifacts/loadtest/<运行编号>
python -B ./scripts/loadtest/platform.py --output-dir ./artifacts/loadtest/<运行编号> --watch
./scripts/loadtest/client-network.ps1 -OutputDir ./artifacts/loadtest/<运行编号>
```

`collect` 收集最新请求历史，按服务器 requestId 去重，供结果关联最终账号。它不会获得普通管理 API 未提供的 attemptCount。平台采样复用共享 Zeabur 工具认证，不读取服务环境变量或部署/重启。

在产物目录创建 `STOP-COLLECTORS` 可结束请求历史与客户端网络采集。网络统计是系统全部网卡流量，可能包含虚拟/物理接口重叠，不能直接归属测试进程。平台采样支持 Ctrl+C 或 `--duration-seconds`。主压测收到 SIGINT/SIGTERM 时停止新增模型请求并取消在途；readiness 连续失败 60 秒或 uptime 下降也触发停止。

## 计量与验收

- countTokens 使用 `generateContentRequest` 包装，避免现有代理给顶层 contents 追加生成用 safetySettings；完整响应的 `promptTokenCount` 再验证实际输入。
- 默认完整回复成功指标不受 token 数量偏差或缺失 usage 影响。严格模式的 2k 输出档为 2000–2400 正文 token，4k 输出档为 3600–4400；思考 token 单独报告。
- HTTP 200 不足以证明成功：默认 response 指标要求可解析、有效普通正文、STOP、完整 EOF、结束标记及无流内/请求错误。仅 `-SuccessMetric tokens` 额外要求 token 达标。
- 持续合格要求至少 600 秒，完成至少 `max(300,3×并发)` 请求，完整回复成功率≥99%，全部样本耗时 P95≤180 秒，并达到指定客户端已发送在途峰值。空回复、流内错误、截断、异常断流与超时均不能算成功。
- 平台指标、日志、OOM 原因缺失时只报告缺口。客户端已上传峰值不等于上游同时有效生成数。

`debug-wave` 仅用于日志通道已确认可导出的诊断复测，会恢复此前 DEBUG 设置；结果不会提升标准容量结论。

产物含 requests/stages/environment/platform/server-usage/client-network JSONL、summary.csv、environment.csv、inflight.csv、report.md，均在 Git 忽略目录。缺失 token 的覆盖率单独记录；吞吐仅累计实际返回的 usage，不将未知消耗补零。网络错误只记录白名单错误码及发生阶段。工具不保存密钥和授权头。

requests 中存在但 stages 尚无闭合记录的 stageId 单独列为部分样本，CSV 使用 `phase=partial` 保留原阶段类型与 ID。这些样本不进入正常波次的成功率分母或容量证明；恢复同一并发档使用新 stageId。未返回请求的数量、执行情况与最终状态均不作推断。

本地验收：`node --test scripts/tests/loadtest.test.js scripts/tests/loadtestCapacity.test.js`；分析模板纯函数验收：`node scripts/loadtest/workloads.js --self-test`。
