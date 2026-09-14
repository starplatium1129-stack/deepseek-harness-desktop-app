# DeepSeek 桌面端设计规范审查 · 2026-09-14

**审查对象：** `starplatium1129-stack/deepseek-harness-desktop-app`，桌面版本 0.4.0。  
**源码基线：** `c22869d6e3c3876ca3ae69804a0496ccf79e22d0`，本轮文档提交之前的 main。  
**依据：** [Apple HIG Web 设计规范 1.1](apple-hig-web-guidelines.md)。  
**方法：** GitHub 当前源码与样式层叠审查、关键交互分支审查、已有测试脚本覆盖检查、独立 sRGB 对比度计算。  
**变更范围：** 本轮只新增规范、审查报告和文档导航，没有修改运行时界面或发布安装包。

## 1. 结论

**基础设计方向符合规范，但当前不能判定完整达标。** 桌面端已有真实的阅读表面、语义颜色、键盘导航、焦点处理、响应式与减少动效入口，不是只覆盖了一层玻璃外观。明确缺口主要是部分文字和可操作状态的对比度，以及需要用户处理的错误会自动消失。

本报告没有给整款应用打一个掩盖缺陷的总分。建议先修复下面两类 P1 问题，再完成相关真实界面回归；不建议因此重做玻璃引擎、换品牌、照搬 iOS 尺寸或重建整个界面。

**证据边界：** 本次未启动真实 Electron/Windows 应用，未运行仓库 npm test、desktop-smoke、appearance-smoke 或分发包验收，未使用真实模型或用户凭据。现有文档中的历史通过记录不算本次通过。对比度数字来自已读源码色值与明示的背景假设，不是用户电脑截图的像素测量。

## 2. 核查范围与样式顺序

本次读取了 `src/index.html`、`renderer.js`、`desktop-interaction.js`、`usage-chart.js`、`main.cjs` 的相关分支，以及全部七个桌面样式文件：

```text
style.css → usage.css → pricing.css → trend.css
→ appearance.css → fluid-design.css → desktop.css
```

该顺序来自 index.html。下文没有把已被后续样式修正的旧色值当成当前缺陷；同时考虑选择器优先级、显式子元素颜色、继承和 opacity。

另核查了 package.json、AGENTS.md、README、设计与桌面交互说明，以及 `scripts/desktop-smoke.cjs`。没有把独立设计参考页的说明直接当成所有工作空间组件已经通过的证据。

## 3. P1：颜色与状态存在可确定的对比度缺口

对应规范第 6、8、11、15 节。这里的 P1 表示按本规范完成发布验收前应修复，不表示安全漏洞等级。

### C01 · 浅色下普通文字按钮与密钥状态仍使用旧低对比度色值

**位置：** `src/style.css` 的 `.text-button` 与 `label span`；`src/index.html` 的日志、重启配置、数据目录等文字按钮，以及 `#key-state`；与 appearance.css、desktop.css 的最终覆盖共同核查。

- `.text-button` 的前景仍为 `#7f90b4`。appearance.css 的 `button { color: var(--ink) }` 选择器优先级不足以覆盖它；desktop.css 对部分成本按钮有特定修复，但没有覆盖所有普通文字按钮。
- `label span` 的前景仍为 `#a3adc1`。即使父 label 使用 `color: var(--muted) !important`，该值也只是向子元素继承，不能覆盖子元素自己的显式 color。

| 对象 | 前景 | 核算背景 | 对比度 | 结论 |
|---|---|---|---:|---|
| 普通 `.text-button` | #7f90b4 | #ffffff | 3.2057:1 | 小号普通文字不足 4.5:1 |
| `#key-state` / `label span` | #a3adc1 | #ffffff | 2.2569:1 | 状态文字不足 4.5:1 |

纯白是这两种文字在浅色阅读背景中的有利亮色参照；接近白色的半透明表面并不能解决这些数值。不是因为按钮是次要操作就可豁免，也不能要求用户先悬停才看清。

**修复建议：** 给文字动作与状态说明定义明确的语义令牌，直接覆盖实际元素；检查默认、悬停、焦点与两种主题。不要继续只在父容器上改 color，也不要把所有文字按钮强行提升为主按钮。

**复核步骤：** 浅色 classic 下进入桌面管理，检查“查看日志”“重启使配置生效”等，以及未保存/已保存密钥状态；再覆盖 glass 与实际壁纸。通过 getComputedStyle 获取最终前景，合成真实背景后检查普通文字至少 4.5:1。

### C02 · 深色会话明细仍保留浅色时代的数值颜色

**位置：** usage.css 的 `.turn-buckets dd`、`.session-amount`，以及 appearance.css 的 `.session-detail`。

`.turn-buckets dd` 为 `#617396`，而深色 `.session-detail` 被设为实体 `var(--surface) = #202735`；这组明确色对为 **3.1368:1**，未达到普通文字门槛。desktop.css 修正了 `.turn-buckets dt`，但没有同步覆盖 dd。

`.session-amount` 的主数值保留 `#4e638b`，后续仅对其 small 成本标签作了专门修正。以深色阅读表面基色 `#191e2a` 核算为 **2.7620:1**；实际阅读表面带 0.97 alpha，最终值需按背景合成复核。这一项的数值是名义背景计算，不宣称为实机截图的精确测量。

**修复建议：** 对标签、数值、次要数值分别使用语义文字色，不能只修 dt、small 与标题而遗漏主要数据。保留原有数量格式、对齐与层级。

**复核步骤：** 在包含实际会话的用量页切换深色并展开轮次，检查会话总量、各用量桶数值、成本、状态和说明。不能只对空状态截图验收。

### C03 · 关闭图例不等于禁用按钮，不能用低透明度规避可读性

**位置：** trend.css 的 `.trend-legend[aria-pressed=false] { opacity: .35; text-decoration: line-through }`；usage-chart.js 的图例按钮生成与 click 处理。

这些按钮在 aria-pressed=false 时仍然可以点击以重新显示曲线，并没有 disabled；因此它们不是不可操作控件，不适用 WCAG 对真正禁用控件的对比度豁免。

以“未缓存输入”图例为例，浅色最终文字 `#315ac4` 整体降到 0.35 opacity 后，按纯白背景合成为 **1.7196:1**。深色 `#a3beff` 按阅读基色 `#191e2a` 合成约 **2.2781:1**。两者均明显不足；实际页面背景另需最终验证。

**修复建议：** 保留可读文字，通过划线、选中标记、边界或独立图标区别开关状态；不要给整个可点击按钮降 opacity。图例状态、键盘焦点、曲线隐藏应互相一致。

**复核步骤：** 隐藏一个图例后，验证按钮仍可键盘/鼠标启用、名称仍清晰，且选中/未选中叠加焦点时可辨。

### 对比度计算说明

本次在隔离 Python 环境实际执行 sRGB 相对亮度计算。先将 0–1 sRGB 分量按以下式子线性化：小于等于 0.04045 时除以 12.92，否则使用 `((c + 0.055) / 1.055) ** 2.4`。相对亮度权重为 0.2126、0.7152、0.0722；对比度为 `(Lmax + 0.05) / (Lmin + 0.05)`。透明文字示例先按指定 alpha 与背景合成再计算。

这些计算只验证列出的色对与假设，不是全应用自动扫描。判断阈值用未四舍五入的值；表格显示值仅供阅读。依据见 [WCAG 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)。

## 4. P1：需要处理的错误仅用自动消失的提示承载

### E01 · 公共错误提示 16 秒后被隐藏

**位置：** `src/renderer.js`，`action(name, value)` 的 catch 分支；`src/index.html` 的 `#error`。

```js
errorTimer = setTimeout(() => $('error').hidden = true, 16000);
```

该入口被保存密钥、检查更新、下载等桌面动作使用。失败时会展示 role=alert，但统一在 16 秒后隐藏；开始另一个 action 也先隐藏错误。它没有按错误的重要性区分临时反馈与需要持续处理的问题。

以密钥保存失败为例，输入值确实得到保留，这是正确的；但失败原因没有写进字段关联的 `#key-message`。等待提示消失后，用户仍在失败状态，却不再能直接查看原因。role=alert 解决播报语义，不解决错误信息的持久性。

**修复建议：** 将字段错误放到对应字段附近，将更新错误放到更新区域，持续保留原因与恢复入口，直至问题解决或用户主动关闭。普通成功通知仍可自动消失。避免用一次全局“查看日志”替代所有具体恢复说明。

**通过条件：** 模拟保存、检查更新与下载失败，16 秒后仍可找到未解决的错误原因；用户可修正/重试，输入不丢失，辅助技术可感知；不要触发真实付费模型请求。

## 5. P2：需要补强，但不能误称 Apple/WCAG 硬性不合格

### F01 · 空密钥提交没有解释

renderer.js 的保存分支在 `!key.trim()` 时直接 return。保存按钮可被点击，Enter 也会调用，但空值没有就地提示。建议选择“无有效输入时禁用并解释”或“提交时就地提示请输入密钥”，并明确清除已存密钥是否为独立操作。

这不等于已发现密钥丢失：当前代码失败保留输入、成功才清空，不能反向误报。

### D01 · 设计变量仍有较多分散字面值

颜色、圆角、字号和间距分别散落于 style.css、usage.css、pricing.css、trend.css、appearance.css 与 desktop.css。已有 `--ink`、`--muted`、`--surface`、`--reading-surface` 是正确基础，但 C01–C03 表明语义迁移没有覆盖所有状态。

建议先补齐 action-text、data-value、secondary-text、selected/unselected、error 等角色，并逐步消除近似覆盖，不为此次审查另建第三套主题系统。

### T01 · 部分信息密度高、文字偏小，需要按桌面场景判断

代码里存在 10–12px 的标签、明细和按钮，部分标题则较大。相比本规范建议的正文/标签起点，仍有可读性和层级优化空间；但 WCAG 没有“所有正文必须 16px”的通用最低字号要求，不能把数值不同直接写成标准不通过。

先提高关键任务信息、数值与恢复提示的可读性，再保留真正次要元信息的紧凑样式；用实际 Windows DPI、缩放与长文本验证，而不是一刀切放大所有控件。

## 6. 已有实现应保留的部分

以下为“源码中已有实现/入口”，不是本次真实应用运行通过的认证。

| 方面 | 当前证据 | 审查判断 |
|---|---|---|
| 导航与焦点 | desktop-interaction.js 设置 aria-current、方向键/Home/End、页面标题定位与可用焦点记忆，忽略无变化的后台刷新 | 方向符合，保留并实测完整流程 |
| Windows 习惯 | main.cjs 的原生窗口、编辑菜单、F6 跨视图、桌面快捷键与两视图同步缩放 | 不应为了苹果外观改掉平台习惯 |
| 阅读表面与工具材质 | desktop.css 将 `.grid>.card`、`.usage-card` 与多数 `.metric` 改为 reading-surface 并取消 backdrop-filter | 主要信息区已有稳定表面，不是全站玻璃化 |
| 系统偏好 | appearance.css 的减少动效媒体规则与用户选择，desktop.css 的 forced-colors 与高对比处理 | 已有机制，真实偏好/硬件仍需验证 |
| 输入保护 | renderer.js 保存期间禁用提交，失败保留输入，成功后才清空；Enter 兼顾输入法合成 | 实现方向正确，与错误持久化分别判断 |
| 破坏性确认 | main.cjs 重启与回退使用原生确认，默认和取消选项均为安全选项，并说明停止服务/快照后果 | 没有误判成“无确认直接重启” |
| 真实状态 | 启动、就绪、失败与重试入口；用量界面区分未上报、未计价和零值 | 保留，不以演示动画替代状态 |
| 自动化测试意图 | desktop-smoke.cjs 覆盖焦点恢复、失败输入保留、模态、Esc、缩放、窗口恢复、跨视图焦点和系统偏好 | 测试有价值，但本轮未运行 |

同样不把 `button:disabled { opacity: .45 }` 单独判为 WCAG 失败；真正不可操作控件有标准豁免。HUIYU 更严格的禁用文字约束不会自动变成 DeepSeek 的现行强制要求。桌面按钮最小 32px 也不因小于触屏建议 44px 就自动判不合格。

## 7. 仍需真实运行确认的项目

### V01 · 对比度测试目前不是全量检查

本次读到的 desktop-smoke.cjs 在双主题用量页中验证了 `.metric-primary small` 为白色并截图，但未对 C01–C03 对象计算对比度；失败输入测试只等待错误出现，没有等待 16 秒验证其保留。这解释了为什么存在测试脚本仍可能遗漏这些问题。此判断仅针对该脚本，不声称扫描了所有仓库测试。

应增加有真实明细、关闭图例和失败状态的针对性断言；截图需人工复核实际图片/壁纸下的颜色与布局。

### V02 · 窄窗口与 200% 缩放有测试定义，但本轮未执行

脚本布局矩阵为 760×560/100%、1000×740/125%、760×560/200%、1440×980/100%，检查页面横向溢出和导航范围。该矩阵不是本次通过记录，也没有明确覆盖 320 CSS px。

按 Web 重排要求，另验证一般纵向内容的 320 CSS px 场景，或者明确桌面产品的支持边界并避免宣称已达到相应条款。必要二维画布/图表的局部例外不能豁免周围表单和操作。此项是验收缺口，不是已复现的横向溢出缺陷。依据见 [WCAG 1.4.10](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)。

### V03 · 上游工作空间不能由桌面管理页代验

应用使用独立 WebContentsView 承载 Harness。本文已核查部分切页、缩放、焦点与主进程边界，但没有实际跑完上游任务开始、取消请求中、断线、恢复和完成的全链路。因此不能把桌面 starting/ready/error 当作完整任务状态机，也不能仅据此判上游缺失全部其他状态。

### V04 · 动效与材质的观感仍需运行环境验证

当前文档有独立参考与共享模块说明，CSS 和测试入口也支持减少动效、强制颜色。但本轮没有测实际 GPU 帧率、玻璃折射、快速反向、晚到快照、真实屏幕阅读器、不同 DPI/显示器，也未完成无开发环境 Windows 分发包验收。没有这些证据，不宣称 Apple 原生等价、全平台无障碍或稳定版交付。

## 8. 建议实施与复验顺序

1. 先修 C01–C03：补语义文字角色、移除可操作图例的整体降透明度，验证浅色/深色、选中/未选中、有数据/空状态。
2. 再修 E01/F01：字段与更新错误持久化，明确空值反馈；保留输入保护与安全确认。
3. 在隔离测试数据下执行相关单元与桌面验收；补 16 秒错误保留和实际对比度断言，再检验缩放、短窗口、模态与壁纸。
4. 最后整理令牌与字号层级；只有明确收益才调整材质/动效，不扩大为无关重构。

仓库已有、后续可用的验证入口：

```powershell
node --test tests/desktop.test.cjs tests/fluid-design.test.cjs tests/appearance.test.cjs
node scripts/desktop-smoke.cjs
node scripts/appearance-smoke.cjs
node scripts/desktop-smoke.cjs --packaged
```

上面是建议后续执行的命令，**本次未执行**。需要准备对应运行时/分发目录，并继续采用脚本的隔离用户数据，不接触生产凭据或真实付费任务。

## 9. 可追溯源码

以下链接固定到本次审查快照，后续修复后可据此比较；路径及选择器/函数是主要定位方式，因为部分 CSS/HTML 为单行压缩格式。

- [桌面入口与样式加载顺序](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/src/index.html)
- [基础样式：文字动作与 label span](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/src/style.css)
- [外观与主题覆盖](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/src/appearance.css)
- [阅读表面与共享材质变量](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/src/fluid-design.css)
- [最终桌面样式与响应式](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/src/desktop.css)
- [用量明细样式](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/src/usage.css)
- [价格样式覆盖](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/src/pricing.css)
- [图例样式](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/src/trend.css)
- [图例按钮生成与事件](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/src/usage-chart.js)
- [公共错误与密钥提交](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/src/renderer.js)
- [导航与焦点](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/src/desktop-interaction.js)
- [桌面主进程与重启/回退确认](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/src/main.cjs)
- [现有桌面验收脚本](https://github.com/starplatium1129-stack/deepseek-harness-desktop-app/blob/c22869d6e3c3876ca3ae69804a0496ccf79e22d0/scripts/desktop-smoke.cjs)

**最终建议：保留现有结构，优先补齐可读性与异常恢复；修复和真实回归完成之前，不标记“已全面达到 Apple HIG/WCAG 要求”。**
