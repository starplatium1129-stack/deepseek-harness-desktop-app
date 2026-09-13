# Windows 旧 Community 版本升级故障

2026-09-13 在本机从旧 Community 0.1.0 升级时，安装器提示 `Failed to uninstall old application files ...: 2`。此前还显示“无法关闭应用”；electron-builder 模板会在旧卸载器连续失败后复用这条提示，因此它不能证明仍有应用进程。

## 已核实的原因

- 安装注册实际指向 `DeepSeek Harness Desktop Community` 的 0.1.0。旁边不带 Community 的 0.2.0 目录未被注册为当前安装，单查后者会误判。
- 安装包 SHA-512 和大小与本地构建清单匹配，旧目录权限和卸载器均正常。
- 使用相同 NSIS 运行时进行只读检查，普通进程检测正确返回“未运行”，未复现进程检测故障。
- 旧运行文件中有一个 261 字符的 `.js.map` 路径。无 longPathAware 的旧 NSIS 进程使用普通路径读取属性时失败，错误码为 3；同一文件使用现有 8.3 根目录别名或扩展路径前缀时成功。
- 旧卸载器使用普通路径逐文件 Rename；失败会中止并返回非零，随后被新安装器包装为错误 2。

## 可恢复的修正

先正常退出 Harness，保存旧安装程序和当前运行文件快照。用户数据位于 Roaming 下独立的 `deepseek-harness-desktop` 目录，不能与安装目录一起清理。

`scripts/repair-legacy-install.ps1` 默认仅检查：验证明确的旧安装目录、程序文件、现有短别名与长路径指向同一目录，以及 HKCU 中本应用安装键的归属。它不会创建短别名或修改 Windows 长路径策略。

```powershell
.\scripts\repair-legacy-install.ps1 -InstallRoot '<实际旧 Community 安装目录>'
.\scripts\repair-legacy-install.ps1 -InstallRoot '<实际旧 Community 安装目录>' -Apply
```

Apply 先把将变更的注册值保存到 `.test-data/legacy-install-repair/registry-before-*.json`，然后只将本应用的 `InstallLocation` 指向已存在的同目录短别名。它不改卸载命令、账号、凭据、安全策略或应用数据。NSIS 升级会据此给旧卸载器传入 `_?=` 路径。

关闭失败安装器后重新启动安装，选择长度足够短的正常目标目录。`/D=` 必须放在 NSIS 命令行末尾；旧版本卸载与新版本安装仍由安装器执行。安装成功后核对注册版本、目标 exe 版本、实际运行进程路径、原数据，以及 MCP 真实修改与续接结果。

本机应用短路径修正后，官方旧卸载流程成功移除旧 Community 程序目录，随后向不带 Community 的正常安装目录安装 0.2.2，退出码为 0。新版 exe 和注册版本已核对，当前 Codex 对安装版原生 Agent 的真实修改与同会话修订也已通过。最终结果见 [协作验收](collaboration-validation.md)。

该修正仅适用于已核实的本项目旧安装；路径不存在、注册项属于另一目录、短别名不可用或注册项并发改变时，脚本会停止，不应删文件强行继续。
