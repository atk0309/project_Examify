# Windows PowerShell 5.1+; generated release installer pins both values below.
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Examify'),
    [string]$ArchivePath,
    [switch]$NoLaunch,
    [switch]$NoShortcut
)
$ErrorActionPreference = 'Stop'
$Version = '__EXAMIFY_VERSION__'
$Sha256 = '__EXAMIFY_SHA256__'
if ($Version -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*$' -or $Sha256 -notmatch '^[a-f0-9]{64}$') {
    throw 'This is installer source. Use the version-pinned installer from a built Examify release artifact; no solo release has been assumed.'
}
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'This preview supports Windows x64 only.'
}
if (-not [IO.Path]::IsPathRooted($InstallRoot) -or $InstallRoot.StartsWith('\\')) { throw 'Choose an absolute local install folder.' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($InstallRoot -match '["''`$%\r\n]' -or $InstallRoot -match '\s#') { throw 'Choose a path without quotes, dollar signs, percent signs or newlines.' }
$Cursor = $InstallRoot
while ($Cursor) {
    if (Test-Path -LiteralPath $Cursor) {
        if ((Get-Item -LiteralPath $Cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The install path must not contain links or junctions.' }
    }
    $Cursor = Split-Path -Parent $Cursor
}
if (Test-Path -LiteralPath $InstallRoot) {
    if ((Get-ChildItem -LiteralPath $InstallRoot -Force | Measure-Object).Count -gt 0 -and -not (Test-Path -LiteralPath (Join-Path $InstallRoot 'installation.json'))) {
        throw 'The destination contains other files. Choose an empty dedicated Examify folder.'
    }
}
foreach ($Relative in @('installation.json', 'Examify.cmd', 'releases', 'config', 'data', "releases/$Version")) {
    $Candidate = Join-Path $InstallRoot $Relative
    if ((Test-Path -LiteralPath $Candidate) -and ((Get-Item -LiteralPath $Candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Existing installation paths must not be links or junctions.'
    }
}
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
if ($Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this in an ordinary Command Prompt, not as Administrator.' }
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
# Private per-user ACL; no administrative privileges or global policy changes.
$RootItem = Get-Item -LiteralPath $InstallRoot -Force
$Sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
if ($RootItem.GetAccessControl($Sections).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $Identity.User.Value) { throw 'Choose a dedicated installation folder owned by your ordinary Windows account.' }
$Acl = New-Object Security.AccessControl.DirectorySecurity
$Acl.SetAccessRuleProtection($true, $false)
$Rule = New-Object Security.AccessControl.FileSystemAccessRule($Identity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$Acl.AddAccessRule($Rule)
function Test-PrivateRootAcl($Value) {
    $Rules = @($Value.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($Value.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $Identity.User.Value -or -not $Value.AreAccessRulesProtected -or $Rules.Count -ne 1) { return $false }
    $Actual = $Rules[0]
    return ($Actual.IdentityReference.Value -eq $Identity.User.Value -and -not $Actual.IsInherited -and $Actual.AccessControlType -eq $Rule.AccessControlType -and $Actual.FileSystemRights -eq $Rule.FileSystemRights -and $Actual.InheritanceFlags -eq $Rule.InheritanceFlags -and $Actual.PropagationFlags -eq $Rule.PropagationFlags)
}
# DACL-only persistence supports repeated installation without audit privileges.
if (-not (Test-PrivateRootAcl ($RootItem.GetAccessControl($Sections)))) {
    $RootItem.SetAccessControl($Acl)
    if (-not (Test-PrivateRootAcl ($RootItem.GetAccessControl($Sections)))) { throw 'Could not verify the private installation folder.' }
}
$Stage = Join-Path $InstallRoot ('.install.' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Stage | Out-Null
try {
    $Archive = Join-Path $Stage 'package.zip'
    if (-not $ArchivePath -and $env:EXAMIFY_INSTALL_SOURCE_DIR) {
        $LocalArchive = Join-Path $env:EXAMIFY_INSTALL_SOURCE_DIR "examify-$Version-win32-x64.zip"
        if (Test-Path -LiteralPath $LocalArchive) { $ArchivePath = $LocalArchive }
    }
    if ($ArchivePath) { Copy-Item -LiteralPath $ArchivePath -Destination $Archive }
    else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $Url = "https://github.com/atk0309/project_Examify/releases/download/$Version/examify-$Version-win32-x64.zip"
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Archive
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash.ToLowerInvariant() -ne $Sha256) { throw 'Download checksum mismatch. Nothing was installed.' }
    $App = Join-Path $Stage 'app'
    Expand-Archive -LiteralPath $Archive -DestinationPath $App
    $Manifest = Get-Content -Raw -LiteralPath (Join-Path $App 'desktop-release.json') | ConvertFrom-Json
    $Node = Join-Path $App 'runtime/node.exe'
    if ($Manifest.version -ne $Version -or $Manifest.platform -ne 'win32-x64' -or -not (Test-Path -LiteralPath $Node)) { throw 'The release package is incomplete or for a different platform.' }
    $NodeVersion = & $Node --version
    if ($LASTEXITCODE -ne 0 -or $NodeVersion -ne "v$($Manifest.nodeVersion)") { throw 'Wrong portable Node runtime.' }
    # The executable doing the swap lives outside the directory being moved.
    $InstallerNode = Join-Path $Stage 'install-node.exe'
    Copy-Item -LiteralPath $Node -Destination $InstallerNode
    & $InstallerNode (Join-Path $App 'scripts/desktop/install-release.mjs') $InstallRoot $App $Version
    if ($LASTEXITCODE -ne 0) { throw 'Could not safely install this release. Existing learner data was preserved.' }
    $Launcher = Join-Path $InstallRoot 'Examify.cmd'
    @"
@echo off
setlocal
"%~dp0releases\$Version\runtime\node.exe" "%~dp0releases\$Version\scripts\launcher.mjs" --root "%~dp0." %*
if errorlevel 1 pause
"@ | Set-Content -Encoding ASCII -LiteralPath $Launcher
    if (-not $NoShortcut) {
        $Shell = New-Object -ComObject WScript.Shell
        $Link = $Shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Examify.lnk'))
        $Link.TargetPath = $Launcher
        $Link.WorkingDirectory = $InstallRoot
        $Link.Description = 'Private exam practice on this computer'
        $Link.Save()
    }
    Write-Host "Examify installed. Relaunch with: $Launcher"
    if (-not $NoLaunch) { & $Launcher }
} finally {
    Remove-Item -Recurse -Force -LiteralPath $Stage -ErrorAction SilentlyContinue
}
