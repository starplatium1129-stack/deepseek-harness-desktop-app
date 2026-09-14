# 桌面外观（0.4.2）

顶部「外观」管理三组独立设置：

- 经典 / 液态玻璃预设，浅色 / 深色 / 跟随系统。
- 默认、柔光渐变、纯色、本地静态壁纸；填充 / 适应、0–40 px 模糊，浅深色分别保存遮罩。
- 完整动效 / 减少动态效果 / 跟随系统；另有降低玻璃效果开关。

预设默认经典，颜色与动效默认跟随系统。玻璃预设使用圆弧边缘位移场，对实际 backdrop 做屏幕空间折射，配合连续弹簧动效。实现与复用说明见 [苹果设计参考](apple-design-reference.md)，不是 Apple 原生合成器的逐像素复刻。

背景与材质独立：经典和玻璃预设共享各页面原有的默认底色，不为玻璃另设背景，也不对默认底色附加模糊或遮罩。只有显式选择柔光渐变或本地图片才显示彩色背景；切换预设保留用户选择的背景。

0.4.1 修复了玻璃模式下上游设置面板被限制在侧栏宽度的问题。侧栏的滤镜移至独立装饰子层，布局容器本身不使用 backdrop-filter，避免改变内部 fixed 弹窗的定位参照。

## 保存与边界

`userData/appearance/settings.json` 保存非敏感外观设置。主进程使用原生文件选择器导入 PNG / JPEG / WebP，源文件上限 20 MB；解码后最长边缩至 2560 px，以 JPEG 保存到该目录。图片只在本地处理；不上传，不依赖原文件持续存在。透明图片会转换为 JPEG，因此不保留透明通道。

通用桌面管理 IPC 仅接受受信桌面页面的主框架。前端不能传入壁纸文件路径；只能通过原生选择器导入。保存按队列串行执行，先写临时文件再替换配置。导入成功后才清理上张应用内副本。恢复默认会清除应用内壁纸副本，不改动原始图片。壁纸缺失或配置 JSON 损坏时回到可用默认值。

更新应用不迁移或覆盖此目录。颜色、背景与动效切换不重启 Harness。

## 上游适配

`src/appearance-adapter.cjs` 将共享的 `appearance-theme.js` 和独立的 `appearance-workspace.css` 应用到 Harness WebContentsView。与桌面管理页保持同一组设置。上游页面仅能通过专用桥上报 light / dark / system 三种主题偏好，不能调用桌面管理动作或读写文件；主进程验证当前工作空间、主框架与回环源。

`integrations/client.js` 使用上游公开的 `theme.getTheme()` / `theme.setTheme()` 和 `theme/change` 事件双向同步颜色模式。工作空间入口更改时立即更新本页材质，再上报主进程统一保存、更新原生主题与桌面外观页；桌面入口更改经同一串行队列同步回工作空间。发送来源与偏好去重避免通知回环，状态版本避免迟到通知覆盖新选择。启动以桌面保存的偏好初始化，之后两个入口都能修改它；system 保存的是偏好，不是某一次解析出的深色或浅色。

初始化通过公开的 `settingsScope.bind({ namespace: 'ui-theme' })` 等待配置就绪，再下发桌面偏好；未推进命名空间版本的旧值不回写桌面。工作空间发起的变更只通知桌面，不回送工作空间重新调用 setTheme，避免覆盖上游尚在处理的较新选择。

布局选择器来自内置 `@deepseek-ai/dsh-client-ui-*` **0.1.5-rc.2** 的 CSS modules：布局 `pI_x6G_*`，侧栏 `hHd-Xa_root`，会话 `wSkVaW_*`，空态 `pXSMma_root`，输入卡片 `uV2eYG_card`。只调整外壳、侧栏、输入与菜单材质；正文滚动区域保留高不透明度底色，代码和终端保留上游内容背景。

这些选择器可能随上游版本改变。升级核心时须重新检查主题服务、上述布局选择器、正文可读性和侧栏展开行为。未知布局仍使用其上游表面样式，不能将当前检查视为未来版本兼容性保证。

## 验证入口

```powershell
node --test tests/appearance.test.cjs tests/integrations.test.cjs tests/usage.test.cjs tests/task-notifications.test.cjs
node scripts/appearance-smoke.cjs
node scripts/appearance-smoke.cjs --packaged
node scripts/workspace-settings-smoke.cjs --packaged
node scripts/theme-sync-smoke.cjs --packaged
```

打包测试默认读取 `release/appearance-0.4.2/win-unpacked/DeepSeek Harness Desktop.exe`，也可用 `DSH_SMOKE_EXECUTABLE` 指定路径。测试数据在系统临时目录，截图在 `.test-data/appearance-screenshots`。测试原生图片解码和复制时，仅将文件选择器替换为固定测试图片；重启后验证原图已删除而壁纸仍可读。

本次验证包含真实 Electron 与内置 Harness 启动、主题同步、切换设置、低效果模式、减少动画、复制壁纸和再次启动恢复。没有使用模型凭据发送新任务，也未在无开发环境的独立 Windows 虚拟机中验证安装向导；打包启动测试移除了子进程 PATH 中的开发工具。
