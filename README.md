# Local Codex + Ollama

在 ChatGPT/Codex 桌面 GUI 中使用本机 Ollama 模型，同时保留原有云端配置。仓库只包含适配器、模型目录和启动脚本；不包含模型权重、账号、个人配置快照或运行日志。

## 行为

- 本地模式在模型选择器中列出 `qwen3.5-codex-fast-16k`（9B）和 `qwen3.8-codex-16k`（27B）。**实际请求使用你在界面选择的模型**；启动入口只决定新任务的初始默认值，不会覆盖你的选择。旧任务也会保留其已选模型，必要时请在该任务中手动改选。
- 本地模式和 OpenAI 云端模式使用不同 provider。由于 Codex 的 provider 是独立配置，单靠同一个模型选择器不能在两者之间跨服务切换；Windows 用本地/云端快捷方式，macOS 用下方命令切换。
- 适配器监听 `127.0.0.1:11435`，上游 Ollama 默认 `127.0.0.1:11434`。Windows 由用户级计划任务托管，并有每分钟健康检查；macOS 由用户级 `launchd` 保持运行。

参考：[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)中的 `model_provider`、`model_catalog_json` 和自定义 provider 项。

## 先决条件

1. 安装并至少打开一次 ChatGPT/Codex 桌面应用，使 `~/.codex/config.toml` 存在。
2. 安装 Ollama 和支持 `zlib.zstdDecompressSync` 的较新 Node.js。Windows 还需 PowerShell 5.1 及任务计划程序。
3. 在每台电脑各自下载模型权重（不会随 Git 仓库传输）：

   ```text
   ollama pull qwen3.5:9b
   ollama pull qwen3.8:27b
   ```

   27B 的下载与内存/显存需求明显高于 9B；若机器资源不够，可先只用 9B，但当前启动脚本为保证两个选项都可用，会要求两者已安装。

## Windows

在仓库目录运行一次：

```powershell
& .\Start-CodexOllama.ps1 -ModelName qwen3.5-codex-fast-16k
& .\Install-WindowsShortcuts.ps1
```

桌面的“本地 Codex（GUI）”默认 9B；进入本地 GUI 后直接在右下角选 9B 或 27B，无需另一枚模型快捷方式。若这台电脑以前创建过“本地 Codex（高质量 27B）”，它现在也只改变初始默认值，可以忽略。桌面的“云端 Codex”恢复切换前的 OpenAI 配置。快捷方式切换会关闭并重开 Codex 窗口，运行中的任务会中断，请先保存工作。

不创建快捷方式也可运行：

```powershell
& .\Launch-Codex-GUI.ps1
& .\Launch-Codex-GUI.ps1 -Preset Quality
& .\Restore-Codex-Cloud.ps1
```

`Start-CodexOllama.ps1` 按当前用户的安装位置查找 Node/Ollama，不需要编辑仓库中的个人路径。若仓库移动到新目录，请重新运行 `Install-WindowsShortcuts.ps1`；已注册的计划任务指向旧目录时会拒绝静默覆盖，需先明确迁移旧任务。

## macOS

在仓库目录运行：

```sh
node macos/local-codex.mjs local 9b
```

这会检查两个 Ollama 基础模型、创建 16K 别名、安装用户级 `launchd` 服务、保存云端设置并配置本地模型目录。然后**退出并重新打开 ChatGPT/Codex 桌面应用**以加载目录。以后可在界面里直接选 9B 或 27B；`local 27b` 只改变新任务的初始默认值。

恢复云端或检查状态：

```sh
node macos/local-codex.mjs cloud
node macos/local-codex.mjs status
```

macOS 脚本在 Windows 上做过静态语法检查，但本仓库尚未在真实 Mac 上完成端到端实测；首次在 Mac 使用时，请先用一条短消息验证请求，再运行长任务。

## 故障检查与测试

```sh
node test-codex-ollama-adapter.mjs
```

此测试使用本机模拟上游，不消耗模型推理，核对“选 9B 就转 9B、选 27B 就转 27B”，以及 system 指令和工具兼容处理。Windows 日志在 `%LOCALAPPDATA%\CodexOllama`；macOS 日志在 `~/.local/state/codex-ollama-agent`。健康端点是 `http://127.0.0.1:11435/health`。若 Windows 整个后台任务意外退出，看门狗在本地模式下至多约一分钟内尝试重启；已开始但断开的那轮模型生成需要 Codex 重试。

脚本只在本机监听，保留 Codex 自身的沙箱与审批策略。旧任务如果保留了 27B 和高推理档位，会比 9B 慢很多；在右下角改选 9B/较低档位即可，不再需要换桌面入口。
