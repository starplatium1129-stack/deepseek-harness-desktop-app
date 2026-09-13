# ZCode 原生 Renderer 协作协议勘查

本文记录针对本机 ZCode **3.11.2** 的静态勘查结果，供桌面适配器实现及兼容性审查使用。源码依据为安装包 `resources/app.asar`；这不是 ZCode 承诺稳定的公开 SDK，也不代表真实模型交互已经验收通过。

## 版本与边界

- `package.json`：ZCode 3.11.2，主入口 `out/main/index.js`。
- 可执行文件包含的版本：Electron 41.0.3、Chromium 146.0.7680.80。
- 原版 Renderer 入口：`out/renderer/assets/index-CWNwuuMm.js`。
- 会话、验证及 V4 transport：`out/renderer/assets/styles-DyAcaLKy.js`。
- ServiceProvider / useServices：`out/renderer/assets/catalogTree-BYrDsScn.js`。
- 原生主机服务：`out/host/index.js`。
- 原生 CLI 与 V4 命令执行器：`resources/glm/zcode.cjs`。

集成仅派发、订阅和管理本应用创建的会话；不遍历用户会话内容，不读取或导出登录凭据，不修改原版 Bundle。原版验证由原版 Renderer 处理；适配器不调用验证回包方法、不构造验证 headers、不操作验证题目。

## 私有 CDP 管道

Electron 41.0.3 的 `PreMainMessageLoopRun` 检查 `--remote-debugging-pipe` 后启动 Chromium Pipe Handler；这个分支不会启动 HTTP 调试监听。管道断开会请求退出所属 Electron 应用。

Node 父进程的启动约定：

```js
const child = spawn(zcodeExecutable, [
  '--remote-debugging-pipe',
  '--open-workspace', ownedWorkspace,
], {
  env: isolatedProfileEnvironment,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
});
// 父进程发往浏览器：child.stdio[3]
// 浏览器发往父进程：child.stdio[4]
// 每条消息为 UTF-8 JSON，末尾一个 NUL 字节，不是 JSONL。
```

Chromium Windows 默认使用 CRT fd 3 / 4。`--remote-debugging-io-pipes=<输入句柄>,<输出句柄>` 是 Native CreateProcess 传递继承 HANDLE 的另一条路径；普通 Node spawn 不需要添加它。不要启用 `--inspect` 或额外的调试端口。

依据：[Electron 41.0.3 启动分支](https://github.com/electron/electron/blob/v41.0.3/shell/browser/electron_browser_main_parts.cc#L432)、[Chromium 146 Windows 管道适配](https://github.com/chromium/chromium/blob/146.0.7680.80/content/browser/devtools/devtools_agent_host_impl.cc#L207)、[NUL 分帧](https://github.com/chromium/chromium/blob/146.0.7680.80/content/browser/devtools/devtools_pipe_handler.cc#L269)。本机 ZCode 自带 Playwright 的 `processLauncher.js` 与 `pipeTransport.js` 也采用 stdio 3 / 4 和 NUL 分帧；其 Electron launcher 默认仍采用端口，因此不能直接把 `_electron.launch()` 当作私有管道方案。

## 独立完整原版窗口

原版主进程支持以下环境变量，在 `requestSingleInstanceLock` 前应用：

```text
ZCODE_DESKTOP_APPLICATION_NAME
ZCODE_DESKTOP_USER_DATA_DIR
ZCODE_DESKTOP_SESSION_DATA_DIR
```

使用应用拥有的持久 Chromium profile，保持原版完整窗口和 Renderer；不要在每个消息轮次重新建立空 profile。不要修改 `ZCODE_DESKTOP_HOME_DIR` 或 `ZCODE_DATA_BASE_DIR` 来重定向登录数据，也不复制用户 profile、Cookies 或凭据。

CLI 的 `--open-workspace` 打开指定工作区。`window.zcode.activateOrSetWorkspace(path)` 仅登记工作区或聚焦已有窗口，不能单独作为工作区界面已打开的证明。Deep Link 未发现任务派发或 prompt 接口。

## 必须使用验证监听对应的服务

原版 Renderer 接收 ServicePort 后创建 `We` services 集合，传入顶层 `ZJt`。不要创建第二个 ChannelClient 争用同一 MessagePort。

原版验证监听的挂载链为：

```text
RJt(workspaceTabs)
  -> IJt 按 workspaceIdentity || workspacePath 去重
  -> LJt(tab)
  -> Rf(workspacePath, remoteSessionId, workspaceIdentity, remoteTarget)
  -> ServiceProvider(实际 workspace services)
  -> PJt(workspacePath, workspaceIdentity)
```

`PJt` 通过该 ServiceProvider 取得 `zcodeAgentService`、`modelProviderService`、`codingPlanSubscriptionService`，订阅 `onDynamicWorkspaceProviderRuntimeHeadersRequest`。

3.11.2 的适配器可以只在自己拥有的原版窗口中，从 `#root` 的 React Fiber 找到 `type.name === 'PJt'`、工作区参数精确匹配的组件，沿其 `return` 找最近持有 `memoizedProps.value` 或 `memoizedProps.services` 的 ServiceProvider，并保留服务对象引用。只返回布尔状态和必要的会话协议结果，不能序列化整棵 Fiber、props、store 或服务缓存。

派发与验证监听必须使用这个同一个服务代理。可以用对象引用相等检验；必要时调用两者的 `helloConversationV4()`，比较非敏感的 `connectionId`。找不到匹配的 PJt 时不得向模型派发。其他组件出现 `workspacePath` 并不能证明此监听已经挂载。

## V4 握手

`zcodeAgentService.helloConversationV4()` 无参数，原生本地实现返回：

```js
{
  kind: 'hello', protocolVersion: 3, connectionId: '...',
  clientMode: 'desktop-continuous', deliveryProfile: 'continuous',
  serverTime: 0,
  capabilities: {
    nativeDialogs: true, localTerminal: true,
    binaryFrames: false, compression: 'none', workspaceHookReview: true,
  },
  auth: {},
}
```

通用 schema 同时允许 `web-remote-replayable` / `replayable`，两组值必须匹配。本地适配器应断言自己取得的是 `desktop-continuous`。

原版使用 `localStorage['zcode-v4-client-id:v1']` 保存非认证用途的稳定 client ID。保持这个 ID，不覆盖原版已建立的客户端身份。

```js
await agent.initializeConversationV4({
  kind: 'clientHello', protocolVersion: 3, clientId,
  clientKind: 'desktop', appVersion: 'unknown',
  capabilities: { workspaceHookReviewUi: true },
});
```

本机 Host 的 initialize 实现只验证参数；未返回会话或认证数据。

## 派发与 ACK

原版普通聊天使用 `sendConversationCommandV4`，Renderer 中没有 `sendPrompt` 调用。当前预热流程 `QEe` 派发 V4 `createSession`，CLI 的 `createSessionRecord` 内部调用 `l3e`，明确使用 `persistence: 'deferred'`。首发仍使用同一 session ID，不要求额外创建不同 ID 的 UI task。

桥接为了保留会话级工具约束，可以采用原生 `zcodeSessionService.createSession`，但必须同样传 `persistence: 'deferred'`。原因是 V4 `admitCommandInput` 仅在 record 为 deferred 时先调用 `runtime.ensureSessionPersistedForExternalActivity`，然后才保存 `session_input`；该表的 `session_id` 有指向 `session(id)` 的外键。默认 immediate 创建仅建立内存 record、设置模型和读取快照，不能证明首个输入之前已存在持久 session 行。遗漏 deferred 会在 V4 输入入账阶段触发外键错误，尚未产生模型轮次事件。

legacy `zcodeSessionService` 的 deferred 创建还会登记 Host 草稿表。第一次发送获得 accepted ACK 后，可调用 `promoteDeferredDraftSession({workspacePath, workspaceIdentity?, sessionId})`：它只忘记草稿登记并让 task-index syncer 订阅该原生会话，不创建新 ID、不修改权限、不发送模型输入。此索引同步失败不能触发任务重发。当前 V4 UI 的 `markPromoted()` 是防止清理预热草稿的本地状态，不是另一个持久会话注册步骤。

创建/恢复后检查实际权限模式、工具允许/拒绝列表；每轮发送使用 V4：

```js
await agent.sendConversationCommandV4({
  workspacePath,
  // workspaceIdentity 仅在目标实际具有该标识时传入。
  envelope: {
    commandId, clientId, sessionId, type: 'sendText',
    payload: {
      text,
      requestedDelivery: 'startNow',
      toolDisallowlist,
    },
    issuedAt: Date.now(),
  },
});
```

`sendText` 不需要 `baseRevision` 或 `baseLogEpoch`。涉及已有行的编辑等其他命令有 CAS 和日志版本约束，不能套用这个简化 envelope。显式 `requestedDelivery: 'startNow'` 会申请前台执行权并停止该会话的现有前台轮次；因此派发前必须确认本应用拥有的目标会话仍空闲，不能把这个选项当作“仅在空闲时启动”。

ACK 的状态包括 `accepted`、`rejected`、`stale`、`duplicate`、`noop`、`failed`。ACK 仅证明派发决策，不证明模型轮次完成。`inputAccepted` 结果含 `delivery`、`inputId`、可选 `messageId`。本机 CLI 的 `iji` / `sendText` 明确把 `commandId` 作为 `app.sendInput` 的 `inputId`，成功 ACK 也返回相同 ID。仍应记录映射并验证 ACK，不能把这一版本的事实推广到未知版本；需要处理事件先于 ACK 到达的竞态。

ACK schema 的其他字段为 `commandId`、可选 `reasonCode`、可选 `message`、`revisionAtDecision`、可选 `result`，没有 `error.details`。网关 `handleCommand` 在执行或持久化输入异常时捕获异常：有 `reasonCode` 则保留；未实现命令映射为 `fault.command.notImplemented`；其他普通异常映射为 `fault.command.executionFailed`，真实原因进入 `message`。适配器应对白名单字段脱敏、限制 message 长度后保留，不能只丢弃 message 留下泛化错误码，也不能记录完整错误对象或堆栈。

`h1` / `startPromptTurn` 等待模型就绪检查和 `app.sendInput` 的 admission；实际轮次的 `completion` 另行异步等待。正常 V4 ACK 不等待模型轮次或 Renderer 的 120 秒验证结束。快速 `executionFailed` ACK 不能仅凭错误码归因于验证码超时。

## 事件与终止

可继续使用已有 `onDynamicSessionEvent({workspacePath, sessionId, deliveryKind:'desktop-continuous', includeSnapshot:false})` 订阅指定会话的原生轮次事件。不要把所有该会话事件无条件归到本次输入；按确认的 input ID 与 turn ID 过滤。

V4 展示层采用：

```js
const subscription = agent.onDynamicConversationFrame(scope)(handleFrame);
const result = await agent.subscribeConversationV4({
  ...scope, sessionId, visibility: 'foreground',
});
// result.ack: { subscriptionId, mode:'snapshot'|'resume', logEpoch, openTiming? }
```

必须在 subscribe RPC 之前安装监听，避免初始帧先于 ACK。完整帧包含 `topic: 'conversation/' + sessionId`、`subscriptionId`、`fromSeq`、`toSeq`、`sentAt`，以及 `payload.kind` 为 `snapshot` 或 `deltas`。原版 transport 另有分块装配和初始帧暂存；不能把任意 frame 都当作完整快照。

`turn.started` 才表明轮次启动；`turn.failed` 为失败；`turn.completed` 仅在 `resultType === 'success'` 时视为成功。收到 `providerRuntimeHeaders.request` 仅表明原版运行时校验正在进行，不等于必须让用户交互。

## 原版校验生命周期

- SDK 初始化等待 10 秒；静默校验 8 秒无结果时，原版可以转交互；一次校验等待上限 120 秒。
- `Yat` 按工作区、session ID、request ID 合并重复请求；`Jat` 最终把原请求结果交还原 Host client。
- Host 的 workspace client 失效或整体 dispose 会清除其待处理请求；旧回执之后会得到 `request not found`。
- 原版同一 Renderer 只允许一个验证进行中。并行模型派发或自动重试可能干扰用户正在进行的验证。
- 90 秒后强制关闭整个探测进程早于原版 120 秒验证期限，不能用这种超时流程承载用户验证。

静态已知的挂载元素为 `#zcode-aliyun-captcha-container`、`#zcode-aliyun-captcha-element` 和 `#zcode-aliyun-captcha-button`。它们正常情况下就存在，前两者为零尺寸但 `overflow-visible`，按钮隐藏；不能用容器存在或 `aria-hidden` 判断交互挑战是否可见。只读确认真实可见 SDK 交互区域后才报告需要用户操作；不要点击隐藏按钮、识别题目、填写答案、调用验证回包、替换或挂钩 SDK。

本文记录了协议和失败时序依据，未证明专用窗口的真实模型回复、同会话修订及验证码恢复已经通过。应在用户当前验证状态恢复后，按明确的验收范围进行真实验证，并把结果单独写入验收记录。
