# CI-only: use an ordinary local user, not the image's elevated runner account.
param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Node,
    [Parameter(Mandatory = $true)][string]$Browsers
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This standard-user fixture runs only in disposable GitHub Actions jobs.' }
$Name = 'Exa' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$Created = $false
$Root = Join-Path $env:SystemDrive ('ExamifyAcceptance-' + [Guid]::NewGuid().ToString('N'))
$PasswordText = [Guid]::NewGuid().ToString('N') + 'aA1!'
$Password = ConvertTo-SecureString -AsPlainText -Force $PasswordText
try {
    New-LocalUser -Name $Name -Password $Password -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
    $Created = $true
    $Users = (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')).Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
    Add-LocalGroupMember -Group $Users -Member $Name
    $Sid = (Get-LocalUser -Name $Name).SID.Value
    New-Item -ItemType Directory -Path $Root | Out-Null
    # Only this job's checkout/browser fixtures and result directory are granted.
    & icacls.exe $Repository /grant "*${Sid}:(OI)(CI)RX" /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot grant fixture read access.' }
    & icacls.exe $Browsers /grant "*${Sid}:(OI)(CI)RX" /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot grant browser fixture read access.' }
    & icacls.exe $Root /grant "*${Sid}:(OI)(CI)F" /Q | Out-Null
    $Script = Join-Path $Root 'run.ps1'
    $Result = Join-Path $Root 'result.txt'
    $Exit = Join-Path $Root 'exit.txt'
    $Accept = Join-Path $Repository 'tests/desktop/acceptance.mjs'
    $Artifact = Join-Path $Repository 'build/desktop/win32-x64'
    # Literal single-quote escaping, never evaluate arbitrary command text.
    function Quote([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
    @"
`$ErrorActionPreference = 'Stop'
`$env:PLAYWRIGHT_BROWSERS_PATH = $(Quote $Browsers)
try {
    & $(Quote $Node) $(Quote $Accept) $(Quote $Artifact) *> $(Quote $Result)
    `$LASTEXITCODE | Set-Content -LiteralPath $(Quote $Exit)
} catch {
    'Acceptance process failed before completion.' | Set-Content -LiteralPath $(Quote $Result)
    '1' | Set-Content -LiteralPath $(Quote $Exit)
}
"@ | Set-Content -Encoding UTF8 -LiteralPath $Script
    Start-Service seclogon
    $Credentials = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$Name", $Password)
    $Process = Start-Process -FilePath powershell.exe -Credential $Credentials -LoadUserProfile -WorkingDirectory $Root -ArgumentList '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script -Wait -PassThru
    if (Test-Path -LiteralPath $Result) { Get-Content -LiteralPath $Result }
    if ($Process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $Exit) -or (Get-Content -Raw -LiteralPath $Exit).Trim() -ne '0') { throw 'Standard-user Windows acceptance failed.' }
} finally {
    if ($Created) { Remove-LocalUser -Name $Name -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force -LiteralPath $Root -ErrorAction SilentlyContinue
}
