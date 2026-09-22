# 外部管理 API 开发任务台账

总控：当前 Codex 任务 `01a0b852-e646-71c2-886e-76cec5ead92e`。
集成工作区：`C:/Users/lywx2/.codex/worktrees/management-api-integration/Aitoapi-custom`。
集成分支：`codex/management-api-integration`。
第一批基线：`55e72484741a0e3cfec074d0526c3a4f6e4aa157`。
第二批基线：`d8170cbe0bb1209a4a88519e4f434874ff0966d8`。
原六项开发任务最近核对：2026-09-22 15:15（Asia/Shanghai），来自实际 task 状态及 Git 产物；六项均已完成交付，总控已复跑最终集成测试。后续本机 LIVE 验证见文末追加记录，不将离线验收等同于真实通过。
继承原工作区改动单独提交：`a738538`。原工作区保持不变。

|任务|实际任务ID|状态|交付|测试/阻塞|
|---|---|---|---|---|
|T1 管理 API｜凭证存储与并发一致性|01a0c7be-4f4f-7a50-8bf9-39136589e207|已验收（本地）|5916d1f → 集成bff90b8|16场景通过，旧入口接入及最终回归通过|
|T2 管理 API｜配置存储与设置一致性|01a0c7be-4efd-70e1-b805-8a5e33bac854|已验收（本地）|7c36765 → 集成1a87411|21场景通过，写盘/回调故障注入及最终回归通过|
|T3 管理 API｜接口契约与兼容验收|01a0c7be-4f17-7cd2-8021-6f927f9563bb|已验收（本地）|42ac0b55，含准备提交和总控基线合并；已快进集成|真实挂载本地25 pass / 0 fail / 0 TODO；21脚本通过|
|T4 管理 API｜独立鉴权与密钥控制台|01a0c7d0-5631-7303-bbd6-e2a26e0a2b1e|已验收（本地）|ca0e36d → 38d28c7|11项测试、真实控制台组件3项模拟交互及完整前端构建通过|
|T5 管理 API｜账号管理与批量任务|01a0c7d0-d58e-7d33-b05b-d574941a2774|已验收（本地）|9461dec → 4b1cefe；ce6a7de参数补丁由总控等价整合|任务15项、路由6项及双模拟账号完整链路通过|
|T6 管理 API｜隔离验证与自动启用|01a0c7d0-5e05-7a80-87f7-aa7d183594d5|已验收（本地）|916b1c2 → b9e3b9a|44项离线测试和实际挂载集成通过；真实页面身份映射待另行 LIVE 验证|

## 独立工作区

以下相对目录均位于 `C:/Users/lywx2/.codex/worktrees/`，每个目录均为独立Git worktree。

|任务|工作区|分支/提交|
|---|---|---|
|T1|6815/Aitoapi-custom|detached HEAD 5916d1f|
|T2|6b51/Aitoapi-custom|detached HEAD 7c36765|
|T3|dab7/Aitoapi-custom|codex/management-api-final-acceptance（初始契约分支 codex/management-api-contract-tests）|
|T4|9142/Aitoapi-custom|codex/management-keys|
|T5|b661/Aitoapi-custom|codex/management-operations|
|T6|471c/Aitoapi-custom|codex/isolated-management-verifier|

已完成交付任务数：6/6；通过本轮本地集成验收任务数：6/6。真实账号验证不在本轮执行范围，以上数字不是线上可用性或真实账号验收百分比。当前无本地实施阻塞；下一步为用户另行安排 LIVE-01 和发布。

## 已确认集成证据

- 总控5d924c2迁移旧后台单/批上传、VNC保存、启禁用、AutoHeal和Cookie刷新到公共存储，删除改为await。
- `managementStorageIntegration.test.js`实际BrowserManager刷新适配器验证禁用/替换/删除优先；旧上下文绑定凭证版本。
- T3独立复核15个测试脚本全部exit0，新API/真实模型10个TODO不算通过。
- T3发现CLI按现存最大编号会复用墓碑编号；d8170cb改为保存时CredentialStore.create；独立复核创建0/1→删除1→创建2、全部删除后创建3，不复用编号。
- 第二批新增管理账号排空运行时测试通过，已有请求可继续、其他账号仍可选择、未明确force不强关连接。
- 单进程/单副本共享卷限制：CLI离线保存仍须停服，不承诺多进程并发一致性。
- 总控 0a7fed0 完成服务器挂载、独立鉴权、按账号排空运行时、任务/验证器启动关闭、控制台面板接入；无新增管理必填环境变量。
- T3 发现旧管理子路径落入模型转发，总控 cc17649 修复 Express 前缀匹配，独立复测返回本地404且上游转发计数不变。
- 总控 44e5a29 补强编码前缀、错误百分号后缀、点路径逃逸的管理命名空间识别。
- 总控 2279b03 真实空实例启动/关闭冒烟测试通过，无凭证、无浏览器、无上游请求。
- 总控在 42ac0b55 最终集成版本复跑 `node scripts/tests/runManagementTests.js`，21脚本 exit0；严格本地验收25 pass / 0 fail / 0 TODO / 1 LIVE deferred。
- 总控复跑 `--require-full` exit1，唯一失败是延期的 LIVE-01 门槛；没有将其计入本地通过项。
- 最终变更 JS/Vue ESLint 0 error、保留1项既有日志 v-html warning；Vite 完整构建通过；`git diff --check` 通过。详见 [验证记录](management-api-validation.md)。

## 进度口径

子任务完成不等于集成通过；状态分为进行中、待集成、已验收。真实Google模型验证与模拟验收分开记录。
首次基线验证：requestRouting.test.js、upstreamImprovements.test.js通过。
目前尚未部署，尚未执行线上账号验证。

用户本轮明确选择：先完成本地模拟验收，真实账号测试另行安排。LIVE-01不在本轮执行范围，不使用真实凭证/生产模型。

## 追加：用户授权本机真实凭证验证（2026-09-22 16:17 后核对）

以上为此前离线阶段的历史记录。用户随后授权按本机隔离方案使用现有加密文件；本追加记录取代“尚未执行 LIVE”的当前状态，但不篡改原阶段结果。

|任务|状态|已完成|阻塞/下一步|证据|
|---|---|---|---|---|
|LIVE 工具与保护修复（总控，无新增独立任务）|已实现，离线回归通过|loopback 真实入口、解密桥、请求预算、脱敏证据及 full gate；全禁用启动保护|真实成功分支尚未通过|`scripts/tests/managementLive.js`，本地 22 脚本|
|LIVE-01 双账号真实全流程|部分通过，真实模型验收未通过|两账号解密/真实导入、鉴权、幂等、失败保持禁用、真实重启、清理|两账号 `identity_unconfirmed`，后台 401/403；生成 0 次。需确认有效会话/可信身份适配|`data/management-live/run-EGxBQI/result.json` 和 `events.jsonl`|
|LIVE 二次空目录重放|未执行，等待依赖|保留同一 A/B 的加密文件与摘要|首次模型验证未成功，不能计重放成功|[完整真实记录](management-api-live-validation-2026-09-22.md)|

原六项开发交付仍为 6/6，本地集成仍为 6/6；**真实双账号完整验收为 0/1**。两账号均未获得 `model_verified` 或自动启用。本次资源已关闭、临时 Key 已撤销、明文实例数据已清理，源文件未变；未部署或操作线上账号。完整门槛携带失败报告实际运行，按预期拒绝。
