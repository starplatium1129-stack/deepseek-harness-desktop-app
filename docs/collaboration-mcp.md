# Agent 协作 MCP 入口

协作服务通过本机 stdio 暴露任务工具，由调用它的规划 Agent 派发、等待、审核，再定向修订。调度入口独立运行，不提供 HTTP，启动入口本身不修改客户端配置或提交模型任务。`scripts/connect-codex.cjs --install` 是单独的、显式注册 Codex 配置的操作，本机已执行并保留备份。

实现位于 `collaboration/core.cjs`、`collaboration/adapters/`、`collaboration/mcp.cjs` 和 `collaboration/cli.cjs`。原始边界见 [协作设计](agent-collaboration-design.md)。协议服务版本独立记录为 `0.3.0`；桌面版与各原生执行器的版本分别维护。

0.3.0 另外提供 start_run、list_runs、get_run、wait_run、pause_run、resume_run 六个长任务工具，总计十四个。后台 Codex 可持续审核和续派，不依赖当前聊天保持活动；具体参数、验证方式及恢复边界见 [长任务闭环](long-running-collaboration.md)。原八个工具仍管理单次执行，不能把 submit_task 当成自动项目循环。

## 启动和连接

在源码目录检查入口和执行器可用性：

```powershell
node collaboration/cli.cjs --help
node collaboration/cli.cjs --allow-root D:\code\Deepseek-harness-destop --list-executors
```

已有准备好的运行时可用 `runtime/node/node.exe` 代替 `node`。至少提供一个明确的绝对路径 `--allow-root`，可以重复传递；服务拒绝省略根目录或使用相对路径。只有允许目录内的仓库可接收任务。执行器还会核验原生权限模式，声明的工作目录限制不能代替操作系统沙箱。

当前协作服务创建和审核 worktree 时仍需要 `git` 位于 PATH 中；内置 Node 不包含 Git。普通桌面日常启动与这项开发者协作入口的依赖不同，尚不能把源码服务启动视为无开发环境的分发包验收。

正常服务启动后等待 MCP 输入：

```powershell
node collaboration/cli.cjs --allow-root D:\code\Deepseek-harness-destop
```

正式 Codex 配置使用共享模式：

```powershell
node collaboration/cli.cjs --shared --allow-root D:\code\Deepseek-harness-destop
node collaboration/cli.cjs --shared-status --allow-root D:\code\Deepseek-harness-destop
```

Windows 由已有的同用户 Explorer 桌面隐藏启动后台进程，以独立于 MCP 客户端的生命周期运行。named pipe 双向认证，密钥只存于用户私有 `ipc/owner.json`，不在管道上传递。关闭一个 MCP 客户端不会取消任务；没有客户端、任务或受管原生窗口时默认闲置 5 分钟退出。`--shared-stop` 要求客户端与任务均结束；`--shared-restart` 可关闭空闲客户端，但任何 active、queued、inflight 请求或持久原生窗口都会阻止它。旧驻留版本不认识新管理命令时会明确报错，不强杀绕过保护。

CLI 默认数据目录是 `%APPDATA%/DeepSeek-Harness-Collaboration`；无 `APPDATA` 时使用 `XDG_STATE_HOME` 或 `~/.local/state` 下的同名目录。可用 `--data-dir <绝对路径>` 覆盖。任务数据和工作目录独立于桌面应用配置，升级入口文件不得清理此目录。同一数据目录供一个服务实例使用。

本机客户端注册现状（2026-09-13）：Codex 在 `~/.codex/config.toml` 注册 `agent-collaboration`（见 [Codex 接入记录](codex-collaboration-connection.md)）；ZCode 桌面端已在用户级 `~/.zcode/cli/config.json` 的 `mcp.servers.agent-collaboration` 注册同一共享服务，stdio、`enabled: true`、`timeoutMs: 60000`，`--data-dir` 使用守护进程实际的 Codex MSIX `LocalCache/Roaming/DeepSeek-Harness-Collaboration-Projects` 物理路径、allow-root 双目录与 Codex 一致，保证三个客户端连到同一服务实例和同一份 `executors.json`。已按注册条目实测握手、`tools/list` 8 工具与 `list_executors`：harness available，zcode available 且 readiness 为 `native-window-handoff-required`。ZCode 配置 schema 严格，未知字段会被丢弃；新会话启动时自动连接，工具以 `mcp__agent-collaboration__*` 形式出现。注意 Codex MSIX 虚拟化会重定向 `%APPDATA%` 写入，后续把数据目录迁出该路径时需同步更新两个客户端注册。

支持 stdio MCP 的客户端可手动添加以下示例；路径应替换为实际安装位置。此文只给出配置内容，不自动写入用户配置：

```json
{
  "mcpServers": {
    "agent-collaboration": {
      "command": "D:/code/Deepseek-harness-destop/runtime/node/node.exe",
      "args": [
        "D:/code/Deepseek-harness-destop/collaboration/cli.cjs",
        "--shared",
        "--allow-root",
        "D:/code/Deepseek-harness-destop"
      ]
    }
  }
}
```

`--help` 输出使用说明并退出；`--list-executors` 输出 JSON 并退出，此检查模式不读取或恢复历史任务、不取得数据锁，即使存在 queued 任务也不会执行。正常服务模式的 stdout 只有协议消息，诊断写 stderr。独占模式在客户端关闭 stdin 时结束执行器连接；共享模式只断开当前连接。持久化任务按核心恢复逻辑处理。

原版 ZCode 资料模式仅允许共享后台托管，任务结束不会关闭用户原窗口；用户自己正常退出 ZCode 后才允许后台安全退出。原生窗口与私有控制管道存在生命周期关联，不能将强杀后台等同于正常退出。

## 工具和调用约束

| 工具 | 用途与关键参数 |
|---|---|
| `list_executors` | 查看执行器、可用性、能力和限制；不提交任务，不推测未知额度。 |
| `submit_task` | 必填 `executor`、`goal`、`acceptance`、绝对 `repository`、`permission`、`deadlineAt`、`budget`、`idempotencyKey`。可选 `context`、`baseCommit`、`parentTaskId` 和原生 `model`。 |
| `get_task` | 通过 `taskId` 读取状态；`afterSequence` 为排他事件游标，`limit` 最多 500。 |
| `wait_task` | 通过 `taskId`、`afterSequence` 等待后续变化；`timeoutMs` 为 0–60000，省略为 30000。返回 `nextSequence`，下次等待使用它。 |
| `read_result` | 读取结果证据；`offset`、`nextOffset` 为字符游标，`limit` 最多 64000。 |
| `send_followup` | 必填 `taskId`、`goal`、`idempotencyKey`；可提供新验收条件、时限、预算。保持原仓库和权限边界。 |
| `cancel_task` | 请求原生执行器取消指定任务，读取回执和最终状态；只管理本服务拥有的执行。 |
| `review_task` | 审核实际证据后，记录 `accepted` 或 `changes_requested`，并给出 `note`；不自动合并代码、不批准越权操作。 |

`permission` 只能为 `read-only` 或 `workspace-write`。`budget.maxTurns` 为 1–50，或者显式 `null`：后者表示允许只用截止时间限制执行，供无法可靠限制轮次的执行器使用；服务不得偷偷把轮次预算降级。`deadlineAt` 是带时区的 ISO 时间，必须在未来一小时内。`acceptance` 和 `context` 各最多 30 条。`context` 每条至少包含文件引用 `path` 或相关摘录 `excerpt`。

代码任务基于明确的 Git 基准提交，在独立 worktree 中执行，省略 `baseCommit` 时核心解析当前 `HEAD`。重复提交相同幂等键不会再次派发；不确定响应是否收到时先使用相同键重试或查询任务，不能另造一个键直接重做。

worktree 不包含源仓库未提交的改动。原任务及修订的文件差异保存到各自证据目录；普通新文件另存快照，疑似凭据文件仅记录哈希。当前不会自动删除工作目录或审计数据。普通子任务不得放宽父任务的时限、步数预算或权限；定向修订是规划端显式发起的新任务，可提供新的有限时限和预算。

Windows 安装目录中的独立入口为 `resources/runtime/collaboration/cli.cjs`，使用同级 `resources/runtime/node/node.exe` 启动；使用说明随包放在 `resources/runtime/collaboration/docs/`。源码入口与分发入口均使用相同实现。

建议调用顺序：`list_executors` → `submit_task` → `wait_task` / `get_task` → `read_result` → 检查真实差异与测试 → `review_task`。需要修订时记录 `changes_requested`，再用 `send_followup` 定向修改，并检查它返回的新任务信息。

任务的 `completed` 表示执行结束，验收结论单独记录。原生 Agent 返回的文本、事件、文件证据均按不受信任内容处理，不能扩大原任务权限。MCP 等待调用只在客户端仍有请求时返回结果，不承诺当前规划 Agent 结束一轮后自动唤醒。

## 协议范围

本实现支持 `2024-11-05`、`2025-03-26`、`2025-06-18`、`2025-11-25` 的 initialize 握手及工具子集。客户端提议未实现的版本时，服务返回 `2025-11-25` 供其决定是否继续；不宣称实现 2026 年协议的新握手。

消息为 UTF-8 JSON-RPC，每行一个消息，stdio 无额外标题。客户端先发送 `initialize`，收到结果后发送 `notifications/initialized`，然后使用 `tools/list`、`tools/call` 或 `ping`。只声明工具能力，不声明资源、提示词、采样、通知订阅或 MCP task 扩展。此处协作任务是工具管理的业务对象。

输入帧上限 1 MiB，响应上限 4 MiB；超大输入会报协议错误并关闭连接，超大结果提示缩小分页。普通在途调用最多 64 个，为显式任务取消保留 4 个额外位置。各请求独立运行，长等待不阻塞查询和取消。

客户端发送 `notifications/cancelled` 取消一个 `wait_task` 请求时，只结束等待。执行中的原生任务必须由明确的 `cancel_task` 取消。错误参数和执行失败返回 `isError: true`；无效 JSON、未知方法或工具使用 JSON-RPC 错误。较新协议的对象结果同时提供 `structuredContent` 和序列化文本，老协议保留文本结果。

依据：[stdio 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[工具](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[请求取消](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)。实现只使用 Node 内置库，没有间接依赖开发环境中的 MCP SDK。

## 验证入口

```powershell
node --test tests/collaboration-mcp.test.cjs
```

测试覆盖真实 Node 子进程的初始化、工具列表和调用，并验证长等待同时取消、传输取消不取消原生任务、权限/预算参数校验、UTF-8 分片、错误回传、帧和输出大小限制、旧版协商、CLI 明确根目录及无任务检查模式。协议测试使用可控执行器，不消耗模型额度；它不能替代各原生执行器的真实任务、取消和定向修订验收。
