# 本机真实凭证验收

本入口与模拟测试分离，默认不会由 `test:management` 自动调用。它会使用真实 Cookie 打开 Google 页面、在满足身份校验后请求真实模型，必须由账号所有者授权执行。

## 运行

在集成工作区执行：

```powershell
node scripts/tests/managementLive.js --base-url http://127.0.0.1:7860 --manager-root G:\code\gemini30\gemini-manager
```

可显式设置 `--python` 和 `--browser` 为已有运行时的绝对路径，不需要新增持久环境变量。默认使用源项目 `.venv/Scripts/python.exe` 与集成工作区 `camoufox/camoufox.exe`。本轮浏览器固定为仓库版本 `135.0.1-beta.24`，Windows x86_64 官方发布包 SHA-256 为 `7b8dd86d9d26fa71e7d8809e311d16223dc74bff2c7feb2a7e7f8b7e8ccdf206`（本机下载计算；发布方没有提供 API digest，不宣称已验证独立发布签名）。

默认单项等待10分钟。已知阻塞的补充诊断可使用 `--task-timeout-ms 60000`（允许30000至600000），届时通过真实取消接口合作式终止并保留逐项结果；不改变服务验证器默认值，更不降低成功标准。

本机 `7860/9998` 必须空闲。入口不会停止占用端口的其他程序。每次在 `data/management-live/run-*` 建立自己的临时实例，不写原工作区、源端数据库或配置，也不访问源项目配置中的线上 Aitoapi 地址。

## 凭证和请求边界

- 从源项目 `runtime/devices` 的 `auth-state.enc.json` 中，按账号 ID 去重、每账号取最新、再选择两个最新的不同账号，固定为 A/B，不自动换号。
- 仅使用现有仓库解锁流程和 ArtifactStore；不运行旧 `run/import-test`、不执行登录和条款确认、不启动 IXBrowser GUI。
- 明文在解密子进程中通过本机 HTTP 发给真实管理路由，不输出到 stdout 或命令行。结构、来源账号 ID、邮箱哈希不一致即拒绝。
- 模型固定 `gemini-3.8-flash`。浏览器在真实请求发送前检查生成路径，全实例和重启间共享最多12次预算；仅在超限时中止，不伪造模型响应。
- 验证失败的账号不进入后续模型调用；错误不能由另一个账号成功替代。管理401/403与目标模型上游状态分开记录。
- 生产路径配置了环境代理、而隔离验证器未支持同一路径时，本入口报告 `PROXY_PATH_MISMATCH` 并停止，不能把网络差异解释为坏凭证。

## 检查与证据

覆盖独立 Key/Session 边界、导入及模型验证、自动启用、指定账号复验、非流式/流式模型接口、幂等重试和冲突、管理期间连接隔离、同目录重启，以及新进程/空目录对同一加密文件的二次重放。

每个 `run-*` 保留 `events.jsonl` 与 `result.json`。记录匿名账号、文件哈希、稳定账号ID、版本、任务ID、请求ID、状态与统计，不保存 Cookie、密码、token、任意上游正文。正常清理会撤销临时管理 Key、关闭本次浏览器/服务并删除本次 `instance-*` 中的明文凭证和任务输入；清理失败独立记录，不会假报完成。

```powershell
node scripts/tests/managementAcceptance.test.js --require-full --live-evidence <绝对路径/result.json>
```

完整门槛验证当前业务源码摘要、双账号及各阶段关联、事件文件摘要、生成次数、隔离性、重启和清理结果。缺失、失败、模拟、错误归属或旧源码报告均拒绝。该机制是可审阅的测试记录校验，不是对恶意篡改者的远程证明或数字签名。

无成功 LIVE 证据时，`--require-local` 仍可通过本地模拟，而 `--require-full` 必须失败；不得删除门槛来达到“全绿”。

## 只读页面诊断

服务关闭后，可对同两份文件运行：

```powershell
node scripts/tests/managementLive.js --base-url http://127.0.0.1:7860 --manager-root G:\code\gemini30\gemini-manager --diagnose true
```

诊断使用无界面浏览器，不点击、不登录，并拦截生成路径；只输出页面来源、固定状态布尔值、身份字段是否存在和结构字段名，不输出页面邮箱、Cookie或正文。诊断通过不代表模型可用，诊断报告不能用于放行 LIVE 门槛。

仅排查已确认的应用启动提示时，可显式追加 `--advance-entry true`：必须同时识别固定提示“This app is from another developer”和精确按钮“Continue to the app”才继续。不会点击一般 Continue、登录或服务条款。可选 `--screenshot true` 保存本地调试截图；截图不进 Git、不作为模型成功证据，分享前必须检查是否包含账号信息。其他诊断仅保留受限的非秘密 UI 标签，不记录任意正文或响应体。
