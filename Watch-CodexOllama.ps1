[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
$configPath = Join-Path $codexHome 'config.toml'
if (-not (Test-Path -LiteralPath $configPath)) { exit 0 }

# Never restart the local service while the desktop is configured for cloud.
$topLevel = ((Get-Content -LiteralPath $configPath -Raw) -split '(?m)^\[', 2)[0]
if ($topLevel -notmatch '(?m)^model_provider\s*=\s*"local_qwen"\s*$') { exit 0 }

$taskName = 'CodexOllamaAdapter'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task -or -not $task.Settings.Enabled) { exit 0 }

$healthy = $false
try {
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:11435/health' -TimeoutSec 3
    $healthy = $response.status -eq 'ok'
} catch {}
if ($task.State -eq 'Running' -and $healthy) { exit 0 }

if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
Start-ScheduledTask -TaskName $taskName
$runtimeDir = Join-Path $(if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath('UserProfile') }) 'CodexOllama'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
Add-Content -LiteralPath (Join-Path $runtimeDir 'watchdog.log') -Value ("{0:u} Restarted unhealthy local adapter." -f (Get-Date)) -Encoding utf8
