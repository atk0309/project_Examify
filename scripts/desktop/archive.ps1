param(
    [Parameter(Mandatory = $true)][ValidateSet('extract', 'create', 'verify-extract')][string]$Operation,
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if ($Operation -eq 'verify-extract') {
    $Zip = [IO.Compression.ZipFile]::OpenRead($Source)
    try {
        foreach ($Entry in $Zip.Entries) {
            $Name = $Entry.FullName.Replace('\', '/')
            $Type = ($Entry.ExternalAttributes -shr 16) -band 0xF000
            if ($Name.StartsWith('/') -or $Name -match '[:\x00-\x1f]' -or $Name.Split('/') -contains '..' -or $Name -match '(^|/)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])([./]|$)' -or $Name -match '[ .](/|$)' -or $Type -notin @(0, 0x4000, 0x8000)) { throw 'Unsafe archive member.' }
        }
    } finally { $Zip.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($Source, $Destination)
}
elseif ($Operation -eq 'extract') { [IO.Compression.ZipFile]::ExtractToDirectory($Source, $Destination) }
else { [IO.Compression.ZipFile]::CreateFromDirectory($Source, $Destination) }
