# Read-only ownership/reparse validation of a private state snapshot source.
# Never normalize source ACLs: a failed upgrade must leave its source unchanged.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
try {
    $Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $Sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
    function Inspect-Entry([string]$Entry, [bool]$RequireDirectory) {
        $Attributes = [IO.File]::GetAttributes($Entry)
        if (($Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($Attributes -band [IO.FileAttributes]::Device)) { throw 'unsafe' }
        $Directory = [bool]($Attributes -band [IO.FileAttributes]::Directory)
        if ($RequireDirectory -and -not $Directory) { throw 'directory' }
        $Item = if ($Directory) { [IO.DirectoryInfo]::new($Entry) } else { [IO.FileInfo]::new($Entry) }
        $Acl = $Item.GetAccessControl($Sections)
        if ($Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $Sid.Value) { throw 'owner' }
        return $Item
    }
    # Validate the exact root, then only data/config. Coordination files and app
    # releases are intentionally outside this state-validation traversal.
    $Root = Inspect-Entry ([IO.Path]::GetFullPath($Path)) $true
    $Pending = [Collections.Generic.Stack[string]]::new()
    foreach ($Name in @('data', 'config')) {
        $Candidate = [IO.Path]::Combine($Root.FullName, $Name)
        try { $null = [IO.File]::GetAttributes($Candidate) }
        catch {
            # Missing fresh-install folders are allowed; access/I/O failures
            # must never be treated as absence by Directory.Exists/File.Exists.
            $Cause = $_.Exception
            while ($Cause.InnerException) { $Cause = $Cause.InnerException }
            if (($Cause -is [IO.FileNotFoundException]) -or ($Cause -is [IO.DirectoryNotFoundException])) { continue }
            throw
        }
        $null = Inspect-Entry $Candidate $true
        $Pending.Push($Candidate)
    }
    while ($Pending.Count -gt 0) {
        $Directory = Inspect-Entry ($Pending.Pop()) $true
        foreach ($Child in $Directory.GetFileSystemInfos()) {
            $Checked = Inspect-Entry $Child.FullName $false
            if ($Checked -is [IO.DirectoryInfo]) { $Pending.Push($Checked.FullName) }
        }
    }
    exit 0
} catch {
    # No learner filenames, saved settings or raw OS diagnostics in logs.
    [Console]::Error.WriteLine('Examify cannot verify the private study source. Existing data was preserved.')
    exit 1
}
