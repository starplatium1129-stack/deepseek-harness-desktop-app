# 桌面架构

Electron 主进程管理可信的本地桌面管理页面和独立的 Harness WebContentsView。前者通过白名单 IPC 调用有限的桌面动作；后者没有 preload、Node 或桌面 IPC 权限。两者启用 contextIsolation 和 sandbox。外部 HTTP(S) 链接交给系统浏览器。

`src/runtime.cjs` 是唯一上游启动与版本适配模块。独立 Node 运行 `dsh web --host 127.0.0.1 --port 0 --no-open`，读取其标准输出提供的认证 URL。端口由操作系统分配，日志移除认证参数。健康检查处理上游的 303 Cookie 交换后检查 HTML。

Windows 子进程由 `scripts/harness-launcher.cjs` 包装，私有 IPC 将退出请求转为上游 SIGTERM 处理流程；超时才使用 PID 定向 taskkill。Electron 单实例锁阻止同一数据目录中的重复启动。启动错误允许重试并保留数据。

首次运行保存内置核心到用户版本目录，保证桌面安装包升级后仍可回退旧核心。记录本应用启动的 PID；再次启动时仅在该 PID 已不存在且锁文件内容与之匹配时恢复残留锁，不按文件年龄删除锁。

核心版本锁定在 `harness-lock.json`。`runtime/manifest.json` 记录 Node 版本、Node SHA-256 和 Harness 版本。首次启动使用内置包，后续使用用户目录下的明确版本，不运行浮动 npx 命令。

检查更新读取 npm 元数据。候选版本在 staging 中通过 npm 安装和完整性检查，禁用安装脚本，再使用临时 Harness home 试启动。只有通过后才写入 pending。应用重启时备份 home、写 trial 状态并启动新版本；正常启动清除 trial，失败或 trial 被中断则恢复旧版本及匹配数据。

桌面壳升级目前通过发行安装包完成。未来可在确定签名证书与发布渠道后添加签名验证的桌面自动更新。核心同步无需重新复制整个上游仓库。

## 0.1.1 桌面扩展

`integrations/` 是独立的 Cordis 插件，打包到 `resources/runtime/desktop-integrations`。启动时生成 `.desktop-integrations.json` 并通过上游 `--profile web --patch` 加载，不修改上游源文件或用户原有 profile patch。更新后的核心同样加载这层插件；缺少共享 MCP SDK 时启动验证会失败。

地区重试拦截 `llm/stream`，只处理无任何已发出流事件的精确地区错误，最多补试两次。每次补试都重新经过完整 waterfall，通过 AsyncLocalStorage 防止自身递归重试；不能重复调用 Cordis 的 `next()`，因为其监听器队列会被消耗。原请求消息和取消信号保持不变；已有输出、其他错误或取消不会触发补试。日志只包含补试序号与延迟。

搜索通过上游共享 MCP SDK 连接 `https://mcp.exa.ai/mcp?tools=web_search_exa`，将 `web_search_exa` 的结果转换为上游 `WebSearchResult`，保留来源 URL、标题和摘录；搜索内容沿用上游工具的外部不可信内容标记。桌面覆盖 `web.searchProvider` 为 `desktop-exa`，`fetchProvider` 仍为 `http`。不做 DeepSeek 付费回退。Exa 独立限流，失败明确报错。参考 https://exa.ai/docs/reference/exa-mcp 。
