@echo off
title D&D Scribe Bot
echo.
echo   ======================================
echo     D^&D Scribe Bot - Starting Bot
echo   ======================================
echo.

cd /d "%~dp0"

:: Check if node is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found! Please install Node.js 18+ from https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo [INFO] First run detected - installing dependencies...
    echo This may take a minute...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] npm install failed. Please run 'npm install' manually.
        pause
        exit /b 1
    )
    echo.
    echo Dependencies installed successfully!
    echo.
)

:: Check if .env exists
if not exist ".env" (
    echo [INFO] Creating .env from template...
    copy .env.example .env >nul
    echo.
    echo IMPORTANT: Edit .env with your API keys before using the bot!
    echo Opening .env in notepad...
    start notepad ".env"
    echo.
    timeout /t 3 >nul
)

:: Dashboard disabled — stories are now posted directly to Discord.
:: To re-enable, uncomment the lines below and comment out the bot.js launch.
:: echo Starting dashboard at http://localhost:3000 ...
:: start "" cmd /c "timeout /t 2 >nul && start http://localhost:3000"
:: node dashboard/server.js

echo Starting D^&D Scribe Bot...
echo Stories will be posted directly to your Discord recap channel.
echo.

node bot.js

:: If the bot stops, pause so user can see any errors
echo.
echo Bot stopped.
pause
