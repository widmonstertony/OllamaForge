$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
try {
    $node = Resolve-OllamaForgeNode
    Set-Location -LiteralPath $PSScriptRoot
    $settingsFile = Join-Path $PSScriptRoot '.runtime\deepseek-harness\connection.json'
    if (Test-Path -LiteralPath $settingsFile) {
        $saved = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
        if ($saved.baseURL -eq 'http://127.0.0.1:8080/v1') {
            $health = $null
            try { $health = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 3 } catch { }
            if (-not $health) { & (Join-Path $PSScriptRoot 'Start-StrataBackground.ps1') -Once }
            elseif ($health.service -ne 'strata' -or $health.model -ne $saved.model) { throw 'Port 8080 is serving a different model. Existing service was preserved.' }
        }
    }
    & $node (Join-Path $PSScriptRoot 'deepseek-harness.mjs') launch
    if ($LASTEXITCODE -ne 0) { throw 'DeepSeek Harness could not start. See the launcher log for details.' }
} catch {
    $log = Join-Path $env:LOCALAPPDATA 'OllamaForge\Open-DeepSeekHarness.host.stderr.log'
    Write-Error $_ -ErrorAction Continue
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup(($_.Exception.Message + [Environment]::NewLine + $log), 15, 'DeepSeek + Strata', 16)
    exit 1
}
