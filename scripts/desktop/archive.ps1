param(
    [Parameter(Mandatory = $true)][ValidateSet('extract', 'create')][string]$Operation,
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if ($Operation -eq 'extract') { [IO.Compression.ZipFile]::ExtractToDirectory($Source, $Destination) }
else { [IO.Compression.ZipFile]::CreateFromDirectory($Source, $Destination) }
