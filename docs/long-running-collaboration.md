# 长任务闭环协作（服务 0.3.0）

一个项目目标可以分多轮执行。共享后台启动独立的原生 Codex 协调回合，由它规划和审核；Harness 原生 Agent 负责修改同一隔离 worktree。执行后运行固定验证命令，Codex 根据真实差异、测试结果和原始验收条件决定继续、返工、完成或阻塞。发起端断开后，后台仍继续这一闭环。

这不是唤醒当前聊天窗口。当前聊天负责给出目标、查看进度和处理需要人工决定的事项；后台协调器负责每轮审核与续派。它不自动合并到原仓库。

## 使用入口

- `start_run`：给出 repository、goal、acceptance、permission、deadlineAt、maxRounds、maxTurnsPerTask、checks 和 idempotencyKey。
- `list_runs` / `get_run`：找回长任务，查看阶段、子任务、测试结果和最近的 Codex 判断。
- `wait_run`：等待一次进度变化；结束等待不停止后台工作。
- `pause_run`：停止继续派发，并等待已拥有执行的停止状态。以 paused/blocked 且 coordinatorActive=false 为准，不能把 pausing 当成已停止。
- `resume_run`：从记录恢复；可提供新的有限 deadlineAt 和说明 note。已确认的部分执行先审核再修订，未知派发不会重放。

必须使用 `--shared` 共享服务。原来的八个单任务工具继续保留；新服务总共提供十四个工具。单个普通 submit_task 不会自动变成项目循环。

调用者显式提供 1–20 个执行轮次、每轮 1–50 个 Harness 模型步骤，以及未来 24 小时内的总截止时间。Codex 每次判断另有 120 秒限制。达到上限或连续三轮代码证据不变会停止；这不是固定费用上限。

## 检查与权限

checks 是调用者固定的命令数组，模型不能增加或替换命令。command 支持内置 node/npm 或明确的 .exe 路径，args 是独立参数数组。检查通过原生 Codex command/exec 沙盒执行，默认关闭网络，并限制写入到工作树和本次专用临时目录；不降级为无沙盒执行。

Windows AppData 下的 Node 模块加载会尝试读取受保护祖先目录。对此只设置本次检查的已知 NODE_OPTIONS：`--preserve-symlinks --preserve-symlinks-main`，不扩大文件读取权限。实际选项写入检查记录；依赖默认符号链接语义的项目需要另行确认兼容性。Windows 验证请求的取消能力取决于原生版本；未获得停止结果时保持 pausing，最多等待该命令自身的有界退出，不提前续派。

Codex 协调回合使用 `codex exec --ephemeral --ignore-user-config` 与结构化输出，复用本机原生登录，不读取或复制凭据。协调回合禁止 shell、浏览器、插件、MCP、递归子代理和自行修改文件。可通过 codexModel 指定模型；省略时使用隔离调用的 CLI 默认值，不承诺与当前聊天的模型相同。Harness 默认沿用其原生模型选择，也可指定 harnessModel。

检查仅执行已有依赖可用的命令；需要联网准备依赖、人工审批、凭据、视觉验收或更多上下文时会阻塞。审核证据不完整、被截断或测试未通过时，不能完成总目标。源码工作基于明确的已提交 Git 版本，未提交改动不会自动包含。

当前实测与本机注册入口使用源码目录中的 MCP 服务及其内置 Node。直接把 MCP 入口改为安装目录时，Windows 沙盒对 AppData 下可执行文件的访问兼容性仍需单独验证；没有把这项打包切换称为已通过。

## 持久化与恢复

长任务保存在协作数据目录的 `runs/<id>.json`，每轮审核证据位于 `runs/<id>/reviews/`。准备好的子任务参数和幂等键先落盘，再派发。中断恢复检查原任务记录，不盲目重派；暂停期间已确认取消的部分成果会先重新审核。

串行修订不再累加递归委派深度。递归委派仍受原深度限制，同一修订链最多 50 轮，长任务还受自己更小的 maxRounds 限制。

CLI 备用入口为 `collaboration/run-cli.cjs`，支持 start/get/list/wait/pause/resume。使用与已注册服务完全相同的 --data-dir 和 --allow-root；start 用 --input 传入包含上述参数的 JSON 文件。新增 MCP 工具在客户端刷新工具目录后可直接使用。

## 实测

`node scripts/long-run-smoke.cjs --live` 会调用真实 Codex 和 Harness，属于显式模型验收。已验证发起端 MCP 连接退出后，后台自动完成“仅 trim → Codex 审核 → 添加 TypeError → 再审核”两轮。代码修改仅在隔离工作树，原 fixture 未变。证据为 `.test-data/long-run-live/latest.json`。

状态机测试另覆盖六轮连续执行、失败检查阻止提前完成、停滞停止、暂停/恢复、已确认取消后的修订、最后一轮审核恢复及中断记录恢复；原生沙盒测试覆盖工作树内写入与越界拒绝。测试替身不等同于实机模型验收。

依据：[Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[Codex App Server](https://learn.chatgpt.com/docs/app-server) 和本机生成的协议 schema。当前原生 CLI 实测版本为 0.154.0-alpha.6.2。
