@echo off
title Host App
cd /d "%~dp0.."

echo Checking VS Code Live Server (127.0.0.1:5500)...
powershell -NoProfile -Command "if (Test-NetConnection -ComputerName 127.0.0.1 -Port 5500 -InformationLevel Quiet -WarningAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1

if errorlevel 1 (
  echo.
  echo [Warning] Cannot detect 127.0.0.1:5500.
  echo Please click "Go Live" on multi\host.html in VS Code first.
  echo Continuing anyway - the app window may be blank until Live Server is running.
  echo.
  pause
)

cd /d "%~dp0..\host-app"
call npm start
