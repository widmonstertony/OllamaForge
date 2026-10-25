function Repair-StrataRuntimeAlias([string]$PackageCache) {
    # Store-packaged Codex and ordinary desktop processes see different names for
    # the same Strata files. Normalize only the old ready-file reference. Strata
    # itself still checks its host lease and child lifetime before recovery.
    $physical = Join-Path $PackageCache 'Local\Strata\runtime'
    if ($env:STRATA_RUNTIME_DIR -ne $physical) { return }
    $statePath = Join-Path $physical 'launch-codex-iq3_s-128k.json'
    if (-not (Test-Path -LiteralPath $statePath)) { return }
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ($state.profile -ne 'launch-codex-iq3_s-128k' -or $state.token -notmatch '^[a-f0-9]{64}$') { return }
    $marker = Join-Path $physical ('launch-codex-iq3_s-128k-' + $state.token + '.child.json')
    if (-not (Test-Path -LiteralPath $marker)) { return }
    $child = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
    if ($child.host_token -ne $state.token -or $child.phase -ne 'owned' -or -not $child.ready) { return }
    $alias = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData\Local\Strata\runtime'
    if ([IO.Path]::GetDirectoryName($child.ready) -ne $alias) { return }
    $name = [IO.Path]::GetFileName($child.ready)
    if ($name -notmatch '^launch-codex-iq3_s-128k-[a-f0-9]{32}\.ready\.json$') { return }
    $target = Join-Path $physical $name
    if (-not (Test-Path -LiteralPath $target)) { return }
    $ready = Get-Content -Raw -LiteralPath $target | ConvertFrom-Json
    if ($ready.pid -ne $child.pid -or $ready.model_id -ne 'qwen3.8-flash-next-iq3_s') { return }
    # Retain the original record; writing the existing file preserves its private ACL.
    Copy-Item -LiteralPath $marker -Destination ($marker + '.ollamaforge.bak') -Force
    $child.ready = $target
    [IO.File]::WriteAllText($marker, ($child | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
    Write-Host 'Normalized the Strata ready-file alias for ordinary Windows login startup.'
}
