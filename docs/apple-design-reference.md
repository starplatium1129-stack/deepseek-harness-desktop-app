# Fluid：苹果设计原则的桌面实现参考

面向 DeepSeek Harness Desktop 0.4.0，也作为 huiyu 的独立实现参考。交互入口是应用「外观 → 打开交互设计参考」，或用 Chrome / Edge 打开 `src/design-reference.html`。分发目录另提供不依赖 Electron、Node 或框架的参考压缩包。

## 参照什么

- **动效观感以 iOS 18 为目标方向**，实现依据是苹果 [Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803/) 与 [Animate with springs](https://developer.apple.com/videos/play/wwdc2023/10158/) 描述的即时响应、可打断、位置与速度连续、自然收敛。
- **材质以 iOS 27 的改进方向为目标**：折射更一致、对比更清楚。[苹果 iOS 27 介绍](https://apps.apple.com/us/iphone/story/id1896606813)、[WWDC26 平台综述](https://developer.apple.com/videos/play/wwdc2026/102/)。光学材质与内容层次的依据来自 [Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)。
- 布局采用桌面导航、侧栏和鼠标/键盘交互。没有搬用手机的全屏手势，也没有使用 Apple 私有代码、SF 字体或 Apple 图标素材。

这是按公开原则独立实现的 Web 设计系统。**频率、阻尼、折射率和厚度是本项目的设计参数，不是测得或公开的 iOS 18 / 27 系统内部参数。** 没有宣称逐帧、逐像素复刻 Apple 的原生合成器。

## 模块边界

| 文件 | 职责 | huiyu 复用方式 |
| --- | --- | --- |
| `src/fluid-motion.js` | 精确弹簧求解、共享帧调度、导航、按钮、开关、弹窗 | 直接加载；或用 CommonJS 导入 Spring / profiles |
| `src/liquid-glass.js` | 圆弧透镜位移场、实际 backdrop 折射、高光跟随 | 加载后 `LiquidGlass.install({ selector })` |
| `src/fluid-design.css` | 共享材质、边缘、阴影和动效覆盖 | 与两个 JS 模块一起使用 |
| `src/design-reference.*` | 可拖动材质、可反向侧栏、来源展开弹窗、阅读表面 | 独立演示与实现样例 |
| `src/appearance-workspace.*` | Harness 0.1.5-rc.2 的布局与菜单适配 | 不复制到 huiyu，替换为其自身组件适配 |

全局状态约定：`html[data-appearance="glass|classic"]`、`data-scheme="light|dark"`、`data-motion="full|reduced"`、`data-low-effects="true|false"`。

## 连续运动

弹簧按质量归一化的二阶系统求解。内部维护 `value`、`velocity`、`target`。更新目标仅改 `target`，不重置速度；采用解析解而不是逐帧 Euler 积分，避免刷新率改变轨迹。

| 场景 | 固有频率 | 阻尼比 | 设计意图 |
| --- | --- | --- | --- |
| 页面 / 跨视图衔接 | 3.8 Hz | 1 | 临界阻尼，尽快到位，无刻意回弹 |
| 按钮 / 开关 / 导航指示器 | 5.5 Hz | 0.86 | 小幅弹性，保持操作反馈紧凑 |
| 弹窗 / 透镜归位 | 3.4 Hz | 0.94 | 收敛柔和，轻微弹性 |
| 侧栏 | 4.2 Hz | 1 | 连续反向，避免内容宽度抖动 |

默认不使用固定时间的 Bezier 来代替位移弹簧。颜色等非空间反馈仍可用短 CSS transition。按钮按下缩至 0.965；页面位移控制在 8–12 px，避免让桌面大画面飞来飞去。

弹窗从触发按钮的几何中心展开，收回同一位置；途中重新打开沿用现有状态。退出到静止后才关闭原生 `dialog`，保持焦点锁定，结束时将焦点还给触发按钮。Esc 和路由离开都有明确处理。

桌面管理与工作空间是两个独立 WebContentsView，不能直接做跨 DOM 变形。跨视图切换短暂使用当前视口的内存快照完成淡出；快照不落盘、不可交互，解码完成才显示。导航序号拒绝过期请求，防止快速点击导致晚到的页面覆盖新选择。

Harness 侧栏读取上游期望的列宽，以独立 CSS 变量绘制弹簧中的实际宽度；不改上游业务状态。直接拖拽列宽、全屏与显式 instant 状态立即跟随。上游菜单关闭后的视觉副本 `inert` 且 `aria-hidden`，不会重复执行动作或留在键盘导航里。

帧调度只在有运动时运行；静止、页面隐藏或切换到减少动态效果时停止。减少动态效果会让当前运动立即到达最新目标，不等待旧动画完成。

## 有厚度的玻璃

透镜模块计算圆角矩形的有符号距离场，在约 15 px 的圆弧边缘求表面法线，以折射率 1.46 的 Snell 近似得到最大 15 px 的背景位移。中心区域位移为零，轮廓处平滑回到零，避免断裂的黑边。

生成的 RG 位移图进入 SVG `feDisplacementMap`，作用于 **实际合成后的 backdrop**：背景网格、壁纸、字形都会在边缘发生变化，不是复制一张模糊壁纸。2.4 px 预模糊、轻微饱和度提升、边缘亮线和外侧阴影共同表达材质。指针高光用同一弹簧缓动跟随。

这是一种屏幕空间、单层折射近似，不包含 Apple 原生合成器的全部光学行为或多层光线追踪。透明参考透镜用于观察效果；实际桌面使用更稳妥的 regular 材质。

位移图最长边限制为 360 像素、缓存最多 48 份、同时最多 32 个表面。ResizeObserver 在尺寸变化时更新，稳定尺寸重用；DOM 扫描合并到 80 ms 窗口。低效果模式移除滤镜并采用稳定底色。

## 可读性和边界

- 正文、代码与终端保留稳定的阅读表面，不为了透光降低文字可读性。
- 桌面根据壁纸遮罩计算玻璃填充密度，避免把遮罩拉到零后文字直接落在极端黑白壁纸上。浅色玻璃与遮罩的合计密度至少 0.78，深色至少 0.86；不是单纯允许所有层同时全透明。
- 本地壁纸仅经受信主进程的文件选择器导入；上游页面不获得文件系统和桌面 IPC。
- 独立参考窗口不携带桌面 preload；关闭主窗口会一并关闭参考窗口。
- 浏览器支持以本次验证的 Electron 44 / Chromium 为准。独立参考建议使用现代 Chrome 或 Edge；没有宣称 Safari / Firefox 的 SVG backdrop 支持等价。

## 验证与复核

```powershell
node --test tests/fluid-design.test.cjs tests/appearance.test.cjs
node scripts/fluid-design-smoke.cjs
node scripts/appearance-smoke.cjs
node scripts/appearance-smoke.cjs --packaged
```

`fluid-design-smoke` 对同一画面比较折射 scale=32 和 scale=0：差异须集中在边缘，内部保持稳定。另覆盖拖拽、反向、弹窗关闭途中重开、Esc 焦点恢复、减少动效和静止时停止调度，输出截图与 `fluid-interactions.webm`。

`appearance-smoke` 启动真实 Harness，覆盖桌面/工作空间快速切换、真实侧栏和菜单、主题同步、壁纸复制、重启恢复与价格弹窗。打包模式移除子进程 PATH 中的开发工具。

这些检查验证实现行为与材质的实际工作方式，不能替代 iPhone 实机的逐帧对照、所有显卡的帧率验证或无开发环境 Windows 虚拟机的安装验收。后续改变参数，应结合参考页实操和帧录制复核，不能只看静态截图。
