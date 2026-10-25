[CmdletBinding()]
param([switch]$Once)
$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'OllamaForge'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$log = Join-Path $stateDir 'startup.log'
Start-Transcript -Path (Join-Path $stateDir 'startup-details.log') -Append | Out-Null
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
        if (-not $ollama.version -or $bridge.service -ne 'ollamaforge-strata-bridge') {
            & (Join-Path $PSScriptRoot 'Setup-Strata.ps1') -InfrastructureOnly
        }
        $strata = Get-Health 'http://127.0.0.1:8080/health'
        if (-not $strata) {
            Write-State 'Starting the saved Strata preset.'
            & (Join-Path $PSScriptRoot 'Setup-Strata.ps1') -RuntimeOnly
            $strata = Get-Health 'http://127.0.0.1:8080/health'
        }
        # Do not replace another model or restart a model that is still loading.
        if ($strata.loaded -and $strata.model -eq 'qwen3.8-flash-next-iq3_s' -and $strata.max_context -eq 131072) {
            $state = 'READY: cloud gateway, loopback bridge, IQ3_S 128K.'
        } else {
            $state = "WAIT: Strata reports loaded=$($strata.loaded), model=$($strata.model), context=$($strata.max_context). Existing runtime left running."
        }
        if ($state -ne $previousState) { Write-State $state; $previousState = $state }
    } catch {
        $state = 'RETRY: ' + $_.Exception.Message
        if ($state -ne $previousState) { Write-State $state; $previousState = $state }
        if ($Once) { throw }
    }
    if (-not $Once) { Start-Sleep -Seconds 30 }
} while (-not $Once)
