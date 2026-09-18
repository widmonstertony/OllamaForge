[CmdletBinding()]
param(
    [int]$AdapterPort = 11435,
    [ValidateSet('qwen3.8-codex-16k', 'qwen3.5-codex-fast-16k')]
    [string]$ModelName = 'qwen3.8-codex-16k'
)

$ErrorActionPreference = 'Stop'
$ollamaExe = if (Get-Command ollama -ErrorAction SilentlyContinue) {
    (Get-Command ollama).Source
} else {
    Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
}
$adapterScript = Join-Path $PSScriptRoot 'codex-ollama-adapter.mjs'
$adapterRunner = Join-Path $PSScriptRoot 'Run-CodexOllamaAdapter.ps1'
$adapterTaskName = 'CodexOllamaAdapter'
$watchdogTaskName = 'CodexOllamaWatchdog'
$watchdogScript = Join-Path $PSScriptRoot 'Watch-CodexOllama.ps1'
$modelSpecs = @(
    @{ Alias = 'qwen3.5-codex-fast-16k'; Base = 'qwen3.5:9b'; File = 'Modelfile.codex-qwen-fast-16k' },
    @{ Alias = 'qwen3.8-codex-16k'; Base = 'qwen3.8:27b'; File = 'Modelfile.codex-qwen-16k' }
)
$runtimeDir = Join-Path $(if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath('UserProfile') }) 'CodexOllama'
$pidFile = Join-Path $runtimeDir 'codex-ollama-adapter.pid'
$stdoutLog = Join-Path $runtimeDir 'codex-ollama-adapter.stdout.log'
$stderrLog = Join-Path $runtimeDir 'codex-ollama-adapter.stderr.log'
$nodeExe = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $ollamaExe)) { throw "Ollama not found: $ollamaExe" }
if (-not (Test-Path -LiteralPath $nodeExe)) { throw "Node.js is required for the local compatibility adapter: $nodeExe" }
$zstdSupport = & $nodeExe -p "typeof require('node:zlib').zstdDecompressSync"
if ($zstdSupport -ne 'function') { throw 'This Node.js version cannot decode Codex Zstandard requests.' }

$llamaStop = Join-Path $PSScriptRoot 'Stop-LocalModel.ps1'
if (Test-Path -LiteralPath $llamaStop) { & $llamaStop }

try {
    $version = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2
} catch {
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    Start-Process -FilePath $ollamaExe -ArgumentList @('serve') -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDir 'ollama-serve.stdout.log') `
        -RedirectStandardError (Join-Path $runtimeDir 'ollama-serve.stderr.log') | Out-Null
    $deadline = (Get-Date).AddMinutes(2)
    do {
        Start-Sleep -Seconds 2
        try { $version = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 } catch { $version = $null }
    } while (-not $version -and (Get-Date) -lt $deadline)
    if (-not $version) { throw 'Ollama did not become ready on 127.0.0.1:11434.' }
}

$previousErrorActionPreference = $ErrorActionPreference
foreach ($spec in $modelSpecs) {
    try {
        $ErrorActionPreference = 'Continue'
        & $ollamaExe show $spec.Alias *> $null
        $aliasExists = $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if (-not $aliasExists) {
        try {
            $ErrorActionPreference = 'Continue'
            & $ollamaExe show $spec.Base *> $null
            $baseExists = $LASTEXITCODE -eq 0
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if (-not $baseExists) { throw "Base model $($spec.Base) is not installed. Run: ollama pull $($spec.Base)" }
        & $ollamaExe create $spec.Alias -f (Join-Path $PSScriptRoot $spec.File)
        if ($LASTEXITCODE -ne 0) { throw "Failed to create Ollama model alias $($spec.Alias)." }
    }
}

if ($AdapterPort -ne 11435) { throw 'The managed Codex adapter task uses port 11435.' }

$task = Get-ScheduledTask -TaskName $adapterTaskName -ErrorAction SilentlyContinue
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
if (-not $task) {
    $action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
        -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $adapterRunner + '"')
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Limited
    $task = Register-ScheduledTask -TaskName $adapterTaskName -Action $action -Principal $principal `
        -Settings $settings -Description 'User-owned local Codex Ollama Responses adapter (on demand)'
} elseif (-not ($task.Actions | Where-Object { $_.Arguments -like "*$adapterRunner*" })) {
    throw "Scheduled task $adapterTaskName exists but does not point to $adapterRunner. Refusing to replace it."
} elseif ($task.Settings.RestartCount -lt 10) {
    $task = Set-ScheduledTask -TaskName $adapterTaskName -Settings $settings
}
if (-not $task.Settings.Enabled) { $task = Enable-ScheduledTask -TaskName $adapterTaskName }

$watchdog = Get-ScheduledTask -TaskName $watchdogTaskName -ErrorAction SilentlyContinue
if (-not $watchdog) {
    $watchdogAction = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
        -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $watchdogScript + '"')
    $watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 1)
    $watchdogPrincipal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Limited
    $watchdogSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $watchdog = Register-ScheduledTask -TaskName $watchdogTaskName -Action $watchdogAction `
        -Trigger $watchdogTrigger -Principal $watchdogPrincipal -Settings $watchdogSettings `
        -Description 'Restarts the local Codex adapter if it disconnects while local mode is active'
} elseif (-not ($watchdog.Actions | Where-Object { $_.Arguments -like "*$watchdogScript*" })) {
    throw "Scheduled task $watchdogTaskName exists but does not point to $watchdogScript. Refusing to replace it."
}
if (-not $watchdog.Settings.Enabled) { Enable-ScheduledTask -TaskName $watchdogTaskName | Out-Null }

$health = $null
try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$AdapterPort/health" -TimeoutSec 2 } catch {}
if ($task.State -eq 'Running' -and $health.status -eq 'ok') {
    # A just-stopped task can leave a short-lived listener behind. Recheck
    # before treating its health response as proof of a durable service.
    Start-Sleep -Seconds 3
    $task = Get-ScheduledTask -TaskName $adapterTaskName
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$AdapterPort/health" -TimeoutSec 2 } catch { $health = $null }
    if ($task.State -eq 'Running' -and $health.status -eq 'ok') {
        Write-Host "Codex-Ollama adapter task is already ready on port $AdapterPort."
        exit 0
    }
}

if ($task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $adapterTaskName
    Start-Sleep -Seconds 1
}

# Replace a legacy child process: it may disappear when Codex GUI restarts.
$listener = Get-NetTCPConnection -LocalPort $AdapterPort -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1
if ($listener) {
    $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction Stop
    if ($listenerProcess.Name -notmatch '^node(\.exe)?$' -or
        $listenerProcess.CommandLine -notlike "*$adapterScript*") {
        throw "Port $AdapterPort is occupied by a process other than the Codex adapter."
    }
    Stop-Process -Id $listener.OwningProcess -Force
    Start-Sleep -Milliseconds 500
}

Start-ScheduledTask -TaskName $adapterTaskName
$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 500
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$AdapterPort/health" -TimeoutSec 2 } catch { $health = $null }
    $task = Get-ScheduledTask -TaskName $adapterTaskName
} while (($health.status -ne 'ok' -or $task.State -ne 'Running') -and (Get-Date) -lt $deadline)

if ($health.status -eq 'ok' -and $task.State -eq 'Running') {
    Start-Sleep -Seconds 3
    $task = Get-ScheduledTask -TaskName $adapterTaskName
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$AdapterPort/health" -TimeoutSec 2 } catch { $health = $null }
}

if ($health.status -ne 'ok' -or $task.State -ne 'Running') {
    $tail = if (Test-Path -LiteralPath $stderrLog) { Get-Content -LiteralPath $stderrLog -Tail 30 } else { @() }
    throw "Codex-Ollama adapter task did not become ready. State=$($task.State).`n$($tail -join [Environment]::NewLine)"
}
$listener = Get-NetTCPConnection -LocalPort $AdapterPort -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1
if ($listener) { Set-Content -LiteralPath $pidFile -Value $listener.OwningProcess -Encoding ascii }
Write-Host "Ready: Ollama $($version.version), model $ModelName, adapter task $adapterTaskName at http://127.0.0.1:$AdapterPort/v1"
