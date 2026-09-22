[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launcher = Join-Path $PSScriptRoot 'Launch-Codex-Connected.ps1'
$shell = New-Object -ComObject WScript.Shell
$entries = @(
    @{
        Name = '本地 Codex（GUI）'
        Target = $powerShell
        Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -File "' + $launcher + '"'
        Description = '刷新 Ollama 模型并自动重启 Codex；云端和本地模型均可选择'
    }
)
foreach ($entry in $entries) {
    if (-not (Test-Path -LiteralPath $entry.Target)) { throw "Missing shortcut target: $($entry.Target)" }
    $shortcutPath = Join-Path $desktop ($entry.Name + '.lnk')
    if ($PSCmdlet.ShouldProcess($shortcutPath, 'Create or update Codex shortcut')) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $entry.Target
        $shortcut.Arguments = $entry.Arguments
        $shortcut.WorkingDirectory = $PSScriptRoot
        $shortcut.Description = $entry.Description
        $shortcut.Save()
        Write-Host "Ready: $shortcutPath"
    }
}
