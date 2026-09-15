# Release v1.2.3 — Quota (HTTP 429) Circuit Breaker

## 问题背景

账号池在生产流量下被 429（RESOURCE_EXHAUSTED，Build App 配额耗尽）反复命中的凭证不会被禁用：

- 自动禁用名单原本只有 `[401, 403]`（登录态失效 / 账号被封）
- 429 只进 per-model 1800s 冷却（`modelCooldowns`），**账号级冷却不抬起**，换一个模型请求照样路由到同一个 429 号
- `SWITCH_ON_USES` 只按成功计数，429 不消耗轮换计数 → 错误号永远"用不满"、永远留在轮换里反复被刷
- 实例（48h 观测）：vt2311994 216 成功 / 318 失败（429 占 307），kewatlaxmi321 22 成功 / 531 失败（503 占 530），均未禁用

## 改动内容（仅 RequestHandler.js + 新增单测）

### 1. 429 熔断（核心）

上游返回 HTTP 429 时，**立即临时禁用该凭证**（`disabledReason=quota_exhausted`，写入 auth 文件）：

- 关闭该账号浏览器上下文、断开连接、移出轮换
- **立即把流量切到其他凭证**（`_selectRequestAuthIndex` 选下一个活跃账号并拉起）
- 记录 `quotaDisabledUntil = now + 20min`（持久化到 account-route-state.json，重启保留）
- 重复 429 单飞短路（已禁用账号不再重复禁用/刷日志）

### 2. AutoHeal 探测扩展

10 分钟一轮的探测现同时覆盖 `crash_loop` 与 `quota_exhausted`：

- 未到 20 分钟窗口的号跳过（避免探测本身烧配额）
- 到点后探测：enableAuth → 预热 context → WS ready → 页面状态检查（与面板 Test 同标准）
- 健康 → 回轮换，计数清零；失败 → 回滚重新禁用，探测失败计数 +1
- 连续失败 ≥ 3 次 → 永久停探，留人工处理（防 Google 风控反复横跳）

### 3. 状态结构兼容

route-state 新增 `quotaDisabledUntil / quotaProbeEpisodes` 字段，加载旧 JSON 回填兜底（防止旧状态缺字段抛错，沿用 crash-loop 同款策略）。

## 测试

- 新增 `scripts/tests/quotaCircuitBreaker.test.js`（npm run test:quota），覆盖：
  1. 单次 429 → 禁用 quota_exhausted + 关上下文 + 出轮换 + 窗口落库
  2. 重复 429 不重复禁用
  3. `_markImmediateRateLimitIfNeeded(429)` 集成路径触发熔断；503 不触发
  4. 探测跳过"窗口内"与"超限"账号
  5. 到点健康账号恢复 + 计数器清零
  6. warm 失败回滚 + 计一次失败
- 回归：`test:crashloop-autoheal`、`test:crashloop-quarantine` 全部 PASS

## 部署

49 (23.251.32.49:7860) 换 `ghcr.io/mulan777/aitoapi-custom:v1.2.3`，旧容器改名保留回滚。参数（可调）：`QUOTA_EXHAUST_DISABLE_MS=20min`、`QUOTA_PROBE_MAX_EPISODES=3`（RequestHandler.js 顶部常量）。