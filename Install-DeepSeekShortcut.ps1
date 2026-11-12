[CmdletBinding()]
param([string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
if (-not $DesktopDirectory -or -not (Test-Path -LiteralPath $DesktopDirectory -PathType Container)) { throw 'Desktop directory is unavailable.' }
$runner = Join-Path $PSScriptRoot 'Open-DeepSeekHarness.ps1'
$launcher = Get-OllamaForgeBackgroundAction $runner
$icon = Join-Path $PSScriptRoot 'deepseek-strata.ico'
if (-not (Test-Path -LiteralPath $icon)) { throw 'DeepSeek + Strata icon is missing; update the complete checkout.' }
$shell = New-Object -ComObject WScript.Shell
$path = Join-Path $DesktopDirectory 'DeepSeek + Strata.lnk'
function Test-OwnedShortcut($Shortcut) {
    return ($Shortcut.Arguments -eq $launcher.Arguments -and
        ([IO.Path]::GetFileName($Shortcut.TargetPath) -eq 'OllamaForge.BackgroundHost.exe'))
}
if (Test-Path -LiteralPath $path) {
    if (-not (Test-OwnedShortcut ($shell.CreateShortcut($path)))) { throw 'An unrelated DeepSeek + Strata shortcut already exists; it was preserved.' }
}
foreach ($existing in Get-ChildItem -LiteralPath $DesktopDirectory -Filter '*.lnk') {
    $entry = $shell.CreateShortcut($existing.FullName)
    $keys = ($entry.Hotkey.ToUpperInvariant().Split('+') | Sort-Object) -join '+'
    if ($keys -eq 'ALT+CTRL+D' -and -not (Test-OwnedShortcut $entry)) { throw 'Ctrl+Alt+D is already assigned to another desktop shortcut.' }
}
$shortcut = $shell.CreateShortcut($path)
$shortcut.TargetPath = $launcher.Execute
$shortcut.Arguments = $launcher.Arguments
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'DeepSeek + Strata | Ctrl+Alt+D | local model, hidden startup'
$shortcut.IconLocation = $icon + ',0'
$shortcut.Hotkey = 'CTRL+ALT+D'
$shortcut.WindowStyle = 7
$shortcut.Save()
if ([IO.Path]::GetFullPath($DesktopDirectory) -eq [IO.Path]::GetFullPath([Environment]::GetFolderPath('Desktop'))) { Update-OllamaForgeShortcut $path }
# Retire only our older launcher, preserving unrelated shortcuts.
$legacy = Join-Path $DesktopDirectory 'OllamaForge - DeepSeek Harness.lnk'
if ((Test-Path -LiteralPath $legacy) -and (Test-OwnedShortcut ($shell.CreateShortcut($legacy)))) {
    Remove-Item -LiteralPath $legacy
    if ([IO.Path]::GetFullPath($DesktopDirectory) -eq [IO.Path]::GetFullPath([Environment]::GetFolderPath('Desktop'))) { Update-OllamaForgeShortcut $legacy -Deleted }
}
Write-Output ('Shortcut ready: ' + $path + ' (Ctrl+Alt+D)')
