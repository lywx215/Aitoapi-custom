# 外部管理 API 开发任务台账

总控：当前 Codex 任务 `01a0b852-e646-71c2-886e-76cec5ead92e`。
集成工作区：`C:/Users/lywx2/.codex/worktrees/management-api-integration/Aitoapi-custom`。
集成分支：`codex/management-api-integration`。
第一批基线：`55e72484741a0e3cfec074d0526c3a4f6e4aa157`。
第二批基线：`d8170cbe0bb1209a4a88519e4f434874ff0966d8`。
最近核对：2026-09-22 14:36（Asia/Shanghai），来自实际task状态及Git产物。
继承原工作区改动单独提交：`a738538`。原工作区保持不变。

|任务|实际任务ID|状态|交付|测试/阻塞|
|---|---|---|---|---|
|T1 凭证存储与并发一致性|01a0c7be-4f4f-7a50-8bf9-39136589e207|已验收（基础存储）|5916d1f → 集成bff90b8|16场景通过，旧入口接入回归通过|
|T2 配置存储与设置一致性|01a0c7be-4efd-70e1-b805-8a5e33bac854|已验收（基础设置）|7c36765 → 集成1a87411|21场景通过，写盘/回调故障注入通过|
|T3 接口契约与兼容验收|01a0c7be-4f17-7cd2-8021-6f927f9563bb|等待新功能集成|68f3b3b → 集成4e418e6；OpenAPI24操作|15/15脚本通过；11基线断言/10 TODO；CLI缺陷修复后独立放行|
|T4 独立鉴权与密钥控制台|01a0c7d0-5631-7303-bbd6-e2a26e0a2b1e|进行中|KeyStore/Key路由/登录来源/UI|待集成与验收|
|T5 账号管理与批量任务|01a0c7d0-d58e-7d33-b05b-d574941a2774|进行中|账号服务/任务/路由|已约定总控提供按账号排空接口|
|T6 隔离验证与自动启用|01a0c7d0-5e05-7a80-87f7-aa7d183594d5|进行中|独立WS传输层已实现|正在实现浏览器生命周期及隔离测试|

## 独立工作区

以下相对目录均位于 `C:/Users/lywx2/.codex/worktrees/`，每个目录均为独立Git worktree。

|任务|工作区|分支/提交|
|---|---|---|
|T1|6815/Aitoapi-custom|detached HEAD 5916d1f|
|T2|6b51/Aitoapi-custom|detached HEAD 7c36765|
|T3|dab7/Aitoapi-custom|codex/management-api-contract-tests|
|T4|9142/Aitoapi-custom|codex/management-keys|
|T5|b661/Aitoapi-custom|codex/management-operations|
|T6|471c/Aitoapi-custom|codex/isolated-management-verifier|

已交付任务数：3/6；通过当前职责集成验收：T1/T2两项，T3基础契约已通过、最终验收尚待新功能。不是总体开发百分比。

## 已确认集成证据

- 总控5d924c2迁移旧后台单/批上传、VNC保存、启禁用、AutoHeal和Cookie刷新到公共存储，删除改为await。
- `managementStorageIntegration.test.js`实际BrowserManager刷新适配器验证禁用/替换/删除优先；旧上下文绑定凭证版本。
- T3独立复核15个测试脚本全部exit0，新API/真实模型10个TODO不算通过。
- T3发现CLI按现存最大编号会复用墓碑编号；d8170cb改为保存时CredentialStore.create；独立复核创建0/1→删除1→创建2、全部删除后创建3，不复用编号。
- 第二批新增管理账号排空运行时测试通过，已有请求可继续、其他账号仍可选择、未明确force不强关连接。
- 单进程/单副本共享卷限制：CLI离线保存仍须停服，不承诺多进程并发一致性。

## 进度口径

子任务完成不等于集成通过；状态分为进行中、待集成、已验收。真实Google模型验证与模拟验收分开记录。
首次基线验证：requestRouting.test.js、upstreamImprovements.test.js通过。
目前尚未部署，尚未执行线上账号验证。

用户本轮明确选择：先完成本地模拟验收，真实账号测试另行安排。LIVE-01不在本轮执行范围，不使用真实凭证/生产模型。
