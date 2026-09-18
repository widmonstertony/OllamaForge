[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ollamaExe = if (Get-Command ollama -ErrorAction SilentlyContinue) {
    (Get-Command ollama).Source
} else {
    Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
}
$runtimeDir = Join-Path $(if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath('UserProfile') }) 'CodexOllama'
$pidFile = Join-Path $runtimeDir 'codex-ollama-adapter.pid'
$adapterScript = Join-Path $PSScriptRoot 'codex-ollama-adapter.mjs'
$adapterTaskName = 'CodexOllamaAdapter'
$watchdog = Get-ScheduledTask -TaskName 'CodexOllamaWatchdog' -ErrorAction SilentlyContinue
if ($watchdog -and $watchdog.Settings.Enabled) {
    Disable-ScheduledTask -TaskName 'CodexOllamaWatchdog' | Out-Null
}

$task = Get-ScheduledTask -TaskName $adapterTaskName -ErrorAction SilentlyContinue
if ($task -and $task.Settings.Enabled) {
    Disable-ScheduledTask -TaskName $adapterTaskName | Out-Null
}
if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $adapterTaskName
    Write-Host "Stopped Codex-Ollama adapter task $adapterTaskName."
}

if (Test-Path -LiteralPath $pidFile) {
    $adapterPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $adapterPid" -ErrorAction SilentlyContinue
    if ($processInfo -and $processInfo.Name -match '^node(\.exe)?$' -and $processInfo.CommandLine -like "*$adapterScript*") {
        Stop-Process -Id $adapterPid -Force
        Write-Host "Stopped Codex-Ollama adapter PID $adapterPid."
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $ollamaExe) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        foreach ($modelName in @('qwen3.5-codex-fast-16k', 'qwen3.8-codex-16k')) {
            & $ollamaExe stop $modelName *> $null
        }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}
