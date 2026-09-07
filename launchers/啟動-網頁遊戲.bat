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
  call :start_bank_api
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
exit /b 0

:start_bank_api
rem Caddy has no file-write ability. serve-lan.js on port 8081 is the tiny backend that
rem host.html's custom quiz-bank upload posts to (Caddyfile proxies /api/* to it).
where node >nul 2>nul || (
  echo [Note] Node.js not found - custom quiz-bank upload will not persist into the project.
  echo        Everything else works. Install Node.js from https://nodejs.org/ to enable it.
  goto :eof
)
echo Starting quiz-bank writer API on port 8081...
start "Bank Writer API :8081" node "launchers\serve-lan.js" 8081
goto :eof
