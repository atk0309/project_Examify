# Restrict only an Examify-owned path, never a shared/system parent directory.
param([Parameter(Mandatory = $true)][string]$Path, [switch]$Diagnostics)
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
function Report-Stage([string]$Stage) { if ($Diagnostics) { [Console]::Out.WriteLine($Stage) } }
try {
    Report-Stage 'ENTRY'
    # Use framework APIs directly. No Get-Item/New-Object module discovery is
    # needed in the deliberately minimal packaged process environment.
    $Attributes = [IO.File]::GetAttributes($Path)
    if ($Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe' }
    $Directory = [bool]($Attributes -band [IO.FileAttributes]::Directory)
    $Item = if ($Directory) { [IO.DirectoryInfo]::new($Path) } else { [IO.FileInfo]::new($Path) }
    Report-Stage 'METADATA'
    $Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $Sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
    $Current = $Item.GetAccessControl($Sections)
    Report-Stage 'ACL_READ'
    if ($Current.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $Sid.Value) { throw 'owner' }
    if ($Directory) {
        $Acl = [Security.AccessControl.DirectorySecurity]::new()
        $Rule = [Security.AccessControl.FileSystemAccessRule]::new($Sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
        $Acl = [Security.AccessControl.FileSecurity]::new()
        $Rule = [Security.AccessControl.FileSystemAccessRule]::new($Sid, 'FullControl', 'Allow')
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
    if (Test-PrivateAcl $Current) { Report-Stage 'DONE'; exit 0 }
    # Persist only the changed DACL. Set-Acl copies the whole descriptor and its
    # fallback can request audit privileges when revisiting a protected DACL.
    # The owner was checked above and is deliberately never changed here.
    Report-Stage 'ACL_WRITE'
    $Item.SetAccessControl($Acl)
    Report-Stage 'ACL_VERIFY'
    $After = $Item.GetAccessControl($Sections)
    if (-not (Test-PrivateAcl $After)) { throw 'verify' }
    Report-Stage 'DONE'
} catch {
    [Console]::Error.WriteLine('Examify could not secure its private local files. Use an ordinary account and a dedicated folder owned by you.')
    exit 1
}
