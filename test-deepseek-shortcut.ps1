$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('deepseek-shortcut-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $installer = Join-Path $PSScriptRoot 'Install-DeepSeekShortcut.ps1'
    & $installer -DesktopDirectory $root
    $file = Join-Path $root 'DeepSeek + Strata.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($file)
    if (-not (Test-Path -LiteralPath $link.TargetPath)) { throw 'Missing hidden launcher.' }
    if ($link.Arguments -ne ('"' + (Join-Path $PSScriptRoot 'Open-DeepSeekHarness.ps1') + '"')) { throw 'Wrong launcher script.' }
    if ($link.IconLocation -ne ((Join-Path $PSScriptRoot 'deepseek-strata.ico') + ',0')) { throw 'Wrong icon.' }
    if ((($link.Hotkey.ToUpperInvariant().Split('+') | Sort-Object) -join '+') -ne 'ALT+CTRL+D') { throw 'Missing hotkey.' }
    & $installer -DesktopDirectory $root
    $otherFile = Join-Path $root 'Unrelated.lnk'
    $other = $shell.CreateShortcut($otherFile)
    $other.TargetPath = Join-Path $env:SystemRoot 'explorer.exe'
    $other.Hotkey = 'CTRL+ALT+D'
    $other.Save()
    $before = [IO.File]::ReadAllBytes($otherFile)
    $refused = $false
    try { & $installer -DesktopDirectory $root } catch { $refused = $_.Exception.Message -like '*already assigned*' }
    if (-not $refused) { throw 'A conflicting hotkey was not refused.' }
    if ([Convert]::ToBase64String($before) -ne [Convert]::ToBase64String([IO.File]::ReadAllBytes($otherFile))) { throw 'Unrelated shortcut changed.' }
    Remove-Item -LiteralPath $otherFile
    Remove-Item -LiteralPath $file
    $unrelated = $shell.CreateShortcut($file)
    $unrelated.TargetPath = Join-Path $env:SystemRoot 'explorer.exe'
    $unrelated.Save()
    $refused = $false
    try { & $installer -DesktopDirectory $root } catch { $refused = $_.Exception.Message -like '*unrelated*' }
    if (-not $refused) { throw 'An unrelated named shortcut was overwritten.' }
    $icon = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'deepseek-strata.ico'))
    if ([BitConverter]::ToUInt16($icon,2) -ne 1 -or [BitConverter]::ToUInt16($icon,4) -ne 4) { throw 'Expected a four-resolution ICO.' }
    Write-Output 'PASS: real Windows shortcut, hidden target, hotkey, icon, reinstall and conflict preservation.'
} finally {
    $resolved = [IO.Path]::GetFullPath($root)
    if ([IO.Path]::GetDirectoryName($resolved) -ne ([IO.Path]::GetTempPath()).TrimEnd('\') -or -not [IO.Path]::GetFileName($resolved).StartsWith('deepseek-shortcut-')) { throw 'Unexpected test cleanup directory.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
