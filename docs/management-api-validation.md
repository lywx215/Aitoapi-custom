# 外部管理 API 本地验证记录

## 范围与结论口径

本轮实施采用独立集成分支 `codex/management-api-integration`。原工作区未重置、未笼统提交；未推送、未部署，也未访问生产账号。

用户明确要求：先完成本地模拟验收，真实账号测试另行安排。测试使用临时目录、虚构凭证、loopback HTTP/WebSocket 和模拟上游；不得将模拟模型响应表述为 Google 真实账号成功。

独立 T3 在合并 `44e5a29` 后的严格本地验收为 26 项登记、25 pass、0 fail、0 TODO、1 LIVE deferred；统一 21 个脚本回归 exit 0。`--require-full` exit 1，仅因 `LIVE-01` 缺少真实双账号证据而不放行。总控最终集成复跑结果见本文末节。`LIVE-01` 是用户延期的真实双账号验证，不以本地通过替代。

## 实现和验证分层

|层次|测试入口|已核查内容|
|---|---|---|
|凭证事务|`scripts/tests/credentialStore.test.js`|并发编号、稳定身份、版本冲突、Cookie 合并、墓碑、归档和恢复、失败及重启|
|设置事务|`scripts/tests/runtimeSettingsStore.test.js`、`runtimeSettingsSave.test.js`|写队列不丢字段，写盘失败不提交内存，明确赋值、旧取反适配及应用回调错误|
|旧入口适配|`managementStorageIntegration.test.js`|实际 BrowserManager 刷新路径，禁用/替换/删除优先于旧上下文|
|账号排空|`managementRuntime.test.js`|按账号引用计数阻止新绑定，保留已有请求，其他账号不受影响，非 force 不强关连接|
|真实服务启动|`managementStartup.test.js`|空凭证实例实际启动 HTTP/WS、管理路由及健康接口、Key 边界、正常关闭；禁止启动浏览器|
|管理密钥|`managementKeys.test.js`|摘要持久化、作用域、撤销、到期、控制台密码 Session 与模型 Key 分离、同源写保护|
|批量任务和路由|`managementTasks.test.js`、`managementRoutes.test.js`|幂等、逐项结果、取消和重启、审计、参数预校验、权限、本地错误、目标账号验证及版本比较|
|隔离验证|`managementVerifier.test.js`|真实客户端脚本、loopback WS、目标账号与请求关联、上游错误分类、取消、超时、资源清理及默认入口|
|独立总体验收|`managementAcceptance.test.js --require-local`|T3 维护；使用真实 ProxyServerSystem 构造与路由挂载，模拟浏览器资源和上游 fetch，覆盖双账号导入到自动启用|
|既有行为回归|统一运行器中的既有测试|路由、后台唤醒、流完整性、模型后缀、429、crash-loop、AutoHeal、隔离探测和用量限制|

统一执行入口：

```powershell
node scripts/tests/runManagementTests.js
node scripts/tests/managementAcceptance.test.js --require-local
node scripts/tests/managementAcceptance.test.js --require-full
node node_modules/vite/bin/vite.js build
git diff --check
```

`--require-local` 必须没有待实现 TODO；统一运行器即使遇到旧版验收脚本忽略参数，也会检查 TODO 并失败。`--require-full` 在 LIVE-01 未执行时应非零退出，这是有意保留的真实验收门槛。

## 本轮发现并修复的问题

1. CLI 先按目录最大编号分配，可能复用已删除编号。改为最终保存时调用公共 CredentialStore；CLI 仍为离线写入，必须先停服。
2. Cookie 刷新缺少上下文版本约束，可能覆盖禁用、替换或删除结果。上下文绑定凭证版本，刷新执行版本校验和字段合并；已删除凭证不能重建。
3. 管理维护影响生产账号时缺少按账号排空。新增引用计数 hold，非 force 操作等待已有请求结束；不借用全局繁忙开关。
4. 隔离验证器最初只接受 AI Studio 长域名，拒绝现有 ConfigLoader 默认 `ai.studio/apps` 入口。现支持合法短入口，并在跳转后校验最终页面身份。
5. 批量输入的 clientRef、模型名等应在任务准入前校验。增加长度、格式和重复值检查，非法请求不创建任务、不写凭证。
6. `enableUsageStats` 不具备热切换生命周期语义，移出新设置允许列表；没有把更新内存字段伪装为服务已经热切换。
7. T3 在真实 Express 挂载中发现旧管理未知子路径落入模型 fallback。总控 `cc17649` 将末尾路径边界改为零宽匹配，避免 Express 前缀裁剪后拒绝命中；T3 已独立复测通过。总控 `44e5a29` 进一步防止错误百分号后缀和点路径规范化掩盖已编码的管理前缀。
8. 前端原有图标引用依赖未声明的包，导致完整构建失败。使用本地等价 SVG 组件，无新增依赖或环境变量。

## 已知限制和后续真实验证

- 文件存储是单进程、单副本设计，不提供跨进程共享卷锁；不能用增加副本替代存储迁移。
- 管理 Key 只保存摘要；Cookie、归档、任务私有输入并未加密，需受限卷权限和备份保护。
- 页面身份适配假设 AI Studio 的 `WIZ_global_data.oPEP7c` 提供会话邮箱。该字段映射只做本地模拟，尚未由真实页面验证；缺失或不匹配时失败关闭，不能自动启用。
- 登录、身份挑战或条款页面不会被误认成验证成功，也不绕过人工身份验证。需要先获得可用凭证，再安排真实验证。
- 上游模型返回版本如与请求型号不一致，当前策略保守拒绝；真实模型别名兼容性待真实验收确认。
- 模拟双账号成功不能证明真实凭证可以迁移、服务区域可用或每日配额；本轮不进行额度探测。
- 控制台组件进行编译和模拟渲染交互测试；不声称已完成真实浏览器视觉回归。
- 前端构建现有 CJS API 弃用及大 bundle 提示不阻断构建。StatusPage 现有日志 `v-html` 保留一个 ESLint 警告；日志先经过 `escapeHtml`，本轮未改变该渲染机制。

后续 LIVE-01 必须在获准的隔离测试实例使用两个不同真实账号，分别记录导入任务、账号稳定 ID/版本、目标请求关联、实际模型响应、自动启用结果及对已有请求的影响；日志不得含 Cookie、管理 token 或模型 Key。

## 总控最终复跑（2026-09-22，Asia/Shanghai）

测试版本：`42ac0b55ad48a5b9b8d6765c50b12813af186603`，已快进至集成分支。后续交付提交只更新台账和本记录，不改变已测试业务代码。

|检查|结果|
|---|---|
|`node scripts/tests/runManagementTests.js`|exit 0；全部21个脚本通过，含严格本地验收|
|严格本地验收|26项登记，25 pass，0 fail，0 TODO，1 LIVE-01 deferred/skip|
|`node scripts/tests/managementAcceptance.test.js --require-full`|预期 exit 1；24 pass、1 fail、1 skip；唯一 fail 为延期的 LIVE-01 完整门槛|
|全部变更 JS/Vue 的 ESLint|exit 0；0 error，1项既有日志 v-html warning|
|完整 Vite 前端构建|exit 0，1628模块；构建产物与已提交版本一致|
|`git diff --check`|exit 0|
|原工作区核对|HEAD 仍为 d24d14e，原有修改清单保留；无重置或覆盖|

双模拟账号证据入口为 `scripts/tests/fixtures/management/localAcceptance.js` 中 W2-03：实际服务挂载后，两项分别取得自己的账号身份、模型请求 ID 和 `model_verified` 结果，再自动启用。W2-04 验证失败目标不能由另一个成功账号替代；W2-06 验证人工变更优先于旧验证。`fullMount.js` 复用实际 ProxyServerSystem、浏览器适配器和客户端脚本，仅替换浏览器资源及上游 fetch，不伪造管理路由的成功响应。

结论：本地实现并模拟验收完成，尚未部署。真实双账号模型验证及真实浏览器视觉回归未执行；六个任务已完成交付和本轮本地集成验收。
