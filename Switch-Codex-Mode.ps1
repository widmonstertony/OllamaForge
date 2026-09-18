[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Local', 'Cloud')]
    [string]$Mode,
    [ValidateSet('Fast', 'Quality')]
    [string]$LocalPreset = 'Fast',
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$agentRoot = $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$ollama = if (Get-Command ollama -ErrorAction SilentlyContinue) {
    (Get-Command ollama).Source
} else {
    Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
}
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
$configPath = Join-Path $codexHome 'config.toml'
$sourceCatalog = Join-Path $agentRoot 'local-qwen-catalog.json'
$localCatalog = Join-Path $codexHome 'local-qwen-catalog.json'
$statePath = Join-Path $agentRoot '.codex-cloud-settings.json'
$helper = Join-Path $agentRoot 'codex-mode-config.mjs'
$codexAppId = 'shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App'
$logPath = Join-Path $agentRoot 'codex-mode-switch.log'
$localSwitchStarted = $false
$localModelName = if ($LocalPreset -eq 'Fast') { 'qwen3.5-codex-fast-16k' } else { 'qwen3.8-codex-16k' }

function Write-SwitchLog([string]$message) {
    Add-Content -LiteralPath $logPath -Value ("{0:u} {1}" -f (Get-Date), $message) -Encoding utf8
}

function Get-CodexGuiProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*OpenAI.Codex_*' })
}

try {
    if (-not (Test-Path -LiteralPath $node)) { throw "Node.js not found: $node" }
    if (-not (Test-Path -LiteralPath $configPath)) { throw "Codex config not found: $configPath" }

    $currentMode = (& $node $helper status $configPath $statePath).Trim()
    $targetMode = $Mode.ToLowerInvariant()
    Write-SwitchLog "Requested=$Mode Preset=$LocalPreset Current=$currentMode NoRestart=$NoRestart"

    if (-not $NoRestart) {
        Add-Type -AssemblyName System.Windows.Forms
        $message = if ($Mode -eq 'Local') {
            "Open Codex GUI with local $LocalPreset Qwen?`r`n`r`nAll Codex windows will close and active tasks will be interrupted. Use the Cloud Codex desktop shortcut to switch back."
        } else {
            "Switch Codex back to OpenAI cloud models?`r`n`r`nAll Codex windows will close and active tasks will be interrupted."
        }
        $answer = [System.Windows.Forms.MessageBox]::Show(
            $message,
            'Codex model switch',
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }
    }

    if ($Mode -eq 'Local') {
        if (-not (Test-Path -LiteralPath $ollama)) { throw "Ollama not found: $ollama" }
        & $node $helper snapshot $configPath $statePath
        if ($LASTEXITCODE -ne 0) { throw 'Could not save cloud model settings.' }
        $localSwitchStarted = $true
        & (Join-Path $agentRoot 'Start-CodexOllama.ps1') -ModelName $localModelName
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:11435/health' -TimeoutSec 3
        if ($health.status -ne 'ok') { throw 'Local compatibility adapter is not healthy.' }
        & $node $helper local $configPath $statePath $sourceCatalog $localCatalog $localModelName
        if ($LASTEXITCODE -ne 0) { throw 'Could not configure the local provider.' }
    } else {
        & $node $helper cloud $configPath $statePath
        if ($LASTEXITCODE -ne 0) { throw 'Could not restore cloud model settings.' }
    }

    Write-Host "Codex is configured for $Mode mode." -ForegroundColor Green
    Write-SwitchLog "Configured=$Mode Model=$localModelName AdapterReady=$($Mode -eq 'Local')"
    if ($NoRestart) { exit 0 }

    foreach ($codexProcess in (Get-CodexGuiProcesses)) {
        try {
            $termination = Invoke-CimMethod -InputObject $codexProcess -MethodName Terminate -ErrorAction Stop
            if ($termination.ReturnValue -ne 0) {
                throw "Windows returned $($termination.ReturnValue) while closing process $($codexProcess.ProcessId)."
            }
        } catch {
            if (Get-Process -Id $codexProcess.ProcessId -ErrorAction SilentlyContinue) { throw }
        }
    }
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-CodexGuiProcesses).Count -gt 0 -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if ((Get-CodexGuiProcesses).Count -gt 0) {
        throw 'Codex did not fully close. Configuration changed, but restart was skipped.'
    }
    if ($Mode -eq 'Local') {
        # Recheck after Codex exits: an adapter inherited from the old app
        # process can disappear during GUI shutdown.
        & (Join-Path $agentRoot 'Start-CodexOllama.ps1') -ModelName $localModelName
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:11435/health' -TimeoutSec 3
        if ($health.status -ne 'ok') { throw 'Local adapter is not healthy after Codex GUI shutdown.' }
        Write-SwitchLog 'AdapterVerifiedAfterGuiClose=True'
    }
    Start-Sleep -Seconds 1
    Start-Process -FilePath 'explorer.exe' -ArgumentList $codexAppId -WindowStyle Normal
    $launchDeadline = (Get-Date).AddSeconds(30)
    while ((Get-CodexGuiProcesses).Count -eq 0 -and (Get-Date) -lt $launchDeadline) {
        Start-Sleep -Milliseconds 500
    }
    if ((Get-CodexGuiProcesses).Count -eq 0) {
        throw 'Codex GUI did not start within 30 seconds. Check the Windows app installation.'
    }
    Write-SwitchLog "GuiStarted=$Mode"
}
catch {
    $message = $_.Exception.Message
    Write-SwitchLog "ERROR=$message"
    if ($localSwitchStarted) {
        & $node $helper rollback $configPath $statePath 2>$null
        Write-SwitchLog 'Rolled back to cloud config after local-mode failure.'
    }
    if (-not $NoRestart -and (Get-CodexGuiProcesses).Count -eq 0) {
        try {
            Start-Process -FilePath 'explorer.exe' -ArgumentList $codexAppId -WindowStyle Normal
            Write-SwitchLog 'Attempted to reopen Codex after failure.'
        } catch {
            Write-SwitchLog "Reopen failed: $($_.Exception.Message)"
        }
    }
    Write-Host "Codex mode switch failed: $message" -ForegroundColor Red
    if (-not $NoRestart) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($message, 'Codex mode switch failed', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    }
    exit 1
}
