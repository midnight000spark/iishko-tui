@echo off
setlocal
echo This installer copies trusted plugin code into your OpenCode user plugins folder.
echo No administrator rights, downloads, credentials or configuration edits are needed.
echo PowerShell execution policy is relaxed ONLY for this installer process.
echo Organization-managed policy is not changed. Read README.md before continuing.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "result=%ERRORLEVEL%"
echo.
if not "%result%"=="0" echo Installation did not complete. Read the message above.
pause
exit /b %result%
