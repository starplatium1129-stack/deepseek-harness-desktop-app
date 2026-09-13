# Harness 原生协作适配器

适配范围：当前锁定的 `@deepseek-ai/dsh 0.1.5-rc.1`、内置 Node 24.18.0。入口是 `collaboration/adapters/harness.cjs` 的 `createHarnessAdapter(options)`。上游协议调查和实现依据均来自内置对应版本的包源码；没有修改上游文件。

`describe()` 与每次执行前都会读取选定运行时的公开 `@deepseek-ai/dsh/package.json`，只允许明确验证过的版本列表（当前仅 `0.1.5-rc.1`）。桌面更新到尚未验证的版本后，协作执行器会报告不可用及实际版本，不会沿用旧版兼容性承诺直接执行；重新验证后才能扩大列表。

## 原生执行与集成

适配器启动内置 `dsh --profile sdk --patch <临时覆盖文件>`，在 SDK profile 中禁用其范围较窄的 JSON-RPC server，挂载 `collaboration/harness-worker.cjs` Cordis 插件。插件调用原生 `ctx.agents.create/resume`、`agent.followup/whenIdle/cancel`、`ctx.sessions.flush`。模型选择使用 `agentDefaultModel.currentSelection()` 和 `installModelSelection`，模型请求、插件工具、沙箱和持久化均由原生 Harness 处理，没有另写模型 API 客户端。

主进程或独立服务传入：

```js
createHarnessAdapter({
  nodePath: '.../runtime/node/node.exe',
  runtimeRoot: '.../versions/0.1.5-rc.1',
  harnessHome: '.../deepseek-harness-desktop/harness-home',
});
```

运行目录必须包含 `adapters/harness.cjs` 和其上一层的 `harness-worker.cjs`；打包为 `runtime/collaboration` 可保持该关系。直接构造适配器时也支持 `COLLABORATION_HARNESS_NODE`、`COLLABORATION_HARNESS_RUNTIME`、`COLLABORATION_HARNESS_HOME`，未指定 home 时遵循 `DSH_HOME`，然后回退 `~/.dsh`。独立服务应显式传入桌面当前 home 和版本路径，避免误用空白 CLI 配置。

配置由原生 `$DSH_HOME/settings.yaml` 和凭据服务加载。临时覆盖文件只有模块路径、权限和工作目录，不含模型登录信息或密钥。适配器不复制 `.credentials.yaml`，不读取或解密桌面的 `credential.bin`。`extraEnv` 是桌面主进程已经获得凭据时的可选启动环境入口；不得持久化或显示其内容。原生 stdout/stderr 不转发，结构化事件进入协作服务的脱敏持久化层。

## 权限、生命周期与能力边界

| 能力 | 实现及边界 |
| --- | --- |
| 原生 Agent | 已实测，独立 SDK 进程复用 Harness runtime |
| 原生 GUI 可见 | 未验证；会话保存在同一 home，但不承诺出现在已经打开窗口的工作区列表 |
| 默认模型 | 原生保存的 provider/model；可选 `provider/model` 或 `{provider, model}` 覆盖，不写回全局默认 |
| 工具权限 | 只接受 `read-only`、`workspace-write`；覆盖原生 sandbox 和 ask 策略，续接时重新钉住权限 |
| 工具范围 | 只开放原生 read/glob/grep/read_image/ask_user_question；workspace-write 额外开放 edit/write。shell、后台 jobs、web、skill、MCP、子 Agent 都不可执行；测试由审核端运行 |
| 人工审批 | 原生 `approval/request` 产生 `needs_approval`，取消当前执行；没有允许审批的桥接端点 |
| 人工输入 | 原生 `user-questions/request` 产生 `needs_input`，取消当前执行；修订需由规划端根据用户答复重新提交 |
| 预算 | `budget.maxTurns` 必须是正整数，限制原生模型步骤数；一个步骤内原生 provider 重试可能产生多个请求，不是费用或 token 上限 |
| 委派 | 禁用子 Agent、workflow、Ralph、目标轮询与自动标题模型；不产生无预算的原生子任务 |
| 截止、取消 | 父进程截止计时、AbortSignal 通过私有 IPC 调用 `agent.cancel`；先正常释放 owned agent，超时只结束所拥有的子进程树 |
| 续接 | 已实测：新 worker 调用原生 `agents.resume`，沿用原生 session ID，并核对同一绝对工作目录；会话被另一个活动运行时持有时需要先交接 |
| 重启恢复 | 当前实例可报告自身 worker running；协作服务重启后保守返回 unknown，不能从 session 存在推断执行成功，更不能自动重派 |
| 使用量/额度、图片 | 首版不宣称支持 |

创建会话后先 flush，再等待协作服务确认持久化 `nativeSessionId` 和起始序号，才允许发送 prompt。因此在检查点持久化失败时不会开始模型任务。结构化回传包含真实原生 session events 和末条 durable assistant 文本；`tests`、`artifacts` 不从自然语言中冒充解析为已核验事实，实际文件与测试验收由协作服务和审核端负责。

发送 checkpoint-ack 后，worker 意外退出、IPC 断开或事件持久化失败均携带 `dispatchUncertain=true`；协作服务须转为 needs_input 并阻止自动重派。明确的原生预算/凭据错误及主动取消仍按原有结果处理，不会误标为不明派发。checkpoint-ack 前原生模型尚未获准启动，启动失败也不属于不明派发。

工具采用可见性白名单和原生 `ToolRuntime.guard` 两层限制；后续注册的任意非白名单 MCP/插件工具也不能执行。这是对可信本机 Harness 插件配置的工具调用限制，不是将任意恶意同进程插件隔离成安全代码的机制。恢复会话发现尚未处理的原生 inbox 时进入 needs_input，不自动回放可能有副作用的旧指令。

### 桌面窗口与独立 SDK 的会话占用

上游 `0.1.5-rc.1` 的 Web 历史订阅在读取冷会话快照后，会在后台调用 `agents.resume`。该 Agent 归 Web controller 生命周期拥有；关闭聊天页只取消订阅，不保证释放持久化写句柄。因此用户在桌面中查看一个已经完成的协作会话后，独立 SDK 的原会话续接可能遇到 `SessionAlreadyOwnedError`。这属于正常会话所有权竞争，不能从“首轮 worker 已退出”推断会话仍可被新的 SDK worker 接管。

适配器只在本次原生 `resume` 返回类型与 session ID 均匹配的所有权错误时，报告 `HARNESS_SESSION_OWNED`、`needs_input` 和 `promptDispatched:false`。此时还没有发送 checkpoint 或修订 prompt。不会删除锁、结束其他运行时、复制会话或声称修订已经执行。Windows 上游使用以 session 路径生成的命名内核信号量；活动持有者正常释放句柄后才能续接，磁盘 `.lock` 文件清理不能解决这种占用。

这是独立 SDK 适配器的边界。新增同进程桌面桥用于在 Web 运行时中借用原生 Agent；直接发送 Web `session.prompt` 仍不能代替协作预算、工具权限、人工审批和持久化检查点约束。

### 同进程桌面协作 Runner

`collaboration/harness-desktop-worker.cjs` 导出 `createDesktopRunner(ctx, { runtimeRoot })`，返回 `execute(task, callbacks)` 和 `dispose()`。`callbacks` 与独立适配器相同：`signal`、`emit(type, data)`、`checkpoint(data)`、`state(state, data)`。其 Cordis 依赖由 `DESKTOP_INJECT` 导出：`agents`、`agentDefaultModel`、`sessions`、`sessionController`、`llm`、`approval`、`sandboxPolicy`、`tools`。

`harness-desktop-server.cjs` 作为 Web 插件调用 Runner；`harness-desktop-client.cjs` 通过每次启动生成的受保护命名管道入口与双方认证连接它。桥自身的随机认证材料与 Web cookie、模型密钥无关；Runner 不读取或复制任何模型凭据。只有桌面启动时加载了这个插件，客户端才具备同进程接入入口。

- 已附着的 `collaboration-*` 会话直接从 `ctx.agents.get` 借用；冷会话通过原生 `sessionController.resolveAgent` 恢复，新会话通过 `sessionController.create` 创建，由官方 Web controller 组合 preset 并持有。协作任务结束、取消及 Runner 退出都不 dispose 这些原生 Agent。
- 只允许相同绝对 cwd，拒绝正在运行、处于维护操作或有待处理 inbox 的会话。任务期桌面再次加入用户输入时进入 `needs_input`，保留尚未发送到模型的用户消息。
- 每个任务临时挂载预算、审批、人工输入及工具执行钩子。最终原生 prompt assembly 只暴露白名单文件工具，单调执行 guard 同时拦截任何非白名单调用；作用仅限借用的 Agent。
- 任务模型覆盖使用 `prepend` 的原生 assembly/request 钩子，避免被 Web 已有模型选择钩子覆盖，也不写回全局模型默认。任务结束卸载后恢复桌面原模型选择。
- sandbox 和审批通过原生 setter 临时钉为任务权限及 `ask`，结束后恢复原有效值；如果用户在任务期明确改过权限，则保留用户选择并停止协作。
- checkpoint resolve 后才允许 prompt；回调失败、取消和截止时间均能在发送前退出。截止时间不需要等待挂起的 checkpoint 回调。终态在原生空闲、钩子撤下及权限恢复完成后回传，是下次同会话任务的交接点。
- prompt 获准后，事件/检查点回传故障或无法获得原生终态的异常报告 `dispatchUncertain`；明确原生失败、人工等待及主动取消保持各自状态。

这些行为已经通过隔离原生 Web fixture 验证。真实模型调用、安装版新桥启用、已打开桌面窗口中的原会话修订，需要再由端到端验收记录确认。

## 验证记录（2026-09-13）

- 空白独立 Harness home：原生 SDK profile 启动、默认模型解析通过，没有发送模型请求。
- 空白 home 执行：原生错误码 `MISSING_CREDENTIAL` 正常回传，明确缺少 `DEEPSEEK_API_KEY`；没有注入替代响应。
- 已配置桌面 home：原生默认 `easycli-antigravity / gemini-3.8-flash-high` 握手通过，不读取密钥内容。
- 真实任务：`maxTurns=2`、每次 60 秒 deadline、read-only、无工具。原生回复 `HARNESS_COLLABORATION_OK`，新进程 resume 后定向修订为 `HARNESS_FOLLOWUP_OK`。会话 `collaboration-bae74256-017f-4bfd-a442-dc5678cb8123`；这是原生执行验证，不代表统一 MCP、文件改动、GUI 可见性和工具审批端到端验收全部通过。
- `node --test tests/harness-adapter.test.cjs` 覆盖权限/预算拒绝、native ID 持久化前禁止 prompt、审批 fail closed、取消归属、模型选择及无凭据原生启动。
- 原生取消：在 checkpoint 回调中持久化 native session ID 后 abort，适配器返回 `CANCELLED`，自己创建的 worker 正常退出码 0；观测到 0 个 turn/start 和 0 个 assistant/message，模型 prompt 没有获准发送。
- 原生跨进程所有权：空白临时 home 中，SDK A 在 durable checkpoint 持有会话，SDK B 续接同一 session 被原生写锁拒绝并报告 `HARNESS_SESSION_OWNED / needs_input`，A 仍存活；A 正常 shutdown 后，SDK C 成功续接同一 session 到 checkpoint。三个 worker 均退出码 0；全程 0 个 turn/start、0 个 assistant/message，没有发送模型请求或操作用户会话。
- 同进程 Web Runner：原生 Web profile 的官方 controller 先创建并持有会话，协作 Runner 借用同一 Agent 连续两次到达 checkpoint 并取消；原 Agent 仍 attached，任务期 5 个只读工具及 shell guard 生效，取消后工具与权限恢复。另覆盖待处理用户输入、任务期新用户输入保留、checkpoint 写入失败、native pre-step 预算、模型覆盖及恢复、挂起 checkpoint 的截止时间。测试均未发送模型请求。
- 桌面桥集成：真实 Windows 命名管道的双方认证连接到隔离原生 Web runtime，认证 PID 与实际子进程 PID 一致；已有 Web Agent 被复用到相同 native ID checkpoint，客户端取消后服务 activeCount 归零，原 Agent 和权限/工具状态保留。全程 0 个 turn/start、0 个 assistant/message。

人工审批事件目前用协议单测验证；尚未触发一个真实需要越界权限的模型工具调用。没有承诺无人值守越权动作可自动恢复。升级 Harness 后应先重跑上述兼容性检查，再进行真实最小任务和续接验证。
