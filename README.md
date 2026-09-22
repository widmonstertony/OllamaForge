# Local Codex + Ollama

在 ChatGPT/Codex 桌面 GUI 中使用本机 Ollama 模型，同时保留原有云端配置。仓库只包含适配器、模型目录和启动脚本；不包含模型权重、账号、个人配置快照或运行日志。

## 一键部署 27B IQ4_XS（推荐）

适用于 Windows 和 macOS。先安装 Git、Node.js 24+、Ollama，并至少打开一次 ChatGPT/Codex，然后在仓库目录运行：

```sh
npm run deploy
```

该命令自动完成以下步骤：

1. 从 Hugging Face 下载 `Qwen3.8-27B-IQ4_XS-3.84bpw.gguf`，支持断点续传，并用固定 SHA-256 校验完整性。
2. 持久化 Ollama 配置：110K 上下文、Q4_0 K/V cache、Flash Attention、单并发。
3. 重启 Ollama，创建 `qwen3.8-codex-iq4-xs-110k`，并用 `draft_num_predict 0` 关闭 MTP。
4. 通过 Ollama 原生 `http://127.0.0.1:11434/api/codex/v1` 网关把模型加入 Codex，同时保留原有云端默认模型。
5. 创建桌面快捷方式，并发送 `PING` 做真实直连验收。

模型约 12.18 GiB；首次部署还需要导入和运行空间，建议至少预留 16 GiB。下载中断后再次运行同一命令即可续传。部署完成后彻底退出并重新打开 Codex，在模型选择器中选择 `qwen3.8-codex-iq4-xs-110k`。

若只想完成配置而跳过首次模型推理验收，可运行：

```sh
npm run deploy -- --skip-smoke
```

## macOS / Windows 一键接入

安装 Git、Node.js 24+、Ollama，并至少打开一次 ChatGPT/Codex 后，在仓库目录运行同一条命令：

```sh
# 默认下载并接入约 6.6 GB 的 9B；适合 16–24 GB 内存电脑
npm run setup -- --model 9b

# 或者下载并接入约 18 GB 的 Qwen 3.8 27B
npm run setup -- --model 27b

# 使用 models 目录中已有的 27B IQ4_XS GGUF，接入 110K Codex 模型
npm run setup -- --model 27b-iq4-xs --no-pull
```

PowerShell 中命令完全相同。脚本只下载所选模型、创建对应的 16K Codex 别名、调用 Ollama 的 ChatGPT 集成，然后把运行前的 Ollama 云端或 OpenAI 模型恢复为默认模型。本地模型会同时出现在选择器里。完成后请彻底退出并重新打开 ChatGPT/Codex。

另一台电脑更新仓库后可以直接运行：

```sh
git pull
npm run setup -- --model 9b
```

模型权重保存在每台电脑自己的 Ollama 目录，永远不会提交到 Git。重复配置且模型已经下载时可加 `--no-pull`；如果模型不存在，该选项会安全报错而不会下载。

`27b-iq4-xs` 要求仓库中存在 `models/Qwen3.8-27B-IQ4_XS-3.84bpw.gguf`。对应 Modelfile 将上下文设为 110,000、将 `draft_num_predict` 设为 0 以关闭 MTP。Q4 KV cache 是 Ollama 服务级配置；Windows 上设置用户环境变量 `OLLAMA_FLASH_ATTENTION=1`、`OLLAMA_KV_CACHE_TYPE=q4_0`、`OLLAMA_CONTEXT_LENGTH=110000` 和 `OLLAMA_NUM_PARALLEL=1` 后，需要重启 Ollama。

## 行为

- 一键安装和平台快捷方式都只准备本次选择的模型。选择 9B 不会检查或要求 27B，反之亦然。
- 一键安装采用混合目录：原有云端模型继续作为默认，本地模型通过 `127.0.0.1:11434` 的 Ollama Codex 网关按需推理。
- 一键安装让云端和本地模型统一经过 Ollama 的 Codex 网关，因此可在同一个模型选择器中切换。下方旧的“完全本地 provider”快捷方式仍是独立模式，可用于不希望云端请求经过 Ollama 时。
- 适配器监听 `127.0.0.1:11435`，上游 Ollama 默认 `127.0.0.1:11434`。Windows 由用户级计划任务托管，并有每分钟健康检查；macOS 由用户级 `launchd` 保持运行。
- 本地目录保留 Apps、插件、skills、Browser、Chrome、Computer Use 和 MCP 的使用说明。适配器把 Codex Responses API 的 `namespace` 工具展开成 Ollama 支持的普通函数调用，并在响应中还原 namespace；Codex 仍负责执行工具、OAuth、权限审批和沙箱。

参考：[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)中的 `model_provider`、`model_catalog_json` 和自定义 provider 项。

## 先决条件

1. 安装并至少打开一次 ChatGPT/Codex 桌面应用，使 `~/.codex/config.toml` 存在。
2. 安装 Ollama 和 Node.js 24 或更新版本。Windows 快捷方式还需 PowerShell 5.1 及任务计划程序。
3. 保留足够空间：脚本在缺少模型时要求 9B 至少 9 GiB、27B 至少 24 GiB 可用磁盘。Ollama 默认量化权重约为 6.6 GB 和 18 GB。27B 建议 32 GB+ 统一内存；24 GB 可以加载，但会自动把部分层卸载到 CPU，首次加载和输出都很慢。实测 M4 Pro 24 GB 在 Codex 同时运行时完成一组短文本和工具调用用了约 10 分 40 秒。日常交互优先使用 9B 或云端模型。

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

推荐先用跨平台脚本下载并配置所选模型，再按需安装桌面快捷方式：

```powershell
npm run setup -- --model 9b
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

推荐直接使用混合云端/本地目录：

```sh
npm run setup -- --model 9b
# 或：npm run setup -- --model 27b
```

旧的完全本地 provider 切换方式仍然保留：

```sh
node macos/local-codex.mjs local 9b
```

这会只检查 9B 基础模型、创建 16K 别名、安装用户级 `launchd` 服务、保存云端设置并配置单模型本地目录。然后**退出并重新打开 ChatGPT/Codex 桌面应用**以加载目录。需要 27B 时，先确保有足够磁盘和内存，再拉取模型并运行 `node macos/local-codex.mjs local 27b`。

恢复云端或检查状态：

```sh
node macos/local-codex.mjs cloud
node macos/local-codex.mjs status
```

安装可双击的桌面恢复快捷方式：

```sh
npm run install:macos-cloud-shortcut
```

桌面上的“云端 Codex”会先提示正在运行的任务将被中断；确认后，它会恢复“云端模型为默认、Ollama 本地模型仍可选”的混合目录，并退出、重新打开 Codex。若仓库或 Node.js 移动到新目录，请重新运行安装命令更新快捷方式。纯 OpenAI 回滚仍可手动运行 `node macos/local-codex.mjs cloud`。

如果曾手动执行 `ollama launch chatgpt`，模型选择器里仍缺本地模型，重新运行一键命令即可自动生成并合并：

```sh
npm run setup -- --model 9b --no-pull
```

混合模式只加入 `ollama list` 中真实安装、且有 Ollama 路由元数据的本地模型；默认模型、Ollama 云端模型、OpenAI 云端模型、Apps、插件和浏览器配置保持不变。脚本在 macOS 的 `~/.ollama/backup/codex-app` 或 Windows 的 `%USERPROFILE%\.ollama\backup\codex-app` 保留变更前的配置；任何集成错误都会自动恢复调用前的三份文件。

脚本会在尚未安装基础模型时进行磁盘空间预检：9B 至少需要约 9 GiB 可用空间，27B 至少需要约 24 GiB。首次切换后请先用一条短消息验证请求，再运行长任务。

## 故障检查与测试

```sh
node test-codex-ollama-adapter.mjs
npm run test:live
```

`npm test` 使用本机模拟上游，不消耗模型推理，覆盖模型路由、system 指令、单模型目录、配置回滚、namespace/App/Computer Use 工具桥、历史调用、图片结果、凭据隔离和流式事件。`npm run test:live` 默认用已激活的 9B 运行文本和 namespaced function-call 实测；也可追加模型 slug。测试混合模式的原生网关时可设置 `CODEX_RESPONSES_URL=http://127.0.0.1:11434/api/codex/v1/responses`；24 GB 机器首次加载 27B 可同时设置 `CODEX_TEST_TIMEOUT_MS=600000`。Windows 日志在 `%LOCALAPPDATA%\CodexOllama`；macOS 日志在 `~/.local/state/codex-ollama-agent`。健康端点是 `http://127.0.0.1:11435/health`。

如果 9B 连续生成无效工具参数，或任务必须使用 OpenAI provider 托管的 built-in tool，请运行 `node macos/local-codex.mjs cloud` 并重启 Codex。云端切换会按完整文本快照恢复进入本地模式前的配置，包括 provider、模型、feature、MCP 设置、注释和原有顺序；macOS/Linux 上快照权限强制为仅当前用户可读写（`0600`）。

脚本只在本机监听，保留 Codex 自身的沙箱与审批策略。旧任务如果保留了 27B 和高推理档位，会比 9B 慢很多；在右下角改选 9B/较低档位即可，不再需要换桌面入口。
