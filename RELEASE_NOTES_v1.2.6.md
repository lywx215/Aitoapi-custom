# v1.2.6 — AutoHeal 探测重构 + 崩溃循环盲区修复

## AutoHeal 探测重构（按需求定制）
- **独立探测浏览器**：探测改用一次性独立 Camoufox 浏览器（`probeAccountIsolated`），完全独立于生产浏览器与 MAX_CONTEXTS 池——池满/忙碌不再影响探测，探测也不再挤占业务上下文。测完立即关闭。
- **探测间隔改为默认 5 小时**，且**永不放弃**：删除「失败 3 次停止探测」的 max-episode 逻辑（crash_loop 与 quota_exhausted 均适用），失败只记计数，下轮继续。
- **面板可动态调整**：新增设置项「自动恢复探测间隔（分钟）」「单号探测超时（分钟）」，走 runtime-settings 持久化（重启不丢），修改后立即重新挂定时器。接口：`PUT /api/settings/autoheal-probe`。

## forbidden 自动删号
- 探测周期发现 `disabledReason=forbidden`（Google 账号级封号）的账号自动删除，删前把 auth 文件备份到 `data/removed-auth-backup/`（软删除，可人工恢复）。

## 崩溃循环盲区修复（#75 死循环根因）
- 根因：页面能打开但 WebSocket 永远初始化不起来时，不产生 connection-lost 事件，`recordWsDisconnect` 从不触发 → 隔离失效 → 恢复逻辑每次都原地选回同一账号，7 分钟内每秒一次「断开→恢复→再断开」。
- 修复①：direct recovery「页面打开成功但 WS 未就绪」的失败路径计入该账号 WS 断连计数；
- 修复②：路由层「WebSocket connection not ready before retry」两处 503 发送点同样计数；
- 效果：60 秒窗口内 3 次 → 触发崩溃隔离 → 恢复强制改道其他账号；连续 2 个隔离周期 → 自动禁用（crash_loop）→ AutoHeal 周期探测恢复。

## 部署边界
- 多实例部署时本功能为节点内行为，无需共享数据库/Redis 配合。
