@echo off
setlocal
rem Release packaging pins the PowerShell installer below. No admin rights needed.
set "EXAMIFY_INSTALL_VERSION=__EXAMIFY_VERSION__"
set "EXAMIFY_INSTALL_PS_SHA256=__EXAMIFY_INSTALL_PS_SHA256__"
set "EXAMIFY_INSTALL_SOURCE_DIR=%~dp0"
set "EXAMIFY_INSTALL_STAGE=%TEMP%\ExamifySetup-%RANDOM%-%RANDOM%"
powershell.exe -NoLogo -NoProfile -Command "$ErrorActionPreference='Stop'; $version=$env:EXAMIFY_INSTALL_VERSION; $hash=$env:EXAMIFY_INSTALL_PS_SHA256; if($version -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*$' -or $hash -notmatch '^[a-f0-9]{64}$'){throw 'Installer source only. Use the version-pinned install.cmd from a built Examify release artifact.'}; $dir=$env:EXAMIFY_INSTALL_STAGE; New-Item -ItemType Directory -Path $dir|Out-Null; $file=Join-Path $dir 'install.ps1'; $local=Join-Path $env:EXAMIFY_INSTALL_SOURCE_DIR 'install.ps1'; if(Test-Path -LiteralPath $local){Copy-Item -LiteralPath $local -Destination $file}else{[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri ('https://github.com/atk0309/project_Examify/releases/download/'+$version+'/install.ps1') -OutFile $file}; if((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() -ne $hash){throw 'Installer checksum mismatch. Nothing was installed.'}"
if errorlevel 1 goto failed
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%EXAMIFY_INSTALL_STAGE%\install.ps1" %*
set "EXAMIFY_INSTALL_EXIT=%ERRORLEVEL%"
rmdir /s /q "%EXAMIFY_INSTALL_STAGE%" 2>nul
exit /b %EXAMIFY_INSTALL_EXIT%
:failed
rem A failed stage creation may mean this path already belonged to someone else.
rem Leave failure cleanup to the OS rather than deleting an unowned directory.
echo Examify could not install. Read the message above. Your data has not been deleted.
exit /b 1
