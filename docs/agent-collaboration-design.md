# 跨应用 Agent 协作方案

目标：由用户指定的规划/审核 Agent 派发任务，让 DeepSeek Harness、ZCode 等软件中的原生 Agent 执行，再回传过程和可核验成果。优先使用各软件自己的工具、登录状态和模型通道，不把“调用同款模型 API”当成“调用这个软件的 Agent”。

本文保留设计边界。2026-09-13 已实现独立协作服务、共享后台、stdio MCP 和两个原生适配器，并注册本机 Codex MCP 配置。Harness 0.2.2 已正式安装，当前 Codex 任务已直接完成真实文件修改、审核测试、桌面同一 Agent 的同会话修订。ZCode 原资料＋明确 Flash 模型已进入原版 V4 轮次，但用户手动验证仍失败，原生新普通会话也不能直接回复，模型闭环未通过；当前用户优先要求完成 Harness 通信。使用方式见 [MCP 入口](collaboration-mcp.md)、[Codex 接入记录](codex-collaboration-connection.md)，实际边界见 [协作验收记录](collaboration-validation.md)。

## 已核实的接入条件

| 应用 | 证据 | 仍需验证 |
|---|---|---|
| DeepSeek Harness Desktop | 原生会话、文件工具、流事件、取消和安装版桌面同一 Agent 续接已实测；本机 NSIS 升级成功 | 真实越界审批、干净虚拟机完整安装验收 |
| ZCode | CLI 0.16.5 / 桌面 3.11.2，原资料＋Flash 已接原版 renderer V4、accepted 与 turn.started；帮助中的 `--max-turns` 实际不可用 | 官方新会话验证、真实写入及修订闭环 |
| ZCode MCP | 官方文档支持 stdio、HTTP、SSE MCP；可作为协作服务的工具使用方 | 不能据此推断 MCP 能主动创建其会话或唤醒空闲 Agent |
| 社区 ZCode ACP | `william0wang/zcode-acp` 已有桥接 ZCode app-server 的实现 | 这是社区适配；需核实版本兼容与授权许可后决定复用范围 |
| Codex 接入 | MCP 已注册，当前任务连接已恢复并直接完成安装版 Harness 链路 | 不支持轮次结束后自动唤醒 |

本机 CLI 入口是 `D:/Program Files (x86)/ZCode/resources/glm/zcode.cjs`。该路径只用于本机勘查，产品通过发现机制定位。原先只看帮助的记录已被实测更新：0.16.5 实际拒绝 `--max-turns`，`app-server` 需通过会话协议显式传递权限，不能沿用 headless 的隐式 yolo 默认。详细勘误和配置阻塞见 [ZCode 协议记录](zcode-protocol.md)。未读取或复制其登录凭据。

## 分层

1. **独立协作服务**：维护任务、执行器、事件、结果和持久化队列，不依赖某一个桌面 UI 才能运行。
2. **统一工具入口**：规划 Agent 通过 MCP 使用 `list_executors`、`submit_task`、`get_task`、`wait_task`、`read_result`、`send_followup`、`cancel_task`。
3. **应用适配器**：优先使用应用提供的 ACP、SDK、app-server 或结构化 CLI；每种应用实现相同任务生命周期。无可用接口的应用标为暂不支持，不用点击聊天框假装实现可靠通用协议。
4. **可选桌面面板**：DeepSeek 桌面端可展示队列和各软件的状态，也可独立提供管理界面；调度核心可抽成单独项目。

MCP 是 Agent 调用协作服务的工具接口，适配器负责驱动执行软件。支持 MCP 的应用不等于自动具备远程任务执行入口。

## 一次协作

用户给出目标 → 规划 Agent 拆分任务 → 服务选定执行器并创建隔离工作目录 → ZCode / Harness 执行 → 服务收集事件和文件证据 → 审核 Agent 读取结果 → 验收或发出修订任务。

规划、执行、审核是任务角色，不固定绑定品牌。首个场景由 Codex 规划和审核，Gemini/Harness 与 ZCode 执行；后续其他 Agent 也能调用同一组工具。

执行器是否支持后台运行、原生 GUI 可见会话、追加指令、取消、图片、工具审批、使用量统计，必须逐项声明并实测。尤其要区分“驱动该软件内核”与“控制已经打开的那个窗口”。

## 任务与结果

任务记录至少包含：唯一 ID、父任务 ID、幂等键、目标、验收条件、必要上下文引用、工作目录、基准提交、执行软件及可选模型、权限范围、截止时间和可执行的预算约束。

结果包含：执行摘要、真实改动/提交、测试命令与结果、产物路径、未完成事项、原生会话 ID、可按需读取的完整对话与事件。执行器声称完成只表示等待审核，不自动视为验收通过。

上下文默认传递任务所需的摘录和文件引用。完整对话保留用于审计，不把全部历史反复塞入每个模型；回传内容是工作证据，不得扩大任务权限。

## 稳定性与权限

- 代码写入任务默认各自使用独立 worktree，完成后审核差异；相同工作树上的并行写入须显式协调。
- 持久化 queued、running、needs_input、needs_approval、completed、failed、cancelled 状态；审核结论另存，避免混淆执行结束与质量通过。
- 执行租约、心跳、事件序号、取消回执和去重防止任务失联或重复派发。派发结果不明时先查询原生会话，不能盲目重发有副作用的任务。
- 模型登录状态和凭据留在各应用，由原生通道使用；协作服务不收集或复制其他软件的登录密钥。
- 每个执行器提供能力及可用性信息。额度只有在接口提供可靠数据时才用于自动路由；否则显示未知，允许用户手动标注偏好和预算，不把“额度多”当成无限使用授权。
- 任务指令必须限制委派深度和执行时限，防止软件互相循环派发。审批交给有权限的人或现有审批机制，不让执行器互相批准越权动作。
- 首版使用本机受控连接；如果开放 HTTP，必须有认证及客户端/工作目录限制。

## 最小可行版本边界

首版完成一条真实闭环：Codex 派发 → Harness 或 ZCode 原生执行 → 等待完成 → 返回改动和测试 → Codex 审核 → 一次定向修订。两种执行器共享任务接口，并验证取消、错误回传、进程重启后的状态恢复。

先验证 ZCode app-server 的只读握手和会话操作，再运行一次用户授权的最小任务；确认其使用原生登录/模型通道及会话可见性。不要先实现自动选模型、无限自治、跨机器调度或无条件自动合并。

## 来源

- ZCode MCP 官方文档：https://zcode.z.ai/en/docs/mcp-services
- 社区 ACP 适配器：https://github.com/william0wang/zcode-acp
- 社区协议记录（非官方稳定契约）：https://github.com/william0wang/zcode-acp/blob/main/docs/PROTOCOL.md
- 本机 `node "…/ZCode/resources/glm/zcode.cjs" --help`，2026-09-13。
