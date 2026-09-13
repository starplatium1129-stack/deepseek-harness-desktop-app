# Agent 协作首版验收

日期：2026-09-13。本记录保留历史验收，并记录桌面及协作服务 0.2.2 的接入增量。Harness 0.1.5-rc.1，ZCode 桌面 3.11.2 / CLI 0.16.5。实现、真实原生验证和仍未验证的能力分别标记。

## 0.2.2 已安装版本与当前 Codex 任务验收

本机安装已于 2026-09-13 完成，安装器返回 0。注册版本和 exe 均为 0.2.2，实际运行路径为 `C:/Users/20864/AppData/Local/Programs/DeepSeek Harness Desktop/DeepSeek Harness Desktop.exe`，app.asar SHA-256 与已验证的分发目录相同。主进程由现有 Explorer 启动，原有 Roaming 数据、模型配置及会话继续使用。

本次由**当前 Codex 任务提供的正式 MCP 工具**直接验收，没有另起 Codex 验证进程：

- 首轮 `12091a37-fbbe-43b4-a1de-993ea1a141f7` 完成 greet.cjs 的 trim 修改；Codex 读取结果和 diff，运行原测试，2 项通过。
- Codex 记录 changes_requested，再派发修订 `8e144183-d94b-491c-90f3-14b894ce6ea3`；原测试 2 项及空名字 TypeError 断言 2 项全部通过，记录 accepted。
- 两轮均为 `nativeDesktop:true`，使用安装版 Web 子进程 PID 24864（桌面主进程 39660），原生会话相同：`collaboration-0d87fa79-d6bb-4771-8391-32dbbeb1c759`。
- 只有隔离 worktree 中的 greet.cjs 改动，原 fixture 保持原样，未自动合并。证据为 `.test-data/installed-direct-mcp/final.json`。

安装失败原因也已收敛：注册项指向旧 Community 0.1.0，而不是旁边未注册的 0.2.0。旧卸载器无法访问其中 261 字符的路径；经同 NSIS 只读诊断确认，使用原目录现有短别名可以访问。备份注册项并修正 InstallLocation 后，官方卸载和安装流程成功完成。详情见 [旧版升级故障](windows-legacy-upgrade.md)；没有删除用户数据或修改 Windows 安全策略。

当前 Codex 工具连接已恢复，不需要为了这次通信再次重连。本轮按用户要求只继续安装和 Harness 通信；ZCode 未继续派发或验证。以下保留此前诊断历史，不代表当前安装状态。

同一时段，ZCode 桌面会话作为**规划与审核端**完成首条真实 MCP 闭环（ZCode → Harness 执行器）：通过新注册的用户级 `~/.zcode/cli/config.json` MCP 工具派发 trim 任务 `fc40ea5d-5f0d-4a94-8d6d-a680f5489d4f`（fixture `8f7a78e6` 基准 `771dfac`），约 15 秒完成，同样经桌面原生桥（nativeDesktop，Web PID 24864）在原生会话 `collaboration-42377572-701f-4de1-a5c3-3f88d27cbaba` 内以 `easycli-antigravity / gemini-3.8-flash-high` 执行。审核端（ZCode）在该工作区实际运行 `node --test greet.test.cjs` 2 项通过、diff 仅 greet.cjs，记录 `changes_requested`；`send_followup` 修订 `0609968b-05c5-422f-b8e1-9a0e3167a417` 在同一原生会话第 2 轮续接完成，复审原测试 2 项通过、`''`/`'   '` TypeError 断言通过，记录 `accepted`。原始 fixture 仓库未改，改动留在隔离 worktree 未合并。至此 ZCode 与 Codex 两个规划端都能驱动同一桌面 Harness；ZCode 作为执行器的交接复测仍待用户退出 ZCode 后进行。

## 0.2.2 安装修复前记录

最终 `npm test`：162 项通过、0 失败、1 项可选实机检查跳过；日志为 `.test-data/collaboration-tests-0.2.2.log`。包含真实 Web Core＋认证管道＋受控模型流的三轮文件工具测试；受控流不是模型实测。离线集成 smoke 同时核对原生插件加载、当前 PID 认证和退出清理，旧桌面壳只传 runtimeRoot 的配置也通过。

真实桌面模型闭环已通过，使用 **0.2.2 便携分发程序**打开用户原有数据，通过真实 Codex App Server 调用当前注册的 MCP（无 Codex 模型轮次、无持久侧栏任务）：

1. `9726c3b6-836b-4291-a4e6-8ae0851e66d9` 修改 `greet.cjs` 使名字先 trim，审核端实际运行原测试，2 项通过。
2. 记录 changes_requested；定向修订 `7c1b26c8-ce18-4ae0-91ac-9adae6a2a822` 在同一会话中加入空白名字 TypeError。
3. 修订原测试 2 项通过，另 2 项空白名字断言通过，审核为 accepted；只有 greet.cjs 改动，原始仓库未改，未合并。
4. 两轮均记录 `nativeDesktop:true`、同一桌面 Web PID 30848、同一原生会话 `collaboration-9cc86632-3170-4b0b-a1e7-ed727febe253`。没有为修订另起 SDK 持有写锁。桌面主进程 PID 9284 由已有 Explorer 启动，验证进程退出后仍在运行。

报告：`.test-data/registered-codex/harness-live.json`。当前聊天在后台更新后仍需重连 MCP；不能把上述独立 App Server 实测说成当前旧连接已恢复。

此前在已安装的旧桌面壳中，任务 `afae4b42-6138-4f9c-bb2b-9ef4499c50a6` 已写入 trim 改动、审核端 2 测试通过，但整个桌面在第 6 模型步骤中退出。用户报告程序崩溃；对应 Windows Application 日志没有 1000/1001 事件，暂未定位原因。该任务保留 dispatchUncertain，未重派或冒充完成。新版增加脱敏 lifecycle 日志；后续成功运行不能证明旧退出原因已经修复。

ZCode 原资料＋显式 GLM 5.3 Flash／体验套餐任务 `5159742a-9a78-4d69-a986-48b454f705ec` 的 accepted 和 turn.started 成功；原生归因确认模型身份正确。用户手动滑块仍失败，SDK 120 秒后超时，无文件改动。用户手动新建同模型原生普通会话也不能直接回复，已停止继续派发。ZCode 真实修改／审核／修订仍未通过，[反馈草稿](zcode-verification-feedback.md) 仅存本地。

2026-09-13 晚间实机状态核查：用户当前 ZCode 原生窗口已恢复正常模型对话（本机 GLM 5.3 Flash 轮次真实成功），此前"手动新建会话也无法回复"的验证码风暴已解除；这只恢复必要条件，不构成 ZCode 执行器验收。共享守护进程（PID 18576，数据目录实际位于 Codex MSIX `LocalCache/Roaming/DeepSeek-Harness-Collaboration-Projects`）存活、无活动任务、未持有受管 ZCode 窗口；经共享 MCP 实测 `list_executors` 返回 zcode `readiness: native-window-handoff-required`，当前门槛只是用户正在运行的 ZCode 主进程待交接。复测材料齐备：fixture `8f7a78e6` 仓库停在干净提交 `771dfac`，上次任务的 `workspace-write`＋显式 Flash＋`maxTurns: null`＋约 300 秒截止可直接沿用，派发时换新幂等键。

分发：生成本地 `release/DeepSeek-Harness-Desktop-0.2.2-Setup.exe`，未发布。最终便携分发程序在 C 用户临时数据目录、PATH 只有 Windows 系统目录的条件下两次启动到 ready，认证桥 PID 与桌面子进程一致，标记文件保留，退出后管道和入口释放。记录 `.test-data/packaged-collaboration-smoke.json`。发现并修复了 powershell.exe 依赖 PATH 的问题。

**本机静默升级未完成**：安装器退出码 2，用户看到安装错误后关闭，未保留错误文字；已安装 exe 仍为 0.2.0。原壳备份在 `.test-data/desktop-shell-before-0.2.2`，旧 0.1.1 安装包仍保留。当前实际运行的是上文已验证的 0.2.2 便携程序，继续使用原数据。没有在干净虚拟机完成安装验收，Git 仍为协作 worktree 的外部依赖。

## 0.2.1 正式接入增量

最终代码检查：`npm test` 126 项通过、0 失败、1 项可选实机检查跳过；随后显式开启 `COLLABORATION_CODEX_INTEROP_TEST=1` 单独运行真实 Codex 首启/多客户端测试，1 项通过，未调用 ZCode 或模型。新增原资料长连接模式只经过 fixture 验证，真实交接尚待用户操作。

`npm run dist` 已生成本地 `release/DeepSeek-Harness-Desktop-0.2.1-Setup.exe`，未发布。分发目录 11 个协作模块逐字节匹配源码；新版桌面程序在独立测试数据目录、仅有 Windows 系统 PATH 时启动到 ready，版本为 0.2.1，Harness 为 0.1.5-rc.1。没有在干净虚拟机安装验收，也没有声称 ZCode 真实闭环已通过。

- 已注册本机 Codex MCP 并保留私有配置备份；真实 Codex App Server 发现并调用 8 个工具，Harness 完成修改、测试、审核及原会话修订。已有 Codex 任务仍需重连后加载新工具目录。
- 共享后台支持同一用户多个客户端，客户端退出不取消任务；真实验收在发起 Codex 退出后，由另一个 Codex 等待 Harness 写入完成并审核通过。
- Windows 共享进程经当前用户已有桌面正常隐藏启动，named pipe 双向认证。不会提升权限或注册系统服务、计划任务、开机启动项。
- ZCode 已接原版完整 renderer、私有 CDP 管道和 V4 原生发送。首次输入的数据库外键错误已按原版 `persistence: 'deferred'` 修复；后一次请求正确进入轮次，最终因原版验证码 120 秒超时失败。用户确认可见验证码且手动操作后仍失败，不能归因为没有及时操作。
- 独立资料窗口不再反复重试。已准备原版资料长连接模式，任务结束、客户端断连或闲置不会关闭原窗口；当前尚未在用户原资料上启动或验收模型。需要用户正常退出原 ZCode、重连 Codex 后交接验证。不能保证该环境调整能解决官方验证拒绝，也不能代答或绕过验证。

详细配置、真实任务 ID、测试记录和交接步骤见 [Codex 接入记录](codex-collaboration-connection.md) 与 [ZCode 协议](zcode-protocol.md)。以下是此前 0.2.0 的历史检查；其中未注册 MCP、独立 CLI 配置缺失等描述不代表当前进度。

## 已完成

- 独立本机服务及八个 stdio MCP 工具；明确目录白名单，无 HTTP、自动合并或客户端配置修改。
- 持久化任务、顺序事件、原生会话检查点、幂等去重、租约心跳、取消请求与执行结束回执。原生检查点落盘后才允许提交模型任务。
- Git worktree 隔离；跟踪改动保存为 patch，新文件记录路径、大小和 SHA-256；每个任务的审核结论独立于执行状态。执行器报告的测试不被冒充为服务核验。
- 同一工作目录修订串行执行，继承原生会话及权限；委派深度最多 4，执行时限最多一小时。服务中断后不盲目重派未知任务。
- Harness 调用原生 Cordis AgentRegistry、原生模型配置和凭据服务；ZCode 使用实际 app-server 协议。协作层没有直接实现模型 API 客户端或复制应用密钥。

## 真实 MCP 文件修改闭环

使用 `node scripts/collaboration-smoke.cjs --live`，由审核端创建独立的小型 Git fixture，通过真正的 stdio MCP 子进程派发至 Harness。模型走用户已有原生配置 `easycli-antigravity / gemini-3.8-flash-high`。

1. 任务 `3019e4fe-8f84-4751-a8ca-d1c858125973` 修改 `greet.cjs`，使名字先 trim；审核端实际运行 `node --test greet.test.cjs`，2 项通过。
2. 审核端记录 `changes_requested`，提出空白名字抛出 TypeError 的定向修订。
3. 修订任务 `7d98a4d0-ab4d-4506-a3bb-4dbabf5e16ad` 通过新 worker 续接同一个原生 session，修改代码。
4. 审核端再次运行原测试，2 项通过；另执行空字符串、纯空白字符串的 2 项 TypeError 断言，均通过；记录 `accepted`。
5. 原 fixture 仓库文件保持原样，真实差异位于隔离 worktree，未合并。

本机报告为 `.test-data/collaboration-live/latest.json`（含测试命令、实际输出、任务 ID、原生 session 和证据路径，不提交完整对话到 Git）。审计数据位于报告中记录的独立 service 目录。

首次尝试的修订在 6 个模型步骤后被预算钩子停止，按失败记录，并保留已经产生的文件改动。随后将验证脚本的修订预算明确设为 10，重新完成以上整条闭环；没有把被预算停止的任务计为完成。`--live` 会真实使用原生模型额度，普通 `npm test` 不运行它。

## 自动检查和边界

最终 `npm test`：77 项通过，0 失败、0 跳过；`git diff --check` 通过。

`npm test` 覆盖协调核心、真实 stdio 子进程握手/并发取消、两个原生适配器的协议与错误处理，以及原桌面启动、凭据脱敏、更新回退和搜索重试回归。适配器 fixture 测试不能替代真实软件测试。

Harness 空白 home 的真实运行时检查正确返回缺少凭据错误。真实应答、同会话续接、文件写入和模型步数停止均已验证。人工审批走停止并报告机制，没有自动授权入口。

真实取消检查在原生 session 检查点落盘后触发 AbortSignal：返回 `CANCELLED`，服务拥有的 worker 以退出码 0 结束，记录到的 `turn/start` 和 `assistant/message` 均为 0，没有派发模型 prompt。首版执行器仅提供文件工具，shell、后台作业、网页、MCP 和递归委派工具不向模型开放；测试由审核端运行。

ZCode 实机 `session/list` 成功；`session/create` 返回 `model_config_missing`，服务准确记录 `needs_input`，没有发出模型 prompt。其真实写入、模型通道、取消及修订闭环仍需原生 CLI 配置就绪后验证。帮助页中的 `--max-turns` 不可执行，因此只有显式 `budget.maxTurns: null` 才授权以硬截止时间运行；不会自动放宽数字预算。

## Windows 分发检查

`npm run dist` 成功生成 `release/DeepSeek-Harness-Desktop-0.2.0-Setup.exe`（本地产物，未发布）。协作源码、原生 worker、许可证和说明文档随 `resources/runtime/collaboration` 分发。

`node scripts/collaboration-smoke.cjs --live --packaged` 使用分发目录的 **内置 Node 和协作入口**，在最终文件工具白名单与版本检查启用时重新完成全部原生闭环。任务为 `d584ddcd-9622-4786-8626-057e135c9eee` 和修订 `26182b1d-bf6c-43f5-a5df-ca60bf2bd6de`；两轮各 2 项测试通过，修订另有 2 项 TypeError 断言通过。实际 Git 差异只包含 `greet.cjs`，测试文件未改，原始仓库未改。最新本机报告记录这次分发检查。

另用 Playwright 启动 `release/win-unpacked/DeepSeek Harness Desktop.exe`，数据目录为独立测试目录，PATH 仅含 Windows 系统目录；状态为 `ready`，桌面版本 `0.2.0`，核心 `0.1.5-rc.1`，管理页未暴露 Node require。此项验证的是桌面分发程序启动，不代表在干净虚拟机安装并验收了 Git 依赖的协作服务。

## 0.2.0 时的验收限制

- 本轮未向任何用户 MCP 客户端注册服务；接入路径见 [MCP 文档](collaboration-mcp.md)。CLI 随 Windows runtime 打包；安装包的普通桌面功能与协作服务的验证分开记录。
- 创建 worktree 需要 PATH 中的 Git，尚未给协作功能分发独立 Git。未在无开发环境机器上验证这项新协作功能。
- Harness 与 ZCode 的已打开 GUI 会话可见性未验证；当前驱动的是各应用原生内核。
- 服务重启后，queued 任务可继续；带执行租约的中断任务转为 `needs_input` 并标注 `dispatchUncertain`。查看原生会话及改动前不能重派或伪造取消回执。未实现自动重连运行中的原生任务。
- `needs_approval` / `needs_input` 没有代替用户作答的端点。已确认停止且非 uncertain 的任务可先取消记录，再由规划端提交明确修订；不要将未知派发当成普通失败重试。
- 服务不订阅客户端轮次结束后的唤醒，不自动选模型、不跨机器、不自动合并。MCP 只实现文档列明的协议工具子集。
- 原生文件工具权限、预算步数和截止时间不能被理解为固定费用上限。额度未知时不自动路由。
