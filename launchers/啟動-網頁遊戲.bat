@echo off
title Quiz - Web Game
cd /d "%~dp0.."

echo ============================================================
if exist "caddy.exe" (
  echo   caddy.exe DETECTED at: %CD%\caddy.exe
  echo   MODE: Caddy ^(public/ngrok-capable^)
) else (
  echo   caddy.exe NOT FOUND in: %CD%
  echo   MODE: LAN-only ^(built-in Node server, no ngrok support^)
)
echo ============================================================
echo.

if exist "caddy.exe" (
  echo Starting Caddy...
  start "Caddy Server" "caddy.exe" run
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo [Error] Neither caddy.exe nor Node.js was found.
    echo Please either download caddy.exe to this folder, or install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
  )
  echo Starting built-in Node static server...
  start "LAN Server (no caddy)" node "launchers\serve-lan.js"
)

echo Waiting for server to be ready...
ping -n 3 127.0.0.1 >nul

echo Opening browser...
start "" "http://localhost:8080/multi/host.html"

echo.
echo Done. You can close this window now.
echo Keep the server window open - closing it stops the site.
pause
