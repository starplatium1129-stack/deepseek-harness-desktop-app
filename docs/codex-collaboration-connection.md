# Codex 正式接入与本机验证

**当前状态（2026-09-13）：安装和当前任务通信均已通过。** 0.2.2 已正式安装；当前 Codex 直接派发任务 `12091a37-fbbe-43b4-a1de-993ea1a141f7` 并收到结果、审核测试，再于同一桌面原生会话执行修订 `8e144183-d94b-491c-90f3-14b894ce6ea3`，全部测试通过且修订已接受。当前工具连接可用，无需再次重连。具体证据见 [验收记录](collaboration-validation.md)。下文中的重连失败和便携版测试属于此前阶段记录。

2026-09-13 已通过 Codex 自带 `mcp add` 将 `agent-collaboration` 注册到本机用户配置，并用 `mcp get --json` 确认 enabled。入口使用项目内置 Node 与 `collaboration/cli.cjs --shared`；仅允许当前项目目录，启动超时 30 秒、工具超时 75 秒。其它配置行为及工具审批策略保持原样；Codex CLI 将已有的空 `args=[]` 规范为省略，两者含义相同。

本机配置文件为 `C:/Users/20864/.codex/config.toml`。修改前备份在同一私有目录的 `config.toml.before-agent-collaboration-1789268869993`，没有把用户配置或凭据存入项目。其它机器可运行：

```powershell
node scripts/connect-codex.cjs --dry-run
node scripts/connect-codex.cjs --install
```

脚本使用实际项目路径，不要求填写本机示例路径。只需已有 Codex 与本项目准备好的 runtime；不新增模型 API Key。

后续检查发现本机配置已由其他操作扩展到两个项目根目录，并切换为 `DeepSeek-Harness-Collaboration-Projects` 数据目录。本轮保留该配置，未移除新增项目；给新目录补齐此前已选择的 `zcode.profileMode: existing`，在认证状态确认无任务和无受管窗口后重载服务。旧目录的历史任务仍保留。旧 MCP 连接曾在服务更新后返回 `Transport closed`；后续当前任务连接已恢复，并完成本文顶部记录的直接验收。

## 已验证的是实际 Codex MCP 调用

`node scripts/codex-collaboration-smoke.cjs --live` 启动真正的 Codex App Server，读取已注册的服务器配置，通过 `mcpServerStatus/list` 和 `mcpServer/tool/call` 调用协作工具。验证使用 `ephemeral: true` 的内存协议会话，没有创建持久的侧栏任务，没有调用 `turn/start` 或 Codex 模型。

实际发现 8 个工具：`list_executors`、`submit_task`、`get_task`、`wait_task`、`read_result`、`send_followup`、`cancel_task`、`review_task`。Harness 任务 `898741a8-ae0c-4a1d-b542-f394e65d0e35` 与原会话修订 `d2189a25-f2a4-4bd5-b9c8-330388762725` 完成了真实文件修改及审核。两轮各 2 项测试通过，修订另通过 2 项空名字断言。证据在 `.test-data/registered-codex/harness-live.json`。

真实 Codex 的首次自动启动还发现了普通 detached 子进程会被客户端清理连带结束的问题。Windows 共享后台现在由**当前用户已经运行的 Explorer 桌面**以隐藏窗口正常启动；不提升权限、不注册服务、计划任务或开机启动项。私有 named pipe 使用双向 HMAC 认证，密钥不跨管道；每个客户端的目录白名单必须与服务拥有者完全一致。客户端退出不取消已派发任务，显式 `cancel_task` 才请求取消；无客户端、无任务时默认 5 分钟退出。

另一次真实验收中，Codex A 派发 Harness 任务后退出整个 A App Server，Codex B 仍成功等待完成并审核接受；任务只修改隔离目录的 `hello.txt`，原始仓库未改。任务为 `7675006e-9250-4368-8374-b3d9781977f5`，原生会话为 `collaboration-70bbc7d3-5c21-4efd-aa60-b6dcfb93b544`。相关回归位于 `tests/collaboration-daemon.test.cjs`；真实模型测试须明确开启环境开关，不随普通测试消耗额度。

## 当前 Codex 任务已加载八个工具

本轮已在当前 Codex 任务直接调用八个工具中的派发、等待、读取结果、审核、修订和取消接口。Harness 任务 `c148910f-f69e-45da-a2ac-b84cfa5fb010` 真实修改 `greet.cjs`，审核端运行原测试，2 项通过。证据在 `.test-data/direct-mcp/latest.json`。这不再只是独立 App Server 的验证。

实际使用同时发现：用户在桌面查看原生会话后，Web controller 会持有该 Agent 的写句柄，独立 SDK 修订 `e189aa6b-6e31-434b-a414-fcb883549e63` 因此未派发。新增 [桌面协作桥](harness-desktop-bridge.md) 将请求送入同一 Web Core，并复用同一个 Agent。0.2.2 便携桌面已完成真实任务 `9726c3b6-836b-4291-a4e6-8ae0851e66d9` 和原会话修订 `7c1b26c8-ce18-4ae0-91ac-9adae6a2a822`，审核端两轮原测试及空名字断言全部通过，修订已 accepted。两轮使用同一桌面子进程和同一原生 Agent。

新注册或变更 MCP 配置时仍须检查实际工具目录。当前 Windows 桌面 App Server 使用私有 stdio；MCP 设置页的 **Restart** 可能中断同一主机当前运行的 Codex 任务，应等任务结束后操作。不能把独立进程成功等同于已打开任务热重载。

依据：[官方 MCP 配置说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[官方 App Server](https://learn.chatgpt.com/docs/app-server)，以及本机 Codex CLI 帮助、生成的 App Server 协议和桌面已发布源码。

## ZCode 状态

ZCode 的原生登录通道已经定位，用户在原窗口可以正常聊天。独立窗口的正确 V4 请求已收到 accepted 和 turn.started，但用户手动验证仍失败，原版 SDK 最后在 120 秒后超时；真实修改/审核/修订闭环尚未验收。前一次数据库外键错误已通过原生日志定位，并按原版 `persistence: 'deferred'` 创建流程修复。这些是不同问题，不能把官方验证失败说成用户没有及时操作。

本机服务设置已选择 `zcode.profileMode: 'existing'`，位于服务数据目录的 `executors.json`。当前任务已实际启动原资料窗口并收到原生 turn.started。任务 `7a59d68c-7668-4d70-bcca-6455089ef4dc` 在用户报告验证失败后，经原生 stop 确认取消，窗口保留，没有文件改动。没有复制 Cookie 或登录文件。原资料模式仅允许共享后台管理长连接；已有普通主进程时要求正常退出，不会关闭它；任务结束或客户端断连继续保留受管窗口。

用户随后确认普通会话使用 **GLM 5.3 Flash／体验套餐**。源码发现省略模型的协作入口选到了列表首项 GLM-5.3，和 UI 保存选择不一致。新代码在原生 renderer 内解析保存的 UI 模型偏好，显式选择仍优先；runtimeModel 保持在原生进程内。显式 `builtin:zai-start-plan/GLM-5.3-Flash` 任务 `1c2bf61c-a050-49b7-b00e-571f1f09053b` 被窗口交接守卫挡住，尚未调用 Flash，不能称为 Flash 验证失败。守卫将自身 CLI 子进程误判为额外窗口的问题亦已修复。

最新原资料 Flash 任务 `5159742a-9a78-4d69-a986-48b454f705ec` 已确认正确 provider/model，收到 accepted 与 turn.started。用户手动验证仍失败，原生 SDK 在 120 秒后超时，无文件改动。用户随后在保留的原版窗口手动新建同模型普通会话，也确认无法直接回复。已停止继续触发验证；[本地反馈草稿](zcode-verification-feedback.md) 未向外部发送。不能再将此问题只归因为模型选择错误，也不能据此推断整个账号不可用。

需要交接时，先结束并保存 ZCode 中的任务，再从应用/托盘正常退出。受管窗口的私有管道由后台维持，不能强制结束后台来重载代码。共享服务提供经过认证的 `--shared-status` 和 `--shared-restart`；仅在无执行、无队列、无请求、无受管原生窗口时允许安全重载。

验证过程的 `--isolated` 只对独立验证 App Server 覆盖服务数据目录，不改用户 Codex 配置；其任务和浏览器资料位于独立 `verification` 子目录。Windows MSIX 文件路径会解析到 Codex LocalCache，实际路径以报告和 `executors.json` 写入结果为准。原版应用资料仍由原版程序按自身默认环境使用。

不能用更换模型 API 或代答验证码冒充完成。具体接口与最新状态见 [ZCode 协议](zcode-protocol.md) 和 [Renderer 协议勘查](zcode-renderer-protocol.md)。
