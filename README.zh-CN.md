# OllamaForge

另一台 Windows/macOS 电脑装好下方前置软件后，pull/clone 本仓库并运行
`npm run setup`，即可连接那台电脑已有的 Ollama 模型并发现它自己的 Codex 安装。
不会复制原电脑的账号、插件授权、模型权重或绝对路径。

## Strata：Qwen3.8 Flash 128K（Windows）

可选安装器面向 Windows x64、64GB 级内存和 NVIDIA 12GB 以上显存；
已在 64GB / RTX 4090 Laptop 16GB 上实机验证。配置为：
Qwen3.8-Flash-Next 125B IQ3_S、131,072 tokens、q4_0 KV、MTP 关闭、
CPU 图片输入、单并发，并为桌面预留 2GiB 显存。
约 84GB 的模型下载需要明确执行下载命令。下载前检查 RAM/GPU 兼容性，
选择显存最大的 NVIDIA GPU，按内存调整专家缓存（64GB 级机器为 40GiB，
更大内存机器最多 48GiB），Strata 再按可用内存和 Windows 提交空间自动缩小。
GPU、RAM、SSD 分层保留全部专家；64GB 并不保证同时开其他应用时所有权重都驻留内存。

```powershell
# 下载前检查硬件，不启动模型或服务。
npm run check:strata
# 一个命令安装/下载，并开启登录自动启动。
# 默认放在 repo 旁边的 Strata-data；请选择至少空闲 95GB 的本地 SSD。
npm run download:strata -- -EnableStartup
# 如需自定义位置（示例；按那台电脑的磁盘情况选择）：
# npm run download:strata -- -DataDirectory "$env:USERPROFILE\Strata-data" -EnableStartup
# 接入已经运行的 Strata 128K 预设，不下载模型。
npm run setup:strata
# 登录 Windows 后自动启动已有模型和连接服务，不再需要桌面快捷方式。
npm run startup:strata
# 手动启动/恢复已有模型和连接，不下载、不重启 Codex。
npm run start:strata
# 仅重启本地 Strata 模型，保留云端网关和桥接。
npm run restart:strata
```

重新打开 Codex 后，在模型列表选择 **Strata · Qwen3.8 Flash 128K (IQ3_S)**。
桌面的 **本地 Codex（GUI）** 快捷方式会启动已保存的 Strata 预设、
本地桥接和 Ollama，然后刷新模型目录并重新打开 Codex。
保留原有云端默认模型，每次连接都从当前安装的 Codex 刷新云端模型信息；
只有准确匹配 Strata ID 的请求才发给 Strata，云端凭据不会发给它。
本地服务仅监听 127.0.0.1。Strata 独立运行，权重不导入 Ollama。

自动启动使用当前用户的普通权限计划任务，先启动云端网关和桥接，再加载本地模型；
首次加载仍需等待权重就绪。每 30 秒检查一次并恢复停止的服务，不重启 Codex、
不重新下载、不覆盖模型目录，也不会替换正在运行的其他 Strata 预设。
日志：`%LOCALAPPDATA%\OllamaForge\startup.log`。
关闭自动启动：`npm run startup:strata:disable`。
后台任务通过本机编译的无控制台 Windows 启动器运行，不会打开 PowerShell 或 Windows Terminal 窗口。
更新已有安装时，执行一次 `npm run startup:strata` 会迁移旧后台任务；以后登录即自动恢复，无需快捷方式或命令。
手动重启前会检查模型文件与请求状态，默认拒绝中断正在处理的本地任务。
需要中断卡住的本地请求时，显式执行 `npm run restart:strata -- -Force`。
重启期间暂挂本仓库的自动恢复任务，完成或出错后恢复；不会启用原本关闭的自启。
开机和重启恢复使用同一套路径发现与旧运行记录修复，适用于普通安装和 Codex Store 安装。
Strata 空闲释放模型内存时会报告待机，下一次请求由 Strata 自动加载，不会被自启反复重启。

本地入口默认启用上下文精简：保留全部 GitHub、Chrome、电脑控制及核心开发工具；
本地请求不携带 Pages、Sites、宠物、文档画布等可选应用的工具定义。
这只影响 Strata 请求，不会卸载插件或修改云端模型的工具。
命名空间的公共说明只发送一次，原有工具参数、函数说明与使用约束保留。
单条工具结果超过约 16,000 字符时保留首尾并明确标记省略；图片、游标、用户消息和工具调用参数保持完整。
需要中间内容时按字段或行号重新读取，避免输出整个模型目录或完整项目 JSON。
`high` 等思考等级保留，默认给本地思考 4,096 tokens 的预算；显式传入的思考预算优先。
压缩摘要的输出上限为 4,096 tokens，自动压缩阈值仍为 110,000、实际模型窗口仍为 128K。
长任务仍会正常压缩，精简用于避免固定工具开销导致每几步就压缩。
`http://127.0.0.1:11436/context` 可查看最近一次本地请求的优化前后大小，只返回工具名和字符数。
回归测试：`npm run test:strata-policy`；`npm run setup:strata` 或登录自启会更新旧版桥接。
纯 Strata 安装不需要在 Ollama 中再下载第二个模型；Ollama 程序仍用于云端网关。
小内存或其他 GPU 的电脑使用普通 `npm run setup`，连接其已有的 Ollama 模型，
不会安装这个大预设。自定义 Strata 安装可设置 `STRATA_TERMINAL_PATH` 指向启动器。

```powershell
npm run test:strata
npm run test:strata-startup
$env:CODEX_RESPONSES_URL='http://127.0.0.1:11436/api/codex/v1/responses'
npm run test:live -- qwen3.8-flash-next-iq3_s
# 可选：实际 128K 窗口测试（约 125,000 输入 tokens）。
npm run test:strata-context
```

[English](README.md) | **简体中文**

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

- Node.js 24.x 中的 24.22.1+，或 26.x 中的 26.12.1+；
- 当前版 Ollama，且支持 `ollama launch chatgpt`；
- 已登录并至少打开过一次 Codex/ChatGPT，使 `~/.codex/config.toml` 存在；
- 至少一个由用户自己安装或导入的本地 Ollama 模型
  （上方可选的纯 Strata 流程不需要）。

每台电脑需要自己登录 Codex，并授权 Chrome/电脑控制插件；本仓库保留这些能力，
不能转移另一台机器的插件权限。自动硬件检查是兼容性检查，无法保证每款 GPU
都有同样性能。CI 覆盖 Windows/macOS，并在 Linux 跑平台无关测试；此 Windows
Strata 安装器不提供 Linux 桌面接入，也不安装 AMD/Apple GPU 的 Strata 后端。

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
2. 让当前安装的 Codex CLI 刷新其云端模型目录；
3. 调用 Ollama 官方 ChatGPT/Codex 集成生成本地模型条目；
4. 合并最新 Codex 云端条目与当前 Ollama 本地模型，同时保留默认模型、Reasoning 设置、Apps 和插件配置；
5. 创建平台对应的桌面快捷方式；
6. 在任何失败时保留或恢复原配置。

它不会下载模型。完成后彻底退出并重新打开 Codex，随后直接在每个任务的模型
选择器中选择本地或云端模型。
以后再次运行 setup 或桌面快捷方式时，只会分别重新生成两部分：Codex 提供最新
云端条目，Ollama 提供当前本地条目；任何一边都不会成为另一边的固定快照。

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

## DeepSeek Harness 连接同一个本地模型

在本仓库目录运行：

```sh
npm run launch:deepseek
```

可以明确指定实际项目，例如
`npm run launch:deepseek -- --workspace D:\Documents\GitHub\你的项目`。
选择会保存供桌面入口使用，并在 Web 界面注册。默认工作区拒绝使用运行时和测试目录；
真实验收会使用各自隔离的 Harness 数据目录，不会再让测试文件夹混入用户的工作区。

压缩预算按本地模型容量设置：128K 模型约到 109K 才触发，额外预留 8K，摘要上限 2K。
失败的摘要会等到历史有明显增长后再尝试，不会每次工具调用后都重试。
接近硬上限时会保留历史并明确停止；上下文溢出的独立恢复仍有次数上限。Web 各预设独立的
压缩器也应用相同预算，保留用户预设中的工具和其他设置。Codex 的云端连接配置不变。

`deepseek-recovery.mjs` 提供保守的迁移辅助：备份有效会话日志、保留源文件、逐个校验
SHA-256，目标文件有冲突时先拒绝，不覆盖用户已有内容。`working_directory` 只改变当前
目录，不改变会话的沙箱写入边界。需要迁移旧测试会话时，`deepseek-migrate-session.mjs`
使用官方会话种子接口，在真实项目中创建继承完整事件历史的续接会话；原会话保留。
迁移请求和校验记录只放在本机忽略提交的运行时目录，普通启动不会自动迁移其他会话。

Windows 的隔离命令执行器需要为项目目录写入权限项和完整性标签。如果目录属于当前用户，
但初始化时报 `grantWrite / SetNamedSecurityInfoW`，可先诊断：

```powershell
npm run repair:deepseek-workspace -- --workspace 'D:\Documents\GitHub\你的项目'
# 确认需要修复后：
npm run repair:deepseek-workspace -- --workspace 'D:\Documents\GitHub\你的项目' --apply
```

修复只为当前所有者补充项目根目录的 `ChangePermissions` 和 `TakeOwnership` 权限，
用于隔离执行器初始化；不递归，不更改所有者，不删除其他权限项，也不切换到完全权限模式。
原权限记录会先备份到本机 `.runtime/deepseek-harness/recovery/workspace-permissions/`。

命令会安装固定版本的官方 `@deepseek-ai/dsh`、原生 Cua Driver 和 Chrome
DevTools 控制插件，连接现有本地模型，并打开已认证的
`http://127.0.0.1:3080` 界面。Windows 上还会创建桌面快捷方式
**OllamaForge - DeepSeek Harness**，通过当前用户的后台任务运行，不显示终端。
任务按需启动；重启电脑后也可以用快捷方式启动。Codex 原有连接和开机配置保留。

优先读取 Strata `/health` 中实际的模型、上下文和图片支持；没有 Strata 时，
选择 Ollama 中已经安装的模型。不会下载模型权重。运行包、私有访问令牌、会话、
配置和日志保存在忽略提交的 `.runtime/deepseek-harness/` 中，不修改已有 `~/.dsh`。

```sh
npm run connect:deepseek
npm run test:deepseek
npm run test:deepseek-controls
npm run stop:deepseek
```

`connect:deepseek` 只配置连接；`test:deepseek` 让真正的 Harness 读取随机标记、
写入新文件并回复标记。`test:deepseek-controls` 打开专属本地测试页面，通过
独立的服务端回执和工具事件验证原生点击输入、Chrome 填写点击。
需要 Windows 桌面可见且已解锁。普通 `npm test` 只验证离线策略，不安装运行包或操作桌面。

指定其他本地接口时，需要填写已经安装的模型和真实上下文容量：

```sh
npm run launch:deepseek -- --base-url http://127.0.0.1:8080/v1 --model qwen3.8-flash-next-iq3_s --context 131072 --api openai-responses
```

3080 被其他应用占用时加 `--port 3081`；不打开浏览器时加 `--no-open`。
修改连接会停止本仓库拥有的 Harness Web 进程，再运行 `launch:deepseek` 打开。
Windows 和 Unix 的停止路径都会先检查进程归属。

电脑控制使用 Harness 自己的原生驱动，不复用 Codex 的私有插件、权限或浏览器连接。
Chrome 为每个运行中的会话打开独立可见实例。系统权限仍然适用；截图工具需要模型接口
已经验证支持图片，纯文本接口不能理解截图。两个驱动目前都是实验性插件。
参考[官方 Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)。
仓库附带的原生适配层会把驱动的结构化快照句柄、控件句柄完整传给模型，修复上游
纯文本投影丢失句柄的问题。Web 和命令行模式都要求原生适配器与 Chrome 插件先成功
加载，缺少驱动时直接报错，不会悄悄退化成部分成功。

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

Windows 原生电脑控制、Chrome 和 GitHub 的实际验收见
[DESKTOP-CONTROL.md](DESKTOP-CONTROL.md)。运行
`npm run test:desktop:prepare` 创建本机测试文件；
`npm run test:desktop-policy` 检查验收脚本本身。实际验收必须完成输入保存、
关闭重开、浏览器表单提交，以及 GitHub 上传后回读；缺一项即失败。
单元测试通过不代表已验证本机桌面控制。

每台电脑首次控制应用时，需要按 Codex 提示允许。新版记事本可能从启动器
转交给另一个应用标识，应重新枚举实际窗口；辅助功能为空时使用新的窗口截图。
GitHub 连接器写入返回 403 时，改用本机已经登录的 Git/GitHub CLI 上传，
连接器仍可用于读取。应用授权和登录信息由每台电脑自行取得，不会从仓库复制。

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

OllamaForge 会把该 endpoint 注册为仅使用 HTTP 的 Codex provider。这样 GPT-5.6
等云端模型会继续使用可工作的 Responses 流式传输，不会让 Codex 尝试 Ollama
尚不支持的 WebSocket 并反复显示“重新连接”。

原有云端模型会继续作为 Codex 默认模型。OllamaForge 只把已安装的本地模型
添加到模型选择器，绝不会把本地模型提升为全局默认值。

```text
http://127.0.0.1:11434/api/codex/v1
```

配置变更前的文件会备份到每台机器自己的：

```text
~/.ollama/backup/codex-app
```

所有服务仅绑定回环地址。模型列表刷新不会删除 Ollama 权重；恢复云端配置也不会
卸载本地模型。
