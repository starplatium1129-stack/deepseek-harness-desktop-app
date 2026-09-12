# DeepSeek Harness Desktop

独立的 Windows 桌面封装：点击图标自动启动 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，使用上游 Web UI，内置 Node.js 与固定版本核心。

![桌面管理](docs/screenshots/desktop.png)

## 使用

下载 Releases 中的 `DeepSeek-Harness-Desktop-0.1.1-Setup.exe`，安装后打开桌面快捷方式。

- **工作空间**：上游原生会话、工作区、模型及插件界面。
- **桌面管理**：服务状态、API Key 加密保存、核心版本检查、诊断日志和数据目录。
- 首次使用按上游引导选择工作区并配置模型。通过桌面保存的 DeepSeek API Key 在重启后生效。
- 上游更新下载到隔离目录，校验包完整性并试启动；重启后备份数据再切换。失败自动恢复，成功后也可手动回退。
- **联网搜索**：默认使用 Exa Search MCP 的免费通道，不依赖 DeepSeek API Key 或余额；Exa 自身仍有免费限流。网页读取继续使用上游 HTTP 后端。
- **地区错误恢复**：遇到包含 `User location is not supported for the API use` 和 `FAILED_PRECONDITION` 的模型错误，且尚未收到任何流事件时，等待 1 秒、2 秒分别补试，最多两次。已有文字、思考、工具调用或其他流事件、用户取消、其他错误均不会触发该补试。

本项目是社区封装，不是 DeepSeek 官方桌面发行版。图标由项目所有者提供。

## 开发与打包

Windows x64，Node **24.18.0**。

```powershell
npm ci
npm run prepare:runtime
npm start
npm test
npm run smoke
node scripts/integration-smoke.cjs
node scripts/ui-smoke.cjs
npm run dist
node scripts/ui-smoke.cjs --packaged
```

`prepare:runtime` 使用 `harness-lock.json` 安装固定核心依赖，复制当前 Node 与 npm，并生成图标。运行文件均位于被 Git 忽略的 `runtime/`；新仓库不包含上游源码历史。安装包位于 `release/`。

## 数据与更新

用户数据保存在 Electron 的用户数据目录（通常为 `%APPDATA%/deepseek-harness-desktop`，通过应用内“数据目录”打开准确路径）。Harness 使用其下独立的 `harness-home`，不会自动读取或迁移旧版 `~/.dsh`。

桌面保存的 API Key 位于 `credential.bin`，通过 Electron safeStorage 使用 Windows 加密；传给本地子进程的环境变量为 `DEEPSEEK_API_KEY`。上游界面自行保存的凭据遵循上游存储机制。

更新来源固定为 npm 官方注册表的 `@deepseek-ai/dsh`。桌面显示的核心版本与桌面版本独立。首版支持核心更新；桌面壳自身通过新安装包升级。上游尚处于预览期，启动验证不能保证所有插件或模型能力兼容。

回退将当前数据另存为 `recovered-data-*`，再恢复升级前快照。回退后新产生的会话不会自动合并；原文件仍保留，可手动恢复。

## 首版验证范围

已覆盖的检查及剩余边界见 [验收记录](docs/validation.md)，进程和更新设计见 [架构说明](docs/architecture.md)。没有 API Key 的测试不调用付费模型，不声称已完成真实模型应答验收。
