# Harness 桌面协作桥

桌面 Web Core 和独立 SDK 不能同时持有同一原生会话的写入锁。用户在桌面打开协作会话后，后续委派必须进入已经持有该会话的 Web Core。因此桌面加载本项目的 `desktop-collaboration-bridge` Cordis 插件，借用同进程的原生 Agent。上游源码无需补丁，也不会为协作另开桌面、关闭 Web Core 或重启用户进程。

## 接入

插件文件为 `collaboration/harness-desktop-server.cjs`，配置为 `{ runtimeRoot, harnessHome }`，两者使用实际运行时和 DSH_HOME 的绝对路径。插件注入 worker 所需原生服务；`createDesktopRunner(ctx, config)` 返回 `execute(task, callbacks)` 与 `dispose()`。执行回调与协作适配器上下文一致：`signal`、`emit(type, data)`、`checkpoint(data)`、`state(state, data)`。

适配器通过 `desktopBridgeStatus(harnessHome)` 只读发现桌面服务；可用时使用 `executeOnDesktop(task, ctx, { harnessHome })`。这两项 API 不启动进程、不加载模型、不传递 Web cookie、API key 或账号凭据。不可用时返回明确的入口状态，由适配器结合原生写入锁判断是否需要桌面更新和会话交接；已经尝试的任务不得自动重新派发。

## 私有协议

入口描述文件位于实际 DSH_HOME 的 `.desktop-collaboration/ipc/desktop.json`。其所在目录使用现有共享协作服务的 Windows ACL 逻辑，仅向当前用户 SID 授权，描述文件原子发布。内容含随机端点 ID、进程 ID、协议版本和随机认证密钥；不得记录或展示文件内容。

服务仅监听 Windows named pipe，不创建 HTTP 接口。每次连接交换新随机挑战、客户端 nonce 和双方各自角色绑定的 HMAC。认证密钥不在 pipe 上传输；客户端验证服务端证明后才发送任务。握手帧上限 4 KiB，任务和事件单帧上限 256 KiB，待发送缓冲总量也有限制。状态查询不能执行任务。

每条执行连接只拥有一个随机请求 ID。消息包括 `run`、`checkpoint`、`checkpoint-ack`、`event`、`state`、`result`、`error` 与 `cancel`。checkpoint 含原生会话 ID 和开始序号；客户端必须先等待协作核心持久化成功，才发送与本次检查点匹配的确认。确认之前原生 worker 不提交 prompt。检查点等待最多 30 秒，超时取消本次执行。

断连和取消只影响该连接的委派，不释放桌面持有的 Agent，也不停止其他连接。插件退出时仅关闭自己的 listener、连接和 worker 临时限制；删除描述文件前核对随机端点 ID，保留后来写入的入口。桌面正常退出仍由桌面自身管理。

取消和截止时间触发后，客户端默认等待 15 秒，以 worker 完成权限恢复后的终态作为停止回执。发送 cancel 本身不算确认；缺少回执或连接中断会返回 `needs_input` 与 `dispatchUncertain`，阻止未经核查的重派。

桌面集成父插件显式声明子桥需要的服务，并等待 Cordis 子 Fiber 完成后才结束加载。兼容旧桌面壳只传 `runtimeRoot` 的配置：`harnessHome` 从原生 `DSH_HOME` 获取。Windows ACL 工具从系统绝对路径调用，不依赖开发环境 PATH；无法设置私有目录权限时明确失败。

传输中断若发生在尝试发送 checkpoint-ack 之后，客户端返回 `dispatchUncertain`，由核心保留待核查状态；客户端没有自动重连或重放逻辑。正常返回的原生失败、需要输入和需要审批保持明确终态。任务权限、会话前缀、工作目录、原生空闲状态、预算和截止时间由 worker 再次检查。

## 本地验证范围

`node --test tests/harness-desktop-transport.test.cjs` 仅使用临时私有目录、实际 Windows named pipe 与 fixture runner，覆盖双向认证、禁止认证前发送内容、帧限额、持久化确认屏障、两客户端取消隔离、需要输入状态、确认后断连不重放，以及 listener 和描述文件归属清理。它不会调用模型、读取用户凭据或操作正在运行的桌面。真实桌面 UI 会话可见性和模型交互须另行验收，不能以 fixture 测试替代。
