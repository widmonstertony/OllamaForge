# OllamaForge

[English](README.md) | **简体中文**

原生 Codex 自己管理云端提供商及完整、自动更新的模型目录。
OllamaForge 的默认接入不修改原生 config.toml、云端默认模型、认证、插件或运行中的对话。
本地模型使用独立的 Codex CLI 配置。旧版“全局混合提供商/目录”方案已停用：
它会把云端对话绑定到本地提供商，也会让更新后新增的原生模型缺失。

## 不影响原生 Codex 的安装

准备 Node 24.22.1+、Ollama 和自行安装的本地模型，克隆仓库后运行：

~~~sh
npm run setup
npm run models
npm run local:codex
~~~

Windows/Linux 的 setup 只在 Codex 配置目录旁生成 ollamaforge-local.config.toml 和
ollamaforge-local-models.json。本地 CLI 仅对自己的进程使用该配置；
桌面云端继续使用 Codex 原生目录与连接，不下载模型、不复制云端认证、
不固定云端名单、不重启 Codex。桌面入口只打开原生应用，不关闭正在运行的对话。
指定本地模型可运行 npm run setup -- --model <已安装名称>。

## Windows 桌面入口

- Codex（官方云端）：官方应用图标，快捷键 Ctrl+Alt+C。直接打开原生应用，
  保留原对话和自动更新的云端模型，不运行配置切换脚本。
- DeepSeek + Strata：鲸鱼/层纹图标，快捷键 Ctrl+Alt+D。打开独立中文 Harness，
  使用已保存的本地模型和工作区。

安装会清理本仓库的旧「本地 Codex（GUI）」及「云端 Codex」入口。
Harness 冷启动可能超过一分钟，隐藏入口最多等待五分钟确认认证网页可用；
重复打开复用服务，不重启正在运行的会话。

## macOS 本地入口

macOS 的 npm run setup 和 npm run launch 保留独立终端及隔离 CODEX_HOME 的入口。
上面的 local:codex 专用配置命令用于 Windows/Linux，原生桌面云端配置保持独立。

### macOS

Apple Silicon 上已安装 Qwen 3.8 27B 时，可配置带 Chrome 与原生电脑控制的 Harness：

```sh
npm run setup:macos-harness
npm run launch:macos-harness
```

配置会复用已有权重创建 128K 和 64K 别名，默认使用 128K，并生成桌面快捷方式。
它按需启动 Ollama，使用独立 Harness 配置；64K 可在模型选择器中切换。
文件、终端、浏览器和原生控制工具使用精简的目录，降低首轮提示开销。
原生控制需要 macOS 辅助功能与屏幕捕捉权限；本机实测使用了 64GB 统一内存。
128K 已用 68,050 输入 tokens 验证前文找回，未宣称填满整个窗口的质量表现。

执行 `npm run setup`，会生成「本地 Codex（Ollama 直连）.command」。
也可以指定已经安装的模型：

```sh
npm run setup -- --model qwen3.5-codex-fast-16k
```

双击快捷方式打开独立 Codex 终端。它会按需启动 Ollama，检查模型是否已安装，
然后连接本地 Responses API。在终端里可用 `npm run launch` 启动同一入口。

如果旧版 Ollama 集成已经接管 Codex 桌面，执行 `npm run disconnect`。
它会备份配置并清理已知的集成覆盖项，保留桌面设置和会话历史。
等正在运行的任务结束后，退出并重开桌面 Codex。Ollama 自带的 Codex 桌面集成
保持关闭，桌面云端模型由 Codex 原生刷新。

### Intel Mac 与 Radeon Metal

已安装 LeetTutor 的 AMD Metal llama-server 和 Qwen 3.5 9B 权重时，执行：

```sh
npm run deploy:macos-metal
npm run install:macos-metal-shortcuts
```

「本地 Codex.command」打开独立的 Metal 终端。适配器使用 8K 上下文，
显卡进程空闲五分钟后退出。「云端 Codex.command」恢复已知的旧版 Ollama 路由，
然后打开桌面 Codex。


## 清理旧版全局接入

~~~sh
npm run repair:native
~~~

命令先备份 config.toml，仅清理确认属于 OllamaForge 的全局提供商、回环地址和目录覆盖。
其他提供商、用户设置及旧本地目录文件都保留。清理后由原生发现返回账户当前可用的全部模型，
包括以后新增的模型。如果旧本地模型被设为全局默认，需先选择原来的云端默认模型；
修复不会猜测并覆盖这个选择。

原生会话的索引误标可按下面的命令保留原 ID 修复；真正跨提供商才需明确选择分支。
不再承诺旧对话中原地无缝切换云端/本地。需要本地 GUI 时，可继续使用下面已有的
OpenClaw 和 DeepSeek Harness，它们独立于原生云端模型目录。

## Windows Strata IQ3_S 128K

~~~powershell
npm run check:strata
npm run download:strata -- -EnableStartup
npm run setup:strata
npm run startup:strata
npm run start:strata
npm run restart:strata
npm run startup:strata:disable
~~~

下载必须显式运行，并需要兼容的 NVIDIA GPU、足够内存和 SSD 空间。
保留现有运行包、预设和登录任务；接入只写本地专用配置。
Strata 请求继续使用现有回环桥接，原生云端模型不经过它。后台服务没有终端窗口。
已有上下文策略保留电脑、Chrome、GitHub 工具，其预算仅影响本地请求。
OpenClaw/JARVIS/Harness 的接入也不会修改原生 Codex 云端模型目录。

## 保留原 ID 修复原生对话

~~~sh
npm run repair:thread -- --thread <原对话UUID>
npm run repair:thread -- --thread <原对话UUID> --apply
~~~

默认诊断和修复都不会新建聊天。如果原始会话头一直是 openai，只有索引被旧桥接误标为
ollamaforge，命令会备份状态数据库和完整历史，只纠正这一条索引字段，恢复原 ID，
并逐条比对已有轮次和内容。索引修正不改历史、文件、时间戳或权限字段。
活动中的原对话或不能证明原生来源的记录会被拒绝。修复后重新点原链接，刷新桌面缓存的旧标签。

真正更换提供商不属于索引漂移，原 ID 修复会明确拒绝。只有确实希望另建完整历史分支时，
才在 --apply 后显式加 --fork；已由桌面创建的分支可用 --verify <接续UUID> 校验。
私有备份留在不提交的 .runtime/original-thread-repair 和 .runtime/thread-recovery，
包含完整聊天，可能较大。CLI 从 PATH 或 OLLAMAFORGE_CODEX_BIN 查找，也可用 --codex 指定。
工具针对已核对的分页 state_5 结构，找不到已有状态数据库时会停止，不会创建或猜测新数据库。

## OpenClaw 和 LeetTutor JARVIS 连接 Strata（Windows）

Windows 还可连接 OpenClaw 和 LeetTutor JARVIS：准备相邻的 `Leetcode` 仓库及其
`.venv`，在本仓库运行 `npm run connect:assistants`，再运行 `npm run launch:assistants`。
前者安装固定版本的官方 OpenClaw 运行包，保存两个助手的 Strata 连接；不会下载模型。
后者注册当前用户的隐藏登录任务，并创建 **OllamaForge - OpenClaw Strata** 和
**OllamaForge - JARVIS Strata** 桌面入口。也可向 connect 命令传入 Leetcode 的完整目录。
OpenClaw 保持本机令牌认证；JARVIS 网页通过原有受限桥接的 1234 端口访问 Strata。
端口被其他应用使用时会拒绝覆盖。首次 OpenClaw 初始化可能需要几分钟，入口会等待就绪。
其他机器需要自行初始化认证和 Python 环境；本机配置、令牌、会话和权重均不提交。

OpenClaw 登录任务使用正常优先级和无终端的进程监护：子进程退出后五秒重试，
每分钟的单实例触发还能恢复监护进程本身。入口会等待 Strata 已加载、Gateway
就绪，以及独立自检会话的真实回复和运行提交完成；HTML 能打开不代表模型就绪。
完整冷启动仍需加载运行环境，登录后自动完成，无需手动运行命令。

默认技能集面向 Windows 开发、GitHub、调试和可视化，关闭技能目录的持续扫描；
已有明确的技能选择和 watch 设置优先保留。电脑、浏览器等工具配置继续沿用。
启动环境自动去重 PATH，加入本仓库私有 OpenClaw 命令目录，并寻找已有
Git/GitHub Desktop 的 Git。Qwen 使用官方
`qwen-chat-template` 方言，默认向 Strata 明确发送 `enable_thinking=false`；
仍可在 OpenClaw 中选择思考级别。未明确配置的周期性模型心跳默认关闭，减少后台争用；
已有显式心跳设置继续保留。

`npm run test:openclaw` 运行就绪/认证/故障单元测试；
`npm run test:openclaw-live` 实际测试新会话、后续回复和随机文件读取，
并把本机耗时写入未跟踪的 `.runtime/openclaw-latency.json`。
长上下文首次预填充和多个应用共用同一模型时的排队仍会影响耗时。

## DeepSeek Harness 连接同一个本地模型

在本仓库目录运行：

```sh
npm run launch:deepseek
```

首次连接或重新部署时，Web 界面默认使用中文，并保存到本机 Harness 的语言设置中，
不再随浏览器语言变回英文。以后在“设置 → 通用设置 → 语言”中手动选择的语言会保留。

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
**DeepSeek + Strata**，通过当前用户的后台任务运行，不显示终端。
任务按需启动；重启电脑后也可以用快捷方式启动。Codex 原有连接和开机配置保留。

桌面入口自带鲸鱼/层纹图标，快捷键 Ctrl+Alt+D。按需启动保存的 Strata 预设，
复用已运行的 Harness，保留工作区和对话，不显示终端。单独修复桌面入口可运行：

~~~sh
npm run install:deepseek-shortcut
~~~

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
需要 macOS 或 Windows 桌面可见且已解锁。普通 `npm test` 只验证离线策略，不安装运行包或操作桌面。

指定其他本地接口时，需要填写已经安装的模型和真实上下文容量：

```sh
npm run launch:deepseek -- --base-url http://127.0.0.1:8080/v1 --model qwen3.8-flash-next-iq3_s --context 131072 --api openai-responses
```

同一接口还有其他已安装模型时，可加 `--extra-model <模型名> --extra-context <上下文容量>`，
把第二个模型加入选择器。两个模型各自使用对应的上下文和压缩策略，
`--model` 仍是新对话的默认模型。切换模型本身不需要重启 Harness。

3080 被其他应用占用时加 `--port 3081`；不打开浏览器时加 `--no-open`。
修改连接前会检查运行中的任务；任务未结束时保留配置并拒绝自动重启。
空闲重启会先阻止新任务进入，再停止本仓库拥有的 Web 进程。旧版服务第一次升级时，
请等任务结束后执行 `npm run stop:deepseek`，然后重新启动以加载保护。
Windows 和 Unix 的停止路径都会先检查进程归属。

电脑控制使用 Harness 自己的原生驱动，不复用 Codex 的私有插件、权限或浏览器连接。
Chrome 为每个运行中的会话打开独立可见实例。系统权限仍然适用；截图工具需要模型接口
已经验证支持图片，纯文本接口不能理解截图。两个驱动目前都是实验性插件。
参考[官方 Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)。
仓库附带的原生适配层会把驱动的结构化快照句柄、控件句柄完整传给模型，修复上游
纯文本投影丢失句柄的问题。Web 和命令行模式都要求原生适配器与 Chrome 插件先成功
加载，缺少驱动时直接报错，不会悄悄退化成部分成功。

## 隐私与验证

私有备份、完整聊天、账户、模型和运行时文件均不提交。每台电脑使用自己的账户、权重和安装路径。

~~~sh
npm test
npm run test:native
npm run test:thread-recovery
npm run test:strata
npm run test:strata-startup
~~~

原生保护测试校验 setup、launch、disconnect 前后主配置逐字节不变，保护以后新增的云端模型，
并拒绝会强制关闭应用的启动脚本。真实云端、本地和旧对话验收与单元测试分别进行。
创建接续分支时保留原对话。
