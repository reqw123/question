@echo off
title Setup
cd /d "%~dp0"

echo ============================================================
echo   Running setup... please wait, a new window will open.
echo ============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "launchers\setup.ps1"
if errorlevel 1 (
  echo.
  echo [Error] Setup script did not finish normally.
  pause
  exit /b 1
)

exit /b 0
