@echo off
REM GoKesari Connector — remove the Windows service (run as Administrator).
cd /d "%~dp0"
GoKesariConnector.exe stop
GoKesariConnector.exe uninstall
echo GoKesari Connector removed. Revoke its token in GoKesari: Shop settings ^> Integrations.
