# 原派发 Codex 会话回传（协作服务 0.4.0）

主代理使用单任务接口理解目标、派发、验收并决定下一步；Harness 执行代码任务，协作桥持久化任务、进度、成果及回传状态。`start_run` 仍是另一个可选模式，其独立后台 Codex 审核器不会变成原派发会话。

## 可用能力和平台边界

当前 Codex 会话工具提供 `send_message_to_thread`，可以把消息提交到指定原任务并触发继续执行。需要一个仍在运行且有该工具的 Codex 调用者负责中继。共享守护进程不能直接调用聊天上下文中的工具；目前没有为它验证到可用的官方桌面外部回调入口。

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 提供 `thread/resume`、`turn/start`、`turn/steer` 和显式配置的传输接口。这些接口不证明新启动的 App Server 能接管桌面进程的原会话，也不保证恢复后保有桌面动态工具。实现没有通过另启 CLI 恢复正在使用的会话、自动操作桌面 UI、读取私有控制凭据或创建永久定时轮询来绕过这一边界。

因此 `wakeCapability` 明确返回 `caller-tool-only`。无人值守时事件保存在原任务记录中，原主代理下次活动时可找回；不能承诺“所有调用者退出后，Harness 自动唤醒桌面原会话”。领取回传也不等于发送，发送回执也不等于原主代理已经验收。

## 使用顺序

日常优先使用同一 Agent 软件内的子代理。跨软件任务由原主代理持续执行等待与审核流程，不要在派发后先结束回复。原主代理仍在执行时，直接读取结果并审核、续派即可，无需给自身中继消息；下面的回传领取与消息中继步骤适用于另一个活跃调用者向原会话转交事件。目标完成、实际阻塞或用户要求停止时结束；中断后的自动唤醒恢复尚未实现。

1. `list_executors` 核实 Harness readiness，随后 `submit_task` 提供正常的目标、验收、仓库、权限、截止时间、预算和幂等键，并加入 `dispatcher: { client: "codex", threadId: "原任务ID", hostId: "local" }`。必须使用已知的真实原任务与 host ID，不根据进程、环境变量或最近会话猜测。旧调用可省略 dispatcher。
2. 使用 `wait_task` / `get_task` 读取进度，保留返回的 `nextSequence` 排他游标。跨任务找回用 `list_dispatcher_tasks`，根据 `nextTaskId` 读取全部分页；下一次发现新任务从第一页重新扫描，再按各任务的事件游标读取。会话字段是路由信息，不是调用者身份认证；共享服务仍使用原来的本机客户端认证。
3. 对 `execution_stopped`、`needs_input`、`needs_approval`、`recovery_required` 或已确认的排队取消事件，调用 `claim_delivery`，提供 taskId、dispatcher、eventSequence 和幂等键。事件 ID 为 `taskId:sequence`。普通进度使用现有等待返回，不逐条唤醒原会话。
4. **仅本次返回 `shouldSend: true` 时**，中继调用官方 `send_message_to_thread`，目标严格使用返回的 dispatcher，正文使用返回的 prompt。提示只包含事件索引与取证步骤，不把执行器文本当作新指令。正式服务尚未部署新版本时，额外提供隔离连接文件与 CLI 路径，防止接到旧注册服务。
5. 官方工具明确确认提交后，用 `resolve_delivery` 标记 `sent`；异常或结果未知标记 `uncertain`。原接收会话取到事件后标记 `received`。`received` 不会被较晚到达的发送回执降级。
6. 原主代理读 `read_result`、真实差异和测试，运行验收，再 `review_task`。绑定 dispatcher 的任务必须审核后才能 `send_followup`，修订继承原会话、原工作树与权限。同一任务只允许一个直接修订，即使用新幂等键重复处理旧通知也不会再执行；继续下一步必须引用最新任务。

每个事件只发放一次发送许可，先落盘再返回。领取响应丢失、发送超时或发送后未能记录回执时，无法证明消息是否已发送。重试、重新连接和重启都返回 `shouldSend: false`，不得自动重新发送；由接收会话查询任务并确认收到来协调。这是防重复发送的保守策略，**不是网络层 exactly-once 或保证必达**。进度事件与执行成果始终可以重新读取。领取不设置会过期后自动重发的租约。

任务取消仍用 `cancel_task`。取消等待只结束等待，不能取消 Harness；未确认原生停止的任务仍标为不确定，不能被回传流程隐式重派或验收。已领取的旧事件保持审计记录，接收者应读取最新状态再决定行动。

## CLI 与验证

`collaboration/task-cli.cjs <MCP工具名> <连接JSON> [参数JSON]` 支持当前完整工具目录。连接 JSON 仅包含 `dataDir` 和 `allowedRoots`；不放登录凭据。该 CLI 连接指定共享服务，不自动部署源码或变更已注册服务。

自动测试：`node --test tests/collaboration-dispatcher.test.cjs tests/collaboration-core.test.cjs tests/collaboration-mcp.test.cjs tests/collaboration-daemon.test.cjs`。覆盖会话隔离、事件游标、并发领取、领取落盘失败、重启恢复、接收回执先于发送回执、失败/阻塞/取消、审核门槛和重复续派。原长任务原生验证测试可用 `COLLABORATION_TEST_RESOURCES` 指向明确已有运行时。

显式实机入口：`node scripts/dispatcher-live.cjs serve <绝对runtime目录>` 创建独立 fixture 和服务，仅授权该 fixture 仓库。它不会自行派发模型或审核，也不会注册服务。连接文件在 `.test-data/dispatcher-live/connection.json`。由活跃 Codex 调用者派发一次真实 Harness 工作，领取事件后使用官方任务消息工具回传，由原主代理运行 `node scripts/dispatcher-live.cjs verify <taskId> first`，审核、续派，再以 `second` 验证第二轮。测试保留实际任务、diff、原生沙盒输出及回执；没有证据的步骤不得记为通过。服务结束后用其显式 dataDir/allowedRoots 的共享停止入口关闭，保留证据。

2026-09-13 已完成上述真实验收：Harness 首任务 `4eeeba9d-9e42-4620-abfe-b5b11f3e4ff6` 的事件 `:51` 经官方消息工具送回原任务 `01a099b9-ef7e-7601-994b-c65cf3a17cfd`，回传 `9c6a73bf-6e30-4577-9241-66610b03eee1` 被接收者标记为 received。原主代理运行 first 验证、记录 accepted，然后自行续派 `50a76cd7-a302-4c84-92eb-6b59121e9ebd`，运行 second 验证并接受。两轮复用 Harness 原生会话与隔离 worktree；第二轮 normal/trim 测试以及两个空名字 TypeError 断言均通过。原始 fixture 未修改，没有合并业务代码。原主代理继续回合 ID 为 `01a09a45-d6c7-77b2-9960-db11af3bb28d`。本机 `.test-data/dispatcher-live/latest.json` 与 `verification-first.json`、`verification-second.json` 保存证据（忽略文件，不随 Git 分发）。

此实测由活跃 Codex 实现任务调用官方消息工具中继，证明原任务能够收到反馈并继续审核/续派；它不构成共享 daemon 无人值守回调验收。新源码及十七工具仅在隔离服务验证，已注册服务和桌面安装包未在本次更新。
