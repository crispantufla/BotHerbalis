@echo off
cd /d "%~dp0"
echo  =============================================
echo    Instalador del Bot Herbalis
echo  =============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
