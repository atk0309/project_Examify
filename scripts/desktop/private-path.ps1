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
    # Persist only the changed DACL. Set-Acl copies the whole descriptor and its
    # fallback can request audit privileges when revisiting a protected DACL.
    # The owner was checked above and is deliberately never changed here.
    $Item.SetAccessControl($Acl)
    $After = $Item.GetAccessControl($Sections)
    $Rules = @($After.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($After.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $Sid.Value -or -not $After.AreAccessRulesProtected -or $Rules.Count -ne 1) { throw 'verify' }
    $Actual = $Rules[0]
    if ($Actual.IdentityReference.Value -ne $Sid.Value -or $Actual.IsInherited -or $Actual.AccessControlType -ne $Rule.AccessControlType -or $Actual.FileSystemRights -ne $Rule.FileSystemRights -or $Actual.InheritanceFlags -ne $Rule.InheritanceFlags -or $Actual.PropagationFlags -ne $Rule.PropagationFlags) { throw 'verify' }
} catch {
    [Console]::Error.WriteLine('Examify could not secure its private local files. Use an ordinary account and a dedicated folder owned by you.')
    exit 1
}
