# ZCode 原生适配器与兼容性记录

更新：2026-09-13。实现位于 `collaboration/adapters/zcode.cjs`，入口为 `createZCodeAdapter(options)`。完整安装默认通过 `zcode-renderer.cjs` 驱动未修改的原版 ZCode renderer 与 host；显式 `nativeSurface: 'desktop-host'` 保留早期受限 host 桥，仅 CLI 安装或显式 `nativeSurface: 'terminal'` 才直接启动 app-server。不收集其他软件的凭据，不直接调用模型 API。

## 当前正规 renderer 适配：无模型握手已通过，真实闭环待验收

新版使用原版 `ZCode.exe --remote-debugging-pipe --open-workspace`，CDP 只通过继承的 stdio 3/4 私有管道传输，不开放 TCP 调试端口。复用协作服务自己的持久 Chromium profile，不再每次新建浏览器身份；profile 由原版软件自行写入，不复制原用户的 Cookie、浏览器目录或登录文件。保留官方默认应用名称和 UA。

启动后只在 React tree 中定位与指定工作目录一致的 `PJt` 原生验证监听组件，并取其最近 Provider 的 service proxy。没有匹配的监听组件就拒绝派发，不能只凭全局 service 或工作目录 props 推断通道正确。握手复用原版 renderer 已有的 `zcode-v4-client-id:v1`（非登录凭据），执行 V4 hello/initialize；实际任务走 `sendConversationCommandV4` 的 `sendText`，权限仍由原生 create/resume 白名单与模式校验限定。

本次唯一一次新版无模型实机检查：全新空工作目录 `C:/Users/20864/AppData/Local/Temp/zcode-renderer-handshake-A196WO`，持久 profile 位于 `APPDATA/DeepSeek-Harness-Collaboration/zcode-browser`。实际找到正确 `PJt` 和同一个 service proxy，私有管道与 V4 protocol 3 / desktop-continuous 握手成功；未创建/恢复会话、未发 prompt、未调用验证 SDK。拥有的 PID 19440 已结束。**这不是原生模型或文件修改验收，真实“修改→测试审核→原会话修订”仍待执行。**

后续一次通过真实 Codex MCP 的隔离验收记录于 `.test-data/registered-codex/zcode-live.json`：任务 `0b6194fe-1a10-4451-bf79-a7df4237b453`、原生会话 `sess_9589e28f-3766-4ca9-bf7d-6cca24b805fb`，给定 300 秒截止时间，但在派发前置阶段立即失败，未收到 turn 事件、未修改文件。该次服务数据/profile 实际位于 Codex MSIX `LocalCache/Roaming/DeepSeek-Harness-Collaboration/verification`，并非无模型手工检查的 profile；不能只凭未继承的环境变量推断二者相同。

离线诊断只筛选本任务会话及派发时间窗：CLI 原生日志于 `2026-09-13T04:08:18.077Z` 记录 `zcode_protocol.v4.gateway_error`、scope `v4.command.execute`、错误 `FOREIGN KEY constraint failed`；这条 gateway 记录本身不含 session ID，按准确时间和 scope 关联。相同会话在稍早的两条 model-selection persistence 警告中也有相同外键错误。检查点在 `04:08:18.001Z`，因此失败发生于 admission 阶段，不能归因于验证码或 30 秒 timeout。

原版 UI 使用 `persistence: 'deferred'` 创建预热会话，而旧适配实现遗漏该字段。原版 CLI 的 deferred admission 会先确保 session 入库，再保存首次输入；直接 immediate 分支可能在没有 session 父记录时触发外键错误。实现现已对齐 deferred，并只在首发 ACK accepted 后调用原生 `promoteDeferredDraftSession` 做索引订阅；这个调用不创建新会话或派发模型，索引失败也不能重发已接受的输入。此修复仅经静态源码与 fixture 验证，尚未再次进行真实模型验收。

失败 ACK 现在只保留经过脱敏和长度限制的 `commandId/status/reasonCode/message/revisionAtDecision/resultType`，以及有界的派发前原生错误事件摘要，在连接关闭前写入 `native_diagnostic`。不会转发整个 ACK、headers、token 或 stack。`session/send` 的 CDP awaitPromise 时限现在显式使用任务剩余截止时间，避免被通用 30 秒 RPC 限制提前截断；原版正常 ACK 只等待 admission，模型 completion 与运行时验证本身异步完成。

deferred 修复后的同一 verification/profile 真实检查为任务 `9ceb8003-e78c-410c-bab3-81059ca2bd33`、会话 `sess_506f15aa-6ce0-4ca1-9e51-28b135fe56df`：首次输入 admission 已接受，收到 `turn.started`，约 124 秒后收到原版 `turn.failed`，detail 明确为 `Captcha verification timed out after 120000ms.`。本次不是数据库外键、模型 key 或我们的 300 秒截止时间问题。用户确认看到了验证码并手动操作后仍失败，因此不能解释为没有操作或没有看到提示。没有完成文件修改或同会话修订；模型与验证码重试已停止。

离线按本次原版窗口 PID 48788 / host PID 44164 和时间窗检查日志，没有找到可归属本次挑战的 SDK `verifyCode` 或 `aliyunErrorCode`，无法据此判断服务器拒绝的具体原因。可以确认本次使用专用 Chromium profile，而原版用户窗口为另一现有 profile；这是环境差异，不是已证明的失败原因。不得通过复制 Cookie、修改 SDK、伪造验证结果、改变网络身份或隐藏调试功能来处理。

本次也暴露提示观察范围不足。后续观察代码只新增同工作区 `onDynamicWorkspaceProviderRuntimeHeadersRequest` 订阅，并按本应用 session ID 过滤，记录 `native-verification-pending`；不调用 SDK 或验证回包。只读 DOM 可见性检查同时覆盖挂载槽与全页 `aliyunCaptcha-*` 元素，实际可见挑战才触发 `needs_input`，并正常呈现拥有的窗口。公开错误码仅从官方文档标识的 `aliyunCaptcha-sliding-errorCode` 读取；不读取图片或答案。[阿里云公开 UI 元素说明](https://help.aliyun.com/zh/captcha/captcha2-0/user-guide/client-ui-description-and-custom-configuration)。这些观察改动只经过 fixture 验证，尚未再次进行真实验证。

复用用户原版已有 Chromium profile 的长期模式现已实现为显式 `profileMode: 'existing'`，但**尚未启动该模式的真实窗口、模型或验证，也不保证能解决服务端验证失败**。具体交接与生命周期如下。

## existing 模式：共享服务持有原版用户窗口

库的默认模式仍为专属 `dedicated` profile。existing 只能配合 `managedLifetime: true` 的共享 daemon；exclusive stdio 在任何原版启动前拒绝该模式，避免客户端 EOF 关闭用户窗口。仅修改服务的 `executors.json` 选择 existing 不会立即启动 ZCode。

首次交接前检测同一原版可执行文件的主进程。存在非本服务拥有的 ZCode 主进程就返回 `needs_input`，要求用户先在原版应用中正常退出；不会关闭、刷新或接管当前未受控窗口。用户完成交接后，启动仍用原版可执行文件、私有 CDP pipe 和官方 `--open-workspace`；existing 不覆盖 `ZCODE_DESKTOP_USER_DATA_DIR`、`ZCODE_DESKTOP_SESSION_DATA_DIR`、`ZCODE_DESKTOP_APPLICATION_NAME`，也不复制原版浏览器数据。控制 marker 与工作区记录位于服务自己的 `profileDir/existing-controller`，不写入原用户的浏览器资料目录。

adapter 实例持有跨任务的原版进程连接。每次执行使用单独的 task lease，并只允许本次创建或明确引用的原生 session ID；结束时清理本任务订阅、输入映射和截止 guard。同工作区直接复用同一 host；更换工作区通过官方第二实例 `--open-workspace` 转交已拥有的进程，再清除本应用的桥缓存并重新匹配正确 `PJt`，不读取其他会话内容。恢复与派发前核对目标会话闲置，不能抢占用户正在进行的原生输入。

**普通任务结束、MCP 客户端断连或服务空闲不会关闭 canonical 用户窗口。** `adapter.hasPersistentResources()` 在窗口仍活着时返回同步 true，供 core/daemon 阻止 idle 退出和安全重启；`adapter.close()` 自身也会拒绝关闭活窗口。任务失败需要取消时，只尝试停止该任务并确认状态，窗口仍保留。用户自行退出原版窗口后，才释放控制 marker；异步关闭、崩溃及服务恢复都不能自动重放旧任务。

限制：原版 Electron 会在 CDP pipe 断开时请求退出。若用户强杀共享 daemon、宿主崩溃或系统结束其进程，仍可能连带关闭由它持有的 ZCode 窗口；正常 idle/重启保护不能消除这个原版行为。需要重启共享服务或更新它时，应先由用户正常退出原版 ZCode，再执行交接。当前没有把原版窗口转换成可在 daemon 死亡后无损转移的独立 broker。

existing 的进程拒绝、保留原环境、同 host 多任务、task finish 不关闭窗口、用户退出释放 marker、切换工作区、权限前闲置检查及拒绝恢复其他 task 由 fixture 验证；真实原版 profile 的交接和模型闭环仍等待用户完成退出与重新连接后验收。

同一时间只运行一个 ZCode 任务（`maxConcurrentTasks: 1`），并对专属 profile 设置进程排他锁。锁记录父进程和原版子进程 PID，陈旧锁恢复需要独立的排他恢复锁；父进程结束但原版子进程仍存活时拒绝接管。持久记录本应用打开的工作区及执行状态，无法确定的旧运行不能自动恢复。

原生 SDK 可能有最长约 120 秒的验证生命周期，因此 renderer 任务至少保留 180 秒剩余时限，建议 300 秒；不会自动延长调用方截止时间。真正可见的 SDK 交互区域才触发 `needs_input`，保持同一原生请求和窗口活着；收到真实模型/工具事件才恢复 `running`。不自动刷新、重发、点击、代答或合成验证码结果。截止/取消先发原生 V4 stop，回执被接受后继续核对同一存活会话已经 idle 且无 active turn / pending request，不能只凭 ACK 声称取消完成。关闭窗口后等待拥有进程优雅退出至少 5 秒，必要时才结束自己的进程树。停止或退出未确认则返回 `dispatchUncertain` 并保留 profile 锁供核对，不伪造取消回执。

详见 [V4 与验证生命周期勘查](zcode-renderer-protocol.md)。ZCode 适配、renderer 与 existing 生命周期相关测试合计 47 项通过，均不代表 existing 模式真实模型已经验收。

## 早期 host 桥记录：已复用模型配置，但缺 renderer 验证流程

重新核对已安装发布包：桌面 **3.11.2**、CLI **0.16.5**。本机安装入口是 `D:/Program Files (x86)/ZCode/resources/glm/zcode.cjs`；这是勘查证据，不是产品硬编码路径。独立无窗口 Electron 44.3.0 helper 使用 `utilityProcess.fork` 加载安装包的原版 `app.asar/out/host/index.js`，并通过其原版 MessagePort channel client 调用会话接口。

官方 host 自己解析当前原生登录、provider registry 和请求签名。协作层没有调用凭据服务、读取登录文件、复制 API key、伪造模型响应或修改官方 bundle。实机已完成：创建原生会话、读取模式、订阅事件、发送任务、收到 `accepted: true` 与 `turn.started`。

原生快照公开的当前可选模型是 `builtin:zai-start-plan/GLM-5.3` 与 `builtin:zai-start-plan/GLM-5.3-Flash`。用户确认当前 ZCode 原生窗口可以正常回复；这证明原生界面通道可用，不能再将问题归因于缺少登录或密钥。

当前未完成部分是 `interaction/requestProviderRuntimeHeaders`：桌面 renderer 在每次模型请求前通过自己的官方验证 SDK 走 silent verification，必要时才出现人机验证界面。无窗口 host 不包含这个 renderer，因此不能替它生成响应。适配器当前返回 `needs_input`，具体代码为 `zcode_native_renderer_required`，含义是**实现缺口**，不表示用户账号需要重新登录或用户当前遇到了验证码。不能承诺“在原生窗口验证一次后，独立 host 就永久可用”。后续完整 renderer 联动必须保留官方原生流程；如实际出现交互挑战，应交给用户。

最后一次端到端适配器实机探测：工作目录 `C:/Users/20864/AppData/Local/Temp/zcode-adapter-live-UvSjig`、会话 `sess_443a9c16-99bf-4a39-997b-106dfbb2f20c`，60 秒截止时间、`maxTurns: null`，约 5 秒收到上述原生请求并停止自己创建的进程。**没有生成目标文件，原生模型写入、测试审核和原会话修订闭环仍未通过。** 不把会话握手成功称为真实协作交付完成。

随后仅在临时 Git 目录验证过独立的完整原版窗口：使用官方 `ZCode.exe --open-workspace`、独立 `ZCODE_DESKTOP_USER_DATA_DIR` / `ZCODE_DESKTOP_SESSION_DATA_DIR`，不修改 HOME 或原生登录路径。通过专用本机 CDP 连接只取得顶层 React props 的原生 service proxy，创建的会话能自动显示在这个原版窗口中，匹配工作目录的组件存在。但直接 `zcodeAgentService.sendPrompt` 仍只得到 `turn.started` 与 runtime headers 请求，90 秒内没有文件变更。源码进一步确认 renderer 聊天并不调用 `sendPrompt`，而使用 `zcodeAgentService.sendConversationCommandV4`；后续需核对该调用链，以及实际挂载的 `PJt` 是否持有相同工作区的原生 service proxy。工作目录 props 匹配不能证明验证监听组件已挂载。官方正常验证链为 `PJt → Yat/Jat → aZ/rZ/Tat`，不能用伪造结果补全它；`Gat` 的业务调用属于设置页连接测试，不能据此推断聊天会先调用它。

用户随后报告出现移动图像验证且未成功，因此已暂停所有模型探测、新验证窗口和重试。完整窗口的已拥有 PID `5344`、`22920`、`38012` 均已结束；只读核对这些 PID 及专属临时工作目录标记，没有残留。最后一轮于北京时间 2026-09-13 11:28:25 启动、11:30:01 到期后结束自己拥有的进程树；用户原有窗口未被关闭或刷新。新的 Chromium profile 可能改变官方风险验证条件，而关闭临时窗口也会使它尚在进行的验证失效；目前不能断言它与用户后来看到的挑战无关。真实探测需等用户原生验证恢复并重新协调后继续。研究与实现不得操作或绕过验证码。

## 桌面桥的分发、权限与连接

桌面桥只接受父进程指定的 CLI、Node、工作目录绝对路径以及 `\\.\pipe\deepseek-zcode-…` 专用 Windows named pipe。Node 协调进程创建随机管道及 256 位一次性令牌，只将令牌传给 helper 的临时环境；helper 读取后立即从自身环境删除，再启动原版 host。服务按常量时间比较令牌，拒绝未认证连接，成功后只保留一个连接，不开放 TCP 端口。该令牌是本次本地桥接生成的 capability，与 ZCode 登录凭据无关。

开发时使用项目 Electron 可执行文件加载 bridge 入口；分发时通过本项目桌面可执行文件 `--collaboration-zcode-host` 专用入口加载同一 bridge。CLI 子进程使用分发的真实 Node 可执行文件。Windows 隐藏 Electron 进程的 stdin 在实测中出现 EOF，因此该段采用 named pipe，不能假定 Electron stdin 等同普通 Node stdin。

bridge 只映射创建、恢复、读取、列表、订阅、发送、模式、会话模型与停止接口，限制于父进程指定工作目录以及本次创建/明确恢复的会话；不暴露任意 channel 调用、凭据 API、全局 provider 设置。返回的快照仅含会话、模式、公开模型标识和事件序号；原生 host 日志与 provider runtime headers 不转发。截止/取消只终止拥有的 helper 进程树，不关闭用户原有窗口。

## 首次独立 CLI 勘查记录（不等同于当前桌面桥）

| 检查 | 实际结果 |
|---|---|
| 启动 `app-server`、按行发送 JSON | 可以通信，消息没有 `jsonrpc` 字段 |
| `initialize` | 返回 `-32601 Method not found`；该协议不需要 MCP 初始化握手 |
| 独立临时目录下 `session/list` | 成功返回空列表，没有读取其他工作目录的会话 |
| `session/create` 的反向请求 | 先收到 `session/requestRuntimePreferences`；不应忽略，否则约 15 秒后超时 |
| 回答运行偏好后的 `session/create` | 返回 `model_config_missing`，指出原生 CLI 尚未配置模型提供方 |
| 适配器真实调用 `execute` | 自动发现安装目录，45 秒截止时间、只读权限、`maxTurns: null`；准确返回 `needs_input` |
| 原生模型任务、工具写入、追加修订 | **未完成**：创建会话即被模型配置阻塞，没有发出 `session/send`，没有模型事件或推理额度消耗证据 |
| 原生 GUI 会话可见性 | **未知** |

独立 CLI 返回的配置错误指向用户目录中的 `.zcode/cli/config.json`。适配器没有读取该文件、提取或复制密钥；该错误只证明独立 CLI 未配置，不能推出桌面未登录。当前桌面桥已证明官方 host 能解析已登录模型配置，后续应修复 renderer 接入，而不是要求用户补交登录密钥。

## 预算勘误：帮助文本不能作为能力证明

0.16.5 的帮助页列出了 `--max-turns`，但实机执行 `--max-turns 1 --help` 退出码为 **1**，返回 `Unknown option '--max-turns'`。本机已发布 bundle 的参数解析器与 app-server `session/create`、`session/send` 参数 schema 也没有对应的模型步数限制字段。app-server 入口不会把 `--mode` 作为会话模式；必须通过协议显式指定并核对模式。

因此，适配器声明 `maxModelTurns: false`。`budget.maxTurns` 的含义仍然是原生模型推理步数，不改成“发送一次任务”，也不把提示词中的轮数要求当成硬限制。

- 数字 `maxTurns`、遗漏 `maxTurns`：返回 `unsupported_budget`，在启动模型任务前拒绝，不自动放宽预算。
- **明确的 `maxTurns: null`**：表示请求者选择仅用截止时间约束执行；必须提供未来的 `deadlineAt`。核心服务限制截止时间范围，适配器同时设置计时器并响应 `AbortSignal`。
- 每次 `execute` 只调用一次 `session/send`；一次原生用户轮次内部可能包含多次模型请求，不能据此承诺固定费用或模型步数。

后续版本若增加预算字段，应先验证新版本实际协议及限制生效行为，再更新能力声明。目前适配器只允许本机已勘查的 **0.16.5** 执行协议操作；发现其他版本会显示 `protocolCompatible: false` 并拒绝派发，不能把发现安装当作验证了兼容性。

## 配置与发现

`createZCodeAdapter` 接受以下配置：

| 配置 | 用途 |
|---|---|
| `cliPath` / 环境变量 `ZCODE_CLI_PATH` | 精确指定 `zcode.cjs`；指定路径无效时直接报错，不悄悄改用另一安装 |
| `nodePath` / 环境变量 `ZCODE_NODE_PATH` | 运行 CLI 的 Node 可执行文件；默认使用当前运行时，并为 Electron 设置 `ELECTRON_RUN_AS_NODE=1` |
| `installationRoots: string[]` | 自定义安装父目录或 ZCode 安装目录，例如 `D:/Apps` 或 `D:/Apps/ZCode` |
| `requestTimeoutMs` | 单个协议请求超时，默认 20 秒；超时不代表请求未送达，不自动重发 |
| `env` | 子进程环境，用于独立测试/宿主启动；不负责读取原生凭据 |
| `nativeSurface` | 默认完整 renderer；`desktop-host` 使用受限 host 桥，`terminal` 使用独立 CLI |
| `profileDir` | 原版 renderer 专用的持久 Chromium profile 根目录；应位于服务数据目录，不放在任务 worktree |
| `profileMode` | 默认为 `dedicated`；显式 `existing` 保留原版 profile 环境并跨任务持有用户窗口 |
| `managedLifetime` | existing 必须为 true，且只能由共享 daemon 提供；exclusive stdio 不启用 |
| `zcodeExecutable` | 明确指定原版 ZCode 桌面可执行文件，默认由所发现的 CLI 安装位置推导 |
| `desktopExecutable` / `COLLABORATION_DESKTOP_EXECUTABLE` | 本项目桌面桥入口可执行文件；开发时可自动发现项目 Electron |
| `desktopArguments` | 宿主入口参数；分发默认 `--collaboration-zcode-host`，尾部追加本次启动的结构化参数 |

自动发现只检查已知产品路径：Windows 标准程序目录、各盘 `Program Files`/`Program Files (x86)`、用户 `Programs`、PATH 下的资源路径；另有 macOS 常见应用路径候选。没有递归扫描磁盘、会话库或用户配置。首要验证平台仍是 Windows。

`describe.available` 表示 CLI 能找到并返回版本；`readiness: configuration-not-verified` 明确区分模型通道是否就绪。若当前适配器已观察到 `model_config_missing` 等错误，后续描述会返回 `readiness: needs_input` 和真实失败原因；成功派发后清除该状态。它不会为了列执行器而创建会话或发起模型任务。额度未知，使用量只有在原生完成事件实际提供时才返回。

## 生命周期与权限

新任务先创建会话，后续任务使用服务持久化的 `nativeSessionId` 恢复原生会话。派发前设置权限、读取会话核对当前模式、订阅事件，并将原生会话 ID、输入 ID 和派发阶段写入检查点，再发送任务。

| 统一权限 | 请求的 ZCode 模式 | 原生工具白名单 |
|---|---|---|
| `read-only` | `plan` | `Read`、`Glob`、`Grep` |
| `workspace-write` | `build` | 上述工具以及 `Write`、`Edit` |

白名单之外不授予 Bash、MCP 或子代理工具；显式禁止 Bash、Agent、Task 和定时任务写操作，关闭额外的标题生成、记忆和自动回答用户问题。工作目录必须是绝对路径。ZCode 自身仍负责工具参数与工作目录的原生权限判断；能力中 `workspaceSandbox: false` 明确表示没有独立操作系统沙箱。本机模型配置缺失，因此尚未实测原生文件权限拒绝和写入行为。

另一个 0.16.5 细节：`mcpServers: []` 被原生转换为“未覆盖”，**不能禁用原生配置中已有的 MCP 服务初始化**。适配器通过原生工具白名单阻止模型调用它们，但原生软件启动时仍可能根据自己的已配置环境初始化服务和插件；能力中使用 `nativeInitializers: configured-by-zcode` 如实标注。不要把工具白名单或工作目录隔离说成整个 ZCode 进程的文件系统沙箱。

`interaction/requestPermission` 或计划批准请求会被保存为 `needs_approval`，普通用户输入请求保存为 `needs_input`。适配器停止本轮并关闭自己创建的服务进程，**不会生成允许/批准响应**。当前版本没有审批答复工具；后续指令需要新的显式派发，不能把审核 Agent 的输出当成批准。

stdout 使用有大小限制的 NDJSON 解析，协议请求有超时；未知客户端方法返回不支持。未经处理的 stderr 不进入审计日志。任务事件通过 `ctx.emit` 交给核心服务；测试命令、产物不能仅凭模型文本猜测，因此适配器不会自动把文本里的“测试通过”填为验证证据。`turn.completed` 仅在 `resultType: success` 时产生执行结果，错误终止和额度错误走失败路径；执行结束始终等待独立审核。

取消/超时请求 `session/stop` 并终止该适配器创建的子进程树；Windows 只针对所拥有的 PID 使用 `taskkill /PID … /T /F`，不按名称清理其他 ZCode 窗口。`session/send` 后若连接中断、协议异常或请求超时，错误携带 `dispatchUncertain: true`，供核心保留待核对状态。恢复功能仅查询目标工作目录的 `session/list`；持久化列表的 `idle` 不能证明旧运行是否结束，因此返回 `unknown` 和已发现会话的信息，不擅自恢复运行或重发可能有副作用的任务。

## 自动验证和证据边界

执行 `node --test tests/zcode-adapter.test.cjs` 验证：预算拒绝、配置缺失、原生请求参数、追加任务时重新应用权限、模式不符时拒绝派发、审批不被自动接受、事件去重、失败回传、信号/截止时间取消、未知恢复状态，以及安装发现。另用实际 Node 子进程验证损坏的 NDJSON 会导致失败并终止自己拥有的进程。

当前 `tests/zcode-adapter.test.cjs`、`tests/zcode-renderer.test.cjs` 与 `tests/zcode-existing.test.cjs` 共 47 项通过，包含验证请求生命周期、凭据过滤、管道协议、profile 互斥、ACK 与终止归属、deferred 首发，以及 existing 窗口不随 task/client 结束而关闭等行为。它们不替代原生模型成功交互。真实闭环、写入权限和追加修订仍未通过，后续需在正常原版验证恢复且重新协调后验收。

## 依据

- 本机发布的 ZCode 0.16.5 CLI：版本、参数解析、协议 schema，以及上述只读/失败握手实测。只用于互操作性勘查，没有将已发布 bundle 代码复制到项目中。
- [协作设计](agent-collaboration-design.md)。
- [社区协议记录](https://github.com/william0wang/zcode-acp/blob/main/docs/PROTOCOL.md) 仅用作勘查线索；该文档不是官方稳定契约，本次没有复制社区实现代码。
- [ZCode 官方 MCP 文档](https://zcode.z.ai/en/docs/mcp-services) 描述应用作为 MCP 工具使用方的能力，不能据此证明外部能够主动派发原生会话。
