@echo off
REM GoKesari Connector — install as a Windows service (run as Administrator).
REM Usage: install.cmd https://gokesari.com gkc_yourtoken
setlocal
cd /d "%~dp0"
if "%~2"=="" (
  echo Usage: install.cmd SERVER_ADDRESS CONNECTOR_TOKEN
  echo Example: install.cmd https://gokesari.com gkc_xxxxxxxx
  echo Create the token in GoKesari: Shop settings ^> Integrations ^> Tally ^> New connector token.
  exit /b 2
)
gokesari-connector.exe setup --server %1 --token %2 || exit /b 1
icacls connector.json /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" >nul
GoKesariConnector.exe install || exit /b 1
GoKesariConnector.exe start || exit /b 1
echo GoKesari Connector is installed and running. Keep TallyPrime open with your company loaded.
