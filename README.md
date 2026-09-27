# OllamaForge

把**已经安装在本机 Ollama 中的模型**加入 Codex/ChatGPT 桌面端，同时保留
原有云端模型。每个 Codex 任务都可以在模型选择器中独立选择本地或云端模型，
并继续使用 Codex Harness、Skills、Apps、MCP、Browser、Computer Use、Shell、
文件编辑、沙箱和审批。

> 默认安装路径永远不会下载模型、创建模型别名或修改 Ollama 的上下文/KV
> cache。模型由用户自己选择并安装，OllamaForge 只负责安全连接和配置回滚。

## 支持范围

| 平台 | 状态 | 桌面入口 |
| --- | --- | --- |
| macOS | 支持 | `Codex.app` 或 `ChatGPT.app` |
| Windows 10/11 | 支持 | Microsoft Store/桌面版 Codex |
| Linux | 不提供桌面 GUI 集成 | 可使用 Ollama/Codex CLI，但不属于本仓库的一键桌面流程 |

要求：

- Node.js 24 或更新版本；
- 当前版 Ollama，且支持 `ollama launch chatgpt`；
- 已登录并至少打开过一次 Codex/ChatGPT，使 `~/.codex/config.toml` 存在；
- 至少一个由用户自己安装或导入的本地 Ollama 模型。

本仓库没有 npm 依赖，clone 后不需要先运行 `npm install`。

## 三步开始

### 1. 确认本地模型

```sh
ollama list
```

如果列表为空，请先自行选择并安装模型。OllamaForge 不会替用户决定或静默下载。

### 2. 克隆仓库

```sh
git clone https://github.com/widmonstertony/OllamaForge.git
cd OllamaForge
```

### 3. 连接 Codex

```sh
npm run setup
```

这条命令会：

1. 检查 Ollama、Codex 配置和已安装模型；
2. 调用 Ollama 官方 ChatGPT/Codex 集成生成本地模型目录；
3. 保留连接前的云端模型、默认模型、Reasoning 设置、Apps 和插件配置；
4. 把所有可用的本地模型加入同一个 Codex 模型选择器；
5. 创建平台对应的桌面快捷方式；
6. 在任何失败时保留或恢复原配置。

它不会下载模型。完成后彻底退出并重新打开 Codex，随后直接在每个任务的模型
选择器中选择本地或云端模型。

## 模型选择

先查看 OllamaForge 能发现的本地模型：

```sh
npm run models
```

默认运行 `npm run setup` 时，当前云端默认模型会保持不变，所有本地模型成为
可选项。若希望下一次打开 Codex 时默认突出某个本地模型，可以明确指定其
`ollama list` 中的完整名称：

```sh
npm run setup -- --model qwen3.8:27b-mlx
```

`--model` 只接受已经安装的精确模型名；不存在时立即报错，不会 pull。

连接完成后无需反复运行 setup。直接在 Codex 模型选择器中按任务切换即可：

- 本地模型：推理由 Ollama 在本机执行；
- 云端模型：仍使用原有云端服务；
- Codex Harness 与工具执行层保持不变。

## 常用命令

| 命令 | 行为 | 下载模型 |
| --- | --- | --- |
| `npm run setup` | 首次连接现有模型并安装快捷方式 | 否 |
| `npm run models` | 只列出本地模型，不修改配置 | 否 |
| `npm run refresh` | 模型安装/删除后刷新 Codex 目录 | 否 |
| `npm run launch` | 刷新目录并重启 Codex | 否 |
| `npm run disconnect` | 恢复连接前配置，不删除权重 | 否 |
| `npm test` | 跨平台离线测试 | 否 |
| `npm run test:live -- <模型名>` | 真实文本与工具调用验收 | 否 |

为了兼容旧版本，`npm run connect` 和 `npm run deploy` 都等同于安全的
`npm run setup`，不会下载模型。

## macOS

`npm run setup` 会在桌面创建：

```text
本地 Codex（Ollama 直连）.command
```

双击它会确认 Ollama、刷新模型目录、关闭并重新打开 Codex。它不是“只能使用
本地模型”的开关；重启后本地和云端模型仍同时出现在模型选择器中。

Apple Silicon 上已经安装 `qwen3.8:27b-mlx` 时，可直接复用同一份权重：

```sh
npm run setup -- --model qwen3.8:27b-mlx
```

仓库会把该已知模型在 Codex 目录中的上下文标记为 184,320，并把默认
Reasoning 设为 `none`；不会更改 Ollama 服务的真实运行参数。

## Windows

在 PowerShell 中执行与 macOS 相同的命令：

```powershell
git clone https://github.com/widmonstertony/OllamaForge.git
cd OllamaForge
npm run models
npm run setup
```

桌面会生成“本地 Codex（GUI）”。双击后会启动/确认 Ollama、刷新所有已安装
模型、验证原生 Codex endpoint，然后重启 Codex。完整日志位于：

```text
%LOCALAPPDATA%\OllamaForge\shortcut.log
```

Windows 与 macOS 使用同一混合目录逻辑：云端模型不会因为加入本地模型而消失。

## Qwen3.8 27B 建议

- 48GB Apple Silicon：`qwen3.8:27b-mlx` 可以直接复用；
- 16GB GPU：优先选择能够完整放入显存的量化版本；
- 上下文越大，KV cache 占用和首轮预填充时间越高；
- 多个 Codex/JARVIS 请求共享单个 Ollama 实例时可能排队，这是预期行为。

OllamaForge 不把某一个模型硬编码为必需项。任意已安装模型都可以进入目录，
但模型能否稳定规划工具取决于它自身的 tool-calling 能力。

## 可选：显式准备仓库别名

只有确实需要仓库提供的 Qwen 模板/别名时才运行：

```sh
npm run prepare:alias -- --model 9b
npm run prepare:alias -- --model 27b
```

这两条命令仍然**不会下载**基础模型；缺少 `qwen3.5:9b` 或 `qwen3.8:27b`
时会停止并提示用户先自行安装。

仓库还保留一个明确命名的高级下载器：

```sh
npm run download:27b
```

它会下载约 12.18GiB 的指定 IQ4_XS GGUF、校验固定 SHA-256，并创建 64K/
110K 两个别名。它不是默认 setup 的一部分；只有用户主动执行这条带
`download` 的命令才会联网下载大模型。旧别名 `npm run deploy:27b` 仍保留兼容。

## 隐私边界

- 选择本地模型时，模型推理请求发送到 `127.0.0.1:11434`；
- 选择云端模型时，对话上下文会按原有云端 Provider 的规则离开本机；
- Browser、邮件、远程 MCP 和网站工具本身仍可能访问外部服务；
- OllamaForge 不提交模型权重、Codex 登录信息、个人配置快照或运行日志；
- 适配器不会把 Codex 的 OAuth/API 凭据转发给本地模型。

“本地模型”描述的是推理位置，不代表整个工具任务完全离线。

## 验证与故障排查

离线回归测试：

```sh
npm test
```

真实 Codex/Ollama 网关验收：

```sh
CODEX_RESPONSES_URL=http://127.0.0.1:11434/api/codex/v1/responses \
CODEX_TEST_TIMEOUT_MS=600000 \
npm run test:live -- qwen3.8:27b-mlx
```

Windows PowerShell：

```powershell
$env:CODEX_RESPONSES_URL='http://127.0.0.1:11434/api/codex/v1/responses'
$env:CODEX_TEST_TIMEOUT_MS='600000'
npm run test:live -- qwen3.8:27b-mlx
```

常见问题：

- `No local Ollama model is installed`：先自行安装模型，再运行 `npm run setup`；
- `Codex config not found`：先登录并打开一次 Codex；
- 模型选择器未刷新：彻底退出 Codex，再双击桌面快捷方式；
- 更新或删除模型后目录仍旧：运行 `npm run refresh`；
- 想完全撤销集成：运行 `npm run disconnect` 后重启 Codex；
- Windows 双击失败：查看 `%LOCALAPPDATA%\OllamaForge\shortcut.log`。

## 工作原理

```text
Codex Desktop / Harness
          │
          ├── 云端模型（保留原有路由）
          │
          └── Ollama Codex gateway
                    │
                    └── 本机已安装模型
```

Ollama 原生 endpoint 为：

```text
http://127.0.0.1:11434/api/codex/v1
```

配置变更前的文件会备份到每台机器自己的：

```text
~/.ollama/backup/codex-app
```

所有服务仅绑定回环地址。模型列表刷新不会删除 Ollama 权重；恢复云端配置也不会
卸载本地模型。
