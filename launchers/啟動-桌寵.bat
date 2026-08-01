@echo off
title Live2D Desktop Pet
cd /d "%~dp0..\desktop-pet"

echo Starting desktop pet...
echo This window shows click-through/interactive mode status - keep it open.
call npm start
pause
