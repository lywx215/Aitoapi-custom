# Release v1.2.5 — 面板设置保存修复（单文件 bind mount EBUSY）

## 问题背景

面板保存任何走 `_saveRuntimeSettings` 的设置（自动禁用状态码 / max-contexts / 重试与冷却参数）时：

- 保存分两步：先改内存 config，再原子落盘到 `/app/configs/runtime-settings.json`
- 落盘写法为「写 `.tmp` → `unlink` 旧文件 → `rename` 顶替」
- 2026-09-12 起 runtime-settings.json 采用 Docker **单文件 bind mount** 持久化（面板改动重启不丢）；单文件挂载的挂载点 inode 被内核锁定，容器内 `unlink` 直接失败
- 结果：500 `EBUSY: resource busy or locked, unlink '/app/configs/runtime-settings.json'`——且内存值已生效但未落盘，**重启即回滚**，面板显示值与文件真实值不一致

## 改动内容

### 后端：`_saveRuntimeSettings` EBUSY 回退（src/routes/StatusRoutes.js）

- `unlink` 抛 EBUSY（单文件 bind mount 场景）时回退为**原地截断重写**：`open(r+) → truncate(0) → writeFile → sync`，保留 inode 使 bind mount 继续有效
- 普通可删除文件的场景仍走原 rename 原子写路径，行为不变

### 测试

- 新增 `scripts/tests/runtimeSettingsSave.test.js`：直接提取真实函数体做隔离验证——bind mount EBUSY 回退（内容更新 + inode 不变 + tmp 清理）与正常 rename 两场景全过

### 部署边界

- 本修复曾于 2026-09-18 以 docker cp 热补进 49 生产容器（commit 37ed1ee）；本版本（v1.2.5）起修复随镜像发布，容器重建不再丢失
- 无 UI / 前端变更，无需 build:ui；升级路径：停旧容器 → rename 保留 → 用新镜像 run（沿用 bind mount 与 .env）→ 验收四连

## 验收记录（2026-09-18，49:7860 实测）

- 面板 PUT auto-disable-status-codes / max-contexts 均 200，宿主 runtime-settings.json 回读确认真实落盘
- 真实 chat gemini-2.5-flash 200（~1s）；/v1/models 200 <1s；容器 healthy
