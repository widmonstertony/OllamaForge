[CmdletBinding()]
param([switch]$Once)
$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'OllamaForge'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$log = Join-Path $stateDir 'startup.log'
$transcript = if ($Once) { 'start-details.log' } else { 'startup-details.log' }
Start-Transcript -Path (Join-Path $stateDir $transcript) -Append | Out-Null
function Write-State([string]$Message) {
    Add-Content -LiteralPath $log -Value ("{0:u} {1}" -f (Get-Date), $Message) -Encoding UTF8
}
function Get-Health([string]$Url) {
    try { Invoke-RestMethod -Uri $Url -TimeoutSec 3 } catch { $null }
}
$previousState = ''
Write-State 'Supervisor started; cloud gateway first, then the saved IQ3_S model. No downloads or Codex restart.'
do {
    try {
        $ollama = Get-Health 'http://127.0.0.1:11434/api/version'
        $bridge = Get-Health 'http://127.0.0.1:11436/health'
        if (-not $ollama.version -or $bridge.service -ne 'ollamaforge-strata-bridge' -or $bridge.contextPolicy -ne 'desktop-v1') {
            & (Join-Path $PSScriptRoot 'Setup-Strata.ps1') -InfrastructureOnly
        }
        $strata = Get-Health 'http://127.0.0.1:8080/health'
        if (-not $strata) {
            Write-State 'Starting the saved Strata preset.'
            & (Join-Path $PSScriptRoot 'Setup-Strata.ps1') -RuntimeOnly
            $strata = Get-Health 'http://127.0.0.1:8080/health'
        }
        # Do not replace another model or restart a model that is still loading.
        $expected = $strata.service -eq 'strata' -and $strata.model -eq 'qwen3.8-flash-next-iq3_s' -and $strata.max_context -eq 131072
        $standby = $false
        if ($expected -and -not $strata.loaded) {
            $metrics = Get-Health 'http://127.0.0.1:8080/metrics'
            $standby = $metrics.live.state -eq 'unloaded' -and $metrics.live.queued -eq 0
        }
        if ($expected -and $strata.loaded) {
            $state = 'READY: cloud gateway, loopback bridge, IQ3_S 128K.'
        } elseif ($standby) {
            $state = 'READY: IQ3_S 128K server in standby; the next request reloads the model automatically.'
        } else {
            $state = "WAIT: Strata reports loaded=$($strata.loaded), model=$($strata.model), context=$($strata.max_context). Existing runtime left running."
            if ($Once) { throw $state }
        }
        if ($state -ne $previousState) { Write-State $state; $previousState = $state }
    } catch {
        $state = 'RETRY: ' + $_.Exception.Message
        if ($state -ne $previousState) { Write-State $state; $previousState = $state }
        if ($Once) { throw }
    }
    if ($Once) { Write-Host $state; Stop-Transcript | Out-Null }
    else { Start-Sleep -Seconds 30 }
} while (-not $Once)
