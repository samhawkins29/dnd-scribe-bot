@echo off
title D&D Scribe Bot
echo.
echo   ======================================
echo     D^&D Scribe Bot
echo   ======================================
echo.

:: Run from the repo root regardless of where this .bat was launched from.
cd /d "%~dp0"

:: Start the bot the normal way (package.json "main" / "npm run bot").
node bot.js

:: Pause on exit so any error output stays visible.
echo.
echo Bot stopped.
pause
