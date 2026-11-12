# OllamaForge

[简体中文](README.zh-CN.md) | **English**

Native Codex owns its cloud provider and complete, automatically updated model list.
OllamaForge local setup never changes native config.toml, the cloud default, auth,
plugins, or running chats. Local models use a separate Codex CLI profile.
The previous shared global provider/catalog design is retired: it bound cloud chats
to a local provider and hid new native models after updates.

## Setup without changing native Codex

Install Node 24.22.1+ and Ollama, install a local model yourself, clone this repo,
then run:

~~~sh
npm run setup
npm run models
npm run local:codex
~~~

On Windows/Linux, setup writes only ollamaforge-local.config.toml and ollamaforge-local-models.json
beside your Codex configuration. The local CLI uses that profile for its own
process; the desktop cloud app continues using native discovery and transport.
It does not download models, copy cloud auth, pin a cloud catalog, or restart Codex.
The desktop shortcut opens the native app without closing any running chat.
An explicit local choice is supported with npm run setup -- --model <installed-name>.

## Windows desktop entries

- Codex（官方云端） uses the official app icon and Ctrl+Alt+C. It opens the native
  application directly, retaining existing chats and automatically updated cloud models.
- DeepSeek + Strata uses the whale/layers icon and Ctrl+Alt+D. It opens the
  independent Chinese Harness with the saved local model and workspace.

Setup retires the old repository-owned 本地 Codex（GUI） and 云端 Codex entries.
A cold Harness start can take over a minute; the hidden launcher waits up to
five minutes for authenticated readiness. Repeated opens reuse the service.

## macOS local launchers

On macOS, npm run setup and npm run launch retain the independent terminal
launcher and isolated CODEX_HOME. The local:codex profile command above is for
Windows/Linux. Native desktop cloud configuration remains independent.

### macOS

On Apple Silicon with Qwen 3.8 27B already installed, configure Harness with
Chrome and native desktop control:

```sh
npm run setup:macos-harness
npm run launch:macos-harness
```

Setup reuses existing weights to create 128K and 64K aliases, defaults to 128K,
and installs a desktop shortcut. It starts Ollama when needed and uses the
isolated Harness configuration. The model picker also offers 64K. A focused
catalog retains file, terminal, browser and native desktop tools with less
prompt overhead. Native control requires macOS accessibility and screen
capture permissions. Local validation used 64GB unified memory. The 128K test
recalled a marker from 68,050 input tokens; it did not fill the whole window.

Run `npm run setup` to create `本地 Codex（Ollama 直连）.command`, or select
an already installed model explicitly:

```sh
npm run setup -- --model qwen3.5-codex-fast-16k
```

Double-click the shortcut to launch an independent Codex terminal. It starts
Ollama if needed, checks the installed model, and connects to its local
Responses API. Use `npm run launch` for the same terminal from the shell.

If Ollama previously took over the desktop provider, run
`npm run disconnect`. This backs up and removes known integration overrides
while retaining the desktop settings and chat history. Reopen the desktop
app once the active tasks finish. Keep Ollama's separate ChatGPT/Codex desktop
integration off. Cloud models refresh through the native desktop app.


## Intel Mac with Radeon Metal

With the patched LeetTutor AMD Metal `llama-server` and existing Qwen 3.5 9B
weights, run:

```sh
npm run deploy:macos-metal
npm run install:macos-metal-shortcuts
```

`本地 Codex.command` opens an independent Metal Codex terminal. The local
adapter keeps an 8K context and stops the dedicated Radeon process after five
idle minutes. `云端 Codex.command` opens the desktop app and removes recognized
legacy Ollama routing overrides if necessary.

## Repair older global integration

~~~sh
npm run repair:native
~~~

This backs up config.toml and removes only recognized OllamaForge global provider,
loopback URL and catalog overrides. Other providers, user settings and the old
local catalog files remain intact. Native model discovery then supplies every
model currently available to the account, including future additions.
If an old local model was the global default, choose your original cloud default
before this repair; it does not guess or replace that choice.

A mislabeled native chat can retain its original ID using the provenance-checked
index repair below. Genuine provider changes require a separately requested fork.
Cloud/local in-place switching in one old chat is not promised. Local GUI users
can retain the independent OpenClaw and DeepSeek Harness connections below.

## Strata IQ3_S 128K on Windows

~~~powershell
npm run check:strata
npm run download:strata -- -EnableStartup
npm run setup:strata
npm run startup:strata
npm run start:strata
npm run restart:strata
npm run startup:strata:disable
~~~

Download is explicit and needs compatible NVIDIA hardware, sufficient RAM and SSD
space. Existing runtime, preset and login tasks are preserved. Setup configures
only the local profile. Strata requests use the existing loopback bridge;
native cloud models never pass through it. Services run without terminal windows.
The existing context policy preserves computer, Chrome and GitHub tools; its
budgets apply only to local requests. OpenClaw/JARVIS/Harness connections remain
independent of the Codex cloud model list.

## Repair an original native chat without changing its ID

~~~sh
npm run repair:thread -- --thread <original-thread-UUID>
npm run repair:thread -- --thread <original-thread-UUID> --apply
~~~

Default diagnosis and apply never create another chat. If the original session
header says openai but its index was mislabeled ollamaforge by the old bridge,
the repair backs up the state database and full history, corrects exactly that
one index field, resumes the original ID and compares every previous turn/item.
History, files, timestamps and permission fields are not rewritten by the index
correction. Active source turns and unexpected provenance are refused.
Reopen the original link afterward to refresh any stale desktop provider label.

A genuine provider change is different from index drift. It is refused by the
same-ID repair. Only if a new history branch is explicitly wanted, add --fork to
--apply. A desktop-created branch can be checked with --verify <child-UUID>.
Private backups remain in ignored .runtime/original-thread-repair and
.runtime/thread-recovery. They include complete private conversations and can be large.
CLI discovery uses PATH or OLLAMAFORGE_CODEX_BIN; --codex can select an executable.
The command supports the inspected paginated state_5 schema and refuses a missing
state database rather than creating or guessing one.

## OpenClaw and LeetTutor JARVIS on Strata (Windows)

On Windows, optionally connect OpenClaw and LeetTutor JARVIS with
`npm run connect:assistants`, then `npm run launch:assistants`. Prepare the sibling
`Leetcode` checkout and its `.venv` first, or pass its full path to the connect
command. This installs a pinned official OpenClaw runtime, reuses Strata without
downloading weights, and creates hidden user login tasks and two desktop shortcuts.
OpenClaw retains local token authentication; JARVIS uses the existing bounded
loopback bridge on port 1234. Conflicting services are never replaced. Initial
OpenClaw startup can take several minutes; launchers wait for readiness. Each PC
creates its own credentials and Python environment. Private state stays untracked.

OpenClaw runs at normal priority with a hidden supervisor: it retries a failed
child after five seconds, and a repeating one-minute, single-instance trigger
recovers a dead supervisor. Launchers wait for the loaded Strata model, Gateway
readiness, a real reply in a separate startup-check session, and successful run
settlement. Serving the dashboard HTML alone is insufficient. Full cold startup
still takes time; login startup performs it automatically.

The default bundled skills cover Windows development, GitHub, debugging and
visualization, with continuous skill watching off. Explicit user skill/watch
choices take precedence; the existing computer/browser tool policy is retained.
The child environment deduplicates PATH, includes this checkout's private OpenClaw
CLI directory, and discovers installed Git/GitHub Desktop Git. Qwen uses the
official `qwen-chat-template` dialect to send a real
`enable_thinking=false` by default, while preserving selectable thinking levels.
Unconfigured recurring model heartbeats default to off to reduce contention;
explicit existing heartbeat settings are preserved.

Run `npm run test:openclaw` for authentication/readiness/failure tests, or
`npm run test:openclaw-live` for real first/follow-up replies and a random-file
read proof. Local timings are saved to ignored `.runtime/openclaw-latency.json`.
Initial long-prompt prefill and contention from other model clients still affect
latency.

## DeepSeek Harness with the same local model

From this checkout, run:

```sh
npm run launch:deepseek
```

Fresh deployments seed Chinese as the durable Web UI language, independent of
the browser's language. Later choices in Settings → General → Language are
preserved across reconnects and redeployments.

Choose a real project explicitly with
`npm run launch:deepseek -- --workspace /absolute/path/to/project` (on Windows,
use its full drive path). The selection is saved for the desktop launcher and
registered in the Web UI. Runtime/test directories are rejected as default
workspaces. Real headless checks use their own isolated Harness homes, so running
tests cannot make a test folder become the user's project.

Local compaction is sized to the selected model: at 128K it starts around 109K
tokens, reserves 8K of headroom and limits a summary to 2K tokens. A failed summary
is deferred until substantial new history arrives, rather than retried after
every tool call. Near the hard context limit the task stops with its history
preserved; the separate overflow-recovery attempt remains bounded. Codex's cloud
connection settings are unchanged. The same budget applies to each Web preset's isolated
compaction engine while preserving its tools and other customizations.

`deepseek-recovery.mjs` provides a conservative recovery helper: it snapshots a
valid session log, keeps source files, verifies copied files with SHA-256 and
refuses conflicting destination files before writing. `working_directory` changes
the effective directory, but does not change a session's sandbox write boundary.
For a legacy test session, `deepseek-migrate-session.mjs` uses the official seed API
to create a continuation in the real project with its full event history inherited;
the original session remains available. Migration requests and receipts stay in the
ignored local runtime. Ordinary launches do not migrate other sessions.

The Windows isolated shell must provision a directory grant and integrity label.
If the current user owns the project but initialization reports
`grantWrite / SetNamedSecurityInfoW`, diagnose it with:

```powershell
npm run repair:deepseek-workspace -- --workspace 'D:\Documents\GitHub\your-project'
# Apply only if the diagnostic says it is needed:
npm run repair:deepseek-workspace -- --workspace 'D:\Documents\GitHub\your-project' --apply
```

This adds only the current owner's root-directory `ChangePermissions` and
`TakeOwnership` rights needed for sandbox provisioning. It does not recurse,
change ownership, remove other entries or enable full-access mode. The original
descriptor is backed up first under the ignored local
`.runtime/deepseek-harness/recovery/workspace-permissions/` directory.

This installs the pinned official `@deepseek-ai/dsh` runtime and its native
Cua Driver and Chrome DevTools providers, connects an existing local model, and
opens the authenticated Web UI at `http://127.0.0.1:3080`. On Windows it also
creates **DeepSeek + Strata** on the desktop and starts a user-owned
background task with no terminal window. The task starts on demand; the shortcut
also starts it after a reboot. It does not change Codex's startup or providers.

The desktop entry has a bundled whale/layers icon and Ctrl+Alt+D hotkey.
It starts the saved Strata preset when needed, reuses a running Harness, and
preserves its workspace and chats. To restore the shortcut without starting services:

~~~sh
npm run install:deepseek-shortcut
~~~

Strata is preferred when available: its actual model, context capacity and image
support are read from `/health`. Otherwise an already installed Ollama model is
selected. No model weights are downloaded. Harness packages, private startup
tokens, sessions, configuration and logs stay in the ignored
`.runtime/deepseek-harness/` directory; an existing `~/.dsh` is left alone.

```sh
npm run connect:deepseek
npm run test:deepseek
npm run test:deepseek-controls
npm run stop:deepseek
```

`connect:deepseek` only configures the connection. `test:deepseek` runs the real
Harness to read a random file, write a new file and reply with the marker.
`test:deepseek-controls` opens a disposable local page and verifies native
click/typing and Chrome fill/click using separate server receipts plus tool
events. It needs an unlocked, visible macOS or Windows desktop. Ordinary `npm test` runs
offline policy tests, not desktop actions or runtime installation.

To select another local endpoint, name its installed model and actual context:

```sh
npm run launch:deepseek -- --base-url http://127.0.0.1:8080/v1 --model qwen3.8-flash-next-iq3_s --context 131072 --api openai-responses
```

To offer another model already installed at that endpoint, add
`--extra-model <model> --extra-context <capacity>`. Each model receives its own
context and compaction policy. `--model` remains the default for new chats.
Selecting either model in the picker does not require restarting Harness.

Use `--port 3081` if 3080 belongs to another app, or `--no-open` to keep the Web UI
in the background. Configuration changes reserve an idle runtime before restarting
this checkout's owned Harness Web process. Running tasks block the restart.
Windows and Unix stop paths verify ownership before stopping processes.
For the first upgrade of an older server, wait for its tasks to finish, run
`npm run stop:deepseek`, then relaunch to load the restart guard.

Computer control uses Harness's own native driver, not Codex's private plugin,
permissions or browser connection. Chrome uses a separate, visible Chromium
instance for each live session. OS permissions still apply. Image tools require
a model endpoint with verified image support; text-only routes cannot interpret
screenshots. The providers are experimental. See the
[official Harness project](https://github.com/deepseek-ai/deepseek-harness).
The repository's small native adapter preserves the driver's structured snapshot
and element handles in the model-visible result, fixing the upstream text-only
projection. Both profiles require the native adapter and Chrome provider before
starting, so missing drivers cannot silently become a partial success.

## Privacy and verification

Private backups, conversation history, accounts, models and runtime files stay
untracked. Each computer uses its own account, model files and installations.

~~~sh
npm test
npm run test:native
npm run test:thread-recovery
npm run test:strata
npm run test:strata-startup
~~~

Native preservation tests assert byte-identical configuration across setup,
launch and disconnect, protect future cloud models, and reject destructive
launcher behavior. Live cloud, local and historical-thread checks are separate
from unit fixtures. A source chat is retained when creating a continuation.
