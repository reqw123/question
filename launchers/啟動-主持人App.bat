@echo off
title Host App
cd /d "%~dp0.."

echo Checking VS Code Live Server (127.0.0.1:5500)...
powershell -NoProfile -Command "if (Test-NetConnection -ComputerName 127.0.0.1 -Port 5500 -InformationLevel Quiet -WarningAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1

if errorlevel 1 (
  echo.
  echo [Info] 127.0.0.1:5500 not detected - VS Code Live Server is not running.
  where node >nul 2>nul
  if errorlevel 1 (
    echo [Error] Node.js not found, and VS Code Live Server is not running.
    echo Please either click "Go Live" on multi\host.html in VS Code, or install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
  )
  echo Starting built-in Node static server on port 5500 instead...
  set PORT=5500
  start "Host Server (port 5500, no Live Server)" node "launchers\serve-lan.js"
  echo Waiting for server to be ready...
  ping -n 3 127.0.0.1 >nul
)

cd /d "%~dp0..\host-app"
call npm start
