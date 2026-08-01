@echo off
title Quiz - Web Game (Caddy)
cd /d "%~dp0.."

echo Starting Caddy web server...
start "Caddy Server" "caddy.exe" run

echo Waiting for server to be ready...
ping -n 3 127.0.0.1 >nul

echo Opening browser...
start "" "http://localhost:8080/multi/host.html"

echo.
echo Done. You can close this window now.
echo Keep the "Caddy Server" window open - closing it stops the site.
pause
