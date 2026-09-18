[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$powerShell = Join-Path $PSHOME 'powershell.exe'
$shell = New-Object -ComObject WScript.Shell
$entries = @(
    @{ Name = '本地 Codex（GUI）'; Script = 'Launch-Codex-GUI.ps1'; Extra = '' },
    @{ Name = '云端 Codex'; Script = 'Restore-Codex-Cloud.ps1'; Extra = '' }
)
foreach ($entry in $entries) {
    $script = Join-Path $PSScriptRoot $entry.Script
    if (-not (Test-Path -LiteralPath $script)) { throw "Missing launcher: $script" }
    $shortcutPath = Join-Path $desktop ($entry.Name + '.lnk')
    if ($PSCmdlet.ShouldProcess($shortcutPath, 'Create or update Codex shortcut')) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $powerShell
        $shortcut.Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -File "' + $script + '"' + $entry.Extra
        $shortcut.WorkingDirectory = $PSScriptRoot
        $shortcut.Save()
        Write-Host "Ready: $shortcutPath"
    }
}
