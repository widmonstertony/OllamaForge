[CmdletBinding(SupportsShouldProcess = $true)]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Strata-WindowsRuntime.ps1')
$desktop = [Environment]::GetFolderPath('Desktop')
$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if (-not $package) { throw 'Install the official Codex desktop app first.' }
[xml]$manifest = Get-Content -LiteralPath (Join-Path $package.InstallLocation 'AppxManifest.xml')
$app = $manifest.Package.Applications.Application | Where-Object { $_.Id -eq 'App' } | Select-Object -First 1
if (-not $app) { throw 'The native Codex application entry is missing.' }
$executable = Join-Path $package.InstallLocation $app.Executable
$shell = New-Object -ComObject WScript.Shell
$destination = Join-Path $desktop 'Codex（官方云端）.lnk'
$nativeArguments = 'shell:AppsFolder\' + $package.PackageFamilyName + '!' + $app.Id
if (Test-Path -LiteralPath $destination) {
    $existing = $shell.CreateShortcut($destination)
    if ($existing.Arguments -ne $nativeArguments) { throw 'An unrelated shortcut already uses this name; it was preserved.' }
}
foreach ($file in Get-ChildItem -LiteralPath $desktop -Filter '*.lnk') {
    $existing = $shell.CreateShortcut($file.FullName)
    $keys = ($existing.Hotkey.ToUpperInvariant().Split('+') | Sort-Object) -join '+'
    if ($keys -eq 'ALT+CTRL+C' -and $existing.Arguments -ne $nativeArguments) { throw 'Ctrl+Alt+C is already assigned to another desktop shortcut.' }
}
if ($PSCmdlet.ShouldProcess($destination, 'Install native Codex entry with its official icon')) {
    $state = Join-Path $env:LOCALAPPDATA 'OllamaForge'
    New-Item -ItemType Directory -Path $state -Force | Out-Null
    $iconFile = Join-Path $state 'codex-native.ico'
    Add-Type -AssemblyName System.Drawing
    $icon = [Drawing.Icon]::ExtractAssociatedIcon($executable)
    $stream = [IO.File]::Create($iconFile)
    try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose() }
    $shortcut = $shell.CreateShortcut($destination)
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'explorer.exe'
    $shortcut.Arguments = $nativeArguments
    $shortcut.IconLocation = $iconFile + ',0'
    $shortcut.Description = 'Codex official cloud | Ctrl+Alt+C | native models and existing chats'
    $shortcut.Hotkey = 'CTRL+ALT+C'
    $shortcut.WorkingDirectory = $desktop
    $shortcut.Save()
    Update-OllamaForgeShortcut $destination
    # Retire only repository-owned entries. Opening the cloud app must not run
    # Restore-Codex-Cloud.ps1 or Launch-Codex-Connected.ps1 and change settings.
    foreach ($legacy in @(
        @{Name='本地 Codex（GUI）.lnk'; Script='Launch-Codex-Connected.ps1'},
        @{Name='云端 Codex.lnk'; Script='Restore-Codex-Cloud.ps1'}
    )) {
        $old = Join-Path $desktop $legacy.Name
        if (Test-Path -LiteralPath $old) {
            $entry = $shell.CreateShortcut($old)
            if ($entry.Arguments.Contains('"' + (Join-Path $PSScriptRoot $legacy.Script) + '"')) { Remove-Item -LiteralPath $old }
        }
    }
    Write-Output ('Ready: ' + $destination + ' (Ctrl+Alt+C)')
}
if ((Test-Path -LiteralPath (Join-Path $PSScriptRoot '.runtime\deepseek-harness\connection.json')) -and $PSCmdlet.ShouldProcess($desktop, 'Install independent local Harness entry')) {
    & (Join-Path $PSScriptRoot 'Install-DeepSeekShortcut.ps1')
}
