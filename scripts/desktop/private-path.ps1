# Restrict only an Examify-owned path, never a shared/system parent directory.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
try {
    $Item = Get-Item -LiteralPath $Path -Force
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe' }
    $Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $Sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
    $Current = $Item.GetAccessControl($Sections)
    if ($Current.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $Sid.Value) { throw 'owner' }
    if ($Item.PSIsContainer) {
        $Acl = New-Object Security.AccessControl.DirectorySecurity
        $Rule = New-Object Security.AccessControl.FileSystemAccessRule($Sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
        $Acl = New-Object Security.AccessControl.FileSecurity
        $Rule = New-Object Security.AccessControl.FileSystemAccessRule($Sid, 'FullControl', 'Allow')
    }
    $Acl.SetAccessRuleProtection($true, $false)
    $Acl.AddAccessRule($Rule)
    function Test-PrivateAcl($Value) {
        $Rules = @($Value.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if ($Value.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $Sid.Value -or -not $Value.AreAccessRulesProtected -or $Rules.Count -ne 1) { return $false }
        $Actual = $Rules[0]
        return ($Actual.IdentityReference.Value -eq $Sid.Value -and -not $Actual.IsInherited -and $Actual.AccessControlType -eq $Rule.AccessControlType -and $Actual.FileSystemRights -eq $Rule.FileSystemRights -and $Actual.InheritanceFlags -eq $Rule.InheritanceFlags -and $Actual.PropagationFlags -eq $Rule.PropagationFlags)
    }
    # Avoid propagating an unchanged inheritable DACL through the installed
    # runtime/junction tree. This is an exact descriptor check, not a marker.
    if (Test-PrivateAcl $Current) { exit 0 }
    # Persist only the changed DACL. Set-Acl copies the whole descriptor and its
    # fallback can request audit privileges when revisiting a protected DACL.
    # The owner was checked above and is deliberately never changed here.
    $Item.SetAccessControl($Acl)
    $After = $Item.GetAccessControl($Sections)
    if (-not (Test-PrivateAcl $After)) { throw 'verify' }
} catch {
    [Console]::Error.WriteLine('Examify could not secure its private local files. Use an ordinary account and a dedicated folder owned by you.')
    exit 1
}
