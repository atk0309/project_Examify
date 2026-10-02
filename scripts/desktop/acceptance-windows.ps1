# CI-only: use an ordinary local user, not the image's elevated runner account.
param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Node,
    [string]$Browsers,
    [switch]$TestsOnly
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This standard-user fixture runs only in disposable GitHub Actions jobs.' }
if (-not $TestsOnly -and -not $Browsers) { throw 'Browser fixtures are required for packaged acceptance.' }
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
    if (-not $TestsOnly) {
        & icacls.exe $Browsers /grant "*${Sid}:(OI)(CI)RX" /T /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Cannot grant browser fixture read access.' }
    }
    & icacls.exe $Root /grant "*${Sid}:(OI)(CI)F" /Q | Out-Null
    $Script = Join-Path $Root 'run.ps1'
    $Result = Join-Path $Root 'result.txt'
    $Exit = Join-Path $Root 'exit.txt'
    $UnitTests = Join-Path $Repository 'tests/desktop/launcher.test.mjs'
    $UpgradeTests = Join-Path $Repository 'tests/desktop/upgrades.test.mjs'
    $WorkerTests = Join-Path $Repository 'tests/desktop/worker-lock.test.mjs'
    $RelocatedTests = Join-Path $Repository 'tests/desktop/relocated-helpers.test.mjs'
    $UpgradeAcceptance = Join-Path $Repository 'tests/desktop/upgrade-acceptance.mjs'
    $InventoryTests = Join-Path $Repository 'tests/desktop/windows-inventory.test.mjs'
    $UserTemp = Join-Path $Root 'UserTemp'
    $RunAcceptance = if ($TestsOnly) { '$false' } else { '$true' }
    $Accept = Join-Path $Repository 'tests/desktop/acceptance.mjs'
    $Artifact = Join-Path $Repository 'build/desktop/win32-x64'
    # Literal single-quote escaping, never evaluate arbitrary command text.
    function Quote([string]$Value) { return "'" + ([string]$Value).Replace("'", "''") + "'" }
    @"
`$ErrorActionPreference = 'Stop'
`$env:PLAYWRIGHT_BROWSERS_PATH = $(Quote $Browsers)
try {
    `$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    `$Principal = New-Object Security.Principal.WindowsPrincipal(`$Identity)
    if (`$Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Windows tests must run without administrator privileges.' }
    # Create these directories as the test user. Inherited runner TEMP may have
    # an Administrators owner, which production ownership checks must reject.
    New-Item -ItemType Directory -Path $(Quote $UserTemp) | Out-Null
    `$env:TEMP = $(Quote $UserTemp)
    `$env:TMP = $(Quote $UserTemp)
    `$ErrorActionPreference = 'Continue'
    & $(Quote $Node) --test $(Quote $UnitTests) $(Quote $InventoryTests) $(Quote $UpgradeTests) $(Quote $WorkerTests) $(Quote $RelocatedTests) *> $(Quote $Result)
    `$Code = `$LASTEXITCODE
    `$ErrorActionPreference = 'Stop'
    if (`$Code -eq 0 -and $RunAcceptance) {
        `$ErrorActionPreference = 'Continue'
        & $(Quote $Node) $(Quote $Accept) $(Quote $Artifact) *>> $(Quote $Result)
        `$Code = `$LASTEXITCODE
        `$ErrorActionPreference = 'Stop'
    }
    if (`$Code -eq 0 -and $RunAcceptance) {
        `$ErrorActionPreference = 'Continue'
        & $(Quote $Node) $(Quote $UpgradeAcceptance) $(Quote $Artifact) *>> $(Quote $Result)
        `$Code = `$LASTEXITCODE
        `$ErrorActionPreference = 'Stop'
    }
    `$Code | Set-Content -LiteralPath $(Quote $Exit)
    exit `$Code
} catch {
    'Standard-user checks failed before completion.' | Add-Content -LiteralPath $(Quote $Result)
    '1' | Set-Content -LiteralPath $(Quote $Exit)
    exit 1
}
"@ | Set-Content -Encoding UTF8 -LiteralPath $Script
    Start-Service seclogon
    $Credentials = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$Name", $Password)
    $Process = Start-Process -FilePath powershell.exe -Credential $Credentials -LoadUserProfile -WorkingDirectory $Root -ArgumentList '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script -Wait -PassThru
    if (Test-Path -LiteralPath $Result) { Get-Content -LiteralPath $Result }
    if ($Process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $Exit) -or (Get-Content -Raw -LiteralPath $Exit).Trim() -ne '0') { throw 'Standard-user Windows checks failed.' }
} finally {
    if ($Created) { Remove-LocalUser -Name $Name -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force -LiteralPath $Root -ErrorAction SilentlyContinue
}
