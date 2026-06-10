@echo off
title Bot Herbalis
cd /d "%~dp0"
:loop
rem El updater nunca pisa run.bat directo (cmd.exe relee los .bat por offset de
rem bytes — pisarlo en caliente ejecuta basura). Deja run.bat.new y este bloque,
rem parseado entero en memoria, hace el swap y se relanza.
if exist run.bat.new (
  move /y run.bat.new run.bat >nul
  start "" "%~f0"
  exit
)
rem El updater deja este flag cuando cambio package.json/package-lock.json.
rem Si npm install falla (sin internet, AV) el flag queda y se reintenta en la
rem proxima vuelta; mientras tanto el agente corre con los node_modules viejos.
if exist update-deps.flag (
  echo [RUN] Actualizando dependencias...
  call npm install --no-audit --no-fund
  if not errorlevel 1 del update-deps.flag
)
node agent.js
if %errorlevel%==0 goto end
echo [RUN] El bot se cerro (codigo %errorlevel%). Reiniciando en 5 segundos...
timeout /t 5 /nobreak >nul
goto loop
:end
