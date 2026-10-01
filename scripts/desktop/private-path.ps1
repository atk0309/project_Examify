# Restrict only an Examify-owned path, never a shared/system parent directory.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
try {
    $Item = Get-Item -LiteralPath $Path -Force
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe' }
    $Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $Current = Get-Acl -LiteralPath $Path
    $Owner = New-Object Security.Principal.NTAccount($Current.Owner)
    if ($Owner.Translate([Security.Principal.SecurityIdentifier]).Value -ne $Sid.Value) { throw 'owner' }
    if ($Item.PSIsContainer) {
        $Acl = New-Object Security.AccessControl.DirectorySecurity
        $Rule = New-Object Security.AccessControl.FileSystemAccessRule($Sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
        $Acl = New-Object Security.AccessControl.FileSecurity
        $Rule = New-Object Security.AccessControl.FileSystemAccessRule($Sid, 'FullControl', 'Allow')
    }
    $Acl.SetOwner($Sid)
    $Acl.SetAccessRuleProtection($true, $false)
    $Acl.AddAccessRule($Rule)
    Set-Acl -LiteralPath $Path -AclObject $Acl
} catch {
    [Console]::Error.WriteLine('Examify could not secure its private local files. Use an ordinary account and a dedicated folder owned by you.')
    exit 1
}
