@echo off
title Control Center
cd /d "%~dp0..\control-center"

echo Starting control center...
call npm start
pause
