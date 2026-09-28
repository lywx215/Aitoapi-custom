# 2026-09-28：线上客户端与独立模型验证修复

## 复现与原因

目标：`https://aib.zeabur.app`，诊断基线 `a2d5138`。

- 服务器源代码已包含客户端协议 v2，但实际 AI Studio 预览页仍加载旧的远程构建脚本，没有发送 `generation_capabilities`。正常模型 API 返回 `503 browser_upgrade_required`。
- Camoufox 的自动化脚本作用域与页面脚本不同。旧验证器通过 `addInitScript` 替换 WebSocket，未改变预览页真正使用的连接。验证一直停在会话检查。
- 当前 AI Studio 应用页不再提供旧 WIZ 身份字段。同一隔离 context 的第一方 `/apps` 页面仍提供 `ms-account-switcher` 的 Google Account 身份控件。
- 模型请求开始后才显示 `rocket_launch` 图标。它不是 button；旧验证器仅检查按钮，且连接后不再检查启动控件。
- 打通上述链路后，真实响应为 HTTP 200，但原验证请求的 64-token 上限导致 `MAX_TOKENS`，被正确拒绝为不完整响应。观测到思考 58 tokens、最终回答有文本。不能把这个结果误判为凭证未上传或无权限。

## 修改

- 正常上下文、自愈探测、独立验证统一加载仓库配套 `scripts/client/build.js`。仅替换已识别的 AI Studio 预览应用代理资源，不改远端应用源码。验证端点直接传给配套客户端，不依赖跨作用域全局替换；不支持的代理脚本在独立验证中报告初始化失败，不回退到生产池。
- 身份兼容读取限于第一方 Google Account 控件，不接受应用正文或任意邮箱；缺失时继续在原期限内等待。
- 保持生成期间的精确启动控件处理，支持图标；控件动画的点击超时在原总期限内重试。
- 验证用固定短提示，输出预算改为 1024；Gemini 3 文本模型使用 LOW 思考。仍要求目标模型、请求关联、完整非空回复及 STOP，不把 MAX_TOKENS 放宽为通过。
- 由 browser.close 统一关闭其 context/page，避免竞争关闭造成假的 cleanup_failed。
- 任务结果保留初始化、条款、地区、连接、响应、清理等明确失败阶段，继续分离上传回执和验证结果。

## 验证证据与边界

在现有部署容器中启动独立诊断进程，以账号 18 的已上传凭证读取副本、加载待发布模块，未覆盖生产源码或凭证文件。2026-09-28 03:57:13 UTC 得到 HTTP 200、`STOP`、`model_verified`；请求编号 `verify_99e3d974-bbff-4f3d-b74b-0ad6402b29eb`。该结果证明修复链路可用，尚不等同于正式进程已发布。

本地管理回归覆盖真实服务装配、取消/清理、请求归属、上传与验证分离；新增真实浏览器现象对应的客户端加载、图标晚出现、具体失败阶段回传测试。模拟用例不替代线上验收。

正式发布后需复测两个已上传账号的 management test，以及普通 `/v1/chat/completions`；比较账号启停、版本和上传回执。共享 MySQL 并发/回滚与完整代理矩阵不由本次验证代替。未运行本地 Docker、GitHub Actions 或 Claude 审核。

参考：[Camoufox 作用域说明](https://camoufox.com/python/main-world-eval/)、[Google 思考与输出预算说明](https://ai.google.dev/gemini-api/docs/generate-content/thinking)。
