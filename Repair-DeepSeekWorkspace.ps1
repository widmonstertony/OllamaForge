[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Path, [switch]$Apply, [string]$BackupDirectory)
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $Path -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Select an ordinary project directory.' }
$target = $item.FullName.TrimEnd('\')
if ($target -eq [IO.Path]::GetPathRoot($item.FullName).TrimEnd('\')) { throw 'A drive root cannot be repaired as a project.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$acl = Get-Acl -LiteralPath $target
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $identity.User.Value) { throw 'This repair only applies to a project already owned by the signed-in user.' }
$required = [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
$present = @($acl.Access | Where-Object {
    $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $identity.User.Value -and
    (($_.FileSystemRights -band $required) -eq $required)
}).Count -gt 0
if ($present) { Write-Host 'Ready: the project owner already has an explicit directory-permission entry.'; return }
if (-not $Apply) { Write-Host 'The project owner needs explicit ChangePermissions/TakeOwnership rights on this directory so the isolated shell can provision its write grant and integrity label. Re-run with -Apply to add only those rights.'; return }
if (-not $BackupDirectory) { $BackupDirectory = Join-Path $env:LOCALAPPDATA 'OllamaForge\workspace-permissions' }
New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
$receipt = Join-Path $BackupDirectory (([guid]::NewGuid().ToString('N')) + '.json')
$before = $acl.Sddl
@{Path=$target;UserSid=$identity.User.Value;BeforeSddl=$before;At=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $receipt -Encoding UTF8
$rule = New-Object Security.AccessControl.FileSystemAccessRule($identity.User, $required, [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
$after = Get-Acl -LiteralPath $target
if ($after.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) { throw 'Unexpected owner change.' }
$verified = @($after.Access | Where-Object {
    $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $identity.User.Value -and
    (($_.FileSystemRights -band $required) -eq $required)
}).Count -gt 0
if (-not $verified) { throw ('Directory permission entry was not retained. Original descriptor: ' + $receipt) }
Write-Host ('Ready: added only the current owner''s directory ChangePermissions/TakeOwnership rights. Original entries and owner preserved. Backup: ' + $receipt)
