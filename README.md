# Local Codex + Ollama

在 ChatGPT/Codex 桌面 GUI 中使用本机 Ollama 模型，同时保留原有云端配置。仓库只包含适配器、模型目录和启动脚本；不包含模型权重、账号、个人配置快照或运行日志。

## 行为

- macOS 本地模式只把本次选择且已经安装的模型写入模型目录。`local 9b` 不再要求同时下载 27B。Windows 现有工作流仍可准备两个模型。
- 本地模式和 OpenAI 云端模式使用不同 provider。由于 Codex 的 provider 是独立配置，单靠同一个模型选择器不能在两者之间跨服务切换；Windows 用本地/云端快捷方式，macOS 用下方命令切换。
- 适配器监听 `127.0.0.1:11435`，上游 Ollama 默认 `127.0.0.1:11434`。Windows 由用户级计划任务托管，并有每分钟健康检查；macOS 由用户级 `launchd` 保持运行。
- 本地目录保留 Apps、插件、skills、Browser、Chrome、Computer Use 和 MCP 的使用说明。适配器把 Codex Responses API 的 `namespace` 工具展开成 Ollama 支持的普通函数调用，并在响应中还原 namespace；Codex 仍负责执行工具、OAuth、权限审批和沙箱。

参考：[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)中的 `model_provider`、`model_catalog_json` 和自定义 provider 项。

## 先决条件

1. 安装并至少打开一次 ChatGPT/Codex 桌面应用，使 `~/.codex/config.toml` 存在。
2. 安装 Ollama 和支持 `zlib.zstdDecompressSync` 的较新 Node.js。Windows 还需 PowerShell 5.1 及任务计划程序。
3. 在每台电脑各自下载需要的模型权重（不会随 Git 仓库传输）：

   ```text
   ollama pull qwen3.5:9b
   # 只有准备使用 27B 时才需要：
   ollama pull qwen3.8:27b
   ```

   Ollama 官方目录中的默认量化权重约为：9B 6.6 GB，27B 18 GB。27B 还需要额外运行空间；磁盘和统一内存不足时只安装 9B。

## 本地工具兼容性

| 能力 | 9B 本地模式 | 说明 |
|---|---|---|
| Shell、文件和普通 function tools | 支持 | 由 Codex 执行，保留沙箱和审批。 |
| Skills | 支持 | 本地目录会注入 skill 使用说明。 |
| Apps、插件和 MCP namespace tools | 支持桥接 | Codex 保管连接与 OAuth；适配器不会把凭据转发给 Ollama。 |
| Browser、Chrome、Computer Use | 支持桥接 | 需要相应插件、Chrome 扩展及 macOS 屏幕录制/辅助功能权限。9B 的操作规划可靠性低于大型云端模型。 |
| OpenAI 托管的 `web_search` 等 built-in tools | 不直接支持 | 使用已安装的 Browser/MCP 搜索工具，或切回云端 provider。 |
| 并行工具调用 | 暂停 | 适配器将 `parallel_tool_calls` 固定为 `false`，降低小模型误调用。 |

远程 Apps 和网站仍然需要网络；“本地模式”指模型推理由 Ollama 完成，不代表外部数据源离线。Computer Use 仍受 Codex 原有安全限制，不能代替用户批准 macOS 隐私权限，也不能用来控制 Codex 自身。

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

这会只检查 9B 基础模型、创建 16K 别名、安装用户级 `launchd` 服务、保存云端设置并配置单模型本地目录。然后**退出并重新打开 ChatGPT/Codex 桌面应用**以加载目录。需要 27B 时，先确保有足够磁盘和内存，再拉取模型并运行 `node macos/local-codex.mjs local 27b`。

恢复云端或检查状态：

```sh
node macos/local-codex.mjs cloud
node macos/local-codex.mjs status
```

脚本会在尚未安装基础模型时进行磁盘空间预检：9B 至少需要约 9 GiB 可用空间，27B 至少需要约 24 GiB。首次切换后请先用一条短消息验证请求，再运行长任务。

## 故障检查与测试

```sh
node test-codex-ollama-adapter.mjs
npm run test:live
```

`npm test` 使用本机模拟上游，不消耗模型推理，覆盖模型路由、system 指令、单模型目录、配置回滚、namespace/App/Computer Use 工具桥、历史调用、图片结果、凭据隔离和流式事件。`npm run test:live` 默认用已激活的 9B 运行文本和 namespaced function-call 实测；也可追加模型 slug。Windows 日志在 `%LOCALAPPDATA%\CodexOllama`；macOS 日志在 `~/.local/state/codex-ollama-agent`。健康端点是 `http://127.0.0.1:11435/health`。

如果 9B 连续生成无效工具参数，或任务必须使用 OpenAI provider 托管的 built-in tool，请运行 `node macos/local-codex.mjs cloud` 并重启 Codex。云端切换会按完整文本快照恢复进入本地模式前的配置，包括 provider、模型、feature、MCP 设置、注释和原有顺序；macOS/Linux 上快照权限强制为仅当前用户可读写（`0600`）。

脚本只在本机监听，保留 Codex 自身的沙箱与审批策略。旧任务如果保留了 27B 和高推理档位，会比 9B 慢很多；在右下角改选 9B/较低档位即可，不再需要换桌面入口。
