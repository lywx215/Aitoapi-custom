# Release v1.2.2

发布日期：2026-09-14

## 重点更新

- 修复浏览器 WebSocket 反复掉线拖垮整池的问题：按凭证统计掉线突发（60 秒内累计 3 次），对问题凭证软隔离 120 秒；隔离期间该凭证不参与请求路由、恢复回退和轮询切换。
- 连续两个隔离周期后自动禁用该凭证，禁用原因记为 `crash_loop`，同时关闭其浏览器上下文并移出轮询池，避免坏凭证继续抢占热上下文。
- 已被自动禁用的凭证再次掉线时直接短路，不会重复禁用或刷日志。
- 新增每 10 分钟一轮的自动恢复探测：只有凭证重新启用、上下文预热成功、WebSocket 就绪且页面状态检查通过时才放回轮询池；预热失败会回滚为禁用并记一次失败。
- 探测失败累计达到 3 次后永久停止探测，保留人工处理，避免与上游风控反复对抗。
- 手动禁用的凭证不会被自动探测恢复，尊重人工操作。
- 修复自动恢复探测读取凭证状态的方法名错误（应使用 `AuthSource.getStatusMetadata`，此前调用的方法不存在），该探测在旧版本中一直抛错、从未生效。
- 自动禁用与恢复状态写入凭证文件的 `disabledReason`，随凭证文件一起迁移，重启后仍然生效。

## 验证

- `npm run test:crashloop-quarantine`：PASS —— 单次掉线不隔离；60 秒内 3 次掉线触发隔离；隔离凭证不再被选号（含当前账号回退路径）；轮询切换跳过隔离凭证并落到健康凭证。
- `npm run test:crashloop-autoheal`：PASS —— 首次隔离不禁用；第二个隔离周期自动禁用并关闭上下文、移出轮询；探测跳过仍在隔离期与已耗尽探测次数的凭证；隔离窗口结束后探测成功恢复并清零计数；预热失败回滚为禁用并计入一次失败。
- 生产机（`23.251.32.49:7860`）真实调用 `POST /v1/chat/completions`：HTTP 200，返回内容正常。
- 生产机重启后日志确认：`[AutoHeal] Crash-loop account probe scheduled every 10 minutes.` 注册成功，且启动满 10 分钟后的首轮探测输出 `[AutoHeal] Probe cycle: no crash-loop-disabled accounts to test.`，无报错。
- `node --check`：本次改动的三个源文件语法检查通过。

## 升级提示

- 无需新增环境变量。隔离窗口、自动禁用阈值与探测周期为 `src/core/RequestHandler.js` 顶部常量，可按需调整：`WS_CRASH_WINDOW_MS`、`WS_CRASH_DROP_THRESHOLD`、`WS_CRASH_ISOLATE_MS`、`WS_CRASH_DISABLE_AFTER_EPISODES`、`WS_CRASH_MAX_EPISODES`、`WS_CRASH_PROBE_INTERVAL_MS`。
- 面板仍可手动启用被自动禁用的凭证；`manual`、`expired` 以及上游返回 401/403 导致的禁用不受自动恢复影响。
- Docker 部署继续持久化 `configs/auth`、`configs/runtime-settings.json` 与 `data`，并使用 `--restart unless-stopped`。