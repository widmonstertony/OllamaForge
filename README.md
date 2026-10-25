# OllamaForge

On another Windows or macOS computer, install the prerequisites below, pull/clone
this repository and run `npm run setup`. This connects that computer's existing
Ollama models and discovers its own Codex installation; it copies no account,
plugin permissions, model files or absolute paths from the original PC.

## Strata: Qwen3.8 Flash 128K (Windows)

The optional Windows x64 preset targets 64 GB-class RAM and NVIDIA 12 GB+ VRAM
(tested live on a 64 GB / RTX 4090 Laptop 16 GB machine). It runs
Qwen3.8-Flash-Next 125B IQ3_S at 131,072 tokens, q4_0 KV, MTP off,
CPU vision and one request at a time, with 2 GiB VRAM reserved for the desktop.
Model downloads are explicit (~84 GB). The installer checks RAM/GPU compatibility
before downloading, selects the NVIDIA GPU with the most VRAM and adapts its host
expert budget to RAM (40 GiB on a 64 GB-class PC, capped at 48 GiB on larger PCs).
Strata further clamps this to available RAM/Windows commit capacity.
All experts remain available across GPU, RAM and SSD;
64 GB does not guarantee that every weight stays in RAM beside other applications.

```powershell
# Check hardware before downloading; no model or service is started.
npm run check:strata
# Install/download and enable login startup in one command.
# Defaults to Strata-data beside the repo; choose a local SSD with 95 GB free.
npm run download:strata -- -EnableStartup
# Optional custom location (example; choose the appropriate disk on that PC):
# npm run download:strata -- -DataDirectory "$env:USERPROFILE\Strata-data" -EnableStartup
# Connect an already running Strata 128K preset; downloads nothing.
npm run setup:strata
# Start installed services automatically at Windows user login, without the shortcut.
npm run startup:strata
# Manually start/recover installed services; no downloads or Codex restart.
npm run start:strata
# Restart only the local Strata model, keeping the cloud gateway and bridge alive.
npm run restart:strata
```

An idle-unloaded Strata server is ready in standby: Strata reloads the model on the next request, and the login supervisor does not repeatedly restart it.

Automatic startup uses a limited, current-user scheduled task. It starts the cloud
gateway and bridge before loading the saved local model, then recovers stopped
services every 30 seconds. Initial model loading still takes time. It does not
restart Codex, download weights, refresh catalogs, or replace another running
Strata preset. Logs: `%LOCALAPPDATA%\OllamaForge\startup.log`.
Disable it with `npm run startup:strata:disable`.
Manual restart checks installed model files and request state, and refuses to
interrupt active local work by default. To interrupt a stuck local request,
explicitly run `npm run restart:strata -- -Force`. The repo's running startup
supervisor is paused during restart and resumed on completion or failure;
previously disabled startup stays disabled. Login and restart recovery share
path discovery and old-runtime-record repair for ordinary and Store installs.
Strata-only PCs do not need a second model installed in Ollama. Ollama itself is
still required for the cloud gateway. A normal `npm run setup` on smaller/other-GPU
PCs connects their existing Ollama models; it never installs this large preset.
Custom Strata installations can set `STRATA_TERMINAL_PATH` to their launcher.

After reopening Codex, select **Strata · Qwen3.8 Flash 128K (IQ3_S)**.
The existing **本地 Codex（GUI）** shortcut starts the saved Strata preset,
the local bridge and Ollama before refreshing the model list and reopening Codex.
The native cloud default is preserved. Cloud metadata refreshes from the installed
Codex on every connection; only the exact Strata model ID routes to Strata.
Cloud credentials are stripped from Strata requests. All local listeners bind to
127.0.0.1. Strata remains an independent runtime; its weights are not imported into Ollama.

```powershell
npm run test:strata
npm run test:strata-startup
$env:CODEX_RESPONSES_URL='http://127.0.0.1:11436/api/codex/v1/responses'
npm run test:live -- qwen3.8-flash-next-iq3_s
# Optional real 128K-window test (about 125,000 input tokens).
npm run test:strata-context
```

**English** | [简体中文](README.zh-CN.md)

Add models that are **already installed in Ollama** to the Codex/ChatGPT desktop
app without removing your existing cloud models. Each Codex task can select a
local or cloud model independently while continuing to use the Codex harness,
Skills, Apps, MCP, Browser, Computer Use, shell, file editing, sandbox, and
approval system.

> The default setup path never downloads a model, creates a model alias, or
> changes Ollama context/KV-cache settings. You choose and install the models;
> OllamaForge only connects them safely and provides configuration rollback.

## Supported platforms

| Platform | Status | Desktop app |
| --- | --- | --- |
| macOS | Supported | `Codex.app` or `ChatGPT.app` |
| Windows 10/11 | Supported | Microsoft Store/desktop Codex app |
| Linux | No desktop GUI integration | Ollama/Codex CLI can still be used, but it is outside this repository's one-command desktop workflow |

Requirements:

- Node.js 24.22.1+ within 24.x, or 26.12.1+ within 26.x;
- a current Ollama release with `ollama launch chatgpt` support;
- Codex/ChatGPT opened and signed in at least once so `~/.codex/config.toml` exists;
- at least one local Ollama model that you installed or imported yourself
  (not required for the optional Strata-only flow above).

Each computer must sign in to Codex and authorize its own Chrome/computer-control
plugins. OllamaForge preserves these tools but cannot transfer their permissions.
The automatic hardware checks are compatibility checks, not a performance guarantee
on every GPU. CI covers Windows/macOS plus platform-independent tests on Linux;
Linux desktop integration and AMD/Apple-GPU Strata installation are not provided
by this Windows Strata installer.

This repository has no npm dependencies. You do not need to run `npm install`
after cloning it.

## Start in three steps

### 1. Check your local models

```sh
ollama list
```

If the list is empty, choose and install a model first. OllamaForge will not
choose one for you or silently download one.

### 2. Clone the repository

```sh
git clone https://github.com/widmonstertony/OllamaForge.git
cd OllamaForge
```

### 3. Connect Codex

```sh
npm run setup
```

This command:

1. checks Ollama, the Codex configuration, and installed models;
2. asks the currently installed Codex CLI to refresh its cloud model catalog;
3. calls Ollama's official ChatGPT/Codex integration to generate local model entries;
4. merges the fresh Codex cloud entries with the currently installed Ollama models, while preserving the default model, reasoning settings, Apps, and plugin configuration;
5. creates the appropriate desktop shortcut for the platform;
6. preserves or restores the original configuration if anything fails.

It does not download models. Fully quit and reopen Codex when setup finishes,
then choose a local or cloud model from the model picker in each task.
Running setup or the desktop shortcut again replaces only the two generated parts:
Codex supplies the latest cloud entries and Ollama supplies the current local entries.
One side never becomes the saved source of truth for the other.

## Choosing a model

List the local models OllamaForge can discover:

```sh
npm run models
```

By default, `npm run setup` preserves the current cloud default and makes every
local model selectable. To make a particular installed local model the initial
selection the next time Codex opens, pass its exact name from `ollama list`:

```sh
npm run setup -- --model qwen3.8:27b-mlx
```

`--model` accepts only an exact, already-installed model name. A missing model
causes an immediate error and is never pulled automatically.

You do not need to repeat setup after the connection is established. Switch per
task in the Codex model picker:

- local model: inference runs locally through Ollama;
- cloud model: the existing cloud service continues to handle inference;
- the Codex harness and tool-execution layer remain available in either case.

## Commands

| Command | Behavior | Downloads a model |
| --- | --- | --- |
| `npm run setup` | Connect installed models and install a shortcut | No |
| `npm run models` | List local models without modifying configuration | No |
| `npm run refresh` | Refresh the Codex catalog after adding/removing models | No |
| `npm run launch` | Refresh the catalog and restart Codex | No |
| `npm run disconnect` | Restore the pre-connection configuration without deleting weights | No |
| `npm test` | Run cross-platform offline tests | No |
| `npm run test:live -- <model-name>` | Test real text and tool calls | No |

For compatibility with older versions, `npm run connect` and `npm run deploy`
are safe aliases of `npm run setup`; neither downloads a model.

## macOS

`npm run setup` creates this desktop shortcut:

```text
本地 Codex（Ollama 直连）.command
```

Double-clicking it checks Ollama, refreshes the model catalog, quits Codex, and
opens it again. It is not a local-only mode: both local and cloud models remain
in the model picker after restart.

If `qwen3.8:27b-mlx` is already installed on Apple Silicon, reuse those weights
directly:

```sh
npm run setup -- --model qwen3.8:27b-mlx
```

For this known model, OllamaForge marks the Codex catalog context as 184,320 and
sets the default reasoning level to `none`. It does not change the actual Ollama
runtime parameters.

## Windows

Run the same commands in PowerShell:

```powershell
git clone https://github.com/widmonstertony/OllamaForge.git
cd OllamaForge
npm run models
npm run setup
```

Setup creates a desktop shortcut named `本地 Codex（GUI）`. It starts or checks
Ollama, refreshes all installed models, validates the native Codex endpoint, and
restarts Codex. The complete log is stored at:

```text
%LOCALAPPDATA%\OllamaForge\shortcut.log
```

Windows and macOS use the same hybrid catalog logic. Adding local models does
not remove cloud models.

## Qwen3.8 27B guidance

- 48 GB Apple Silicon: an existing `qwen3.8:27b-mlx` installation can be reused directly;
- 16 GB GPU: prefer a quantization that fits completely in VRAM;
- larger context windows increase KV-cache use and first-turn prefill time;
- multiple Codex/JARVIS requests sharing one Ollama instance may queue, which is expected.

OllamaForge does not hard-code one required model. Any installed model can enter
the catalog, but reliable tool planning still depends on that model's own
tool-calling capability.

## Optional: explicitly prepare repository aliases

Run these only if you specifically need the Qwen templates/aliases provided by
this repository:

```sh
npm run prepare:alias -- --model 9b
npm run prepare:alias -- --model 27b
```

These commands still **do not download** the base model. If `qwen3.5:9b` or
`qwen3.8:27b` is missing, they stop and ask you to install it yourself.

The repository also retains an explicitly named advanced downloader:

```sh
npm run download:27b
```

It downloads the specified approximately 12.18 GiB IQ4_XS GGUF, verifies a
pinned SHA-256 checksum, and creates 64K and 110K aliases. It is not part of the
default setup. A model is downloaded only when you deliberately run this
`download` command. The old `npm run deploy:27b` name remains as a compatibility
alias.

## Privacy boundaries

- with a local model selected, inference requests go to `127.0.0.1:11434`;
- with a cloud model selected, conversation context leaves the machine according to that provider's existing rules;
- Browser, email, remote MCP, and website tools may still access external services;
- OllamaForge does not commit model weights, Codex login data, personal configuration snapshots, or runtime logs;
- the adapter does not forward Codex OAuth/API credentials to the local model.

“Local model” describes where inference runs. It does not mean that an entire
tool-enabled task is offline.

## Verification and troubleshooting

Offline regression suite:

```sh
npm test
```

Live Codex/Ollama gateway test:

```sh
CODEX_RESPONSES_URL=http://127.0.0.1:11434/api/codex/v1/responses \
CODEX_TEST_TIMEOUT_MS=600000 \
npm run test:live -- qwen3.8:27b-mlx
```

Windows PowerShell:

```powershell
$env:CODEX_RESPONSES_URL='http://127.0.0.1:11434/api/codex/v1/responses'
$env:CODEX_TEST_TIMEOUT_MS='600000'
npm run test:live -- qwen3.8:27b-mlx
```

Common problems:

- `No local Ollama model is installed`: install a model yourself, then run `npm run setup`;
- `Codex config not found`: sign in and open Codex once first;
- model picker did not refresh: fully quit Codex, then double-click the desktop shortcut;
- catalog is stale after adding/removing a model: run `npm run refresh`;
- completely undo the integration: run `npm run disconnect`, then restart Codex;
- Windows shortcut failed: inspect `%LOCALAPPDATA%\OllamaForge\shortcut.log`.

## How it works

```text
Codex Desktop / Harness
          │
          ├── cloud models (existing route preserved)
          │
          └── Ollama Codex gateway
                    │
                    └── installed local models
```

Ollama's native endpoint is:

OllamaForge registers that endpoint as an HTTP-only Codex provider. This keeps cloud
models such as GPT-5.6 on the working streaming Responses transport instead of letting
Codex attempt an unsupported WebSocket connection and loop on "Reconnecting".

Your existing cloud model remains the Codex default. OllamaForge only adds installed
local models to the picker; it never promotes a local model to the global default.

```text
http://127.0.0.1:11434/api/codex/v1
```

Files changed by the connection are backed up on each machine under:

```text
~/.ollama/backup/codex-app
```

All services bind only to loopback. Refreshing the model catalog does not delete
Ollama weights, and restoring the cloud configuration does not uninstall local
models.
