$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$node = Resolve-OllamaForgeNode
$saved = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.runtime\strata-assistants.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$needle = Join-Path $PSScriptRoot '.runtime\openclaw\node_modules\openclaw\openclaw.mjs'
while ($true) {
    $listener = Get-NetTCPConnection -LocalPort $saved.openclawPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
        if (-not $owner.CommandLine -or $owner.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'OpenClaw port belongs to another runtime; nothing was replaced.' }
        $ownerPid = $listener.OwningProcess
        $started = (Get-Process -Id $ownerPid).StartTime
        $verified = $false
        try {
            $receipt = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.runtime\openclaw-ready.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            $verified = $receipt.pid -eq $ownerPid -and $receipt.model -eq $saved.model
        } catch { }
        if (-not $verified) { & $node (Join-Path $PSScriptRoot 'strata-assistants.mjs') warm-openclaw $ownerPid }
        Write-Output ('Monitoring the existing owned OpenClaw PID ' + $ownerPid)
        do {
            Start-Sleep -Seconds 5
            $process = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
        } while ($process -and $process.StartTime -eq $started)
    } else {
        & $node (Join-Path $PSScriptRoot 'strata-assistants.mjs') serve-openclaw
        if ($LASTEXITCODE -eq 78) { exit 78 }
    }
    Write-Output 'OpenClaw exited; the background supervisor will recover it in five seconds.'
    Start-Sleep -Seconds 5
}
