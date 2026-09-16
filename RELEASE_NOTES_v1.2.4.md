# Release v1.2.4 — Usage Stats 面板负载限流（limit 截断）

## 问题背景

面板「Usage Stats / 请求记录」页面每次加载都会全量拉取 `usage-stats.jsonl`：

- 文件随每一次请求追加一行，账号池事故/429 熔断期间错误记录急剧膨胀（9-15 事故后实测 30714 条 / 21MB）
- `/api/usage-stats` 原样返回整个 snapshot（`getSnapshot()` 内 records 全量），国内访问海外机房 + 国际链路高重传，21MB 要传几分钟
- 浏览器端解析 + 渲染 3 万条记录直接假死，表现为「连接中断 / 页面打不开」（抓包实测两条连接 2 分钟吃掉 121MB 流量）

## 改动内容

### 1. 后端：`/api/usage-stats?limit=N`（StatusRoutes.js + UsageStatsService.js）

- `UsageStatsService.applyRecordsLimit(snapshot, limit)` 静态方法：把 snapshot 的 records 截断到最近 N 条（records 本就是 newest-first），并返回 `totalRecords`（全量总数）与 `recordsTruncated`（是否被截断）两个字段
- 路由 handler 调用该方法；limit 缺省/非法时回退 500
- 完整历史不受影响：`/api/usage-stats/download` 仍导出全量 JSONL

### 2. 前端：只拉最近 500 条 + 截断提示（StatusPage.vue + i18n）

- `fetchUsageStats` 请求改为 `/api/usage-stats?limit=500`
- 记录表标题行新增截断提示（仅当 `recordsTruncated` 为真时显示）：「仅显示最近 500 条，共 N 条。完整记录请下载 JSONL」（en/zh 双语文案 key `recordsShownCount`）

### 3. 测试

- 新增 `scripts/tests/usageStatsLimit.test.js`（npm run test:usage-stats-limit）：空快照 / 恰好等于 limit 不截断 / 超出截断且保最新 / limit 覆盖默认值 / 非法 limit 回退 / null 快照容忍，6 场景全过
- 顺手修订 `requestRouting.test.js` 中过时断言：v1.2.3 起单次上游 429 会触发账号级 quota 熔断（所有模型排除），旧断言仍期望「只有该模型被隔离」故基线即红，已对齐 v1.2.3 行为

## 部署说明

- 镜像：`ghcr.io/mulan777/aitoapi-custom:v1.2.4`（本地构建推送，GitHub Actions 免费额度已停用）
- 生产：23.251.32.49:7860（AitoAPI 主站）
- 配套运维：49 已加 cron（每天 03:30 若 usage-stats.jsonl 超 3000 行则备份并裁剪到最近 1200 行，`/opt/aistudio-to-api/rotate-usage-stats.sh`），双保险防文件再次膨胀